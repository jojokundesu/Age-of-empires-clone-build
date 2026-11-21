/* Mountains: the highest ground on the map, and whether a man can get up it.

   The defect this suite exists to prevent is a specific and embarrassing one.
   The generated map has real relief -- fifty metres of it -- and until this
   section it was scenery. Not because the terrain was impassable in principle,
   but because the only way onto the high ground was a cliff, and a cliff is
   exactly what the navigation domain calls BLOCKED. Two thirds of the map's
   high ground could not be reached from the player's own town, so the most
   dramatic terrain in the game was a painted backdrop with resources printed
   on it that nobody could ever gather.

   The fix is terrain, not permission: a ramp is graded into the height field
   and the domain grid is recompiled from the new heights, so the ramp becomes
   ordinary walkable ground and the cliff either side of it stays solid. That
   distinction is the first thing tested here, because the cheap version of
   this feature -- punching passable cells into the domain -- would pass a
   reachability test while letting men walk up a vertical face.

   Everything is measured by flooding the real navigation grid, which is the
   same grid the pathfinder reads. If the flood arrives, an army arrives.

   node tests/mountain.mjs
*/
import { generateWorld } from '../src/sim/worldgen.js';
import { DOMAIN, CLIMB_MIN, TRAVERSAL } from '../src/sim/hydrology.js';
import { Game, TEAM_WILD, TEAM_PLAYER } from '../src/sim/game.js';
import { traversalOf } from '../src/sim/data.js';

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const NULL_SOUND = { play() {} };

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const SIZES = ['small', 'normal', 'large', 'huge'];
const worlds = new Map();
const world = (size) => {
  if (!worlds.has(size)) worlds.set(size, generateWorld(20261, { size }));
  return worlds.get(size);
};

/* One flood from the player's seat over the whole grid. Cached per size: the
   same flood answers reachability for every crown on that map. */
const floods = new Map();
function floodFromSeat(size) {
  if (floods.has(size)) return floods.get(size);
  const w = world(size);
  const h = w.hydrology;
  const { domain, domainCells: N, domainCell, half } = h;
  const idx = (x, z) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor((x + half) / domainCell)));
    const j = Math.min(N - 1, Math.max(0, Math.floor((z + half) / domainCell)));
    return j * N + i;
  };
  const seat = h.seats[0];
  const seen = new Uint8Array(N * N);
  const start = idx(seat.x, seat.z);
  seen[start] = 1;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head], i = k % N, j = (k / N) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nk = nj * N + ni;
      if (seen[nk]) continue;
      const d = domain[nk];
      if (d === DOMAIN.BLOCKED || d === DOMAIN.WATER_ONLY) continue;
      seen[nk] = 1;
      queue.push(nk);
    }
  }
  const out = { seen, idx, N, domain, seat };
  floods.set(size, out);
  return out;
}

console.log('\nMountains\n');

/* ---------------------------------------------------------------- relief */
check('the map has real relief to climb', () => {
  const w = world('normal');
  const h = w.height;
  let peak = -1e9, n = 0;
  for (let i = 0; i < h.h.length; i++) if (h.h[i] > peak) peak = h.h[i];
  for (let i = 0; i < h.h.length; i++) if (h.h[i] > 22) n++;
  assert(peak > 30, `peak is only ${peak.toFixed(1)} m`);
  assert(n > 40, `only ${n} cells above 22 m`);
  return `peak ${peak.toFixed(1)} m, ${n} cells above 22 m`;
});

/* --------------------------------------------------- climbs are terrain */
check('a climb is graded terrain, not a hole punched in the domain', () => {
  for (const size of ['normal', 'large', 'huge']) {
    const w = world(size);
    for (const c of w.climbs) {
      /* Along the ramp, the ground rises steadily: a cut that only edited the
         permission grid would leave the height field jump by the whole summit
         in one step. */
      const cos = Math.cos(c.angle), sin = Math.sin(c.angle);
      let prev = w.height.sample(c.foot.x, c.foot.z), worst = 0;
      for (let d = 1; d <= 6; d++) {
        const px = c.foot.x + cos * d, pz = c.foot.z + sin * d;
        const h = w.height.sample(px, pz);
        worst = Math.max(worst, Math.abs(h - prev));
        prev = h;
      }
      assert(worst < 4.0, `${size} climb at ${c.x.toFixed(0)},${c.z.toFixed(0)} jumps ${worst.toFixed(1)} m in a metre`);
    }
  }
  return 'no height discontinuity on any ramp';
});

