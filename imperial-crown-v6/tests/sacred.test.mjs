import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { Building, STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';

const world = generateWorld(197);
const g = new Game({ world, seed: 197, victory: 'sacred' });
g.running = true;
function site(x, z) {
  const b = new Building(g, 'outpost_shrine', 0, x, z, true);
  b.poiType = 'sacred'; b.siteOwner = 0; b.captureTeam = 0; b.captureProgress = 0;
  g.addBuilding(b); return b;
}
const base = world.playerBase;
const a = site(base.x + 12, base.z), b = site(base.x + 24, base.z);
const m = g.spawnUnitRaw('monk', 1, a.x + 2, a.z);
const enemy = g.spawnUnitRaw('archer', 2, a.x + 3, a.z);
function tick(dt) {
  while (dt > 1e-9) {
    const step = Math.min(dt, 0.1);
    g.spatial.clear(); g.spatial.insertAll(g.units); g.updateSacredSites(step);
    dt -= step;
  }
}
tick(9);
assert.equal(a.siteOwner, 0, 'enemy contest prevents capture');
enemy.x += 50;
tick(9.9);
assert.equal(a.siteOwner, 0, 'capture requires ten seconds');
tick(0.2);
assert.equal(a.siteOwner, 1);
assert.equal(a.takeDamage(100000, enemy), 0, 'sites cannot be destroyed');
m.x = b.x + 2; m.z = b.z;
tick(10.1);
assert.equal(b.siteOwner, 1);
assert.equal(g.sacredClock.team, 1);
tick(179);
assert(!g.gameOver, 'must hold for the entire 180 seconds');
assert(g.sacredStatus().time > 178.9);
// Losing any site resets the shared victory clock.
b.siteOwner = 2;
tick(0.1);
assert.equal(g.sacredClock.time, 0);
b.siteOwner = 1;
tick(0.1);
tick(179);
assert(!g.gameOver);
tick(1.1);
assert(g.gameOver && g.result.win && g.result.reason === 'sacred');
// A rival must discover sites with its own sight; hidden sites are not read.
const ai = new AIController(g, 2);
const st = g.teams.get(2);
st.age = 2; st.res.gold = 500; st.popCap = 30; st.popUsed = 0;
ai.manageSacredSites(st, 2);
assert.equal(ai.knownSacred.size, 0, 'AI must not know unseen sites');
enemy.x = a.x + 4; enemy.z = a.z;
const monastery = new Building(g, 'monastery', 2, a.x - 15, a.z + 1, true);
g.addBuilding(monastery);
const monk = g.spawnUnitRaw('monk', 2, a.x - 12, a.z);
ai.manageSacredSites(st, 2);
assert(ai.knownSacred.has(a), 'AI discovers site with its own sight');
assert.equal(monk.state, STATE.MOVE, 'AI sends its monk to capture a visible rival site');
assert(monastery.queue.some(q => q.type === 'monk'), 'AI pays to train another monk');
console.log('SACRED CAPTURE, CONTEST, AI SIGHT AND 180-SECOND VICTORY PASSED');
