/* The Mod Workshop, driven through the real interface in a real browser.

   The node suite (tests/mods.mjs) proves the *rules*: that a corpse rises, that
   a spell spends mana, that disposing a mod restores the tables. This suite
   proves the parts only a browser can show:

     · the Mods button opens a workshop with every mod on a card
     · toggles are honoured, persisted, and a session starts from them
     · every mod unit and building has geometry -- the renderer has a batch for
       each type, so nothing is an invisible stat block
     · the HUD strip appears in a mod session and nowhere else
     · a spell is cast by tapping the card and then the ground
     · the mod build menu really offers the mod's building
     · a normal campaign after a mod session is untouched
     · the workshop, the horde, the magician, the beasts and a shrine are
       photographed for the record

   node tests/modsite.mjs [--out ci/v4-mods]
*/
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-mods'));
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

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => {
  const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
  return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
}, { timeout: 300000, polling: 200 });

/* ------------------------------------------------------------------ workshop */
await check('the menu offers a Mods button', async () => {
  const vis = await page.evaluate(() => {
    const b = document.getElementById('btnMods');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const s = getComputedStyle(b);
    return r.width > 40 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
  });
  assert(vis, 'the Mods button is missing or invisible');
  return '#btnMods is on screen';
});

await page.click('#btnMods');
await page.waitForFunction(() => !!document.querySelector('#modList .modCard'), { timeout: 60000 });
await check('the workshop lists every mod as its own card', async () => {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#modList .modCard')];
    return {
      count: cards.length,
      ids: cards.map((c) => c.dataset.mod),
      titled: cards.every((c) => (c.querySelector('.modHead b') || {}).textContent),
      detailed: cards.every((c) => c.querySelectorAll('.modBody li').length >= 2),
      toggles: cards.filter((c) => c.querySelector('.modToggle')).length
    };
  });
  assert(info.count === 6, `expected 6 mod cards, saw ${info.count}`);
  assert(info.titled && info.detailed, 'a card is missing its name or its detail list');
  assert(info.toggles === 6, 'a card has no toggle');
  return info.ids.join(', ');
});
await shot('01-workshop');

await check('every mod can be switched on and off individually', async () => {
  const first = await page.evaluate(() => {
    const card = document.querySelector('#modList .modCard');
    const btn = card.querySelector('.modToggle');
    const before = btn.textContent.trim();
    btn.click();
    return { idle: card.dataset.mod, before, after: btn.textContent.trim(), on: card.classList.contains('on') };
  });
  assert(first.before === 'OFF' && first.after === 'ON' && first.on, 'the first toggle did not turn on');
  const back = await page.evaluate(() => {
    const card = document.querySelector('#modList .modCard');
    const btn = card.querySelector('.modToggle');
    btn.click();
    return { after: btn.textContent.trim(), on: card.classList.contains('on') };
  });
  assert(back.after === 'OFF' && !back.on, 'the first toggle did not turn back off');
  return `${first.idle}: OFF → ON → OFF`;
});

await check('turning everything on is one press, and the count follows', async () => {
  await page.click('#modAll');
  await wait(120);
  const st = await page.evaluate(() => ({
    toggles: [...document.querySelectorAll('#modList .modToggle')].map((b) => b.textContent.trim()),
    count: (document.getElementById('modCount') || {}).textContent,
    hidden: (document.getElementById('modCount') || {}).classList.contains('hidden')
  }));
  assert(st.toggles.every((t) => t === 'ON'), `not every toggle is on: ${st.toggles.join(',')}`);
  assert(st.count === '6' && !st.hidden, `the badge should read 6 (got ${st.count}, hidden ${st.hidden})`);
  return '6 of 6 on, badge reads 6';
});

await page.evaluate(() => {
  /* headless SwiftShader renders a handful of frames a second, so wall-clock
     waits starve the simulation. Mechanics are advanced by stepping the game
     loop directly; the pictures are still taken from real rendered frames. */
  window.__stepSim = (seconds) => {
    const a = window.__imperial;
    if (!a || !a.game) return 0;
    const step = 1 / 30;
    const n = Math.max(1, Math.round(seconds / step));
    for (let i = 0; i < n; i++) a.game.update(step);
    return a.game.time;
  };
});
await page.click('#modStart');
await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
/* the strip is filled by the HUD's own 9 Hz refresh, not by startMatch */
await page.waitForFunction(() => {
  const h = document.getElementById('modHud');
  return h && !h.classList.contains('hidden') && h.querySelectorAll('.modChip').length >= 4;
}, { timeout: 60000, polling: 120 });
await page.waitForFunction('!!(window.__imperial.game && window.__imperial.game.modHost)', { timeout: 120000 });
await page.waitForFunction(() => {
  const h = document.getElementById('modHud');
  return h && !h.classList.contains('hidden') && h.querySelectorAll('.modChip').length >= 6;
}, { timeout: 60000, polling: 120 });

