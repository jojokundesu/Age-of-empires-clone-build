/* Combat balance test.
   Two *equal-cost* armies fight to the death. Because the composition differs
   the fight should be close: both sides must lose most of their troops and the
   winner should be left with a handful. Also verifies that armour and the
   counter triangle actually matter. */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE, Unit } from '../src/sim/entities.js';
import { UNIT_DEFS } from '../src/sim/data.js';

const world = generateWorld(20261);
const cost = (t) => Object.values(UNIT_DEFS[t].cost || {}).reduce((a, b) => a + b, 0);

function battle(armyA, armyB, seconds = 120) {
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  game.start();
  game.units.length = 0;
  const rows = (list) => list.flatMap(([type, n]) => Array.from({ length: n }, () => type));
  const A = [], B = [];
  rows(armyA).forEach((type, i) => {
    A.push(game.spawnUnitRaw(type, 1, -9 + (i % 4) * 1.35, -4 + ((i / 4) | 0) * 1.35));
  });
  rows(armyB).forEach((type, i) => {
    B.push(game.spawnUnitRaw(type, 2, 9 + (i % 4) * 1.35, -4 + ((i / 4) | 0) * 1.35));
  });
  for (const u of A) { u.noAggro = false; u.moveTo(14, 0); u.state = STATE.ATTACK_MOVE; }
  for (const u of B) { u.noAggro = false; u.moveTo(-14, 0); u.state = STATE.ATTACK_MOVE; }
  let maxProj = 0, firstBlood = -1;
  for (let i = 0; i < 60 * seconds; i++) {
    game.update(1 / 60);
    maxProj = Math.max(maxProj, game.projectiles.activeCount);
    const aliveA = A.filter((u) => !u.dead).length, aliveB = B.filter((u) => !u.dead).length;
    if (firstBlood < 0 && (aliveA < A.length || aliveB < B.length)) firstBlood = game.time;
    if (!aliveA || !aliveB) break;
  }
  const aliveA = A.filter((u) => !u.dead), aliveB = B.filter((u) => !u.dead);
  const hpA = aliveA.reduce((s, u) => s + u.hp, 0), hpB = aliveB.reduce((s, u) => s + u.hp, 0);
  const totalA = A.reduce((s, u) => s + u.maxHp, 0), totalB = B.reduce((s, u) => s + u.maxHp, 0);
  return {
    a: aliveA.length, b: aliveB.length, total: A.length, totalB: B.length,
    hpA, hpB, maxProj, firstBlood, t: game.time,
    lostA: 1 - aliveA.length / A.length, lostB: 1 - aliveB.length / B.length,
    hpFracA: hpA / totalA, hpFracB: hpB / totalB
  };
}

const fails = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert'); };
function expect(cond, msg) { if (!cond) { fails.push(msg); console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); }

/* ---- equal-cost main battle: 1005 resources each ---- */
const armyA = [['spearman', 9], ['archer', 6]];              // 585 + 420 = 1005
const armyB = [['swordsman', 6], ['archer', 4], ['knight', 2]]; // 450 + 280 + 270 = 1000
const costA = armyA.reduce((s, [t, n]) => s + cost(t) * n, 0);
const costB = armyB.reduce((s, [t, n]) => s + cost(t) * n, 0);
console.log(`\nequal-cost battle: A=$${costA} (${armyA.map(([t, n]) => n + ' ' + t).join(', ')}) vs B=$${costB} (${armyB.map(([t, n]) => n + ' ' + t).join(', ')})`);
const r = battle(armyA, armyB);
console.log(`  result: A ${r.a}/${r.total} alive (${(r.hpFracA * 100).toFixed(0)}% hp), B ${r.b}/${r.totalB} alive (${(r.hpFracB * 100).toFixed(0)}% hp) after ${r.t.toFixed(1)} s, first blood ${r.firstBlood.toFixed(1)} s, ${r.maxProj} projectiles in flight`);
expect(r.lostA >= 0.7 && r.lostB >= 0.7, `both sides take heavy losses (A ${(r.lostA * 100) | 0}%, B ${(r.lostB * 100) | 0}%)`);
expect(r.hpFracA + r.hpFracB < 0.45, `the battlefield is left wrecked (${((r.hpFracA + r.hpFracB) * 100) | 0}% of both armies' hp left)`);
expect(r.firstBlood > 0.5, 'nobody dies in the first half second');
expect(r.maxProj > 0, 'archers actually loose arrows');
const balance = Math.abs(r.hpFracA - r.hpFracB);
expect(balance < 0.25, `outcome is not a walkover (hp delta ${(balance * 100) | 0}%)`);

