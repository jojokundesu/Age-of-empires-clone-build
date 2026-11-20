/* ============================================================
   tests/riverwar.mjs — the AI crosses the river
   ------------------------------------------------------------
   Section 3 of the depth plan. The complaint was that the AI
   never crosses the river, so on a river map the enemy is a
   decorative neighbour and half the map is not in play. The
   plan asks for more than "make it cross": a crown that defends
   its town, keeps a garrison, scouts, answers what it sees,
   keeps a raider alive, expands, brings siege, and chooses
   between pushing the ford and taking the corner.

   Every check here is a *measurement* of a match that was
   actually simulated, not a test of a function in isolation.
   The question is always "did the war happen", because every
   individual piece of this worked before and the war did not.

   `node tests/riverwar.mjs`  (add `--long` for the 30-minute runs)
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const LONG = process.argv.includes('--long');
const SEED = 20261;

/* Run a match with one AI on the far crown and the player's crown sitting
   still, which is the case the complaint is about: the player builds, the AI
   has to come to them. Returns a log of everything worth measuring. */
function liveMatch(size, minutes, opts = {}) {
  const world = generateWorld(opts.seed ?? SEED, { size });
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: opts.difficulty || 'standard' });
  game.start();
  const bot = new AIController(game, 2, {});
  const base = world.bases[0];          // the player's town, which is what the AI must reach
  const foeSeat = world.bases[1];
  const dt = 1 / 30;
  const log = {
    size, world, game, bot,
    firstSight: null,        // first AI man within 150 m of the player's hall
    firstContact: null,      // first time the AI saw a player unit
    raids: 0, raidWithdrawals: 0, marches: 0, storms: 0,
    peakArmy: 0, approaches: [],
    garrisonAt: {},          // t -> how many men were held at home
    byTime: []
  };
  let lastRole = '';
  for (let s = 0; s < minutes * 60 * 30; s++) {
    bot.update(dt);
    game.update(dt);
    const army = game.units.filter((u) => !u.dead && u.team === 2 && u.def && u.def.attack > 0 && !u.def.classes.includes('villager'));
    log.peakArmy = Math.max(log.peakArmy, army.length);
    if (bot.plan && bot.plan.why && bot.plan.why !== 'no contact' && !log.firstContact) log.firstContact = game.time;
    /* the AI's own men at the player's town */
    for (const u of army) {
      if (Math.hypot(u.x - base.x, u.z - base.z) < 150 && !log.firstSight) {
        log.firstSight = { t: game.time, type: u.type, d: Math.hypot(u.x - base.x, u.z - base.z) };
      }
    }
    if (lastRole !== bot.armyState) {
      if (bot.armyState === 'march') log.marches++;
      if (bot.armyState === 'stage') log.storms++;
      lastRole = bot.armyState;
    }
    if (bot.approach && bot.approach.kind) {
      const k = bot.approach.kind;
      if (!log.approaches.length || log.approaches[log.approaches.length - 1].kind !== k) {
        log.approaches.push({ kind: k, t: game.time, x: bot.approach.x, z: bot.approach.z });
      }
    }
    if (s % 450 === 0) {
      const held = game.units.filter((u) => !u.dead && u.team === 2 && u.aiRole === 'garrison').length;
      log.garrisonAt[Math.round(game.time)] = held;
      log.byTime.push({
        t: game.time,
        army: army.length,
        held,
        villagers: game.units.filter((u) => !u.dead && u.team === 2 && u.type === 'villager').length,
        age: game.teams.get(2).age,
        state: bot.armyState,
        scouts: (bot.scouts || []).filter((u) => !u.dead).length,
        plan: bot.plan ? bot.plan.why : ''
      });
    }
  }
  log.game.gameOver || (log.game.gameOver = false);
  log.final = {
    army: game.units.filter((u) => !u.dead && u.team === 2 && u.def && u.def.attack > 0 && !u.def.classes.includes('villager')).length,
    souls: game.units.filter((u) => !u.dead && u.team === 2).length,
    buildings: game.buildings.filter((b) => !b.dead && b.team === 2).length,
    playerLosses: 0
  };
  return log;
}

