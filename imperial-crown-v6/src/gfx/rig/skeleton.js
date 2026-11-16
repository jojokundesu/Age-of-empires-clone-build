/* ============================================================
   skeleton.js — the humanoid bone hierarchy

   One shared topology for every humanoid in the game. A unit's
   *proportions* live in rigs.js; its *pose* lives in animator.js;
   this file is only the tree and the arithmetic that turns a set
   of joint angles into a palette of model-space matrices.

   Why 24 bones and not the 15 the design doc counted: the doc
   calls them "15 joints" but nests shoulder->upperArm->elbow->
   forearm->wrist, which is five transforms per arm. A wrist that
   can grip independently of the forearm is what makes the archer
   draw and the villager carry work, so the real number is larger.
   The palette is what gets uploaded, so the honest count matters.

   Bones are indexed 0..BONE_COUNT-1 and the index is baked into a
   vertex attribute. Order never changes: indices are in the mesh.
   ============================================================ */

/** Canonical bone indices. Append-only — these are baked into meshes. */
export const B = {
  ROOT: 0,
  PELVIS: 1,
  SPINE: 2,
  CHEST: 3,
  NECK: 4,
  HEAD: 5,
  SHOULDER_L: 6, UPPER_ARM_L: 7, FOREARM_L: 8, HAND_L: 9,
  SHOULDER_R: 10, UPPER_ARM_R: 11, FOREARM_R: 12, HAND_R: 13,
  HIP_L: 14, THIGH_L: 15, SHIN_L: 16, FOOT_L: 17,
  HIP_R: 18, THIGH_R: 19, SHIN_R: 20, FOOT_R: 21,
  /** Secondary-motion nodes: garments and hair. No skin weights lean on these
      hard, but a braid that can swing on its own is most of the "alive" look. */
  SKIRT: 22,
  HAIR: 23
};

export const BONE_COUNT = 24;

/** parent[i] is the parent bone of i. ROOT has no parent (-1). */
export const PARENT = new Int8Array([
  -1,        // ROOT
  B.ROOT,    // PELVIS
  B.PELVIS,  // SPINE
  B.SPINE,   // CHEST
  B.CHEST,   // NECK
  B.NECK,    // HEAD
  B.CHEST,   // SHOULDER_L
  B.SHOULDER_L, // UPPER_ARM_L
  B.UPPER_ARM_L, // FOREARM_L
  B.FOREARM_L,   // HAND_L
  B.CHEST,   // SHOULDER_R
  B.SHOULDER_R, // UPPER_ARM_R
  B.UPPER_ARM_R, // FOREARM_R
  B.FOREARM_R,   // HAND_R
  B.PELVIS,  // HIP_L
  B.HIP_L,   // THIGH_L
  B.THIGH_L, // SHIN_L
  B.SHIN_L,  // FOOT_L
  B.PELVIS,  // HIP_R
  B.HIP_R,   // THIGH_R
  B.SHIN_R === undefined ? 0 : B.THIGH_R, // SHIN_R
  B.SHIN_R,  // FOOT_R
  B.PELVIS,  // SKIRT
  B.HEAD     // HAIR
]);

/** Human-readable names, for the inspector and for test failure messages. */
export const BONE_NAMES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'hipL', 'thighL', 'shinL', 'footL',
  'hipR', 'thighR', 'shinR', 'footR',
  'skirt', 'hair'
];

/**
 * Bind-pose rest offsets, in metres, relative to the parent joint.
 * These are the *neutral* skeleton; a unit's proportions scale them.
 * Y is up, +Z is forward (the model faces +Z before the instance
 * matrix applies facing).
 */
export const REST = [
  /* 0 ROOT        */ [0, 0, 0],
  /* 1 PELVIS      */ [0, 0.95, 0],
  /* 2 SPINE       */ [0, 0.16, 0],
  /* 3 CHEST       */ [0, 0.20, 0],
  /* 4 NECK        */ [0, 0.20, 0],
  /* 5 HEAD        */ [0, 0.09, 0],
  /* 6 SHOULDER_L  */ [-0.20, 0.09, 0],
  /* 7 UPPER_ARM_L */ [-0.03, -0.02, 0],
  /* 8 FOREARM_L   */ [0, -0.28, 0],
  /* 9 HAND_L      */ [0, -0.26, 0],
  /*10 SHOULDER_R  */ [0.20, 0.09, 0],
  /*11 UPPER_ARM_R */ [0.03, -0.02, 0],
  /*12 FOREARM_R   */ [0, -0.28, 0],
  /*13 HAND_R      */ [0, -0.26, 0],
  /*14 HIP_L       */ [-0.10, -0.03, 0],
  /*15 THIGH_L     */ [0, -0.05, 0],
  /*16 SHIN_L      */ [0, -0.44, 0],
  /*17 FOOT_L      */ [0, -0.42, 0],
  /*18 HIP_R       */ [0.10, -0.03, 0],
  /*19 THIGH_R     */ [0, -0.05, 0],
  /*20 SHIN_R      */ [0, -0.44, 0],
  /*21 FOOT_R      */ [0, -0.42, 0],
  /*22 SKIRT       */ [0, -0.04, 0],
  /*23 HAIR        */ [0, 0.12, 0]
];

