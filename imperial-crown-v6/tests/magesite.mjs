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

   node tests/magesite.mjs [--out ci/v4-mages]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-mages'));
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
const frame = async (n = 3) => { for (let i = 0; i < n; i++) { await wait(90); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); } };

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

/* the same escape hatch the other suites use: headless frames are far too
   slow to wait out a spell cooldown, so mechanics are stepped by hand */
await page.evaluate(() => {
  window.__stepSim = (seconds) => {
    const a = window.__imperial;
    if (!a || !a.game) return 0;
    const step = 1 / 30;
    const n = Math.max(1, Math.round(seconds / step));
    for (let i = 0; i < n; i++) a.game.update(step);
    return a.game.time;
  };
  window.__look = (x, z, dist = 14, pitch = 0.42, yaw = 0.4) => {
    const cam = window.__imperial.camera;
    cam.target[0] = x; cam.target[1] = window.__imperial.game.heightAt(x, z); cam.target[2] = z;
    cam.desired[0] = cam.target[0]; cam.desired[1] = cam.target[1]; cam.desired[2] = cam.target[2];
    cam.yaw = cam.desiredYaw = yaw;
    cam.pitch = cam.desiredPitch = pitch;
    cam.dist = cam.desiredDist = dist;
    cam.update(0.016);
  };
});

/* ------------------------------------------------------------------ session */
await page.evaluate(() => window.__imperial.startMatch({
  mode: 'mods', mods: ['arcane'], civ: 'franks', difficulty: 'standard', seed: 909,
  quality: 'medium', music: false, sound: false
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.modHost)', { timeout: 120000 });
// V5 deliberately starts the workshop status collapsed. Open it explicitly
// before checking its chips; this also verifies the requested uncluttered HUD.
await page.waitForFunction(() => {
  const b = document.getElementById('btnModStatus');
  return b && !b.classList.contains('hidden');
}, { timeout: 60000, polling: 120 });
await check('workshop status starts collapsed and can be opened', async () => {
  const collapsed = await page.evaluate(() => document.getElementById('modHud').classList.contains('is-collapsed'));
  assert(collapsed, 'status covered the battlefield before it was requested');
  await page.click('#btnModStatus');
  return 'collapsed by default, opened on demand';
});
await page.waitForFunction(() => {
  const h = document.getElementById('modHud');
  return h && !h.classList.contains('hidden') && h.querySelectorAll('.modChip').length >= 1;
}, { timeout: 60000, polling: 120 });

await check('the arcane session comes up clean', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      ids: a.game.modHost.activeIds(),
      errors: a.game.modHost.errors.map((e) => `${e.mod}: ${e.message}`),
      units: !!a.game.units.length,
      hud: !document.getElementById('modHud').classList.contains('hidden')
    };
  });
  assert(st.ids.includes('arcane'), `arcane is not active (${st.ids.join(',')})`);
  assert(st.errors.length === 0, `mod errors: ${st.errors.join(' | ')}`);
  assert(st.hud, 'no mod HUD');
  return `${st.ids.join(',')} · ${st.units ? 'world up' : 'no world'}`;
});

/* ------------------------------------------------------------------ ranks */
await check('six ranks, six silhouettes, one legible line', async () => {
  const info = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const cx = tc.x + 26, cz = tc.z - 22;
    const types = ['mage', 'mage_adept', 'mage_magus', 'mage_archmage', 'mage_sage', 'mage_ascendant'];
    const made = [];
    for (let i = 0; i < types.length; i++) {
      const spot = g.freeSpotNear(cx - 9 + i * 3.4, cz, { radius: 0.6, def: { naval: false } }, 8) || [cx - 9 + i * 3.4, cz];
      const u = g.spawnUnitRaw('mage', 1, spot[0], spot[1]);
      if (!u) continue;
      u.modState.arcane.rank = i + 1;
      u.modState.arcane.xp = [0, 90, 240, 460, 760, 1150][i];
      u.type = types[i];
      u._stats = null;
      u._statsVersion = -1;
      u.facing = 0.5;
      u.anim.phase = i * 1.1;
      g.selection = [u];
      made.push({ id: u.id, type: u.type, x: u.x, z: u.z });
    }
    a.camera.target[0] = cx; a.camera.target[2] = cz;
    window.__look(cx, cz, 15, 0.34, 0.35);
    return { made, batches: made.map((m) => a.renderer.unitBatches.has(m.type)) };
  });
  assert(info.made.length === 6, `six magi on the field (${info.made.length})`);
  assert(info.batches.every(Boolean), `a rank has no renderer batch: ${info.batches.join(',')}`);
  await frame(4);
  await shot('01-six-ranks');
  return info.made.map((m) => m.type.replace('mage_', '')).join(' → ');
});

