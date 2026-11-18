/* What colour are the soldiers, in the actual game, on screen?

   rigshot.mjs is a CPU rasteriser: it never runs the unit shader, so it cannot
   answer this question. The Armory runs the shader but lights the pedestal its
   own way and pushes its own team colour. This suite boots the real game
   through the real menu, puts one of every class on the field, and measures
   the pixels the player would be looking at.

   It exists because the units shipped as white mannequins while three code
   renderers, a CPU rig preview and the Armory all looked fine. The causes were
   an instance push that hardcoded a white team tint, and a lighting sum twice
   as hot as the tone curve's white point. Neither is visible from a PNG of a
   rig and neither is visible to any suite that does not rasterise the game.

   node tests/unitcolour.mjs [--out ci/unitcolour]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/unitcolour'));
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(2); }
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  protocolTimeout: 300000,
  args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

let pass = 0, failures = 0;
const rows = [];
const check = async (name, fn) => {
  try {
    const d = await fn();
    pass++;
    rows.push({ ok: true, name, detail: d || '' });
    console.log(`  ok   ${name}${d ? '  — ' + d : ''}`);
  } catch (e) {
    failures++;
    rows.push({ ok: false, name, detail: (e && e.message) || 'failed' });
    console.log(`  FAIL ${name} — ${e && e.message}`);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') });
const frame = async (n = 4) => { for (let i = 0; i < n; i++) { await wait(90); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });
await page.click('.modeCard[data-mode="campaign"]').catch(() => {});
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.units.length > 5)', { timeout: 60000 });
await frame(10);

/* ---------------------------------------------------------- the harness --
   The canvas is drawn with preserveDrawingBuffer off, so anything read after
   the frame is black. That false green is exactly what let the white-mannequin
   bug survive every existing suite: readPixels returned zeroes and the
   assertion was written to pass on zeroes. Sample inside the render call.

   Sample the DIFFERENCE between a frame with the skinned-unit pass and the
   same frame without it. The measured pixels are then provably soldier: grass,
   roofs and shadow all cancel, and no screen-space box can pick up the
   background behind a figure. */
await page.evaluate(() => {
  const a = window.__imperial;
  const gl = a.renderer.gl;
  const p = a.__probe = { stage: 0, withU: null, withoutU: null, dim: null, output: null };

  const origDraw = a.renderer._drawRiggedUnits.bind(a.renderer);
  a.renderer._drawRiggedUnits = (cam, g) => { if (p.stage === 1) return; origDraw(cam, g); };

  const origRender = a.renderer.render.bind(a.renderer);
  a.renderer.render = (dt, game) => {
    origRender(dt, game);
    if (p.stage === 0 || p.stage === 1) {
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const buf = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      if (p.stage === 0) { p.withU = buf; p.dim = [W, H]; } else { p.withoutU = buf; }
      p.stage++;
    }
  };

  a.__probeFinish = () => {
    if (!p.withU || !p.withoutU) return null;
    const [W, H] = p.dim;
    const A = p.withU, B = p.withoutU;
    const pts = [];
    for (const u of a.game.units) {
      if (u.dead || u.gone) continue;
      const o = [0, 0, 0];
      a.camera.project(u.x, a.game.heightAt(u.x, u.z) + 0.7, u.z, o);
      if (o[2] > 1) continue;
      pts.push({ cls: u.cls || u.type, team: u.team,
        sx: (o[0] * 0.5 + 0.5) * W, sy: (o[1] * 0.5 + 0.5) * H });
    }
    const acc = new Map();
    let changed = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d < 30) continue;
        changed++;
        let best = null, bd = 1e9;
        for (const t of pts) {
          const dx = x - t.sx, dy = y - t.sy;
          const dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; best = t; }
        }
        if (!best || bd > 3600) continue;
        const key = best.cls + '#' + best.team;
        let e = acc.get(key);
        if (!e) { e = { cls: best.cls, team: best.team, n: 0, r: 0, g: 0, b: 0, hot: 0 }; acc.set(key, e); }
        e.n++; e.r += A[i]; e.g += A[i + 1]; e.b += A[i + 2];
        /* "white" here means bright AND colourless: the trash-can finish. */
        const mx = Math.max(A[i], A[i + 1], A[i + 2]), mn = Math.min(A[i], A[i + 1], A[i + 2]);
        if (mx > 205 && mx - mn < 34) e.hot++;
      }
    }
    const out = [];
    for (const e of acc.values()) {
      if (e.n < 40) continue;
      const mr = e.r / e.n, mg = e.g / e.n, mb = e.b / e.n;
      out.push({ cls: e.cls, team: e.team, px: e.n,
        mean: [Math.round(mr), Math.round(mg), Math.round(mb)],
        lum: +(0.2126 * mr + 0.7152 * mg + 0.0722 * mb).toFixed(1),
        sat: +(Math.max(mr, mg, mb) - Math.min(mr, mg, mb)).toFixed(1),
        white: +((e.hot / e.n) * 100).toFixed(1) });
    }
    out.sort((x, y) => y.px - x.px);
    p.output = { units: out, changed, dim: [W, H] };
    return p.output;
  };
});

