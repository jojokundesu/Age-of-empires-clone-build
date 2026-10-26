/* ============================================================
   courtsite.mjs — the Court of Offices, through the real interface
   ------------------------------------------------------------
   tests/court.mjs proves the simulation: the aura, the deed, the writ,
   the mourning. This suite proves the parts only a rendered frame and a
   real tap can show:

     · the Court button is in the top bar and opens on a phone-sized HUD;
     · the four offices say why they are closed in the Dark Age;
     · the appointment is armed by a button and *completed by a tap on a
       man on the battlefield* — no invisible state, no drag;
     · the writs land on the field with a visual (a march, a mark, a heal);
     · a rank III Marshal is worth looking at, and his death empties the
       office and takes a rank with it;
     · the save carries the court, the AI fills its own court, and quitting
       leaves nothing behind.

   node tests/courtsite.mjs [--out ci/v4-court]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-court'));
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
  /* a unit's centre in CSS pixels, so the suite can tap it like a player */
  window.__screenOf = (u) => {
    const a = window.__imperial;
    const out = a.camera.project(u.x, u.y + 0.9, u.z, [0, 0, 0]);
    return [Math.round((out[0] * 0.5 + 0.5) * window.innerWidth), Math.round((0.5 - out[1] * 0.5) * window.innerHeight)];
  };
});

/* ------------------------------------------------------------------ campaign */
await page.evaluate(() => window.__imperial.startMatch({
  mode: 'campaign', civ: 'franks', difficulty: 'standard', seed: 909,
  quality: 'medium', music: false, sound: false
}));
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.court)', { timeout: 60000 });

await check('the Court has a door in the top bar, and no badge in peacetime', async () => {
  const st = await page.evaluate(() => {
    const b = document.getElementById('btnCourt');
    const badge = document.getElementById('courtBadge');
    return {
      exists: !!b,
      visible: b ? getComputedStyle(b).display !== 'none' : false,
      badge: badge ? badge.style.display : 'missing',
      age: window.__imperial.game.teams.get(1).age
    };
  });
  assert(st.exists, 'no Court button');
  assert(st.visible, 'the Court button is hidden');
  assert(st.age === 0, 'a campaign starts in the Dark Age');
  return 'Dark Age, four offices closed';
});

await check('the Dark Age court explains itself', async () => {
  const panel = await page.evaluate(() => {
    const a = window.__imperial;
    a.ui.openCourt();
    const rows = [...document.querySelectorAll('#modalBody .courtRow')];
    const text = document.getElementById('modalBody').textContent;
    return {
      rows: rows.length,
      locked: rows.filter((r) => r.classList.contains('locked')).length,
      unlocks: (text.match(/Unlocks in the (Feudal|Castle) Age/g) || []).length,
      title: document.getElementById('modalTitle')?.textContent || '',
      appoint: document.querySelectorAll('#modalBody [data-appoint]').length
    };
  });
  assert(panel.rows === 4, `four offices, got ${panel.rows}`);
  assert(panel.locked === 4, `all four are closed in the Dark Age (${panel.locked})`);
  assert(panel.unlocks === 4, `every row says why (${panel.unlocks})`);
  assert(panel.appoint === 0, 'a locked office offers no appointment');
  await frame(2);
  await shot('01-court-dark');
  await page.evaluate(() => window.__imperial.menu.closeModal());
  return '4 rows, all locked, all explained';
});

await check('in the Feudal Age the offices are open and the badge counts them', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const t = a.game.teams.get(1);
    t.age = 1;
    t.res.gold = t.res.wood = t.res.food = t.res.stone = 4000;
    t.favor = 300;
    a.game.statsVersion++;
    a.ui.update(0.2, true);
    a.ui.openCourt();
    const rows = [...document.querySelectorAll('#modalBody .courtRow')];
    return {
      open: rows.filter((r) => !r.classList.contains('locked')).length,
      appoint: document.querySelectorAll('#modalBody [data-appoint]').length,
      badge: document.getElementById('courtBadge').textContent,
      badgeShown: document.getElementById('courtBadge').style.display !== 'none'
    };
  });
  assert(st.open === 2, `the two Feudal offices are open (${st.open})`);
  assert(st.appoint === 2, `two appointments offered (${st.appoint})`);
  assert(st.badgeShown && st.badge === '2', `the badge should read 2 (${st.badge}, shown ${st.badgeShown})`);
  await frame(2);
  await shot('02-court-feudal');
  return 'Marshal and Chancellor open, badge 2';
});

