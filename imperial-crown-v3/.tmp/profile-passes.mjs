/* Measures the cost of renderer.render() on a fixed scene, for two builds. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = resolve(argOf('root', 'dist'));
const W = Number(argOf('w', 1280)), H = Number(argOf('h', 720));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
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
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(base, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 240000 });
await page.evaluate(() => window.__imperial.startMatch({
  mode: 'sandbox', difficulty: 'sandbox', civ: 'franks', seed: 20261, quality: 'high'
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 180000 });
await new Promise((r) => setTimeout(r, 6000));
const out = await page.evaluate(async (q) => {
  const a = window.__imperial;
  a.renderer.setQuality(q);
  a.renderer.adaptiveScale = 1; a.renderer.resize();
  const g = a.game;
  const tc = g.buildings.find((b) => b.team === 1 && !b.dead) || { x: 0, z: 0 };
  a.camera.yaw = a.camera.desiredYaw = 0.7;
  a.camera.pitch = a.camera.desiredPitch = 0.62;
  a.camera.dist = a.camera.desiredDist = 46;
  a.camera.setTarget(tc.x, tc.z, true);
  const gl = a.renderer.gl;
  const px = new Uint8Array(4);
  const bench = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      a.camera.update(1 / 60);
      a.renderer.render(1 / 60, g);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return +((performance.now() - t0) / n).toFixed(1);
  };
  const R = a.renderer;
  const orig = {
    _drawTerrain: R._drawTerrain, _drawModels: R._drawModels, _drawSky: R._drawSky,
    _drawWater: R._drawWater, _drawDecals: R._drawDecals, _drawBillboards: R._drawBillboards,
    _drawParticles: R._drawParticles, _drawPost: R._drawPost, _shadowPass: R._shadowPass,
    _drawAmmo: R._drawAmmo
  };
  bench(4);
  const full = bench(12);
  const rows = { full };
  for (const k of Object.keys(orig)) {
    R[k] = () => {};
    rows[k] = bench(12);
    R[k] = orig[k];
  }
  // fragment-only probes: same geometry, but a trivial fragment shader would
  // need new programs; instead test resolution scaling of the full frame
  rows.lowres = (() => {
    const old = [R.renderW, R.renderH];
    return null;
  })();
  return rows;
}, argOf('quality', 'high'));
console.log(JSON.stringify(out));
await browser.close();
server.close();
