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
  assert(buildings >= 4, 'not enough mod buildings');
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
  const host = modHost(g, ['zombies', 'arcane', 'artificer', 'relics']);
  assert(host.activeIds().length === 4, 'four mods should be active');
  assert(!!UNIT_DEFS.plague_zombie, 'zombie should be registered');
  assert(!!BUILDING_DEFS.necropolis, 'necropolis should be registered');
  assert(BUILDING_DEFS.necropolis.trains.includes('plague_zombie'), 'necropolis trains zombies');
  host.dispose();
  eq(Object.keys(UNIT_DEFS).sort().join(','), beforeU, 'unit table must be restored');
  eq(Object.keys(BUILDING_DEFS).sort().join(','), beforeB, 'building table must be restored');
  eq(BUILDING_DEFS.town_center.trains.join(','), beforeTrains, 'train lists must be restored');
  eq(g.modHost, null, 'game should drop the host');
  return 'unit + building tables and train lists restored';
});

check('enabling one mod does not drag in another', () => {
  const g = makeGame();
  const host = modHost(g, ['weather']);
  assert(host.isActive('weather'), 'weather on');
  assert(!host.isActive('zombies'), 'zombies off');
  assert(!UNIT_DEFS.plague_zombie, 'no zombie content');
  assert(!BUILDING_DEFS.necropolis, 'no necropolis content');
  host.dispose();
  return 'only the requested mod is live';
});

check('an unknown mod id is ignored instead of crashing', () => {
  const g = makeGame();
  const host = modHost(g, ['not_a_mod', 'weather']);
  eq(host.activeIds().join(','), 'weather', 'unknown id filtered');
  host.dispose();
  return 'unknown ids are dropped at the door';
});

/* ============================================================
   containment
   ============================================================ */
console.log('\nCONTAINMENT');
check('a mod that throws is disabled and the match keeps going', () => {
  const g = makeGame();
  const before = Object.keys(UNIT_DEFS).length;
  const host = modHost(g, ['weather']);
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
  assert(host.isActive('weather'), 'the healthy mod survived');
  assert(!g.gameOver, 'the match is still running');
  host.dispose();
  return `rogue content (${withRogue - before} type) removed, ${errors.length} report, game alive`;
});

check('a mod that throws inside a command cannot swallow the click', () => {
  const g = makeGame();
  const host = modHost(g, ['weather']);
  host.mods.set('badcmd', {
    mod: {
      id: 'badcmd', name: 'Bad Command', icon: 'warning',
      commands() { throw new Error('nope'); }
    },
    api: host._apiFor({ id: 'badcmd' }, {}),
    state: {}, opts: {}
  });
  const list = [{ icon: 'sword', label: 'Real', action: () => {} }];
  const out = host.decorateCommands(list, null);
  eq(out.length, 1, 'the real command survives');
  assert(!host.isActive('badcmd'), 'the broken one is disabled');
  host.dispose();
  return 'command cards still work';
});

/* ============================================================
   zombies
   ============================================================ */
console.log('\nPLAGUE OF THE DEAD');
check('the dead rise for the side that killed them', () => {
  const g = makeGame();
  const host = modHost(g, ['zombies']);
  const killer = placeAt(g, 'swordsman', 2, g.playerBase.x + 9, g.playerBase.z);
  assert(killer, 'killer spawned');
  run(g, 0.5);
  /* a plain corpse rises on a roll, so the check needs a handful of them */
  for (let i = 0; i < 10; i++) {
    const victim = placeAt(g, 'swordsman', 1, g.playerBase.x + 6 + (i % 3), g.playerBase.z + 2 + (i % 2));
    if (victim) victim.kill(killer);
  }
  run(g, 6);
  const risen = g.units.filter((u) => u.type === 'plague_zombie');
  assert(risen.length >= 1, 'a zombie should have risen');
  eq(risen[0].team, 2, 'it should answer to the killer');
  host.dispose();
  return `${risen.length} risen for team ${risen[0].team}`;
});

