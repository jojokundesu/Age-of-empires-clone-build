import { Camera } from '../src/gfx/camera.js';
const W=900,H=420;
const cam = new Camera({ yaw: 0.7, pitch: 0.62, dist: 46 });
cam.setAspect(W/H); cam.setViewport(W,H); cam.heightAt = () => 0;
cam.setTarget(0,0,true); cam.snap(); cam.update(1/60,{instant:true});
const drift = (camera, x, z, fn) => {
  const before = [0,0,0], after = [0,0,0];
  camera.project(x, 0, z, before);
  fn();
  camera.update(1/60, { instant: true });
  camera.project(x, 0, z, after);
  return [(after[0]-before[0])*0.5*W, -(after[1]-before[1])*0.5*H];
};
for (const yaw of [0,0.7,1.57,2.4,-1.1]) {
  cam.desiredYaw = cam.yaw = yaw;
  cam.update(1/60,{instant:true});
  cam.setTarget(0,0,true);
  cam.snap();
  cam.update(1/60,{instant:true});
  console.log(yaw.toFixed(2), drift(cam, 0, 0, () => cam.panPixels(60,0)), 'target', Array.from(cam.desired).map(v=>v.toFixed(1)).join(','));
}
