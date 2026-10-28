/* Walls and gates, driven the way a thumb drives them, in a real browser.

   The sim suite proves that a wall run blocks a path and that a gate opens for
   its owner. This suite proves something different and just as important: that
   the *gesture* works. A wall line is drawn by dragging on the canvas with the
   build tool armed -- if the drag is swallowed by the camera, or the ghost does
   not follow the finger, or the run is committed on pointerup at the wrong
   anchor, the feature is broken no matter how correct the simulation is.

   So the checks here dispatch real pointer events at real screen coordinates,
   watch the game react, and photograph the result:
     · dragging draws a ghost line of segments before the finger lifts
     · lifting the finger places exactly those segments, and charges for them
     · a tap places a single segment
     · a gate in the line opens for a friendly soldier walking through it
     · an enemy soldier is stopped by the same gate
     · the finished wall is photographed by day

   node tests/wallsite.mjs [--out ci/v4-walls]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-walls'));
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(2); }
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  protocolTimeout: 300000,
  args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

let pass = 0, failures = 0;
const results = [];
const check = async (name, fn) => {
  try {
    const d = await fn();
    pass++;
    console.log(`  ok   ${name}${d ? '  — ' + d : ''}`);
    results.push({ name, ok: true, detail: d });
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name} — ${e && e.message}`);
    results.push({ name, ok: false, detail: e && e.message });
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') });

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.evaluate(() => {
  const a = window.__imperial;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; }
  a.renderer.setQuality('high');
  a.renderer.setPixelScale(1);
  a.settings.autoQuality = false;
  const t = a.game.teams.get(1);
  t.res.food = 99999; t.res.wood = 99999; t.res.gold = 99999; t.res.stone = 99999;
  t.age = 3; t.popCap = 300;
  a.game.statsVersion++;
});
await wait(1500);

/* ------------------------------------------------------------------ helpers */
/* A screen point for a world point, using the camera the game is really using. */
await page.evaluate(() => {
  window.__toScreen = (x, z) => {
    const a = window.__imperial;
    const cam = a.camera;
    const y = a.game.heightAt(x, z);
    const p = cam.project(x, y, z, [0, 0, 0]);
    const cw = p[2];
    if (!cw) return null;
    const nx = p[0] / cw, ny = p[1] / cw;
    const r = a.canvas.getBoundingClientRect();
    return { x: r.left + (nx * 0.5 + 0.5) * r.width, y: r.top + (-ny * 0.5 + 0.5) * r.height };
  };
});

const pointer = async (type, x, y) => page.evaluate((type, x, y) => {
  const a = window.__imperial;
  const canvas = a.canvas;
  const ev = new PointerEvent(type, {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1
  });
  canvas.dispatchEvent(ev);
}, type, x, y);

/** Open ground in front of the town centre, big enough for a wall across. */
const site = await page.evaluate(() => {
  const a = window.__imperial;
  const g = a.game;
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  for (let r = 16; r < 90; r += 4) {
    for (let k = 0; k < 96; k++) {
      const ang = (k / 96) * Math.PI * 2;
      const x = tc.x + Math.cos(ang) * r, z = tc.z + Math.sin(ang) * r;
      let ok = true;
      for (let i = -8; i <= 8 && ok; i += 2) {
        const px = x + Math.cos(ang + Math.PI / 2) * i;
        const pz = z + Math.sin(ang + Math.PI / 2) * i;
        if (!g.canPlaceAt('stone_wall', 1, px, pz).ok) ok = false;
      }
      if (!ok) continue;
      /* and there must be walkable ground on both sides of it */
      for (let i = -7; i <= 7 && ok; i += 3.5) {
        const bx = x + Math.cos(ang + Math.PI / 2) * i;
        const bz = z + Math.sin(ang + Math.PI / 2) * i;
        if (!g.isPassable(bx, bz)) ok = false;
      }
      if (!ok) continue;
      return { x, z, ang };
    }
  }
  return null;
});
if (!site) { console.error('no room to build a wall on this map'); process.exit(2); }

/* point the camera at the site from a nice angle, close in */
await page.evaluate((site) => {
  const a = window.__imperial;
  a.camera.setTarget(site.x, site.z, true);
  a.camera.desiredDist = a.camera.dist = 34;
  a.camera.desiredPitch = a.camera.pitch = 0.72;
  a.camera.yaw = a.camera.desiredYaw = site.ang + Math.PI * 0.5;
  a.camera.update(1 / 60, { instant: true });
}, site);
await wait(700);

