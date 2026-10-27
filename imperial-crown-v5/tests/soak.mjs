/* Phone soak test: the thing the first build of this game could not do.

   Boots the production bundle in headless Chrome with the flags a leak would
   show up under (exposed GC), starts a match, spawns a 260-entity battle and
   runs it for a while while sampling:

     • page errors / console errors           -> crashes, bad uniforms, GL spam
     • JS heap after forced GC                -> leaks (geometry, materials, DOM)
     • frame prep, draw calls, triangles      -> batching and draw-call budget
     • simulation tick time                   -> the "it hangs" complaint
     • queued DOM work / toasts               -> the old innerHTML thrash

   The frame rate itself is a SwiftShader artefact here (a few fps), so the
   pass/fail bars are CPU-side budgets and heap growth, not fps.

   Usage: node tests/soak.mjs [--seconds 25] [--units 260]              */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SECONDS = Number(argOf('seconds', 40));
const UNITS = Number(argOf('units', 260));
const TIER = argOf('quality', 'medium');
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/ not found — run `npm run build` first');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

async function findChrome() {
  if (process.env.CHROME_PATH) return { exe: process.env.CHROME_PATH, args: [] };
  const system = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'].find((p) => existsSync(p));
  if (system) return { exe: system, args: [] };
  const mod = await import('@sparticuz/chromium');
  const chromium = mod.default ?? mod;
  return { exe: await chromium.executablePath(), args: chromium.args };
}

const chrome = await findChrome();
const browser = await puppeteer.launch({
  executablePath: chrome.exe,
  headless: true,
  protocolTimeout: 300000,
  args: [
    ...chrome.args,
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars',
    // expose gc() so "did the heap grow" measures retained memory, not garbage
    '--js-flags=--expose-gc'
  ]
});

const page = await browser.newPage();
// Realme 9i class: 900x414 CSS at dpr 2, touch, mobile Chrome
await page.setViewport({ width: 900, height: 414, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e).slice(0, 300)));

const fails = [];
const check = (cond, msg) => {
  if (cond) { console.log('  ok   ' + msg); return; }
  fails.push(msg);
  console.log('  FAIL ' + msg);
};

await mkdir('ci', { recursive: true }).catch(() => {});
let md = '### Soak test\n\nRUNNING\n';
const writeReport = (s) => writeFile('ci/soak-report.md', s).catch(() => {});
await writeReport(md);

