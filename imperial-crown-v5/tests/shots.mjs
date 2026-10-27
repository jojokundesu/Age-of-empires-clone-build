/* A gallery of the game as it actually looks, taken from a real browser.

   This is the eyes of the project. Every other suite asks "does the rule
   work"; this one asks "does it look like a game": a home town at noon, a
   four-crown war in progress, the build ring, the court, the sky at night,
   the end screen and a mod session. The pictures land in `ci/shots/` and are
   reviewed by a human (or by a model with eyes).

   It also fails loudly on the two things a screenshot cannot forgive: a
   black frame (nothing rendered) and a console full of errors.

   node tests/shots.mjs [--out ci/shots]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/shots'));
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(2); }
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
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
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

let pass = 0, failures = 0;
const check = async (name, fn) => {
  try {
    const d = await fn();
    pass++;
    console.log(`  ok   ${name}${d ? '  — ' + d : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name} — ${e && e.message}`);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Screenshot, and remember the bytes so a black frame can be caught. */
const shots = [];
/**
 * Screenshot, write it to disk, and measure how bright the picture actually
 * is. The measurement is taken from the PNG the browser produced, not from a
 * 2D copy of the canvas: the WebGL context does not preserve its drawing
 * buffer, so reading the canvas back gives a black rectangle even when the
 * screen is full of daylight.
 */
const shot = async (name) => {
  const b64 = await page.screenshot({ encoding: 'base64' });
  const buf = Buffer.from(b64, 'base64');
  await writeFile(join(OUT, name + '.png'), buf);
  const luma = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
    return sum / (d.length / 4);
  }, b64);
  shots.push({ name, bytes: buf.length, luma });
  return luma;
};
const frame = async (n = 6) => { for (let i = 0; i < n; i++) { await wait(90); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };
const lookAt = (x, z, dist) => page.evaluate((x, z, dist) => {
  const a = window.__imperial;
  const cam = a.camera;
  cam.target[0] = x;
  cam.target[1] = a.game.heightAt(x, z) + 0.6;
  cam.target[2] = z;
  if (dist) { cam.distance = dist; }
  if (cam.snap) cam.snap();
}, x, z, dist || 0);
/** Run the simulation forward without rendering, in one-second bites. */
const simulate = (seconds) => page.evaluate((seconds) => {
  const a = window.__imperial;
  const g = a.game;
  const ais = a.ais || [];
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) {
    g.update(1 / 30);
    /* the commander thinks while the world turns: the frame loop is blocked
       by this very call, so the AI has to be driven from in here too */
    if (i % 2 === 0) for (const ai of ais) ai.update(1 / 15);
  }
  return { time: Math.round(g.time), units: g.units.filter((u) => !u.dead).length, buildings: g.buildings.filter((b) => !b.dead).length };
}, seconds);

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

await check('the title screen is a picture, not a black rectangle', async () => {
  await frame(10);
  const luma = await shot('01-title');
  assert(luma > 12, `the canvas is nearly black (luma ${luma.toFixed(1)})`);
  return `luma ${luma.toFixed(1)}`;
});

