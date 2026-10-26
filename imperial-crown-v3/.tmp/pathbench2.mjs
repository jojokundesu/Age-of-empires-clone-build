import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const pf = g.pathFinder, cells = pf.cells, grid = pf.blocked;

class Bucket {
  constructor(n) { this.b = new Array(n); for (let i=0;i<n;i++) this.b[i]=[]; this.n=n; this.min=0; }
  clear(){ for (let i=this.min;i<this.n;i++) if (this.b[i].length) this.b[i].length=0; this.min=0; }
  push(i, d){ const k = d|0; if (!this.b[k]) this.b[k]=[]; this.b[k].push(i); if (k<this.min) this.min=k; }
  pop(){ while (this.min < this.n && !this.b[this.min].length) this.min++; if (this.min>=this.n) return -1; const arr=this.b[this.min]; const v=arr.pop(); return v; }
}
const DIRS = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.4142],[1,-1,1.4142],[-1,1,1.4142],[-1,-1,1.4142]];
const dist = new Float32Array(cells*cells);
const visited = new Uint32Array(cells*cells);
let stamp = 1;
function field(gx, gz) {
  stamp++;
  const bucket = new Bucket(400);
  const s = stamp;
  let bestPush = 0;
  dist[gz*cells+gx] = 0; visited[gz*cells+gx] = s; bucket.push(gz*cells+gx, 0);
  let count = 0;
  for (;;) {
    const i = bucket.pop();
    if (i < 0) break;
    count++;
    const d = dist[i];
    const cx = i % cells, cz = (i/cells)|0;
    for (let k=0;k<8;k++) {
      const [dx,dz,c] = DIRS[k];
      const nx=cx+dx, nz=cz+dz;
      if (nx<0||nz<0||nx>=cells||nz>=cells) continue;
      const ni = nz*cells+nx;
      if (grid[ni]) continue;
      if (dx && dz && (grid[cz*cells+nx] || grid[nz*cells+cx])) continue;
      const nd = d + c;
      if (visited[ni] !== s || nd < dist[ni]) { visited[ni]=s; dist[ni]=nd; bucket.push(ni, nd); bestPush++; }
    }
  }
  return { count, bestPush };
}
for (const goal of [[0,0],[(206)/4|0, 0]]) {}
let t = process.hrtime.bigint();
let r = field(128, 128);
console.log('field(centre) ms', (Number(process.hrtime.bigint()-t)/1e6).toFixed(2), r);
t = process.hrtime.bigint();
r = field(30, 90);
console.log('field(corner) ms', (Number(process.hrtime.bigint()-t)/1e6).toFixed(2), r);