await check('an appointment is armed by the panel and finished by a tap on a man', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    a.menu.closeModal();
    const g = a.game;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const spot = g.freeSpotNear(tc.x + 9, tc.z + 9, { radius: 0.8, def: {} }, 8) || [tc.x + 9, tc.z + 9];
    const k = g.spawnUnitRaw('knight', 1, spot[0], spot[1]);
    /* the spatial hash only learns about him on the next tick — a tap before
       that would fall back to the full unit list */
    for (let i = 0; i < 4; i++) g.update(1 / 30);
    window.__look(k.x, k.z, 11, 0.34, 0.3);
    const screen = window.__screenOf(k);
    g.selection = [k];
    a.ui.refreshCommands(true);
    a.ui.openCourt();
    const btn = document.querySelector('#modalBody [data-appoint="marshal"]');
    if (!btn) return { noButton: true };
    btn.click();
    const armed = g.courtArmed ? g.courtArmed.office : null;
    const modalGone = document.getElementById('modalScreen').classList.contains('hidden');
    return { armed, modalGone, screen, id: k.id, gold: g.teams.get(1).res.gold };
  });
  assert(!st.noButton, 'no Marshal appointment button');
  assert(st.armed === 'marshal', `the panel did not arm the appointment (${st.armed})`);
  assert(st.modalGone, 'the modal stayed over the battlefield');
  /* the camera is easing under the frame loop, so the finger has to be placed
     on where the man is *now*, exactly as a player's eye would */
  await frame(2);
  const screen = await page.evaluate((id) => {
    const k = window.__imperial.game.units.find((u) => u.id === id);
    return k ? window.__screenOf(k) : null;
  }, st.id);
  assert(screen, 'the knight vanished');
  await page.evaluate(([x, y]) => window.__imperial.input.tap(x, y), screen);
  await wait(200);
  const after = await page.evaluate(([sx, sy, id]) => {
    const g = window.__imperial.game;
    const a = window.__imperial;
    const rec = g.court.office(1, 'marshal');
    const k = g.units.find((u) => u.id === id);
    const hit = a.input.pick(sx, sy);
    return {
      holder: rec.holder ? rec.holder.type : null,
      office: rec.holder ? rec.holder.courtOffice : null,
      gold: g.teams.get(1).res.gold,
      armed: !!g.courtArmed,
      alive: k ? !k.dead : false,
      pos: k ? [k.x, k.z] : null,
      screenNow: k ? window.__screenOf(k) : null,
      hit: hit ? `${hit.kind}:${hit.type}:${hit.team}` : null,
      toast: [...document.querySelectorAll('#toastLayer .toast')].map((n) => n.textContent).join(' | ')
    };
  }, [screen[0], screen[1], st.id]);
  assert(after.holder === 'knight', `the tap did not appoint the knight (${after.holder}) · alive ${after.alive} · hit ${after.hit} · at ${JSON.stringify(after.pos)} vs screen ${JSON.stringify(after.screenNow)} · ${after.toast}`);
  assert(after.office === 'marshal', 'the knight did not take the office');
  assert(after.gold < st.gold, 'the appointment was free');
  assert(!after.armed, 'the arming survived the tap');
  return `knight raised, ${st.gold} → ${after.gold} gold`;
});

await check('the Marshal is visible on the field and in the HUD', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const rec = g.court.office(1, 'marshal');
    const u = rec.holder;
    u.anim.phase = 0.4;
    window.__look(u.x, u.z, 9, 0.32, 0.25);
    g.selection = [u];
    a.ui.refreshCommands(true);
    a.ui.last = a.ui.last || {};
    a.ui.sig = '';
    a.ui.refreshCommands(true);
    return { x: u.x, z: u.z, name: u.def.name };
  });
  await frame(4);
  await shot('03-marshal-field');
  const hud = await page.evaluate(() => {
    const el = document.getElementById('inspName');
    return { name: el ? el.textContent : '', sub: document.getElementById('inspSub')?.textContent || '' };
  });
  assert(/knight|marshal/i.test(st.name), 'no knight to photograph');
  assert(hud.sub.length > 0, 'the inspector shows nothing for the officer');
  return `${hud.name} · ${hud.sub.slice(0, 60)}`;
});

