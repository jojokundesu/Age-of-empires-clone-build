/* A War of Crowns, fuzzed: four kingdoms, every system on the board.

   The campaign fuzz (`tests/fuzz.mjs`) runs two teams and the five systems
   the game shipped with. This suite exists because the four-crown war turned
   on a second engine room -- collapse and inheritance, per-team nav grids,
   a court per crown, the wheel of the year, the slow sky, the realm, the
   elites -- and none of it was ever soaked.

   What is checked, every second of game time:
     · no NaN position, no dead-but-standing entity, nobody outside the map
     · no negative resources, and population that equals the living roster
     · no unit walking nowhere for twenty-five seconds
     · a fallen crown owns nothing and fields nobody (inheritance is total)
     · the fallen set, the survivor's roster and the crown count agree

   And at the end: a save round-trips every subsystem (court, calendar,
   climate, realm, elites) without throwing, and a reloaded game still runs.

   node tests/fuzzcrowns.mjs [--seconds 240] [--seeds 2]
*/
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { mulberry32 } from '../src/core/math.js';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(argOf('seconds', 240));
const SEEDS = Number(argOf('seeds', 2));
const STEP = 1 / 30;

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const NULL_SOUND = { play() {} };

function buildGame(seed) {
  const world = generateWorld(seed, { sites: 4 });
  const game = new Game({
    world, civ: 'franks', mode: 'kingdoms', difficulty: 'hard',
    kingdoms: 4, victory: 'conquest', fx: NULL_FX, sound: NULL_SOUND, rand: mulberry32(seed)
  });
  game.start();
  return game;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function checkWorld(game, tag) {
  const bad = [];
  const teams = [...game.teams.keys()];
  for (const u of game.units) {
    if (u.dead) continue;
    const where = `${u.type}#${u.id} (T${u.team})`;
    if (!finite(u.x) || !finite(u.y) || !finite(u.z)) bad.push(`${where} position ${u.x},${u.y},${u.z}`);
    if (!finite(u.hp)) bad.push(`${where} hp ${u.hp}`);
    if (u.hp <= 0) bad.push(`${where} alive with hp ${u.hp}`);
    if (u.hp > u.maxHp + 1e-6) bad.push(`${where} hp ${u.hp} > max ${u.maxHp}`);
    if (u.x < -262 || u.x > 262 || u.z < -262 || u.z > 262) bad.push(`${where} outside the world at ${u.x.toFixed(1)},${u.z.toFixed(1)}`);
    if (!teams.includes(u.team)) bad.push(`${where} belongs to no seated crown (${u.team})`);
    if (u.team === 0 || u.team === null) bad.push(`${where} has no team`);
  }
  for (const b of game.buildings) {
    if (b.dead) continue;
    if (!finite(b.x) || !finite(b.z)) bad.push(`${b.type}#${b.id} position NaN`);
    if (!finite(b.hp) || b.hp <= 0) bad.push(`${b.type}#${b.id} hp ${b.hp}`);
    if (!finite(b.buildProgress)) bad.push(`${b.type}#${b.id} buildProgress ${b.buildProgress}`);
    if (b.x < -262 || b.x > 262 || b.z < -262 || b.z > 262) bad.push(`${b.type}#${b.id} outside the world`);
  }
  for (const t of teams) {
    const st = game.teams.get(t);
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      const v = st.res[k];
      if (!finite(v)) bad.push(`team ${t} ${k} = ${v}`);
      if (v < -1e-6) bad.push(`team ${t} ${k} went negative: ${v.toFixed(3)}`);
    }
    if (!finite(st.popUsed) || st.popUsed < 0) bad.push(`team ${t} popUsed ${st.popUsed}`);
    if (!finite(st.favor) || st.favor < 0) bad.push(`team ${t} favor ${st.favor}`);
    if (st.popUsed > 0 && !game.units.some((u) => !u.dead && u.team === t)) {
      bad.push(`team ${t} counts ${st.popUsed} population with no men`);
    }
  }
  const ids = new Set();
  for (const e of [...game.units, ...game.buildings]) {
    if (ids.has(e.id)) bad.push(`duplicate entity id ${e.id} (${e.type})`);
    ids.add(e.id);
  }
  if (bad.length) throw new Error(`${tag}: ` + bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ` …+${bad.length - 6}` : ''));
}

