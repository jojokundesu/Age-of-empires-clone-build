import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const b = g.world.playerBase;
for (let i = 0; i < 30; i++) g.spawnUnitRaw('spearman', 1, b.x - 8 + (i%8), b.z - 4 + ((i/8)|0));
const measure = (label, fn, n = 3000) => {
  g.units.forEach(u => u.state = 'idle');
  global.gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) fn(i);
  if (global.gc) global.gc();
  const h1 = process.memoryUsage().heapUsed;
  console.log(label.padEnd(26), ((h1 - h0) / n).toFixed(0), 'bytes/tick live-delta');
};
measure('noop', () => {});
measure('game.update idle', () => g.update(1/30));
// just the unit loop
measure('unit.update only', () => { for (const u of g.units) { u.xPrev = u.x; u.update(1/30); } });
measure('spatial rebuild', () => { g.spatial.clear(); g.spatial.insertAll(g.units); });
measure('moving army', () => { if (Math.random()<0.02) g.orderMove(g.units.filter(u=>u.team===1), 20, 20); g.update(1/30); });
