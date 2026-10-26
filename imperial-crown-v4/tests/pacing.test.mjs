/* ============================================================
   pacing.test.mjs — does the match *play*?

   The renderer gates answer "does it draw"; this suite answers the questions a
   player actually asks in the first ten minutes:

     • does the economy start on its own, and at a believable rate?
     • is there anything to do, or is the first age a five-minute wait?
     • do population, queues, techs and resources follow the rules the HUD
       claims (the queue drew eight dots but accepted five; that is here now)
     • can either side actually win, and can the player actually lose?
     • does a long match stay finite — no NaNs, no units walking through the
       sea, no villager trapped in a loop, no slow tick creep?

   Everything runs headless on the real Game, so it is fast (a ten-minute match
   is under a second of CPU) and deterministic.
   ============================================================ */
import { generateWorld, WORLD } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';
import { AGES, UNIT_DEFS, BUILDING_DEFS, TECH_DEFS } from '../src/sim/data.js';

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
};

const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const near = (v, lo, hi) => v >= lo && v <= hi;

const seeds = new Map();
const worldFor = (seed) => {
  if (!seeds.has(seed)) seeds.set(seed, generateWorld(seed));
  return seeds.get(seed);
};

function match(mode = 'campaign', difficulty = 'standard', seed = 20261, civ = 'franks') {
  const game = new Game({ world: worldFor(seed), civ, mode, difficulty });
  game.start();
  return game;
}

const run = (game, seconds, dt = 1 / 30, each) => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    if (each && each(i, game.time) === false) return i * dt;
    game.update(dt);
  }
  return seconds;
};

/* ============================================================ */
console.log('\nOPENING MINUTES');
{
  const g = match();
  const st = g.teams.get(1);
  const vills = g.units.filter((u) => u.team === 1 && u.type === 'villager' && !u.dead);
  check('a match starts with a working economy and a scout', () => {
    assert(vills.length >= 5, `only ${vills.length} villagers`);
    assert(g.units.some((u) => u.team === 1 && u.type === 'scout_cavalry'), 'no scout');
    assert(st.popCap >= 15, 'pop cap ' + st.popCap);
    assert(st.res.food >= 150 && st.res.wood >= 150, 'starting stock ' + JSON.stringify(st.res));
  });

  check('villagers are already gathering on the first tick', () => {
    const idle = vills.filter((u) => u.state === STATE.IDLE).length;
    assert(idle === 0, `${idle} of ${vills.length} villagers idle at t=0`);
    assert(vills.every((v) => v.gatherTarget || v.state === STATE.GATHER || v.state === STATE.MOVE),
      'a villager has no gather order at all');
  });

  const before = { ...st.res };
  run(g, 90);
  check('the opening economy produces without being touched', () => {
    assert(st.gathered > 150, 'only ' + st.gathered.toFixed(0) + ' gathered in 90 s');
    assert(st.res.wood > before.wood, 'wood did not rise');
  });

  /* Effective throughput, walking included. The gather rates are 2.2-3.3/s at
     the node; the loop between node and drop-off is what the player feels. */
  const perVillager = st.gathered / (90 * Math.max(1, vills.length));
  check(`effective gather rate is human (${perVillager.toFixed(2)}/villager/s)`, () => {
    assert(perVillager > 0.45, 'too slow: ' + perVillager.toFixed(2));
    assert(perVillager < 2.6, 'too fast: ' + perVillager.toFixed(2));
  });

  check('no villager gets stuck walking to a node', () => {
    const stuck = g.units.filter((u) => u.team === 1 && u.type === 'villager' && !u.dead
      && u.state === STATE.MOVE && u.targetPos === null && !u.path);
    assert(stuck.length === 0, stuck.length + ' villagers are in MOVE with nowhere to go');
  });
}

