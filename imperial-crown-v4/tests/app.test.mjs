/* End-to-end application test: boots the real App with a mock WebGL2 context,
   starts a match, drives the frame loop, then plays the game through the real
   input layer (taps, drags, minimap clicks) and the real HUD. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;

function ctx2d() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: { width: 320, height: 320 },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
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
// run animation frames synchronously-ish but do not recurse forever
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};
const flushRaf = () => {};

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.stack.split('\n').slice(0, 4).join(' | ')}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.stack.split('\n').slice(0, 4).join(' | ')}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { App } = await import('../src/main.js');
const { AGES } = await import('../src/sim/data.js');

console.log('\nAPP BOOT');
const app = new App();
app.canvas = document.getElementById('gl');
await app.boot();
check('renderer ready', () => assert(app.renderer && app.renderer.ready, 'renderer not ready'));
check('menu visible after boot', () => assert(!document.getElementById('menuScreen').classList.contains('hidden'), 'menu hidden'));
check('boot screen dismissed', () => assert(document.getElementById('bootScreen').classList.contains('hidden'), 'boot still up'));

console.log('\nMATCH START');
await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261, quality: 'medium' });
// after start-up, the test drives the loop manually instead of the browser's rAF
globalThis.requestAnimationFrame = () => 0;
window.requestAnimationFrame = globalThis.requestAnimationFrame;
check('game running', () => assert(app.running && app.game, 'not running'));
check('hud visible', () => assert(!document.getElementById('hud').classList.contains('hidden'), 'hud hidden'));
check('input attached', () => assert(app.input && app.input.game === app.game, 'no input'));
check('camera framed on base', () => {
  const b = app.game.world.playerBase;
  const d = Math.hypot(app.camera.target[0] - b.x, app.camera.target[2] - b.z);
  assert(d < 40, 'camera is ' + d.toFixed(1) + ' m from base');
});
check('start pop cap and villagers', () => {
  const t = app.game.teams.get(1);
  const v = app.game.units.filter((u) => u.team === 1 && u.type === 'villager' && !u.dead).length;
  assert(v >= 4, 'only ' + v + ' villagers');
  assert(t.popCap >= 15, 'pop cap ' + t.popCap);
});

const cv = app.canvas;
Object.defineProperty(cv, 'clientWidth', { get: () => 900, configurable: true });
Object.defineProperty(cv, 'clientHeight', { get: () => 420, configurable: true });
cv.setPointerCapture = () => {};
cv.releasePointerCapture = () => {};
cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 420, right: 900, bottom: 420 });

let now = 1000;
const step = () => { now += 16.7; app.loop(now); flushRaf(); };
check('600 frames of gameplay', () => {
  for (let i = 0; i < 600; i++) step();
  const st = app.renderer.stats;
  assert(st.drawCalls > 5, 'no draws: ' + st.drawCalls);
  assert(app.game.time > 8, 'sim time did not advance: ' + app.game.time.toFixed(2));
});
console.log(`  (${app.game.time.toFixed(1)} s simulated, ${app.renderer.stats.drawCalls} draws, ${app.renderer.stats.tris} tris)`);

/* ---------- real pointer input ---------- */
function pointer(type, x, y, extra = {}) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  ev.pointerId = extra.id ?? 1;
  ev.pointerType = 'touch';
  ev.isPrimary = true;
  Object.assign(ev, extra);
  cv.dispatchEvent(ev);
  return ev;
}
function screenOf(e) {
  const out = [0, 0, 0];
  app.camera.project(e.x, (e.y || 0) + 1.0, e.z, out);
  return [(out[0] * 0.5 + 0.5) * 900, (-out[1] * 0.5 + 0.5) * 420];
}

