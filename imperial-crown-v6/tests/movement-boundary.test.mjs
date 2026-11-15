import assert from 'node:assert/strict';
import { Game } from '../src/sim/game.js';
import { generateWorld } from '../src/sim/worldgen.js';

const game = new Game({ world: generateWorld(531), seed: 531 });
const unit = game.spawnUnitRaw('spearman', 1, 0, 0);
game.navHalf = 256;
game.navInv = 0.5;
game.navN = 256;
game.speedMulOnStep = () => 1;
game.isPassable = (x, z) => x < game.blockX && Math.abs(z - 0.5) < 0.001;

// Test both crossing a nav-cell edge and a shoreline that cuts through a
// single cell. A cached proof at the previous point cannot prove either.
for (const [start, boundary] of [[1.95, 2], [0.95, 1]]) {
  unit.x = start;
  unit.z = 0.5;
  unit.path = [[3, 0.5]];
  unit.pathIdx = 0;
  unit.targetPos = [3, 0.5];
  unit._wpBlock = 0;
  unit._passKey = ((unit.z + 256) / 2 | 0) * 256 + ((unit.x + 256) / 2 | 0);
  game.blockX = boundary;
  unit.stepMovement(0.1, { speed: 3 });
  assert(unit.x < boundary, `unit crossed blocked boundary ${boundary} at x=${unit.x}`);
}
// The building broad phase must agree with the full geometric query, even at
// shrine edges, overlapping buildings and with unusually large custom units.
{
  const g = new Game({ world: generateWorld(531), seed: 531, mode: 'campaign' });
  g.start();
  g.update(1 / 30); // build the spatial index
  // Include a large modded footprint, whose corners lie outside the old
  // fixed 5m centre query. It is intentionally tested before a spatial rebuild.
  const giant = { x: g.playerBase.x + 18, z: g.playerBase.z, team: 2, dead: false, wall: false, def: { size: 16 } };
  g.addBuilding(giant);
  const points = [];
  for (const b of g.buildings) {
    for (let dx = -6; dx <= 6; dx += 0.75)
      for (let dz = -6; dz <= 6; dz += 0.75) points.push([b.x + dx, b.z + dz]);
  }
  const units = [undefined, { radius: 0.32, def: {}, team: 1 }, { radius: 3, def: {}, team: 2 }, { radius: 8, def: {}, team: 1 }];
  const fast = points.flatMap(([x, z]) => units.map(u => g.isPassable(x, z, u)));
  const hazards = g.navHaz.slice(), bodies = g.navBodies.slice();
  g.navHaz.fill(1);
  g.navBodies.fill(g.buildings); // brute-force every body, no spatial broad phase
  const full = points.flatMap(([x, z]) => units.map(u => g.isPassable(x, z, u)));
  assert.deepEqual(fast, full, 'building broad phase disagrees with full collision checks');
  g.navHaz.set(hazards);
  for (let i = 0; i < bodies.length; i++) g.navBodies[i] = bodies[i];
  const hx = Math.floor((giant.x + 7 + 256) / g.world.nav.cell);
  const hz = Math.floor((giant.z + 7 + 256) / g.world.nav.cell);
  const corner = hz * g.world.nav.cells + hx;
  assert(g.navBodies[corner]?.includes(giant), 'large building corner missing from collision grid');
  g.markBuildingFootprint(giant, false);
  assert(!g.navBodies[corner]?.includes(giant), 'destroyed building remains in collision grid');
  g.buildings.splice(g.buildings.indexOf(giant), 1);
  g.clearEntities();
  assert(g.navHaz.every(v => v === 0), 'clearing a match must clear collision coverage');
  assert(g.navBodies.every(v => !v), 'clearing a match must release collision bodies');
  assert(g.navWall.every(v => v === 0) && g.navGateCount === 0, 'clearing a match must reset wall and gate layers');
}
console.log('MOVEMENT BOUNDARY CHECKS PASSED');
