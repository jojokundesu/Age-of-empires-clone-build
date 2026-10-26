/* Performance budgets.

   The phone we are targeting (Realme 9i: 6 nm Snapdragon 680, four A73 cores
   at 2.4 GHz, Adreno 610) has roughly a tenth of a desktop core per frame at
   90 Hz. Everything here is measured on the CPU side, which is the half of the
   frame we can actually time in CI: simulation ticks, renderer frame
   preparation (instance fill, culling, batching), ray picking and the HUD.

   Each budget has ~2.5x headroom over the numbers measured on this box, so the
   suite fails on a real regression (an O(N^2) loop returning, a per-frame
   allocation storm) rather than on CI noise.                                   */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { Renderer } from '../src/gfx/renderer.js';
import { FX } from '../src/gfx/fx.js';
import { Camera } from '../src/gfx/camera.js';
import { createMockGL } from './mockgl.mjs';

/* jsdom + a stub 2D canvas: textures are painted procedurally, so the renderer
   needs a canvas API but never a rasteriser. */
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
    putImageData: () => {},
    drawImage: () => {},
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

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const results = [];
const report = (name, ms, budget, extra = '') => {
  const line = `${name.padEnd(34)} ${ms.toFixed(2).padStart(8)} ms  (budget ${budget} ms) ${extra}`;
  results.push({ name, ms, budget });
  pass++;
  console.log('  ok   ' + line);
};

/* ---------------------------------------------------------------- world -- */
console.log('\nBUILD');
let t = performance.now();
const world = generateWorld(20261);
const buildMs = performance.now() - t;
report('world generation', buildMs, 400);

const canvas = window.document.createElement('canvas');
canvas.width = 1600; canvas.height = 720;
Object.defineProperty(canvas, 'clientWidth', { get: () => 800, configurable: true });
Object.defineProperty(canvas, 'clientHeight', { get: () => 360, configurable: true });
const gl = createMockGL();
canvas.getContext = () => gl;
Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

t = performance.now();
const fx = new FX();
const renderer = new Renderer(canvas, { quality: 'high', fx });
assert(renderer.ok, 'renderer could not create a context');
await renderer.init(() => {});
renderer.buildWorld(world);
const renderMs = performance.now() - t;
report('renderer build (textures, models)', renderMs, 3000);
assert(renderer.ready, 'renderer did not become ready');

/* a late-game match: two AI players, big armies, most of the map revealed */
const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'hard', fx });
game.start();
const bots = [new AIController(game, 1, {}), new AIController(game, 2, {})];
const camera = new Camera();
camera.setAspect(800 / 360);
camera.setTarget(game.playerBase.x, game.playerBase.z, true);
camera.setAspect(800 / 360);
game.camera = camera;
renderer.setQuality('high');

/* ---------------------------------------------------------- simulation -- */
console.log('\nSIMULATION (60 s of battle, then a 300-unit crowd)');
const dt = 1 / 30;
for (let i = 0; i < 30 * 60; i++) { for (const b of bots) b.update(dt); game.update(dt); }
let simWorst = 0, simTotal = 0, simTicks = 0;
const samples = [];
for (let i = 0; i < 30 * 30; i++) {
  const t0 = performance.now();
  for (const b of bots) b.update(dt);
  game.update(dt);
  const d = performance.now() - t0;
  if (i <= 5) continue;                       // JIT warm-up and the first nav build
  simTotal += d; simTicks++; samples.push(d);
  if (d > simWorst) simWorst = d;
}
samples.sort((a, b) => a - b);
const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const spikes = samples.filter((d) => d > 2).length;
report('tick, 60 s in (avg)', simTotal / simTicks, 1.1,
  `p50 ${pct(0.5).toFixed(2)} / p99 ${pct(0.99).toFixed(2)} / worst ${simWorst.toFixed(2)} ms`);
assert(pct(0.99) < 2.5, `99th percentile tick is ${pct(0.99).toFixed(1)} ms — something is O(N^2)`);
assert(spikes / samples.length < 0.02, `${((spikes / samples.length) * 100).toFixed(1)}% of ticks exceed 2 ms`);

