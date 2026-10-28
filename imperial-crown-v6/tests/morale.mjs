/* ============================================================
   morale.mjs — the will to fight
   ------------------------------------------------------------
   What this suite nails down:

     · morale is a bonus and nothing else: it never takes a man below
       his normal strength, and it never stops him acting;
     · supply comes from buildings and pushes morale up, not down;
     · terror is local and small — a death ten metres away matters a
       little, a death across the map does not;
     · no order is ever refused and no unit ever routs, at any morale;
     · the Marshal's aura is a walking supply point;
     · all of it survives a save.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { UNIT_DEFS } from '../src/sim/data.js';
import { MORALE_MAX, MORALE_FLOOR } from '../src/sim/morale.js';

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
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m} (got ${a}, expected ${b})`); }
function near(a, b, tol, m) { if (Math.abs(a - b) > tol) throw new Error(`${m} (got ${a}, expected ~${b})`); }

function makeGame(seed = 31337) {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  g.worldTime = 10;
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 9000;
    st.age = 3;
  }
  return g;
}
function run(g, seconds, hz = 20) {
  const step = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) g.update(step);
}
function placeAt(g, type, team, x, z) {
  const p = g.freeSpotNear(x, z, { radius: 0.5, def: UNIT_DEFS[type] }, 8) || [x, z];
  return g.spawnUnitRaw(type, team, p[0], p[1]);
}
/* A far, empty patch of grass: out of every supply radius. */
function farSpot(g, team) {
  const base = team === 1 ? g.playerBase : g.enemyBase;
  const dir = team === 1 ? 1 : -1;
  for (let r = 46; r < 90; r += 4) {
    const x = base.x + dir * r, z = base.z + 8;
    if (g.isPassable(x, z, { radius: 0.6, def: {} })) return [x, z];
  }
  return [base.x + dir * 55, base.z];
}

/* ============================================================ */
console.log('\nSUPPLY AND DECAY');
check('a soldier inside the town\'s supply net keeps his nerve', () => {
  const g = makeGame();
  const u = placeAt(g, 'spearman', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  assert(u, 'the spearman');
  const m0 = u.morale;
  run(g, 20);
  assert(u.morale >= MORALE_MAX - 0.01, `morale fell in supply (${m0} → ${u.morale.toFixed(2)})`);
  assert(u.fed, 'the net should report him fed');
  return `${u.morale.toFixed(0)} with ${g.morale.sourcesFor(1).length} supply source(s)`;
});

check('a soldier far from any supply bleeds morale', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'spearman', 1, x, z);
  assert(u, 'the spearman');
  assert(!g.morale.inSupply(u), 'the test spot must be outside the net');
  const m0 = u.morale;
  run(g, 30);
  assert(u.morale < m0 - 8, `morale should fall (${m0} → ${u.morale.toFixed(1)})`);
  return `${m0.toFixed(0)} → ${u.morale.toFixed(1)} in 30 s`;
});

check('night is worse than day for a man with no tent', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const day = placeAt(g, 'spearman', 1, x, z);
  const [x2, z2] = farSpot(g, 2);
  const night = placeAt(g, 'spearman', 2, x2, z2);
  assert(day && night, 'two spearmen');
  g.worldTime = 12;
  run(g, 24);
  const dayLoss = MORALE_MAX - day.morale;
  night.morale = MORALE_MAX;
  day.morale = MORALE_MAX;
  g.worldTime = 0.5;
  run(g, 24);
  const nightLoss = MORALE_MAX - night.morale;
  assert(nightLoss > dayLoss + 1, `night should cost more (day ${dayLoss.toFixed(1)}, night ${nightLoss.toFixed(1)})`);
  return `day −${dayLoss.toFixed(1)}, night −${nightLoss.toFixed(1)} per 24 s`;
});

check('a supply tent extends the net, and can be cut down', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'spearman', 1, x, z);
  assert(u && !g.morale.inSupply(u), 'the unit starts unsupplied');
  const spot = g.freeSpotNear(x + 3, z + 3, { radius: 1.2, def: { size: 2.4 } }, 6) || [x + 3, z + 3];
  const tent = g.placeBuilding('supply_tent', 1, spot[0], spot[1], { instant: true, free: true });
  assert(tent, 'the tent was placed');
  assert(g.morale.inSupply(u), 'the tent should cover him');
  run(g, 6);
  assert(u.morale > 95, `he should be recovering (${u.morale.toFixed(1)})`);
  /* burn the tent: the net collapses with it */
  tent.dead = true;
  assert(!g.morale.inSupply(u), 'a dead tent must not supply anyone');
  return `covered by a ${tent.def.supply} m tent, and only while it stands`;
});