check('the climb did not open the mountain, only a ramp into it', () => {
  /* The cheap version of this feature is to relax the domain and call every
     cliff walkable. These maps are built on the opposite promise: steep ground
     is a wall, everywhere, and the only way onto the high ground is the ramp.
     So count how much genuinely steep land is still refused -- if the cut had
     blanket-opened the heights, this number would collapse to nothing. */
  for (const size of ['normal', 'large', 'huge']) {
    const w = world(size);
    const h = w.hydrology;
    const { domain, domainCells: N, domainCell, half } = h;
    let steep = 0, stillBlocked = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * domainCell - half;
        const z = (j + 0.5) * domainCell - half;
        if (w.height.sample(x, z) < 1) continue;             // only land can be a wall
        if (w.height.slope(x, z) <= 1.05) continue;          // not steep, not a wall
        steep++;
        if (domain[j * N + i] === DOMAIN.BLOCKED) stillBlocked++;
      }
    }
    assert(steep > 50, `${size}: only ${steep} steep land cells on the whole map`);
    assert(stillBlocked === steep, `${size}: ${steep - stillBlocked} steep cells were opened up`);
  }
  return 'every steep land cell on all three sizes is still BLOCKED';
});

/* --------------------------------------------------------- reachability */
check('every summit is reachable from the player\'s seat', () => {
  const lines = [];
  for (const size of SIZES) {
    const w = world(size);
    const { seen, idx, N } = floodFromSeat(size);
    let ok = 0;
    for (const c of w.climbs) if (seen[idx(c.x, c.z)]) ok++;
    assert(ok === w.climbs.length, `${size}: ${ok}/${w.climbs.length} crowns reachable`);
    lines.push(`${size} ${ok}/${w.climbs.length}`);
  }
  return lines.join(', ');
});

check('climbs exist on every map bigger than classic', () => {
  for (const size of ['normal', 'large', 'huge']) {
    assert(world(size).climbs.length === 4, `${size} has ${world(size).climbs.length} climbs`);
  }
  return 'normal/large/huge each 4';
});

check('classic is untouched', () => {
  const w = generateWorld(20261, {});
  assert(w.climbs.length === 0, `classic grew ${w.climbs.length} climbs`);
  assert(w.resources.length === 907, `classic resource count changed to ${w.resources.length}`);
  assert(!w.resources.some((r) => r.summit), 'classic grew summit resources');
  return 'no climbs, no summit nodes, 907 resources';
});

/* ------------------------------------------------------------- the prize */
check('the crowns are worth climbing', () => {
  const w = world('normal');
  const summit = w.resources.filter((r) => r.summit);
  assert(summit.length >= 60, `only ${summit.length} summit nodes`);
  const gold = summit.filter((r) => r.kind === 'gold');
  const best = Math.max(...gold.map((r) => r.amount));
  /* The contested centre of the map pays 1200 a mine; a summit that paid the
     same would never justify the climb. */
  assert(best > 1200, `summit gold pays only ${best}`);
  for (const kind of ['gold', 'stone', 'wood', 'food']) {
    assert(summit.some((r) => r.kind === kind), `no ${kind} on the summits`);
  }
  return `${summit.length} nodes, gold up to ${best}`;
});

check('the summit ground can actually be worked', () => {
  for (const size of ['normal', 'large', 'huge']) {
    const w = world(size);
    const { seen, idx, N, domain } = floodFromSeat(size);
    const summit = w.resources.filter((r) => r.summit);
    let workable = 0;
    for (const r of summit) {
      const k = idx(r.x, r.z);
      if (domain[k] !== DOMAIN.LAND_ONLY) continue;
      const i = k % N, j = (k / N) | 0;
      let stand = false;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        if (seen[nj * N + ni]) { stand = true; break; }
      }
      if (stand) workable++;
    }
    assert(workable === summit.length, `${size}: ${workable}/${summit.length} summit nodes have a reachable standing spot`);
  }
  return 'every summit node has walkable ground beside it';
});

/* ------------------------------------------------------------- the toll */
/* A crown a single villager can stroll onto and mine is not high ground, it is
   a plateau. These tests put a real working party on a real summit and ask
   whether the animals there do anything -- and whether an escort changes the
   answer, because "bring an escort" is the decision the section is for. */
function crownEncounter({ escort, seconds = 45, size = 'normal' }) {
  const w = generateWorld(20261, { size });
  const g = new Game({ world: w, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed: 20261 });
  g.start();
  g.ai = [];
  g.teams.get(TEAM_PLAYER).popCap = 200;
  const c = w.climbs[0];
  const crew = [];
  for (let i = 0; i < 3; i++) {
    const v = g.spawnUnit('villager', TEAM_PLAYER, c.x + (i - 1) * 2, c.z + 2, null, { force: true });
    v.noAggro = true;
    crew.push(v);
  }
  const guard = [];
  for (let i = 0; i < escort; i++) {
    const m = g.spawnUnit('spearman', TEAM_PLAYER,
      c.x + ((i % 4) - 1.5) * 1.4, c.z - 2 - Math.floor(i / 4) * 1.4, null, { force: true });
    m.stance = 'aggressive';
    guard.push(m);
  }
  for (let i = 0; i < seconds * 30; i++) g.update(1 / 30);
  const wild = g.units.filter((u) => u.team === TEAM_WILD);
  return {
    crewAlive: crew.filter((v) => !v.dead).length,
    guardLost: guard.filter((m) => m.dead).length,
    wildAlive: wild.filter((u) => !u.dead).length,
    wildTotal: wild.length,
    game: g, world: w
  };
}

