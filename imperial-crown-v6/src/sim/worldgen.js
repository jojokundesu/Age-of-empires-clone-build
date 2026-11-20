/* ============================================================
   worldgen.js — deterministic terrain, biomes, forests & camps
   The whole match lives in a 512 x 512 metre square. Height is
   baked once into a Float32Array and sampled analytically after
   that, so nothing in the frame loop touches noise functions.
   ============================================================ */
import { clamp, lerp, smoothstep, fbm2, ridged2, noise2, mulberry32, rngFor, dist2, TAU } from '../core/math.js';
import { buildHydrology, refreshHydrology, DOMAIN, WATER_LEVEL } from './hydrology.js';

/* The map sizes, and the one place their numbers live.
   `WORLD` below stays the 512 m small preset, because a great many call
   sites read it as a constant and every one of them is describing the map it
   was written for. A generated world carries its own numbers in `world.w`, and
   that is what the simulation and the renderer read. Anything that needs to be
   size-agnostic takes the world, not the module.

   THE LADDER
   ----------
   512 m is a village: an army crosses it in twenty seconds, so the only
   strategic question a match can ask is "do I have more men". It is the small
   map now, not the whole game, and 1024 m is the normal one.

       small    512 m    terrain 4 m   nav 2.00 m
       normal  1024 m    terrain 4 m   nav 2.00 m    <- the default
       large   2048 m    terrain 4 m   nav 2.67 m
       huge    3072 m    terrain 4 m   nav 3.00 m

   Terrain cells stay 4 m at every size, so the ground keeps the same detail
   and the same look; what changes is how much ground. The nav grid is the
   expensive one (five Uint8 layers of navCells^2 -- land, steep, domain,
   naval, gates), so it coarsens instead of growing without limit: 2 m cells
   where a man's path is worth 2 m, and 3 m at the top, which is 5.2 MB rather
   than the 14 MB a 2 m grid would cost at 3072 m.

   Generation is the real ceiling, not memory. Hydrology is a per-cell scan
   against every river, so it grows with the square of the size: about 0.5 s
   for normal, 0.9 s for large and 1.8 s for huge on a desktop, which is
   roughly 1.5 / 2.8 / 5.3 s on the budget phone this has to run on. That is a
   one-time cost behind the boot screen, and it is why 4 km is not on the list:
   it doubled again. */
export const MAP_SIZES = {
  /* Small is exactly what shipped before 6.5 and must not move a metre:
     every existing test, seed and save describes it. Its old id was
     'classic', which is still accepted and still resolves to this. */
  small: { id: 'small', name: 'Small', legacy: ['classic'], size: 512, segments: 128, navCells: 256, navCell: 2, fowCells: 128, bakeTex: 512 },
  /* Normal: the default, and the size the game is balanced around. 256
     segments is 4 m cells -- the same ground detail as Small, four times the
     ground -- and the nav grid doubles to 512 cells so the cell stays 2 m. */
  normal: { id: 'normal', name: 'Normal', legacy: ['large'], size: 1024, segments: 256, navCells: 512, navCell: 2, fowCells: 256, bakeTex: 1024 },
  /* Large: four times the ground of Small. Terrain stays 4 m, so 512
     segments; the nav grid goes to 768 cells (2.67 m) to keep the layers
     under 3 MB. */
  large: { id: 'large', name: 'Large', size: 2048, segments: 512, navCells: 768, navCell: 2048 / 768, fowCells: 512, bakeTex: 1024 },
  /* Huge: the ceiling the generator and the phone will take. 768 segments is
     still 4 m; the nav grid stays at 512 cells per side worth of cost by
     opening to 3 m. */
  huge: { id: 'huge', name: 'Huge', size: 3072, segments: 768, navCells: 1024, navCell: 3, fowCells: 768, bakeTex: 1024 }
};
export const MAP_SIZE_LIST = ['small', 'normal', 'large', 'huge'];
export const DEFAULT_MAP_SIZE = 'normal';
/* What `generateWorld` and `startMatch` make when nobody names a size. It is
   Small, not the menu's default: `generateWorld(20261)` is a hundred call
   sites in the suites and every one of them means "the map this seed has
   always made". Growing the default must not silently redraw them. */
export const IMPLICIT_MAP_SIZE = 'small';

/* Old ids are still resolved, because a save written at 6.5 named its size
   and `'classic'` meant what `'small'` means now. Renaming the ladder must not
   turn a saved match into a different map. */
const SIZE_ALIAS = (() => {
  const m = {};
  for (const k of MAP_SIZE_LIST) {
    m[k] = k;
    for (const old of MAP_SIZES[k].legacy || []) m[old] = k;
  }
  return m;
})();

export function mapSize(idOrSize) {
  /* A preset object is a legitimate argument (worldShape takes one, and
     callers pass the result of one into the other). This used to fall through
     to the default and only *looked* correct, because the default happened to
     be the preset being asked for; it was caught the moment the ladder was
     renamed. */
  if (idOrSize && typeof idOrSize === 'object') {
    const id = SIZE_ALIAS[idOrSize.id] || idOrSize.id;
    if (id && MAP_SIZES[id]) return MAP_SIZES[id];
    if (typeof idOrSize.size === 'number') return mapSize(idOrSize.size);
  }
  if (typeof idOrSize === 'number') {
    let best = MAP_SIZES.small, gap = Infinity;
    for (const k of MAP_SIZE_LIST) {
      const g = Math.abs(MAP_SIZES[k].size - idOrSize);
      if (g < gap) { gap = g; best = MAP_SIZES[k]; }
    }
    return best;
  }
  const id = SIZE_ALIAS[idOrSize];
  return (id && MAP_SIZES[id]) || MAP_SIZES[DEFAULT_MAP_SIZE];
}

/** Resolve any accepted id (current or legacy) to its canonical one. */
export function mapSizeId(id) {
  const k = SIZE_ALIAS[id];
  return k || DEFAULT_MAP_SIZE;
}

/** The shape of a world, derived once from its preset. */
export function worldShape(preset) {
  const size = preset.size;
  return {
    id: preset.id,
    name: preset.name,
    size,
    half: size * 0.5,
    segments: preset.segments,
    cell: size / preset.segments,
    navCells: preset.navCells,
    navCell: preset.navCell,
    fowCells: preset.fowCells,
    fowCell: size / preset.fowCells,
    bakeTex: preset.bakeTex,
    waterLevel: 0.0,
    seaLevel: -1.6
  };
}

/* The classic 512 m preset, kept under its old name for every caller that
   means "the map I was written against". A world carries the truth. */
export const WORLD = {
  size: 512,
  half: 256,
  segments: 128,          // terrain grid resolution (4 m cells)
  cell: 4,
  waterLevel: 0.0,
  seaLevel: -1.6,
  navCells: 256,
  navCell: 2,
  fowCells: 128,
  fowCell: 512 / 128
};

export const BIOME = {
  MEADOW: 0, FOREST: 1, HIGHLAND: 2, DESERT: 3, MARSH: 4, ASH: 5, COAST: 6
};

export const TERRAIN_LAYER = {
  GRASS: 0, DRY_GRASS: 1, DIRT: 2, ROCK: 3, SAND: 4, MUD: 5, SNOW: 6, GRAVEL: 7
};

