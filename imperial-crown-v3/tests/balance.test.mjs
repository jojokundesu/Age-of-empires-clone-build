/* Balance harness: runs head-to-head matchups in the real simulation and
   prints survivors + remaining HP so the counter triangle can be tuned.
   Run with `node tests/balance.test.mjs` (add --full for the mixed army). */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';

const world = generateWorld(20261);

function duel(typeA, typeB, count = 6, seconds = 60) {
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  game.start();
  const base = { x: 0, z: 0 };
  // clear the starting armies so only the duelists fight
  for (const u of game.units) u.dead = true;
  game.units.length = 0;
  const A = [], B = [];
  for (let i = 0; i < count; i++) {
    const col = i % 3, row = (i / 3) | 0;
    A.push(game.spawnUnitRaw(typeA, 1, base.x - 8 + col * 1.3, base.z - 3 + row * 1.3));
    B.push(game.spawnUnitRaw(typeB, 2, base.x + 8 + col * 1.3, base.z - 3 + row * 1.3));
  }
  for (const u of A) { u.noAggro = false; u.moveTo(base.x + 14, base.z); u.state = STATE.ATTACK_MOVE; }
  for (const u of B) { u.noAggro = false; u.moveTo(base.x - 14, base.z); u.state = STATE.ATTACK_MOVE; }
  for (let i = 0; i < 60 * seconds; i++) {
    game.update(1 / 60);
    if (!A.some((u) => !u.dead) || !B.some((u) => !u.dead)) break;
  }
  const aliveA = A.filter((u) => !u.dead), aliveB = B.filter((u) => !u.dead);
  return {
    a: aliveA.length, b: aliveB.length,
    hpA: aliveA.reduce((s, u) => s + u.hp, 0), hpB: aliveB.reduce((s, u) => s + u.hp, 0),
    t: game.time
  };
}

const rows = [];
const COST = (await import('../src/sim/data.js')).UNIT_DEFS;
const cost = (t) => Object.values(COST[t].cost || {}).reduce((a, b) => a + b, 0);
const pairs = [
  ['spearman', 'knight'], ['spearman', 'swordsman'], ['spearman', 'archer'],
  ['archer', 'swordsman'], ['archer', 'knight'], ['archer', 'skirmisher'],
  ['swordsman', 'knight'], ['knight', 'skirmisher']
];
console.log('matchup                      A  B   hpA  hpB   (A cost/count vs B)');
for (const [a, b] of pairs) {
  const r = duel(a, b, 6);
  rows.push({ a, b, ...r });
  console.log(
    `${(a + ' vs ' + b).padEnd(28)} ${String(r.a).padStart(2)} ${String(r.b).padStart(2)} ` +
    `${String(Math.round(r.hpA)).padStart(5)} ${String(Math.round(r.hpB)).padStart(5)}   ` +
    `$${(cost(a) / 6).toFixed(0)}/$6 vs $${(cost(b) / 6).toFixed(0)}`);
}
if (process.argv.includes('--full')) {
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  game.start();
  game.units.length = 0;
  const A = [], B = [];
  for (let i = 0; i < 8; i++) {
    A.push(game.spawnUnitRaw('spearman', 1, -6 + (i % 3) * 1.2, -4 + ((i / 3) | 0) * 1.2));
    A.push(game.spawnUnitRaw('archer', 1, -6 + (i % 3) * 1.2, -1 + ((i / 3) | 0) * 1.2));
    B.push(game.spawnUnitRaw('swordsman', 2, 10 + (i % 3) * 1.2, -4 + ((i / 3) | 0) * 1.2));
    B.push(game.spawnUnitRaw('knight', 2, 10 + (i % 3) * 1.2, -1 + ((i / 3) | 0) * 1.2));
  }
  for (const u of A) { u.moveTo(14, 0); u.state = STATE.ATTACK_MOVE; }
  for (const u of B) { u.moveTo(-14, 0); u.state = STATE.ATTACK_MOVE; }
  for (let i = 0; i < 60 * 90; i++) {
    game.update(1 / 60);
    if (!A.some((u) => !u.dead) || !B.some((u) => !u.dead)) break;
  }
  console.log(`\nmixed 8+8 vs 8+8 -> A ${A.filter((u) => !u.dead).length} alive, B ${B.filter((u) => !u.dead).length} alive at ${game.time.toFixed(1)} s`);
}
