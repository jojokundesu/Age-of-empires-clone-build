/* Real-browser frame-rate measurement, at the target phone's pixel geometry.

   `tests/browser.mjs` proves the game *works* in Chromium; this measures what
   it costs. The interesting question for a phone is not "how many frames per
   second does my laptop get" but "how much does the frame cost when the
   drawing buffer is the size this phone really asks for", so the viewport is
   set to a Realme 9i (360x800 CSS at DPR 3 = 1080x2400) and the renderer is
   asked to draw at several pixel budgets, from the v3 behaviour (the full
   native buffer, 2.6 Mpx) down through the v4 tiers.

   Chromium in CI has no GPU, so it falls back to SwiftShader -- a CPU
   rasteriser. That makes absolute numbers meaningless for a phone and the
   *relative* numbers meaningful in exactly the dimension we care about: cost
   per pixel. A frame that is 4x cheaper at 0.46 Mpx than at 2.6 Mpx here is
   also cheaper on an Adreno 610, because both are fill-rate bound.

   node tools/fps.mjs [--seconds 6] [--w 360] [--h 800] [--dpr 3] [--out ci/fps]
*/
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { TIERS } from '../src/gfx/quality.js';

const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const SECONDS = Number(argOf('seconds', 6));
const W = Number(argOf('w', 360));
const H = Number(argOf('h', 800));
const DPR = Number(argOf('dpr', 3));
const OUT = resolve(argOf('out', 'ci/fps'));
const ROOT = resolve('dist');

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/ not found — run `npm run build` first');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};
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

async function findChrome() {
  if (process.env.CHROME_PATH) return { exe: process.env.CHROME_PATH, args: [] };
  const system = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
    .find((p) => existsSync(p));
  if (system) return { exe: system, args: [] };
  const mod = await import('@sparticuz/chromium');
  const chromium = mod.default ?? mod;
  return { exe: await chromium.executablePath(), args: chromium.args };
}
const chrome = await findChrome();
const browser = await puppeteer.launch({
  executablePath: chrome.exe,
  headless: true,
  protocolTimeout: 240000,
  args: [
    ...chrome.args,
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', `--window-size=${W * 2},${H}`, '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'
  ]
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.error('pageerror:', String(e).split('\n')[0]));

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 240000 });
await page.waitForFunction(
  () => {
    const m = document.getElementById('menuScreen');
    const b = document.getElementById('bootScreen');
    return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
  },
  { timeout: 240000, polling: 200 }
);

/* Start the match, put the camera on the town, and give it a crowd so the
   measurement is of the worst case rather than of an empty field. */
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 240000 });
await page.evaluate(() => {
  const a = window.__imperial;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; }  // this tool owns the settings
  const tc = a.game.buildings.find((b) => b.team === 1 && !b.dead);
  if (tc) a.camera.setTarget(tc.x, tc.z, true);
  const u = a.game.units.filter((x) => !x.dead && x.team === 1)[0];
  for (let i = 0; i < 120; i++) {
    const ang = (i / 120) * Math.PI * 2, r = 3 + (i % 13) * 0.55;
    a.game.spawnUnitRaw(['spearman', 'swordsman', 'archer', 'knight'][i & 3], 1,
      (u ? u.x : 0) + Math.cos(ang) * r, (u ? u.z : 0) + Math.sin(ang) * r);
  }
});
await new Promise((r) => setTimeout(r, 1500));

/* Frame rate is measured in *rendered frames per second of wall clock*, not
   from requestAnimationFrame deltas. Two reasons: rAF deltas are quantised to
   the compositor, and a governor that deliberately renders every other frame
   would otherwise look like a 60 fps game that stutters. What a player sees
   is how many different pictures arrived in a second. */
const probe = async (label, setup) => {
  await page.evaluate(setup);
  await new Promise((r) => setTimeout(r, 900));   // settle: resize, shadow rebuild
  const res = await page.evaluate(async (seconds) => {
    const a = window.__imperial;
    const r = a.renderer;
    const prep = [];
    const orig = r.render.bind(r);
    r.render = (dt, g) => { const t = performance.now(); orig(dt, g); prep.push(performance.now() - t); };
    const f0 = r.frameCount;
    const t0 = performance.now();
    await new Promise((done) => setTimeout(done, seconds * 1000));
    const secs = (performance.now() - t0) / 1000;
    const drawn = r.frameCount - f0;
    r.render = orig;
    prep.sort((x, y) => x - y);
    return {
      fps: drawn / secs,
      drawn, secs,
      prepMed: prep.length ? prep[prep.length >> 1] : 0,
      prepP95: prep.length ? prep[Math.min(prep.length - 1, Math.floor(prep.length * 0.95))] : 0,
      buffer: `${r.renderW}x${r.renderH}`,
      mpx: (r.renderW * r.renderH) / 1e6,
      draws: r.stats.drawCalls, tris: r.stats.tris,
      instances: r.stats.instances, tier: r.qualityName,
      glError: r.gl.getError()
    };
  }, SECONDS);
  console.log(`${label.padEnd(26)} ${res.buffer.padEnd(11)} ${res.mpx.toFixed(2)} Mpx  `
    + `${res.fps.toFixed(1).padStart(5)} fps  cpu ${res.prepMed.toFixed(1)}/${res.prepP95.toFixed(1)} ms  `
    + `${res.draws} draws  ${(res.tris / 1000).toFixed(0)}k tris`
    + (res.glError ? '  GL ERROR ' + res.glError : ''));
  return res;
};

const results = {};
const fullNative = await page.evaluate(() => {
  const a = window.__imperial;
  const dpr = Math.min(window.devicePixelRatio, 3);
  return Math.round(a.canvas.clientWidth * a.canvas.clientHeight * dpr * dpr);
});

/* v3 behaviour: no pixel budget, the buffer is css x DPR. */
results.v3 = await probe('v3 (full native buffer)', `(() => {
  const a = window.__imperial;
  a.renderer.setQuality('high');
  a.renderer.quality.maxDpr = 4;
  a.renderer.setPixelScale(1);
  a.renderer.pixelBudget = ${fullNative};
  a.renderer.renderW = 0; a.renderer.resize();
  return a.renderer.renderW * a.renderer.renderH;
})()`);

for (const tier of ['low', 'medium', 'high', 'ultra']) {
  results[tier] = await probe(`v4 ${tier}`, `(() => {
    const a = window.__imperial;
    a.renderer.setQuality('${tier}');
    a.renderer.setPixelScale(1);
    return a.renderer.renderW * a.renderer.renderH;
  })()`);
}

await page.screenshot({ path: join(OUT, 'town.png') });

console.log('\nsummary (SwiftShader: relative, not absolute)');
for (const k of ['v3', 'low', 'medium', 'high', 'ultra']) {
  const r = results[k];
  console.log(`  ${k.padEnd(7)} ${r.mpx.toFixed(2).padStart(5)} Mpx  ${r.fps.toFixed(1).padStart(6)} fps  `
    + `${(1000 / Math.max(0.01, r.fps) / Math.max(0.01, r.mpx)).toFixed(0).padStart(5)} ms per Mpx`);
}
console.log(`  v4 balanced is ${(results.v3.mpx / Math.max(1e-6, results.medium.mpx)).toFixed(1)}x fewer pixels than the v3 buffer`);
for (const k of ['v3', 'low', 'medium', 'high', 'ultra']) {
  if (results[k].glError) { console.error('GL error during ' + k); process.exitCode = 1; }
}

await browser.close();
server.close();
