/* ============================================================
   anatomy.js — the shared human body

   Every humanoid in the game is built from this file, then dressed by
   wardrobe.js. Splitting body from clothing matters for two reasons:

   1. Twenty unit classes is too many to write twenty bespoke builds for.
      A villager and a man-at-arms have the same skeleton, the same
      ribcage and the same elbow; only the proportions and the clothes
      differ.

   2. A class that is *only* a shape change (villager vs spearman) should
      not drift away from the rest of the cast over time. If the torso
      lathe improves, it improves for everyone.

   All measurements are in metres at height = 1 and multiplied by the
   profile, so a 1.08-height man-at-arms is exactly 8% taller everywhere.
   ============================================================ */

import { B } from './skeleton.js';
import { DETAIL } from './meshbuilder.js';

/**
 * Emit the naked body: torso, neck, head, arms, legs, feet.
 *
 * Returns the shared measurements the wardrobe layer needs, so clothing
 * can be placed against the same numbers the body was built from rather
 * than re-deriving them (and disagreeing).
 */
export function buildBody(g, prop, opts = {}) {
  const H = prop.height;
  const lw = prop.limbW;
  const sw = prop.shoulderW;
  const cd = prop.chestD;

  const y = (base) => base * H;
  const x = (base) => base * sw;

  const skin = opts.skin || [0.72, 0.55, 0.42];
  const fabric = opts.bodyMat !== undefined ? opts.bodyMat : 3;   // GAMBESON
  const legMat = opts.legMat !== undefined ? opts.legMat : 3;

  /* ---------- TORSO ----------
     A lathe, because a ribcage is wider at the chest than at the waist and
     a cylinder is the thing this overhaul exists to remove. The `squash`
     makes it deeper than it is wide: a barrel chest, not a tube. */
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
    [x(0.130), y(1.56)]
  ];
  g.material(fabric);
  if (opts.bodyCol) g.color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
  else g.color(0.78, 0.76, 0.70);
  g.lathe(B.CHEST, torsoProfile, {
    seg: g.seg(0), squash: [1.0, cd / sw * 1.05], blend: B.SPINE
  });

  /* ---------- NECK ---------- */
  g.material(4).color(skin);
  g.tube(B.NECK, [0, y(1.53), 0], [0, y(1.60), 0], 0.058 * lw, 0.055 * lw,
    { seg: 5, rings: 2, blend: B.CHEST });

  /* ---------- HEAD ----------
     Cranium plus a jaw. A single sphere reads as a ball; the jaw taper is
     most of what makes a head a head at 4 m. */
  const headY = y(1.68);
  const hr = 0.098 * prop.headR;
  g.material(4).color(skin);
  g.ellipsoid(B.HEAD, [0, headY, 0], [hr, hr * 1.16, hr * 1.06], { sph: [7, 4] });
  g.ellipsoid(B.HEAD, [0, headY - hr * 0.62, hr * 0.16], [hr * 0.82, hr * 0.55, hr * 0.80],
    { sph: [5, 3] });

  /* Brow and nose carry the face at close range; a soldier four pixels tall
     does not have a brow, so they appear only where they can be seen. */
  if (g.detail <= DETAIL.MID) {
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.22, hr * 0.72], [hr * 0.74, hr * 0.20, hr * 0.30],
      { sph: [5, 3] });
  }
  if (g.detail === DETAIL.NEAR) {
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.06, hr * 1.0], [hr * 0.17, hr * 0.26, hr * 0.22],
      { sph: [5, 3] });
  }

  /* ---------- LEGS ----------
     Thigh, shin, boot. The knee blend is what stops the joint pinching. */
  g.material(legMat).color(0.62, 0.58, 0.50);
  for (const side of [-1, 1]) {
    const HIP = side < 0 ? B.HIP_L : B.HIP_R;
    const THIGH = side < 0 ? B.THIGH_L : B.THIGH_R;
    const SHIN = side < 0 ? B.SHIN_L : B.SHIN_R;
    const FOOT = side < 0 ? B.FOOT_L : B.FOOT_R;
    const hipX = side * x(0.105) * prop.stance;

    g.tube(THIGH, [hipX, y(0.96), 0], [hipX * 1.06, y(0.52), 0],
      0.092 * lw, 0.070 * lw, { seg: g.seg(1), rings: g.rings(0), blend: HIP });
    /* A shin is nearly a straight taper: one fewer segment each way is
       invisible and worth 30 triangles per leg. */
    g.tube(SHIN, [hipX * 1.06, y(0.52), 0], [hipX * 1.02, y(0.09), 0],
      0.072 * lw, 0.048 * lw, { seg: g.seg(0), rings: g.rings(0), blend: THIGH });
    /* the boot: a slab is correct here, feet are boxy */
    g.material(6).color(0.32, 0.24, 0.17);
    g.slab(FOOT, [hipX * 1.02, y(0.055), 0.045], [0.098 * lw, 0.095 * H, 0.235 * H]);
  }

  /* ---------- ARMS ----------
     Deltoid, upper arm, forearm, hand. The shoulder ellipsoid is what makes
     armour sit on a body instead of hovering over it. */
  if (opts.bodyCol) g.material(fabric).color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
  else g.material(fabric).color(0.66, 0.62, 0.55);
  const armX = 0.268;
  for (const side of [-1, 1]) {
    const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
    const UP = side < 0 ? B.UPPER_ARM_L : B.UPPER_ARM_R;
    const FORE = side < 0 ? B.FOREARM_L : B.FOREARM_R;
    const HAND = side < 0 ? B.HAND_L : B.HAND_R;
    /* The arm hangs from the deltoid, which must clear the ribcage: at 0.215
       the forearm drew inside the torso. */
    const sx = side * x(armX);

    g.ellipsoid(SHO, [sx, y(1.42), 0], [0.108 * lw, 0.100 * lw, 0.108 * lw], { sph: [6, 4] });
    g.tube(UP, [sx, y(1.40), 0], [sx * 0.98, y(1.13), 0],
      0.070 * lw, 0.056 * lw, { seg: g.seg(0), rings: g.rings(0), blend: SHO });
    g.tube(FORE, [sx * 0.98, y(1.13), 0], [sx * 0.96, y(0.86), 0],
      0.058 * lw, 0.044 * lw, { seg: g.seg(0), rings: g.rings(0), blend: UP });
    /* hand: a small tapered block, not a sphere */
    g.material(4).color(skin);
    g.tube(HAND, [sx * 0.96, y(0.86), 0], [sx * 0.95, y(0.78), 0],
      0.045 * lw, 0.038 * lw, { seg: 4, rings: 1, blend: FORE });
  }

  return {
    H, lw, sw, cd, y, x,
    headY, hr, armX,
    /** Where the two hands sit in bind pose, for placing weapons and tools. */
    handX: 0.268 * sw * 0.95,
    handY: y(0.82),
    shoulderY: y(1.42)
  };
}