/* ============================================================ */
console.log('\nNO ONE BREAKS');

/**
 * The player's own words: "remove this morale bullshit completely... they just
 * keep standing there". Morale used to floor a unit at zero, turn its back and
 * march it home, which on a phone looked like an army that had stopped obeying
 * orders. Morale now only ever adds: the floor is worth no penalty, and there
 * is no rout at any number.
 */
check('morale never falls below the floor, however long a man is abandoned', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  assert(u, 'the swordsman');
  u.morale = 0;                       // even a stale, corrupted value
  for (let t = 0; t < 200 * 20; t++) g.update(1 / 20);
  assert(u.morale >= MORALE_FLOOR, `morale fell to ${u.morale.toFixed(1)}`);
  assert(u.state !== 'rout', 'a rout came back');
  return `floor ${MORALE_FLOOR} held for 200 s`;
});

check('a man at the floor is exactly as strong as one at full morale', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  assert(u, 'the swordsman');
  u.morale = MORALE_FLOOR;
  near(g.morale.attackMul(u), 1, 1e-9, 'the floor must not cost damage');
  near(g.morale.speedMul(u), 1, 1e-9, 'the floor must not cost speed');
  near(g.morale.damageTakenMul(u), 1, 1e-9, 'the floor must not cost toughness');
  u.morale = MORALE_MAX;
  assert(g.morale.attackMul(u) > 1, 'full morale should be a bonus');
  near(g.morale.speedMul(u), 1, 1e-9, 'morale never touches speed');
  near(g.morale.damageTakenMul(u), 1, 1e-9, 'morale never makes a man softer');
  return `floor ×1.00, full ×${g.morale.attackMul(u).toFixed(2)} damage`;
});

check('every order is obeyed at zero morale', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  const tree = g.resources.find((r) => !r.dead && r.resKind === 'wood');
  const b = g.buildings.find((bd) => !bd.dead && bd.team === 1);
  u.morale = 0;
  run(g, 1);
  g.orderMove([u], u.x + 4, u.z + 4);
  eq(u.state, 'move', 'a move order was refused');
  run(g, 1);
  if (tree) { g.orderGather([u], tree); assert(u.state !== 'idle', 'a gather order was refused'); }
  if (b) { g.orderRepair([u], b); assert(u.state !== 'idle', 'a repair order was refused'); }
  g.orderAttack([u], g.enemyBase);
  assert(u.state !== 'idle', 'an attack order was refused');
  return 'move, gather, repair and attack all accepted';
});

/**
 * The bug that made v6 unplayable: every state away from supply bled the same
 * -1.05 a second, so an army ordered to march 200 m turned its back and ran
 * home inside a minute and a half -- "units turning away for no reason".
 */
check('a marching column keeps its nerve all the way to the enemy', () => {
  const g = makeGame();
  const base = g.playerBase;
  const squad = [];
  for (let i = 0; i < 6; i++) {
    const u = placeAt(g, 'spearman', 1, base.x + 40 + i * 2, base.z + 40);
    if (u) { u.stance = 'aggressive'; squad.push(u); }
  }
  assert(squad.length === 6, 'six spearmen');
  const goal = [base.x + 200, base.z + 200];
  for (const u of squad) g.orderMove([u], goal[0], goal[1]);
  for (let t = 0; t < 180 * 30; t++) {
    g.update(1 / 30);
    for (const u of squad) if (u.state === 'idle') g.orderMove([u], goal[0], goal[1]);
  }
  const routed = squad.filter((u) => u.state === 'rout').length;
  assert(routed === 0, `${routed} of ${squad.length} broke on the march`);
  const worst = Math.min(...squad.map((u) => u.morale));
  assert(worst >= MORALE_FLOOR, `the column lost its nerve (${worst.toFixed(0)})`);
  return `${squad.length} men, 3 min, worst morale ${worst.toFixed(0)}`;
});

check('an army parked in the open keeps its nerve indefinitely', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  assert(u, 'the swordsman');
  u.stance = 'stand';
  for (let t = 0; t < 300 * 20; t++) g.update(1 / 20);
  assert(u.state !== 'rout', 'a parked army broke');
  assert(u.morale >= MORALE_FLOOR, `morale fell to ${u.morale.toFixed(1)}`);
  return `five minutes in the open, morale ${u.morale.toFixed(0)}, still standing`;
});

