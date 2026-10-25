/* Villager logistics — the things that make an RTS feel broken.

   Three separate reports from the phone all landed on the same code path:

     "my villagers stand next to the town centre and never drop anything"
     "the builder walked to the house and just stopped"
     "units freeze for a second or two for no reason"

   The cause was a delivery rule that waited for the unit to stop twitching
   (`stallT`), measured per tick, so a villager being nudged by a crowd -- or
   circling a blocked last metre -- reset it every frame and could stand there
   with a full load forever. The same shape of rule guarded building and
   repairing. What they need is a *progress* timer: seconds since the distance
   to the target last really improved.

   This suite pins the behaviour down without a browser: nobody may livelock,
   nobody may deposit from across the map, and every unit's measured velocity
   has to be a number.                                                     */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';

const world = generateWorld(20261);

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const tick = (g, seconds, each) => {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) { g.update(1 / 30); if (each) each(i); }
};
const fresh = () => {
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  for (const u of g.units) { u.state = STATE.IDLE; u.path = null; u.targetPos = null; u.gatherTarget = null; }
  return g;
};

check('a villager delivers even when the town centre is crowded', () => {
  const g = fresh();
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const v = g.units.find((u) => u.team === 1 && u.type === 'villager');
  /* Put the villager just outside the wall with a load, then ring the town
     centre with eight idle villagers so every approach is body-blocked. The
     old code jiggled here indefinitely. */
  const half = (tc.def.size || 5) / 2;
  v.x = tc.x + half + 1.6; v.z = tc.z;
  v.carry = { kind: 'wood', amount: 10 };
  v.dropOff = tc;
  v.state = STATE.RETURN;
  v.path = null; v.targetPos = null;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const o = g.spawnUnitRaw('villager', 1, tc.x + Math.cos(a) * (half + 0.9), tc.z + Math.sin(a) * (half + 0.9));
    o.noAggro = true;
  }
  const before = g.teams.get(1).res.wood;
  tick(g, 8);
  assert(g.teams.get(1).res.wood > before, `wood never arrived (still ${before.toFixed(0)}) — the villager livelocked`);
  assert(v.state !== STATE.RETURN, 'the villager is still stuck in the return state');
  // it must have been handed over, not ground down: the full 10 wood arrives
  assert(g.teams.get(1).res.wood - before >= 9.5, `only ${(g.teams.get(1).res.wood - before).toFixed(1)} of 10 wood arrived`);
});

check('a villager boxed in on all four sides still deposits', () => {
  const g = fresh();
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const v = g.units.find((u) => u.team === 1 && u.type === 'villager');
  const half = (tc.def.size || 5) / 2;
  v.x = tc.x + half + 3.2; v.z = tc.z;
  v.carry = { kind: 'food', amount: 10 };
  v.dropOff = tc;
  v.state = STATE.RETURN;
  // a solid wall of bodies on the only open side
  for (let i = 0; i < 6; i++) {
    const o = g.spawnUnitRaw('villager', 1, v.x + 0.8, v.z - 2.2 + i * 0.9);
    o.noAggro = true;
  }
  const before = g.teams.get(1).res.food;
  tick(g, 9);
  assert(g.teams.get(1).res.food > before + 5, 'food never arrived with the door blocked');
});

check('depositing does not happen from across the map', () => {
  const g = fresh();
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const v = g.units.find((u) => u.team === 1 && u.type === 'villager');
  v.x = tc.x + 45; v.z = tc.z;
  v.carry = { kind: 'gold', amount: 10 };
  v.dropOff = tc;
  v.state = STATE.RETURN;
  // block it in place so it cannot walk: the load must NOT teleport home
  for (let i = 0; i < 10; i++) {
    const o = g.spawnUnitRaw('villager', 1, v.x + Math.cos(i) * 0.7, v.z + Math.sin(i) * 0.7);
    o.noAggro = true;
  }
  tick(g, 6);
  assert(v.carry.amount > 0 || Math.hypot(v.x - tc.x, v.z - tc.z) < 14,
    'a villager 45 m away handed its load through the wall');
});

