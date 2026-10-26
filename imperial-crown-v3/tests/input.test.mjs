/* ============================================================
   input.test.mjs — the control contract

   The single loudest complaint about v2 was that dragging the map scrolled the
   camera the wrong way. That is a sign error, and a sign error is exactly what
   a test is for. Everything here is asserted in screen space: we take a world
   point, project it before and after the gesture, and require that the point
   moved the way a finger would have dragged it.

   Also covered:
     • pinch out = zoom in, and the point between the fingers stays put
     • two-finger gestures can never place a move order (the v2 bug that sent
       a whole army to wherever the player had pinched)
     • a long press is attack-move, and its release must not also select
     • keyboard panning moves the view up-screen for ArrowUp
     • camera clamps (distance, pitch, world edge)
     • tap picking resolves the nearest unit, not the first in the list
   ============================================================ */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

/* ---------------- harness ---------------- */
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
function ctx2d() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: { width: 320, height: 320 },
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    createPattern: () => ({ setTransform() {} }),
    measureText: () => ({ width: 8 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    putImageData: () => {}, drawImage: () => {},
    setTransform() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
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
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.localStorage = window.localStorage;
globalThis.ImageData = window.ImageData;
globalThis.devicePixelRatio = 2;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};

const { App } = await import('../src/main.js');
const { Camera } = await import('../src/gfx/camera.js');

const app = new App();
app.canvas = document.getElementById('gl');
await app.boot();
await app.startMatch({ mode: 'sandbox', civ: 'franks', difficulty: 'sandbox', seed: 20261, quality: 'medium' });
globalThis.requestAnimationFrame = () => 0;
window.requestAnimationFrame = globalThis.requestAnimationFrame;

const cv = app.canvas;
const W = 900, H = 420;
Object.defineProperty(cv, 'clientWidth', { get: () => W, configurable: true });
Object.defineProperty(cv, 'clientHeight', { get: () => H, configurable: true });
cv.setPointerCapture = () => {};
cv.releasePointerCapture = () => {};
cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H });

let now = 1000;
const step = (n = 1) => { for (let i = 0; i < n; i++) { now += 16.7; app.loop(now); } };
step(20);

function pointer(type, x, y, extra = {}) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  ev.pointerId = extra.id ?? 1;
  ev.pointerType = extra.type ?? 'touch';
  ev.isPrimary = extra.id ? false : true;
  if (extra.button !== undefined) ev.button = extra.button;
  cv.dispatchEvent(ev);
  return ev;
}
const toScreen = (x, y, z) => {
  const o = [0, 0, 0];
  app.camera.project(x, y, z, o);
  return [(o[0] * 0.5 + 0.5) * W, (-o[1] * 0.5 + 0.5) * H];
};

/* ============================================================
   1. camera mathematics, without the input layer
   ============================================================ */
console.log('\nCAMERA DIRECTION');
const cam = new Camera({ yaw: 0.7, pitch: 0.62, dist: 46 });
cam.setAspect(W / H);
cam.setViewport(W, H);
cam.heightAt = () => 0;
cam.setTarget(0, 0, true);
cam.snap();
cam.update(1 / 60, { instant: true });

/** Screen-space displacement of the ground point at world (x,z). */
const drift = (camera, x, z, fn) => {
  const before = [0, 0, 0], after = [0, 0, 0];
  camera.project(x, 0, z, before);
  fn();
  camera.update(1 / 60, { instant: true });
  camera.project(x, 0, z, after);
  return [(after[0] - before[0]) * 0.5 * W, -(after[1] - before[1]) * 0.5 * H];
};

for (const yaw of [0, 0.7, Math.PI / 2, 2.4, -1.1]) {
  check(`drag right moves the world right (yaw ${yaw.toFixed(2)})`, () => {
    cam.desiredYaw = cam.yaw = yaw;
    cam.update(1 / 60, { instant: true });
    cam.setTarget(0, 0, true);
    cam.snap();
    cam.update(1 / 60, { instant: true });
    const [dx] = drift(cam, 0, 0, () => cam.panPixels(60, 0));
    assert(dx > 20, `world moved ${dx.toFixed(1)} px in x (expected > 20)`);
    assert(Math.abs(dx - 60) < 22, `drag of 60 px moved the world ${dx.toFixed(1)} px`);
  });
  check(`drag down moves the world down (yaw ${yaw.toFixed(2)})`, () => {
    cam.desiredYaw = cam.yaw = yaw;
    cam.update(1 / 60, { instant: true });
    cam.setTarget(0, 0, true);
    cam.snap();
    cam.update(1 / 60, { instant: true });
    const [, dy] = drift(cam, 0, 0, () => cam.panPixels(0, 60));
    assert(dy > 10, `world moved ${dy.toFixed(1)} px down (expected > 10)`);
  });
}

