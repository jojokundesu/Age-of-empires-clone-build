/* Headless simulation smoke test — run with: node tests/sim.test.mjs */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';

const world = generateWorld(20261);
const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
game.start();

console.log('start units', game.units.length, 'buildings', game.buildings.length, 'resources', game.resources.length);
for (const u of game.units) {
  if (u.type === 'villager') console.log('  villager state', u.state, 'target', u.gatherTarget ? u.gatherTarget.type : 'none', 'path', u.path ? u.path.length : 0);
}

const dt = 1 / 60;
const seconds = Number(process.argv[2] || 60);
let worst = 0;
let total = 0;
const t0 = performance.now();
for (let i = 0; i < seconds * 60; i++) {
  const a = performance.now();
  game.update(dt);
  const d = performance.now() - a;
  total += d;
  if (d > worst) worst = d;
  if (i % 600 === 0) {
    const st = game.teams.get(1);
    console.log(`t=${(i / 60).toFixed(0)}s units=${game.units.length} res=${['food', 'wood', 'gold', 'stone'].map((k) => st.res[k].toFixed(0)).join('/')} pop=${st.popUsed}/${st.popCap} gathered=${st.gathered.toFixed(0)} worst=${worst.toFixed(2)}ms`);
  }
}
const elapsed = performance.now() - t0;
const st = game.teams.get(1);
console.log('--- done', seconds + 's sim in', (elapsed / 1000).toFixed(2), 's wall; avg tick', (total / (seconds * 60)).toFixed(3), 'ms; worst', worst.toFixed(2), 'ms');
console.log('final res', st.res, 'pop', st.popUsed + '/' + st.popCap, 'gathered', st.gathered.toFixed(0));
const states = {};
for (const u of game.units) states[u.state] = (states[u.state] || 0) + 1;
console.log('unit states', states);
console.log('idle villagers', game.units.filter((u) => u.type === 'villager' && u.state === STATE.IDLE).length);
