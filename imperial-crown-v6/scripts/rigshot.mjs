/* Rasterise a rig headlessly, so the silhouette can be looked at without
   a GPU.

   The sandbox has no WebGL2 context, and reasoning about whether a
   procedural body reads as a person is unreliable. This renders the same
   packed buffers the GPU would consume, with the same 3/4 camera angle the
   game uses, and writes a PNG. It is a debug tool, not part of the game.

   Usage: node scripts/rigshot.mjs <out.png> [--pose walk|attack|idle] [--tier mid] [--age 3]
*/
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { B, BONE_COUNT, Pose, buildPalette, buildBindPalette, buildSkinPalette } from '../src/gfx/rig/skeleton.js';
import { DETAIL } from '../src/gfx/rig/meshbuilder.js';
import { buildRig, PROFILES, SKIN_TONES, HAIR_COLORS, RIGS, isMounted } from '../src/gfx/rig/rigs.js';
import { evaluate, AnimState } from '../src/gfx/rig/animator.js';

/* ---------------- PNG ---------------- */

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- tiny 4x4 / vec maths ---------------- */

const m4id = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function m4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f;
  o[10] = (far + near) / (near - far); o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function xform(m, v) {
  const x = v[0], y = v[1], z = v[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
  ];
}

/* ---------------- skinning ---------------- */

/**
 * Skin one vertex on the CPU exactly as UNIT_VS does: four bone matrices
 * from the palette, weighted by the normalised byte weights.
 */
function skinVertex(packed, u8, i8, vi, pal, out) {
  const o = vi * 32;
  const f32 = new Float32Array(packed, o, 3);
  let x = 0, y = 0, z = 0;
  const nx = i8[o + 12] / 127, ny = i8[o + 13] / 127, nz = i8[o + 14] / 127;
  let sx = 0, sy = 0, sz = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const w = u8[o + 27 + k] / 255;
    if (w === 0) continue;
    const b = u8[o + 23 + k];
    const m = b * 16;
    x += (pal[m + 0] * f32[0] + pal[m + 4] * f32[1] + pal[m + 8] * f32[2] + pal[m + 12]) * w;
    y += (pal[m + 1] * f32[0] + pal[m + 5] * f32[1] + pal[m + 9] * f32[2] + pal[m + 13]) * w;
    z += (pal[m + 2] * f32[0] + pal[m + 6] * f32[1] + pal[m + 10] * f32[2] + pal[m + 14]) * w;
    sx += (pal[m + 0] * nx + pal[m + 4] * ny + pal[m + 8] * nz) * w;
    sy += (pal[m + 1] * nx + pal[m + 5] * ny + pal[m + 9] * nz) * w;
    sz += (pal[m + 2] * nx + pal[m + 6] * ny + pal[m + 10] * nz) * w;
    wsum += w;
  }
  out[0] = x; out[1] = y; out[2] = z;
  const nl = Math.hypot(sx, sy, sz) || 1;
  out[3] = sx / nl; out[4] = sy / nl; out[5] = sz / nl;
  out[6] = u8[o + 20] / 255; out[7] = u8[o + 21] / 255; out[8] = u8[o + 22] / 255;
  out[9] = u8[o + 15];
  return out;
}

/* ---------------- render ---------------- */

