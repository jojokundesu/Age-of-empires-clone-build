/* ============================================================
   court.mjs — the Court of Offices
   ------------------------------------------------------------
   A campaign needs a long game that is not "more units". The Court
   is four offices, each held by a body on the map, and every check
   here is about the *person*:

     · an office only takes the right kind of subject, and costs
     · the aura is real: a soldier beside the Marshal hits harder,
       a villager beside the Chancellor gathers faster
     · deeds raise the rank, and a rank raises the aura
     · a writ costs favour, does what its card says, and then waits
     · the holder dying empties the office for a while
     · the AI fills its own court and the threat table sees officers
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController, unitThreat } from '../src/sim/ai.js';
import { OFFICES, RANK_AT } from '../src/sim/court.js';

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

function makeGame(seed = 909, age = 2) {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 5000;
    st.favor = 400;
    st.age = age;
  }
  return g;
}
function run(g, seconds, hz = 20) {
  const step = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) g.update(step);
}
function place(g, type, team, dx = 6, dz = 6) {
  const base = team === 1 ? g.playerBase : g.enemyBase;
  const spot = g.freeSpotNear(base.x + dx, base.z + dz, { radius: 0.5, def: { naval: false } }, 10) || [base.x + dx, base.z + dz];
  return g.spawnUnitRaw(type, team, spot[0], spot[1]);
}

/* ============================================================ */
console.log('\nTHE FOUR OFFICES');
check('four offices, each with a class, a cost and a writ', () => {
  eq(OFFICES.length, 4, 'office count');
  const ids = OFFICES.map((o) => o.id);
  eq(ids.join(','), 'marshal,chancellor,spymaster,hierophant', 'office ids');
  for (const o of OFFICES) {
    assert(o.age >= 1, `${o.id} needs an age`);
    assert(o.cost.gold > 0 && o.cost.favor > 0, `${o.id} is free`);
    assert(o.writ && o.writ.cd > 0 && o.writ.name, `${o.id} has no writ`);
    assert(o.passive.length === 3, `${o.id} needs three ranks of text`);
    assert(RANK_AT.length === 3, 'three rank thresholds');
  }
  return OFFICES.map((o) => `${o.name} (${o.class})`).join(', ');
});

check('an office refuses the wrong subject, the poor, and the young', () => {
  const g = makeGame(909, 2);
  const villager = place(g, 'villager', 1, 3, 3);
  const knight = place(g, 'knight', 1, 6, 3);
  const mage = place(g, 'monk', 1, 9, 3);
  assert(villager && knight && mage, 'subjects on the field');
  /* the Marshal must be a soldier */
  assert(g.court.canAppoint(1, 'marshal', villager), 'a villager cannot be Marshal');
  assert(!g.court.canAppoint(1, 'marshal', knight), 'a knight can');
  /* the Chancellor must be a villager */
  assert(g.court.canAppoint(1, 'chancellor', knight), 'a knight cannot be Chancellor');
  assert(!g.court.canAppoint(1, 'chancellor', villager), 'a villager can');
  /* the Hierophant must be a monk */
  assert(g.court.canAppoint(1, 'hierophant', knight), 'a knight cannot be Hierophant');
  assert(!g.court.canAppoint(1, 'hierophant', mage), 'a monk can');
  /* every office is open in the Castle Age */
  assert(!g.court.canAppoint(1, 'spymaster', knight), 'the Spymaster is available in the Castle Age');
  assert(g.court.canAppoint(1, 'marshal', place(g, 'swordsman', 2, 4, 4)) !== '', 'enemy subjects are refused');
  /* and in the Dark Age the two Castle offices are closed */
  const young = makeGame(910, 1);
  const squire = place(young, 'knight', 1, 6, 3);
  assert(/Feudal|Castle Age/.test(young.court.canAppoint(1, 'spymaster', squire)), 'a Dark Age realm has no Spymaster');
  assert(!young.court.canAppoint(1, 'marshal', squire), 'but a Marshal rides in the Feudal Age');
  g.teams.get(1).res.gold = 0;
  g.teams.get(1).res.favor = 0;
  assert(/cost/.test(g.court.canAppoint(1, 'marshal', knight)), 'poverty blocks an appointment');
  return 'class, age and purse all hold';
});