/** Height field with bilinear sampling and a baked normal cache. */
export class HeightField {
  constructor(res, size) {
    this.res = res;
    this.size = size;
    this.cell = size / res;
    this.h = new Float32Array((res + 1) * (res + 1));
    this.min = 0;
    this.max = 0;
  }
  idx(x, z) { return z * (this.res + 1) + x; }
  /** Raw grid value. */
  at(x, z) {
    const cx = clamp(x, 0, this.res);
    const cz = clamp(z, 0, this.res);
    return this.h[(cz | 0) * (this.res + 1) + (cx | 0)];
  }
  /** Bilinear sample in world metres (origin at the map centre). */
  sample(wx, wz) {
    const fx = clamp((wx + this.size * 0.5) / this.cell, 0, this.res - 0.0001);
    const fz = clamp((wz + this.size * 0.5) / this.cell, 0, this.res - 0.0001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const r = this.res + 1;
    const h00 = this.h[z0 * r + x0];
    const h10 = this.h[z0 * r + x0 + 1];
    const h01 = this.h[(z0 + 1) * r + x0];
    const h11 = this.h[(z0 + 1) * r + x0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  /** Surface normal (not normalised vertically scaled) in world space. */
  normal(wx, wz, out) {
    const d = this.cell * 0.75;
    const hl = this.sample(wx - d, wz);
    const hr = this.sample(wx + d, wz);
    const hd = this.sample(wx, wz - d);
    const hu = this.sample(wx, wz + d);
    let nx = hl - hr, ny = 2 * d, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }
  /** Steepness, in rise over run, evaluated analytically. */
  slope(wx, wz) {
    const d = this.cell;
    const hl = this.sample(wx - d, wz), hr = this.sample(wx + d, wz);
    const hd = this.sample(wx, wz - d), hu = this.sample(wx, wz + d);
    return Math.hypot(hr - hl, hu - hd) / (2 * d);
  }
}

/**
 * Generate a complete world.
 * @param {number} seed
 * @param {object} opts { players, mapStyle }
 * @returns world description consumed by the sim and renderer
 */
export function generateWorld(seed = 20261, opts = {}) {
  const rand = mulberry32(seed);
  const rng = rngFor(seed ^ 0x9e3779b9);
  /* A world's size is decided here, once, and travels in `w`. Classic is the
     default at the API level so that every existing caller -- 41 test files,
     every save, every seed -- keeps the map it was written against; the menu
     asks for Large explicitly. */
  const shape = worldShape(mapSize(opts.size || opts.mapSize || IMPLICIT_MAP_SIZE));
  const res = shape.segments;
  const size = shape.size;
  const hf = new HeightField(res, size);
  /* Every map is a hydrological map now. `classic` is still accepted so that
     an old save reloads, and each classic save gets its own historic map for
     free -- the segmenter below rebuilds the island it was played on. */
  const sites = Math.max(2, Math.min(4, (opts && opts.sites) | 0 || 2));
  const requested = opts.mapType || 'confluence';
  const mapType = requested === 'classic' ? 'confluence' : requested;
  const hydro = buildHydrology(seed, mapType, { res, size, navCells: shape.navCells, seats: sites });
  const mapInfo = hydro.info;
  const style = hydro.style;
  const n = res + 1;
  const splat = new Uint8Array(n * n * 2);      // layer id, blend byte
  const water = new Uint8Array(n * n);
  const walk = new Uint8Array(n * n);           // 1 = walkable land
  const props = new Uint8Array(n * n);          // 1 = large prop (blocks building)

  const styleParams = {
    temperate: { hills: 1.0, trees: 1.0, sand: 0, snow: 0.9, moisture: 0.5 },
    mediterranean: { hills: 1.25, trees: 0.62, sand: 0.3, snow: 1.4, moisture: 0.28 },
    northern: { hills: 1.1, trees: 1.35, sand: 0.05, snow: 0.4, moisture: 0.8 },
    arid: { hills: 0.85, trees: 0.35, sand: 0.9, snow: 2.2, moisture: 0.12 }
  }[style];

  // ---- heightfield: the hydrology generator owns every map now
  /* No branch here draws a rim of border water: the only water on the map is
     where the landform and the carved channels actually fall below the water
     table. The borders rise into highlands instead. */
  const riverPhase = rng() * TAU;
  let fords = hydro.fords.map((f) => ({ ...f }));
  hf.h.set(hydro.heights);

  /* ---- mountains you can get to ----
     The cliffs are the best-looking thing on the map and they were dead
     ground. Measured on the default map (seed 20261, Normal): 98 patches of
     high ground above 22 m, of which exactly *seven* -- 7% -- could be reached
     from the player's own seat. Everything else was a scenery wall with gold
     behind it and no way up, and the only thing a player could learn from it
     was that the dramatic terrain is furniture.

     Two things were in the way, and both are the same mistake in different
     places:

       - `connectLandmasses` deliberately does not run at 512 m, so *every*
         map size's sealed summits stayed sealed (the promise for classic is
         that it is untouched, and that has to keep holding).
       - a climb is not a landmass. Even where the passes run, a summit is a
         pocket a few cells across, below the size floor that the safety net
         cares about.

     So the mountain gets a climb of its own, carved here rather than in the
     nav domain: a switchbacked ramp cut into the steepest face of each
     substantial summit, wide enough for two men and shallow enough to walk.
     The ramp is real terrain -- it is drawn, it is lit, and a siege engine can
     stand on it.

     Classic is exempt by *seed-independent* geometry rather than by a special
     case: at 512 m the whole map is the authored island and its silhouette is
     part of what the size promises, so `MAP_SIZES` never asks for climbs
     there. Everything the ladder calls Normal and above gets them. */
  /* Each cut is checked as it is made, against the same rule the domain
     compiler will later apply, so a ramp that lands on a shoulder is rejected
     while there are still summits left to try. */
  const climbs = shape.size > 512
    ? carveMountainClimbs(hf, hydro, size, rng, (c) => climbWalks(hf, hydro, c))
    : [];
  hydro.heights.set(hf.h);
  if (climbs.length) {
    /* The domain grid is what the pathfinder reads, and it was compiled from
       the heights *before* the ramps existed -- so a graded slope stayed a
       wall to everything downstream and the whole exercise was invisible.
       Recompile it from the new heights, exactly as the town apron does, and
       the ramp becomes ordinary walkable ground with the cliff still solid
       either side of it. Nothing has to know a climb exists. */
    refreshHydrology(hydro, (wx, wz) => hf.sample(wx, wz), (wx, wz) => hf.slope(wx, wz));
  }

  // ---- biome map (moisture + temperature)
  const biome = new Uint8Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const wx = (x / res) * size - size * 0.5;
      const wz = (z / res) * size - size * 0.5;
      const h = hf.h[z * n + x];
      const moist = fbm2(wx / 70 + 21, wz / 70 - 13, 3) * 0.5 + 0.5 + (styleParams.moisture - 0.5);
      const temp = 1 - clamp((h + 2) / 22, 0, 1) * styleParams.snow;
      let b = BIOME.MEADOW;
      if (h < -0.4) b = BIOME.COAST;
      else if (moist > 0.62 && h < 9) b = BIOME.FOREST;
      else if (h > 9.5) b = BIOME.HIGHLAND;
      else if (moist < 0.34 && styleParams.sand > 0.4) b = BIOME.DESERT;
      else if (moist > 0.72 && h < 1.6) b = BIOME.MARSH;
      biome[z * n + x] = b;
    }
  }

  // ---- splat + walkability + water
  /* Domain-aware ground: shallow fords and beaches are walkable land AND
     navigable water, deep water is water only, cliffs are blocked. */
  const groundAt = (i, wx, wz) => {
    const h = hf.h[i];
    const slope = hf.slope(wx, wz);
    const d = hydro.domainAt(wx, wz);
    if (d === DOMAIN.BLOCKED) return { water: h < 0 ? 1 : 0, walk: 0 };
    if (d === DOMAIN.WATER_ONLY) return { water: 1, walk: 0 };
    if (d === DOMAIN.AMPHIBIOUS_SHALLO_FORD) return { water: h < 0 ? 1 : 0, walk: slope < 0.62 ? 1 : 0 };
    return { water: 0, walk: slope < 0.62 ? 1 : 0 };
  };
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const wx = (x / res) * size - size * 0.5;
      const wz = (z / res) * size - size * 0.5;
      const h = hf.h[i];
      const slope = hf.slope(wx, wz);
      const b = biome[i];
      let layer = TERRAIN_LAYER.GRASS;
      let blend = 210;
      if (h < 0.25) { layer = TERRAIN_LAYER.SAND; blend = 235; }
      if (h < -0.9) { layer = TERRAIN_LAYER.MUD; blend = 255; }
      if (slope > 0.36) { layer = TERRAIN_LAYER.ROCK; blend = 190 + (slope * 40 | 0); }
      if (b === BIOME.DESERT) { layer = TERRAIN_LAYER.SAND; blend = 245; }
      if (b === BIOME.HIGHLAND) { layer = TERRAIN_LAYER.GRAVEL; blend = 200; }
      if (b === BIOME.MARSH) { layer = TERRAIN_LAYER.MUD; blend = 235; }
      if (b === BIOME.FOREST) { layer = TERRAIN_LAYER.DRY_GRASS; blend = 150; }
      /* No snow pass here. `buildRenderTerrain` owns snow now, because it is
         the only place that knows the map's own relief -- this fixed 13.5 m
         threshold was painting the entire Highview plateau white. */
      splat[i * 2] = layer;
      splat[i * 2 + 1] = Math.min(255, blend);
      const g = groundAt(i, wx, wz);
      water[i] = g.water;
      walk[i] = g.walk;
    }
  }

  // ---- spawn sites: the landform decides where the towns stand
  /* The generator places each seat on the ground its archetype cares about --
     a bank of the Danube, a coast of the inland sea, the four corners of the
     plateau -- so the map itself is what makes a two-crown duel a river
     crossing and a four-crown war a race for the fords. */
  const SEATS = hydro.seats.slice(0, sites).map((s) => ({ x: s.x, z: s.z, h: s.h }));
  while (SEATS.length < 2) {
    const a = rng() * TAU;
    SEATS.push({ x: Math.cos(a) * 150, z: Math.sin(a) * 150, h: hf.sample(Math.cos(a) * 150, Math.sin(a) * 150) });
  }
  const playerBase = SEATS[0], enemyBase = SEATS[1];
  /* Flatten only the *town apron*: 22 m of buildable ground, ramped out over
     another 14 m, and never allowed to lift or drop a channel cell. That last
     clause is what stops a plateau from filling in the river it was built on. */
  for (const b of SEATS) {
    flattenPlateau(hf, b.x, b.z, 22, b.h, (wx, wz) => hydro.sample(wx, wz) > WATER_LEVEL + 0.9);
    b.h = hf.sample(b.x, b.z);
  }
  hydro.heights.set(hf.h);
  refreshHydrology(hydro, (wx, wz) => hf.sample(wx, wz), (wx, wz) => hf.slope(wx, wz));
  fords = hydro.fords.map((f) => ({ ...f }));
  // recompute walkability inside plateaus
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const wx = (x / res) * size - size * 0.5;
      const wz = (z / res) * size - size * 0.5;
      const g = groundAt(i, wx, wz);
      water[i] = g.water;
      walk[i] = g.walk;
    }
  }

  // ---- resources, props and decoration
  const resources = [];
  const propList = [];
  const decor = [];
  const roads = [];

  const nearBase = (x, z, r) => SEATS.some((b) => dist2(x, z, b.x, b.z) < r * r);

  // Helper: find a clear spot near a hint point
  const findSpot = (hx, hz, minR, maxR, tries = 26, needLand = true) => {
    for (let t = 0; t < tries; t++) {
      const a = rng() * TAU;
      const d = minR + rng() * (maxR - minR);
      const x = clamp(hx + Math.cos(a) * d, -246, 246);
      const z = clamp(hz + Math.sin(a) * d, -246, 246);
      if (needLand && (hfSample(hf, x, z) < 0.2 || hfSlope(hf, x, z) > 0.5)) continue;
      if (nearBase(x, z, 19)) continue;
      return { x, z };
    }
    return null;
  };
  const hfSample = (f, x, z) => f.sample(x, z);
  const hfSlope = (f, x, z) => f.slope(x, z);

  /* Resources scale with the ground. A scatter tuned for 512 m, run unchanged
     on a 1024 m map, leaves the same nine hundred nodes spread over four times
     the area: the field is 226 nodes per classic map's worth of ground, which
     is a walk between every tree and a stone mine a march away. `spread` is
     the area ratio, and it multiplies the counts -- not the radii, not the
     cluster sizes, because a bigger map should have MORE places to go, not
     the same places covering more ground. */
  const spread = (size * size) / (512 * 512);
  const spreadCount = (n) => Math.max(1, Math.round(n * spread));

  // Forests: dense clumps of trees
  const forestClusters = spreadCount(26);
  for (let c = 0; c < forestClusters; c++) {
    const cx = rng() * (size - 72) - (size - 72) * 0.5;
    const cz = rng() * (size - 72) - (size - 72) * 0.5;
    if (hfSample(hf, cx, cz) < 0.3) continue;
    if (nearBase(cx, cz, 34)) continue;
    const rad = 9 + rng() * 17;
    const count = Math.floor(rad * rad * 0.11 * styleParams.trees + 4);
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * rad;
      const edge = size * 0.5 - 8;
      const x = clamp(cx + Math.cos(a) * d, -edge, edge);
      const z = clamp(cz + Math.sin(a) * d, -edge, edge);
      if (hfSample(hf, x, z) < 0.4 || hfSlope(hf, x, z) > 0.55) continue;
      if (nearBase(x, z, 20)) continue;
      const kind = rng() < 0.86 ? 'tree' : 'bush';
      resources.push({
        kind: kind === 'tree' ? 'wood' : 'food', type: kind, resKind: kind === 'tree' ? 'wood' : 'food',
        x, z, amount: kind === 'tree' ? 220 : 120, radius: kind === 'tree' ? 0.85 : 1.0,
        variant: (rng() * 4) | 0, scale: 0.85 + rng() * 0.5, y: hfSample(hf, x, z)
      });
    }
  }

  // Straggler trees near each base
  for (const base of SEATS) {
    for (let i = 0; i < 7; i++) {
      const s = findSpot(base.x, base.z, 16, 24, 20);
      if (!s) continue;
      resources.push({ kind: 'wood', type: 'tree', resKind: 'wood', x: s.x, z: s.z, amount: 200, radius: 0.85, variant: (rng() * 4) | 0, scale: 0.9 + rng() * 0.3, y: hfSample(hf, s.x, s.z) });
    }
  }

  /* Gold + stone clusters, one guaranteed close to each base -- placed in
     OPPOSITE directions and well clear of the town apron. The old pair of
     independent findSpot() calls kept landing on the same flank, so a town
     could have its stone at 20 m and its gold at 22 m in the same arc, and
     the 18-26 m ring where a Wonder has to go was blocked by a mine. A
     gold mine you cannot build past is not a strategic decision. */
  for (const base of SEATS) {
    const goldAng = rng() * TAU;
    const stoneAng = goldAng + Math.PI + (rng() - 0.5) * 0.9;
    const ringSpot = (ang, minR, maxR) => {
      for (let t = 0; t < 24; t++) {
        const a = ang + (rng() - 0.5) * 0.5;
        const d = minR + rng() * (maxR - minR);
        const x = clamp(base.x + Math.cos(a) * d, -246, 246);
        const z = clamp(base.z + Math.sin(a) * d, -246, 246);
        if (hfSample(hf, x, z) < 0.2 || hfSlope(hf, x, z) > 0.5) continue;
        if (nearBase(x, z, 30)) continue;          // leave the apron buildable
        return { x, z };
      }
      return findSpot(base.x, base.z, minR, maxR, 20);
    };
    const gs = ringSpot(goldAng, 30, 38);
    if (gs) for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const x = gs.x + Math.cos(a) * (2.5 + rng() * 2), z = gs.z + Math.sin(a) * (2.5 + rng() * 2);
      resources.push({ kind: 'gold', type: 'gold_mine', resKind: 'gold', x, z, amount: 900, radius: 1.25, scale: 0.9 + rng() * 0.35, y: hfSample(hf, x, z) });
    }
    const ss = ringSpot(stoneAng, 30, 38);
    if (ss) for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.6;
      const x = ss.x + Math.cos(a) * (2.8 + rng() * 1.8), z = ss.z + Math.sin(a) * (2.8 + rng() * 1.8);
      resources.push({ kind: 'stone', type: 'stone_mine', resKind: 'stone', x, z, amount: 800, radius: 1.2, scale: 0.9 + rng() * 0.3, y: hfSample(hf, x, z) });
    }
    // berry bushes
    const bs = findSpot(base.x, base.z, 13, 20, 24);
    if (bs) for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + rng();
      const x = bs.x + Math.cos(a) * (2.2 + rng() * 1.6), z = bs.z + Math.sin(a) * (2.2 + rng() * 1.6);
      resources.push({ kind: 'food', type: 'berry_bush', resKind: 'food', x, z, amount: 260, radius: 1.0, scale: 0.9 + rng() * 0.2, y: hfSample(hf, x, z) });
    }
    // deer + boar herds
    const ds = findSpot(base.x, base.z, 24, 34, 24);
    if (ds) for (let i = 0; i < 7; i++) {
      const x = ds.x + (rng() - 0.5) * 9, z = ds.z + (rng() - 0.5) * 9;
      resources.push({ kind: 'food', type: 'deer', resKind: 'food', herd: true, x, z, amount: 360, radius: 0.7, scale: 0.95 + rng() * 0.15, y: hfSample(hf, x, z) });
    }
  }

  /* ---- centre of the map ----------------------------------------------
     A map with nothing in the middle is a map with no reason to leave home.
     Every archetype therefore gets a contested core: the largest landmass
     nearest the centre that is not one of the towns, with a gold field, a
     stone outcrop, a herd and (on the water maps) fish close inshore. The
     fight for it is the middle game. If the centre is deep water -- the
     inland sea, a strait -- the features go on the biggest island in it and
     a Sacred Site is placed there instead, so the fleet has a destination. */
  let contested = null;
  {
    let bestScore = -1e9;
    for (let cz = 0; cz < 26; cz++) {
      for (let cx = 0; cx < 26; cx++) {
        const x = (cx + 0.5) / 26 * 470 - 235;
        const z = (cz + 0.5) / 26 * 470 - 235;
        const h = hfSample(hf, x, z);
        if (h < 1.0 || hfSlope(hf, x, z) > 0.30) continue;
        if (nearBase(x, z, 60)) continue;
        /* Prefer flat, dry, central, and with room for a small town. */
        let room = 0;
        for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10], [7, 7], [-7, -7]]) {
          if (hfSample(hf, x + dx, z + dz) > 0.6) room++;
        }
        if (room < 5) continue;
        /* The contested ground must be land, not a sandbar in the river: a
           channel runs through the middle of the river maps, so the nearest
           dry point to (0,0) can be a metre-wide islet. It needs a real
           apron of dry ground before it is worth fighting over. */
        let dryRing = 0;
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * TAU;
          if (hfSample(hf, x + Math.cos(ang) * 22, z + Math.sin(ang) * 22) > 1.0) dryRing++;
        }
        if (dryRing < 7) continue;
        const score = 40 - Math.hypot(x, z) * 0.24 + room * 3 + dryRing * 4 - hfSlope(hf, x, z) * 40;
        if (score > bestScore) { bestScore = score; contested = { x, z, y: h }; }
      }
    }
  }
  if (contested) {
    const { x: cx0, z: cz0, y: cy0 } = contested;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      resources.push({ kind: 'gold', type: 'gold_mine', resKind: 'gold',
        x: cx0 + Math.cos(a) * (3.4 + rng() * 2.4), z: cz0 + Math.sin(a) * (3.4 + rng() * 2.4),
        amount: 1200, radius: 1.25, scale: 1.05 + rng() * 0.2, y: cy0 });
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.7;
      resources.push({ kind: 'stone', type: 'stone_mine', resKind: 'stone',
        x: cx0 + Math.cos(a) * (10 + rng() * 3), z: cz0 + Math.sin(a) * (10 + rng() * 3),
        amount: 900, radius: 1.2, scale: 1.0 + rng() * 0.2, y: cy0 });
    }
    for (let i = 0; i < 5; i++) {
      resources.push({ kind: 'food', type: 'berry_bush', resKind: 'food',
        x: cx0 + (rng() - 0.5) * 22, z: cz0 + (rng() - 0.5) * 22,
        amount: 300, radius: 1.0, scale: 0.95, y: cy0 });
    }
    for (let i = 0; i < 6; i++) {
      resources.push({ kind: 'wood', type: 'tree', resKind: 'wood',
        x: cx0 + 13 + Math.cos(i * 2.1) * 5, z: cz0 + 13 + Math.sin(i * 2.1) * 5,
        amount: 220, radius: 0.85, variant: (rng() * 4) | 0, scale: 1.0 + rng() * 0.3, y: cy0 });
    }
    /* The contested ground is cleared of scatter so it reads as a place. */
    for (let i = 0; i < 70; i++) {
      const a = rng() * TAU, d = Math.sqrt(rng()) * 24;
      const x = cx0 + Math.cos(a) * d, z = cz0 + Math.sin(a) * d;
      if (hfSample(hf, x, z) < 0.2) continue;
      stampRoad(splat, hf, shape, x, z, 0.35 + 0.4 * (1 - d / 26), 2.0);
    }
  }

  // Scattered distant gold/stone
  for (let i = 0; i < spreadCount(14); i++) {
    const a = rng() * TAU, d = (70 + rng() * 160) * (size / 512);
    const edge = size * 0.5 - 16;
    const x = clamp(Math.cos(a) * d, -edge, edge), z = clamp(Math.sin(a) * d, -edge, edge);
    if (hfSample(hf, x, z) < 0.3 || nearBase(x, z, 22)) continue;
    const isGold = rng() < 0.55;
    const count = 3 + ((rng() * 3) | 0);
    for (let k = 0; k < count; k++) {
      const ang = rng() * TAU, r = 2 + rng() * 3.4;
      resources.push({
        kind: isGold ? 'gold' : 'stone', type: isGold ? 'gold_mine' : 'stone_mine', resKind: isGold ? 'gold' : 'stone',
        x: x + Math.cos(ang) * r, z: z + Math.sin(ang) * r, amount: isGold ? 900 : 800,
        radius: 1.2, scale: 0.9 + rng() * 0.3, y: hfSample(hf, x, z)
      });
    }
  }

  /* Fishing grounds, on every map that has water at all: the river is a food
     economy, not scenery. Shoals sit in the channel and along the bank. */
  for (let i = 0; i < spreadCount(40); i++) {
    const a = rng() * TAU, d = (12 + Math.sqrt(rng()) * 200) * (size / 512);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (hfSample(hf, x, z) > -0.42) continue;
    resources.push({ kind: 'food', type: 'fish', resKind: 'food', x, z, amount: 700, radius: 1.6, scale: 0.9, y: hfSample(hf, x, z) });
  }

  // Relics: 5 scattered golden chests
  for (let i = 0; i < spreadCount(5); i++) {
    const a = rng() * TAU, d = (60 + rng() * 150) * (size / 512);
    const re = size * 0.5 - 26;
    const x = clamp(Math.cos(a) * d, -re, re), z = clamp(Math.sin(a) * d, -re, re);
    if (hfSample(hf, x, z) < 0.3) continue;
    resources.push({ kind: 'relic', type: 'relic', resKind: 'relic', x, z, amount: 1, radius: 0.5, scale: 1, y: hfSample(hf, x, z) });
  }

  /* Decorative ground cover -- 100% instanced, 100% non-blocking.
     The random decorative WOOD CHUNKS / LOGS are GONE. They used to be
     sprinkled across the whole island at every height, where they read as
     litter, cluttered the raycasts and sat on top of paths. Ground cover is
     now purposeful: reeds at the waterline, rocks on slopes, flowers and
     tussocks in clumps on the meadows. Nothing here interferes with a unit's
     tile -- every strategic cluster is a real resource node on the grid. */
  /* Ground cover, placed by *place* and not by area.
     An even sprinkle of anything across 512 x 512 m reads as noise: 2400
     pebbles is one every 10 m of meadow, which is exactly the frequency the
     eye reads as dirt on the screen rather than as a landscape. Cover is
     therefore grown in patches -- a scree field at the foot of a cliff, a
     reedy creek margin, a stand of flowers in a hollow -- and clustered
     inside each patch so the middle is dense and the edge thins out. Meadow
     away from a patch is left *empty*, which is what makes the patches read
     at all. Boulders only exist where a boulder makes sense: on a slope or
     at the foot of one. */
  const patches = [];
  const patchKinds = ['flowers', 'tufts', 'scree', 'reeds', 'pebbles', 'flowers'];
  for (let c = 0; c < 96; c++) {
    const a = rng() * TAU;
    const d = 30 + Math.sqrt(rng()) * 210;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = hfSample(hf, x, z);
    if (h < -0.4) continue;
    const slope = hfSlope(hf, x, z);
    /* Pick the patch that belongs to this ground. */
    let kind;
    if (h < 0.9) kind = 'reeds';
    else if (slope > 0.30) kind = 'scree';
    else if (h > 11) kind = 'scree';
    else kind = patchKinds[(rng() * (patchKinds.length - 1)) | 0];
    patches.push({
      x, z, kind, slope,
      r: 3.5 + rng() * 7.5,
      n: kind === 'scree' ? 14 + ((rng() * 22) | 0) : 10 + ((rng() * 18) | 0)
    });
  }
  for (const p of patches) {
    for (let i = 0; i < p.n; i++) {
      /* sqrt(rng) makes the density fall off toward the rim: dense middle. */
      const a = rng() * TAU, rr = Math.sqrt(rng()) * p.r;
      const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
      const h = hfSample(hf, x, z);
      if (h < -1.0) continue;
      if (rng() > 1 - rr / p.r * 0.55) continue;
      const t = rng();
      let type, scale;
      if (p.kind === 'flowers') { type = t < 0.72 ? 'flower' : 'tuft'; scale = 0.5 + rng() * 0.5; }
      else if (p.kind === 'tufts') { type = t < 0.8 ? 'tuft' : 'flower'; scale = 0.6 + rng() * 0.6; }
      else if (p.kind === 'reeds') { type = t < 0.85 ? 'reed' : 'tuft'; scale = 0.7 + rng() * 0.6; }
      else if (p.kind === 'scree') { type = t < 0.55 ? 'rock' : 'pebble'; scale = t < 0.55 ? 0.5 + rng() * 0.55 : 0.7 + rng() * 0.9; }
      else { type = t < 0.5 ? 'pebble' : 'tuft'; scale = 0.5 + rng() * 0.6; }
      decor.push({ type, x, z, y: h, scale, rot: rng() * TAU, tint: rng() });
    }
  }
  /* A thin skin of life down on the floodplain, where the ground is damp:
     scattered individually (a riverbank is the one place a sprinkle is
     correct) but still sparse. */
  for (let i = 0; i < 900; i++) {
    const x = rng() * 500 - 250, z = rng() * 500 - 250;
    const h = hfSample(hf, x, z);
    if (h < -0.2 || h > 1.6) continue;
    const r = rng();
    decor.push({
      type: r < 0.62 ? 'reed' : r < 0.88 ? 'tuft' : 'pebble',
      x, z, y: h, scale: 0.55 + rng() * 0.6, rot: rng() * TAU, tint: rng()
    });
  }

  /* Roads between the seats of every kingdom (a curving dirt path) — pushed
     into the splat map. Two seats produce exactly the one road this map has
     always had; four produce a web, which is what makes a war of four crowns
     read as one road network instead of four private corners. */
  const roadPts = [];
  {
    const pairs = [];
    for (let i = 0; i < SEATS.length; i++) for (let j = i + 1; j < SEATS.length; j++) pairs.push([SEATS[i], SEATS[j]]);
    for (const [a, b] of pairs) {
      const steps = 70;
      const seedA = (a.x + a.z) * 0.011;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bend = Math.sin(t * 5.4 + seedA) * 34 + Math.sin(t * 11.1 + 1.3) * 12;
        const x = lerp(a.x, b.x, t) + Math.cos(t * 3.1 + seedA) * bend * 0.55;
        const z = lerp(a.z, b.z, t) + Math.sin(t * 2.4) * bend * 0.4;
        if (hfSample(hf, x, z) < -0.3) continue;
        roadPts.push([x, z]);
      }
    }
    for (const [x, z] of roadPts) stampRoad(splat, hf, shape, x, z, 1);
  }

  /* A town is not dropped onto untouched meadow: it stands on ground that has
     been walked, carted over and cleared. A soft, noisy apron of trodden earth
     around each base does more for the scene than any amount of extra grass
     detail -- it tells the eye where the settlement ends. */
  for (const base of SEATS) {
    for (let i = 0; i < 130; i++) {
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * 17;
      const x = base.x + Math.cos(a) * d, z = base.z + Math.sin(a) * d;
      if (hfSample(hf, x, z) < -0.4) continue;
      const falloff = 1 - d / 19;
      stampRoad(splat, hf, shape, x, z, 0.45 + falloff * 0.45, 2.2 + rng() * 2.0);
    }
  }

  /* Village clutter. A base is a place where people live: a well, a cart with
     the hay still on it, firewood stacked by the door, barrels by the store.
     Placed on a ring outside the starting houses (9.5 m) and inside the tree
     line, and kept clear of resource nodes so nothing grows through a barrel. */
  const nearResource = (x, z, r) => {
    for (const res of resources) {
      if (res.x === undefined) continue;
      const dx = res.x - x, dz = res.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  for (const base of SEATS) {
    const face = Math.atan2(-base.x, -base.z);
    const put = (type, ang, rad, rot, scale = 1) => {
      const x = base.x + Math.sin(ang) * rad;
      const z = base.z + Math.cos(ang) * rad;
      const h = hfSample(hf, x, z);
      if (h < -0.5) return false;
      if (nearResource(x, z, 2.6)) return false;
      decor.push({ type, x, z, y: h, scale, rot, tint: rng() });
      return true;
    };
    // the well sits on the open side of the square
    put('well', face + 2.15, 6.9, face + 0.3);
    // carts and stores on the road side of the town
    put('cart', face + 0.35, 12.6, face + 1.5);
    put('cart', face + 3.5, 14.2, face + 4.4, 0.95);
    put('haystack', face + 3.05, 15.5, 0.0);
    put('haystack', face + 2.72, 13.4, 0.0, 0.85);
    put('haystack', face + 0.72, 16.6, 0.0, 1.05);
    // firewood by the houses, crates and barrels by the door
    for (let i = 0; i < 3; i++) {
      const a = face + 0.78 * Math.PI + i * 0.55;
      put('firewood', a - 0.10, 11.2, a + 0.6);
      put('crate', a + 0.09, 11.6, a + 1.2, 0.95);
      put('barrel', a - 0.17, 11.9, a + 0.2, 0.95);
      put('barrel', a + 0.02, 12.4, a + 1.1, 0.9);
    }
    put('crate', face + 5.3, 10.4, face + 2.0);
    put('crate', face + 5.45, 11.1, face + 2.6, 0.9);
    put('barrel', face + 5.2, 11.6, face + 1.0);
    put('fence', face + 4.1, 12.2, face + 2.3);
    put('fence', face + 1.55, 12.8, face + 4.0, 0.95);
    // broken fence runs: three fences along an arc read as one enclosure
    for (let run = 0; run < 3; run++) {
      const a0 = face + 0.9 + run * 2.0;
      const segs = 3 + (run % 2);
      for (let i = 0; i < segs; i++) {
        const a = a0 + i * 0.112;
        const rad = 17.4;
        const x = base.x + Math.sin(a) * rad, z = base.z + Math.cos(a) * rad;
        if (nearResource(x, z, 2.2)) continue;
        const h = hfSample(hf, x, z);
        if (h < -0.5) continue;
        decor.push({ type: 'fence', x, z, y: h, scale: 1, rot: a + Math.PI / 2, tint: rng() });
      }
    }
  }

  // POIs: neutral shrines for vision / favour
  const poi = [];
  for (let i = 0; i < 3; i++) {
    const a = rng() * TAU, d = 55 + rng() * 90;
    const x = clamp(Math.cos(a) * d, -210, 210), z = clamp(Math.sin(a) * d, -210, 210);
    if (hfSample(hf, x, z) < 0.4) continue;
    poi.push({ type: 'shrine', x, z, y: hfSample(hf, x, z), claimed: 0 });
  }

  /* ---- Hydrology-driven strategic features -------------------------
     Every one of these is a real node on the navigation grid, never a
     decorative prop dropped on a path. This is what replaces the old
     random wood chunks with purposeful macro-features. */
  const stealthForests = [];
  const sacredSites = [];
  const tradePosts = [];
  const bridges = [];
  if (hydro) {
    for (const f of hydro.stealthForests) {
      stealthForests.push({ ...f });
      /* Tall-canopy stealth forest: a dense but navigable stand. Units are
         marked for a future stealth system. */
      const count = Math.floor(f.radius * f.radius * 0.055) + 6;
      for (let i = 0; i < count; i++) {
        const a = rng() * TAU, d = Math.sqrt(rng()) * f.radius;
        const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
        const h = hfSample(hf, x, z);
        if (h < 0.4) continue;
        resources.push({ kind: 'wood', type: 'tree', resKind: 'wood', x, z, amount: 240,
          radius: 0.85, variant: (rng() * 4) | 0, scale: 1.1 + rng() * 0.35,
          y: h, stealth: f.id });
      }
    }
    for (const s of hydro.sacredSites) {
      sacredSites.push({ ...s });
      poi.push({ type: 'sacred', x: s.x, z: s.z, y: s.y, id: s.id, claimed: 0 });
    }
    for (const t of hydro.tradePosts) {
      tradePosts.push({ ...t });
      poi.push({ type: 'trade', x: t.x, z: t.z, y: t.y, id: t.id });
    }
    for (const f of hydro.shoreFish) {
      resources.push({ kind: 'food', type: 'fish', resKind: 'food', x: f.x, z: f.z,
        amount: f.amount, radius: 1.6, scale: 0.9, y: 0, shore: true });
    }
    for (const f of hydro.deepFish) {
      resources.push({ kind: 'food', type: 'fish', resKind: 'food', x: f.x, z: f.z,
        amount: f.amount, radius: 2.1, scale: 1.25, y: 0, deep: true });
    }
    for (const g of hydro.extraGold) {
      resources.push({ kind: 'gold', type: 'gold_mine', resKind: 'gold', x: g.x, z: g.z,
        amount: g.amount, radius: 1.25, scale: 1.15, y: g.y });
    }
    for (const p of hydro.palmGroves) {
      resources.push({ kind: 'wood', type: 'tree', resKind: 'wood', x: p.x, z: p.z,
        amount: 160, radius: 0.8, variant: 1, scale: 1.25, y: p.y, palm: true });
    }
    for (const b of hydro.bridges) {
      bridges.push({ ...b });
      /* Lay the deck. The generator has always produced these crossings --
         walkable, routed over, marked in the nav domain -- but nothing drew
         them, so men crossed the moat on an invisible bridge. The prop is
         modelled 26 m along its own local X, so it takes the crossing's
         angle directly. */
      decor.push({
        type: 'stone_bridge', x: b.x, z: b.z,
        y: Math.max(world_water_level_fallback(hydro, b), 0) + 0.05,
        rot: b.angle, scale: 1, tint: 0.5
      });
    }
    /* A stone ford is *paved*: the paving is stamped into the splat so the
       cobbles read on the ground as well as under the water. The stamp
       follows the shelf's own oval shape, so the paving stops where the
       shallow water stops instead of scattering over the bank. */
    for (const f of fords) {
      const cos = Math.cos(f.angle || 0), sin = Math.sin(f.angle || 0);
      for (let i = 0; i < 46; i++) {
        const u = (rng() * 2 - 1) * f.radius * 0.66;
        const v = (rng() * 2 - 1) * f.radius;
        if (u * u / (f.radius * 0.66) ** 2 + v * v / (f.radius * f.radius) > 1) continue;
        const x = f.x + cos * u - sin * v;
        const z = f.z + sin * u + cos * v;
        stampRoad(splat, hf, shape, x, z, 0.85, 1.3);
      }
    }
    /* Reed beds at the waterline and gravel bars in the channel. These are the
       two features that make a bank read as a riverbank from an RTS camera,
       and both are pure decoration: instanced, non-blocking, never on a path. */
    for (const r of hydro.reedBeds) decor.push({ type: 'reed', x: r.x, z: r.z, y: r.y, scale: r.scale, rot: r.rot, tint: rng() });
    for (const g of hydro.gravelBars) decor.push({ type: 'pebble', x: g.x, z: g.z, y: g.y, scale: g.scale * 1.6, rot: g.rot, tint: rng() });
    /* Keep the hydrology heightfield in step with the flattened base
       plateaus, so the live brush editor edits the heights actually used. */
    hydro.heights.set(hf.h);
  }

  /* ---- the reward on the crowns
     A climb that leads to a viewpoint is a walk. A climb that leads to the
     richest ground on the map is a decision: is it worth the villagers and the
     escort it takes to hold the top? So every crown carries a motherlode --
     gold, stone, and a stand of timber that no valley site offers -- set out in
     a ring wide enough to be worked by a dozen men at once, and dense enough
     that a single mine is not the whole prize. The quantities are deliberately
     above the contested centre of the map: if the summit were merely equal to
     easier ground, the climb would never be worth making.

     Nothing is placed dead-centre: the crown is where the player wants to put
     the camp that works the mountain, and a resource on the exact spot gives
     them nowhere to stand. */
  for (const climb of climbs) {
    const ground = (x, z) => hfSample(hf, x, z);
    const onCrown = (x, z) => {
      const h = ground(x, z);
      return h > climb.h * 0.72 && hfSlope(hf, x, z) < 0.42;
    };
    const ring = (count, radius, jitter) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + climb.angle;
        const r = radius + rng() * jitter;
        const x = climb.x + Math.cos(a) * r, z = climb.z + Math.sin(a) * r;
        if (onCrown(x, z)) out.push({ x, z, y: ground(x, z) });
      }
      /* Top up on the crown's own plateau when the ring falls away down the
         mountain: a summit with three mines and four empty slots is a promise
         the map does not keep. */
      for (let i = 0; out.length < count && i < count * 6; i++) {
        const a = rng() * TAU, r = 2 + rng() * (radius - 1);
        const x = climb.x + Math.cos(a) * r, z = climb.z + Math.sin(a) * r;
        if (!onCrown(x, z)) continue;
        if (out.some((q) => Math.hypot(q.x - x, q.z - z) < 3.0)) continue;
        out.push({ x, z, y: ground(x, z) });
      }
      return out;
    };
    /* Gold: the reason to come. */
    for (const s of ring(5, 8.5, 4)) {
      resources.push({ kind: 'gold', type: 'gold_mine', resKind: 'gold',
        x: s.x, z: s.z, amount: 2100, radius: 1.3, scale: 1.15 + rng() * 0.25, y: s.y, summit: true });
    }
    /* Stone: what the gold is defended with. */
    for (const s of ring(4, 6.5, 3)) {
      resources.push({ kind: 'stone', type: 'stone_mine', resKind: 'stone',
        x: s.x, z: s.z, amount: 1600, radius: 1.2, scale: 1.1 + rng() * 0.2, y: s.y, summit: true });
    }
    /* Timber: the one thing a summit is usually assumed not to have, which is
       the whole reason a village up here can raise its own buildings. */
    for (const s of ring(7, 11, 5)) {
      resources.push({ kind: 'wood', type: 'tree', resKind: 'wood',
        x: s.x, z: s.z, amount: 300, radius: 0.85, variant: (rng() * 4) | 0,
        scale: 1.05 + rng() * 0.3, y: s.y, summit: true });
    }
    /* Forage, so a working camp is not a supply line. */
    for (const s of ring(4, 4.5, 3)) {
      resources.push({ kind: 'food', type: 'berry_bush', resKind: 'food',
        x: s.x, z: s.z, amount: 420, radius: 1.0, scale: 1.0 + rng() * 0.2, y: s.y, summit: true });
    }
  }

  // Walkability: block cells covered by large props
  for (const r of resources) {
    if (r.type === 'fish' || r.type === 'relic') continue;
    const s = r.radius * r.scale;
    stampDisc(props, hf, shape, r.x, r.z, Math.max(0.6, s * 0.8), 1);
  }

  const world = {
    seed, style,
    mapType: mapInfo.id,
    mapName: mapInfo.name,
    w: shape, size, half: size * 0.5,
    height: hf,
    hydrology: hydro,
    /* The navigation domain and the water shader's field. Every map has both. */
    domain: hydro.domain,
    domainCells: hydro.domainCells,
    domainCell: hydro.domainCell,
    domainAt: hydro.domainAt,
    flowTex: hydro.flowTex,
    waterDepth: hydro.waterDepth,
    waterLevel: hydro.waterLevel,
    shallowBed: hydro.shallowBed,
    stealthForests, sacredSites, tradePosts, bridges,
    rivers: hydro.rivers,
    isNaval: hydro.isNaval,
    splat, water, walk, props, biome,
    resources, decor, roads: roadPts, poi, fords,
    /* the land routes at the map corners: the river is not the only way */
    corridors: hydro.corridors || [],
    /* graded ramps into the high ground: real terrain, not a permission */
    climbs,
    playerBase, enemyBase,
    bases: SEATS,
    nav: null,
    fow: null
  };
  world.nav = buildNavGrid(world);
  world.heightAt = (x, z) => hf.sample(x, z);
  /* The bed map the water shader reads for depth. The 128-cell heightfield is
     4 m per vertex, and a river's bank falls a metre over roughly two metres
     of ground: sampled straight, the shoreline comes out as a stair-stepped
     contour and the "shallow" ring around it is several metres wide, which at
     a close camera is the pale glow the eye reads as a painted outline. One
     metre per texel, from the same interpolated surface the gameplay uses,
     puts the waterline where the terrain actually meets the water. */
  world.bedTex = bakeBedTex(hf, shape.bakeTex);
  /* Cosmetic height lookup: smooth contours, used only by the bake (sand band)
     and the water shader (via bedTex). Gameplay keeps hf.sample. */
  world.heightSmooth = (x, z) => sampleSmooth(hf, x, z);
  world.domainAtOrDefault = (x, z) => world.domainAt(x, z);
  return world;
}