/* ------------------------------------------------------------------ the book */
await check('the spell card opens a book the rank has earned', async () => {
  const book = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    /* keep only the apprentice standing in the open: the rest of the line
       falls over so the camera has one mage to read */
    const keep = g.units.filter((u) => u.type === 'mage');
    const u = keep[0];
    for (const other of g.units) {
      if (other !== u && /^mage/.test(other.type)) other.dead = true;
    }
    g.selection = [u];
    u.modState.arcane.rank = 1;
    u.modState.arcane.mana = 100;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    u.x = tc.x + 10; u.z = tc.z + 6;
    window.__look(u.x, u.z, 11, 0.4, 0.3);
    a.ui.refreshCommands(true);
    const labels = [...document.querySelectorAll('#cmdGrid .cmdBtn')]
      .filter((b) => b.style.display !== 'none').map((b) => b.textContent.trim());
    return { labels, sel: g.selection.length };
  });
  assert(book.sel === 1, 'the mage is not selected');
  const spells = book.labels.find((t) => /Spells/.test(t));
  assert(spells, `no Spells card in [${book.labels.join(' | ')}]`);
  const opened = await page.evaluate(() => {
    const a = window.__imperial;
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Spells/.test(b.textContent));
    btn.click();
    return [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.textContent.trim());
  });
  await wait(120);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#cmdGrid .cmdBtn')]
    .filter((b) => b.style.display !== 'none').map((b) => b.textContent.trim()));
  assert(labels.some((t) => /Fireball/.test(t)), `no fireball at rank 1: ${labels.join(' | ')}`);
  assert(labels.some((t) => /Blink/.test(t)), `no blink at rank 1: ${labels.join(' | ')}`);
  assert(!labels.some((t) => /Meteor|SKYFALL|Chain/.test(t)), `rank 1 shows unearned spells: ${labels.join(' | ')}`);
  await shot('02-spellbook-rank1');
  return labels.join(' · ');
});

await check('arming a spell arms the input layer too', async () => {
  const armed = await page.evaluate(() => {
    const a = window.__imperial;
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Fireball/.test(b.textContent));
    btn.click();
    return {
      modCast: !!a.game.modCast,
      label: a.game.modCast && a.game.modCast.label,
      radius: a.game.modCast && a.game.modCast.radius
    };
  });
  assert(armed.modCast, 'clicking Fireball did not arm a cast');
  assert(/Fireball/i.test(armed.label), `armed ${armed.label}`);
  /* move the virtual finger: the reticle must follow it */
  const ret = await page.evaluate(() => {
    const a = window.__imperial;
    a.input.lastX = a.canvas.clientWidth * 0.55;
    a.input.lastY = a.canvas.clientHeight * 0.52;
    a.input.update(0.016);
    return a.game.castReticle ? { x: a.game.castReticle.x, z: a.game.castReticle.z } : null;
  });
  assert(ret, 'no reticle while a cast is armed');
  return `${armed.label} armed, reticle at ${ret.x.toFixed(1)},${ret.z.toFixed(1)}`;
});

