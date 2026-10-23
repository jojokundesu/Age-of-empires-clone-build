/* Real-browser smoke test (runs in CI, where Chrome exists).
   Boots the production bundle in headless Chrome with SwiftShader, starts a
   match, plays for a few seconds, measures the frame rate, checks the WebGL
   context for errors and saves screenshots.

   Usage:  node tests/browser.mjs [--seconds 8] [--out ci/screenshots]        */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const SECONDS = Number(argOf('seconds', 8));
const OUT = resolve(argOf('out', 'ci/screenshots'));
const ROOT = resolve('dist');

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/ not found — run `npm run build` first');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL_BASE = `http://127.0.0.1:${PORT}/`;

const CHROME = process.env.CHROME_PATH ||
  ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((p) => existsSync(p));
if (!CHROME) { console.error('no Chrome binary found'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,720',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'
  ]
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') consoleErrors.push(m.text());
  else if (t === 'warning' && /webgl|shader|gl_/i.test(m.text())) consoleErrors.push('warn: ' + m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

const results = {};
const fail = [];
const expect = (cond, msg) => { if (!cond) fail.push(msg); };

try {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 90000 });
  results.gpu = await page.evaluate(() => {
    const gl = window.__imperial.renderer.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a',
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE)
    };
  });
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, '01-menu.png') });
  results.menuShotBytes = (await readFile(join(OUT, '01-menu.png'))).length;

  // start a campaign exactly like a player would
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 60000 });
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 900) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await page.screenshot({ path: join(OUT, '02-match.png') });

  // select the whole army via the HUD, then screenshot the command card
  await page.evaluate(() => {
    const a = window.__imperial;
    const army = a.game.units.filter((u) => !u.dead && u.team === 1).slice(0, 12);
    a.game.setSelection(army);
    a.ui.refreshCommands();
    a.camera.setTarget(army[0]?.x ?? 0, army[0]?.z ?? 0, true);
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(OUT, '03-army.png') });

  results.frame = await page.evaluate(() => {
    const a = window.__imperial;
    const f = window.__frames.slice(5).sort((x, y) => x - y);
    const avg = f.reduce((s, v) => s + v, 0) / Math.max(1, f.length);
    const p95 = f[Math.floor(f.length * 0.95)] || avg;
    return {
      samples: f.length,
      fps: 1000 / avg,
      avgMs: avg,
      p95Ms: p95,
      worstMs: f[f.length - 1] || 0,
      draws: a.renderer.stats.drawCalls,
      tris: a.renderer.stats.tris,
      instances: a.renderer.stats.instances,
      units: a.game.units.length,
      buildings: a.game.buildings.length,
      quality: a.renderer.qualityName,
      glError: a.renderer.gl.getError(),
      simMs: a.game.stats?.tickMs ?? null,
      time: a.game.time
    };
  });

  // play a bit more with orders, pause and the end screen to be sure the flow works
  await page.evaluate(async () => {
    const a = window.__imperial;
    a.game.notify('Browser smoke test', 'good');
    a.ui.showEnd(true, 'smoke test');
    await new Promise((r) => setTimeout(r, 400));
    a.ui.togglePause();
  });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: join(OUT, '04-end.png') });

  results.errors = { console: consoleErrors.slice(0, 8), page: pageErrors.slice(0, 8) };

  expect(results.errors.page.length === 0, 'page errors: ' + results.errors.page.join(' | '));
  expect(results.errors.console.length === 0, 'console errors: ' + results.errors.console.join(' | '));
  expect(results.frame.draws > 15, `only ${results.frame.draws} draw calls`);
  expect(results.frame.tris > 5000, `only ${results.frame.tris} triangles`);
  expect(results.frame.glError === 0, 'gl.getError() = ' + results.frame.glError);
  expect(results.frame.fps > 10, `frame rate ${results.frame.fps.toFixed(1)} fps on SwiftShader`);
  expect(results.menuShotBytes > 20000, 'menu screenshot looks blank');
  expect(results.frame.time > 1, 'the simulation did not advance');
} catch (err) {
  fail.push('EXCEPTION: ' + (err && err.stack ? err.stack.split('\n')[0] : err));
  results.exception = String(err);
} finally {
  await browser.close();
  server.close();
}

const f = results.frame || {};
const md = [
  '### Browser smoke test',
  '',
  `- GPU: \`${results.gpu?.renderer || '?'}\` · ${results.gpu?.version || ''}`,
  `- Renderer: ${f.draws} draws · ${f.tris} tris · ${f.instances} instances · quality **${f.quality}**`,
  `- Frame: **${(f.fps || 0).toFixed(1)} fps** avg ${(f.avgMs || 0).toFixed(1)} ms · p95 ${(f.p95Ms || 0).toFixed(1)} ms · worst ${(f.worstMs || 0).toFixed(1)} ms (${f.samples} samples)`,
  `- World: ${f.units} units, ${f.buildings} buildings, game time ${(f.time || 0).toFixed(0)} s`,
  `- Console errors: ${results.errors?.console.length || 0} · page errors: ${results.errors?.page.length || 0}`,
  fail.length ? `\n**FAILURES**\n${fail.map((x) => '- ' + x).join('\n')}` : '\n**All browser checks passed.**'
].join('\n');

console.log(md);
await mkdir('ci', { recursive: true }).catch(() => {});
await writeFile('ci/browser-report.json', JSON.stringify({ results, fail }, null, 2)).catch(() => {});
await writeFile('ci/browser-report.md', md).catch(() => {});
process.exit(fail.length ? 1 : 0);