check('an unescorted working party does not survive the summit', () => {
  const r = crownEncounter({ escort: 0 });
  assert(r.wildTotal > 0, 'no animals on the crown at all');
  assert(r.crewAlive === 0, `${r.crewAlive}/3 villagers survived an escort of nobody`);
  return `${r.wildTotal} animals, crew wiped`;
});

check('an escort saves the party and pays for it', () => {
  const r = crownEncounter({ escort: 4 });
  assert(r.crewAlive === 3, `only ${r.crewAlive}/3 villagers survived with four spearmen`);
  assert(r.guardLost >= 1, 'the escort was free — no spearman was killed');
  return `crew 3/3 saved, ${r.guardLost}/4 spearmen lost`;
});

check("animals are nobody's faction", () => {
  const r = crownEncounter({ escort: 0, seconds: 0 });
  const g = r.game;
  assert(!g.teams.has(TEAM_WILD), 'animals registered as a crown');
  assert(!g.teamIds.includes(TEAM_WILD), 'animals counted for victory');
  assert(g.isHostile(TEAM_WILD, TEAM_PLAYER), 'animals are not hostile to a crown');
  assert(g.isHostile(TEAM_WILD, 2), 'animals are not hostile to the enemy crown');
  assert(!g.isHostile(TEAM_WILD, TEAM_WILD), 'animals are hostile to each other');
  const wild = g.units.filter((u) => u.team === TEAM_WILD);
  assert(wild.every((u) => u.wild), 'wild units are missing the wild flag');
  assert(wild.every((u) => u.def.pop === 0), 'animals consume population');
  return `${wild.length} animals, no crown, no pop`;
});

/* The leash keeps the animals in place. This keeps them *quiet*: a leashed
   animal that cannot reach what it wants will re-ask the pathfinder for a
   route down a sealed ramp every tick, and a ridge of them turns into a
   permanent A* tax nobody sees until the frame budget is gone. The spec
   asked for leashed *and* not spamming failed queries; the check above only
   proved the first half. */
check('a leashed animal does not hammer the pathfinder at a sealed ramp', () => {
  const r = crownEncounter({ escort: 0, seconds: 0 });
  const g = r.game;
  const pf = g.pathFinder;
  const wildIds = new Set(g.units.filter((u) => u.team === TEAM_WILD && !u.dead).map((u) => u.id));
  assert(wildIds.size > 0, 'no wildlife on this crown to measure');
  const realFind = pf.find.bind(pf);
  let calls = 0, failed = 0;
  pf.find = (...args) => {
    const out = realFind(...args);
    calls++;
    if (!out || !out.length) failed++;
    return out;
  };
  const SECONDS = 30;
  try { for (let i = 0; i < 30 * SECONDS; i++) g.update(1 / 30); }
  finally { pf.find = realFind; }
  /* Generous on purpose: this is a runaway detector, not a budget. One
     failed query per animal every two seconds is already plenty of slack,
     and a per-tick re-ask would be thirty times that. */
  const ceiling = wildIds.size * SECONDS * 0.5;
  assert(failed <= ceiling,
    `${failed} failed path queries in ${SECONDS} s from ${wildIds.size} animals (ceiling ${Math.round(ceiling)})`);
  return `${failed} failed of ${calls} queries, ${wildIds.size} animals over ${SECONDS} s`;
});

check('animals stay on their mountain', () => {
  const r = crownEncounter({ escort: 0, seconds: 0 });
  const g = r.game;
  const wild = g.units.filter((u) => u.team === TEAM_WILD);
  for (let i = 0; i < 30 * 40; i++) g.update(1 / 30);
  const strays = wild.filter((u) => !u.dead && Math.hypot(u.x - u.homePoint.x, u.z - u.homePoint.z) > 30);
  assert(strays.length === 0, `${strays.length} animals wandered more than 30 m off their ground`);
  return 'every animal within 30 m of its post after 40 s';
});

/* ---------------------------------------------------------- determinism */
/* ================================================================
   THE CLIMB LADDER

   Everything above this line is about the mountain. Everything below is
   about the three structures that are the only way onto it, and the rule
   the whole section rests on: a summit is an island until somebody pays
   for a way up, and what he pays for decides who may use it.
   ================================================================ */

/** A match on a generated map, with the AI off and nothing spent. */
function match(size = 'normal') {
  const w = generateWorld(20261, { size });
  const g = new Game({ world: w, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed: 20261 });
  g.start();
  g.ai = [];
  g.teams.get(TEAM_PLAYER).popCap = 200;
  return { g, w, c: w.climbs[0] };
}

/** Can this weight class walk from a to b right now? */
function reaches(g, from, to, trav, radius = 2) {
  const pf = g.pathFinder;
  pf.lastGated = false;
  const path = pf.find(from.x, from.z, to.x, to.z, radius, { offTick: true, traversal: trav });
  if (!path || !path.length) return { ok: false, gated: pf.lastGated, short: Infinity };
  const end = path[path.length - 1];
  const short = Math.hypot(end[0] - to.x, end[1] - to.z);
  return { ok: short < 6, gated: pf.lastGated, short };
}