/* ------------------------------------------------------------------ skyfall */
await check('SKYFALL: one tap, one pillar, one day spent', async () => {
  const prep = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    g.modHost.cancelCast();
    const u = g.units.find((x) => x.type === 'mage');
    /* grow it all the way up, in the open, facing the enemy town */
    const st = u.modState.arcane;
    st.xp = 5000;
    for (let i = 0; i < 8 && (st.rank || 1) < 6; i++) window.__stepSim(0.3);
    const tc = g.buildings.find((b) => b.team === 2 && b.type === 'town_center');
    u.x = tc.x - 24; u.z = tc.z - 10;
    window.__look(tc.x - 8, tc.z, 20, 0.5, 0.2);
    a.ui.refreshCommands(true);
    return { rank: st.rank, type: u.type, hp: tc.hp, tcId: tc.id, x: tc.x, z: tc.z, mx: u.x, mz: u.z };
  });
  assert(prep.rank === 6, `the mage only reached rank ${prep.rank}`);
  assert(prep.type === 'mage_ascendant', `model is ${prep.type}`);
  await frame(2);
  await shot('03-ascendant');

  const armed = await page.evaluate(() => {
    const a = window.__imperial;
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /SKYFALL/.test(b.textContent));
    if (!btn) return { labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.textContent.trim()) };
    btn.click();
    return { armed: !!a.game.modCast, label: a.game.modCast && a.game.modCast.label };
  });
  assert(armed.armed, `SKYFALL could not be armed: ${(armed.labels || []).join(' | ')}`);

  const hit = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const tc = g.buildings.find((b) => b.id === g.__skyTc) || g.buildings.find((b) => b.team === 2 && b.type === 'town_center');
    const before = tc.hp;
    const flash0 = a.renderer.flash;
    g.modHost.castAt(tc.x, tc.z, tc);
    return {
      hp: tc.hp, before, tcDead: tc.dead,
      flash: a.renderer.flash, flash0,
      skyday: a.game.modHost.mods.get('arcane').api.state.skyday,
      shock: a.camera.shake
    };
  });
  assert(hit.hp < hit.before, `the town centre took no damage (${hit.before} → ${hit.hp})`);
  assert(hit.flash > hit.flash0, 'the frame did not flash');
  assert(hit.shock > 0, 'the camera did not shake');
  /* hold the flash for one captured frame: SwiftShader composites slower than
     it renders, so a decay-on-dt flash is gone before the screenshot lands */
  await page.evaluate(() => { window.__imperial.renderer.flash = 0.34; });
  await shot('04-skyfall-impact');
  await page.evaluate(() => { window.__imperial.renderer.flash = 0; });
  await wait(260);
  await shot('05-skyfall-aftermath');
  return `TC ${hit.before} → ${hit.hp}, flash ${hit.flash.toFixed(2)}, shake ${hit.shock.toFixed(2)}`;
});

await check('an Ascendant gets three skies a day, and the card counts them down', async () => {
  /* 6.2: the once-a-day spell is three castings at rank 6, and the card has to
     say how many are left rather than lying about tomorrow */
  const after = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const u = g.units.find((x) => x.type === 'mage_ascendant');
    const arc = a.game.modHost.mods.get('arcane');
    const sky = arc.mod.spells().find((s) => s.id === 'skyfall');
    const tc = g.buildings.find((b) => b.team === 2 && b.type === 'town_center');
    for (let i = 0; i < 2; i++) {
      u.modState.arcane.mana = 1000;
      arc.mod.castSpell(arc.api, u, sky, tc ? tc.x : u.x, tc ? tc.z : u.z);
    }
    g.selection = [u];
    a.ui.refreshCommands(true);
    const card = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /SKYFALL/.test(b.textContent));
    return { has: !!card, disabled: card && card.classList.contains('poor'), text: card && card.textContent.trim(),
      uses: arc.api.state.skyuses };
  });
  assert(after.uses === 3, `the sky was used ${after.uses} times, not three`);
  assert(after.has, 'the SKYFALL card vanished instead of dimming');
  assert(after.disabled, 'a spent day still offers a live SKYFALL card');
  return after.text.replace(/\s+/g, ' ');
});

