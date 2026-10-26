import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { Unit, Building } from '../src/sim/entities.js';
import { PathFinder } from '../src/sim/pathfind.js';

const acc = new Map();
const wrap = (obj, name, label) => {
  const fn = obj[name];
  if (typeof fn !== 'function') return console.log('missing', label);
  obj[name] = function (...a) {
    const t = process.hrtime.bigint();
    const r = fn.apply(this, a);
    const ms = Number(process.hrtime.bigint()-t)/1e6;
    acc.set(label, (acc.get(label)||0) + ms);
    return r;
  };
};
wrap(Unit.prototype, 'update', 'Unit.update');
wrap(Building.prototype, 'update', 'Building.update');
for (const k of ['find','findPath','search']) wrap(PathFinder.prototype, k, 'path.'+k);
for (const k of ['refreshNav','updateFog','compact','checkVictory','recomputePop','spawnResources']) wrap(Game.prototype, k, 'g.'+k);

const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const ai = new AIController(g, 2, { aggression: 0.85 });
const dt = 1/30;
const rows = [];
for (let i = 0; i < 30*600; i++) {
  acc.clear();
  const t = process.hrtime.bigint();
  ai.update(dt);
  g.update(dt);
  const total = Number(process.hrtime.bigint()-t)/1e6;
  if (total > 5) rows.push({ t:+g.time.toFixed(1), total:+total.toFixed(1), break: Object.fromEntries([...acc].map(([k,v])=>[k,+v.toFixed(1)]).filter(e=>e[1]>0.5)) });
  if (g.gameOver) break;
}
for (const r of rows.slice(0,12)) console.log(JSON.stringify(r));
