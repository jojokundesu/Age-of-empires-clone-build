/* ============================================================
   bake.js — the texture forge for v3 (CPU, once per match)

   v2 painted the ground *per pixel*: the terrain fragment shader ran about
   forty noise octaves, five hundred sin-hashes and nine texture-fetches per
   fragment. On an Adreno 610 that is several gigafetches a second at phone
   resolution -- the single largest reason the game stuttered.

   Every one of those fields is a pure function of world position, so v3
   evaluates them once, here, into textures:

     · bakeTerrain      one 512x512 radiance map for the whole 512 m island
                        (albedo + baked ambient occlusion in alpha)
     · bakeGroundDetail a seamless 4 m detail tile that gives close-ups their
                        blades and pebbles and mips to neutral at distance
     · bakeClouds       a seamless cloud field shared by the sky and the
                        ground cloud-shadows
     · bakeStars        a star dome (three layers + the Milky Way) baked once
     · bakeWater        scrolling normals + foam in one RGBA tile
     · bakeNoise        four channels of field noise for the model shader

   The shaders then cost 1-3 fetches instead of 40 octaves, and the art is
   *better*: we can afford more octaves, the mip chain is correct, and nothing
   shimmers when the camera moves.
   ============================================================ */
import { clamp } from '../core/math.js';
import {
  hash2, hash3, vnoise, vnoiseWrap, fbm, tileFbm, tileRidge, tileCell,
  clamp01, smoothstep, mix
} from './noise.js';

const TAU = Math.PI * 2;

/* =====================================================================
   1. GROUND DETAIL TILE  (greyscale, seamless, one tile = `METRES` metres)
   ===================================================================== */
export const DETAIL_METRES = 4;      // world size of one detail repeat

/**
 * RGB = luminance detail around 0.5 (+/- so it can be used as a multiplier),
 * A   = sparse specks (flowers, pebbles, glints) that only read up close.
 */
export function bakeGroundDetail(size = 512) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = (y * size + x) << 2;
      // blade-scale structure: stretched along one axis so it reads as grass
      const warp = tileFbm(u, v, 6, 3) - 0.5;
      const blades = tileFbm(u * 2 + warp * 0.14, v * 7, 12, 3);
      const clumps = tileFbm(u, v, 4, 4);
      const grain = tileFbm(u, v, 32, 2);
      const pebble = tileCell(u, v, 14, 0.9);
      const soil = tileCell(u * 1.7, v * 1.7, 26, 0.95);

      // 0.5-centred luminance
      let lum = 0.5
        + (blades - 0.5) * 0.36
        + (clumps - 0.5) * 0.30
        + (grain - 0.5) * 0.18;
      // a faint dark crevice between clumps, a pebble highlight
      lum -= smoothstep(0.62, 0.95, clumps) * 0.10;
      lum += smoothstep(0.30, 0.02, pebble) * 0.16;

      const speck = Math.max(
        smoothstep(0.055, 0.012, pebble) * 0.9,       // small stones
        smoothstep(0.045, 0.0, soil) * 0.55           // seed heads / petals
      );
      lum = clamp01(lum);
      const b = lum * 255;
      out[i] = b;
      out[i + 1] = clamp(b * (0.97 + (clumps - 0.5) * 0.10), 0, 255);
      out[i + 2] = clamp(b * (0.95 + (grain - 0.5) * 0.12), 0, 255);
      out[i + 3] = speck * 255;
    }
  }
  return out;
}

/* =====================================================================
   2. CLOUD FIELD (seamless; alpha is the ground cloud-shadow coverage)
   ===================================================================== */
export function bakeClouds(size = 512) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = (y * size + x) << 2;
      const big = tileFbm(u, v, 4, 5);
      const mid = tileFbm(u + 0.37, v + 0.11, 8, 5);
      const wisp = tileRidge(u, v, 16, 3);
      // coverage: broad banks, not a uniform fog
      const cover = clamp01((big * 0.66 + mid * 0.34 - 0.30) * 2.15);
      out[i] = big * 255;
      out[i + 1] = mid * 255;
      out[i + 2] = wisp * 255;
      out[i + 3] = cover * 255;
    }
  }
  return out;
}

