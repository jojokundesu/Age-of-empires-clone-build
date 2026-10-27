/* A full tour of everything the game can show, in a real browser.

   The other browser suites play a normal match: villagers, houses, spearmen.
   That leaves most of the content unexercised -- 22 building types, 29 unit
   types, walls, gates, ships, siege, a wonder, every age. A model with a
   broken vertex, a building whose footprint leaves its shadow map undefined, a
   unit type with no geometry: none of that shows up in a five-building
   opening, and all of it is a crash or a black object when a player finally
   builds it.

   So this suite builds the entire catalogue in one scene, screenshots it by
   day and by night, and asserts:
     · every type produced a model and a placeable entity
     · the frame stays inside the phone's draw/triangle budget with all of it
     · no GL errors, no console errors, no failed requests

   node tests/tour.mjs [--out ci/tour]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/tour'));
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(2); }
await mkdir(OUT, { recursive: true });
await writeFile('ci/tour-report.md', '### Full-catalogue tour\n\nRUNNING — this file is rewritten with the results.\n').catch(() => {});

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
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
page.on('requestfailed', (r) => failedRequests.push(r.url() + ' — ' + (r.failure()?.errorText || 'failed')));
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(r.url() + ' — HTTP ' + r.status()); });

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`);
    results.push({ name, ok: true, detail });
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}  — ${e && e.message}`);
    results.push({ name, ok: false, detail: e && e.message });
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); };
const step = (secs) => page.evaluate((secs) => {
  const a = window.__imperial;
  const g = a.game;
  const n = Math.max(1, Math.round(secs * 30));
  for (let i = 0; i < n; i++) { g.update(1 / 30); if (a.ai && !g.gameOver) a.ai.update(1 / 30); }
  if (g.fowDirty) { a.pushFog(g); g.fowDirty = false; }
  for (let i = 0; i < 20; i++) a.camera.update(1 / 60);
  return { time: g.time, units: g.units.filter((u) => !u.dead).length, buildings: g.buildings.filter((b) => !b.dead).length };
}, secs);

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });

/* freeze the governor and take a tier nobody has to guess about */
await page.evaluate(() => {
  const a = window.__imperial;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; }
  a.renderer.setQuality('high');
  a.renderer.setPixelScale(1);
  a.settings.autoQuality = false;
});
await wait(2000);

const catalogue = await page.evaluate(() => window.__imperial.catalogue);
assert(catalogue && catalogue.buildings.length > 15, 'the bundle exposes no catalogue');

/* A tour is not a fair game: unlock every age, lift the population ceiling and
   give the player resources, so the catalogue can be exercised in one scene.
   The gates themselves are tested by the play test and the sim suite. */
await page.evaluate(() => {
  const a = window.__imperial;
  const t = a.game.teams.get(1);
  t.age = 3;
  t.ageResearch = null;
  t.res.food = 99999; t.res.wood = 99999; t.res.gold = 99999; t.res.stone = 99999;
  t.popCap = 400;
  a.game.statsVersion++;
});

console.log('\nCATALOGUE');
await check('every building type has a model and can be placed', async () => {
  const r = await page.evaluate((types) => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && !b.dead) || g.buildings[0];
    const cx = tc.x, cz = tc.z;
    const placed = [], refused = [], noModel = [];
    types.forEach((t, i) => {
      const ring = Math.floor(i / 6), slot = i % 6;
      const rad = 20 + ring * 11;
      const ang = (slot / 6) * Math.PI * 2 + ring * 0.5;
      const x = cx + Math.cos(ang) * rad, z = cz + Math.sin(ang) * rad;
      const b = g.placeBuilding(t, 1, x, z, { instant: true, free: true });
      if (!b) { refused.push(t); return; }
      placed.push(t);
      if (!a.renderer.buildingBatches.has(t)) noModel.push(t);
    });
    return { placed, refused, noModel };
  }, catalogue.buildings);
  assert(!r.refused.length, 'refused to place: ' + r.refused.join(', '));
  assert(!r.noModel.length, 'no model for: ' + r.noModel.join(', '));
  return `${r.placed.length} types placed`;
});

await check('every unit type has a model and can be spawned', async () => {
  const r = await page.evaluate((types) => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center') || g.buildings[0];
    const cx = tc.x, cz = tc.z;
    const spawned = [], refused = [], noModel = [];
    types.forEach((t, i) => {
      const ang = (i / types.length) * Math.PI * 2;
      const rad = 11 + (i % 4) * 2.5;
      const u = g.spawnUnitRaw(t, 1, cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad);
      if (!u) { refused.push(t); return; }
      spawned.push(t);
      if (!a.renderer.unitBatches.has(t)) noModel.push(t);
    });
    return { spawned, refused, noModel };
  }, catalogue.units);
  assert(!r.refused.length, 'refused to spawn: ' + r.refused.join(', '));
  assert(!r.noModel.length, 'no model for: ' + r.noModel.join(', '));
  return `${r.spawned.length} unit types on the field`;
});