try {
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 180000 });
  await page.evaluate(() => { const a = window.__imperial; a.menu && a.menu.pickMode && a.menu.pickMode('sandbox'); });
  await page.waitForSelector('#menuScreen:not(.hidden)', { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 120000 });
  console.log('  match started');

  /* The tier the target phone will actually run: 'medium' is what the governor
     picks for an Adreno 610. Soaking at 'low' proved nothing about the build
     people install, so the tier is a flag and the phone default is the default.
     The governor itself is frozen here -- a soak has to measure one setting,
     not chase a moving one. */
  await page.evaluate((tier) => {
    const a = window.__imperial;
    a.renderer.setQuality(tier);
    a.renderer.setPixelScale(1);
    if (a.governor) a.governor.enabled = false;
    a.settings.quality = tier;
    a.settings.autoQuality = false;
    window.__soak = { frames: [], gcs: [], pops: [] };
    const loop = a.loop.bind(a);
    let last = performance.now();
    a.loop = (t) => {
      const now = performance.now();
      window.__soak.frames.push(now - last);
      last = now;
      return loop(t);
    };
  }, TIER);
  await new Promise((r) => setTimeout(r, 2500));

  // spawn a real battle: two armies facing each other across the map centre
  const spawned = await page.evaluate((n) => {
    const a = window.__imperial, g = a.game;
    const types = ['spearman', 'swordsman', 'archer', 'knight'];
    const cx = g.playerBase ? g.playerBase.x : 0;
    const cz = g.playerBase ? g.playerBase.z : 0;
    const armyA = [], armyB = [];
    let made = 0;
    for (let i = 0; i < n; i++) {
      const team = i % 2 === 0 ? 1 : 2;
      const type = types[i % types.length];
      const rank = Math.floor(i / 2);
      const col = rank % 10, row = Math.floor(rank / 10);
      const x = cx + (team === 1 ? -11 : 11) + (col - 4.5) * 1.5;
      const z = cz + (row - 2) * 1.6;
      const u = g.spawnUnitRaw(type, team, x, z);
      if (!u) continue;
      made++;
      (team === 1 ? armyA : armyB).push(u);
    }
    // send them at each other: idle units would never close the gap
    if (g.orderAttackMove) {
      g.orderAttackMove(armyA, cx + 22, cz);
      g.orderAttackMove(armyB, cx - 22, cz);
    }
    return made;
  }, UNITS);
  console.log(`  spawned ${spawned} units`);
  check(spawned >= UNITS * 0.95, `only ${spawned}/${UNITS} units spawned`);

  // ---- live phase: the real frame loop must keep running, DOM must not grow --
  const live = [];
  for (let s = 0; s < Math.min(6, SECONDS); s++) {
    await new Promise((r) => setTimeout(r, 1000));
    const sample = await page.evaluate(() => {
      const a = window.__imperial;
      const st = a.renderer.stats;
      const f = window.__soak.frames;
      window.__soak.frames = [];
      f.sort((x, y) => x - y);
      return {
        nodes: document.getElementsByTagName('*').length,
        draws: st.drawCalls, tris: st.tris, instances: st.instances,
        units: a.game.units.filter((u) => !u.dead).length,
        time: a.game.time, frames: f.length,
        worst: f.length ? f[f.length - 1] : 0,
        errors: a.renderer.gl.getError()
      };
    });
    live.push(sample);
    process.stdout.write(`  live t+${s + 1}s  frames ${sample.frames}  units ${sample.units}  ` +
      `draws ${sample.draws}  tris ${sample.tris}  worst frame ${sample.worst.toFixed(0)}ms  gl ${sample.errors}\n`);
  }

  /* ---- battle phase: drive the simulation directly -------------------------
     Software GL renders at about 1 fps, which would make a wall-clock soak test
     measure the rasteriser instead of the game. Ticking the sim directly gives
     a real minute of combat in a couple of seconds and, because both batches do
     identical work, the difference in post-GC heap between them is retained
     memory — i.e. a leak. */
  const TICKS = Math.max(600, Math.round(SECONDS * 60));
  const battle = await page.evaluate((ticks) => {
    const a = window.__imperial, g = a.game;
    const heap = () => {
      if (window.gc) window.gc();
      return performance.memory ? performance.memory.usedJSHeapSize : 0;
    };
    const run = (n) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) g.update(1 / 60);
      return performance.now() - t0;
    };
    // corpses are spliced out of the unit list, so count deaths at the source
    let deaths = 0;
    const prevEvent = g.onEvent;
    g.onEvent = (name, data) => { if (name === 'death' || name === 'buildingDeath') deaths++; return prevEvent(name, data); };
    run(240);                       // warm up pools, queues and effect buffers
    const h0 = heap();
    const t1 = run(ticks);
    const h1 = heap();
    const t2 = run(ticks);
    const h2 = heap();
    const alive = g.units.filter((u) => !u.dead);
    const hpLost = alive.filter((u) => u.hp < u.maxHp).length;
    return {
      ticks, h0, h1, h2, ms1: t1, ms2: t2, time: g.time,
      alive: alive.length, deaths, hpLost,
      projectiles: g.projectiles ? g.projectiles.activeCount : -1,
      particles: g.fx ? g.fx.count : -1,
      buildings: g.buildings.length
    };
  }, TICKS);

  const msPerTick = battle.ms2 / battle.ticks;
  console.log(`  battle: ${battle.ticks * 2} ticks, ${battle.alive} alive / ${battle.deaths} killed, ` +
    `${battle.hpLost} damaged, heap ${(battle.h1 / 1e6).toFixed(1)} -> ${(battle.h2 / 1e6).toFixed(1)} MB, ` +
    `${msPerTick.toFixed(2)} ms/tick`);

  const first = live[0], lastSample = live[live.length - 1];

  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.slice(0, 3).join(' | '));
  check(consoleErrors.length === 0, 'no console errors: ' + consoleErrors.slice(0, 3).join(' | '));
  check(live.every((s) => s.errors === 0), 'no GL errors during the live phase');
  check(live.every((s) => s.frames > 0), 'the frame loop stopped');
  check(lastSample.time > first.time, 'the simulation did not advance while rendering');
  check(battle.time >= (battle.ticks * 2 / 60) * 0.8,
    `only ${battle.time.toFixed(0)} s of game time for ${battle.ticks * 2} ticks`);
  check(battle.deaths > 5, `the two armies barely fought (${battle.deaths} deaths, ${battle.hpLost} damaged)`);
  check(msPerTick < 3.0, `simulation tick is ${msPerTick.toFixed(2)} ms (budget 3.0)`);
  // leak: identical second batch must not retain another budget's worth of memory
  check(battle.h2 - battle.h1 < 6e6,
    `heap grew ${((battle.h2 - battle.h1) / 1e6).toFixed(1)} MB over an identical workload (leak)`);
  check(battle.h2 < battle.h0 + 18e6,
    `heap grew from ${(battle.h0 / 1e6).toFixed(1)} to ${(battle.h2 / 1e6).toFixed(1)} MB`);
  check(battle.projectiles >= 0 && battle.projectiles <= 240,
    'projectile pool overflowed its 240 slots: ' + battle.projectiles);
  check(battle.particles <= 4000, 'particle pool is unbounded: ' + battle.particles);
  // DOM must not accumulate (the old build rebuilt #actions every 350 ms)
  check(lastSample.nodes <= first.nodes + 40, `DOM grew from ${first.nodes} to ${lastSample.nodes} nodes`);
  // batching: a phone cannot afford more than ~90 draws
  check(live.every((s) => s.draws <= 90), 'draw calls over budget: ' + live.map((s) => s.draws).join(','));
  check(live.every((s) => s.tris <= 260000), 'triangle count over budget: ' +
    Math.max(...live.map((s) => s.tris)));

  md = [
    '### Soak test (phone profile)',
    '',
    `- ${spawned} extra units · quality **${TIER}** · 900×414 @2x`,
    `- Battle: ${battle.ticks * 2} simulation ticks (${(battle.ticks * 2 / 60).toFixed(0)} s of game time), ` +
      `${battle.alive} alive / ${battle.deaths} killed, ${battle.hpLost} damaged`,
    `- Tick cost: **${msPerTick.toFixed(2)} ms** (budget 3.0)`,
    `- Heap after forced GC: ${(battle.h1 / 1e6).toFixed(1)} → ${(battle.h2 / 1e6).toFixed(1)} MB ` +
      `over an identical second batch`,
    `- Draw calls ${Math.min(...live.map((s) => s.draws))}–${Math.max(...live.map((s) => s.draws))} · ` +
      `triangles ${Math.min(...live.map((s) => s.tris))}–${Math.max(...live.map((s) => s.tris))} · ` +
      `DOM ${first.nodes}–${lastSample.nodes} nodes`,
    `- Errors: ${pageErrors.length} page · ${consoleErrors.length} console · GL ${live.filter((s) => s.errors).length} frames`,
    '',
    fails.length ? `**${fails.length} soak check(s) failed**\n${fails.map((f) => '- ' + f).join('\n')}`
      : '**Soak passed.**'
  ].join('\n');
  await writeReport(md);
  console.log('\n' + md);
} catch (err) {
  const msg = String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' ') : err);
  fails.push('EXCEPTION: ' + msg);
  await writeReport(`### Soak test\n\n**CRASHED**\n\n\`\`\`\n${msg}\n\`\`\`\n`);
  console.error('\nSOAK EXCEPTION: ' + msg);
} finally {
  await browser.close();
  server.close();
}

if (fails.length) { console.log(`\nSOAK FAILED (${fails.length})`); process.exit(1); }
console.log('\nSOAK PASSED');
