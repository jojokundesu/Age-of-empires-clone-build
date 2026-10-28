/* ============================================================
   moralesite.mjs — morale, supply and veterans through the real HUD
   ------------------------------------------------------------
   tests/morale.mjs proves the simulation. This one proves the parts
   only a rendered frame, a real tap and the real inspector can show:

     · the inspector reports morale and the rank chevrons are drawn;
     · a supply tent covers a man, and draws its net when selected;
     · a broken unit is labelled, lamps red, and refuses a real tap;
     · a veteran wears his chevrons and his rank in the inspector;
     · a Marshal of rank II covers his men with his aura.

   node tests/moralesite.mjs [--out ci/v4-morale]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-morale'));
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
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

let pass = 0, failures = 0;
const results = [];
const check = async (name, fn) => {
  try {
    const d = await fn();
    pass++;
    console.log(`  ok   ${name}${d ? '  — ' + d : ''}`);
    results.push({ name, ok: true, detail: d });
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name} — ${e && e.message}`);
    results.push({ name, ok: false, detail: e && e.message });
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') });
const frame = async (n = 3) => { for (let i = 0; i < n; i++) { await wait(80); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

await page.evaluate(() => {
  window.__stepSim = (seconds) => {
    const a = window.__imperial;
    if (!a || !a.game) return 0;
    const step = 1 / 30;
    const n = Math.max(1, Math.round(seconds / step));
    for (let i = 0; i < n; i++) a.game.update(step);
    return a.game.time;
  };
  window.__look = (x, z, dist = 18, pitch = 0.42, yaw = 0.4) => {
    const cam = window.__imperial.camera;
    cam.target[0] = x; cam.target[1] = window.__imperial.game.heightAt(x, z); cam.target[2] = z;
    cam.desired[0] = cam.target[0]; cam.desired[1] = cam.target[1]; cam.desired[2] = cam.target[2];
    cam.yaw = cam.desiredYaw = yaw;
    cam.pitch = cam.desiredPitch = pitch;
    cam.dist = cam.desiredDist = dist;
    cam.update(0.016);
  };
  window.__screenOf = (u) => {
    const a = window.__imperial;
    const out = a.camera.project(u.x, u.y + 0.9, u.z, [0, 0, 0]);
    return [Math.round((out[0] * 0.5 + 0.5) * window.innerWidth), Math.round((0.5 - out[1] * 0.5) * window.innerHeight)];
  };
  window.__spawnAt = (type, team, x, z) => {
    const g = window.__imperial.game;
    const spot = g.freeSpotNear(x, z, { radius: 0.5, def: {} }, 10) || [x, z];
    const u = g.spawnUnitRaw(type, team, spot[0], spot[1]);
    if (u) { g.spatial.clear(); g.spatial.insertAll(g.units); }
    return u ? u.id : null;
  };
  window.__unit = (id) => window.__imperial.game.units.find((u) => u.id === id) || null;
});

await page.evaluate(() => window.__imperial.startMatch({
  mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 909,
  quality: 'medium', music: false, sound: false
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.morale)', { timeout: 60000 });

/* ------------------------------------------------------------------ 1 */
await check('the inspector reports morale on a soldier', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    const id = window.__spawnAt('spearman', 1, b.x + 8, b.z + 6);
    window.__stepSim(1);
    const u = window.__unit(id);
    g.selection = [u];
    a.ui.updateInspector();
    return { id, morale: u.morale, fed: u.fed, text: document.getElementById('inspStats')?.innerHTML || '' };
  });
  assert(st.text.includes('morale'), 'the inspector does not show morale: ' + st.text);
  assert(st.text.includes('#i-flag'), 'the morale flag is not the game sprite: ' + st.text);
  assert(Math.round(st.morale) === 100, 'a soldier beside his town should be at full morale: ' + st.morale);
  assert(st.fed === true, 'he should be inside the supply net');
  return `flag ${Math.round(st.morale)} in supply`;
});