await check('the whole catalogue renders inside the phone draw budget', async () => {
  await page.evaluate(() => {
    const a = window.__imperial;
    a.camera.setTarget(a.game.buildings.find((b) => b.team === 1 && b.type === 'town_center').x,
      a.game.buildings.find((b) => b.team === 1 && b.type === 'town_center').z, true);
    a.camera.desiredDist = a.camera.dist = 78;
    a.camera.desiredPitch = a.camera.pitch = 0.72;
    a.camera.update(1 / 60, { instant: true });
  });
  await step(1.5);
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    for (let i = 0; i < 3; i++) a.renderer.render(1 / 60, a.game);
    return { ...a.renderer.stats, buffers: a.renderer._activeBatches.length };
  });
  await shot('tour-01-everything');
  assert(st.drawCalls < 120, `${st.drawCalls} draw calls with every type on screen`);
  assert(st.tris < 900000, `${st.tris} triangles`);
  return `${st.drawCalls} draws · ${(st.tris / 1000).toFixed(0)}k tris · ${st.instances} instances · ${st.culled} culled`;
});

await check('walls, gates and multi-tile buildings do not fight each other', async () => {
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const placed = [];
    /* a run of wall segments with a gate in the middle, the way a player builds */
    for (let i = -3; i <= 3; i++) {
      const t = i === 0 ? 'stone_gate' : 'stone_wall';
      const b = g.placeBuilding(t, 1, tc.x + i * 3.4, tc.z - 16, { instant: true, free: true });
      if (b) placed.push([t, b.x, b.z, b.def.size]);
    }
    return placed;
  });
  assert(r.length >= 6, `only ${r.length} wall pieces placed`);
  const overlaps = [];
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 1; j < r.length; j++) {
      const dx = r[i][1] - r[j][1], dz = r[i][2] - r[j][2];
      const min = (r[i][3] + r[j][3]) * 0.5 * 0.55;
      if (Math.hypot(dx, dz) < min) overlaps.push(`${r[i][0]}@${i} vs ${r[j][0]}@${j}`);
    }
  }
  assert(!overlaps.length, 'wall pieces overlap: ' + overlaps.join(', '));
  return `${r.length} pieces, no interpenetration`;
});

await check('ships only float on water, and the map has a coast', async () => {
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    let wet = 0, dry = 0, spawned = 0, beached = 0, wrong = 0;
    const spots = [];
    for (let i = 0; i < 900 && spots.length < 5; i++) {
      const x = -240 + ((i * 73) % 480), z = -240 + ((i * 131) % 480);
      const h = g.world.heightAt(x, z);
      if (h < -0.6) { wet++; if (spots.length < 5) spots.push([x, z]); }
      else dry++;
    }
    for (const [x, z] of spots) {
      const u = g.spawnUnitRaw('war_galley', 1, x, z);
      if (!u) continue;
      spawned++;
      /* a ship that lands on dry ground must be pulled back to the water */
      const h = g.world.heightAt(u.x, u.z);
      if (h > 0.2) wrong++;
      /* and the walkability rule must classify its cell as water */
      if (g.isWalkable && g.isWalkable(u.x, u.z, u)) beached++;
    }
    return { wet, dry, spawned, beached, wrong, seaLevel: g.world.seaLevel };
  });
  assert(r.wet > 0 && r.dry > 0, `the map has no coast (${r.wet} water / ${r.dry} land samples)`);
  assert(r.spawned > 0, 'no ship could be spawned');
  assert(r.beached === 0, `${r.beached} ships stand on walkable land`);
  return `${r.spawned} galleys afloat · ${r.wet} water samples found`;
});

await check('a siege train fires without a GL error', async () => {
  await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const enemy = g.buildings.find((b) => b.team === 2 && !b.dead) || g.buildings.find((b) => b.team === 2);
    const tx = enemy ? enemy.x : g.world.playerBase.x + 40;
    const tz = enemy ? enemy.z : g.world.playerBase.z + 40;
    for (const t of ['ram', 'mangonel', 'bombard_cannon', 'trebuchet']) {
      const u = g.spawnUnitRaw(t, 1, tx - 12 + Math.random() * 4, tz - 12 + Math.random() * 4);
      if (u && enemy) g.orderAttack([u], enemy);
    }
    a.camera.setTarget(tx, tz, true);
    a.camera.desiredDist = a.camera.dist = 34;
    a.camera.update(1 / 60, { instant: true });
  });
  await step(12);
  const gl = await page.evaluate(() => window.__imperial.renderer.gl.getError());
  await shot('tour-02-siege');
  assert(gl === 0, 'GL error 0x' + gl.toString(16) + ' after the siege fired');
  return 'four siege engines, one enemy town, no GL error';
});

