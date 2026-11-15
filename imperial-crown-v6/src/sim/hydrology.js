/* ============================================================
   hydrology.js — the river system
   ------------------------------------------------------------
   Every map in this game is a *landscape*, not an island in a
   square tank. There is no code path that draws a ring of ocean
   around the border any more: water exists exactly where the
   terrain the generator built happens to fall below the water
   table, and nowhere else.

   The generator is a small pipeline, and each stage is a separate,
   inspectable thing:

     1. SPLINES   Cubic Catmull-Rom rivers with a per-station width
                  and bed depth. Two tributaries joining a trunk is a
                  confluence; the same code makes a moat, a wadi, a
                  delta or a mountain headwater. Nothing is a sine wave.

     2. MACRO     The archetype's landform — terraced valley, island
                  metaballs, inland basin, plateau, dunes — evaluated
                  as pure noise plus shape functions.

     3. CARVE     The channel. A U-shaped bed that is *deepest* in the
                  middle, with banks that rise to a low floodplain and
                  terraces above it, point bars on the inside of bends,
                  and shallow stone fords where the bed is lifted to
                  just under the waterline.

     4. DOMAIN    The 4-state navigation grid the whole game reads:
                  BLOCKED / LAND_ONLY / WATER_ONLY / AMPHIBIOUS.
                  Land units can only cross a river at a ford; ships
                  can follow the same ford; cliffs stop both.

     5. BAKE      A 128x128 flow/depth/foam field for the water shader
                  (river tangents advect the ripples, depth colours the
                  water, the shore mask drives the foam).

   Everything is deterministic from the seed, evaluated once at load,
   and baked into typed arrays. The frame loop never calls a noise
   function.
   ============================================================ */
import {
  clamp, clamp01, lerp, smoothstep, smootherstep, fbm2, ridged2, noise2,
  mulberry32, TAU
} from '../core/math.js';

/* ------------------------------------------------------------
   Domain states. This is the contract between the map and every
   pathfinder, spawn resolver and unit in the game.
   ------------------------------------------------------------ */
export const DOMAIN = {
  BLOCKED: 0,
  LAND_ONLY: 1,
  WATER_ONLY: 2,
  AMPHIBIOUS_SHALLO_FORD: 3
};
export const DOMAIN_LABEL = ['BLOCKED', 'LAND_ONLY', 'WATER_ONLY', 'AMPHIBIOUS_SHALLO_FORD'];

/* Water table and the depths that matter, in metres. */
export const WATER_LEVEL = 0.0;
/** A packed-stone ford: 22 cm of water over paving. Land wades, ships float. */
export const SHALLOW_BED = -0.22;
/** Anything below this can float a hull. Used by the ship pathfinder. */
export const FLOAT_DEPTH = 0.55;
/** A ford cell must be at least this shallow to count as wading depth. */
const FORD_WADE_LIMIT = -0.62;
/** The spec's foam rule: terrainHeight - waterLevel < 0.45. */
export const FOAM_DEPTH = 0.45;
export const DEEP_BED = -7.2;

/** Normalised smoothstep between two edges (this codebase's smoothstep takes 0..1). */
const ss = (a, b, v) => smoothstep(clamp01((v - a) / (b - a)));

/* ============================================================
   1. RIVERS
   ============================================================ */

/**
 * A river is a polyline of stations. Each station carries a half-width and
 * a bed depth; each *segment* between stations is what the carve loop reads,
 * pre-flattened into typed arrays so the inner loop is pure arithmetic.
 */
class River {
  constructor(name, kind, samples) {
    this.name = name;
    this.kind = kind;          // 'trunk' | 'tributary' | 'moat' | 'wadi' | 'lake'
    this.samples = samples;    // [{ x, z, w, d }]
    this.seginx = null;        // filled by `compile()`
  }

  /** Precompute segment arrays: (ax,az,dx,dz,len2,tx,tz,w0,w1,d0,d1). */
  compile() {
    const n = this.samples.length - 1;
    const ax = new Float64Array(n), az = new Float64Array(n);
    const dx = new Float64Array(n), dz = new Float64Array(n);
    const inv = new Float64Array(n), len = new Float64Array(n);
    const tx = new Float64Array(n), tz = new Float64Array(n);
    const w0 = new Float64Array(n), w1 = new Float64Array(n);
    const d0 = new Float64Array(n), d1 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.samples[i], b = this.samples[i + 1];
      const ex = b.x - a.x, ez = b.z - a.z;
      const l = Math.hypot(ex, ez) || 1e-6;
      ax[i] = a.x; az[i] = a.z; dx[i] = ex; dz[i] = ez;
      len[i] = l; inv[i] = 1 / (l * l);
      tx[i] = ex / l; tz[i] = ez / l;
      w0[i] = a.w; w1[i] = b.w;
      d0[i] = a.d; d1[i] = b.d;
    }
    this.seginx = { count: n, ax, az, dx, dz, inv, len, tx, tz, w0, w1, d0, d1 };
    return this;
  }

  /**
   * Nearest point on this river.
   * Writes into `out`:
   *   d      distance from (x,z) to the centreline
   *   t      arc-length parameter of the closest station (0..count)
   *   w      half-width there
   *   bed    bed depth there
   *   tx,tz  unit tangent there (direction the water flows)
   *   side   signed offset: +1 on the left bank looking downstream
   *   curve  signed curvature there (-1..1): inside vs outside of a bend
   *   first,second  two closest segment indices (for smooth flow blending)
   */
  nearest(x, z, out) {
    const s = this.seginx;
    if (!s) return out;
    const { count, ax, az, dx, dz, inv, tx, tz, w0, w1, d0, d1 } = s;
    let best = Infinity, bi = 0, bt = 0;
    for (let i = 0; i < count; i++) {
      const px = x - ax[i], pz = z - az[i];
      let t = px * dx[i] + pz * dz[i];
      t *= inv[i];
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = px - dx[i] * t, qz = pz - dz[i] * t;
      const d2 = qx * qx + qz * qz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    out.d = Math.sqrt(best);
    out.seg = bi;
    out.t = (bi + bt) / count;
    out.w = lerp(w0[bi], w1[bi], bt);
    out.bed = lerp(d0[bi], d1[bi], bt);
    out.tx = tx[bi]; out.tz = tz[bi];
    /* Signed side: cross(tangent, toPoint). */
    const rx = x - (ax[bi] + dx[bi] * bt), rz = z - (az[bi] + dz[bi] * bt);
    out.side = Math.sign(tx[bi] * rz - tz[bi] * rx) || 1;
    /* Curvature: how fast the tangent turns per metre, signed. This is what
       puts the deep water on the outside of a bend and a gravel point bar on
       the inside, which is the single strongest cue that a channel is real. */
    const j = Math.min(count - 1, bi + 3), k = Math.max(0, bi - 3);
    const xt = tx[j] - tx[k], zt = tz[j] - tz[k];
    const turn = tx[bi] * zt - tz[bi] * xt;
    out.curve = Math.max(-1, Math.min(1, turn * 26));
    return out;
  }
}

/** Catmull-Rom through control points, with width/depth ramped along the way. */
function splineSamples(controls, perSpan, wobbleSeed) {
  const out = [];
  const c = controls;
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = c[Math.max(0, i - 1)], p1 = c[i], p2 = c[i + 1], p3 = c[Math.min(c.length - 1, i + 2)];
    const steps = perSpan;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t
        + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2
        + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      /* A river is never a constant-width ribbon: it breathes. The wobble is
         deterministic from the seed so the same world always looks the same. */
      const wob = 1 + 0.20 * noise2(i * 1.7 + t * 2.6 + wobbleSeed, 3.1 + wobbleSeed * 0.5);
      out.push({
        x, z,
        w: lerp(p1.w, p2.w, t) * wob,
        d: lerp(p1.d, p2.d, t)
      });
    }
  }
  const last = c[c.length - 1];
  out.push({ x: last.x, z: last.z, w: last.w, d: last.d });
  return out;
}

/** A closed ring, built from a wobbling ellipse — used for moats and lakes. */
function ringSamples(cx, cz, rx, rz, wobbleAmp, wobbleSeed, depth, width, steps = 96) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const k = 1 + Math.sin(a * 3 + wobbleSeed) * wobbleAmp
      + Math.sin(a * 5 - wobbleSeed * 1.7) * wobbleAmp * 0.55
      + Math.sin(a * 2 + wobbleSeed * 0.6) * wobbleAmp * 0.4;
    out.push({
      x: cx + Math.cos(a) * rx * k,
      z: cz + Math.sin(a) * rz * k,
      w: typeof width === 'function' ? width(a) : width,
      d: depth
    });
  }
  return out;
}