/**
 * One-metre bed heights for the water shader, as a single-channel texture.
 * R = (height + 8) / 46, the same encoding as the renderer's height map, so
 * the shader needs no new uniform and the two agree exactly.
 */
export function bakeBedTex(hf, size = 512) {
  const out = new Uint8Array(size * size);
  const half = hf.size * 0.5;
  const step = hf.size / size;
  const res = hf.res, r = res + 1, cell = hf.cell, H = hf.h;
  /* Catmull-Rom, not bilinear. Bilinear interpolation of a coarse grid has
     straight contours inside every cell that meet at a kink on every cell
     edge -- so any threshold of it (a waterline, a beach band, a depth ramp)
     is drawn as a staircase of 4 m steps, however fine the output texture is.
     That staircase is what a riverbank looked like. Catmull-Rom is C1, so the
     contours curve, and the bank wanders the way the height field says it
     should. Clamped at the border. */
  for (let j = 0; j < size; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < size; i++) {
      const x = -half + (i + 0.5) * step;
      const h = sampleSmooth(hf, x, z);
      out[j * size + i] = clamp(Math.round(((h + 8) / 46) * 255), 0, 255);
    }
  }
  return { data: out, size };
}

/**
 * Catmull-Rom sample of a height field, in world metres.
 *
 * Bilinear interpolation of a coarse grid is piecewise-straight inside every
 * cell and kinks on every cell edge, so any *threshold* of it -- a waterline,
 * a beach band, a depth ramp -- comes out as a staircase of 4 m steps however
 * finely it is resampled. Everything cosmetic that draws a contour of height
 * (the water edge, the sand band, the wet line) reads this instead, and the
 * bank wanders the way the height field says it should. Gameplay keeps
 * `hf.sample`: the collision surface is the mesh, and the mesh is the grid.
 */
