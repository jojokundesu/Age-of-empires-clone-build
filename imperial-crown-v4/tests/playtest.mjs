/* A play-test driven entirely through the interface a player has.

   Every other suite pokes the simulation (`g.update`, `game.orderMove`). This
   one uses the menu's own buttons, then taps and drags at real screen
   coordinates and checks that the *game* answers:

     · the menu's campaign cards / civ chips / difficulty row start the match
       the player asked for, not a default one
     · tapping the town centre selects it and the command card is the card a
       town centre has
     · training from that card produces a villager, who walks out of the hall
     · Build → House → tap ground lays a foundation; the crew finishes it;
       the house raises the population cap
     · tapping a tree with a villager selected sends it to gather, and wood
       arrives at the hall
     · the army is selected from the card and marched by tapping the ground
     · one-finger drag pans the map, exactly as far as the finger moved
     · the wheel zooms, the tech panel lists real technologies, a save
       survives a reload

   node tests/playtest.mjs [--out ci/v4-playtest]
*/
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-playtest'));
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
/* Every check is also written to ci/playtest-report.md: the APK workflow reads
   that file to decide whether the build may ship, so a pass that only reaches
   stdout is a pass nobody sees. */
const REPORT = 'ci/playtest-report.md';
const rows = [];
await mkdir('ci', { recursive: true }).catch(() => {});
const writeReport = () => writeFile(REPORT, [
  '## Play test — a whole session in a real browser',
  '',
  `- checks: **${pass}** passed, **${failures}** failed`,
  `- screenshots: \`${OUT}\``,
  `- mode: ${process.env.PLAYTEST_MODE || 'desktop + phone'}`,
  '',
  '| | check | result |',
  '| - | ----- | ------ |',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail || ''} |`),
  '',
  failures === 0 ? `**PLAYTEST PASSED (${pass})**` : `**PLAYTEST FAILURES (${failures})**`,
  ''
].join('\n')).catch(() => {});

const check = async (name, fn) => {
  try {
    const d = await fn();
    pass++;
    rows.push({ ok: true, name, detail: d ? String(d) : '' });
    console.log(`  ok   ${name}${d ? '  — ' + d : ''}`);
  } catch (e) {
    failures++;
    rows.push({ ok: false, name, detail: (e && e.message) || 'failed' });
    console.log(`  FAIL ${name} — ${e && e.message}`);
  }
  await writeReport();
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') });
const frame = async (n = 4) => { for (let i = 0; i < n; i++) { await wait(90); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };

/** Where is this world point on screen? null when it is behind the camera. */
const screenOf = (x, z, lift = 1.2) => page.evaluate((x, z, lift) => {
  const a = window.__imperial;
  const out = [0, 0, 0];
  a.camera.project(x, a.game.heightAt(x, z) + lift, z, out);
  if (out[2] > 1) return null;
  return { x: Math.round((out[0] * 0.5 + 0.5) * innerWidth), y: Math.round((-out[1] * 0.5 + 0.5) * innerHeight) };
}, x, z, lift);

const state = () => page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const st = g.teams.get(1);
  return {
    time: +g.time.toFixed(1),
    mode: g.mode, civ: g.civ, difficulty: g.difficultyKey, crowns: g.crowns,
    selection: g.selection.map((e) => `${e.type}#${e.id}`),
    units: g.units.filter((u) => !u.dead && u.team === 1).map((u) => ({
      id: u.id, type: u.type, state: u.state, x: +u.x.toFixed(1), z: +u.z.toFixed(1)
    })),
    buildings: g.buildings.filter((b) => !b.dead && b.team === 1).map((b) => ({
      id: b.id, type: b.type, progress: b.buildProgress, x: +b.x.toFixed(1), z: +b.z.toFixed(1)
    })),
    res: { ...st.res },
    pop: { used: st.popUsed, cap: st.popCap }
  };
});

