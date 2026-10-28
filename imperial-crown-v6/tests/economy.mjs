/* ============================================================
   economy.mjs — the men who feed the war

   The three complaints this suite exists for, in the player's own
   words:

     · "villagers just doing anything after a while" — a work force
       that quietly dissolves into people standing about;
     · "I don't think farms work either" — a farm cost 60 wood and
       produced nothing at all, because nothing ever turned the
       building into something a villager could harvest;
     · and the watchdog that made the first one worse: standing still
       at a tree counted as being stuck, so every 3.5 s a woodcutter
       lost his tree and went idle.

   Every check here runs the real simulation, not a model of it.
   ============================================================ */
import nodeAssert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';

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
assert.equal = (a, b, msg) => nodeAssert.equal(a, b, msg);
assert.deepEqual = (a, b, msg) => nodeAssert.deepEqual(a, b, msg);

function makeGame(mode = 'campaign') {
  const world = generateWorld(20261);
  const g = new Game({ world, civ: 'franks', mode, difficulty: 'standard' });
  g.start();
  g.running = true;
  g.checkVictory = () => {};
  g.gameOver = false;
  /* the enemy's own AI is not part of these questions */
  g.ais = [];
  return g;
}
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) g.update(1 / 30); };
const villagers = (g, team = 1) => g.units.filter((u) => u.team === team && !u.dead && u.type === 'villager');
function openSpot(g, type, team = 1) {
  const base = g.baseOf(team) || g.world.playerBase;
  for (let r = 8; r < 60; r += 3) {
    for (let a = 0; a < 16; a++) {
      const x = base.x + Math.cos((a / 16) * Math.PI * 2) * r;
      const z = base.z + Math.sin((a / 16) * Math.PI * 2) * r;
      if (g.canPlaceAt(type, team, x, z).ok) return [x, z];
    }
  }
  throw new Error(`nowhere to put a ${type}`);
}
function complete(b) { b.buildProgress = 1; b.completedOnce = true; return b; }

/* ============================================================ */
console.log('THE WORK FORCE');

check('a villager chopping a tree is not declared stuck while he chops', () => {
  const g = makeGame();
  const v = villagers(g)[0];
  assert(v, 'no villager');
  const tree = g.findNearestResource('wood', v.x, v.z, 40, v);
  assert(tree, 'no tree within 40 m');
  v.gatherTarget = tree; v.homeNode = tree; v.lastGatherKind = 'wood'; v.state = STATE.GATHER;
  v.moveTo(tree.x, tree.z, true);
  let lost = 0;
  for (let s = 0; s < 120; s++) {
    run(g, 1);
    /* depositing a full load is work; standing with nothing to do is not */
    const working = v.state === STATE.GATHER || v.state === STATE.RETURN;
    if (!working || !v.gatherTarget) lost++;
  }
  assert(lost === 0, `he stood about ${lost} times in two minutes`);
  assert(v.carry.amount > 0 || g.teams.get(1).res.wood > 0, 'he never actually gathered anything');
  return 'two minutes at one tree, target kept';
});

check('a work force is still working five minutes later', () => {
  const g = makeGame();
  const pool = villagers(g);
  assert(pool.length >= 3, 'not enough villagers to test');
  const tree = g.findNearestResource('wood', pool[0].x, pool[0].z, 60, pool[0]);
  assert(tree, 'no trees near the town');
  for (const v of pool) {
    v.gatherTarget = tree; v.homeNode = tree; v.lastGatherKind = 'wood';
    v.state = STATE.GATHER; v.moveTo(tree.x, tree.z, true);
  }
  const start = g.teams.get(1).res.wood;
  run(g, 300);
  const idle = pool.filter((v) => v.state === STATE.IDLE).length;
  const gain = g.teams.get(1).res.wood - start;
  assert(gain > 300, `five minutes of five woodcutters produced ${gain.toFixed(0)} wood`);
  assert(idle === 0, `${idle} of ${pool.length} villagers had stopped working`);
  return `${gain.toFixed(0)} wood, nobody idle`;
});

