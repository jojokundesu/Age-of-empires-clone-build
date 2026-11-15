/* ============================================================
   hydrology.js — experimental terrain, rivers and domain data
   ------------------------------------------------------------
   The old generator carved one sine-wave valley into a square island
   and dropped a ring of ocean around the edges: the "box island".
   This module replaces that with a procedural heightfield built from
   value-noise fBm/ridges and cubic Bezier river splines,
   five distinct map archetypes, a per-cell flow vector field and a
   four-state navigation domain:

     0 BLOCKED                 cliffs, deep forest, buildings
     1 LAND_ONLY               plains, hills, roads, stealth forests
     2 WATER_ONLY              deep rivers, straits, open ocean
     3 AMPHIBIOUS_SHALLO_FORD  proposed shared fords and beaches

   Everything is deterministic from the match seed, evaluated once at
   load, and baked into typed arrays. The frame loop never calls a
   noise function. The renderer reads `flowTex` (rg = flow, b = depth,
   a = shore/ford mask) for directional ripples, depth colouring and
   shoreline foam; the land navigation grid reads the generated domain data.
   ============================================================ */
import { clamp, clamp01, lerp, smoothstep, fbm2, ridged2, noise2, mulberry32, TAU } from '../core/math.js';

export const DOMAIN = {
  BLOCKED: 0,
  LAND_ONLY: 1,
  WATER_ONLY: 2,
  AMPHIBIOUS_SHALLO_FORD: 3
};
export const DOMAIN_LABEL = ['BLOCKED', 'LAND_ONLY', 'WATER_ONLY', 'AMPHIBIOUS_SHALLO_FORD'];

export const WATER_LEVEL = 0.0;
export const SHALLOW_BED = -0.18;     // a ford: 18 cm of water over stone
export const DEEP_BED = -5.2;

export const MAP_TYPES = [
  {
    id: 'confluence', name: 'Confluence / Danube', icon: 'fish', style: 'temperate',
    desc: 'A wide navigable river divides the empires. Three shallow stone fords carry armies; deep channels carry warships. Tributaries feed the valley.',
    water: 0.24, naval: true, fords: 3
  },
  {
    id: 'archipelago', name: 'Warring Islands', icon: 'ship', style: 'northern',
    desc: 'Four great landmasses split by deep ocean straits. Gold-rich central islands and Sacred Sites make Docks, Transports and naval superiority decisive.',
    water: 0.55, naval: true, fords: 0
  },
  {
    id: 'mediterranean', name: 'Inland Sea', icon: 'fish', style: 'mediterranean',
    desc: 'A vast central sea of Deep Sea Fish and Coastal Trade Posts, ringed by continuous land with two narrow coastal choke points.',
    water: 0.38, naval: true, fords: 0
  },
  {
    id: 'highview', name: 'King of the Hill / Highview', icon: 'mountain', style: 'temperate',
    desc: 'An elevated central plateau with cliff faces, natural ramps, Stealth Forests and a winding river moat crossed by three stone bridges.',
    water: 0.18, naval: false, fords: 3
  },
  {
    id: 'arabia', name: 'Dry Arabia / Oasis', icon: 'leaf', style: 'arid',
    desc: 'Golden dunes, a lush central oasis, palm groves and wide open cavalry flanking plains. Little water, no safe flank.',
    water: 0.05, naval: false, fords: 0
  }
];
export const MAP_TYPE_BY_ID = Object.fromEntries(MAP_TYPES.map((m) => [m.id, m]));
export const DEFAULT_MAP_TYPE = 'confluence';
export function mapTypeInfo(id) { return MAP_TYPE_BY_ID[id] || MAP_TYPE_BY_ID[DEFAULT_MAP_TYPE]; }

/* ------------------------------------------------------------
   Cubic Bezier splines. A river is a chain of these; the polyline
   that comes out is used both for carving the bed and for the flow
   vector field (the tangent IS the direction the water moves).
   ------------------------------------------------------------ */