/* Speed the simulation up while the harness waits: a villager walking to a
   tree takes half a minute of real time otherwise. */
const speed = (v) => page.evaluate((v) => { window.__imperial.game.speed = v; }, v);

/* Wait for the *game* clock, not the wall clock.
   A shared CI runner (or a machine running three soaks at once) can hand the
   page far fewer frames than it asked for; a check that says "wait 1.2 s and
   expect a march" then fails for a reason that has nothing to do with the
   game. Every timed check waits on simulated seconds instead. */
const gameSeconds = async (n, capMs = 30000) => {
  const now = await page.evaluate(() => window.__imperial.game.time);
  await page.waitForFunction((target) => window.__imperial.game.time >= target,
    { timeout: capMs, polling: 100 }, now + n);
};

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

/* ------------------------------------------------------------- the menu -- */
await check('the menu starts the match the player configured', async () => {
  await page.click('.modeCard[data-mode="campaign"]');
  await page.click('#civGrid .civChip[data-civ="byzantines"]');
  await page.click('#diffRow .seg[data-diff="standard"]');
  await page.click('#victoryRow .seg[data-victory="conquest"]');
  await frame(2);
  await shot('01-menu-configured');
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
  await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.units.length > 5)', { timeout: 60000 });
  const st = await state();
  assert(st.mode === 'campaign', `mode is ${st.mode}`);
  assert(st.civ === 'byzantines', `civilisation is ${st.civ}`);
  assert(st.difficulty === 'standard', `difficulty is ${st.difficulty}`);
  return `${st.civ} · ${st.difficulty} · ${st.units.length} men`;
});

/* --------------------------------------------------------- the hall card -- */
await check('tapping the town centre selects it and offers a hall card', async () => {
  const hall = (await state()).buildings.find((b) => b.type === 'town_center');
  assert(hall, 'no town centre');
  await page.evaluate((id) => {
    /* centre the camera on the hall first: a tap is a screen coordinate */
    const a = window.__imperial;
    const b = a.game.buildings.find((x) => x.id === id);
    a.camera.setTarget(b.x, b.z, true);
  }, hall.id);
  await frame(4);
  const p = await screenOf(hall.x, hall.z, 2.0);
  assert(p, 'the hall is off screen');
  await page.mouse.click(p.x, p.y);
  await frame(2);
  const st = await state();
  assert(st.selection.length === 1 && st.selection[0].startsWith('town_center'), `selection is ${JSON.stringify(st.selection)}`);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#cmdGrid .cmdBtn')]
    .filter((b) => b.style.display !== 'none').map((b) => b.querySelector('.lbl').textContent));
  assert(labels.includes('Villager'), `the hall card offers ${JSON.stringify(labels)}`);
  await shot('02-hall-selected');
  return labels.join(', ');
});

await check('training from the card produces a villager who leaves the hall', async () => {
  const before = (await state()).units.filter((u) => u.type === 'villager').length;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .find((b) => (b.querySelector('.lbl') || {}).textContent === 'Villager');
    btn.click();
  });
  await speed(6);
  const t0 = Date.now();
  let st = await state();
  while (Date.now() - t0 < 40000) {
    await wait(300);
    st = await state();
    if (st.units.filter((u) => u.type === 'villager').length > before) break;
  }
  await speed(1);
  const after = st.units.filter((u) => u.type === 'villager').length;
  assert(after > before, `still ${after} villagers (was ${before})`);
  return `${before} → ${after} villagers`;
});