/* ============================================================
   2. ARCHETYPES
   ------------------------------------------------------------
   Six of them. Each one is a landform plus a river plan plus the
   places it wants the towns to stand. The seat hints are chosen so
   that the *landform itself* decides where the fight happens: a
   river between two banks, a strait between two islands, a plateau
   in the middle of four corners.
   ============================================================ */
export const MAP_TYPES = [
  {
    id: 'confluence',
    name: 'Confluence / Danube',
    short: 'Danube',
    icon: 'fish',
    style: 'temperate',
    desc: 'A wide, winding navigable river cuts the map in two. Three shallow stone fords '
      + 'are the only dry crossings; tributaries feed the valley from the highlands. '
      + 'Warships own the channel, armies own the fords.',
    water: 0.22, naval: true, fords: 3, rivers: 3
  },
  {
    id: 'archipelago',
    name: 'Warring Islands',
    short: 'Islands',
    icon: 'ship',
    style: 'northern',
    desc: 'Four great landmasses split by deep straits, with a gold-rich island in the '
      + 'middle of the sea. Without a Dock and a fleet you are fighting half a map.',
    water: 0.52, naval: true, fords: 0, rivers: 0
  },
  {
    id: 'mediterranean',
    name: 'Inland Sea',
    short: 'Inland Sea',
    icon: 'fish',
    style: 'mediterranean',
    desc: 'A vast landlocked sea of Deep Sea Fish and trade, ringed by one continuous '
      + 'coast. Two narrow isthmuses are the only land route — and both are worth a castle.',
    water: 0.34, naval: true, fords: 2, rivers: 2
  },
  {
    id: 'highview',
    name: 'King of the Hill / Highview',
    short: 'Highview',
    icon: 'mountain',
    style: 'temperate',
    desc: 'An elevated plateau with cliff faces and four narrow ramps, ringed by a stone-'
      + 'walled moat. The Sacred Site stands on top. Holding the high ground is worth more '
      + 'than any army you can buy.',
    water: 0.16, naval: false, fords: 3, rivers: 1
  },
  {
    id: 'arabia',
    name: 'Dry Arabia / Oasis',
    short: 'Dry Arabia',
    icon: 'leaf',
    style: 'arid',
    desc: 'Golden dunes, a single lush oasis at the centre, palm groves and wide-open '
      + 'flanking plains. Almost no water: cavalry decides it.',
    water: 0.05, naval: false, fords: 0, rivers: 0
  },
  {
    id: 'headwaters',
    name: 'Headwaters / Riverlands',
    short: 'Riverlands',
    icon: 'leaf',
    style: 'temperate',
    desc: 'The river is born in the northern hills, gathers two tributaries in the '
      + 'floodplain and leaves the map as a broad navigable trunk. Oxbow lakes, '
      + 'reed beds and gravel bars — the richest, most awkward ground in the game.',
    water: 0.26, naval: true, fords: 2, rivers: 4
  }
];
export const MAP_TYPE_BY_ID = Object.fromEntries(MAP_TYPES.map((m) => [m.id, m]));
export const DEFAULT_MAP_TYPE = 'confluence';
export function mapTypeInfo(id) {
  if (id === 'classic') return MAP_TYPE_BY_ID[DEFAULT_MAP_TYPE];   // old saves
  return MAP_TYPE_BY_ID[id] || MAP_TYPE_BY_ID[DEFAULT_MAP_TYPE];
}
/** True when the id names a real archetype (the Forge Studio asks). */
export function isMapType(id) { return !!MAP_TYPE_BY_ID[id]; }

/* ---- landform helpers ------------------------------------------------ */

/** A soft elliptical island mask: 1 in the middle, 0 at the shore, warped. */
function islandMask(x, z, cx, cz, rx, rz, warp = 0.26, seed = 0) {
  const ang = Math.atan2(z - cz, x - cx);
  const wob = 1 + Math.sin(ang * 2.3 + seed) * warp + Math.sin(ang * 4.1 - seed * 1.6) * warp * 0.6;
  const d = Math.hypot((x - cx) / (rx * wob), (z - cz) / (rz * wob));
  return 1 - ss(0.55, 1.02, d);
}

/**
 * Terrace a slope: sharp lips, flat treads. This is what makes a river valley
 * read like a river valley from an RTS camera instead of a lumpy field.
 */
function terrace(h, start, width, steps) {
  const t = (h - start) / width;
  if (t <= 0) return h;
  const fl = Math.floor(t);
  const fr = t - fl;
  const k = clamp01((fr - 0.45) / 0.2);
  const shaped = fl + smoothstep(k);
  return start + Math.min(steps, shaped) * width;
}

/* ============================================================
   3. GENERATOR
   ============================================================ */

/**
 * Build the whole hydrological world.
 *
 * @param {number} seed
 * @param {string} mapTypeId  one of MAP_TYPES[].id
 * @param {object} opts  { res, size, navCells, flowSize, seats }
 * @returns {object} hydro — heights, per-cell channel data, domain grid,
 *                   flow texture, seats, strategic features.
 */
