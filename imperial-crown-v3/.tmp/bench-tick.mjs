/* ============================================================
   .tmp/bench-tick.mjs — steady-state simulation cost

   Reports the distribution of Game.update() wall time for a full match
   (200+ units, AI on, orders issued) rather than a mean, because the mean is
   never what stutters: p99 and max are. Run it after any sim change.

     node .tmp/bench-tick.mjs [units] [ticks] [dt]
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';

const UNITS = Number(process.argv[2] || 200);
const TICKS = Number(process.argv[3] || 3000);
const DT = Number(process.argv[4] || 1 / 30);

const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const ai = new AIController(g, 2, { aggression: 0.85 });
const b = g.world.playerBase, e = g.world.enemyBase;
for (let i = 0; i < UNITS; i++) {
  const t = ['spearman', 'archer', 'knight', 'swordsman'][i % 4];
  g.spawnUnitRaw(t, 1, b.x - 16 + (i % 20) * 1.4, b.z - 10 + ((i / 20) | 0) * 1.4);
}
g.recomputePop();
g.teams.get(1).popCap = 999;

const tick = (i) => {
  if (i % 240 === 0) {
    // a player keeps giving orders: attack-move across the map, then back
    const army = g.units.filter((u) => u.team === 1 && !u.dead);
    const toEnemy = (i / 240) % 2 === 0;
    const tx = toEnemy ? e.x + 8 + (i % 17) : b.x - 10;
    const tz = toEnemy ? e.z - (i % 13) : b.z + 6;
    g.orderAttackMove(army, tx, tz);
  }
  const t = process.hrtime.bigint();
  g.update(DT);
  ai.update(DT);
  return Number(process.hrtime.bigint() - t) / 1e6;
};

for (let i = 0; i < 300; i++) tick(i);        // warm the JIT
const times = new Float64Array(TICKS);
for (let i = 0; i < TICKS; i++) times[i] = tick(i + 300);
const sorted = Float64Array.from(times).sort();
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2);
let sum = 0;
for (const t of times) sum += t;
console.log(`units ${g.units.length}  ticks ${TICKS}  dt ${(DT * 1000).toFixed(1)}ms`);
console.log(`mean ${(sum / TICKS).toFixed(2)} ms   p50 ${q(0.5)}   p90 ${q(0.9)}   p99 ${q(0.99)}   p999 ${q(0.999)}   max ${sorted[sorted.length - 1].toFixed(2)}`);
console.log(`over 8 ms: ${[...times].filter((t) => t > 8).length} ticks (${([...times].filter((t) => t > 8).length / TICKS * 100).toFixed(2)} %)`);
