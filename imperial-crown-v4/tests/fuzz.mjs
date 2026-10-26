/* Sim fuzz: a long, hostile, randomly-driven match, with invariants.

   Every other sim suite checks that a specific thing works. This one checks
   that *nothing rots*: for minutes of game time, two AIs and a random player
   issue every kind of order there is, and after every tick the world is
   required to still make sense. The bugs this class of test finds are the ones
   nobody writes a test for -- a unit whose position becomes NaN after a
   failed path, a population counter that drifts after a cancel, a resource
   that goes negative when two villagers turn in on the same tick, an entity
   that survives its own death, a save that no longer round-trips.

   It is also a determinism check: the same seed and the same order script must
   produce a bit-identical world, which is what makes a bug report reproducible
   at all.

   node tests/fuzz.mjs [--seconds 120] [--seeds 3] [--orders 6]
*/
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { BUILDING_DEFS, UNIT_DEFS } from '../src/sim/data.js';
import { mulberry32 } from '../src/core/math.js';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(argOf('seconds', 120));
const SEEDS = Number(argOf('seeds', 3));
const ORDER_TICKS = Number(argOf('orders', 6));

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const STEP = 1 / 30;
const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const NULL_SOUND = { play() {} };

/* ---------------------------------------------------------------- builder */
function buildGame(seed) {
  const world = generateWorld(seed);
  const game = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'hard', fx: NULL_FX, sound: NULL_SOUND, rand: mulberry32(seed) });
  game.start();
  for (const t of [1, 2]) {
    const st = game.teams.get(t);
    st.res.food = 4000; st.res.wood = 4000; st.res.gold = 3000; st.res.stone = 3000;
  }
  return game;
}

/* ------------------------------------------------------- invariant checks */
function checkWorld(game, tag) {
  const bad = [];
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  for (const u of game.units) {
    if (u.dead) continue;
    const where = `${u.type}#${u.id}`;
    if (!finite(u.x) || !finite(u.y) || !finite(u.z)) bad.push(`${where} position ${u.x},${u.y},${u.z}`);
    if (!finite(u.hp)) bad.push(`${where} hp ${u.hp}`);
    if (u.hp <= 0) bad.push(`${where} alive with hp ${u.hp}`);
    if (u.hp > u.maxHp + 1e-6) bad.push(`${where} hp ${u.hp} > max ${u.maxHp}`);
    if (u.x < -260 || u.x > 260 || u.z < -260 || u.z > 260) bad.push(`${where} outside the world at ${u.x.toFixed(1)},${u.z.toFixed(1)}`);
    if (u.kind !== 'unit') bad.push(`${where} is not a unit`);
  }
  for (const b of game.buildings) {
    if (b.dead) continue;
    if (!finite(b.x) || !finite(b.z)) bad.push(`${b.type}#${b.id} position NaN`);
    if (!finite(b.hp) || b.hp <= 0) bad.push(`${b.type}#${b.id} hp ${b.hp}`);
    if (!finite(b.buildProgress)) bad.push(`${b.type}#${b.id} buildProgress ${b.buildProgress}`);
  }
  for (const t of [1, 2]) {
    const st = game.teams.get(t);
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      const v = st.res[k];
      if (!finite(v)) bad.push(`team ${t} ${k} = ${v}`);
      if (v < -1e-6) bad.push(`team ${t} ${k} went negative: ${v.toFixed(3)}`);
    }
    if (!finite(st.popUsed) || st.popUsed < 0) bad.push(`team ${t} popUsed ${st.popUsed}`);
    if (!finite(st.favor) || st.favor < 0) bad.push(`team ${t} favor ${st.favor}`);
  }
  const ids = new Set();
  for (const e of [...game.units, ...game.buildings]) {
    if (ids.has(e.id)) bad.push(`duplicate entity id ${e.id} (${e.type})`);
    ids.add(e.id);
  }
  if (bad.length) throw new Error(`${tag}: ` + bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ` …+${bad.length - 6}` : ''));
}

/** Population must equal what the living roster says it is. */
function checkPop(game, tag) {
  for (const t of [1, 2]) {
    const st = game.teams.get(t);
    const before = st.popUsed;
    game.recomputePop();
    if (st.popUsed !== before) {
      throw new Error(`${tag}: team ${t} population drifted ${before} → ${st.popUsed}`);
    }
  }
}