check('three bites make a carrier, and a carrier always rises', () => {
  const g = makeGame();
  const host = modHost(g, ['zombies']);
  const zombie = place(g, 'plague_zombie', 2, 5, 0);
  const soldier = place(g, 'swordsman', 1, 7, 0);
  assert(zombie && soldier, 'spawned');
  run(g, 0.3);
  for (let i = 0; i < 3; i++) soldier.takeDamage(5, zombie, 'melee');
  const st = soldier.modState && soldier.modState.zombies;
  assert(st && st.carrier, 'three bites should infect');
  soldier.kill(zombie);
  run(g, 5);
  const risen = g.units.filter((u) => u.type === 'plague_zombie');
  assert(risen.length >= 2, `a carrier must always rise (zombies: ${risen.length})`);
  host.dispose();
  return `${risen.length} zombies, carrier guaranteed`;
});

check('the horde is capped instead of snowballing forever', () => {
  const g = makeGame();
  const host = modHost(g, ['zombies']);
  const killer = place(g, 'swordsman', 2, 8, 0);
  assert(killer, 'killer spawned');
  for (let i = 0; i < 60; i++) {
    const v = place(g, 'swordsman', 1, 4 + (i % 5), 3 + (i % 3));
    if (v) v.kill(killer);
    run(g, 0.45);
  }
  run(g, 6);
  const z = g.units.filter((u) => u.type === 'plague_zombie' && u.team === 2).length;
  assert(z <= 32, `zombie cap broken (${z})`);
  host.dispose();
  return `${z} zombies after 60 corpses — capped`;
});

check('a necropolis raises zombies on its own', () => {
  const g = makeGame();
  const host = modHost(g, ['zombies']);
  const base = g.playerBase;
  const b = g.placeBuilding('necropolis', 1, base.x + 14, base.z + 6, { instant: true, free: true });
  assert(b, 'necropolis placed');
  run(g, 48);
  const z = g.units.filter((u) => u.type === 'plague_zombie' && u.team === 1).length;
  assert(z >= 1, 'the crypt should have produced at least one zombie');
  host.dispose();
  return `${z} zombie(s) from one necropolis in 48s`;
});

/* ============================================================
   arcane
   ============================================================ */
console.log('\nTHE ARCANE ORDER');
check('mana regenerates and a spell spends it', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  assert(mage, 'mage spawned');
  const rec = host.mods.get('arcane');
  const st = () => mage.modState.arcane;
  eq(st().mana >= 250 ? 1 : 0, 1, `a rank-1 mage should carry at least 250 mana, has ${st().mana}`);
  st().mana = 10;
  run(g, 3);
  near(st().mana, 52, 3, 'mana regen (14/s at Apprentice)');
  const spell = rec.mod.spells().find((s) => s.id === 'fireball');
  st().mana = 100;
  const before = st().mana;
  const enemy = placeAt(g, 'spearman', 2, mage.x + 2, mage.z);
  assert(enemy, 'enemy spawned');
  const ok = rec.mod.castSpell(rec.api, mage, spell, enemy.x, enemy.z);
  assert(ok, 'fireball cast');
  assert(st().mana < before, 'mana spent');
  assert(enemy.hp < enemy.maxHp, 'fireball should hurt');
  host.dispose();
  return `mana ${before.toFixed(1)} → ${st().mana.toFixed(1)}, target ${enemy.hp.toFixed(0)}/${enemy.maxHp}`;
});