export function buildHydrology(seed = 20261, mapTypeId = DEFAULT_MAP_TYPE, opts = {}) {
  const info = mapTypeInfo(mapTypeId);
  const id = info.id;
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const res = opts.res || 128;
  const size = opts.size || 512;
  const half = size * 0.5;
  const n = res + 1;
  const cell = size / res;
  const nv = n * n;
  const seatCount = clamp(opts.seats | 0 || 2, 2, 4);

  const heights = new Float32Array(nv);
  const riverMask = new Float32Array(nv);      // 0..1 "inside a channel"
  const fordMask = new Uint8Array(nv);         // 1 inside a ford
  const flowVX = new Float32Array(nv);
  const flowVZ = new Float32Array(nv);

  /* --- 3.1 the river plan --------------------------------------------- */
  const rivers = [];
  const fords = [];
  const bridges = [];

  const add = (name, kind, controls, perSpan = 14) => {
    const r = new River(name, kind, splineSamples(
      controls, perSpan, rng() * 40));
    r.compile();
    rivers.push(r);
    return r;
  };

  if (id === 'confluence') {
    /* The trunk enters from the west edge, swings north of centre, dips
       south, and leaves to the east — a real meander, not a diagonal. */
    const phase = (rng() - 0.5) * 46;
    const trunk = add('The Danube', 'trunk', [
      { x: -half - 26, z: 26 + phase * 0.5, w: 13, d: -4.6 },
      { x: -168, z: 10 + phase, w: 16, d: -5.6 },
      { x: -96, z: -22 + phase * 0.7, w: 18, d: -6.6 },
      { x: -20, z: -6 + phase * 0.4, w: 20, d: -7.2 },
      { x: 58, z: 34 + phase * 0.5, w: 21, d: -7.4 },
      { x: 138, z: 20 + phase * 0.3, w: 19, d: -7.0 },
      { x: 208, z: -26 + phase * 0.6, w: 16, d: -6.0 },
      { x: half + 26, z: -18, w: 13, d: -4.8 }
    ], 16);
    /* Two tributaries, coming down out of the highlands, meeting the trunk. */
    add('The March', 'tributary', [
      { x: -206, z: 236, w: 5, d: -1.6 },
      { x: -168, z: 178, w: 7, d: -2.4 },
      { x: -118, z: 118, w: 9, d: -3.4 },
      { x: -78, z: 58, w: 11, d: -4.2 },
      { x: -46, z: 6, w: 13, d: -5.0 }
    ], 12);
    add('The Raab', 'tributary', [
      { x: 214, z: -238, w: 5, d: -1.6 },
      { x: 178, z: -184, w: 7, d: -2.4 },
      { x: 132, z: -118, w: 9, d: -3.4 },
      { x: 92, z: -46, w: 11, d: -4.2 },
      { x: 74, z: 8, w: 13, d: -5.0 }
    ], 12);
    /* Three fords spread along the navigable stretch. */
    for (const fx of [-146, -2, 140]) {
      const st = nearestStation(trunk, fx);
      if (st) fords.push({ x: st.x, z: st.z, radius: 15, kind: 'stone ford', angle: Math.atan2(st.tz, st.tx) });
    }
  } else if (id === 'headwaters') {
    /* Born in the northern hills, flowing south into a wide trunk. */
    const trunk = add('Headwater', 'trunk', [
      { x: -92, z: -half - 20, w: 3.5, d: -1.0 },
      { x: -70, z: -196, w: 5.5, d: -2.0 },
      { x: -36, z: -142, w: 8, d: -3.2 },
      { x: -14, z: -84, w: 11, d: -4.4 },
      { x: -22, z: -26, w: 14, d: -5.8 },
      { x: -6, z: 34, w: 17, d: -6.8 },
      { x: 26, z: 96, w: 19, d: -7.4 },
      { x: 18, z: 168, w: 19, d: -7.4 },
      { x: 44, z: half + 24, w: 17, d: -6.8 }
    ], 14);
    add('Cold Beck', 'tributary', [
      { x: -244, z: -96, w: 3, d: -1.4 },
      { x: -186, z: -60, w: 4.5, d: -2.0 },
      { x: -128, z: -40, w: 6, d: -2.6 },
      { x: -64, z: -34, w: 7.5, d: -3.2 },
      { x: -18, z: -30, w: 8.5, d: -3.8 }
    ], 12);
    add('The Went', 'tributary', [
      { x: 246, z: 62, w: 3.2, d: -1.4 },
      { x: 190, z: 78, w: 4.6, d: -2.0 },
      { x: 134, z: 88, w: 6.2, d: -2.8 },
      { x: 80, z: 98, w: 8, d: -3.4 },
      { x: 34, z: 100, w: 9, d: -4.0 }
    ], 12);
    /* An oxbow: a half-moon of old channel left behind by the trunk. */
    const ox = new River('Old Race', 'lake',
      ringSamples(126, -128, 34, 26, 0.16, rng() * TAU, -3.4, (a) => 6.5 + Math.sin(a * 2) * 1.6, 64));
    ox.compile();
    rivers.push(ox);
    /* The oxbow is a closed loop: give it a beach and make it reachable. */
    for (const fx of [-40, 80]) {
      const near = nearestRiverPointAt(rivers, fx, +1);
      if (near) fords.push({ x: near.x, z: near.z, radius: 14, kind: 'stone ford', angle: near.angle });
    }
    void trunk;
  } else if (id === 'highview') {
    /* A moat ring, fed by a stream from the north-west. */
    const moat = new River('Moat', 'moat',
      ringSamples(0, 0, 122, 112, 0.035, rng() * TAU, -4.2, 9.5, 120));
    moat.compile();
    rivers.push(moat);
    /* A feeder stream that actually joins the moat, so the water has a source. */
    add('Millrace', 'tributary', [
      { x: -238, z: -110, w: 3.4, d: -1.6 },
      { x: -196, z: -128, w: 4.6, d: -2.2 },
      { x: -160, z: -146, w: 5.5, d: -2.8 },
      { x: -128, z: -142, w: 6.4, d: -3.4 }
    ], 10);
    /* Three stone bridges across the moat, on the three walkable ramps. */
    for (const a of [-1.15, 0.9, 2.75]) {
      const rx = Math.cos(a), rz = Math.sin(a);
      let best = null, bd = 1e9;
      for (const st of moat.samples) {
        const d = Math.hypot(st.x - rx * 120, st.z - rz * 110);
        if (d < bd) { bd = d; best = st; }
      }
      if (best) {
        const ang = Math.atan2(best.z, best.x);
        bridges.push({ x: best.x, z: best.z, radius: 13, angle: ang, length: 26, deck: 2.1 });
        /* A bridge is a crossing, so it is also a ford as far as the
           navigation domain is concerned -- the difference is only the deck
           the renderer lays on it and the fact that a hull cannot pass. */
        fords.push({ x: best.x, z: best.z, radius: 13, angle: ang + Math.PI / 2, kind: 'stone bridge' });
      }
    }
  } else if (id === 'mediterranean') {
    /* Two short rivers feeding the inland sea. */
    add('River Aufidus', 'tributary', [
      { x: -244, z: 182, w: 4, d: -1.8 },
      { x: -206, z: 128, w: 5.5, d: -2.4 },
      { x: -172, z: 74, w: 7, d: -3.0 },
      { x: -150, z: 30, w: 8, d: -3.6 }
    ], 12);
    add('River Metaurus', 'tributary', [
      { x: 236, z: -196, w: 4, d: -1.8 },
      { x: 202, z: -142, w: 5.5, d: -2.4 },
      { x: 172, z: -86, w: 7, d: -3.0 },
      { x: 158, z: -34, w: 8, d: -3.6 }
    ], 12);
    for (const a of [-2.35, 1.05]) {
      const x = Math.cos(a) * 176, z = Math.sin(a) * 168;
      fords.push({ x, z, radius: 17, kind: 'isthmus', angle: a });
    }
  } else if (id === 'arabia') {
    /* A wadi: a real channel that is dry most of the year. Shallow, walkable
       everywhere, and it makes the open plain legible. */
    /* A wadi is a channel that is DRY: the bed sits a few centimetres above
       the water table, so it is a sandy road across the plain and its banks
       still catch the flash flood the shader draws as a damp sheen. */
    add('Wadi Rum', 'wadi', [
      { x: -half - 20, z: -64, w: 6, d: 0.16 },
      { x: -166, z: -30, w: 7.5, d: 0.12 },
      { x: -92, z: 6, w: 9, d: 0.08 },
      { x: -24, z: -14, w: 10, d: 0.05 },
      { x: 62, z: 20, w: 9, d: 0.07 },
      { x: 150, z: -6, w: 7.5, d: 0.12 },
      { x: half + 20, z: -34, w: 6, d: 0.16 }
    ], 14);
  }

  /* --- 3.2 nearest-river field (one pass, all rivers) ------------------ */
  /* The macro landform needs to know how far the river is before the channel
     is cut, and the carve needs the exact station data. Both come from this
     one scan so the generator only walks the segment list once. */
  const nearD = new Float32Array(nv);
  const nearW = new Float32Array(nv);
  const nearBed = new Float32Array(nv);
  const nearSide = new Float32Array(nv);
  const nearCurve = new Float32Array(nv);
  const nearTx = new Float32Array(nv);
  const nearTz = new Float32Array(nv);
  const nearT = new Float32Array(nv);
  const nearKind = new Uint8Array(nv);      // index into rivers
  const probe = { d: 0, t: 0, w: 0, bed: 0, tx: 0, tz: 0, side: 1, curve: 0, seg: 0 };
  const KIND_TRUNK = 0, KIND_TRIB = 1, KIND_MOAT = 2, KIND_WADI = 3, KIND_LAKE = 4;
  const kindCode = (k) => (k === 'trunk' ? KIND_TRUNK : k === 'tributary' ? KIND_TRIB
    : k === 'moat' ? KIND_MOAT : k === 'wadi' ? KIND_WADI : KIND_LAKE);

  for (let j = 0; j < n; j++) {
    const wz = j * cell - half;
    for (let i = 0; i < n; i++) {
      const wx = i * cell - half;
      const k = j * n + i;
      let bestRatio = 1e9, bestD = 1e9, bi = -1;
      for (let r = 0; r < rivers.length; r++) {
        rivers[r].nearest(wx, wz, probe);
        const ratio = probe.d / probe.w;
        if (ratio < bestRatio) {
          bestRatio = ratio; bestD = probe.d; bi = r;
          nearD[k] = probe.d; nearW[k] = probe.w; nearBed[k] = probe.bed;
          nearSide[k] = probe.side; nearCurve[k] = probe.curve;
          nearTx[k] = probe.tx; nearTz[k] = probe.tz; nearT[k] = probe.t;
        }
      }
      if (bi < 0) { nearD[k] = 1e6; nearW[k] = 1; nearBed[k] = -1; }
      nearKind[k] = bi < 0 ? 255 : kindCode(rivers[bi].kind);
    }
  }

  /* --- 3.3 macro landform --------------------------------------------- */
  const valleys = {};

  const macro = (x, z, k) => {
    const dm = nearD[k];
    switch (id) {
      case 'confluence': {
        /* Terraced valley: the ground climbs away from the river in steps. */
        const nx = x / 120, nz = z / 120;
        let h = 3.2 + fbm2(nx * 0.85 + 3.3, nz * 0.85 - 1.7, 4) * 4.6;
        const hillside = ss(26, 150, dm);
        h += hillside * (6.5 + ridged2(nx * 1.7 + 8.1, nz * 1.7 - 2.4, 4) * 25
          * (0.35 + 0.65 * ss(60, 190, dm)));
        h += fbm2(nx * 5.4, nz * 5.4, 2) * 0.7;
        h = terrace(h, 7.5, 3.6, 7);
        /* Border: the land rises into wooded highlands. No water rim. */
        const rim = ss(206, 258, Math.max(Math.abs(x), Math.abs(z)));
        h += rim * (16 + fbm2(x * 0.02, z * 0.02, 3) * 9);
        return h;
      }
      case 'headwaters': {
        const nx = x / 120, nz = z / 120;
        let h = 3.6 + fbm2(nx * 0.8 - 5.1, nz * 0.8 + 2.2, 4) * 5.2;
        const north = ss(0, 210, -z);                 // higher in the north
        h += north * (16 + ridged2(nx * 1.6 - 3.3, nz * 1.6 + 6.6, 4) * 20);
        h += ss(20, 130, dm) * (4.5 + ridged2(nx * 2.1, nz * 2.1, 3) * 9);
        h += fbm2(nx * 6.2 + 1, nz * 6.2 - 4, 2) * 0.65;
        h = terrace(h, 6.5, 3.2, 8);
        const rim = ss(210, 258, Math.max(Math.abs(x), Math.abs(z)));
        h += rim * (12 + fbm2(x * 0.03, z * 0.03, 3) * 7);
        return h;
      }
      case 'archipelago': {
        /* Four great islands plus a wealthy centre, deep water between. */
        const isles = [
          [-140, 132, 116, 104, 0.9], [146, -128, 112, 104, 2.1],
          [150, 146, 96, 92, 3.4], [-148, -140, 98, 94, 0.2],
          [2, 4, 66, 58, 1.4], [40, 176, 44, 40, 2.7], [-196, 16, 40, 46, 5.0]
        ];
        let m = 0;
        for (let q = 0; q < isles.length; q++) {
          const [cx, cz, rx, rz, sd] = isles[q];
          m = Math.max(m, islandMask(x, z, cx, cz, rx, rz, 0.24, sd));
        }
        const rough = fbm2(x / 58, z / 58, 4) * 4.2 + ridged2(x / 92, z / 92, 3) * 5.4;
        let h = lerp(DEEP_BED - 2.0, 4.2 + rough, m);
        h += fbm2(x / 150, z / 150, 2) * 1.4 * (1 - m);
        return h;
      }
      case 'mediterranean': {
        /* A landlocked sea: a big warped basin, ringed by continuous coast. */
        const ang = Math.atan2(z, x);
        const wob = 1 + Math.sin(ang * 2.7 + 1.1) * 0.10 + Math.sin(ang * 4.3 - 2.0) * 0.06;
        const rr = Math.hypot(x / (118 * wob), z / (108 * wob));
        const sea = 1 - ss(0.86, 1.06, rr);
        let floor = DEEP_BED - 1.0 + fbm2(x / 70, z / 70, 3) * 2.2;
        let land = 4.4 + fbm2(x / 96, z / 96, 4) * 5.4
          + ss(150, 232, Math.hypot(x, z)) * (8 + ridged2(x / 70, z / 70, 3) * 10);
        let h = lerp(land, floor, sea);
        /* Two isthmuses: the only land route across the sea. */
        for (const a of [-2.35, 1.05]) {
          const cx = Math.cos(a), cz = Math.sin(a);
          const along = x * cx + z * cz;
          const across = Math.abs(-x * cz + z * cx);
          if (along > 0 && across < 11) {
            const k2 = ss(11, 5, across) * ss(0, 26, along) * ss(232, 190, along);
            h = Math.max(h, lerp(h, 1.6 + fbm2(x / 34, z / 34, 2) * 0.5, k2));
          }
        }
        /* Two small islands for the fleet to fight over. */
        for (const [cx, cz, rx, rz, sd] of [[-52, 44, 26, 22, 1.2], [58, -40, 22, 19, 3.6]]) {
          const m = islandMask(x, z, cx, cz, rx, rz, 0.3, sd);
          h = Math.max(h, lerp(h, 3.0 + fbm2(x / 20, z / 20, 2) * 1.6, m));
        }
        h += fbm2(x / 140, z / 140, 2) * 0.8;
        return h;
      }
      case 'highview': {
        /* A plateau with real cliff faces and four narrow ramps. */
        let ramp = 0;
        for (const a of [-1.15, 0.9, 2.75, 4.35]) {
          const dx = Math.cos(a), dz = Math.sin(a);
          const along = x * dx + z * dz;
          const across = Math.abs(-x * dz + z * dx);
          if (along > 0) ramp = Math.max(ramp, ss(22, 12, across) * ss(0, 40, along) * ss(210, 170, along));
        }
        const r = Math.hypot(x / 116, z / 110);
        const cliff = ss(1.02 + ramp * 0.30, 0.80 - ramp * 0.26, r);
        let h = 3.4 + fbm2(x / 105, z / 105, 4) * 4.4 + ridged2(x / 150, z / 150, 3) * 5.0;
        h += cliff * (15.5 + fbm2(x / 48, z / 48, 3) * 2.4);
        h = terrace(h, 9, 3.0, 6);
        const rim = ss(214, 258, Math.max(Math.abs(x), Math.abs(z)));
        h += rim * (11 + fbm2(x * 0.03, z * 0.03, 3) * 6);
        return h;
      }
      case 'arabia': {
        const nx = x / 118, nz = z / 118;
        const dunes = ridged2(nx * 1.15 + 2.2, nz * 1.15 - 1.4, 4) * 6.4;
        let h = 4.8 + fbm2(nx * 0.68, nz * 0.68, 4) * 3.0 + dunes
          + noise2(nx * 3.1, nz * 3.1) * 0.8;
        /* The oasis: a real basin below the water table with a green rim. */
        const d = Math.hypot(x / 40, z / 34);
        const basin = ss(1.0, 0.42, d);
        h = lerp(h, -2.4, basin);
        const rim2 = ss(1.5, 1.0, d) * ss(0.72, 0.96, d);
        h += rim2 * 2.0;
        /* Dunes grow toward the border, framing the plain. */
        const rim = ss(200, 258, Math.max(Math.abs(x), Math.abs(z)));
        h += rim * (7 + ridged2(x * 0.02, z * 0.02, 3) * 12);
        return h;
      }
      default: {
        return 4 + fbm2(x / 100, z / 100, 4) * 5;
      }
    }
  };

  for (let j = 0; j < n; j++) {
    const wz = j * cell - half;
    for (let i = 0; i < n; i++) {
      const wx = i * cell - half;
      const k = j * n + i;
      heights[k] = macro(wx, wz, k);
    }
  }

  /* --- 3.4 seats -------------------------------------------------------
     A seat is a fair place to start: flat, above the water table, and — on a
     river map — on a *particular* bank. The map decides where the fight is,
     so the seat hints come from the landform, not from a fixed corner list. */
  const sample = (x, z) => {
    const fx = clamp((x + half) / cell, 0, res - 0.0001);
    const fz = clamp((z + half) / cell, 0, res - 0.0001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const r = j0 => (z0 + j0) * n;
    const a = heights[r(0) + x0], b = heights[r(0) + x0 + 1];
    const c = heights[r(1) + x0], d = heights[r(1) + x0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  };
  const slopeAt = (x, z) => {
    const d = cell * 0.8;
    return Math.hypot(sample(x + d, z) - sample(x - d, z),
      sample(x, z + d) - sample(x, z - d)) / (2 * d);
  };

  /* --- 3.5 carve -------------------------------------------------------
     The channel profile. For every vertex we know the nearest river, its
     half-width, its bed, and which side we are on. The bed is deepest in the
     middle, rises through a shallow shelf to the waterline at the bank, then
     climbs through a low floodplain to the terraces. The deep line is pushed
     toward the outside of a bend, which is what leaves a point bar on the
     inside — the thing your eye reads as "a river". */
  for (let j = 0; j < n; j++) {
    const wz = j * cell - half;
    for (let i = 0; i < n; i++) {
      const wx = i * cell - half;
      const k = j * n + i;
      const d = nearD[k];
      const w = nearW[k];
      const kind = nearKind[k];
      const bed = nearBed[k];
      const macroH = heights[k];
      if (kind === 255 || d > w * 6.5) {
        /* No channel here. Still record an ambient flow so the shader's
           normals keep moving on open water. */
        flowVX[k] = -wz / (half * 2.2);
        flowVZ[k] = wx / (half * 2.2);
        continue;
      }
      const isWadi = kind === KIND_WADI;
      const isLake = kind === KIND_LAKE;
      /* Point bars and the thalweg. The deepest line of a real channel hugs
         the OUTSIDE of a bend and leaves a gravel bar on the inside; that is
         the single strongest cue that a river has direction, and it costs one
         multiply. `shift` moves the thalweg off centre by up to 30 % of the
         half-width. */
      const shift = nearCurve[k] * nearSide[k];
      /* A natural bank wanders: bays bite into the meadow, spurs push out into
         the current, and the waterline has a grain at a few metres. The wobble
         is a pure function of world position, so it is identical every load and
         the domain grid, the heightfield and the shader all agree about it. */
      /* The wobble multiplies BOTH the half-width and the distance, so it
         bends the waterline without creating the long flat shelf that a
         width-only wobble leaves behind (a widened bank, held at the carve's
         +3 cm waterline, became a 70 m beach). */
      const wob = 1 + 0.20 * noise2(wx * 0.019 + 3.7, wz * 0.019 - 1.3)
        + 0.10 * noise2(wx * 0.061 - 8.1, wz * 0.061 + 5.5)
        + 0.045 * noise2(wx * 0.185 + 2.2, wz * 0.185 - 9.4);
      const rel = Math.max(0, d / w / wob + shift * 0.30);
      /* A bank is a bank: by the outside edge of the channel the ground is
         already 90 cm above the water, so the waterline itself (where the
         carve passes 0) is a few metres wide instead of a shelf. This is what
         stops the generator producing 60 m beaches. */
      const floodLevel = isWadi ? 0.55 : (isLake ? 1.0 : 1.15);
      const BANK_LIP = isWadi ? 0.5 : (isLake ? 0.75 : 0.90);
      let channelH;
      let mask = 0;
      if (rel < 1) {
        /* A real cross-section, not a V. Out to ~60 % of the half-width the
           bed sits at full depth (the thalweg and the navigable channel);
           the last 40 % is the shallow shoulder where a hull grounds and a
           soldier can wade to his knees. That plateau is what gives the
           depth-based colour something to colour. */
        const shoulder = smoothstep(clamp01((rel - 0.58) / 0.42));
        channelH = lerp(bed, BANK_LIP, shoulder * shoulder);
        mask = 1;
      } else if (rel < 2.4) {
        /* The bank and the floodplain, climbing out of the waterline. */
        const t = smoothstep(clamp01((rel - 1) / 1.4));
        channelH = lerp(BANK_LIP, floodLevel, t);
        mask = (1 - t) * 0.9;
      } else {
        const t = smoothstep(clamp01((rel - 2.4) / 4.1));
        channelH = floodLevel + t * 0.6;
        mask = Math.max(0, 1 - t) * 0.16;
      }
      /* A wadi is a dry bed: no waterline, just a sandy channel, and it is
         never allowed to dip under the water table and become a stream. */
      if (isWadi) channelH = clamp(channelH, 0.05, 0.9);
      /* Blend with the macro landform. The channel is a *cut*, so the carve
         can only ever lower the ground; it never builds a levy out of nothing. */
      const weight = 1;
      let h = lerp(macroH, Math.min(macroH, channelH), weight);
      /* Micro-relief that fades out inside the water, so the bed stays legible
         through the surface. */
      h += fbm2(wx * 0.045 + 11, wz * 0.045 - 7, 2) * 0.55 * (1 - mask * 0.85) * lerp(0, 1, ss(1, 2.6, rel));
      heights[k] = h;
      riverMask[k] = mask;
      const fl = Math.hypot(nearTx[k], nearTz[k]) || 1;
      flowVX[k] = nearTx[k] / fl;
      flowVZ[k] = nearTz[k] / fl;
    }
  }

  /* --- 3.6 fords -------------------------------------------------------
     A ford is a paved shelf lifted to 22 cm under the surface: it is a real
     crossing for land units (AMPHIBIOUS) and still floats a shallow hull, so
     the fleet and the army fight over the same ground. */
  for (const f of fords) {
    const r = f.radius;
    const i0 = Math.max(0, Math.floor((f.x - r + half) / cell));
    const i1 = Math.min(res, Math.ceil((f.x + r + half) / cell));
    const j0 = Math.max(0, Math.floor((f.z - r + half) / cell));
    const j1 = Math.min(res, Math.ceil((f.z + r + half) / cell));
    for (let j = j0; j <= j1; j++) {
      const wz = j * cell - half;
      for (let i = i0; i <= i1; i++) {
        const wx = i * cell - half;
        const dd = Math.hypot(wx - f.x, wz - f.z);
        if (dd > r) continue;
        const k = j * n + i;
        /* The shelf is wider across the flow than along it. */
        const along = Math.abs((wx - f.x) * Math.cos(f.angle) + (wz - f.z) * Math.sin(f.angle));
        const across = Math.abs(-(wx - f.x) * Math.sin(f.angle) + (wz - f.z) * Math.cos(f.angle));
        const shape = clamp01(1 - Math.max(along / (r * 0.62), across / r));
        if (shape <= 0) continue;
        const t = smoothstep(shape);
        heights[k] = Math.max(heights[k], lerp(heights[k], SHALLOW_BED, t));
        heights[k] = Math.min(heights[k], lerp(heights[k], SHALLOW_BED, t));
        /* A ford cell is a cell you can WADE. The ellipse's rim only lifts
           the bed a few centimetres, so marking the whole ellipse as ford
           declared seven metres of river "walkable" and the AI duly walked
           an army into it. Only cells that actually reached wading depth
           count; the rest stay open water and the pathfinder routes around
           them. */
        if (heights[k] > FORD_WADE_LIMIT) {
          fordMask[k] = 1;
          riverMask[k] = Math.max(riverMask[k], t * 0.8);
        }
      }
    }
  }
  /* Bridge cuttings: the deck is walkable across the moat. */
  for (const b of bridges) {
    const r = b.radius;
    for (let j = Math.max(0, Math.floor((b.z - r + half) / cell)); j <= Math.min(res, Math.ceil((b.z + r + half) / cell)); j++) {
      const wz = j * cell - half;
      for (let i = Math.max(0, Math.floor((b.x - r + half) / cell)); i <= Math.min(res, Math.ceil((b.x + r + half) / cell)); i++) {
        const wx = i * cell - half;
        if (Math.hypot(wx - b.x, wz - b.z) > r) continue;
        fordMask[j * n + i] = 2;      // 2 = bridge deck (walkable, not navigable)
      }
    }
  }

  /* --- 3.6b seats -------------------------------------------------------
     Chosen after the carve, so a town can never find itself in the river it
     was meant to stand beside. Scored over the whole finished landform.
     not an offset from a control point. A candidate has to be dry, flat,
     buildable over a 20 m apron, near the feature its archetype cares about
     (a river bank, a coast), far from the border highlands, and far from
     every seat already chosen. On the river maps the second town is forced
     onto the other bank, which is what makes the crossing matter. */
  const seats = [];
  const seatRng = mulberry32((seed ^ 0x2545f491) >>> 0);
  const trunkRiver = rivers.find((r) => r.kind === 'trunk') || rivers[0] || null;
  const trunkProbe = { d: 0, t: 0, w: 0, bed: 0, tx: 0, tz: 0, side: 1, curve: 0, seg: 0 };
  const riverSep = (x, z) => {
    if (!trunkRiver) return { d: 1e6, side: 0, t: 0 };
    trunkRiver.nearest(x, z, trunkProbe);
    return { d: trunkProbe.d, side: trunkProbe.side, t: trunkProbe.t };
  };
  const wantsRiver = id === 'confluence' || id === 'headwaters';
  const wantsCoast = id === 'mediterranean' || id === 'archipelago';

  const buildable = (x, z) => {
    if (sample(x, z) < 1.0) return false;
    if (slopeAt(x, z) > 0.24) return false;
    /* Four probes at the corners of the apron: a seat on a 20 m slope edge
       would flatten into a shelf you could not build a house on. */
    for (const [dx, dz] of [[16, 0], [-16, 0], [0, 16], [0, -16], [12, 12], [-12, -12]]) {
      const h = sample(x + dx, z + dz);
      if (h < 0.3 || slopeAt(x + dx, z + dz) > 0.42) return false;
      if (Math.abs(h - sample(x, z)) > 3.4) return false;
    }
    return true;
  };

  /* How much of the apron sits within half a metre of the waterline: a town
     wall on wet ground floods, and a hall whose floor is a metre above the
     river is a hall that has to be rebuilt every spring. */
  const slopeWet = (x, z, h) => {
    let wet = 0;
    for (const [dx, dz] of [[14, 0], [-14, 0], [0, 14], [0, -14], [10, 10], [-10, -10]]) {
      const o = sample(x + dx, z + dz);
      if (o < 0.75) wet += 1 - o / 0.75;
    }
    return wet;
  };

  const scoreSeat = (x, z, q) => {
    const h = sample(x, z);
    const sl = slopeAt(x, z);
    /* Where towns can stand. These maps are a floodplain at about 1-1.8 m
       with the highlands starting at 20 m, so the band between "dry" and
       "the tree line" has to include the floodplain or there is nothing to
       choose from: a 3 m floor left the search with one candidate cell.
       Anything under a metre of the waterline is still out. */
    if (h < 1.05 || h > 18) return -1e9;
    let score = 60 - sl * 120 - Math.max(0, h - 12) * 2.2;
    score += Math.min(14, h * 3.4);              // the higher bank drains better
    score -= slopeWet(x, z, h) * 40;
    /* Waste ground: never in a corner, always with room to grow.
       The band is wide because a town needs more than its own apron: the
       starting valley that the fog reveals is a ~95 m ragged disc, and a
       seat 40 m from the map edge has that disc sliced off by the border --
       the player opens the match looking at a flat, walled-in half-valley. */
    score -= Math.max(0, Math.abs(x) - 150) * 2.6;
    score -= Math.max(0, Math.abs(z) - 150) * 2.6;
    if (wantsRiver) {
      const r = riverSep(x, z);
      /* 62-104 m from the channel: close enough to dock a boat on it,
         far enough that the town apron never spills into the bed. */
      score += 46 - Math.abs(r.d - 84) * 0.55;
      if (r.d < 40) score -= 120;
      return score;
    }
    if (wantsCoast) {
      /* A seat wants a shore: walk outward until the ground drops below the
         waterline, and score the distance. */
      let sea = 1e6;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * TAU;
        for (let d = 8; d <= 96; d += 6) {
          if (sample(x + Math.cos(ang) * d, z + Math.sin(ang) * d) < WATER_LEVEL - 0.6) { sea = Math.min(sea, d); break; }
        }
      }
      score += 40 - Math.abs(sea - 34) * 0.7;
      if (sea > 96) score -= 90;
      return score;
    }
    /* Highview / Arabia: just a good, flat, central-ish plot. */
    score += 30 - Math.hypot(x, z) * 0.08;
    return score;
  };

  const CAND = 72;
  for (let q = 0; q < seatCount; q++) {
    let best = null, bestScore = -1e9;
    const prev = seats[0] || null;
    const prevRiver = prev ? riverSep(prev.x, prev.z) : null;
    /* Separation is a preference, not a veto. A four-crown match on a map
       with one big landmass used to come back with two seats and the other
       two crowns simply had nowhere to spawn; the search now steps the
       spacing down until every crown has ground of its own. */
    /* Never below 96 m: two towns closer than that share a woodpile, an
       army walks between them in ten seconds, and the map stops being a
       war. If the fine ground cannot honour it, the map needs a seat on the
       high terrace, not a neighbour next door. */
    const minSep = [160, 132, 108, 96][Math.min(3, q)];
    for (let cz = 0; cz < CAND; cz++) {
      for (let cx = 0; cx < CAND; cx++) {
        const x = (cx + 0.5) / CAND * size - half;
        const z = (cz + 0.5) / CAND * size - half;
        /* Keep 105 m of margin: the whole surveyed valley, plus the room a
           town needs to expand, has to fit inside the map. */
        if (Math.abs(x) > half - 105 || Math.abs(z) > half - 105) continue;
        if (!buildable(x, z)) continue;
        /* Separation: enough room for two towns and a fight between them. */
        if (seats.some((s) => Math.hypot(s.x - x, s.z - z) < minSep)) continue;
        let score = scoreSeat(x, z, q);
        if (score < -1e8) continue;
        if (wantsRiver && prevRiver && q > 0) {
          const r = riverSep(x, z);
          /* Opposite banks. Without this the map is a two-town race along
             one shore and the river is scenery instead of a border. */
          score += r.side === prevRiver.side ? -260 : 90;
          /* And a real reach of water between them, not a hairpin. */
          score += Math.min(60, Math.abs(r.t - prevRiver.t) * 150);
        }
        /* A four-crown map wants the seats spread out; a duel wants them
           opposite each other rather than adjacent. The pull has to be
           strong enough to beat the flat-ground bonus of the best meadow,
           or every extra crown lands in the same corner. */
        if (prev) score += Math.min(150, Math.hypot(x - prev.x, z - prev.z) * 0.85);
        score += seatRng() * 6;                      // no two seeds alike
        if (score > bestScore) { bestScore = score; best = { x, z, h: sample(x, z) }; }
      }
    }
    /* If no ground cleared the spacing, retake the pick with a looser
       separation rather than shipping a map with a crown that has no seat. */
    for (let relax = 0; !best && relax < 3; relax++) {
      const sep = Math.max(96, minSep * (0.92 - relax * 0.06));
      bestScore = -1e9;
      for (let cz = 0; cz < CAND; cz++) {
        for (let cx = 0; cx < CAND; cx++) {
          const x = (cx + 0.5) / CAND * size - half;
          const z = (cz + 0.5) / CAND * size - half;
          if (Math.abs(x) > half - 105 || Math.abs(z) > half - 105) continue;
          if (!buildable(x, z)) continue;
          if (seats.some((s) => Math.hypot(s.x - x, s.z - z) < sep)) continue;
          /* Relaxing the *spacing* must never relax the ground rules: a town
             on the 1.4 m floodplain is a town in a marsh, however far the
             other crowns are. */
          const base = scoreSeat(x, z, q);
          if (base < -1e8) continue;
          const score = base + seatRng() * 6;
          if (score > bestScore) { bestScore = score; best = { x, z, h: sample(x, z) }; }
        }
      }
    }
    if (best) {
      best.side = riverSep(best.x, best.z).side;
      best.near = wantsRiver ? 'river' : wantsCoast ? 'coast' : 'land';
      seats.push(best);
    }
  }
  while (seats.length < 2) {
    const a = seatRng() * TAU, d = 120 + seatRng() * 60;
    const x = clamp(Math.cos(a) * d, -half + 60, half - 60);
    const z = clamp(Math.sin(a) * d, -half + 60, half - 60);
    seats.push({ x, z, h: sample(x, z), near: 'land' });
  }

  /* --- 3.7 domain grid -------------------------------------------------- */
  const N = opts.navCells || 256;
  const navCell = size / N;
  const domain = new Uint8Array(N * N);
  const waterDepth = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const wz = (j + 0.5) * navCell - half;
    for (let i = 0; i < N; i++) {
      const wx = (i + 0.5) * navCell - half;
      const h = sample(wx, wz);
      const sl = slopeAt(wx, wz);
      /* Sample the ford/bridge mask at the nav cell centre. */
      const mx = clamp(Math.round((wx + half) / cell), 0, res);
      const mz = clamp(Math.round((wz + half) / cell), 0, res);
      const fm = fordMask[mz * n + mx];
      let d;
      if (sl > 1.05) d = DOMAIN.BLOCKED;
      else if (fm === 1) d = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
      else if (fm === 2) d = DOMAIN.LAND_ONLY;
      else if (h < WATER_LEVEL - FLOAT_DEPTH) d = DOMAIN.WATER_ONLY;
      else if (h < WATER_LEVEL + 0.22) d = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
      else d = DOMAIN.LAND_ONLY;
      domain[j * N + i] = d;
      waterDepth[j * N + i] = WATER_LEVEL - h;
    }
  }
  /* A ford that is a single nav cell wide is not a crossing, it is a trap. */
  widenFords(domain, N, navCell, half, fords, 2, { heights, res, n, cell });

  const domainAt = (x, z) => {
    const cx = clamp(((x + half) / navCell) | 0, 0, N - 1);
    const cz = clamp(((z + half) / navCell) | 0, 0, N - 1);
    return domain[cz * N + cx];
  };

  /* --- 3.8 flow / depth / foam texture ---------------------------------- */
  const F = opts.flowSize || 256;
  const flowData = new Uint8Array(F * F * 4);
  const flow = buildFlowTexture(F, size, half, sample, flowVX, flowVZ, riverMask, nearD, nearW, n, cell, res);

  /* --- 3.9 strategic features ------------------------------------------- */
  const stealthForests = [];
  const sacredSites = [];
  const tradePosts = [];
  const deepFish = [];
  const shoreFish = [];
  const extraGold = [];
  const palmGroves = [];
  const reedBeds = [];
  const gravelBars = [];

  const featRng = mulberry32((seed ^ 0x7f4a7c15) >>> 0);
  const nearSeat = (x, z, r) => seats.some((s) => Math.hypot(x - s.x, z - s.z) < r);

  const spot = (need, minR, maxR, tries = 90) => {
    for (let t = 0; t < tries; t++) {
      const a = featRng() * TAU, dist = minR + featRng() * (maxR - minR);
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      const h = sample(x, z);
      const sl = slopeAt(x, z);
      if (need === 'land' && (h < 1.0 || sl > 0.34)) continue;
      if (need === 'shore' && (h < -0.75 || h > 0.35)) continue;
      if (need === 'deep' && h > -2.2) continue;
      if (need === 'flat' && (h < 1.4 || sl > 0.16)) continue;
      if (nearSeat(x, z, 46)) continue;
      if (Math.max(Math.abs(x), Math.abs(z)) > half - 26) continue;
      return { x, z, y: h };
    }
    return null;
  };

  /* Sacred sites: three of them, spread out and never on water. */
  for (let i = 0; i < 3; i++) {
    let s = null;
    for (let a = 0; a < 10 && !s; a++) {
      const cand = i === 0 ? spot('flat', 0, 62, 120) || spot('land', 40, 120, 90)
        : spot('land', 60, half - 40, 110);
      if (cand && sacredSites.every((o) => Math.hypot(cand.x - o.x, cand.z - o.z) >= 46)) s = cand;
    }
    if (s) sacredSites.push({ x: s.x, z: s.z, y: s.y, type: 'sacred_site', id: `sacred-${i}`, claimed: 0 });
  }

  /* Stealth forests: tall-canopy stands on good ground. */
  const forestCount = id === 'arabia' ? 2 : id === 'highview' ? 6 : 5;
  for (let i = 0; i < forestCount; i++) {
    const s = spot('land', 54, half - 46, 110);
    if (s) stealthForests.push({ x: s.x, z: s.z, y: s.y, radius: 14 + featRng() * 11, id: `stealth-${i}` });
  }

  if (info.naval) {
    for (let i = 0; i < 4; i++) {
      const s = spot('shore', 60, half - 30, 120);
      if (s) tradePosts.push({ x: s.x, z: s.z, y: s.y, type: 'trade_post', id: `trade-${i}` });
    }
    for (let i = 0; i < 20; i++) {
      const s = spot('deep', 30, half - 24, 130);
      if (s) deepFish.push({ x: s.x, z: s.z, y: WATER_LEVEL, amount: 1500, type: 'deep_fish' });
    }
    for (let i = 0; i < 16; i++) {
      const s = spot('shore', 24, half - 24, 130);
      if (s) shoreFish.push({ x: s.x, z: s.z, y: WATER_LEVEL, amount: 750, type: 'fish' });
    }
  }
  if (id === 'archipelago') {
    for (let i = 0; i < 10; i++) {
      const a = featRng() * TAU, d = 12 + featRng() * 46;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = sample(x, z);
      if (h > 1.2) extraGold.push({ x, z, y: h, amount: 1700 });
    }
  }
  if (id === 'arabia') {
    for (let i = 0; i < 30; i++) {
      const a = featRng() * TAU, d = 36 + featRng() * 30;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = sample(x, z);
      if (h > 0.6) palmGroves.push({ x, z, y: h, type: 'tree', palm: true });
    }
  }

  /* Reeds at the waterline and gravel bars in the channel: the two features
     that make a riverbank look like a riverbank. Both are decoration only. */
  for (let i = 0; i < 900; i++) {
    const x = (featRng() - 0.5) * (size - 24);
    const z = (featRng() - 0.5) * (size - 24);
    const k = clamp(Math.round((x + half) / cell), 0, res) + clamp(Math.round((z + half) / cell), 0, res) * n;
    if (nearKind[k] === 255) continue;
    const d = nearD[k], w = nearW[k];
    const rel = d / w;
    if (rel > 0.86 && rel < 1.18 && reedBeds.length < 620) {
      const h = sample(x, z);
      if (h > -0.7 && h < 0.45) reedBeds.push({ x, z, y: h, scale: 0.7 + featRng() * 0.7, rot: featRng() * TAU });
    } else if (rel < 0.75 && rel > 0.2 && gravelBars.length < 260) {
      const h = sample(x, z);
      if (h > -1.6 && h < -0.12) gravelBars.push({ x, z, y: h, scale: 0.6 + featRng() * 0.9, rot: featRng() * TAU });
    }
  }

  const hydro = {
    id, info, seed,
    style: info.style,
    res, n, cell, size, half,
    heights, riverMask, fordMask, flowVX, flowVZ,
    nearD, nearW, nearKind,
    sample, slopeAt, domainAt,
    domain, domainCells: N, domainCell: navCell, waterDepth,
    flowTex: { size: F, data: flowData },
    rivers: rivers.map((r) => ({
      kind: r.kind, name: r.name,
      points: r.samples.filter((_, i) => i % 3 === 0).map((p) => [p.x, p.z]),
      width: r.samples[0].w
    })),
    fords, bridges, seats,
    stealthForests, sacredSites, tradePosts, deepFish, shoreFish,
    extraGold, palmGroves, reedBeds, gravelBars,
    waterLevel: WATER_LEVEL,
    shallowBed: SHALLOW_BED,
    isNaval: !!info.naval,
    nodeKind: kindCode
  };
  return hydro;
}

