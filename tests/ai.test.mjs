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