check('blink will not cross a wall', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const base = g.playerBase;
  const rec = host.mods.get('arcane');
  const spell = rec.mod.spells().find((s) => s.id === 'blink');
  /* a proper wall on open ground north of the town */
  const plan = g.planWallLine('stone_wall', base.x + 4, base.z + 20, base.x + 4, base.z + 30, 1);
  const built = g.placeWallLine('stone_wall', 1, plan, { free: true, instant: true });
  assert(built.placed.length >= 3, `wall should exist (${built.placed.length})`);
  g.refreshNav();
  const wx = built.placed[Math.floor(built.placed.length / 2)].x;
  const wz = built.placed[Math.floor(built.placed.length / 2)].z;
  const mage = placeAt(g, 'mage', 1, wx - 3, wz);
  assert(mage, 'mage spawned');
  mage.modState.arcane.mana = 100;
  const blocked = rec.mod.castSpell(rec.api, mage, spell, wx + 3, wz);
  assert(!blocked, 'blink through a wall must fail');
  mage.modState.arcane.mana = 100;
  const open = rec.mod.castSpell(rec.api, mage, spell, mage.x, mage.z + 5);
  assert(open, 'blink over open ground should work');
  host.dispose();
  return `${built.placed.length}-segment wall refused, open ground accepted`;
});

check('a golem is temporary', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  levelUp(g, mage, 6);
  mage.modState.arcane.mana = 500;
  const spell = rec.mod.spells().find((s) => s.id === 'golem');
  assert(rec.mod.castSpell(rec.api, mage, spell, mage.x, mage.z), 'golem raised');
  /* an Ascendant raises three, and each tier is its own thing */
  const types = g.units.filter((u) => !u.dead && u.owner === mage).map((u) => u.type).sort();
  eq(types.length, 3, `an Ascendant should raise three golems, got ${types.length}`);
  assert(types.includes('stone_golem') && types.includes('granite_golem') && types.includes('obsidian_golem'),
    `the three tiers are not all present: ${types.join(', ')}`);
  const golem = g.units.find((u) => u.type === 'stone_golem' && u.owner === mage);
  assert(!golem.dead, 'golem is alive');
  run(g, 40);
  assert(golem.dead, 'golem should expire');
  host.dispose();
  return `raised ${types.join(' + ')}, all returned to the earth inside 40 s`;
});

check('one mage, and the Order sends another when he falls', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const rec = host.mods.get('arcane');
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  assert(mage, 'mage spawned');
  levelUp(g, mage, 4);
  const rankBefore = mage.modState.arcane.rank;
  assert(rankBefore === 4, 'the mage did not climb');
  mage.kill(null);
  run(g, 1);
  assert(rec.mod.respawnIn(rec.api, 1) > 0, 'no respawn was scheduled');
  const alive0 = g.units.filter((u) => !u.dead && u.type.startsWith('mage')).length;
  eq(alive0, 0, 'the dead mage is still counted');
  run(g, 50);
  const back = g.units.find((u) => !u.dead && u.type.startsWith('mage') && u.team === 1);
  assert(back, 'the Order never sent another mage');
  eq(back.modState.arcane.rank, 1, 'the returning mage must start at the base rank');
  assert(Math.hypot(back.x - g.playerBase.x, back.z - g.playerBase.z) < 16,
    'the returning mage should walk out of a hall, not appear in the fields');
  host.dispose();
  return `rank ${rankBefore} fell, an Apprentice returned ${Math.round(rec.mod.respawnSeconds())} s later`;
});

check('rank shortens every cooldown until the book is spammable', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const rec = host.mods.get('arcane');
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const fireball = rec.mod.spells().find((s) => s.id === 'fireball');
  const spell = rec.api;
  mage.modState.arcane.mana = 100000;
  mage.modState.arcane.cd = Object.create(null);
  rec.mod.castSpell(spell, mage, fireball, mage.x + 6, mage.z);
  const cd1 = mage.modState.arcane.cd.fireball - g.time;
  levelUp(g, mage, 6);
  mage.modState.arcane.cd = Object.create(null);
  mage.modState.arcane.mana = 100000;
  rec.mod.castSpell(spell, mage, fireball, mage.x + 6, mage.z);
  const cd6 = mage.modState.arcane.cd.fireball - g.time;
  assert(cd6 < cd1 * 0.2, `rank 6 should pay a fraction of the cooldown (${cd1.toFixed(2)} → ${cd6.toFixed(2)})`);
  assert(cd6 < 0.6, `an Ascendant's fireball should be spammable, it is ${cd6.toFixed(2)} s`);
  host.dispose();
  return `fireball cooldown ${cd1.toFixed(2)} s → ${cd6.toFixed(2)} s`;
});

