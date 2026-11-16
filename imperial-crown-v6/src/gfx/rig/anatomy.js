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
  /* THE TORSO PROFILE.
     A lathe is a body of revolution, so the only thing carrying the figure
     is its silhouette from the front, and that silhouette has to taper.
     The previous profile went 0.150 -> 0.168 -> 0.175 -> 0.165 -> 0.205 ->
     0.225: three near-equal rings from the hip to the sternum, which is a
     barrel with a lid, and every unarmoured soldier read as a slab-chested
     robot. It also ran straight up the neck, so the collar was a wide funnel.

     This is a person: hip, waist (narrower than the hip -- that is what a
     waist is), ribcage flaring to the chest, then a steep slope in to the
     shoulders and the base of the neck. The top closes on the neck, which is
     what removes the hole in the collar. */
  /* Top of the neck, just under the chin. */
  const neckTopY = y(1.68) - 0.098 * prop.headR * 0.96;
  const torsoProfile = [
    [x(0.148), y(0.90)],   /* below the hip joint, so the tunic meets the thigh */
    [x(0.162), y(0.97)],
    [x(0.150), y(1.06)],   /* waist: narrower than the hip */
    [x(0.166), y(1.16)],
    [x(0.205), y(1.28)],   /* ribcage */
    [x(0.226), y(1.38)],   /* chest, widest */
    [x(0.222), y(1.44)],
    [x(0.196), y(1.49)],   /* shoulder slope */
    /* The neck run must stop BELOW the chin.
       Head centre is y(1.68) and the chin is 1.06 hr under it -- about
       1.58 at a standard height. Carrying the torso up to 1.66 put it
       through the jaw: the beard and the whole lower face were buried
       inside the tunic, and what showed at the collar was the inside of
       the torso. These heights are relative to the head, not fixed. */
    [x(0.140), y(1.525)],
    [x(0.100), neckTopY - 0.052],
    [x(0.078), neckTopY - 0.016],
    [x(0.074), neckTopY]
  ];
  g.material(fabric);
  if (opts.bodyCol) g.color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
  else g.color(0.78, 0.76, 0.70);
  g.lathe(B.CHEST, torsoProfile, {
    seg: g.seg(0), squash: [1.0, cd / sw * 1.05], blend: B.SPINE
  });

  /* ---------- NECK ---------- */
  g.material(4).color(skin);
  /* The neck has to be wide enough to fill the hole in the top of the
     torso lathe, which closes to x(0.130) at y(1.56). At 0.058 the neck
     was a pencil through a collar two sizes too big and you could see
     straight down into the chest. */
  /* No separate neck tube: the torso profile above carries the neck now.
     A tube pushed through a hole and a dome patched over the rim were both
     attempts to hide a seam that this removes. */

  /* ---------- HEAD ----------
     ONE surface of revolution, from the point of the chin to the crown.

     Two overlapping ellipsoids still produced a jagged lens where the jaw
     and the cranium crossed, because at six segments a sphere is a
     polyhedron and two polyhedra intersecting give a zigzag. There is no
     tessellation that fixes that, and a face built out of stacked closed
     volumes can only ever be a heap of shards at close range.

     A lathe has no interior to intersect with. This profile is the skull:
     chin, jaw, cheek, temple, crown -- and because the radius is a function
     of height, the silhouette is smooth from every angle. Squashed on X so
     the head is narrower than it is deep, which is what a head is.

     What it cannot do is a nose, which projects rather than revolves; that
     stays a separate small ellipsoid and only appears at NEAR. */
  const headY = y(1.68);
  const hr = 0.098 * prop.headR;
  g.material(4).color(skin);
  const chinY = headY - hr * 1.06;
  const crownY = headY + hr * 1.14;
  const headH = crownY - chinY;
  /* radius fractions of hr at even steps from chin to crown */
  /* The radius fractions are of `hr`, which is already the head's half-width,
     so the widest ring must be 1.0 -- at 0.94 times a further 0.94 the skull
     came out 12% too narrow and read as a cone with a forehead. The chin is
     lifted off zero for the same reason: a true zero radius is a point, and a
     point chin on a seven-segment lathe is a spike. */
  const skull = [
    [0.00, 0.16],   /* chin, blunt */
    [0.22, 0.52],   /* jaw */
    [0.46, 0.80],   /* cheekbone */
    [0.70, 1.00],   /* temples: widest */
    [0.88, 0.92],   /* upper skull turning over */
    [1.00, 0.34]    /* crown, rounded rather than pointed */
  ];
  g.lathe(B.HEAD, skull.map(([t, r]) => [r * hr, chinY + headH * t]), {
    seg: g.seg(0), squash: [1.0, 1.10], blend: B.NECK
  });
  if (g.detail === DETAIL.NEAR) {
    /* nose: projects from the face, so it is the one feature the lathe
       cannot carry */
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.14, hr * 0.86],
      [hr * 0.16, hr * 0.26, hr * 0.26], { sph: [4, 3] });
  }

  /* ---------- LEGS ----------
     Thigh, shin, boot. The knee blend is what stops the joint pinching. */
  for (const side of [-1, 1]) {
    /* Same trap as the arms: the boot at the end of the iteration switches
       the builder to LEATHER, so the second leg was being built in boot
       leather. One trouser leg brown, one grey. */
    g.material(legMat).color(0.62, 0.58, 0.50);
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
  const armX = 0.268;
  for (const side of [-1, 1]) {
    /* The sleeve material is set INSIDE the loop. It used to be set once
       before it, and the hand block at the end of the iteration switched the
       builder to SKIN -- so the second arm was built entirely in skin and
       every soldier in the game had a bare right arm under a sleeved tunic.
       A material is builder state, not geometry state: anything the loop
       sets, the loop has to restore. */
    if (opts.bodyCol) g.material(fabric).color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
    else g.material(fabric).color(0.66, 0.62, 0.55);
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

  /* The cap is a FULL ellipsoid, not a cut one.
     `cut` keeps the top and throws the bottom rings away, which leaves an
     open shell: from the front you look through the hair's underside and
     see the back of the skull's interior, and at close range the head was a
     pale dome with brown shards inside it. A full shell encloses the
     cranium and cannot be seen through from any angle. Its lower half is
     inside the skull, which costs nothing and needs no cap. */
  g.ellipsoid(B.HAIR, [0, headY + hr * 0.13, -hr * 0.24],
    [hr * 1.10, hr * 1.05, hr * 1.08], { sph: [6, 4] });

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
    /* A beard sits ON the jaw. This was at headY - hr*0.98, which is below
       the chin and inside the collar, so it rendered as a dark hexagonal
       hole at the throat rather than as a beard -- and being pure hair
       colour it read as a gap in the body. It is now centred on the jaw
       line, slightly proud of the face, and lifted off black. */
    /* On the jaw, projecting forward, and lifted well clear of the hair.
       HAIR_COLORS[0] is 0.16/0.12/0.09, so multiplying it -- even by two --
       still lands at 0.42 and a beard under a helmet reads as a hole. A
       beard is also greyer than the hair it belongs to, which this uses. */
    g.material(5).color(
      Math.min(1, 0.30 + hair[0] * 0.85),
      Math.min(1, 0.26 + hair[1] * 0.85),
      Math.min(1, 0.22 + hair[2] * 0.85));
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.62, hr * 0.42],
      [hr * 0.56, hr * 0.40, hr * 0.50], { sph: [5, 3] });
  }
}
