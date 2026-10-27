/* ============================================================
   math.js — allocation-free maths for the simulation and renderer
   Everything hot is written so the caller supplies the output
   object. No arrays are created inside the frame loop.
   ============================================================ */

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
export const mix = lerp;
export const sign = Math.sign;
export const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

export const angleLerp = (a, b, t) => {
  const d = wrapAngle(b - a);
  return a + d * t;
};
export const wrapAngle = (a) => ((a + PI) % TAU + TAU) % TAU - PI;
export const shortestAngle = (a, b) => wrapAngle(b - a);

/* ---------------- vec3 (Float32Array) ---------------- */
export const v3 = (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]);
export function v3set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
export function v3copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
export function v3add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; }
export function v3sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; }
export function v3scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; }
export function v3len(a) { return Math.hypot(a[0], a[1], a[2]); }
export function v3norm(o, a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o; }
export function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function v3cross(o, a, b) {
  const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
  o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx;
  return o;
}
export function v3dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function v3lerp(o, a, b, t) {
  const it = 1 - t;
  o[0] = a[0] * it + b[0] * t; o[1] = a[1] * it + b[1] * t; o[2] = a[2] * it + b[2] * t;
  return o;
}

/* ---------------- mat4, column-major ---------------- */
export const mat4 = () => new Float32Array(16);

export function m4identity(o) {
  o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
  return o;
}
export function m4copy(o, a) { o.set(a); return o; }

/** o = a * b (both column-major). */
export function m4mul(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    o[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    o[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    o[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    o[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return o;
}

export function m4perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
  o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
  return o;
}

export function m4ortho(o, l, r, b, t, n, f) {
  const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
  o[0] = -2 * lr; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = -2 * bt; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = 2 * nf; o[11] = 0;
  o[12] = (l + r) * lr; o[13] = (t + b) * bt; o[14] = (f + n) * nf; o[15] = 1;
  return o;
}

export function m4lookAt(o, ex, ey, ez, cx, cy, cz, ux = 0, uy = 1, uz = 0) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xy * ey + xz * ez);
  o[13] = -(yx * ex + yy * ey + yz * ez);
  o[14] = -(zx * ex + zy * ey + zz * ez);
  o[15] = 1;
  return o;
}

export function m4invert(o, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return m4identity(o);
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

export function m4trs(o, x, y, z, ry, sx, sy, sz) {
  const c = Math.cos(ry), s = Math.sin(ry);
  o[0] = c * sx; o[1] = 0; o[2] = -s * sx; o[3] = 0;
  o[4] = 0; o[5] = sy; o[6] = 0; o[7] = 0;
  o[8] = s * sz; o[9] = 0; o[10] = c * sz; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}

export function m4trsEuler(o, x, y, z, rx, ry, rz, sx, sy, sz) {
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);
  // R = Ry * Rx * Rz
  const m00 = cy * cz + syr * sxr * szr;
  const m01 = -cy * szr + syr * sxr * cz;
  const m02 = syr * cx;
  const m10 = cx * szr;
  const m11 = cx * cz;
  const m12 = -sxr;
  const m20 = -syr * cz + cy * sxr * szr;
  const m21 = syr * szr + cy * sxr * cz;
  const m22 = cy * cx;
  o[0] = m00 * sx; o[1] = m10 * sx; o[2] = m20 * sx; o[3] = 0;
  o[4] = m01 * sy; o[5] = m11 * sy; o[6] = m21 * sy; o[7] = 0;
  o[8] = m02 * sz; o[9] = m12 * sz; o[10] = m22 * sz; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}

export function m4transformPoint(out, m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function m4transformDir(out, m, x, y, z) {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

export function m4basis(o, right, up, fwd, pos) {
  o[0] = right[0]; o[1] = right[1]; o[2] = right[2]; o[3] = 0;
  o[4] = up[0]; o[5] = up[1]; o[6] = up[2]; o[7] = 0;
  o[8] = fwd[0]; o[9] = fwd[1]; o[10] = fwd[2]; o[11] = 0;
  o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2]; o[15] = 1;
  return o;
}

/* ---------------- deterministic random ---------------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(seed) {
  const r = mulberry32(seed);
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  return r;
}

/* ---------------- value noise ---------------- */
const PERM = new Uint8Array(512);
(function initPerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const grad2 = (h, x, y) => {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
};

/** Perlin-style gradient noise, roughly -1..1. */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[X] + Y], ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y], bb = PERM[PERM[X + 1] + Y + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 1.4;
}

export function fbm2(x, y, oct = 4, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

export function ridged2(x, y, oct = 3) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/* ---------------- easing ---------------- */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
export const easeOutElastic = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
};
export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

/* ---------------- colour ---------------- */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(r, g, b) {
  const c = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export const mixHex = (a, b, t) => {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
};
export const shadeHex = (hex, amount) => {
  const c = hexToRgb(hex);
  return rgbToHex(clamp(c[0] + amount, 0, 1), clamp(c[1] + amount, 0, 1), clamp(c[2] + amount, 0, 1));
};

/* ---------------- misc ---------------- */
export const randRange = (a, b) => a + Math.random() * (b - a);
export const randPick = (arr) => arr[(Math.random() * arr.length) | 0];
export function shuffle(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
export const fmt = (n) => {
  n = Math.round(n);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
};
export function fmtTime(sec) {
  sec = Math.max(0, sec | 0);
  const m = (sec / 60) | 0, s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
/** Smoothing factor that is frame-rate independent. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
/** Move a value toward a target by at most `step`. */
export const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
