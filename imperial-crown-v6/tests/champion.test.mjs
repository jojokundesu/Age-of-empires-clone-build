/* ============================================================
   champion.test.mjs — the five promises of v6, asserted

   1. DIRECTIONS. v5 mirrored first-person steering: a thumb dragged
      right turned the view left, and a push forward slid sideways.
      Every check here is in *screen space* — a world point is
      projected through the real view-projection matrix before and
      after a movement, and has to land on the side of the screen the
      player pushed towards.

   2. MAGE PRODUCTION. The Arcane Order's mage was drawn on the Town
      Centre card and refused by the queue. This suite trains one
      through the real building API, the real command card, and the
      real economy, and checks the cap and the reasons.

   3. THE CHAMPION. A body you stand in earns renown, ranks and perks,
      and every perk changes a number the simulation actually reads.

   4. SQUADS. Formed through the drawer, fed by real fighting,
      promoted on shared experience, saved, reloaded, disbanded, and
      commanded from inside the body (follow / focus).

   5. SANDBOX MODS. A sandbox with the Workshop switched on starts
      with mods; with it switched off it starts clean.

   Harness: the real index.html, the real App, mock WebGL.
   ============================================================ */
import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  { url: 'https://v6.test/', pretendToBeVisual: true });
const { window } = dom;
function ctx2d() {
  const gradient = { addColorStop() {} };
  const base = { canvas: { width: 320, height: 320 },
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    createPattern: () => ({ setTransform() {} }), measureText: () => ({ width: 8 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, drawImage: () => {},
    setTransform() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });
}
window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === '2d') return ctx2d();
  if (type === 'webgl2') return this.__gl ||= createMockGL();
  return null;
};
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  HTMLCanvasElement: window.HTMLCanvasElement, localStorage: window.localStorage, devicePixelRatio: 1 });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
const liveRaf = (fn) => setTimeout(() => fn(performance.now()), 0);
const stopRaf = () => 0;
globalThis.requestAnimationFrame = window.requestAnimationFrame = liveRaf;
globalThis.cancelAnimationFrame = () => {};

const { App } = await import('../src/main.js');
const { STATE } = await import('../src/sim/entities.js');
const { UNIT_DEFS } = await import('../src/sim/data.js');
const { CHAMPION_RANKS, rankIndexFor } = await import('../src/sim/champion.js');

const app = new App();
app.canvas = document.getElementById('gl');
await app.boot();
const cv = app.canvas;
cv.setPointerCapture = () => {};
cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 420, right: 900, bottom: 420 });
Object.defineProperty(cv, 'clientWidth', { get: () => 900 });
Object.defineProperty(cv, 'clientHeight', { get: () => 420 });

let failures = 0;
/* unbuffered: a suite that dies (OOM, a hang) must still leave its trail */
const say = (line) => { try { writeSync(1, line + '\n'); } catch (e) { console.log(line); } };
function check(name, fn) {
  try { fn(); say('  ok  ' + name); }
  catch (err) { failures++; say('  FAIL ' + name + ': ' + (err.stack || err)); }
}
async function acheck(name, fn) {
  try { await fn(); say('  ok  ' + name); }
  catch (err) { failures++; say('  FAIL ' + name + ': ' + (err.stack || err)); }
}
let dc = null, cam = null;
async function start(opts) {
  globalThis.requestAnimationFrame = window.requestAnimationFrame = liveRaf;
  await app.startMatch({ civ: 'franks', difficulty: 'standard', quality: 'low', seed: 20261, ...opts });
  globalThis.requestAnimationFrame = window.requestAnimationFrame = stopRaf;
  /* every match builds its own camera, controller and UI: never keep a
     handle from the previous one */
  dc = app.game.directControl;
  cam = app.camera;
}
const tick = (g, n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) g.update(dt); };
const rebuild = (g) => {
  g.spatial.clear(); g.spatial.insertAll(g.units);
  g.buildingSpatial.clear(); for (const b of g.buildings) if (!b.dead) g.buildingSpatial.insert(b);
};
function openField(g) {
  const base = g.world.playerBase;
  for (let dx = -70; dx <= 70; dx += 3) for (let dz = -70; dz <= 70; dz += 3) {
    const x = base.x + dx, z = base.z + dz;
    if (g.isPassable(x, z, null) && g.isPassable(x + 6, z, null) && g.isPassable(x, z + 6, null)
      && g.heightAt(x, z) > 0.5) return [x, z];
  }
  throw new Error('no open field');
}
const spawn = (g, type, team, x, z) => {
  const u = g.spawnUnit(type, team, x, z, null, { force: true });
  assert.ok(u, 'spawn ' + type);
  return u;
};
/* The stick, as a thumb uses it: press on the left of the glass, push, hold,
   lift. `x`/`y` are in -1..1 and 48 px is a full ring. */