/* ============================================================
   helpers
   ============================================================ */

/** Nearest station to a world x (used to place fords along a run). */
function nearestStation(river, x) {
  let best = null, bd = 1e9;
  for (const s of river.samples) {
    const d = Math.abs(s.x - x);
    if (d < bd) { bd = d; best = s; }
  }
  if (!best) return null;
  const i = river.samples.indexOf(best);
  const a = river.samples[Math.max(0, i - 1)], b = river.samples[Math.min(river.samples.length - 1, i + 1)];
  return { x: best.x, z: best.z, tx: b.x - a.x, tz: b.z - a.z, w: best.w };
}

/** Station at fraction t of a river's length (approximate but consistent). */
function stationAt(river, t) {
  const s = river.samples;
  if (!s.length) return null;
  const i = clamp(Math.round(t * (s.length - 1)), 0, s.length - 1);
  const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
  return { x: s[i].x, z: s[i].z, tx: b.x - a.x, tz: b.z - a.z, w: s[i].w };
}

/** First river point whose x is near `x` on the given side (headwaters fords). */
function nearestRiverPointAt(rivers, x, side) {
  let best = null, bd = 1e9;
  for (const r of rivers) {
    if (r.kind === 'lake') continue;
    for (let i = 1; i < r.samples.length; i++) {
      const a = r.samples[i - 1], b = r.samples[i];
      if ((a.z > 0) !== (b.z > 0)) continue;
      const d = Math.abs(b.x - x);
      if (d < bd && b.z * side > 0) { bd = d; best = { x: b.x, z: b.z, angle: Math.atan2(b.z - a.z, b.x - a.x) }; }
    }
  }
  return best;
}