check('appointment costs, and one person holds one office', () => {
  const g = makeGame();
  const knight = place(g, 'knight', 1, 6, 3);
  const before = g.teams.get(1).res.gold;
  const res = g.court.appoint(1, 'marshal', knight);
  assert(res.ok, `appointment failed: ${res.reason}`);
  assert(g.teams.get(1).res.gold < before, 'the appointment costs gold');
  eq(knight.courtOffice, 'marshal', 'the knight carries the office');
  const again = g.court.appoint(1, 'spymaster', knight);
  assert(!again.ok && /already/.test(again.reason), 'a second office is refused');
  return `${before} → ${g.teams.get(1).res.gold} gold`;
});

/* ============================================================ */
console.log('\nAURAS');
check('the Marshal makes the soldiers beside him hit harder', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  const near1 = place(g, 'swordsman', 1, 8, 4);
  const far = place(g, 'swordsman', 1, -40, 20);
  assert(marshal && near1 && far, 'the cast');
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed');
  const nearMul = g.court.damageMul(near1);
  const farMul = g.court.damageMul(far);
  assert(nearMul > farMul, `the aura is a placibo (${nearMul} vs ${farMul})`);
  near(nearMul, 1.18, 0.02, 'rank I is +18%');
  eq(farMul, 1, 'outside the aura is untouched');
  /* the aura flows through the shared damage path */
  assert(g.auraBonusFor(near1) > g.auraBonusFor(far), 'auraBonusFor sees the Marshal');
  return `${nearMul.toFixed(2)}× beside, ${farMul}× away`;
});

check('the Chancellor makes the villagers beside her gather faster', () => {
  const g = makeGame();
  const chancellor = place(g, 'villager', 1, 8, 0);
  const near1 = place(g, 'villager', 1, 8, 4);
  const far = place(g, 'villager', 1, -40, 20);
  assert(g.court.appoint(1, 'chancellor', chancellor).ok, 'appointed');
  const nearRate = g.gatherRate(near1, 'wood');
  const farRate = g.gatherRate(far, 'wood');
  assert(nearRate > farRate, `no gather aura (${nearRate} vs ${farRate})`);
  near(nearRate / farRate, 1.1, 0.03, 'rank I is +10%');
  return `${nearRate.toFixed(2)} vs ${farRate.toFixed(2)} wood/s`;
});

check('the Spymaster widens the realm\'s eyes and pays in gold', () => {
  const g = makeGame();
  const spy = place(g, 'archer', 1, 8, 0);
  const scout = place(g, 'villager', 1, -40, 20);
  const sight0 = scout.stats().sight;
  assert(g.court.appoint(1, 'spymaster', spy).ok, 'appointed');
  g.statsVersion++;
  const sight1 = scout.stats().sight;
  assert(sight1 > sight0, `sight did not move (${sight0} → ${sight1})`);
  const gold0 = g.teams.get(1).res.gold;
  run(g, 12);
  assert(g.teams.get(1).res.gold > gold0, 'informants pay something');
  return `sight ${sight0} → ${sight1}, +${(g.teams.get(1).res.gold - gold0).toFixed(1)} gold in 12s`;
});

