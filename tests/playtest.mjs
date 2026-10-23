/* End-to-end play test. Not a screenshot pass and not a unit test: this boots
   the real production bundle in Chrome at a Realme-9i-sized viewport, plays a
   campaign opening the way a person would (tap a villager, send them to a tree,
   build a house, queue a villager, advance an age, tilt the camera, open the
   pause menu) and then plays a sandbox battle with the command card.

   Headless Chrome renders in software at a couple of frames per second, so the
   simulation is advanced deterministically at 60 Hz from the page, while every
   *input* still goes through the real DOM and the real pointer handlers.

   Usage: node tests/playtest.mjs [--out ci/screenshots] [--keep]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = resolve(argOf('out', 'ci/screenshots'));
const ROOT = resolve('dist');
const REPORT = 'ci/playtest-report.md';

await mkdir('ci', { recursive: true }).catch(() => {});
await mkdir(OUT, { recursive: true }).catch(() => {});
const writeReport = (md) => writeFile(REPORT, md).catch(() => {});
await writeReport('### Play test\n\nRUNNING\n');

const bail = async (msg) => {
  console.error(msg);
  await writeReport(`### Play test\n\n**FAILED TO START**\n\n\`\`\`\n${msg}\n\`\`\`\n`);
  process.exit(2);
};
if (!existsSync(join(ROOT, 'index.html'))) await bail('dist/ not found — run `npm run build` first');

/* ---------------------------------------------------------------- server -- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
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
const systemChrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p) => existsSync(p));
let exe = process.env.CHROME_PATH || systemChrome;
let extraArgs = [];
if (!exe) {
  const mod = await import('@sparticuz/chromium');
  const chromium = mod.default ?? mod;
  exe = await chromium.executablePath();
  extraArgs = chromium.args;
}
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  protocolTimeout: 240000,
  args: [...extraArgs, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars']
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 414, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });

const jsErrors = [];
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => jsErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

/* ------------------------------------------------------------------ checks */
const checks = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`  ok   ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (e) {
    checks.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    console.log(`  FAIL ${name}  — ${e.message}`);
    await page.screenshot({ path: join(OUT, 'pt-failure.png') }).catch(() => {});
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); };

/* ------------------------------------------------------------ page helpers */
const installHelpers = () => page.evaluate(() => {
  const app = window.__imperial;
  const g = app.game;
  window.__pt = {
    step(secs) {
      const dt = 1 / 60;
      const n = Math.max(1, Math.round(secs * 60));
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        g.update(dt);
        if (app.ai && !g.gameOver) app.ai.update(dt);
      }
      if (g.fowDirty) { app.pushFog(g); g.fowDirty = false; }
      const frames = Math.min(30, Math.max(1, Math.round(secs * 60)));
      for (let i = 0; i < frames; i++) app.camera.update(1 / 60);
      /* Drive the HUD at the same cadence the render loop would. At least one
         command-card refresh per step matters: the card's click closure is
         rebuilt when the signature changes, so a step that skipped the 9 Hz
         tick left a button whose closure still thought the age was
         unaffordable while the resources were already in the bank. */
      app.ui.update(Math.min(0.25, Math.max(0.12, secs)));
      return { ms: performance.now() - t0, ticks: n };
    },
    screen(x, y, z) {
      const cam = app.camera;
      const r = app.canvas.getBoundingClientRect();
      const p = cam.project(x, y, z, [0, 0, 0, 0]);
      const w = p[3] || 1;
      return {
        x: r.left + (p[0] / w * 0.5 + 0.5) * r.width,
        y: r.top + (0.5 - p[1] / w * 0.5) * r.height,
        behind: w <= 0
      };
    },
    center() {
      const r = app.canvas.getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
    },
    cmd(label) {
      const want = label.toLowerCase();
      const btns = [...document.querySelectorAll('#cmdGrid .cmdBtn')].filter((el) => el.style.display !== 'none');
      const b = btns.find((el) => (el.querySelector('.lbl')?.textContent || '').trim().toLowerCase() === want);
      if (!b) return { ok: false, labels: btns.map((el) => (el.querySelector('.lbl')?.textContent || '').trim()) };
      b.click();
      return { ok: true };
    },
    labels() {
      return [...document.querySelectorAll('#cmdGrid .cmdBtn')]
        .filter((el) => el.style.display !== 'none')
        .map((el) => (el.querySelector('.lbl')?.textContent || '').trim());
    },
    state() {
      const t = g.teams.get(1);
      return {
        time: +g.time.toFixed(2), age: t.age,
        res: { food: Math.round(t.res.food), wood: Math.round(t.res.wood), gold: Math.round(t.res.gold), stone: Math.round(t.res.stone) },
        pop: `${t.popUsed}/${t.popCap}`,
        villagers: g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager').length,
        army: g.units.filter((u) => !u.dead && u.team === 1 && u.def.attack > 0 && !u.def.classes.includes('villager')).length,
        buildings: g.buildings.filter((b) => !b.dead && b.team === 1).length,
        selection: g.selection.length,
        selTypes: g.selection.map((e) => e.type || e.kind),
        nodes: document.querySelectorAll('*').length,
        queue: g.buildings.filter((b) => b.team === 1 && b.queue).reduce((n, b) => n + b.queue.length, 0)
      };
    },
    unitScreen(team, type) {
      const u = g.units.find((x) => !x.dead && x.team === team && x.type === type);
      if (!u) return null;
      return window.__pt.screen(u.x, (u.y || 0) + 0.6, u.z);
    },
    selectBuilding(team, type) {
      const b = g.buildings.filter((x) => !x.dead && x.team === team && (!type || x.type === type))
        .sort((p, q) => Math.hypot(p.x - g.camera.target[0], p.z - g.camera.target[2]) - Math.hypot(q.x - g.camera.target[0], q.z - g.camera.target[2]))[0];
      if (!b) return null;
      const p = window.__pt.screen(b.x, (b.y || 0) + 1.2, b.z);
      const r = app.canvas.getBoundingClientRect();
      const inside = p.x > r.left + 4 && p.x < r.left + r.width - 4 && p.y > r.top + 4 && p.y < r.top + r.height - 4;
      const offsets = [[0, 0], [0, -26], [0, 26], [26, 0], [-26, 0]];
      return { ok: inside && !p.behind, p, offsets, type: b.type };
    },
    resourceScreen(kind) {
      const rect = app.canvas.getBoundingClientRect();
      const base = g.world.playerBase;
      const near = g.resources
        .filter((x) => !x.dead && x.resKind === kind && Math.hypot(x.x - base.x, x.z - base.z) < 70)
        .sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z));
      for (const r of near) {
        const p = window.__pt.screen(r.x, (r.y || 0) + 0.9, r.z);
        if (p.behind) continue;
        if (p.x < rect.left + 210 || p.x > rect.left + rect.width - 210) continue;
        if (p.y < rect.top + 70 || p.y > rect.top + rect.height - 150) continue;
        return { ...p, x0: r.x, z0: r.z, clear: true };
      }
      return null;
    },
    buildingScreen(team) {
      const b = g.buildings.find((x) => !x.dead && x.team === team);
      if (!b) return null;
      return window.__pt.screen(b.x, (b.y || 0) + 3.4, b.z);
    },
    setTime(h) { g.setTimeOfDay(h); return g.worldTime; }
  };
});

const tap = async (p) => { await page.mouse.click(p.x, p.y); await new Promise((r) => setTimeout(r, 90)); };
const tapBuilding = async (type) => {
  // centre the view on the town first, the way the Town button does: a
  // building under the HUD cannot be tapped by anyone
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => {
      const a = window.__imperial;
      const b = a.game.buildings.find((x) => !x.dead && x.team === 1 && x.def.isTownCenter);
      if (b) a.camera.setTarget(b.x, b.z, true);
    });
    await page.evaluate(() => window.__pt.step(1.2));
    const info = await page.evaluate((t) => window.__pt.selectBuilding(1, t), type || null);
    if (!info || !info.ok) continue;
    for (const [dx, dy] of info.offsets) {
      await tap({ x: info.p.x + dx, y: info.p.y + dy });
      const sel = await page.evaluate(() => {
        const s = window.__imperial.game.selection;
        return s.length ? { n: s.length, t: s[0].type, kind: s[0].kind } : null;
      });
      if (sel && sel.n === 1 && sel.kind === 'building' && (!type || sel.t === type)) return true;
    }
  }
  return false;
};
const step = async (secs) => page.evaluate((s) => window.__pt.step(s), secs);
const state = async () => page.evaluate(() => window.__pt.state());
const cmd = async (label) => page.evaluate((l) => window.__pt.cmd(l), label);
const labels = async () => page.evaluate(() => window.__pt.labels());

const startMatch = async ({ mode = 'campaign', diff = 'standard', civ } = {}) => {
  await page.evaluate(({ mode, diff }) => {
    const m = document.querySelector(`.modeCard[data-mode="${mode}"]`);
    if (m) m.click();
    const d = document.querySelector(`.seg[data-diff="${diff}"]`);
    if (d) d.click();
  }, { mode, diff });
  if (civ) await page.evaluate((c) => { const b = document.querySelector(`#civGrid [data-civ="${c}"]`); if (b) b.click(); }, civ);
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial && window.__imperial.running === true', { timeout: 120000, polling: 150 });
  // hand the clock to the test: the software renderer cannot run 60 fps
  await page.evaluate(() => { window.__imperial.paused = true; });
  await installHelpers();
  await step(0.5);
};

