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
/** Head width as a fraction of the skull lathe's radius. A head is about
    0.75 as wide as it is deep; the lathe is built round, so X is squashed. */
export const HEAD_X = 0.86;

/* Head radius as a fraction of the profile's `headR`. This is the single
   most important proportion in the rig.

   It was 0.098, then 0.118, and both read as a pin-head: a head is one
   seventh of a standing figure, and at 0.118 on a 1.08-height body the head
   came out at 6.1 heads, which is a giant, but it was drawn 0.24 m across
   against 0.60 m shoulders, i.e. TWO AND A HALF heads wide, which is a
   bodybuilder. Age of Empires IV sits at a heroic 6.8 heads with shoulders
   2.2 heads wide, and that is what makes a soldier read at 3/4 zoom: the
   head is big enough to hold a face and a helmet, and small enough that the
   body is not a box. 0.126 with the profile table below lands on 6.8. */
export const HEAD_R = 0.126;

/* The skull's radius profile, as (height fraction, radius fraction of hr).
   Hoisted to module scope because the face layer has to solve for the
   surface these rings describe -- see surfZ in buildFaceDetail. */
export const SKULL_RINGS = [
  [0.00, 0.22],   /* chin closes, blunt -- a point is a spike on a lathe */
  [0.15, 0.58],   /* chin and jaw come out almost at once */
  [0.34, 0.82],   /* jaw: strong, nearly as wide as the cheek */
  [0.52, 0.96],   /* cheekbone */
  [0.72, 1.00],   /* temples: widest */
  [0.86, 1.02],   /* crown mass -- a skull is not a paraboloid */
  [0.955, 0.66],
  [1.00, 0.12]    /* crown closes: a lathe's top rim is a hole */
];