/** Put a finished climb structure of `type` on socket `c`. */
function raise(g, c, type) {
  const b = g.placeBuilding(type, TEAM_PLAYER, c.throat.x, c.throat.z,
    { free: true, instant: true, climb: c });
  g.refreshNav();
  return b;
}

check('the summits got taller, and stayed under the height cap', () => {
  const lines = [];
  for (const size of ['normal', 'large', 'huge']) {
    const w = world(size);
    for (const c of w.climbs) {
      const crown = w.height.sample(c.x, c.z);
      assert(crown >= 26, `${size}: a crown is only ${crown.toFixed(1)} m`);
      /* +38 m is where the renderer's height quantisation clips. Anything
         above it would need HEIGHT_RANGE changed in the CPU bake and in
         every GLSL site that unpacks it, together, or the terrain mesh and
         the simulation would disagree about where the mountain is. */
      assert(crown <= 35, `${size}: a crown reached ${crown.toFixed(1)} m, over the 35 m ceiling`);
      assert(c.length >= 45, `${size}: an ascent is only ${c.length.toFixed(0)} m long`);
    }
    const hi = Math.max(...w.climbs.map((c) => w.height.sample(c.x, c.z)));
    const run = Math.min(...w.climbs.map((c) => c.length));
    lines.push(`${size} ${hi.toFixed(0)} m / ${run.toFixed(0)} m run`);
  }
  return lines.join(', ');
});

check('small and classic are bit-identical to the maps before the climbs', () => {
  /* Recorded against the tree as it stood before this section: if a change
     to the mountains ever reaches the 512 m maps, these four numbers move
     and this test is the only thing that will say so. */
  const fnv = (arr) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < arr.length; i++) {
      h ^= Math.round(arr[i] * 1000) & 0xffffffff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  for (const [label, opts] of [['small', { size: 'small' }], ['classic', {}]]) {
    const w = generateWorld(20261, opts);
    const res = [];
    for (const r of w.resources) res.push(r.x, r.z, r.amount, r.type.length);
    assert(fnv(w.height.h) === '2c602706', `${label} terrain changed (${fnv(w.height.h)})`);
    assert(fnv(w.hydrology.domain) === 'ca824a45', `${label} domain changed (${fnv(w.hydrology.domain)})`);
    assert(fnv(w.nav.blocked) === '5fe8a1a5', `${label} nav grid changed (${fnv(w.nav.blocked)})`);
    assert(fnv(res) === 'd6778681', `${label} resources moved`);
    assert(w.decor.length === 1465, `${label} decor count changed to ${w.decor.length}`);
    assert((w.climbs || []).length === 0, `${label} grew climbs`);
  }
  return 'terrain 2c602706 · domain ca824a45 · nav 5fe8a1a5 · 0 climbs';
});

check('the weight classes cost nothing in nav memory', () => {
  const w = world('normal');
  const n = w.nav.cells * w.nav.cells;
  assert(w.nav.blocked instanceof Uint8Array, 'the nav grid stopped being a Uint8Array');
  assert(w.nav.blocked.length === n, `nav grid is ${w.nav.blocked.length} cells, expected ${n}`);
  assert(w.nav.domain.length === n, 'the domain grid changed size');
  /* The codes live in the bytes that were already there: 0-3 as before,
     4/5/6 for the three climb classes. */
  const seen = new Set(w.nav.blocked);
  for (const v of seen) assert(v <= DOMAIN.HEAVY_CLIMB, `nav grid holds ${v}, outside the domain codes`);
  return `${n} cells, one byte each, codes ${[...seen].sort((a, b) => a - b).join('/')}`;
});

check('an unbuilt throat seals the summit against every class, diagonals included', () => {
  for (const size of ['normal', 'large', 'huge']) {
    const { g, w } = match(size);
    let leaked = 0;
    for (const c of w.climbs) {
      assert(c.tier === 0, `${size}: a climb starts already open`);
      assert(c.footAnchor && c.summitAnchor, `${size}: a climb is missing a build stand`);
      for (const trav of [TRAVERSAL.foot, TRAVERSAL.mounted, TRAVERSAL.heavy]) {
        if (reaches(g, c.footAnchor, { x: c.x, z: c.z }, trav).ok) leaked++;
      }
    }
    assert(leaked === 0, `${size}: ${leaked} paths leaked onto a sealed summit`);
  }
  return 'normal/large/huge: 0 leaked paths, all three classes, all four ramps';
});

