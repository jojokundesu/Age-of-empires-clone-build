import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
console.log('pf cells', g.pathFinder.cells, 'cell size', g.pathFinder.cellSize);
const t0 = process.hrtime.bigint();
g.pathFinder._components();
console.log('component build ms', (Number(process.hrtime.bigint()-t0)/1e6).toFixed(2), 'components', g.pathFinder.compId);

const b = g.world.playerBase;
const army = [];
for (let i = 0; i < 20; i++) army.push(g.spawnUnitRaw('spearman', 1, b.x - 10 + (i%5)*1.2, b.z - 4 + ((i/5)|0)*1.2));
const e = g.world.enemyBase;
for (const group of [10, 20, 40]) {
  const units = [];
  for (let i = 0; i < group; i++) units.push(g.spawnUnitRaw('spearman', 1, b.x - 10 + (i%8)*1.2, b.z - 4 + ((i/8)|0)*1.2));
  g.pathFinder.beginTick();
  const t = process.hrtime.bigint();
  g.orderMove(units, e.x + 6, e.z - 4);
  const orderMs = Number(process.hrtime.bigint()-t)/1e6;
  // first tick after the order
  const t2 = process.hrtime.bigint();
  g.update(1/30);
  const tickMs = Number(process.hrtime.bigint()-t2)/1e6;
  let worstTick = 0;
  for (let i = 0; i < 120; i++) { const a = process.hrtime.bigint(); g.update(1/30); worstTick = Math.max(worstTick, Number(process.hrtime.bigint()-a)/1e6); }
  console.log(`group ${group}: order ${orderMs.toFixed(2)} ms, next tick ${tickMs.toFixed(2)} ms, worst of 120 ticks ${worstTick.toFixed(2)} ms, skipped ${g.pathFinder.stats.skipped}`);
  for (const u of units) { u.dead = true; }
  g.compact();
}
