import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
const ROOT = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
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
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true,
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
await page.goto(base, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 180000 });
await page.evaluate(() => { const a = window.__imperial; a.menu && a.menu.pickMode && a.menu.pickMode('sandbox'); });
await page.waitForSelector('#menuScreen:not(.hidden)', { timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 120000 });
await page.evaluate(() => window.__imperial.renderer.setQuality('high'));
await new Promise((r) => setTimeout(r, 4000));
const info = await page.evaluate(async () => {
  const a = window.__imperial;
  a.game.setTimeOfDay(22.34);
  const cam = a.camera;
  cam.yaw = cam.desiredYaw = -1.66; cam.pitch = cam.desiredPitch = 0.22; cam.dist = cam.desiredDist = 52;
  const tc = a.game.buildings.find((b) => b.team === 1 && !b.dead) || { x: 0, z: 0 };
  cam.setTarget(tc.x, tc.z, true);
  cam.update(0.016, { instant: true });
  await new Promise((r) => setTimeout(r, 2500));
  const r = a.renderer;
  const m = r.moonDir;
  const { m4transformPoint } = window.__imperial.math || {};
  return { moon: Array.from(m), moonAmount: r.moonAmount, starAmount: r.starAmount, worldTime: r.worldTime,
    eye: Array.from(cam.eye), pitch: cam.pitch, yaw: cam.yaw };
});
console.log(JSON.stringify(info));
const px = await page.evaluate(() => {
  const a = window.__imperial;
  const { m4transformPoint } = a.math || {};
  const cam = a.camera, m = a.renderer.moonDir;
  const p = [cam.eye[0] + m[0] * 300, cam.eye[1] + m[1] * 300, cam.eye[2] + m[2] * 300];
  const out = [0, 0, 0, 0];
  // manual projection via viewProj
  const vp = cam.viewProj;
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  out[0] = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w;
  out[1] = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w;
  return { ndc: out.slice(0, 2), w, size: [a.renderer.canvas.width, a.renderer.canvas.height] };
});
console.log(JSON.stringify(px));
await page.screenshot({ path: 'ci/shots/moonprobe.png' });
await browser.close(); server.close();
