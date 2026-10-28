/* V5 integration: real game, input, HUD, saves and workshop code, with a
   mock WebGL context. Browser touch and visual checks live in v5-browser.mjs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMockGL } from './mockgl.mjs';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://v5.test/', pretendToBeVisual: true });
const { window } = dom;
function ctx2d() {
  const gradient = { addColorStop() {} };
  const base = { createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    createPattern: () => ({ setTransform() {} }), measureText: () => ({ width: 8 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
  return new Proxy(base, { get: (t, k) => k in t ? t[k] : () => {}, set: () => true });
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
const { Menu } = await import('../src/game/menu.js');
const app = new App();
app.canvas = document.getElementById('gl');
await app.boot();
const cv = app.canvas;
cv.setPointerCapture = () => {};
cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 420, right: 900, bottom: 420 });
Object.defineProperty(cv, 'clientWidth', { get: () => 900 });
Object.defineProperty(cv, 'clientHeight', { get: () => 420 });
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + ': ' + err.stack); }
}
async function start(opts) {
  globalThis.requestAnimationFrame = window.requestAnimationFrame = liveRaf;
  await app.startMatch({ civ: 'franks', difficulty: 'standard', quality: 'low', seed: 20261, ...opts });
  globalThis.requestAnimationFrame = window.requestAnimationFrame = stopRaf;
}
const tick = (g, n = 1) => { for (let i = 0; i < n; i++) g.update(1 / 30); };
const rebuild = (g) => { g.spatial.clear(); g.spatial.insertAll(g.units); g.buildingSpatial.clear(); for (const b of g.buildings) if (!b.dead) g.buildingSpatial.insert(b); };
function findOpen(g) {
  const base = g.world.playerBase;
  for (let dx = -65; dx <= 65; dx += 4) for (let dz = -65; dz <= 65; dz += 4) {
    const x = base.x + dx, z = base.z + dz;
    if (g.isPassable(x, z, null) && g.isPassable(x + 5, z, null) && g.isPassable(x, z + 5, null) && g.heightAt(x, z) > 0.5) return [x, z];
  }
  throw new Error('no open field');
}
const spawn = (g, type, team, x, z) => {
  const u = g.spawnUnit(type, team, x, z, null, { force: true });
  assert.ok(u, 'spawn ' + type);
  return u;
};
const evt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', preventDefault() {} });

console.log('\nV5: SQUADS, GUARDING AND DIRECT CONTROL');
await start({ mode: 'campaign' });
let g = app.game;
let [x, z] = findOpen(g);
const a = spawn(g, 'swordsman', 1, x, z), b = spawn(g, 'archer', 1, x + 2, z), recruit = spawn(g, 'swordsman', 1, x + 3, z);
const principal = spawn(g, 'swordsman', 1, x + 7, z);
rebuild(g);
let squad;
let depletedKey;
check('create a named mixed squad and reject duplicate membership', () => {
  ({ squad } = g.squads.create([a, b], 'Mage guard'));
  assert.ok(squad); assert.deepEqual(squad.members, [a, b]);
  assert.equal(g.squads.create([a, b]).ok, false);
});
check('shared experience and individual veterancy both advance', () => {
  g.veterancy.gain(a, 500, 'test');
  assert.equal(g.squads.rank(squad), 3); assert.equal(a.rank, 3); assert.equal(b.rank, 0);
  g.squads.update(0.5);
  assert.equal(g.squads.armorBonus(a), 1); assert.equal(g.squads.attackMul(a), 1.1);
});
check('a late recruit must earn a personal squad bond', () => {
  assert.equal(g.squads.add(squad, [recruit]).ok, true);
  assert.equal(g.squads.memberRank(recruit), 0);
  g.veterancy.gain(a, 110, 'test');
  assert.equal(g.squads.memberRank(recruit), 1);
});
check('spaced guards follow a unit, block cycles, and ordinary orders release them', () => {
  assert.equal(g.orderGuard([a, b], principal), 2);
  assert.notEqual(g.guards.records.get(a).slot, g.guards.records.get(b).slot);
  assert.equal(g.orderGuard([principal], a), 0);
  g.guards.update(0.5);
  assert.equal(a.guardTarget, principal); assert.equal(b.guardTarget, principal);
  const first = g.guards.records.get(b).x;
  principal.x += 8; g.time += 2; g.guards.update(0.5);
  assert.ok(Math.abs(g.guards.records.get(b).x - first) > 2, 'follow point did not move');
  g.orderStop([a]); assert.equal(a.guardTarget, null); assert.equal(b.guardTarget, principal);
});
check('guards engage threats near their principal and return to duty', () => {
  const enemy = spawn(g, 'spearman', 2, principal.x + 3, principal.z); rebuild(g);
  g.time += 2; g.guards.update(.5);
  assert.equal(b.target, enemy); assert.equal(b.state, STATE.ATTACK);
  enemy.kill(null); g.time += 2; g.guards.update(.5);
  assert.equal(b.guardTarget, principal); assert.notEqual(b.target, enemy);
});
check('building guard assignments use the same system', () => {
  const town = g.buildings.find((v) => v.team === 1 && v.type === 'town_center');
  assert.equal(g.orderGuard([a], town), 1); assert.equal(a.guardTarget, town);
});
check('selection can be explicitly cleared from the HUD', () => {
  g.setSelection([a]); app.ui.refreshCommands(true);
  document.getElementById('btnDeselect').click();
  assert.equal(g.selection.length, 0);
});
check('bottom panels collapse without losing selection and retain deselection', () => {
  g.setSelection([a]); app.ui.updateInspector();
  const toggle = document.getElementById('btnPanelToggle');
  const quick = document.getElementById('btnQuickDeselect');
  toggle.click();
  assert.ok(document.getElementById('bottomBar').classList.contains('panels-collapsed'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(g.selection[0], a); assert.ok(!quick.classList.contains('hidden'));
  app.input.armed = { kind: 'guard' }; quick.click();
  assert.equal(g.selection.length, 0); assert.equal(app.input.armed, null);
  assert.ok(quick.classList.contains('hidden'));
  toggle.click();
  assert.ok(!document.getElementById('bottomBar').classList.contains('panels-collapsed'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});
check('the first-person command enters a real eye-height camera', () => {
  g.orderStop([a]); g.setSelection([a]); app.ui.refreshCommands(true);
  const command = document.querySelector('[data-cmd="first-person"]'); assert.ok(command); command.click();
  assert.equal(g.directControl.unit, a); assert.equal(a.state, STATE.CONTROLLED);
  assert.ok(Math.abs(app.camera.eye[1] - a.y) < a.height + .5);
  assert.ok(document.body.classList.contains('firstPerson'));
  assert.equal(document.getElementById('fpEquipment').dataset.kind, 'sword');
});
check('two independent touch regions move and look', () => {
  const dc = g.directControl, cam = app.camera;
  cam.firstPerson.yaw = 0;
  const before = [a.x, a.z], yaw = cam.firstPerson.yaw;
  dc.pointerDown(evt(1, 100, 260)); dc.pointerMove(evt(1, 100, 212));
  dc.pointerDown(evt(2, 690, 160)); dc.pointerMove(evt(2, 720, 160));
  tick(g, 45); cam.update(0);
  dc.pointerUp(evt(1, 100, 212)); dc.pointerUp(evt(2, 720, 160));
  assert.ok(Math.hypot(a.x - before[0], a.z - before[1]) > .25, 'unit did not move');
  /* a right-hand drag turns the view to the right. Yaw is measured from +z
     towards +x, so a right turn *decreases* it -- v5 had this backwards. */
  assert.ok(cam.firstPerson.yaw < yaw, 'right-side drag did not turn the view right');
  assert.equal(dc.stickY, 0);
  const swiped = (x, dx) => { dc.pointerDown(evt(7, x, 160)); dc.pointerMove(evt(7, x + dx, 160)); dc.pointerUp(evt(7, x + dx, 160)); };
  const mid = cam.firstPerson.yaw;
  swiped(500, -60);
  assert.ok(cam.firstPerson.yaw > mid, 'left-side drag did not turn the view left');
});
check('aim assist fires the unit’s existing melee weapon', () => {
  const dc = g.directControl; app.camera.firstPerson.yaw = 0; app.camera.firstPerson.pitch = -.2;
  const enemy = spawn(g, 'spearman', 2, a.x, a.z + 1.05); g.showFog = false; rebuild(g);
  a.attackCooldown = 0; const hp = enemy.hp;
  assert.equal(dc.attackOnce(), true); assert.ok(enemy.hp < hp, 'no real damage');
  enemy.kill(null);
});
check('pause clears input and closing its modal resumes', () => {
  g.directControl.setBlock(true); app.openPause();
  assert.equal(app.paused, true); assert.equal(g.directControl.blockHeld, false);
  assert.equal(g.directControl.stickX, 0);
  app.menu.closeModal(); assert.equal(app.paused, false);
});
check('exit restores the strategy camera and selection', () => {
  document.getElementById('fpExit').click();
  assert.equal(g.directControl.active, false); assert.equal(app.camera.firstPerson, null);
  assert.equal(g.selection[0], a); assert.ok(!document.body.classList.contains('firstPerson'));
});
check('equipment and attack control follow a ranged unit', () => {
  const dc = g.directControl; assert.ok(dc.enter(b));
  assert.equal(document.getElementById('fpEquipment').dataset.kind, 'bow');
  assert.equal(document.querySelector('#fpAttack use').getAttribute('href'), '#i-bow');
  assert.equal(document.querySelector('#fpAttack span').textContent, 'SHOOT');
  dc.exit();
});
check('villagers can choose and place buildings without leaving first person', () => {
  const villager = g.units.find((u) => u.type === 'villager' && u.team === 1 && !u.dead);
  const dc = g.directControl; assert.ok(dc.enter(villager));
  document.getElementById('fpBuild').click();
  assert.ok(!document.getElementById('fpBuildShelf').classList.contains('hidden'));
  const house = document.querySelector('#fpBuildList [data-build="house"]'); assert.ok(house); house.click();
  assert.equal(g.placing.type, 'house'); assert.ok(dc.active);
  let spot = null;
  for (let dx = -10; dx <= 10 && !spot; dx += 2) for (let dz = -10; dz <= 10; dz += 2) {
    if (Math.hypot(dx, dz) <= 10 && g.canPlaceAt('house', 1, villager.x + dx, villager.z + dz).ok) { spot = [villager.x + dx, villager.z + dz]; break; }
  }
  assert.ok(spot, 'no legal nearby foundation');
  const aim = dc.aimPoint; dc.aimPoint = () => spot;
  const attack = document.getElementById('fpAttack');
  attack.onpointerdown(evt(9, 850, 360));
  assert.equal(villager.state, STATE.BUILD); assert.ok(dc.active); assert.equal(dc.attackHeld, false);
  tick(g, 3); // A held PLACE must not immediately replace the building order.
  assert.equal(villager.state, STATE.BUILD); assert.equal(villager.buildTarget.type, 'house');
  attack.onpointerup(evt(9, 850, 360)); dc.aimPoint = aim;
  dc.exit();
});
check('death releases guards without destroying surviving squad history', () => {
  const xp = squad.xp; principal.kill(null); g.guards.update(.5);
  assert.equal(b.guardTarget, null); assert.equal(squad.xp, xp);
});
check('save stores squad bonds and building guards under an isolated v6 key', () => {
  const town = g.buildings.find((v) => v.team === 1 && v.type === 'town_center');
  g.orderGuard([a], town);
  const depleted = g.resources.find((r) => !r.dead); depleted.dead = true; depleted.amount = 0;
  depletedKey = [depleted.type, Math.round(depleted.x * 10), Math.round(depleted.z * 10)];
  g.fow[0] = 1;
  assert.equal(app.saveMatch(), true);
  const saved = JSON.parse(localStorage.getItem('imperial-crown-v6-save'));
  assert.equal(saved.version, 6); assert.equal(saved.squads.squads.length, 1); assert.ok(saved.guards.length > 0);
  assert.equal(localStorage.getItem('imperial-crown-save'), null);
});
let save = JSON.parse(localStorage.getItem('imperial-crown-v6-save'));
await start({ mode: 'campaign', load: save }); g = app.game;
check('reload reconstructs squad progress, membership, guards and resource hash', () => {
  const s = g.squads.list[0]; assert.equal(s.name, 'Mage guard'); assert.equal(s.members.length, 3);
  assert.equal(s.xp, save.squads.squads[0].xp);
  assert.equal(s.members.find((u) => u.type === 'archer').squad, s);
  assert.ok([...g.guards.records.values()].some((r) => r.target.type === 'town_center'));
  const node = g.resources.find((r) => !r.dead); assert.ok(g.resourceSpatial.query(node.x, node.z, 2).includes(node));
  assert.notEqual(g.fow[0], 0, 'explored fog was lost');
  const depleted = g.resources.find((r) => r.type === depletedKey[0] && Math.round(r.x * 10) === depletedKey[1] && Math.round(r.z * 10) === depletedKey[2]);
  assert.ok(!depleted || depleted.dead, 'depleted resource reappeared');
  const foundation = g.buildings.find((v) => v.team === 1 && v.type === 'house' && v.buildProgress < 1);
  assert.ok(foundation && !foundation.completedOnce, 'unfinished foundation was completed on load');
});
check('low resources do not prevent saved buildings from returning', () => {
  const poor = structuredClone(save); poor.teams['1'].res = { food: 0, wood: 0, gold: 0, stone: 0 };
  app.applySave(g, poor); assert.ok(g.buildings.some((v) => v.team === 1 && v.type === 'town_center'));
});
check('v4 save migration is read-only and does not overwrite the old slot', () => {
  const old = { ...save, version: 4, seed: 42 }; Menu.clearSave();
  localStorage.setItem('imperial-crown-save', JSON.stringify(old));
  assert.equal(Menu.readSave().seed, 42);
  Menu.writeSave(save); assert.equal(JSON.parse(localStorage.getItem('imperial-crown-save')).seed, 42);
  localStorage.removeItem('imperial-crown-save');
});

