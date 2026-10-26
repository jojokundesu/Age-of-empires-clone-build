/* AI-vs-AI soak test — node tests/ai.test.mjs [seconds] */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';

const seconds = Number(process.argv[2] || 600);
const difficulty = process.argv[3] || 'hard';
const world = generateWorld(20261);
const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty });
game.start();
const bots = [new AIController(game, 1, {}), new AIController(game, 2, {})];

const dt = 1 / 30;
let worst = 0, total = 0, errors = 0;
const t0 = performance.now();
const maxTicks = Math.round(seconds / dt);
for (let i = 0; i < maxTicks; i++) {
  try {
    const a = performance.now();
    for (const b of bots) b.update(dt);
    game.update(dt);
    const d = performance.now() - a;
    total += d;
    if (d > worst) worst = d;
  } catch (e) {
    errors++;
    console.error('TICK ERROR at', (i * dt).toFixed(1), e.stack);
    if (errors > 3) break;
  }
  if (i % 900 === 0) {
    const s1 = game.teams.get(1), s2 = game.teams.get(2);
    const mil = (t) => game.units.filter((u) => !u.dead && u.team === t && u.def.attack > 0 && !u.def.classes.includes('villager')).length;
    console.log(
      `t=${(i * dt).toFixed(0)}s | P: v${game.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager').length} mil${mil(1)} pop${s1.popUsed}/${s1.popCap} age${s1.age} ${['food', 'wood', 'gold', 'stone'].map((k) => Math.round(s1.res[k])).join('/')} b${game.buildings.filter((b) => !b.dead && b.team === 1).length}` +
      ` | E: v${game.units.filter((u) => !u.dead && u.team === 2 && u.type === 'villager').length} mil${mil(2)} pop${s2.popUsed}/${s2.popCap} age${s2.age} ${['food', 'wood', 'gold', 'stone'].map((k) => Math.round(s2.res[k])).join('/')} b${game.buildings.filter((b) => !b.dead && b.team === 2).length}` +
      ` | proj${game.projectiles.activeCount} favour ${Math.floor(s1.favor)}/${Math.floor(s2.favor)} buffs ${(s1.buffs||[]).length}/${(s2.buffs||[]).length}`
    );
  }
  if (game.gameOver) { console.log('GAME OVER at', game.time.toFixed(0) + 's', game.result); break; }
}
const dur = (performance.now() - t0) / 1000;
console.log('---', (maxTicks * dt).toFixed(0) + 's simulated in', dur.toFixed(2) + 's wall; avg tick', (total / maxTicks).toFixed(3), 'ms; worst', worst.toFixed(2), 'ms; errors', errors);
console.log('units alive', game.units.filter((u) => !u.dead).length, 'buildings alive', game.buildings.filter((b) => !b.dead).length, 'projectiles', game.projectiles.activeCount);

/* Assertions, not just a log. An economy that silently deadlocks (everyone
   banking gold, nobody gathering wood, no army, no age-up) still "runs" and
   would otherwise pass unnoticed. */
const bad = [];
const samples = [];
for (const team of [1, 2]) {
  const st = game.teams.get(team);
  const villagers = game.units.filter((u) => !u.dead && u.team === team && u.type === 'villager').length;
  const army = game.units.filter((u) => !u.dead && u.team === team && u.type !== 'villager' && u.def.attack > 0).length;
  samples.push({ team, villagers, army, age: st.age, gold: st.res.gold, gathered: st.gathered });
  if (errors > 0) bad.push(`${errors} tick errors`);
  if (seconds >= 240 && !game.gameOver) {
    if (st.gathered < 600) bad.push(`team ${team} gathered only ${st.gathered | 0} in ${seconds}s`);
    if (st.age < 1 && seconds >= 420) bad.push(`team ${team} never left the Dark Age`);
    if (villagers === 0 && seconds >= 300) bad.push(`team ${team} has no villagers left and no result`);
    if (army === 0 && seconds >= 500) bad.push(`team ${team} never fielded an army`);
    if (st.res.gold > 2500 && st.res.food < 100) bad.push(`team ${team} is hoarding gold (${st.res.gold | 0}) while starving (${st.res.food | 0} food)`);
  }
}
const avgTick = total / maxTicks;
console.log('economy', samples.map((s) => `T${s.team}: ${s.villagers}v ${s.army}mil age${s.age} ${s.gathered | 0}gath`).join(' | '));
if (avgTick > 2.0) bad.push(`average tick ${avgTick.toFixed(2)} ms exceeds the 2 ms budget`);
if (game.gameOver) console.log('RESULT', JSON.stringify(game.result));
if (bad.length) {
  console.log('\nAI SOAK FAILED:');
  for (const b of bad) console.log(' - ' + b);
  process.exit(1);
}
console.log('AI SOAK PASSED');