check('a villager with nothing left nearby finds work again by himself', () => {
  const g = makeGame('sandbox');
  const v = villagers(g)[0];
  assert(v, 'no villager');
  /* strip every node within the old 26 m ring, then let him go */
  let stripped = 0;
  for (const r of g.resources) {
    if (r.dead) continue;
    if (Math.hypot(r.x - v.x, r.z - v.z) < 60) { r.amount = 0; r.dead = true; stripped++; }
  }
  assert(stripped > 0, 'nothing to strip');
  v.carry.amount = 0; v.carry.kind = null;
  v.gatherTarget = null; v.homeNode = null; v.lastGatherKind = 'wood';
  v.state = STATE.IDLE;
  let first = null;
  for (let t = 0; t < 400 && !first; t++) {
    g.update(1 / 30);
    if (v.gatherTarget && v.gatherTarget.amount > 0) first = Math.hypot(v.gatherTarget.x - v.x, v.gatherTarget.z - v.z);
    if (v.state === STATE.IDLE && t > 200) break;
  }
  assert(first !== null, 'he stood about instead of looking further out');
  assert(first > 26, `the search should reach past the old ring (${first.toFixed(0)} m)`);
  return `pick a node ${first.toFixed(0)} m away`;
});

check('the enemy AI keeps its own villagers working too', () => {
  const g = makeGame();
  const ai = new AIController(g, 2, { aggression: 0.62 });
  for (let i = 0; i < 180 * 30; i++) { g.update(1 / 30); ai.update(1 / 30); }
  const pool = g.units.filter((u) => u.team === 2 && !u.dead && u.type === 'villager');
  assert(pool.length >= 4, `the AI only has ${pool.length} villagers after three minutes`);
  const working = pool.filter((v) => v.state === STATE.GATHER || v.state === STATE.RETURN || v.state === STATE.BUILD);
  assert(working.length >= Math.ceil(pool.length * 0.75),
    `only ${working.length} of ${pool.length} AI villagers are working`);
  return `${working.length}/${pool.length} working`;
});

/* ============================================================ */
console.log('\nTHE WATCH');

check('the watch reports an army closing on the walls, and only a real one', () => {
  const g = makeGame();
  const base = g.baseOf(1) || g.world.playerBase;
  const said = [];
  g.notify = (text) => said.push(text);
  const place = (n) => {
    for (let i = 0; i < n; i++) {
      const u = g.spawnUnitRaw('swordsman', 2, base.x + 30 + i * 1.5, base.z + 30);
      if (u) { u.stance = 'stand'; u.state = STATE.IDLE; }
    }
  };
  place(2);
  run(g, 3);
  assert(said.length === 0, `two stragglers raised the alarm: ${said.join(' / ')}`);
  place(4);
  run(g, 3);
  const line = said.find((t) => /lookout/i.test(t));
  assert(line, `six soldiers at the walls and no warning (${said.join(' / ') || 'silence'})`);
  assert(/enemy soldiers/i.test(line), `the warning does not say what it saw: ${line}`);
  assert(/(north|south|east|west)/i.test(line), `the warning gives no direction: ${line}`);
  return line;
});

/* ============================================================ */
console.log('\nFARMS');

check('a finished farm is food a villager can actually harvest', () => {
  const g = makeGame('sandbox');
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  assert(farm, 'the farm was not placed');
  complete(farm);
  assert.equal(farm.resKind, 'food', 'a farm carries no food');
  assert(farm.amount > 0, 'a farm carries no yield');
  assert.equal(g.findNearestResource('food', farm.x, farm.z, 30, villagers(g)[0]), farm,
    'the villager search cannot find the farm');
  const v = g.spawnUnitRaw('villager', 1, farm.x + 8, farm.z + 8);
  v.carry.amount = 0; v.carry.kind = null;
  v.gatherTarget = farm; v.homeNode = farm; v.lastGatherKind = 'food';
  v.state = STATE.GATHER; v.moveTo(farm.x, farm.z, true);
  const before = farm.amount;
  run(g, 30);
  assert(farm.amount < before - 20, `he took ${(before - farm.amount).toFixed(0)} food in 30 s`);
  assert.equal(v.gatherTarget, farm, 'he wandered off his own field');
  return `${(before - farm.amount).toFixed(0)} food in 30 s`;
});

