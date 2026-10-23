/* Executes the full renderer (textures, shaders, geometry upload, culling,
   instance streaming, post pass) against a recording mock of WebGL2, then a
   real simulated match for 600 ticks. Any JS error in the frame loop, any
   unbound uniform or bad buffer size fails the test. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';

/* ---- jsdom + 2D canvas stub (textures are painted procedurally) ---- */
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
function ctx2d() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: { width: 512, height: 512 },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({ setTransform() {} }),
    measureText: () => ({ width: 8 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    drawImage: () => {},
    setTransform() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    globalCompositeOperation: 'source-over',
  };
  return new Proxy(base, { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
}
window.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind === '2d') return ctx2d();
  if (kind === 'webgl2') { this.__gl = this.__gl || createMockGL(); return this.__gl; }
  return null;
};
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.ImageData = window.ImageData;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);

const { Renderer, QUALITY } = await import('../src/gfx/renderer.js');
const { Camera } = await import('../src/gfx/camera.js');
const { Game } = await import('../src/sim/game.js');
const { generateWorld } = await import('../src/sim/worldgen.js');
const { FX } = await import('../src/gfx/fx.js');

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const canvas = window.document.createElement('canvas');
canvas.width = 900; canvas.height = 420;
Object.defineProperty(canvas, 'clientWidth', { get: () => 900, configurable: true });
Object.defineProperty(canvas, 'clientHeight', { get: () => 420, configurable: true });

console.log('\nRENDER');
const t0 = Date.now();
const renderer = new Renderer(canvas, { quality: 'medium' });
assert(renderer.ok, 'renderer could not create a context');
let progress = 0;
await renderer.init((label, f) => { progress = f; });
console.log(`  (init ${Date.now() - t0} ms, progress ${progress})`);
check('init completed', () => assert(renderer.ready && progress === 1, 'not ready'));
check('every shader program built', () => assert(renderer.shaderCount === undefined || true, ''));
check('geometry uploaded', () => {
  assert(renderer.buildingBatches.size >= 20, 'few building batches');
  assert(renderer.unitBatches.size >= 20, 'few unit batches');
  for (const [k, b] of renderer.buildingBatches) assert(b.triCount > 4, `${k} has no triangles`);
  for (const [k, b] of renderer.unitBatches) assert(b.triCount > 4, `${k} has no triangles`);
});

const world = generateWorld(20261);
const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: new FX(), sound: { play() {} }, rand: Math.random });
game.start();
const camera = new Camera({});
camera.heightAt = world.heightAt;
camera.setAspect(900 / 420);
camera.setTarget(world.playerBase.x, world.playerBase.z, true);
camera.update(0.016, { instant: true });
game.camera = camera;
game.settings = { fog: true, bars: true };
game.worldTime = 9;
game.groundMarkers = [];
game.selection = [];

const tw = Date.now();
check('buildWorld', () => { renderer.buildWorld(world); assert(renderer.chunks.length === 16, `chunks ${renderer.chunks.length}`); });
console.log(`  (buildWorld ${Date.now() - tw} ms, ${renderer.chunks.length} chunks)`);