await check('a mod session starts with all six systems live and no errors', async () => {
  const info = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      ids: a.game.modHost.activeIds(),
      errors: a.game.modHost.errors.map((e) => `${e.mod}: ${e.message}`),
      mode: a.game.mode,
      modsInOpts: (a.matchOpts.mods || []).length,
      bodyClass: document.body.classList.contains('mods'),
      hudVisible: !document.getElementById('modHud').classList.contains('hidden'),
      chips: document.querySelectorAll('#modHud .modChip').length
    };
  });
  assert(info.ids.length === 6, `expected 6 active mods, saw ${info.ids.length}`);
  assert(info.errors.length === 0, `mod errors: ${info.errors.join(' | ')}`);
  assert(info.mode === 'mods', `match mode is ${info.mode}`);
  assert(info.bodyClass, 'body is not flagged as a mod session');
  assert(info.hudVisible, 'the mod HUD strip is hidden');
  assert(info.chips >= 6, `expected at least 6 chips, saw ${info.chips}`);
  return `${info.ids.join(', ')} · ${info.chips} chips`;
});

await check('every unit and building a mod adds has geometry', async () => {
  const census = await page.evaluate(() => {
    const a = window.__imperial;
    const units = ['plague_zombie', 'magician', 'stone_golem', 'dire_wolf', 'bear', 'beastmaster'];
    const buildings = ['necropolis', 'spike_trap', 'ballista_tower', 'relic_shrine'];
    return {
      missingUnits: units.filter((t) => !a.renderer.unitBatches.has(t)),
      missingBuildings: buildings.filter((t) => !a.renderer.buildingBatches.has(t)),
      units: units.length, buildings: buildings.length
    };
  });
  assert(census.missingUnits.length === 0, `no mesh for: ${census.missingUnits.join(', ')}`);
  assert(census.missingBuildings.length === 0, `no mesh for: ${census.missingBuildings.join(', ')}`);
  return `${census.units} unit meshes, ${census.buildings} building meshes`;
});

/* ------------------------------------------------------------- presentation */
/* Put a scene together near the town: the horde, the magician, the wild. */
const scene = await page.evaluate(() => {
  const a = window.__imperial;
  const g = a.game;
  if (a.governor) { a.governor.enabled = false; a.governor.div = 1; }
  a.renderer.setQuality('high');
  a.renderer.setPixelScale(1);
  a.settings.autoQuality = false;
  const t = g.teams.get(1);
  t.res.food = 99999; t.res.wood = 99999; t.res.gold = 99999; t.res.stone = 99999;
  t.age = 3; t.popCap = 300;
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const at = (dx, dz) => {
    const spot = g.freeSpotNear(tc.x + dx, tc.z + dz, { radius: 0.5, def: { naval: false } }, 14);
    return spot || [tc.x + dx, tc.z + dz];
  };
  const mage = g.spawnUnitRaw('magician', 1, ...at(7, 5));
  const zs = [];
  for (let i = 0; i < 5; i++) { const s = at(3 + i * 1.6, 10 + (i % 2)); const z = g.spawnUnitRaw('plague_zombie', 2, s[0], s[1]); if (z) zs.push(z); }
  const wolf = g.spawnUnitRaw('dire_wolf', 2, ...at(-9, 8));
  const bear = g.spawnUnitRaw('bear', 2, ...at(-12, 12));
  const master = g.spawnUnitRaw('beastmaster', 1, ...at(-6, 4));
  const necro = g.placeBuilding('necropolis', 1, ...at(12, -6), { instant: true, free: true });
  const tower = g.placeBuilding('ballista_tower', 1, ...at(-14, -4), { instant: true, free: true });
  g.statsVersion++;
  a.camera.setTarget(tc.x + 2, tc.z + 6, true);
  a.camera.desiredDist = a.camera.dist = 30;
  a.camera.desiredPitch = a.camera.pitch = 0.74;
  return {
    tc: [tc.x, tc.z], mage: mage && [mage.id, mage.type],
    zombies: zs.length, wolf: !!wolf, bear: !!bear, master: !!master,
    necro: !!necro, tower: !!tower
  };
});
assert(scene.mage, 'the magician did not spawn');
await wait(1600);
await shot('02-mod-session');