/* v6 changes the shape of a soldier (champions), so an older campaign has to
   come across without overwriting the file it came from. */
check('a v5 campaign is imported read-only and never overwritten in place', () => {
  const old = { ...save, version: 5, seed: 77 }; Menu.clearSave();
  localStorage.setItem('imperial-crown-v5-save', JSON.stringify(old));
  assert.equal(Menu.readSave().seed, 77, 'a v5 save was not offered');
  Menu.writeSave(save);
  assert.equal(JSON.parse(localStorage.getItem('imperial-crown-v5-save')).seed, 77, 'the v5 slot was overwritten');
  assert.equal(JSON.parse(localStorage.getItem('imperial-crown-v6-save')).version, 6);
  localStorage.removeItem('imperial-crown-v5-save');
});

check('v4 settings and workshop preferences are imported read-only', () => {
  const oldSettings = JSON.stringify({ quality: 'low', music: false });
  const oldMods = JSON.stringify(['arcane']);
  localStorage.removeItem('imperial-crown-v6-settings');
  localStorage.removeItem('imperial-crown-v6-mods');
  localStorage.setItem('imperial-crown-settings', oldSettings);
  localStorage.setItem('imperial-crown-mods', oldMods);
  const imported = new App();
  assert.equal(imported.settings.music, false);
  assert.deepEqual(Menu.readMods(), { arcane: true });
  imported.applySettings({ music: true });
  Menu.writeMods({ weather: true });
  assert.equal(localStorage.getItem('imperial-crown-settings'), oldSettings);
  assert.equal(localStorage.getItem('imperial-crown-mods'), oldMods);
  assert.equal(JSON.parse(localStorage.getItem('imperial-crown-v6-settings')).music, true);
  assert.deepEqual(Menu.readMods(), { weather: true });
  localStorage.removeItem('imperial-crown-settings');
  localStorage.removeItem('imperial-crown-mods');
});