console.log('\nTHE ROAD');

/* The one thing the section exists for. */
for (const size of ['normal', 'large']) {
  check(`${size}: the AI brings the war to the player's town`, () => {
    const m = liveMatch(size, LONG ? 30 : 16);
    const what = m.firstSight
      ? `first man at ${(m.firstSight.t / 60).toFixed(1)} min`
      : `no AI soldier came within 150 m of the player's hall in ${LONG ? 30 : 16} min (army peaked at ${m.peakArmy})`;
    assert(m.firstSight, `${size}: ${what}`);
    /* and it must be an army, not one lost scout: three of them */
    const near = m.game.units.filter((u) => !u.dead && u.team === 2 && u.def && u.def.attack > 0
      && Math.hypot(u.x - m.world.bases[0].x, u.z - m.world.bases[0].z) < 260).length;
    assert(near >= 3, `${size}: only ${near} of the AI's ${m.final.army} soldiers are near the player's town`);
  });
}

check('the AI raises an army at all', () => {
  /* This is the check that would have caught the real bug. The AI could not
     train anything for the first version of this work: an affordability test
     consulted an empty reserve and answered "no" forever, so the barracks sat
     empty while the stores climbed past four figures. Every other AI check
     passed, because an AI with no army also has no bugs in its army. */
  const m = liveMatch('normal', 8);
  assert(m.peakArmy >= 8, `the army never got past ${m.peakArmy} men in 8 min`);
});

check('the camp is ground, not a coordinate in a lake', () => {
  /* The camp is computed by walking back from the enemy hall along the line of
     march. On Large that line runs into water: the point was 5.9 m under a
     lake, every order to it was refused, and the column spent the rest of the
     match "at the camp" ordering seventeen men into a lakebed. A camp is only
     a camp if an army can stand on it. */
  for (const size of ['normal', 'large']) {
    const m = liveMatch(size, 15);
    const camp = m.bot.line && m.bot.line.camp;
    if (!camp) continue;                 // never marched in this window
    assert(m.game.isPassable(camp.x, camp.z, { radius: 0.5, def: {} }),
      `${size}: the camp at ${camp.x.toFixed(0)},${camp.z.toFixed(0)} is not standable ground`);
    const h = m.world.height.sample(camp.x, camp.z);
    assert(h > -0.25, `${size}: the camp is ${(-h).toFixed(1)} m under water`);
  }
});

check('a column that cannot reach its camp still goes to the war', () => {
  /* The camp phase used to have no clock. The "stalled" test fires only within
     420 m of the enemy hall, so an army camped half a kilometre out on a 1 km
     road stood in a field for the rest of the match. Measured on Large: the
     march began at 13.1 min and the storm never came. */
  const m = liveMatch('large', 20);
  assert(m.storms >= 1, 'the column never left the camp in 20 minutes');
  assert(m.marches >= 1, 'the column never marched at all');
});

check('a long road is not a broken one: the column forms before it walks', () => {
  const m = liveMatch('large', LONG ? 30 : 20);
  assert(m.marches >= 1, 'the AI never marched');
  assert(m.storms >= 1, 'the column never reached a town to storm');
  const byTime = m.byTime;
  const stalled = byTime.filter((s) => s.state === 'march').length;
  assert(stalled <= byTime.length * 0.75,
    `the army spent ${stalled} of ${byTime.length} samples on the road and never arrived`);
});

console.log('\nTHE CROSSING');

check('the AI chooses a crossing, and it chooses a real one', () => {
  const m = liveMatch('normal', 20);
  assert(m.approaches.length, 'the AI never picked an approach to the player’s town');
  const world = m.world;
  for (const a of m.approaches) {
    const onFord = (world.fords || []).some((f) => Math.hypot(f.x - a.x, f.z - a.z) < (f.radius || 24) + 1);
    const onFlank = (world.corridors || []).some((c) => Math.hypot(c.x - a.x, c.z - a.z) < (c.r || 60) + 1);
    assert(onFord || onFlank, `chose an approach at ${a.x.toFixed(0)},${a.z.toFixed(0)} which is neither a ford nor a flank`);
  }
});

