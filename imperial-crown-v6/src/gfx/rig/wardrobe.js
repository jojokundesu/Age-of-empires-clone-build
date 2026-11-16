/* ============================================================
   wardrobe.js — heads, armour and carried kit

   Each function dresses the body that anatomy.js emitted. They are
   deliberately small and independent: a class is a list of which ones to
   call, which is what lets twenty unit types share one body without
   twenty copies of it.

   The Age I->IV ladder lives here. A kettle hat becomes a barbute becomes
   a crested great helm; linen becomes mail becomes plate. The `age` test
   is deliberately generous with silhouette and stingy with ornament —
   what changes across ages should be readable at strategic zoom, and a
   rivet is not.
   ============================================================ */

import { B } from './skeleton.js';
import { DETAIL } from './meshbuilder.js';

/* Material ids, shared with unitShaders.js. */
export const MAT = {
  LINEN: 0, MAIL: 1, PLATE: 2, GAMBESON: 3,
  SKIN: 4, HAIR: 5, LEATHER: 6, WOOD: 7
};

/* ------------------------------------------------------------
   Heads
   ------------------------------------------------------------ */

/**
 * Helmet, from a bare hood to a crested great helm.
 *
 * @param kind 'none' | 'hood' | 'kettle' | 'barbute' | 'great' | 'nasal' |
 *             'turban' | 'cone'
 */
export function buildHelm(g, m, kind, age = 3, opts = {}) {
  const { headY, hr } = m;
  if (kind === 'none') return;
  g.material(kind === 'hood' || kind === 'turban' ? MAT.LINEN : MAT.PLATE);
  g.color(kind === 'hood' ? 0.55 : 0.70, kind === 'hood' ? 0.50 : 0.72,
    kind === 'hood' ? 0.44 : 0.76);

  if (kind === 'hood') {
    /* Cloth over the skull, falling to the shoulders. A full dome (no `cut`,
       which removes the crown and leaves a brim-shaped ring) plus a short
       cowl down the back of the neck. */
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.06, -hr * 0.12],
      [hr * 1.04, hr * 1.06, hr * 1.08], { sph: [6, 4] });
    g.lathe(B.HEAD, [
      [hr * 1.16, headY - hr * 0.30],
      [hr * 1.22, headY - hr * 0.62],
      [hr * 1.18, headY - hr * 0.92]
    ], { seg: g.seg(1) });
    return;
  }

  if (kind === 'kettle') {
    /* A shallow brimmed hat: the Age I-II silhouette. */
    g.lathe(B.HEAD, [
      [hr * 1.12, headY + hr * 0.40],
      [hr * 1.62, headY + hr * 0.52],
      [hr * 1.14, headY + hr * 0.70],
      [0.0, headY + hr * 0.96]
    ], { seg: g.seg(1) });
    return;
  }

  if (kind === 'nasal') {
    /* Spangenhelm: a dome with a nose guard, the early knight's helm.
       Sized to the SKULL (0.94 of it in X, the lathe's own figure) plus a
       millimetre, not to 1.10 of the head sphere it is not shaped like --
       at 1.10 all round the helm was wider than the face and swallowed it,
       leaving a helmet with a beard under it and no visible eyes. */
    /* `cut` is the fraction of the ellipsoid's lower half that is thrown
       away, so 0.34 keeps two thirds of it and the rim lands well BELOW the
       eyes -- a nasal helm is a skullcap, and its rim belongs above the
       brow. 0.60 keeps the top 40%. */
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.30, -hr * 0.04],
      [hr * 0.98, hr * 1.04, hr * 0.96], { cut: 0.50, sph: [6, 4] });
    g.slab(B.HEAD, [0, headY + hr * 0.06, hr * 0.90], [hr * 0.14, hr * 0.62, hr * 0.10]);
    return;
  }

  if (kind === 'cone') {
    /* Tall conical helm: the steppe and the Rus. */
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.26, -hr * 0.04],
      [hr * 0.96, hr * 1.00, hr * 0.94], { cut: 0.55, sph: [6, 4] });
    g.lathe(B.HEAD, [
      [hr * 1.02, headY + hr * 0.70],
      [hr * 0.52, headY + hr * 1.36],
      [0.0, headY + hr * 1.72]
    ], { seg: g.seg(1) });
    return;
  }

  if (kind === 'turban') {
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.22, -hr * 0.04],
      [hr * 1.02, hr * 0.80, hr * 1.00], { cut: 0.44, sph: [6, 4] });
    /* the brow band sits ABOVE the eyes and stops at the temples */
    g.lathe(B.HEAD, [
      [hr * 1.16, headY + hr * 0.14],
      [hr * 1.20, headY + hr * 0.40]
    ], { seg: g.seg(1) });
    return;
  }

  /* Model faces +Z (theta = PI/2). Centre the arc on the BACK and leave the
     front third open: that opening is the face. */
  const FLARE_ARC = Math.PI * 1.34;
  const FLARE_START = Math.PI * 0.5 + Math.PI * 0.33;
  /* barbute and great helm: ONE lathe from the neck flare to the crown.
     It used to be a cut ellipsoid dome plus a separate arc for the flare,
     and the two did not meet -- the dome's rim sat 0.13 hr inside the
     flare's, so there was a gap all the way round the helmet at brow
     height and you saw the face through it.

     A lathe cannot open a gap, and the profile is exactly what a barbute
     is: a neck flare, a cheek line, a temple, a crown. The face opening is
     cut out of the front by sweeping an arc that stops at the temples. */
  g.lathe(B.HEAD, [
    [hr * 0.99, headY - hr * 0.50],
    [hr * 1.04, headY - hr * 0.12],
    [hr * 1.02, headY + hr * 0.18],
    [hr * 1.00, headY + hr * 0.68],
    [hr * 0.62, headY + hr * 1.16],
    [0.0, headY + hr * 1.30]
  ], { seg: g.seg(1), arc: FLARE_ARC, arcStart: FLARE_START });
  if (kind === 'great' && g.detail <= DETAIL.MID) {
    /* A visor: the horizontal slot is the whole point of the shape. */
    g.slab(B.HEAD, [0, headY + hr * 0.10, hr * 1.02], [hr * 0.92, hr * 0.30, hr * 0.16]);
  }
}