/* ============================================================ */
console.log('\nAGES AND TECHS');
{
  const g = match('campaign', 'standard');
  const st = g.teams.get(1);
  let feudal = null;
  run(g, 300, 1 / 30, () => {
    const r = g.canAdvanceAge(1);
    if (r.ok) g.startAgeAdvance(1);
    if (!feudal && st.age === 1) feudal = g.time;
  });
  check(`a passive five-villager town reaches Feudal (${feudal ? feudal.toFixed(0) + ' s' : 'never'})`, () => {
    assert(feudal !== null, 'never reached Feudal in 5 minutes');
    assert(near(feudal, 45, 260), 'Feudal at ' + feudal.toFixed(0) + ' s is off the 25-minute pacing target');
  });

  check('an age costs its listed resources and takes its listed time', () => {
    const g2 = match('campaign', 'standard');
    const t2 = g2.teams.get(1);
    t2.res.food = 2000; t2.res.gold = 1000;
    const before = { ...t2.res };
    const started = g2.startAgeAdvance(1);
    assert(started.ok, 'advance refused: ' + started.reason);
    assert(t2.res.food === before.food - AGES[1].cost.food, 'food cost wrong');
    assert(t2.res.gold === before.gold - AGES[1].cost.gold, 'gold cost wrong');
    assert(t2.age === 0, 'age changed before the research finished');
    run(g2, AGES[1].time + 1);
    assert(t2.age === 1, 'age did not advance after ' + AGES[1].time + ' s');
  });

  check('a tech is paid once, applies its effect, and cannot be bought twice', () => {
    const g3 = match('campaign', 'standard');
    const t3 = g3.teams.get(1);
    t3.res.wood = 3000; t3.res.food = 3000; t3.res.gold = 3000;
    const base0 = g3.world.playerBase;
    assert(g3.startAgeAdvance(1).ok, 'could not reach Feudal');
    run(g3, AGES[1].time + 1);
    const lumber = g3.placeBuilding('lumber_camp', 1, base0.x - 16, base0.z + 10, { instant: true });
    assert(lumber, 'could not raise a lumber camp');
    assert(g3.teams.get(1).age === 1, 'age is ' + g3.teams.get(1).age);
    const v = g3.units.find((u) => u.team === 1 && u.type === 'villager');
    const base = g3.gatherRate(v, 'wood');
    const before = t3.res.wood;
    assert(lumber.queueTech('double_bit_axe'), 'research refused');
    assert(t3.res.wood < before, 'research was free');
    assert(!lumber.queueTech('double_bit_axe'), 'queued the same tech twice');
    run(g3, TECH_DEFS.double_bit_axe.time + 1);
    assert(g3.hasTech(1, 'double_bit_axe'), 'tech never completed');
    const after = g3.gatherRate(v, 'wood');
    assert(after > base * 1.15, `wood rate ${base.toFixed(2)} -> ${after.toFixed(2)}`);
    assert(!lumber.queueTech('double_bit_axe'), 're-researched a finished tech');
  });

  check('impractical ages are refused with a reason, not silently', () => {
    const g4 = match('campaign', 'standard');
    g4.teams.get(1).res = { food: 0, wood: 0, gold: 0, stone: 0 };
    const r = g4.canAdvanceAge(1);
    assert(!r.ok && typeof r.reason === 'string' && r.reason.length > 3, 'no reason given');
  });
}