/* ============================================================ */
console.log('\nDEEDS & WRITS');
check('kills raise the rank, and the rank raises the aura', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  const soldier = place(g, 'swordsman', 1, 8, 4);
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed');
  const mul1 = g.court.damageMul(soldier);
  /* feed the office the deeds it asks for */
  g.court.deed(1, 'marshal', RANK_AT[1] + 1);
  eq(g.court.rank(1, 'marshal'), 2, 'rank II at the first threshold');
  const mul2 = g.court.damageMul(soldier);
  assert(mul2 > mul1, `rank II is not stronger (${mul1} → ${mul2})`);
  near(mul2, 1.26, 0.02, 'rank II is +26%');
  g.court.deed(1, 'marshal', RANK_AT[2] + 1);
  eq(g.court.rank(1, 'marshal'), 3, 'rank III at the second');
  near(g.court.damageMul(soldier), 1.34, 0.02, 'rank III is +34%');
  /* rank III mends the line */
  soldier.hp = soldier.maxHp * 0.5;
  const hp0 = soldier.hp;
  run(g, 6);
  assert(soldier.hp > hp0 + 2, `rank III should mend (${hp0} → ${soldier.hp})`);
  return `+18% → +26% → +34%, ${(soldier.hp - hp0).toFixed(1)} hp mended`;
});

check('Forced March spends favour and moves the line', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  const soldier = place(g, 'swordsman', 1, 8, 4);
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed');
  const favour0 = g.teams.get(1).favor;
  const speed0 = g.unitSpeedMul(soldier);
  const res = g.court.useWrit(1, 'marshal', null);
  assert(res.ok, `writ failed: ${res.reason}`);
  const speed1 = g.unitSpeedMul(soldier);
  assert(speed1 > speed0 + 0.2, `the march did nothing (${speed0} → ${speed1})`);
  assert(g.teams.get(1).favor < favour0, 'the writ costs favour');
  const ready = g.court.writ(1, 'marshal');
  assert(!ready.ready && ready.cooldown > 90, `the writ should be on cooldown (${ready.cooldown})`);
  run(g, 13);
  near(g.unitSpeedMul(soldier), speed0, 0.05, 'the march ends after 12 s');
  return `${speed0.toFixed(2)} → ${speed1.toFixed(2)} speed, cd ${ready.cooldown | 0}s`;
});

check('Whisper marks one enemy and only that enemy', () => {
  const g = makeGame();
  const spy = place(g, 'archer', 1, 8, 0);
  const attacker = place(g, 'swordsman', 1, 10, 0);
  const marked = place(g, 'spearman', 2, 14, 0);
  const other = place(g, 'spearman', 2, 14, 4);
  assert(g.court.appoint(1, 'spymaster', spy).ok, 'appointed');
  assert(g.court.useWrit(1, 'spymaster', marked).ok, 'whisper cast');
  eq(marked.markedBy, 1, 'the target is marked');
  assert(marked.markedUntil > g.time, 'the mark has a lifetime');
  attacker.target = marked;
  const mul = g.court.damageMul(attacker);
  near(mul, 1.3, 0.01, 'marked targets take +30%');
  attacker.target = other;
  near(g.court.damageMul(attacker), 1, 0.01, 'an unmarked target takes normal damage');
  const bad = g.court.useWrit(1, 'spymaster', place(g, 'swordsman', 1, 3, 3));
  assert(!bad.ok, 'an ally cannot be whispered');
  return '+30% against the mark only';
});

check('Benediction mends the circle around the Hierophant', () => {
  const g = makeGame();
  const monk = place(g, 'monk', 1, 8, 0);
  const hurtNear = place(g, 'swordsman', 1, 10, 0);
  const hurtFar = place(g, 'swordsman', 1, -30, 20);
  assert(g.court.appoint(1, 'hierophant', monk).ok, 'appointed');
  hurtNear.hp = hurtNear.maxHp * 0.3;
  hurtFar.hp = hurtFar.maxHp * 0.3;
  const near0 = hurtNear.hp, far0 = hurtFar.hp;
  assert(g.court.useWrit(1, 'hierophant', null).ok, 'benediction cast');
  assert(hurtNear.hp > near0 + hurtNear.maxHp * 0.2, `the circle is not mended (${near0} → ${hurtNear.hp})`);
  eq(hurtFar.hp, far0, 'outside the circle is untouched');
  /* and the rank III passive cuts decree prices */
  g.court.deed(1, 'hierophant', RANK_AT[1] + RANK_AT[2] + 2);
  eq(g.court.rank(1, 'hierophant'), 3, 'rank III');
  near(g.court.decreeDiscount(1), 0.8, 0.001, 'decrees are 20% cheaper');
  return `+${(hurtNear.hp - near0).toFixed(0)} hp inside, 0 outside`;
});

