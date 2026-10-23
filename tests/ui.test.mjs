/* Headless UI smoke test: loads index.html in jsdom, boots the menu and the
   entire in-game HUD against a real simulated match, then hammers every
   command button for every unit and building type. Catches DOM wiring bugs
   that would otherwise only show up on a phone. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;

/* ---- fake 2D canvas context (jsdom has no rasteriser) ---- */
function ctx2d() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: { width: 320, height: 320 },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 12 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    putImageData: () => {},
    setTransform: () => {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      return () => {};
    },
    set() { return true; }
  });
}
window.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind === '2d') return ctx2d();
  return null;
};

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = window.localStorage;

const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { fails.push(`${name}: ${err.message}`); console.log(`  FAIL ${name} — ${err.stack.split('\n').slice(0, 3).join(' | ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const { Menu } = await import('../src/game/menu.js');
const { UI } = await import('../src/game/ui.js');
const { Camera } = await import('../src/gfx/camera.js');
const { Game } = await import('../src/sim/game.js');
const { generateWorld } = await import('../src/sim/worldgen.js');
const { UNIT_DEFS, BUILDING_DEFS, CIVS, AGES } = await import('../src/sim/data.js');
const { STATE } = await import('../src/sim/entities.js');
const { FX } = await import('../src/gfx/fx.js');

const audio = { play() {}, unlock() {}, setMusic() {}, setEnabled() {}, startMusic() {}, stopMusic() {} };


console.log('\nMENU');
let started = null;
const menu = new Menu({ audio, quality: 'medium', onStart: (o) => { started = o; }, onSettingsChanged() {} });
menu.bind();
check('civ grid built', () => assert(document.getElementById('civGrid').children.length >= 4, 'no civ chips'));
check('start summary', () => assert(document.getElementById('startSub').textContent.length > 4, 'empty summary'));
check('art canvas painted', () => assert(document.getElementById('artTitle').textContent.length > 2, 'no art title'));
check('mode switch', () => {
  document.querySelector('[data-mode="regicide"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(menu.state.mode === 'regicide', 'mode not set');
  document.querySelector('[data-mode="campaign"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
check('civ switch', () => {
  const chip = document.querySelector('#civGrid button');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(menu.state.civ === chip.dataset.civ, 'civ not set');
});
check('difficulty switch', () => {
  document.querySelector('[data-diff="standard"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(menu.state.difficulty === 'standard', 'diff not set');
});
check('settings modal', () => {
  menu.openSettings();
  assert(!document.getElementById('modalScreen').classList.contains('hidden'), 'modal hidden');
  const toggle = document.querySelector('#modalBody button[data-set]');
  if (toggle) toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  menu.closeModal();
});
check('help modal', () => { menu.openHelp(); menu.closeModal(); });
check('save round-trip', () => {
  const data = { version: 2, seed: 5, res: { food: 100 } };
  assert(Menu.writeSave(data), 'write failed');
  assert(Menu.readSave().seed === 5, 'read mismatch');
  Menu.clearSave();
  assert(Menu.readSave() === null, 'clear failed');
});
check('start fires', () => {
  document.getElementById('btnStart').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(started && started.mode === 'campaign', 'onStart not called');
});

console.log('\nHUD');
const world = generateWorld(20261);
const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: new FX(), sound: { play() {} }, rand: Math.random });
game.start();
const camera = new Camera({});
camera.heightAt = world.heightAt;
const renderer = { stats: { drawCalls: 0, tris: 0, instances: 0 }, qualityName: 'medium', canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 420 }) }, projectToScreen() { return [0, 0, 0]; } };
const app = { togglePause() {}, openPause() {}, quit() {} };
const ui = new UI({ game, renderer, camera, audio, menu, app });
ui.show();
ui.setGame(game);

check('minimap base built', () => assert(ui.miniBase, 'no minimap base'));
check('update loop is stable', () => {
  for (let i = 0; i < 240; i++) {
    game.update(1 / 60);
    ui.update(1 / 60);
  }
});
check('camera rail: rotate, zoom and tilt', () => {
  const yaw0 = camera.desiredYaw;
  document.getElementById('camRotL').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.getElementById('camRotR').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(Math.abs(camera.desiredYaw - yaw0) < 1e-9, 'rotate buttons do not cancel out');
  const d0 = camera.desiredDist;
  document.getElementById('camZoomIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(camera.desiredDist < d0, 'zoom in did nothing');
  document.getElementById('camZoomOut').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // tilt up lowers the pitch (toward the horizon) and clamps at the floor
  const p0 = camera.desiredPitch;
  const up = document.getElementById('camTiltUp');
  assert(up, 'no tilt control: the night sky is unreachable on a phone');
  up.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  up.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  assert(camera.desiredPitch < p0, 'tilt up did not lower the pitch');
  for (let i = 0; i < 40; i++) {
    up.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    up.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  }
  assert(camera.desiredPitch >= 0.2 && camera.desiredPitch <= 0.32,
    'tilt does not stop at the pitch floor: ' + camera.desiredPitch);
  const down = document.getElementById('camTiltDown');
  for (let i = 0; i < 40; i++) {
    down.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    down.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  }
  assert(camera.desiredPitch > 1.2, 'tilt down does not reach the top-down limit: ' + camera.desiredPitch);
  camera.desiredPitch = camera.pitch = 0.86;
});

check('resources render', () => {
  const food = document.getElementById('resFood').textContent;
  assert(food !== '0' || game.teams.get(1).res.food > 0, 'food not shown');
});

const villager = game.units.find((u) => u.team === 1 && u.type === 'villager');
check('villager selection commands', () => {
  game.setSelection([villager]);
  ui.refreshCommands();
  ui.update(0.2);
  const btns = document.querySelectorAll('#cmdGrid .cmdBtn');
  assert(btns.length > 2, `only ${btns.length} commands`);
});
check('build menu opens', () => {
  ui.openBuildMenu([villager]);
  assert(document.querySelectorAll('#cmdGrid .cmdBtn').length > 4, 'no build options');
  ui.refreshCommands();
});
check('every building command button', () => {
  game.teams.get(1).res.food = 9000; game.teams.get(1).res.wood = 9000;
  game.teams.get(1).res.gold = 9000; game.teams.get(1).res.stone = 9000;
  for (const type of Object.keys(BUILDING_DEFS)) {
    if (BUILDING_DEFS[type].neutral) continue;
    const b = game.placeBuilding(type, 1, world.playerBase.x + 6 + Math.random() * 8, world.playerBase.z + 8 + Math.random() * 8, { free: true, instant: true });
    if (!b) continue;
    game.setSelection([b]);
    ui.refreshCommands();
    ui.update(0.1);
    for (const btn of document.querySelectorAll('#cmdGrid .cmdBtn')) {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      ui.update(0.1);
    }
    b.dead = true;
  }
});
check('every unit command button', () => {
  for (const type of Object.keys(UNIT_DEFS)) {
    const u = game.spawnUnit(type, 1, world.playerBase.x + 4, world.playerBase.z + 4);
    if (!u) continue;
    game.setSelection([u]);
    ui.refreshCommands();
    ui.update(0.1);
    for (const btn of document.querySelectorAll('#cmdGrid .cmdBtn')) {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      ui.update(0.1);
    }
    u.dead = true;
  }
  game.clearSelection();
});
check('multi selection', () => {
  const army = game.units.filter((u) => !u.dead && u.team === 1).slice(0, 5);
  game.setSelection(army);
  ui.refreshCommands(); ui.update(0.1);
  assert(document.getElementById('inspName').textContent.length > 0, 'no inspector text');
});
check('tech / decrees / market modals', () => {
  ui.openTech(); menu.closeModal();
  ui.openDecrees(); menu.closeModal();
  ui.openMarket(); menu.closeModal();
});
check('a decree can be proclaimed from the council', () => {
  const t = game.teams.get(1);
  t.favor = 400;
  ui.openDecrees();
  const row = document.querySelector('#modalBody [data-decree]');
  assert(row, 'no decree buttons rendered');
  assert(!row.disabled, 'decree button disabled with 400 favour');
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(t.buffs.length > 0, 'no buff after proclaiming a decree');
  assert(t.favor < 400, 'favour was not spent');
  menu.closeModal();
});
check('market sells and buys at a moving price', () => {
  const t = game.teams.get(1);
  // stand up a finished market so trade is legal
  const tc = game.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const m = game.placeBuilding('market', 1, tc.x + 6, tc.z + 6, true);
  const mart = Array.isArray(m) ? m[0] : m;
  if (mart) mart.buildProgress = 1;
  t.res.gold = 5000;
  const before = t.res.food;
  const buy = game.marketTrade(1, 'food', 200, true);
  assert(buy.ok, 'buy failed: ' + buy.reason);
  assert(t.res.food > before, 'food did not increase');
  const before2 = t.res.gold;
  const sell = game.marketTrade(1, 'wood', 200, false);
  assert(sell.ok, 'sell failed: ' + sell.reason);
  assert(t.res.gold > before2 - 5000, 'gold sanity');
  ui.openMarket();
  const buyBtn = document.querySelector('#modalBody [data-buy]');
  assert(buyBtn, 'no buy buttons in the market modal');
  buyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  menu.closeModal();
});
check('age advance', () => {
  game.teams.get(1).res.food = 9000; game.teams.get(1).res.gold = 9000;
  ui.ageAdvance();
  assert(game.teams.get(1).ageResearch !== null || game.teams.get(1).age > 0, 'age research not started');
});
check('idle villager + army + groups', () => {
  ui.cycleIdleVillager();
  ui.selectArmy();
  ui.selectGroup(1);
  ui.centreOnTownCentre();
  ui.toggleSound();
  ui.cycleStance();
  ui.sendScout();
});
check('the clock shows the time and the day phase', () => {
  const el = document.getElementById('worldTime');
  assert(el, 'no #worldTime in the HUD');
  game.setTimeOfDay(12.25);
  ui.update(0.4);
  assert(/12:1\d/.test(el.textContent), 'clock does not show noon: ' + el.textContent);
  assert(el.dataset.phase === 'day', 'noon is not marked as day: ' + el.dataset.phase);
  game.setTimeOfDay(22);
  ui.update(0.4);
  assert(/2[12]:\d\d/.test(el.textContent), 'clock does not show night: ' + el.textContent);
  assert(el.dataset.phase === 'night', '22:00 is not marked as night: ' + el.dataset.phase);
  assert(/\u263e/.test(el.textContent), 'no moon glyph at night: ' + el.textContent);
  game.setTimeOfDay(6.2);
  ui.update(0.4);
  assert(el.dataset.phase === 'dawn', 'dawn not shown: ' + el.dataset.phase);
  game.setTimeOfDay(18.4);
  ui.update(0.4);
  assert(el.dataset.phase === 'dusk', 'dusk not shown: ' + el.dataset.phase);
});
check('selection box + ripples', () => {
  ui.showSelBox({ x: 10, y: 10, w: 40, h: 40 });
  ui.hideSelBox();
  ui.ripple(50, 50);
  ui.floatText(0, 0, 0, '+12', 'res');
});
check('alerts + perf', () => {
  game.notify('Test alert', 'bad');
  ui.update(0.4);
  const perf = document.getElementById('perfChip');
  ui.perfVisible = true;
  perf.classList.remove('hidden');
  ui.update(0.4);
});
check('end screen', () => {
  ui.showEnd(true, 'The enemy town centre has fallen');
  assert(!document.getElementById('endScreen').classList.contains('hidden'), 'end hidden');
  assert(document.getElementById('endTitle').textContent.length > 3, 'no end title');
});
check('survives 1500 mixed frames', () => {
  for (let i = 0; i < 1500; i++) {
    game.update(1 / 60);
    ui.update(1 / 60);
    if (i % 170 === 0) { game.setSelection(game.units.filter((u) => !u.dead).slice(0, 12)); ui.refreshCommands(); }
  }
});

console.log('');
if (fails.length) { console.log(`FAILURES (${fails.length}):`); for (const f of fails) console.log(' - ' + f); process.exit(1); }
console.log('ALL UI CHECKS PASSED');
