import { Geo, M } from '../src/gfx/geo.js';
const vol = (g) => {
  const geo = g.finish(); const v = geo.v, idx = geo.i; let s = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]*16, b = idx[t+1]*16, c = idx[t+2]*16;
    s += v[a]*(v[b+1]*v[c+2]-v[b+2]*v[c+1]) - v[a+1]*(v[b]*v[c+2]-v[b+2]*v[c]) + v[a+2]*(v[b]*v[c+1]-v[b+1]*v[c]);
  }
  return s/6;
};
const T = (name, fn) => { const g = new Geo(2048); try { fn(g); console.log(name.padEnd(16), vol(g).toFixed(3)); } catch (e) { console.log(name, 'ERR', e.message); } };
T('box', g => g.box(0,1,0,2,2,2));
T('cyl', g => g.cyl(0,1,0,0.5,2,8));
T('gable', g => g.gable(0,0,0,4,2,4));
T('beam', g => g.beam(-1,1,0,1,1,0,0.2));
T('cone', g => g.cone ? g.cone(0,1,0,1,2,8) : 0);
T('sphere', g => g.sphere ? g.sphere(0,1,0,1,8,6) : 0);
T('prism', g => g.prism ? g.prism(0,0,0,2,2,2,4) : 0);
T('pyramid', g => g.pyramid ? g.pyramid(0,0,0,2,2) : 0);
T('plane', g => g.quad(-1,0,1,1,0,1,1,0,-1,-1,0,-1));