/* ------------------------------------------------------------------ checks */
await check('dragging the wall tool draws a ghost line before the finger lifts', async () => {
  const pts = await page.evaluate((site) => {
    const perp = site.ang + Math.PI / 2;
    const x0 = site.x + Math.cos(perp) * -8, z0 = site.z + Math.sin(perp) * -8;
    const x1 = site.x + Math.cos(perp) * 8, z1 = site.z + Math.sin(perp) * 8;
    return { a: window.__toScreen(x0, z0), b: window.__toScreen(x1, z1), x0, z0 };
  }, site);
  assert(pts.a && pts.b, 'the wall ends are off screen');
  /* arm the tool exactly as the build menu does */
  await page.evaluate(() => {
    const a = window.__imperial;
    a.game.placing = { type: 'stone_wall', line: true, cells: null, valid: true, footprint: 2, x: 0, z: 0, y: 0, builders: [] };
  });
  await pointer('pointerdown', pts.a.x, pts.a.y);
  for (let i = 1; i <= 6; i++) {
    await pointer('pointermove', pts.a.x + (pts.b.x - pts.a.x) * i / 6, pts.a.y + (pts.b.y - pts.a.y) * i / 6);
    await wait(20);
  }
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const p = a.game.placing;
    return { cells: p && p.cells ? p.cells.length : 0, ok: p && p.cells ? p.cells.filter((c) => c.ok).length : 0, before: a.game.buildings.length };
  });
  await shot('01-drawing');
  assert(st.cells >= 6, `the ghost has ${st.cells} cells after a 16 m drag`);
  assert(st.ok >= 6, `only ${st.ok} of ${st.cells} ghost cells are buildable`);
  /* lifting the finger commits the run */
  await pointer('pointerup', pts.b.x, pts.b.y);
  await wait(300);
  const after = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      walls: a.game.buildings.filter((b) => b.type === 'stone_wall' && !b.dead).length,
      stone: a.game.teams.get(1).res.stone,
      placing: !!a.game.placing
    };
  });
  assert(after.walls === st.ok, `committed ${after.walls} segments after a ghost of ${st.ok}`);
  assert(after.stone < 99999, 'the run was free');
  return `${after.walls} segments placed, ${99999 - after.stone} stone spent, tool still armed`;
});

await check('a tap places a single segment', async () => {
  const before = await page.evaluate(() => window.__imperial.game.buildings.filter((b) => b.type === 'stone_wall').length);
  const p = await page.evaluate((site) => {
    const perp = site.ang + Math.PI / 2;
    return window.__toScreen(site.x + Math.cos(perp) * 14, site.z + Math.sin(perp) * 14);
  }, site);
  assert(p, 'the tap point is off screen');
  await pointer('pointerdown', p.x, p.y);
  await pointer('pointerup', p.x, p.y);
  await wait(250);
  const after = await page.evaluate(() => window.__imperial.game.buildings.filter((b) => b.type === 'stone_wall').length);
  assert(after === before + 1, `a tap placed ${after - before} segments`);
  return 'one segment per tap';
});

