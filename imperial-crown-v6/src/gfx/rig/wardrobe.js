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
/* The skull lathe is squashed on X (see HEAD_X in anatomy.js), so every
   helm radius that goes across the head has to be squashed with it or the
   helmet is wider than the skull it sits on. */
import { HEAD_X } from './anatomy.js';

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

  /* ---------------------------------------------------------------
     THE CLEARANCE RULE, and why every helmet in this file obeys it.

     `hr` is the skull lathe's own radius, and the skull is the widest
     thing on the head. A helmet that sits at 1.00-1.05 hr is therefore
     not a helmet: it is a second skin, and at six or eight segments the
     flat chords of the two polyhedra fall inside one another at a
     different place in every ring. The skull came out through the sides
     of the barbute, through the crown of the cone, and through the front
     of the great helm, and it looked like geometry tearing.

     Nothing in steel goes below HELM_CLEAR x the skull. The skull is also
     squashed [HEAD_X, 1.10] by anatomy.js, which the earlier helms ignored
     on Z, so they were narrower front-to-back than the head inside them.
     --------------------------------------------------------------- */
  const HELM_CLEAR = 1.16;
  const SQX = HEAD_X * 1.06;
  const SQZ = 1.10 * 1.06;

  /* A padded coif and a mail aventail under every steel rim. Two jobs: it
     hides the skull where the helmet's lower rim stops -- a coif is what a
     real helmet has between the steel and the skin -- and it gives the
     helmet a dark edge, so the eye reads "worn" rather than "intersecting
     dome". Linen for the coif, mail (MAT.MAIL) for the curtain, because
     mail is the thing that has an aventail. */
  /* An arc, not a cone. A full sweep of an aventail at 1.06-1.10 hr is
     WIDER than the face, so the first draft closed every kettle hat and
     every barbute with a dark band across the eyes and nobody had a face
     any more. An aventail hangs off the back and the sides of a helmet down
     to the shoulders; the front is where the face is. 1.55 pi centred on
     the back leaves the whole front quarter open. */
  const AVENTAIL_ARC = Math.PI * 1.55;
  const AVENTAIL_START = -Math.PI * 0.5 - Math.PI * 0.775;
  const coif = () => {
    /* ONE arc, not two. A linen cap under a mail curtain was 70 triangles to
       render a surface the curtain already covers; the curtain alone does
       both jobs -- it darkens the rim and it hides the jaw under the steel. */
    g.material(MAT.MAIL).color(0.40, 0.40, 0.38);
    g.lathe(B.HEAD, [
      [hr * 1.02, headY - hr * 0.52],
      [hr * 1.06, headY - hr * 1.44]
    ], { seg: g.seg(0), squash: [SQX, SQZ],
         arc: AVENTAIL_ARC, arcStart: AVENTAIL_START });
    g.material(kind === 'hood' || kind === 'turban' ? MAT.LINEN : MAT.PLATE);
    g.color(kind === 'hood' ? 0.55 : 0.70, kind === 'hood' ? 0.50 : 0.72,
      kind === 'hood' ? 0.44 : 0.76);
  };

  if (kind === 'hood') {
    /* Cloth over the skull, falling to the shoulders. A FULL body of
       revolution from the cowl hem to the crown, so it has no rim to sit
       above the eyes and no interior to see. */
    g.lathe(B.HEAD, [
      [hr * 1.30, headY - hr * 1.34],
      [hr * 1.18, headY - hr * 0.92],
      [hr * 1.10 * HELM_CLEAR, headY - hr * 0.24],
      [hr * 1.14 * HELM_CLEAR, headY + hr * 0.52],
      [hr * 0.94 * HELM_CLEAR, headY + hr * 1.06],
      [hr * 0.56 * HELM_CLEAR, headY + hr * 1.44],
      [0.0, headY + hr * 1.58]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    return;
  }

  if (kind === 'kettle') {
    /* A shallow brimmed war hat. The bowl has to sit ON the skull with
       clearance and the brim has to be a brim: the old profile ran
       1.12 -> 1.62 -> 1.14 -> 0 over a bare 56 mm of height, a disc rather
       than a hat, and it was written bottom-up, so it drew inside-out and
       the head showed through it. */
    coif();
    g.lathe(B.HEAD, [
      [hr * 1.02 * HELM_CLEAR, headY - hr * 0.30],
      [hr * 1.06 * HELM_CLEAR, headY + hr * 0.30],
      [hr * 1.60 * HELM_CLEAR, headY + hr * 0.40],
      [hr * 1.64 * HELM_CLEAR, headY + hr * 0.50],
      [hr * 1.08 * HELM_CLEAR, headY + hr * 0.62],
      [hr * 1.02 * HELM_CLEAR, headY + hr * 1.02],
      [hr * 0.58 * HELM_CLEAR, headY + hr * 1.30],
      [0.0, headY + hr * 1.40]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    return;
  }

  if (kind === 'nasal') {
    /* Spangenhelm: a dome with a nose guard, the early knight's helm.
       The dome is cut so its rim lands on the brow, and the guard runs
       from the brow down over the bridge of the nose. */
    coif();
    /* Its rim stops ABOVE the eyes. At headY - 0.24 hr the dome came down
       over the brow and the nasal helm was a bowl with a beard under it and
       no face at all -- the same failure as the old cone cap. A spangenhelm
       sits at the brow, which is +0.14 hr above the head's centre. */
    g.lathe(B.HEAD, [
      [hr * 1.00 * HELM_CLEAR, headY + hr * 0.12],
      [hr * 1.06 * HELM_CLEAR, headY + hr * 0.50],
      [hr * 1.02 * HELM_CLEAR, headY + hr * 1.00],
      [hr * 0.60 * HELM_CLEAR, headY + hr * 1.36],
      [0.0, headY + hr * 1.48]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    /* The guard: a narrow bar from under the brow down the bridge. It is the
       one part of a spangenhelm that is not a body of revolution, so it is a
       slab -- narrow in X, and centred just outside the face plane so it
       stands proud of the nose instead of floating in front of it. */
    g.slab(B.HEAD, [0, headY - hr * 0.20, hr * 1.10],
      [hr * 0.22, hr * 0.86, hr * 0.15]);
    return;
  }

  if (kind === 'cone') {
    /* Tall conical helm: the steppe and the Rus. One lathe from the brow
       to the point, starting at full clearance so the skull never shows
       between the cap and the peak. */
    coif();
    g.lathe(B.HEAD, [
      [hr * 1.00 * HELM_CLEAR, headY - hr * 0.22],
      [hr * 1.08 * HELM_CLEAR, headY + hr * 0.16],
      [hr * 1.06 * HELM_CLEAR, headY + hr * 0.74],
      [hr * 0.94 * HELM_CLEAR, headY + hr * 1.42],
      [hr * 0.62 * HELM_CLEAR, headY + hr * 2.10],
      [hr * 0.30 * HELM_CLEAR, headY + hr * 2.66],
      [0.0, headY + hr * 2.94]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    return;
  }

  if (kind === 'turban') {
    coif();
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.22, -hr * 0.04],
      [hr * 1.02 * (HEAD_X * 1.04), hr * 0.80, hr * 1.10], { cut: 0.44, sph: [6, 4] });
    /* the brow band sits ABOVE the eyes and stops at the temples */
    g.lathe(B.HEAD, [
      [hr * 1.16, headY + hr * 0.14],
      [hr * 1.20, headY + hr * 0.40]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    return;
  }

  if (kind === 'great') {
    /* A great helm is not a bigger barbute: it is a BARREL. Closed all the
       way round, deep enough to reach the shoulders, and with the skull
       given real clearance. */
    coif();
    g.lathe(B.HEAD, [
      [hr * 1.02 * HELM_CLEAR, headY - hr * 0.92],
      [hr * 1.18 * HELM_CLEAR, headY - hr * 0.42],
      [hr * 1.18 * HELM_CLEAR, headY + hr * 0.44],
      [hr * 0.96 * HELM_CLEAR, headY + hr * 1.00],
      [hr * 0.58 * HELM_CLEAR, headY + hr * 1.34],
      [0.0, headY + hr * 1.46]
    ], { seg: g.seg(1), squash: [SQX + 0.02, SQZ * 1.06] });
    if (g.detail <= DETAIL.MID) {
      /* The sight slit, as a flush band (see the barbute for why a slab
         cannot win against a curved surface -- it was sticking out past the
         side of the helm as a black bar). */
      /* The band has to FOLLOW the cone, not stand off it as a cylinder.
         The helm flares from 1.20 hr at -0.02 to 1.18 hr at +0.44, so a
         straight-sided band 2 mm proud at its bottom edge was 2 mm INSIDE
         the steel at its top, and the helm's own facets came through it as
         three black fragments with grey between them. Interpolating the
         radius to match the helm at both rings is the whole fix. */
      const slitBottom = 1.20 * HELM_CLEAR * 1.05;
      const slitTop = 1.183 * HELM_CLEAR * 1.05;
      g.material(MAT.LEATHER).color(0.10, 0.10, 0.11);
      g.lathe(B.HEAD, [
        [hr * slitTop, headY + hr * 0.30],
        [hr * slitBottom, headY + hr * 0.00]
      ], { seg: 8, squash: [SQX, SQZ],
           arc: Math.PI * 0.56, arcStart: Math.PI * 0.5 - Math.PI * 0.28 });
      g.material(MAT.PLATE).color(0.70, 0.72, 0.76);
    }
    return;
  }

  /* barbute: a CLOSED shell with a T-shaped face opening cut into the front.
     It used to be an arc lathe with the face left out, and an arc is the
     wrong tool for a helmet. An open sweep has a RIM -- two radial edges
     running from the crown to the jaw -- and because a lathe has no
     thickness those rims render as a pair of hard vertical faces standing
     off the head, which is what read as a black rectangle bolted to the
     face. It also cannot be widened without exposing the back of the skull.
     A closed lathe plus a dark slab for the sight and the mouth is both
     cleaner and closer to the actual armour. */
  coif();
  g.lathe(B.HEAD, [
    [hr * 1.00 * HELM_CLEAR, headY - hr * 0.62],
    [hr * 1.10 * HELM_CLEAR, headY - hr * 0.18],
    [hr * 1.08 * HELM_CLEAR, headY + hr * 0.50],
    [hr * 0.66 * HELM_CLEAR, headY + hr * 1.18],
    [0.0, headY + hr * 1.32]
  ], { seg: g.seg(1), squash: [SQX, SQZ] });
  if (g.detail <= DETAIL.MID) {
    /* The sight, as a BAND, not a slab.
       A box drawn across a curved surface cannot win: it has to be wide
       enough to span the face and deep enough to cut the surface, and those
       two requirements put its corners outside the helmet's silhouette --
       which rendered as a black bar sticking out past the side of the head.
       A short arc lathe at the helm's own radius is flush by construction:
       it follows the curvature, so there is nothing to poke out. Its two
       radial rims are 0.20 hr tall and the same dark colour as the band, so
       they are not visible. */
    /* 1.05, not 1.012. A lathe's flat chords sag to R*cos(pi/seg) between its
       vertices, so a band a hundredth of a percent proud of the helmet is
       still INSIDE it over most of each segment and the steel comes through
       in a periodic row of fragments. Five per cent clears the sag by a
       factor of three and still reads as a slit cut in the surface. */
    const sightR = 1.10 * HELM_CLEAR * 1.05;
    g.material(MAT.LEATHER).color(0.09, 0.09, 0.10);
    g.lathe(B.HEAD, [
      [hr * sightR, headY + hr * 0.30],
      [hr * sightR, headY + hr * 0.04]
    ], { seg: 10, squash: [SQX, SQZ],
         arc: Math.PI * 0.52, arcStart: Math.PI * 0.5 - Math.PI * 0.26 });
    /* the breath channel down the nose and mouth */
    g.lathe(B.HEAD, [
      [hr * sightR, headY + hr * 0.02],
      [hr * sightR * 0.98, headY - hr * 0.46]
    ], { seg: 5, squash: [SQX, SQZ],
         arc: Math.PI * 0.24, arcStart: Math.PI * 0.5 - Math.PI * 0.12 });
    g.material(MAT.PLATE).color(0.70, 0.72, 0.76);
  }
}

/** A crest or plume, Age III+. */
export function buildCrest(g, m, colour, count = 4) {
  const { headY, hr } = m;
  g.material(MAT.HAIR).color(colour);
  /* A crest is a fin, so each lock is one quad wide and one segment deep:
     at two rings per lock, five locks cost 60 triangles for a plume. */
  for (let i = 0; i < count; i++) {
    const t = (i - (count - 1) / 2) / ((count - 1) / 2 || 1);
    g.tube(B.HEAD, [0, headY + hr * 1.10, t * hr * 0.60],
      [0, headY + hr * (1.55 + 0.20 * (1 - Math.abs(t))), t * hr * 0.90],
      0.024, 0.015, { seg: 4, rings: 1, squash: [0.55, 1.0] });
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
      [x(0.200), y(0.90)],
      [x(0.232), y(0.68)],
      [x(0.222), y(0.56)]
    ]
    : [
      [x(0.168), y(1.00)],
      [x(0.188), y(0.90)],
      [x(0.196), y(0.78)],
      [x(0.192), y(0.68)]
    ];
  /* At far a surcoat is not drawn at all. It is a garment hanging over a
     tunic that is the same silhouette from thirty metres, and the torso
     lathe underneath already carries the shape: it was 54 triangles per
     figure across 130 of the 300 units in the army. */
  if (g.detail > DETAIL.MID) return;
  /* Cloth, not a lampshade: the same fold treatment as the cape, at a
     shallower depth, because a surcoat is belted at the waist and hangs in
     fewer, wider panels. */
  g.lathe(B.SKIRT, profile, {
    seg: g.detail === DETAIL.NEAR ? g.seg(1) + 2 : g.seg(1),
    squash: [1.0, cd / sw],
    folds: g.detail === DETAIL.NEAR ? 5 : 0, foldDepth: 0.070
  });
}

/** Pauldrons: a shell over each deltoid. */
export function buildPauldrons(g, m) {
  const { x, y, lw } = m;
  for (const side of [-1, 1]) {
    const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
    const sx = side * x(m.armX);
    g.material(MAT.PLATE).color(0.68, 0.70, 0.74);
    /* A LATHE, not a cut sphere, and that is the whole fix for the jagged
       grey-and-brown shards on every armoured shoulder.

       A cut ellipsoid is a shell with an open rim, and the rim has to cross
       the deltoid underneath it somewhere. At [4, 4] the two polyhedra are
       flat-chorded in different directions, so they crossed in a different
       place on every panel: what that renders as is not a pauldron over an
       arm, it is a plate that has been shattered, with the cloth brown
       showing through the gaps. A lathe is a surface of revolution about the
       arm's own axis; give it a flare and it is a pauldron, and there is no
       rim to intersect anything.

       The clearance is the other half. Deltoid is 0.090 lw across, so the
       shell starts at 0.104 and opens to 0.146 at the bottom lame -- outside
       the cloth at every height, the way armour is. */
    /* The shell runs DOWN the arm, so its profile is written top-down like
       every garment in this file -- the first draft ran bottom-up and the
       `ascend && grows` winding test sent it inside-out. It comes to a point
       at the top of the shoulder (so it caps over the deltoid with no rim to
       intersect), swells through the joint, and flares out at the last lame.
       The closing ring returns to a small radius, which gives the bottom of
       the pauldron an edge instead of an open mouth you can see up. */
    /* Four rings, three bands. The pointed crown, the swelling body and the
       flared lame -- the three features that make it read as armour. The
       fourth band the first draft carried was between two of those three and
       added nothing but cost 56 triangles per man at near and 28 at far,
       where a pauldron is a grey blob on the shoulder. */
    g.lathe(SHO, [
      [0.000, y(1.492)],
      [0.092 * lw, y(1.428)],
      [0.152 * lw, y(1.314)],
      [0.120 * lw, y(1.291)]
    ], { seg: g.seg(1), x: sx, squash: [1.0, 1.04] });
    /* The arm bone points straight down, so a lathe about its own axis has
       to be centred on the joint. */
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
  /* A cape hangs from the shoulders and falls clear of the sword arm. At
     far tier the whole garment is a hand's breadth of silhouette, and the
     five-ring profile with its folds costs more than the head does. */
  if (g.detail > DETAIL.MID) {
    g.lathe(B.SKIRT, [
      [x(0.234), y(1.46)],
      [x(0.278), y(1.08)],
      [x(0.318), y(0.60)]
    ], { seg: 5, squash: [1.0, 1.12],
         arc: Math.PI * 1.14, arcStart: -Math.PI * 0.5 - Math.PI * 0.57 });
    return;
  }
  /* A cape hangs from the shoulders and falls clear of the sword arm.
     At 1.34 PI the arc came round far enough to pass the arm, so the cape
     was drawn across the hand and the blade disappeared behind it. 1.1 PI
     keeps it on the back and the flanks, and the extra segments stop the
     fall from reading as two flat planes. */
  /* It hangs from the COLLAR, not across the shoulder blades: starting the
     profile at x(0.234) left its cut top edge standing a hand's width above
     the shoulders, a flat red bar across the upper back. The profile now
     begins narrow at the nape and widens as it falls. */
  g.lathe(B.SKIRT, [
    [x(0.105), y(1.585)],
    [x(0.196), y(1.500)],
    [x(0.264), y(1.16)],
    [x(0.316), y(0.78)],
    [x(0.326), y(0.56)],
    [x(0.300), y(0.45)]
  /* The model faces +Z, so the back is at theta = -PI/2. Centring the arc
     there is what puts the cape behind the shoulders instead of hanging off
     one side. */
  ], {
    /* A quarter-segment per ring for every fold: a 7-fold hem needs 28
       segments to round it, and at 14 the folds were below the sampling
       frequency and the cape stayed a smooth scroll. */
    seg: g.detail === DETAIL.NEAR ? g.seg(1) + 3 : g.seg(1),
    /* Deeper than wide: the cape wraps the back, not the flanks. */
    squash: [1.0, 1.24],
    arc: Math.PI * 1.14, arcStart: -Math.PI * 0.5 - Math.PI * 0.57,
    folds: g.detail === DETAIL.NEAR ? 7 : 0, foldDepth: 0.150
  });
}

/* ------------------------------------------------------------
   Carried kit
   ------------------------------------------------------------ */

/** A straight blade held in a hand. */
export function buildSword(g, hand, pos, len, opts = {}) {
  /* Grip, guard, blade. The blade used to start at the hand and taper all
     the way down, so a swordsman was holding a spike: there was no hilt to
     say where the weapon began, and nothing parallel-sided to say what it
     was. `len` is now the blade length, measured from the guard.

     It also leans OUT and FORWARD. Hanging straight down, the blade is
     inside the surcoat from the waist to the hem and only the last few
     centimetres of it show, which is why a swordsman looked unarmed next
     to a spearman. */
  const grip = Math.min(0.13, len * 0.3);
  const out = Math.sign(pos[0] || 1);
  g.material(MAT.LEATHER).color(0.30, 0.21, 0.14);
  if (g.detail === DETAIL.NEAR) {
    /* grip and pommel. At mid and far the fist itself is the hilt: a
       4-sided tube 2 cm across is a handful of pixels there, and a pommel
       is less than one. */
    g.tube(hand, [pos[0], pos[1] + grip * 0.55, pos[2]],
      [pos[0], pos[1] - grip * 0.55, pos[2]], 0.020, 0.019, { seg: 4, rings: 1 });
    g.material(MAT.PLATE).color(0.62, 0.64, 0.68);
    g.ellipsoid(hand, [pos[0], pos[1] + grip * 0.58, pos[2]],
      [0.030, 0.026, 0.030], { sph: [4, 3] });
  }
  if (g.detail <= DETAIL.MID) {
    /* Crossguard across the blade. The blade runs down -Y and a little
       +Z, so the quillons lie along X: a slab 0.17 wide in X, 0.034 along
       the blade, and thin in Z. A slab with its long axis on Y is just a
       lump on the hand. */
    g.slab(hand, [pos[0], pos[1] - grip * 0.62, pos[2] + 0.012],
      [0.175, 0.032, 0.030]);
  }
  const top = pos[1] - grip * 0.78;
  /* Carried, not dropped. The blade left the fist almost straight down, with
     a 15-degree forward lean, so from the front it was a line between the
     legs and from the side it was inside the surcoat -- a soldier who looks
     unarmed from every angle but the one you are not looking at. Angling it
     OUT and FORWARD puts the whole blade against the background. */
  const tip = [pos[0] + out * len * 0.20, top - len * 0.94, pos[2] + len * 0.52];
  g.material(MAT.PLATE).color(0.80, 0.82, 0.86);
  /* 3 cm at the base over a 40 cm blade. At 4.2 cm the parallel section
     was as wide as a forefinger and the thing read as a paddle or a
     feather rather than a sword. */
  g.blade(hand, [pos[0], top, pos[2] + 0.01], tip, 0.030, {
    thick: 0.009,
    sections: [
      { t: 0, w: 0.021, th: 0.009 },
      { t: 0.10, w: 0.030, th: 0.010 },
      { t: 0.82, w: 0.027, th: 0.009 },
      { t: 0.94, w: 0.018, th: 0.007 },
      { t: 1, w: 0.004, th: 0.003 }
    ]
  });
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