/* ---- tiny column-major 4x4 helpers (the palette is column-major) ---- */

export function m4id(o) {
  o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
  return o;
}

/**
 * out = a * b, both column-major. Out may not alias a or b.
 * Deliberately unrolled: this runs 24 times per unit per frame, and
 * `perf` measures 300 units.
 */
export function m4mult(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

/** Local matrix: translate, then rotate XYZ (small-angle friendly). */
export function m4local(out, tx, ty, tz, rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  /* R = Rz * Ry * Rx  (yaw, then pitch, then roll about the limb axis) */
  const r00 = cy * cz;
  const r01 = cz * sy * sx - sz * cx;
  const r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy;
  const r11 = sz * sy * sx + cz * cx;
  const r12 = sz * sy * cx - cz * sx;
  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cy * cx;
  out[0] = r00; out[1] = r10; out[2] = r20; out[3] = 0;
  out[4] = r01; out[5] = r11; out[6] = r21; out[7] = 0;
  out[8] = r02; out[9] = r12; out[10] = r22; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

/**
 * A pose is three parallel arrays indexed by bone:
 *   rot  — Float32Array(BONE_COUNT*3)  euler XYZ radians, local
 *   off  — Float32Array(BONE_COUNT*3)  extra translation, local metres
 *   scl  — Float32Array(BONE_COUNT*3)  per-bone scale (chest breathing)
 * Building the palette from a pose is one multiply per bone.
 */
export class Pose {
  constructor() {
    this.rot = new Float32Array(BONE_COUNT * 3);
    this.off = new Float32Array(BONE_COUNT * 3);
    this.scl = new Float32Array(BONE_COUNT * 3).fill(1);
    this._local = new Float32Array(16);
    this._localS = new Float32Array(16);
  }
  clear() {
    this.rot.fill(0); this.off.fill(0); this.scl.fill(1);
    return this;
  }
  set(bone, rx, ry, rz) {
    const o = bone * 3;
    this.rot[o] = rx; this.rot[o + 1] = ry; this.rot[o + 2] = rz;
    return this;
  }
  add(bone, rx, ry, rz) {
    const o = bone * 3;
    this.rot[o] += rx; this.rot[o + 1] += ry; this.rot[o + 2] += rz;
    return this;
  }
}

/**
 * Compose a pose + a proportion table into a model-space bone palette.
 *
 * @param out     Float32Array(BONE_COUNT*16) destination palette
 * @param pose    Pose
 * @param prop    proportions (see rigs.js) — scales the REST offsets
 */
export function buildPalette(out, pose, prop) {
  const local = pose._local;
  for (let b = 0; b < BONE_COUNT; b++) {
    const r = b * 3, o = b * 16;
    const rest = REST[b];
    /* rest offset, scaled by the unit's proportions, plus any pose offset */
    const tx = rest[0] * prop.limbW + pose.off[r];
    const ty = rest[1] * prop.height + pose.off[r + 1];
    const tz = rest[2] * prop.chestD + pose.off[r + 2];
    m4local(local, tx, ty, tz, pose.rot[r], pose.rot[r + 1], pose.rot[r + 2]);
    if (pose.scl[r] !== 1 || pose.scl[r + 1] !== 1 || pose.scl[r + 2] !== 1) {
      m4scaleUniform(out, local, pose.scl[r], pose.scl[r + 1], pose.scl[r + 2], o);
    }
    const p = PARENT[b];
    if (p < 0) {
      for (let k = 0; k < 16; k++) out[o + k] = local[k];
    } else {
      m4mult(out.subarray(o, o + 16), out.subarray(p * 16, p * 16 + 16), local);
    }
  }
  return out;
}

function m4scaleUniform(out, m, sx, sy, sz, o) {
  out[o] = m[0] * sx; out[o + 1] = m[1] * sx; out[o + 2] = m[2] * sx; out[o + 3] = 0;
  out[o + 4] = m[4] * sy; out[o + 5] = m[5] * sy; out[o + 6] = m[6] * sy; out[o + 7] = 0;
  out[o + 8] = m[8] * sz; out[o + 9] = m[9] * sz; out[o + 10] = m[10] * sz; out[o + 11] = 0;
  out[o + 12] = m[12]; out[o + 13] = m[13]; out[o + 14] = m[14]; out[o + 15] = 1;
}

/** Read a bone's model-space origin out of a palette (for tests/diagnostics). */
export function boneOrigin(palette, bone) {
  const o = bone * 16;
  return [palette[o + 12], palette[o + 13], palette[o + 14]];
}
