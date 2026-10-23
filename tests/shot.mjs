/* Dev tool: boot the built game in headless Chrome, pose the camera and shoot
   screenshots. Usage:
     node tests/shot.mjs --out ci/shots --quality high --fog 0 --mode sandbox \
        --yaw 0.7 --pitch 0.62 --dist 46 [--time 12] [--wait 6000]
*/
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/shots'));
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });

await mkdir(OUT, { recursive: true });
await page.goto(base, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 180000 });

await page.screenshot({ path: join(OUT, 'menu.png') });

// start a match with the requested mode
const mode = argOf('mode', 'sandbox');
await page.evaluate((mode) => {
  const a = window.__imperial;
  a.menu && a.menu.pickMode && a.menu.pickMode(mode);
}, mode);
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 120000 });

await page.evaluate((q) => {
  const a = window.__imperial;
  if (q && q !== 'auto') a.renderer.setQuality(q);
}, argOf('quality', 'high'));

// let the match breathe so buildings appear, units walk
await new Promise((r) => setTimeout(r, Number(argOf('warm', 6000))));

const shots = JSON.parse(argOf('shots', '[]'));
const pose = async (p) => {
  await page.evaluate((p) => {
    const a = window.__imperial;
    const g = a.game;
    if (p.fog !== undefined) {
      g.settings.fog = !!p.fog;
      a.renderer.setFog && a.renderer.setFog(!!p.fog);
      if (g.fog) { for (let i = 0; i < g.fog.length; i++) g.fog[i] = p.fog ? g.fog[i] : 255; }
    }
    if (p.time !== undefined && g.setTimeOfDay) g.setTimeOfDay(p.time);
    if (p.tod !== undefined && g.setTimeOfDay) g.setTimeOfDay(p.tod * 24);
    const tc = g.buildings.find((b) => b.team === 1 && !b.dead) || { x: 0, z: 0 };
    const cam = a.camera;
    cam.yaw = cam.desiredYaw = p.yaw ?? 0.7;
    cam.pitch = cam.desiredPitch = p.pitch ?? 0.62;
    cam.dist = cam.desiredDist = p.dist ?? 46;
    a.camera.setTarget(tc.x + (p.dx || 0), tc.z + (p.dz || 0), true);
    // diagnostic: drop a decor kind entirely (e.g. hide:["tuft"]) to see what
    // a single prop family contributes to the ground clutter
    if (p.hide && p.hide.length) {
      for (const kind of p.hide) a.renderer.propCells.get(kind)?.clear();
      a.renderer.propDirty = true;
    }
  }, p);
  // headless software GL runs at a couple of frames per second, so "wait
  // 2 s" is not the same as "the renderer has drawn the new time of day".
  // Poll until the renderer has actually sampled the requested world time.
  const want = await page.evaluate(() => window.__imperial.game.worldTime);
  await page.waitForFunction(
    (want) => {
      const a = window.__imperial;
      return a.renderer.worldTime !== undefined && Math.abs(a.renderer.worldTime - want) < 0.02;
    },
    { timeout: 15000, polling: 120 }, want,
  ).catch(() => console.log(`[warn] renderer never picked up world time ${want}`));
  await new Promise((r) => setTimeout(r, Number(argOf('settle', 2500))));
  const file = join(OUT, (p.name || 'shot') + '.png');
  await page.screenshot({ path: file });
  const info = await page.evaluate(() => {
    const a = window.__imperial;
    return { stats: a.renderer.stats, quality: a.renderer.qualityName, time: a.game.time,
      units: a.game.units.filter((u) => !u.dead).length,
      hour: +a.renderer.worldTime.toFixed(2), night: +a.renderer.night.toFixed(2), lights: +a.renderer.townLightI.toFixed(2) };
  });
  console.log(file, JSON.stringify(info));
};

if (shots.length) {
  for (const s of shots) await pose(s);
} else {
  await pose({ name: 'town', fog: Number(argOf('fog', 1)), yaw: Number(argOf('yaw', 0.7)), pitch: Number(argOf('pitch', 0.62)), dist: Number(argOf('dist', 46)) });
}
await browser.close();
server.close();