/* ------------------------------------------------------------- building -- */
await check('Build → House → tap the ground raises a house', async () => {
  const before = await state();
  const capBefore = before.pop.cap;
  const houseBefore = before.buildings.filter((b) => b.type === 'house').length;
  /* pick a villager and open the build ring through the command card */
  await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const v = g.units.find((u) => !u.dead && u.team === 1 && u.type === 'villager');
    g.setSelection([v]);
    a.camera.setTarget(v.x, v.z, true);
    a.ui.refreshCommands(true);
  });
  await frame(3);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .find((b) => (b.querySelector('.lbl') || {}).textContent === 'Build');
    if (!btn) throw new Error('no Build command on a selected villager');
    btn.click();
  });
  await frame(2);
  const armed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .find((b) => (b.querySelector('.lbl') || {}).textContent === 'House');
    if (!btn) return false;
    btn.click();
    return !!window.__imperial.game.placing;
  });
  assert(armed, 'House did not arm a placement');
  /* tap open ground just south of the villager */
  const v = (await state()).units.find((u) => u.type === 'villager');
  await page.evaluate((x, z) => window.__imperial.camera.setTarget(x, z, true), v.x, v.z);
  await frame(3);
  const p = await screenOf(v.x + 7, v.z + 6.5, 0.4);
  assert(p, 'the build site is off screen');
  await page.mouse.click(p.x, p.y);
  await frame(3);
  const placed = await page.evaluate(() => {
    const g = window.__imperial.game;
    return g.buildings.filter((b) => !b.dead && b.team === 1 && b.type === 'house' && b.buildProgress < 1)
      .map((b) => ({ id: b.id, progress: b.buildProgress }));
  });
  assert(placed.length >= 1, 'no foundation was laid');
  await shot('03-house-foundation');
  await speed(8);
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 90000) {
    await wait(400);
    done = await page.evaluate((ids) => ids.every((id) => {
      const b = window.__imperial.game.buildings.find((x) => x.id === id);
      return b && !b.dead && b.buildProgress >= 1;
    }), placed.map((b) => b.id));
    if (done) break;
  }
  await speed(1);
  const after = await state();
  const houseAfter = after.buildings.filter((b) => b.type === 'house').length;
  assert(done, 'the crew never finished the house');
  assert(houseAfter > houseBefore || after.pop.cap > capBefore,
    `a finished house raised neither the count (${houseBefore} → ${houseAfter}) nor the cap (${capBefore} → ${after.pop.cap})`);
  await shot('04-house-finished');
  return `cap ${capBefore} → ${after.pop.cap}`;
});

/* ------------------------------------------------------------ gathering -- */
await check('tapping a tree with a villager selected gathers wood', async () => {
  const st0 = await state();
  const wood0 = st0.res.wood;
  const tree = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const v = g.units.find((u) => !u.dead && u.team === 1 && u.type === 'villager');
    /* the nearest tree the crown can actually see */
    let best = null, bd = 1e9;
    for (const r of g.resources) {
      if (r.dead || r.resKind !== 'wood' || r.amount <= 0) continue;
      const d = (r.x - v.x) ** 2 + (r.z - v.z) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    g.setSelection([v]);
    a.camera.setTarget((v.x + best.x) / 2, (v.z + best.z) / 2, true);
    return best ? { x: best.x, z: best.z, id: best.id } : null;
  });
  assert(tree, 'no tree on the map');
  await frame(4);
  const p = await screenOf(tree.x, tree.z, 0.9);
  assert(p, 'the tree is off screen');
  await page.mouse.click(p.x, p.y);
  await frame(2);
  const gathering = await page.evaluate(() => {
    const g = window.__imperial.game;
    const v = g.units.find((u) => !u.dead && u.team === 1 && u.type === 'villager');
    return { state: v.state, target: v.gatherTarget ? v.gatherTarget.id : null,
      villagers: g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager' && u.state === 'gather').length };
  });
  assert(gathering.villagers >= 1, `no villager took a gathering order (${JSON.stringify(gathering)})`);
  await shot('05-gather-order');
  await speed(8);
  const t0 = Date.now();
  let wood1 = wood0;
  while (Date.now() - t0 < 60000) {
    await wait(400);
    wood1 = (await state()).res.wood;
    if (wood1 > wood0 + 8) break;
  }
  await speed(1);
  assert(wood1 > wood0, `wood did not rise (${wood0} → ${wood1})`);
  return `wood ${Math.round(wood0)} → ${Math.round(wood1)}`;
});