check('a builder finishes a house it cannot quite reach', () => {
  const g = fresh();
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const v = g.units.find((u) => u.team === 1 && u.type === 'villager');
  // start a house and park a crowd between it and the builder
  const b = g.placeBuilding('house', 1, tc.x + 12, tc.z + 12, { free: true });
  assert(b, 'could not place the test house');
  b.buildProgress = 0.05;
  b.hp = 10;
  v.buildTarget = b;
  v.state = STATE.BUILD;
  v.x = tc.x + 12; v.z = tc.z + 12 + 4.6;
  for (let i = 0; i < 6; i++) {
    const o = g.spawnUnitRaw('villager', 1, v.x - 1.5 + i * 0.6, v.z - 1.2);
    o.noAggro = true;
  }
  tick(g, 25);
  assert(b.buildProgress > 0.1, `the builder never made progress (${(b.buildProgress * 100).toFixed(0)} %)`);
});

check('every building has an approach point the pathfinder will accept', () => {
  const g = fresh();
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  // wall a farm and a house right against the town centre, the way a player
  // does in the first thirty seconds
  g.placeBuilding('house', 1, tc.x + 5.4, tc.z, { instant: true, free: true });
  g.placeBuilding('farm', 1, tc.x, tc.z + 5.4, { instant: true, free: true });
  const probe = g.spawnUnitRaw('villager', 1, tc.x + 14, tc.z + 14);
  for (const b of g.buildings.filter((x) => x.team === 1)) {
    probe.x = b.x + 13; probe.z = b.z + 13;
    probe.path = null; probe.targetPos = null;
    probe.approachBuilding(b, 1.0);
    const tp = probe.targetPos;
    assert(tp, `${b.type} has no approach point at all`);
    const [cx, cz] = g.pathFinder.worldToCell(tp[0], tp[1]);
    assert(!g.pathFinder.isBlocked(cx, cz),
      `${b.type}: the approach point (${tp[0].toFixed(1)}, ${tp[1].toFixed(1)}) is inside a blocked nav cell`);
    assert(g.isPassable(tp[0], tp[1], probe),
      `${b.type}: the approach point is inside the building itself`);
  }
});

check('every unit has a finite measured velocity, even the ones born mid-tick', () => {
  const g = fresh();
  tick(g, 2);
  g.spawnUnitRaw('spearman', 1, 10, 10);
  g.update(1 / 30);
  for (const u of g.units) {
    assert(Number.isFinite(u.vx) && Number.isFinite(u.vz), `${u.type} has vx=${u.vx} vz=${u.vz}`);
  }
  // and a zero-length tick does not manufacture infinities
  g.update(0);
  for (const u of g.units) assert(Number.isFinite(u.vx), `${u.type} went infinite on a dt = 0 tick`);
});

/* The empirical version, because the failure that started all this was not a
   unit test: two AI players build out a town, the buildings pack together,
   and one villager ends up on the wrong side of a farm with a full load.
   Sixty seconds of that (it really did last sixty) is what a player sees as
   "my economy stopped". */
check('no villager carries a load for more than twelve seconds in a played match', () => {
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'hard' });
  g.start();
  const bots = [new AIController(g, 1, {}), new AIController(g, 2, {})];
  const carryT = new Map();
  let worst = 0, worstInfo = '';
  for (let i = 0; i < 30 * 200; i++) {
    for (const b of bots) b.update(1 / 30);
    g.update(1 / 30);
    for (const u of g.units) {
      if (u.dead) continue;
      if (u.state === STATE.RETURN && u.carry && u.carry.amount > 0) {
        const t = (carryT.get(u.id) || 0) + 1 / 30;
        carryT.set(u.id, t);
        if (t > worst) {
          worst = t;
          worstInfo = `${u.type} at ${u.x.toFixed(0)},${u.z.toFixed(0)} heading for ${u.dropOff?.type || '?'} (${Math.hypot(u.x - (u.dropOff?.x || 0), u.z - (u.dropOff?.z || 0)).toFixed(1)} m)`;
        }
      } else carryT.set(u.id, 0);
    }
  }
  /* Twelve seconds is generous on purpose: a villager can be 25 m from its
     drop-off and still be walking normally. The bug this pins down ran for
     sixty. */
  assert(worst <= 12, `a villager carried a load for ${worst.toFixed(1)} s — ${worstInfo}`);
});

if (fails.length) {
  console.log('\nFAILURES (' + fails.length + ')');
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`\nLOGISTICS CHECKS PASSED (${pass})`);
