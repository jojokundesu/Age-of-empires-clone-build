/* Real-browser check for the Armory, and screenshots of the pedestal.

   The mock WebGL used by the other suites proves the code paths run, but it
   cannot prove the shaders link on a real driver or that the palette
   texture samples correctly. This drives a real Chromium with SwiftShader,
   opens the Armory, cycles through classes, ages and poses, and writes
   PNGs.

   Run: npm run build && node scripts/armoryshot.mjs
*/
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const root = resolve('dist');
const out = resolve('ci/armory');
await mkdir(out, { recursive: true });

const mime = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(root, rel === '/' ? 'index.html' : rel);
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let browser;
const errors = [];
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
};

try {
  browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
    protocolTimeout: 180000,
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('!document.getElementById("menuScreen").classList.contains("hidden")', { timeout: 120000 });

  await page.click('#btnArmory');
  await page.waitForSelector('.armoryCanvas', { timeout: 60000 });
  /* Let the render loop settle, then wait for the context to be live. */
  await new Promise((r) => setTimeout(r, 1500));

  const info = await page.evaluate(() => {
    const c = document.querySelector('.armoryCanvas');
    const gl = c && c.getContext('webgl2');
    return {
      w: c ? c.width : 0,
      h: c ? c.height : 0,
      hasGL: !!gl,
      error: gl ? gl.getError() : -1,
      chips: document.querySelectorAll('.armChip').length
    };
  });
  check('the pedestal canvas exists and is sized', () => {
    if (!info.w || !info.h) throw new Error(`canvas is ${info.w}x${info.h}`);
  });
  check('it has a live WebGL2 context', () => {
    if (!info.hasGL) throw new Error('no webgl2 context');
    if (info.error !== 0) throw new Error('gl.getError() = ' + info.error);
  });
  check('the controls are rendered', () => {
    if (info.chips < 25) throw new Error(`only ${info.chips} chips`);
  });

  /* Is anything actually drawn? Read the pixels back: a shader that failed to
     link leaves a uniformly black canvas, which a screenshot will not tell
     apart from a dark backdrop. */
  /* readPixels has to happen in the same task as the draw: the context is
     created without preserveDrawingBuffer, so a snapshot afterwards reads a
     buffer the compositor has already swapped away. Stop the loop and draw
     once by hand. */
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.armoryCanvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, reason: 'no context' };
    window.__imperialArmory?.stop();
    window.__imperialArmory?._draw();
    const px = new Uint8Array(4 * c.width * c.height);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let min = 765, max = 0; const distinct = new Set();
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i] + px[i + 1] + px[i + 2];
      if (v < min) min = v;
      if (v > max) max = v;
      distinct.add((px[i] >> 3 << 10) | (px[i + 1] >> 3 << 5) | (px[i + 2] >> 3));
    }
    return { ok: true, min, max, distinct: distinct.size };
  });
  check('the shaders linked and the unit is painted', () => {
    if (!painted.ok) throw new Error(painted.reason);
    if (painted.distinct < 8) throw new Error(`only ${painted.distinct} distinct colours — nothing drawn`);
    if (painted.max === painted.min) throw new Error('the centre is a flat colour');
  });

  await page.evaluate(() => window.__imperialArmory?.start());
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(out, 'armory-man-at-arms.png') });

  /* Cycle a few classes and ages, screenshotting the interesting ones. */
  const shots = [
    ['villager', 1, 'idle', 'armory-villager-age1.png'],
    ['archer', 1, 'idle', 'armory-archer-age1.png'],
    ['knight', 4, 'idle', 'armory-knight-age4.png'],
    ['hero_general', 4, 'idle', 'armory-hero-age4.png'],
    ['monk', 3, 'idle', 'armory-monk.png'],
    ['man_at_arms', 3, 'walk', 'armory-walk.png'],
    ['man_at_arms', 3, 'attack', 'armory-attack.png']
  ];
  for (const [cls, age, pose, file] of shots) {
    await page.evaluate((c, a, p) => {
      const q = (sel) => document.querySelector(sel);
      q(`.armChip[data-cls="${c}"]`)?.click();
      q(`.armChip[data-age="${a}"]`)?.click();
      q(`.armChip[data-pose="${p}"]`)?.click();
    }, cls, age, pose);
    await new Promise((r) => setTimeout(r, 900));
    await page.screenshot({ path: join(out, file) });
    console.log('  shot ' + file);
  }

  const state = await page.evaluate(() => {
    const c = document.querySelector('.armoryCanvas');
    const gl = c.getContext('webgl2');
    return { error: gl ? gl.getError() : -1 };
  });
  check('no GL error after cycling every state', () => {
    if (state.error !== 0) throw new Error('gl.getError() = ' + state.error);
  });

  /* Touch: drag to orbit must change the yaw. */
  const box = await page.evaluate(() => {
    const r = document.querySelector('.armoryCanvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const before = await page.evaluate(() => window.__imperialArmory?.yaw);
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.5 + 120, box.y + box.h * 0.5, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const after = await page.evaluate(() => window.__imperialArmory?.yaw);
  if (before !== undefined && after !== undefined) {
    check('dragging orbits the pedestal', () => {
      if (Math.abs(after - before) < 0.05) throw new Error('yaw did not change');
    });
  }

  check('no page errors while the Armory was open', () => {
    const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
    if (real.length) throw new Error(real.slice(0, 3).join(' | '));
  });
} catch (e) {
  failed++;
  console.error('  FAIL (fatal) ' + (e.stack || e));
  if (errors.length) console.error('  page errors:\n   ' + errors.slice(0, 6).join('\n   '));
} finally {
  await browser?.close();
  server.close();
}

console.log(failed ? `\n${failed} armory check(s) failed` : '\nARMORY CHECKS PASSED');
console.log(`screenshots in ${out}`);
process.exitCode = failed ? 1 : 0;