function bezier(p0, p1, p2, p3, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    pts.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      z: a * p0.z + b * p1.z + c * p2.z + d * p3.z
    });
  }
  return pts;
}
function polyline(pts, width, depth, kind = 'river') {
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    seg.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, len, tx: dx / len, tz: dz / len });
  }
  return { pts, seg, width, depth, kind };
}
/** Distance to a polyline plus its local flow tangent. */
function nearestOn(spline, x, z, out) {
  let best = 1e9;
  const seg = spline.seg;
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i];
    let t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / (s.len * s.len);
    t = clamp01(t);
    const px = s.ax + s.dx * t, pz = s.az + s.dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; out.tx = s.tx; out.tz = s.tz; out.seg = i; }
  }
  out.d = best;
  return out;
}
/** A ring moat, built from Bezier arcs so it has real curvature. */
function ringSpline(rx, rz, wobble, rng, steps = 96) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const r = 1 + Math.sin(a * 3 + wobble) * 0.055 + Math.sin(a * 5 - wobble) * 0.03;
    pts.push({ x: Math.cos(a) * rx * r, z: Math.sin(a) * rz * r });
  }
  // closure segment
  return pts;
}

/* ------------------------------------------------------------
   Archetype height functions. Every one of them guarantees land
   at the four corner seats, so the existing base-site search,
   resource placement and starting towns still work unchanged.
   ------------------------------------------------------------ */
const CORNERS = [[-150, 150], [150, -150], [150, 150], [-150, -150]];

function seatPad(x, z, radius = 46, lift = 4.2) {
  let w = 0;
  for (const [cx, cz] of CORNERS) {
    const d = Math.hypot(x - cx, z - cz);
    w = Math.max(w, smoothstep(1 - d / radius));
  }
  return w * lift;
}

function baseLand(x, z, style, rng) {
  const nx = x / 110, nz = z / 110;
  let h = 3.4 + fbm2(nx * 0.9, nz * 0.9, 4) * 6.2;
  const mask = smoothstep((fbm2(nx * 0.42 + 7.3, nz * 0.42 - 3.1, 3) + 0.22) / 0.72);
  h += mask * ridged2(nx * 1.9 + 4.4, nz * 1.9 - 2.2, 4) * 16.5 * (style === 'arid' ? 0.42 : 1);
  h += fbm2(nx * 5.6, nz * 5.6, 2) * 0.75;
  h += seatPad(x, z);
  return h;
}

function islandMask(x, z, cx, cz, rx, rz) {
  const d = Math.hypot((x - cx) / rx, (z - cz) / rz);
  return smoothstep(clamp01((1.16 - d) / 0.42));
}

function archipelagoLand(x, z, rng) {
  // Four major landmasses, plus a resource-rich central island.
  const seats = [
    [-150, 150, 122, 112], [150, -150, 122, 112],
    [150, 150, 104, 100], [-150, -150, 104, 100],
    [0, 0, 58, 52], [-40, 120, 42, 38], [70, -130, 40, 36]
  ];
  let m = 0;
  for (const [cx, cz, rx, rz] of seats) m = Math.max(m, islandMask(x, z, cx, cz, rx, rz));
  const rough = fbm2(x / 62, z / 62, 4) * 3.6 + ridged2(x / 95, z / 95, 3) * 4.2;
  return lerp(DEEP_BED - 1.4, 3.8 + rough, m) + fbm2(x / 140, z / 140, 2) * 1.1 * m;
}

function mediterraneanLand(x, z) {
  const r = Math.hypot(x / 150, z / 138);
  // continuous outer land ring, deep central sea
  let h = lerp(DEEP_BED - 0.8, 4.6 + fbm2(x / 95, z / 95, 4) * 5.2, smoothstep(clamp01((r - 0.88) / 0.26)));
  // two narrow land spits: the coastal choke points
  for (const a of [0.42, Math.PI + 0.42]) {
    const cx = Math.cos(a), cz = Math.sin(a);
    const along = Math.abs(x * cx + z * cz);
    const across = Math.abs(-x * cz + z * cx);
    if (along < 152 && across < 9) {
      const k = smoothstep(1 - across / 9) * smoothstep(1 - along / 152);
      h = Math.max(h, lerp(h, 1.35 + fbm2(x / 40, z / 40, 2) * 0.5, k));
    }
  }
  h += seatPad(x, z, 54, 4.6);
  return h;
}