check('a scaling ladder carries men and nothing else', () => {
  const { g, c } = match();
  assert(!reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.foot).ok, 'the summit was open before the ladder');
  const b = raise(g, c, 'cliff_ladder');
  assert(b && c.tier === DOMAIN.FOOT_CLIMB, `the ladder set tier ${c.tier}`);
  const foot = reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.foot);
  assert(foot.ok, `a villager still cannot climb (${foot.short.toFixed(1)} m short)`);
  for (const [name, trav] of [['cavalry', TRAVERSAL.mounted], ['siege', TRAVERSAL.heavy]]) {
    const r = reaches(g, c.footAnchor, { x: c.x, z: c.z }, trav);
    assert(!r.ok, `${name} walked up a rope ladder`);
    assert(r.gated, `${name} was refused, but not for a reason the player can act on`);
  }
  return 'foot up, cavalry and siege refused with an actionable reason';
});

check('a timber switchback adds the horse, and a pulley lift adds the siege train', () => {
  const { g, c } = match();
  raise(g, c, 'cliff_switchback');
  assert(c.tier === DOMAIN.MOUNTED_CLIMB, `switchback set tier ${c.tier}`);
  assert(reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.foot).ok, 'foot lost the switchback');
  assert(reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.mounted).ok, 'cavalry cannot use a switchback');
  assert(!reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.heavy).ok, 'a ram drove up a timber trestle');

  const { g: g2, c: c2 } = match();
  raise(g2, c2, 'cliff_lift');
  assert(c2.tier === DOMAIN.HEAVY_CLIMB, `the lift set tier ${c2.tier}`);
  for (const trav of [TRAVERSAL.foot, TRAVERSAL.mounted, TRAVERSAL.heavy]) {
    assert(reaches(g2, c2.footAnchor, { x: c2.x, z: c2.z }, trav).ok, `class ${trav} cannot use the lift`);
  }
  return 'ladder foot · switchback +horse · lift +siege';
});

check('the traversal class is read off the unit, never off a list of names', () => {
  /* A knight in this game fights on foot: he carries `classes: cavalry` for
     the counter system and no mount. Any hardcoded "knights are cavalry"
     test would put him on the wrong side of every ladder in the game. */
  const { g } = match();
  const expect = {
    villager: 0, spearman: 0, archer: 0, monk: 0, knight: 0,
    scout_cavalry: 1, cataphract: 1, mangudai: 1,
    ram: 2, mangonel: 2, trebuchet: 2, bombard_cannon: 2, trade_cart: 2
  };
  for (const [type, want] of Object.entries(expect)) {
    assert(traversalOf(type) === want, `${type} classified ${traversalOf(type)}, expected ${want}`);
  }
  const k = g.spawnUnit('knight', TEAM_PLAYER, g.world.hydrology.seats[0].x + 6, g.world.hydrology.seats[0].z + 6, null, { force: true });
  assert(k && g.traversalOf(k) === 0, 'the knight was treated as mounted');
  const s = g.spawnUnit('scout_cavalry', TEAM_PLAYER, g.world.hydrology.seats[0].x + 8, g.world.hydrology.seats[0].z + 6, null, { force: true });
  assert(s && g.traversalOf(s) === 1, 'the scout was not treated as mounted');
  return '13 types, and the dismounted knight climbs with the infantry';
});

check('a climb is slow going up and quicker coming down, by tier', () => {
  const { g, c } = match();
  const want = {
    cliff_ladder: [0.42, 0.65],
    cliff_switchback: [0.72, 0.95],
    cliff_lift: [1.05, 1.10]
  };
  const lines = [];
  for (const [type, [up, down]] of Object.entries(want)) {
    const { g: gg, c: cc } = match();
    raise(gg, cc, type);
    const u = gg.spawnUnit('villager', TEAM_PLAYER, cc.throat.x, cc.throat.z, null, { force: true });
    u.x = cc.throat.x; u.z = cc.throat.z;
    const hi = { x: cc.x, z: cc.z }, lo = cc.footAnchor;
    u.path = [[hi.x, hi.z]]; u.pathIdx = 0;
    const climbing = gg.climbSpeedMul(u);
    u.path = [[lo.x, lo.z]]; u.pathIdx = 0;
    const descending = gg.climbSpeedMul(u);
    assert(Math.abs(climbing - up) < 1e-6, `${type} climbs at ${climbing}, expected ${up}`);
    assert(Math.abs(descending - down) < 1e-6, `${type} descends at ${descending}, expected ${down}`);
    lines.push(`${type.replace('cliff_', '')} ${up}/${down}`);
  }
  assert(g.climbSpeedMul(g.spawnUnit('villager', TEAM_PLAYER, c.footAnchor.x, c.footAnchor.z, null, { force: true })) === 1,
    'ordinary ground is not full speed');
  return lines.join(' · ');
});