/* ------------------------------------------------------------------ 2 */
await check('a supply tent covers a unit and draws its net when selected', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    const id = window.__spawnAt('swordsman', 1, b.x + 52, b.z + 10);
    window.__stepSim(0.4);
    const u = window.__unit(id);
    const before = g.morale.inSupply(u);
    const spot = g.freeSpotNear(u.x - 6, u.z - 6, { radius: 1.2, def: { size: 2.4 } }, 8) || [u.x - 6, u.z - 6];
    const tent = g.placeBuilding('supply_tent', 1, spot[0], spot[1], { instant: true, free: true });
    window.__stepSim(2);
    const after = g.morale.inSupply(u);
    g.selection = [tent];
    a.ui.updateInspector();
    window.__look(tent.x, tent.z, 20, 0.5, 0.4);
    return { before, after, supply: tent.def.supply };
  });
  assert(st.before === false, 'the test spot must start outside the net');
  assert(st.after === true, 'the tent did not extend the supply net');
  await frame(4);
  await shot('01-supply-net');
  return `${st.supply} m net`;
});

/* ------------------------------------------------------------------ 3 */
await check('a broken unit is labelled, and runs home', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    const id = window.__spawnAt('swordsman', 1, b.x + 56, b.z + 6);
    window.__stepSim(0.5);
    const u = window.__unit(id);
    u.morale = 3;
    window.__stepSim(1.5);
    g.selection = [u];
    a.ui.updateInspector();
    window.__look(u.x, u.z, 17, 0.38, 0.5);
    const d0 = Math.hypot(u.x - b.x, u.z - b.z);
    return { id, state: u.state, sub: document.getElementById('inspSub')?.textContent || '', d0 };
  });
  assert(st.state === 'rout', 'the unit did not break: ' + st.state);
  assert(/Falling back/.test(st.sub), 'the inspector does not say he is falling back: ' + st.sub);
  await frame(4);
  await shot('02-rout');
  const moved = await page.evaluate((id) => {
    window.__stepSim(6);
    const a = window.__imperial, u = window.__unit(id);
    return Math.hypot(u.x - a.game.playerBase.x, u.z - a.game.playerBase.z);
  }, st.id);
  assert(moved < st.d0 - 2, `he did not run home (${st.d0.toFixed(1)} → ${moved.toFixed(1)})`);
  return `${st.d0.toFixed(0)} m → ${moved.toFixed(0)} m`;
});

/* ------------------------------------------------------------------ 4 */
await check('a real tap on the ground does not move a broken man', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    const id = window.__spawnAt('swordsman', 1, b.x + 56, b.z + 14);
    window.__stepSim(0.5);
    const u = window.__unit(id);
    u.morale = 2;
    window.__stepSim(1.2);
    g.selection = [u];
    a.ui.updateInspector();
    window.__look(u.x, u.z, 26, 0.55, 0.4);
    return { id, state: u.state };
  });
  assert(st.state === 'rout', 'the man must be broken for this check');
  await frame(2);
  const target = await page.evaluate(() => {
    const cam = window.__imperial.camera;
    const g = window.__imperial.game;
    const x = g.playerBase.x + 40, z = g.playerBase.z + 30;
    const p = cam.project(x, g.heightAt(x, z), z, [0, 0, 0]);
    return { px: Math.round((p[0] * 0.5 + 0.5) * window.innerWidth), py: Math.round((0.5 - p[1] * 0.5) * window.innerHeight) };
  });
  await page.evaluate((p) => window.__imperial.input.tap(p.px, p.py), target);
  const after = await page.evaluate((id) => {
    const u = window.__unit(id);
    return { state: u.state, toast: document.body.textContent || '' };
  }, st.id);
  assert(after.state === 'rout', 'the tap shook him out of the rout: ' + after.state);
  assert(/refuse/.test(after.toast), 'the player was not told why');
  return 'orders refused, with a message';
});

/* ------------------------------------------------------------------ 5 */
await check('a veteran wears his chevrons and his rank in the inspector', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    const id = window.__spawnAt('knight', 1, b.x + 10, b.z + 10);
    window.__stepSim(0.4);
    const u = window.__unit(id);
    g.veterancy.gain(u, 120, 'test');
    g.selection = [u];
    a.ui.updateInspector();
    window.__look(u.x, u.z, 13, 0.34, 0.6);
    return {
      rank: u.rank,
      sub: document.getElementById('inspSub')?.textContent || '',
      stats: document.getElementById('inspStats')?.innerHTML || ''
    };
  });
  assert(st.rank >= 1, 'the knight did not rank up: ' + st.rank);
  assert(/▴/.test(st.stats), 'no chevron in the inspector: ' + st.stats);
  assert(/Seasoned|Veteran|Elite/.test(st.sub), 'no rank name in the inspector: ' + st.sub);
  await frame(4);
  await shot('03-veteran');
  return `rank ${st.rank}`;
});