function render({ out, pose: poseName = 'idle', tier = DETAIL.MID, age = 3, scale = 1,
  width = 720, height = 900, cls = 'man_at_arms' }) {
  const rig = buildRig(cls, tier, { age, skin: SKIN_TONES[0], hair: HAIR_COLORS[0] });
  const mounted = isMounted(cls);
  const rideInp = { mounted };
  const profileName = (RIGS[cls] || { profile: 'spearman' }).profile;
  const prop = PROFILES[profileName];
  const packed = rig.packed;
  const u8 = new Uint8Array(packed);
  const i8 = new Int8Array(packed);
  const pal = new Float32Array(BONE_COUNT * 16);

  /* Build the pose */
  const pose = new Pose();
  const st = new AnimState(0.37);
  if (poseName === 'walk') {
    for (let i = 0; i < 40; i++) {
      evaluate(pose, st, { ...rideInp, dt: 1 / 60, speed: 1, phase: 2.1, attack: 0, moving: true, classKey: cls });
    }
  } else if (poseName === 'attack') {
    for (let i = 0; i < 40; i++) {
      evaluate(pose, st, { ...rideInp, dt: 1 / 60, speed: 0, phase: 0, attack: 0.55, classKey: cls });
    }
  } else {
    for (let i = 0; i < 90; i++) {
      evaluate(pose, st, { ...rideInp, dt: 1 / 60, speed: 0, phase: 0, attack: 0, classKey: cls });
    }
  }
  /* Skinning matrices, not raw bone transforms: the mesh is authored in
     model space, so it needs world * inverseBind. */
  const bind = new Float32Array(BONE_COUNT * 16);
  buildBindPalette(bind, prop);
  buildSkinPalette(pal, pose, prop, bind);

  /* Camera: the game's 3/4 view, close enough to read the face. A foot
     figure is roughly 1.9 m tall; a mounted one is 2.8 m to the top of the
     helm and 1.9 m nose to tail, so it needs both a higher aim point and a
     camera further back or it is cropped at all four edges. */
  const aim = mounted ? 1.55 : 0.98;
  const back = mounted ? 1.55 : 1.0;
  /* A mount is 2.1 m tall and 1.9 m long; framing it with the foot soldier's
     numbers crops the hooves off the bottom and the tail off the side. */
  const target = [0, aim * scale, mounted ? 0.12 : 0];
  const eye = [
    (mounted ? 3.6 : 2.05) * scale,
    (mounted ? 2.05 : 1.42) * scale,
    (mounted ? 4.1 : 2.55) * scale
  ];
  const view = lookAt(eye, target, [0, 1, 0]);
  const proj = perspective(0.60, width / height, 0.1, 60);
  const vp = m4mul(proj, view);

  /* Light from the upper left front, matching the game's sun. */
  const L = norm([-0.45, 0.82, 0.36]);

  const color = Buffer.alloc(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);
  /* vertical gradient background so the silhouette is legible */
  for (let y = 0; y < height; y++) {
    const t = y / height;
    const r = 0.20 + t * 0.16, g = 0.24 + t * 0.18, b = 0.31 + t * 0.20;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      color[o] = Math.round(r * 255); color[o + 1] = Math.round(g * 255); color[o + 2] = Math.round(b * 255);
    }
  }

  const vout = new Float32Array(10);
  const verts = [];
  const idx = rig.indices;
  const tris = idx.length / 3;
  let drawn = 0;

  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const pa = skinVertex(packed, u8, i8, a, pal, vout.slice());
    const pr = skinVertex(packed, u8, i8, b, pal, vout.slice());
    const pc = skinVertex(packed, u8, i8, c, pal, vout.slice());
    const A = [pa[0], pa[1], pa[2]], Bv = [pr[0], pr[1], pr[2]], C = [pc[0], pc[1], pc[2]];

    /* back-face cull in view space via the projected winding */
    const sA = xform(vp, A), sB = xform(vp, Bv), sC = xform(vp, C);
    const area = (sB[0] - sA[0]) * (sC[1] - sA[1]) - (sC[0] - sA[0]) * (sB[1] - sA[1]);
    if (area >= 0) continue;

    /* Face normal, used only for the winding test. Shading uses the
       interpolated vertex normals, exactly as the GPU would: the whole
       point of the smooth-normal requirement is that a 6-sided cylinder
       shades like a round one, and a flat-shaded preview cannot show it. */

    const px = (v) => [(v[0] * 0.5 + 0.5) * width, (1 - (v[1] * 0.5 + 0.5)) * height, v[2]];
    const P = [px(sA), px(sB), px(sC)];

    /* material tint, approximating the shader's per-material colour */
    const base = [pa[6], pa[7], pa[8]];
    const mat = pa[9];
    const tint = MATERIAL_TINT[mat] || [1, 1, 1];
    /* rasterise */
    const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    if (maxX < minX || maxY < minY) continue;
    const d = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(d) < 1e-9) continue;
    drawn++;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((P[1][0] - x) * (P[2][1] - y) - (P[2][0] - x) * (P[1][1] - y)) / d;
        const w1 = ((P[2][0] - x) * (P[0][1] - y) - (P[0][0] - x) * (P[2][1] - y)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
        const di = y * width + x;
        if (z >= depth[di]) continue;
        depth[di] = z;
        /* interpolate the three vertex normals */
        const nx = w0 * pa[3] + w1 * pr[3] + w2 * pc[3];
        const ny = w0 * pa[4] + w1 * pr[4] + w2 * pc[4];
        const nz = w0 * pa[5] + w1 * pr[5] + w2 * pc[5];
        const nl = Math.hypot(nx, ny, nz) || 1;
        let nd = (nx * L[0] + ny * L[1] + nz * L[2]) / nl;
        if (nd < 0) nd = 0;
        /* a little wrap lighting, plus a soft sky term, so the shadow side
           still describes the form instead of going to mud */
        const lit = 0.22 + 0.78 * (nd * 0.82 + 0.18);
        const o = di * 3;
        color[o] = Math.round(Math.min(1, base[0] * tint[0] * lit * 1.10) * 255);
        color[o + 1] = Math.round(Math.min(1, base[1] * tint[1] * lit * 1.10) * 255);
        color[o + 2] = Math.round(Math.min(1, base[2] * tint[2] * lit * 1.10) * 255);
      }
    }
  }

  writeFileSync(out, png(width, height, color));
  return { out, tris, drawn, verts: rig.vertices };
}

const MATERIAL_TINT = {
  0: [1.00, 0.98, 0.94],  // linen
  1: [0.86, 0.88, 0.92],  // mail
  2: [1.05, 1.07, 1.12],  // plate
  3: [0.94, 0.90, 0.82],  // gambeson
  4: [1.00, 0.96, 0.92],  // skin
  5: [0.90, 0.86, 0.80],  // hair
  6: [0.86, 0.78, 0.66],  // leather
  7: [0.92, 0.86, 0.76]   // wood
};

/* ---------------- cli ---------------- */

const args = process.argv.slice(2);
const out = args[0] || 'rig.png';
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const tierName = opt('tier', 'mid');
const tier = tierName === 'near' ? DETAIL.NEAR : tierName === 'far' ? DETAIL.FAR : DETAIL.MID;
const r = render({
  out,
  cls: opt('cls', 'man_at_arms'),
  pose: opt('pose', 'idle'),
  tier,
  age: parseInt(opt('age', '3'), 10),
  scale: parseFloat(opt('scale', '1'))
});
console.log(`${r.out}  ${r.verts} verts, ${r.tris} tris, ${r.drawn} drawn`);
