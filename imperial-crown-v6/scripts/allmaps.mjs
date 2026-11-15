/* All maps helper: serve dist/, boot one match, screenshot it.

   Usage (from imperial-crown-v6/, after `npm run build`):
     node scripts/allmaps.mjs [maps]           -> /tmp/maps/<map>.png
     node scripts/mapshot.mjs <map> <out> <dist> <x> <z> <pitch> <yaw>

   The shared Chromium libraries are unpacked on the way in, exactly as the
   test runner does, so this works on a bare Linux box with no NSS installed.
*/
import { execFileSync } from 'node:child_process';
try {
  const libDir = execFileSync(process.execPath, ['scripts/browser-libs.mjs'], { encoding: 'utf8' }).trim();
  process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
} catch (e) {
  console.warn('chromium libs unavailable:', e.message);
}
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
const ROOT = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const p = join(ROOT, url === '/' ? 'index.html' : url);
    if (!p.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end('x'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(), headless: true,
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e && e.stack || e).slice(0, 1200)));
await mkdir('/tmp/maps', { recursive: true });
await page.goto(base, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 200000 });
await page.evaluate(() => { window.__imperial.settings.fog = false; });
const maps = (process.argv[2] || 'confluence,archipelago,mediterranean,highview,arabia,headwaters').split(',');
const dist = process.argv[3] || '300';
for (const map of maps) {
  await page.evaluate((m) => {
    const a = window.__imperial;
    a.startMatch({ mapType: m, mode: 'sandbox', seed: 20261, civ: 'franks', difficulty: 'standard' });
  }, map);
  const ok = await page.waitForFunction((m) => {
    const a = window.__imperial;
    return a.running === true && a.game && a.game.world && a.game.world.mapType === m;
  }, { timeout: 30000 }, map).then(() => true).catch(() => false);
  if (!ok) { const st = await page.evaluate(() => ({ running: window.__imperial.running, mt: window.__imperial.game && window.__imperial.game.world && window.__imperial.game.world.mapType })); console.log('!! not started', map, JSON.stringify(st)); continue; }
  console.log('  started', map);
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => {
    const a = window.__imperial;
    if (a.governor) { a.governor.enabled = false; a.governor.div = 1; a.governor.scale = 1; }
    a.renderer.setQuality('high'); a.renderer.setPixelScale(1);
    document.getElementById('hud')?.classList.add('hidden');
    a.game.settings.fog = false; a.game.showFog = false;
    /* The game's own zoom, pushed to its limit: maxDist is the designed
       strategic view, so this is what a player actually sees. */
    const c = a.camera;
    c.zoom(4);
    c.setPitch(1.02);
    c.yaw = c.desiredYaw = 0.35;
    c.setTarget(0, 0, true);
    c.snap();
    document.getElementById('menuScreen')?.classList.add('hidden');
    document.getElementById('bootScreen')?.classList.add('hidden');
    const hud = document.getElementById('hud'); if (hud) hud.classList.remove('hidden');
  });
  await new Promise(r => setTimeout(r, 2200));
  await page.evaluate(() => { const c = window.__imperial.camera; c.zoom(4); c.setPitch(1.02); c.snap(); });
  await new Promise(r => setTimeout(r, 900));
  const cam = await page.evaluate(() => { const c = window.__imperial.camera; return [c.dist, c.pitch]; });
  console.log(' cam', JSON.stringify(cam));
  const st2 = await page.evaluate(() => {
    const a = window.__imperial;
    return { running: a.running, paused: a.paused, hidden: document.hidden,
      hudHidden: document.getElementById('hud')?.classList.contains('hidden'),
      menuHidden: document.getElementById('menuScreen')?.classList.contains('hidden'),
      splash: [...document.querySelectorAll('body > *')].filter(e => e.offsetParent !== null).map(e => e.id || e.className).slice(0, 12) };
  });
  console.log('  state', JSON.stringify(st2));
  await page.screenshot({ path: `/tmp/maps/${map}.png` });
  console.log('wrote', map);
}
await browser.close(); server.close();