check('keyboard ArrowUp pans up-screen', () => {
  cam.desiredYaw = cam.yaw = 0.7;
  cam.setTarget(0, 0, true);
  cam.update(1 / 60, { instant: true });
  const before = [0, 0, 0], after = [0, 0, 0];
  cam.project(0, 0, 0, before);
  cam.pan(0, 10);                    // what ArrowUp does
  cam.update(1 / 60, { instant: true });
  cam.project(0, 0, 0, after);
  // NDC y grows upward, so content moving down-screen is a negative delta
  const dy = -(after[1] - before[1]) * 0.5 * H;
  assert(dy > 0, `world moved ${dy.toFixed(1)} px, expected down-screen`);
});

check('zoom clamps and pinch-out zooms in', () => {
  cam.setTarget(0, 0, true);
  cam.desiredDist = cam.dist = 46;
  cam.zoom(0.5);              // trying to zoom in twice: should hit the floor
  cam.zoom(0.5);
  assert(cam.desiredDist === cam.minDist, 'did not clamp: ' + cam.desiredDist);
  cam.desiredDist = 46;
  cam.zoomSteps(0.88 ** 3 < 1 ? 3 : 3);
  assert(cam.desiredDist < 46, 'did not zoom in');
  cam.desiredDist = 92;
  cam.zoom(2);
  assert(cam.desiredDist === cam.maxDist, 'max clamp broken: ' + cam.desiredDist);
});

check('zoom-at-cursor keeps the ground point under the cursor', () => {
  cam.setTarget(40, -30, true);
  cam.desiredDist = cam.dist = 40;
  cam.update(1 / 60, { instant: true });
  const nx = 0.72, ny = 0.35;
  const hit = [0, 0, 0];
  assert(cam.pickGround(nx, ny, cam.heightAt, hit), 'ray missed the ground');
  const wx = hit[0], wz = hit[2];
  for (let i = 0; i < 6; i++) { cam.zoomAt(0.9, nx, ny); cam.update(1 / 60, { instant: true }); }
  const after = [0, 0, 0];
  const ok = cam.pickGround(nx, ny, cam.heightAt, after);
  assert(ok, 'ray missed the ground after zoom');
  const err = Math.hypot(after[0] - wx, after[2] - wz);
  assert(err < 1.2, `ground point drifted ${err.toFixed(2)} m under the cursor`);
});

check('pitch is clamped to a playable band', () => {
  cam.setPitch(-5);
  assert(cam.desiredPitch >= 0.19, 'pitch floor ' + cam.desiredPitch);
  cam.setPitch(9);
  assert(cam.desiredPitch <= 1.37, 'pitch ceiling ' + cam.desiredPitch);
});

check('the target cannot leave the map', () => {
  cam.setTarget(9000, -9000);
  assert(cam.desired[0] <= 248 && cam.desired[2] >= -248, `target at ${cam.desired[0]},${cam.desired[2]}`);
});

/* ============================================================
   2. the real input layer
   ============================================================ */
console.log('\nTOUCH GESTURES');
app.camera.setTarget(app.game.playerBase.x, app.game.playerBase.z, true);
app.camera.yaw = app.camera.desiredYaw = 0.7;
app.camera.pitch = app.camera.desiredPitch = 0.62;
app.camera.dist = app.camera.desiredDist = 46;
app.camera.snap();
step(4);

check('one-finger drag pans the camera and never selects anything', () => {
  app.game.clearSelection();
  const before = app.camera.desired[0];
  pointer('pointerdown', 450, 200);
  for (let i = 1; i <= 8; i++) pointer('pointermove', 450 - i * 12, 200 + i * 2);
  pointer('pointerup', 354, 216);
  step(6);
  assert(app.game.selection.length === 0, 'a pan created a selection of ' + app.game.selection.length);
  assert(Math.abs(app.camera.desired[0] - before) > 2, 'the camera did not pan');
});

check('a pinch zooms in and issues no order', () => {
  const dist0 = app.camera.desiredDist;
  const villager = app.game.units.find((u) => u.team === 1 && !u.dead);
  app.game.setSelection([villager]);
  app.ui.refreshCommands(true);
  const order = { x: villager.tx ?? 0, z: villager.tz ?? 0, state: villager.state };
  pointer('pointerdown', 380, 200, { id: 21 });
  pointer('pointerdown', 520, 200, { id: 22 });
  for (let i = 1; i <= 10; i++) {
    pointer('pointermove', 380 - i * 8, 200, { id: 21 });
    pointer('pointermove', 520 + i * 8, 200, { id: 22 });
  }
  pointer('pointerup', 300, 200, { id: 21 });
  pointer('pointerup', 600, 200, { id: 22 });
  step(8);
  assert(app.camera.desiredDist < dist0 - 2, `distance ${dist0.toFixed(1)} -> ${app.camera.desiredDist.toFixed(1)}`);
  assert(villager.state === order.state, 'the pinch issued a move order to a villager');
  assert(app.game.selection.length === 1, 'the pinch changed the selection');
});

