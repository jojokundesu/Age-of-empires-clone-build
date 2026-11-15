import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { Building } from '../src/sim/entities.js';
const g = new Game({ world: generateWorld(211), seed: 211 });
const units = [[0,0], [70,70], [-70,70]].map(([x,z]) => g.spawnUnitRaw('archer', 1, x, z));
const neutral = new Building(g, 'outpost_shrine', 0, -150, -150, true);
g.addBuilding(neutral);
g.updateFog(1);
for (const u of units) assert(g.isVisible(u.x, u.z), 'full initial vision includes each friendly unit');
assert(!g.isVisible(neutral.x, neutral.z), 'neutral buildings must not reveal fog for the player');
for (let i = 0; i < 9; i++) {
  g.updateFog(0.03);
  for (const u of units) assert(g.isVisible(u.x, u.z), `vision flickered on pass ${i}`);
}
const lost = units[0];
lost.kill(null);
for (let i = 0; i < 4; i++) g.updateFog(0.03);
assert(!g.isVisible(lost.x, lost.z), 'vision expires after its source dies');
assert(g.isExplored(lost.x, lost.z), 'lost vision remains explored');
console.log('FOG VISIBILITY AND EXPIRY CHECKS PASSED');
