import { SpatialHash } from '../src/sim/spatial.js';
const h = new SpatialHash(6, 96);
h.half = 256;
for (let i = 0; i < 30; i++) h.insert({ x: Math.random()*200-100, z: Math.random()*200-100 });
const N = 20000;
let t = process.hrtime.bigint();
for (let i = 0; i < N; i++) h.clear();
console.log('clear', (Number(process.hrtime.bigint()-t)/N*1000).toFixed(2), 'us  buckets', h.buckets.length);