function highviewLand(x, z) {
  const r = Math.hypot(x / 92, z / 92);
  // plateau with real cliff faces (steep transition) and four natural ramps
  let ramp = 0;
  for (const a of [0.35, 1.65, 3.0, 4.75]) {
    const dx = Math.cos(a), dz = Math.sin(a);
    const along = x * dx + z * dz;
    const across = Math.abs(-x * dz + z * dx);
    if (along > 0 && across < 17) ramp = Math.max(ramp, smoothstep(1 - across / 17) * smoothstep(1 - along / 175));
  }
  const cliff = smoothstep(clamp01((1.02 - r) / (0.1 + ramp * 0.55)));
  let h = baseLand(x, z, 'temperate', null);
  h += cliff * (12.5 + fbm2(x / 55, z / 55, 3) * 2.2);
  return h;
}

function arabiaLand(x, z) {
  const nx = x / 110, nz = z / 110;
  const dunes = ridged2(nx * 1.35 + 2.2, nz * 1.35 - 1.4, 4) * 5.2;
  let h = 4.6 + fbm2(nx * 0.7, nz * 0.7, 4) * 3.4 + dunes + noise2(nx * 3.1, nz * 3.1) * 0.7;
  // central lush oasis: a real basin with a green rim
  const d = Math.hypot(x / 34, z / 29);
  const basin = smoothstep(clamp01((1.0 - d) / 0.35));
  h = lerp(h, -1.9, basin);
  const rim = smoothstep(clamp01(1 - Math.abs(d - 1.08) / 0.35));
  h += rim * 1.35;
  h += seatPad(x, z, 48, 5.0);
  return h;
}

function heightFor(mapType, x, z, rng) {
  switch (mapType) {
    case 'archipelago': return archipelagoLand(x, z, rng);
    case 'mediterranean': return mediterraneanLand(x, z);
    case 'highview': return highviewLand(x, z);
    case 'arabia': return arabiaLand(x, z);
    default: return baseLand(x, z, 'temperate', rng);
  }
}

/* ------------------------------------------------------------
   buildHydrology -- the one public generator
   ------------------------------------------------------------ */