/* =====================================================================
   3. STAR DOME  (equirectangular: u = azimuth, v = elevation)
   ===================================================================== */
export function bakeStars(w = 1024, h = 512) {
  const acc = new Float32Array(w * h * 3);
  const addStar = (px, py, gain, temp) => {
    // 3x3 gaussian so a star survives mip-mapping instead of flickering
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = (px + dx + w) % w;
        const sy = py + dy;
        if (sy < 0 || sy >= h) continue;
        const wgt = (dx === 0 ? 1 : 0.42) * (dy === 0 ? 1 : 0.42);
        const o = (sy * w + sx) * 3;
        acc[o] += gain * wgt * (1 - temp * 0.45);
        acc[o + 1] += gain * wgt * 0.96;
        acc[o + 2] += gain * wgt * (0.82 + temp * 0.30);
      }
    }
  };
  // three density layers, like v2's shader, but resolved to pixels once
  const layers = [
    { count: 2600, gain: 0.22, rMax: 0.40 },
    { count: 520, gain: 0.55, rMax: 0.55 },
    { count: 90, gain: 1.35, rMax: 0.75 }
  ];
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const L of layers) {
    for (let i = 0; i < L.count; i++) {
      // sample uniformly on the sphere, then project into equirect space
      const cz = rnd() * 2 - 1;
      const phi = rnd() * TAU;
      const r = Math.sqrt(Math.max(0, 1 - cz * cz));
      const dx = Math.cos(phi) * r, dy = cz, dz = Math.sin(phi) * r;
      if (dy < -0.12) continue;
      const u = (Math.atan2(dz, dx) / TAU + 0.5) % 1;
      const vv = Math.asin(clamp(dy, -1, 1)) / Math.PI + 0.5;
      addStar(Math.round(u * w) % w, Math.round((1 - vv) * h), L.gain * (0.55 + rnd() * 0.9), rnd());
    }
  }
  // milky way: a tilted band with two octaves of grain, exactly as the shader
  // used to draw it, now resolved per texel at bake time
  const ax = [0.36, 0.46, 0.81];
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  ax[0] /= al; ax[1] /= al; ax[2] /= al;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const vv = 1 - (y + 0.5) / h;           // 0..1 -> north..south
    const theta = (vv - 0.5) * Math.PI;
    const ct = Math.cos(theta), st = Math.sin(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w - 0.5) * TAU;
      const dx = Math.cos(phi) * ct, dy = st, dz = Math.sin(phi) * ct;
      const o = (y * w + x) * 4;
      let r = acc[(y * w + x) * 3], g = acc[(y * w + x) * 3 + 1], b = acc[(y * w + x) * 3 + 2];
      const dotAxis = dx * ax[0] + dy * ax[1] + dz * ax[2];
      const band = smoothstep(0.86, 0.995, 1 - Math.abs(dotAxis));
      if (band > 0.001) {
        const grain = vnoise(dx * 46, dz * 46 + dy * 23) * 0.55 + vnoise(dx * 113 - dy * 37, dz * 113) * 0.45;
        const mw = band * (0.020 + 0.085 * grain * grain);
        r += 0.42 * mw * 1.6; g += 0.50 * mw * 1.6; b += 0.74 * mw * 1.9;
      }
      out[o] = clamp(r * 255, 0, 255);
      out[o + 1] = clamp(g * 255, 0, 255);
      out[o + 2] = clamp(b * 255, 0, 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/* =====================================================================
   4. WATER TILE  (R,G = normal xy, B = height, A = foam)
   ===================================================================== */
export function bakeWater(size = 256) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let hgt = 0;
      // three crossed swell trains, then two octaves of chop
      hgt += Math.sin((u * 3 + v * 1.5) * TAU + Math.sin(v * TAU * 2) * 1.2) * 0.50;
      hgt += Math.sin((u * 5 - v * 3) * TAU + 2.1) * 0.28;
      hgt += Math.sin((u * 8 + v * 6) * TAU - 1.3) * 0.14;
      hgt += (tileFbm(u, v, 8, 3) - 0.5) * 1.20;
      hgt += (tileFbm(u, v, 24, 2) - 0.5) * 0.40;
      height[y * size + x] = hgt;
    }
  }
  const out = new Uint8ClampedArray(size * size * 4);
  const strength = 1.7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) << 2;
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const up = height[((y - 1 + size) % size) * size + x];
      const dn = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (up - dn) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const u = x / size, v = y / size;
      // foam lives in the troughs of the longest swell
      const swell = Math.sin((u * 2 + v * 1) * TAU + 0.7) * 0.5 + 0.5;
      const foam = clamp01((1 - swell) * 0.55 + (tileRidge(u, v, 10, 3) - 0.55) * 0.9);
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (height[y * size + x] * 0.30 + 0.5) * 255;
      out[i + 3] = foam * 255;
    }
  }
  return out;
}