check('blink reaches across a battlefield, not across a room', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const rec = host.mods.get('arcane');
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const blink = rec.mod.spells().find((s) => s.id === 'blink');
  assert(blink.range >= 25, `blink range is ${blink.range}; it is supposed to be a real teleport`);
  host.dispose();
  return `${blink.range} m`;
});

check('time warp slows enemies but not allies', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  levelUp(g, mage, 6);
  mage.modState.arcane.mana = 200;
  const spell = rec.mod.spells().find((s) => s.id === 'warp');
  const ally = placeAt(g, 'swordsman', 1, mage.x + 1.4, mage.z);
  const enemy = placeAt(g, 'swordsman', 2, mage.x - 1.4, mage.z);
  assert(ally && enemy, 'units for the warp test');
  assert(rec.mod.castSpell(rec.api, mage, spell, mage.x, mage.z), 'warp cast');
  eq(rec.mod.speedMul(rec.api, enemy), 0.42, 'enemy slowed');
  eq(rec.mod.speedMul(rec.api, ally), 1, 'ally unaffected');
  host.dispose();
  return 'field discriminates by team';
});

check('insight climbs six ranks and changes the model', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  const st = mage.modState.arcane;
  const seen = [];
  eq(st.rank, 1, 'starts at rank 1');
  eq(mage.type, 'mage', 'starts as an apprentice model');
  const startMax = mage.maxHp;
  for (let r = 2; r <= 6; r++) {
    st.xp = rec.mod.ranks()[r - 1].xp + 1;
    run(g, 0.3, 30);   /* one 5 Hz mod tick */
    eq(st.rank, r, `rank ${r}`);
    seen.push(mage.type);
    assert(mage.type !== 'mage', `rank ${r} must swap the model (${mage.type})`);
    assert(UNIT_DEFS[mage.type], `rank ${r} type ${mage.type} is registered`);
    eq(mage.def.name, rec.mod.ranks()[r - 1].title, `rank ${r} name`);
  }
  assert(mage.maxHp > startMax, 'a rank is worth more life');
  eq(rec.mod.rankOf(mage).mana, 1000, 'an Ascendant holds 1000 mana');
  host.dispose();
  return `${seen.join(' → ')} (${startMax} → ${mage.maxHp} hp)`;
});

check('spells are gated by rank, not just by mana', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  const meteor = rec.mod.spells().find((s) => s.id === 'meteor');
  mage.modState.arcane.mana = 200;
  assert(!rec.mod.castSpell(rec.api, mage, meteor, mage.x + 3, mage.z), 'rank 1 must not throw a meteor');
  mage.modState.arcane.mana = 200;
  levelUp(g, mage, 4);
  mage.modState.arcane.mana = 200;
  assert(rec.mod.castSpell(rec.api, mage, meteor, mage.x + 3, mage.z), 'a rank 4 Archmage may');
  host.dispose();
  return 'meteor refused at rank 1, cast at rank 4';
});

check('attunement turns two elements into a new spell', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  levelUp(g, mage, 3);
  const st = mage.modState.arcane;
  st.mana = 200;
  assert(!rec.mod.attune(rec.api, mage, 'plasma') === false, 'first attunement succeeds');
  assert(rec.api.state.discovered.has('plasma'), 'plasma is in the book');
  eq(rec.mod.attunementPairs().length, 6, 'six hybrids exist');
  const plasma = rec.mod.hybrids().find((h) => h.id === 'plasma');
  const enemy = placeAt(g, 'spearman', 2, mage.x + 8, mage.z);
  assert(enemy, 'target for the lance');
  st.mana = 200;
  const before = enemy.hp;
  assert(rec.mod.castSpell(rec.api, mage, plasma, enemy.x, enemy.z), 'plasma lance casts');
  assert(enemy.hp < before, 'the lance burns');
  st.mana = 200;
  assert(rec.mod.attune(rec.api, mage, 'plasma') === false, 'a found hybrid is not found twice');
  host.dispose();
  return 'plasma lance discovered and cast';
});