export function buildBody(g, prop, opts = {}) {
  const H = prop.height;
  const lw = prop.limbW;
  const sw = prop.shoulderW;
  const cd = prop.chestD;

  const y = (base) => base * H;
  const x = (base) => base * sw;

  const skin = opts.skin || [0.72, 0.55, 0.42];
  const fabric = opts.bodyMat !== undefined ? opts.bodyMat : 3;   // GAMBESON
  /* Is the outer garment mail? Then the arm below the elbow is mail too. */
  const outMailed = fabric === 1;
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
  /* The collar stops BELOW the chin. `chinY` is headY - hr*1.06, so the
     collar top is a further two centimetres down: above the chin the tunic
     stands in front of the jaw and the lower face disappears into it. */
  const headYc = y(1.68);
  const hrc = HEAD_R * prop.headR;
  /* chin, and the height the neck runs up to inside the skull. The neck has
     to stop where the HEAD is still wider than it is, or its open top shows
     above the jaw as a tan collar of its own. */
  const chinYc = headYc - hrc * 1.06;
  const crownYc = headYc + hrc * 1.14;
  const neckTopY = chinYc + (crownYc - chinYc) * 0.20;
  const torsoProfile = [
    [x(0.148), y(0.90)],   /* below the hip joint, so the tunic meets the thigh */
    [x(0.162), y(0.97)],
    [x(0.150), y(1.06)],   /* waist: narrower than the hip */
    [x(0.166), y(1.16)],
    [x(0.212), y(1.28)],   /* ribcage */
    [x(0.238), y(1.38)],   /* chest, widest */
    /* The latissimus run. These two rings used to pull in by 15% between the
       chest and the collarbone, and since the shoulder joint floats at
       x(0.244) that inward turn is what left daylight between the arm and
       the body. A man's upper ribcage is nearly as wide as his chest. */
    [x(0.240), y(1.44)],
    [x(0.208), y(1.474)],  /* shoulder slope: the trapezius run */
    /* The neck run must stop BELOW the chin.
       Head centre is y(1.68) and the chin is 1.06 hr under it -- about
       1.58 at a standard height. Carrying the torso up to 1.66 put it
       through the jaw: the beard and the whole lower face were buried
       inside the tunic, and what showed at the collar was the inside of
       the torso. These heights are relative to the head, not fixed. */
    /* the trapezius run: shoulders into neck without a shelf. These used to
       drop 22% of the radius over 35 mm, which drew a hard ledge across the
       collarbones and left the neck emerging from a collar like a chimney
       out of a roof. */
    /* THE NECKLINE. A lathe pays `rings x seg` for every ring it has, so a
       collar drawn with four rings across 25 mm of height is four rings of
       triangles for a line you cannot see -- and worse, it was drawing the
       COLLAR at chest height (y 1.528 of 1.68, i.e. 1.65 m on a 1.08 m
       build) while the chin sits at 1.71 m. Everything between was a bare
       column of neck, which is what the last five close-ups were showing.

       Two rings do the whole job: a steep slope off the shoulder, then the
       collar itself. The collar is wider than the neck inside it
       (0.082 against 0.056), so the fabric shows round the throat. */
    /* One more ring across the trapezius. Without it the lathe turned from
       the full 0.240 chest to x(0.170) in a single 26 mm step, and at six
       segments that renders as a squared-off tent: two hard corners with a
       flat plane between them, a hard rim across the collarbones that every
       close-up of this rig has shown under the helms.

       It has to go BEFORE the slope it softens. The first draft inserted it
       just above, so the profile ran 1.490 -> 1.474 -> 1.492: the lathe
       back-tracked on itself for 16 mm and drew a fold, which is worse than
       the corner it was meant to remove. */
    [x(0.170), y(1.492)],
    /* CLOSE THE LATHE. This is the whole fix for the black polygonal hole
       under every chin in the game. A lathe closes on its axis only where
       the profile returns to radius zero; the previous profile stopped at
       x(0.070), so the top of the tunic was an open RING 143 mm across, and
       because the inside of a lathe is not drawn you looked down a hole
       through the shirt and out the other side. A collar cannot be modelled
       as a hole and then plugged with a neck: it has to be a surface the
       neck passes THROUGH. Ending the profile at radius zero makes the
       shoulders into a closed dome, the neck emerges from it at the throat,
       and the ring of clotharound the neck is the collar. */
    [0.0, y(1.512)]
  ];
  g.material(fabric);
  if (opts.bodyCol) g.color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
  else g.color(0.78, 0.76, 0.70);
  /* At far the torso is a handful of pixels tall and the waist/ribcage
     distinction has already been lost to the LOD, so the profile is
     decimated: a lathe pays `rings x seg` twice over, and this one is the
     single most expensive thing in every humanoid. */
  /* At mid the figure is a few centimetres tall and the sub-rib rings are
     below the pixel: keep the hip, the waist, the chest and the shoulder
     slope, drop the rings between them. */
  const nearTorso = g.detail === DETAIL.NEAR
    ? torsoProfile.filter((_, i) => i !== 2 && i !== 4 && i !== 5)
    : g.detail === DETAIL.MID
      ? torsoProfile.filter((_, i) => i !== 1 && i !== 3 && i !== 6)
      : torsoProfile.filter((_, i) => i !== 1 && i !== 3 && i !== 6 && i !== 10);
  /* Extra rings cost `seg x 2` triangles each and the chest is the single
     most expensive lathe in the rig, so it is the one place a decimation is
     worth spending attention on. The trapezius gets one ring at near -- the
     ring that turns the hard tent corner into a shoulder -- and the two
     rings below it are the ones that go. */
  g.lathe(B.CHEST, nearTorso, {
    seg: g.seg(0), squash: [1.0, cd / sw * 1.05], blend: B.SPINE
  });

  /* ---------- NECK ----------
     A lathe closes on its own axis only if the profile returns to zero
     radius, and this one stops at the collar -- so the top of the torso is
     an open ring, and through it you see the background. The neck is what
     plugs it, and it has to be WIDER than the ring it passes through:
     a tube narrower than the collar leaves a ring of sky all the way
     round the throat, which is what the two drafts before this one did.
     Its own open top is hidden inside the head. */
  g.material(4).color(skin);
  /* Tapered, and no wider than the jaw at the top: at a constant 0.066 it
     was wider than the chin above it, so it stuck out all round the jaw and
     read as a scarf. */
  /* The neck is a TAPER from the collar to the jaw and it is narrower than
     the head at every point. At x(0.074) it was 186 mm across against a
     220 mm head -- a column of skin from the chin to the chest, which is
     what every close-up of this rig has been showing. */
  /* `hr` is declared further down with the head, so the neck measures the
     head from `prop` directly. */
  /* A neck is 55% of the head's width, not 100% of its radius.
     `neckR` was set to HEAD_R -- one full head radius -- so the neck tube was
     0.126 * 1.10 = 252 mm across against a 212 mm head: WIDER THAN THE HEAD
     IT CARRIES. That is the bare cylinder standing on the shoulders in every
     close-up, and it is the single largest piece of the "flesh cylinder"
     complaint. At 0.56 of the head radius it is 118 mm across, which is a
     heavy man's neck. */
  const neckR = HEAD_R * prop.headR * 0.56;
  /* Narrow. A neck is roughly HALF the width of the head it carries; at
     0.66 of a head radius, squashed only ten per cent, this was 132 mm
     across against a 156 mm head and read as a column of skin from the jaw
     to the chest, especially on the classes with no beard. */
  /* It starts at y(1.50), not y(1.42). The chest lathe turns inward above
     1.49 -- that ring is the shoulder slope -- so a tube whose base sat down
     at 1.42 was inside the ribcage at the bottom and in front of it by the
     time it reached the collar, and the skin column came out through the
     front of the chest. Starting above the slope puts the whole tube inside
     the collar ring. */
  /* It is also WIDER than the collar ring it passes through. The torso
     closes at x(0.070) at `neckTopY` and the collar is an open hole there:
     the TUNIC's top rim is a hole because a lathe only closes on its axis at
     radius zero, and anything nearer the axis than the rim leaves you
     looking down an open sleeve of cloth. The neck at 0.098 of a head radius
     was the narrowest thing in the whole rig and the hunter's green interior
     of the tunic showed all the way round it. */
  /* Runs from inside the ribcage, up through the collar dome, and into the
     skull -- where its own open top is hidden by the jaw. It is wider at the
     bottom than the collar it passes through, so the dome meets it rather
     than standing off it in a ring. */
  /* THE NECK STARTS AT THE COLLAR, NOT IN THE RIBCAGE.
     It ran from y(1.42) -- forty millimetres BELOW the shoulder slope --
     straight up and out. Because the chest lathe turns inward above 1.474,
     the bottom of that tube was inside the ribcage and its top was in front
     of the collar, so the tube emerged THROUGH the front slope of the tunic:
     a tan cylinder punching out of the chest, which is exactly what every
     close-up showed.

     Now it begins at y(1.49), above the slope and inside the collar ring,
     and it is narrower than the collar it passes through so the opening
     reads as a throat with cloth round it.

     The tilt is the other half. A neck does not rise vertically out of the
     shoulders -- it leans forward, which is what puts the head over the
     chest instead of on a pole. `top` carries the head's own centre line
     forward by 0.02 of height. */
  const neckTop = chinYc + (crownYc - chinYc) * 0.34;
  g.tube(B.NECK, [0, y(1.49), -0.004], [0, neckTop, 0.016],
    neckR * 1.16, neckR * 0.98,
    { seg: Math.max(4, g.seg(0) - 2), rings: 1, squash: [HEAD_X / 0.86, 1.0] });

  /* ---------- COLLAR / GORGET ----------
     A padded ring of cloth-and-mail at the throat, on EVERY class. Two jobs
     that no amount of neck geometry can do on its own:

       1. It hides the joint where the neck passes through the tunic collar.
          That joint is a hole by construction -- a lathe can only close on
          its own axis -- and a hole with a cylinder through it is a hole.
          A gorget is a real garment with real thickness and it sits exactly
          where the seam is.
       2. It is the Aoe4 silhouette cue: knights, men-at-arms and even
          villagers read as dressed rather than as bare-limbed mannequins
          because there is a visible band of cloth at the throat.

     Mail under the steel classes and linen under the rest, keyed on the
     body material the class already declared. */
  {
    const mailCollar = fabric === 1 || opts.mailedBody;
    g.material(mailCollar ? 1 : 0);
    if (mailCollar) g.color(0.46, 0.47, 0.48);
    else if (opts.bodyCol) g.color(opts.bodyCol[0] * 1.18, opts.bodyCol[1] * 1.18, opts.bodyCol[2] * 1.18);
    else g.color(0.88, 0.86, 0.80);
    /* It has to be WIDER than the tunic collar it stands inside, and the
       tunic collar closes to radius zero at y(1.512), so anything narrower
       than the shoulder slope at that height is simply inside the torso and
       invisible -- which is what the first draft of this ring was. The
       collar sits at x(0.170) at y(1.492); the gorget is placed 8% inside
       THAT at the bottom and tapers to the throat above it. */
    const collarR = x(0.170);
    g.lathe(B.NECK, [
      [collarR * 1.06, y(1.488)],
      [neckR * 1.90, y(1.512)],
      [neckR * 1.55, y(1.545)],
      [neckR * 1.42, y(1.566)]
    ], { seg: g.seg(-1), squash: [HEAD_X / 0.86, 1.02] });
  }

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
  const headY = headYc;
  const hr = hrc;
  g.material(4).color(skin);
  const chinY = chinYc;
  const crownY = crownYc;
  const headH = crownY - chinY;
  /* radius fractions of hr at even steps from chin to crown */
  /* The radius fractions are of `hr`, which is already the head's half-width,
     so the widest ring must be 1.0 -- at 0.94 times a further 0.94 the skull
     came out 12% too narrow and read as a cone with a forehead. The chin is
     lifted off zero for the same reason: a true zero radius is a point, and a
     point chin on a seven-segment lathe is a spike. */
  /* A JAW, not an almond. The old profile went 0.10 -> 0.40 -> 0.66 -> 0.86
     and reached its widest point at the temples, which is the silhouette of a
     pointed egg: it read as a pin-head on a man with 0.226-wide shoulders,
     because it was one. A head is nearly as wide at the jaw as at the
     cheekbones, and the cranium above the temples turns over quickly. These
     fractions put the mass back in the lower half and blunt the chin. */
  const skull = SKULL_RINGS;
  /* Seven rings at near, not eight: the ring at t 0.86 sits between the
     widest temple ring and the crown turn-over and describes a curve that the
     two either side already carry. It is 30 triangles on every soldier. */
  const skullProfile = g.detail === DETAIL.NEAR
    ? skull.filter((_, i) => i !== 5)
    : g.detail === DETAIL.MID
      ? skull.filter((_, i) => i !== 5 && i !== 2)
      : skull.filter((_, i) => i !== 2 && i !== 5);
  /* A head is NARROWER than it is deep: about 155 mm across and 210 mm
     front to back. Built as a body of revolution it was 200 mm across and
     220 deep -- a potato -- and since `hr` also sets the height there is no
     way to fix it by radius alone. So the lathe is squashed on X. Every
     helm in wardrobe.js squares the same figure, or the helmet ends up wider
     than the skull it is supposed to sit on. */
  g.lathe(B.HEAD, skullProfile.map(([t, r]) => [r * hr, chinY + headH * t]), {
    seg: g.seg(0), squash: [HEAD_X, 1.10], blend: B.NECK
  });
  if (g.detail === DETAIL.NEAR) {
    /* nose: projects from the face, so it is the one feature the lathe
       cannot carry */
    g.ellipsoid(B.HEAD, [0, headY - hr * 0.14, hr * 0.86],
      [hr * 0.16, hr * 0.26, hr * 0.26], { sph: [4, 3] });
  }

  /* ---------- PELVIS AND TUNIC SKIRT ----------
     Every medieval man wears a hemmed tunic over his braies, and without one
     the rig is two cylinders hanging off a flat waist with a gap between
     them: that is what man-at-arms Age I, the archer and the berserk all
     looked like. It is built here, on the BODY, rather than in each class's
     wardrobe, so no unit can be authored without a lower edge -- the
     surcoat, the robe and the kilt are all garments laid OVER this.
     The hip ring is wider than the waist above it and narrower than the
     chest, and it flares slightly to a hem at mid-thigh. */
  g.material(fabric);
  if (opts.bodyCol) g.color(opts.bodyCol[0] * 0.92, opts.bodyCol[1] * 0.92, opts.bodyCol[2] * 0.92);
  else g.color(0.70, 0.67, 0.60);
  /* The skirt is the pelvis: a tunic that ends at the waist leaves the legs
     meeting the torso at a point, and that is the "no pelvis" read. It earns
     its triangles at near and mid -- but not at far, where the torso lathe
     already runs down to y(0.90) and the hem is inside its own silhouette.
     24 triangles on 130 of the 300 units in the army, for nothing. */
  if (g.detail < DETAIL.FAR) {
    /* A HEM AT MID-THIGH, and a flare that actually covers the crotch.
       The old hem was at y(0.76) with a radius of 0.208 sw -- narrower than
       the two thighs side by side -- so the legs came out from under it and
       met at a point, and the visible join was a gap. A tunic is wider than
       the man inside it: the hem flares to 0.245, which clears the outer
       edge of both thighs, and it hangs to y(0.62), which is below the
       crotch at y(0.88) by a good hand's breadth.
       The bottom ring turns BACK IN before it closes, so the hem has a
       thickness and reads as cloth rather than as the open mouth of a cone. */
    g.lathe(B.SKIRT, [
      [x(0.212), y(0.60)],   /* hem underside, inside the flare above it */
      [x(0.248), y(0.625)],  /* hem edge */
      [x(0.240), y(0.80)],   /* over the hips */
      [x(0.196), y(0.94)],
      [x(0.152), y(1.08)]    /* tucked under the belt, inside the torso */
    ], { seg: g.seg(0), squash: [1.0, cd / sw * 1.02] });
    /* THE HEM BAND. An undyed strip at the bottom edge is what turns a
       dyed cone into a garment: it frames the team colour, it draws the
       eye along the hem, and because MAT.TRIM is not team-dyed it stays
       cream on every player's colour. Two rings, four segments a band. */
    if (g.detail === DETAIL.NEAR) {
      g.material(8).color(0.92, 0.90, 0.83);
      g.lathe(B.SKIRT, [
        [x(0.250), y(0.628)],
        [x(0.246), y(0.680)],
        [x(0.244), y(0.688)]
      ], { seg: g.seg(0), squash: [1.0, cd / sw * 1.02] });
      g.material(fabric);
      if (opts.bodyCol) g.color(opts.bodyCol[0] * 0.92, opts.bodyCol[1] * 0.92, opts.bodyCol[2] * 0.92);
      else g.color(0.70, 0.67, 0.60);
    }
  }

  /* ---------- LEGS ----------
     Thigh, shin, boot. The knee blend is what stops the joint pinching. */
  /* HOSE, BINDINGS AND BOOTS -- three values down the leg, because one
     material from hip to ankle is the single strongest "untextured tube"
     cue in the rig. Age of Empires IV never shows one: every leg is hose,
     then a wrapped or plated shin, then a boot with a cuff, and the three
     values break the cylinder's outline at exactly the heights the eye
     needs to read a knee and an ankle. */
  const hoseCol = opts.bodyCol
    ? [opts.bodyCol[0] * 0.62 + 0.30, opts.bodyCol[1] * 0.62 + 0.28, opts.bodyCol[2] * 0.62 + 0.26]
    : [0.56, 0.52, 0.44];
  for (const side of [-1, 1]) {
    /* Same trap as the arms: the boot at the end of the iteration switches
       the builder to LEATHER, so the second leg was being built in boot
       leather. One trouser leg brown, one grey. */
    g.material(legMat).color(hoseCol[0], hoseCol[1], hoseCol[2]);
    const HIP = side < 0 ? B.HIP_L : B.HIP_R;
    const THIGH = side < 0 ? B.THIGH_L : B.THIGH_R;
    const SHIN = side < 0 ? B.SHIN_L : B.SHIN_R;
    const FOOT = side < 0 ? B.FOOT_L : B.FOOT_R;
    const hipX = side * x(0.105) * prop.stance;

    /* The thigh is 0.44 m of near-straight taper between the hem of the
       tunic and the knee, and the tunic skirt now covers its top third.
       Three rings at near -> two, which is 40 triangles a man and the
       silhouette does not change. */
    g.tube(THIGH, [hipX, y(0.96), 0], [hipX * 1.06, y(0.52), 0],
      0.092 * lw, 0.070 * lw, { seg: g.seg(1), rings: g.detail === DETAIL.FAR ? 1 : g.detail === DETAIL.MID ? 2 : 3, blend: HIP });
    /* A shin is nearly a straight taper: one fewer segment each way is
       invisible and worth 30 triangles per leg. */
    /* Shin: leather bindings or a greave, darker or lighter than the hose
       above it. This is the contrast band that reads as a boot even at mid
       range, and it costs nothing -- it is the same tube in another colour. */
    g.material(6).color(0.34, 0.27, 0.20);
    g.tube(SHIN, [hipX * 1.06, y(0.52), 0], [hipX * 1.02, y(0.13), 0],
      0.074 * lw, 0.050 * lw, { seg: g.seg(0), rings: g.detail === DETAIL.FAR ? 1 : 2, blend: THIGH });
    /* BOOT CUFF. A flared ring at the ankle, which is what stops the shin
       being a cylinder pushed into a box: the last two drafts of this rig
       had a hard step from a taper straight into a slab and it read as a
       peg leg. Closed at both ends, so there is nothing to see inside. */
    if (g.detail < DETAIL.FAR) {
      g.lathe(FOOT, [
        [0.062 * lw, y(0.185)],
        [0.082 * lw, y(0.155)],
        [0.080 * lw, y(0.105)],
        [0.058 * lw, y(0.090)]
      ], { seg: g.seg(0), x: hipX * 1.02, squash: [1.0, 1.06], blend: SHIN });
    }
    /* the boot: a slab is correct here, feet are boxy */
    g.material(6).color(0.26, 0.19, 0.13);
    g.slab(FOOT, [hipX * 1.02, y(0.052), 0.050], [0.104 * lw, 0.090 * H, 0.245 * H]);
  }

  /* ---------- ARMS ----------
     Deltoid, upper arm, forearm, hand. The shoulder ellipsoid is what makes
     armour sit on a body instead of hovering over it. */
  /* The shoulder JOINT. It was 0.268, which put the deltoid sphere 0.29 of a
     shoulder-width clear of a ribcage that only reaches 0.226 -- a ball
     floating beside a body with a strip of background between them, and that
     gap is what made every unarmoured unit read as a balloon animal. The
     chest is widened below to meet it, and the joint pulled in to 0.244. */
  const armX = 0.228;
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

    /* A SHOULDER SLOPE, not a cannonball.
       This was a 0.096 sphere -- 192 mm across, sitting proud of a 0.238
       ribcage -- and a sphere at the top of a cylinder is a ball glued to a
       stick. Every armoured class then got a lathed pauldron over the top of
       it, and the two polyhedra crossed in a different place on every panel,
       which is the shattered-shard artefact.

       A deltoid is a muscle draped OVER a joint: wide at the top where it
       meets the trapezius, tapering down the arm. Three things make this one
       read that way rather than as a ball:
         - it is squashed on Y, so its widest point is at the shoulder and it
           falls away below;
         - it is centred INBOARD of the arm's own axis, so its inner edge is
           buried in the ribcage and there is no gap to see through;
         - it is smaller than the arm it caps, so the arm's silhouette
           carries the shoulder rather than a bead on top of it. */
    g.ellipsoid(SHO, [sx * 0.90, y(1.418), 0],
      [0.082 * lw, 0.088 * lw, 0.085 * lw], { sph: [6, 4] });
    /* THREE rings at near, not four. Both arm segments are near-straight
       tapers with a muscle swell at one end that the deltoid above already
       covers -- the fourth ring samples a curve that is a straight line
       within a millimetre, and there are four of these tubes on every one of
       300 units. */
    const armRings = g.detail === DETAIL.NEAR ? 3 : g.rings(0);
    g.tube(UP, [sx, y(1.432), 0], [sx * 0.98, y(1.13), 0],
      0.080 * lw, 0.058 * lw, { seg: g.seg(0), rings: armRings, blend: SHO });
    /* THE FOREARM IS A DIFFERENT GARMENT FROM THE UPPER ARM.
       One material from shoulder to wrist is why the whole cast reads as
       navy tubes: the torso, both sleeves and the skirt were the same dyed
       cloth at the same value, so a soldier was one silhouette in one
       colour. Age of Empires IV never does this -- the upper arm carries the
       padded or mailed sleeve and the forearm carries a contrasting
       undertunic cuff, a leather vambrace or a steel rerebrace -- and that
       break at the elbow is most of what makes an arm read as an arm.

       Cloth bodies get the cream undertunic; mailed bodies get mail. */
    if (opts.foreMat !== undefined) g.material(opts.foreMat);
    else g.material(outMailed ? 1 : 8);
    if (outMailed) g.color(0.50, 0.51, 0.52);
    else g.color(0.90, 0.88, 0.81);
    g.tube(FORE, [sx * 0.98, y(1.13), 0], [sx * 0.96, y(0.86), 0],
      0.058 * lw, 0.044 * lw, { seg: g.seg(0), rings: armRings, blend: UP });
    /* and the elbow joint itself is cloth of the upper sleeve, so the two
       garments meet at a seam rather than at a step */
    g.material(fabric);
    if (opts.bodyCol) g.color(opts.bodyCol[0], opts.bodyCol[1], opts.bodyCol[2]);
    else g.color(0.66, 0.62, 0.55);
    g.tube(UP, [sx * 0.985, y(1.19), 0], [sx * 0.982, y(1.08), 0],
      0.062 * lw, 0.058 * lw, { seg: g.seg(0), rings: 1, blend: UP });
    /* GLOVES. A bare skin tube at the end of a coloured sleeve is the last
       mannequin cue on the arm, and every class in every reference has
       something on its hands -- gauntlets, gloves, or a wrapped cuff. It is
       the same tube in leather with a trim cuff where it meets the sleeve,
       which also gives the wrist a visible joint. */
    if (opts.gloves !== false) {
      g.material(6).color(0.40, 0.29, 0.20);
      /* the flared cuff, on the forearm bone so it does not swing with the
         hand */
      g.lathe(FORE, [
        [0.042 * lw, y(0.885)],
        [0.056 * lw, y(0.868)],
        [0.050 * lw, y(0.845)],
        [0.040 * lw, y(0.840)]
      ], { seg: g.seg(-2), x: sx * 0.96, squash: [1.0, 1.06], blend: FORE });
      g.tube(HAND, [sx * 0.96, y(0.86), 0], [sx * 0.95, y(0.78), 0],
        0.046 * lw, 0.039 * lw, { seg: 4, rings: 1, blend: FORE });
    } else {
      g.material(4).color(skin);
      g.tube(HAND, [sx * 0.96, y(0.86), 0], [sx * 0.95, y(0.78), 0],
        0.045 * lw, 0.038 * lw, { seg: 4, rings: 1, blend: FORE });
    }
  }

  return {
    H, lw, sw, cd, y, x,
    headY, hr, armX,
    /** Where the two hands sit in bind pose, for placing weapons and tools.
        These have to follow `armX`, which is a profile-driven joint: they
        were pinned to the literal 0.268 and stayed there when the shoulder
        came in, so every tool placed from them sat a hand's width outboard
        of the fist it was supposed to be held in -- the monk's staff hung in
        the air beside his sleeve. */
    handX: armX * sw * 0.95,
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
  /* A LATHE, following the skull's own profile at a fixed clearance.
     An ellipsoid was the wrong primitive for this: a sphere centred on the
     cranium has a different curvature from the skull, so it dives inside it
     and comes back out, and the result was a black M-shape on the back of
     every villager's head with a bald strip through it. The skull is a body
     of revolution, so its cap is too -- take the skull's own radii above the
     hairline and push them out by 5%. */
  const hc = m.headY - hr * 1.06;   /* chin */
  const hh = hr * 2.20;             /* chin to crown */
  const hs = (t, r) => [hr * r, hc + hh * t];
  /* THE HAIR HAS TO CLEAR THE SKULL AT EVERY RING, and the numbers below are
     derived rather than eyeballed. A cap at a fixed 1.06-1.09 hr touches the
     skull at the brow ring (where the skull is widest, 1.02) and dives
     INSIDE it at the crown, where the skull is still 1.02 at t = 0.86: the
     result is two dark tufts at the temples and a bald dome between them,
     which is what the last three passes rendered.
     SKULL_CLEARANCE is applied to the skull's OWN radius at each height, so
     the cap is a real 6% shell over the whole cranium. */
  const SKULL_CLEARANCE = 1.07;
  /* From the hairline UP AND OVER, closing on the crown. Starting the sweep
     at t 0.50 and letting it stop at 1.00 hr left a band around a bald head:
     the profile has to return to zero radius at the top or the hair is a
     belt, not a cap. */
  /* An ARC centred on the back, so the face stays open and the hair falls
     behind the ears: a full sweep puts a black band across the brow at
     whatever height the profile starts, which is a helmet liner, not hair.
     The top has to go ABOVE the skull's own crown (t 1.0), or the skull's
     last ring pokes out of the top of the hair as a bald patch. */
  /* A FULL sweep, from the brow line up and over. It was an arc for a while
     and an arc is the wrong tool: a lathe can only vary its radius with
     HEIGHT, so pulling the front of the hair back means choosing one cut
     height for the whole sweep, and at that height the side of the head is
     still forehead. The result was a man with a bald strip down the front of
     his skull and a black wedge behind one ear. Short hair is a cap that
     starts just above the brow and closes over the crown, and that IS a body
     of revolution. */
  /* A CLOSED SHELL, not a lathe.
     A lathe cap can only close on its own axis, so its hairline is an open
     rim, and an open rim that crosses a curved skull at a shallow angle
     aliases: skull and cap alternate pixel by pixel, which is the ragged
     black hairline in every render. Every fix that kept the rim (tucking
     it, raising the clearance, adding a ring) moved the tear rather than
     removing it, because the rim is still a rim.

     A full ellipsoid has no rim. It is a closed surface, so there is no edge
     to alias and no underside to see; its lower half is inside the skull,
     which costs a few triangles and needs no cap. It is also cheaper than
     the six-ring lathe it replaces (48 against 66), and it follows the
     head bone with the skull so no blend weighting is needed. */
  /* Positioned so its CROWN clears the skull's (1.14 hr above centre) and
     its lowest point lands near the cheekbone at the sides: a cap that
     reaches the brow at the front is a fringe, and this one is hair. The X
     semi-axis carries HEAD_X because the skull is squashed on X and the cap
     has to be squashed with it or it is wider than the head inside it. */
  /* The hairline is where the cap's surface crosses the SKULL's, so it is
     set by pushing the cap back and up rather than by choosing a cut
     height: the front of the ellipsoid then lies inside the skull and the
     hair simply does not appear there, which is what a hairline is. The
     crown is 1.22 hr above the head's centre, clear of the skull's 1.14. */
  /* Its HEIGHT is what sets the hairline at the sides, and a tall semi-axis
     is what made the last draft read as a hood pulled down to the eyes: the
     skull is 2.2 hr from chin to crown, so an ellipsoid centred on the head
     with a 1.1 hr semi-axis reaches the brow on both sides. A short crop is
     a shallow cap sitting on the crown -- bottom edge at the brow (0.26 hr
     above centre), crown 1.20 hr, and the front pulled back inside the
     skull so the face is bare. */
  const hairR = hr * 1.055;
  g.ellipsoid(B.HAIR,
    [0, headY + hr * 0.74, -hr * 0.10],
    [hairR * HEAD_X * 1.03, hr * 0.46, hairR * 1.02],
    { sph: g.detail === DETAIL.NEAR ? [9, 5] : [6, 3] });

  if (style === 'long') {
    /* Long hair is a CURTAIN, so it is a lathe swept round the back of the
       head and shoulders, not a tube. A tube has one axis and one radius:
       hung behind the neck it is a rope, and squashed flat to make it a
       sheet it becomes a blade with a point, which is what the previous
       draft rendered -- a black spearhead between the shoulder blades.
       The arc is centred on the back (theta = -PI/2) and stops short of the
       face, and the radii start inside the hair cap and open out past the
       shoulders so the fall hangs clear of the body instead of inside it. */
    g.lathe(B.HAIR, [
      [hr * 1.02, headY + hr * 0.30],
      [hr * 1.20, headY - hr * 0.62],
      [m.x(0.094), m.y(1.36)],
      [m.x(0.078), m.y(1.24)]
    ], {
      seg: g.detail === DETAIL.NEAR ? g.seg(1) + 2 : g.seg(1),
      squash: [HEAD_X, 0.66],
      arc: Math.PI * 1.00, arcStart: -Math.PI * 0.5 - Math.PI * 0.50,
      folds: g.detail === DETAIL.NEAR ? 4 : 0, foldDepth: 0.10
    });
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
  const SKIN = 4, HAIR = 5;

  /* ---------------------------------------------------------------
     WHERE THE SURFACE ACTUALLY IS.

     This is the bug that made every face in the game a mess of floating
     shards, and it is worth stating precisely because it looked like a
     tessellation problem for weeks.

     The skull is a lathe: at each ring it has radius r*hr, squashed to
     [HEAD_X, 1.10]. So the front of the face at height `t` of the skull is
     at z = r(t) * hr * 1.10, and at a horizontal offset `ex` it is at
       z = r(t) * hr * 1.10 * sqrt(1 - (ex / (r(t)*hr))^2)
     which is the equation of the ellipse the ring projects to.

     Every feature in this function used to be placed at `fz * k` where
     `fz = hr * 1.10` and k was a guess between 0.74 and 0.90. Those numbers
     are all INSIDE the skull: at eye height the surface is at 1.05 hr and
     the eyes were placed at 0.86 hr, so two thirds of each eyeball was
     within the head and what rendered was the sliver poking out of the
     cheek -- a torn black wedge across the face. Same for the brow, same
     for the nose.

     So: compute the surface, then place each feature as a fraction of the
     way OUT from it. `surfZ` returns the surface z at a given height offset
     and horizontal offset. */
  const CHIN = headY - hr * 1.06;
  const HEAD_H = hr * 2.20;
  /* Skull radius fraction at a height. Linear between the profile's own
     rings, which is what the lathe does, so this is exact at every ring. */
  const skullFrac = (yy) => {
    const t = (yy - CHIN) / HEAD_H;
    if (t <= 0) return 0.22;
    if (t >= 1) return 0.12;
    let prev = [0, 0.22];
    for (const [tt, rr] of SKULL_RINGS) {
      if (t <= tt) {
        const u = (t - prev[0]) / (tt - prev[0] || 1);
        return prev[1] + (rr - prev[1]) * u;
      }
      prev = [tt, rr];
    }
    return 0.12;
  };
  const surfZ = (yy, xLocal) => {
    const r = skullFrac(yy) * hr;
    if (r <= 1e-6) return 0;
    const sx = Math.min(0.999, Math.abs(xLocal) / r);
    return r * 1.10 * Math.sqrt(1 - sx * sx);
  };

  /* ---------- BROW ----------
     A ridge under the hairline, not a bar on the forehead. It is a squashed
     ellipsoid lying along the bone, its centre INSIDE the skull and its
     front face a few millimetres proud, so what shows is a ridge with a
     shadow under it rather than a box glued on. */
  g.material(SKIN).color(0.58, 0.44, 0.34);
  {
    const by = headY + hr * 0.26;
    const bz = surfZ(by, 0);
    g.ellipsoid(B.HEAD, [0, by, bz - hr * 0.10],
      [hr * 0.52, hr * 0.11, hr * 0.20], { sph: [5, 2] });
  }

  /* ---------- NOSE ----------
     The one feature that projects. A bridge from the brow down to a tip,
     both closed volumes whose centres sit inside the skull and whose front
     faces clear it, so they read as a wedge rather than as a beak hung off
     the face. */
  {
    const ny = headY - hr * 0.10;
    const nz = surfZ(ny, 0);
    g.ellipsoid(B.HEAD, [0, ny, nz - hr * 0.04],
      [hr * 0.17, hr * 0.20, hr * 0.20], { sph: [4, 3] });
    const ty = headY - hr * 0.26;
    g.ellipsoid(B.HEAD, [0, ty, surfZ(ty, 0) - hr * 0.03],
      [hr * 0.24, hr * 0.13, hr * 0.17], { sph: [4, 2] });
  }

  /* ---------- EYES ----------
     A socket in shadow, and an iris inside it -- both placed ON the surface
     the skull actually presents at that offset, then pushed out by a fixed
     2 mm so nothing is coplanar with a triangle of the skull. The offset is
     the whole point: the previous draft placed them on a flat plane and the
     skull is an ellipse, so the outer corner of each eye sank and the inner
     corner floated. */
  for (const side of [-1, 1]) {
    const ex = side * hr * 0.34;
    const ey = headY + hr * 0.06;
    const ez = surfZ(ey, ex);
    g.material(SKIN).color(0.40, 0.30, 0.24);
    if (g.detail === DETAIL.NEAR) {
      g.ellipsoid(B.HEAD, [ex, ey, ez - hr * 0.035],
        [hr * 0.20, hr * 0.115, hr * 0.13], { sph: [4, 2] });
    } else {
      g.slab(B.HEAD, [ex, ey, ez - hr * 0.030],
        [hr * 0.34, hr * 0.20, hr * 0.10]);
    }
    g.material(HAIR).color(0.09, 0.08, 0.08);
    if (g.detail === DETAIL.NEAR) {
      g.ellipsoid(B.HEAD, [ex, ey, ez + hr * 0.010],
        [hr * 0.105, hr * 0.085, hr * 0.085], { sph: [3, 2] });
    } else {
      g.slab(B.HEAD, [ex, ey, ez + hr * 0.010],
        [hr * 0.17, hr * 0.13, hr * 0.05]);
    }
  }

  /* ---------- BEARD ----------
     A beard is a MASS on the jaw that wraps the chin and runs up the cheeks,
     not a cube hung off the point of it. It is built as a lathe swept round
     the front and sides of the jaw, which is the only way to get it to wrap
     at this segment count without intersecting the skull. */
  if (opts.beard) {
    /* Lifted well clear of HAIR_COLORS[0] = 0.16/0.12/0.09: multiplied up it
       still lands under 0.42 and a beard under a helmet reads as a hole. A
       beard is also greyer than the hair it belongs to. */
    g.material(HAIR).color(
      Math.min(1, 0.30 + hair[0] * 0.85),
      Math.min(1, 0.26 + hair[1] * 0.85),
      Math.min(1, 0.22 + hair[2] * 0.85));
    /* 1.30 pi centred on the FRONT (+Z), i.e. theta = PI/2, so the sweep
       covers both cheeks and the chin and stops at the ears. */
    const beardProfile = [
      [hr * 0.30, headY - hr * 1.30],
      [hr * 0.72, headY - hr * 1.08],
      [hr * 0.98, headY - hr * 0.76],
      [hr * 1.06, headY - hr * 0.44],
      /* It stops BELOW the cheekbone. Run up to +0.10 hr it reached the eye
         line, and with the jaw now 0.82-0.96 hr wide the beard covered the
         whole visible face and every bearded class lost its eyes. */
      [hr * 0.98, headY - hr * 0.26]
    ];
    /* The middle ring is a sub-cheek sample worth ~50 triangles on every
       bearded soldier and invisible at mid range. */
    const beardRings = g.detail === DETAIL.NEAR
      ? beardProfile
      : beardProfile.filter((_, i) => i !== 2);
    g.lathe(B.HEAD, beardRings, {
      seg: g.seg(0), squash: [HEAD_X, 1.10],
      arc: Math.PI * 1.34, arcStart: Math.PI * 0.5 - Math.PI * 0.67
    });
  }
}