/* =====================================================================
   5. FIELD NOISE FOR MODELS  (R,G = fbm, B = leaf cells, A = sparks)
   ===================================================================== */
export function bakeNoise(size = 256) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = (y * size + x) << 2;
      out[i] = tileFbm(u, v, 4, 4) * 255;
      out[i + 1] = tileFbm(u + 0.23, v + 0.61, 8, 5) * 255;
      const c = tileCell(u, v, 9, 0.95);
      out[i + 2] = clamp01(1 - c * 1.55) * 255;
      out[i + 3] = clamp01((tileRidge(u, v, 16, 2) - 0.72) * 3.4) * 255;
    }
  }
  return out;
}

/* =====================================================================
   6. FOG OF WAR DITHER  (replaces the two noise octaves the shader ran on
      every single material's pixels)
   ===================================================================== */
export function bakeFogDither(size = 64) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // two scales: a 14 m rim wobble and a 4 m grain, in [-1,1]
      const a = (tileFbm(u, v, 4, 3) - 0.5) * 2;
      const b = (tileFbm(u + 0.5, v + 0.5, 8, 3) - 0.5) * 2;
      out[y * size + x] = a * 0.72 + b * 0.28;
    }
  }
  return out;
}

/* =====================================================================
   7. THE TERRAIN RADIANCE MAP
   ---------------------------------------------------------------
   One texel per metre (512 m world -> 512 px). Alpha carries baked
   sky occlusion from the height field, which v2 had no way to compute.
   ===================================================================== */

/** Layer indices in the terrain atlas (must match textures.js). */
const L_GRASS = 0, L_GRASS_DRY = 1, L_DIRT = 2, L_ROCK = 3, L_SAND = 4,
  L_COBBLE = 6, L_SNOW = 7, L_FOREST = 10;

/**
 * @param world  the sim world (height field + splat)
 * @param RT     buildRenderTerrain() output (splat weights per vertex)
 * @param pixels array of 12 RGBA Uint8ClampedArray (256x256) layer images
 * @param opts   { size, cloudData, cloudSize }
 */