export function buildHydrology(seed = 20261, mapTypeId = DEFAULT_MAP_TYPE, opts = {}) {
  const info = mapTypeInfo(mapTypeId);
  const id = info.id;
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const res = opts.res || 128;                 // terrain grid resolution
  const size = opts.size || 512;
  const half = size * 0.5;
  const n = res + 1;
  const cell = size / res;
  const heights = new Float32Array(n * n);
  const flowVX = new Float32Array(n * n);
  const flowVZ = new Float32Array(n * n);
  const riverMask = new Float32Array(n * n);
  const fordMask = new Uint8Array(n * n);

  /* --- 1. River / moat splines --------------------------------------- */
  const rivers = [];
  const fords = [];
  const bridges = [];
  if (id === 'confluence') {
    const phase = rng() * 0.6 - 0.3;
    const main = polyline(bezier(
      { x: -half - 20, z: 34 + phase * 40 }, { x: -110, z: -72 - phase * 60 },
      { x: 110, z: 88 + phase * 50 }, { x: half + 20, z: -26 + phase * 30 }, 84),
      21, -3.9, 'river');
    rivers.push(main);
    /* two tributaries join the main river -- confluence, not a canal */
    for (const [sx, sz, ex, ez, w] of [
      [-172, 214, -58, 20, 9], [176, -206, 74, -12, 8]
    ]) {
      const c1 = { x: lerp(sx, ex, 0.35) + (rng() - 0.5) * 70, z: lerp(sz, ez, 0.3) };
      const c2 = { x: lerp(sx, ex, 0.7) - (rng() - 0.5) * 70, z: lerp(sz, ez, 0.75) };
      rivers.push(polyline(bezier({ x: sx, z: sz }, c1, c2, { x: ex, z: ez }, 52), w, -2.7, 'tributary'));
    }
    // three shallow stone fords, evenly spread along the navigable river
    for (const fx of [-142, 2, 146]) {
      let best = main.pts[0], bd = 1e9;
      for (const p of main.pts) { const d = Math.abs(p.x - fx); if (d < bd) { bd = d; best = p; } }
      fords.push({ x: best.x, z: best.z, radius: 12.5, kind: 'stone ford' });
    }
  } else if (id === 'highview') {
    const moat = polyline(ringSpline(104, 96, rng() * TAU, rng, 120), 10.5, -2.8, 'moat');
    rivers.push(moat);
    for (const a of [0.35, 2.45, 4.4]) {
      bridges.push({ x: Math.cos(a) * 104, z: Math.sin(a) * 96, radius: 12, angle: a });
    }
    for (const b of bridges) fords.push({ x: b.x, z: b.z, radius: 11, kind: 'stone bridge' });
  } else if (id === 'mediterranean') {
    // a short river feeding the inland sea from the north-west
    rivers.push(polyline(bezier(
      { x: -232, z: 214 }, { x: -176, z: 120 }, { x: -120, z: 60 }, { x: -86, z: 8 }, 48),
      8, -3.2, 'tributary'));
  } else if (id === 'arabia') {
    // an irrigation channel out of the oasis: shallow, walkable, no ships
    rivers.push(polyline(bezier(
      { x: 0, z: 0 }, { x: 44, z: 26 }, { x: 96, z: -34 }, { x: 168, z: -58 }, 40),
      5.5, -0.45, 'wadi'));
  }

  /* --- 2. Heightfield: noise + Bezier carving ------------------------- */
  const probe = { d: 0, tx: 0, tz: 0, seg: 0 };
  for (let j = 0; j < n; j++) {
    const wz = j * cell - half;
    for (let i = 0; i < n; i++) {
      const wx = i * cell - half;
      let h = heightFor(id, wx, wz, rng);
      let vx = 0, vz = 0, mask = 0;
      for (let r = 0; r < rivers.length; r++) {
        const river = rivers[r];
        nearestOn(river, wx, wz, probe);
        if (probe.d > river.width * 1.9) continue;
        /* Shape of the bed: a flat navigable channel with soft banks.
           `smoothstep` gives the shallow shoreline the foam shader wants. */
        const t = smoothstep(clamp01(1 - probe.d / river.width));
        const bank = smoothstep(clamp01(1 - probe.d / (river.width * 1.8)));
        h = lerp(h, river.depth, Math.max(t * 0.96, bank * 0.42));
        vx += probe.tx * t; vz += probe.tz * t;
        mask = Math.max(mask, t);
      }
      /* Fords / bridges: shallow stone where both armies and ships pass.
         The bed sits at -0.18 m, so the water is 18 cm deep: land units
         walk through it (with splashes) and shallow-draft ships sail. */
      let onFord = false;
      for (const f of fords) {
        const d = Math.hypot(wx - f.x, wz - f.z);
        if (d < f.radius) {
          const t = smoothstep(1 - d / f.radius);
          h = lerp(h, SHALLOW_BED, t);
          onFord = true;
        }
      }
      const k = j * n + i;
      heights[k] = h;
      riverMask[k] = mask;
      fordMask[k] = onFord ? 1 : 0;
      const fl = Math.hypot(vx, vz) || 1;
      flowVX[k] = vx / fl; flowVZ[k] = vz / fl;
      if (!mask) {
        /* Open water drifts gently; a circular gyre reads as a living sea
           without six noise fetches per pixel in the shader. */
        flowVX[k] = -wz / (half * 1.6);
        flowVZ[k] = wx / (half * 1.6);
      }
    }
  }

  /* --- 3. Bilinear sampling helpers over the finished field ----------- */
  const sampleGrid = (arr, wx, wz) => {
    const fx = clamp((wx + half) / cell, 0, res - 0.0001);
    const fz = clamp((wz + half) / cell, 0, res - 0.0001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const a = arr[z0 * n + x0], b = arr[z0 * n + x0 + 1];
    const c = arr[(z0 + 1) * n + x0], d = arr[(z0 + 1) * n + x0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  };
  const heightAt = (x, z) => sampleGrid(heights, x, z);
  const slopeAt = (x, z) => {
    const d = cell * 0.8;
    return Math.hypot(heightAt(x + d, z) - heightAt(x - d, z),
      heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
  };

  /* --- 4. Four-state domain grid -------------------------------------- */
  const N = opts.navCells || 256;
  const navCell = size / N;
  const domain = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const wz = (j + 0.5) * navCell - half;
    for (let i = 0; i < N; i++) {
      const wx = (i + 0.5) * navCell - half;
      const h = heightAt(wx, wz);
      let d;
      if (slopeAt(wx, wz) > 0.95) d = DOMAIN.BLOCKED;
      else if (sampleGrid(fordMask, wx, wz) > 0.42) d = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
      else if (h < -0.35) d = DOMAIN.WATER_ONLY;
      else if (h < 0.25) d = DOMAIN.AMPHIBIOUS_SHALLO_FORD;   // beaches, moat edges
      else d = DOMAIN.LAND_ONLY;
      domain[j * N + i] = d;
    }
  }
  const domainAt = (x, z) => {
    const cx = clamp(((x + half) / navCell) | 0, 0, N - 1);
    const cz = clamp(((z + half) / navCell) | 0, 0, N - 1);
    return domain[cz * N + cx];
  };

  /* --- 5. Flow/depth/foam texture for the water shader ---------------- */
  const F = opts.flowSize || 128;
  const flowData = new Uint8Array(F * F * 4);
  for (let j = 0; j < F; j++) {
    const wz = (j / (F - 1)) * size - half;
    for (let i = 0; i < F; i++) {
      const wx = (i / (F - 1)) * size - half;
      const vx = sampleGrid(flowVX, wx, wz), vz = sampleGrid(flowVZ, wx, wz);
      const h = heightAt(wx, wz);
      const depth = clamp01(Math.max(0, WATER_LEVEL - h) / 6);
      /* The shoreline/ford mask is exactly the spec's rule:
         terrainHeight - waterLevel < 0.45 means foam. */
      const shore = h - WATER_LEVEL < 0.45 && h > DEEP_BED - 0.5
        ? clamp01(1 - Math.abs(h - 0.02) / 0.9) : 0;
      const ford = sampleGrid(fordMask, wx, wz);
      const o = (j * F + i) * 4;
      flowData[o] = clamp(((vx * 0.5 + 0.5) * 255) | 0, 0, 255);
      flowData[o + 1] = clamp(((vz * 0.5 + 0.5) * 255) | 0, 0, 255);
      flowData[o + 2] = (depth * 255) | 0;
      flowData[o + 3] = Math.max((shore * 235) | 0, ford > 0.4 ? 200 : 0);
    }
  }

  /* --- 6. Strategic terrain features ---------------------------------- */
  const stealthForests = [];
  const sacredSites = [];
  const tradePosts = [];
  const deepFish = [];
  const shoreFish = [];
  const extraGold = [];
  const palmGroves = [];

  const landSpot = (minR, maxR, tries = 60, need = 'land') => {
    for (let t = 0; t < tries; t++) {
      const a = rng() * TAU, d = minR + rng() * (maxR - minR);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = heightAt(x, z);
      if (need === 'land' && (h < 1.1 || slopeAt(x, z) > 0.42)) continue;
      if (need === 'shore' && (h < -0.4 || h > 1.4)) continue;
      if (need === 'deep' && h > -1.8) continue;
      if (CORNERS.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 44)) continue;
      return { x, z, y: h };
    }
    return null;
  };

  const forestCount = id === 'highview' ? 7 : id === 'arabia' ? 2 : 5;
  for (let i = 0; i < forestCount; i++) {
    const s = landSpot(52, 178, 70, 'land');
    if (s) stealthForests.push({ x: s.x, z: s.z, y: s.y, radius: 13 + rng() * 10, id: `stealth-${i}` });
  }
  for (let i = 0; i < 3; i++) {
    let s = null;
    // The inland sea can cover the central candidate entirely. Fall back to
    // its shores rather than silently omitting the first sacred site.
    for (let attempt = 0; attempt < 8 && !s; attempt++) {
      const candidate = attempt === 0
        ? landSpot(i === 0 ? 0 : 60, i === 0 ? 34 : 150, 80, 'land')
        : landSpot(45, 205, 120, 'land');
      if (candidate && sacredSites.every(other => Math.hypot(candidate.x - other.x, candidate.z - other.z) >= 25)) s = candidate;
    }
    if (s) sacredSites.push({ x: s.x, z: s.z, y: s.y, type: 'sacred_site', id: `sacred-${i}`, claimed: 0 });
  }
  if (info.naval) {
    for (let i = 0; i < 4; i++) {
      const s = landSpot(90, 205, 90, 'shore');
      if (s) tradePosts.push({ x: s.x, z: s.z, y: s.y, type: 'trade_post', id: `trade-${i}` });
    }
    for (let i = 0; i < 18; i++) {
      const s = landSpot(40, 205, 90, 'deep');
      if (s) deepFish.push({ x: s.x, z: s.z, y: WATER_LEVEL, amount: 1400, type: 'deep_fish' });
    }
    for (let i = 0; i < 14; i++) {
      const s = landSpot(30, 205, 90, 'shore');
      if (s) shoreFish.push({ x: s.x, z: s.z, y: WATER_LEVEL, amount: 700, type: 'fish' });
    }
  }
  if (id === 'archipelago') {
    for (let i = 0; i < 10; i++) {
      const a = rng() * TAU, d = 18 + rng() * 44;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      extraGold.push({ x, z, y: heightAt(x, z), amount: 1600 });
    }
  }
  if (id === 'arabia') {
    for (let i = 0; i < 26; i++) {
      const a = rng() * TAU, d = 34 + rng() * 26;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = heightAt(x, z);
      if (h > 0.5) palmGroves.push({ x, z, y: h, type: 'tree', palm: true });
    }
  }

  return {
    id, info, seed,
    style: info.style,
    res, n, cell, size, half,
    heights, flowVX, flowVZ, riverMask, fordMask,
    heightAt, slopeAt, domainAt,
    domain, domainCells: N, domainCell: navCell,
    flowTex: { size: F, data: flowData },
    rivers: rivers.map((r) => ({ kind: r.kind, width: r.width, depth: r.depth,
      points: r.pts.map((p) => [p.x, p.z]) })),
    fords, bridges,
    stealthForests, sacredSites, tradePosts, deepFish, shoreFish, extraGold, palmGroves,
    waterLevel: WATER_LEVEL,
    shallowBed: SHALLOW_BED,
    isNaval: !!info.naval
  };
}

/** Count of each domain state -- used by the Forge Studio and tests. */
export function domainCensus(hydro) {
  const out = [0, 0, 0, 0];
  for (const d of hydro.domain) out[d]++;
  return Object.fromEntries(DOMAIN_LABEL.map((k, i) => [k, out[i]]));
}

/** Brushes used by the Imperial Forge Studio's live terrain editor. */
export const HYDROLOGY_BRUSHES = [
  { id: 'raise', name: 'Raise hills', icon: 'mountain' },
  { id: 'cliff', name: 'Sculpt cliffs', icon: 'stone' },
  { id: 'lower', name: 'Lower ground', icon: 'down' },
  { id: 'river', name: 'Carve river', icon: 'fish' },
  { id: 'ford', name: 'Paint shallow ford', icon: 'boot' },
  { id: 'stealth', name: 'Paint stealth forest', icon: 'leaf' },
  { id: 'gold', name: 'Place gold vein', icon: 'coin' },
  { id: 'stone', name: 'Place stone outcrop', icon: 'stone' },
  { id: 'deepfish', name: 'Place deep-sea fish', icon: 'fish' },
  { id: 'sacred', name: 'Place Sacred Site', icon: 'relic' }
];

/**
 * Apply one Forge Studio brush to a live world. Mutates the heightfield and
 * the domain grid in place, then refreshes the flow texture. The renderer
 * re-bakes terrain from the same arrays, so the edit is visible immediately.
 */
export function applyBrush(world, brush, x, z, radius = 12, strength = 1) {
  const hf = world.height;
  const H = world.hydrology;
  if (!hf || !H) return false;
  const res = hf.res;
  const n = res + 1;
  const cell = hf.cell;
  const half = world.half;
  const i0 = clamp(Math.floor((x - radius + half) / cell), 0, res);
  const i1 = clamp(Math.ceil((x + radius + half) / cell), 0, res);
  const j0 = clamp(Math.floor((z - radius + half) / cell), 0, res);
  const j1 = clamp(Math.ceil((z + radius + half) / cell), 0, res);
  let changed = false;
  for (let j = j0; j <= j1; j++) {
    const wz = j * cell - half;
    for (let i = i0; i <= i1; i++) {
      const wx = i * cell - half;
      const d = Math.hypot(wx - x, wz - z);
      if (d > radius) continue;
      const t = smoothstep(1 - d / radius) * strength;
      const k = j * n + i;
      switch (brush) {
        case 'raise':
        case 'cliff': hf.h[k] += (brush === 'cliff' ? 9 : 3.5) * t; changed = true; break;
        case 'lower': hf.h[k] -= 3.5 * t; changed = true; break;
        case 'river': hf.h[k] = lerp(hf.h[k], DEEP_BED, t); changed = true; break;
        case 'ford': hf.h[k] = lerp(hf.h[k], SHALLOW_BED, t); changed = true; break;
        default: break;
      }
      if (changed) { H.heights[k] = hf.h[k]; H.fordMask[k] = brush === 'ford' ? 1 : H.fordMask[k]; }
    }
  }
  if (!changed) return false;
  // refresh domain cells in the painted disc
  const N = H.domainCells, nc = H.domainCell;
  const ci0 = clamp(Math.floor((x - radius + half) / nc), 0, N - 1);
  const ci1 = clamp(Math.ceil((x + radius + half) / nc), 0, N - 1);
  const cj0 = clamp(Math.floor((z - radius + half) / nc), 0, N - 1);
  const cj1 = clamp(Math.ceil((z + radius + half) / nc), 0, N - 1);
  for (let j = cj0; j <= cj1; j++) {
    for (let i = ci0; i <= ci1; i++) {
      const wx = (i + 0.5) * nc - half, wz = (j + 0.5) * nc - half;
      const h = hf.sample(wx, wz);
      const steep = H.slopeAt(wx, wz) > 0.95;
      H.domain[j * N + i] = steep ? DOMAIN.BLOCKED
        : h < -0.35 ? DOMAIN.WATER_ONLY
          : h < 0.25 ? DOMAIN.AMPHIBIOUS_SHALLO_FORD : DOMAIN.LAND_ONLY;
    }
  }
  /* Rebuild the flow texture from the edited field: depth + foam follow the
     new shoreline, so a carved river immediately gets its own ripples. */
  const F = H.flowTex.size, data = H.flowTex.data;
  for (let j = 0; j < F; j++) {
    const wz = (j / (F - 1)) * H.size - half;
    for (let i = 0; i < F; i++) {
      const wx = (i / (F - 1)) * H.size - half;
      if (Math.hypot(wx - x, wz - z) > radius + 6) continue;
      const h = hf.sample(wx, wz);
      const o = (j * F + i) * 4;
      data[o + 2] = (clamp01(Math.max(0, WATER_LEVEL - h) / 6) * 255) | 0;
      data[o + 3] = h - WATER_LEVEL < 0.45 && h > DEEP_BED - 0.5
        ? (clamp01(1 - Math.abs(h - 0.02) / 0.9) * 235) | 0 : 0;
    }
  }
  world.flowDirty = true;
  return true;
}

export default buildHydrology;