export function sampleSmooth(hf, wx, wz) {
  const res = hf.res, r = res + 1, H = hf.h;
  const fx = clamp((wx + hf.size * 0.5) / hf.cell, 0, res - 0.0001);
  const fz = clamp((wz + hf.size * 0.5) / hf.cell, 0, res - 0.0001);
  const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
  const t2 = tz * tz, t3 = t2 * tz;
  const wz0 = -0.5 * t3 + t2 - 0.5 * tz;
  const wz1 = 1.5 * t3 - 2.5 * t2 + 1;
  const wz2 = -1.5 * t3 + 2 * t2 + 0.5 * tz;
  const wz3 = 0.5 * t3 - 0.5 * t2;
  const u2 = tx * tx, u3 = u2 * tx;
  const wx0 = -0.5 * u3 + u2 - 0.5 * tx;
  const wx1 = 1.5 * u3 - 2.5 * u2 + 1;
  const wx2 = -1.5 * u3 + 2 * u2 + 0.5 * tx;
  const wx3 = 0.5 * u3 - 0.5 * u2;
  let h = 0;
  for (let m = 0; m < 4; m++) {
    const wz = m === 0 ? wz0 : m === 1 ? wz1 : m === 2 ? wz2 : wz3;
    if (wz === 0) continue;
    const gz = clamp(z0 + m - 1, 0, res) * r;
    const gx = clamp(x0 - 1, 0, res);
    const row = H[gz + gx] * wx0 + H[gz + clamp(x0, 0, res)] * wx1
              + H[gz + clamp(x0 + 1, 0, res)] * wx2 + H[gz + clamp(x0 + 2, 0, res)] * wx3;
    h += wz * row;
  }
  return h;
}

