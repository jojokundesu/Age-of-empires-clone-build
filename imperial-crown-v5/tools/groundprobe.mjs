/* Dev tool: is the ground actually textured, or just painted?

   "The terrain looks flat" is not a bug report. This measures it: render the
   same camera pose with the detail tile on and off, read both frames back, and
   compare the local contrast (mean absolute difference between neighbouring
   pixels) inside a patch of ground with no buildings in it. A ground that is
   genuinely textured has several times the local contrast of one that is just
   a smooth gradient.

   node tools/groundprobe.mjs [--detail 1] [--dist 46]
*/
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('run npm run build first'); process.exit(2); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, (req.url === '/' ? '/index.html' : req.url).split('?')[0]);
    const b = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  protocolTimeout: 240000,
  args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 240000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 240000, polling: 200 });
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 240000 });
await new Promise((r) => setTimeout(r, 4000));

const measure = async (strength) => page.evaluate(async (strength) => {
  const a = window.__imperial;
  const r = a.renderer;
  r.setQuality('high');
  r.setPixelScale(1);
  if (a.governor) a.governor.enabled = false;
  const cam = a.camera;
  const tc = a.game.buildings.find((b) => b.team === 1 && !b.dead);
  cam.desiredYaw = cam.yaw = 0.7;
  cam.desiredPitch = cam.pitch = 0.62;
  cam.desiredDist = cam.dist = 46;
  const old = r.quality;
  r.quality = { ...old, detail: strength };
  if (tc) cam.setTarget(tc.x, tc.z, true);
  cam.update(1 / 60, { instant: true });
  for (let i = 0; i < 3; i++) r.render(1 / 60, a.game);
  /* read a band of ground below the town, where nothing is drawn over it */
  const W = r.renderW, H = r.renderH;
  const bw = Math.round(W * 0.5), bh = Math.round(H * 0.18);
  const x0 = Math.round(W * 0.25), y0 = Math.round(H * 0.06);
  const px = new Uint8Array(bw * bh * 4);
  r.gl.readPixels(x0, y0, bw, bh, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
  /* local contrast: mean |luma(x,y) - luma(x+1,y)|, which is zero for a flat
     gradient and large for a textured surface */
  /* local contrast at several lags: 1 px is "is there any surface at all",
     4 px is blade/clump scale, 16 px is field-patch scale, 64 px is the
     painted splat. A ground that only has the last one looks like watercolour. */
  const luma = new Float32Array(bw * bh);
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
    luma[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  }
  const lag = (L) => {
    let sum = 0, n = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw - L; x++) {
        sum += Math.abs(luma[y * bw + x + L] - luma[y * bw + x]); n++;
      }
    }
    return sum / Math.max(1, n);
  };
  r.quality = old;
  return { lag: { '1': lag(1), '2': lag(2), '4': lag(4), '8': lag(8), '16': lag(16), '32': lag(32), '64': lag(64) },
    contrast: lag(1), W, H, buffer: `${r.renderW}x${r.renderH}` };
}, strength);

const off = await measure(0);
const on = await measure(Number(argOf('detail', 1)));
console.log(`  buffer ${on.buffer}`);
console.log('  lag(px)   detail off   detail on    ratio');
for (const k of Object.keys(on.lag)) {
  console.log(`  ${k.padStart(5)}   ${off.lag[k].toFixed(2).padStart(9)}   ${on.lag[k].toFixed(2).padStart(9)}   ${(on.lag[k] / Math.max(0.01, off.lag[k])).toFixed(2)}x`);
}
await browser.close();
server.close();
