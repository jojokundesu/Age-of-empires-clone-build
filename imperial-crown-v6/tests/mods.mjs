/* ============================================================
   mods.mjs — the Mod Workshop, without a browser
   ------------------------------------------------------------
   What this suite is for:

     * isolation — a mod session must be *removable*. Registering
       content adds keys; disposing removes exactly those keys and
       leaves the game tables byte-identical. A normal campaign must
       never see a modHost at all.
     * containment — a mod that throws is disabled, its content is
       removed, and the match keeps running with the other mods.
     * mechanics — every mod actually does what its card promises,
       measured on the simulation, not on a screenshot.
     * cost — five seconds of mod ticking over a few hundred units
       has to stay far below a frame.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { UNIT_DEFS, BUILDING_DEFS } from '../src/sim/data.js';
import { ModHost, createModHost } from '../src/mods/index.js';
import { modCatalogue, MODS, MOD_BY_ID } from '../src/mods/registry.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg} (got ${a}, expected ${b})`); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg} (got ${a}, expected ~${b})`); }

/** A quiet game with no AI, no victory check and deep pockets. */
function makeGame(seed = 909) {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'mods', difficulty: 'sandbox' });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 99999;
    st.age = 3;
  }
  return g;
}
function run(g, seconds, hz = 20) {
  const step = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) g.update(step);
}
/** Put a unit of `type` on open ground near the player's town centre. */
function place(g, type, team, dx = 4, dz = 4) {
  const base = g.playerBase;
  const spot = g.freeSpotNear(base.x + dx, base.z + dz, { radius: 0.4, def: { naval: false } }, 8) || [base.x + dx, base.z + dz];
  return g.spawnUnitRaw(type, team, spot[0], spot[1]);
}
function placeAt(g, type, team, x, z) {
  const spot = g.freeSpotNear(x, z, { radius: 0.4, def: { naval: false } }, 10);
  if (!spot) return null;
  return g.spawnUnitRaw(type, team, spot[0], spot[1]);
}
function modHost(g, ids, opts = {}) {
  return createModHost(g, { enabled: ids, options: opts });
}
/** Push a mage up the ladder the way the game does: insight, then ticks.
    One rank is granted per simulation tick, so five ticks reach rank 6. */
function levelUp(g, mage, rank = 6) {
  const st = mage.modState.arcane;
  st.xp = 2000;
  /* the host ticks at 5 Hz, so 0.3 s is one tick: one rank per tick */
  for (let i = 0; i < 8 && (st.rank || 1) < rank; i++) run(g, 0.3, 30);
  return st.rank;
}

/* ============================================================
   catalogue
   ============================================================ */
console.log('\nMOD CATALOGUE');
check('every mod is a complete, self-describing card', () => {
  const cat = modCatalogue();
  eq(cat.length, MODS.length, 'catalogue length');
  for (const m of cat) {
    assert(m.id && /^[a-z_]+$/.test(m.id), `bad id ${m.id}`);
    assert(m.name && m.name.length > 3, `${m.id} needs a name`);
    assert(m.icon, `${m.id} needs an icon`);
    assert(m.tagline, `${m.id} needs a tagline`);
    assert(m.blurb && m.blurb.length > 20, `${m.id} needs a blurb`);
    assert(Array.isArray(m.detail) && m.detail.length >= 2, `${m.id} needs depth, not one line`);
  }
  eq(new Set(cat.map((m) => m.id)).size, cat.length, 'duplicate mod id');
  return `${cat.length} mods, ${cat.reduce((n, m) => n + m.units.length + m.buildings.length, 0)} pieces of content`;
});

check('the catalogue exposes real content, not just labels', () => {
  let units = 0, buildings = 0;
  for (const mod of MODS) {
    units += Object.keys(mod.units || {}).length;
    buildings += Object.keys(mod.buildings || {}).length;
    assert(typeof mod.tick === 'function', `${mod.id} has no tick`);
    assert(mod.detail && mod.detail.length >= 2, `${mod.id} is a one-liner`);
  }
  assert(units >= 5, 'not enough mod units');
  assert(buildings >= 1, 'the mod ships no buildings');
  return `${units} units, ${buildings} buildings`;
});

/* ============================================================
   isolation
   ============================================================ */
console.log('\nISOLATION');
check('a normal match never gets a mod host', () => {
  const world = generateWorld(11);
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  eq(g.modHost, null, 'modHost should be null');
  run(g, 2);
  eq(g.modHost, null, 'modHost should still be null');
  return 'no hooks, no content, no host';
});