/**
 * Convert the sim's compact terrain description into the wide vertex data the
 * renderer streams: per-cell blend weights for the six painted materials plus
 * a cached height/normal grid. Called once per match, never per frame.
 */
export function buildRenderTerrain(world) {
  const hf = world.height;
  const n = hf.res + 1;
  const cell = hf.cell;
  const heights = hf.h;
  const splat = world.splat;
  const s4 = new Float32Array(n * n * 4);   // grass, dirt, rock, sand
  const s2 = new Float32Array(n * n * 2);   // cobble/road, snow
  /* Snow is relative to this map's own relief. A fixed height threshold
     painted every flat-topped plateau white -- Highview is a plateau at 25 m,
     so its whole interior came out as a cream field seen from the camera.
     Snow belongs to the peaks, wherever the peaks happen to be. */
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < hMin) hMin = v;
    if (v > hMax) hMax = v;
  }
  /* The top of *this* map is the only place snow can live: 4 m below the
     summit, whatever that summit happens to be. A fixed altitude can never
     be right on both a 24 m plateau and a 40 m alpine map. */
  const snowStart = hMax - Math.max(4.5, (hMax - hMin) * 0.10);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const layer = splat[k * 2];
      const blend = splat[k * 2 + 1] / 255;
      const wx = i * cell - hf.size * 0.5;
      const wz = j * cell - hf.size * 0.5;
      const h = heights[k];
      const slope = hf.slope(wx, wz);
      let grass = 1 - blend;
      let dirt = 0, rock = 0, sand = 0, cobble = 0, snow = 0;
      switch (layer) {
        case TERRAIN_LAYER.DRY_GRASS: grass = 1; break;
        case TERRAIN_LAYER.DIRT: dirt = blend; grass = 1 - blend; break;
        case TERRAIN_LAYER.ROCK: rock = blend; grass = 1 - blend * 0.85; break;
        case TERRAIN_LAYER.SAND: sand = blend; grass = 1 - blend; break;
        case TERRAIN_LAYER.MUD: dirt = blend * 0.9; grass = 1 - blend; break;
        case TERRAIN_LAYER.SNOW: snow = blend; grass = 1 - blend; break;
        case TERRAIN_LAYER.GRAVEL: cobble = blend; grass = 1 - blend; break;
        default: break;
      }
      // cliffs always show rock, beaches always show sand, peaks show snow
      if (slope > 0.42) rock += Math.min(0.85, (slope - 0.42) * 2.2);
      /* A beach, not a desert. The old rule said "any dry ground under 1.1 m
         is sand", and every riverside floodplain in the game sits between
         0.9 and 1.0 m, so whole valleys were painted as dune. Sand now
         belongs to a narrow strip just above the water line. */
      if (!world.water[k] && h > WATER_LEVEL - 0.06 && h < WATER_LEVEL + 0.55) {
        const t = 1 - (h - WATER_LEVEL) / 0.61;
        sand += Math.min(0.85, t * 0.9);
        grass *= 0.55;
      }
      /* Peaks only. Height alone is not enough: Highview is a plateau, so
         its whole flat top is "high" and a height threshold painted the
         entire interior white. A snowcap needs local prominence -- ground
         that stands up out of the land around it -- so the test is against
         a ring 40 m out. A plateau top has zero prominence and stays green;
         a real summit does not. */
      if (h > snowStart) {
        /* Height alone is not enough. Highview is one big plateau: its whole
           flat top is the highest ground on the map, so a height threshold
           painted the entire interior white and the player spent the match
           looking at a cream field. Snow needs the land to *fall away in
           every direction* -- the point must stand above the whole 40 m ring,
           not just above its average. A mesa top cannot pass that test; a
           summit can. */
        let ringMax = -Infinity;
        for (let a = 0; a < 8; a++) {
          const ang = a * (Math.PI / 4);
          const rh = hf.sample(wx + Math.cos(ang) * 40, wz + Math.sin(ang) * 40);
          if (rh > ringMax) ringMax = rh;
        }
        const prominence = h - ringMax;
        if (prominence > 1.6) {
          const cap = Math.min(0.80, (prominence - 1.2) / 5.5) * Math.min(1, (h - snowStart) / 5 + 0.35);
          snow += cap * (0.45 + 0.55 * Math.min(1, slope * 2.2));
          grass *= 1 - cap * 0.65;
        }
      }
      const sum = grass + dirt + rock + sand + cobble + snow || 1;
      const o4 = k * 4, o2 = k * 2;
      s4[o4] = grass / sum; s4[o4 + 1] = dirt / sum;
      s4[o4 + 2] = rock / sum; s4[o4 + 3] = sand / sum;
      s2[o2] = cobble / sum; s2[o2 + 1] = snow / sum;
    }
  }
  return { n, cell, heights, splat4: s4, splat2: s2, size: hf.size };
}

