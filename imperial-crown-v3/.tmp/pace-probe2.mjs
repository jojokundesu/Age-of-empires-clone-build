import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
const world = generateWorld(20261);
for (const mode of ['campaign','sandbox']) {
  const g = new Game({ world, civ: 'franks', mode, difficulty: 'standard' });
  g.start();
  const st = g.teams.get(1);
  console.log(mode, 'start', JSON.stringify(st.res), 'cap', st.popCap, 'units', g.units.filter(u=>u.team===1).length);
  const dt=1/30;
  let feudalAt = null;
  for (let i=0;i<30*600;i++){
    g.update(dt);
    if (feudalAt===null && st.age>=1) feudalAt=(i*dt);
    // naive player: always try to age up
    const c = g.canAdvanceAge(1);
    if (c.ok) g.startAgeAdvance(1);
    if (i===30*60) console.log('  60s res', JSON.stringify(st.res).replace(/"/g,''), 'gathered', st.gathered.toFixed(0), 'idle', g.units.filter(u=>u.team===1&&u.type==='villager'&&u.state===STATE.IDLE).length);
  }
  console.log('  feudal at', feudalAt, 'res after 600s', JSON.stringify(st.res).replace(/"/g,''), 'pop', st.popUsed+'/'+st.popCap, 'age', st.age);
}
