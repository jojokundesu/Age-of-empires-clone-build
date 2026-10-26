/* ============================================================
   noise.js — CPU noise for texture baking (v3)

   Why this file exists
   --------------------
   v2 evaluated its whole art direction per pixel: the terrain shader alone
   ran ~40 value-noise octaves, ~500 sin() hashes and nine texture fetches for
   every fragment it covered. That is 2-3 GFLOP per frame at phone resolution
   -- more than an Adreno 610 can do at 60 Hz, which is exactly why the game
   crawled on the Realme 9i.

   None of that noise changes between frames. The meadow is where it is, the
   clouds drift one metre a second and the "damage" pattern on a wall is a
   function of world position. So we evaluate it ONCE, on the CPU, into
   textures, and the shader becomes a handful of fetches. The result looks
   *better* than the old procedural version (we can afford more octaves and
   proper mip-mapping) while costing an order of magnitude less.

   Everything here is integer-hash based (no Math.sin) so a bake is fast and
   bit-identical on every device -- the same map looks the same on a phone, a
   laptop and in the test harness.
   ============================================================ */

/** 2D integer hash -> [0,1). Deterministic on every JS engine. */
export function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 3D integer hash -> [0,1). */
export function hash3(ix, iy, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1]. */
export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Value noise that wraps exactly every `period` lattice cells. */
export function vnoiseWrap(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const p = period | 0;
  const m = (n) => ((n % p) + p) % p;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash2(x0, y0), b = hash2(x1, y0);
  const c = hash2(x0, y1), d = hash2(x1, y1);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal value noise in [0,1] (sum is normalised, so it stays in range). */
export function fbm(x, y, oct = 5, lac = 2.03, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(fx, fy);
    norm += amp;
    fx = fx * lac + 31.7; fy = fy * lac + 17.3;
    amp *= gain;
  }
  return sum / norm;
}

/** Seamless fbm over the unit square: u,v in [0,1). */
export function tileFbm(u, v, period, oct = 4, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, f = period;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoiseWrap(u * f, v * f, f);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged variant -- crests instead of blobs. Used for rock and cloud edges. */
export function tileRidge(u, v, period, oct = 4) {
  let sum = 0, amp = 0.5, norm = 0, f = period;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoiseWrap(u * f, v * f, f) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Worley/cellular F1 distance (0 = on a feature point). Seamless. */
export function tileCell(u, v, cells, jitter = 0.85) {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const mx = ((cx % cells) + cells) % cells;
      const my = ((cy % cells) + cells) % cells;
      const px = cx + 0.5 + (hash2(mx, my) - 0.5) * jitter;
      const py = cy + 0.5 + (hash2(mx + 71, my + 19) - 0.5) * jitter;
      const dx = x - px, dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;
export const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Bilinear sample of an RGBA Uint8 buffer with REPEAT wrapping. */
export function sampleRGBA(data, size, u, v, out) {
  let x = (u - Math.floor(u)) * size;
  let y = (v - Math.floor(v)) * size;
  const x0 = x | 0, y0 = y | 0;
  const fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
  const i00 = (y0 * size + x0) << 2, i10 = (y0 * size + x1) << 2;
  const i01 = (y1 * size + x0) << 2, i11 = (y1 * size + x1) << 2;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;
  for (let c = 0; c < 4; c++) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
  return out;
}

/** Box-filtered downsample of an RGBA buffer (halves resolution). */
export function downsampleRGBA(data, size) {
  const n = size >> 1;
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) << 2;
      const a = ((y * 2) * size + x * 2) << 2;
      const b = a + 4;
      const c = a + (size << 2);
      const d = c + 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (data[a + k] + data[b + k] + data[c + k] + data[d + k]) >> 2;
      }
    }
  }
  return out;
}

/** Build a pre-blurred pyramid so the terrain baker never aliases. */
export function mipPyramid(data, size, levels = 4) {
  const chain = [{ data, size }];
  let cur = { data, size };
  for (let i = 0; i < levels; i++) {
    if (cur.size <= 8) break;
    const next = { data: downsampleRGBA(cur.data, cur.size), size: cur.size >> 1 };
    chain.push(next);
    cur = next;
  }
  return chain;
}