/* ------------------------------------------------------------------ hybrid */
await check('attunement opens six pairs and finds one', async () => {
  const opened = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const u = g.units.find((x) => x.type === 'mage_ascendant');
    g.selection = [u];
    u.modState.arcane.mana = 200;
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Attune/.test(b.textContent));
    if (!btn) return { labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.textContent.trim()) };
    btn.click();
    return { labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.textContent.trim()) };
  });
  assert(opened.labels && opened.labels.some((t) => /Fire \+ Storm/.test(t)), `no pairs: ${(opened.labels || []).join(' | ')}`);
  await shot('06-attunement');
  const found = await page.evaluate(() => {
    const a = window.__imperial;
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Fire \+ Storm/.test(b.textContent));
    btn.click();
    return {
      discovered: [...a.game.modHost.mods.get('arcane').api.state.discovered],
      say: (document.getElementById('toasts') || {}).textContent || ''
    };
  });
  assert(found.discovered.includes('plasma'), `plasma was not discovered (${found.discovered.join(',')})`);
  return `found ${found.discovered.join(', ')}`;
});

/* ------------------------------------------------------------------ a cast */
await check('a ground spell hits what is standing there', async () => {
  const hit = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const u = g.units.find((x) => x.type === 'mage_ascendant');
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const spot = g.freeSpotNear(tc.x - 12, tc.z + 12, { radius: 0.5, def: { naval: false } }, 10);
    const victims = [];
    for (let i = 0; i < 4; i++) {
      const v = g.spawnUnitRaw('spearman', 2, spot[0] + i * 1.1, spot[1]);
      if (v) victims.push(v);
    }
    u.x = spot[0] - 7; u.z = spot[1];
    u.modState.arcane.mana = 225;
    g.selection = [u];
    a.ui.refreshCommands(true);
    gen: {
      const openBook = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Spells/.test(b.textContent));
      if (openBook) openBook.click();
    }
    const btn = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /Meteor/.test(b.textContent));
    if (!btn) return { labels: [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.textContent.trim()) };
    btn.click();
    const hp0 = victims.map((v) => v.hp);
    window.__look(spot[0], spot[1], 14, 0.46, 0.3);
    g.modHost.castAt(spot[0] + 1.5, spot[1], null);
    window.__stepSim(2.2);
    return { hp0, hp1: victims.map((v) => v.hp), labels: [] };
  });
  assert(!hit.labels.length, `the book had no Meteor: ${hit.labels.join(' | ')}`);
  const hurt = hit.hp1.filter((hp, i) => hp < hit.hp0[i]).length;
  assert(hurt >= 2, `the meteor hit ${hurt} of ${hit.hp0.length}`);
  await frame(2);
  await shot('07-meteor');
  return `${hurt} spearmen caught, ${hit.hp0[0]} → ${hit.hp1[0]}`;
});

/* ------------------------------------------------------------------ tidying */
await check('quitting a session leaves no magic behind', async () => {
  await page.evaluate(() => window.__imperial.quitToMenu());
  await wait(400);
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      host: a.game ? a.game.modHost : null,
      flash: a.renderer.flash,
      hud: document.getElementById('modHud').classList.contains('hidden'),
      body: document.body.classList.contains('mods')
    };
  });
  assert(!st.host, 'a mod host survived the menu');
  assert(st.flash === 0, `the flash survived the menu (${st.flash})`);
  assert(st.hud && !st.body, 'mod chrome survived the menu');
  return 'host gone, flash reset, chrome gone';
});

await check('nothing errored in the browser', async () => {
  const bad = consoleErrors.filter((t) => !/favicon|AudioContext|autoplay|Deprecation/i.test(t));
  assert(pageErrors.length === 0, 'page errors: ' + pageErrors.slice(0, 3).join(' | '));
  assert(bad.length === 0, 'console errors: ' + bad.slice(0, 3).join(' | '));
  return 'clean console';
});

await writeFile(join(OUT, 'report.md'), [
  '# The Arcane Order — browser report',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  '',
  failures ? `**${failures} failure(s)**` : `**all ${pass} checks passed**`
].join('\n'));

await browser.close();
server.close();
console.log(`\n${failures ? `MAGE BROWSER CHECKS FAILED (${failures})` : `MAGE BROWSER CHECKS PASSED (${pass})`} — shots in ${OUT}`);
process.exit(failures ? 1 : 0);
