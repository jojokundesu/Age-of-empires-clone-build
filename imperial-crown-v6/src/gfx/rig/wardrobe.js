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
  SKIN: 4, HAIR: 5, LEATHER: 6, WOOD: 7, TRIM: 8
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
  const coif = (nape = true) => {
    /* ONE arc, not two. A linen cap under a mail curtain was 70 triangles to
       render a surface the curtain already covers; the curtain alone does
       both jobs -- it darkens the rim and it hides the jaw under the steel. */
    /* Lighter than it wants to be. A mail aventail lit by a single sun
       reads as a black band unless its albedo is pushed up; at 0.40 the
       curtain under a kettle hat was a hole between the helmet and the
       shoulders, which is worse than the bare jaw it replaced. */
    g.material(MAT.MAIL).color(0.74, 0.74, 0.70);
    /* BOTTOM-UP. This arc was written crown-first for a long time, which
       gives every quad an inward normal (nOut = dy/|d| < 0) and the whole
       aventail was culled -- so the jaw and the nape showed bare under every
       helmet in the file and three passes went looking for a geometry
       collision that was never there. The mesh is a two-ring skirt: it has to
       start at the hem and climb. */
    /* AND IT FLARES. A two-ring cone at near-constant radius is a tube
       round the neck; an aventail hangs off the helmet's rim and spreads
       over the shoulders, so it is narrow at the top and wide at the hem.
       The three rings also let it curve instead of running straight from
       the rim to the collarbone. */
    /* UP UNDER THE RIM, not below the ear.
       It hung from headY - 0.44 hr, which is under the jaw -- so between the
       helmet's rim at +0.15 hr and the top of the curtain there were 74 mm
       of bare cheek on both sides, and a kettle hat read as a metal hat
       floating over a naked head. The curtain's top ring is now at +0.10 hr,
       inside the rim, and the FRONT is still open: the arc spans 1.55 PI
       centred on the back, so the gap it leaves is the 81 degrees the face
       occupies. Sides and nape covered from the steel down, face clear. */
    /* `nape = false` skips the curtain entirely.
       The BARBUTE does not need it: its skirt is itself an arc that comes
       down over the nape and the cheeks to the collarbone, and it is built
       wider (1.21-1.23 hr against the curtain's 1.00-1.22), so the whole
       curtain sat inside the steel unseen. That is 72 triangles per
       barbute-wearing soldier for a surface no camera can reach -- and there
       are five such classes. Every other helm keeps it. */
    if (nape) {
      g.lathe(B.HEAD, [
        [hr * 1.22, headY - hr * 1.50],
        [hr * 1.16, headY - hr * 1.18],
        [hr * 1.04, headY - hr * 0.70],
        [hr * 1.00, headY - hr * 0.20],
        [hr * 1.00, headY + hr * 0.10]
      ], { seg: g.seg(0), squash: [SQX, SQZ],
           arc: AVENTAIL_ARC, arcStart: AVENTAIL_START });
    }
    g.material(kind === 'hood' || kind === 'turban' ? MAT.LINEN : MAT.PLATE);
    g.color(kind === 'hood' ? 0.55 : 0.70, kind === 'hood' ? 0.50 : 0.72,
      kind === 'hood' ? 0.44 : 0.76);
  };

  /* A mail curtain over the JAW, for the open-faced steel helms.
     An aventail is a full sweep round the back and sides and it leaves the
     face open -- which is right for the nape and wrong for the chin, because
     below a barbute's brow the skull lathe stops and what is left is a bare
     jaw under a steel crown. That reads as a man wearing half a helmet.
     This is the other half: an arc across the FRONT, from just under the
     sight down below the chin, in mail. The barbute thus opens on the eyes
     and the nose only, which is what the armour actually does. */
  const chinCurtain = (fromY, toY) => {
    g.material(MAT.MAIL).color(0.40, 0.41, 0.42);
    g.lathe(B.HEAD, [
      [hr * 1.13, fromY],
      [hr * 1.16, headY - hr * 0.90],
      [hr * 1.06, toY]
    ], { seg: g.seg(1), squash: [SQX, SQZ],
         arc: Math.PI * 0.92, arcStart: Math.PI * 0.5 - Math.PI * 0.46 });
    g.material(kind === 'hood' || kind === 'turban' ? MAT.LINEN : MAT.PLATE);
    g.color(kind === 'hood' ? 0.55 : 0.70, kind === 'hood' ? 0.50 : 0.72,
      kind === 'hood' ? 0.44 : 0.76);
  };

  if (kind === 'hood') {
    /* A COWL IS FABRIC OVER THE SKULL WITH A FACE OPENING -- not a cone.
       This was a single closed lathe from the hem to the crown, which is a
       cloth egg. It produced the SECOND version of the same complaint the
       barbute produced: five classes at the head close-up were a blank blue
       or brown mass with no visible face at all (skirmisher, longbowman,
       mob_rioter, and every age-1/2 archer).
       Same construction as the barbute, for the same reason: a closed crown
       (where the skull's curvature is) plus an open-arc mantle (where the
       face is). Cloth sits closer than steel, so the clearance is smaller
       and the opening is wider -- a cowl is pushed back off the brow, it
       does not wrap the chin the way a barbute's cheekpiece does. */
    const OPEN = Math.PI * 0.46;
    const COVERED = Math.PI * 2 - OPEN;
    const START = Math.PI * 0.5 + OPEN * 0.5;
    const BROW_Y = headY + hr * 0.30;
    /* crown */
    g.lathe(B.HEAD, [
      [hr * 1.13 * HELM_CLEAR, BROW_Y - hr * 0.02],
      [hr * 1.14 * HELM_CLEAR, headY + hr * 0.56],
      [hr * 0.98 * HELM_CLEAR, headY + hr * 1.02],
      [hr * 0.60 * HELM_CLEAR, headY + hr * 1.40],
      [0.0, headY + hr * 1.54]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    /* mantle, falling to the shoulders. It flares DOWNWARD, which is what
       makes a cowl read as cloth over shoulders rather than as a tube round
       a neck: 1.05 at the brow out to 1.30 at the hem. */
    g.lathe(B.HEAD, [
      [hr * 1.30, headY - hr * 1.34],
      [hr * 1.22, headY - hr * 0.94],
      [hr * 1.12, headY - hr * 0.44],
      [hr * 1.10 * HELM_CLEAR, headY - hr * 0.06],
      [hr * 1.13 * HELM_CLEAR, BROW_Y + hr * 0.04]
    ], { seg: g.seg(1), squash: [SQX, SQZ], arc: COVERED, arcStart: START });
    return;
  }

  if (kind === 'kettle') {
    /* A KETTLE HAT IS A BOWL WITH A BRIM, AND IT COVERS THE SKULL.
       The old profile rose from the brow to a brim at +0.40 hr, then closed
       over the top at +1.40 -- but the skull's crown is at +1.14 and its
       widest ring at +0.83, so the bowl was inside the head over its whole
       top half and what rendered was a flat disc with the face hanging out
       below it: a pork-pie hat.

       The numbers that make a kettle hat read are the SKULL's, not the
       helmet's. The skull's widest ring is 1.02 hr at +0.83 hr, and its
       crown is at +1.14 hr, so:
         - a rim at +0.15 hr passes below the brow ridge (+0.26) and above
           the eyes (+0.06): the one band on the face that can be covered
           without hiding the face;
         - the bowl has to be clear of 1.02 hr at +0.83, and the clearance
           is applied at every ring rather than at the rim alone;
         - the brim is 1.65 hr, which is wider than the shoulders' inner
           third, so it is the thing the silhouette reads. */
    coif();
    const bowlTop = headY + hr * 1.16;
    g.lathe(B.HEAD, [
      /* rim, low and clear of the brow ridge */
      [hr * 1.14 * HELM_CLEAR, headY + hr * 0.15],
      /* the bowl proper: a ROUND dome. Four rings, because three made the
         crown a straight cone -- the eye reads curvature from the second
         derivative and two chords have none. */
      [hr * 1.20 * HELM_CLEAR, headY + hr * 0.52],
      [hr * 1.16 * HELM_CLEAR, headY + hr * 0.86],
      [hr * 0.84 * HELM_CLEAR, bowlTop - hr * 0.14],
      [hr * 0.42 * HELM_CLEAR, bowlTop],
      [0.0, headY + hr * 1.22]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    /* THE BRIM, as its own surface, written separately and sloping DOWN and
       OUT. A flat annulus seen from anywhere near the head's own height is a
       line; a brim that drops 0.10 hr over its 0.5 hr of reach catches light
       along its top face and throws a shadow under itself, which is what
       makes a kettle hat a kettle hat. */
    g.lathe(B.HEAD, [
      [hr * 1.12 * HELM_CLEAR, headY + hr * 0.18],
      [hr * 1.18 * HELM_CLEAR, headY + hr * 0.13],
      [hr * 1.65 * HELM_CLEAR, headY + hr * 0.00],
      [hr * 1.66 * HELM_CLEAR, headY - hr * 0.06]
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
    /* The rim comes down to +0.04 hr, not +0.12. At +0.12 the coif's top
       ring and the helmet's rim left a wedge of bare cheek between them on
       each side -- a bright skin-coloured notch under the steel that read as
       a hole in the helm. The two now overlap. */
    g.lathe(B.HEAD, [
      [hr * 1.02 * HELM_CLEAR, headY + hr * 0.04],
      [hr * 1.08 * HELM_CLEAR, headY + hr * 0.46],
      [hr * 1.04 * HELM_CLEAR, headY + hr * 1.00],
      [hr * 0.62 * HELM_CLEAR, headY + hr * 1.36],
      [0.0, headY + hr * 1.48]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    /* THE NOSE GUARD: a narrow bar from the brow down the bridge.
       It is the one part of a spangenhelm that is not a body of revolution,
       so it is a slab -- and the slab was 22 x 86 x 15 per cent of a head
       radius, i.e. 280 mm wide by 22 mm deep on a 200 mm-wide head. What
       rendered was a grey plank across the face from brow to chin, with the
       eyes and the beard behind it. A nasal is a finger's width of steel:
       0.20 hr across (25 mm, which is a nose guard) and it stops at the tip
       of the nose, not at the chin. */
    /* CENTRED ON THE FACE PLANE, not in front of it.
       The skull's own surface at eye height is z = 1.10 * hr (it is squashed
       1.10 on Z), so a slab centred at 0.99 hr with a 0.10 hr half-depth was
       0.06 hr INSIDE the face at its front and floating in front of the nose
       at its back: it rendered as a pale bar hanging in the air beside a
       nose it never touched. Centre it at 1.11 hr and make it deep enough to
       swallow the surface it stands on. */
    /* A NOSE GUARD IS A TONGUE OF STEEL ON THE NOSE.
       Three quarters of it was missing. The slab was 0.20 x 0.62 x 0.09 hr
       centred 0.10 hr below the head's centre, so it spanned +0.21 to -0.41
       hr -- it stopped at the bridge and never reached the nose, whose tip is
       at -0.44 hr. What showed was a small grey tab hanging under the brow
       with a bare nose below it, which reads as a broken helmet.
       It now runs from under the brow (+0.30 hr) down past the nose tip
       (-0.56 hr): 0.86 hr long, 0.20 hr wide, and placed on the skull's own
       surface with `surfZ`, stepped proud at each end so it stands off the
       bridge the way a nasal does. */
    const guardTop = headY + hr * 0.30;
    const guardBot = headY - hr * 0.56;
    const midY2 = (guardTop + guardBot) / 2;
    const faceZ = m.surfZ ? m.surfZ(midY2, 0) : hr * 1.10;
    g.slab(B.HEAD, [0, midY2, faceZ + hr * 0.10],
      [hr * 0.20, hr * 0.86, hr * 0.10]);
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
    /* A great helm is not a bigger barbute: it is a BARREL, closed all the
       way round, deep enough to reach the shoulders, and with the skull given
       real clearance.

       THE SIGHT IS A GAP IN THE STEEL, not a dark band laid over it.
       Three passes tried to paint a slit on: a slab poked out past the
       silhouette, and a flush band, sized to within 3% of the shell, lost
       every depth test to the shell's own facets -- a lathe's chords sag by
       cos(pi/seg) between vertices, which at eight segments is 8%, so a band
       3% proud is 5% INSIDE the steel over most of every segment. The band
       exists, and it is hidden. There is no clearance that fixes that without
       the band standing off the helmet like a shelf.

       So build the helm the way the armourer did: TWO shells with a gap
       between them, and a dark enclosed surface behind the gap. The slit is
       then genuinely empty, which is the only thing that reads as a place to
       see out of from every angle and at every distance. */
    coif();
    const SIGHT_LO = headY + hr * 0.02;    /* bottom of the sight */
    const SIGHT_HI = headY + hr * 0.26;    /* top of it */
    /* the barrel, split */
    g.lathe(B.HEAD, [
      [hr * 1.02 * HELM_CLEAR, headY - hr * 0.92],
      [hr * 1.18 * HELM_CLEAR, headY - hr * 0.42],
      [hr * 1.18 * HELM_CLEAR, SIGHT_LO]
    ], { seg: g.seg(0), squash: [SQX + 0.02, SQZ * 1.06] });
    g.lathe(B.HEAD, [
      [hr * 1.18 * HELM_CLEAR, SIGHT_HI],
      [hr * 1.18 * HELM_CLEAR, headY + hr * 0.44],
      [hr * 0.96 * HELM_CLEAR, headY + hr * 1.00],
      [hr * 0.58 * HELM_CLEAR, headY + hr * 1.34],
      [0.0, headY + hr * 1.46]
    ], { seg: g.seg(0), squash: [SQX + 0.02, SQZ * 1.06] });
    /* THE INSIDE OF THE HELM, behind the slit. Without it the gap is a hole
       through the head and you see sky: at 74% of the shell's radius it is
       behind the steel everywhere except the one band that is missing, and
       dark enough that the slit reads as shadow rather than as an opening.
       It is also what the brow and the bridge of the nose sit against. */
    if (g.detail <= DETAIL.MID) {
      g.material(MAT.LEATHER).color(0.06, 0.06, 0.07);
      g.lathe(B.HEAD, [
        [hr * 1.06 * HELM_CLEAR * 0.74, SIGHT_LO - hr * 0.30],
        [hr * 1.18 * HELM_CLEAR * 0.78, SIGHT_LO],
        [hr * 1.18 * HELM_CLEAR * 0.78, SIGHT_HI],
        [hr * 1.06 * HELM_CLEAR * 0.74, SIGHT_HI + hr * 0.30]
      ], { seg: g.seg(0), squash: [SQX + 0.02, SQZ * 1.06] });
      g.material(MAT.PLATE).color(0.70, 0.72, 0.76);
      /* A brow ridge over the slit, so it is shadowed and so the steel above
         it does not read as a smooth continuation of the steel below. */
      g.lathe(B.HEAD, [
        [hr * 1.18 * HELM_CLEAR * 1.02, SIGHT_HI - hr * 0.01],
        [hr * 1.19 * HELM_CLEAR * 1.02, SIGHT_HI + hr * 0.05],
        [hr * 1.19 * HELM_CLEAR * 1.02, SIGHT_HI + hr * 0.09]
      ], { seg: g.seg(0), squash: [SQX + 0.02, SQZ * 1.06] });
    }
    return;
  }

  /* ---------------- BARBUTE ----------------
     AN OPEN-FACED HELMET. This is the single most mis-read piece of kit in
     the whole rig, and the user's words for it were "a big white blob as
     their face" -- which is exactly right.

     It was built as a CLOSED shell over an enclosed skull, with a painted
     dark band for the sight and a painted dark slot for the breath. Painted
     openings do not work; there is a note about that further down this file
     and a much longer one in the great helm. What that construction actually
     produces is a smooth pale egg with two small dark marks on it, and since
     a smooth pale egg is very close to the shape of a skull, the result
     reads as a giant blank face rather than as armour. At age 3 it hit
     man_at_arms, spearman, swordsman, axeman and hand_cannoneer -- five of
     the most common units in the game -- so it was also the most visible
     thing wrong with the rig.

     A barbute is NOT an enclosed helmet. Its defining feature is a
     T-SHAPED OPENING with the wearer's face fully visible behind it: steel
     over the crown and the ears, steel cheekpieces sweeping down to the
     collarbone, a brow ridge over the eyes, and an open mouth and chin. That
     is why it reads instantly as armour -- you can see a face in it.

     The geometry that makes it read:
       - an OPEN ARC, not a closed lathe, so there is no steel across the
         face at all. The gap IS the opening.
       - 1.42 pi of sweep leaves 0.58 pi (104 degrees) of face open, which
         is wide enough to show both eyes, the nose and the mouth.
       - the sweep has to start at 0.21 pi and end at 1.79 pi, i.e. centred
         on the face, so the opening is symmetric about +Z.
       - cheekpieces come DOWN at the sides of the opening and reach below
         the chin, which is the barbute's other signature.
       - the coif's aventail is SKIPPED, because this helmet's own skirt is
         wider and already covers the nape. */
  coif(false);
  {
    /* THE SWEEP. `arcStart` is the first COVERED angle, measured from +X
       toward +Z: +Z is the way the model faces, so an opening centred on the
       face means the covered arc starts just past it and runs all the way
       round the back. */
    /* 0.50 pi, not 0.58: at 104 degrees of opening the cheekpieces were wide
       enough apart to read as two separate panels bolted to the sides of a
       face rather than as one helmet. 90 degrees shows both eyes, the nose
       and the mouth and still leaves the sides joined by the crown. */
    const OPEN = Math.PI * 0.50;
    const COVERED = Math.PI * 2 - OPEN;
    const START = Math.PI * 0.5 + OPEN * 0.5;
    /* TWO PIECES, NOT ONE.
       An arc lathe over the whole helm looks like the obvious answer and it
       is wrong: the crown of a lathe closes where the profile reaches radius
       zero, so an open arc leaves a 104-degree WEDGE MISSING OUT OF THE TOP
       OF THE SKULL. The first attempt at this rendered a bare bald crown
       with a steel fin beside it, which is a worse blob than the one it
       replaced.
       A barbute is closed over the crown and open over the face, and those
       are two different sweeps, so it is two pieces:
         - the CROWN, a full 2 pi dome from the brow up, which is where the
           skull's own curvature lives;
         - the SKIRT, an arc from the collarbone up to the brow, which is
           where the opening lives.
       They overlap by 0.04 hr at the brow so there is no seam to see. */
    const BROW_Y = headY + hr * 0.24;
    /* --- crown: closed --- */
    g.lathe(B.HEAD, [
      [hr * 1.21 * HELM_CLEAR, BROW_Y - hr * 0.02],
      [hr * 1.20 * HELM_CLEAR, headY + hr * 0.72],
      [hr * 0.94 * HELM_CLEAR, headY + hr * 1.10],
      [hr * 0.52 * HELM_CLEAR, headY + hr * 1.32],
      [0.0, headY + hr * 1.40]
    ], { seg: g.seg(1), squash: [SQX, SQZ] });
    /* --- skirt: open across the face --- */
    /* A MONOTONIC TAPER, NOT A DERIVED ONE.
       Deriving each ring from the skull profile looked right and rendered a
       jagged mess: the skull narrows fast toward the jaw, so the derived
       radii went 1.32, 0.76, 1.04, 1.19, 1.22, 1.40 -- out, in, out, in.
       A lathe profile that reverses like that draws folds, and the folds
       read as broken bands across the helmet.
       A barbute's cheekpieces converge downward toward the neck, so the
       profile is simply widest at the temple and narrowest at the hem. Read
       off the skull's own numbers -- 1.02 hr at +0.83 (widest), 1.14 at the
       crown -- and monotonically decreasing below the temple. */
    g.lathe(B.HEAD, [
      [hr * 1.10 * HELM_CLEAR, headY - hr * 1.20],
      [hr * 1.15 * HELM_CLEAR, headY - hr * 0.78],
      [hr * 1.20 * HELM_CLEAR, headY - hr * 0.34],
      [hr * 1.22 * HELM_CLEAR, headY + hr * 0.12],
      [hr * 1.21 * HELM_CLEAR, BROW_Y + hr * 0.06]
    ], { seg: g.seg(2), squash: [SQX, SQZ], arc: COVERED, arcStart: START });

  }
}

/** A crest or plume, Age III+. */
export function buildCrest(g, m, colour, count = 4) {
  const { headY, hr } = m;
  g.material(MAT.HAIR).color(colour);
  /* A crest is a fin, so each lock is one quad wide and one segment deep:
     at two rings per lock, five locks cost 60 triangles for a plume. */
  /* Three segments, not four: a plume lock is 12 mm across and reads purely
     as a silhouette against the sky, and every triangle in the crest is a
     triangle the age-4 soldier does not have for his armour. */
  for (let i = 0; i < count; i++) {
    const t = (i - (count - 1) / 2) / ((count - 1) / 2 || 1);
    g.tube(B.HEAD, [0, headY + hr * 1.10, t * hr * 0.60],
      [0, headY + hr * (1.55 + 0.20 * (1 - Math.abs(t))), t * hr * 0.90],
      0.024, 0.015, { seg: 3, rings: 1, squash: [0.55, 1.0] });
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
    /* Three rings below near tier, four at it. A pauldron's silhouette is
       its crown, its flare and its lame; the fourth ring sits between the
       flare and the lame and describes no feature at 8 segments. */
    g.lathe(SHO, g.detail === DETAIL.NEAR ? [
      [0.000, y(1.492)],
      [0.092 * lw, y(1.428)],
      [0.152 * lw, y(1.314)],
      [0.120 * lw, y(1.291)]
    ] : [
      [0.000, y(1.492)],
      [0.104 * lw, y(1.400)],
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
  /* THREE rings, not four. The middle pair described a 2 mm bulge that no
     camera resolves, and the belt is drawn on every soldier in the game --
     24 triangles a man times three hundred is 7k in the frame for a curve
     nobody can see. The two end rings still turn inward, so the strap keeps
     its thickness and its shadow. */
  g.lathe(B.SKIRT, [
    [x(0.180), y(1.055)],
    [x(0.192), y(0.978)],
    [x(0.180), y(0.955)]
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
  /* Four rings at near, three below it. The cape's silhouette is its hem and
     its shoulders; the two rings between them sample a straight fall. It is
     also the broadest single surface in the class -- at 14 segments it cost
     120 triangles on its own, against 148 for the great helm. */
  g.lathe(B.SKIRT, [
    [x(0.105), y(1.585)],
    [x(0.264), y(1.16)],
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
/* ------------------------------------------------------------------
   A TWO-HANDED AXE, AUTHORED BETWEEN THE FISTS.

   `grip` is the pair of guard-pose hand positions from rigs.js. The haft
   runs from below the lower fist to above the upper one, so it passes
   through both hands however the guard is tuned; the head hangs off the
   end that points up and forward. Everything is parented to the pelvis,
   which is upright in every pose, so the whole weapon keeps the line it is
   drawn on.
   ------------------------------------------------------------------ */
export function buildTwoHandedAxe(g, m, opts = {}) {
  const grip = m.grip;
  if (!grip) return;
  const UPRIGHT = B.SKIRT;
  /* which fist is lower on the haft decides which way the blade points */
  const lo = grip.R[1] <= grip.L[1] ? grip.R : grip.L;
  const hi = grip.R[1] <= grip.L[1] ? grip.L : grip.R;
  /* the shaft runs through both, extended past the top fist by the length of
     the head's neck and below the bottom fist by a hand's width of butt */
  const dir = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const u = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  /* The BUTT is the end that points UP on this grip. A Dane axe is carried
     head-low in the guard and driven up and over on the swing, and the two
     fists are already stated the right way round -- left high, right low --
     so the long end of the haft, the end the head hangs off, is the one past
     the LOWER fist. Written the other way the axe head sat behind the hip. */
  const butt = [lo[0] + u[0] * 0.02, lo[1] + u[1] * 0.02, lo[2] + u[2] * 0.02];
  const top = [hi[0] + u[0] * 0.60, hi[1] + u[1] * 0.60, hi[2] + u[2] * 0.60];

  g.material(MAT.WOOD).color(0.46, 0.34, 0.22);
  g.tube(UPRIGHT, butt, top, 0.016, 0.018,
    { seg: g.detail === 0 ? 5 : 4, rings: 1 });
  /* the butt spike: a haft that ends in an open pipe reads as a broken prop */
  g.material(MAT.PLATE).color(0.44, 0.46, 0.50);
  g.tube(UPRIGHT, butt, [butt[0] - u[0] * 0.05, butt[1] - u[1] * 0.05, butt[2] - u[2] * 0.05],
    0.020, 0.011, { seg: 4, rings: 1 });

  /* THE HEAD: a bearded axe, hung off the top of the haft and offset to
     whichever side the upper fist does not occupy (the blade sits outside
     the hands on a real axe, never between them). A blade built along the
     haft instead of across it is a spike, not an axe. */
  const side = hi[0] >= 0 ? 1 : -1;
  const hx = top[0] + side * 0.085;
  const socketTop = [top[0], top[1] + 0.02, top[2]];
  g.material(MAT.PLATE).color(0.66, 0.68, 0.72);
  g.tube(UPRIGHT, [socketTop[0], socketTop[1] + 0.055, socketTop[2]],
    [socketTop[0], socketTop[1] - 0.055, socketTop[2]], 0.034, 0.030,
    { seg: 4, rings: 1 });
  /* THE BLADE: a broad crescent, so it is NARROW at the socket and widest at
     the cutting edge. `blade`'s default section list tapers toward the far
     end, which is right for a sword pointing at the target and exactly wrong
     for an axe -- it made the head a spear point growing sideways out of the
     haft. Sections are stated here, widening from the eye to the edge. */
  /* THE HEAD, BUILT AS A CRESCENT IN THE X-Y PLANE.
     `blade` spreads its width along an axis perpendicular to the blade's
     LENGTH, and for a horizontally-held haft that perpendicular runs
     front-to-back -- so the axe head rendered as a flat card seen edge-on
     from the side, which is the one angle it is ever looked at. An axe head
     is a plate whose FLAT lies in the plane of the haft: tall along the
     haft, thin perpendicular to it, broad outward from the socket.
     So: a slab with its height on Y and its thin axis on Z, plus a second
     slab raked back to make the bearded lower horn. Two boxes, 24
     triangles, and the silhouette is an axe from every side. */
  g.material(MAT.PLATE).color(0.66, 0.68, 0.72);
  const bladeX = socketTop[0] + side * 0.105;
  /* the main plate: 210 mm tall, 105 mm out, 18 mm thick */
  g.slab(UPRIGHT, [socketTop[0] + side * 0.052, socketTop[1] - 0.01, socketTop[2]],
    [0.105, 0.210, 0.018], { rot: 0 });
  /* the cutting edge: a thinner plate standing proud of the main one, at the
     outer end, so the edge catches light separately from the cheek */
  g.material(MAT.PLATE).color(0.86, 0.88, 0.91);
  g.slab(UPRIGHT, [bladeX, socketTop[1] - 0.01, socketTop[2]],
    [0.026, 0.225, 0.010], { rot: 0 });
  /* the beard: the lower horn, raked back toward the haft */
  g.material(MAT.PLATE).color(0.66, 0.68, 0.72);
  g.slab(UPRIGHT, [socketTop[0] + side * 0.058, socketTop[1] - 0.145, socketTop[2]],
    [0.098, 0.130, 0.017], { rot: side * 0.30 });
}

export function buildSword(g, hand, pos, len, opts = {}) {
  /* Grip, guard, blade. The blade used to start at the hand and taper all
     the way down, so a swordsman was holding a spike: there was no hilt to
     say where the weapon began, and nothing parallel-sided to say what it
     was. `len` is now the blade length, measured from the guard.

     It also leans OUT and FORWARD. Hanging straight down, the blade is
     inside the surcoat from the waist to the hem and only the last few
     centimetres of it show, which is why a swordsman looked unarmed next
     to a spearman. */
  /* Parented to the PELVIS for the same reason the spear is: a weapon
     authored in bind space and skinned to the hand rotates with the guard,
     which swings the blade across the body. The pelvis is upright in every
     pose, so the angle written here is the angle that renders -- and the
     hand is posed to close on the grip. */
  const UPRIGHT = B.SKIRT;
  const grip = Math.min(0.13, len * 0.3);
  const out = Math.sign(pos[0] || 1);
  g.material(MAT.LEATHER).color(0.30, 0.21, 0.14);
  if (g.detail === DETAIL.NEAR) {
    /* grip and pommel. At mid and far the fist itself is the hilt: a
       4-sided tube 2 cm across is a handful of pixels there, and a pommel
       is less than one. */
    g.tube(UPRIGHT, [pos[0], pos[1] + grip * 0.55, pos[2]],
      [pos[0], pos[1] - grip * 0.55, pos[2]], 0.020, 0.019, { seg: 4, rings: 1 });
    g.material(MAT.PLATE).color(0.62, 0.64, 0.68);
    g.ellipsoid(UPRIGHT, [pos[0], pos[1] + grip * 0.58, pos[2]],
      [0.030, 0.026, 0.030], { sph: [4, 3] });
  }
  if (g.detail <= DETAIL.MID) {
    /* Crossguard across the blade. The blade runs down -Y and a little
       +Z, so the quillons lie along X: a slab 0.17 wide in X, 0.034 along
       the blade, and thin in Z. A slab with its long axis on Y is just a
       lump on the hand. */
    g.slab(UPRIGHT, [pos[0], pos[1] - grip * 0.62, pos[2] + 0.012],
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
  g.blade(UPRIGHT, [pos[0], top, pos[2] + 0.01], tip, 0.030, {
    thick: 0.009,
    /* Four sections, from five. The 0.10 and 0.82 rings describe a
       parallel-sided blade between two tapers, and one straight run between
       the shoulder and the point reads identically at 30 cm on screen. */
    sections: [
      { t: 0, w: 0.021, th: 0.009 },
      { t: 0.10, w: 0.030, th: 0.010 },
      { t: 0.90, w: 0.024, th: 0.008 },
      { t: 1, w: 0.004, th: 0.003 }
    ]
  });
}

/** A spear: a long shaft with a leaf head. Thrusts, so it hangs upright. */
export function buildSpear(g, hand, pos, len = 1.9) {
  /* A SPEAR IS HELD UPRIGHT, AND IT IS HELD IN TWO HANDS.
     The old one ran 0.25 m above the hand and `len` below it along a single
     line from a hip-height origin, so it was a 2.1 m shaft standing on the
     diagonal in front of the belly -- and at rest the hands hang at the
     model's sides, so nothing was holding it. Every reference soldier plants
     his spear: butt on the ground beside the right foot, shaft vertical, top
     hand at shoulder height, and the blade two metres up where it belongs.

     That is a position that only exists in an IDLE pose, which is why it is
     authored against the guard rather than against the bind pose. The two
     grip points below are where the right and left hands actually end up
     under IDLE_GUARD.spearman. If the guard moves, these move with it. */
  const [rx, ry, rz] = pos;
  /* top hand (left) high on the shaft, right hand lower and closer to the
     body -- the pose leans the shoulders, so the shaft tilts slightly */
  const topX = rx, topY = ry + 0.30, topZ = rz;
  const botX = topX - 0.045, botY = topY - len, botZ = topZ - 0.02;
  /* SKINNED TO THE PELVIS, not the hand.
     Everything here is emitted in bind space and posed afterwards, so a
     shaft parented to the hand inherits whatever rotation the guard gives
     that hand -- and the spearman's guard swings the arm forward, which laid
     the "planted" spear out at forty degrees across his body. The pelvis
     stays upright in every pose this rig has, so a vertical shaft parented
     to it stays vertical. The hands are posed to meet it. */
  const UPRIGHT = B.SKIRT;
  g.material(MAT.WOOD).color(0.50, 0.37, 0.24);
  g.tube(UPRIGHT, [botX, botY, botZ], [topX, topY, topZ],
    0.015, 0.017, { seg: g.detail === DETAIL.NEAR ? 5 : 4, rings: 1 });
  /* BUTT CAP, so the shaft is not an open tube resting on the ground. */
  g.material(MAT.PLATE).color(0.40, 0.42, 0.46);
  g.tube(UPRIGHT, [botX, botY, botZ], [botX, botY + 0.055, botZ], 0.021, 0.017,
    { seg: 4, rings: 1 });
  /* THE HEAD: a winged spear tip with a socket, and a team-coloured tassel
     below it. The tassel is the Age of Empires signature on a spear and it is
     four triangles -- it reads as a coloured accent at gameplay distance even
     when the blade itself is one pixel wide. */
  g.material(MAT.PLATE).color(0.78, 0.80, 0.84);
  g.tube(UPRIGHT, [topX, topY, topZ], [topX, topY + 0.10, topZ], 0.021, 0.024,
    { seg: 4, rings: 1 });                       /* socket */
  g.blade(UPRIGHT, [topX, topY + 0.10, topZ], [topX, topY + 0.44, topZ],
    0.042, { thick: 0.013 });                    /* leaf blade */
  /* the wings: two small cross-pieces at the base of the blade */
  g.slab(UPRIGHT, [topX, topY + 0.115, topZ], [0.115, 0.020, 0.016]);
  /* the tassel, in undyed cloth so it frames the team colour */
  g.material(MAT.TRIM).color(0.90, 0.88, 0.80);
  g.tube(UPRIGHT, [topX, topY + 0.055, topZ], [topX + 0.012, topY - 0.09, topZ + 0.012],
    0.026, 0.016, { seg: 4, rings: 1 });
  g.material(MAT.PLATE).color(0.78, 0.80, 0.84);
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
  /* One ring at mid: a quiver is a straight tube, and the second ring was
     sampling a curve that is not there. */
  g.tube(B.CHEST, [x(0.10), y(1.44), -0.14], [x(0.14), y(1.10), -0.17],
    0.048, 0.042, { seg: 5, rings: g.detail === 0 ? 2 : 1 });
  g.material(MAT.WOOD).color(0.50, 0.42, 0.30);
  for (let i = 0; i < 3; i++) {
    const t = (i - 1) * 0.018;
    g.tube(B.CHEST, [x(0.10) + t, y(1.44), -0.14 + t],
      [x(0.11) + t, y(1.62), -0.10 + t], 0.006, 0.005, { seg: 3, rings: 1 });
  }
}

/** A farmer's tool: axe, pick, sickle, crook or mallet. */
export function buildTool(g, hand, pos, kind) {
  /* SKINNED TO THE PELVIS, like every other carried thing in this file.
     A haft parented to the hand swings with the guard and ends up lying
     across the body pointing at nothing; the pelvis is upright in every
     pose, so the tool hangs where it is drawn. */
  const UPRIGHT = B.SKIRT;
  g.material(MAT.WOOD).color(0.46, 0.34, 0.22);
  const top = [pos[0], pos[1] + 0.26, pos[2]];
  const bottom = [pos[0], pos[1] - 0.40, pos[2]];
  g.tube(UPRIGHT, top, bottom, 0.015, 0.017, { seg: 4, rings: 1 });
  if (g.detail > DETAIL.MID) return;
  g.material(MAT.PLATE).color(0.62, 0.63, 0.66);
  if (kind === 'axe' || kind === 'pick') {
    /* A head at the top, offset perpendicular to the haft -- and just under
       it, not beside it: a slab centred on the haft's own axis swallowed the
       top 40 mm of the shaft and read as a lump balanced on a stick. */
    g.slab(UPRIGHT, [top[0] - 0.058, top[1] - 0.045, top[2]],
      [0.115, 0.105, 0.022], { rot: kind === 'pick' ? 0.4 : 0 });
  } else if (kind === 'sickle') {
    g.tube(UPRIGHT, [top[0], top[1] - 0.02, top[2]], [top[0] + 0.11, top[1] + 0.01, top[2]],
      0.016, 0.008, { seg: 3, rings: 1 });
  } else if (kind === 'mallet') {
    g.slab(UPRIGHT, [top[0], top[1] - 0.05, top[2]], [0.14, 0.075, 0.075]);
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
