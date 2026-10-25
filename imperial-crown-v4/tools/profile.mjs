/* Dev tool: a stage-by-stage profile of boot and of a 300-unit frame, on the
   CPU side (mock GL). It answers "where did the 1.5 s of boot go" and "which
   pass owns the 2 ms of frame preparation" without a GPU in the way.

   node tools/profile.mjs [--units 300] [--quality high]
*/
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { Renderer } from '../src/gfx/renderer.js';
import { FX } from '../src/gfx/fx.js';
import { Camera } from '../src/gfx/camera.js';
import { createMockGL } from '../tests/mockgl.mjs';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const UNITS = Number(argOf('units', 300));
const QUALITY = argOf('quality', 'high');

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  { url: 'https://example.test/', pretendToBeVisual: true });
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
    putImageData: () => {}, drawImage: () => {},
    setTransform() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    globalCompositeOperation: 'source-over'
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

const ms = (t) => `${t.toFixed(1)} ms`;
const time = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  console.log(`  ${label.padEnd(44)} ${ms(performance.now() - t0)}`);
  return r;
};

let t = performance.now();
const world = await time('world generation', () => generateWorld(20261));
console.log(`  world total ${ms(performance.now() - t)}`);

const canvas = window.document.createElement('canvas');
Object.defineProperty(canvas, 'clientWidth', { get: () => 804, configurable: true });
Object.defineProperty(canvas, 'clientHeight', { get: () => 360, configurable: true });
Object.defineProperty(canvas, 'width', { get() { return this.__w || 1; }, set(v) { this.__w = v; }, configurable: true });
Object.defineProperty(canvas, 'height', { get() { return this.__h || 1; }, set(v) { this.__h = v; }, configurable: true });
Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
const gl = createMockGL();
canvas.getContext = () => gl;

const fx = new FX();
const r = new Renderer(canvas, { quality: QUALITY });
const timings = {};
const origInit = r.init.bind(r);
await time('renderer.init (textures/models/shaders)', () => origInit(() => {}));
await time('renderer.buildWorld', () => r.buildWorld(world));

const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'hard', fx });
game.start();
const bots = [new AIController(game, 1, {}), new AIController(game, 2, {})];
const camera = new Camera();
camera.setAspect(804 / 360); camera.setViewport(804, 360);
camera.setTarget(game.playerBase.x, game.playerBase.z, true);
game.camera = camera;
game.settings = { fog: true, bars: true };

console.log(`\nSIM (${UNITS} units)`);
// fast-forward so both bases are developed
for (let i = 0; i < 30 * 45; i++) { for (const b of bots) b.update(1 / 30); game.update(1 / 30); }
const cx = game.playerBase.x, cz = game.playerBase.z;
for (let i = 0; i < UNITS; i++) {
  const a = (i / UNITS) * Math.PI * 2, rr = 3 + (i % 17) * 0.7;
  game.spawnUnitRaw(['spearman', 'swordsman', 'archer', 'knight'][i & 3], 2, cx + Math.cos(a) * rr * 2.2, cz + Math.sin(a) * rr * 2.2);
}
for (let i = 0; i < 60; i++) { for (const b of bots) b.update(1 / 30); game.update(1 / 30); }
console.log(`  units ${game.units.filter((u) => !u.dead).length}, buildings ${game.buildings.length}, resources ${game.resources.length}`);

/* which stage of a frame costs what */
console.log(`\nFRAME STAGES (quality ${QUALITY}, ${(canvas.width)}x${canvas.height} buffer)`);
for (let i = 0; i < 4; i++) r.render(1 / 60, game);
const N = 40;
const stage = (label, fn) => {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  const v = (performance.now() - t0) / N;
  timings[label] = v;
  console.log(`  ${label.padEnd(30)} ${v.toFixed(3)} ms`);
};
stage('frame total', () => r.render(1 / 60, game));
stage('env + resize', () => r.updateEnvironment(1 / 60, game.worldTime));
stage('fillInstances', () => r._fillInstances(game, camera, 1 / 60));
stage('pickTownLights', () => r._pickTownLights(game, camera, 1 / 60));
stage('shadowPass', () => r._shadowPass(camera, 1 / 60));
stage('drawTerrain', () => r._drawTerrain(camera));
stage('drawModels', () => r._drawModels(camera));
stage('drawSky', () => r._drawSky(camera));
stage('drawWater', () => r._drawWater(camera));
stage('drawBillboards', () => r._drawBillboards(game, camera));
stage('drawDecals', () => r._drawDecals(game, camera));
stage('drawParticles', () => r._drawParticles(camera, game));
stage('drawPost', () => r._drawPost());
for (let i = 0; i < 3; i++) r.render(1 / 60, game);
console.log(`  stats/frame: ${JSON.stringify(r.stats)}`);
const cat = [];
for (const kind of ['buildingBatches', 'unitBatches', 'resBatches', 'propBatches']) {
  let n = 0, inst = 0;
  for (const b of r[kind].values()) if (b.count) { n++; inst += b.count; }
  cat.push(`${kind} ${n} batches / ${inst} inst`);
}
console.log(`  batches/frame: ${cat.join(' | ')}`);
console.log(`  draw order: ${r._activeBatches.map((b) => b.name || (b.triCount + 't')).join(' ')}`);
console.log(`  buffer: ${r.renderW}x${r.renderH} (css ${canvas.clientWidth}x${canvas.clientHeight} @dpr3)`);

/* Garbage collection is the stutter a profiler does not show you: the frame
   time is fine on average and then one frame takes 8 ms because the young
   generation filled up. Counting GCs (and their pauses) per second of
   gameplay is the honest measure; `heapUsed` deltas mostly measure how much
   semispace V8 happens to have grown. */
if (global.gc) {
  const { PerformanceObserver } = await import('node:perf_hooks');
  const gcs = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push({ kind: e.detail.kind, ms: e.duration });
  });
  obs.observe({ entryTypes: ['gc'] });
  global.gc();
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) r.render(1 / 60, game);
  const secs = (performance.now() - t0) / 1000;
  obs.disconnect();
  const minor = gcs.filter((g) => g.kind === 1);
  const major = gcs.filter((g) => g.kind !== 1);
  const pause = (arr) => (arr.length ? arr.reduce((a, b) => a + b.ms, 0) / arr.length : 0);
  console.log(`\nGC over ${secs.toFixed(1)} s of frames: ${minor.length} minor (${(minor.length / secs).toFixed(1)}/s, ${pause(minor).toFixed(2)} ms avg), `
    + `${major.length} major (${(major.length / secs).toFixed(2)}/s, ${pause(major).toFixed(2)} ms avg)`);
}

/* retained memory: a leak shows up here, garbage does not */
if (global.gc) {
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) r.render(1 / 60, game);
  global.gc();
  console.log(`\n  heap delta over 200 frames: ${((process.memoryUsage().heapUsed - before) / 1048576).toFixed(2)} MB`);
}
r.dispose();
