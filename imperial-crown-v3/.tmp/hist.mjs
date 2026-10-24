import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const b = g.world.playerBase, e = g.world.enemyBase;
for (let i = 0; i < 200; i++) g.spawnUnitRaw(i % 3 ? 'spearman' : 'archer', 1, b.x - 14 + (i%16)*1.3, b.z - 8 + ((i/16)|0)*1.3);
g.orderMove(g.units.filter(u=>u.team===1), e.x + 8, e.z);
const times = [];
for (let i = 0; i < 900; i++) {
  const t = process.hrtime.bigint();
  g.update(1/30);
  times.push(Number(process.hrtime.bigint()-t)/1e6);
}
const sorted = [...times].sort((a,b)=>a-b);
const q = (p)=>sorted[Math.min(sorted.length-1, Math.floor(p*sorted.length))].toFixed(2);
console.log('units', g.units.length, 'p50', q(0.5), 'p90', q(0.9), 'p99', q(0.99), 'max', sorted[sorted.length-1].toFixed(2), 'mean', (times.reduce((a,b)=>a+b,0)/times.length).toFixed(2));