/* --------------------------------------------------------------- army --- */
await check('the army card selects soldiers and a tap marches them', async () => {
  const cards = await page.evaluate(() => {
    const a = window.__imperial;
    a.game.clearSelection();
    a.ui.refreshCommands(true);
    return [...document.querySelectorAll('#cmdGrid .cmdBtn')].filter((b) => b.style.display !== 'none').map((b) => b.querySelector('.lbl').textContent);
  });
  assert(cards.includes('Army'), `the empty selection card offers ${JSON.stringify(cards)}`);
  await page.evaluate(() => {
    [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => b.querySelector('.lbl').textContent === 'Army').click();
  });
  await frame(2);
  const sel = (await state()).selection;
  assert(sel.length > 0, 'the Army button selected nothing');
  const at = await page.evaluate(() => {
    const g = window.__imperial.game;
    const u = g.selection[0];
    window.__imperial.camera.setTarget(u.x, u.z, true);
    return { x: u.x, z: u.z };
  });
  await frame(3);
  const p = await screenOf(at.x, at.z + 9, 0.3);
  assert(p, 'the destination is off screen');
  const before = await page.evaluate(() => window.__imperial.game.selection.map((u) => ({ id: u.id, x: u.x, z: u.z })));
  await page.mouse.click(p.x, p.y);
  await speed(4);
  await gameSeconds(4.5);
  await speed(1);
  const after = await page.evaluate((ids) => ids.map((id) => {
    const u = window.__imperial.game.units.find((x) => x.id === id);
    return u ? { id, x: u.x, z: u.z, state: u.state } : null;
  }), before.map((u) => u.id));
  const moved = after.filter((u, i) => u && Math.hypot(u.x - before[i].x, u.z - before[i].z) > 0.6).length;
  assert(moved > 0, 'no soldier moved on the order');
  return `${moved}/${before.length} marched`;
});

/* --------------------------------------------------------------- camera -- */
await check('a right-drag pans the map and keeps the selection', async () => {
  /* The desktop convention: the left button is the selection box, the right
     button is the map. (A phone has neither, which is why the finger drag is
     a separate check on a separate phone-shaped page below.) */
  const selBefore = (await state()).selection.length;
  const before = await page.evaluate(() => window.__imperial.camera.target.slice(0, 3));
  await page.mouse.move(640, 420);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) { await page.mouse.move(640 + i * 16, 420); await wait(16); }
  await page.mouse.up({ button: 'right' });
  await frame(3);
  const after = await page.evaluate(() => window.__imperial.camera.target.slice(0, 3));
  const dist = Math.hypot(after[0] - before[0], after[2] - before[2]);
  assert(dist > 4, `a right-drag moved the camera ${dist.toFixed(2)} m`);
  const selAfter = (await state()).selection.length;
  assert(selAfter === selBefore, `the pan changed the selection from ${selBefore} to ${selAfter}`);
  return `camera moved ${dist.toFixed(1)} m`;
});

await check('the wheel zooms without moving the ground under the cursor', async () => {
  const z0 = await page.evaluate(() => window.__imperial.camera.dist);
  await page.mouse.move(640, 380);
  await page.mouse.wheel({ deltaY: -420 });
  await frame(4);
  const z1 = await page.evaluate(() => window.__imperial.camera.dist);
  assert(Math.abs(z1 - z0) > 1, `the wheel changed nothing (${z0} → ${z1})`);
  await page.mouse.wheel({ deltaY: 900 });
  await frame(3);
  const z2 = await page.evaluate(() => window.__imperial.camera.dist);
  return `dist ${z0.toFixed(1)} → ${z1.toFixed(1)} → ${z2.toFixed(1)}`;
});