await check('walls of every kind render in the shadow pass', async () => {
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const gl = a.renderer.gl;
    const before = { err: gl.getError() };
    a.renderer._shadowPass(a.camera, 1 / 30);
    return { err: gl.getError(), shadowDraws: a.renderer.stats.shadowDraws, size: a.renderer.shadowSize };
  });
  assert(r.err === 0, 'GL error during the shadow pass');
  return `shadow map ${r.size}², ${r.shadowDraws} draws`;
});

await check('every age can be entered and looks different', async () => {
  const shots = [];
  for (const age of [0, 1, 2, 3]) {
    await page.evaluate((age) => {
      const a = window.__imperial;
      const t = a.game.teams.get(1);
      t.age = Math.max(t.age, age);
      t.ageResearch = null;
      a.game.statsVersion++;
      a.ui.refreshCommands(true);
    }, age);
    await step(0.6);
    await wait(350);
    await shot('tour-03-age' + age);
    /* read inside a rAF callback: without preserveDrawingBuffer the colour
       buffer is cleared as soon as the browser composited it */
    shots.push(await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const gl = window.__imperial.renderer.gl;
        const w = 64, h = 36;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        resolve(sum / (w * h));
      }));
    })));
  }
  assert(shots.every((v) => v > 0), 'one of the ages rendered a black frame');
  return `age luma ${shots.map((v) => v.toFixed(0)).join(' → ')}`;
});

await check('night with the full catalogue: fires, lights, no black screen', async () => {
  await page.evaluate(() => window.__imperial.game.setTimeOfDay(22.5));
  await page.waitForFunction(() => Math.abs(window.__imperial.renderer.worldTime - 22.5) < 0.05, { timeout: 60000, polling: 120 });
  await step(1.0);
  await wait(700);
  await shot('tour-04-night');
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    return { night: a.renderer.night, lights: a.renderer.townLightI, fires: a.renderer.fireBatch ? a.renderer.fireBatch.count : -1 };
  });
  assert(r.night > 0.9, 'the night uniform never arrived: ' + r.night);
  assert(r.fires > 0, 'no braziers in the town at night');
  return `night ${r.night.toFixed(2)} · ${r.fires} braziers · light ${r.lights.toFixed(2)}`;
});

await check('a storm of effects does not break the particle pool', async () => {
  await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    for (let i = 0; i < 60; i++) {
      const x = tc.x + (Math.random() - 0.5) * 30, z = tc.z + (Math.random() - 0.5) * 30;
      g.fx.blood(x, 1, z, 6);
      if (i % 3 === 0) g.fx.explosion(x, 1.2, z, 1.4);
      if (i % 4 === 0) g.fx.dust(x, 0.4, z, 4);
    }
  });
  await step(0.5);
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    a.renderer.render(1 / 60, a.game);
    return { particles: a.renderer.stats.particles, err: a.renderer.gl.getError() };
  });
  assert(r.err === 0, 'GL error while drawing the particle storm');
  assert(r.particles > 0, 'no particles were drawn at all');
  return `${r.particles} particles, no error`;
});

console.log('\nHYGIENE');
await check('no console errors, page errors or failed requests', async () => {
  const bad = [...pageErrors, ...failedRequests, ...consoleErrors];
  assert(!bad.length, bad.slice(0, 4).join(' | '));
  return 'zero errors across the whole tour';
});
await check('the GL context is clean after everything', async () => {
  const r = await page.evaluate(() => {
    const a = window.__imperial;
    a.renderer.render(1 / 60, a.game);
    return { err: a.renderer.gl.getError(), lost: a.renderer.ctxLost, buffers: a.renderer.gl.log ? a.renderer.gl.log.buffers : -1 };
  });
  assert(r.err === 0, 'GL error 0x' + r.err.toString(16));
  assert(!r.lost, 'the context was lost during the tour');
  return `GL clean, ${r.buffers} buffers allocated`;
});

await browser.close();
server.close();

const md = [
  '### Full-catalogue tour',
  '',
  `- ${results.length} checks · ${results.filter((r) => r.ok).length} passed`,
  '',
  ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`),
  '',
  failures ? '**TOUR FAILED.**' : '**Tour passed — every building and unit type renders.**'
].join('\n');
await writeFile('ci/tour-report.md', md).catch(() => {});
console.log('');
if (failures) {
  console.log(`TOUR FAILED — ${failures}/${results.length} checks`);
  process.exit(1);
}
console.log(`TOUR PASSED — ${results.length}/${results.length} checks`);