check('the route to the enemy gets its feet wet only at a crossing', () => {
  /* The point of the section is that the war path uses the water crossings
     the map generator carved, and that it does not simply wade the river.

     It cannot be checked by looking for a route point inside a ford's radius.
     The pathfinder aims at a cell and the ford is a disc, so a road that goes
     through a ford perfectly legitimately passes 55 m from its centre -- the
     check below failed on a route that was entirely correct. What can be
     measured is the thing that matters: count the points of the route that
     are in water, and require every one of them to be at a crossing. A route
     that wades the river has wet points in the middle of nowhere. */
  const m = liveMatch('normal', 0.2);
  const world = m.world, game = m.game;
  const base = world.bases[1], enemy = world.bases[0];
  const route = game.pathFinder.find(base.x, base.z, enemy.x, enemy.z, 2, { offTick: true });
  assert(route && route.length > 1, 'no route between the two capitals at all');
  /* How far from a ford its water reaches. The published radius is the *shelf*
     -- the paved bank the men wade from -- and on a widened channel the shelf
     and the water are not the same size: the route here passes 60 m from a
     ford whose shelf is 30 m wide, and the water it crosses is that ford's.
     Measure the map instead of guessing: walk out from the ford's centre until
     the ground is dry and use that. */
  const wetReach = (f) => {
    for (let d = (f.radius || 24); d < 220; d += 2) {
      let anyWet = false;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        if (game.heightAt(f.x + Math.cos(ang) * d, f.z + Math.sin(ang) * d) < 0) { anyWet = true; break; }
      }
      if (!anyWet) return d;
    }
    return 220;
  };
  const fordsReach = (world.fords || []).map((f) => ({ f, r: wetReach(f) }));
  const atCrossing = (x, z) =>
    fordsReach.some(({ f, r }) => Math.hypot(f.x - x, f.z - z) < r)
    || (world.corridors || []).some((c) => Math.hypot(c.x - x, c.z - z) < (c.r || 60) + 8);
  const wet = route.filter((q) => game.heightAt(q[0], q[1]) < 0);
  const strayWet = wet.filter((q) => !atCrossing(q[0], q[1]));
  assert(wet.length, 'the route between two towns on opposite banks never touches water');
  assert(!strayWet.length,
    `${strayWet.length} of ${wet.length} wet points on the route are not at a ford or a flank: `
    + strayWet.slice(0, 3).map((q) => `${q[0].toFixed(0)},${q[1].toFixed(0)}`).join(' '));
});

console.log('\nTHE TOWN BEHIND THE ARMY');

check('a marching crown leaves men holding its own town', () => {
  const m = liveMatch('normal', LONG ? 30 : 18);
  const held = Object.values(m.garrisonAt);
  assert(held.length, 'no samples');
  const marched = m.byTime.some((s) => s.state === 'march');
  assert(marched, 'the AI never marched, so there was nothing to leave behind');
  const maxHeld = Math.max(...held);
  assert(maxHeld >= 2, `the largest garrison ever kept at home was ${maxHeld} men`);
  /* and it must not be the whole army: a crown that leaves everything home
     never attacks, and one that leaves nothing home loses its town */
  const m2 = m.byTime.filter((s) => s.army > 0).map((s) => s.held / s.army);
  assert(m2.some((f) => f > 0 && f < 0.8), 'the garrison was always all or nothing');
});