await check('Forced March is a real speed buff with a card that reflects it', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const holder = g.court.office(1, 'marshal').holder;
    const soldier = g.units.find((u) => u.team === 1 && u.type === 'knight' && u !== holder) ||
      g.spawnUnitRaw('knight', 1, holder.x + 2, holder.z + 2);
    soldier.x = holder.x + 2; soldier.z = holder.z + 2;
    const before = g.unitSpeedMul(soldier);
    a.ui.openCourt();
    const btn = document.querySelector('#modalBody [data-writ="marshal"]');
    if (!btn) return { noButton: true, labels: document.getElementById('modalBody').textContent.slice(0, 200) };
    btn.click();
    const rec = g.court.office(1, 'marshal');
    return {
      before,
      after: g.unitSpeedMul(soldier),
      buffUntil: rec.buffUntil,
      time: g.time,
      cooldown: g.court.writ(1, 'marshal').cooldown,
      ready: g.court.writ(1, 'marshal').ready
    };
  });
  assert(!st.noButton, `no Forced March button (${st.labels || ''})`);
  assert(st.after > st.before + 0.2, `the march did not speed the line (${st.before} → ${st.after})`);
  assert(st.buffUntil > st.time, 'the march has no duration');
  assert(!st.ready && st.cooldown > 60, `the writ is not on cooldown (${st.cooldown})`);
  await page.evaluate(() => window.__imperial.menu.closeModal());
  await frame(2);
  return `${st.before.toFixed(2)} → ${st.after.toFixed(2)} speed, cd ${st.cooldown | 0}s`;
});

await check('a rank III Marshal mends his line, and the panel says so', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    g.court.deed(1, 'marshal', 260);
    const rec = g.court.office(1, 'marshal');
    const holder = rec.holder;
    const hurt = g.units.find((u) => u.team === 1 && u.type === 'knight' && u !== holder) || holder;
    hurt.x = holder.x + 2; hurt.z = holder.z + 3;
    hurt.hp = hurt.maxHp * 0.5;
    const hp0 = hurt.hp;
    window.__stepSim(4);
    a.ui.openCourt();
    const row = document.querySelector('#modalBody [data-office-row="marshal"]');
    const text = row ? row.textContent : '';
    return { rank: g.court.rank(1, 'marshal'), hp0, hp1: hurt.hp, text: text.replace(/\s+/g, ' ').trim() };
  });
  assert(st.rank === 3, `the Marshal should be rank III (${st.rank})`);
  assert(st.hp1 > st.hp0, `rank III does not mend (${st.hp0} → ${st.hp1})`);
  assert(/rank iii/i.test(st.text), `the panel does not say rank III: ${st.text.slice(0, 120)}`);
  await frame(2);
  await shot('04-rank-iii');
  await page.evaluate(() => window.__imperial.menu.closeModal());
  return `rank III, ${(st.hp1 - st.hp0).toFixed(1)} hp mended`;
});

