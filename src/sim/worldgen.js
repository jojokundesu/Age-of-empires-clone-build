/* ============================================================
   worldgen.js — deterministic terrain, biomes, forests & camps
   The whole match lives in a 512 x 512 metre square. Height is
   baked once into a Float32Array and sampled analytically after
   that, so nothing in the frame loop touches noise functions.
   ============================================================ */
import { clamp, lerp, smoothstep, fbm2, ridged2, noise2, mulberry32, rngFor, dist2, TAU } from '../core/math.js';

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
  const style = opts.style || rng.pick(['temperate', 'temperate', 'mediterranean', 'northern', 'arid']);
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

  // ---- base height: rolling land, mountain ridges, a river valley
  const riverPhase = rng() * TAU;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const wx = (x / res) * size - size * 0.5;
      const wz = (z / res) * size - size * 0.5;
      const nx = wx / 110, nz = wz / 110;
      // rolling countryside, biased above sea level
      let h = 3.4 + fbm2(nx * 0.9, nz * 0.9, 4) * 6.2;
      // mountain massifs only where the mask is strong
      const mask = smoothstep((fbm2(nx * 0.42 + 7.3, nz * 0.42 - 3.1, 3) + 0.22) / 0.72);
      h += mask * ridged2(nx * 1.9 + 4.4, nz * 1.9 - 2.2, 4) * 16.5 * styleParams.hills;
      // surface detail
      h += fbm2(nx * 5.6, nz * 5.6, 2) * 0.75;
      // a single meandering river cutting the map in half
      const riverZ = Math.sin(wx * 0.0125 + riverPhase) * 58 + Math.sin(wx * 0.033 + riverPhase * 2) * 17;
      const dRiver = Math.abs(wz - riverZ);
      h -= smoothstep(1 - clamp(dRiver / 11, 0, 1)) * 7.5;
      // the sea beyond the square island
      const rim = Math.max(Math.abs(wx), Math.abs(wz));
      const edge = clamp((rim - 196) / 58, 0, 1);
      h = h * (1 - edge * 1.25) - edge * 7.5;
      hf.h[z * n + x] = h;
    }
  }
  // ---- fords: shallow crossings so both halves of the map stay connected
  const fords = [];
  for (let f = 0; f < 3; f++) {
    const fx = -145 + f * 132 + (rand() - 0.5) * 26;
    const riverZ = Math.sin(fx * 0.0125 + riverPhase) * 58 + Math.sin(fx * 0.033 + riverPhase * 2) * 17;
    fords.push({ x: fx, z: riverZ });
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const wx = (x / res) * size - size * 0.5;
        const wz = (z / res) * size - size * 0.5;
        if (Math.abs(wx - fx) > 13) continue;
        const rz = Math.sin(wx * 0.0125 + riverPhase) * 58 + Math.sin(wx * 0.033 + riverPhase * 2) * 17;
        if (Math.abs(wz - rz) > 16) continue;
        const t = smoothstep(1 - Math.abs(wx - fx) / 13);
        hf.h[z * n + x] = lerp(hf.h[z * n + x], Math.max(hf.h[z * n + x], 0.85), t);
      }
    }
  }
  // ---- smooth once to remove high-frequency spikes in walking space
  smoothField(hf, 1);

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
      if (h > 13.5 && slope < 0.3) { layer = TERRAIN_LAYER.SNOW; blend = 235; }
      splat[i * 2] = layer;
      splat[i * 2 + 1] = Math.min(255, blend);
      const isWater = h < -0.35;
      water[i] = isWater ? 1 : 0;
      walk[i] = (!isWater && slope < 0.62) ? 1 : 0;
    }
  }

  // ---- spawn sites: two opposite corners, flattened and cleared
  const playerBase = findBaseSite(hf, walk, -150, 150, rng);
  const enemyBase = findBaseSite(hf, walk, 150, -150, rng);
  flattenPlateau(hf, playerBase.x, playerBase.z, 26, playerBase.h);
  flattenPlateau(hf, enemyBase.x, enemyBase.z, 26, enemyBase.h);
  // recompute walkability inside plateaus
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const wx = (x / res) * size - size * 0.5;
      const wz = (z / res) * size - size * 0.5;
      const h = hf.h[i];
      const slope = hf.slope(wx, wz);
      const isWater = h < -0.35;
      water[i] = isWater ? 1 : 0;
      walk[i] = (!isWater && slope < 0.62) ? 1 : 0;
    }
  }

  // ---- resources, props and decoration
  const resources = [];
  const propList = [];
  const decor = [];
  const roads = [];

  const nearBase = (x, z, r) => (dist2(x, z, playerBase.x, playerBase.z) < r * r) || (dist2(x, z, enemyBase.x, enemyBase.z) < r * r);

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
  for (const base of [playerBase, enemyBase]) {
    for (let i = 0; i < 7; i++) {
      const s = findSpot(base.x, base.z, 16, 24, 20);
      if (!s) continue;
      resources.push({ kind: 'wood', type: 'tree', resKind: 'wood', x: s.x, z: s.z, amount: 200, radius: 0.85, variant: (rng() * 4) | 0, scale: 0.9 + rng() * 0.3, y: hfSample(hf, s.x, s.z) });
    }
  }

  // Gold + stone clusters, one guaranteed close to each base
  for (const base of [playerBase, enemyBase]) {
    const gs = findSpot(base.x, base.z, 18, 26, 30);
    if (gs) for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const x = gs.x + Math.cos(a) * (2.5 + rng() * 2), z = gs.z + Math.sin(a) * (2.5 + rng() * 2);
      resources.push({ kind: 'gold', type: 'gold_mine', resKind: 'gold', x, z, amount: 900, radius: 1.25, scale: 0.9 + rng() * 0.35, y: hfSample(hf, x, z) });
    }
    const ss = findSpot(base.x, base.z, 20, 30, 30);
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

  // Fishing grounds
  for (let i = 0; i < 22; i++) {
    const a = rng() * TAU, d = 120 + rng() * 120;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (hfSample(hf, x, z) > -0.6) continue;
    resources.push({ kind: 'food', type: 'fish', resKind: 'food', x, z, amount: 700, radius: 1.6, scale: 0.9, y: -0.35 });
  }

  // Relics: 5 scattered golden chests
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU, d = 60 + rng() * 150;
    const x = clamp(Math.cos(a) * d, -230, 230), z = clamp(Math.sin(a) * d, -230, 230);
    if (hfSample(hf, x, z) < 0.3) continue;
    resources.push({ kind: 'relic', type: 'relic', resKind: 'relic', x, z, amount: 1, radius: 0.5, scale: 1, y: hfSample(hf, x, z) });
  }

  // Decorative props: rocks, logs, reeds, flowers, pebbles
  for (let i = 0; i < 2400; i++) {
    const x = rng() * 500 - 250;
    const z = rng() * 500 - 250;
    const h = hfSample(hf, x, z);
    if (h < -1.2) continue;
    const slope = hfSlope(hf, x, z);
    const r = rng();
    let type;
    if (h < 0.05) type = r < 0.6 ? 'reed' : 'pebble';
    else if (slope > 0.45) type = r < 0.55 ? 'rock' : 'pebble';
    else if (h > 10) type = r < 0.5 ? 'rock' : 'tuft';
    else if (r < 0.42) type = 'tuft';
    else if (r < 0.62) type = 'flower';
    else if (r < 0.74) type = 'pebble';
    else if (r < 0.84) type = 'log';
    else if (r < 0.9) type = 'stump';
    else type = 'rock';
    decor.push({ type, x, z, y: h, scale: 0.6 + rng() * 0.9, rot: rng() * TAU, tint: rng() });
  }
  // forest floor debris inside clusters
  for (let i = 0; i < 700; i++) {
    const x = rng() * 500 - 250, z = rng() * 500 - 250;
    const h = hfSample(hf, x, z);
    if (h < 0.3) continue;
    if (rng() < 0.5) continue;
    decor.push({ type: rng() < 0.5 ? 'log' : 'tuft', x, z, y: h, scale: 0.5 + rng() * 0.7, rot: rng() * TAU, tint: rng() });
  }

  // Roads between the bases (a curving dirt path) — pushed into the splat map
  const roadPts = [];
  {
    const steps = 70;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const bend = Math.sin(t * 5.4) * 34 + Math.sin(t * 11.1 + 1.3) * 12;
      const x = lerp(playerBase.x, enemyBase.x, t) + Math.cos(t * 3.1) * bend * 0.55;
      const z = lerp(playerBase.z, enemyBase.z, t) + Math.sin(t * 2.4) * bend * 0.4;
      if (hfSample(hf, x, z) < -0.3) continue;
      roadPts.push([x, z]);
    }
    for (const [x, z] of roadPts) stampRoad(splat, hf, x, z, 1);
  }

  // POIs: neutral shrines for vision / favour
  const poi = [];
  for (let i = 0; i < 3; i++) {
    const a = rng() * TAU, d = 55 + rng() * 90;
    const x = clamp(Math.cos(a) * d, -210, 210), z = clamp(Math.sin(a) * d, -210, 210);
    if (hfSample(hf, x, z) < 0.4) continue;
    poi.push({ type: 'shrine', x, z, y: hfSample(hf, x, z), claimed: 0 });
  }

  // Walkability: block cells covered by large props
  for (const r of resources) {
    if (r.type === 'fish' || r.type === 'relic') continue;
    const s = r.radius * r.scale;
    stampDisc(props, hf, r.x, r.z, Math.max(0.6, s * 0.8), 1);
  }

  const world = {
    seed, style,
    size, half: size * 0.5,
    height: hf,
    splat, water, walk, props, biome,
    resources, decor, roads: roadPts, poi, fords,
    playerBase, enemyBase,
    nav: null,
    fow: null
  };
  world.nav = buildNavGrid(world);
  world.heightAt = (x, z) => hf.sample(x, z);
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
      if (h < 1.1 && !world.water[k]) { sand += Math.min(0.8, (1.1 - h) * 0.6); grass *= 0.4; }
      if (h > 12.5) snow += Math.min(0.9, (h - 12.5) * 0.22);
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

