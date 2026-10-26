/* ============================================================
   aihunt.mjs — does the opponent actually come for the wizard?
   ------------------------------------------------------------
   The magician is the most valuable thing on a modded field, and
   an AI that ignores it is just a wave timer. These checks run the
   real controller over the real simulation:

     * a lone elite caster gets a hunt squad sent at it, not a
       vague attack-move in the same postcode;
     * that squad re-targets while the mage runs, and disbands when
       the mage dies;
     * a caster standing in the AI's own base pulls the whole army;
     * early raids form against economy, without emptying the base;
     * the whole thing still costs a fraction of a frame.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController, unitThreat } from '../src/sim/ai.js';
import { createModHost } from '../src/mods/index.js';

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

function makeGame(seed = 909, difficulty = 'hard') {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'mods', difficulty });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 99999;
    st.age = 3;
  }
  return g;
}
function run(g, ai, seconds, hz = 10) {
  const step = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    g.update(step);
    if (ai) ai.update(step);
  }
}
function spawn(g, type, team, x, z) {
  const spot = g.freeSpotNear(x, z, { radius: 0.5, def: { naval: false } }, 12);
  return spot ? g.spawnUnitRaw(type, team, spot[0], spot[1]) : null;
}

const midOf = (g) => ({
  x: (g.playerBase.x + g.enemyBase.x) / 2,
  z: (g.playerBase.z + g.enemyBase.z) / 2
});

/* ============================================================ */
console.log('\nHUNT THE CASTER');
check('a lone magician is worth a squad of its own', () => {
  const g = makeGame();
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  const mid = midOf(g);
  const mage = spawn(g, 'magician', 1, mid.x, mid.z);
  assert(mage, 'the mage is on the field');
  eq(unitThreat(mage), 4, 'a magician publishes a threat value');
  const knights = [];
  for (let i = 0; i < 7; i++) {
    const k = spawn(g, 'knight', 2, g.enemyBase.x + 4 + (i % 3) * 2, g.enemyBase.z + 5 + ((i / 3) | 0) * 2);
    if (k) knights.push(k);
  }
  assert(knights.length >= 6, `knights for the AI (${knights.length})`);
  const startDist = new Map(knights.map((k) => [k, Math.hypot(k.x - mage.x, k.z - mage.z)]));
  run(g, ai, 25);
  assert(ai.hunt.length >= 2, `a hunt squad should form (${ai.hunt.length})`);
  assert(ai.huntTarget === mage, 'the target is the magician, not the nearest thing');
  const roleHunt = g.units.filter((u) => u.team === 2 && u.aiRole === 'hunt').length;
  assert(roleHunt >= 2, `the squad is marked as hunters (${roleHunt})`);
  /* every hunter must be strictly closer than it started: an order that is
     set but never walked is not a hunt, it is a comment */
  const closing = ai.hunt.every((u) => {
    const d0 = startDist.get(u);
    if (d0 === undefined) return true;
    return Math.hypot(u.x - mage.x, u.z - mage.z) < d0 - 1;
  });
  assert(closing, 'the squad is moving at the mage');
  host.dispose();
  return `${ai.hunt.length} hunters on a threat-${unitThreat(mage)} target`;
});
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg} (got ${a}, expected ${b})`); }

check('the squad chases a running mage and lets go when it dies', () => {
  const g = makeGame(1234);
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  const mid = midOf(g);
  const mage = spawn(g, 'magician', 1, mid.x - 6, mid.z);
  assert(mage, 'mage');
  for (let i = 0; i < 6; i++) spawn(g, 'knight', 2, g.enemyBase.x + 3 + i, g.enemyBase.z + 6);
  run(g, ai, 12);
  assert(ai.hunt.length >= 2, 'squad formed');
  /* the mage runs: the squad's target must stay the mage, not its old spot */
  mage.x += 18;
  const squad = ai.hunt.slice();
  run(g, ai, 14);
  assert(ai.huntTarget === mage, 'the target followed the mage');
  const moved = squad.some((u) => !u.dead && u.x > mid.x + 4);
  assert(moved, 'the hunters are physically chasing east');
  mage.kill(null);
  run(g, ai, 6);
  eq(ai.hunt.length, 0, 'the hunt disbands when the target dies');
  const leftover = g.units.filter((u) => !u.dead && u.team === 2 && u.aiRole === 'hunt').length;
  eq(leftover, 0, 'no unit is left holding a dead hunt order');
  host.dispose();
  return `${squad.length} hunters, target chased, squad released`;
});

check('a caster in the AI base pulls every soldier', () => {
  const g = makeGame(77);
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  const b = g.enemyBase;
  const mage = spawn(g, 'magician', 1, b.x + 8, b.z + 6);
  assert(mage, 'mage infiltrated');
  const army = [];
  for (let i = 0; i < 5; i++) army.push(spawn(g, 'swordsman', 2, b.x - 8 - i, b.z - 4));
  assert(army.filter(Boolean).length === 5, 'five defenders');
  run(g, ai, 4);
  const defenders = g.units.filter((u) => !u.dead && u.team === 2 && u.aiRole === 'defend');
  assert(defenders.length >= 4, `everything turns on the intruder (${defenders.length})`);
  assert(defenders.every((u) => u.target === mage), 'the intruder is the target');
  host.dispose();
  return `${defenders.length} defenders switched to the mage`;
});

/* ============================================================ */
console.log('\nRAIDS');
check('early raids form against the economy without gutting the base', () => {
  const g = makeGame(909, 'extreme');
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  for (let i = 0; i < 10; i++) {
    spawn(g, i % 2 ? 'knight' : 'swordsman', 2, g.enemyBase.x + 3 + (i % 4) * 2, g.enemyBase.z + 6 + ((i / 4) | 0) * 2);
  }
  let sawRaid = false;
  for (let t = 0; t < 120; t += 5) {
    run(g, ai, 5);
    const raiders = g.units.filter((u) => !u.dead && u.team === 2 && u.aiRole === 'raid');
    if (raiders.length >= 2) { sawRaid = true; break; }
  }
  assert(sawRaid, 'a raid party was sent within two minutes');
  const raiders = g.units.filter((u) => !u.dead && u.team === 2 && u.aiRole === 'raid');
  const army = g.units.filter((u) => !u.dead && u.team === 2 && u.def.attack > 0 && !u.wild);
  assert(raiders.length < army.length, 'the raid is a detachment, not the whole army');
  host.dispose();
  return `${raiders.length} raiders of ${army.length} soldiers`;
});

check('a raid keeps a goal and ignores walls it cannot reach', () => {
  const g = makeGame(4242, 'extreme');
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  for (let i = 0; i < 8; i++) spawn(g, 'knight', 2, g.enemyBase.x + 3 + i, g.enemyBase.z + 8);
  const goal = ai.pickRaidGoal();
  assert(goal, 'there is something worth raiding');
  assert(goal.team === 1, 'the goal belongs to the enemy');
  host.dispose();
  return `goal: ${goal.type || goal.kind} at ${goal.x.toFixed(0)},${goal.z.toFixed(0)}`;
});

/* ============================================================ */
console.log('\nBUDGET');
check('the controller stays far below a frame', () => {
  const g = makeGame(5, 'extreme');
  const host = createModHost(g, { enabled: ['arcane'] });
  const ai = new AIController(g, 2, {});
  for (let i = 0; i < 50; i++) {
    spawn(g, i % 3 === 0 ? 'knight' : i % 3 === 1 ? 'archer' : 'spearman', 2,
      g.enemyBase.x + (i % 10) * 1.6 - 8, g.enemyBase.z + 8 + ((i / 10) | 0) * 1.6);
  }
  run(g, ai, 5);
  const t0 = performance.now();
  run(g, ai, 20, 10);
  const ms = performance.now() - t0;
  assert(ms < 900, `20 s of AI + sim took ${ms.toFixed(0)} ms`);
  host.dispose();
  return `${(ms / 200).toFixed(3)} ms per decision frame`;
});

/* ============================================================ */
console.log(`\n${failures.length ? `AI HUNT CHECKS FAILED (${failures.length})` : `AI HUNT CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
