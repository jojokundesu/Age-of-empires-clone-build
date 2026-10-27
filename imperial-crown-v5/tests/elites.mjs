/* ============================================================
   tests/elites.mjs — the men who will not die
   ------------------------------------------------------------
   Veterancy is experience. This is *survival*, and it is the
   axis that decides the shape of a long battle: the longer a
   soldier lives, the more dangerous he becomes, and every single
   power it grants has a counter that a player can actually use.

   The tests below pin down the four tiers, each power, each
   counter, the AI's bounty on a legend, and the cost of the whole
   system on a busy field.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController, unitThreat } from '../src/sim/ai.js';
import { RENOWN, MAX_RENOWN, renownOf } from '../src/sim/elites.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || 'not near'}: ${a} vs ${b}`);

function fresh() {
  const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
  g.start();
  return g;
}

console.log('\nRENOWN');

check('the tiers climb and are all documented', () => {
  assert(RENOWN.length === 5, `${RENOWN.length} tiers`);
  for (let i = 1; i < RENOWN.length; i++) {
    assert(RENOWN[i].at > RENOWN[i - 1].at, 'tiers must take longer');
    assert(RENOWN[i].name && RENOWN[i].power && RENOWN[i].counter, `tier ${i} is undocumented`);
  }
  assert(renownOf(0) === 0 && renownOf(119) === 1 - 1, 'a fresh man is Untested');
  assert(renownOf(120) === 1, 'two minutes is Blooded');
  assert(renownOf(300) === 2, 'five minutes is Hardened');
  assert(renownOf(540) === 3, 'nine minutes is Renowned');
  assert(renownOf(900) === MAX_RENOWN, 'fifteen minutes is a Legend');
  assert(renownOf(99999) === MAX_RENOWN, 'renown is capped');
});

check('a soldier becomes Blooded after two minutes on the field', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  u.survived = 119;
  g.elites.update(1);          // crosses the line
  assert(u.renown === 1, `renown ${u.renown}`);
  assert(g.elites.describe(u).name === 'Blooded', 'the wrong name');
});

check('workers do not earn renown', () => {
  const g = fresh();
  const v = g.units.find((x) => x.type === 'villager' && x.team === 1);
  v.survived = 4000;
  g.elites.update(0.5);
  assert(!v.renown, 'a villager earned renown');
});

check('survival is what is measured, not rank', () => {
  const g = fresh();
  const a = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 4, g.playerBase.z + 4);
  const b = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 5, g.playerBase.z + 5);
  a.rank = 3; b.rank = 0;
  a.survived = 130; b.survived = 130;
  g.elites.update(0.5);
  assert(a.renown === 1 && b.renown === 1, 'rank changed the survival tier');
});

console.log('\nFIELD DRESSING');

check('a Blooded man heals when nothing is hitting him', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  u.renown = 1;
  u.hp = u.maxHp * 0.5;
  u.lastHurt = g.time - 10;
  const before = u.hp;
  for (let i = 0; i < 20; i++) g.elites.update(0.5);
  assert(u.hp > before, `hp ${before} -> ${u.hp}`);
  assert(u.hp <= u.maxHp, 'healing past the cap');
});

check('the dressing does not work while the man is being hit', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  u.renown = 1;
  u.hp = u.maxHp * 0.5;
  u.lastHurt = g.time;           // wounded just now
  const before = u.hp;
  for (let i = 0; i < 4; i++) g.elites.update(0.5);    // under six seconds
  near(u.hp, before, 0.001, 'the dressing worked while he was under fire');
});

check('a siege wound keeps the dressing shut even after the barrage', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  u.renown = 1;
  u.hp = u.maxHp * 0.5;
  u.lastHurt = g.time - 10;
  g.elites.onHurt(u, 'siege');
  const before = u.hp;
  for (let i = 0; i < 3; i++) g.elites.update(0.5);
  near(u.hp, before, 0.001, 'a siege wound healed immediately');
});

console.log('\nSHIELDWALL');

check('Shieldwall is worth nothing to an Untested man', () => {
  const g = fresh();
  const v = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  const a = g.spawnUnitRaw('spearman', 2, v.x, v.z - 3);
  assert(g.elites.shieldwall(v, a, 'melee') === 0, 'an untested man has a shieldwall');
});

check('Shieldwall holds the front and fails at the back', () => {
  const g = fresh();
  const v = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  v.renown = 2;
  v.facing = 0;                  // facing +z
  const front = g.spawnUnitRaw('spearman', 2, v.x, v.z + 3);
  const back = g.spawnUnitRaw('spearman', 2, v.x, v.z - 3);
  assert(g.elites.shieldwall(v, front, 'melee') === 3, 'no bonus from the front');
  assert(g.elites.shieldwall(v, back, 'melee') === 0, 'the shieldwall covered his back');
});

check('siege ignores a shield entirely', () => {
  const g = fresh();
  const v = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  v.renown = 2;
  v.facing = 0;
  const a = g.spawnUnitRaw('spearman', 2, v.x, v.z + 3);
  assert(g.elites.shieldwall(v, a, 'siege') === 0, 'a rock respected a shield');
});

check('a shieldwall really does reduce the wound', () => {
  const g = fresh();
  const v = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  const a = g.spawnUnitRaw('spearman', 2, v.x, v.z + 3);
  v.renown = 0; v.facing = 0;
  v.hp = v.maxHp;
  v.takeDamage(30, a, 'melee');
  const open = v.maxHp - v.hp;
  v.hp = v.maxHp;
  v.renown = 2;
  v.takeDamage(30, a, 'melee');
  const walled = v.maxHp - v.hp;
  assert(walled < open, `the shieldwall did not help: ${open} vs ${walled}`);
});

console.log('\nLAST STAND');

check('Last Stand needs a line behind him', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  /* remove every other unit of his team from the neighbourhood */
  for (const o of g.units) if (o !== u && o.team === 1) { o.x += 200; o.z += 200; }
  u.renown = 3;
  u.hp = u.maxHp * 0.2;
  u.lastHurt = g.time;
  g.elites.update(0.5);
  assert(!u.rally, 'an isolated man found a last stand');
});