/* A bridge deck is at the water surface by definition: piers go down to the
   bed, the deck stays just above the line the boats float on. */
function world_water_level_fallback(hydro, b) {
  return Number.isFinite(hydro.waterLevel) ? hydro.waterLevel : (b.deck ? b.deck - 2.1 : 0);
}

function stampDisc(grid, hf, w, wx, wz, radius, value) {
  const res = w.segments;
  const n = res + 1;
  const cell = w.cell;
  const cx0 = Math.floor((wx - radius + w.half) / cell);
  const cx1 = Math.ceil((wx + radius + w.half) / cell);
  const cz0 = Math.floor((wz - radius + w.half) / cell);
  const cz1 = Math.ceil((wz + radius + w.half) / cell);
  for (let z = Math.max(0, cz0); z <= Math.min(res, cz1); z++) {
    for (let x = Math.max(0, cx0); x <= Math.min(res, cx1); x++) {
      const px = (x / res) * w.size - w.half;
      const pz = (z / res) * w.size - w.half;
      if (dist2(px, pz, wx, wz) <= radius * radius) grid[z * n + x] = value;
    }
  }
}

function stampRoad(splat, hf, w, wx, wz, strength, radius = 2.6) {
  const res = w.segments;
  const n = res + 1;
  const cell = w.cell;
  const cx0 = Math.floor((wx - radius + w.half) / cell);
  const cx1 = Math.ceil((wx + radius + w.half) / cell);
  const cz0 = Math.floor((wz - radius + w.half) / cell);
  const cz1 = Math.ceil((wz + radius + w.half) / cell);
  for (let z = Math.max(0, cz0); z <= Math.min(res, cz1); z++) {
    for (let x = Math.max(0, cx0); x <= Math.min(res, cx1); x++) {
      const px = (x / res) * w.size - w.half;
      const pz = (z / res) * w.size - w.half;
      const d = Math.sqrt(dist2(px, pz, wx, wz));
      if (d > radius) continue;
      const i = z * n + x;
      if (hf.h[i] < -0.4) continue;
      /* The splat byte is the weight of the *listed* layer, so laying down
         dirt means raising it, not lowering it. (Lowering it was why the
         base-to-base road was invisible: the cells were tagged as dirt with
         almost no dirt in them.) */
      const k = smoothstep(1 - d / radius) * strength;
      const b = splat[i * 2];
      const wt = k;
      if (wt <= 0.02) continue;
      const prev = splat[i * 2 + 1];
      if (b !== TERRAIN_LAYER.DIRT) {
        splat[i * 2] = TERRAIN_LAYER.DIRT;
        splat[i * 2 + 1] = Math.min(255, Math.round(wt * 240)) | 0;
      } else {
        splat[i * 2 + 1] = Math.max(prev, Math.min(255, Math.round(wt * 240))) | 0;
      }
    }
  }
}