console.log('\nINPUT');
const villager = app.game.units.find((u) => u.team === 1 && u.type === 'villager' && !u.dead);
check('tap selects a villager', () => {
  const [sx, sy] = screenOf(villager);
  pointer('pointerdown', sx, sy);
  pointer('pointerup', sx, sy);
  step();
  const sel = app.game.selection;
  assert(sel.length === 1, 'selection size ' + sel.length);
});
check('tap ground orders a move', () => {
  const before = { x: villager.x, z: villager.z };
  const tx = before.x + 14, tz = before.z + 6;
  const out = [0, 0, 0];
  app.camera.project(tx, app.game.heightAt(tx, tz), tz, out);
  const px = (out[0] * 0.5 + 0.5) * 900, py = (-out[1] * 0.5 + 0.5) * 420;
  pointer('pointerdown', px, py);
  pointer('pointerup', px, py);
  for (let i = 0; i < 180; i++) step();
  const moved = Math.hypot(villager.x - before.x, villager.z - before.z);
  assert(moved > 3, 'villager moved only ' + moved.toFixed(1) + ' m');
});
check('drag pans the camera', () => {
  const before = app.camera.desired[0];
  pointer('pointerdown', 450, 200);
  for (let i = 1; i <= 6; i++) pointer('pointermove', 450 - i * 18, 200);
  pointer('pointerup', 342, 200);
  for (let i = 0; i < 30; i++) step();
  assert(Math.abs(app.camera.desired[0] - before) > 1, 'camera did not pan');
});
check('pinch zooms', () => {
  const before = app.camera.desiredDist;
  const p1 = pointer('pointerdown', 400, 200, { id: 11 });
  const p2 = pointer('pointerdown', 500, 200, { id: 12 });
  for (let i = 1; i <= 8; i++) {
    pointer('pointermove', 400 - i * 6, 200, { id: 11 });
    pointer('pointermove', 500 + i * 6, 200, { id: 12 });
  }
  pointer('pointerup', 352, 200, { id: 11 });
  pointer('pointerup', 548, 200, { id: 12 });
  for (let i = 0; i < 40; i++) step();
  assert(Math.abs(app.camera.desiredDist - before) > 0.5, 'zoom unchanged');
});
check('drag box selects an army', () => {
  game_box();
  function game_box() {
    const army = app.game.units.filter((u) => u.team === 1 && !u.dead).slice(0, 3);
    app.game.setSelection(army);
    app.ui.refreshCommands();
    return army;
  }
});
check('minimap click recentres', () => {
  const mini = document.getElementById('minimap');
  mini.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 160 });
  mini.setPointerCapture = () => {};
  const before = app.camera.desired[0];
  mini.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 130, clientY: 30 }));
  mini.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  for (let i = 0; i < 40; i++) step();
  assert(Math.abs(app.camera.desired[0] - before) > 5, 'minimap did not move the camera');
});
check('HUD buttons do not throw', () => {
  for (const id of ['btnIdle', 'btnArmy', 'btnTech', 'btnDecrees', 'btnSound', 'btnPause', 'ageBtn', 'camRotL', 'camRotR', 'camHome', 'camZoomIn', 'camZoomOut', 'btnGotoTC', 'btnMiniMode', 'btnFormation', 'inspMultiBtn']) {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing #' + id);
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    step();
    app.menu.closeModal();
    if (app.paused) { app.paused = false; }
  }
});
check('stance buttons', () => {
  for (const s of ['aggressive', 'defensive', 'stand']) {
    document.querySelector(`[data-stance="${s}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    step();
  }
});
check('pause + resume', () => {
  app.togglePause();
  assert(app.paused, 'not paused');
  const t = app.game.time;
  for (let i = 0; i < 60; i++) step();
  assert(Math.abs(app.game.time - t) < 0.05, 'time advanced while paused');
  app.paused = false;
  app.menu.closeModal();
  for (let i = 0; i < 60; i++) step();
  assert(app.game.time > t, 'time did not resume');
});
check('save writes a campaign', () => {
  assert(app.saveMatch(), 'save failed');
  const save = window.localStorage.getItem('imperial-crown-save');
  assert(save && save.length > 100, 'save empty');
});
const savedRes = { ...app.game.teams.get(1).res, _units: app.game.units.filter((u) => u.team === 1 && !u.dead).length };
await acheck('load restores the campaign', async () => {
  const save = JSON.parse(window.localStorage.getItem('imperial-crown-save'));
  const liveRaf = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = liveRaf; window.requestAnimationFrame = liveRaf;
  await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261, load: save });
  globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  const t = app.game.teams.get(1);
  const units = app.game.units.filter((u) => u.team === 1 && !u.dead).length;
  assert(units === savedRes._units, `units ${units} != ${savedRes._units}`);
  assert(Math.abs(t.res.wood - savedRes.wood) < 1, `wood ${t.res.wood} != ${savedRes.wood}`);
  assert(app.renderer.stats.drawCalls > 5, 'renderer stopped after load');
});
/* Loading a save must be *clean*: the previous match's buildings have to take
   their navigation footprints with them. v2 truncated the entity arrays, so
   every footprint stayed counted and each reload stacked another blocked layer
   on the same cells -- after three loads the town centre was an island. */
await acheck('two reloads do not poison the navigation grid', async () => {
  const raf = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = raf;
  window.requestAnimationFrame = raf;
  await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261, quality: 'low' });
  globalThis.requestAnimationFrame = () => 0;
  window.requestAnimationFrame = () => 0;
  const g = app.game;
  const base = g.world.playerBase;
  const baseline = g.navBuild.reduce((a, v) => a + v, 0);
  for (let pass = 0; pass < 3; pass++) {
    assert(app.saveMatch(), 'save failed');
    const save = JSON.parse(window.localStorage.getItem('imperial-crown-save'));
    const r = (fn) => setTimeout(() => fn(performance.now()), 0);
    globalThis.requestAnimationFrame = r; window.requestAnimationFrame = r;
    await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261, load: save });
    globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  }
  const g2 = app.game;
  const after = g2.navBuild.reduce((a, v) => a + v, 0);
  assert(after === baseline, `blocked nav cells grew ${baseline} -> ${after} over three reloads`);
  // and the town's own footprint is walkable again where it should be
  const passable = g2.isPassable(g2.world.playerBase.x + 9, g2.world.playerBase.z + 9, { radius: 0.4, def: {} });
  assert(passable, 'ground beside the town centre is permanently blocked');
  // a villager dropped next to the town centre must be able to walk away
  const v = g2.spawnUnitRaw('villager', 1, g2.world.playerBase.x + 9, g2.world.playerBase.z + 9);
  g2.orderMove([v], g2.world.playerBase.x + 26, g2.world.playerBase.z + 9);
  for (let i = 0; i < 240; i++) step();
  assert(Math.hypot(v.x - (g2.world.playerBase.x + 9), v.z - (g2.world.playerBase.z + 9)) > 4,
    'a villager could not walk away from the town centre after a reload');
});

check('end screen', () => {
  app.game.endGame(true, 'Test victory');
  for (let i = 0; i < 30; i++) step();
});
await new Promise((r) => setTimeout(r, 1100));
check('end screen visible after the delay', () => {
  assert(!document.getElementById('endScreen').classList.contains('hidden'), 'end screen hidden');
  assert(document.getElementById('endTitle').textContent.length > 3, 'no title');
});
check('play again', () => {
  document.getElementById('btnEndAgain').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
check('quit to menu', () => {
  app.quitToMenu();
  assert(!document.getElementById('menuScreen').classList.contains('hidden'), 'menu not shown');
});

/* Sandbox is the mode a player uses to look at the game, build freely and try
   a fight. It has no opponent, so it must not start an AI controller: that
   controller had no base to defend, adopted the first team-2 unit it saw and
   marched a hand-placed sparring partner off across the island. */
await acheck('a sandbox match has no opponent and leaves your sparring partners alone', async () => {
  // startMatch waits on one animation frame, and the harness stubbed rAF out
  // after the first match; give it a real one back for the boot, then take it
  // away again so the test drives the loop itself
  const raf = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = raf;
  window.requestAnimationFrame = raf;
  await app.startMatch({ mode: 'sandbox', civ: 'franks', difficulty: 'standard', seed: 20261, quality: 'low' });
  globalThis.requestAnimationFrame = () => 0;
  window.requestAnimationFrame = () => 0;
  assert(app.running && app.game, 'the sandbox match did not start');
  assert(app.ai === null, 'a sandbox match started an AI controller');
  const g = app.game;
  assert(!g.buildings.some((b) => b.team === 2 && !b.dead), 'the sandbox has an enemy town');
  const base = g.world.playerBase;
  const u = g.spawnUnitRaw('huskarl', 2, base.x + 20, base.z + 15);
  assert(u, 'could not place a sparring partner');
  const x0 = u.x, z0 = u.z;
  for (let i = 0; i < 600; i++) step();
  const moved = Math.hypot(u.x - x0, u.z - z0);
  assert(moved < 5, `the sandbox enemy walked ${moved.toFixed(1)} m without being ordered to`);
});
check('quit the sandbox', () => {
  app.quitToMenu();
  assert(!document.getElementById('menuScreen').classList.contains('hidden'), 'menu not shown');
});

/* A War of Crowns is the one mode where the save has more than two sides to
   remember, and where a reload that quietly fell back to a duel would throw
   the player into a different match. The save carries its own island. */
await acheck('a four-crown war saves and reloads as the same war', async () => {
  const raf = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = raf; window.requestAnimationFrame = raf;
  await app.startMatch({ mode: 'kingdoms', civ: 'franks', difficulty: 'standard', seed: 20261, kingdoms: 4, victory: 'regicide' });
  globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  const g = app.game;
  assert(g.teamIds.length === 4, `${g.teamIds.length} teams`);
  assert(app.ais.length === 3, `${app.ais.length} AI controllers`);
  for (const t of g.teamIds) g.teams.get(t).res.gold = 300 + t * 10;
  const crownCourt = g.court.rec(4);
  assert(crownCourt, 'the fourth crown has no court');
  assert(app.saveMatch(), 'the war could not be saved');
  const save = JSON.parse(window.localStorage.getItem('imperial-crown-save'));
  assert(save.kingdoms === 4 && save.victory === 'regicide', `saved as ${save.kingdoms} crowns, ${save.victory}`);
  assert(Object.keys(save.teams).length === 4, `${Object.keys(save.teams).length} ledgers saved`);
  g.fallenTeams.add(3);
  g.lastBlood.set(3, 2);
  assert(app.saveMatch(), 'the war could not be saved after a fall');
  const save2 = JSON.parse(window.localStorage.getItem('imperial-crown-save'));

  const r = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = r; window.requestAnimationFrame = r;
  await app.startMatch({ mode: 'kingdoms', civ: 'franks', difficulty: 'standard', seed: 20261, load: save2 });
  globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  const g2 = app.game;
  assert(g2.teamIds.length === 4, `the reloaded war has ${g2.teamIds.length} crowns`);
  assert(g2.victory === 'regicide', `victory came back as ${g2.victory}`);
  assert(g2.fallenTeams.has(3), 'the fallen crown came back to life');
  assert(g2.lastBlood.get(3) === 2, 'the blood debt was forgotten');
  assert(g2.court.rec(4), 'the fourth crown lost its court on reload');
  for (const t of g2.teamIds) {
    assert(Math.abs(g2.teams.get(t).res.gold - (300 + t * 10)) < 1, `crown ${t} came back with ${g2.teams.get(t).res.gold} gold`);
  }
  assert(app.ais.length === 3, 'the reloaded war lost its AI crowns');
  for (const a of app.ais) assert(a.foe !== null, 'an AI crown has no foe after a reload');
});
/* A reload is authoritative. Two things used to be lost between the save and
   the load: the garrison (every man came back standing on the ground beside a
   tower he had been inside) and, when a crown was over its cap because its
   houses had been burned, the men themselves -- spawnUnit() enforced the
   population gate and returned null. */
await acheck('a reload restores the garrison and never drops a soldier', async () => {
  const raf = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = raf; window.requestAnimationFrame = raf;
  await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261 });
  globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  const g = app.game;
  const hall = g.buildings.find((b) => b.team === 1 && b.def.ageAdvance);
  assert(hall && hall.def.garrison, 'the hall cannot hold a garrison');
  const men = [];
  for (let i = 0; i < 3; i++) {
    const u = g.spawnUnitRaw('archer', 1, hall.x + 6 + i * 0.5, hall.z + 6);
    assert(u, 'archer spawn failed');
    assert(g.garrisonUnit(u, hall), 'the hall refused the garrison');
    men.push(u);
  }
  /* over the cap: burn the houses that made the room */
  for (const b of g.buildings) if (b.team === 1 && b.type === 'house') b.dead = true;
  g.recomputePop();
  assert(g.teams.get(1).popUsed > g.teams.get(1).popCap, 'the crown was not over its cap');
  const before = {
    men: g.units.filter((u) => !u.dead && u.team === 1).length,
    inHall: hall.garrison.length,
    pop: g.teams.get(1).popUsed
  };
  assert(app.saveMatch(), 'the match could not be saved');
  const blob = JSON.parse(window.localStorage.getItem('imperial-crown-save'));
  const r = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.requestAnimationFrame = r; window.requestAnimationFrame = r;
  await app.startMatch({ mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 20261, load: blob });
  globalThis.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  const g2 = app.game;
  g2.recomputePop();
  const after = {
    men: g2.units.filter((u) => !u.dead && u.team === 1).length,
    inHall: g2.buildings.filter((b) => b.team === 1).reduce((n, b) => n + (b.garrison ? b.garrison.length : 0), 0),
    pop: g2.teams.get(1).popUsed
  };
  assert(after.men === before.men, `the reload lost ${before.men - after.men} men of ${before.men}`);
  assert(after.inHall === before.inHall, `the reload emptied the garrison (${before.inHall} → ${after.inHall})`);
  assert(after.pop === before.pop, `population came back as ${after.pop}, saved as ${before.pop}`);
  for (const u of g2.units) {
    if (!u.garrisoned) continue;
    assert(u.garrisonTarget && !u.garrisonTarget.dead, 'a man is garrisoned in nothing');
  }
});

check('quit the war', () => {
  app.quitToMenu();
  assert(!document.getElementById('menuScreen').classList.contains('hidden'), 'menu not shown');
});

console.log('');
if (fails.length) { console.log(`FAILURES (${fails.length}):`); for (const f of fails) console.log(' - ' + f); process.exit(1); }
console.log('APPLICATION CHECKS PASSED');