/**
 * Choose a seat near a hint: flat, dry, above the water table, and far enough
 * from every other seat. Deterministic (the rng is seeded).
 */
function pickSeat(hint, sample, slopeAt, rng, taken, minGap, nearD, nearW, n, cell, half, id) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < 220; i++) {
    const a = rng() * TAU;
    const d = i < 140 ? rng() * (i < 70 ? 34 : 74) : rng() * 120;
    const x = clamp(hint.x + Math.cos(a) * d, -half + 30, half - 30);
    const z = clamp(hint.z + Math.sin(a) * d, -half + 30, half - 30);
    const h = sample(x, z);
    const sl = slopeAt(x, z);
    if (h < 1.15 || sl > 0.30) continue;
    if (taken.some((s) => Math.hypot(s.x - x, s.z - z) < minGap)) continue;
    /* Prefer: flat, a little high, near a river or coast (a dock is a real
       thing on these maps), and close to the hint. */
    const k = clamp(Math.round((x + half) / cell), 0, n - 1) + clamp(Math.round((z + half) / cell), 0, n - 1) * n;
    const riverDist = nearD ? nearD[k] : 1e6;
    let score = h * 0.35 - sl * 46 - Math.hypot(x - hint.x, z - hint.z) * 0.02;
    if (hint.near === 'river') score += 26 - Math.abs(riverDist - 84) * 0.34;
    else if (hint.near === 'coast') score += 8 - Math.abs(Math.hypot(x, z) - 178) * 0.1;
    if (score > bestScore) { bestScore = score; best = { x, z, h, side: hint.side, near: hint.near }; }
  }
  if (!best) {
    /* Nothing scored: take the hint itself if it is dry ground at all. */
    const h = sample(hint.x, hint.z);
    if (h > 0.6) best = { x: hint.x, z: hint.z, h, side: hint.side, near: hint.near };
  }
  return best;
}