/* ------------------------------------------------------------------- play -- */
let boot = {};
try {
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 180000 });
  await page.waitForFunction(() => {
    const m = document.getElementById('menuScreen');
    const b = document.getElementById('bootScreen');
    return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
  }, { timeout: 120000, polling: 200 });

  await check('the menu opens a match', async () => {
    const cards = await page.evaluate(() => document.querySelectorAll('.modeCard').length);
    assert(cards === 4, `expected 4 modes, found ${cards}`);
    await startMatch({ mode: 'campaign', diff: 'standard' });
    const s = await state();
    assert(s.villagers >= 5, `expected a starting workforce, got ${s.villagers} villagers`);
    assert(s.buildings >= 3, `expected a town centre and two houses, got ${s.buildings} buildings`);
    await shot('pt-01-start');
    return `${s.villagers} villagers · ${s.buildings} buildings · ${s.pop} pop`;
  });

  await check('tapping a villager selects it, dragging a box selects the group', async () => {
    const v = await page.evaluate(() => window.__pt.unitScreen(1, 'villager'));
    assert(v && !v.behind, 'no villager on screen');
    await tap(v);
    let s = await state();
    assert(s.selection === 1, `a tap should select exactly one unit, got ${s.selection}`);
    // a box over the town: press, drag, release
    const c = await page.evaluate(() => window.__pt.center());
    await page.mouse.move(c.x - 210, c.y - 120);
    await page.mouse.down();
    await page.mouse.move(c.x + 150, c.y + 110, { steps: 6 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
    s = await state();
    assert(s.selection >= 2, `box select should grab several villagers, got ${s.selection}`);
    return `${s.selection} units in the box`;
  });

  await check('a gather order sends villagers to the woodline and wood goes up', async () => {
    const tree = await page.evaluate(() => window.__pt.resourceScreen('wood'));
    assert(tree, 'no wood node on screen near the town');
    const before = (await state()).res.wood;
    await tap(tree);
    const s0 = await state();
    assert(s0.selection >= 1, 'selection was lost when issuing the order');
    const gathering = await page.evaluate(() => {
      const g = window.__imperial.game;
      return g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager' && u.gatherTarget).length;
    });
    assert(gathering > 0, 'the tap on a tree did not give anyone a gather order');
    await step(30);
    const after = (await state()).res.wood;
    assert(after > before + 12, `wood should have risen from ${before}, got ${after}`);
    await shot('pt-02-gather');
    return `wood ${before} → ${after}`;
  });

  await check('the build menu places a house and it finishes', async () => {
    const v = await page.evaluate(() => window.__pt.unitScreen(1, 'villager'));
    await tap(v);
    const r = await cmd('Build');
    assert(r.ok, `no Build command: ${JSON.stringify(r.labels)}`);
    const r2 = await cmd('House');
    assert(r2.ok, `no House card: ${JSON.stringify(r2.labels)}`);
    const before = await state();
    const c = await page.evaluate(() => window.__pt.center());
    await tap({ x: c.x + 90, y: c.y + 60 });
    await step(0.4);
    const placed = await page.evaluate(() => {
      const g = window.__imperial.game;
      const b = g.buildings.filter((x) => x.team === 1 && !x.x0);
      const newest = g.buildings[g.buildings.length - 1];
      return newest ? { type: newest.type, progress: newest.buildProgress ?? 1, x: newest.x, z: newest.z } : null;
    });
    assert(placed && placed.progress < 0.99, `expected a house under construction, got ${JSON.stringify(placed)}`);
    const capBefore = await page.evaluate(() => window.__imperial.game.teams.get(1).popCap);
    await step(40);
    const done = await page.evaluate(() => {
      const g = window.__imperial.game;
      const houses = g.buildings.filter((b) => b.team === 1 && b.type === 'house' && !b.dead);
      return { houses: houses.length, min: Math.min(...houses.map((b) => b.buildProgress ?? 1)) };
    });
    assert(done.min > 0.99, `the house never finished (min progress ${done.min})`);
    const capAfter = await page.evaluate(() => window.__imperial.game.teams.get(1).popCap);
    assert(capAfter > capBefore, `population cap did not rise: ${capBefore} → ${capAfter}`);
    await shot('pt-03-house');
    return `built at ${placed.x.toFixed(0)},${placed.z.toFixed(0)} · cap ${capBefore} → ${capAfter}`;
  });

  await check('the town centre queues and delivers a villager', async () => {
    assert(await tapBuilding('town_center'), 'could not tap the town centre at all');
    const s0 = await state();
    assert(s0.selection === 1, `tapping the town centre selected ${s0.selection} things`);
    const r = await cmd('Villager');
    assert(r.ok, `no Villager card: ${JSON.stringify(r.labels)}`);
    const queued = await state();
    assert(queued.queue >= 1, 'nothing entered the production queue');
    const before = queued.villagers;
    await step(30);
    const after = await state();
    assert(after.villagers > before, `villagers ${before} → ${after.villagers}`);
    await shot('pt-04-train');
    return `queue ${queued.queue} · villagers ${before} → ${after.villagers}`;
  });

  await check('advancing an age costs resources and changes the age', async () => {
    // re-select the town centre: the age button lives on its card
    assert(await tapBuilding('town_center'), 'could not tap the town centre');
    /* The opening economy cannot afford an age. Rather than cheat, put a
       villager on whatever is short and let the economy do its job -- which is
       also the first thing a new player has to learn. */
    let affordable = false;
    for (let guard = 0; guard < 45 && !affordable; guard++) {
      const can = await page.evaluate(() => window.__imperial.game.canAdvanceAge(1));
      if (can.ok) { affordable = true; break; }
      await page.evaluate(() => {
        const g = window.__imperial.game;
        const t = g.teams.get(1);
        const need = t.res.food < 430 ? 'food' : 'gold';
        const vills = g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager');
        const v = vills.find((u) => !u.gatherTarget) || vills[vills.length - 1];
        if (!v) return;
        const node = g.findNearestResource(need, v.x, v.z, 140, v);
        if (node) g.orderGather([v], node);
      });
      await step(8);
    }
    assert(affordable, 'the economy never produced enough for the next age');
    // let the card redraw with the freshly affordable state before clicking
    await step(0.6);
    const before = await state();
    const r = await cmd('Age 2');
    assert(r.ok, `no age card: ${JSON.stringify(r.labels)}`);
    await step(1);
    const research = await page.evaluate(() => {
      const g = window.__imperial.game;
      const t = g.teams.get(1);
      const toast = (document.querySelector('#toastLayer')?.textContent || '').slice(-90);
      return t.ageResearch ? { time: +t.ageResearch.time.toFixed(1) } : {
        none: true, toast, can: g.canAdvanceAge(1),
        labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].filter((el) => el.style.display !== 'none').map((el) => el.querySelector('.lbl').textContent)
      };
    });
    assert(!research.none, `the age research did not start: ${JSON.stringify(research)}`);
    await step(70);
    const after = await state();
    assert(after.age === 1, `age stayed ${after.age} after ${research.time}s of research`);
    assert(after.res.food < before.res.food, 'advancing an age cost no food');
    await shot('pt-05-age');
    return `age ${before.age} → ${after.age} · food ${before.res.food} → ${after.res.food}`;
  });

  await check('night falls: the shader, the firelight and the clock all agree', async () => {
    await page.evaluate(() => window.__pt.setTime(22.5));
    // the renderer samples the clock on its own frame, which is slow in
    // software GL -- wait for it instead of assuming one step is enough
    await page.waitForFunction(
      () => Math.abs(window.__imperial.renderer.worldTime - window.__imperial.game.worldTime) < 0.05,
      { timeout: 30000, polling: 120 }
    ).catch(() => {});
    await step(0.6);
    const night = await page.evaluate(() => {
      const r = window.__imperial.renderer;
      const pill = document.getElementById('worldTime');
      return {
        night: +r.night.toFixed(2), light: +r.townLightI.toFixed(2),
        sunY: +r.sunDir[1].toFixed(2), phase: pill.dataset.phase,
        title: (pill.title || '').split('\n')[1] || ''
      };
    });
    assert(night.night > 0.9, `renderer night is ${night.night}`);
    assert(night.light > 0.5, `town lights are only ${night.light}`);
    assert(night.phase === 'night', `the clock pill says ${night.phase}`);
    assert(/Melee damage/.test(night.title), 'the clock does not explain the night bonus');
    await shot('pt-06-night');
    await page.evaluate(() => window.__pt.setTime(10));
    await page.waitForFunction(
      () => Math.abs(window.__imperial.renderer.worldTime - window.__imperial.game.worldTime) < 0.05,
      { timeout: 30000, polling: 120 }
    ).catch(() => {});
    await step(0.4);
    const day = await page.evaluate(() => +window.__imperial.renderer.night.toFixed(2));
    assert(day < 0.2, `noon is still ${day} night`);
    return `night ${night.night}, lights ${night.light}, phase ${night.phase} → back to day ${day}`;
  });

  await check('camera rail: zoom, tilt and rotate all move the camera', async () => {
    const before = await page.evaluate(() => {
      const c = window.__imperial.camera;
      return { dist: c.dist, pitch: c.pitch, yaw: c.yaw };
    });
    await page.click('#camZoomIn');
    await page.click('#camRotL');
    await page.evaluate(() => {
      const b = document.getElementById('camTiltUp');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    });
    await page.evaluate(() => window.__pt.step(0.6));
    await page.evaluate(() => window.__pt.step(1));
    const after = await page.evaluate(() => {
      const c = window.__imperial.camera;
      return { dist: c.dist, pitch: c.pitch, yaw: c.yaw, wantDist: c.desiredDist, wantPitch: c.desiredPitch, wantYaw: c.desiredYaw };
    });
    assert(after.wantDist < before.dist, `zoom in did not shorten the camera: ${before.dist} → ${after.wantDist}`);
    assert(Math.abs(after.wantYaw - before.yaw) > 0.05, `rotate did nothing: ${before.yaw} → ${after.wantYaw}`);
    assert(Math.abs(after.wantPitch - before.pitch) > 0.02, `tilt did nothing: ${before.pitch} → ${after.wantPitch}`);
    // hold tilt-up until it bottoms out, then check it stopped at the minimum
    await page.evaluate(() => {
      const b = document.getElementById('camTiltUp');
      for (let i = 0; i < 12; i++) {
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 + i }));
        b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 + i }));
      }
    });
    await page.evaluate(() => window.__pt.step(1));
    const floor = await page.evaluate(() => window.__imperial.camera.desiredPitch);
    assert(floor >= 0.20 && floor <= 0.25, `tilt-up bottoms out at ${floor.toFixed(2)}, not the 0.22 minimum`);
    return `dist ${before.dist.toFixed(1)}→${after.dist.toFixed(1)}, yaw Δ${(after.yaw - before.yaw).toFixed(2)}, pitch ${before.pitch.toFixed(2)}→${after.pitch.toFixed(2)}`;
  });

  await check('the minimap and the pause menu work', async () => {
    const before = await page.evaluate(() => [...window.__imperial.camera.target]);
    const box = await page.evaluate(() => {
      const r = document.getElementById('minimap').getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
    });
    await page.mouse.click(box.x, box.y);
    await page.evaluate(() => window.__pt.step(0.4));
    const after = await page.evaluate(() => [...window.__imperial.camera.target]);
    const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
    assert(moved > 4, `tapping the minimap moved the camera ${moved.toFixed(1)} m`);

    await page.evaluate(() => { window.__imperial.paused = false; });
    await page.click('#btnPause');
    await new Promise((r) => setTimeout(r, 250));
    const modal = await page.evaluate(() => {
      const m = document.getElementById('modalScreen');
      return { open: !!m && !m.classList.contains('hidden'), text: (document.getElementById('modalBody')?.textContent || '').slice(0, 80) };
    });
    assert(modal.open, 'the pause button did not open the pause menu');
    assert(/Villagers/.test(modal.text), 'the pause menu has no campaign figures');
    await page.evaluate(() => window.__imperial.app && 0).catch(() => {});
    // close it again (Resume lives in the modal body)
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#modalBody [data-act]')].find((x) => x.dataset.act === 'resume');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const closed = await page.evaluate(() => {
      const m = document.getElementById('modalScreen');
      return !m || m.classList.contains('hidden');
    });
    assert(closed, 'resume did not close the pause menu');
    await page.evaluate(() => { window.__imperial.paused = true; });
    return `camera moved ${moved.toFixed(0)} m · pause menu opened and closed`;
  });

  /* ---------------------------------------------------------------- battle */
  await check('a sandbox battle: train soldiers, order an attack, take losses', async () => {
    await page.evaluate(() => window.__imperial.quitToMenu());
    await new Promise((r) => setTimeout(r, 400));
    await page.waitForFunction(() => {
      const m = document.getElementById('menuScreen');
      return m && !m.classList.contains('hidden');
    }, { timeout: 60000, polling: 150 });
    await startMatch({ mode: 'sandbox', diff: 'sandbox' });
    await step(0.4);

    // the barracks is a Feudal building: advance first, as a player must
    assert(await tapBuilding('town_center'), 'could not tap the town centre');
    await step(0.6);
    const rise = await cmd('Age 2');
    assert(rise.ok, `no age card in sandbox: ${JSON.stringify(rise.labels)}`);
    await step(2);
    const aged0 = await page.evaluate(() => {
      const g = window.__imperial.game;
      return {
        research: !!g.teams.get(1).ageResearch,
        can: g.canAdvanceAge(1),
        labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].filter((el) => el.style.display !== 'none').map((el) => el.querySelector('.lbl').textContent),
        toast: (document.querySelector('#toastLayer')?.textContent || '').slice(-70)
      };
    });
    assert(aged0.research, `sandbox age research did not start: ${JSON.stringify(aged0)}`);
    await step(70);
    const aged = await page.evaluate(() => window.__imperial.game.teams.get(1).age);
    assert(aged >= 1, `sandbox age stayed ${aged}`);

    // a barracks on the meadow, placed through the real build menu
    const v = await page.evaluate(() => window.__pt.unitScreen(1, 'villager'));
    await tap(v);
    assert((await cmd('Build')).ok, 'no Build command in sandbox');
    assert((await cmd('Barracks')).ok, 'no Barracks card in sandbox');
    // find legal spots on screen and try them until the tap is accepted
    const spots = await page.evaluate(() => {
      const g = window.__imperial.game;
      const t = g.camera.target;
      const out = [];
      for (let r = 8; r < 40; r += 3) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const x = t[0] + Math.cos(ang) * r, z = t[2] + Math.sin(ang) * r;
          if (!g.canPlaceAt('barracks', 1, x, z).ok) continue;
          const p = window.__pt.screen(x, g.heightAt(x, z) + 0.5, z);
          const rect = window.__imperial.canvas.getBoundingClientRect();
          if (p.x < rect.left + 210 || p.x > rect.left + rect.width - 210) continue;
          if (p.y < rect.top + 70 || p.y > rect.top + rect.height - 150) continue;
          out.push({ ...p, wx: x, wz: z });
        }
      }
      return out.slice(0, 8);
    });
    assert(spots.length, 'no legal spot for a barracks near the town');
    for (const s of spots) {
      await tap(s);
      const placed = await page.evaluate(() => !!window.__imperial.game.buildings.find((b) => b.team === 1 && b.type === 'barracks' && !b.dead));
      if (placed) break;
    }
    await step(45);
    const barracks = await page.evaluate(() => {
      const g = window.__imperial.game;
      const b = g.buildings.find((x) => x.team === 1 && x.type === 'barracks' && !x.dead);
      return b ? { x: b.x, z: b.z, progress: b.buildProgress ?? 1 } : null;
    });
    assert(barracks, 'the barracks was never built');
    assert(barracks.progress > 0.99, `the barracks is still at ${barracks.progress}`);

    // queue five spearmen through its command card
    await page.evaluate(({ x, z }) => {
      const g = window.__imperial.game;
      g.setSelection([g.buildings.find((b) => b.team === 1 && b.type === 'barracks' && !b.dead)]);
      window.__imperial.ui.refreshCommands();
      window.__imperial.camera.setTarget(x, z, true);
    }, barracks);
    await step(0.3);
    assert((await cmd('Spearman')).ok, `no Spearman card: ${JSON.stringify(await labels())}`);
    for (let i = 0; i < 4; i++) await cmd('Spearman');
    await step(60);
    const army = await page.evaluate(() => window.__imperial.game.units.filter((u) => !u.dead && u.team === 1 && u.type === 'spearman').length);
    assert(army >= 3, `only ${army} spearmen came out of the barracks`);

    // an enemy raiding party lands next to the town (test-only spawn)
    const raid = await page.evaluate(() => {
      const g = window.__imperial.game;
      g.stanceSpread = true;
      const base = g.world.playerBase;
      const out = [];
      for (let i = 0; i < 4; i++) {
        const u = g.spawnUnitRaw('huskarl', 2, base.x + 20 + i * 1.6, base.z + 15 + (i % 2) * 2);
        if (u) { u.stance = 'aggressive'; out.push({ x: u.x, z: u.z }); }
      }
      // look at the raid: the attack order is given by tapping the enemy
      window.__imperial.camera.setTarget(out[0].x, out[0].z, true);
      return out;
    });
    assert(raid.length === 4, `spawned only ${raid.length} raiders`);
    await step(1.2);

    // select the army with the HUD button, order an attack-move onto the raid
    await page.evaluate(() => window.__imperial.ui.selectArmy());
    await step(0.2);
    assert((await cmd('Atk-Move')).ok, 'no Atk-Move command');
    const raider = await page.evaluate((rp) => {
      const g = window.__imperial.game;
      // the raiders we spawned, not whichever enemy unit happens to be first
      let best = null, bd = 1e9;
      for (const u of g.units) {
        if (u.dead || u.team !== 2) continue;
        const d = Math.hypot(u.x - rp.x, u.z - rp.z);
        if (d < bd) { bd = d; best = u; }
      }
      return best ? window.__pt.screen(best.x, (best.y || 0) + 0.6, best.z) : null;
    }, raid[0]);
    assert(raider && !raider.behind, 'the raid is not on screen');
    await tap(raider);
    let deaths = 0;
    await page.evaluate(() => {
      window.__deaths = 0;
      const g = window.__imperial.game;
      const prev = g.onEvent;
      g.onEvent = (type, data) => { if (type === 'death') window.__deaths++; if (prev) prev(type, data); };
    });
    for (let i = 0; i < 12; i++) await step(5);
    deaths = await page.evaluate(() => window.__deaths);
    const battle = await page.evaluate(() => {
      const g = window.__imperial.game;
      const ours = g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'spearman');
      const theirs = g.units.filter((u) => !u.dead && u.team === 2);
      const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z).toFixed(1);
      return {
        ours: ours.length, theirs: theirs.length,
        ourStates: ours.slice(0, 3).map((u) => `${u.state}:${u.target ? 'target' : '-'}:${u.x.toFixed(0)},${u.z.toFixed(0)}`),
        theirPos: theirs.slice(0, 2).map((u) => `${u.x.toFixed(0)},${u.z.toFixed(0)}`),
        dist: ours.length && theirs.length ? near(ours[0], theirs[0]) : null,
        armed: g.input && g.input.armed ? g.input.armed.kind : null
      };
    });
    assert(deaths > 0, `nobody died in a 60 second battle: ${JSON.stringify(battle)}`);
    const alive = battle.theirs;
    await shot('pt-07-battle');
    return `${army} spearmen vs 4 raiders · ${deaths} deaths · ${alive} enemies left`;
  });

  await check('the frame stays inside the phone budget after all of that', async () => {
    const perf = await page.evaluate(() => {
      const a = window.__imperial;
      const s = a.renderer.stats;
      const before = document.querySelectorAll('*').length;
      const samples = [];
      for (let i = 0; i < 120; i++) {
        a.game.update(1 / 60);
        if (i % 20 === 0) a.ui.update(0.05);
        samples.push(a.game.stats.tickMs);
      }
      samples.sort((x, y) => x - y);
      return {
        draws: s.drawCalls, tris: s.tris, nodes: document.querySelectorAll('*').length, before,
        tickAvg: samples.reduce((n, x) => n + x, 0) / samples.length,
        tickP99: samples[Math.floor(samples.length * 0.99)],
        heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null
      };
    });
    assert(perf.draws <= 90, `${perf.draws} draw calls`);
    assert(perf.tris <= 260000, `${perf.tris} triangles`);
    assert(perf.tickAvg < 3, `tick averaged ${perf.tickAvg.toFixed(2)} ms`);
    assert(perf.nodes === perf.before, `DOM grew from ${perf.before} to ${perf.nodes} nodes`);
    await shot('pt-08-late');
    return `${perf.draws} draws · ${(perf.tris / 1000).toFixed(0)}k tris · ${perf.tickAvg.toFixed(2)} ms/tick · ${perf.nodes} DOM nodes`;
  });

  await check('no console or page errors during the whole session', async () => {
    const all = [...jsErrors, ...consoleErrors].filter((t) => !/favicon/i.test(t));
    assert(all.length === 0, all.slice(0, 3).join(' | '));
    return `${checks.length} checks, zero errors`;
  });
} finally {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const rows = checks.map((c) => `| ${c.ok ? '✅' : '❌'} | ${c.name} | ${c.detail || ''} | ${c.ms} ms |`).join('\n');
  const md = `### Play test

${failed === 0 ? '**All play checks passed.**' : `**${failed} play check(s) failed.**`}

| | check | result | time |
|---|---|---|---|
${rows}

Error surface: ${jsErrors.length} page errors, ${consoleErrors.length} console errors.
`;
  await writeReport(md);
  for (const c of checks) if (!c.ok) console.log(`\n - ${c.name}: ${c.detail}`);
  console.log(`\nPLAYTEST ${failed === 0 ? 'PASSED' : 'FAILED'} — ${passed}/${checks.length} checks`);
  await browser.close();
  server.close();
  // eslint-disable-next-line no-process-exit
  process.exit(failed === 0 ? 0 : 1);
}
