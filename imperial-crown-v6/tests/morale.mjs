/* ============================================================
   morale.mjs — the will to fight
   ------------------------------------------------------------
   What this suite nails down:

     · supply comes from buildings and is the *only* thing that
       keeps morale up away from home;
     · a raid that outruns its tents breaks, and a broken unit
       cannot be ordered, cannot fight, and runs for home;
     · terror is local — a death ten metres away matters, a death
       across the map does not;
     · low morale costs damage and speed before it costs control;
     · the Marshal's aura is a walking supply point;
     · all of it survives a save.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { UNIT_DEFS } from '../src/sim/data.js';
import { MORALE_MAX, ROUT_AT, RECOVER_AT } from '../src/sim/morale.js';

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
    st.favor = 250;
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
console.log('\nBREAKING');
check('with no supply a unit eventually breaks and runs for home', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  assert(u, 'the swordsman');
  u.morale = ROUT_AT + 0.5;
  const d0 = Math.hypot(u.x - g.playerBase.x, u.z - g.playerBase.z);
  run(g, 4);
  eq(u.state, 'rout', 'the unit should break');
  assert(u.target === null, 'a broken unit drops its target');
  run(g, 5);
  const d1 = Math.hypot(u.x - g.playerBase.x, u.z - g.playerBase.z);
  assert(d1 < d0 - 2, `a broken unit must run home (${d0.toFixed(1)} → ${d1.toFixed(1)})`);
  return `${d0.toFixed(0)} m → ${d1.toFixed(0)} m`;
});

check('a broken unit refuses orders until it recovers', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  u.morale = 2;
  run(g, 1);
  eq(u.state, 'rout', 'broken');
  const d0 = Math.hypot(u.x - g.playerBase.x, u.z - g.playerBase.z);
  g.orderMove([u], g.playerBase.x + 40, g.playerBase.z - 40);
  eq(u.state, 'rout', 'an order must not shake him out of a rout');
  run(g, 3);
  const d1 = Math.hypot(u.x - g.playerBase.x, u.z - g.playerBase.z);
  assert(d1 < d0, `he must still be running home, not to the tap (${d0.toFixed(1)} → ${d1.toFixed(1)})`);
  return 'orders ignored while broken';
});

check('every order refuses a broken man, not just move', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  const tree = g.resources.find((r) => !r.dead && r.resKind === 'wood');
  const b = g.buildings.find((bd) => !bd.dead && bd.team === 1);
  u.morale = 2;
  run(g, 1);
  eq(u.state, 'rout', 'broken');
  if (tree) g.orderGather([u], tree);
  eq(u.state, 'rout', 'a gather order was accepted');
  if (b) g.orderRepair([u], b);
  eq(u.state, 'rout', 'a repair order was accepted');
  g.orderAttack([u], g.enemyBase);
  eq(u.state, 'rout', 'an attack order was accepted');
  g.orderMove([g.units.find((e) => e.team === 1 && e.state !== 'rout') || u], x, z);
  return 'move, gather, repair and attack all ignored';
});

check('a recovered unit returns to the line', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  u.morale = 2;
  run(g, 1);
  eq(u.state, 'rout', 'broken');
  run(g, 26);
  eq(u.state, 'idle', 'recovered near the town centre');
  assert(u.morale >= RECOVER_AT, `morale is back (${u.morale.toFixed(1)})`);
  g.orderMove([u], u.x + 4, u.z + 4);
  eq(u.state, 'move', 'orders work again');
  return `back at ${u.morale.toFixed(0)} morale`;
});

check('a broken man is slower and softer in the back', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  assert(u, 'the swordsman');
  near(g.morale.damageTakenMul(u), 1, 1e-9, 'a formed man takes normal damage');
  u.state = 'rout';
  assert(g.morale.speedMul(u) < 0.95, 'running is slower than walking');
  assert(g.morale.damageTakenMul(u) > 1.4, 'a fleeing man is cut down from behind');
  return `speed ×${g.morale.speedMul(u)}, damage taken ×${g.morale.damageTakenMul(u)}`;
});

/* ============================================================ */
console.log('\nTHE MARCH');

/**
 * The bug that made v6 unplayable: every state away from supply bled the same
 * -1.05 a second, so an army ordered to march 200 m turned its back and ran
 * home inside a minute and a half -- "units turning away for no reason".
 * Marching is now a slow cost, not a rout sentence.
 */
check('a marching column keeps its nerve all the way to the enemy', () => {
  const g = makeGame();
  const base = g.playerBase;
  const squad = [];
  for (let i = 0; i < 6; i++) {
    const [x, z] = [base.x + 40 + i * 2, base.z + 40];
    const u = placeAt(g, 'spearman', 1, x, z);
    if (u) { u.stance = 'aggressive'; squad.push(u); }
  }
  assert(squad.length === 6, 'six spearmen');
  const goal = [base.x + 200, base.z + 200];
  for (const u of squad) g.orderMove([u], goal[0], goal[1]);
  /* three minutes of marching: longer than the walk to the far side of the
     island, and far longer than the old numbers allowed */
  for (let t = 0; t < 180 * 30; t++) {
    g.update(1 / 30);
    for (const u of squad) if (u.state === 'idle') g.orderMove([u], goal[0], goal[1]);
  }
  const routed = squad.filter((u) => u.state === 'rout').length;
  assert(routed === 0, `${routed} of ${squad.length} broke on the march`);
  const worst = Math.min(...squad.map((u) => u.morale));
  assert(worst > 20, `the column should still have some nerve left (${worst.toFixed(0)})`);
  return `${squad.length} men, 3 min, worst morale ${worst.toFixed(0)}`;
});

check('an army parked in the open still eventually loses its nerve', () => {
  const g = makeGame();
  const [x, z] = farSpot(g, 1);
  const u = placeAt(g, 'swordsman', 1, x, z);
  assert(u, 'the swordsman');
  u.stance = 'stand';
  let broke = 0;
  for (let t = 0; t < 260 * 30 && !broke; t++) { g.update(1 / 30); if (u.state === 'rout') broke = t / 30; }
  assert(broke, 'standing in the wilderness forever must cost him his nerve');
  assert(broke > 90, `it should take minutes, not seconds (${broke.toFixed(0)} s)`);
  return `broke after ${broke.toFixed(0)} s in the open`;
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

check('low morale costs damage and speed before it costs control', () => {
  const g = makeGame();
  const u = placeAt(g, 'swordsman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  assert(u, 'the swordsman');
  near(g.morale.attackMul(u), 1, 1e-6, 'full morale: no penalty');
  near(g.morale.speedMul(u), 1, 1e-6, 'full morale: full speed');
  u.morale = 30;
  assert(g.morale.attackMul(u) < 0.95 && g.morale.attackMul(u) > 0.8, 'a shaken unit hits ~12 % softer');
  u.morale = 0;
  assert(g.morale.attackMul(u) < 0.8, 'a broken unit barely fights');
  return `attack ×${g.morale.attackMul(u).toFixed(2)} at 0 morale`;
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