/* ------------------------------------------------------------------ 6 */
await check('an officer of rank II extends supply to his men', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const b = g.playerBase;
    const kid = window.__spawnAt('knight', 1, b.x + 50, b.z - 6);
    const sid = window.__spawnAt('spearman', 1, b.x + 54, b.z - 6);
    window.__stepSim(0.4);
    const k = window.__unit(kid), s = window.__unit(sid);
    g.teams.get(1).age = 2;
    /* appoint() returns the office record, which holds the unit, which holds
       the game: never hand that to page.evaluate, it cannot be serialised */
    const ok = !!g.court.appoint(1, 'marshal', k).ok;
    g.court.deed(1, 'marshal', 60);
    const gr = g.court.rank(1, 'marshal');
    window.__stepSim(0.4);
    const fed = g.morale.inSupply(s);
    g.selection = [k, s];
    a.ui.updateInspector();
    window.__look(k.x, k.z, 16, 0.42, 0.5);
    return { ok, gr, fed };
  });
  assert(st.ok === true, 'the Marshal could not be appointed: ' + st.ok);
  assert(st.gr >= 2, 'the Marshal is not rank II: ' + st.gr);
  assert(st.fed === true, 'the Marshal does not count as supply');
  await frame(4);
  await shot('04-marshal-aura');
  return `rank ${st.gr} aura`;
});

/* ------------------------------------------------------------------ 7 */
await check('the Wheel of the Year shows in the top bar and reads out its rules', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    a.ui.updateText();
    const chip = document.getElementById('seasonChip');
    const cs = chip ? getComputedStyle(chip) : null;
    return {
      exists: !!chip,
      season: g.calendar ? g.calendar.season.key : null,
      dataSeason: chip ? chip.dataset.season : null,
      label: chip ? chip.querySelector('b').textContent : '',
      use: chip ? chip.querySelector('use').getAttribute('href') : '',
      title: chip ? chip.title : '',
      visible: cs ? cs.display !== 'none' : false
    };
  });
  assert(st.exists, 'no season chip in the top bar');
  assert(st.visible, 'the season chip is hidden');
  assert(st.dataSeason === st.season, `the chip says ${st.dataSeason}, the sim says ${st.season}`);
  assert(st.label.length > 2, 'the chip has no season name');
  assert(st.use.startsWith('#i-'), 'the chip has no icon');
  assert(/Food \d+%/.test(st.title) && /Omen:/.test(st.title), 'the tooltip does not spell out the rules: ' + st.title);
  return `${st.label} (${st.dataSeason})`;
});

await check('the season turns in the HUD when the wheel turns', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const before = g.calendar.season.key;
    /* jump the wheel to the last tenth of a second of the season */
    g.calendar.t = g.calendar.seasonLength - 0.05;
    a.ui.updateText();
    window.__stepSim(0.4);
    a.ui.updateText();
    const chip = document.getElementById('seasonChip');
    return { before, after: g.calendar.season.key, chip: chip.dataset.season, title: chip.title };
  });
  assert(st.before !== st.after, `the wheel did not turn (${st.before})`);
  assert(st.chip === st.after, `the chip is stale: ${st.chip} vs ${st.after}`);
  return `${st.before} → ${st.after}`;
});

/* ------------------------------------------------------------------ 8 */
await check('nothing errored in the browser', async () => {
  const bad = consoleErrors.filter((t) => !/favicon|AudioContext|autoplay|Deprecation/i.test(t));
  assert(pageErrors.length === 0, 'page errors: ' + pageErrors.slice(0, 3).join(' | '));
  assert(bad.length === 0, 'console errors: ' + bad.slice(0, 3).join(' | '));
  return 'clean console';
});

await writeFile(join(OUT, 'report.md'), [
  '# Morale, supply and veterans — browser report',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  '',
  failures ? `**${failures} failure(s)**` : `**all ${pass} checks passed**`
].join('\n'));

await browser.close();
server.close();
console.log(`\n${failures ? `MORALE BROWSER CHECKS FAILED (${failures})` : `MORALE BROWSER CHECKS PASSED (${pass})`} — shots in ${OUT}`);
process.exit(failures ? 1 : 0);