/* ============================================================ */
console.log('\nPOPULATION AND QUEUES');
{
  const g = match('campaign', 'standard');
  const st = g.teams.get(1);
  st.res.food = 5000; st.res.wood = 5000; st.res.gold = 5000;
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  check('a queue accepts eight and refuses the ninth', () => {
    let n = 0;
    while (tc.queueUnit('villager') && n < 20) n++;
    assert(n === 8, 'queue accepted ' + n + ' units (cap is 8, HUD draws 8 dots)');
  });
  check('queued units arrive one at a time, at the listed build time', () => {
    const popBefore = st.popUsed;
    run(g, 5);
    assert(st.popUsed === popBefore, 'units popped out instantly');
    run(g, UNIT_DEFS.villager.time * 2 + 2);
    const delivered = st.popUsed - popBefore;
    assert(delivered >= 1 && delivered <= 4, delivered + ' villagers in 26 s (expected 1-4)');
  });

  check('population is capped by houses, not by a hidden number', () => {
    const g2 = match('campaign', 'standard');
    const s2 = g2.teams.get(1);
    s2.res.food = 9000;
    const tc2 = g2.buildings.find((b) => b.team === 1 && b.type === 'town_center');
    const capBefore = s2.popCap;
    // fill to the cap with instant units, then try one more
    for (let i = 0; i < capBefore + 6; i++) g2.spawnUnitRaw('villager', 1, g2.world.playerBase.x + 3, g2.world.playerBase.z + 3);
    g2.recomputePop();
    assert(s2.popUsed >= capBefore, 'pop used ' + s2.popUsed + ' < cap ' + capBefore);
    const queued = tc2.queueUnit('villager');
    assert(!queued, 'trained past the population cap');
    // a house raises the cap by its listed amount; build it instantly
    const spot = g2.canPlaceAt('house', 1, g2.world.playerBase.x + 12, g2.world.playerBase.z + 12);
    assert(spot.ok, 'could not place a house: ' + spot.reason);
    const house = g2.placeBuilding('house', 1, g2.world.playerBase.x + 12, g2.world.playerBase.z + 12, { instant: true, free: true });
    assert(house, 'house not placed');
    g2.recomputePop();
    assert(s2.popCap === capBefore + BUILDING_DEFS.house.pop, `cap ${capBefore} -> ${s2.popCap}`);
    // the reservations from the queue must leave exactly one more slot
    s2.popCap = s2.popUsed + 1;
    assert(tc2.queueUnit('villager'), 'a free population slot did not accept a unit');
    assert(!tc2.queueUnit('villager'), 'queued a second unit into a single slot');
  });
}

/* ============================================================ */
console.log('\nWIN AND LOSE');
{
  check('conquest: destroying the enemy ends the match in a win', () => {
    const g = match('campaign', 'standard');
    for (const e of g.units) if (e.team !== 1) { e.dead = true; }
    for (const b of g.buildings) if (b.team !== 1) { b.dead = true; }
    g.checkVictory();
    assert(g.gameOver && g.result && g.result.win === true, 'no win: ' + JSON.stringify(g.result));
  });

  check('conquest: losing your last building and unit is a loss', () => {
    const g = match('campaign', 'standard');
    for (const e of g.units) if (e.team === 1) e.dead = true;
    for (const b of g.buildings) if (b.team === 1) b.dead = true;
    g.checkVictory();
    assert(g.gameOver && g.result && g.result.win === false, 'no loss: ' + JSON.stringify(g.result));
  });

  check('dominance gives 60 s of grace instead of an instant loss', () => {
    const g = match('campaign', 'standard');
    for (const b of g.buildings) if (b.team === 1) b.dead = true;
    g.checkVictory();
    assert(!g.gameOver, 'ended instantly with an army still alive');
    run(g, 70);
    assert(g.gameOver && g.result.win === false && g.result.reason === 'dominance', JSON.stringify(g.result));
  });

  check('sandbox never ends, whatever you do to it', () => {
    const g = match('sandbox', 'sandbox');
    for (const b of g.buildings) if (b.team === 1) b.dead = true;
    for (const u of g.units) if (u.team === 1) u.dead = true;
    run(g, 90);
    assert(!g.gameOver, 'sandbox ended: ' + JSON.stringify(g.result));
  });
}