await check('all four offices can stand in a line with their sigils', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const t = g.teams.get(1);
    t.age = 2;
    t.res.gold = 4000; t.favor = 400;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const cx = tc.x + 14, cz = tc.z + 20;
    const casts = [
      ['marshal', 'knight', 320],       // rank III
      ['chancellor', 'villager', 60],   // rank II
      ['spymaster', 'archer', 5],       // rank I
      ['hierophant', 'monk', 150]
    ];
    const made = [];
    for (let i = 0; i < casts.length; i++) {
      const [office, type, deeds] = casts[i];
      const spot = g.freeSpotNear(cx - 6 + i * 4, cz, { radius: 0.8, def: {} }, 10) || [cx - 6 + i * 4, cz];
      const u = g.spawnUnitRaw(type, 1, spot[0], spot[1]);
      if (!u) { made.push({ office, ok: false }); continue; }
      u.facing = 0.2; u.anim.phase = i * 0.9;
      const res = g.court.appoint(1, office, u);
      if (res.ok && deeds) g.court.deed(1, office, deeds);
      made.push({ office, ok: res.ok, rank: g.court.rank(1, office), type });
    }
    for (let i = 0; i < 4; i++) g.update(1 / 30);
    window.__look(cx, cz, 17, 0.34, 2.45);
    g.setSelection(made.length ? g.units.filter((u) => u.courtOffice) : []);
    a.ui.refreshCommands(true);
    return { made, holders: made.filter((m) => m.ok).length };
  });
  assert(st.holders === 4, `only ${st.holders} offices filled: ${JSON.stringify(st.made)}`);
  assert(st.made[0].rank === 3 && st.made[1].rank === 2 && st.made[2].rank === 1,
    `ranks are wrong: ${st.made.map((m) => m.rank).join(',')}`);
  await frame(5);
  await shot('07-officers');
  await page.evaluate(() => {
    const a = window.__imperial;
    const u = a.game.units.find((x) => x.courtOffice === 'marshal');
    window.__look(u.x, u.z, 9, 0.22, 2.2);
  });
  await frame(4);
  await shot('08-marshal-sigil');
  const colors = await page.evaluate(() => {
    const g = window.__imperial.game;
    const out = [];
    g.court.eachHolder((u, o, r) => out.push(`${o.id}:${r}`));
    return out;
  });
  return colors.join(' ');
});

await check('Whisper arms on a card and marks the enemy you tap', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const t = g.teams.get(1);
    t.age = 2;
    t.favor = 300;
    const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const spot = g.freeSpotNear(tc.x - 12, tc.z + 12, { radius: 0.8, def: {} }, 8) || [tc.x - 12, tc.z + 12];
    const spy = g.spawnUnitRaw('archer', 1, spot[0] - 2.5, spot[1]);
    const enemy = g.spawnUnitRaw('spearman', 2, spot[0] + 1.5, spot[1]);
    enemy.noAggro = true;
    if (spy) { spy.noAggro = true; spy.stance = 'stand'; }
    const res = g.court.appoint(1, 'spymaster', spy);
    for (let i = 0; i < 4; i++) g.update(1 / 30);
    window.__look(spot[0], spot[1], 10, 0.36, 0.3);
    a.ui.openCourt();
    const btn = document.querySelector('#modalBody [data-writ="spymaster"]');
    if (!btn) return { noButton: true, text: document.getElementById('modalBody').textContent.slice(0, 200) };
    btn.click();
    const armed = g.courtWrit ? g.courtWrit.office : null;
    const screen = window.__screenOf(enemy);
    const hit = a.input.pick(screen[0], screen[1]);
    return { ok: res.ok, armed, screen, id: enemy.id, alive: !enemy.dead, hit: hit ? `${hit.kind}:${hit.type}` : null };
  });
  assert(st.ok, 'the spymaster could not be appointed');
  assert(!st.noButton, `no Whisper button (${st.text || ''})`);
  assert(st.armed === 'spymaster', `the whisper did not arm (${st.armed})`);
  assert(st.hit === 'unit:spearman', `the enemy is not under the finger (${st.hit})`);
  await page.evaluate(([x, y]) => window.__imperial.input.tap(x, y), st.screen);
  await wait(200);
  const after = await page.evaluate((id) => {
    const g = window.__imperial.game;
    const e = g.units.find((u) => u.id === id);
    return { marked: e ? e.markedBy : null, until: e ? e.markedUntil : 0, time: g.time, armed: !!g.courtWrit };
  }, st.id);
  assert(after.marked === 1, `the spearman was not marked (${after.marked})`);
  assert(after.until > after.time, 'the mark has no lifetime');
  assert(!after.armed, 'the whisper stayed armed');
  await frame(2);
  await shot('05-whisper');
  return 'spearman marked for 40 s';
});

