import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const pf = g.pathFinder;
pf._components();
console.log('components', pf.compId, 'comp[start]', pf.comp[pf.idx(...pf.worldToCell(g.world.playerBase.x, g.world.playerBase.z))]);
const v = g.units.find(u => u.team===1 && u.type==='villager');
console.log('villager', v.x.toFixed(1), v.z.toFixed(1), 'state', v.state, 'target', v.gatherTarget?.type, v.gatherTarget?.x.toFixed(1), v.gatherTarget?.z.toFixed(1));
const [sx0,sz0]=pf.worldToCell(v.x,v.z); const [gx0,gz0]=pf.worldToCell(v.gatherTarget.x,v.gatherTarget.z);
console.log('cells', sx0,sz0,'->',gx0,gz0,'blockedStart',pf.isBlocked(sx0,sz0),'blockedGoal',pf.isBlocked(gx0,gz0), 'comps', pf.comp[pf.idx(sx0,sz0)], pf.comp[pf.idx(gx0,gz0)]);
pf.beginTick();
const p = pf.find(v.x, v.z, v.gatherTarget.x, v.gatherTarget.z, 4);
console.log('path', p && p.length, 'skip', pf.lastWasSkip, 'stats', pf.stats);
// try snapping
console.log('snap', pf._snapToComponent(gx0,gz0, pf.comp[pf.idx(sx0,sz0)], 6));