check('ordering villagers onto a farm pins that farm as their home', () => {
  const g = makeGame('sandbox');
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  complete(farm);
  const v = g.spawnUnitRaw('villager', 1, farm.x + 9, farm.z + 9);
  g.setSelection([v]);
  g.orderGather([v], farm);
  assert.equal(v.homeNode, farm, 'the field the player pointed at is not the villager\'s home');
  assert.equal(v.gatherTarget, farm, 'the villager was not sent to the field');
  return 'the tapped field became homeNode and gatherTarget';
});

check('a farm is not abandoned for a closer bush', () => {
  const g = makeGame('sandbox');
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  complete(farm);
  const v = g.spawnUnitRaw('villager', 1, farm.x + 4, farm.z + 4);
  /* a berry bush two metres away, with food in it: the field must still win */
  const bush = g.resources.find((r) => r.resKind === 'food' && !r.dead) || null;
  if (bush) { bush.x = farm.x + 2; bush.z = farm.z + 2; bush.amount = 400; }
  g.orderGather([v], farm);
  run(g, 8);
  assert.equal(v.gatherTarget, farm, `he wandered to ${v.gatherTarget && v.gatherTarget.resKind === 'food' ? 'another food source' : 'nothing'}`);
  return 'the ordered field keeps the farmer';
});

check('a harvested field is resown for wood, not destroyed', () => {
  const g = makeGame();
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  complete(farm);
  const v = g.spawnUnitRaw('villager', 1, farm.x + 6, farm.z + 6);
  v.gatherTarget = farm; v.homeNode = farm; v.lastGatherKind = 'food';
  v.state = STATE.GATHER; v.moveTo(farm.x, farm.z, true);
  g.teams.get(1).res.wood = 500;
  farm.amount = 1;
  /* the town's other woodcutters keep delivering, so the stockpile is the
     wrong instrument here: the reseed event is recorded with the purse it
     was paid from */
  const paid = [];
  const emit = g.onEvent.bind(g);
  g.onEvent = (name, data) => {
    if (name === 'reseed') paid.push(g.teams.get(1).res.wood);
    return emit(name, data);
  };
  run(g, 25);
  assert(!farm.dead, 'harvesting the last sheaf destroyed the farm');
  assert(farm.amount > 150, `the field was not resown (${farm.amount.toFixed(0)})`);
  assert(paid.length >= 1, 'the field refilled itself for free');
  assert(paid[0] === 440, `the reseed cost ${500 - paid[0]} wood, not 60`);
  return `resown with ${farm.amount.toFixed(0)} food left, 60 wood paid`;
});

check('a farm with no wood stays bare and the farmer goes elsewhere', () => {
  const g = makeGame();
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  complete(farm);
  const v = g.spawnUnitRaw('villager', 1, farm.x + 6, farm.z + 6);
  v.gatherTarget = farm; v.homeNode = farm; v.lastGatherKind = 'food';
  v.state = STATE.GATHER; v.moveTo(farm.x, farm.z, true);
  g.teams.get(1).res.wood = 0;
  farm.amount = 1;
  run(g, 20);
  assert(!farm.dead, 'the farm was destroyed by being harvested');
  assert(v.gatherTarget !== farm || farm.amount > 0, 'he is still trying to harvest a bare field');
  return 'the field stayed standing, the farmer moved on';
});

check('a farm under construction cannot be harvested', () => {
  const g = makeGame('sandbox');
  const [x, z] = openSpot(g, 'farm');
  const farm = g.placeBuilding('farm', 1, x, z, true);
  farm.buildProgress = 0.4;
  assert.equal(g.findNearestResource('food', farm.x, farm.z, 30, villagers(g)[0]) === farm, false,
    'a half-built farm is being harvested');
  return 'a furrow in progress is not a harvest';
});

console.log(`\nECONOMY ${failures.length ? 'CHECKS FAILED (' + failures.length + ')' : 'CHECKS PASSED'} (${passed})`);
if (failures.length) for (const f of failures) console.log(` - ${f.name}: ${f.e.message}`);
process.exit(failures.length ? 1 : 0);