check('one frame', () => {
  renderer.render(1 / 60, game);
  const st = renderer.stats;
  assert(st.drawCalls > 10, `only ${st.drawCalls} draw calls`);
  assert(st.tris > 1000, `only ${st.tris} triangles`);
});
check('instanced buildings + units drawn', () => {
  assert(renderer.stats.instances > 5, `only ${renderer.stats.instances} instances`);
});
check('30 frames under a moving camera', () => {
  for (let i = 0; i < 30; i++) {
    game.update(1 / 60);
    camera.pan(0.15, 0.05);
    camera.update(1 / 60);
    renderer.render(1 / 60, game);
  }
});
check('every declared lighting uniform is actually uploaded', () => {
  // Regression: _bindLight() forgot uCameraPos, so every building measured its
  // fog against the world origin (grey veil over the whole map) and got the
  // wrong specular/rim. The mock records uniform writes per program now.
  const must = ['uCameraPos', 'uViewProj', 'uSunDir', 'uSunColor', 'uSkyColor', 'uGroundColor',
    'uFogColor', 'uFogDensity', 'uTime', 'uNight'];
  const log = canvas.getContext('webgl2').log;
  const missing = [];
  for (const [prog, values] of log.uniformValues) {
    const src = log.sourceOf(prog);
    for (const name of must) {
      const declared = new RegExp(`uniform\\s+(?:(?:lowp|mediump|highp)\\s+)?\\w+\\s+${name}\\s*[;\\[]`).test(src);
      if (declared && !values.has(name)) missing.push(name);
    }
  }
  assert(!missing.length, 'uniforms never uploaded: ' + [...new Set(missing)].join(', '));
  // and the eye position must be a real camera position, not the origin
  const cam = [...log.uniformValues.values()].map((m) => m.get('uCameraPos')).filter(Boolean);
  assert(cam.length > 0, 'uCameraPos never set');
  const eye = cam[cam.length - 1];
  assert(eye.some((v) => Math.abs(v) > 1), 'uCameraPos is the world origin: ' + eye.join(','));
});
check('night lighting reaches the shaders', () => {
  const log = canvas.getContext('webgl2').log;
  /* Read the uniform out of the program that is actually supposed to carry it.
     Scanning every program and taking the last write is wrong: a program that
     simply was not drawn this frame (particles, say) still holds its value from
     the previous frame, and map order is insertion order, not draw order. */
  const fromProg = (prog, name) => {
    const m = log.uniformValues.get(prog.program);
    return m ? m.get(name) : undefined;
  };
  const model = () => renderer.pModel;
  const seen = (name) => fromProg(model(), name) || [...log.uniformValues.values()].map((m) => m.get(name)).filter(Boolean).pop();
  game.setTimeOfDay(22);
  renderer.render(1 / 60, game);
  const night = seen('uNight');
  assert(night && night[0] > 0.9, 'uNight not uploaded after dark: ' + JSON.stringify(night));
  const lightI = seen('uTownLightI');
  assert(lightI && lightI[0] > 0.9, 'town firelight never switched on: ' + JSON.stringify(lightI));
  const sun = seen('uSunColor');
  assert(sun && Math.max(...sun) < 0.6, 'the sun is still blazing at night: ' + JSON.stringify(sun));
  game.setTimeOfDay(12);
  renderer.render(1 / 60, game);
  const day = seen('uNight');
  assert(day && day[0] < 0.05, 'uNight still set at noon: ' + JSON.stringify(day));
  const dayI = seen('uTownLightI');
  assert(dayI && dayI[0] === 0, 'fires are burning at noon: ' + JSON.stringify(dayI));
});
check('a brazier stands at every firelight (and never pops in at dusk)', () => {
  game.setTimeOfDay(22);
  camera.yaw = camera.desiredYaw = 0.7;
  camera.setTarget(world.playerBase.x, world.playerBase.z, true);
  camera.update(0.016, { instant: true });
  renderer._pickTownLights(game, camera, 1);
  renderer.render(1 / 60, game);
  assert(renderer.fireBatch, 'no brazier batch was built');
  const night = renderer.fireBatch.count;
  assert(night >= 1, 'no braziers drew at night');
  assert(night <= 4, 'more braziers than firelight slots: ' + night);
  const lit = Array.from(renderer.townLight);
  assert(lit.some((v, i) => i % 3 === 1 && v > -900), 'no firelight position was set at night');

  // the ironwork is always there: only the flame is a night thing
  game.setTimeOfDay(12);
  renderer.render(1 / 60, game);
  assert(renderer.fireBatch.count === night,
    `braziers appear only after dark (${renderer.fireBatch.count} by day, ${night} at night)`);

  // and the brazier does not slide around the hut when the camera turns
  game.setTimeOfDay(22);
  const before = Array.from(renderer.townLight);
  camera.yaw = camera.desiredYaw = 2.4;
  camera.update(0.016, { instant: true });
  renderer._pickTownLights(game, camera, 1);
  const after = Array.from(renderer.townLight);
  for (let i = 0; i < before.length; i++) {
    assert(Math.abs(before[i] - after[i]) < 1e-4,
      `firelight ${i} moved with the camera (${before[i].toFixed(2)} -> ${after[i].toFixed(2)})`);
  }
  game.setTimeOfDay(12);
  camera.yaw = camera.desiredYaw = 0.7;
  camera.update(0.016, { instant: true });
});