export function bakeTerrain(world, RT, pixels, opts = {}) {
  const S = opts.size || 512;
  const half = RT.size * 0.5;
  const cloud = opts.cloudData || null;
  const csize = opts.cloudSize || 512;
  const out = new Uint8ClampedArray(S * S * 4);

  /* ---- pre-blur the layer atlas so 1.2 cm texels never alias into 1 m
     texels. We keep a 32x32 (9.8 cm) copy: still finer than the target
     resolution, cheap to sample, and free of fireflies. ---- */
  const LAYER = 32;
  const small = [];
  for (let li = 0; li < pixels.length; li++) {
    const src = pixels[li];
    if (!src) { small.push(null); continue; }
    const dst = new Uint8ClampedArray(LAYER * LAYER * 4);
    const stride = 256 / LAYER;                 // 8
    for (let y = 0; y < LAYER; y++) {
      for (let x = 0; x < LAYER; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < stride; sy++) {
          for (let sx = 0; sx < stride; sx++) {
            const o = (((y * stride + sy) * 256) + (x * stride + sx)) << 2;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
          }
        }
        const n = stride * stride;
        const o = (y * LAYER + x) << 2;
        dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = a / n;
      }
    }
    small.push(dst);
  }

  /** Bilinear, repeating sample of a 32x32 layer into [r,g,b]. */
  const sampleLayer = (li, u, v, res) => {
    const data = small[li];
    if (!data) { res[0] = res[1] = res[2] = 128; return res; }
    const x = u * LAYER, y = v * LAYER;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xa = ((x0 % LAYER) + LAYER) % LAYER, xb = (xa + 1) % LAYER;
    const ya = ((y0 % LAYER) + LAYER) % LAYER, yb = (ya + 1) % LAYER;
    const i00 = ((ya * LAYER) + xa) << 2, i10 = ((ya * LAYER) + xb) << 2;
    const i01 = ((yb * LAYER) + xa) << 2, i11 = ((yb * LAYER) + xb) << 2;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    res[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
    res[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
    res[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
    return res;
  };

  /* ---- slow fields on a 4 m grid (matching the splat resolution) ---- */
  const PG = 129;                    // vertices of the 4 m grid
  const PF = 7;
  const param = new Float32Array(PG * PG * PF);
  for (let j = 0; j < PG; j++) {
    const z = j * RT.cell - half;
    for (let i = 0; i < PG; i++) {
      const x = i * RT.cell - half;
      const o = ((j * PG) + i) * PF;
      /* These fields must keep v2's 0..1 range: every threshold below was
         authored against 0..1 noise, and re-centring them on zero silently
         removed the whole sun-dried straw pass (the island baked emerald). */
      param[o] = fbm(x * 0.013 + 3, z * 0.013 + 3, 5);          // macro
      param[o + 1] = fbm(x * 0.055 - 7, z * 0.055 - 7, 5);      // patches
      param[o + 2] = fbm(x * 0.020 + 11, z * 0.020 + 11, 4);    // forest mask
      param[o + 3] = fbm(x * 0.0105 + 3, z * 0.0105 + 3, 5);    // fields
      param[o + 4] = fbm(x * 0.038 - 7, z * 0.038 - 7, 5);      // patchwork
      param[o + 5] = fbm(x * 0.085 - 19, z * 0.085 - 19, 5);    // drifts
      param[o + 6] = fbm(x * 0.055 + 41, z * 0.055 + 41, 5);    // mown bands
    }
  }
  // bilinear fetch of one param channel at world (x,z)
  const pget = (x, z, ch) => {
    const gx = clamp((x + half) / RT.cell, 0, PG - 1.001);
    const gz = clamp((z + half) / RT.cell, 0, PG - 1.001);
    const i0 = gx | 0, j0 = gz | 0;
    const fx = gx - i0, fz = gz - j0;
    const o00 = ((j0 * PG) + i0) * PF + ch;
    const o10 = o00 + PF;
    const o01 = o00 + PG * PF;
    const o11 = o01 + PF;
    const a = param[o00] + (param[o10] - param[o00]) * fx;
    const b = param[o01] + (param[o11] - param[o01]) * fx;
    return a + (b - a) * fz;
  };

  const hf = world.height;
  const tmp = [0, 0, 0];
  const texScale = 0.32;             // metres -> layer atlas uv (v2 value)

  /* Bilinear-ish fetch of the cloud coverage channel at a wrapping uv.
     A plain `% 1` on a negative world coordinate yields a negative index --
     undefined array reads, NaN pixels, and a black half-map. */
  const wrap = (v) => v - Math.floor(v);
  const cloudAt = (data, size, u, v) => {
    const x = wrap(u) * size, y = wrap(v) * size;
    const x0 = x | 0, y0 = y | 0;
    const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
    const fx = x - x0, fy = y - y0;
    const a = data[(y0 * size + x0) * 4 + 3], b = data[(y0 * size + x1) * 4 + 3];
    const c = data[(y1 * size + x0) * 4 + 3], d = data[(y1 * size + x1) * 4 + 3];
    return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) / 255;
  };

  for (let j = 0; j < S; j++) {
    // texture row 0 is the -Z edge; v = 0 at z = -half (flipY handled on upload)
    const z = ((j + 0.5) / S) * RT.size - half;
    for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S) * RT.size - half;
      const o = ((j * S) + i) << 2;
      const y = hf.sample(x, z);

      /* --- splat weights, bilinear from the 4 m vertex grid --- */
      const gx = clamp((x + half) / RT.cell, 0, RT.n - 1.001);
      const gz = clamp((z + half) / RT.cell, 0, RT.n - 1.001);
      const i0 = gx | 0, j0 = gz | 0;
      const fx = gx - i0, fz = gz - j0;
      const k00 = (j0 * RT.n) + i0, k10 = k00 + 1, k01 = k00 + RT.n, k11 = k01 + 1;
      const b00 = (1 - fx) * (1 - fz), b10 = fx * (1 - fz), b01 = (1 - fx) * fz, b11 = fx * fz;
      const sg = RT.splat4, s2 = RT.splat2;
      const wGrass = sg[k00 * 4] * b00 + sg[k10 * 4] * b10 + sg[k01 * 4] * b01 + sg[k11 * 4] * b11;
      const wDirt = sg[k00 * 4 + 1] * b00 + sg[k10 * 4 + 1] * b10 + sg[k01 * 4 + 1] * b01 + sg[k11 * 4 + 1] * b11;
      const wRock = sg[k00 * 4 + 2] * b00 + sg[k10 * 4 + 2] * b10 + sg[k01 * 4 + 2] * b01 + sg[k11 * 4 + 2] * b11;
      const wSand = sg[k00 * 4 + 3] * b00 + sg[k10 * 4 + 3] * b10 + sg[k01 * 4 + 3] * b01 + sg[k11 * 4 + 3] * b11;
      const wCobble = s2[k00 * 2] * b00 + s2[k10 * 2] * b10 + s2[k01 * 2] * b01 + s2[k11 * 2] * b11;
      const wSnow = s2[k00 * 2 + 1] * b00 + s2[k10 * 2 + 1] * b10 + s2[k01 * 2 + 1] * b01 + s2[k11 * 2 + 1] * b11;

      const u = x * texScale, v = z * texScale;
      const macro = pget(x, z, 0);
      const patchy = pget(x, z, 1) * 0.72;
      const forestMask = smoothstep(0.55, 0.9, pget(x, z, 2)) * 0.5;

      // grass = mix(lush, dry, macro) then blended toward forest floor
      sampleLayer(L_GRASS, u, v, tmp);
      let gr = tmp[0], gg = tmp[1], gb = tmp[2];
      sampleLayer(L_GRASS_DRY, u * 0.86, v * 0.86, tmp);
      const dryMix = smoothstep(0.42, 0.82, macro + pget(x, z, 1) * 0.25);
      gr = mix(gr, tmp[0], dryMix); gg = mix(gg, tmp[1], dryMix); gb = mix(gb, tmp[2], dryMix);
      sampleLayer(L_FOREST, u, v, tmp);
      gr = mix(gr, tmp[0], forestMask); gg = mix(gg, tmp[1], forestMask); gb = mix(gb, tmp[2], forestMask);

      sampleLayer(L_DIRT, u * 0.8, v * 0.8, tmp);
      let r = gr * wGrass + tmp[0] * wDirt;
      let g = gg * wGrass + tmp[1] * wDirt;
      let b = gb * wGrass + tmp[2] * wDirt;
      sampleLayer(L_ROCK, u * 1.15, v * 1.15, tmp);
      r += tmp[0] * wRock; g += tmp[1] * wRock; b += tmp[2] * wRock;
      sampleLayer(L_SAND, u * 1.3, v * 1.3, tmp);
      r += tmp[0] * wSand; g += tmp[1] * wSand; b += tmp[2] * wSand;
      sampleLayer(L_COBBLE, u * 1.6, v * 1.6, tmp);
      r += tmp[0] * wCobble; g += tmp[1] * wCobble; b += tmp[2] * wCobble;
      sampleLayer(L_SNOW, u * 0.9, v * 0.9, tmp);
      r += tmp[0] * wSnow; g += tmp[1] * wSnow; b += tmp[2] * wSnow;
      const wsum = wGrass + wDirt + wRock + wSand + wCobble + wSnow || 1;
      r /= wsum; g /= wsum; b /= wsum;

      /* --- the patchwork of fields ------------------------------------- */
      const field = pget(x, z, 3);
      const patch = pget(x, z, 4);
      const drifts = pget(x, z, 5);
      const clumps = vnoise(x * 0.185 + 11, z * 0.185 + 11);
      const dry = smoothstep(0.34, 0.78, patchy + field * 0.46);
      r = mix(r, r * 1.32 + 8.7, dry * 0.70);
      g = mix(g, g * 1.10 + 7.7, dry * 0.70);
      b = mix(b, b * 0.60 + 1.0, dry * 0.70);
      const lush = smoothstep(0.62, 0.22, patch * 0.66 + field * 0.54);
      r = mix(r, r * 0.62 + 1.0, lush * 0.56);
      g = mix(g, g * 0.88 + 5.6, lush * 0.56);
      b = mix(b, b * 0.66 + 1.5, lush * 0.56);
      const tussock = 0.90 + clumps * 0.20;
      r *= tussock; g *= tussock; b *= tussock;
      const drift = 0.88 + drifts * 0.26;
      r *= drift; g *= drift; b *= drift;
      const band = smoothstep(0.62, 0.92, pget(x, z, 6));
      r = mix(r, r * 1.16, band * 0.30);
      g = mix(g, g * 1.02, band * 0.30);
      b = mix(b, b * 0.66, band * 0.30);

      /* --- slope and altitude ------------------------------------------ */
      const d = 1.2;
      const hx = hf.sample(x + d, z) - hf.sample(x - d, z);
      const hz = hf.sample(x, z + d) - hf.sample(x, z - d);
      const nl = Math.hypot(hx, 2 * d, hz) || 1;
      const ny = (2 * d) / nl;
      const steep = 1 - smoothstep(0.60, 0.90, ny);
      r = mix(r, r * 0.74 + 7.6, steep * 0.55);
      g = mix(g, g * 0.66 + 6.1, steep * 0.55);
      b = mix(b, b * 0.56 + 4.1, steep * 0.55);
      const high = smoothstep(5, 27, y);
      r = mix(r, r * 1.14, high * 0.32);
      g = mix(g, g * 1.02, high * 0.32);
      b = mix(b, b * 0.78, high * 0.32);

      /* --- cloud modulation (v2 fetched the cloud map twice per pixel) -- */
      if (cloud) {
        const micro = cloudAt(cloud, csize, x * 0.021, z * 0.021);
        const fine = cloudAt(cloud, csize, x * 0.11, z * 0.11);
        const mod = 0.84 + micro * 0.24 + fine * 0.10;
        r *= mod; g *= mod; b *= mod;
      }

      /* --- saturation lift, matching the shader's final grade ----------- */
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = Math.max(0, mix(lum, r, 1.02) * 1.05);
      g = Math.max(0, mix(lum, g, 1.02) * 1.02);
      b = Math.max(0, mix(lum, b, 1.02) * 0.92);

      /* --- baked sky occlusion (new in v3) ------------------------------
         Cheap horizon test in four directions: how much of the sky does a
         soldier standing here actually see? Costs nothing at runtime and it
         is what makes valleys read as valleys from an RTS camera. */
      let occ = 0;
      for (let a = 0; a < 4; a++) {
        const ang = a * (Math.PI / 2) + 0.4;
        const dx = Math.cos(ang), dz = Math.sin(ang);
        const h1 = hf.sample(x + dx * 3.5, z + dz * 3.5);
        const h2 = hf.sample(x + dx * 9, z + dz * 9);
        const h3 = hf.sample(x + dx * 18, z + dz * 18);
        occ += Math.max(0, h1 - y) * 0.35 + Math.max(0, h2 - y) * 0.05 + Math.max(0, h3 - y) * 0.015;
      }
      const ao = clamp01(1 - occ * 0.55 - steep * 0.18);
      const aoByte = (0.55 + ao * 0.45) * 255;

      out[o] = r > 255 ? 255 : r;
      out[o + 1] = g > 255 ? 255 : g;
      out[o + 2] = b > 255 ? 255 : b;
      out[o + 3] = aoByte;
    }
  }
  return out;
}

/* =====================================================================
   8. Dirt path / hedge mask used by the scatter pass (keeps trees and
      boulders off roads and out of villages)
   ===================================================================== */
export function bakeScatterMask(RT, pixels, size = 128) {
  // unused placeholder kept tiny; the sim owns real scattering
  return new Uint8ClampedArray(size * size * 4);
}