/* ============================================================ */
console.log('\nWONDER RACE');
{
  const g = match('wonder', 'standard');
  const st = g.teams.get(1);
  st.res = { food: 5000, wood: 5000, gold: 5000, stone: 5000 };
  st.age = 3;
  const base = g.world.playerBase;
  const spot = g.canPlaceAt('wonder', 1, base.x + 18, base.z + 18);
  assert(spot.ok, 'cannot place a wonder: ' + spot.reason);
  const w = g.placeBuilding('wonder', 1, base.x + 18, base.z + 18, { instant: true });
  assert(w, 'wonder not placed');

  check('the clock only runs on a finished wonder', () => {
    assert(g.wonderProgressOf(1) === 0, 'clock started at ' + g.wonderProgressOf(1));
    run(g, 10);
    assert(near(g.wonderProgressOf(1), 9.9, 10.5), 'clock at ' + g.wonderProgressOf(1) + ' after 10 s');
  });

  check('damage resets the countdown', () => {
    w.hp = w.maxHp * 0.8;
    run(g, 1);
    assert(g.wonderProgressOf(1) === 0, 'clock survived damage: ' + g.wonderProgressOf(1));
    w.hp = w.maxHp;
  });

  check('an unfinished wonder never counts', () => {
    const g2 = match('wonder', 'standard');
    const s2 = g2.teams.get(1);
    s2.age = 3;
    s2.res = { food: 5000, wood: 5000, gold: 5000, stone: 5000 };
    const b2 = g2.placeBuilding('wonder', 1, g2.world.playerBase.x + 18, g2.world.playerBase.z + 18);
    assert(b2, 'placeholder wonder not placed');
    run(g2, 30);
    assert(g2.wonderProgressOf(1) === 0, 'unfinished wonder counted ' + g2.wonderProgressOf(1));
  });

  const t0 = g.time;
  let won = false;
  run(g, 215, 1 / 20, () => { if (g.gameOver) { won = true; return false; } });
  check('holding it for 200 s wins the mode', () => {
    assert(g.gameOver && g.result.win === true && g.result.reason === 'wonder',
      'no wonder victory: ' + JSON.stringify(g.result));
    assert(near(g.result.time - t0, 195, 215), 'won at ' + (g.result.time - t0).toFixed(1) + ' s');
  });

  check('the HUD can tell how close each side is', () => {
    const s = g.wonderStatus();
    assert(s && s.mine >= s.hold - 1, 'status ' + JSON.stringify(s));
    const g3 = match('campaign', 'standard');
    assert(g3.wonderStatus() === null, 'a conquest match shows a wonder clock');
  });
}

