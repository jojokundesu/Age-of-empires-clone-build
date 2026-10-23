import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true,
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready');
await page.evaluate(() => document.querySelector('.modeCard[data-mode="sandbox"]').click());
await page.evaluate(() => document.getElementById('btnStart').click());
await page.waitForFunction('window.__imperial.running === true');
await new Promise((r) => setTimeout(r, 7000));
const out = await page.evaluate(() => {
  const gl = window.__imperial.renderer.gl;
  const prog = window.__imperial.renderer.pModel.program;
  const q = (n) => { const loc = gl.getUniformLocation(prog, n); const v = gl.getUniform(prog, loc); return v === null ? null : (typeof v === 'object' ? Array.from(v).map((x) => +(+x).toFixed(4)) : v); };
  window.__uni = { camPos: q('uCameraPos'), fogDensity: q('uFogDensity'), sunColor: q('uSunColor'), sunDir: q('uSunDir'),
    sky: q('uSkyColor'), ground: q('uGroundColor'), fogColor: q('uFogColor'), vp: q('uViewProj') };
  return { uni: window.__uni, uniforms: gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) };
});
const out2 = await page.evaluate(() => window.__uni);
console.log(JSON.stringify(out2, null, 1));
const _unused = await page.evaluate(() => {
  const a = window.__imperial; const r = a.renderer;
  const f = (v) => Array.from(v).map((x) => +x.toFixed(3));
  return {
    fogDensity: r.fogDensity, exposure: r.exposure, night: r.night,
    sunColor: f(r.sunColor), skyColor: f(r.skyColor), groundColor: f(r.groundColor),
    fogColor: f(r.fogColor), sunDir: f(r.sunDir),
    quality: r.quality, renderScale: r.renderScale, camDist: a.game.camera.dist,
    objects: a.game.units.length, buildings: a.game.buildings.length,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