/* --------------------------------------------- one of every class, on show --
   The starting army is nine villagers and a scout, which is not a survey. Put
   one of each class in a line, all on team 1, and photograph the row. */
const CLASSES = ['villager', 'spearman', 'archer', 'man_at_arms', 'knight', 'monk',
  'swordsman', 'skirmisher', 'axeman', 'huskarl', 'samurai', 'longbowman',
  'hand_cannoneer', 'cataphract', 'hero_general', 'scout_cavalry'];

const placed = await page.evaluate((keys) => {
  const a = window.__imperial, g = a.game;
  const live = g.units.filter((u) => !u.dead);
  if (!live.length) return 0;
  const ox = live[0].x, oz = live[0].z + 6;
  let n = 0;
  for (let i = 0; i < keys.length; i++) {
    /* reuse the sim's own units so death, HP bars and bones stay consistent */
    const u = live[i % live.length];
    u.type = keys[i]; u.cls = keys[i];
    u.team = 1; u.dead = false; u.gone = false;
    u.x = ox + (i % 8) * 1.9;
    u.z = oz + Math.floor(i / 8) * 2.2;
    u.facing = Math.PI; u.vx = 0; u.vz = 0;
    n++;
  }
  a.camera.setTarget(ox + 7, oz + 1.1, true);
  a.camera.desiredDist = 13; a.camera.dist = 13;
  a.camera.desiredPitch = 0.46; a.camera.pitch = 0.46;
  return n;
}, CLASSES);
await frame(16);
await shot('01-army-row');

const probe = await (async () => {
  await page.evaluate(() => { window.__imperial.__probe.stage = 0; });
  await frame(3);
  return page.evaluate(() => window.__imperial.__probeFinish());
})();
await shot('02-units-only');

const results = probe ? probe.units : [];
console.log(`\n  ${results.length} classes isolated from ${probe ? probe.changed : 0} changed pixels\n`);
console.log('  class            team  mean RGB          lum    sat   %white');
for (const r of results) {
  console.log(`  ${String(r.cls).padEnd(16)} ${r.team}    ${String(r.mean).padEnd(17)} ${String(r.lum).padEnd(6)} ${String(r.sat).padEnd(5)} ${r.white}`);
}
console.log('');

const names = results.map((r) => r.cls);
const detail = results.map((r) => `${r.cls} ${r.lum}/${r.sat}`).join('  ');

await check('every class renders something', () => {
  assert(results.length >= 10, `only ${results.length} classes had pixels: ${names.join(', ')}`);
  return `${results.length} classes`;
});

await check('no class is a white mannequin', () => {
  /* The bug the user reported, as a number. A pale-grey figure sat above 120
     luminance with almost no chroma; proper wool, mail and leather sit well
     below that and carry a hue. */
  const bad = results.filter((r) => r.white > 12);
  assert(bad.length === 0, bad.map((r) => `${r.cls} ${r.white}% white (${r.mean.join(',')})`).join('; '));
  return `worst ${Math.max(...results.map((r) => r.white))}% white`;
});

await check('the army is not one flat value', () => {
  /* A mannequin army also fails this: every figure the same tone. Real kit
     spans dark leather, mid mail and pale trim. */
  const lums = results.map((r) => r.lum);
  const spread = Math.max(...lums) - Math.min(...lums);
  assert(spread >= 45, `luminance spread only ${spread.toFixed(0)} (${detail})`);
  return `spread ${spread.toFixed(0)} between ${Math.min(...lums)} and ${Math.max(...lums)}`;
});

await check('team-1 cloth wears the player blue', () => {
  /* The instance push used to hardcode a (1,1,1) tint, and a neutral tint
     makes the shader skip the dye entirely. Any cloth that is meant to be
     team-coloured must therefore lean blue, not grey or sepia. */
  const blue = results.filter((r) => r.mean[2] > r.mean[0]);
  assert(blue.length >= Math.ceil(results.length * 0.4),
    `only ${blue.length}/${results.length} read blue-dominant: ${detail}`);
  return `${blue.length}/${results.length} blue-dominant`;
});

await check('no page errors while drawing the army', () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
});

await page.screenshot({ path: join(OUT, '99-final.png') });
await browser.close();
server.close();

const report = [
  '# Unit colour — what the player actually sees',
  '',
  `- checks: **${pass}** passed, **${failures}** failed`,
  `- screenshots: \`${OUT}\``,
  '',
  '| | check | result |',
  '| - | ----- | ------ |',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail} |`),
  '',
  '| class | mean RGB | luminance | chroma | % white |',
  '| ----- | -------- | --------- | ------ | ------- |',
  ...results.map((r) => `| ${r.cls} | ${r.mean.join(', ')} | ${r.lum} | ${r.sat} | ${r.white} |`),
  '',
  failures === 0 ? `**UNITCOLOUR PASSED (${pass})**` : `**UNITCOLOUR FAILURES (${failures})**`,
  ''
].join('\n');
await mkdir('ci', { recursive: true }).catch(() => {});
await writeFile('ci/unitcolour-report.md', report).catch(() => {});
console.log(failures === 0 ? `UNITCOLOUR PASSED (${pass})` : `UNITCOLOUR FAILURES (${failures})`);
process.exit(failures === 0 ? 0 : 1);