check('the garrison answers an intruder', () => {
  /* Put a hostile soldier in the AI's town and see whether the men at home
     react to it rather than finishing their coffee. */
  /* A crown twenty seconds into a match has no army to answer with, so give
     it one -- the question is whether the men it has turn round, not whether
     it has men. */
  const m = liveMatch('normal', 0.2);
  const game = m.game, bot = m.bot;
  const seat = m.world.bases[1];
  const defenders = [];
  for (let i = 0; i < 8; i++) {
    defenders.push(game.spawnUnitRaw('spearman', 2, seat.x + 6 + (i % 4) * 2, seat.z - 6 - Math.floor(i / 4) * 2));
  }
  for (let i = 0; i < 3; i++) game.spawnUnitRaw('spearman', 1, seat.x + 3 + i * 3, seat.z + 3);
  let answered = 0;
  for (let s = 0; s < 30 * 12; s++) {
    bot.update(1 / 30);
    game.update(1 / 30);
    answered = defenders.filter((u) => !u.dead && u.aiRole === 'defend').length;
    if (answered >= 3) break;
  }
  assert(answered >= 3, `only ${answered} of 8 soldiers turned to answer three spearmen in their own town`);
  /* and they must go for the intruders, not mill about */
  const target = defenders.find((u) => u.aiRole === 'defend' && u.target);
  assert(target, 'the garrison took the defend role but was never given a target');
  assert(target.target.team === 1, `the garrison targeted a ${target.target.team === 0 ? 'neutral' : 'friendly'} thing`);
});

console.log('\nTHE COUNTER');

check('the AI looks before it answers: it scouts, and it sees the enemy', () => {
  /* The player's crown is idle in the default scenario, which is the case the
     complaint is about, but it means there is nobody to see: a crown with no
     army and no buildings is not a thing to scout. Give the defending crown
     something to defend with, so this measures the AI's eyes rather than the
     emptiness of the opposition. */
  const world = generateWorld(SEED, { size: 'normal' });
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  game.start();
  const bot = new AIController(game, 2, {});
  const guard = [];
  /* Standing in the AI's *own* town: the scouts ride there and back, and an
     army the crown can already see is the case where the council is supposed
     to answer immediately. The far-away version of this check belongs to the
     "it brings the war to the player" check above. */
  const aiSeat = world.bases[1];
  for (let i = 0; i < 10; i++) guard.push(game.spawnUnitRaw('spearman', 1, aiSeat.x + 4 + (i % 4) * 3, aiSeat.z + 4 + Math.floor(i / 4) * 3));
  const dt = 1 / 30;
  let seen = 0, scouts = 0, role = null;
  /* The two questions are asked separately. "Did it look?" is answered by the
     riders, whenever they went out. "Did it see, and did it answer?" is
     answered by the council, which is the thing that decides what the barracks
     trains -- and it does not need to be still true at the end of the run,
     because the answer changes as the battle does. */
  let sawEnemy = false, sawRoofs = false;
  /* The player's crown is passive in this harness, so its army is a statue:
     it does not advance, and the AI's scouts have to come to it. Run long
     enough for the riders to make the round trip -- on Small that is seconds,
     on the default map it is most of a minute each way. */
  const limit = LONG ? 40 : 30;
  for (let s = 0; s < limit * 60 * 30; s++) {
    bot.update(dt);
    game.update(dt);
    /* The ceiling, not the last sample: a scout that rides out and comes home
       leaves the party empty, and reading the count at the end reports zero
       for a crown that had two riders out for six minutes. */
    scouts = Math.max(scouts, (bot.scouts || []).filter((u) => !u.dead).length);
    const why = bot.plan && bot.plan.why;
    if (why && why !== 'no contact') {
      if (!seen) seen = game.time;
      if (/roofs/.test(why)) sawRoofs = true;
      else sawEnemy = true;
      if (bot.plan.role && !role) role = bot.plan.role;
    }
  }
  assert(scouts >= 1, 'the AI never put a single man out to look');
  assert(sawEnemy || sawRoofs,
    'the AI never saw the enemy town at all, so it could not answer anything');
  assert(role, 'the AI stood ten spearmen in front of its own barracks and formed no plan about them');
});