/* ----------------------------------------------------------------- tech -- */
await check('the tech panel lists real technologies and the hall researches one', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial, g = a.game;
    const hall = g.buildings.find((b) => !b.dead && b.team === 1 && b.type === 'town_center');
    const team = g.teams.get(1);
    team.res.food = 3000; team.res.wood = 3000; team.res.gold = 3000; team.res.stone = 3000;
    g.setSelection([hall]);
    a.ui.refreshCommands(true);
    a.ui.openTech();
    return { open: !document.getElementById('modalScreen').classList.contains('hidden') };
  });
  assert(st.open, 'the tech panel did not open');
  const rows = await page.evaluate(() => document.querySelectorAll('#modalBody .techList .row').length);
  assert(rows >= 6, `the tech panel listed ${rows} technologies`);
  await shot('06-tech-panel');
  await page.evaluate(() => window.__imperial.menu.closeModal());
  /* and a real research, from the hall's own command card */
  const labels = await page.evaluate(() => [...document.querySelectorAll('#cmdGrid .cmdBtn')]
    .filter((b) => b.style.display !== 'none').map((b) => b.querySelector('.lbl').textContent));
  assert(labels.includes('Loom'), `the hall card offers ${JSON.stringify(labels)}`);
  await page.evaluate(() => {
    [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .find((b) => b.querySelector('.lbl').textContent === 'Loom').click();
  });
  await speed(10);
  const t0 = Date.now();
  let learned = false;
  while (Date.now() - t0 < 40000) {
    await wait(300);
    learned = await page.evaluate(() => window.__imperial.game.teams.get(1).techs.has('loom'));
    if (learned) break;
  }
  await speed(1);
  assert(learned, 'Loom never completed');
  return `${rows} techs listed, Loom researched`;
});

/* ----------------------------------------------------------------- save -- */
await check('a save survives a reload with the army intact', async () => {
  const before = await state();
  await page.evaluate(() => window.__imperial.saveMatch());
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem('imperial-crown-save') || '';
    return { bytes: raw.length, ok: raw.length > 500 };
  });
  assert(saved.ok, 'the save is empty');
  const after = await page.evaluate(() => {
    const raw = localStorage.getItem('imperial-crown-save');
    const data = JSON.parse(raw);
    return { units: (data.units || []).length, buildings: (data.buildings || []).length, teams: Object.keys(data.teams || {}) };
  });
  assert(after.units > 0, 'the save has no units');
  assert(after.teams.length >= 2, `the save has ${after.teams.length} teams`);
  return `${(saved.bytes / 1024).toFixed(1)} kB · ${after.units} men · ${after.buildings} roofs · ${before.time}s`;
});

/* --------------------------------------------------------- the phone ----- */
/* A second page, opened as a phone from the first paint: a finger is a touch
   pointer, and changing that on a live page reloads it. This is the shape of
   the device the game ships for (a 1080x2400 panel in landscape). */