let STICK_ID = 90;
function stickPush(dc, x = 0, y = 1, strength = 0.62) {
  const id = ++STICK_ID;
  dc.pointerDown({ pointerId: id, clientX: 200, clientY: 330, pointerType: 'touch', preventDefault() {} });
  dc.pointerMove({
    pointerId: id, clientX: 200 + x * 48 * strength, clientY: 330 - y * 48 * strength,
    pointerType: 'touch', preventDefault() {}
  });
  return id;
}
function stickRelease(dc, id) {
  dc.pointerUp({ pointerId: id, clientX: 200, clientY: 330, pointerType: 'touch', preventDefault() {} });
}

/* screen-space helper: where does this world point sit on the canvas? */
const project = (x, y, z) => {
  app.camera.update(0);
  const p = app.renderer.projectToScreen(app.camera, x, y, z, [0, 0, 0]);
  assert.ok(p, 'point behind the camera');
  return { x: p[0], y: p[1] };
};

console.log('\nV6: DIRECTIONS, CHAMPIONS, MAGES, SQUADS AND SANDBOX MODS');

/* ============================================================
   1 · DIRECTIONS
   ============================================================ */
await start({ mode: 'campaign' });
let g = app.game;
let [ox, oz] = openField(g);
const hero = spawn(g, 'swordsman', 1, ox, oz);
rebuild(g);

check('first person enters a body with a legible view', () => {
  assert.ok(dc.enter(hero), 'enter refused');
  assert.equal(dc.unit, hero);
  assert.equal(hero.state, STATE.CONTROLLED);
  assert.ok(cam.firstPerson, 'no first-person camera');
  assert.ok(document.body.classList.contains('firstPerson'));
  const p = project(hero.x, hero.y + 1.6, hero.z);
  assert.ok(Math.abs(p.x - 450) < 40, `eye is ${p.x}px from centre, not centred`);
});

check('forward input always walks the way the camera looks', () => {
  for (const yaw of [0, 0.9, -2.2, 3.0]) {
    cam.firstPerson.yaw = yaw; cam.firstPerson.pitch = 0; cam.update(0);
    hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
    const before = [hero.x, hero.z];
    const id = stickPush(dc, 0, 1);
    tick(g, 12);
    stickRelease(dc, id);
    const dx = hero.x - before[0], dz = hero.z - before[1];
    const dist = Math.hypot(dx, dz);
    assert.ok(dist > 0.5, `yaw ${yaw}: the body did not move (${dist.toFixed(2)} m)`);
    const fwd = [Math.sin(yaw), Math.cos(yaw)];
    const along = (dx * fwd[0] + dz * fwd[1]) / dist;
    assert.ok(along > 0.97, `yaw ${yaw}: W walked ${(along * 100).toFixed(0)}% along the look direction`);
  }
});

/* A landmark standing in front of the eye is the honest witness: the body
   itself sits under the camera and cannot be projected. If the body strafes
   right, the world (and the landmark) must slide LEFT across the screen --
   that is what a rightward push looks like from inside the helmet. */
function landmarkShift(axis, yaw) {
  cam.firstPerson.yaw = yaw; cam.firstPerson.pitch = 0; cam.update(0);
  hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
  cam.update(0);
  const mark = [hero.x + Math.sin(yaw) * 11 + hero.x * 0, hero.y + 1.6, hero.z + Math.cos(yaw) * 11];
  const before = project(...mark);
  const id = stickPush(dc, axis, 0);
  tick(g, 10);
  stickRelease(dc, id);
  const dx = hero.x - ox, dz = hero.z - oz;
  const right = [-Math.cos(yaw), Math.sin(yaw)];
  return { shift: project(...mark).x - before.x, along: dx * right[0] + dz * right[1], moved: Math.hypot(dx, dz) };
}

check('a push to the right of the screen moves the body to the right of the screen', () => {
  for (const yaw of [0, 0.7, -1.4, 2.4]) {
    const r = landmarkShift(1, yaw);
    assert.ok(r.moved > 0.4, `yaw ${yaw}: D moved the body ${r.moved.toFixed(2)} m`);
    assert.ok(r.along > 0.35, `yaw ${yaw}: D moved ${r.along.toFixed(2)} m along the camera's own right axis`);
    assert.ok(r.shift < -10, `yaw ${yaw}: the landmark slid ${r.shift.toFixed(0)} px — D must take the world left`);
  }
});

check('a push to the left of the screen moves the body to the left of the screen', () => {
  for (const yaw of [0, 1.1, -2.6]) {
    const r = landmarkShift(-1, yaw);
    assert.ok(r.along < -0.35, `yaw ${yaw}: A moved ${r.along.toFixed(2)} m along the camera's right axis`);
    assert.ok(r.shift > 10, `yaw ${yaw}: the landmark slid ${r.shift.toFixed(0)} px — A must take the world right`);
  }
});

