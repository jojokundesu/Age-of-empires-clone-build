import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const dt = 1/30;
let last = 0;
for (let i = 0; i < 30*120; i++) {
  g.update(dt);
  if (i % (30*20) === 0) {
    const st = g.teams.get(1);
    console.log(`t=${(i*dt).toFixed(0)} res=${['food','wood','gold','stone'].map(k=>st.res[k].toFixed(0)).join('/')} pop=${st.popUsed}/${st.popCap} units=${g.units.length} gath=${st.gathered.toFixed(0)} idle=${g.units.filter(u=>u.team===1&&u.type==='villager'&&u.state==='idle').length}`);
  }
}
console.log('start res', JSON.stringify(new Map(g.teams).get(1).res));
