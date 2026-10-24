import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const b = g.world.playerBase, e = g.world.enemyBase;
for (let i = 0; i < 200; i++) g.spawnUnitRaw(i % 3 ? 'spearman' : 'archer', 1, b.x - 14 + (i%16)*1.3, b.z - 8 + ((i/16)|0)*1.3);
for (let i = 0; i < 4000; i++) {
  if (i % 300 === 0) g.orderMove(g.units.filter(u=>u.team===1), e.x + 8 + (i%20), e.z - (i%13));
  g.update(1/30);
}
console.log('done', g.units.length);