/**
 * The hair cap plus optional swept locks.
 *
 * Locks are what read as hair rather than a painted helmet liner, and they
 * hang off the HAIR bone so they can lag the head independently.
 */
export function buildHair(g, m, prop, opts = {}) {
  const { headY, hr } = m;
  const hair = opts.hair || [0.16, 0.12, 0.09];
  const style = opts.hairStyle || 'short';
  g.material(5).color(hair);

  if (style === 'bald') return;

  /* Sits proud of the skull, not inside it: the cranium is hr*1.16 tall in
     Y, so a cap at hr*0.86 was entirely swallowed. */
  g.ellipsoid(B.HAIR, [0, headY + hr * 0.10, -hr * 0.22],
    [hr * 1.12, hr * 1.06, hr * 1.10], { cut: 0.18, sph: [6, 4] });

  if (style === 'long') {
    /* A tail behind the head, hanging to the shoulder blades. */
    g.tube(B.HAIR, [0, headY - hr * 0.30, -hr * 0.85],
      [0, m.y(1.30), -hr * 1.15], hr * 0.62, hr * 0.42,
      { seg: g.seg(0), rings: g.rings(0) });
  } else if (style === 'braid') {
    g.tube(B.HAIR, [0, headY - hr * 0.35, -hr * 0.80],
      [0, m.y(1.36), -hr * 0.95], hr * 0.52, hr * 0.34,
      { seg: 4, rings: g.rings(0) });
  }
}

/**
 * Eyebrows and a beard, which is most of what distinguishes one peasant
 * from another at gameplay distance. Only worth drawing up close.
 */
export function buildFaceDetail(g, m, opts = {}) {
  if (g.detail > DETAIL.MID) return;
  const { headY, hr } = m;
  const hair = opts.hair || [0.16, 0.12, 0.09];
  g.material(5).color(hair);
  if (opts.beard) {
    /* a beard is a flattened blob under the jaw, not a second sphere */
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.98, hr * 0.34],
      [hr * 0.62, hr * 0.42, hr * 0.52], { sph: [5, 3] });
  }
}
