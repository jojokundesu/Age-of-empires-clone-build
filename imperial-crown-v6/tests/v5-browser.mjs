/* Real mobile-sized Chromium test. Run npm run build && npm run test:v5-browser.
   SwiftShader is useful for correctness and screenshots, not phone FPS claims. */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const root = resolve('dist'), out = resolve('ci/v5-browser');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent((req.url || '/').split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
const errors = [];
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
};
try {
  browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true, protocolTimeout: 180000,
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 414, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 180000 });
  await page.waitForFunction('!document.getElementById("menuScreen").classList.contains("hidden")', { timeout: 120000 });
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running && window.__imperial.game', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(out, 'strategy.png') });
  const strategy = await page.evaluate(() => ({
    ready: window.__imperial.renderer.ready,
    canvas: document.getElementById('gl').getBoundingClientRect().toJSON(),
    squadButton: getComputedStyle(document.getElementById('btnSquads')).display !== 'none'
  }));
  check('landscape strategy view uses WebGL2 and exposes squad tools', () => {
    assert.ok(strategy.ready && strategy.squadButton); assert.ok(strategy.canvas.width >= 899 && strategy.canvas.height >= 413);
  });

  await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const [x, z] = g.freeSpotNear(g.world.playerBase.x + 13, g.world.playerBase.z + 10, null, 20);
    const u = g.spawnUnit('swordsman', 1, x, z, null, { force: true });
    const v = g.spawnUnit('archer', 1, x + 1, z + 1, null, { force: true });
    window.__v5units = [u, v];
    g.setSelection([u, v]); a.ui.refreshCommands(true);
  });
  await page.click('#btnSquads');
  await page.type('#squadName', 'The Shield');
  await page.click('#squadCreate');
  await page.screenshot({ path: join(out, 'squads.png') });
  const squad = await page.evaluate(() => ({
    name: window.__imperial.game.squads.list[0]?.name,
    members: window.__imperial.game.squads.list[0]?.members.length,
    rendered: document.querySelector('#squadList .squadRowName')?.textContent
  }));
  check('a squad is created through the visible drawer', () => {
    assert.equal(squad.name, 'The Shield'); assert.equal(squad.members, 2); assert.equal(squad.rendered, 'The Shield');
  });
  await page.click('#squadClose');
  await page.evaluate(() => { const a = window.__imperial; a.game.setSelection([window.__v5units[0]]); a.ui.refreshCommands(true); });
  // The reference screenshot shows these bottom panels at a phone aspect ratio.
  // Collapse them at a matching landscape size and ensure the freed area is
  // not still covered by an invisible full-width grid.
  await page.setViewport({ width: 784, height: 351, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#btnPanelToggle');
  const collapsedPanels = await page.evaluate(() => ({
    inspector: getComputedStyle(document.getElementById('selectionInspector')).display,
    commands: getComputedStyle(document.getElementById('cmdPanel')).display,
    minimap: getComputedStyle(document.querySelector('.miniPanel')).display,
    bottomWidth: document.getElementById('bottomBar').getBoundingClientRect().width,
    quickClear: getComputedStyle(document.getElementById('btnQuickDeselect')).display,
    selected: window.__imperial.game.selection.length,
    expanded: document.getElementById('btnPanelToggle').getAttribute('aria-expanded')
  }));
  await page.screenshot({ path: join(out, 'panels-collapsed.png') });
  check('bottom panels collapse at phone size without losing selection or blocking the battlefield', () => {
    assert.equal(collapsedPanels.inspector, 'none'); assert.equal(collapsedPanels.commands, 'none');
    assert.notEqual(collapsedPanels.minimap, 'none'); assert.ok(collapsedPanels.bottomWidth < 200);
    assert.notEqual(collapsedPanels.quickClear, 'none'); assert.equal(collapsedPanels.selected, 1); assert.equal(collapsedPanels.expanded, 'false');
  });
  await page.click('#btnPanelToggle');
  const restoredPanels = await page.evaluate(() => ({
    commands: getComputedStyle(document.getElementById('cmdPanel')).display,
    selected: window.__imperial.game.selection.length,
    expanded: document.getElementById('btnPanelToggle').getAttribute('aria-expanded')
  }));
  check('bottom panels restore with the same selected unit', () => {
    assert.notEqual(restoredPanels.commands, 'none'); assert.equal(restoredPanels.selected, 1); assert.equal(restoredPanels.expanded, 'true');
  });
  await page.setViewport({ width: 900, height: 414, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
  await page.click('[data-cmd="first-person"]');
  await page.waitForFunction('window.__imperial.directControl.active');
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: join(out, 'first-person.png') });
  const uiState = await page.evaluate(() => ({
    eye: window.__imperial.camera.eye[1] - window.__v5units[0].y,
    strategyHidden: getComputedStyle(document.getElementById('bottomBar')).display === 'none',
    fpVisible: getComputedStyle(document.getElementById('fpLayer')).display !== 'none',
    equipment: document.getElementById('fpEquipment').dataset.kind,
    attackRect: document.getElementById('fpAttack').getBoundingClientRect().toJSON()
  }));
  check('first-person overlay and eye-height view are visible', () => {
    assert.ok(uiState.eye > 1 && uiState.eye < 3); assert.ok(uiState.strategyHidden && uiState.fpVisible);
    assert.equal(uiState.equipment, 'sword');
    assert.ok(uiState.attackRect.x >= 0 && uiState.attackRect.right <= 900 && uiState.attackRect.bottom <= 414);
  });

  const client = await page.createCDPSession();
  const before = await page.evaluate(() => ({ x: window.__v5units[0].x, z: window.__v5units[0].z, yaw: window.__imperial.camera.firstPerson.yaw }));
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 290, id: 1, radiusX: 1, radiusY: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90, y: 240, id: 1, radiusX: 1, radiusY: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 240, id: 1 }, { x: 700, y: 180, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90, y: 240, id: 1 }, { x: 750, y: 180, id: 2 }] });
  await new Promise((r) => setTimeout(r, 1600));
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const after = await page.evaluate(() => ({ x: window.__v5units[0].x, z: window.__v5units[0].z, yaw: window.__imperial.camera.firstPerson.yaw, sticks: window.__imperial.directControl.pointers.size }));
  check('simultaneous left movement and right look use actual touch events', () => {
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > .05, JSON.stringify({ before, after }));
    assert.ok(Math.abs(after.yaw - before.yaw) > .05, JSON.stringify({ before, after }));
    assert.equal(after.sticks, 0);
  });
  // Put a stationary hostile in weapon reach, but use the actual mobile
  // attack control, aim assist, cooldown, and combat code.
  const target = await page.evaluate(() => {
    const a = window.__imperial, g = a.game, u = g.directControl.unit;
    a.camera.firstPerson.yaw = 0; a.camera.firstPerson.pitch = -.3; a.camera.update(0);
    const enemy = g.spawnUnitRaw('swordsman', 2, u.x, u.z + 1.0);
    enemy.hp = enemy.maxHp = 10000; enemy.update = () => {}; // stationary practice target
    g.spatial.clear(); g.spatial.insertAll(g.units);
    return { id: enemy.id, hp: enemy.hp, aim: g.directControl.findAim('enemy', 3, true)?.id };
  });
  assert.equal(target.aim, target.id, 'practice target was not in the aim cone');
  await page.touchscreen.tap(uiState.attackRect.x + uiState.attackRect.width / 2, uiState.attackRect.y + uiState.attackRect.height / 2);
  const attack = await page.evaluate((id) => ({
    hp: window.__imperial.game.units.find((u) => u.id === id)?.hp,
    cooldown: window.__imperial.game.directControl.unit.attackCooldown
  }), target.id);
  check('mobile attack hits an aimed enemy using the real weapon', () => {
    assert.ok(attack.hp < target.hp, `target hp ${attack.hp} did not decrease`); assert.ok(attack.cooldown > 0);
  });
  await page.click('#fpPause');
  const paused = await page.evaluate(() => ({ paused: window.__imperial.paused, time: window.__imperial.game.time }));
  await new Promise((r) => setTimeout(r, 400));
  const stillPaused = await page.evaluate(() => window.__imperial.game.time);
  await page.click('#modalClose');
  const resumed = await page.evaluate(() => !window.__imperial.paused);
  check('first-person pause freezes the simulation and close resumes', () => {
    assert.equal(paused.paused, true); assert.equal(stillPaused, paused.time); assert.equal(resumed, true);
  });
  await page.click('#fpExit');
  const returnedCamera = await page.evaluate(() => window.__imperial.camera.firstPerson);
  check('return to strategy restores the camera', () => assert.equal(returnedCamera, null));
  await page.click('#btnPanelToggle');
  await page.click('#btnQuickDeselect');
  const selectionCount = await page.evaluate(() => window.__imperial.game.selection.length);
  check('deselection remains available while the panels are hidden', () => assert.equal(selectionCount, 0));
  await page.click('#btnPanelToggle');

  // Choose a villager through the command card, then find a legal direction
  // on the actual terrain. The reticle and touch PLACE button use the real
  // ground ray and placement rules without replacing either implementation.
  await page.evaluate(() => {
    const a = window.__imperial, u = a.game.units.find((v) => v.team === 1 && v.type === 'villager' && !v.dead);
    a.game.setSelection([u]); a.ui.refreshCommands(true);
  });
  await page.click('[data-cmd="first-person"]');
  await page.click('#fpBuild');
  await page.click('#fpBuildList [data-build="house"]');
  const buildAim = await page.evaluate(() => {
    const a = window.__imperial, g = a.game, dc = g.directControl, fp = a.camera.firstPerson;
    for (let yaw = -Math.PI; yaw < Math.PI; yaw += Math.PI / 12) {
      for (const pitch of [-.22, -.3, -.4, -.5, -.6]) {
        fp.yaw = yaw; fp.pitch = pitch; a.camera.update(0);
        const [x,z] = dc.aimPoint({ id: 'construction', range: 10 });
        if (g.canPlaceAt('house', 1, x, z).ok) return { x, z, count: g.buildings.length, equipment: document.getElementById('fpEquipment').dataset.kind };
      }
    }
    return null;
  });
  assert.ok(buildAim, 'no legal aimed construction site near the villager');
  await page.waitForFunction(() => window.__imperial.game.placing?.valid === true, { timeout: 10000 });
  const attackButton = await page.$eval('#fpAttack', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.touchscreen.tap(attackButton.x, attackButton.y);
  const built = await page.evaluate(() => ({
    count: window.__imperial.game.buildings.length,
    building: window.__imperial.game.buildings.at(-1)?.type,
    active: window.__imperial.game.directControl.active,
    target: window.__imperial.game.directControl.unit.buildTarget?.type
  }));
  check('villager aims and places a real foundation without leaving first person', () => {
    assert.equal(buildAim.equipment, 'tool'); assert.equal(built.count, buildAim.count + 1);
    assert.equal(built.building, 'house'); assert.equal(built.target, 'house'); assert.equal(built.active, true);
  });
  await page.click('#fpExit');

  // Exercise a real workshop session and its global-range spell map.
  await page.evaluate(async () => {
    const a = window.__imperial;
    await a.startMatch({ mode: 'mods', mods: ['arcane'], civ: 'franks', difficulty: 'standard', seed: 20261, quality: 'low' });
    const g = a.game, base = g.world.playerBase;
    const u = g.spawnUnit('mage', 1, base.x + 8, base.z + 8, null, { force: true });
    u.modState.arcane.rank = 6; u.modState.arcane.mana = 300;
    g.setSelection([u]); a.ui.refreshCommands(true); window.__v5mage = u;
  });
  await page.waitForFunction('!document.getElementById("btnModStatus").classList.contains("hidden")', { timeout: 60000 });
  const initiallyCollapsed = await page.evaluate(() => document.getElementById('modHud').classList.contains('is-collapsed'));
  await page.click('#btnModStatus');
  const opened = await page.evaluate(() => !document.getElementById('modHud').classList.contains('is-collapsed'));
  await page.click('#btnModStatus');
  const collapsedAgain = await page.evaluate(() => document.getElementById('modHud').classList.contains('is-collapsed'));
  check('workshop status starts collapsed and can be toggled', () => { assert.ok(initiallyCollapsed); assert.ok(opened); assert.ok(collapsedAgain); });
  await page.click('[data-cmd="first-person"]');
  await page.waitForFunction('document.querySelector("#fpSpellList [data-spell=skyfall]")');
  await page.screenshot({ path: join(out, 'mage.png') });
  const spellCount = await page.$$eval('#fpSpellList [data-spell]', (els) => els.length);
  const mageEquipment = await page.$eval('#fpEquipment', (el) => el.dataset.kind);
  check('mage spellbook and staff are available in first person', () => { assert.ok(spellCount >= 11, 'only ' + spellCount); assert.equal(mageEquipment, 'staff'); });
  await page.click('#fpSpellList [data-spell="skyfall"]');
  await page.waitForFunction('!document.getElementById("fpMap").classList.contains("hidden")');
  await page.screenshot({ path: join(out, 'skyfall-map.png') });
  const map = await page.$('#fpMapCanvas');
  await map.click({ offset: { x: 30, y: 40 } });
  const skyday = await page.evaluate(() => window.__imperial.game.modHost.mods.get('arcane').state.skyday);
  check('Skyfall tactical map casts through the actual mod', () => assert.equal(skyday, 0));
  /* A real thumb path: the map closes and the book has to come back, or the
     once-a-day spell looks like it took every other spell with it. */
  const book = await page.evaluate(() => ({
    shelf: !document.getElementById('fpSpellShelf').classList.contains('hidden'),
    map: !document.getElementById('fpMap').classList.contains('hidden'),
    spells: [...document.querySelectorAll('#fpSpellList [data-spell]')].map((b) => b.dataset.spell),
    sky: document.querySelector('#fpSpellList [data-spell="skyfall"] small')?.textContent || ''
  }));
  check('the spellbook is still there after the once-a-day spell', () => {
    assert.equal(book.map, false, 'the skyfall map stayed open');
    assert.equal(book.shelf, true, 'the spellbook vanished after casting');
    assert.ok(book.spells.length >= 11, 'only ' + book.spells.length + ' spells left');
    assert.ok(book.spells.includes('fireball'), 'Fireball disappeared with SKYFALL');
    /* 6.2: an Ascendant gets three castings a day, so one cast leaves two */
    assert.match(book.sky, /2 left/i, 'the daily spell count says "' + book.sky + '"');
  });
  assert.ok(await page.evaluate(() => window.__imperial.saveMatch()));
  const mode = await page.evaluate(() => JSON.parse(localStorage.getItem('imperial-crown-v6-save')).mods);
  check('workshop state is saved from the browser', () => assert.ok(mode.includes('arcane')));
  check('no JavaScript or console errors', () => assert.deepEqual(errors, []));
  console.log(`\nScreenshots: ${out}`);
} catch (e) {
  failed++;
  console.error('  FAIL browser flow: ' + (e.stack || e));
  if (errors.length) console.error('  Browser errors: ' + errors.join('\n'));
} finally {
  if (browser) await browser.close();
  server.close();
}
console.log(`\nV5 BROWSER ${failed ? 'FAILED (' + failed + ')' : 'CHECKS PASSED'}`);
process.exit(failed ? 1 : 0);