check('SKYFALL falls once a day and breaks a base', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const mage = placeAt(g, 'mage', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const rec = host.mods.get('arcane');
  levelUp(g, mage, 6);
  const st = mage.modState.arcane;
  const sky = rec.mod.spells().find((s) => s.id === 'skyfall');
  const enemyBase = g.enemyBase;
  /* the enemy town centre is the target */
  const tc = g.buildings.find((b) => b.team === 2 && b.type === 'town_center');
  if (!tc) throw new Error('no enemy town centre to drop the sky on');
  const hp0 = tc.hp;
  const pos0 = g.units.filter((u) => u.team === 2).length;
  st.mana = 225;
  assert(rec.mod.castSpell(rec.api, mage, sky, tc.x, tc.z), 'the sky falls');
  assert(tc.hp < hp0, `the town centre takes it (${hp0} → ${tc.hp})`);
  near(tc.x, enemyBase.x, 40, 'sanity: that was the enemy base');
  /* three castings a day at Ascendant, and the fourth is refused */
  st.mana = 1000;
  assert(rec.mod.castSpell(rec.api, mage, sky, tc.x, tc.z), 'the second skyfall of the day');
  st.mana = 1000;
  assert(rec.mod.castSpell(rec.api, mage, sky, tc.x, tc.z), 'the third skyfall of the day');
  st.mana = 1000;
  assert(rec.mod.castSpell(rec.api, mage, sky, tc.x, tc.z) === false, 'the sky is spent after three');
  /* advance past one full day */
  run(g, 246, 10);
  st.mana = 225;
  assert(rec.mod.castSpell(rec.api, mage, sky, tc.x, tc.z), 'tomorrow the sky returns');
  host.dispose();
  return `${hp0} → ${tc.hp} hp, ${pos0} defenders, three castings per 240s`;
});

check('an arcane tower teaches faster, and one mage is the cap', () => {
  const g = makeGame();
  const host = modHost(g, ['arcane']);
  const rec = host.mods.get('arcane');
  const b = g.playerBase;
  const cap0 = rec.mod.mageCap(rec.api, 1);
  eq(cap0, 1, 'one mage is the whole of a crown\'s magic');
  const tower = g.placeBuilding('arcane_tower', 1, b.x + 12, b.z - 6, { free: true, instant: true });
  assert(tower, 'the tower can be placed');
  eq(rec.mod.mageCap(rec.api, 1), cap0, 'a tower must not raise the mage cap');
  /* insight beside the tower vs out in the field */
  const near1 = placeAt(g, 'mage', 1, tower.x + 2, tower.z);
  const far1 = placeAt(g, 'mage', 1, b.x - 20, b.z - 20);
  assert(near1 && far1, 'two mages for the lesson');
  const x0 = near1.modState.arcane.xp;
  const y0 = far1.modState.arcane.xp;
  run(g, 6);
  assert(near1.modState.arcane.xp - x0 > far1.modState.arcane.xp - y0 + 1,
    'standing in the tower\'s shadow teaches faster');
  host.dispose();
  return `cap held at ${cap0}, ${(near1.modState.arcane.xp - x0).toFixed(1)} vs ${(far1.modState.arcane.xp - y0).toFixed(1)} insight`;
});

/* ============================================================
   beasts
   ============================================================ */
console.log('\nBEASTS OF THE WILD');
check('the wilderness is stocked with wolves and bears', () => {
  const g = makeGame(77);
  const host = modHost(g, ['beasts']);
  const wild = g.units.filter((u) => u.wild);
  const wolves = wild.filter((u) => u.type === 'dire_wolf').length;
  const bears = wild.filter((u) => u.type === 'bear').length;
  assert(wolves >= 6, `wolf packs missing (${wolves})`);
  assert(bears >= 1, `bears missing (${bears})`);
  host.dispose();
  return `${wolves} wolves, ${bears} bears`;
});