/* ---------------------------------------------------------------- a war -- */
await page.evaluate(() => window.__imperial.startMatch({
  mode: 'kingdoms', civ: 'franks', difficulty: 'hard', seed: 4242, kingdoms: 4, victory: 'conquest'
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.units.length > 8)', { timeout: 60000 });
await frame(6);

await check('the home town reads as a home town', async () => {
  const at = await page.evaluate(() => {
    const b = window.__imperial.game.playerBase;
    return { x: b.x, z: b.z };
  });
  await lookAt(at.x, at.z, 46);
  await frame(8);
  const luma = await shot('02-home-town');
  assert(luma > 25, `the town is too dark to see (luma ${luma.toFixed(1)})`);
  return `luma ${luma.toFixed(1)}`;
});

await check('four crowns are on the map and told apart by colour', async () => {
  const st = await page.evaluate(() => {
    const g = window.__imperial.game;
    const teams = g.teamIds.map((t) => ({
      team: t,
      buildings: g.buildings.filter((b) => !b.dead && b.team === t).length,
      units: g.units.filter((u) => !u.dead && u.team === t).length
    }));
    return { teams, crowns: g.crowns };
  });
  assert(st.teams.length === 4, `expected four crowns, got ${st.teams.length}`);
  assert(st.teams.every((t) => t.buildings > 0), `a crown has no buildings: ${JSON.stringify(st.teams)}`);
  return st.teams.map((t) => `T${t.team} ${t.buildings}b/${t.units}u`).join(' ');
});

await check('all four crowns of the war are readable on the HUD', async () => {
  /* the strip used to sit at a fixed 48 px, which is inside the Age card in
     landscape: the fourth kingdom of a four-crown war was simply not drawn.
     Every pill has to be on screen and clear of the card. */
  await page.waitForFunction('!document.getElementById("crownStrip").classList.contains("hidden")', { timeout: 60000 });
  const st = await page.evaluate(() => {
    const strip = document.getElementById('crownStrip');
    const card = document.querySelector('.centerPanel').getBoundingClientRect();
    const pills = [...strip.querySelectorAll('.crown')].map((p) => {
      const r = p.getBoundingClientRect();
      const overlapCard = !(r.right < card.left || r.left > card.right || r.bottom < card.top || r.top > card.bottom);
      const onScreen = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      return { text: p.textContent.trim().replace(/\s+/g, ' '), overlapCard, onScreen, w: Math.round(r.width) };
    });
    return { pills, cardBottom: Math.round(card.bottom), stripTop: Math.round(strip.getBoundingClientRect().top) };
  });
  assert(st.pills.length === 4, `the HUD shows ${st.pills.length} crowns of four`);
  const bad = st.pills.filter((p) => p.overlapCard || !p.onScreen || p.w < 20);
  assert(bad.length === 0, `crowns are unreadable: ${JSON.stringify(bad)}`);
  assert(st.stripTop >= st.cardBottom - 1, `the crown strip starts at ${st.stripTop}, inside the card (${st.cardBottom})`);
  return st.pills.map((p) => p.text).join(' · ');
});

await check('a war in progress is photogenic', async () => {
  await simulate(430);
  /* find the hottest spot on the map: the two armies closest to each other */
  const hot = await page.evaluate(() => {
    const g = window.__imperial.game;
    const mil = g.units.filter((u) => !u.dead && u.def.attack > 0);
    let best = null, bestD = 1e9;
    for (const a of mil) {
      for (const b of mil) {
        if (a.team === b.team) continue;
        const d = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
        if (d < bestD) { bestD = d; best = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, d: Math.sqrt(d) }; }
      }
    }
    if (!best) {
      const b = g.baseOf(g.teamIds[1]);
      return { x: b.x, z: b.z, d: -1 };
    }
    return best;
  });
  await lookAt(hot.x, hot.z, 34);
  await frame(6);
  await shot('03-armies-in-the-field');
  return `scenes of war, nearest pair ${hot.d.toFixed(1)} m apart`;
});

await check('the build ring opens and draws its ghost', async () => {
  await page.evaluate(() => {
    const a = window.__imperial;
    const u = a.game.units.find((x) => !x.dead && x.team === 1 && x.type === 'villager');
    if (!u) throw new Error('the player has no villager to build with');
    a.game.setSelection([u]);
    a.ui.openBuildMenu([u]);
  });
  await frame(4);
  await shot('04-build-ring');
  const n = await page.evaluate(() => [...document.querySelectorAll('#cmdGrid .cmdBtn')]
    .filter((b) => b.style.display !== 'none').length);
  assert(n >= 8, `the build ring offered ${n} commands`);
  /* pick a house: the ring is not a menu unless its buttons actually arm a
     placement ghost on the ground */
  const armed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .find((b) => (b.querySelector('.lbl') || {}).textContent === 'House');
    if (!btn) return false;
    btn.click();
    return !!window.__imperial.game.placing;
  });
  assert(armed, 'tapping House did not arm a placement');
  await page.mouse.move(760, 430);
  await frame(4);
  await shot('04b-placement-ghost');
  await page.evaluate(() => { window.__imperial.game.placing = null; window.__imperial.ui.sig = ''; window.__imperial.ui.refreshCommands(); });
  return `${n} commands, ghost armed`;
});

await check('the court shows its four offices', async () => {
  await page.evaluate(() => window.__imperial.ui.openCourt());
  await frame(4);
  await shot('05-court');
  const rows = await page.evaluate(() => document.querySelectorAll('[data-office-row]').length);
  assert(rows >= 4, `the court listed ${rows} offices`);
  await page.evaluate(() => window.__imperial.menu.closeModal());
  return `${rows} offices`;
});

await check('the sky turns, and night is a different picture', async () => {
  await page.evaluate(() => {
    const a = window.__imperial;
    const b = a.game.playerBase;
    a.camera.target[0] = b.x; a.camera.target[2] = b.z;
    if (a.game.setWorldTime) a.game.setWorldTime(22.5);
    else a.game.worldTime = 22.5;
  });
  await frame(10);
  const luma = await shot('06-night');
  await page.evaluate(() => {
    const a = window.__imperial;
    if (a.game.setWorldTime) a.game.setWorldTime(9.0);
    else a.game.worldTime = 9.0;
  });
  await frame(4);
  assert(luma > 4, `night is pitch black (luma ${luma.toFixed(1)})`);
  return `night luma ${luma.toFixed(1)}`;
});

await check('the chronicle screen ends a war with a story', async () => {
  await page.evaluate(() => window.__imperial.game.endGame(true, 'conquest'));
  await frame(8);
  await shot('07-end-screen');
  const visible = await page.evaluate(() => {
    const el = document.getElementById('endScreen');
    return !!el && !el.classList.contains('hidden');
  });
  assert(visible, 'the end screen did not appear');
  return 'shown';
});

/* --------------------------------------------------------------- a mod -- */
await check('a mod session looks like its own thing', async () => {
  await page.evaluate(() => window.__imperial.startMatch({
    mode: 'mods', civ: 'franks', difficulty: 'sandbox', seed: 909, mods: ['arcane', 'undead']
  }));
  await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
  await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.modHost)', { timeout: 60000 });
  await simulate(10);
  const at = await page.evaluate(() => {
    const g = window.__imperial.game;
    const b = g.playerBase;
    return { x: b.x, z: b.z };
  });
  await lookAt(at.x, at.z, 40);
  await frame(8);
  await shot('08-mod-session');
  return 'arcane + undead';
});

await check('nothing errored in the browser', async () => {
  const errs = [...pageErrors, ...consoleErrors].filter((e) => !/favicon|AudioContext|autoplay/i.test(e));
  assert(errs.length === 0, errs.slice(0, 3).join(' | '));
  return 'clean console';
});

console.log('');
for (const s of shots) console.log(`  shot ${s.name.padEnd(26)} ${(s.bytes / 1024).toFixed(0).padStart(4)} kB  luma ${s.luma.toFixed(1)}`);
console.log('');
console.log(failures === 0
  ? `SHOT GALLERY PASSED (${pass}) — pictures in ${OUT}`
  : `SHOT GALLERY FAILURES (${failures}) — pictures in ${OUT}`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