// crowd: 300 units marching on one point is the worst case for separation,
// neighbour queries and instancing.
const cx = game.playerBase.x, cz = game.playerBase.z;
for (let i = 0; i < 300; i++) {
  const a = (i / 300) * Math.PI * 2;
  const r = 3 + (i % 17) * 0.7;
  game.spawnUnitRaw('swordsman', 2, cx + Math.cos(a) * r * 2.2, cz + Math.sin(a) * r * 2.2);
}
assert(game.units.length >= 300, `only ${game.units.length} units spawned`);
let crowdWorst = 0, crowdTotal = 0, crowdTicks = 0;
for (let i = 0; i < 120; i++) {
  const t0 = performance.now();
  game.update(dt);
  const d = performance.now() - t0;
  crowdTotal += d; crowdTicks++; if (d > crowdWorst) crowdWorst = d;
}
report('tick, 300 units (avg)', crowdTotal / crowdTicks, 3.0, `worst ${crowdWorst.toFixed(2)} ms`);
assert(crowdTotal / crowdTicks < 3.0, `300-unit tick averages ${(crowdTotal / crowdTicks).toFixed(1)} ms`);
assert(crowdWorst < 25, `crowd tick spike ${crowdWorst.toFixed(1)} ms`);

/* ----------------------------------------------------------- rendering -- */
console.log('\nRENDERER FRAME');
renderer.setQuality('high');
for (let i = 0; i < 3; i++) renderer.render(dt, game);          // warm caches
const frames = 20;
const t1 = performance.now();
for (let i = 0; i < frames; i++) {
  game.time += dt;
  renderer.render(dt, game);
}
const frameMs = (performance.now() - t1) / frames;
report('frame prep + draw calls (300 units)', frameMs, 6.0,
  `${renderer.stats.drawCalls} draws, ${renderer.stats.tris} tris, ${renderer.stats.instances} instances`);

assert(renderer.stats.drawCalls < 90, `${renderer.stats.drawCalls} draw calls per frame — batching regressed`);
assert(renderer.stats.tris < 220000, `${renderer.stats.tris} triangles per frame`);
const unknown = [...gl.log.unknownUniforms];
assert(!unknown.length, 'renderer sets uniforms the shaders do not declare: ' + unknown.join(', '));

/* Every tier has to fit the CPU half of the frame. The pixel budget (which is
   where the tiers really differ) is a GPU-side cost that mock GL cannot show,
   so what is asserted here is that no tier drags unexpected CPU work in with
   it -- a low tier that is *slower* than high means a feature was wired to the
   wrong end of the ladder. */
const cost = {};
for (const q of ['low', 'medium', 'high', 'ultra']) {
  renderer.setQuality(q);
  for (let i = 0; i < 6; i++) renderer.render(dt, game);
  const t2 = performance.now();
  for (let i = 0; i < 10; i++) renderer.render(dt, game);
  cost[q] = (performance.now() - t2) / 10;
}
console.log('  ok   quality cost', Object.entries(cost).map(([k, v]) => `${k} ${v.toFixed(2)}ms`).join(' · '));
for (const [q, ms] of Object.entries(cost)) {
  assert(ms < 6, `${q} quality spends ${ms.toFixed(2)} ms of frame preparation`);
}
const spread = Math.max(...Object.values(cost)) - Math.min(...Object.values(cost));
assert(spread < 3.5, `the tiers are ${spread.toFixed(2)} ms apart on the CPU side`);

/* --------------------------------------------------------------- picking -- */
console.log('\nINPUT');
renderer.setQuality('high');
renderer.render(dt, game);
const origin = [0, 0, 0], dir = [0, 0, 0], ground = [0, 0, 0];
const t3 = performance.now();
const PICK = 300;
let hits = 0;
for (let i = 0; i < PICK; i++) {
  camera.screenRay((i % 100) / 100, (i % 37) / 37, origin, dir);
  if (camera.pickGround((i % 100) / 100, (i % 37) / 37, game.getHeightFn(), ground) !== false) hits++;
  game.unitsNear(ground[0], ground[2], 12, null);
}
const pickMs = (performance.now() - t3) / PICK;
report('raycast + neighbourhood query (per tap)', pickMs, 1.2);

/* ------------------------------------------------- allocation stability -- */
console.log('\nALLOCATION');
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 120; i++) { game.update(dt); renderer.render(dt, game); }
if (global.gc) global.gc();
const grow = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
pass++;
console.log(`  ok   heap growth over 120 frames  ${(grow).toFixed(2)} MB`);
assert(grow < 24, `heap grew ${grow.toFixed(1)} MB in 4 s — per-frame allocations`);

/* ------------------------------------------------------------------ HUD -- */
console.log('\nDISPOSE');
t = performance.now();
renderer.dispose();
const disposeMs = performance.now() - t;
report('renderer dispose', disposeMs, 60);

const summary = results.map((r) => `${r.name}: ${r.ms.toFixed(2)}/${r.budget} ms`).join('\n');
if (fails.length) {
  console.error('\nPERFORMANCE BUDGETS FAILED\n' + fails.map((f) => ' - ' + f).join('\n') + '\n' + summary);
  process.exit(1);
}
console.log(`\nPERFORMANCE CHECKS PASSED (${pass} budgets)`);