check('taming needs a wounded beast, and the beast changes sides', () => {
  const g = makeGame();
  const host = modHost(g, ['beasts']);
  const rec = host.mods.get('beasts');
  const master = place(g, 'beastmaster', 1, 6, 6);
  assert(master, 'beastmaster');
  const wolf = g.spawnUnitRaw('dire_wolf', 2, master.x + 3, master.z + 1);
  assert(wolf, 'wolf');
  const cmd = rec.mod.commands({
    api: rec.api, game: g, host, ui: null, selection: [master], cast: () => {}
  })[0];
  assert(cmd && cmd.label === 'Tame', 'tame command offered');
  /* full health: the tame must refuse */
  let captured = null;
  const ctx = { api: rec.api, game: g, host, ui: null, selection: [master], cast: (s) => { captured = s; } };
  rec.mod.commands(ctx)[0].action();
  let ok = captured.onCast(wolf.x, wolf.z, wolf);
  assert(!ok, 'a healthy wolf must not be tameable');
  wolf.hp = wolf.maxHp * 0.2;
  ok = captured.onCast(wolf.x, wolf.z, wolf);
  assert(ok, 'a wounded wolf should be tamed');
  eq(wolf.team, 1, 'wolf now fights for the player');
  assert(wolf.tamedBeast, 'marked as tamed');
  host.dispose();
  return 'healthy refused, wounded accepted';
});

check('a tamed beast levels up on kills', () => {
  const g = makeGame();
  const host = modHost(g, ['beasts']);
  const rec = host.mods.get('beasts');
  const wolf = g.spawnUnitRaw('dire_wolf', 1, g.playerBase.x + 8, g.playerBase.z + 8);
  wolf.wild = false; wolf.tamedBeast = true;
  rec.api.state.tamed.push({ unit: wolf, level: 1, kills: 0 });
  const baseAtk = wolf.def.attack;
  for (let i = 0; i < 2; i++) {
    const victim = place(g, 'villager', 2, 8 + i, 8);
    if (victim) victim.kill(wolf);
  }
  const recNow = rec.api.state.tamed.find((t) => t.unit === wolf);
  assert(recNow && recNow.level >= 2, 'level should rise');
  assert(wolf.def.attack > baseAtk, 'attack should rise with the level');
  host.dispose();
  return `level ${recNow.level}, attack ${baseAtk} → ${wolf.def.attack}`;
});

/* ============================================================
   weather
   ============================================================ */
console.log('\nSEASONS & STORM');
check('weather changes the sky and the ground', () => {
  const g = makeGame();
  const host = modHost(g, ['weather']);
  const rec = host.mods.get('weather');
  const soldier = place(g, 'swordsman', 1, 6, 6);
  const archer = place(g, 'archer', 1, 8, 8);
  assert(soldier && archer, 'units');
  /* force a storm */
  rec.api.state.phase = {
    id: 'storm', name: 'Storm', icon: 'bolt', min: 40, max: 60,
    gather: 0.8, speed: 0.94, archer: 0.75, fog: 0.0028, sun: 0.72, line: 'Storm.'
  };
  near(rec.mod.speedMul(rec.api, soldier), 0.94, 0.001, 'storm slows the march');
  near(rec.mod.onDamage(rec.api, null, 100, archer, 'pierce'), 75, 0.01, 'archers loose badly');
  near(rec.mod.onDamage(rec.api, null, 100, soldier, 'melee'), 100, 0.01, 'melee unaffected');
  const at = rec.mod.atmosphere(rec.api);
  assert(at && at.fog > 0.002 && at.tint[0] < 0.8, 'storm should darken the sky');
  host.dispose();
  return 'storm: 0.94 speed, 75% archery, heavy fog';
});

