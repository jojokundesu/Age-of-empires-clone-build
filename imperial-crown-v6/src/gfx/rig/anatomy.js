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
export const HEAD_X = 0.84;

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
  /* The collar stops BELOW the chin. `chinY` is headY - hr*1.06, so the
     collar top is a further two centimetres down: above the chin the tunic
     stands in front of the jaw and the lower face disappears into it. */
  const headYc = y(1.68);
  const hrc = 0.118 * prop.headR;
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
  const neckR = 0.118 * prop.headR;
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
  g.tube(B.NECK, [0, y(1.42), 0], [0, chinYc + (crownYc - chinYc) * 0.34, 0],
    0.086, 0.062, { seg: Math.max(4, g.seg(0) - 2), rings: 1, squash: [HEAD_X / 0.84, 1.0] });

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
  const skull = [
    [0.00, 0.22],   /* chin closes, blunt -- a point is a spike on a lathe */
    [0.15, 0.58],   /* chin and jaw come out almost at once */
    [0.34, 0.82],   /* jaw: strong, nearly as wide as the cheek */
    [0.52, 0.96],   /* cheekbone */
    [0.72, 1.00],   /* temples: widest */
    [0.86, 1.02],   /* crown mass -- a skull is not a paraboloid */
    [0.955, 0.66],
    [1.00, 0.12]    /* crown closes: a lathe's top rim is a hole */
  ];
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
    g.lathe(B.SKIRT, [
      [x(0.208), y(0.76)],   /* hem, mid-thigh */
      [x(0.216), y(0.84)],
      [x(0.196), y(0.94)],   /* over the hips */
      [x(0.152), y(1.08)]    /* tucked under the belt, inside the torso */
    ], { seg: g.seg(0), squash: [1.0, cd / sw * 1.02] });
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

    /* The thigh is 0.44 m of near-straight taper between the hem of the
       tunic and the knee, and the tunic skirt now covers its top third.
       Three rings at near -> two, which is 40 triangles a man and the
       silhouette does not change. */
    g.tube(THIGH, [hipX, y(0.96), 0], [hipX * 1.06, y(0.52), 0],
      0.092 * lw, 0.070 * lw, { seg: g.seg(1), rings: g.detail === DETAIL.FAR ? 1 : g.detail === DETAIL.MID ? 2 : 3, blend: HIP });
    /* A shin is nearly a straight taper: one fewer segment each way is
       invisible and worth 30 triangles per leg. */
    g.tube(SHIN, [hipX * 1.06, y(0.52), 0], [hipX * 1.02, y(0.09), 0],
      0.072 * lw, 0.048 * lw, { seg: g.seg(0), rings: g.detail === DETAIL.FAR ? 1 : 2, blend: THIGH });
    /* the boot: a slab is correct here, feet are boxy */
    g.material(6).color(0.32, 0.24, 0.17);
    g.slab(FOOT, [hipX * 1.02, y(0.055), 0.045], [0.098 * lw, 0.095 * H, 0.235 * H]);
  }

  /* ---------- ARMS ----------
     Deltoid, upper arm, forearm, hand. The shoulder ellipsoid is what makes
     armour sit on a body instead of hovering over it. */
  /* The shoulder JOINT. It was 0.268, which put the deltoid sphere 0.29 of a
     shoulder-width clear of a ribcage that only reaches 0.226 -- a ball
     floating beside a body with a strip of background between them, and that
     gap is what made every unarmoured unit read as a balloon animal. The
     chest is widened below to meet it, and the joint pulled in to 0.244. */
  const armX = 0.244;
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

    /* A shoulder CAP, not a balloon: flatter, and set so its inner edge is
       buried in the ribcage. A deltoid is a muscle draped over a joint, and
       at 0.108 all round it read as a ball stuck on a stick. */
    g.ellipsoid(SHO, [sx * 0.94, y(1.403), 0],
      [0.090 * lw, 0.096 * lw, 0.094 * lw], { sph: [6, 4] });
    /* THREE rings at near, not four. Both arm segments are near-straight
       tapers with a muscle swell at one end that the deltoid above already
       covers -- the fourth ring samples a curve that is a straight line
       within a millimetre, and there are four of these tubes on every one of
       300 units. */
    const armRings = g.detail === DETAIL.NEAR ? 3 : g.rings(0);
    g.tube(UP, [sx, y(1.40), 0], [sx * 0.98, y(1.13), 0],
      0.074 * lw, 0.058 * lw, { seg: g.seg(0), rings: armRings, blend: SHO });
    g.tube(FORE, [sx * 0.98, y(1.13), 0], [sx * 0.96, y(0.86), 0],
      0.058 * lw, 0.044 * lw, { seg: g.seg(0), rings: armRings, blend: UP });
    /* hand: a small tapered block, not a sphere */
    g.material(4).color(skin);
    g.tube(HAND, [sx * 0.96, y(0.86), 0], [sx * 0.95, y(0.78), 0],
      0.045 * lw, 0.038 * lw, { seg: 4, rings: 1, blend: FORE });
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
  /* Three rings at far. The cap's whole job there is to be a darker value
     than the skull across a four-pixel head, and the crown rings that give
     it a round silhouette at arm's length are inside that silhouette. */
  const hairProfile = [
    hs(0.80, 1.06),
    hs(0.88, 1.09),
    hs(0.95, 0.98),
    hs(0.99, 0.62),
    hs(1.02, 0.26),
    hs(1.055, 0.0)
  ];
  g.lathe(B.HAIR, g.detail === DETAIL.FAR
    ? [hairProfile[0], hairProfile[2], hairProfile[5]]
    : hairProfile,
  { seg: g.seg(1), squash: [HEAD_X * 1.03, 1.13] });

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
  /* The face's own depth. `hr` is the skull lathe's radius, but the lathe is
     squashed [HEAD_X, 1.10], so the front of the face sits at 1.10 hr and
     every feature has to be placed against that, not against hr. Feature
     depths below are fractions OF this. */
  const fz = hr * 1.10;
  const SKIN = 4, HAIR = 5;
  /* ...and the head is squashed on X as well, so a feature centred at
     `ex` on the face plane lands on a surface that is only HEAD_X of the way
     out there. Dividing by HEAD_X puts the eyes back on the cheeks instead
     of a centimetre in front of them. */
  const fxs = 1 / HEAD_X;
  /* Feature tessellation by tier. The eyes and the brow are three or four
     pixels across at mid range and one at far, and a sphere at [5,3] is 30
     triangles: this is the cheapest detail in the rig and it is also the
     detail that gives a head a face, so it is worth spending on -- but not
     the same amount at every tier. */
  const fa = g.detail === DETAIL.NEAR ? [5, 3] : [4, 2];

  /* ---------- BROW ----------
     One bar across the forehead, slightly proud. It is what gives the face a
     shadow line under a helmet, which is most of what makes a head read as a
     head at gameplay distance. */
  g.material(SKIN).color(0.62, 0.47, 0.36);
  if (g.detail === DETAIL.NEAR) {
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.28, fz * 0.74],
      [hr * 0.56, hr * 0.12, hr * 0.20], { sph: fa });
  } else {
    g.slab(B.HEAD, [0, headY + hr * 0.28, fz * 0.70],
      [hr * 1.10, hr * 0.20, hr * 0.18]);
  }

  /* ---------- NOSE ----------
     A bridge and a tip, not one ball. The point of the nose is the only
     feature that ever projects far enough to matter in silhouette. */
  /* Bridge, then tip. At 0.30 hr tall the bridge ran from the brow to the
     mouth and the nose read as a beak hung off the face; a nose is a short
     wedge, wide at the bottom. */
  if (g.detail === DETAIL.NEAR) {
    g.ellipsoid(B.HEAD, [0, headY + hr * 0.02, fz * 0.86],
      [hr * 0.15, hr * 0.22, hr * 0.24], { sph: fa });
  }
  g.ellipsoid(B.HEAD, [0, headY - hr * 0.16, fz * 0.90],
    [hr * 0.23, hr * 0.15, hr * 0.22], { sph: fa });
  /* Both of those are drawn at NEAR and MID; at far the whole face is under
     a helmet rim or five pixels of skin and the rig drops it. */

  /* ---------- EYES ----------
     Sockets first, in a shadowed skin tone, then a dark iris inside each.
     A single dark dot on a bare cheek reads as a freckle; the socket is what
     makes it an eye. Both sit just proud of the face so neither z-fights the
     skull.

     Spheres at NEAR, BARS at MID. A head is twenty pixels tall at gameplay
     distance: an eyeball there is a single pixel and an 18-triangle sphere
     to put it on the screen is the worst trade in the rig. A flat bar of the
     same two colours reads identically at that size for six triangles. The
     face costs 140 triangles per unit at mid without this, and 40% of a
     300-unit army is at mid. */
  for (const side of [-1, 1]) {
    const ex = side * hr * 0.30 * fxs;
    g.material(SKIN).color(0.44, 0.33, 0.26);
    if (g.detail === DETAIL.NEAR) {
      g.ellipsoid(B.HEAD, [ex, headY + hr * 0.10, fz * 0.80],
        [hr * 0.21, hr * 0.13, hr * 0.15], { sph: fa });
    } else {
      g.slab(B.HEAD, [ex, headY + hr * 0.10, fz * 0.80],
        [hr * 0.40, hr * 0.24, hr * 0.20]);
    }
    g.material(HAIR).color(0.10, 0.09, 0.09);
    if (g.detail === DETAIL.NEAR) {
      g.ellipsoid(B.HEAD, [ex, headY + hr * 0.10, fz * 0.86],
        [hr * 0.11, hr * 0.09, hr * 0.10], { sph: [3, 2] });
    } else {
      g.slab(B.HEAD, [ex, headY + hr * 0.10, fz * 0.88],
        [hr * 0.20, hr * 0.16, hr * 0.10]);
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
      arc: Math.PI * 1.30, arcStart: Math.PI * 0.5 - Math.PI * 0.65
    });
  }
}
