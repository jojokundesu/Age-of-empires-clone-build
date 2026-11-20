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
import { DOMAIN } from '../src/sim/hydrology.js';
import { Game, TEAM_WILD, TEAM_PLAYER } from '../src/sim/game.js';

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