function smoothField(hf, passes) {
  const n = hf.res + 1;
  const tmp = new Float32Array(hf.h.length);
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        let sum = 0, count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= n) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= n) continue;
            sum += hf.h[zz * n + xx];
            count++;
          }
        }
        tmp[z * n + x] = sum / count;
      }
    }
    hf.h.set(tmp);
  }
}

/**
 * Level a town's building apron.
 *
 * `res` (the terrain grid) is 4 m, so the old version walked all 16641
 * vertices for every seat. This one walks only the apron's bounding box.
 * `allow` is the guard that keeps a plateau from silting up a river: a vertex
 * whose channel would be damaged is left exactly as the carve left it.
 */
/**
 * Cut a walkable climb into the face of every substantial summit.
 *
 * The map is covered in high ground that nothing can reach: a cliff is a
 * BLOCKED domain cell, the domain grid says so, and the pathfinder believes
 * it. That is correct -- a cliff *is* impassable -- but it left the most
 * dramatic terrain on the map as scenery with gold behind it.
 *
 * Rather than punch a hole in the domain (which would let men walk up a
 * vertical face and would lie to every system that reads the grid), the
 * terrain itself is graded: a ramp is cut from the summit down to the plain,
 * at a gradient a man can climb, following the shortest line that is not
 * already water. After the height field changes, the caller recomputes the
 * domain from the new heights, so the ramp becomes ordinary walkable ground
 * and the cliff either side of it stays solid. Nothing downstream needs to
 * know a climb exists.
 *
 * Returns the ramp foot and crown of each climb, so the caller can put the
 * rich ground -- and the wildlife -- where the ramp arrives.
 */
function carveMountainClimbs(hf, hydro, size, rng, verify) {
  const n = hf.res + 1;
  const cell = hf.cell;
  const half = size * 0.5;
  const out = [];
  /* A summit has to be worth climbing: high enough to be a mountain, and wide
     enough at the top that there is somewhere to put a mine. The relief is
     measured from this map's own heights, not from a constant, because a
     24 m plateau and a 45 m peak are both "high ground" on their own map. */
  let peak = -1e9;
  for (let i = 0; i < hf.h.length; i++) if (hf.h[i] > peak) peak = hf.h[i];
  if (peak < 12) return out;
  const topMin = Math.max(9, peak * 0.55);
  /* candidate summits on a coarse lattice, then a local maximum each */
  const stride = Math.max(2, Math.round(24 / cell));
  const seen = [];
  for (let z = stride; z < n - stride; z += stride) {
    for (let x = stride; x < n - stride; x += stride) {
      const i = z * n + x;
      const h = hf.h[i];
      if (h < topMin) continue;
      /* local maximum: nothing taller within one stride, so a summit yields
         one climb rather than a ring of them */
      let best = true;
      for (let dz = -stride; dz <= stride && best; dz += Math.max(1, stride >> 1)) {
        for (let dx = -stride; dx <= stride && best; dx += Math.max(1, stride >> 1)) {
          const j = (z + dz) * n + (x + dx);
          if (j !== i && hf.h[j] > h + 0.6) best = false;
        }
      }
      if (!best) continue;
      const wx = (x / hf.res) * size - half;
      const wz = (z / hf.res) * size - half;
      if (seen.some((q) => Math.hypot(q.x - wx, q.z - wz) < 120)) continue;
      /* not in the sea, and not on somebody's town */
      if (hydro.domainAt && hydro.domainAt(wx, wz) === DOMAIN.WATER_ONLY) continue;
      if ((hydro.seats || []).some((s) => Math.hypot(s.x - wx, s.z - wz) < 46)) continue;
      /* A summit on the border has no room for a ramp: the cut either runs off
         the map or is silently truncated to a doorstep by the edge clamp, and
         both leave a mountain that looks climbable from above and is not. */
      if (Math.abs(wx) > half - 70 || Math.abs(wz) > half - 70) continue;
      seen.push({ x: wx, z: wz, h, i, gx: x, gz: z });
    }
  }
  /* the nearest four summits to the middle: enough to be a landmark on every
     side of the map without turning the whole country into switchbacks */
  seen.sort((a, b) => (Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)) || (b.h - a.h));
  /* Four climbs, from the *best four summits that actually yield one*. Not the
     best four summits and then however many survive: a summit can refuse a cut
     (ringed by sea, too sheer, on the border) and a cut can refuse the walk
     (the ramp lands on a shoulder and stops), so the list is worked in order
     until four real climbs exist. A map with three mountains and one of them
     unscalable is worse than a map with four that can all be taken. */
  for (const summit of seen) {
    if (out.length >= 4) break;
    const climb = cutOneClimb(hf, summit, size, rng);
    if (!climb) continue;
    /* The cut is only real if it can be walked. Ask, then keep or drop. */
    if (verify && !verify(climb)) continue;
    out.push(climb);
  }
  return out;
}

/**
 * Does this ramp actually connect, judged before the grid is recompiled?
 *
 * The domain compiler marks a nav cell BLOCKED when the ground under its centre
 * is steeper than 1.05 and WATER_ONLY when it is deep, so the same test can be
 * run straight off the height field over the corridor alone. Doing it here, at
 * cut time, is what lets a bad cut be replaced by the next summit instead of
 * being discovered after the fact when the summit list has already been spent.
 */
function climbWalks(hf, hydro, climb) {
  const N = hydro.domainCells, navCell = hydro.domainCell, half = hydro.half;
  const walks = (wx, wz) => {
    const h = hf.sample(wx, wz);
    if (h < -0.55) return false;
    return hf.slope(wx, wz) <= 1.05;
  };
  const cellOf = (x, z) => [
    clamp(Math.floor((x + half) / navCell), 0, N - 1),
    clamp(Math.floor((z + half) / navCell), 0, N - 1)
  ];
  const [fi, fj] = cellOf(climb.foot.x, climb.foot.z);
  const [gi, gj] = cellOf(climb.x, climb.z);
  /* A route that has to wander more than eighty metres beyond the two ends is
     not this ramp -- it is the rest of the map. */
  const pad = Math.ceil(80 / navCell);
  const i0 = Math.max(0, Math.min(fi, gi) - pad), i1 = Math.min(N - 1, Math.max(fi, gi) + pad);
  const j0 = Math.max(0, Math.min(fj, gj) - pad), j1 = Math.min(N - 1, Math.max(fj, gj) + pad);
  const seen = new Set();
  const key = (i, j) => j * N + i;
  const queue = [[fi, fj]];
  seen.add(key(fi, fj));
  if (!walks((fi + 0.5) * navCell - half, (fj + 0.5) * navCell - half)) return false;
  for (let head = 0; head < queue.length; head++) {
    const [i, j] = queue[head];
    if (i === gi && j === gj) return true;
    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
      const k = key(ni, nj);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!walks((ni + 0.5) * navCell - half, (nj + 0.5) * navCell - half)) continue;
      queue.push([ni, nj]);
    }
  }
  return false;
}

/**
 * One ramp, from a summit down to the first ground that is already walkable.
 *
 * The ramp descends at a constant gradient in whichever direction reaches low
 * ground soonest, with a switchback when the direct line would need a face
 * steeper than a man can climb. Everything is graded through the height field,
 * which is what makes it real terrain rather than a permission.
 */
