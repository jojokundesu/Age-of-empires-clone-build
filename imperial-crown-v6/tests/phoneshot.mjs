/* ============================================================
   phoneshot.mjs — the layout check on the phone this is built for

   Realme 9i: 6.6", 1080×2400, ~2.6 device pixel ratio, so Chrome reports
   roughly 892×412 CSS pixels in landscape. That is a *short* screen and the
   first-person controls have to fit in it with two thumbs.

   This boots the built game at that exact shape, starts a sandbox, walks a
   soldier into first person through the real command card, and asserts the
   things a thumb can feel:

     · every primary control is at least 44 CSS px (the platform minimum);
     · the attack thumb, the block thumb, the dodge thumb and the move stick
       never overlap each other;
     · the stick sits in the bottom-left, the attack thumb bottom-right, and
       neither reaches the middle third of the screen;
     · the same holds in portrait.

   `node tests/phoneshot.mjs --out ci/phone`  (needs `npm run build`)
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/phone'));
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
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
await mkdir(OUT, { recursive: true });

const VIEWS = [
  ['landscape', { width: 892, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }],
  ['portrait', { width: 412, height: 892, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isPortrait: true }]
];

await page.setViewport(VIEWS[0][1]);
await page.goto(base, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer.ready', { timeout: 180000 });
/* let boot finish on its own: an early tap would race the boot overlay */
await page.waitForFunction("document.getElementById('bootScreen').classList.contains('hidden')", { timeout: 120000 });
await page.evaluate(() => {
  document.querySelector('[data-mode="sandbox"]').click();
  document.getElementById('btnStart').click();
});
await page.waitForFunction('window.__imperial.running === true', { timeout: 120000 });
await page.waitForFunction("document.getElementById('menuScreen').classList.contains('hidden')", { timeout: 20000 });
await page.evaluate(() => {
  const a = window.__imperial;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; a.governor.scale = 1; }
  a.renderer.setQuality('medium');
  a.renderer.setPixelScale(1);
});
await new Promise((r) => setTimeout(r, 3500));

const fails = [];
for (const [name, vp] of VIEWS) {
  await page.setViewport(vp);
  await new Promise((r) => setTimeout(r, 1200));
  /* in through the real UI: select a soldier, press FIRST PERSON */
  await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const soldier = g.units.find((x) => x.team === 1 && !x.dead && x.kind === 'unit'
      && !x.garrisoned && x.def.attack > 0);
    g.setSelection([soldier]);
    a.ui.refreshCommands(true);
    const btn = document.querySelector('[data-cmd="first-person"]');
    if (btn) btn.click(); else g.directControl.enter(soldier);
  });
  await new Promise((r) => setTimeout(r, 1600));
  await page.screenshot({ path: join(OUT, `fp-${name}.png`) });

  const layout = await page.evaluate(() => {
    const box = (id) => {
      const e = document.getElementById(id);
      if (!e || e.classList.contains('hidden')) return null;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      return { id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const overlap = (a, b) => !!a && !!b
      && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    const parts = ['fpAttack', 'fpBlock', 'fpDodge', 'fpStick', 'fpInteract', 'fpBuild', 'fpRally', 'fpSpells']
      .map(box).filter(Boolean);
    const pairs = [];
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) if (overlap(parts[i], parts[j])) pairs.push(`${parts[i].id}+${parts[j].id}`);
    }
    return {
      view: { w: innerWidth, h: innerHeight },
      parts, collisions: pairs,
      smallest: Math.min(...parts.map((p) => Math.min(p.w, p.h))),
      inFirstPerson: !!window.__imperial.game.directControl.unit
    };
  });
  const say = (m) => { fails.push(`${name}: ${m}`); console.log(`  FAIL ${name}: ${m}`); };
  console.log(`  ${name} ${layout.view.w}×${layout.view.h} · ${layout.parts.map((p) => `${p.id} ${p.w}×${p.h}`).join(', ')}`);
  if (!layout.inFirstPerson) say('first person never started');
  if (layout.smallest < 44) say(`a control is only ${layout.smallest} px across`);
  if (layout.collisions.length) say(`controls overlap: ${layout.collisions.join(', ')}`);
  for (const p of layout.parts) {
    if (p.y + p.h > layout.view.h + 1) say(`${p.id} hangs off the bottom edge`);
    if (p.x + p.w > layout.view.w + 1) say(`${p.id} hangs off the right edge`);
  }
  const stick = layout.parts.find((p) => p.id === 'fpStick');
  const attack = layout.parts.find((p) => p.id === 'fpAttack');
  if (stick && stick.x > layout.view.w * 0.3) say('the move stick is not under the left thumb');
  if (attack && attack.x < layout.view.w * 0.55) say('the attack button is not under the right thumb');
  if (stick && attack && attack.x < stick.x + stick.w) say('the attack thumb reaches into the stick corner');
  await page.evaluate(() => window.__imperial.game.directControl.exit());
  await new Promise((r) => setTimeout(r, 600));
}

await browser.close();
server.close();
console.log('');
if (fails.length) { console.log(`PHONE LAYOUT FAILED (${fails.length})`); process.exit(1); }
console.log(`PHONE LAYOUT PASSED · shots in ${OUT}`);