console.log('\nV5: ARCANE AND WORKSHOP ROUND-TRIP');
const mods = ['arcane', 'beasts', 'relics', 'weather', 'zombies', 'artificer'];
await start({ mode: 'mods', mods }); g = app.game; [x, z] = findOpen(g);
const mage = spawn(g, 'mage', 1, x, z);
const guard = spawn(g, 'swordsman', 1, x + 2, z);
rebuild(g);
const arc = g.modHost.mods.get('arcane');
check('Arcane Mage exposes the real complete spellbook and attunement', () => {
  const dc = g.directControl; assert.ok(dc.enter(mage));
  assert.equal(document.getElementById('fpEquipment').dataset.kind, 'staff');
  assert.equal(dc.availableSpells().length, arc.mod.spells().length);
  mage.modState.arcane.rank = 3; mage.modState.arcane.mana = 300;
  assert.equal(dc.attune('plasma'), true); assert.ok(arc.state.discovered.has('plasma'));
  assert.ok(dc.availableSpells().some((spell) => spell.id === 'plasma'));
});
check('spells use actual mana and cooldown rules', () => {
  const dc = g.directControl;
  mage.modState.arcane.mana = 300;
  const before = mage.modState.arcane.mana;
  assert.equal(dc.cast('fireball'), true); assert.ok(mage.modState.arcane.mana < before);
  assert.equal(dc.cast('fireball'), false, 'cooldown was bypassed');
});
check('Skyfall can target the whole map and observes its three-a-day rule', () => {
  const dc = g.directControl; mage.modState.arcane.rank = 6; mage.modState.arcane.mana = 1000;
  assert.equal(dc.cast('skyfall'), true); assert.equal(dc.mapSpell, 'skyfall');
  assert.ok(!document.getElementById('fpMap').classList.contains('hidden'));
  assert.equal(dc.cast('skyfall', [-200, 200]), true);
  assert.equal(arc.state.skyday, Math.floor(g.time / 240));
  /* an Ascendant gets three castings a day, and not a fourth */
  for (let i = 0; i < 2; i++) { mage.modState.arcane.mana = 1000; assert.equal(dc.cast('skyfall', [-200, 200]), true); }
  mage.modState.arcane.mana = 1000;
  assert.equal(dc.cast('skyfall', [-200, 200]), false);
  assert.equal(arc.state.skyuses, 3, 'the sky was used a different number of times than the book says');
  dc.closeGlobalMap();
});
check('other units with an Arcane debuff are not mistaken for mages', () => {
  guard.modState = { arcane: { mana: 0, xp: 0, rank: 1, cd: {}, slow: { until: g.time + 30, mul: .5 } } };
  g.directControl.exit(); g.directControl.enter(guard);
  assert.equal(g.directControl.arcane(), null);
  arc.mod.tick(arc.api, 1);
  assert.equal(guard.type, 'swordsman'); assert.equal(guard.modState.arcane.xp, 0);
  g.directControl.exit();
});
check('workshop save carries mod state, entities and indexed references', () => {
  const s = g.squads.create([mage, guard], 'The Order').squad;
  g.veterancy.gain(guard, 90, 'test'); g.orderGuard([guard], mage);
  const golem = spawn(g, 'stone_golem', 1, x + 4, z); golem.owner = mage;
  arc.state.golems.push({ unit: golem, until: g.time + 26 });
  const relics = g.modHost.mods.get('relics').state;
  relics.shrines[0].owner = 1; relics.shrines[0].progress = 1;
  assert.equal(app.saveMatch(), true); save = JSON.parse(localStorage.getItem('imperial-crown-v6-save'));
  assert.equal(save.mods.length, mods.length); assert.ok(save.modState.states.arcane.discovered.$set.includes('plasma'));
  assert.equal(save.squads.squads[0].name, s.name);
});
app.ui.toast('old match sentinel', 'info');
assert.ok(document.getElementById('toastLayer').textContent.includes('old match sentinel'));
await start({ mode: 'campaign', load: save }); g = app.game;
check('old match toast nodes do not leak into a new HUD', () => {
  assert.ok(!document.getElementById('toastLayer').textContent.includes('old match sentinel'));
});
check('all workshop mods, spells, effects, relics, squads and guards reload', () => {
  assert.deepEqual(g.modHost.activeIds().sort(), mods.slice().sort());
  const loadedArc = g.modHost.mods.get('arcane'), loadedMage = g.units.find((u) => u.type === 'mage');
  assert.ok(loadedArc.state.discovered instanceof Set); assert.ok(loadedArc.state.discovered.has('plasma'));
  assert.ok(loadedMage.modState.arcane.cd.fireball > g.time);
  assert.equal(loadedArc.state.golems[0].unit.owner, loadedMage);
  assert.equal(g.modHost.mods.get('relics').state.shrines[0].owner, 1);
  assert.ok(g.buildings.includes(g.modHost.mods.get('relics').state.shrines[0].b));
  const s = g.squads.list.find((v) => v.name === 'The Order'); assert.equal(s.members.length, 2);
  assert.ok([...g.guards.records].some(([u, rec]) => u.squad === s && rec.target === loadedMage));
  tick(g, 30); assert.deepEqual(g.modHost.errors, []);
});
check('only the current match receives HUD clicks after restart', () => {
  const pause = document.getElementById('btnPause');
  assert.equal(app.paused, false); pause.click(); assert.equal(app.paused, true);
  app.menu.closeModal(); assert.equal(app.paused, false);
});
app.quitToMenu();
console.log(`\nV5 ${failures ? 'FAILED (' + failures + ')' : 'CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