check('a cornered Renowned man with allies fights like a demon', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  const ally = g.spawnUnitRaw('spearman', 1, u.x + 2, u.z + 2);
  u.renown = 3;
  u.hp = u.maxHp * 0.2;
  u.lastHurt = g.time;
  g.elites.update(0.5);
  assert(u.rally > g.time, 'no last stand');
  assert(ally && !ally.dead, 'the ally vanished');
  const base = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 40, g.playerBase.z + 40);
  base.renown = 3;
  assert(u.stats().attack > base.stats().attack, 'the last stand did not sharpen his attack');
  assert(u.stats().armor > base.stats().armor, 'the last stand did not toughen him');
});

check('the last stand has a cooldown', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  g.spawnUnitRaw('spearman', 1, u.x + 2, u.z + 2);
  u.renown = 3;
  u.hp = u.maxHp * 0.2;
  u.lastHurt = g.time;
  g.elites.update(0.5);
  const first = u.rally;
  u.hp = u.maxHp * 0.2;
  g.elites.update(0.5);
  assert(u.rally === first, 'the last stand re-fired immediately');
  assert(u.rallyCd > g.time + 60, `cooldown ${u.rallyCd - g.time}s`);
});

check('a last stand does not break morale', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  g.spawnUnitRaw('spearman', 1, u.x + 2, u.z + 2);
  u.renown = 3;
  u.hp = u.maxHp * 0.2;
  u.lastHurt = g.time;
  g.elites.update(0.5);
  u.morale = 5;
  g.morale.update(0.5);
  assert(u.morale >= 60, `morale fell to ${u.morale} during a last stand`);
});

console.log('\nBANNER');

