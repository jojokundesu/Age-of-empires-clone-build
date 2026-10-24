import { Camera } from '../src/gfx/camera.js';
const cam = new Camera({ yaw: 0.7, pitch: 0.62, dist: 46 });
cam.setAspect(900/420); cam.heightAt = () => 0;
cam.setTarget(0,0,true); cam.snap(); cam.update(1/60, {instant:true});
const p = (x,z) => { const o=[0,0,0]; cam.project(x,0,z,o); return [(o[0]*0.5+0.5)*900, (-o[1]*0.5+0.5)*420, o[2]]; };
const before = p(0,0);
for (const [label, fn] of [['pan(0,+10)', () => cam.pan(0,10)], ['pan(0,-10)', () => cam.pan(0,-10)], ['pan(+10,0)', () => cam.pan(10,0)], ['pan(-10,0)', () => cam.pan(-10,0)]]) {
  cam.setTarget(0,0,true); cam.snap(); cam.update(1/60,{instant:true});
  fn(); cam.update(1/60,{instant:true});
  const after = p(0,0);
  console.log(label.padEnd(12), 'screen d =', (after[0]-before[0]).toFixed(1), (after[1]-before[1]).toFixed(1));
}