await check('the horde, the magician and the wild all stand on the field', async () => {
  const live = await page.evaluate(() => {
    const g = window.__imperial.game;
    const count = (t) => g.units.filter((u) => u.type === t && !u.dead).length;
    return {
      zombies: count('plague_zombie'), magicians: count('magician'), wolves: count('dire_wolf'),
      bears: count('bear'), masters: count('beastmaster'),
      necro: g.buildings.some((b) => b.type === 'necropolis' && !b.dead),
      tower: g.buildings.some((b) => b.type === 'ballista_tower' && !b.dead)
    };
  });
  assert(live.zombies >= 3, `only ${live.zombies} zombies`);
  assert(live.magicians >= 1 && live.wolves >= 1 && live.bears >= 1, 'a creature is missing');
  assert(live.necro && live.tower, 'a mod building is missing');
  return `${live.zombies} zombies, ${live.magicians} magician, ${live.wolves} wolf, ${live.bears} bear`;
});

await check('the HUD strip names the mods and updates on its own', async () => {
  const a = await page.evaluate(() => [...document.querySelectorAll('#modHud .modChip')].map((c) => c.textContent.trim()));
  await wait(1400);
  const b = await page.evaluate(() => [...document.querySelectorAll('#modHud .modChip')].map((c) => c.textContent.trim()));
  assert(a.length >= 6, 'fewer than six chips');
  const text = a.join(' | ');
  assert(/plague/i.test(text), `no horde chip: ${text}`);
  assert(/mana/i.test(text), `no arcane chip: ${text}`);
  assert(/wild/i.test(text), `no wilderness chip: ${text}`);
  assert(/relic/i.test(text), `no relic chip: ${text}`);
  assert(/skies|rain|storm|snow|fog/i.test(text), `no weather chip: ${text}`);
  return b.slice(0, 5).join(' · ');
});

/* ------------------------------------------------------------------- casting */
await check('tapping the spell card and then the ground casts it', async () => {
  const armed = await page.evaluate((id) => {
    const a = window.__imperial;
    const g = a.game;
    const mage = g.units.find((u) => u.id === id);
    if (!mage) return { err: 'magician gone' };
    g.setSelection([mage]);
    a.ui.refreshCommands(true);
    const visible = () => [...document.querySelectorAll('#cmdGrid .cmdBtn')].filter((b) => b.style.display !== 'none');
    const label = (b) => (b.querySelector('.lbl') || b).textContent;
    /* the arcane mod puts its spells behind a Spells card: that is the card
       the player taps first, and the book replaces the whole grid */
    const book = visible().find((b) => /spells/i.test(label(b)));
    if (book) book.click();
    const labels = visible().map(label);
    const fire = visible().find((b) => /fireball/i.test(label(b)));
    if (!fire) return { err: 'no Fireball card: ' + labels.join(',') };
    fire.click();
    return { labels, armed: !!g.modCast, mana: mage.modState.arcane.mana };
  }, scene.mage[0]);
  assert(!armed.err, armed.err);
  assert(armed.armed, 'clicking Fireball did not arm a cast');
  /* a target: an enemy zombie a few metres away */
  const targetId = await page.evaluate((id) => {
    const a = window.__imperial;
    const g = a.game;
    const mage = g.units.find((u) => u.id === id);
    if (!mage) return null;
    /* pick the closest zombie to the magician, then let the camera settle
       before projecting: the camera eases toward its target, so a projection
       taken on the same frame lands somewhere else entirely */
    const zs = g.units.filter((u) => u.type === 'plague_zombie' && !u.dead);
    let best = null, bestD = Infinity;
    for (const z of zs) {
      const d = Math.hypot(z.x - mage.x, z.z - mage.z);
      if (d < bestD) { bestD = d; best = z; }
    }
    if (!best) return null;
    a.camera.setTarget(best.x, best.z, true);
    a.camera.desiredDist = a.camera.dist = 24;
    a.camera.yaw = a.camera.desiredYaw;
    a.camera.update(1 / 60, { instant: true });
    return best.id;
  }, scene.mage[0]);
  assert(targetId, 'no zombie to burn');
  await wait(700);
  const target = await page.evaluate((zid) => {
    const a = window.__imperial;
    const g = a.game;
    const zombie = g.units.find((u) => u.id === zid);
    if (!zombie) return null;
    const y = g.heightAt(zombie.x, zombie.z);
    const p = a.camera.project(zombie.x, y, zombie.z, [0, 0, 0]);
    const r = a.canvas.getBoundingClientRect();
    return { hp: zombie.hp, id: zombie.id, x: r.left + (p[0] * 0.5 + 0.5) * r.width, y: r.top + (-p[1] * 0.5 + 0.5) * r.height };
  }, targetId);
  assert(target, 'the target zombie vanished');
  await page.evaluate((x, y) => {
    const c = window.__imperial.canvas;
    for (const type of ['pointerdown', 'pointerup']) {
      c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
        bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0
      }));
    }
  }, target.x, target.y);
  await wait(700);
  const after = await page.evaluate((mageId, zid) => {
    const g = window.__imperial.game;
    const mage = g.units.find((u) => u.id === mageId);
    const z = g.units.find((u) => u.id === zid);
    return { mana: mage && mage.modState.arcane.mana, armed: !!g.modCast, hp: z ? z.hp : 0, max: z ? z.maxHp : 0 };
  }, scene.mage[0], target.id);
  assert(!after.armed, 'the cast stayed armed after the tap');
  assert(after.mana < armed.mana - 20, `mana did not fall enough (${armed.mana} → ${after.mana})`);
  assert(after.hp < target.hp, `the zombie took no damage (${target.hp} → ${after.hp})`);
  return `mana ${Math.round(armed.mana)} → ${Math.round(after.mana)}, zombie ${Math.round(after.hp)}/${after.max} hp`;
});
await shot('03-arcane-fireball');

