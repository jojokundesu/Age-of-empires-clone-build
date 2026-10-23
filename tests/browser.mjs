/* Real-browser smoke test. Boots the production bundle in headless Chrome,
   starts a match, plays it for a few seconds, measures real frame times, checks
   the WebGL context for errors and saves screenshots.

   Chrome is resolved in this order:
     1. $CHROME_PATH
     2. a system install (/usr/bin/google-chrome, /usr/bin/chromium, …)
     3. the Chromium build shipped by `@sparticuz/chromium` (used by sandboxes
        without a system browser — needs `LD_LIBRARY_PATH` pointing at stubs of
        libnss3/libnspr4 if those are missing)

   Usage: node tests/browser.mjs [--seconds 8] [--out ci/screenshots]        */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const SECONDS = Number(argOf('seconds', 8));
const OUT = resolve(argOf('out', 'ci/screenshots'));
const ROOT = resolve('dist');

const REPORT = 'ci/browser-report.md';
await mkdir('ci', { recursive: true }).catch(() => {});
const writeReport = (md) => writeFile(REPORT, md).catch(() => {});
await writeReport('### Browser smoke test\n\nRUNNING — the job will rewrite this with results.\n');
const bail = async (msg) => {
  console.error(msg);
  await writeReport(`### Browser smoke test\n\n**FAILED TO START**\n\n\`\`\`\n${msg}\n\`\`\`\n`);
  process.exit(2);
};
if (!existsSync(join(ROOT, 'index.html'))) {
  await bail('dist/ not found — run `npm run build` first');
}

/* ---------------------------------------------------------------- server -- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json'
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
const URL_BASE = `http://127.0.0.1:${server.address().port}/`;

/* ---------------------------------------------------------------- chrome -- */
async function findChrome() {
  if (process.env.CHROME_PATH) return { exe: process.env.CHROME_PATH, args: [] };
  const system = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
    .find((p) => existsSync(p));
  if (system) return { exe: system, args: [] };
  try {
    const mod = await import('@sparticuz/chromium');
    const chromium = mod.default ?? mod;
    const exe = await chromium.executablePath();
    return { exe, args: chromium.args };
  } catch (e) {
    await bail('no Chrome binary found and @sparticuz/chromium is unavailable: ' + e.message);
  }
}
const chrome = await findChrome();

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chrome.exe,
    headless: true,
    protocolTimeout: 180000,
    args: [
      ...chrome.args,
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'
    ]
  });
} catch (e) {
  await bail('Chrome refused to launch: ' + (e && e.message));
}

/* ------------------------------------------------------------------ test -- */
const DPR = Number(argOf('dpr', 2.5));
const page = await browser.newPage();
// Realme 9i class viewport at a phone pixel ratio. Software GL in CI is slow,
// so --dpr lets the workflow trade authenticity for a run that finishes.
await page.setViewport({ width: 900, height: 414, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  const type = m.type();
  const text = m.text();
  if (type === 'error') consoleErrors.push(text);
  else if (type === 'warning' && /webgl|shader|gl_|THREE/i.test(text)) consoleErrors.push('warn: ' + text);
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
const failedRequests = [];
page.on('requestfailed', (r) => failedRequests.push(r.url() + ' — ' + (r.failure()?.errorText || 'failed')));
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(r.url() + ' — HTTP ' + r.status()); });

const results = {};
const fail = [];
let checksRun = 0;
const expect = (cond, msg) => { checksRun++; if (!cond) fail.push(msg); };
const shot = async (name) => {
  const p = join(OUT, name + '.png');
  await page.screenshot({ path: p });
  return (await readFile(p)).length;
};