check('a valley villager builds the way up, and losing it shuts the mountain again', () => {
  const { g, c } = match();
  const v = g.spawnUnit('villager', TEAM_PLAYER, c.footAnchor.x + 3, c.footAnchor.z + 3, null, { force: true });
  assert(v, 'no villager');
  /* He can reach the stand at the foot of the climb... */
  const toStand = reaches(g, v, c.footAnchor, TRAVERSAL.foot);
  assert(toStand.ok, `the valley build stand is unreachable (${toStand.short.toFixed(1)} m short)`);
  /* ...but not the crown, until he has built something. */
  assert(!reaches(g, v, { x: c.x, z: c.z }, TRAVERSAL.foot).ok, 'the crown was open before anything was built');
  const b = raise(g, c, 'cliff_ladder');
  assert(reaches(g, v, { x: c.x, z: c.z }, TRAVERSAL.foot).ok, 'the finished ladder did not open the climb');
  /* Burn it. The mountain closes, and the components are rebuilt -- a stale
     reachability label here would strand every unit that asked. */
  b.kill();
  g.onBuildingKilled(b);
  g.refreshNav();
  assert(c.tier === 0, `the destroyed ladder left tier ${c.tier}`);
  const after = reaches(g, v, { x: c.x, z: c.z }, TRAVERSAL.foot);
  assert(!after.ok, 'the summit stayed open after the ladder burned');
  return 'built from the valley, re-sealed on destruction, components refreshed';
});

check('a builder walks to the stand on his own side of the mountain', () => {
  /* The anti-deadlock rule, stated as behaviour: the same order, given to
     two villagers on opposite sides of a sealed throat, has to send them
     to two different places. */
  const { g, c } = match();
  const below = g.spawnUnit('villager', TEAM_PLAYER, c.footAnchor.x + 2, c.footAnchor.z + 2, null, { force: true });
  const above = g.spawnUnit('villager', TEAM_PLAYER, c.summitAnchor.x, c.summitAnchor.z - 2, null, { force: true });
  assert(below && above, 'the two villagers did not spawn');
  assert(g.climbStandFor(below, c) === c.footAnchor, 'the valley villager was sent over the mountain');
  assert(g.climbStandFor(above, c) === c.summitAnchor, 'the stranded villager was sent to the valley');
  const site = g.placeBuilding('cliff_ladder', TEAM_PLAYER, c.throat.x, c.throat.z, { free: true, climb: c });
  assert(site && site.buildProgress < 0.99, 'the foundation did not go down');
  g.orderBuild([below, above], site);
  for (const [who, want] of [[below, c.footAnchor], [above, c.summitAnchor]]) {
    const goal = who.targetPos || (who.path && who.path[who.path.length - 1]);
    assert(goal, 'a builder was given no route to the site');
    const gx = who.targetPos ? who.targetPos[0] : goal[0];
    const gz = who.targetPos ? who.targetPos[1] : goal[1];
    assert(Math.hypot(gx - want.x, gz - want.z) < 8,
      `a builder is heading for ${gx.toFixed(0)},${gz.toFixed(0)} instead of his own stand`);
  }
  return 'valley crew to the foot stand, summit crew to the head stand';
});

check('a villager stranded on the summit can rebuild his own way down', () => {
  /* The deadlock this prevents: the ladder burns while a mining party is on
     the crown. If the only build stand were in the valley, those men would
     be stuck on a rock for the rest of the match. */
  const { g, c } = match();
  const up = g.spawnUnit('villager', TEAM_PLAYER, c.summitAnchor.x, c.summitAnchor.z, null, { force: true });
  assert(up, 'no villager on the summit');
  assert(reaches(g, up, c.summitAnchor, TRAVERSAL.foot).ok, 'the summit build stand is unreachable from the summit');
  assert(!reaches(g, up, c.footAnchor, TRAVERSAL.foot).ok, 'the summit was not sealed from above');
  const spot = g.canPlaceAt('cliff_ladder', TEAM_PLAYER, c.throat.x, c.throat.z);
  assert(spot.ok, `a stranded villager may not build a ladder: ${spot.reason}`);
  raise(g, c, 'cliff_ladder');
  assert(reaches(g, up, c.footAnchor, TRAVERSAL.foot).ok, 'he built a ladder and still cannot get down');
  return 'summit stand reachable from above, and the climb rebuilds downward';
});

check('a mixed order parks the cavalry at the foot and sends the infantry up', () => {
  const { g, c } = match();
  raise(g, c, 'cliff_ladder');
  const foot = [], horse = [];
  for (let i = 0; i < 3; i++) {
    foot.push(g.spawnUnit('spearman', TEAM_PLAYER, c.footAnchor.x + i * 1.6 - 2, c.footAnchor.z + 3, null, { force: true }));
    horse.push(g.spawnUnit('scout_cavalry', TEAM_PLAYER, c.footAnchor.x + i * 1.6 - 2, c.footAnchor.z + 6, null, { force: true }));
  }
  const all = [...foot, ...horse].filter(Boolean);
  assert(all.length === 6, 'the squad did not form');
  g.orderMove(all, c.x, c.z, false);
  for (const u of foot) assert(u.path || u.targetPos, 'a spearman was refused the summit he can climb');
  for (const u of horse) {
    assert(u.state !== undefined, 'a horseman has no state');
    const goal = u.targetPos || (u.path && u.path[u.path.length - 1]);
    assert(goal, 'a horseman was given no orders at all');
    const gx = u.targetPos ? u.targetPos[0] : goal[0];
    const gz = u.targetPos ? u.targetPos[1] : goal[1];
    const toCrown = Math.hypot(gx - c.x, gz - c.z);
    const toStand = Math.hypot(gx - c.footAnchor.x, gz - c.footAnchor.z);
    assert(toStand < toCrown, `a horseman is still marching at the cliff (${toStand.toFixed(0)} m from the stand, ${toCrown.toFixed(0)} m from the crown)`);
  }
  return 'three spearmen climb, three horsemen hold the stand below';
});

