/* ============================================================
   rigs.js — sculpted anatomy, as data

   A rig is a proportion table plus a build function that emits
   skinned geometry. Everything is in bind-pose model space, feet at
   y = 0, facing +Z.

   The proportion numbers are the design doc's approved table. The
   Man-at-Arms ships with two variants so the approved 1.08/1.24 and
   the tighter 1.05/1.18 can be compared at 4 m and 12 m before the
   rest of the cast is built on the winner.
   ============================================================ */

import { B } from './skeleton.js';
import { DETAIL, SkinnedBuilder } from './meshbuilder.js';

/* Material ids shared with unitShaders.js */
export const MAT = {
  LINEN: 0, MAIL: 1, PLATE: 2, GAMBESON: 3,
  SKIN: 4, HAIR: 5, LEATHER: 6, WOOD: 7
};

/**
 * Anatomy profiles. `height`/`limbW`/`chestD` scale the skeleton's rest
 * offsets; the rest are direct measurements in metres at height = 1.
 */
export const PROFILES = {
  /* The approved imposing juggernaut. */
  manAtArms: {
    height: 1.08, shoulderW: 1.24, chestD: 1.22, waist: 1.02, limbW: 1.16,
    headR: 1.02, stance: 1.2
  },
  /* The tighter alternative — same read, less "different species". */
  manAtArmsTight: {
    height: 1.05, shoulderW: 1.18, chestD: 1.16, waist: 1.0, limbW: 1.10,
    headR: 1.0, stance: 1.15
  },
  villager: {
    height: 0.94, shoulderW: 0.96, chestD: 0.95, waist: 0.88, limbW: 0.90,
    headR: 0.98, stance: 1.0
  },
  spearman: {
    height: 1.0, shoulderW: 1.02, chestD: 1.0, waist: 0.94, limbW: 1.0,
    headR: 1.0, stance: 1.05
  }
};

/* Skin tones and hair colours, picked per unit from its animSeed. */
export const SKIN_TONES = [
  [0.82, 0.66, 0.54], [0.72, 0.55, 0.42],
  [0.58, 0.42, 0.31], [0.44, 0.31, 0.23]
];
export const HAIR_COLORS = [
  [0.16, 0.12, 0.09], [0.32, 0.21, 0.12],
  [0.55, 0.42, 0.22], [0.70, 0.62, 0.52]
];

/**
 * Build a Man-at-Arms.
 *
 * @param g       SkinnedBuilder
 * @param prop    profile (PROFILES.manAtArms or .manAtArmsTight)
 * @param opts    { skin:[r,g,b], hair:[r,g,b], age:1..4, plume:bool }
 */