check('dragging the look region to the right turns the world to the left', () => {
  const evt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', preventDefault() {} });
  cam.firstPerson.yaw = 0; cam.firstPerson.pitch = 0; cam.update(0);
  const marker = [hero.x, hero.y + 1.4, hero.z + 12];
  const before = project(...marker);
  dc.pointerDown(evt(2, 690, 200));
  dc.pointerMove(evt(2, 790, 200));
  dc.pointerUp(evt(2, 790, 200));
  const after = project(...marker);
  assert.ok(after.x < before.x - 20,
    `the marker moved ${(after.x - before.x).toFixed(0)} px — dragging right must swing the view right, moving the world left`);
});

check('dragging down tilts the view down, so the horizon rises', () => {
  const evt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', preventDefault() {} });
  cam.firstPerson.yaw = 0; cam.firstPerson.pitch = 0; cam.update(0);
  const marker = [hero.x + 6, hero.y + 1.4, hero.z + 12];
  const before = project(...marker);
  dc.pointerDown(evt(3, 690, 120));
  dc.pointerMove(evt(3, 690, 220));
  dc.pointerUp(evt(3, 690, 220));
  const after = project(...marker);
  assert.ok(after.y < before.y - 5,
    `the marker moved ${(after.y - before.y).toFixed(0)} px — dragging down must look down, which lifts the world`);
});

check('a screen drag cannot move the body', () => {
  const evt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', preventDefault() {} });
  hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
  const before = [hero.x, hero.z];
  dc.pointerDown(evt(4, 700, 200));
  dc.pointerMove(evt(4, 760, 300));
  dc.pointerUp(evt(4, 760, 300));
  tick(g, 6);
  assert.ok(Math.hypot(hero.x - before[0], hero.z - before[1]) < 0.2, 'a look drag walked the body');
});

/* ---------------- the phone's own controls ---------------- */
const touch = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', preventDefault() {} });

check('pushing the stick past its ring sprints without a third thumb', () => {
  cam.firstPerson.yaw = 0; cam.update(0);
  hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
  hero.champion.stamina = 100; hero.champion.staminaDelay = 0;
  dc._dodge = null;
  dc.pointerDown(touch(21, 120, 300));
  dc.pointerMove(touch(21, 120, 250));            // a long push up: 50 px on a 48 px ring
  assert.equal(dc.stickSprint, true, 'a full push did not start a sprint');
  assert.ok(document.getElementById('fpStick').classList.contains('sprinting'), 'the stick never lit up');
  tick(g, 12);
  assert.ok(hero.champion.stamina < 100, 'sprinting down the stick cost no stamina');
  dc.pointerUp(touch(21, 120, 250));
  assert.equal(dc.stickSprint, false, 'the sprint stuck on after the thumb lifted');
  assert.equal(dc.sprintHeld, false);
});

check('a tap on an enemy locks on, and the hero swings by himself', () => {
  cam.firstPerson.yaw = 0; cam.firstPerson.pitch = -0.05; cam.update(0);
  hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
  const foe = spawn(g, 'spearman', 2, hero.x + 0.25, hero.z + 0.95);
  g.showFog = false; rebuild(g);
  cam.update(0);
  const p = app.renderer.projectToScreen(cam, foe.x, (foe.y || 0) + 0.9, foe.z, [0, 0, 0]);
  assert.ok(p && p[2] > 0, 'the enemy is not on screen');
  dc.pointerDown(touch(31, p[0], p[1]));
  dc.pointerUp(touch(31, p[0], p[1]));
  assert.equal(dc.locked, foe, 'the tap did not lock on');
  hero.attackCooldown = 0;
  dc.attackHeld = false;
  const hp = foe.hp;
  tick(g, 6);                                   // no thumb on ATTACK at all
  assert.ok(foe.hp < hp, 'auto-swing never landed a blow on the locked enemy');
  foe.kill(null);
  dc.lockTarget();
  assert.equal(dc.locked, null, 'the lock survived its target');
});

check('a tap on empty ground clears the lock', () => {
  cam.firstPerson.yaw = 0; cam.firstPerson.pitch = 0; cam.update(0);
  const foe = spawn(g, 'spearman', 2, hero.x, hero.z + 4);
  g.showFog = false; rebuild(g);
  cam.update(0);
  const p = app.renderer.projectToScreen(cam, foe.x, (foe.y || 0) + 0.9, foe.z, [0, 0, 0]);
  dc.pointerDown(touch(32, p[0], p[1])); dc.pointerUp(touch(32, p[0], p[1]));
  assert.equal(dc.locked, foe);
  dc.pointerDown(touch(33, 40, 40)); dc.pointerUp(touch(33, 40, 40));
  assert.equal(dc.locked, null, 'tapping the sky kept the lock');
  foe.kill(null);
});