await check('the office dies with its holder, and mourns before it reopens', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const rec = g.court.office(1, 'marshal');
    const holder = rec.holder;
    const rank0 = rec.rank;
    holder.kill(null);
    window.__stepSim(0.6);
    const after = g.court.office(1, 'marshal');
    a.ui.openCourt();
    const row = document.querySelector('#modalBody [data-office-row="marshal"]');
    const text = row ? row.textContent.replace(/\s+/g, ' ').trim() : '';
    const btn = document.querySelector('#modalBody [data-appoint="marshal"]');
    return {
      rank0, rank1: after.rank, holder: after.holder,
      vacant: after.vacantUntil - g.time, text,
      disabled: btn ? btn.hasAttribute('disabled') : null
    };
  });
  assert(st.holder === null, 'the office still has a holder');
  assert(st.rank1 < st.rank0, `the office kept its rank (${st.rank0} → ${st.rank1})`);
  assert(st.vacant > 20, `the office should mourn for ~25 s (${st.vacant.toFixed(1)})`);
  assert(/mourning/i.test(st.text), `the panel does not mourn: ${st.text.slice(0, 120)}`);
  assert(st.disabled === true, 'the appointment is not disabled during mourning');
  await frame(2);
  await shot('06-mourning');
  await page.evaluate(() => window.__imperial.menu.closeModal());
  return `rank ${st.rank0} → ${st.rank1}, ${st.vacant.toFixed(0)}s of mourning`;
});

await check('the court is in the save file', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    a.saveMatch();
    const raw = localStorage.getItem('imperial-crown-save-v3') || localStorage.getItem('imperial-crown-save') || '';
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    return { has: !!raw, court: data && data.court ? Object.keys(data.court) : null, length: raw.length };
  });
  assert(st.has, 'nothing was written to the save slot');
  assert(st.court && st.court.length === 2, `the save has no court (${st.court})`);
  return `save ${(st.length / 1024).toFixed(1)} kB with both courts`;
});

await check('the AI fills its own court', async () => {
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const t = g.teams.get(2);
    t.age = 2;
    t.res.gold = 4000; t.res.food = 4000; t.res.wood = 4000; t.favor = 300;
    const base = g.enemyBase;
    for (let i = 0; i < 6; i++) g.spawnUnitRaw('knight', 2, base.x + 3 + i * 2, base.z + 3);
    for (let i = 0; i < 3; i++) g.spawnUnitRaw('villager', 2, base.x + 3 + i, base.z + 8);
    for (let i = 0; i < 2; i++) g.spawnUnitRaw('monk', 2, base.x + 4 + i, base.z + 11);
    for (let i = 0; i < 30; i++) { window.__stepSim(0.4); a.ai && a.ai.update(0.4); }
    const held = ['marshal', 'chancellor', 'spymaster', 'hierophant']
      .filter((id) => g.court.holder(2, id));
    return { held, ai: !!a.ai, errors: g.court.errors || [] };
  });
  assert(st.ai, 'no AI controller in a campaign');
  assert(st.held.includes('marshal'), `the AI appointed no Marshal (${st.held.join(',')})`);
  assert(st.held.length >= 2, `the AI court is too thin (${st.held.join(',')})`);
  return st.held.join(', ');
});

/* ------------------------------------------------------------------ tidying */
await check('quitting leaves no court behind', async () => {
  await page.evaluate(() => window.__imperial.quitToMenu());
  await wait(400);
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      game: !!a.game,
      armed: a.game ? !!a.game.courtArmed : false,
      modal: document.getElementById('modalScreen').classList.contains('hidden')
    };
  });
  assert(!st.game, 'the game survived the menu');
  assert(st.modal, 'the court modal survived the menu');
  return 'game gone, modal closed';
});

await check('nothing errored in the browser', async () => {
  const bad = consoleErrors.filter((t) => !/favicon|AudioContext|autoplay|Deprecation/i.test(t));
  assert(pageErrors.length === 0, 'page errors: ' + pageErrors.slice(0, 3).join(' | '));
  assert(bad.length === 0, 'console errors: ' + bad.slice(0, 3).join(' | '));
  return 'clean console';
});

await writeFile(join(OUT, 'report.md'), [
  '# The Court of Offices — browser report',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  '',
  failures ? `**${failures} failure(s)**` : `**all ${pass} checks passed**`
].join('\n'));

await browser.close();
server.close();
console.log(`\n${failures ? `COURT BROWSER CHECKS FAILED (${failures})` : `COURT BROWSER CHECKS PASSED (${pass})`} — shots in ${OUT}`);
process.exit(failures ? 1 : 0);