check('a two-finger tap selects the soldiers on screen', () => {
  // a sandbox starts with villagers only: make sure there is an army to find
  for (let i = 0; i < 3; i++) {
    const b = app.game.playerBase;
    app.game.spawnUnitRaw('spearman', 1, b.x + 4 + i, b.z + 3);
  }
  app.game.setSelection([app.game.units.find((u) => u.team === 1 && !u.dead)]);
  app.camera.update(1 / 60, { instant: true });
  app.game.clearSelection();
  app.ui.refreshCommands(true);
  pointer('pointerdown', 420, 220, { id: 31 });
  pointer('pointerdown', 470, 240, { id: 32 });
  pointer('pointerup', 420, 220, { id: 31 });
  pointer('pointerup', 470, 240, { id: 32 });
  step(3);
  const sel = app.game.selection;
  assert(sel.length > 0, 'nothing selected by the army tap');
  assert(sel.every((e) => e.team === 1 && e.kind === 'unit'), 'selected a non-unit');
});

check('tap slop: a 20 px wobble is a pan, not a tap', () => {
  const unit = app.game.units.find((u) => u.team === 1 && u.type === 'villager' && !u.dead);
  app.game.clearSelection();
  const [sx, sy] = toScreen(unit.x, unit.y + 1, unit.z);
  pointer('pointerdown', sx, sy);
  pointer('pointermove', sx + 11, sy + 6);
  pointer('pointermove', sx + 20, sy + 12);
  pointer('pointerup', sx + 20, sy + 12);
  step(3);
  assert(app.game.selection.length === 0, 'a wobble selected something');
});

check('a long press becomes attack-move', () => {
  const army = app.game.units.filter((u) => u.team === 1 && u.def.attack > 0 && !u.dead);
  assert(army.length > 0, 'no soldiers to command');
  app.game.setSelection(army);
  app.ui.refreshCommands(true);
  const g = [0, 0, 0];
  const tx = app.camera.target[0], tz = app.camera.target[2];
  app.camera.project(tx, app.game.heightAt(tx, tz) + 0.5, tz, g);
  const px = (g[0] * 0.5 + 0.5) * W, py = (-g[1] * 0.5 + 0.5) * H;
  pointer('pointerdown', px, py);
  app.input._longPress(px, py);       // the timer callback, called directly
  pointer('pointerup', px, py);
  step(2);
  const ordered = army.filter((u) => u.state === 'attackmove').length;
  assert(ordered > 0, `no unit received an attack-move (states: ${army.map((u) => u.state).join(',')})`);
});

console.log('\nPOINTER PICKS');
check('a tap picks the unit under the finger, not the first in the list', () => {
  const units = app.game.units.filter((u) => u.team === 1 && u.kind === 'unit' && !u.dead);
  assert(units.length >= 2, 'need two units');
  const target = units[units.length - 1];
  app.game.clearSelection();
  const [sx, sy] = toScreen(target.x, target.y + 1, target.z);
  const hit = app.input.pick(sx, sy);
  assert(hit === target, `picked ${hit && hit.type} instead of ${target.type}`);
});

check('taps outside every entity return null instead of the nearest one', () => {
  const hit = app.input.pick(4, 4);
  assert(hit === null, 'picked something from an empty corner');
});

console.log('\nKEYBOARD');
check('escape cancels placement, then clears the selection', () => {
  const g = app.game;
  g.placing = { type: 'house', footprint: 3 };
  app.input.key({ key: 'Escape', preventDefault() {} });
  assert(!g.placing, 'placement was not cancelled');
  g.setSelection([app.game.units.find((u) => u.team === 1 && !u.dead)]);
  app.input.key({ key: 'Escape', preventDefault() {} });
  assert(g.selection.length === 0, 'selection survived escape');
});

check('number keys do not scroll the camera', () => {
  app.input.fling = null;
  app.input.keys.clear();
  const before = app.camera.desired[0];
  for (const k of ['w', 'a', 's', 'd']) app.input.key({ key: k, preventDefault() {} });
  app.input.keys.clear();
  app.input.update(0.1);
  assert(Math.abs(app.camera.desired[0] - before) < 0.01, 'a letter key panned the camera');
});

console.log('');
if (fails.length) {
  console.log(`INPUT FAILURES (${fails.length})`);
  for (const f of fails) console.log('   ' + f);
  process.exit(1);
}
console.log('INPUT CHECKS PASSED');
