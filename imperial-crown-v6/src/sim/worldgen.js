/* ============================================================
   worldgen.js — deterministic terrain, biomes, forests & camps
   The whole match lives in a 512 x 512 metre square. Height is
   baked once into a Float32Array and sampled analytically after
   that, so nothing in the frame loop touches noise functions.
   ============================================================ */
import { clamp, lerp, smoothstep, fbm2, ridged2, noise2, mulberry32, rngFor, dist2, TAU } from '../core/math.js';
import { buildHydrology, refreshHydrology, DOMAIN, WATER_LEVEL } from './hydrology.js';

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
  const res = WORLD.segments;
  const size = WORLD.size;
  const hf = new HeightField(res, size);
  /* Every map is a hydrological map now. `classic` is still accepted so that
     an old save reloads, and each classic save gets its own historic map for
     free -- the segmenter below rebuilds the island it was played on. */
  const sites = Math.max(2, Math.min(4, (opts && opts.sites) | 0 || 2));
  const requested = opts.mapType || 'confluence';
  const mapType = requested === 'classic' ? 'confluence' : requested;
  const hydro = buildHydrology(seed, mapType, { res, size, navCells: WORLD.navCells, seats: sites });
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

  // Forests: dense clumps of trees
  const forestClusters = 26;
  for (let c = 0; c < forestClusters; c++) {
    const cx = rng() * 440 - 220;
    const cz = rng() * 440 - 220;
    if (hfSample(hf, cx, cz) < 0.3) continue;
    if (nearBase(cx, cz, 34)) continue;
    const rad = 9 + rng() * 17;
    const count = Math.floor(rad * rad * 0.11 * styleParams.trees + 4);
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * rad;
      const x = clamp(cx + Math.cos(a) * d, -248, 248);
      const z = clamp(cz + Math.sin(a) * d, -248, 248);
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
      stampRoad(splat, hf, x, z, 0.35 + 0.4 * (1 - d / 26), 2.0);
    }
  }

  // Scattered distant gold/stone
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU, d = 70 + rng() * 160;
    const x = clamp(Math.cos(a) * d, -240, 240), z = clamp(Math.sin(a) * d, -240, 240);
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
  for (let i = 0; i < 40; i++) {
    const a = rng() * TAU, d = 12 + Math.sqrt(rng()) * 200;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (hfSample(hf, x, z) > -0.42) continue;
    resources.push({ kind: 'food', type: 'fish', resKind: 'food', x, z, amount: 700, radius: 1.6, scale: 0.9, y: hfSample(hf, x, z) });
  }

  // Relics: 5 scattered golden chests
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU, d = 60 + rng() * 150;
    const x = clamp(Math.cos(a) * d, -230, 230), z = clamp(Math.sin(a) * d, -230, 230);
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
    for (const [x, z] of roadPts) stampRoad(splat, hf, x, z, 1);
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
      stampRoad(splat, hf, x, z, 0.45 + falloff * 0.45, 2.2 + rng() * 2.0);
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
    for (const b of hydro.bridges) bridges.push({ ...b });
    /* A stone ford is *paved*: the paving is stamped into the splat so the
       cobbles read on the ground as well as under the water. The stamp
       follows the shelf's own oval shape, so the paving stops where the
       shallow water stops instead of scattering over the bank. */
    for (const f of fords) {
      const cos = Math.cos(f.angle || 0), sin = Math.sin(f.angle || 0);
      for (let i = 0; i < 46; i++) {
        const u = (rng() * 2 - 1) * f.radius * 0.66;
        const w = (rng() * 2 - 1) * f.radius;
        if (u * u / (f.radius * 0.66) ** 2 + w * w / (f.radius * f.radius) > 1) continue;
        const x = f.x + cos * u - sin * w;
        const z = f.z + sin * u + cos * w;
        stampRoad(splat, hf, x, z, 0.85, 1.3);
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

  // Walkability: block cells covered by large props
  for (const r of resources) {
    if (r.type === 'fish' || r.type === 'relic') continue;
    const s = r.radius * r.scale;
    stampDisc(props, hf, r.x, r.z, Math.max(0.6, s * 0.8), 1);
  }

  const world = {
    seed, style,
    mapType: mapInfo.id,
    mapName: mapInfo.name,
    size, half: size * 0.5,
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
    playerBase, enemyBase,
    bases: SEATS,
    nav: null,
    fow: null
  };
  world.nav = buildNavGrid(world);
  world.heightAt = (x, z) => hf.sample(x, z);
  world.domainAtOrDefault = (x, z) => world.domainAt(x, z);
  return world;
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

function stampDisc(grid, hf, wx, wz, radius, value) {
  const res = WORLD.segments;
  const n = res + 1;
  const cell = WORLD.size / res;
  const cx0 = Math.floor((wx - radius + WORLD.half) / cell);
  const cx1 = Math.ceil((wx + radius + WORLD.half) / cell);
  const cz0 = Math.floor((wz - radius + WORLD.half) / cell);
  const cz1 = Math.ceil((wz + radius + WORLD.half) / cell);
  for (let z = Math.max(0, cz0); z <= Math.min(res, cz1); z++) {
    for (let x = Math.max(0, cx0); x <= Math.min(res, cx1); x++) {
      const px = (x / res) * WORLD.size - WORLD.half;
      const pz = (z / res) * WORLD.size - WORLD.half;
      if (dist2(px, pz, wx, wz) <= radius * radius) grid[z * n + x] = value;
    }
  }
}

function stampRoad(splat, hf, wx, wz, strength, radius = 2.6) {
  const res = WORLD.segments;
  const n = res + 1;
  const cell = WORLD.size / res;
  const cx0 = Math.floor((wx - radius + WORLD.half) / cell);
  const cx1 = Math.ceil((wx + radius + WORLD.half) / cell);
  const cz0 = Math.floor((wz - radius + WORLD.half) / cell);
  const cz1 = Math.ceil((wz + radius + WORLD.half) / cell);
  for (let z = Math.max(0, cz0); z <= Math.min(res, cz1); z++) {
    for (let x = Math.max(0, cx0); x <= Math.min(res, cx1); x++) {
      const px = (x / res) * WORLD.size - WORLD.half;
      const pz = (z / res) * WORLD.size - WORLD.half;
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
      const w = k;
      if (w <= 0.02) continue;
      const prev = splat[i * 2 + 1];
      if (b !== TERRAIN_LAYER.DIRT) {
        splat[i * 2] = TERRAIN_LAYER.DIRT;
        splat[i * 2 + 1] = Math.min(255, Math.round(w * 240)) | 0;
      } else {
        splat[i * 2 + 1] = Math.max(prev, Math.min(255, Math.round(w * 240))) | 0;
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
  const N = WORLD.navCells;
  const cell = WORLD.navCell;
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
      const wx = (x + 0.5) * cell - WORLD.half;
      const wz = (z + 0.5) * cell - WORLD.half;
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
      const cx = clamp(((x + WORLD.half) / cell) | 0, 0, N - 1);
      const cz = clamp(((z + WORLD.half) / cell) | 0, 0, N - 1);
      return domain[cz * N + cx] === DOMAIN.WATER_ONLY;
    },
    domainAt: (x, z) => {
      const cx = clamp(((x + WORLD.half) / cell) | 0, 0, N - 1);
      const cz = clamp(((z + WORLD.half) / cell) | 0, 0, N - 1);
      return domain[cz * N + cx];
    }
  };
}
