import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const pf = g.pathFinder;
const b = g.world.playerBase, e = g.world.enemyBase;
// worst-case single searches
let worst = 0, total = 0;
for (let i = 0; i < 30; i++) {
  pf.cache.clear(); pf.version++;
  const t = process.hrtime.bigint();
  pf.find(b.x + (i%5), b.z + (i%3), e.x - (i%4), e.z + (i%2), 2);
  const ms = Number(process.hrtime.bigint()-t)/1e6;
  total += ms; worst = Math.max(worst, ms);
}
console.log('single find: avg', (total/30).toFixed(2), 'ms worst', worst.toFixed(2), 'cache', pf.cache.size, 'nodes', pf.stats.nodes/pf.stats.searches|0);

// full-grid dijkstra reference
function dijkstra(grid, cells, gx, gz) {
  const dist = new Float32Array(cells*cells).fill(Infinity);
  const from = new Int32Array(cells*cells).fill(-1);
  const heap = [];
  const gi = gz*cells+gx;
  dist[gi] = 0; heap.push([0, gi]);
  const DIRS = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.4142],[1,-1,1.4142],[-1,1,1.4142],[-1,-1,1.4142]];
  let pushed = 0;
  while (heap.length) {
    // simple binary heap via sort-free approach
    let mi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[mi][0]) mi = i;
    const [d, i] = heap[mi];
    heap[mi] = heap[heap.length-1]; heap.pop();
    if (d > dist[i]) continue;
    const cx = i % cells, cz = (i/cells)|0;
    for (const [dx,dz,c] of DIRS) {
      const nx = cx+dx, nz = cz+dz;
      if (nx<0||nz<0||nx>=cells||nz>=cells) continue;
      const ni = nz*cells+nx;
      if (grid[ni]) continue;
      if (dx && dz && (grid[cz*cells+nx] || grid[nz*cells+cx])) continue;
      const nd = d + c;
      if (nd < dist[ni]) { dist[ni] = nd; from[ni] = i; heap.push([nd, ni]); pushed++; }
    }
  }
  return pushed;
}
const t = process.hrtime.bigint();
const pushed = dijkstra(pf.blocked, pf.cells, (e.x+256)/4|0, (e.z+256)/4|0);
console.log('naive dijkstra ms', (Number(process.hrtime.bigint()-t)/1e6).toFixed(2), 'pushes', pushed);
