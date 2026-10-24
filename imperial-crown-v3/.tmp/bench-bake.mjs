import { bakeTerrain, bakeGroundDetail, bakeClouds, bakeStars, bakeWater, bakeNoise } from '../src/gfx/bake.js';
import { fbm } from '../src/gfx/noise.js';

const n = 129, cell = 4, size = 512, half = 256;
const heights = new Float32Array(n*n);
for (let j=0;j<n;j++) for (let i=0;i<n;i++) {
  const x=i*cell-half, z=j*cell-half;
  heights[j*n+i] = 6 + fbm(x*0.01, z*0.01, 4)*14 - Math.max(0,(Math.hypot(x,z)-120))*0.05;
}
const hf = { res:n-1, cell, size, h: heights, sample(x,z){
  const fx = Math.max(0, Math.min(n-1.001, (x+half)/cell)); const fz = Math.max(0, Math.min(n-1.001, (z+half)/cell));
  const i0=fx|0, j0=fz|0, ax=fx-i0, az=fz-j0;
  const a=heights[j0*n+i0], b=heights[j0*n+i0+1], c=heights[(j0+1)*n+i0], d=heights[(j0+1)*n+i0+1];
  const t=a+(b-a)*ax, u=c+(d-c)*ax; return t+(u-t)*az;
}};
const splat4 = new Float32Array(n*n*4), splat2 = new Float32Array(n*n*2);
for (let k=0;k<n*n;k++){
  const x=(k%n)*cell-half, z=Math.floor(k/n)*cell-half;
  const r = Math.max(0, Math.min(1, fbm(x*0.02,z*0.02,3)*1.5));
  splat4[k*4]=1-r; splat4[k*4+2]=r*0.7; splat4[k*4+3]=r*0.3;
  splat2[k*2]=r*0.2;
}
const layers = Array.from({length:12},(_,i)=>{ const a=new Uint8ClampedArray(256*256*4); for(let p=0;p<a.length;p+=4){a[p]=(i*37)%255;a[p+1]=(i*91)%255;a[p+2]=(i*53)%255;a[p+3]=255;} return a; });
const RT = { n, cell, heights, splat4, splat2, size };
const world = { height: hf };
const t = (label, fn) => { const t0=performance.now(); const r=fn(); console.log(label, (performance.now()-t0).toFixed(0)+' ms'); return r; };
const cloud = t('clouds', ()=>bakeClouds(512));
t('detail', ()=>bakeGroundDetail(512));
t('terrain512', ()=>bakeTerrain(world, RT, layers, {size:512, cloudData:cloud, cloudSize:512}));
t('stars', ()=>bakeStars(1024,512));
t('water', ()=>bakeWater(256));
t('noise', ()=>bakeNoise(256));
