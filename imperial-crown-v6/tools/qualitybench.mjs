/* Dev tool: what each quality tier actually costs, stage by stage.

   The governor can only make good decisions if the tiers are ordered by real
   cost on the CPU side, and "it felt slower" is not a measurement. This prints
   the per-stage frame cost of the same scene at all four tiers, plus the
   buffer size each tier asks for -- so a tier that is slower than the one
   above it shows up as a number instead of a mystery.

   node tools/qualitybench.mjs [--units 300]
*/
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { Renderer } from '../src/gfx/renderer.js';
import { FX } from '../src/gfx/fx.js';
import { Camera } from '../src/gfx/camera.js';
import { TIER_ORDER } from '../src/gfx/quality.js';
import { createMockGL } from '../tests/mockgl.mjs';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const UNITS = Number(argOf('units', 300));

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

const world = generateWorld(20261);
const canvas = window.document.createElement('canvas');
Object.defineProperty(canvas, 'clientWidth', { get: () => 804, configurable: true });
Object.defineProperty(canvas, 'clientHeight', { get: () => 360, configurable: true });
Object.defineProperty(canvas, 'width', { get() { return this.__w || 1; }, set(v) { this.__w = v; }, configurable: true });
Object.defineProperty(canvas, 'height', { get() { return this.__h || 1; }, set(v) { this.__h = v; }, configurable: true });
Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
let gl = createMockGL();
canvas.getContext = () => gl;

const fx = new FX();
const r = new Renderer(canvas, { quality: 'high' });
await r.init(() => {});
r.buildWorld(world);

const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'hard', fx });
game.start();
const bots = [new AIController(game, 1, {}), new AIController(game, 2, {})];
const camera = new Camera();
camera.setAspect(804 / 360); camera.setViewport(804, 360);
camera.setTarget(game.playerBase.x, game.playerBase.z, true);
game.camera = camera;
game.settings = { fog: true, bars: true };
for (let i = 0; i < 30 * 45; i++) { for (const b of bots) b.update(1 / 30); game.update(1 / 30); }
const cx = game.playerBase.x, cz = game.playerBase.z;
for (let i = 0; i < UNITS; i++) {
  const a = (i / UNITS) * Math.PI * 2, rr = 3 + (i % 17) * 0.7;
  game.spawnUnitRaw(['spearman', 'swordsman', 'archer', 'knight'][i & 3], 2, cx + Math.cos(a) * rr * 2.2, cz + Math.sin(a) * rr * 2.2);
}
for (let i = 0; i < 60; i++) { for (const b of bots) b.update(1 / 30); game.update(1 / 30); }

const N = 20;
/* Minimum of two timed rounds: the first round of the first tier carries the
   JIT compile of every code path in the frame, which would otherwise be
   charged to whichever tier happens to be measured first. */
const bench = (fn) => {
  for (let i = 0; i < 4; i++) fn();
  let best = Infinity;
  for (let round = 0; round < 2; round++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) fn();
    best = Math.min(best, (performance.now() - t0) / N);
  }
  return best;
};

/* warm every path up at the tier the phone will use */
r.setQuality('medium');
for (let i = 0; i < 80; i++) {
  r.render(1 / 60, game);
  r._fillInstances(game, camera, 1 / 60);
  r._shadowPass(camera, 1 / 60);
  for (const fn of [() => r._drawTerrain(camera), () => r._drawModels(camera), () => r._drawSky(camera),
    () => r._drawWater(camera), () => r._drawDecals(game, camera), () => r._drawBillboards(game, camera),
    () => r._drawParticles(camera, game)]) fn();
  if (r.postTarget) r._drawPost();
}

console.log(`\n${'tier'.padEnd(8)} ${'buffer'.padEnd(12)} ${'frame'.padEnd(9)} ${'fill'.padEnd(8)} ${'shadow'.padEnd(9)} ${'draw'.padEnd(8)} draws  tris`);
for (const tier of TIER_ORDER) {
  r.setQuality(tier);
  for (let i = 0; i < 6; i++) r.render(1 / 60, game);
  const frame = bench(() => r.render(1 / 60, game));
  r.render(1 / 60, game);
  const stSnap = { ...r.stats };
  const fill = bench(() => r._fillInstances(game, camera, 1 / 60));
  const shadow = bench(() => r._shadowPass(camera, 1 / 60));
  const draw = bench(() => { r._fillInstances(game, camera, 1 / 60); r._drawModels(camera); });
  console.log(`${tier.padEnd(8)} ${(r.renderW + 'x' + r.renderH).padEnd(12)} ${frame.toFixed(2).padEnd(9)} ${fill.toFixed(2).padEnd(8)} ${shadow.toFixed(3).padEnd(9)} ${draw.toFixed(2).padEnd(8)} ${String(stSnap.drawCalls).padStart(5)}  ${stSnap.tris}`);
}

/* where does a single frame go, at the tier the phone will use? */
console.log('\nSTAGE BREAKDOWN (medium)');
r.setQuality('medium');
r.render(1 / 60, game);
for (const [name, fn] of [
  ['updateEnvironment', () => r.updateEnvironment(1 / 60, game.worldTime)],
  ['fillInstances', () => r._fillInstances(game, camera, 1 / 60)],
  ['pickTownLights', () => r._pickTownLights(game, camera, 1 / 60)],
  ['fillFires', () => r._fillFires(camera)],
  ['shadowPass', () => r._shadowPass(camera, 1 / 60)],
  ['drawTerrain', () => r._drawTerrain(camera)],
  ['drawModels', () => r._drawModels(camera)],
  ['drawSky', () => r._drawSky(camera)],
  ['drawWater', () => r._drawWater(camera)],
  ['drawDecals', () => r._drawDecals(game, camera)],
  ['drawBillboards', () => r._drawBillboards(game, camera)],
  ['drawParticles', () => r._drawParticles(camera, game)],
  ['drawPost', () => (r.postTarget ? r._drawPost() : null)]
]) console.log(`  ${name.padEnd(18)} ${bench(fn).toFixed(3)} ms`);

r.dispose();