export function buildManAtArms(g, prop, opts = {}) {
  const age = opts.age || 3;
  const skin = opts.skin || SKIN_TONES[0];
  const hair = opts.hair || HAIR_COLORS[0];
  const H = prop.height;
  const lw = prop.limbW;
  const sw = prop.shoulderW;
  const cd = prop.chestD;

  const y = (base) => base * H;
  const x = (base) => base * sw;

  /* ---------- TORSO ----------
     Chest is a lathe so the ribcage can widen above the waist and the
     gambeson/mail can sit over it without a seam. The profile narrows at
     the waist, flares at the hips, and the `squash` makes it deeper than
     it is wide — a barrel chest, not a tube. */
  const torsoProfile = [
    /* Start below the hip joint, not at it. Without a surcoat to cover the
       join (ages I-II) a profile starting at 0.98 leaves a visible gap
       between the tunic hem and the thighs. */
    [x(0.150), y(0.90)],
    [x(0.168), y(0.96)],
    [x(0.175), y(1.12)],
    [x(0.165), y(1.24)],
    [x(0.205), y(1.36)],
    [x(0.225), y(1.45)],
    [x(0.205), y(1.52)],
    [x(0.13), y(1.56)]
  ];
  g.material(age >= 3 ? MAT.MAIL : MAT.GAMBESON);
  g.color(0.78, 0.76, 0.70);
  g.lathe(B.CHEST, torsoProfile, {
    seg: g.seg(0), squash: [1.0, cd / sw * 1.05], blend: B.SPINE
  });

  /* ---------- NECK ---------- */
  g.material(MAT.SKIN).color(skin);
  g.tube(B.NECK, [0, y(1.53), 0], [0, y(1.60), 0], 0.058 * lw, 0.055 * lw,
    { seg: 5, rings: 2, blend: B.CHEST });

  /* ---------- HEAD ----------
     Cranium, jaw and brow as three ellipsoids. A single sphere reads as a
     ball; the jaw taper is most of what makes a head a head at 4 m. */
  const headY = y(1.68);
  const hr = 0.098 * prop.headR;
  g.ellipsoid(B.HEAD, [0, headY, 0], [hr, hr * 1.16, hr * 1.06]);
  /* jaw: narrower, lower, pulled forward slightly. This one stays at every
     tier — a head without a jaw is a ball. */
  g.ellipsoid(B.HEAD, [0, headY - hr * 0.62, hr * 0.16], [hr * 0.82, hr * 0.55, hr * 0.80],
    { sph: [5, 3] });
  /* Brow ridge and nose carry the face at 4 m; the far tier drops them
     because a soldier four pixels tall does not have a brow. */
  if (g.detail <= DETAIL.MID) {
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.22, hr * 0.72], [hr * 0.74, hr * 0.20, hr * 0.30]);
  }
  if (g.detail === DETAIL.NEAR) {
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.06, hr * 1.0], [hr * 0.17, hr * 0.26, hr * 0.22],
      { sph: [5, 3] });
  }

  /* ---------- HELM ----------
     Age I–II: kettle hat (a shallow cone). Age III+: barbute with a
     cheek flare, which is the silhouette tell at strategic zoom. */
  g.material(MAT.PLATE).color(0.70, 0.72, 0.76);
  if (age <= 2) {
    g.lathe(B.HEAD, [
      [hr * 1.12, headY + hr * 0.55],
      [hr * 1.30, headY + hr * 0.70],
      [hr * 1.05, headY + hr * 0.86],
      [0.0, headY + hr * 0.92]
    ], { seg: g.seg(1), y: 0 });
  } else {
    /* barbute: dome plus the cheek flare that makes it recognisable */
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.26, 0], [hr * 1.10, hr * 0.98, hr * 1.10], { cut: 0.35 });
    if (g.detail <= DETAIL.MID) {
      g.lathe(B.HEAD, [
        [hr * 1.06, headY - hr * 0.55],
        [hr * 1.12, headY - hr * 0.10],
        [hr * 1.10, headY + hr * 0.30]
      ], { seg: g.seg(1) });
    }
  }
  /* ---------- HAIR ----------
     A cap plus swept locks. Locks are what read as hair rather than a
     painted helmet liner, and they can lag independently (Pillar 3). */
  if (age <= 2 || opts.plume === false) {
    g.material(MAT.HAIR).color(hair);
    g.ellipsoid(B.HAIR, [0, headY - hr * 0.06, -hr * 0.30], [hr * 1.04, hr * 0.86, hr * 0.92], { sph: [5, 3] });
  }
  /* ---------- CREST / PLUME (Age IV) ---------- */
  if (age >= 4) {
    g.material(MAT.HAIR).color([0.55, 0.10, 0.10]);
    for (let i = 0; i < 4; i++) {
      const t = (i - 1.5) / 1.5;
      g.tube(B.HEAD, [0, headY + hr * 1.1, t * hr * 0.6],
        [0, headY + hr * (1.55 + 0.2 * (1 - Math.abs(t))), t * hr * 0.9],
        0.022, 0.014, { seg: 4, rings: 2, blend: B.HEAD });
    }
  }

  /* ---------- LEGS ----------
     Thigh, shin and a foot slab. The knee blend is what stops the joint
     pinching when it bends. */
  for (const side of [-1, 1]) {
    const HIP = side < 0 ? B.HIP_L : B.HIP_R;
    const THIGH = side < 0 ? B.THIGH_L : B.THIGH_R;
    const SHIN = side < 0 ? B.SHIN_L : B.SHIN_R;
    const FOOT = side < 0 ? B.FOOT_L : B.FOOT_R;
    const hipX = side * x(0.105) * prop.stance;

    g.material(age >= 3 ? MAT.MAIL : MAT.LINEN).color(0.62, 0.58, 0.50);
    g.tube(THIGH, [hipX, y(0.96), 0], [hipX * 1.06, y(0.52), 0],
      0.092 * lw, 0.070 * lw, { seg: g.seg(1), rings: g.rings(0), blend: HIP });
    /* A shin is nearly a straight taper: one fewer segment each way is
       invisible and worth 30 triangles per leg. */
    g.tube(SHIN, [hipX * 1.06, y(0.52), 0], [hipX * 1.02, y(0.09), 0],
      0.072 * lw, 0.048 * lw, { seg: g.seg(0), rings: g.rings(0), blend: THIGH });
    /* the boot: a slab is correct here, feet are boxy */
    g.material(MAT.LEATHER).color(0.32, 0.24, 0.17);
    g.slab(FOOT, [hipX * 1.02, y(0.055), 0.045], [0.098 * lw, 0.095 * H, 0.235 * H]);
  }

  /* ---------- ARMS ----------
     Deltoid, upper arm, forearm, hand. The shoulder ellipsoid is what
     makes a pauldron sit on a body instead of hover. */
  for (const side of [-1, 1]) {
    const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
    const UP = side < 0 ? B.UPPER_ARM_L : B.UPPER_ARM_R;
    const FORE = side < 0 ? B.FOREARM_L : B.FOREARM_R;
    const HAND = side < 0 ? B.HAND_L : B.HAND_R;
    /* The arm hangs from the deltoid, which must clear the ribcage:
       at 0.215 the forearm was drawing inside the torso. */
    const sx = side * x(0.268);

    g.material(age >= 3 ? MAT.MAIL : MAT.LINEN).color(0.66, 0.62, 0.55);
    /* deltoid / pauldron shelf */
    g.ellipsoid(SHO, [sx, y(1.42), 0], [0.108 * lw, 0.100 * lw, 0.108 * lw], { sph: [6, 4] });
    g.tube(UP, [sx, y(1.40), 0], [sx * 0.98, y(1.13), 0],
      0.070 * lw, 0.056 * lw, { seg: g.seg(0), rings: g.rings(0), blend: SHO });
    g.tube(FORE, [sx * 0.98, y(1.13), 0], [sx * 0.96, y(0.86), 0],
      0.058 * lw, 0.044 * lw, { seg: g.seg(0), rings: g.rings(0), blend: UP });
    /* hand: a small tapered block, not a sphere */
    g.material(MAT.SKIN).color(skin);
    g.tube(HAND, [sx * 0.96, y(0.86), 0], [sx * 0.95, y(0.78), 0],
      0.045 * lw, 0.038 * lw, { seg: 4, rings: 1, blend: FORE });

    if (age >= 3 && g.detail <= DETAIL.MID) {
      /* pauldron cap over the deltoid */
      g.material(MAT.PLATE).color(0.68, 0.70, 0.74);
      g.ellipsoid(SHO, [sx, y(1.40), 0], [0.128 * lw, 0.098 * lw, 0.122 * lw], { cut: 0.45, sph: [6, 4] });
    }
  }

  /* ---------- SURCOAT ----------
     The heraldic tabard, split at the legs. A lathe from the waist to
     mid-thigh, weighted to the skirt bone so it can swing. */
  if (age >= 2 && g.detail <= DETAIL.MID) {
    g.material(MAT.LINEN).color(0.72, 0.70, 0.74);
    /* Widen it at the hem and pinch it at the belt: a garment swinging off
       the hips, not a bucket with legs coming out of it. */
    g.lathe(B.SKIRT, [
      [x(0.170), y(1.02)],
      [x(0.196), y(0.93)],
      [x(0.214), y(0.82)],
      [x(0.232), y(0.70)],
      [x(0.236), y(0.62)],
      [x(0.222), y(0.56)]
    ], { seg: g.seg(1), squash: [1.0, cd / sw] });
  }

  /* ---------- ARMS: SWORD AND SHIELD ----------
     Held in the hands, weighted to them, so they follow the wrist. */
  const rh = [x(0.258), y(0.79), 0.03];
  g.material(MAT.PLATE).color(0.80, 0.82, 0.86);
  g.blade(B.HAND_R, rh, [rh[0] - 0.02, y(0.44), 0.05], 0.030,
    { thick: 0.010, guard: g.detail <= DETAIL.MID ? 0.10 : 0 });
  /* shield on the left, facing out */
  g.material(MAT.WOOD).color(0.55, 0.46, 0.34);
  /* A heater shield is carried on the forearm, tilted, hanging just below
     the elbow — not floating at shoulder height. */
  g.heater(B.HAND_L, [-x(0.285), y(1.12), 0.13], [0.34, 0.48, 0.030],
    { rot: 0.22, dome: 0.30 });

  return g;
}

/** Rig registry, keyed so the renderer can look one up by class + variant. */
export const RIGS = {
  man_at_arms: { profile: 'manAtArms', build: buildManAtArms },
  man_at_arms_tight: { profile: 'manAtArmsTight', build: buildManAtArms }
};

/**
 * Build one rig at a detail tier.
 * @returns {{packed, indices, tris, vertices}}
 */
export function buildRig(key, detail = DETAIL.MID, opts = {}) {
  const rig = RIGS[key];
  if (!rig) throw new Error('unknown rig: ' + key);
  const g = new SkinnedBuilder(detail);
  const prop = PROFILES[rig.profile];
  if (!prop) throw new Error('no profile for ' + key + ': ' + rig.profile);
  rig.build(g, prop, opts);
  return g.finish();
}