check('phases rotate instead of sticking', () => {
  const g = makeGame();
  const host = modHost(g, ['weather']);
  const rec = host.mods.get('weather');
  const seen = new Set();
  rec.api.state.t = 0.01;
  for (let i = 0; i < 40; i++) {
    run(g, 3);
    seen.add(rec.api.state.phase.id);
    rec.api.state.t = 0.01;               // force the next roll
  }
  assert(seen.size >= 3, `weather should vary (saw ${[...seen].join(',')})`);
  host.dispose();
  return [...seen].join(', ');
});

/* ============================================================
   artificer
   ============================================================ */
console.log("\nARTIFICER'S WORKSHOP");
check('a spike trench is spent on the first enemy over it', () => {
  const g = makeGame();
  const host = modHost(g, ['artificer']);
  const x = g.playerBase.x + 18, z = g.playerBase.z + 4;
  const trap = g.placeBuilding('spike_trap', 1, x, z, { instant: true, free: true });
  assert(trap, 'trap placed');
  const enemy = g.spawnUnitRaw('swordsman', 2, x + 0.6, z + 0.6);
  assert(enemy, 'enemy');
  run(g, 1);
  assert(trap.dead, 'trap consumed');
  assert(enemy.hp < enemy.maxHp * 0.75, `enemy should be hurt (${enemy.hp})`);
  const st = enemy.modState && enemy.modState.artificer;
  assert(st && st.snareUntil > g.time, 'enemy snared');
  eq(g.units.filter((u) => u.type === 'spike_trap').length, 0, 'no trap unit leaked');
  host.dispose();
  return `${Math.round(enemy.hp)}/${enemy.maxHp} hp, snared ${(st.snareUntil - g.time).toFixed(1)}s`;
});

check('a spike trench does not wall your own troops out', () => {
  const g = makeGame();
  const host = modHost(g, ['artificer']);
  const x = g.playerBase.x + 16, z = g.playerBase.z - 6;
  const trap = g.placeBuilding('spike_trap', 1, x, z, { instant: true, free: true });
  assert(trap, 'trap placed');
  const unitLike = { radius: 0.4, def: { naval: false } };
  assert(g.isPassable(x, z, unitLike), 'a trap is a floor, not a fence');
  host.dispose();
  return 'walkable cell under the trap';
});

check('fire arrows burn what they hit', () => {
  const g = makeGame();
  const host = modHost(g, ['artificer']);
  const rec = host.mods.get('artificer');
  const tc = g.buildings.find((b) => b.type === 'town_center' && b.team === 1);
  const base = g.playerBase;
  const archer = placeAt(g, 'archer', 1, base.x + 12, base.z + 12);
  const enemy = placeAt(g, 'swordsman', 2, base.x + 15, base.z + 12);
  assert(tc && archer && enemy, `setup (tc ${!!tc} archer ${!!archer} enemy ${!!enemy})`);
  const cmds = rec.mod.commands({ api: rec.api, game: g, host, ui: null, selection: [tc] });
  assert(cmds.length === 1, 'fire arrows offered at the town centre');
  cmds[0].action();
  assert(rec.api.state.fireArrows[1], 'upgrade bought');
  const hp0 = enemy.hp;
  rec.mod.onDamage(rec.api, enemy, 5, archer, 'pierce');
  run(g, 2);
  assert(enemy.hp < hp0, 'the burn should tick');
  host.dispose();
  return `${Math.round(hp0)} → ${Math.round(enemy.hp)} hp from burn alone`;
});

check('the ballista tower exists and shoots', () => {
  const g = makeGame();
  const host = modHost(g, ['artificer']);
  const x = g.playerBase.x + 20, z = g.playerBase.z + 10;
  const tower = g.placeBuilding('ballista_tower', 1, x, z, { instant: true, free: true });
  assert(tower, 'tower placed');
  const enemy = g.spawnUnitRaw('swordsman', 2, x + 6, z);
  assert(enemy, 'enemy');
  const hp0 = enemy.hp;
  run(g, 6);
  assert(enemy.hp < hp0 || enemy.dead, 'tower should shoot');
  host.dispose();
  return `tower dealt ${enemy.dead ? 'a kill' : Math.round(hp0 - enemy.hp) + ' damage'}`;
});