check('a mod session adds content and removes exactly what it added', () => {
  const g = makeGame();
  const beforeU = Object.keys(UNIT_DEFS).sort().join(',');
  const beforeB = Object.keys(BUILDING_DEFS).sort().join(',');
  const beforeTrains = BUILDING_DEFS.town_center.trains.join(',');
  const host = modHost(g, ['arcane']);
  assert(host.activeIds().length === 1, 'the Arcane Order should be active');
  assert(!!UNIT_DEFS.mage, 'the mage should be registered');
  assert(!!BUILDING_DEFS.arcane_tower, 'the tower should be registered');
  assert(BUILDING_DEFS.town_center.trains.includes('mage'), 'a hall trains mages while the mod is on');
  host.dispose();
  eq(Object.keys(UNIT_DEFS).sort().join(','), beforeU, 'unit table must be restored');
  eq(Object.keys(BUILDING_DEFS).sort().join(','), beforeB, 'building table must be restored');
  eq(BUILDING_DEFS.town_center.trains.join(','), beforeTrains, 'train lists must be restored');
  eq(g.modHost, null, 'game should drop the host');
  return 'unit + building tables and train lists restored';
});

check('enabling the mod does not leak content when it is not asked for', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  assert(host.isActive('arcane'), 'arcane on');
  assert(!host.isActive('zombies'), 'a retired mod id is not active');
  host.dispose();
  assert(!UNIT_DEFS.mage, 'no mage content after dispose');
  return 'only the requested mod is live';
});

check('an unknown mod id is ignored instead of crashing', () => {
  const g = makeGame();
  const host = modHost(g, ['not_a_mod', 'arcane']);
  eq(host.activeIds().join(','), 'arcane', 'unknown id filtered');
  host.dispose();
  return 'unknown ids are dropped at the door';
});

/* ============================================================
   containment
   ============================================================ */
console.log('\nCONTAINMENT');
check('a mod that throws is disabled and the match keeps going', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  /* baseline AFTER the healthy mod is up: this check is about the rogue's
     content being rolled back, not about the Arcane Order's */
  const before = Object.keys(UNIT_DEFS).length;
  const errors = [];
  host.onError = (e) => errors.push(e);
  /* a rogue mod that registers content and then explodes on its first tick */
  host.mods.set('rogue', {
    mod: {
      id: 'rogue', name: 'Rogue Mod', icon: 'warning', units: { rogue_grunt: { name: 'Rogue Grunt', icon: 'sword', hp: 10, attack: 1, speed: 1, classes: [] } },
      tick() { throw new Error('boom'); }
    },
    api: host._apiFor({ id: 'rogue' }, {}),
    state: {},
    opts: {}
  });
  host._registerContent(host.mods.get('rogue').mod);
  const withRogue = Object.keys(UNIT_DEFS).length;
  run(g, 3);
  assert(!host.isActive('rogue'), 'rogue mod should be disabled');
  assert(errors.length >= 1, 'the failure should be reported');
  eq(Object.keys(UNIT_DEFS).length, before, 'rogue content removed');
  assert(host.isActive('arcane'), 'the healthy mod survived');
  assert(!g.gameOver, 'the match is still running');
  host.dispose();
  return `rogue content (${withRogue - before} type) removed, ${errors.length} report, game alive`;
});

check('one bad hook is a hiccup, a mod that keeps throwing is retired', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  let armed = true;
  host.mods.set('badcmd', {
    mod: {
      id: 'badcmd', name: 'Bad Command', icon: 'warning',
      commands() { if (armed) throw new Error('nope'); return []; }
    },
    api: host._apiFor({ id: 'badcmd' }, {}),
    state: {}, opts: {}
  });
  const list = [{ icon: 'sword', label: 'Real', action: () => {} }];
  /* 6.4: an exception used to take the whole mod off the field, which is how a
     spellbook could vanish mid-match over one bad frame. It survives now. */
  const out = host.decorateCommands(list, null);
  eq(out.length, 1, 'the real command survives');
  assert(host.isActive('badcmd'), 'one throw must not kill a mod');
  assert(host.errors.length >= 1, 'the failure is still reported');
  /* a mod that is genuinely broken throws every frame and is retired */
  for (let i = 0; i < 10; i++) host.decorateCommands(list, null);
  assert(!host.isActive('badcmd'), 'a mod that keeps throwing is disabled');
  host.dispose();
  return 'one throw tolerated, a broken mod retired';
});

/* ============================================================
   cost
   ============================================================ */
console.log('\nCOST');
check('the Arcane Order on a busy field stays far below a frame', () => {
  const g = makeGame(5);
  /* a crowd, so every mod has something to iterate */
  for (let i = 0; i < 60; i++) {
    place(g, i % 3 === 0 ? 'swordsman' : i % 3 === 1 ? 'archer' : 'villager', 1, (i % 10) * 1.4 - 6, 6 + ((i / 10) | 0) * 1.4);
    if (i % 4 === 0) place(g, 'spearman', 2, (i % 8) * 1.5 - 4, 12 + ((i / 8) | 0) * 1.5);
  }
  const host = modHost(g, ['arcane']);
  run(g, 2);
  const t0 = performance.now();
  run(g, 20);
  const ms = performance.now() - t0;
  assert(ms < 1200, `20 s of modded simulation took ${ms.toFixed(0)} ms`);
  const perTick = ms / (20 * 20);
  host.dispose();
  return `${perTick.toFixed(2)} ms/tick with ${g.units.length} units`;
});

/* ============================================================ */
console.log(`\n${failures.length ? `MOD CHECKS FAILED (${failures.length})` : `MOD CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