await check('a gate opens for the owner, shuts for the enemy, and its leaf moves', async () => {
  const r = await page.evaluate(async (site) => {
    const a = window.__imperial;
    const g = a.game;
    const perp = site.ang + Math.PI / 2;
    /* drop a gate into the line, replacing whatever segment is there */
    const gx = site.x + Math.cos(perp) * 2, gz = site.z + Math.sin(perp) * 2;
    const near = g.buildings.filter((b) => b.type === 'stone_wall' && !b.dead && Math.hypot(b.x - gx, b.z - gz) < 2.4);
    for (const b of near) { g.markBuildingFootprint(b, false); b.dead = true; }
    g.refreshNav();
    const gate = g.placeBuilding('stone_gate', 1, gx, gz, { instant: true, free: true });
    if (!gate) return { error: 'the gate was refused' };
    const side = site.ang;
    const nx = Math.cos(side), nz = Math.sin(side);
    const ally = g.spawnUnitRaw('swordsman', 1, gx + nx * 1.2, gz + nz * 1.2);
    const foe = g.spawnUnitRaw('swordsman', 2, gx - nx * 2.2, gz - nz * 2.2);
    if (!ally || !foe) return { error: 'could not spawn the pair' };
    ally.stance = 'stand'; foe.stance = 'stand'; foe.noAggro = true;
    /* the leaf: a friend in the gateway must raise it */
    let leaf = 0;
    for (let i = 0; i < 90; i++) { g.update(1 / 30); leaf = Math.max(leaf, gate.gateOpen); }
    const openWhileFriend = gate.gateOpen;
    /* the doorway itself: a 2.6 m line through the gateway, which is exactly
       the gate's own cell. An 8 m line would also test whatever buildings
       happen to stand either side of it, which is not what is being asked. */
    const lineAlly = g.walkableLine(gx - nx * 1.3, gz - nz * 1.3, gx + nx * 1.3, gz + nz * 1.3, ally);
    /* and it must settle again with the friend gone. The enemy goes too:
       since 6.1 an idle defender inside its own town walks out to meet a man
       standing in the gateway, and a guard in the gateway is a friend of the
       gate -- the leaf is right to stay up while that fight is on. */
    ally.x = gx + nx * 26; ally.z = gz + nz * 26;
    foe.x = gx - nx * 26; foe.z = gz - nz * 26;
    for (let i = 0; i < 240; i++) g.update(1 / 30);
    const shutAfter = gate.gateOpen;
    /* an enemy in the gateway is a different matter: it does not open it */
    const lineFoe = g.walkableLine(gx - nx * 1.3, gz - nz * 1.3, gx + nx * 1.3, gz + nz * 1.3, foe);
    const N = g.world.nav.cells, cell = g.world.nav.cell, half = 256;
    const idx = Math.floor((gz + half) / cell) * N + Math.floor((gx + half) / cell);
    const samples = [];
    for (let i = 0; i <= 5; i++) {
      const x = gx - nx * 1.3 + nx * i * 0.52, z = gz - nz * 1.3 + nz * i * 0.52;
      samples.push({ pass: g.isPassable(x, z, ally), cellAlly: g.navFinal[Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell)],
        cellFoe: g.navFinalEnemy[Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell)],
        build: g.navBuild[Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell)],
        carve: g.navCarve[Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell)],
        gateL: g.navGate[Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell)] });
    }
    return { samples,
      leaf, openWhileFriend, shutAfter, lineAlly, lineFoe,
      allyGrid: g.navFinal[idx], enemyGrid: g.navFinalEnemy[idx], gateLayer: g.navGate[idx],
      enemyPassableAtGate: g.isPassable(gx, gz, foe), allyPassableAtGate: g.isPassable(gx, gz, ally)
    };
  }, site);
  assert(!r.error, r.error || 'failed');
  if (r.lineAlly !== true) console.log('      gate samples: ' + JSON.stringify(r.samples));
  assert(r.gateLayer > 0, 'the gate is not in the gate nav layer');
  assert(r.allyGrid === 0, 'the gate blocks its owner in the nav grid');
  assert(r.enemyGrid === 1, 'the gate does not block the enemy in the nav grid');
  assert(r.lineAlly === true, 'the straight line through the gateway is refused for the owner');
  assert(r.lineFoe === false, 'the straight line through the gateway is allowed for the enemy');
  assert(r.allyPassableAtGate === true, 'an ally cannot stand in its own gateway');
  assert(r.enemyPassableAtGate === false, 'an enemy can stand inside a shut gate');
  assert(r.leaf > 0.8, `the leaf only reached ${r.leaf.toFixed(2)} with a friend in the gateway`);
  assert(r.shutAfter < 0.1, `the leaf is still ${r.shutAfter.toFixed(2)} open with nobody near`);
  return `leaf ${r.leaf.toFixed(2)} open, ${r.shutAfter.toFixed(2)} shut; gateway owner-only`;
});

await check('a crew raises the whole run, not just the first segment', async () => {
  const r = await page.evaluate(async (site) => {
    const a = window.__imperial;
    const g = a.game;
    const perp = site.ang + Math.PI / 2;
    const cx = site.x, cz = site.z;
    const walls = g.buildings.filter((b) => b.type === 'stone_wall' && !b.dead && b.buildProgress < 1);
    if (!walls.length) return { error: 'no foundations to build' };
    const crew = [];
    for (let i = 0; i < 4; i++) {
      const v = g.spawnUnit('villager', 1, cx - Math.cos(perp) * 4 + i * 0.9, cz - Math.sin(perp) * 4 + i * 0.9);
      if (v) crew.push(v);
    }
    if (!crew.length) return { error: 'no villagers' };
    g.orderBuildMany(crew, walls);
    const assigned = new Set(crew.map((v) => v.buildTarget && v.buildTarget.id));
    let done = 0;
    for (let i = 0; i < 1800; i++) {
      g.update(1 / 30);
      if (i % 60 === 0) {
        done = walls.filter((b) => b.buildProgress >= 1).length;
        if (done === walls.length) break;
      }
    }
    done = walls.filter((b) => b.buildProgress >= 1).length;
    const crewState = crew.map((v) => ({
      st: v.state, tgt: v.buildTarget ? Math.round(v.buildTarget.x) + ',' + Math.round(v.buildTarget.z) : null,
      prog: v.buildTarget ? +v.buildTarget.buildProgress.toFixed(2) : null,
      d: v.buildTarget ? +Math.hypot(v.x - v.buildTarget.x, v.z - v.buildTarget.z).toFixed(1) : null,
      path: v.path ? v.path.length : null, stall: +(v.stallT || 0).toFixed(1)
    }));
    return { total: walls.length, done, spread: assigned.size, crew: crew.length, crewState,
      progress: walls.map((b) => +b.buildProgress.toFixed(2)) };
  }, site);
  assert(!r.error, r.error || 'failed');
  if (r.done !== r.total) console.log('      crew: ' + JSON.stringify(r.crewState) + '\n      progress: ' + JSON.stringify(r.progress));
  assert(r.spread > 1, `all ${r.crew} villagers were sent to ${r.spread} segment(s)`);
  assert(r.done === r.total, `only ${r.done}/${r.total} segments finished`);
  return `${r.crew} villagers spread over ${r.spread} segments, ${r.done} segments finished`;
});