check('the pulley lift is the only drop-off a summit may have, and it dies with the building', () => {
  const { g, c } = match();
  const b = raise(g, c, 'cliff_lift');
  assert(b.def.dropoff.includes('gold') && b.def.dropoff.includes('stone') && b.def.dropoff.includes('wood'),
    'the lift does not accept the ores it exists for');
  assert(!b.def.dropoff.includes('food'), 'the lift takes food it has no business taking');
  /* A miner on the crown now has somewhere to tip his basket, and it is the
     lift -- not a town centre forty metres below him. */
  for (const kind of ['gold', 'stone', 'wood']) {
    const drop = g.findDropoff(TEAM_PLAYER, kind, c.x, c.z, 999);
    assert(drop === b, `${kind} on the summit still reports to ${drop ? drop.type : 'nothing'}`);
  }
  /* And it is handed over at the brow, not at the throat the lift stands in. */
  const [px, pz] = g.dropPointOf(b);
  assert(Math.hypot(px - b.x, pz - b.z) > 2, 'the hoist platform is on top of the structure');
  assert(g.world.isSummit(px, pz) || g.heightAt(px, pz) > g.heightAt(b.x, b.z) - 2,
    'the hoist platform is below the structure instead of at the brow');
  b.kill();
  g.onBuildingKilled(b);
  g.refreshNav();
  assert(c.tier === 0, 'passage survived the lift');
  assert(g.findDropoff(TEAM_PLAYER, 'gold', c.x, c.z, 90) === null,
    'the summit kept its drop-off after the lift was destroyed');
  return 'gold/stone/wood at the brow, both passage and drop-off lost on destruction';
});

check('the summit carries a richer haul than the valley', () => {
  const w = world('normal');
  const summit = w.resources.filter((r) => r.summit);
  assert(summit.length > 0, 'no summit nodes to pay the bonus on');
  assert(w.resources.some((r) => !r.summit), 'everything on the map is a summit node');
  const { g, c } = match();
  const node = g.resources.find((r) => r.summit && Math.hypot(r.x - c.x, r.z - c.z) < 40 && r.resKind === 'gold');
  assert(node, 'no summit gold near the first crown');
  const plain = g.resources.find((r) => !r.summit && r.resKind === 'gold');
  assert(plain, 'no ordinary gold on the map');
  const take = (n) => {
    const v = g.spawnUnit('villager', TEAM_PLAYER, n.x, n.z, null, { force: true });
    v.x = n.x + 0.4; v.z = n.z;                 // inside arm's reach of the rock
    v.carry = { kind: n.resKind, amount: 0 };
    v.gatherTarget = n;
    v.homeNode = n;
    v.gatherCooldown = 0;
    const before = n.amount;
    v.updateGather(0.016, { gathered: 0 });
    return { mined: before - n.amount, packed: v.carry.amount };
  };
  const hi = take(node), lo = take(plain);
  assert(hi.mined > 0 && lo.mined > 0, 'no ore came out of the rock');
  const ratio = (hi.packed / hi.mined) / (lo.packed / lo.mined);
  assert(Math.abs(ratio - 1.6) < 0.01, `the alpine haul pays ${ratio.toFixed(2)}x, expected 1.6x`);
  /* The bonus is in the pack, not in the rock: the node must not last longer. */
  assert(Math.abs(hi.mined - lo.mined) < 1e-6, 'the summit node empties at a different rate');
  return `1.6x in the pack, same drain on the node (${summit.length} summit nodes)`;
});

check('the alpine building code refuses a town and accepts a garrison', () => {
  const { g, c } = match();
  g.teams.get(TEAM_PLAYER).age = 3;
  assert(g.world.isSummit(c.x, c.z), 'the crown does not report as summit ground');
  assert(!g.world.isSummit(c.footAnchor.x, c.footAnchor.z), 'the valley reports as summit ground');
  const banned = ['town_center', 'house', 'farm', 'mill', 'mining_camp', 'lumber_camp', 'market',
    'barracks', 'stable', 'archery_range', 'siege_workshop', 'monastery', 'university', 'wonder'];
  for (const type of banned) {
    const r = g.canPlaceAt(type, TEAM_PLAYER, c.x + 2, c.z + 2);
    assert(!r.ok, `${type} may be built on a rocky summit`);
    assert(r.reason === 'summit', `${type} was refused for "${r.reason}", not the summit rule`);
  }
  for (const type of ['watch_tower', 'palissade_wall', 'stone_wall', 'stone_gate']) {
    const r = g.canPlaceAt(type, TEAM_PLAYER, c.x + 2, c.z + 2);
    assert(r.ok, `${type} is not allowed on the summit it is meant to hold (${r.reason})`);
  }
  /* The same house is perfectly legal off the mountain. The ground at the
     foot of a ramp can still refuse it for being steep or occupied -- what
     it must never say is `summit`. */
  const seat = g.world.hydrology.seats[0];
  assert(g.canPlaceAt('house', TEAM_PLAYER, seat.x + 14, seat.z + 14).ok, 'a house cannot be built in the home valley');
  assert(g.canPlaceAt('house', TEAM_PLAYER, c.footAnchor.x + 6, c.footAnchor.z + 6).reason !== 'summit',
    'the summit rule leaked down the mountain');
  return `${banned.length} civilian types refused, towers and walls allowed`;
});

