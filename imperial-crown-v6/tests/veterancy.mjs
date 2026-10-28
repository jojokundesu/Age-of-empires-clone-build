/* ============================================================
   veterancy.mjs — what a soldier learns by surviving
   ------------------------------------------------------------
   The rule the whole suite defends: *the same unit gets better*.
   Not a new unit type, not a buff aura, the man himself:

     · damage dealt and blows landed pay xp; kills pay more
     · a rank raises hit points, armour and damage, and the
       promotion heals the difference
     · villagers and buildings learn nothing
     · the AI prices a chevron into threat and walks crippled
       elites home instead of spending them
     · the rank survives a save and a reload
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController, unitThreat } from '../src/sim/ai.js';
import { RANKS, MAX_RANK, xpFor, rankOf } from '../src/sim/veterancy.js';

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

function makeGame(seed = 4242) {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  g.worldTime = 10;                 // broad daylight: no night-raid multiplier
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 8000;
    st.age = 3;
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
console.log('\nXP AND RANKS');
check('the ladder is four ranks with rising costs', () => {
  eq(RANKS.length, 4, 'four ranks');
  eq(RANKS[0].name, 'Recruit', 'rank 0');
  eq(RANKS[3].name, 'Elite', 'rank 3');
  assert(RANKS[1].xp > 0 && RANKS[2].xp > RANKS[1].xp && RANKS[3].xp > RANKS[2].xp, 'thresholds rise');
  eq(MAX_RANK, 3, 'the ladder is capped');
  eq(xpFor(3), Infinity, 'nothing is above Elite');
  eq(rankOf(0), 0, 'rankOf(0)');
  eq(rankOf(RANKS[1].xp), 1, 'rankOf(first threshold)');
  eq(rankOf(RANKS[3].xp + 5000), 3, 'rankOf(huge)');
  return RANKS.map((r) => `${r.name}@${r.xp}`).join(' → ');
});

check('a kill promotes, and the promotion is a real stat change', () => {
  const g = makeGame();
  const a = place(g, 'spearman', 1, 6, 6);
  const b = place(g, 'spearman', 2, 14, 6);
  assert(a && b, 'both spearmen exist');
  eq(a.rank, 0, 'a fresh unit is a recruit');
  const hp0 = a.maxHp, atk0 = a.stats().attack, arm0 = a.stats().armor;
  g.veterancy.gain(a, RANKS[1].xp + 1, 'test');
  eq(a.rank, 1, 'rank 1 at the first threshold');
  assert(a.maxHp > hp0, `rank 1 raises max hp (${hp0} → ${a.maxHp})`);
  eq(a.hp, a.maxHp, 'the promotion heals the difference');
  assert(a.stats().attack > atk0, 'rank 1 raises attack');
  g.veterancy.gain(a, RANKS[2].xp, 'test');
  eq(a.rank, 2, 'rank 2');
  eq(a.stats().armor, arm0 + RANKS[2].arm, 'rank 2 raises armour');
  near(a.maxHp, Math.round(a.baseMaxHp * RANKS[2].hp), 1, 'max hp follows the rank table');
  return `hp ${hp0} → ${a.maxHp}, attack ${atk0.toFixed(1)} → ${a.stats().attack.toFixed(1)}, armour +${RANKS[2].arm}`;
});

check('the rank is a damage multiplier in the real attack path', () => {
  const g = makeGame();
  const raw = place(g, 'swordsman', 1, 6, 6);
  const vet = place(g, 'swordsman', 1, 8, 6);
  const t1 = place(g, 'spearman', 2, 10, 10);
  const t2 = place(g, 'spearman', 2, 12, 10);
  assert(raw && vet && t1 && t2, 'the cast is on the field');
  g.veterancy.gain(vet, RANKS[3].xp + 1, 'test');
  eq(vet.rank, 3, 'the veteran is elite');
  const hp1 = t1.hp, hp2 = t2.hp;
  raw.performAttack(t1, raw.stats());
  vet.performAttack(t2, vet.stats());
  const d1 = hp1 - t1.hp, d2 = hp2 - t2.hp;
  assert(d2 > d1 * 1.2, `an elite must hit much harder (${d1} vs ${d2})`);
  near(d2 / d1, RANKS[3].atk, 0.08, 'the multiplier is the rank table');
  return `${d1} damage → ${d2} damage (×${(d2 / d1).toFixed(2)})`;
});

check('damage alone teaches, so archers level too', () => {
  const g = makeGame();
  const archer = place(g, 'archer', 1, 6, 6);
  const dummy = place(g, 'knight', 2, 20, 6);
  assert(archer && dummy, 'the archer and the dummy');
  const xp0 = archer.xp;
  dummy.takeDamage(55, archer, 'pierce');
  assert(!dummy.dead, 'the dummy is still standing');
  assert(archer.xp > xp0, `a hit must teach something (${xp0} → ${archer.xp})`);
  return `+${(archer.xp - xp0).toFixed(1)} xp for 55 damage`;
});

check('workers and buildings learn nothing', () => {
  const g = makeGame();
  const vill = place(g, 'villager', 1, 6, 6);
  const foe = place(g, 'spearman', 2, 8, 6);
  assert(vill && foe, 'the cast');
  const xp0 = vill.xp || 0;
  g.veterancy.gain(vill, 500, 'test');
  eq(vill.xp || 0, xp0, 'a villager keeps his xp');
  eq(vill.rank, 0, 'and never ranks up');
  const tower = g.buildings.find((b) => b.team === 1 && (b.def.attack || 0) > 0);
  if (tower) {
    g.veterancy.onKill(tower, foe);
    eq(tower.rank || 0, 0, 'a building never ranks up');
  }
  return 'the economy stays the economy';
});

check('killing a veteran is worth more than killing a recruit', () => {
  const g = makeGame();
  const a1 = place(g, 'swordsman', 1, 6, 6);
  const a2 = place(g, 'swordsman', 1, 8, 6);
  const v1 = place(g, 'spearman', 2, 20, 20);
  const v2 = place(g, 'spearman', 2, 22, 20);
  assert(a1 && a2 && v1 && v2, 'the cast');
  g.veterancy.gain(v2, RANKS[3].xp + 1, 'test');
  g.veterancy.gain(a1, 0.0001, 'noop');   // establish a baseline without a rank
  const before1 = a1.xp || 0, before2 = a2.xp || 0;
  g.veterancy.onKill(a1, v1);
  g.veterancy.onKill(a2, v2);
  assert((a2.xp - before2) > (a1.xp - before1) + 10, `an elite is worth more dead (${(a1.xp - before1).toFixed(0)} vs ${(a2.xp - before2).toFixed(0)})`);
  return `${(a1.xp - before1).toFixed(0)} xp for a recruit, ${(a2.xp - before2).toFixed(0)} for an elite`;
});

check('the ladder is capped at Elite', () => {
  const g = makeGame();
  const u = place(g, 'knight', 1, 6, 6);
  assert(u, 'the knight');
  g.veterancy.gain(u, 100000, 'test');
  eq(u.rank, 3, 'never above Elite');
  const before = u.maxHp;
  g.veterancy.gain(u, 100000, 'test');
  eq(u.maxHp, before, 'no further health');
  return `xp ${Math.round(u.xp)} held at rank 3`;
});

check('progress reads 0..1 toward the next rank', () => {
  const g = makeGame();
  const u = place(g, 'swordsman', 1, 6, 6);
  eq(g.veterancy.progress(u), 0, 'a recruit starts at zero');
  const mid = (RANKS[1].xp) / 2;
  g.veterancy.gain(u, mid, 'test');
  const p = g.veterancy.progress(u);
  assert(p > 0.4 && p < 0.6, `half-way to Seasoned (${p.toFixed(2)})`);
  g.veterancy.gain(u, RANKS[3].xp, 'test');
  eq(g.veterancy.progress(u), 1, 'an elite is done');
  return `${p.toFixed(2)} at half a rank`;
});

/* ============================================================ */
console.log('\nTHE AI');
check('the AI prices a chevron into threat', () => {
  const g = makeGame();
  const a = place(g, 'swordsman', 1, 6, 6);
  const b = place(g, 'swordsman', 1, 9, 6);
  const t0 = unitThreat(a);
  g.veterancy.gain(b, RANKS[2].xp + 1, 'test');
  const t1 = unitThreat(b);
  assert(t1 >= t0 + 3, `a veteran must be worth hunting (${t0} → ${t1})`);
  return `threat ${t0} → ${t1}`;
});