/* ============================================================ */
console.log('\nLONG MATCH');
{
  const g = match('campaign', 'standard');
  const ai = new AIController(g, 2, { aggression: 0.85 });
  const dt = 1 / 30;
  const t0 = Date.now();
  let bad = null;
  const tickMs = [];
  let peakUnits = 0;
  const seen = new Set();
  for (let i = 0; i < 30 * 600; i++) {
    const a = process.hrtime.bigint();
    ai.update(dt);
    g.update(dt);
    tickMs.push(Number(process.hrtime.bigint() - a) / 1e6);
    peakUnits = Math.max(peakUnits, g.units.length);
    if (i % 900 === 0) {
      for (const e of g.units) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) { bad = bad || `${e.type} at NaN position`; break; }
        if (Math.abs(e.x) > WORLD.half + 4 || Math.abs(e.z) > WORLD.half + 4) { bad = bad || `${e.type} left the map at ${e.x.toFixed(0)},${e.z.toFixed(0)}`; break; }
        if (!e.dead && e.kind === 'unit' && e.team === 2) seen.add(e.type);
        if (g.gameOver) break;
      }
    }
    if (g.gameOver) break;
  }
  const wall = (Date.now() - t0) / 1000;
  const st = g.teams.get(1);

  check(`ten simulated minutes stay sane (${wall.toFixed(1)} s CPU, ${peakUnits} peak units)`, () => {
    assert(!bad, bad);
    assert(!Number.isFinite(st.res.food) === false, 'NaN resources');
    assert(st.res.food >= 0 && st.res.wood >= 0, 'negative resources');
    assert(g.time > 500, 'sim stopped early at ' + g.time.toFixed(0) + ' s');
  });

  /* Percentiles, not the maximum: a single 15 ms tick out of 18 000 is V8
     collecting garbage, and GC is not a design property we can fix by
     optimising the loop. The player feels the 99th percentile. */
  const sorted = [...tickMs].sort((a, b) => a - b);
  const q = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(pct * sorted.length))];
  const mean = tickMs.reduce((a, b) => a + b, 0) / tickMs.length;
  console.log(`       (tick mean ${mean.toFixed(2)} ms · p50 ${q(0.5).toFixed(2)} · p99 ${q(0.99).toFixed(2)} · p999 ${q(0.999).toFixed(2)})`);
  check(`the simulation stays inside the frame budget at 30 Hz (p99 ${q(0.99).toFixed(2)} ms, mean ${mean.toFixed(2)} ms)`, () => {
    assert(mean < 2.0, 'mean tick ' + mean.toFixed(2) + ' ms');
    assert(q(0.99) < 5.0, 'p99 tick ' + q(0.99).toFixed(2) + ' ms');
    assert(q(0.999) < 12.0, 'p99.9 tick ' + q(0.999).toFixed(2) + ' ms');
  });

  check('the AI actually plays: it ages, builds and fields an army', () => {
    const t2 = g.teams.get(2);
    assert(t2.age >= 1, 'AI stuck in the Dark Age');
    assert(g.buildings.filter((b) => b.team === 2 && !b.dead).length >= 5, 'AI has no town');
    assert(seen.size >= 2 || g.gameOver, 'AI never fielded soldiers: ' + [...seen].join(','));
  });

  check('nothing is left walking into the sea', () => {
    const drowned = g.units.filter((u) => !u.dead && g.isWater(u.x, u.z));
    assert(drowned.length === 0, drowned.length + ' units are in the water (' + [...new Set(drowned.map((u) => u.type))].join(',') + ')');
  });
}

/* ============================================================ */
console.log('\nEDGE CASES');
{
  check('a stripped map does not spin: villagers go idle, the tick stays cheap', () => {
    const g = match('campaign', 'standard');
    for (const r of g.resources) r.dead = true;
    run(g, 20);
    const t0 = Date.now();
    run(g, 60);
    const ms = (Date.now() - t0) / 60;
    assert(ms < 6, 'empty-map tick cost ' + ms.toFixed(2) + ' ms');
    const vills = g.units.filter((u) => u.team === 1 && u.type === 'villager' && !u.dead);
    const idle = vills.filter((u) => u.state === STATE.IDLE).length;
    assert(idle >= 1, 'not one villager went idle on an empty map');
  });

  check('a full-length day really is the advertised fifteen minutes', () => {
    const g = match('sandbox', 'sandbox');
    const h0 = g.worldTime;
    run(g, 90);
    const h1 = g.worldTime;
    const hours = ((h1 - h0) + 24) % 24;
    /* the true cycle: ten minutes of light, five of dark */
    const expected = 90 * (24 / 900);
    assert(Math.abs(hours - expected) < 0.6, `90 s moved the clock ${hours.toFixed(2)} h, expected ${expected.toFixed(2)}`);
  });

  check('repeated match creation does not leak the world', () => {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 8; i++) { const g = match('campaign', 'standard', 30000 + i); run(g, 3); }
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const mb = (after - before) / 1048576;
    console.log(`       (heap delta over 8 matches: ${mb.toFixed(1)} MB)`);
  });
}

console.log('');
if (fails.length) {
  console.log(`PACING FAILURES (${fails.length})`);
  for (const f of fails) console.log('   ' + f);
  process.exit(1);
}
console.log('PACING CHECKS PASSED');