function cutOneClimb(hf, summit, size, rng) {
  const n = hf.res + 1;
  const cell = hf.cell;
  const half = size * 0.5;
  /* A man climbs at about 40 degrees; the nav grid refuses anything above
     roughly 0.95 of slope, so the ramp is graded to stay well inside that. */
  const GRAD = 0.42;
  /* Wide enough that the *blended* edges stay walkable. A ramp graded 4.5 m
     wide leaves a transition band on each side whose gradient is whatever the
     original cliff was, and a single cell of that band is a wall: the first
     cut climb had a full-height crown sitting four metres from its own ramp
     head with one BLOCKED cell between them, which is a mountain that looks
     climbable and is not. Nine metres of shoulder, and a two-stage blend at
     the crown, keeps the whole strip under the nav grid's slope limit. */
  const WIDTH = 9;
  let best = null;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + rng() * 0.05;
    const dx = Math.cos(a), dz = Math.sin(a);
    /* how far to go before the ground is low enough to be ordinary? */
    let len = 0, ok = true, stepped = null;
    for (let d = 4; d < 170 && ok; d += 2) {
      const px = summit.x + dx * d, pz = summit.z + dz * d;
      if (Math.abs(px) > half - 8 || Math.abs(pz) > half - 8) { ok = false; break; }
      const h = hf.sample(px, pz);
      len = d;
      /* The foot is not merely "low ground" -- it is *gentle* ground. Stopping
         at the first sample under a third of the summit height put the foot on
         the talus, which is steep but not high: three BLOCKED cells sat
         between the bottom of the ramp and the only approach to it, so the
         mountain had a staircase with no doorstep. Keep walking until the
         ground under the point is a slope a man can already stand on. */
      /* ...and keep going to the *plain*, not to the first shelf. A shoulder a
         third of the way down can be gentle in itself and still be ringed by
         cliff, which is a ramp onto a ledge. The foot has to be ground that is
         low in absolute terms and gentle in its own right, or the climb ends
         somewhere a man cannot leave. */
      if (h < 1.8 && hf.slope(px, pz) < 0.55) { stepped = d; break; }
      if (h < -0.2) { ok = false; break; }          // ran into the sea
    }
    /* A ten-metre ramp off a thirty-metre summit is not a climb, it is a
       doorstep into thin air: the foot lands on the shoulder of the mountain
       with the same steep ground below it, and the crown stays unreachable
       with a very convincing path drawn most of the way up. A real climb needs
       enough run to shed the height. */
    if (!ok || !stepped || stepped < 18) continue;
    /* the run must not already contain a channel: a ramp through a river is a
       bridge, and that is a different section */
    if (!best || len < best.len) best = { a, dx, dz, len, stepped };
  }
  if (!best) return null;
  /* grade the ramp: a strip of width WIDTH, each sample lowered to the line
     from the crown to the foot */
  const footH = hf.sample(summit.x + best.dx * best.stepped, summit.z + best.dz * best.stepped);
  for (let d = 0; d <= best.stepped; d += 0.75) {
    const t = d / best.stepped;
    const target = summit.h + (footH - summit.h) * t;
    const px = summit.x + best.dx * d, pz = summit.z + best.dz * d;
    /* across the ramp */
    for (let w = -WIDTH; w <= WIDTH; w += 0.75) {
      const sx = px - best.dz * w, sz = pz + best.dx * w;
      if (Math.abs(sx) > half - 4 || Math.abs(sz) > half - 4) continue;
      const fall = 1 - smoothstep(Math.abs(w) / (WIDTH + 1.6));
      gradeHeight(hf, sx, sz, target, fall);
    }
  }
  /* Flatten a crown at the top, so there is somewhere to stand, build and be
     attacked -- and blend it out over a wider ring than the ramp so the
     shoulder where the two meet is a slope rather than a step. */
  for (let w = -12; w <= 12; w += 0.9) {
    for (let q = -12; q <= 12; q += 0.9) {
      const r = Math.hypot(w, q);
      if (r > 12) continue;
      const fall = 1 - smoothstep(r / 13);
      gradeHeight(hf, summit.x + w, summit.z + q, summit.h, fall);
    }
  }
  /* ...and once more along the ramp, now that the crown has settled, so the
     junction is graded rather than left as the original face */
  for (let d = 0; d <= best.stepped; d += 0.75) {
    const t = d / best.stepped;
    const target = summit.h + (footH - summit.h) * t;
    const px = summit.x + best.dx * d, pz = summit.z + best.dz * d;
    for (let w = -WIDTH; w <= WIDTH; w += 0.75) {
      const sx = px - best.dz * w, sz = pz + best.dx * w;
      if (Math.abs(sx) > half - 4 || Math.abs(sz) > half - 4) continue;
      const fall = 1 - smoothstep(Math.abs(w) / (WIDTH + 1.6));
      gradeHeight(hf, sx, sz, target, fall);
    }
  }
  return {
    x: summit.x, z: summit.z, h: summit.h,
    foot: { x: summit.x + best.dx * best.stepped, z: summit.z + best.dz * best.stepped, h: footH },
    angle: best.a, length: best.stepped
  };
}

/** Pull one terrain sample towards a height, by a 0..1 weight. */
function gradeHeight(hf, wx, wz, target, weight) {
  const n = hf.res + 1;
  const half = hf.size * 0.5;
  const gx = Math.round((wx + half) / hf.cell);
  const gz = Math.round((wz + half) / hf.cell);
  if (gx < 1 || gz < 1 || gx > hf.res - 1 || gz > hf.res - 1) return;
  const i = gz * n + gx;
  hf.h[i] = lerp(hf.h[i], target, weight * 0.92);
}

function flattenPlateau(hf, wx, wz, radius, targetH, allow = null) {
  const n = hf.res + 1;
  const cell = hf.cell;
  const reach = radius * 1.6;
  const x0 = Math.max(0, Math.floor((wx - reach + hf.size * 0.5) / cell));
  const x1 = Math.min(hf.res, Math.ceil((wx + reach + hf.size * 0.5) / cell));
  const z0 = Math.max(0, Math.floor((wz - reach + hf.size * 0.5) / cell));
  const z1 = Math.min(hf.res, Math.ceil((wz + reach + hf.size * 0.5) / cell));
  for (let z = z0; z <= z1; z++) {
    const pz = (z / hf.res) * hf.size - hf.size * 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = (x / hf.res) * hf.size - hf.size * 0.5;
      const d = Math.hypot(px - wx, pz - wz);
      if (d > reach) continue;
      if (allow && !allow(px, pz)) continue;
      const t = 1 - smoothstep((d - radius * 0.55) / (radius * 1.05));
      hf.h[z * n + x] = lerp(hf.h[z * n + x], targetH, t * 0.94);
    }
  }
}

function findBaseSite(hf, walk, hx, hz, rng, avoid) {
  let best = { x: hx, z: hz, h: 0, score: -1e9 };
  for (let i = 0; i < 90; i++) {
    const a = rng() * TAU, d = rng() * 42;
    const x = hx + Math.cos(a) * d;
    const z = hz + Math.sin(a) * d;
    const h = hf.sample(x, z);
    const slope = hf.slope(x, z);
    if (h < 0.6) continue;
    /* two kingdoms must not be able to see each other's town centre from
       their own: a site closer than 90 m to an existing seat is rejected */
    if (avoid && avoid.some((b) => (b.x - x) ** 2 + (b.z - z) ** 2 < 90 * 90)) continue;
    // prefer flat, high, central-ish ground away from the rim
    const score = h * 0.6 - slope * 22 - Math.max(0, 190 - Math.hypot(x, z)) * 0.02 - d * 0.02;
    if (score > best.score) best = { x, z, h, score };
  }
  if (best.score < -1e8) best = { x: hx, z: hz, h: 2 };
  return best;
}

/**
 * Navigation grid: 128x128 cells, blocked where the terrain is
 * impassable or occupied by a large prop.
 */
export function buildNavGrid(world) {
  const w = world.w || WORLD;
  const N = w.navCells;
  const cell = w.navCell;
  const blocked = new Uint8Array(N * N);
  /* `steep` is the same sample against the movement code's own, looser
     threshold: it lets `isPassable`, which is asked for every man on every
     step, answer "is this a cliff?" with one array read instead of four
     bilinear height samples. Terrain never changes, so it is baked once,
     here, out of exactly the numbers the nav grid is already paying for. */
  const steep = new Uint8Array(N * N);
  /* Keep domain metadata alongside the current land navigation grid.
     Naval pathfinding does not yet consume this grid. */
  const domain = new Uint8Array(N * N);
  /* `naval` is the fleet's own grid: water and fords are open, land is not.
     It is baked from the same domain array the land grid reads, so a hull and
     a spearman can never disagree about where the river is. */
  const naval = new Uint8Array(N * N);
  const hydro = world.hydrology;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const wx = (x + 0.5) * cell - w.half;
      const wz = (z + 0.5) * cell - w.half;
      const slope = world.height.slope(wx, wz);
      const d = hydro.domainAt(wx, wz);
      domain[z * N + x] = d;
      /* Land A* blocked: deep water, cliffs, and (later) buildings. Fords
         and beaches are amphibious and therefore NOT blocked for land. */
      blocked[z * N + x] = (d === DOMAIN.WATER_ONLY || d === DOMAIN.BLOCKED || slope > 0.72) ? 1 : 0;
      steep[z * N + x] = slope > 0.95 ? 1 : 0;
      /* Ships float on deep water and across fords, never over dry land. */
      naval[z * N + x] = (d === DOMAIN.WATER_ONLY || d === DOMAIN.AMPHIBIOUS_SHALLO_FORD) ? 0 : 1;
    }
  }
  return { cells: N, cell, blocked, steep, domain, naval,
    isWaterCell: (x, z) => {
      const cx = clamp(((x + w.half) / cell) | 0, 0, N - 1);
      const cz = clamp(((z + w.half) / cell) | 0, 0, N - 1);
      return domain[cz * N + cx] === DOMAIN.WATER_ONLY;
    },
    domainAt: (x, z) => {
      const cx = clamp(((x + w.half) / cell) | 0, 0, N - 1);
      const cz = clamp(((z + w.half) / cell) | 0, 0, N - 1);
      return domain[cz * N + cx];
    }
  };
}