/** Units must never hold a dead order.
 *
 *  A villager standing still *is* a villager (building, gathering, praying),
 *  so "no movement" alone proves nothing. The bugs are: a unit that keeps
 *  walking to nothing (a failed path is retried forever), and a unit whose
 *  order points at an entity that has been destroyed or finished -- that one
 *  is never allowed to recover by itself, because nobody ever re-issues it.
 */
function checkOrders(game, tag, stuck) {
  const now = game.time;
  const dead = (e) => !e || e.dead;
  /* Stale-target checks must survive one tick. A resource can be exhausted, or a
     foundation completed, by a villager that updates before this one in the same
     tick; the loser clears its order on its next update. So a *single* stale
     sample is normal and three in a row (3 s of game time) is a stuck worker.
     Without this the test cries wolf on healthy play -- and a test that cries
     wolf gets ignored, which is worse than no test. */
  const stale = stuck.stale || (stuck.stale = new Map());
  const badFor = (u, key) => {
    const last = stale.get(u.id);
    const n = last && last.key === key ? last.n + 1 : 1;
    stale.set(u.id, { key, n });
    return n;
  };
  const staleBug = (u, key, why) => {
    if (badFor(u, key) >= 3) throw new Error(`${tag}: ${u.type}#${u.id} ${why} (for 3 s)`);
  };

  for (const u of game.units) {
    if (u.dead || u.garrisoned) { stale.delete(u.id); continue; }
    const s = u.state;
    let key = null;
    if (s === 'build') {
      const t = u.buildTarget;
      key = 'build:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, `is building a ${t ? 'dead' : 'missing'} target`);
      else if (t.buildProgress >= 1) staleBug(u, key, `is still building a finished ${t.type}`);
    } else if (s === 'gather') {
      const t = u.gatherTarget;
      key = 'gather:' + (t ? t.id : 'none');
      if (dead(t) || (t && t.amount <= 0)) staleBug(u, key, `is gathering from a ${t ? 'depleted' : 'missing'} node`);
    } else if (s === 'return') {
      const t = u.dropOff;
      key = 'return:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, `is returning to a ${t ? 'dead' : 'missing'} drop-off`);
    } else if (s === 'attack') {
      const t = u.target;
      key = 'attack:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, 'is attacking a dead target');
    } else if (s === 'repair') {
      const t = u.repairTarget;
      key = 'repair:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, 'is repairing nothing');
      else if (t.hp >= t.maxHp) staleBug(u, key, 'is still repairing a whole building');
    } else if (s === 'convert') {
      const t = u.convertTarget;
      key = 'convert:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, 'is converting a dead unit');
    } else if (s === 'trade') {
      if (u.tradeTarget) { key = 'trade:' + u.tradeTarget.id; if (u.tradeTarget.dead) staleBug(u, key, 'is trading with a dead market'); }
    } else if (s === 'garrison') {
      const t = u.garrisonTarget;
      key = 'garrison:' + (t ? t.id : 'none');
      if (dead(t)) staleBug(u, key, `is walking into a ${t ? 'dead' : 'missing'} host`);
    }
    if (!key) stale.delete(u.id);

    /* walking states: no progress for a long time means a livelock */
    const walking = s === 'move' || s === 'attackMove' || s === 'patrol' || s === 'trade' || s === 'return' || s === 'garrison';
    if (!walking) { stuck.delete(u.id); continue; }
    const last = stuck.get(u.id);
    if (!last) { stuck.set(u.id, { x: u.x, z: u.z, t: now }); continue; }
    const moved = Math.hypot(u.x - last.x, u.z - last.z);
    if (moved > 0.75) { last.x = u.x; last.z = u.z; last.t = now; }
    else if (now - last.t > 25) {
      throw new Error(`${tag}: ${u.type}#${u.id} has been walking nowhere at ${u.x.toFixed(1)},${u.z.toFixed(1)} ` +
        `in state ${s} for ${(now - last.t).toFixed(0)} s (path ${u.path ? u.path.length + ' nodes' : 'none'}, ` +
        `target ${u.targetPos ? u.targetPos.join(',') : 'none'})`);
    }
  }
}

