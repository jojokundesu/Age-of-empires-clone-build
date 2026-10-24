import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';
/* the bundle under test is this project's own dist, resolved from the test
   file so the suite works wherever the repository is checked out */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(dist + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
function ctx2d() {
  const g = { addColorStop() {} };
  const b = { canvas: { width: 320, height: 320 }, createLinearGradient: () => g, createRadialGradient: () => g,
    createPattern: () => ({ setTransform() {} }), measureText: () => ({ width: 8 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    putImageData() {}, drawImage() {}, setTransform() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  return new Proxy(b, { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
}
window.HTMLCanvasElement.prototype.getContext = function (k) {
  if (k === '2d') return ctx2d();
  if (k === 'webgl2') { this.__gl = this.__gl || createMockGL(); return this.__gl; }
  return null;
};
globalThis.window = window; globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage; globalThis.ImageData = window.ImageData;
globalThis.HTMLElement = window.HTMLElement; globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.MutationObserver = window.MutationObserver;
globalThis.Event = window.Event; globalThis.CustomEvent = window.CustomEvent;
globalThis.Node = window.Node; globalThis.DocumentFragment = window.DocumentFragment;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.WebGL2RenderingContext = window.WebGL2RenderingContext || function () {};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = () => {};
window.addEventListener = window.addEventListener.bind(window);
const js = readdirSync(dist + '/assets').find((f) => f.startsWith('index') && f.endsWith('.js'));
await import(dist + '/assets/' + js);
await new Promise((r) => setTimeout(r, 1200));
const app = window.__imperial;
console.log('app?', !!app, 'renderer ready?', app && app.renderer && app.renderer.ready, 'menu visible?', !document.getElementById('menuScreen').classList.contains('hidden'));
await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 7 });
globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
let now = 1000;
for (let i = 0; i < 300; i++) { now += 16.7; app.loop(now); }
console.log('time', app.game.time.toFixed(1), 'draws', app.renderer.stats.drawCalls, 'tris', app.renderer.stats.tris, 'units', app.game.units.length);
console.log('DIST BUNDLE OK');