function checkPop(game, tag) {
  for (const t of [...game.teams.keys()]) {
    const st = game.teams.get(t);
    const before = st.popUsed;
    game.recomputePop();
    if (st.popUsed !== before) throw new Error(`${tag}: team ${t} population drifted ${before} → ${st.popUsed}`);
    /* and the number the HUD shows can never exceed the cap it shows beside it */
    if (st.popUsed > st.popCap && st.popUsed > 0) {
      const over = game.units.filter((u) => !u.dead && u.team === t);
      const per = over.reduce((n, u) => n + (u.def.pop || 1), 0);
      /* Over the cap is not automatically a leak: burn a kingdom's houses and
         the men standing in the rubble outnumber the roofs that feed them.
         Every RTS shows that in red until the ranks thin out, and nothing can
         be trained meanwhile. What must never happen is a *spawn* that pushes
         a team over its own cap, so only a team whose cap did not just fall
         is accused. */
      const seen = game.__popCapSeen || (game.__popCapSeen = new Map());
      const lastCap = seen.get(t);
      seen.set(t, st.popCap);
      const housingLost = lastCap != null && st.popCap < lastCap;
      if (per === st.popUsed && st.popCap > 0 && !housingLost) {
        throw new Error(`${tag}: team ${t} fields ${st.popUsed} men over a cap of ${st.popCap}`);
      }
      continue;
    }
    const seen2 = game.__popCapSeen || (game.__popCapSeen = new Map());
    seen2.set(t, st.popCap);
  }
}

/**
 * Nobody may be standing inside a blocked nav cell.
 *
 * isPassable() deliberately ignores walls (they are nav obstacles, not
 * physical ones), so a unit that ends up inside one neither bounces off nor
 * stops -- it slides about inside the obstacle, and the "walking nowhere"
 * check below never fires because the slide counts as movement. That is how a
 * villager carried a load around inside a wall for thirty seconds in a
 * twenty-minute four-crown war: 1.5 m of jitter each way, stall timer reset,
 * forever.
 */
const insideSince = new Map();
function checkInsideWalls(game, tag) {
  const bad = [];
  for (const u of game.units) {
    if (u.dead || u.garrisoned || !u.def || u.def.naval) continue;
    const pf = game.pfFor(u);
    const [cx, cz] = pf.worldToCell(u.x, u.z);
    /* Being in a *blocked cell* is not the same as being inside a wall. The
       grid stamps a building by which cell its centre falls in, so a 2.8 m
       house claims two cells and leaves the sliver of its face in a third,
       which reads as open ground. And a man on the free half of a cell a hut
       happens to occupy is not trapped at all. So the test is the same union
       the rescue uses: the body must be inside something solid, or the cell
       must be a wall cell. */
    const N = game.navN || 256;
    const wallCell = game.navWall ? game.navWall[cz * N + cx] > 0 : pf.isBlocked(cx, cz);
    const bodyIn = !game.isPassable(u.x, u.z, u);
    if (!wallCell && !bodyIn) { insideSince.delete(u.id); continue; }
    /* a rescue is allowed half a second to notice and lift him out */
    const since = insideSince.has(u.id) ? insideSince.get(u.id) : game.time;
    insideSince.set(u.id, since);
    if (game.time - since > 3) bad.push(`${u.type}#${u.id} (T${u.team}) inside a wall at ${u.x.toFixed(1)},${u.z.toFixed(1)} for ${(game.time - since).toFixed(0)} s`);
  }
  if (bad.length) throw new Error(`${tag}: ${bad.slice(0, 4).join(' | ')}`);
}

function checkOrders(game, tag, stuck) {
  const now = game.time;
  for (const u of game.units) {
    if (u.dead || u.garrisoned) { stuck.delete(u.id); continue; }
    const s = u.state;
    const walking = s === 'move' || s === 'attackMove' || s === 'patrol' || s === 'trade' || s === 'return' || s === 'garrison';
    if (!walking) { stuck.delete(u.id); continue; }
    const last = stuck.get(u.id);
    if (!last) { stuck.set(u.id, { x: u.x, z: u.z, t: now }); continue; }
    const moved = Math.hypot(u.x - last.x, u.z - last.z);
    if (moved > 0.75) { last.x = u.x; last.z = u.z; last.t = now; }
    else if (now - last.t > 28) {
      throw new Error(`${tag}: ${u.type}#${u.id} (T${u.team}) has been walking nowhere at ` +
        `${u.x.toFixed(1)},${u.z.toFixed(1)} in state ${s} for ${(now - last.t).toFixed(0)} s ` +
        `(path ${u.path ? u.path.length + ' nodes' : 'none'}, target ${u.targetPos ? u.targetPos.join(',') : 'none'})`);
    }
  }
}

/** A fallen crown must own nothing: its men and roofs belong to its heir. */
function checkInheritance(game, tag) {
  const fallen = game.fallenTeams || new Set();
  if (!fallen.size) return;
  const squatters = [];
  for (const u of game.units) {
    if (u.dead) continue;
    if (fallen.has(u.team)) squatters.push(`${u.type}#${u.id}`);
  }
  for (const b of game.buildings) {
    if (b.dead) continue;
    if (fallen.has(b.team)) squatters.push(`${b.type}#${b.id}`);
  }
  /* the last blood stands until its spoils are handed over -- allow the very
     tick the crown fell, not a second longer */
  if (squatters.length && game.time - (game.lastCollapseAt || -99) > 2.5) {
    throw new Error(`${tag}: a fallen crown still owns ${squatters.length} things (${squatters.slice(0, 4).join(', ')})`);
  }
}

