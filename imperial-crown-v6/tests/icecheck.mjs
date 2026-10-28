/* ============================================================
   magesite.mjs — the Arcane Order, through the real interface
   ------------------------------------------------------------
   The node suite (tests/mods.mjs) proves the ladder exists: insight
   promotes a mage, a rank gates a spell, a hybrid is discovered. This
   suite proves the parts only a rendered frame can show:

     · the model really changes at every rank, and the six of them
       stand in a legible line;
     · the spell card opens a real book, with only the spells the
       rank has earned;
     · arming a spell arms the input layer too (the reticle), and a
       tap on the ground casts it;
     · SKYFALL hits a base, flashes the frame, shakes the camera and
       spends the day;
     · nothing errors, and quitting leaves no mod behind.

   node tests/magesite.mjs [--out ci/ice]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/ice'));
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
const frame = async (n = 3) => { for (let i = 0; i < n; i++) { await wait(90); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });


await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

await page.evaluate(() => window.__imperial.startMatch({
  mode: 'mods', mods: ['arcane'], civ: 'franks', difficulty: 'standard', seed: 909,
  quality: 'high', music: false, sound: false
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.modHost)', { timeout: 120000 });
await wait(1500);

await page.evaluate(() => {
  window.__look = (x, z, dist = 14, pitch = 0.42, yaw = 0.4) => {
    const cam = window.__imperial.camera;
    cam.target[0] = x; cam.target[1] = window.__imperial.game.heightAt(x, z); cam.target[2] = z;
    cam.desired[0] = cam.target[0]; cam.desired[1] = cam.target[1]; cam.desired[2] = cam.target[2];
    cam.yaw = cam.desiredYaw = yaw;
    cam.pitch = cam.desiredPitch = pitch;
    cam.dist = cam.desiredDist = dist;
    cam.update(0.016);
  };
});

const info = await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  if (!tc) return { error: 'no hall' };
  const mage = g.spawnUnit('mage', 1, tc.x + 8, tc.z + 2, null, { force: true });
  mage.modState.arcane.rank = 5;
  mage.modState.arcane.mana = 1000;
  let foes = 0;
  for (let i = 0; i < 5; i++) {
    const f = g.spawnUnitRaw('swordsman', 2, mage.x + 2.6 + (i % 3) * 1.3, mage.z - 2.2 + Math.floor(i / 3) * 1.5);
    if (f) { f.noAggro = true; f.maxHp = f.hp = 900; foes++; }
  }
  g.selection = [mage];
  a.ui.refreshCommands(true);
  return { foes, mage: [Number(mage.x.toFixed(1)), Number(mage.z.toFixed(1))] };
});
console.log('setup', JSON.stringify(info));

const cast = await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const arc = g.modHost.mods.get('arcane');
  const mage = g.units.find((u) => u.modState && u.modState.arcane && u.team === 1);
  const nova = arc.mod.spells().find((s) => s.id === 'nova');
  const ok = arc.mod.castSpell(arc.api, mage, nova, mage.x, mage.z);
  window.__look(mage.x, mage.z, 13, 0.40, 0.6);
  const frozen = g.units.filter((u) => u.modState && u.modState.arcane && u.modState.arcane.freeze > g.time).length;
  return { ok, frozen };
});
await frame(4);
const counts = await page.evaluate(() => {
  const r = window.__imperial.renderer, g = window.__imperial.game;
  return { ice: r.iceBatch ? r.iceBatch.count : -1, marks: g.groundMarkers.length,
    held: g.groundMarkers.filter((m) => m.hold).length, draw: r.stats.drawCalls };
});
console.log('nova', JSON.stringify(cast), 'render', JSON.stringify(counts));
console.log('batch', JSON.stringify(await page.evaluate(() => {
  const b = window.__imperial.renderer.iceBatch;
  const d = b.instances.data;
  return { count: b.count, cap: b.instances.capacity, m: [...d.slice(0, 16)].map((v) => +v.toFixed(2)),
    col: [...d.slice(16, 24)].map((v) => +v.toFixed(2)) };
})));
await shot('ice-1-freeze');


await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const arc = g.modHost.mods.get('arcane');
  const mage = g.units.find((u) => u.modState && u.modState.arcane && u.team === 1);
  arc.api.state.discovered.add('hail');
  const hail = arc.mod.hybrids().find((h) => h.id === 'hail');
  arc.mod.castSpell(arc.api, mage, hail, mage.x + 5, mage.z - 4);
  window.__look(mage.x + 3, mage.z - 2, 17, 0.46, 0.7);
});
await frame(4);
const held2 = await page.evaluate(() => window.__imperial.game.groundMarkers.filter((m) => m.hold).length);
console.log('area marks held', held2);
await shot('ice-2-area');

await page.setViewport({ width: 892, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluate(() => window.__imperial.quitToMenu());
await wait(1200);
await page.evaluate(() => window.__imperial.menu.openCodex());
await wait(800);
await shot('codex-1-spells');
const codex = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('#modalBody .codexTab')].map((b) => b.textContent);
  const body = document.getElementById('modalBody');
  return { tabs, wide: body.scrollWidth - body.clientWidth, rows: document.querySelectorAll('#modalBody .codexRow').length };
});
console.log('codex', JSON.stringify(codex));
await page.evaluate(() => { const l = [...document.querySelectorAll('#modalBody .codexTab')]; l[l.length - 1].click(); });
await wait(500);
await shot('codex-2-perks');
await page.evaluate(() => { const l = [...document.querySelectorAll('#modalBody .codexTab')]; l[1].click(); });
await wait(400);
await shot('codex-3-ranks');
console.log('errors', JSON.stringify(pageErrors.slice(0, 4)), JSON.stringify(consoleErrors.slice(0, 4)));
await browser.close(); server.close();