check('block is a toggle a thumb can leave alone', () => {
  hero.champion.stamina = 100;
  const block = document.getElementById('fpBlock');
  block.click();
  assert.equal(hero.champion.blocking, true, 'the first tap did not raise the shield');
  assert.ok(block.classList.contains('active'), 'the button does not show its state');
  block.click();
  assert.equal(hero.champion.blocking, false, 'the second tap did not lower it');
});

check('a dodge rolls along the input, never against it', () => {
  cam.firstPerson.yaw = 0.4; cam.update(0);
  hero.x = ox; hero.z = oz; hero.stop(); hero.state = STATE.CONTROLLED;
  hero.champion.stamina = 100; hero.champion.dodgeReadyAt = 0;
  const sid = stickPush(dc, 0, 1);
  const before = [hero.x, hero.z];
  assert.equal(dc.dodge(), true, 'dodge refused');
  tick(g, 8);
  stickRelease(dc, sid);
  const dx = hero.x - before[0], dz = hero.z - before[1];
  const fwd = [Math.sin(0.4), Math.cos(0.4)];
  assert.ok(Math.hypot(dx, dz) > 1.5, 'the dodge did not move the body');
  assert.ok((dx * fwd[0] + dz * fwd[1]) / Math.hypot(dx, dz) > 0.9, 'the dodge went the wrong way');
});

/* ============================================================
   2 · MAGE PRODUCTION
   ============================================================ */
dc.exit();
app.quitToMenu();
await start({ mode: 'mods', mods: ['arcane'] });
g = app.game;
const arc = g.modHost.mods.get('arcane');
const town = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
const mageCap = () => g.units.filter((u) => u.team === 1 && !u.dead && UNIT_DEFS[u.type]?.caster).length;

check('the Town Centre really offers the Arcane Mage', () => {
  assert.ok(g.modHost, 'no mod host');
  assert.equal(typeof town.trainBlocker, 'function', 'buildings have no trainBlocker');
  assert.equal(town.trainBlocker('mage'), '', `the hall refuses its own mage: ${town.trainBlocker('mage')}`);
});

check('the command card draws an enabled Mage, and the tap queues him', () => {
  g.teams.get(1).res.food = 2000; g.teams.get(1).res.gold = 2000;
  g.setSelection([town]);
  app.ui.refreshCommands(true);
  const card = document.querySelector('[data-cmd="train:mage"]');
  assert.ok(card, 'no Mage card on the hall');
  assert.ok(!card.classList.contains('poor'), 'the Mage card is disabled with resources in the bank');
  card.click();
  assert.equal(town.queue.length, 1, 'nothing was queued');
  assert.equal(town.queue[0].type, 'mage');
});

await acheck('a queued mage is actually produced, and walks out of the hall', async () => {
  const before = mageCap();
  for (let i = 0; i < 1200 && mageCap() === before; i++) g.update(1 / 20);
  assert.equal(mageCap(), before + 1, 'the mage never appeared');
  const mage = g.units.find((u) => u.team === 1 && !u.dead && u.type === 'mage');
  assert.ok(mage, 'no mage in the army after training');
  assert.ok(mage.modState?.arcane, 'the produced mage has no Arcane state');
  assert.ok(mage.modState.arcane.mana > 0, 'the produced mage has no mana');
  assert.ok(arc.mod.spells().length > 4, 'the mage has no spellbook');
});

check('the spellbook shelf really casts what you tap', () => {
  /* A mage in first person: the shelf is rebuilt on every mana tick, so this
     also proves the delegation survives a re-render. */
  const mage = g.units.find((u) => u.team === 1 && !u.dead && u.type === 'mage');
  assert.ok(mage, 'no mage to possess');
  assert.ok(dc.enter(mage), 'the mage could not be possessed');
  assert.equal(document.getElementById('fpEquipment').dataset.kind, 'staff');
  mage.modState.arcane.rank = 6;
  mage.modState.arcane.mana = 300;
  assert.ok(!document.getElementById('fpSpellShelf').classList.contains('hidden'), 'the spellbook is hidden for a mage');
  const row = document.querySelector('#fpSpellList [data-spell="fireball"]');
  assert.ok(row, 'no fireball on the shelf');
  const mana = mage.modState.arcane.mana;
  row.click();
  assert.ok(mage.modState.arcane.mana < mana, 'tapping a spell row spent no mana');
  assert.ok(mage.modState.arcane.cd.fireball > g.time, 'the tapped spell never went on cooldown');
  dc.exit();
});