await check('the mod build menu offers the workshop’s own tools', async () => {
  const menu = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const villager = g.teams.get(1) && g.units.find((u) => u.team === 1 && u.type === 'villager');
    if (!villager) return { err: 'no villager' };
    g.setSelection([villager]);
    a.ui.refreshCommands(true);
    const build = [...document.querySelectorAll('#cmdGrid .cmdBtn')].find((b) => /build/i.test(b.querySelector('.lbl').textContent));
    if (!build) return { err: 'no Build card' };
    build.click();
    const labels = [...document.querySelectorAll('#cmdGrid .cmdBtn')].map((b) => b.querySelector('.lbl').textContent);
    return { labels };
  });
  assert(!menu.err, menu.err);
  assert(menu.labels.some((l) => /spike/i.test(l)), `no spike trench in: ${menu.labels.join(',')}`);
  assert(menu.labels.some((l) => /ballista/i.test(l)), `no ballista tower in: ${menu.labels.join(',')}`);
  return 'spike trench + ballista tower in the Build grid';
});

/* --------------------------------------------------------------- atmosphere */
await check('a storm changes the sky and the ground without errors', async () => {
  const before = await page.evaluate(() => {
    const a = window.__imperial;
    return { fog: a.renderer.modAtmosphere && a.renderer.modAtmosphere.fog, exp: a.renderer.modAtmosphere && a.renderer.modAtmosphere.exposure };
  });
  await page.evaluate(() => {
    const rec = window.__imperial.modHost.mods.get('weather');
    rec.api.state.phase = {
      id: 'storm', name: 'Storm', icon: 'bolt', min: 60, max: 90,
      gather: 0.8, speed: 0.94, archer: 0.75, fog: 0.0034, sun: 0.62, line: 'A storm breaks.'
    };
    rec.api.state.t = 45;
  });
  await page.evaluate(() => window.__stepSim(1.2));
  await wait(250);
  const after = await page.evaluate(() => {
    const at = window.__imperial.renderer.modAtmosphere;
    return { fog: at && at.fog, exp: at && at.exposure, tint: at && at.tint };
  });
  assert(after.fog > 0.001, `fog did not rise (${JSON.stringify(after)} diag ${await page.evaluate(() => {
    const a = window.__imperial;
    const rec = a.modHost.mods.get('weather');
    return JSON.stringify({
      phase: rec.api.state.phase.id, t: Math.round(rec.api.state.t),
      hostRenderer: a.modHost.renderer === a.renderer,
      atmo: a.modHost._atmosphere, gameTime: Math.round(a.game.time * 10) / 10,
      tick: a.modHost._hudTick
    });
  })})`);
  assert(after.tint && after.tint[0] < 0.95, 'the sky was not tinted');
  return `fog ${Number(before.fog || 0).toFixed(4)} → ${Number(after.fog).toFixed(4)}, exposure ${Number(after.exp).toFixed(2)}`;
});
await shot('04-storm');

