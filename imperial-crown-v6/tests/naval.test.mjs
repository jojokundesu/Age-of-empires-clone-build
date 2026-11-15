import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { DOMAIN } from '../src/sim/hydrology.js';
import { Game } from '../src/sim/game.js';
import { Building, ResourceNode, STATE } from '../src/sim/entities.js';

// A land peninsula separates two stretches of water, with a route around it.
const world = generateWorld(42);
const N = world.nav.cells, cell = world.nav.cell, half = world.half;
const domain = new Uint8Array(N * N);
for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
  const wx = (x + 0.5) * cell - half, wz = (z + 0.5) * cell - half;
  domain[z * N + x] = Math.abs(wx) < 6 && Math.abs(wz) < 20 ? DOMAIN.LAND_ONLY : DOMAIN.WATER_ONLY;
}
world.hydrology = {};
world.nav.domain = domain;
world.nav.domainAt = (x, z) => {
  const cx = Math.max(0, Math.min(N - 1, Math.floor((x + half) / cell)));
  const cz = Math.max(0, Math.min(N - 1, Math.floor((z + half) / cell)));
  return domain[cz * N + cx];
};
world.height.sample = (x, z) => world.nav.domainAt(x, z) === DOMAIN.WATER_ONLY ? -3 : 2;
world.height.slope = () => 0;
const g = new Game({ world, seed: 42 });
const ship = g.spawnUnitRaw('war_galley', 1, -20, 0);
const pf = g.pfFor(ship);
assert.notEqual(pf, g.pathFinder);
assert.equal(pf.isBlocked(...pf.worldToCell(0, 0)), true, 'land must block ships');
assert.equal(pf.isBlocked(...pf.worldToCell(-20, 0)), false);
ship.moveTo(20, 0, true);
assert(ship.path && ship.path.length > 2, 'ship must route around peninsula');
for (let i = 0; i < 1300; i++) {
  g.beginPathTicks();
  ship.stepMovement(1 / 30, ship.stats());
  assert(g.isPassable(ship.x, ship.z, ship), `ship reached land at ${ship.x},${ship.z}`);
  if (Math.hypot(ship.x - 20, ship.z) < 2) break;
}
assert(Math.hypot(ship.x - 20, ship.z) < 2, `ship did not reach water destination: ${ship.x},${ship.z}`);

const boat = g.spawnUnitRaw('fishing_boat', 1, -24, 12);
const fish = new ResourceNode(g, 'fish', -24, 14, 500, { resKind: 'food', radius: 1.5 });
const berries = new ResourceNode(g, 'berry_bush', -24, 12, 500, { resKind: 'food' });
g.resources.push(fish, berries);
assert.equal(g.findNearestResource('food', boat.x, boat.z, 30, boat), fish, 'boats must find fish, not berries');
g.orderGather([boat], fish);
assert.equal(boat.state, STATE.GATHER);
assert.equal(boat.gatherTarget, fish);
const dock = new Building(g, 'dock', 1, -26, 12, true);
const town = new Building(g, 'town_center', 1, -24, 10, true);
g.addBuilding(dock);
g.addBuilding(town);
assert.equal(g.findDropoff(1, 'food', boat.x, boat.z, 999, boat), dock, 'boats deposit at docks');
const foodBefore = g.teams.get(1).res.food;
for (let i = 0; i < 1800 && g.teams.get(1).res.food <= foodBefore; i++) {
  g.beginPathTicks();
  if (boat.state === STATE.GATHER) boat.updateGather(1 / 30, boat.stats());
  else if (boat.state === STATE.RETURN) boat.updateReturn(1 / 30, boat.stats());
}
assert(g.teams.get(1).res.food > foodBefore, 'fishing boat must gather and deliver food');
const spot = g.findNearestFreeTile(boat.x, boat.z, { def: boat.def, radius: boat.radius, team: 1 });
assert(spot && g.isPassable(...spot, boat));
assert(Math.hypot(spot[0] - boat.x, spot[1] - boat.z) >= boat.radius * 2, 'spawn tile occupied');
console.log('NAVAL NAVIGATION AND FISHING CHECKS PASSED');