/* ============================================================ */
console.log('\nTERROR IS LOCAL');
check('a death in sight shakes the men who saw it', () => {
  const g = makeGame();
  const base = g.playerBase;
  const near1 = placeAt(g, 'spearman', 1, base.x + 5, base.z + 5);
  const near2 = placeAt(g, 'spearman', 1, base.x + 7, base.z + 6);
  const away = placeAt(g, 'spearman', 1, base.x + 28, base.z + 4);
  assert(near1 && near2 && away, 'three spearmen');
  const victim = placeAt(g, 'spearman', 1, base.x + 6, base.z + 5);
  assert(victim, 'the victim');
  const m0 = near2.morale, a0 = away.morale;
  victim.kill(null);
  assert(near2.morale < m0 - 4, `a witness must be shaken (${m0} → ${near2.morale.toFixed(1)})`);
  near(a0, away.morale, 0.001, 'a man 22 m away saw nothing');
  return `witnesses lost ${(m0 - near2.morale).toFixed(0)} morale`;
});

check('a kill within sight lifts the men who made it', () => {
  const g = makeGame();
  const base = g.playerBase;
  const killer = placeAt(g, 'swordsman', 1, base.x + 5, base.z + 5);
  const buddy = placeAt(g, 'swordsman', 1, base.x + 7, base.z + 5);
  const enemy = placeAt(g, 'spearman', 2, base.x + 8, base.z + 7);
  assert(killer && buddy && enemy, 'the cast');
  killer.morale = 60; buddy.morale = 60;
  enemy.kill(killer);
  assert(killer.morale > 60, `the killer should be heartened (${killer.morale.toFixed(1)})`);
  assert(buddy.morale > 60, `and his neighbour too (${buddy.morale.toFixed(1)})`);
  return `+${(killer.morale - 60).toFixed(0)} morale for the kill`;
});

check('a villager never breaks', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const v = placeAt(g, 'villager', 1, x, z);
  assert(v, 'the villager');
  v.morale = 0;
  run(g, 10);
  assert(v.state !== 'rout', 'a villager cannot rout');
  eq(v.morale, MORALE_MAX, 'and carries no morale at all');
  return 'the economy does not panic';
});

check('morale is a bonus, and only a small one', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  assert(u, 'the swordsman');
  u.morale = MORALE_FLOOR;
  near(g.morale.attackMul(u), 1, 1e-9, 'the floor is exactly neutral');
  u.morale = MORALE_MAX;
  const top = g.morale.attackMul(u);
  assert(top > 1.02 && top < 1.15, `full morale should be a small bonus (${top.toFixed(3)})`);
  return `attack ×${top.toFixed(2)} at full morale`;
});

/* ============================================================ */
console.log('\nTHE COURT AND THE SAVE');
check('a Marshal of rank II is a walking supply point', () => {
  const g = makeGame();
  const knight = placeAt(g, 'knight', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'spearman', 1, x, z);
  assert(knight && u, 'the cast');
  assert(!g.morale.inSupply(u), 'unsupplied before the Marshal arrives');
  const ok = g.court.appoint(1, 'marshal', knight);
  assert(ok && ok.ok === true, 'the appointment failed: ' + JSON.stringify(ok && ok.reason));
  eq(g.court.holder(1, 'marshal'), knight, 'the knight holds the office');
  g.court.deed(1, 'marshal', 60);
  assert(g.court.rank(1, 'marshal') >= 2, 'the Marshal is rank II');
  knight.x = u.x + 4; knight.z = u.z + 4;
  assert(g.morale.inSupply(u), 'the Marshal covers his men');
  return `rank ${g.court.rank(1, 'marshal')} aura`;
});

check('morale survives a save', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  u.morale = 37.4;
  const tuple = [u.type, u.team, u.x, u.z, Math.round(u.hp), u.rank, Math.round(u.xp), Math.round(u.morale)];
  const g2 = makeGame();
  const u2 = g2.spawnUnit(tuple[0], tuple[1], tuple[2], tuple[3]);
  u2.morale = tuple[7];
  eq(u2.morale, 37, 'morale came back from the save');
  return '37 morale';
});

check('supply sources are scanned once per tick, not per unit', () => {
  const g = makeGame();
  let scans = 0;
  const orig = g.morale._scan.bind(g.morale);
  g.morale._scan = (t2) => { scans++; return orig(t2); };
  for (let i = 0; i < 8; i++) {
    const u = placeAt(g, 'spearman', 1, g.playerBase.x + 4 + i, g.playerBase.z + 5);
    if (u) u.morale = 99;
  }
  const total = g.units.filter((u) => !u.dead).length;
  scans = 0;
  run(g, 4, 30);
  assert(scans <= 2 * 30, `${scans} scans for ${total} units in 4 s (should be one per team per tick)`);
  return `${scans} scans, ${total} units`;
});

/* ============================================================ */
console.log(`\n${failures.length ? `MORALE CHECKS FAILED (${failures.length})` : `MORALE CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