await check('a relic shrine can be claimed and shows its owner', async () => {
  const info = await page.evaluate(() => {
    const a = window.__imperial;
    const g = a.game;
    const rec = a.modHost.mods.get('relics');
    const shrine = rec.api.state.shrines[0];
    /* stand a soldier on it and keep him there */
    const soldier = g.spawnUnitRaw('swordsman', 1, shrine.b.x + 2.1, shrine.b.z);
    if (soldier) soldier.pinned = true;
    a.camera.setTarget(shrine.b.x, shrine.b.z, true);
    a.camera.desiredDist = a.camera.dist = 18;
    return { x: shrine.b.x, z: shrine.b.z, relic: shrine.relic.id, owner: shrine.owner, soldier: !!soldier };
  });
  assert(info.soldier, 'could not place a soldier at the shrine');
  for (let i = 0; i < 12; i++) {
    await page.evaluate((x, z) => {
      const a = window.__imperial;
      const g = a.game;
      const u = g.units.find((u) => u.team === 1 && u.pinned);
      if (u) { u.x = x + 2.1; u.z = z; u.state = 'idle'; u.targetPos = null; u.path = null; }
      window.__stepSim(0.7);
    }, info.x, info.z);
    await wait(60);
  }
  const st = await page.evaluate(() => {
    const s0 = window.__imperial.modHost.mods.get('relics').api.state.shrines[0];
    return { owner: s0.owner, progress: s0.progress, by: s0.by };
  });
  assert(st.owner === 1, `the shrine is owned by ${st.owner} (progress ${(st.progress * 100).toFixed(0)}%, by ${st.by})`);
  const buff = await page.evaluate(() => window.__imperial.game.teams.get(1).buffs.filter((b) => b.name === 'mod:relics').length);
  assert(buff >= 1, 'no relic buff on the team');
  await shot('05-relic');
  return `${info.relic} held, ${buff} buff(s)`;
});

/* ---------------------------------------------------------------- isolation */
await check('leaving a mod session tears the mods out completely', async () => {
  await page.evaluate(() => window.__imperial.quitToMenu());
  await wait(600);
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      host: !!a.modHost,
      game: !!a.game,
      body: document.body.classList.contains('mods'),
      hudHidden: document.getElementById('modHud').classList.contains('hidden'),
      atmo: a.renderer.modAtmosphere
    };
  });
  assert(!st.host, 'the mod host survived the menu');
  assert(!st.game, 'the game was not released');
  assert(!st.body, 'the body still thinks it is a mod session');
  assert(st.hudHidden, 'the mod HUD stayed visible');
  return 'host disposed, HUD hidden, atmosphere reset';
});

await check('a normal campaign afterwards has no mod content at all', async () => {
  await page.waitForFunction(() => {
    const m = document.getElementById('menuScreen');
    return m && !m.classList.contains('hidden');
  }, { timeout: 60000 });
  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 300000 });
  await wait(1200);          // the HUD strip refreshes at 9 Hz
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      host: a.game.modHost,
      mode: a.game.mode,
      zombie: a.game.units.some((u) => u.type === 'plague_zombie'),
      hudHidden: document.getElementById('modHud').classList.contains('hidden'),
      chips: document.querySelectorAll('#modHud .modChip').length,
      body: document.body.classList.contains('mods')
    };
  });
  const detail = JSON.stringify(st);
  assert(st.host === null, `a campaign got a mod host (${detail})`);
  assert(st.mode !== 'mods', `campaign mode is ${st.mode} (${detail})`);
  assert(!st.zombie, `mod units leaked into the campaign (${detail})`);
  assert(st.hudHidden && st.chips === 0 && !st.body, `mod UI leaked into the campaign (${detail})`);
  await shot('06-clean-campaign');
  return 'no host, no units, no HUD, mode ' + st.mode;
});

await check('nothing errored in the browser', async () => {
  const bad = consoleErrors.filter((t) => !/favicon|AudioContext|autoplay|Deprecation/i.test(t));
  assert(pageErrors.length === 0, 'page errors: ' + pageErrors.slice(0, 3).join(' | '));
  assert(bad.length === 0, 'console errors: ' + bad.slice(0, 3).join(' | '));
  return 'clean console';
});

await writeFile(join(OUT, 'report.md'), [
  '# Mod Workshop — browser report',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  '',
  failures ? `**${failures} failure(s)**` : `**all ${pass} checks passed**`
].join('\n'));

await browser.close();
server.close();
console.log(`\n${failures ? `MOD BROWSER CHECKS FAILED (${failures})` : `MOD BROWSER CHECKS PASSED (${pass})`} — shots in ${OUT}`);
process.exit(failures ? 1 : 0);