check('a climb structure only goes in a throat, one to a ramp, in its own age', () => {
  const { g, c } = match();
  const st = g.teams.get(TEAM_PLAYER);
  st.age = 0;
  assert(g.canPlaceAt('cliff_ladder', TEAM_PLAYER, c.throat.x, c.throat.z).ok, 'no ladder in the Dark Age');
  assert(g.canPlaceAt('cliff_switchback', TEAM_PLAYER, c.throat.x, c.throat.z).reason === 'age',
    'a switchback was allowed in the Dark Age');
  const seat = g.world.hydrology.seats[0];
  assert(g.canPlaceAt('cliff_ladder', TEAM_PLAYER, seat.x, seat.z).reason === 'noclimb',
    'a ladder may be built in the middle of a field');
  raise(g, c, 'cliff_ladder');
  assert(g.canPlaceAt('cliff_ladder', TEAM_PLAYER, c.throat.x, c.throat.z).reason === 'occupied',
    'two ladders fit on one ramp');
  st.age = 2;
  const up = g.canPlaceAt('cliff_switchback', TEAM_PLAYER, c.throat.x, c.throat.z);
  assert(up.ok, `a ladder cannot be upgraded in place: ${up.reason}`);
  return 'age-gated, ramp-only, one per ramp, upgradeable in place';
});

check('an upgrade never closes the mountain while it is being built', () => {
  /* Pay for a switchback over a standing ladder and the ladder must keep
     working until the switchback is finished -- otherwise the upgrade is a
     self-inflicted siege. */
  const { g, c } = match();
  raise(g, c, 'cliff_ladder');
  const old = g.climbStructure(c);
  const next = g.placeBuilding('cliff_switchback', TEAM_PLAYER, c.throat.x, c.throat.z, { free: true, climb: c });
  assert(next && next.buildProgress < 0.99, 'the upgrade was finished instantly');
  assert(!old.dead, 'the ladder was demolished before its replacement stood');
  assert(c.tier === DOMAIN.FOOT_CLIMB, `the climb dropped to tier ${c.tier} mid-upgrade`);
  assert(reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.foot).ok, 'the climb shut during its own upgrade');
  g.onBuildingComplete(next);
  assert(old.dead, 'the ladder survived its replacement');
  assert(c.tier === DOMAIN.MOUNTED_CLIMB, `the finished switchback left tier ${c.tier}`);
  assert(reaches(g, c.footAnchor, { x: c.x, z: c.z }, TRAVERSAL.mounted).ok, 'the finished switchback does not carry horses');
  return 'the ladder works until the switchback stands, then hands over';
});

check('every ramp is marked on the ground for a player who has not built yet', () => {
  for (const size of ['normal', 'large', 'huge']) {
    const w = world(size);
    const posts = (w.decor || []).filter((d) => d.type === 'trail_post');
    assert(posts.length >= w.climbs.length * 2, `${size}: ${posts.length} markers for ${w.climbs.length} ramps`);
    for (const c of w.climbs) {
      for (const a of [c.footAnchor, c.summitAnchor]) {
        assert(posts.some((p) => Math.hypot(p.x - a.x, p.z - a.z) < 3), `${size}: a build stand has no marker`);
      }
    }
  }
  assert((world('small').decor || []).every((d) => d.type !== 'trail_post'), 'classic grew trail markers');
  return 'a cairn and a board at both stands of every ramp';
});

check('the same seed gives the same mountains', () => {
  const a = generateWorld(20261, { size: 'normal' });
  const b = generateWorld(20261, { size: 'normal' });
  assert(a.climbs.length === b.climbs.length, 'climb count differs');
  for (let i = 0; i < a.climbs.length; i++) {
    assert(a.climbs[i].x === b.climbs[i].x && a.climbs[i].z === b.climbs[i].z, `climb ${i} moved`);
    assert(a.climbs[i].h === b.climbs[i].h, `climb ${i} changed height`);
  }
  return `${a.climbs.length} climbs, identical twice`;
});

console.log('');
if (fails.length) {
  console.log(`MOUNTAIN FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`MOUNTAIN CHECKS PASSED (${pass})`);
