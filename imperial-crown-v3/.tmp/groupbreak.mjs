import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { Unit, Building } from '../src/sim/entities.js';
import { PathFinder } from '../src/sim/pathfind.js';

const acc = new Map();
const wrap = (obj, name, label) => {
  const fn = obj[name];
  obj[name] = function (...a) {
    const t = process.hrtime.bigint();
    const r = fn.apply(this, a);
    acc.set(label, (acc.get(label)||0) + Number(process.hrtime.bigint()-t)/1e6);
    return r;
  };
};
wrap(Unit.prototype, 'update', 'unit');
for (const k of ['updateIdle','updateMove','updateAttackMove','updateAttack','updateGather','updateReturn','stepMovement','setPath','stats','updateBuild']) wrap(Unit.prototype, k, 'u.'+k);
wrap(Building.prototype, 'update', 'building');
for (const k of ['find','_components','_snapToComponent','_smooth','beginTick']) wrap(PathFinder.prototype, k, 'pf.'+k);
for (const k of ['refreshNav','updateFog','compact','unstick','isPassable','findEnemyNear','unitsNear']) wrap(Game.prototype, k, 'g.'+k);

const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
g.start();
const b = g.world.playerBase, e = g.world.enemyBase;
const units = [];
for (let i = 0; i < 20; i++) units.push(g.spawnUnitRaw('spearman', 1, b.x - 10 + (i%8)*1.2, b.z - 4 + ((i/8)|0)*1.2));
g.pathFinder.beginTick();
g.orderMove(units, e.x + 6, e.z - 4);
const rows = [];
for (let i = 0; i < 400; i++) {
  acc.clear();
  const t = process.hrtime.bigint();
  g.update(1/30);
  const total = Number(process.hrtime.bigint()-t)/1e6;
  if (total > 3) rows.push({ i, total: +total.toFixed(1), br: Object.fromEntries([...acc].map(([k,v])=>[k,+v.toFixed(1)]).filter(x=>x[1]>0.4)) });
}
rows.sort((a,b)=>b.total-a.total);
for (const r of rows.slice(0,8)) console.log(JSON.stringify(r));
console.log('pf stats', g.pathFinder.stats);