/** A stable fingerprint of everything that matters, for determinism. */
function hashGame(game) {
  let h = 2166136261;
  const mix = (v) => { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619); };
  mix(game.time);
  for (const u of game.units) {
    if (u.dead) continue;
    mix(u.id); mix(u.x); mix(u.z); mix(u.hp);
  }
  for (const b of game.buildings) {
    if (b.dead) continue;
    mix(b.id); mix(b.hp); mix(b.buildProgress);
  }
  for (const t of [1, 2]) {
    const st = game.teams.get(t);
    mix(st.res.food); mix(st.res.wood); mix(st.res.gold); mix(st.res.stone);
    mix(st.popUsed); mix(st.age);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------ the player */
const PLACEABLE = Object.keys(BUILDING_DEFS).filter((k) => !BUILDING_DEFS[k].neutral);
const TRAINABLE = Object.keys(UNIT_DEFS);

function randomLegalSpot(game, team, type, rand) {
  const def = BUILDING_DEFS[type];
  const wantWater = !!def.water;
  for (let tries = 0; tries < 40; tries++) {
    const x = (rand() * 2 - 1) * 200, z = (rand() * 2 - 1) * 200;
    const h = game.heightAt(x, z);
    if (wantWater ? h > -0.8 : h < 0.2) continue;
    const spot = game.canPlaceAt(type, team, x, z);
    if (spot.ok) return { x, z };
  }
  return null;
}

/* The player is expressed as *commands*: a small data record per decision,
   holding entity ids and coordinates and nothing else. `plan()` looks at the
   world and decides; `apply()` does it. Splitting them is what makes the
   determinism check honest -- the replay does not re-decide, it re-executes
   the recorded script, so a divergence is the simulation's fault and never the
   fuzzer's. It is also, in miniature, a recorded game. */
const byId = (game, id) => game.units.find((u) => u.id === id && !u.dead) || null;
const nodeById = (game, id) => game.resources.find((r) => r.id === id) || null;
const bById = (game, id) => game.buildings.find((b) => b.id === id && !b.dead) || null;

function plan(game, rand, log) {
  const roll = rand();
  const mine = game.units.filter((u) => !u.dead && u.team === 1 && !u.garrisoned);
  const myBuildings = game.buildings.filter((b) => !b.dead && b.team === 1);
  const enemyBuildings = game.buildings.filter((b) => !b.dead && b.team === 2);
  const pick = (arr) => (arr.length ? arr[(rand() * arr.length) | 0] : null);
  const idsOf = (n) => mine.slice(0, n).map((u) => u.id);

  if (roll < 0.14 && mine.length) {
    const u = pick(mine);
    return { op: 'move', ids: [u.id], x: (rand() * 2 - 1) * 230, z: (rand() * 2 - 1) * 230 };
  }
  if (roll < 0.24 && mine.length) {
    const u = pick(mine);
    const kind = ['food', 'wood', 'gold', 'stone'][(rand() * 4) | 0];
    const node = game.findNearestResource(kind, u.x, u.z, 120, u);
    if (node) return { op: 'gather', ids: [u.id], node: node.id, kind };
    return { op: 'none', why: 'gather (none nearby)' };
  }
  if (roll < 0.34) {
    const type = PLACEABLE[(rand() * PLACEABLE.length) | 0];
    const spot = randomLegalSpot(game, 1, type, rand);
    if (!spot) return { op: 'none', why: 'build: no site' };
    return { op: 'build', type, x: spot.x, z: spot.z, ids: mine.filter((u) => u.type === 'villager').slice(0, 3).map((u) => u.id) };
  }
  if (roll < 0.46 && myBuildings.length) {
    const b = pick(myBuildings);
    const opts = b.def.trains || [];
    if (opts.length) return { op: 'train', building: b.id, type: opts[(rand() * opts.length) | 0] };
    const techs = b.def.research || [];
    if (techs.length) return { op: 'tech', building: b.id, tech: techs[(rand() * techs.length) | 0] };
    return { op: 'none', why: 'nothing to do at ' + b.type };
  }
  if (roll < 0.54 && enemyBuildings.length && mine.length) {
    const target = pick(enemyBuildings);
    return { op: 'attack', ids: idsOf(4), target: target.id };
  }
  if (roll < 0.60 && mine.length) {
    return { op: 'attackMove', ids: idsOf(5), x: (rand() * 2 - 1) * 220, z: (rand() * 2 - 1) * 220 };
  }
  if (roll < 0.66 && mine.length) {
    const u = pick(mine);
    return { op: 'stance', id: u.id, stance: ['aggressive', 'defensive', 'stand'][(rand() * 3) | 0] };
  }
  if (roll < 0.71 && mine.length) {
    const u = pick(mine);
    const host = myBuildings.find((b) => (b.def.garrison || 0) > 0);
    if (host) return { op: 'garrison', id: u.id, host: host.id };
    return { op: 'none', why: 'garrison (no host)' };
  }
  if (roll < 0.75) {
    const hosts = myBuildings.filter((b) => b.garrison && b.garrison.length);
    return { op: 'ungarrison', hosts: hosts.map((b) => b.id) };
  }
  if (roll < 0.80) {
    if (game.canAdvanceAge(1).ok) return { op: 'age' };
    return { op: 'none', why: 'age (blocked)' };
  }
  if (roll < 0.85) {
    return { op: 'market', kind: rand() < 0.5 ? 'wood' : 'stone', qty: 100, buy: rand() < 0.5 };
  }
  if (roll < 0.90 && mine.length) {
    return { op: 'patrol', ids: idsOf(6), x: (rand() * 2 - 1) * 200, z: (rand() * 2 - 1) * 200 };
  }
  if (roll < 0.95) {
    const u = pick(mine);
    if (u && u.def.classes && u.def.classes.includes('monk')) {
      const near = game.findWoundedAlly(u, 14);
      if (near) return { op: 'heal', id: u.id, target: near.id };
    }
    return { op: 'none', why: 'heal (nobody hurt)' };
  }
  /* a short wall run, the way a player drops a palisade */
  return { op: 'wall', x: (rand() * 2 - 1) * 200, z: (rand() * 2 - 1) * 200, dir: rand() * Math.PI * 2, n: 5 };
}

/** Execute a recorded command. Returns a short label for the log. */
function apply(game, cmd) {
  const units = (ids) => ids.map((id) => byId(game, id)).filter(Boolean);
  switch (cmd.op) {
    case 'move': game.orderMove(units(cmd.ids), cmd.x, cmd.z); return 'move';
    case 'gather': {
      const u = byId(game, cmd.ids[0]), node = nodeById(game, cmd.node);
      if (!u || !node) return 'gather (gone)';
      game.orderGather([u], node); return 'gather ' + cmd.kind;
    }
    case 'build': {
      const b = game.placeBuilding(cmd.type, 1, cmd.x, cmd.z, {});
      if (!b) return 'build refused ' + cmd.type;
      const vills = units(cmd.ids);
      if (vills.length) game.orderBuild(vills, b);
      return 'build ' + cmd.type;
    }
    case 'train': { const b = bById(game, cmd.building); if (!b) return 'train (gone)'; b.queueUnit(cmd.type); return 'train ' + cmd.type; }
    case 'tech': { const b = bById(game, cmd.building); if (!b) return 'tech (gone)'; b.queueTech(cmd.tech); return 'tech'; }
    case 'attack': { const t = bById(game, cmd.target); const u = units(cmd.ids); if (!t || !u.length) return 'attack (gone)'; game.orderAttack(u, t); return 'attack'; }
    case 'attackMove': { const u = units(cmd.ids); if (!u.length) return 'attack-move (gone)'; game.orderAttackMove(u, cmd.x, cmd.z); return 'attack-move'; }
    case 'stance': { const u = byId(game, cmd.id); if (u) u.stance = cmd.stance; return 'stance ' + cmd.stance; }
    case 'garrison': { const u = byId(game, cmd.id), h = bById(game, cmd.host); if (!u || !h) return 'garrison (gone)'; game.orderGarrison([u], h); return 'garrison'; }
    case 'ungarrison': {
      let n = 0;
      for (const id of cmd.hosts) { const b = bById(game, id); if (b && b.garrison && b.garrison.length) { n += b.garrison.length; if (b.ungarrisonAll) b.ungarrisonAll(); } }
      return 'ungarrison ' + n;
    }
    case 'age': return game.startAgeAdvance(1) ? 'advance age' : 'age (refused)';
    case 'market': game.marketTrade(1, cmd.kind, cmd.qty, cmd.buy); return 'market';
    case 'patrol': { const u = units(cmd.ids); if (!u.length) return 'patrol (gone)'; game.orderPatrol(u, cmd.x, cmd.z); return 'patrol'; }
    case 'heal': { const u = byId(game, cmd.id), t = byId(game, cmd.target); if (!u || !t) return 'heal (gone)'; game.orderHeal([u], t); return 'heal'; }
    case 'wall': {
      let built = 0;
      for (let i = 0; i < cmd.n; i++) {
        const b = game.placeBuilding('palissade_wall', 1, cmd.x + Math.cos(cmd.dir) * i * 2.1, cmd.z + Math.sin(cmd.dir) * i * 2.1, { instant: true });
        if (b) built++;
      }
      return 'wall run ' + built;
    }
    default: return cmd.why || 'no-op';
  }
}

/* ------------------------------------------------------------------ run */
function runSeed(seed, record, script, trace) {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const game = buildGame(seed);
  const bots = [new AIController(game, 1, { aggression: 0.7 }), new AIController(game, 2, { aggression: 0.9 })];
  const stuck = new Map();
  const actions = [];
  const marks = [];
  const ticks = Math.round(SECONDS * 30);
  for (let i = 0; i < ticks; i++) {
    for (const b of bots) b.update(STEP);
    game.update(STEP);
    if (i % ORDER_TICKS === 0) {
      const k = (i / ORDER_TICKS) | 0;
      if (script) {
        const label = apply(game, script[k].cmd);
        if (trace) trace.push([i, label]);
      } else {
        const cmd = plan(game, rand, record);
        if (record) actions.push({ tick: i, cmd, label: apply(game, cmd) });
        else apply(game, cmd);
      }
    }
    if (i % 30 === 0) {
      marks.push([i, hashGame(game)]);
      if (record) { checkWorld(game, `seed ${seed} t=${game.time.toFixed(1)}s`);
      checkOrders(game, `seed ${seed} t=${game.time.toFixed(1)}s`, stuck); }
    }
    if (i % 300 === 0 && record) checkPop(game, `seed ${seed} t=${game.time.toFixed(1)}s`);
    if (game.gameOver) break;
  }
  if (record) { checkWorld(game, `seed ${seed} (final)`); checkPop(game, `seed ${seed} (final)`); }
  const summary = { time: game.time, hash: hashGame(game), units: game.units.filter((u) => !u.dead).length, buildings: game.buildings.filter((b) => !b.dead).length, marks: marks.slice() };
  /* a save must round-trip */
  const save = {
    version: 3, seed, civ: game.civ, mode: game.mode,
    teams: { 1: game.exportTeam(1), 2: game.exportTeam(2) },
    units: game.units.filter((u) => !u.dead).map((u) => [u.type, u.team, Math.round(u.x * 10) / 10, Math.round(u.z * 10) / 10, Math.round(u.hp)]),
    buildings: game.buildings.filter((b) => !b.dead).map((b) => [b.type, b.team, Math.round(b.x * 10) / 10, Math.round(b.z * 10) / 10, Math.round(b.hp), b.buildProgress, b.facing || 0])
  };
  return { game, summary, save, actions, marks };
}

/* FUZZ_TRACE=<id> prints what one unit is doing, and why it cannot move, every
   second -- the follow-up tool for the "walking nowhere" invariant. */
if (process.env.FUZZ_TRACE) {
  const want = Number(process.env.FUZZ_TRACE);
  const seed = Number(process.env.FUZZ_SEED || 7001);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const game = buildGame(seed);
  const bots = [new AIController(game, 1, { aggression: 0.7 }), new AIController(game, 2, { aggression: 0.9 })];
  const ticks = Math.round(SECONDS * 30);
  for (let i = 0; i < ticks; i++) {
    for (const b of bots) b.update(STEP);
    game.update(STEP);
    if (i % ORDER_TICKS === 0) apply(game, plan(game, rand));
    if (i % 30 === 0) {
      const u = game.units.find((x) => x.id === want);
      if (u) {
        const [cx, cz] = game.pathFinder.worldToCell(u.x, u.z);
        const d = u.destX !== undefined ? Math.hypot(u.destX - u.x, u.destZ - u.z) : -1;
        console.log(`t=${game.time.toFixed(0)} #${u.id} ${u.type} ${u.state} at ${u.x.toFixed(1)},${u.z.toFixed(1)}`,
          `dest ${u.destX?.toFixed(1)},${u.destZ?.toFixed(1)} d=${d.toFixed(2)}`,
          `path ${u.path ? u.path.length : 'none'} idx ${u.pathIdx}`,
          `passable-here ${game.isPassable(u.x, u.z, u)} cellBlocked ${game.pathFinder.isBlocked(cx, cz)}`,
          `destPassable ${u.destX !== undefined ? game.isPassable(u.destX, u.destZ, u) : '?'}`,
          `stall ${u.stallT?.toFixed(2)} stuck ${u.stuckScore}`);
      }
    }
  }
  process.exit(0);
}

/* Developer aid: FUZZ_DIFF=1 replays one recorded script twice, in lockstep, and
   reports the exact entity and field where the two worlds first differ. */
if (process.env.FUZZ_DIFF) {
  const seed = 7001;
  const r = runSeed(seed, true);
  const a = runSeed(seed, false, r.actions);
  const b = runSeed(seed, false, r.actions);
  console.log('two replays of one script:', a.summary.hash === b.summary.hash ? 'IDENTICAL' : 'DIFFERENT');
  const c = r.summary.hash;
  console.log('  recorded run:', c, ' replay A:', a.summary.hash, ' replay B:', b.summary.hash);
  process.exit(0);
}

console.log(`\nSIM FUZZ — ${SEEDS} seeds × ${SECONDS} s of game time, an order every ${ORDER_TICKS} ticks\n`);

const summaries = [];
for (let s = 0; s < SEEDS; s++) {
  const seed = 7001 + s * 137;
  let r;
  const t0 = Date.now();
  check(`seed ${seed} survives ${SECONDS} s of random play`, () => {
    r = runSeed(seed, true);
    return `${r.summary.units} units · ${r.summary.buildings} buildings · game t=${r.summary.time.toFixed(0)} s · ${Date.now() - t0} ms`;
  });
  if (r) summaries.push(r);

  check(`seed ${seed} replays its command script exactly`, () => {
    if (!r) throw new Error('skipped: the run above did not finish');
    const again = runSeed(seed, false, r.actions);
    if (again.summary.hash === r.summary.hash) return `state hash ${r.summary.hash.toString(16)} reproduced exactly`;
    /* find the first second at which the two worlds part company */
    let at = -1;
    for (let k = 0; k < r.marks.length; k++) if (r.marks[k][1] !== again.marks[k][1]) { at = k; break; }
    const t = at >= 0 ? (at).toFixed(0) + ' s' : 'after the last checkpoint';
    throw new Error(`replay diverged at ${t}: ${r.summary.hash} vs ${again.summary.hash} ` +
      `(units ${r.summary.units}/${again.summary.units}, buildings ${r.summary.buildings}/${again.summary.buildings})`);
  });

  check(`seed ${seed} save/load keeps the economy intact`, () => {
    if (!r) throw new Error('skipped: the run above did not finish');
    const g2 = buildGame(seed);
    const team = r.save.teams[1];
    g2.clearEntities();
    g2.importTeam(1, team);
    g2.importTeam(2, r.save.teams[2]);
    for (const [type, teamId, x, z, hp, prog, facing] of r.save.buildings) {
      if (teamId !== 1 && teamId !== 2) continue;
      const b = g2.placeBuilding(type, teamId, x, z, { instant: true, free: true, facing });
      if (b) { b.hp = Math.min(b.maxHp, hp); b.buildProgress = prog ?? 1; }
    }
    for (const [type, teamId, x, z, hp] of r.save.units) {
      if (teamId !== 1 && teamId !== 2) continue;
      const u = g2.spawnUnit(type, teamId, x, z);
      if (u) { u.maxHp = Math.max(u.maxHp, hp); u.hp = Math.min(u.maxHp, hp); }
    }
    g2.spawnUnit && g2.recomputePop();
    g2.buildingSpatialDirty = true;
    g2.refreshNav();
    const a = r.save.teams[1], b2 = g2.teams.get(1);
    for (const k of ['food', 'wood', 'gold', 'stone', 'popUsed', 'age']) {
      const va = typeof a[k] === 'object' ? a[k] : a[k];
      if (k === 'popUsed') continue;   // recomputed from the roster on load
      if (typeof va === 'number' && Math.abs((b2[k] ?? 0) - va) > 0.5) {
        throw new Error(`team 1 ${k} came back as ${b2[k]} instead of ${va}`);
      }
    }
    for (let i = 0; i < 90; i++) g2.update(STEP);
    checkWorld(g2, `seed ${seed} after reload`);
    return `${r.save.units.length} units, ${r.save.buildings.length} buildings reloaded and ran 3 s`;
  });
}

console.log('');
if (fails.length) {
  console.log(`FUZZ FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`FUZZ PASSED — ${pass} checks`);