/** Grow each ford by `rings` cells so a crossing is never a one-cell squeeze. */
function widenFords(domain, N, navCell, half, fords, rings, hfArgs) {
  const isFord = (v) => v === DOMAIN.AMPHIBIOUS_SHALLO_FORD;
  const grow = [];
  for (const f of fords) {
    const ci = clamp(((f.x + half) / navCell) | 0, 0, N - 1);
    const cj = clamp(((f.z + half) / navCell) | 0, 0, N - 1);
    const rad = Math.ceil(f.radius / navCell);
    for (let j = cj - rad; j <= cj + rad; j++) {
      for (let i = ci - rad; i <= ci + rad; i++) {
        if (i < 1 || j < 1 || i >= N - 1 || j >= N - 1) continue;
        if (!isFord(domain[j * N + i])) continue;
        /* Fill the orthogonal neighbours that are deep water, so the ford is
           a causeway rather than a stepping stone. The writes go to a list
           applied AFTER the scan: writing them in place let each new cell
           widen its own neighbours on the next iteration, so one 15 m ford
           crept along the entire river and declared seven metres of water
           "wading depth". Pathfinding believed it and drowned the army. */
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const idx = (j + dz) * N + (i + dx);
          if (domain[idx] === DOMAIN.WATER_ONLY) {
            const dist = Math.hypot((i + dx) * navCell - half - f.x, (j + dz) * navCell - half - f.z);
            if (dist < f.radius * 1.05) grow.push(idx);
          }
        }
      }
    }
  }
  /* The widened ring follows the *shelf*, not the grid: a neighbour is only
     wading depth if the bed there is one. Otherwise the ring bridges a deep
     channel beside a shallow ford and the army walks on water again. */
  const { heights, res, n: hn, cell: hc } = hfArgs;
  for (const idx of grow) {
    const ci2 = idx % N, cj2 = (idx / N) | 0;
    const wx = (ci2 + 0.5) * navCell - half;
    const wz = (cj2 + 0.5) * navCell - half;
    const mi = clamp(Math.round((wx + half) / hc), 0, res);
    const mj = clamp(Math.round((wz + half) / hc), 0, res);
    if (heights[mj * hn + mi] > FORD_WADE_LIMIT) domain[idx] = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
  }
}

