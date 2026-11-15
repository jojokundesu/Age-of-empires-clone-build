import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { DOMAIN } from '../src/sim/hydrology.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';

// A straight coast: land on the east, deep water on the west.
const world = generateWorld(89);
const n = world.nav.cells, cell = world.nav.cell, half = world.half;
const domain = new Uint8Array(n * n);
for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
  const wx = (x + 0.5) * cell - half;
  const i = z * n + x;
  domain[i] = wx < 0 ? DOMAIN.WATER_ONLY : DOMAIN.LAND_ONLY;
  world.nav.blocked[i] = wx < 0 ? 1 : 0;
}
world.hydrology = {};
world.nav.domain = domain;
world.nav.domainAt = (x, z) => domain[Math.max(0, Math.min(n - 1, Math.floor((z + half) / cell))) * n + Math.max(0, Math.min(n - 1, Math.floor((x + half) / cell)))];
world.height.sample = (x, z) => world.nav.domainAt(x, z) === DOMAIN.WATER_ONLY ? -2 : 2;
world.height.slope = () => 0;
const g = new Game({ world, seed: 89 });
assert.equal(g.canPlaceAt('dock', 1, -30, 40).reason, 'shoreline', 'deep-water docks cannot be built');
assert(g.canPlaceAt('dock', 1, -3, 40).ok, 'shoreline dock should be placeable');
g.teams.get(1).res.wood = 500;
const builder = g.spawnUnitRaw('villager', 1, 8, 40);
const dock = g.placeBuilding('dock', 1, -3, 40);
assert(dock, 'paid dock placement should succeed');
g.orderBuild([builder], dock);
for (let i = 0; i < 900 && dock.buildProgress < 1; i++) {
  g.beginPathTicks();
  builder.updateBuild(1 / 30, builder.stats());
  dock.update(1 / 30);
}
assert(dock.buildProgress >= 1, `villager must be able to build a shoreline dock: ${dock.buildProgress}`);
const produced = g.spawnUnit('transport_ship', 1, dock.x, dock.z, dock, { force: true });
assert(produced && g.isPassable(produced.x, produced.z, produced), 'dock spawns ship on water');
const ship = g.spawnUnitRaw('transport_ship', 1, -3, 0);
assert.equal(ship.def.capacity, 12);
const villager = g.spawnUnitRaw('villager', 1, 8, 0);
g.orderGarrison([villager], ship);
assert.equal(villager.state, STATE.GARRISON);
for (let i = 0; i < 600 && !villager.garrisoned; i++) {
  g.beginPathTicks();
  villager.updateGarrisonMove(1 / 30, villager.stats());
}
assert(villager.garrisoned, 'unit must walk to the coast and board');
assert.equal(villager.garrisonTarget, ship);
const passengers = [villager];
for (let i = 0; i < 11; i++) {
  const u = g.spawnUnitRaw('archer', 1, 1, 0);
  assert(g.boardTransport(u, ship));
  passengers.push(u);
}
const extra = g.spawnUnitRaw('archer', 1, 1, 0);
assert(!g.boardTransport(extra, ship), 'thirteenth passenger must be refused');
assert.equal(ship.garrison.length, 12);
ship.x = -30;
assert.equal(g.unloadTransport(ship), 0, 'cannot disembark in deep water');
assert.equal(ship.garrison.length, 12);
ship.x = -3;
const count = g.unloadTransport(ship);
assert(count > 0, 'shore unloading releases available units');
for (const u of passengers.filter(u => !u.garrisoned)) {
  assert(g.isPassable(u.x, u.z, u));
  assert(Math.hypot(u.x - ship.x, u.z - ship.z) <= 4.5);
}
for (const u of passengers.filter(u => !u.garrisoned)) {
  for (const other of passengers.filter(v => v !== u && !v.garrisoned))
    assert(Math.hypot(u.x - other.x, u.z - other.z) >= u.radius + other.radius);
}
const retained = ship.garrison.slice();
ship.kill(null);
assert(retained.every(u => u.dead && !u.garrisoned), 'passengers die when transport sinks');
console.log('TRANSPORT BOARDING, CAPACITY, UNLOADING AND DESTRUCTION PASSED');