/* ---- counter triangle (equal counts) ---- */
console.log('\ncounter triangle');
const tri = [
  ['spearman', 'knight', 'spears beat cavalry'],
  ['archer', 'spearman', 'archers beat slow infantry'],
  ['knight', 'archer', 'cavalry rides down archers'],
  ['skirmisher', 'archer', 'skirmishers beat archers'],
  ['swordsman', 'spearman', 'swordsmen beat spears in melee']
];
for (const [a, b, label] of tri) {
  const res = battle([[a, 6]], [[b, 6]], 60);
  const winner = res.a > res.b ? a : res.b > res.a ? b : 'draw';
  console.log(`  ${a} vs ${b}: A ${res.a} B ${res.b} (${res.t.toFixed(1)} s) -> ${winner}`);
  expect(winner === a, label);
}

/* ---- armour matters: the same hit hurts a knight less than an archer ---- */
console.log('\narmour');
const g2 = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g2.start();
const sword = g2.spawnUnitRaw('swordsman', 1, 0, 0);
const knight = g2.spawnUnitRaw('knight', 1, 2, 0);
const archer = g2.spawnUnitRaw('archer', 1, 4, 0);
const hit = (u, kind) => { const before = u.hp; u.takeDamage(20, sword, kind); return before - u.hp; };
const dmgKnight = hit(knight, 'melee');
const dmgArcher = hit(archer, 'melee');
const dmgArcherPierce = hit(archer, 'pierce');
const dmgKnightPierce = hit(knight, 'pierce');
console.log(`  melee 20 -> knight ${dmgKnight}, archer ${dmgArcher}; pierce 20 -> knight ${dmgKnightPierce}, archer ${dmgArcherPierce}`);
expect(dmgArcher > dmgKnight, 'armour reduces melee damage');
expect(dmgArcherPierce >= dmgArcherPierce, 'pierce armour applies to arrows');

console.log('');
if (fails.length) { console.log(`FAILURES (${fails.length})`); process.exit(1); }
console.log('COMBAT BALANCE PASSED');


/* ---- victory rules ------------------------------------------------------- */
{
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  const check = (msg, fn) => {
    try { fn(); console.log('  ok   ' + msg); }
    catch (e) { fails.push(msg + ': ' + e.message); console.log('  FAIL ' + msg + ' - ' + e.message); }
  };
  check('a team with no buildings left loses after the grace period', () => {
    for (const b of g.buildings) if (b.team === 2) { b.dead = true; }
    for (const u of g.units) if (u.team === 2) { u.dead = true; }
    // a lone survivor that cannot rebuild
    const lone = g.spawnUnitRaw('villager', 2, g.world.enemyBase.x, g.world.enemyBase.z);
    g.time = 100;
    g.checkVictory();
    assert(!g.gameOver, 'ended instantly, no grace period');
    g.time = 100 + 61;
    g.checkVictory();
    assert(g.gameOver && g.result.reason === 'dominance', 'dominance never triggered: ' + JSON.stringify(g.result));
    assert(g.result.win === true, 'player did not win');
  });
  check('one standing building is enough to stay alive', () => {
    const g2 = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
    g2.start();
    const keep = g2.buildings.find((b) => b.team === 2 && !b.dead);
    for (const b of g2.buildings) if (b.team === 2 && b !== keep) b.dead = true;
    g2.time = 100; g2.checkVictory();
    g2.time = 400; g2.checkVictory();
    assert(!g2.gameOver, 'a team with a building was declared dead');
  });
  check('conquest still ends the match the moment the last unit dies', () => {
    const g3 = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
    g3.start();
    for (const b of g3.buildings) if (b.team === 2) b.dead = true;
    for (const u of g3.units) if (u.team === 2) u.dead = true;
    g3.checkVictory();
    assert(g3.gameOver && g3.result.reason === 'conquest', 'conquest did not fire: ' + JSON.stringify(g3.result));
  });
  check('sandbox never ends', () => {
    const g4 = new Game({ world, civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
    g4.start();
    for (const u of g4.units) if (u.team === 2) u.dead = true;
    g4.time = 900; g4.checkVictory();
    assert(!g4.gameOver, 'sandbox ended the match');
  });
}