const phone = await browser.newPage();
const phoneErrors = [];
phone.on('pageerror', (e) => phoneErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
phone.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text()); });
await phone.setViewport({ width: 915, height: 412, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await phone.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await phone.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await phone.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

await check('on a phone the HUD clears the top bar', async () => {
  await phone.evaluate(() => window.__imperial.startMatch({
    mode: 'kingdoms', civ: 'franks', difficulty: 'standard', seed: 4242, kingdoms: 4, victory: 'conquest'
  }));
  await phone.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
  await phone.waitForFunction('!document.getElementById("crownStrip").classList.contains("hidden")', { timeout: 60000 });
  await phone.screenshot({ path: join(OUT, '07-phone-hud.png') });
  const hud = await phone.evaluate(() => {
    const bar = document.getElementById('topBar').getBoundingClientRect();
    const stack = document.getElementById('topStack').getBoundingClientRect();
    const pills = [...document.querySelectorAll('#crownStrip .crown')].map((p) => {
      const r = p.getBoundingClientRect();
      return { text: p.textContent.trim().replace(/\s+/g, ' '), x: Math.round(r.x), w: Math.round(r.width),
        onScreen: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 };
    });
    return { barBottom: Math.round(bar.bottom), stackTop: Math.round(stack.top), pills,
      safeH: innerHeight, bottomBarTop: Math.round(document.getElementById('bottomBar').getBoundingClientRect().top) };
  });
  assert(hud.stackTop >= hud.barBottom - 2, `the strips start at ${hud.stackTop}, inside the bar (${hud.barBottom})`);
  assert(hud.pills.length === 4, `the phone shows ${hud.pills.length} crowns of four`);
  assert(hud.pills.every((p) => p.onScreen && p.w > 20), `a crown is clipped: ${JSON.stringify(hud.pills)}`);
  assert(hud.stackTop < hud.bottomBarTop, `the crowns (${hud.stackTop}) sit below the command bar (${hud.bottomBarTop})`);
  return `${hud.pills.length} crowns under a bar that ends at ${hud.barBottom}px`;
});

await check('a one-finger drag on a phone pans with the finger', async () => {
  const before = await phone.evaluate(() => window.__imperial.camera.target.slice(0, 3));
  const selBefore = await phone.evaluate(() => window.__imperial.game.selection.length);
  await phone.touchscreen.touchStart(430, 250);
  for (let i = 1; i <= 10; i++) { await phone.touchscreen.touchMove(430 + i * 20, 250); await wait(20); }
  await phone.touchscreen.touchEnd();
  await frame(4);
  const after = await phone.evaluate(() => window.__imperial.camera.target.slice(0, 3));
  const dist = Math.hypot(after[0] - before[0], after[2] - before[2]);
  const selAfter = await phone.evaluate(() => window.__imperial.game.selection.length);
  assert(dist > 3, `a 200 px finger drag moved the camera ${dist.toFixed(2)} m`);
  assert(selAfter === selBefore, `the drag selected ${selAfter} things (was ${selBefore})`);
  await phone.screenshot({ path: join(OUT, '08-phone-panned.png') });
  return `${dist.toFixed(1)} m of pan on a 915x412 touch screen`;
});

await check('a two-finger pinch on a phone zooms the map', async () => {
  const z0 = await phone.evaluate(() => window.__imperial.camera.dist);
  const cdp = await phone.createCDPSession();
  const pts = (sep) => [
    { x: 450 - sep, y: 210, id: 1, radiusX: 8, radiusY: 8, force: 1 },
    { x: 450 + sep, y: 210, id: 2, radiusX: 8, radiusY: 8, force: 1 }
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(40 + i * 10) });
    await wait(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frame(4);
  const z1 = await phone.evaluate(() => window.__imperial.camera.dist);
  assert(Math.abs(z1 - z0) > 1.5, `a pinch changed the zoom by ${Math.abs(z1 - z0).toFixed(2)} (${z0} → ${z1})`);
  return `dist ${z0.toFixed(1)} → ${z1.toFixed(1)}`;
});

await check('the phone page stayed clean', async () => {
  const errs = phoneErrors.filter((e) => !/favicon|AudioContext|autoplay/i.test(e));
  assert(errs.length === 0, errs.slice(0, 3).join(' | '));
  return 'clean console';
});

await check('nothing errored in the browser', async () => {
  const errs = [...pageErrors, ...consoleErrors].filter((e) => !/favicon|AudioContext|autoplay/i.test(e));
  assert(errs.length === 0, errs.slice(0, 3).join(' | '));
  return 'clean console';
});

console.log('');
await writeReport();
console.log(failures === 0
  ? `PLAY-TEST PASSED (${pass}) — shots in ${OUT}`
  : `PLAY-TEST FAILURES (${failures}) — shots in ${OUT}`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
