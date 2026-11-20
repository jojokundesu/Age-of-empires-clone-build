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
    /* `project` returns NDC already divided through by w (m4transformPoint
       does the perspective divide itself), so the third component is the
       normalised depth, not the clip-space w. Dividing by it a second time
       shrank every screen point toward the middle of the frame -- about a
       tenth of a screen on a short camera -- and the drag then started a few
       metres from where the test thought it had aimed. On the smaller map the
       probe's own search ring happened to absorb the error; on the bigger one
       it did not, and the ghost line came back with one buildable cell. */
    const p = cam.project(x, y, z, [0, 0, 0]);
    if (!p) return null;
    const nx = p[0], ny = p[1];
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
  const out = [0, 0, 0];
  const cands = [];
  /* Work in the space the player actually works in.
     A drag is two screen points, and the app resolves each of them by casting
     a ray at the terrain -- so the wall a player gets is the wall through the
     PLACES THE RAYS LAND, not through the places they aimed at. Those differ
     wherever a rise stands between the camera and the target, which is most of
     a zoomed-out view on a bigger map. So this searches for a run that is
     clean when resolved exactly the way a finger resolves it: project the two
     ends, pick them back off the ground, and ask the wall planner about that
     line. It is the same code path the check itself will drive. */
  const toScreen = (x, z) => {
    const y = g.heightAt(x, z);
    const p = a.camera.project(x, y, z, [0, 0, 0]);
    if (!p) return null;
    const r = a.canvas.getBoundingClientRect();
    return { x: r.left + (p[0] * 0.5 + 0.5) * r.width, y: r.top + (-p[1] * 0.5 + 0.5) * r.height };
  };
  const pick = (x, z) => {
    const s = toScreen(x, z);
    if (!s) return null;
    if (!a.input.groundAt(s.x, s.y, out)) return null;
    return { x: out[0], z: out[2] };
  };
  for (let r = 16; r < 110; r += 4) {
    for (let k = 0; k < 96; k++) {
      const ang = (k / 96) * Math.PI * 2;
      const perp = ang + Math.PI / 2;
      const x = tc.x + Math.cos(ang) * r, z = tc.z + Math.sin(ang) * r;
      const p0 = pick(x + Math.cos(perp) * -8, z + Math.sin(perp) * -8);
      const p1 = pick(x + Math.cos(perp) * 8, z + Math.sin(perp) * 8);
      if (!p0 || !p1) continue;
      /* the two ends must really be a run across open ground, not the same
         spot after the ray was blocked */
      if (Math.hypot(p1.x - p0.x, p1.z - p0.z) < 12) continue;
      const cells = g.planWallLine('stone_wall', p0.x, p0.z, p1.x, p1.z, 1);
      if (cells.length < 8 || !cells.every((c) => c.ok)) continue;
      let open = true;
      for (const c of cells) {
        for (const d of [-3.6, 3.6]) {
          if (!g.isPassable(c.x + Math.cos(perp) * d, c.z + Math.sin(perp) * d)) { open = false; break; }
        }
        if (!open) break;
      }
      if (!open) continue;
      cands.push({ x, z, ang, cells: cells.length });
      if (cands.length >= 24) break;
    }
    if (cands.length >= 24) break;
  }

  /* ---- second pass: judge each candidate from the camera the checks will
     actually look through ----------------------------------------------
     Everything above was measured through whatever camera the match opened
     with. The checks move the camera to the site first, and a ray cast from
     somewhere else lands somewhere else: a site can have a flawless 16 m
     drag from across the valley and, once the camera is over it, put the
     single-tap point at the bottom edge of the frame where the ray grazes
     the ground and lands fifty metres away in a lake. That is how this
     suite failed intermittently -- on the terrain, not on the walls. So
     stand the camera where the test will stand it and re-ask, for all
     three points the test will actually press. */
  const aim = (c) => {
    a.camera.setTarget(c.x, c.z, true);
    a.camera.desiredDist = a.camera.dist = 34;
    a.camera.desiredPitch = a.camera.pitch = 0.72;
    a.camera.yaw = a.camera.desiredYaw = c.ang + Math.PI * 0.5;
    a.camera.update(1 / 60, { instant: true });
  };
  const rect = a.canvas.getBoundingClientRect();
  const onScreen = (s, pad) => s && s.x > rect.left + pad && s.x < rect.right - pad
    && s.y > rect.top + pad && s.y < rect.bottom - pad;
  for (const c of cands) {
    aim(c);
    const perp = c.ang + Math.PI / 2;
    const e0 = { x: c.x + Math.cos(perp) * -8, z: c.z + Math.sin(perp) * -8 };
    const e1 = { x: c.x + Math.cos(perp) * 8, z: c.z + Math.sin(perp) * 8 };
    const tap = { x: c.x + Math.cos(perp) * 14, z: c.z + Math.sin(perp) * 14 };
    const s0 = toScreen(e0.x, e0.z), s1 = toScreen(e1.x, e1.z), st = toScreen(tap.x, tap.z);
    /* 90 px of margin at the bottom keeps every point clear of the command
       card, which eats taps, and off the grazing edge of the frustum. */
    if (!onScreen(s0, 70) || !onScreen(s1, 70) || !onScreen(st, 70)) continue;
    if (st.y > rect.bottom - 150) continue;
    const r0 = pick(e0.x, e0.z), r1 = pick(e1.x, e1.z), rt = pick(tap.x, tap.z);
    if (!r0 || !r1 || !rt) continue;
    if (Math.hypot(rt.x - tap.x, rt.z - tap.z) > 2.5) continue;
    const line = g.planWallLine('stone_wall', r0.x, r0.z, r1.x, r1.z, 1);
    if (line.length < 8 || !line.every((q) => q.ok)) continue;
    if (!g.canPlaceAt('stone_wall', 1, rt.x, rt.z, { ignoreUnits: true }).ok) continue;
    return { x: c.x, z: c.z, ang: c.ang, cells: line.length };
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
    /* Spawn BESIDE the wall, not on it, and then walk in through the gate.
       spawnUnitRaw refuses an impassable spot by nudging the body out of it
       (it is the same call a house uses to drop a villager on free ground),
       and the gateway of a freshly built wall run is impassable until the
       gate is there -- so dropping the man straight onto the sill put him
       wherever the nudge landed, which on this map was twenty-five metres
       away among the segments. Walking in is also the thing being tested:
       the leaf must rise for a friend who actually comes through. */
    /* The gateway itself is passable for the owner (that is the point of a
       gate), so the friend can stand in it; anywhere else along a fresh wall
       run is wall, and spawnUnitRaw would nudge him off the sill. */
    const ally = g.spawnUnitRaw('swordsman', 1, gx, gz);
    const foe = g.spawnUnitRaw('swordsman', 2, gx - nx * 14, gz - nz * 14);
    if (!ally || !foe) return { error: 'could not spawn the pair' };
    ally.stance = 'stand'; foe.stance = 'stand'; foe.noAggro = true;
    /* the leaf: a friend in the gateway must raise it */
    let leaf = 0;
    for (let i = 0; i < 120; i++) { g.update(1 / 30); leaf = Math.max(leaf, gate.gateOpen); }
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
    /* the map's own half-extent, not the 512 m map's: reading the wrong one
       samples a corner of the grid for every cell on a bigger world */
    const N = g.world.nav.cells, cell = g.world.nav.cell, half = g.world.half;
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
    return { samples, gatePos: [+gate.x.toFixed(1), +gate.z.toFixed(1)],
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
    /* Measure the line in its OWN frame. The formation is dressed along the
       axis of the order, and this test changes the camera yaw to look down
       that axis -- so a line running north-south has a Z spread and a line
       running east-west has an X spread. Reading only Z passed on the 512 m
       map's particular heading and reported "the line is only 5.5 m across"
       the moment the moon map put the same formation on a different bearing. */
    const gx = Math.cos(site.ang), gz = Math.sin(site.ang);
    const along = units.map((u) => u.x * gx + u.z * gz);
    const across = units.map((u) => -u.x * gz + u.z * gx);
    return {
      n: units.length,
      spread: Math.max(...across) - Math.min(...across),
      depth: Math.max(...along) - Math.min(...along),
      zs: Math.max(...units.map((u) => u.z)) - Math.min(...units.map((u) => u.z)),
      xs: Math.max(...units.map((u) => u.x)) - Math.min(...units.map((u) => u.x))
    };
  }, site);
  await wait(1000);
  await shot('03-formation-line');
  assert(r.spread > 6, `the line is only ${r.spread.toFixed(1)} m across (x ${r.xs.toFixed(1)}, z ${r.zs.toFixed(1)})`);
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
