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
/* The peak each crown ever fielded. A crown that is overrun did still raise
   an army; the health check is that the economy produced one, not that it
   survived a war the AI now actually knows how to win. */
const peak = { 1: 0, 2: 0 };
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
  if (i % 30 === 0) {
    for (const t of [1, 2]) {
      const n = game.units.filter((u) => !u.dead && u.team === t && u.type !== 'villager' && u.def.attack > 0).length;
      if (n > peak[t]) peak[t] = n;
    }
  }
  if (game.gameOver) { console.log('GAME OVER at', game.time.toFixed(0) + 's', game.result); break; }
}
const dur = (performance.now() - t0) / 1000;
console.log('---', (maxTicks * dt).toFixed(0) + 's simulated in', dur.toFixed(2) + 's wall; avg tick', (total / maxTicks).toFixed(3), 'ms; worst', worst.toFixed(2), 'ms; errors', errors);
console.log('units alive', game.units.filter((u) => !u.dead).length, 'buildings alive', game.buildings.filter((b) => !b.dead).length, 'projectiles', game.projectiles.activeCount);
/* Supply tents are the AI's own answer to the morale system: an army that
   walks away from them breaks. A bot that never builds one is not playing
   the game the player is playing. */
const tents = game.buildings.filter((b) => b.type === 'supply_tent').length;
const season = game.calendar ? game.calendar.season.key : 'n/a';
const omen = game.calendar && game.calendar.omen ? game.calendar.omen.id : 'n/a';
console.log('the wheel:', season, 'year', game.calendar ? game.calendar.year : '?', '| omen', omen, '| tents', tents);
const seasonsAll = game.calendar ? ['spring', 'summer', 'autumn', 'winter'] : [];
const seasonIdx = game.calendar ? game.calendar.seasonIndex : 0;
const seasonsSeen = game.calendar ? Math.floor(game.time / game.calendar.seasonLength) + game.calendar.year - 1 : 0;

/* Assertions, not just a log. An economy that silently deadlocks (everyone
   banking gold, nobody gathering wood, no army, no age-up) still "runs" and
   would otherwise pass unnoticed. */
const bad = [];
const elapsed = Math.min(seconds, game.time);
if (elapsed >= 480 && tents === 0) bad.push('no supply tent was ever built — raids must break');
if (elapsed >= 400 && seasonsSeen < 1) bad.push('the wheel of the year never turned');
const samples = [];
for (const team of [1, 2]) {
  const st = game.teams.get(team);
  const villagers = game.units.filter((u) => !u.dead && u.team === team && u.type === 'villager').length;
  const army = game.units.filter((u) => !u.dead && u.team === team && u.type !== 'villager' && u.def.attack > 0).length;
  samples.push({ team, villagers, army, age: st.age, gold: st.res.gold, gathered: st.gathered });
  if (errors > 0) bad.push(`${errors} tick errors`);
  const eliminated = game.aliveTeam ? !game.aliveTeam(team) : false;
  if (elapsed >= 240 && !eliminated) {
    if (st.gathered < 600) bad.push(`team ${team} gathered only ${st.gathered | 0} in ${elapsed.toFixed(0)}s`);
    if (st.age < 1 && elapsed >= 420) bad.push(`team ${team} never left the Dark Age`);
    if (villagers === 0 && elapsed >= 300) bad.push(`team ${team} has no villagers left and no result`);
    if (peak[team] === 0 && elapsed >= 300) bad.push(`team ${team} never fielded an army`);
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
