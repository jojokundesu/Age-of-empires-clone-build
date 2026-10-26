import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const pf = g.pathFinder;
const cells = pf.cells, blocked = pf.blocked;

function search(sx, sz, gx, gz, hScale) {
  const DIRS = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.4142],[1,-1,1.4142],[-1,1,1.4142],[-1,-1,1.4142]];
  const gArr = new Float32Array(cells*cells), from = new Int32Array(cells*cells), st = new Uint8Array(cells*cells);
  const heap = [];
  const push=(i,f)=>{heap.push([f,i]);let k=heap.length-1;while(k>0){const p=(k-1)>>1;if(heap[p][0]<=heap[k][0])break;[heap[p],heap[k]]=[heap[k],heap[p]];k=p;}};
  const pop=()=>{const top=heap[0];const last=heap.pop();if(heap.length){heap[0]=last;let k=0;for(;;){const l=2*k+1,r=l+1;if(l>=heap.length)break;let c=l;if(r<heap.length&&heap[r][0]<heap[l][0])c=r;if(heap[c][0]>=heap[k][0])break;[heap[c],heap[k]]=[heap[k],heap[c]];k=c;}}return top[1];};
  const [sx0,sz0] = pf.worldToCell(sx,sz), [gx0,gz0] = pf.worldToCell(gx,gz);
  const start = sz0*cells+sx0, goal = gz0*cells+gx0;
  const heur=(cx,cz)=>{const dx=Math.abs(cx-gx0),dz=Math.abs(cz-gz0);return ((dx+dz)+(1.4142-2)*Math.min(dx,dz))*1.25*hScale;};
  gArr[start]=0;from[start]=-1;st[start]=1;push(start,heur(sx0,sz0));
  let nodes=0;
  while(heap.length && nodes<6000){
    const cur=pop(); if(!st[cur]) continue; st[cur]=2; nodes++;
    if(cur===goal) return {nodes, found:true};
    const cx=cur%cells, cz=(cur/cells)|0, gc=gArr[cur];
    for(const [dx,dz,c] of DIRS){
      const nx=cx+dx,nz=cz+dz; if(nx<0||nz<0||nx>=cells||nz>=cells)continue;
      const ni=nz*cells+nx; if(blocked[ni]||st[ni]===2)continue;
      if(dx&&dz&&(blocked[cz*cells+nx]||blocked[nz*cells+cx]))continue;
      const ng=gc+c*1.25;
      if(!st[ni]||ng<gArr[ni]){gArr[ni]=ng;from[ni]=cur;st[ni]=1;push(ni,ng+heur(nx,nz));}
    }
  }
  return {nodes, found:false};
}
for (const h of [1, 1.0, 1.02, 1.08, 1.2]) {
  let t=process.hrtime.bigint(), worst=0, tot=0, n=0;
  for (let i=0;i<25;i++){
    const a=process.hrtime.bigint();
    const r=search(0+i*3, 0, 150, -30+i*2, h);
    const ms=Number(process.hrtime.bigint()-a)/1e6; tot+=ms; worst=Math.max(worst,ms); n+=r.nodes;
  }
  console.log('h*', h, 'avg ms', (tot/25).toFixed(2), 'worst', worst.toFixed(2), 'avg nodes', (n/25)|0);
}