/** A crest or plume, Age III+. */
export function buildCrest(g, m, colour, count = 4) {
  const { headY, hr } = m;
  g.material(MAT.HAIR).color(colour);
  for (let i = 0; i < count; i++) {
    const t = (i - (count - 1) / 2) / ((count - 1) / 2 || 1);
    g.tube(B.HEAD, [0, headY + hr * 1.10, t * hr * 0.60],
      [0, headY + hr * (1.55 + 0.20 * (1 - Math.abs(t))), t * hr * 0.90],
      0.022, 0.014, { seg: 4, rings: 2 });
  }
}

/* ------------------------------------------------------------
   Torso armour and garments
   ------------------------------------------------------------ */

/** A surcoat or tunic hanging off the hips, split for the legs. */
export function buildSurcoat(g, m, opts = {}) {
  const { x, y, cd, sw } = m;
  const flares = opts.flares !== false;
  /* Mid grey, not near-white: the team tint replaces the hue and keeps
     this garment's luminance, so a white surcoat has no value left to
     keep and flattens into a saturated slab. */
  g.material(MAT.LINEN).color(0.58, 0.56, 0.60);
  const profile = flares
    ? [
      [x(0.170), y(1.02)],
      [x(0.196), y(0.93)],
      [x(0.214), y(0.82)],
      [x(0.232), y(0.70)],
      [x(0.236), y(0.62)],
      [x(0.222), y(0.56)]
    ]
    : [
      [x(0.168), y(1.00)],
      [x(0.188), y(0.90)],
      [x(0.196), y(0.78)],
      [x(0.192), y(0.68)]
    ];
  g.lathe(B.SKIRT, profile, { seg: g.seg(1), squash: [1.0, cd / sw] });
}

/** Pauldrons: a shell over each deltoid. */
export function buildPauldrons(g, m) {
  const { x, y, lw } = m;
  for (const side of [-1, 1]) {
    const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
    const sx = side * x(m.armX);
    g.material(MAT.PLATE).color(0.68, 0.70, 0.74);
    g.ellipsoid(SHO, [sx, y(1.40), 0],
      [0.128 * lw, 0.098 * lw, 0.122 * lw], { cut: 0.45, sph: [5, 3] });
  }
}