/**
 * The 128x128 field the water shader samples:
 *   r,g = flow direction (unit, 0.5-centred)
 *   b   = depth of the bed below the surface, 0..6 m
 *   a   = shore/ford foam mask
 */
function buildFlowTexture(F, size, half, sample, flowVX, flowVZ, riverMask, nearD, nearW, n, cell, res) {
  const data = new Uint8Array(F * F * 4);
  for (let j = 0; j < F; j++) {
    const wz = (j / (F - 1)) * size - half;
    for (let i = 0; i < F; i++) {
      const wx = (i / (F - 1)) * size - half;
      const gx = clamp((wx + half) / cell, 0, res - 0.001);
      const gz = clamp((wz + half) / cell, 0, res - 0.001);
      const x0 = gx | 0, z0 = gz | 0;
      const tx = gx - x0, tz = gz - z0;
      const k00 = z0 * n + x0, k10 = k00 + 1, k01 = k00 + n, k11 = k01 + 1;
      const b00 = (1 - tx) * (1 - tz), b10 = tx * (1 - tz), b01 = (1 - tx) * tz, b11 = tx * tz;
      const vx = flowVX[k00] * b00 + flowVX[k10] * b10 + flowVX[k01] * b01 + flowVX[k11] * b11;
      const vz = flowVZ[k00] * b00 + flowVZ[k10] * b10 + flowVZ[k01] * b01 + flowVZ[k11] * b11;
      const h = sample(wx, wz);
      const depth = clamp01(Math.max(0, WATER_LEVEL - h) / 7.0);
      const shore = h - WATER_LEVEL < FOAM_DEPTH ? clamp01(1 - (h - WATER_LEVEL) / FOAM_DEPTH) : 0;
      const o = (j * F + i) * 4;
      data[o] = clamp(((vx * 0.5 + 0.5) * 255) | 0, 0, 255);
      data[o + 1] = clamp(((vz * 0.5 + 0.5) * 255) | 0, 0, 255);
      data[o + 2] = (depth * 255) | 0;
      data[o + 3] = (shore * 235) | 0;
    }
  }
  return data;
}

