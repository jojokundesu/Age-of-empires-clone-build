import assert from 'node:assert/strict';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { DIFFICULTY } from '../src/sim/data.js';
import { AIController } from '../src/sim/ai.js';

const world = generateWorld(677);
for (const difficulty of ['easy', 'standard', 'conqueror', 'hard', 'extreme']) {
  assert(DIFFICULTY[difficulty], `${difficulty} preset must exist`);
  const g = new Game({ world, seed: 677, mode: 'campaign', civ: 'franks', difficulty });
  g._civByTeam.set(2, 'franks');
  g.teams.get(2).civ = 'franks';
  g.start();
  const a = g.units.find(u => u.team === 1 && u.type === 'villager');
  const b = g.units.find(u => u.team === 2 && u.type === 'villager');
  a.gatherTarget = b.gatherTarget = null;
  for (const kind of ['food', 'wood', 'gold', 'stone'])
    assert.equal(g.gatherRate(a, kind), g.gatherRate(b, kind), `${difficulty} ${kind} gather rate must be fair`);
  assert.equal(g.aiSpeed, 1, `${difficulty} must not accelerate AI production, research or age-up`);
  const p = g.teams.get(1).res, q = g.teams.get(2).res;
  assert.deepEqual(q, p, `${difficulty} starting resources must match for the same civilisation`);
}
// Enemy census must not read units or roofs outside this crown's own sight.
{
  const g = new Game({ world: generateWorld(678), seed: 678, mode: 'campaign', civ: 'franks', difficulty: 'standard' });
  g.start();
  const ai = new AIController(g, 2);
  const scout = g.units.find(u => u.team === 2);
  const foe = g.units.find(u => u.team === 1);
  const roof = g.buildings.find(b => b.team === 1 && b.type === 'town_center');
  g.units = [scout, foe];
  g.buildings = [roof];
  scout.x = scout.z = 0;
  foe.x = roof.x = 30;
  foe.z = roof.z = 0;
  ai.census = null;
  let census = ai.readEnemy();
  assert.equal(census.total, 0, 'distant enemy unit must not be counted');
  assert.equal(census.roofs, 0, 'distant enemy building must not be counted');
  foe.x = roof.x = 4;
  ai.census = null;
  census = ai.readEnemy();
  assert.equal(census.total, 1, 'enemy in sight must be counted');
  assert.equal(census.roofs, 1, 'building in sight must be counted');
  foe.x = roof.x = 20;
  ai.census = null;
  census = ai.readEnemy();
  assert.equal(census.total, 0, 'nearby but out-of-sight enemy must stay hidden');
  assert.equal(census.roofs, 0, 'nearby but out-of-sight roof must stay hidden');
  ai.foe = 1;
  assert.equal(ai.foeAnchor(), null, 'hidden enemy structures must not become an attack anchor');
  roof.x = 4;
  assert.equal(ai.foeAnchor(), roof, 'a visible enemy structure can become an attack anchor');
  const query = ai.sightQuery();
  for (let x = -270; x <= 270; x += 3.7) for (let z = -270; z <= 270; z += 5.3)
    assert.equal(query(x, z), ai.sees(x, z), `sight broad phase differs at ${x}, ${z}`);
}
// Rival selection may only use observed army and roof counts, not hidden ones.
{
  const world = generateWorld(679, { sites: 4 });
  const g = new Game({ world, seed: 679, mode: 'kingdoms', kingdoms: 4, civ: 'franks', difficulty: 'standard' });
  g.start();
  const ai = new AIController(g, 3);
  for (const e of [...g.units, ...g.buildings]) {
    if (e.team === 3) { e.x = -150; e.z = -150; }
    else if (e.team !== 0) { e.x = 150; e.z = 150; }
  }
  const reads = new Map();
  const score = ai.foeScore.bind(ai);
  ai.foeScore = (team, distance, seen) => { reads.set(team, seen); return score(team, distance, seen); };
  ai.chooseFoe();
  for (const seen of reads.values()) assert.deepEqual(seen, { army: 0, buildings: 0 }, 'hidden rival strength leaked into foe selection');
  const visibleUnit = g.units.find(u => u.team === 1 && u.def.attack > 0);
  const visibleBuilding = g.buildings.find(b => b.team === 1);
  visibleUnit.x = visibleBuilding.x = -148;
  visibleUnit.z = visibleBuilding.z = -150;
  ai.chooseFoe();
  assert(reads.get(1).army > 0 && reads.get(1).buildings > 0, 'visible rivals must be counted');
}
console.log('AI ECONOMY AND CENSUS FAIRNESS CHECKS PASSED');
