/* placecheck.mjs — where can I actually put a building? Scratch. */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';

const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
g.checkVictory = () => {};
g.running = true;
const base = g.baseOf(1) || g.world.playerBase;
console.log('base', base.x.toFixed(0), base.z.toFixed(0));

for (const type of ['house', 'farm', 'barracks']) {
  const counts = {};
  let ok = 0, total = 0;
  for (let dx = -30; dx <= 30; dx += 3) {
    for (let dz = -30; dz <= 30; dz += 3) {
      const x = base.x + dx, z = base.z + dz;
      total++;
      const r = g.canPlaceAt(type, 1, x, z);
      if (r.ok) ok++;
      else counts[r.reason] = (counts[r.reason] || 0) + 1;
    }
  }
  console.log(`${type.padEnd(9)} placeable ${ok}/${total} at 3 m resolution; blocked by`, JSON.stringify(counts));
}

/* what does the player see when they tap? distances to the nearest legal spot */
const nearestOk = (type) => {
  let best = null;
  for (let r = 1; r < 40; r += 1) {
    for (let a = 0; a < 24; a++) {
      const x = base.x + Math.cos((a / 24) * Math.PI * 2) * r;
      const z = base.z + Math.sin((a / 24) * Math.PI * 2) * r;
      if (g.canPlaceAt(type, 1, x, z).ok) { best = [x, z, r]; break; }
    }
    if (best) break;
  }
  return best;
};
console.log('nearest legal house from the hall', JSON.stringify(nearestOk('house')?.map((v) => Math.round(v))));
console.log('nearest legal farm from the hall', JSON.stringify(nearestOk('farm')?.map((v) => Math.round(v))));
console.log('units standing around', g.units.filter((u) => u.team === 1).length);
console.log('resources within 30 m', g.resources.filter((r) => !r.dead && Math.hypot(r.x - base.x, r.z - base.z) < 30).length);
process.exit(0);