check('the once-a-day spell does not take the rest of the spellbook with it', () => {
  /* The reported bug: cast SKYFALL from the map and every other spell "just
     completely disappeared" -- the map had closed the book, and nothing ever
     opened it again. The book comes back, scrolled where it was, with only
     the spent spell greyed out. */
  const mage = g.units.find((u) => u.team === 1 && !u.dead && u.type === 'mage');
  assert.ok(mage, 'no mage to possess');
  assert.ok(dc.enter(mage), 'the mage could not be possessed');
  mage.modState.arcane.rank = 6;
  mage.modState.arcane.mana = 300;
  mage.modState.arcane.cd = Object.create(null);
  dc.openSpellShelf();
  const rows = () => [...document.querySelectorAll('#fpSpellList [data-spell]')].map((b) => b.dataset.spell);
  const before = rows();
  assert.ok(before.includes('fireball') && before.includes('skyfall'), 'the book is missing rows');
  assert.ok(dc.cast('skyfall'), 'SKYFALL could not be aimed');
  assert.ok(!document.getElementById('fpMap').classList.contains('hidden'), 'the map never opened');
  /* the tap a thumb makes on the map, through the element's own handler */
  const canvas = document.getElementById('fpMapCanvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 });
  canvas.onclick({ clientX: 150, clientY: 150 });
  assert.equal(arc.state.skyday, Math.floor(g.time / 240), 'the sky was not actually spent');
  assert.ok(document.getElementById('fpMap').classList.contains('hidden'), 'the map stayed open');
  assert.ok(!document.getElementById('fpSpellShelf').classList.contains('hidden'), 'the spellbook vanished after the daily spell');
  const after = rows();
  assert.deepEqual(after, before, 'the spellbook changed when the daily spell was used');
  const sky = document.querySelector('#fpSpellList [data-spell="skyfall"] small');
  assert.match(sky.textContent, /Tomorrow/i, `the spent spell should say tomorrow, said "${sky.textContent}"`);
  assert.ok(document.querySelector('#fpSpellList [data-spell="fireball"]'), 'fireball is gone from the book');
  dc.exit();
});

check('the cap is a reason, not a silent no-op', () => {
  g.teams.get(1).res.food = 5000; g.teams.get(1).res.gold = 5000;
  let guard = 0;
  while (mageCap() < 4 && guard++ < 40) {
    const reason = town.trainBlocker('mage');
    if (reason) break;
    town.queueUnit('mage');
    for (let i = 0; i < 400; i++) g.update(1 / 20);
  }
  /* at the limit the hall must *say so*, and the card must be disabled */
  if (mageCap() >= 4) {
    const reason = town.trainBlocker('mage');
    assert.ok(/Mage limit/i.test(reason), `expected a cap reason, got "${reason}"`);
    assert.ok(/Arcane Tower/i.test(reason), 'the reason does not say how to raise the cap');
  }
  g.setSelection([town]); app.ui.refreshCommands(true);
  const card = document.querySelector('[data-cmd="train:mage"]');
  if (mageCap() >= 4) assert.ok(card.classList.contains('poor'), 'the card is still tappable at the cap');
  assert.ok(reasonText(card), 'the card carries no explanation');
});
function reasonText(card) { return card && (card.getAttribute('title') || card.querySelector('.cardReason')?.textContent || ''); }

function placeBuilding(type) {
  for (let dx = -40; dx <= 40; dx += 2) for (let dz = -40; dz <= 40; dz += 2) {
    const x = town.x + dx, z = town.z + dz;
    if (!g.canPlaceAt(type, 1, x, z).ok) continue;
    const b = g.placeBuilding(type, 1, x, z);
    if (b) { b.buildProgress = 1; b.hp = b.maxHp; return b; }
  }
  throw new Error('could not place a ' + type);
}

check('a building that cannot train a unit says why', () => {
  const barracks = placeBuilding('barracks');
  assert.match(barracks.trainBlocker('mage'), /cannot be trained here|study only/i);
  assert.equal(town.trainBlocker('villager'), '', 'the hall must keep training villagers');
  const stable = placeBuilding('stable');
  assert.match(stable.trainBlocker('villager'), /cannot be trained here/i);
  assert.equal(stable.queueUnit('villager'), false, 'a stable queued a villager');
  assert.equal(town.queueUnit('archer'), false, 'the hall queued an archer');
});

/* ============================================================
   3 · THE CHAMPION
   ============================================================ */
let [hx, hz] = openField(g);
const champ = spawn(g, 'swordsman', 1, hx, hz);
rebuild(g);

check('entering a body declares a Champion with renown at zero', () => {
  assert.ok(dc.enter(champ), 'enter refused');
  assert.ok(champ.champion, 'no champion record');
  assert.equal(champ.champion.renown, 0);
  assert.ok(g.champions.current === champ, 'the controller and the Champion disagree');
  assert.equal(g.champions.rankName(champ), 'Sworn');
  assert.ok(document.getElementById('fpRank').textContent.length > 2, 'the HUD shows no rank');
});

check('deeds pay renown, and a rank pays a perk choice', () => {
  const gained = g.champions.addRenown(champ, 400, 'test');
  assert.ok(gained >= 1, `400 renown did not promote (${gained})`);
  assert.ok(champ.champion.renown >= 400);
  assert.ok(g.champions.pendingChoices(champ) >= 1, 'no perk choice after a promotion');
  assert.equal(g.champions.offers(champ).length, 3, 'not three offers');
});

check('a chosen perk changes the numbers the simulation reads', () => {
  const before = champ.stats().attack;
  const offer = g.champions.offers(champ).find((p) => p.id === 'keen_edge') || g.champions.offers(champ)[0];
  const result = g.champions.choose(champ, offer.id);
  assert.ok(result.ok, 'choose refused: ' + result.reason);
  champ._stats = null;
  const after = champ.stats().attack;
  if (offer.id === 'keen_edge') assert.ok(after > before * 1.15, `Keen Edge added ${(after - before).toFixed(2)} attack`);
  assert.ok(champ.champion.picks.includes(offer.id));
  /* 400 renown is two ranks, so two perks are owed: spend them all */
  while (g.champions.pendingChoices(champ) > 0) {
    const next = g.champions.offers(champ)[0];
    assert.ok(next, 'a pending choice with nothing offered');
    assert.ok(g.champions.choose(champ, next.id).ok, 'could not spend a pending perk');
  }
  assert.equal(g.champions.pendingChoices(champ), 0);
});

check('perks survive leaving the body', () => {
  const boost = champ.stats().attack;
  dc.exit();
  champ._stats = null;
  assert.equal(champ.stats().attack, boost, 'the perk vanished with the camera');
});

check('Undying refuses a killing blow', () => {
  champ.champion.picks.push('undying');
  champ.champion.spent = champ.champion.picks.length;
  g.champions.version++;
  champ._stats = null; champ.champion.undyingAt = 0;
  champ.hp = 12;
  champ.takeDamage(999, null, 'melee');
  assert.ok(champ.hp >= 1 && !champ.dead, 'Undying did not save the Champion');
  champ.hp = champ.maxHp;
});

check('Second Wind heals a body below the threshold', () => {
  champ.champion.picks.push('second_wind');
  champ.champion.spent = champ.champion.picks.length;
  g.champions.version++;
  champ.hp = champ.maxHp * 0.5;
  champ.takeDamage(champ.maxHp * 0.3, null, 'melee');
  assert.ok(champ.hp > champ.maxHp * 0.4, `Second Wind left the Champion at ${champ.hp.toFixed(0)} hp`);
  champ.hp = champ.maxHp;
});

check('a raised shield stops frontal damage and a fresh block parries', () => {
  const st = champ.champion;
  st.blocking = true; st.blockStart = g.time; st.stamina = 100;
  const front = { x: champ.x + Math.sin(champ.facing || 0) * 2, z: champ.z + Math.cos(champ.facing || 0) * 2, dead: false, attackCooldown: 0 };
  const out = g.champions.mitigate(champ, 100, front, 'melee');
  assert.ok(out < 20, `a fresh parry let ${out.toFixed(0)} damage through`);
  st.blocking = false; st.blockStart = 0;
});

check('dodge spends stamina, grants i-frames and goes on cooldown', () => {
  assert.ok(dc.enter(champ), 're-enter refused');
  const st = champ.champion;
  st.stamina = 100; st.dodgeReadyAt = 0;
  assert.equal(dc.dodge(), true);
  assert.ok(st.stamina < 80, 'the dodge was free');
  assert.ok(champ.invulnerableUntil > g.time, 'no invulnerability window');
  assert.ok(g.champions.dodgeCooldown(champ) > 3, 'no cooldown');
  const hp = champ.hp;
  champ.takeDamage(50, null, 'melee');
  assert.equal(champ.hp, hp, 'a blow landed during the dodge');
});

check('sprint drains stamina and moves faster than a walk', () => {
  const st = champ.champion;
  const cam0 = cam.firstPerson.yaw, pitch0 = cam.firstPerson.pitch;
  const travel = (sprint, yaw) => {
    cam.firstPerson.yaw = yaw; cam.firstPerson.pitch = 0; cam.update(0);
    champ.x = hx; champ.z = hz; champ.stop(); champ.state = STATE.CONTROLLED;
    st.stamina = 100; st.staminaDelay = 0; st.blocking = false;
    dc._dodge = null;
    /* a deliberate walk, or a thumb pushed past the ring for a run */
    const id = stickPush(dc, 0, 1, sprint ? 1 : 0.62);
    tick(g, 24);
    stickRelease(dc, id);
    dc.setSprint(false);
    return Math.hypot(champ.x - hx, champ.z - hz);
  };
  /* pick a heading with open ground: a walk into a wall proves nothing */
  let walked = 0, ran = 0;
  for (const yaw of [0, 0.8, -0.9, 1.9, -2.4]) {
    walked = travel(false, yaw);
    if (walked < 0.8) continue;
    ran = travel(true, yaw);
    if (ran > 0.8) break;
  }
  assert.ok(walked > 0.8, `the body walked only ${walked.toFixed(1)} m — no open ground for the test`);
  assert.ok(st.stamina < 95, 'sprinting cost no stamina');
  assert.ok(ran > walked * 1.2, `sprinting covered ${ran.toFixed(1)} m vs walking ${walked.toFixed(1)} m`);
  cam.firstPerson.yaw = cam0; cam.firstPerson.pitch = pitch0;
});

check('a rally heals the men around the Champion once, then rests', () => {
  champ.champion.picks.push('rally');
  champ.champion.spent = champ.champion.picks.length;
  g.champions.version++;
  champ.champion.rallyReadyAt = 0;
  const men = [spawn(g, 'swordsman', 1, champ.x + 2, champ.z), spawn(g, 'archer', 1, champ.x - 2, champ.z)];
  for (const m of men) m.hp = m.maxHp * 0.4;
  assert.equal(dc.rally(), true, 'rally refused');
  for (const m of men) assert.ok(m.hp > m.maxHp * 0.4, 'rally healed nobody');
  assert.ok(champ.champion.rallyReadyAt > g.time, 'rally has no cooldown');
  assert.equal(dc.rally(), false, 'rally fired twice');
});

check('renown and perks survive a save and a reload', () => {
  const renown = champ.champion.renown, picks = champ.champion.picks.slice();
  assert.equal(app.saveMatch(), true, 'save failed');
  const blob = JSON.parse(localStorage.getItem('imperial-crown-v6-save'));
  assert.ok(blob.champions, 'the save has no champion section');
  assert.equal(blob.version, 6);
  g = app.game;
  const clone = { ...champ };
  app.applySave(g, blob);
  /* the mage was possessed too, so pick the Champion with the history */
  const back = g.units.filter((u) => u.champion).sort((a, b) => b.champion.renown - a.champion.renown)[0];
  assert.ok(back, 'no champion after reload');
  assert.equal(Math.round(back.champion.renown), Math.round(renown));
  assert.deepEqual(back.champion.picks, picks);
  assert.equal(g.champions.rank(back), rankIndexFor(renown));
  assert.ok(clone);
});

/* ============================================================
   4 · SQUADS
   ============================================================ */
let sx, sz;
[sx, sz] = openField(g);
const s1 = spawn(g, 'swordsman', 1, sx, sz);
const s2 = spawn(g, 'archer', 1, sx + 1.5, sz);
const s3 = spawn(g, 'spearman', 1, sx + 3, sz);
rebuild(g);
let squad = null;

check('the drawer forms a squad from a real selection', () => {
  g.setSelection([s1, s2]);
  app.ui.toggleSquads(true);
  const nameInput = document.getElementById('squadName');
  nameInput.value = 'The Wall';
  document.getElementById('squadCreate').click();
  assert.equal(g.squads.list.length, 1, 'the drawer did not create a squad');
  squad = g.squads.list[0];
  assert.equal(squad.name, 'The Wall');
  assert.deepEqual(squad.members.map((u) => u.type).sort(), ['archer', 'swordsman']);
  assert.ok(document.querySelector('[data-squad]'), 'the squad row was not drawn');
});

check('a third man joins the existing squad from the drawer', () => {
  g.setSelection([s3]);
  app.ui.updateSquads(true);
  const add = [...document.querySelectorAll('[data-squad]')].find((b) => b.dataset.action === 'add');
  assert.ok(add, 'no + Selected control');
  add.click();
  assert.equal(squad.members.length, 3);
  assert.equal(s3.squad, squad);
});

check('shared experience is earned in a real fight', () => {
  const enemy = spawn(g, 'spearman', 2, s1.x + 1.2, s1.z + 0.6);
  rebuild(g);
  const xp = squad.xp;
  for (let i = 0; i < 40 && squad.xp === xp; i++) { g.orderAttack([s1, s3], enemy); tick(g, 5); }
  assert.ok(squad.xp > xp, 'a squad that fought a man to death learned nothing');
  enemy.kill(null);
  assert.equal(squad.xp, g.squads.list[0].xp);
});

check('squad rank is shared, and its perk is a real stat', () => {
  g.veterancy.gain(s1, 900, 'test');
  assert.ok(g.squads.rank(squad) >= 2, `rank ${g.squads.rank(squad)} after 900 xp`);
  g.squads.update(0.5);
  assert.equal(g.squads.armorBonus(s1), 1, 'the Battlebound armour is missing');
  /* and it is armour the *battle* reads: the same blow hurts less when the
     squad is shoulder to shoulder */
  const hit = (cohesive) => {
    s1.squadCohesive = cohesive;
    s1.hp = s1.maxHp; s1.champion = null;
    return s1.takeDamage(20, null, 'melee'), s1.maxHp - s1.hp;
  };
  const together = hit(true), alone = hit(false);
  assert.ok(alone > together, `cohesion saved nothing (${together} vs ${alone} taken)`);
  s1.hp = s1.maxHp;
  /* a late recruit inherits the *history*, not the rank: he has to earn his
     own bond before the shared perks cover him */
  const rookie = spawn(g, 'spearman', 1, s1.x + 1.2, s1.z + 1.2);
  rebuild(g);
  assert.equal(g.squads.add(squad, [rookie]).ok, true, 'the rookie could not join');
  assert.equal(g.squads.memberRank(rookie), 0, 'the late joiner was handed a free rank');
  g.squads.update(0.5);
  assert.equal(g.squads.armorBonus(rookie), 0, 'the late joiner got cohesion he never earned');
  g.veterancy.gain(rookie, 400, 'test');
  g.squads.update(0.5);
  assert.ok(g.squads.memberRank(rookie) >= 2, 'a late joiner can never catch up');
  assert.equal(g.squads.armorBonus(rookie), 1, 'the earned bond never paid out');
});

await acheck('the squad survives a save and a reload, names and all', async () => {
  const savedMembers = squad.members.length;
  assert.equal(app.saveMatch(), true);
  const blob = JSON.parse(localStorage.getItem('imperial-crown-v6-save'));
  await start({ mode: 'campaign', load: blob });
  g = app.game;
  const loaded = g.squads.list.find((s) => s.name === 'The Wall');
  assert.ok(loaded, 'the squad did not come back');
  assert.equal(loaded.members.length, savedMembers, 'members were lost');
  assert.ok(loaded.xp > 0, 'the shared experience was lost');
  assert.ok(loaded.members.every((m) => m.squad === loaded), 'members came back detached');
});

check('the Champion can order the squad from inside the body', () => {
  const leader = g.units.find((u) => u.type === 'swordsman' && u.team === 1 && !u.dead);
  const wall = g.squads.list[0];
  /* put the champion into the squad, as a player would by selecting him */
  if (!leader.squad) g.squads.add(wall, [leader]);
  assert.ok(dc.enter(leader), 'enter refused');
  const mates = dc.squadMembers(wall);
  assert.ok(mates.length >= 1, 'the squad has nobody else on the field');
  assert.equal(dc.followSquad(), true, 'follow refused');
  assert.ok(mates.every((m) => m.guardTarget === leader || m.def.classes.includes('monk')),
    'the squad did not fall in behind the Champion');
  const enemy = spawn(g, 'spearman', 2, leader.x + Math.sin(cam.firstPerson.yaw) * 8, leader.z + Math.cos(cam.firstPerson.yaw) * 8);
  g.showFog = false; rebuild(g);
  cam.firstPerson.yaw = Math.atan2(enemy.x - leader.x, enemy.z - leader.z);
  cam.firstPerson.pitch = Math.atan2((enemy.y + 0.85) - cam.eye[1], 8);
  cam.update(0);
  assert.ok(dc.findAim('enemy', 60, false), 'the enemy in the crosshair is not aimable');
  assert.equal(dc.focusSquad(), true, 'focus refused');
  assert.ok(mates.some((m) => m.target === enemy), 'nobody was ordered onto the target');
  enemy.kill(null);
  dc.exit();
});

/* ============================================================
   5 · SANDBOX MODS
   ============================================================ */
await acheck('a sandbox with the Workshop on starts with mods, and without it starts clean', async () => {
  const { Menu } = await import('../src/game/menu.js');
  const menu = app.menu;
  menu.state.mode = 'sandbox';
  menu.state.sandboxMods = true;
  const row = document.getElementById('sandboxModsRow');
  assert.ok(row, 'no sandbox Workshop row in the menu');
  menu._syncVictory?.();
  assert.ok(!row.classList.contains('hidden'), 'the Workshop row is hidden in a sandbox');
  const off = row.querySelector('[data-sandboxmods="0"]');
  off.click();
  assert.equal(menu.state.sandboxMods, false, 'switching the Workshop off did nothing');
  row.querySelector('[data-sandboxmods="1"]').click();
  assert.equal(menu.state.sandboxMods, true);
  assert.ok(Menu, 'Menu export missing');

  await start({ mode: 'sandbox', mods: ['arcane'] });
  assert.ok(app.game.modHost, 'a sandbox asked for mods and got none');
  assert.equal(app.ai, null, 'a sandbox started an AI');
  app.quitToMenu();
  await start({ mode: 'sandbox' });
  assert.equal(app.game.modHost, null, 'a plain sandbox loaded the workshop');
  app.quitToMenu();
});

console.log(`\nV6 ${failures ? 'FAILED (' + failures + ')' : 'CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