try {
  await mkdir(OUT, { recursive: true });
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 180000 });

  results.gpu = await page.evaluate(() => {
    const gl = window.__imperial.renderer.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a',
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE)
    };
  });

  results.menuShot = await shot('01-menu');

  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 120000 });
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 2000) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  results.matchShot = await shot('02-match');

  // jump the camera to the player's town so the shot is representative
  await page.evaluate(() => {
    const a = window.__imperial;
    const tc = a.game.buildings.find((b) => b.team === 1 && !b.dead) || a.game.buildings.find((b) => b.team === 1);
    if (tc) a.camera.setTarget(tc.x, tc.z, true);
    const units = a.game.units.filter((u) => !u.dead && u.team === 1).slice(0, 10);
    if (units.length) a.game.setSelection(units);
    if (a.ui && a.ui.refreshCommands) a.ui.refreshCommands();
  });
  await new Promise((r) => setTimeout(r, 1500));
  results.townShot = await shot('03-town');

  results.frame = await page.evaluate(() => {
    const a = window.__imperial;
    const f = window.__frames.slice(10).sort((x, y) => x - y);
    const avg = f.reduce((s, v) => s + v, 0) / Math.max(1, f.length);
    return {
      samples: f.length,
      fps: 1000 / avg,
      avgMs: avg,
      p95Ms: f[Math.floor(f.length * 0.95)] || avg,
      worstMs: f[f.length - 1] || 0,
      draws: a.renderer.stats.drawCalls,
      tris: a.renderer.stats.tris,
      instances: a.renderer.stats.instances,
      particles: a.renderer.stats.particles,
      units: a.game.units.filter((u) => !u.dead).length,
      buildings: a.game.buildings.filter((b) => !b.dead).length,
      quality: a.renderer.qualityName,
      glError: a.renderer.gl.getError(),
      time: a.game.time
    };
  });

  // drive the interface like a player: open the build menu, place a building,
  // pan the camera, pause, then quit to the menu.
  results.ui = await page.evaluate(() => {
    const a = window.__imperial;
    const out = {};
    a.ui.toast('Browser smoke test', 'ok');
    a.game.notify('Smoke test', 'good');
    out.cards = document.querySelectorAll('#cmdGrid .cmdBtn').length;
    return out;
  });
  await new Promise((r) => setTimeout(r, 600));
  results.uiShot = await shot('04-hud');

  results.afterUi = await page.evaluate(() => {
    const a = window.__imperial;
    return { glError: a.renderer.gl.getError(), errors: a.errors ? a.errors.slice(0, 3) : null };
  });

  // ---- day / night: the same camera, eight hours later -------------------
  // Reads the actual framebuffer, so it catches "night is a black screen" and
  // "the sun never moves" rather than just checking that a uniform was set.
  const sampleLuma = () => page.evaluate(() => {
    const a = window.__imperial;
    const gl = a.renderer.gl;
    const w = 96, h = 54;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, warm = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      warm += r - b;
    }
    const n = px.length / 4;
    return { luma: sum / n, warmth: warm / n };
  });
  const setHour = async (hour) => {
    await page.evaluate((hour) => window.__imperial.game.setTimeOfDay(hour), hour);
    await page.waitForFunction(
      (hour) => Math.abs(window.__imperial.renderer.worldTime - hour) < 0.05,
      { timeout: 30000, polling: 120 }, hour,
    );
    await new Promise((r) => setTimeout(r, 900));
    return sampleLuma();
  };
  results.daylight = await setHour(12);
  results.daylightShot = await shot('05-daylight');
  results.night = await setHour(22.5);
  results.nightShot = await shot('06-night');

  expect(results.daylight.luma > 45, `daytime frame is nearly black (${results.daylight.luma.toFixed(1)})`);
  expect(results.night.luma > 5, `night frame is black (${results.night.luma.toFixed(1)})`);
  expect(results.night.luma < results.daylight.luma * 0.8,
    `night is not darker than day (${results.night.luma.toFixed(1)} vs ${results.daylight.luma.toFixed(1)})`);
  expect(results.nightShot > 12000, 'night screenshot looks blank');
  expect(results.daylight.warmth > results.night.warmth,
    `daylight is not warmer than moonlight (${results.daylight.warmth.toFixed(1)} vs ${results.night.warmth.toFixed(1)})`);
  await setHour(10);

  results.errors = { console: consoleErrors.slice(0, 10), page: pageErrors.slice(0, 10), requests: failedRequests.slice(0, 10) };

  expect(results.errors.page.length === 0, 'page errors: ' + results.errors.page.join(' | '));
  expect(results.errors.console.length === 0, 'console errors: ' + results.errors.console.join(' | '));
  expect(results.frame.draws > 15, `only ${results.frame.draws} draw calls`);
  expect(results.frame.tris > 5000, `only ${results.frame.tris} triangles`);
  expect(results.frame.glError === 0, 'gl.getError() = ' + results.frame.glError);
  expect(results.frame.time > 1, 'the simulation did not advance');
  expect(results.menuShot > 15000, 'menu screenshot looks blank');
  expect(results.matchShot > 25000, 'match screenshot looks blank');
  expect(results.ui.cards > 0, 'no command cards rendered');
} catch (err) {
  fail.push('EXCEPTION: ' + String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : err));
  try { results.failureShot = await shot('99-failure'); } catch { /* ignore */ }
  results.exception = String(err && err.stack ? err.stack : err);
} finally {
  await browser.close();
  server.close();
}

/* ---------------------------------------------------------------- report -- */
const f = results.frame || {};
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '?');
const md = [
  '### Browser smoke test',
  '',
  `- GPU: \`${results.gpu?.renderer || '?'}\` — ${results.gpu?.version || ''}`,
  `- Renderer: ${f.draws} draws · ${f.tris} tris · ${f.instances} instances · ${f.particles} particles · quality **${f.quality}**`,
  `- Frame: **${fmt(f.fps)} fps** avg ${fmt(f.avgMs)} ms · p95 ${fmt(f.p95Ms)} ms · worst ${fmt(f.worstMs)} ms (${f.samples} samples)`,
  `- World: ${f.units} units, ${f.buildings} buildings, game time ${fmt(f.time, 0)} s`,
  `- UI: ${results.ui?.cards ?? '?'} command cards · glError ${results.afterUi?.glError ?? '?'}`,
  `- Day/night: noon luma ${fmt(results.daylight?.luma)} → night luma ${fmt(results.night?.luma)} (screenshots 05/06)`,
  `- Console errors: ${results.errors?.console.length ?? '?'} · page errors: ${results.errors?.page.length ?? '?'} · failed requests: ${results.errors?.requests.length ?? '?'}`,
  results.errors?.requests.length ? `  - ${results.errors.requests.join('\n  - ')}` : '',
  `- Checks: ${checksRun} run · ${fail.length} failed`,
  results.errors?.page.length ? `  - ${results.errors.page.join('\n  - ')}` : '',
  results.errors?.console.length ? `  - ${results.errors.console.join('\n  - ')}` : '',
  fail.length ? `\n**FAILURES**\n${fail.map((x) => '- ' + x).join('\n')}` : '\n**All browser checks passed.**'
].filter(Boolean).join('\n');

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { await writeFile(process.env.GITHUB_STEP_SUMMARY, md + '\n', { flag: 'a' }); } catch { /* ignore */ }
}
await mkdir('ci', { recursive: true }).catch(() => {});
await writeFile('ci/browser-report.json', JSON.stringify({ results, fail }, null, 2)).catch(() => {});
await writeReport(md);
process.exit(fail.length ? 1 : 0);