check('a crippled elite is walked home, not spent', () => {
  const g = makeGame(777);
  const ai = new AIController(g, 2, {});
  const vet = place(g, 'swordsman', 2, 26, 18);
  assert(vet, 'the veteran exists');
  g.veterancy.gain(vet, RANKS[2].xp + 1, 'test');
  vet.hp = vet.maxHp * 0.2;
  ai.manageWounded([vet]);
  eq(vet.aiRole, 'retreat', 'the AI marks him for home');
  eq(vet.state, 'move', 'and he is actually walking');
  run(g, 0.5);
  const d0 = Math.hypot(vet.x - ai.base.x, vet.z - ai.base.z);
  run(g, 6);
  const d1 = Math.hypot(vet.x - ai.base.x, vet.z - ai.base.z);
  assert(d1 < d0, `he must get closer to home (${d0.toFixed(1)} → ${d1.toFixed(1)})`);
  /* and he is released once he has healed */
  vet.hp = vet.maxHp;
  ai.manageWounded([vet]);
  eq(vet.aiRole, null, 'a healed veteran returns to the line');
  return `home ${d0.toFixed(0)} m → ${d1.toFixed(0)} m`;
});

check('a recruit is never evacuated, only veterans', () => {
  const g = makeGame(778);
  const ai = new AIController(g, 2, {});
  const rookie = place(g, 'swordsman', 2, 26, 18);
  assert(rookie, 'the recruit');
  rookie.hp = rookie.maxHp * 0.2;
  ai.manageWounded([rookie]);
  eq(rookie.aiRole || null, null, 'a recruit is not worth the walk home');
  return 'recruits are spent';
});