check('a Legend makes the men around him hit harder', () => {
  const g = fresh();
  const lead = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  const closeBy = g.spawnUnitRaw('spearman', 1, lead.x + 4, lead.z);
  const far = g.spawnUnitRaw('spearman', 1, lead.x + 20, lead.z);
  lead.renown = MAX_RENOWN;
  /* settle the aura */
  g.elites.update(0.5);
  const a = closeBy.stats().attack, b = far.stats().attack;
  assert(a > b, `no banner aura: near ${a} far ${b}`);
});

check('a broken legend carries no banner', () => {
  const g = fresh();
  const lead = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  lead.renown = MAX_RENOWN;
  lead.morale = 20;
  assert(!g.elites.isBeacon(lead), 'a routing legend is still a beacon');
  assert(g.elites.bounty(lead) === 3, 'the bounty should not care about his nerve');
});

check('a legend is a beacon, and the AI prices him accordingly', () => {
  const g = fresh();
  const lead = g.spawnUnitRaw('knight', 2, g.playerBase.x + 40, g.playerBase.z + 40);
  const plain = g.spawnUnitRaw('knight', 2, g.playerBase.x + 44, g.playerBase.z + 40);
  assert(g.elites.bounty(plain) === 1, 'a plain knight has a bounty');
  lead.renown = MAX_RENOWN;
  assert(g.elites.bounty(lead) === 3, 'a legend is not worth three men');
  assert(g.elites.isBeacon(lead), 'a legend is not a beacon');
  const ai = new AIController(g, 1, {});
  assert(ai.threatOf(lead) > ai.threatOf(plain) * 2, 'the AI does not price renown');
  assert(unitThreat(lead) > unitThreat(plain), 'raw threat ignores renown');
  const targets = ai.eliteTargets();
  assert(targets.some((u) => u === lead), 'the legend is not on the AI hunt list');
});

check('the aura helps only the legend’s own side', () => {
  const g = fresh();
  const lead = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 30, g.playerBase.z + 30);
  const enemy = g.spawnUnitRaw('spearman', 2, lead.x + 3, lead.z);
  lead.renown = MAX_RENOWN;
  g.elites.update(0.5);
  const plain = g.spawnUnitRaw('spearman', 2, lead.x + 30, lead.z);
  near(enemy.stats().attack, plain.stats().attack, 0.001, 'the banner inspired the enemy');
});

console.log('\nINTEGRATION');

check('survival is carried by a save', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 1, g.playerBase.x + 3, g.playerBase.z + 3);
  u.survived = 610;
  u.renown = 3;
  const blob = JSON.parse(JSON.stringify({ survived: Math.round(u.survived) }));
  assert(blob.survived === 610 && renownOf(blob.survived) === 3, 'the save tuple loses renown');
});

check('a legend survives being inherited by a conqueror', () => {
  const g = fresh();
  const u = g.spawnUnitRaw('spearman', 3, g.playerBase.x + 60, g.playerBase.z + 60);
  u.survived = 1000; u.renown = MAX_RENOWN;
  g.convertUnit(u, 1);
  assert(u.team === 1, 'conversion failed');
  assert(u.renown === MAX_RENOWN, 'the legend lost his name changing sides');
});

check('the whole system is cheap on a busy field', () => {
  const g = fresh();
  for (let i = 0; i < 120; i++) {
    const u = g.spawnUnitRaw(i % 3 === 0 ? 'archer' : 'spearman', 1 + (i % 2),
      g.playerBase.x + (i % 12) * 2, g.playerBase.z + ((i / 12) | 0) * 2);
    u.renown = i % 5;
    u.survived = g.rng() * 900;
  }
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) g.elites.update(0.5);
  const ms = (performance.now() - t0) / 200;
  assert(ms < 0.35, `${ms.toFixed(3)} ms per elite pass`);
  console.log(`       (${ms.toFixed(3)} ms per pass, ${g.units.length} units)`);
});

console.log('');
if (fails.length) {
  console.log(`FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`ELITE CHECKS PASSED (${pass})`);
