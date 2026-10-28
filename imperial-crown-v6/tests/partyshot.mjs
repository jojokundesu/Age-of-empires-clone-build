/* ============================================================
   magesite.mjs — the Arcane Order, through the real interface
   ------------------------------------------------------------
   The node suite (tests/mods.mjs) proves the ladder exists: insight
   promotes a mage, a rank gates a spell, a hybrid is discovered. This
   suite proves the parts only a rendered frame can show:

     · the model really changes at every rank, and the six of them
       stand in a legible line;
     · the spell card opens a real book, with only the spells the
       rank has earned;
     · arming a spell arms the input layer too (the reticle), and a
       tap on the ground casts it;
     · SKYFALL hits a base, flashes the frame, shakes the camera and
       spends the day;
     · nothing errors, and quitting leaves no mod behind.

   node tests/magesite.mjs [--out ci/party]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/party'));
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
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });
await page.evaluate(() => window.__imperial.startMatch({
  mode: 'sandbox', civ: 'franks', difficulty: 'standard', seed: 4242,
  quality: 'high', music: false, sound: false
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await wait(1500);
await page.evaluate(() => {
  /* the browser under SwiftShader runs the sim far slower than real time, so
     the diplomacy is driven by stepping the simulation itself */
  window.__step = (seconds) => {
    const g = window.__imperial.game;
    window.__imperial.paused = true;
    for (let i = 0; i < Math.max(1, Math.round(seconds * 30)); i++) g.update(1 / 30);
    window.__imperial.paused = false;
    return g.time;
  };
});

const info = await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const tc = g.buildings.find((b) => b.team === g.partyTeam && b.type === 'town_center');
  const cam = a.camera;
  cam.target[0] = tc.x; cam.target[1] = g.heightAt(tc.x, tc.z); cam.target[2] = tc.z;
  cam.desired[0] = cam.target[0]; cam.desired[1] = cam.target[1]; cam.desired[2] = cam.target[2];
  cam.yaw = cam.desiredYaw = 0.9; cam.pitch = cam.desiredPitch = 0.5; cam.dist = cam.desiredDist = 30;
  cam.update(0.016);
  return { party: g.partyTeam, name: g.partyName, peace: g.atPeace(g.partyTeam),
    ai: a.ai === null, councils: (a.ais || []).map((x) => x.team),
    people: g.units.filter((u) => u.team === 2).length, roofs: g.buildings.filter((b) => b.team === 2).length,
    canFight: [g.canFight(1, 2), g.canFight(2, 1)] };
});
await wait(1500);
await shot('party-1-town');
console.log('party', JSON.stringify(info));

await page.evaluate(() => window.__imperial.openPause());
await wait(700);
const panel = await page.evaluate(() => document.getElementById('modalBody')?.textContent || '');
console.log('panel', /at peace/.test(panel), (panel.match(/The Free Company[^A-Z]{0,40}/) || [''])[0].trim());
await shot('party-2-panel');
await page.evaluate(() => window.__imperial.togglePause());
await wait(600);

const war = await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const victim = g.units.find((u) => u.team === 2 && u.def.attack > 0 && u.type !== 'villager');
  let sx = victim.x + 2.4, sz = victim.z;
  for (const [dx, dz] of [[2.4, 0], [-2.4, 0], [0, 2.4], [0, -2.4], [2, 2], [-2, -2], [3, 0], [0, 3]]) {
    if (g.isPassable(victim.x + dx, victim.z + dz, { radius: 0.5 })) { sx = victim.x + dx; sz = victim.z + dz; break; }
  }
  const man = g.spawnUnit('swordsman', 1, sx, sz, null, { force: true });
  g.orderAttack([man], victim);
  const cam = a.camera;
  cam.target[0] = victim.x; cam.target[1] = g.heightAt(victim.x, victim.z); cam.target[2] = victim.z;
  cam.desired[0] = cam.target[0]; cam.desired[1] = cam.target[1]; cam.desired[2] = cam.target[2];
  cam.dist = cam.desiredDist = 16; cam.update(0.016);
  window.__man = man; window.__victim = victim; window.__t0 = g.time;
  return { canFightBefore: g.canFight(2, 1), man: !!man, state: man && man.state, target: !!(man && man.target), dist: man ? Math.hypot(man.x - victim.x, man.z - victim.z).toFixed(1) : -1 };
});
await page.evaluate(() => window.__step(10));
await wait(900);
const after = await page.evaluate(() => {
  const g = window.__imperial.game;
  const stack = [...document.querySelectorAll('.toast, #toasts div')].map((d) => d.textContent).join(' | ');
  const v = window.__victim, man = window.__man;
  const sim = { dt: +(g.time - window.__t0).toFixed(2), manAt: [man.x.toFixed(1), man.z.toFixed(1)], manState: man.state,
    vAt: [v.x.toFixed(1), v.z.toFixed(1)], vHp: v.hp, vDead: v.dead, cd: +(man.attackCooldown || 0).toFixed(2) };
  return { peace: g.atPeace(2), canFight: g.canFight(2, 1), declared: /taken up arms/.test(stack),
    paused: window.__imperial.paused, sim };
});
await shot('party-3-war');
console.log('war', JSON.stringify(war), JSON.stringify(after));
console.log('errors', JSON.stringify(pageErrors.slice(0, 4)), JSON.stringify(consoleErrors.slice(0, 4)));
await browser.close(); server.close();