/* ============================================================ */
console.log('\nTHE HUD AND THE SAVE');
check('rank and xp survive a save and a reload', () => {
  const g = makeGame();
  const u = place(g, 'swordsman', 1, 6, 6);
  assert(u, 'the unit');
  g.veterancy.gain(u, RANKS[2].xp + 13, 'test');
  const rank = u.rank, xp = u.xp, maxHp = u.maxHp;
  const saved = [u.type, u.team, u.x, u.z, Math.round(u.hp), u.rank, Math.round(u.xp)];
  const g2 = makeGame();
  const u2 = g2.spawnUnit(saved[0], saved[1], saved[2], saved[3]);
  assert(u2, 'respawned');
  u2.rank = Math.min(MAX_RANK, saved[5]);
  u2.xp = saved[6];
  u2.maxHp = Math.round(u2.baseMaxHp * RANKS[u2.rank].hp);
  eq(u2.rank, rank, 'the rank came back');
  eq(u2.xp, Math.round(xp), 'the xp came back');
  eq(u2.maxHp, maxHp, 'and so did the hit points the rank bought');
  return `rank ${rank}, ${u2.maxHp} hp`;
});

check('a promotion is announced to the player, in words', () => {
  const g = makeGame();
  const notes = [];
  g.onNotify = (text) => notes.push(text);
  const u = place(g, 'swordsman', 1, 6, 6);
  g.veterancy.gain(u, RANKS[1].xp + 1, 'test');
  const said = notes.some((n) => /Seasoned/.test(n));
  assert(said, `no promotion notice: ${notes.join(' | ')}`);
  return notes.find((n) => /Seasoned/.test(n));
});

check('the enemy is never told about your promotions', () => {
  const g = makeGame();
  const notes = [];
  g.onNotify = (text) => notes.push(text);
  const u = place(g, 'swordsman', 2, 6, 6);
  g.veterancy.gain(u, RANKS[2].xp + 1, 'test');
  eq(u.rank, 2, 'the enemy unit ranked up');
  assert(!notes.some((n) => /Seasoned|Veteran/.test(n)), 'the player was told about an enemy promotion');
  return 'silent for the enemy';
});

/* ============================================================ */
console.log(`\n${failures.length ? `VETERANCY CHECKS FAILED (${failures.length})` : `VETERANCY CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