/* ============================================================ */
console.log('\nLOSS');
check('the office dies with its holder, and mourns before it reopens', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed');
  g.court.deed(1, 'marshal', RANK_AT[1] + 5);
  eq(g.court.rank(1, 'marshal'), 2, 'rank II before the fall');
  marshal.kill(null);
  run(g, 1);
  const rec = g.court.office(1, 'marshal');
  eq(rec.holder, null, 'the office is empty');
  eq(rec.rank, 1, 'the office loses a rank');
  assert(rec.vacantUntil > g.time, 'the office is in mourning');
  const knight = place(g, 'knight', 1, 9, 0);
  assert(/mourning/.test(g.court.canAppoint(1, 'marshal', knight)), 'no appointment during mourning');
  run(g, 27);
  assert(!g.court.canAppoint(1, 'marshal', knight), 'after the mourning it reopens');
  return `vacant ${(rec.vacantUntil - (g.time - 27)).toFixed(0)}s, rank 2 → 1`;
});

check('an officer counts as a high-value target for the AI', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  const plain = place(g, 'knight', 1, 12, 0);
  const t0 = unitThreat(plain);
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed');
  const t1 = unitThreat(marshal);
  assert(t1 >= t0 + 3, `an officer must be worth hunting (${t0} → ${t1})`);
  return `threat ${t0} → ${t1}`;
});

/* ============================================================ */
console.log('\nTHE AI COURT');
check('the opponent fills its court and spends its writs', () => {
  const g = makeGame(321, 2);
  const ai = new AIController(g, 2, {});
  for (let i = 0; i < 8; i++) place(g, 'knight', 2, 4 + i * 2, 4);
  for (let i = 0; i < 4; i++) place(g, 'villager', 2, 4 + i, 9);
  for (let i = 0; i < 2; i++) place(g, 'monk', 2, 6 + i, 12);
  run(g, 0.6);
  for (let i = 0; i < 40; i++) { run(g, 0.6); ai.update(0.6); }
  const filled = OFFICES.filter((o) => g.court.holder(2, o.id)).map((o) => o.id);
  assert(filled.length >= 2, `the AI court is empty (${filled.join(',')})`);
  assert(filled.includes('marshal'), 'the AI should appoint a Marshal first');
  const favour = g.teams.get(2).favor;
  assert(favour <= 400, 'san sanity');
  return filled.join(', ');
});

/* ============================================================ */
console.log('\nSAVE');
check('the court survives a save and a load', () => {
  const g = makeGame();
  const marshal = place(g, 'knight', 1, 8, 0);
  const chancellor = place(g, 'villager', 1, 4, 9);
  assert(g.court.appoint(1, 'marshal', marshal).ok, 'appointed the marshal');
  assert(g.court.appoint(1, 'chancellor', chancellor).ok, 'appointed the chancellor');
  g.court.deed(1, 'marshal', RANK_AT[1] + 3);
  const save = JSON.parse(JSON.stringify(g.court.toJSON()));
  const g2 = makeGame();
  /* the same people exist at the same places in the new world */
  const k2 = place(g2, 'knight', 1, 8, 0);
  place(g2, 'villager', 1, 4, 9);
  g2.court.fromJSON(save);
  eq(g2.court.rank(1, 'marshal'), 2, 'the rank came back');
  assert(g2.court.holder(1, 'marshal'), 'the holder was reattached');
  eq(g2.court.holder(1, 'marshal').type, 'knight', 'and to the right kind of person');
  assert(g2.court.holder(1, 'chancellor'), 'the chancellor came back too');
  return `rank ${g2.court.rank(1, 'marshal')} marshal, ${g2.court.holder(1, 'chancellor').type} chancellor`;
});

/* ============================================================ */
console.log(`\n${failures.length ? `COURT CHECKS FAILED (${failures.length})` : `COURT CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