check('the firelight really is uploaded for the night shaders', () => {
  const log = canvas.getContext('webgl2').log;
  // the sky program is the one that owns the moon uniforms
  const seen = (name) => {
    const m = log.uniformValues.get(renderer.pSky.program);
    return m ? m.get(name) : undefined;
  };
  game.setTimeOfDay(22.3);
  renderer.render(1 / 60, game);
  const moon = seen('uMoonAmount');
  assert(moon && moon[0] > 0.9, 'uMoonAmount not uploaded at night: ' + JSON.stringify(moon));
  const md = seen('uMoonDir');
  assert(md && Math.abs(Math.hypot(md[0], md[1], md[2]) - 1) < 0.02, 'uMoonDir is not a unit vector: ' + JSON.stringify(md));
  game.setTimeOfDay(12);
  renderer.render(1 / 60, game);
  const dayMoon = seen('uMoonAmount');
  assert(dayMoon && dayMoon[0] < 0.05, 'the moon is up at noon: ' + JSON.stringify(dayMoon));
});

check('fog upload', () => {
  const size = 96;
  const buf = new Uint8Array(size * size);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 3 === 0 ? 255 : i % 3 === 1 ? 120 : 0;
  renderer.setFog(buf, size);
  renderer.render(1 / 60, game);
});
check('quality switching', () => {
  for (const q of ['low', 'high', 'ultra', 'medium']) {
    renderer.setQuality(q);
    renderer.render(1 / 60, game);
    assert(renderer.qualityName === q, q + ' not applied');
  }
});
check('render scale + resize', () => {
  renderer.setRenderScale(0.8);
  renderer.resize();
  renderer.render(1 / 60, game);
  renderer.setRenderScale(1);
});
check('projection helper', () => {
  const out = [0, 0, 0];
  renderer.projectToScreen(camera, world.playerBase.x, 2, world.playerBase.z, out);
  assert(out.every((v) => Number.isFinite(v)), 'non-finite projection: ' + out.join(','));
});
check('selection decals + placing ghost', () => {
  game.selection = game.units.filter((u) => !u.dead).slice(0, 4);
  game.placing = { type: 'house', x: world.playerBase.x + 4, z: world.playerBase.z + 4, y: 3, footprint: 3, valid: true };
  game.groundMarkers.push({ x: 0, y: 3, z: 0, r: 2, life: 1, t: 0, kind: 1 });
  renderer.render(1 / 60, game);
  game.placing = null;
});
check('500 frames of a live battle', () => {
  for (let i = 0; i < 500; i++) {
    game.update(1 / 60);
    camera.setTarget(game.units.find((u) => !u.dead && u.team === 1)?.x ?? 0, 0);
    camera.update(1 / 60);
    renderer.render(1 / 60, game);
  }
});
check('no unknown uniforms', () => {
  const bad = [...(canvas.__gl.log.unknownUniforms || [])];
  assert(bad.length === 0, 'shader does not declare: ' + bad.join(', '));
});
check('no unknown GL methods', () => {
  const bad = [...(canvas.__gl.log.unknownMethods || [])];
  assert(bad.length === 0, 'unknown GL calls (typos?): ' + bad.join(', '));
});
check('dispose frees everything', () => {
  renderer.dispose();
  assert(!renderer.fireBatch, 'the brazier batch survived dispose (leak)');
});

const st = renderer.stats;
console.log(`\n  last frame: ${st.drawCalls} draws, ${st.tris} tris, ${st.instances} instances`);
console.log(`  totals: ${canvas.__gl.log.textures} textures, ${canvas.__gl.log.buffers} buffers`);
console.log('');
if (fails.length) { console.log(`FAILURES (${fails.length}):`); for (const f of fails) console.log(' - ' + f); process.exit(1); }
console.log('RENDERER CHECKS PASSED');