/** A belt at the waist, which stops a tunic reading as a sack. */
export function buildBelt(g, m) {
  if (g.detail > DETAIL.MID) return;
  const { x, y, cd, sw } = m;
  /* Lifted off pure black, and given a real profile.
     The leather was 0.30/0.22/0.15, which against a mid-grey tunic reads as
     a black gap rather than as a strap, and the three-point lathe had no
     thickness -- a ribbon standing off the waist with visible nothing
     behind it at the top and bottom edges. */
  g.material(MAT.LEATHER).color(0.42, 0.31, 0.20);
  g.lathe(B.SKIRT, [
    [x(0.176), y(1.055)],
    [x(0.190), y(1.035)],
    [x(0.192), y(0.975)],
    [x(0.176), y(0.955)]
  ], { seg: g.seg(2), squash: [1.0, cd / sw] });
  /* buckle: a small plate on the front, which is what stops the band
     reading as a painted stripe */
  g.material(MAT.PLATE).color(0.62, 0.62, 0.64);
  g.slab(B.SKIRT, [0, y(1.005), x(0.196) * cd / sw], [0.052, 0.048, 0.012]);
}

/** A cloak hanging from the shoulders, weighted to the skirt bone. */
export function buildCape(g, m, colour) {
  if (g.detail > DETAIL.MID) return;
  const { x, y } = m;
  /* Lifted toward mid grey: a saturated near-black cape reads as a hole in
     the silhouette rather than as cloth, especially at the shading angles
     the game's sun actually produces. */
  g.material(MAT.LINEN).color(
    colour[0] * 0.75 + 0.18,
    colour[1] * 0.75 + 0.16,
    colour[2] * 0.75 + 0.16);
  /* A cape is a lathe cut off at the front: two thirds of a cone. */
  /* Two thirds of a circle, centred on the back: a cape is open at the
     front. A full lathe here wraps the knight in a closed cone. */
  g.lathe(B.SKIRT, [
    [x(0.220), y(1.48)],
    [x(0.262), y(1.10)],
    [x(0.300), y(0.72)],
    [x(0.312), y(0.50)]
  /* The model faces +Z, so the back is at theta = -PI/2. Centring the arc
     there is what puts the cape behind the shoulders instead of hanging off
     one side. */
  ], {
    seg: g.seg(1), squash: [1.0, 1.10],
    arc: Math.PI * 1.34, arcStart: -Math.PI * 0.5 - Math.PI * 0.67
  });
}

/* ------------------------------------------------------------
   Carried kit
   ------------------------------------------------------------ */

/** A straight blade held in a hand. */
export function buildSword(g, hand, pos, len, opts = {}) {
  g.material(MAT.PLATE).color(0.80, 0.82, 0.86);
  g.blade(hand, pos, [pos[0] - 0.02, pos[1] - len, pos[2] + 0.05],
    0.030, { thick: 0.010, guard: g.detail <= DETAIL.MID ? 0.10 : 0 });
}

/** A spear: a long shaft with a leaf head. Thrusts, so it hangs upright. */
export function buildSpear(g, hand, pos, len = 1.9) {
  g.material(MAT.WOOD).color(0.48, 0.36, 0.24);
  g.tube(hand, [pos[0], pos[1] + 0.25, pos[2]], [pos[0], pos[1] - len + 0.25, pos[2]],
    0.016, 0.014, { seg: 4, rings: 2 });
  g.material(MAT.PLATE).color(0.76, 0.78, 0.82);
  g.blade(hand, [pos[0], pos[1] + 0.25, pos[2]], [pos[0], pos[1] + 0.52, pos[2]],
    0.030, { thick: 0.012 });
}

/** A bow, held in the off hand. A curved stave, not a straight stick. */
export function buildBow(g, hand, pos) {
  g.material(MAT.WOOD).color(0.42, 0.30, 0.19);
  const h = 0.60;
  /* A bow is a stave bent away from the string. Sample the curve so the
     belly (toward the archer) and the back are actually curved — a straight
     tube reads as a walking stick, which is what it looked like. */
  const steps = g.detail > DETAIL.MID ? 2 : 4;
  const belly = 0.11;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;                 // 0 top .. 1 bottom
    const yy = pos[1] + h - 2 * h * t;
    const bulge = Math.sin(t * Math.PI) * belly;   // 0 at the tips
    pts.push([pos[0] + bulge, yy, pos[2] + bulge * 0.35]);
  }
  const seg = g.detail > DETAIL.MID ? 3 : 4;
  for (let i = 0; i < pts.length - 1; i++) {
    g.tube(hand, pts[i], pts[i + 1], 0.010, 0.012, { seg, rings: 1 });
  }
  /* the string, straight from tip to tip */
  if (g.detail <= DETAIL.MID) {
    g.color(0.72, 0.70, 0.64);
    g.tube(hand, [pos[0], pos[1] + h, pos[2]], [pos[0], pos[1] - h, pos[2]],
      0.003, 0.003, { seg: 3, rings: 1 });
  }
}

