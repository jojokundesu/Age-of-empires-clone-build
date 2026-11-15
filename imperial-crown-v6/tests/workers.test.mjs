import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { Building, ResourceNode, STATE } from '../src/sim/entities.js';

const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'campaign' }).start();
const v = g.units.find(u => u.type === 'villager' && u.team === 1);
const x = v.x, z = v.z;
// Use explicit nodes so this test does not depend on random forests.
const depleted = new ResourceNode(g, 'gold_mine', x + 0.5, z, 0.01, { resKind: 'gold' });
const next = new ResourceNode(g, 'gold_mine', x + 4, z, 100, { resKind: 'gold' });
const different = new ResourceNode(g, 'stone_mine', x + 1, z, 100, { resKind: 'stone' });
const far = new ResourceNode(g, 'gold_mine', x + 40, z, 100, { resKind: 'gold' });
g.resources.push(depleted, next, different, far);
assert.equal(g.findReplacementResource(depleted, v), next, 'choose closest matching type');
assert.equal(g.findReplacementResource(next, v, 2), null, 'respect replacement radius');
v.gatherTarget = v.homeNode = depleted;
v.lastGatherKind = 'gold'; v.state = STATE.GATHER; v.gatherCooldown = 0;
v.carry.kind = null; v.carry.amount = 0;
v.updateGather(1 / 30, v.stats());
assert(depleted.dead);
assert.equal(v.gatherTarget, next, 'depletion should assign replacement');

const farm = new Building(g, 'farm', 1, x + 8, z + 2, true);
assert(v._gatherAfterConstruction(farm));
assert.equal(v.gatherTarget, farm);
assert.equal(v.state, STATE.GATHER);
const camp = new Building(g, 'mining_camp', 1, x + 4, z, true);
assert(v._gatherAfterConstruction(camp));
assert(['gold', 'stone'].includes(v.gatherTarget.resKind));
assert.equal(g.findNearestResource('gold', x, z, 1, v), null, 'resource search must not exceed radius');
// A blocked return route eventually pauses without losing its carried load.
const carrier = g.units.find(u => u.team === 1 && u.type === 'villager' && u !== v);
const home = g.buildings.find(b => b.team === 1 && b.type === 'town_center');
carrier.x = home.x + 60; carrier.z = home.z + 60;
carrier.carry.kind = 'wood'; carrier.carry.amount = 7;
carrier.dropOff = home; carrier.state = STATE.RETURN;
carrier._returnAnchor = { x: carrier.x, z: carrier.z, time: 12 };
carrier.updateReturn(0.1, carrier.stats());
assert.equal(carrier.state, STATE.IDLE);
assert.equal(carrier.carry.amount, 7);
assert(carrier._returnRetryAt > g.time);

// A worker never switches to an enemy's field.
const enemyFarm = new Building(g, 'farm', 2, x + 0.5, z + 0.5, true);
g.addBuilding(enemyFarm);
assert.notEqual(g.findNearestResource('food', enemyFarm.x, enemyFarm.z, 2, v), enemyFarm);

// A crowded exit must not stack occupants or silently discard them.
const tc = g.buildings.find(b => b.team === 1 && b.type === 'town_center');
const crew = g.units.filter(u => u.team === 1 && u.type === 'villager').slice(0, 3);
for (const u of crew) assert(tc.garrisonUnit(u));
const originalSearch = g.findNearestFreeTile;
g.findNearestFreeTile = () => null;
assert.equal(g.removeFromGarrison(crew[0]), false);
assert(crew[0].garrisoned && tc.garrison.includes(crew[0]));
g.findNearestFreeTile = originalSearch;
for (const u of crew) assert(g.removeFromGarrison(u));
for (let i = 0; i < crew.length; i++) for (let j = 0; j < i; j++) {
  assert(Math.hypot(crew[i].x - crew[j].x, crew[i].z - crew[j].z) >= crew[i].radius + crew[j].radius);
}
console.log('WORKER AUTOMATION AND GARRISON EXIT CHECKS PASSED');