function stampRoad(splat, hf, wx, wz, strength) {
  const res = WORLD.segments;
  const n = res + 1;
  const cell = WORLD.size / res;
  const radius = 2.6;
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
      const k = smoothstep(1 - d / radius) * strength;
      const b = splat[i * 2 + 1];
      const nb = Math.max(0, b - k * 70) | 0;
      splat[i * 2 + 1] = nb;
      if (k > 0.45) splat[i * 2] = TERRAIN_LAYER.DIRT;
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

function flattenPlateau(hf, wx, wz, radius, targetH) {
  const n = hf.res + 1;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const px = (x / hf.res) * hf.size - hf.size * 0.5;
      const pz = (z / hf.res) * hf.size - hf.size * 0.5;
      const d = Math.hypot(px - wx, pz - wz);
      if (d > radius * 1.6) continue;
      const t = 1 - smoothstep((d - radius * 0.55) / (radius * 1.05));
      hf.h[z * n + x] = lerp(hf.h[z * n + x], targetH, t * 0.94);
    }
  }
}

function findBaseSite(hf, walk, hx, hz, rng) {
  let best = { x: hx, z: hz, h: 0, score: -1e9 };
  for (let i = 0; i < 90; i++) {
    const a = rng() * TAU, d = rng() * 42;
    const x = hx + Math.cos(a) * d;
    const z = hz + Math.sin(a) * d;
    const h = hf.sample(x, z);
    const slope = hf.slope(x, z);
    if (h < 0.6) continue;
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
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const wx = (x + 0.5) * cell - WORLD.half;
      const wz = (z + 0.5) * cell - WORLD.half;
      const h = world.height.sample(wx, wz);
      const slope = world.height.slope(wx, wz);
      blocked[z * N + x] = (h < 0.05 || slope > 0.72) ? 1 : 0;
    }
  }
  return { cells: N, cell, blocked };
}