/** A quiver on the back, with arrows sticking out. */
export function buildQuiver(g, m) {
  if (g.detail > DETAIL.MID) return;      // invisible at strategic zoom
  const { y, x } = m;
  g.material(MAT.LEATHER).color(0.34, 0.25, 0.17);
  g.tube(B.CHEST, [x(0.10), y(1.44), -0.14], [x(0.14), y(1.10), -0.17],
    0.048, 0.042, { seg: 5, rings: 2 });
  g.material(MAT.WOOD).color(0.50, 0.42, 0.30);
  for (let i = 0; i < 3; i++) {
    const t = (i - 1) * 0.018;
    g.tube(B.CHEST, [x(0.10) + t, y(1.44), -0.14 + t],
      [x(0.11) + t, y(1.62), -0.10 + t], 0.006, 0.005, { seg: 3, rings: 1 });
  }
}

/** A farmer's tool: axe, pick, sickle, crook or mallet. */
export function buildTool(g, hand, pos, kind) {
  g.material(MAT.WOOD).color(0.46, 0.34, 0.22);
  const top = [pos[0], pos[1] + 0.30, pos[2]];
  const bottom = [pos[0], pos[1] - 0.42, pos[2]];
  g.tube(hand, top, bottom, 0.015, 0.017, { seg: 4, rings: 1 });
  if (g.detail > DETAIL.MID) return;
  g.material(MAT.PLATE).color(0.62, 0.63, 0.66);
  if (kind === 'axe' || kind === 'pick') {
    /* A head at the top, offset perpendicular to the haft. */
    g.slab(hand, [top[0] - 0.06, top[1] - 0.02, top[2]],
      [0.11, 0.10, 0.022], { rot: kind === 'pick' ? 0.4 : 0 });
  } else if (kind === 'sickle') {
    g.tube(hand, top, [top[0] + 0.11, top[1] + 0.03, top[2]],
      0.016, 0.008, { seg: 3, rings: 1 });
  } else if (kind === 'mallet') {
    g.slab(hand, [top[0], top[1] - 0.03, top[2]], [0.14, 0.075, 0.075]);
  }
}

/** A staff for a monk: a plain shaft with a knob. */
/**
 * A staff held in a hand.
 *
 * `pos` is [x, y, z, bottom]. The bone argument is `pos[4] ?? hand`: a staff
 * bound to HAND pivots about the palm, so the idle hand swing throws a 1.3 m
 * lever out sideways and the pole leans away from the figure. Anything the
 * hand can grip and the ground has to hold belongs to the body instead, and
 * the hand is inside a sleeve anyway.
 */
export function buildStaff(g, hand, pos) {
  const bone = pos[4] ?? hand;
  g.material(MAT.WOOD).color(0.45, 0.33, 0.21);
  /* `bottom` is optional and exists for the robed classes: a staff held at
     hand height reached the ground and then kept going, so the monk's pole
     hung in space below the hem of his own habit. */
  const bottom = pos[3] ?? (pos[1] - 0.75);
  g.tube(bone, [pos[0], pos[1] + 0.55, pos[2]], [pos[0], bottom, pos[2]],
    0.019, 0.019, { seg: 5, rings: 2 });
  if (g.detail <= DETAIL.MID) {
    g.ellipsoid(bone, [pos[0], pos[1] + 0.58, pos[2]], [0.038, 0.042, 0.038], { sph: [5, 3] });
  }
}

/** A satchel or basket at the hip. */
export function buildSatchel(g, m) {
  if (g.detail > DETAIL.MID) return;
  const { x, y } = m;
  g.material(MAT.LEATHER).color(0.38, 0.28, 0.18);
  g.ellipsoid(B.SKIRT, [x(0.20), y(0.92), 0.10], [0.075, 0.090, 0.055], { sph: [5, 3] });
}