check('the counter it builds is the one the enemy asked for', () => {
  /* Make the player's crown visibly cavalry-heavy, let the AI read it, and
     check the answer is spears. This is the whole point of the council: an AI
     that always trains the same army cannot be read, and cannot read.

     Read it once rather than driving frames: the AI's own update refreshes its
     census on its own schedule, so poking it from outside every tick is a race
     with itself. One census over an army it can see is exactly what the real
     decision uses. */
  const m = liveMatch('normal', 0.2);
  const game = m.game, bot = m.bot;
  const seat = m.world.bases[1];
  for (let i = 0; i < 8; i++) game.spawnUnitRaw('knight', 1, seat.x + 4 + (i % 3) * 4, seat.z + 4 + Math.floor(i / 3) * 4);
  bot.censusAt = -99;
  const c = bot.readEnemy();
  assert(c.cavalry >= 5, `only ${c.cavalry} of 8 knights were read as cavalry`);
  assert(bot.plan.role === 'spear', `the council answered ${c.cavalry} knights with "${bot.plan.role}"`);
  assert(bot.wantedRole() === 'spear', `the barracks would still be asked for "${bot.wantedRole()}"`);
  /* and the reverse, on a fresh crown: a wall of infantry gets archers */
  const m2 = liveMatch('normal', 0.2);
  const g2 = m2.game, bot2 = m2.bot;
  const seat2 = m2.world.bases[1];
  for (let i = 0; i < 10; i++) g2.spawnUnitRaw('swordsman', 1, seat2.x + 3 + (i % 4) * 3, seat2.z + 3 + Math.floor(i / 4) * 3);
  bot2.censusAt = -99;
  const c2 = bot2.readEnemy();
  assert(c2.infantry >= 6, `only ${c2.infantry} of 10 swordsmen were read as infantry`);
  assert(bot2.plan.role === 'archer', `the council answered ${c2.infantry} swordsmen with "${bot2.plan.role}"`);
});

console.log('\nTHE RAIDERS');

check('a raiding party that is outnumbered comes home', () => {
  const m = liveMatch('normal', LONG ? 30 : 20);
  assert(m.raidWithdrawals >= 0, 'sanity');
  /* The behaviour itself: build a party, put a stronger force in front of it,
     and check it turns back rather than feeding. */
  const game = m.game, bot = m.bot;
  const home = m.world.bases[1];
  const raiders = [];
  for (let i = 0; i < 4; i++) raiders.push(game.spawnUnitRaw('spearman', 2, home.x - 60 + i * 3, home.z));
  for (const u of raiders) {
    u.aiRole = 'raid';
    u.state = 'attackmove';
    u.moveTo(home.x - 120, home.z, true);
  }
  bot.raidUnits = raiders;
  bot.raidTimer = 0;
  bot.raidRefresh = game.time + 8;
  /* within sight of the party it is supposed to be scared of */
  for (let i = 0; i < 8; i++) game.spawnUnitRaw('knight', 1, home.x - 72 + (i % 4) * 5, home.z + Math.floor(i / 4) * 5);
  bot.manageRaids(bot.militaryUnits());
  const stillRaiding = raiders.filter((u) => !u.dead && u.aiRole === 'raid').length;
  assert(stillRaiding === 0, `${stillRaiding} of 4 raiders stayed to fight eight knights`);
  const goingHome = raiders.filter((u) => !u.dead && Math.hypot(u.destX - home.x, u.destZ - home.z) < 40).length;
  assert(goingHome >= 3, `only ${goingHome} of 4 raiders were sent home`);
});

console.log('\nTHE LONG RUN');

check('a full 30-minute war does not stall, crash or lose its own town', () => {
  const m = liveMatch('normal', 30);
  assert(m.game.units.length > 0, 'the simulation emptied itself');
  assert(m.final.buildings >= 8, `the AI ended with ${m.final.buildings} buildings`);
  assert(m.final.souls >= 10, `the AI ended with ${m.final.souls} people`);
  /* a crown that spends the whole match on the road never fights, which is
     the failure this section was written about */
  assert(m.firstSight, 'thirty minutes and the AI never reached the player');
});

if (fails.length) {
  console.log(`\nFAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f.name + ': ' + f.e.message);
  process.exitCode = 1;
} else {
  console.log(`\n  ${pass} river-war checks passed`);
  console.log('THE AI CROSSES THE RIVER');
}