/**
 * Re-derive everything that depends on the *final* heightfield (after the
 * towns' plateaus have been levelled). Called by worldgen once the plateau
 * pass is done; cheap, because the carve is already baked.
 */
export function refreshHydrology(hydro, sampleHeight, slopeAt) {
  const { domain, domainCells: N, domainCell: navCell, half, fords } = hydro;
  for (let j = 0; j < N; j++) {
    const wz = (j + 0.5) * navCell - half;
    for (let i = 0; i < N; i++) {
      const wx = (i + 0.5) * navCell - half;
      const h = sampleHeight(wx, wz);
      const sl = slopeAt(wx, wz);
      let d;
      if (sl > 1.05) d = DOMAIN.BLOCKED;
      else if (h < WATER_LEVEL - FLOAT_DEPTH) d = DOMAIN.WATER_ONLY;
      else if (h < WATER_LEVEL + 0.22) d = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
      else d = DOMAIN.LAND_ONLY;
      domain[j * N + i] = d;
      hydro.waterDepth[j * N + i] = WATER_LEVEL - h;
    }
  }
  /* Restore the fords: the plateau pass never touches them, but the fresh
     domain pass above would otherwise erode their edges. */
  const { res, n, cell } = hydro;
  for (let j = 0; j < N; j++) {
    const wz = (j + 0.5) * navCell - half;
    for (let i = 0; i < N; i++) {
      const wx = (i + 0.5) * navCell - half;
      const mx = clamp(Math.round((wx + half) / cell), 0, res);
      const mz = clamp(Math.round((wz + half) / cell), 0, res);
      const fm = hydro.fordMask[mz * n + mx];
      if (fm === 1) domain[j * N + i] = DOMAIN.AMPHIBIOUS_SHALLO_FORD;
      else if (fm === 2) domain[j * N + i] = DOMAIN.LAND_ONLY;
    }
  }
  widenFords(domain, N, navCell, half, fords, 2, { heights: hydro.heights, res: hydro.res, n: hydro.n, cell: hydro.cell });
  return hydro;
}

/** Count of each domain state — used by the Forge Studio and the tests. */
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
 * the domain grid in place, then refreshes the flow texture.
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
      if (changed) {
        H.heights[k] = hf.h[k];
        if (brush === 'ford') H.fordMask[k] = 1;
      }
    }
  }
  if (!changed) return false;
  refreshHydrology(H, (px, pz) => hf.sample(px, pz), (px, pz) => hf.slope(px, pz));
  world.flowDirty = true;
  return true;
}

export default buildHydrology;