/* ============================================================
   relics
   ============================================================ */
console.log('\nRELICS OF THE OLD FAITH');
check('five shrines, each with its own relic', () => {
  const g = makeGame(31);
  const host = modHost(g, ['relics']);
  const rec = host.mods.get('relics');
  const shrines = rec.api.state.shrines;
  eq(shrines.length, 5, 'shrine count');
  const ids = new Set(shrines.map((s) => s.relic.id));
  eq(ids.size, 5, 'every relic is unique');
  for (const s of shrines) {
    eq(s.owner, 0, 'shrines start neutral');
    assert(!s.b.neutral === false, 'shrine stays neutral');
  }
  host.dispose();
  return shrines.map((s) => s.relic.id).join(', ');
});

check('standing at a shrine claims it and buffs the empire', () => {
  const g = makeGame();
  const host = modHost(g, ['relics']);
  const rec = host.mods.get('relics');
  const shrine = rec.api.state.shrines[0];
  const soldier = g.spawnUnitRaw('swordsman', 1, shrine.b.x + 1, shrine.b.z + 1);
  assert(soldier, 'soldier');
  /* keep him there: the sim would otherwise walk him away */
  for (let i = 0; i < 200; i++) {
    soldier.x = shrine.b.x + 1; soldier.z = shrine.b.z + 1;
    soldier.state = 'idle'; soldier.targetPos = null; soldier.path = null;
    g.update(1 / 20);
  }
  eq(shrine.owner, 1, 'shrine claimed');
  const fired = g.units.filter((u) => u.team === 1 && u.type === 'plague_zombie').length;
  void fired;
  const buffs = g.teams.get(1).buffs.filter((b) => b.name === 'mod:relics');
  assert(buffs.length >= 1, 'the relic buff should be live');
  host.dispose();
  return `${shrine.relic.id} held, ${buffs.length} buff(s) on team 1`;
});

check('an enemy can take a relic away', () => {
  const g = makeGame();
  const host = modHost(g, ['relics']);
  const rec = host.mods.get('relics');
  const shrine = rec.api.state.shrines[1];
  const spot = g.freeSpotNear(shrine.b.x + 1, shrine.b.z + 1, { radius: 0.4, def: { naval: false } }, 8);
  assert(spot, 'a place to stand');
  const mine = g.spawnUnitRaw('swordsman', 1, spot[0], spot[1]);
  assert(mine, 'player soldier');
  const hold = (u, n) => {
    for (let i = 0; i < n; i++) {
      u.x = shrine.b.x + 1; u.z = shrine.b.z + 1;
      u.state = 'idle'; u.targetPos = null; u.path = null;
      g.update(1 / 20);
    }
  };
  hold(mine, 170);
  eq(shrine.owner, 1, 'player holds it');
  /* the enemy only arrives once the player is dead: two sides inside the ring
     contest it by head-count, which is a different mechanic */
  const theirs = g.spawnUnitRaw('swordsman', 2, shrine.b.x + 1, shrine.b.z + 1);
  assert(theirs, 'enemy soldier');
  mine.kill(theirs);
  hold(theirs, 200);
  eq(shrine.owner, 2, 'enemy takes it');
  host.dispose();
  return 'claim → capture';
});

/* ============================================================
   cost
   ============================================================ */
console.log('\nCOST');
check('six mods on a busy field stay far below a frame', () => {
  const g = makeGame(5);
  /* a crowd, so every mod has something to iterate */
  for (let i = 0; i < 60; i++) {
    place(g, i % 3 === 0 ? 'swordsman' : i % 3 === 1 ? 'archer' : 'villager', 1, (i % 10) * 1.4 - 6, 6 + ((i / 10) | 0) * 1.4);
    if (i % 4 === 0) place(g, 'spearman', 2, (i % 8) * 1.5 - 4, 12 + ((i / 8) | 0) * 1.5);
  }
  const host = modHost(g, ['zombies', 'arcane', 'beasts', 'weather', 'artificer', 'relics']);
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