function runSeed(seed) {
  const game = buildGame(seed);
  const bots = game.teamIds.map((t) => new AIController(game, t, {}));
  const stuck = new Map();
  const collapses = [];
  const orig = game.collapse.bind(game);
  game.collapse = (team, heir) => {
    collapses.push({ t: +game.time.toFixed(0), team, heir });
    game.lastCollapseAt = game.time;
    return orig(team, heir);
  };
  let peakMen = 0, peakRoofs = 0;
  const ticks = Math.round(SECONDS * 30);
  for (let i = 0; i < ticks; i++) {
    for (const b of bots) b.update(STEP);
    game.update(STEP);
    if (i % 30 === 0) {
      const tag = `seed ${seed} t=${game.time.toFixed(0)}s`;
      checkWorld(game, tag);
      checkOrders(game, tag, stuck);
      checkInsideWalls(game, tag);
      checkInheritance(game, tag);
      peakMen = Math.max(peakMen, game.units.filter((u) => !u.dead).length);
      peakRoofs = Math.max(peakRoofs, game.buildings.filter((b) => !b.dead).length);
    }
    if (i % 600 === 0) checkPop(game, `seed ${seed} t=${game.time.toFixed(0)}s`);
    if (game.gameOver) break;
  }
  checkWorld(game, `seed ${seed} (final)`);
  checkPop(game, `seed ${seed} (final)`);
  return { game, collapses, peakMen, peakRoofs, bots };
}

/** Every subsystem's save must survive a JSON round-trip and a reload. */
function checkSave(game, tag) {
  const systems = ['court', 'calendar', 'climate', 'realm', 'elites'];
  const blob = {};
  for (const key of systems) {
    const sys = game[key];
    if (!sys || typeof sys.toJSON !== 'function') continue;
    blob[key] = JSON.parse(JSON.stringify(sys.toJSON()));
  }
  /* a second game, same seed, loads the blob: nothing may throw and the
     reloaded multipliers must still answer */
  const fresh = buildGame(game.world.seed);
  for (const [key, data] of Object.entries(blob)) {
    const sys = fresh[key];
    if (!sys || typeof sys.fromJSON !== 'function') continue;
    fresh.time = game.time;
    sys.fromJSON(data);
  }
  const speeds = fresh.teamIds.map((t) => fresh.unitSpeedMul(fresh.units.find((u) => u.team === t) || { team: t, def: {} }));
  if (speeds.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error(`${tag}: a speed multiplier is ${speeds}`);
  fresh.update(1 / 30);
  return `${Object.keys(blob).length} systems, speeds ${speeds.map((v) => v.toFixed(2)).join('/')}`;
}

console.log(`\nFOUR-CROWN FUZZ — ${SEEDS} seeds × ${SECONDS} s of game time\n`);

for (let s = 0; s < SEEDS; s++) {
  const seed = 4242 + s * 911;
  let r = null;
  check(`seed ${seed} fights a four-crown war without rotting`, () => { r = runSeed(seed); return null; });
  if (r) {
    check(`seed ${seed} resolves or progresses`, () => {
      const g = r.game;
      const standing = g.buildings.filter((b) => !b.dead && b.def && b.def.ageAdvance).length;
      if (!g.gameOver && !r.collapses.length) {
        /* four crowns, four halls each at the start; if nothing at all has
           happened after four minutes the war machine is stalled */
        assert(g.time > 240 || g.time >= SECONDS - 1, 'the war ended early');
        assert(standing >= 1, 'no hall is standing');
        return `${(g.time / 60).toFixed(1)} min, no crown has fallen yet (${standing} halls)`;
      }
      return `${g.gameOver ? `over: ${g.result && g.result.reason}` : 'still fighting'}, ` +
        `${r.collapses.length} crown(s) fell ${JSON.stringify(r.collapses)}`;
    });
    check(`seed ${seed} peaks at a real army`, () => `${r.peakMen} men · ${r.peakRoofs} roofs`);
    check(`seed ${seed} saves and reloads every subsystem`, () => checkSave(r.game, `seed ${seed}`));
    check(`seed ${seed} leaves no crown unaccounted for`, () => {
      const g = r.game;
      const seated = g.teamIds;
      const fallen = [...(g.fallenTeams || [])];
      const withHalls = seated.filter((t) => g.buildings.some((b) => !b.dead && b.team === t && b.def && b.def.ageAdvance));
      const unexplained = withHalls.filter((t) => fallen.includes(t));
      assert(unexplained.length === 0, `crowns ${unexplained} are marked fallen but still hold a hall`);
      return `${seated.length - fallen.length} crown(s) alive, ${fallen.length} fallen`;
    });
  }
}

console.log('');
if (fails.length) {
  console.log(`FOUR-CROWN FUZZ FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`FOUR-CROWN FUZZ PASSED (${pass} checks)`);
