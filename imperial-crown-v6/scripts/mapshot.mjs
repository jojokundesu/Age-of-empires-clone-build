/* Map snapshot helper: serve dist/, boot one match, screenshot it.

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
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end('x');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(), headless: true,
  protocolTimeout: 300000,
  args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,720']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
await mkdir('/tmp/shots', { recursive: true });
await page.goto(base, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 200000 });
const mapArg = process.argv[2] || 'confluence';
const out = process.argv[3] || ('/tmp/shots/' + mapArg + '.png');
const zoom = process.argv[4] || '210';
const tx = process.argv[5] || '0';
const tz = process.argv[6] || '0';
const pitch = process.argv[7] || '1.0';
const yaw = process.argv[8] || '0';
/* Start the match through the same call the game's own menu uses: setting
   settings.mapType alone leaves the menu's pickMode to decide the archetype,
   and the menu's default is Confluence -- so every "highview" screenshot was
   quietly a picture of Confluence. */
await page.evaluate((map) => {
  const a = window.__imperial;
  a.settings.mapType = map; a.settings.fog = false;
  a.startMatch({ mapType: map, mode: 'sandbox', seed: 20261, civ: 'franks', difficulty: 'standard' });
  return true;
}, mapArg);
const started = await page.waitForFunction((m) => {
  const a = window.__imperial;
  return a.running === true && a.game && a.game.world && a.game.world.mapType === m;
}, { timeout: 180000, polling: 500 }, mapArg).then(() => true).catch(() => false);
if (!started) {
  const st = await page.evaluate(() => ({
    running: window.__imperial.running,
    mt: window.__imperial.game && window.__imperial.game.world && window.__imperial.game.world.mapType
  }));
  console.log('!! match did not start on', mapArg, JSON.stringify(st));
  await page.screenshot({ path: out });
  await browser.close();
  server.close();
  process.exit(2);
}
/* startMatch() boots the world but does not dismiss the shell -- the menu's
   own button does that -- so a direct call leaves the menu painted over the
   battle. Dismiss it the way the button does. */
await page.evaluate(() => {
  const a = window.__imperial;
  a.menu && a.menu.hideMenu && a.menu.hideMenu();
  document.getElementById('menuScreen')?.classList.add('hidden');
});
await page.evaluate((z, x, tzz) => { window.__zoom = z; window.__tx = x; window.__tz = tzz; }, zoom, tx, tz);
await page.evaluate((p,y)=>{window.__pitch=p;window.__yaw=y;}, pitch, yaw);
await new Promise(r => setTimeout(r, 4000));
await page.evaluate(() => {
  const a = window.__imperial;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; a.governor.scale = 1; }
  a.renderer.setQuality('high'); a.renderer.setPixelScale(1);
  document.getElementById('hud')?.classList.add('hidden');
  const c = a.camera;
  a.game.settings.fog = false; a.game.showFog = false;
  const mode = new URLSearchParams(location.search).get('zoom') || '1';
  c.dist = c.desiredDist = Number(window.__zoom || 210); c.pitch = Number(window.__pitch||1.16); c.yaw = Number(window.__yaw || 0); c.setTarget(Number(window.__tx||0), Number(window.__tz||0), true);
});
await new Promise(r => setTimeout(r, 2500));
console.log('state', JSON.stringify(await page.evaluate(() => ({
  running: window.__imperial.running,
  mt: window.__imperial.game && window.__imperial.game.world && window.__imperial.game.world.mapType,
  menuHidden: document.getElementById('menu') ? document.getElementById('menu').classList.contains('hidden') : 'no-menu',
  splash: [...document.querySelectorAll('.splash')].map(e => e.className)
}))));
await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close(); server.close();