await check('the finished wall looks like a wall', async () => {
  await page.evaluate((site) => {
    const a = window.__imperial;
    a.camera.setTarget(site.x, site.z, true);
    a.camera.desiredDist = a.camera.dist = 22;
    a.camera.desiredPitch = a.camera.pitch = 0.42;
    a.camera.yaw = a.camera.desiredYaw = site.ang + Math.PI * 0.75;
    a.camera.update(1 / 60, { instant: true });
    a.game.placing = null;
    a.game.clearSelection();
  }, site);
  await wait(1200);
  await shot('02-finished-wall');
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    for (let i = 0; i < 3; i++) a.renderer.render(1 / 60, a.game);
    return { ...a.renderer.stats };
  });
  assert(st.drawCalls > 0, 'nothing was drawn');
  return `${st.drawCalls} draw calls, ${st.tris} tris`;
});

await check('a formation of soldiers stands in its shape on the field', async () => {
  const r = await page.evaluate((site) => {
    const a = window.__imperial;
    const g = a.game;
    const perp = site.ang + Math.PI / 2;
    const cx = site.x + Math.cos(perp) * 16, cz = site.z + Math.sin(perp) * 16;
    const units = [];
    for (let i = 0; i < 8; i++) {
      const u = g.spawnUnitRaw('swordsman', 1, cx + (i % 3) * 1.4, cz + ((i / 3) | 0) * 1.4);
      if (u) { u.stance = 'stand'; units.push(u); }
    }
    g.formationStyle = 'line';
    const tx = cx + Math.cos(site.ang + Math.PI / 2) * 0 + Math.cos(site.ang) * 10;
    const tz = cz + Math.sin(site.ang) * 10;
    g.orderMove(units, tx, tz);
    for (let i = 0; i < 900; i++) g.update(1 / 30);
    a.camera.setTarget(tx, tz, true);
    a.camera.desiredDist = a.camera.dist = 20;
    a.camera.desiredPitch = a.camera.pitch = 0.62;
    a.camera.yaw = a.camera.desiredYaw = site.ang + Math.PI * 0.5;
    a.camera.update(1 / 60, { instant: true });
    const zs = units.map((u) => u.z), xs = units.map((u) => u.x);
    return {
      n: units.length,
      spread: Math.max(...zs) - Math.min(...zs),
      depth: Math.max(...xs) - Math.min(...xs)
    };
  }, site);
  await wait(1000);
  await shot('03-formation-line');
  assert(r.spread > 6, `the line is only ${r.spread.toFixed(1)} m across`);
  return `${r.n} soldiers, ${r.spread.toFixed(1)} m across, ${r.depth.toFixed(1)} m deep`;
});

await check('nothing errored in the browser', async () => {
  assert(!pageErrors.length, 'page errors: ' + pageErrors.slice(0, 3).join(' | '));
  const real = consoleErrors.filter((e) => !/favicon|Autoplay|AudioContext|user gesture/i.test(e));
  assert(!real.length, 'console errors: ' + real.slice(0, 3).join(' | '));
  return 'clean console';
});

await writeFile(join(OUT, 'report.md'), [
  '# Walls, gates and formations in the browser',
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  '',
  `${pass} passed, ${failures} failed`,
  ''
].join('\n')).catch(() => {});

console.log('');
if (failures) {
  console.log(`WALL SITE FAILURES (${failures}):`);
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.name + ': ' + r.detail);
  await browser.close();
  server.close();
  process.exit(1);
}
console.log(`WALL/GATE BROWSER CHECKS PASSED (${pass}) — shots in ${OUT}`);
await browser.close();
server.close();
