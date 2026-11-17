/* ============================================================
   classes.js — the cast, as declarations

   One entry per humanoid unit class. Each says what it wears, what it
   carries and how it stands. The build itself is anatomy.js plus
   wardrobe.js, so a class that only differs in a hat and a tool costs
   about eight lines instead of a copy of the man-at-arms.

   The comments here are the design specification: what makes this class
   unmistakable at gameplay distance. If a change makes two classes read
   the same, the comment is the thing that was violated.
   ============================================================ */

import { B } from './skeleton.js';
import { DETAIL } from './meshbuilder.js';
import {
  MAT, buildHelm, buildCrest, buildSurcoat, buildPauldrons, buildBelt,
  buildCape, buildSword, buildSpear, buildBow, buildQuiver, buildTool,
  buildStaff, buildSatchel
} from './wardrobe.js';
import { buildBody, buildHair, buildFaceDetail } from './anatomy.js';

/**
 * Hang a heater shield on the left arm.
 *
 * Mounted riders need different geometry from foot soldiers and everyone was
 * getting the infantry placement: for a man on a destrier the shield sat
 * flat and horizontal over the horse's neck, level with the ears, like a
 * plank laid across the reins. The reason is that a rider's left arm hangs
 * BESIDE the horse, so a plate swung on its own centre in the frontal plane
 * ends up edge-on to the ground -- and `rot` cannot fix it, because `rot`
 * only spins the plate about its face normal.
 *
 * So: on foot the shield hangs in front of the flank; mounted it is turned
 * to lie along the horse's near side, lower and further out, where a rider
 * actually carries it.
 */
function hangHeater(g, m, size, age = 3) {
  /* `m.mounted` is set by rigs.js before the class builds. */
  if (m.mounted) {
    g.heater(B.HAND_L, [-m.x(0.375), m.y(0.98), -0.02],
      [size[0] * 0.94, size[1] * 0.90, size[2]], { rot: -1.30, dome: 0.30 });
  } else {
    g.heater(B.HAND_L, [-m.x(0.300), m.y(age >= 4 ? 1.14 : 1.10), 0.15],
      size, { rot: 0.10, dome: 0.30 });
  }
}

/**
 * Every class definition.
 *
 * silhouette  — proportion overrides on top of the profile
 * helm        — helmet kind, or 'none'
 * hair        — 'short' | 'long' | 'braid' | 'bald'
 * dress(age)  — returns the garment list for that age tier
 * kit         — what is carried
 */
export const CLASSES = {
  /* ---------- MAN-AT-ARMS ----------
     The imposing juggernaut: widest shoulders in the game, mail from Age
     III, plate pauldrons, surcoat, heater shield and arming sword. */
  man_at_arms: {
    profile: 'manAtArms',
    /* Mail to the skin: the body IS the hauberk, and the surcoat goes over
       it. Without this flag he is a padded jacket with a tabard. */
    mailedBody: true,
    helm: (age) => (age <= 2 ? 'kettle' : age === 3 ? 'barbute' : 'great'),
    hair: 'short',
    beard: false,
    crest: (age) => (age >= 4 ? [0.55, 0.10, 0.10] : null),
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (this.crest(o.age)) buildCrest(g, m, this.crest(o.age));
      if (o.age <= 2) buildHairAfterHelm(g, m, this, o);
      if (o.age >= 3) buildPauldrons(g, m);
      if (o.age >= 2 && g.detail <= DETAIL.MID) {
        buildSurcoat(g, m);
        buildBelt(g, m);
      }
      const rh = [m.handX, m.handY, 0.03];
      buildSword(g, B.HAND_R, rh, m.y(0.42));
      /* A heater shield is carried on the forearm, tilted, hanging just
         below the elbow. */
      g.material(MAT.WOOD).color(0.55, 0.46, 0.34);
      /* The shield hangs on the forearm just outside the flank. `rot` swings
         a 0.34 m plate about its own centre, so 0.22 rad alone threw it to
         x = -0.51 and laid it across the near arm; 0.10 keeps it on the
         armature and the centre is set to clear the elbow. */
      hangHeater(g, m, [0.32, 0.46, 0.030], o.age);
    }
  },

  /* ---------- VILLAGER ----------
     Narrowest shoulders, no armour at any age, plain tunic, a tool that
     changes with the job. Should read as a civilian from across the map. */
  villager: {
    profile: 'villager',
    helm: () => 'none',
    hair: 'short',
    beard: true,
    build(g, m, o) {
      buildHairAfterHelm(g, m, this, o);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      buildSurcoat(g, m, { flares: true });
      buildBelt(g, m);
      buildSatchel(g, m);
      buildTool(g, B.HAND_R, [m.handX + 0.030, m.y(0.98), 0.06], o.tool || 'axe');
    }
  },

  /* ---------- SPEARMAN ----------
     Light infantry: a long spear is the entire silhouette. Kettle hat,
     padded jack, no shield, both hands on the shaft. */
  spearman: {
    profile: 'spearman',
    helm: (age) => (age <= 2 ? 'kettle' : 'barbute'),
    hair: 'short',
    beard: false,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (o.age <= 2) buildHairAfterHelm(g, m, this, o);
      buildBelt(g, m);
      /* The spear is the silhouette: nearly two metres of it, planted on the
         ground just outside the right foot and rising past the shoulder. The
         grip origin is the right hand's position under the spearman guard --
         forward of the body and out to the side, which is where the hand
         actually is once the pose is applied, not where it hangs in bind. */
      buildSpear(g, B.HAND_R,
        [m.handX + 0.055, m.y(1.02), 0.14], m.y(1.28));
    }
  },

  /* ---------- ARCHER ----------
     Narrow waist, wide shoulders, a bow and a quiver, a hood rather than
     a helm. The bow curve is what distinguishes him at distance. */
  archer: {
    profile: 'archer',
    helm: (age) => (age <= 2 ? 'hood' : 'kettle'),
    hair: 'short',
    beard: false,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      buildBelt(g, m);
      buildQuiver(g, m);
      buildBow(g, B.HAND_L, [-m.x(0.255), m.y(0.85), 0.10]);
    }
  },

  /* ---------- SKIRMISHER ----------
     Javelins and a light shield: smaller than an archer's bow, and no
     quiver. A capped, banded look. */
  skirmisher: {
    profile: 'archer',
    helm: () => 'hood',
    hair: 'short',
    beard: false,
    build(g, m, o) {
      buildHelm(g, m, 'hood', o.age);
      buildBelt(g, m);
      /* three javelins behind the off shoulder */
      g.material(MAT.WOOD).color(0.48, 0.38, 0.26);
      for (let i = 0; i < 3; i++) {
        const t = (i - 1) * 0.030;
        g.tube(B.CHEST, [m.x(0.09) + t, m.y(1.48), -0.12],
          [m.x(0.16) + t, m.y(0.96), -0.20], 0.011, 0.009, { seg: 3, rings: 1 });
      }
      g.material(MAT.WOOD).color(0.52, 0.43, 0.32);
      hangHeater(g, m, [0.28, 0.34, 0.026], o.age);
    }
  },

  /* ---------- SWORDSMAN ----------
     Mid-weight infantry. Mail at Age III, a kite shield and a sword.
     Between the spearman and the man-at-arms in build. */
  swordsman: {
    profile: 'spearman',
    helm: (age) => (age <= 2 ? 'kettle' : age === 3 ? 'barbute' : 'great'),
    hair: 'short',
    beard: false,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (o.age >= 3) buildPauldrons(g, m);
      buildBelt(g, m);
      buildSword(g, B.HAND_R, [m.handX, m.handY, 0.03], m.y(0.42));
      g.material(MAT.WOOD).color(0.50, 0.42, 0.32);
      hangHeater(g, m, [0.30, 0.44, 0.028], o.age);
    }
  },

  /* ---------- KNIGHT / CATAPHRACT / CLAIMANT ----------
     Mounted aristocracy. Tall, broad, a great helm, a cape, plate at the
     top age. The rider is built here; the horse is a separate rig. */
  knight: {
    profile: 'knight',
    mailedBody: true,
    helm: (age) => (age <= 2 ? 'nasal' : age === 3 ? 'great' : 'great'),
    hair: 'short',
    beard: false,
    crest: (age) => (age >= 4 ? [0.62, 0.14, 0.12] : null),
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (this.crest(o.age)) buildCrest(g, m, this.crest(o.age), 5);
      buildPauldrons(g, m);
      buildCape(g, m, o.capeColor || [0.34, 0.12, 0.14]);
      buildSurcoat(g, m);
      const rh = [m.handX, m.handY, 0.03];
      buildSword(g, B.HAND_R, rh, m.y(0.44));
      g.material(MAT.WOOD).color(0.44, 0.36, 0.26);
      hangHeater(g, m, [0.32, 0.46, 0.030], o.age);
    }
  },

  /* ---------- MONK ----------
     A robe to the ankles, a hood or tonsure, a staff, sandals. Narrow,
     and the only class in a long unbroken garment. */
  monk: {
    profile: 'monk',
    helm: () => 'none',
    hair: 'bald',
    beard: true,
    /* The habit covers the whole body, so the body underneath it should BE
       the habit. Left as the default gambeson grey, every seam the robe does
       not quite reach -- the armpit, the collar notch, a sliver at the
       shoulder -- showed as grey undershirt through brown wool. There is no
       grey garment on a monk to show. */
    bodyCol: [0.50, 0.40, 0.32],
    bodyMat: 0,
    legMat: 0,
    build(g, m, o) {
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      /* The robe: a long lathe from the shoulders to the ankles. This is
         the monk's whole silhouette, so it gets a real profile.

         The brown is lifted off the floor of the palette on purpose. At
         0.42/0.33/0.26 a robe this big has no gradient left across its
         front third and reads as a hole in the figure rather than as
         cloth -- the same trap the cape above fell into. */
      g.material(MAT.LINEN).color(0.52, 0.42, 0.33);
      g.lathe(B.SKIRT, [
        /* The robe has to close over the shoulders, not stop below them.
           The bare tunic reaches 0.225 at y(1.45) and the neck is only 0.058
           across, so any hemline between the two leaves a ring of pale tunic
           visible around the collarbones. Carry the collar up to the jaw,
           which is also what a hooded habit actually looks like. */
        /* The collar stops at the base of the neck. Carried to m.y(1.582)
           it swallowed the jaw and the whole throat, and the head became a
           ball resting on a cone -- a hood, not a habit. */
        /* The garment has to be wider than the TUNIC at every height, not
           merely wider than the neck: the tunic's own shoulder is 0.15-0.22
           across between 1.47 and 1.56, and a robe that pinched to 0.092
           there by 1.53 left a pale wedge of tunic standing proud of the
           habit on both shoulders. */
        [m.x(0.092), m.y(1.568)],
        [m.x(0.150), m.y(1.546)],
        [m.x(0.212), m.y(1.510)],
        [m.x(0.244), m.y(1.466)],
        [m.x(0.232), m.y(1.260)],
        [m.x(0.246), m.y(0.92)],
        [m.x(0.278), m.y(0.52)],
        [m.x(0.294), m.y(0.13)]
      /* Ring 3 (y 1.26) is the sub-chest, and between 1.50 and 0.92 the
         robe is near-vertical: it adds no silhouette for its 16 triangles
         at any tier. */
      /* `i !== 6` as well as `i !== 3` at near: 0.52 and 0.92 are two
         samples of a near-straight 1.4 m fall and 8 segments on the widest
         lathe in the class is 64 triangles for one. */
      ].filter((_, i) => (i !== 3) &&
        (g.detail === DETAIL.NEAR ? i !== 6 : (i !== 1 && i !== 5 && i !== 6))),
      { seg: g.detail === DETAIL.NEAR ? g.seg(0) + 1 : g.seg(0),
        squash: [1.0, m.cd / m.sw * 1.02],
        folds: g.detail === DETAIL.NEAR ? 5 : 0, foldDepth: 0.060 });

      /* SLEEVES. The arms hang at armX = 0.268, which is outside a robe that
         is 0.24 across at the shoulder, so the bare arm and its skin tone can
         only ever sit proud of the cloth. Cover it.

         One lathe, not a tube plus a cap: a `tube` is an open cylinder, so a
         sleeve wide enough to swallow the deltoid has a mouth at the top that
         faces the sky and reads as a hole in the shoulder. Two patched
         attempts at capping it -- a flat disc, then a dome -- both showed
         through as a rim, because the tube and the cap were separate
         surfaces at slightly different radii. A lathe profile starting at
         radius zero closes the crown as a pole, so there is nothing to cap,
         and the same profile can flare the cuff. */
      const sl = m.lw;
      for (const side of [-1, 1]) {
        const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
        const UP = side < 0 ? B.UPPER_ARM_L : B.UPPER_ARM_R;
        const sx = side * m.x(m.armX);
        g.material(MAT.LINEN).color(0.48, 0.39, 0.31);
        /* Six rings at near; the two that only describe the upper arm's
           slight swell are below the pixel at mid and far. */
        /* 75-90 mm, not 120: the sleeve was 0.25 m across, i.e. twice the
           width of the head, so the monk read as wearing two columns. */
        /* Wide at the crown, narrow down the arm. The deltoid ball is
           0.108 across and reaches 0.371 from the centre line, so a sleeve
           narrower than that there leaves a pale crescent of tunic showing
           at the shoulder -- which is what the last two drafts rendered as
           a scalloped wedge on each shoulder. A habit's sleeve IS wide at
           the top; the only fault before was making it wide everywhere. */
        const sleeve = g.detail === DETAIL.NEAR ? [
          [0.000, m.y(1.548)],
          [0.100, m.y(1.492)],
          [0.126, m.y(1.400)],
          [0.084, m.y(1.120)],
          [0.094, m.y(0.930)]
        ] : [
          [0.000, m.y(1.548)],
          [0.110, m.y(1.455)],
          [0.078, m.y(1.150)],
          [0.094, m.y(0.930)]
        ];
        /* `seg(-2)` at near: a sleeve is a 90 mm cylinder down a 300 mm
           arm, and six segments is already rounder than the arm inside it. */
        g.lathe(UP, sleeve, {
          seg: g.detail === DETAIL.NEAR ? g.seg(-2) : g.seg(-1),
          x: sx, blend: SHO
        });
        /* the cuff is still an open cylinder -- cap it, the wrist goes in */
        /* the cuff is a closed lathe ring now: the profile ends at 0.126
           and the wrist passes through it, so a cap on top is eight more
           triangles that are never seen */
        g.cap(UP, [sx * 0.955, m.y(0.930), 0], 0.092 * sl, [0, -1, 0],
          { seg: g.detail === DETAIL.NEAR ? g.seg(0) : 4 });
        /* The robe collar closes to 0.118 at the jaw and the sleeve crown
           starts 0.268 out, so the bare deltoid shows between them as a pale
           notch. Bridge the yoke -- but only where the seam can be seen; half
           a sphere each side is not worth 60 triangles at mid range. */
        /* No yoke sphere. It was a patch for the bare deltoid showing
           between the robe collar and the sleeve crown, but with the collar
           widened to 0.236 the robe already covers that gap, and the patch
           itself now shows: a pale ellipsoid biting a scallop out of the
           shoulder in the garment's own shade. */
        void SHO;
      }

      /* Two fold ridges down the front of the robe. A lathe can only shade
         by its own slope, and a near-vertical profile has almost none, so
         without something breaking the face the front is one flat tone.
         Off-centre and unequal: a symmetric pair reads as armour. */
      if (g.detail < DETAIL.FAR) {
        for (const [fx, fz, r] of [[-0.085, 0.255, 0.028], [0.115, 0.235, 0.019]]) {
          g.tube(B.SKIRT, [m.x(fx), m.y(1.16), fz * m.cd / m.sw],
            [m.x(fx * 1.30), m.y(0.24), fz * m.cd / m.sw * 1.25], r, r * 0.85,
            { seg: 4, rings: 1 });
        }
      }

      buildBelt(g, m);
      /* planted on the ground beside the hem, not hanging past it */
      /* Outside the robe's 0.25 radius at hip height, and inside the cuff's
         0.124 mouth, so the sleeve reads as gripping it. */
      /* The shaft runs THROUGH the fist, not beside it. It was pinned at
         x(0.320), which is the outer edge of the sleeve cuff and 60 mm
         outboard of the hand, so the staff hung in the air next to the arm
         all the way to the ground. m.handX is where the fist actually is. */
      /* Just outside the FINGERS, not at the wrist's centre line. The robe
         is 0.245 across at hip height, so a shaft at the wrist centre was
         swallowed by the habit all the way down and the monk appeared to be
         holding nothing. The fist is 0.227 out with a 0.045 radius, so the
         palm's outer edge is 0.272: put the shaft there and it reads as
         gripped, with the robe clear of it. */
      buildStaff(g, B.HAND_R, [m.handX + 0.048, m.y(0.90), 0.02, m.y(0.03), B.SKIRT]);
    }
  },

  /* ---------- AXEMAN ----------
     A two-handed axe: heavy shoulders, no shield, a beard and a bare head
     or a simple cap. */
  axeman: {
    profile: 'manAtArms',
    helm: (age) => (age <= 2 ? 'kettle' : 'barbute'),
    hair: 'short',
    beard: true,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (o.age <= 2) buildHairAfterHelm(g, m, this, o);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      buildBelt(g, m);
      /* a long haft with a broad head: both hands, diagonal across the body */
      g.material(MAT.WOOD).color(0.46, 0.34, 0.22);
      g.tube(B.HAND_R, [m.x(0.16), m.y(1.10), 0.10], [m.x(0.34), m.y(1.92), 0.24],
        0.021, 0.019, { seg: 5, rings: 2 });
      g.material(MAT.PLATE).color(0.60, 0.62, 0.66);
      g.slab(B.HAND_R, [m.x(0.36), m.y(1.96), 0.25], [0.19, 0.15, 0.026], { rot: 0.3 });
    }
  },

  /* ---------- HUSKARL ----------
     Norse heavy infantry: round shield, axe, mail, no horse. */
  huskarl: {
    profile: 'manAtArms',
    mailedBody: true,
    helm: (age) => (age <= 2 ? 'kettle' : 'nasal'),
    hair: 'braid',
    beard: true,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      if (o.age >= 3) buildPauldrons(g, m);
      buildBelt(g, m);
      buildSword(g, B.HAND_R, [m.handX, m.handY, 0.03], m.y(0.40));
      /* Round shield. It was a 300 mm radius disc centred 285 mm out from
         the centre line, i.e. most of its width hung inside the torso: the
         near arm, the belt and the whole flank were drawn through it and
         what showed was a brown wedge beside the hip. A shield covers the
         near side, so it is 230 mm across and sits OUTSIDE the shoulder
         line at armX. */
      /* ONE lathe for the whole board, and that is what makes the round
         shield affordable. The draft before it was three spheres -- a wooden
         disc, an iron disc 5 mm in front of it and a boss -- i.e. three
         closed shells of which two were almost entirely hidden by each
         other: ~120 triangles to show a 6 mm ring and a stud. A lathe about
         the shield's own axis draws the board and its iron edge as one
         profile, from the boss at the centre out to the rim and back in a
         short lip. The whole shield costs 32.
         The axis is the face normal, so the lathe has to be laid on its
         side: the profile is in the shield's radius, and `rot` tips it to
         face forward. */
      g.material(MAT.WOOD).color(0.52, 0.42, 0.30);
      /* FOUR rings, which is a fan from the boss to the rim and one lip back
         over the edge. A disc drawn from its centre pays one ring of
         triangles per ring of profile whether or not that ring describes
         anything, and the last draft carried seven. */
      const sy = m.y(1.03);
      g.lathe(B.HAND_L, g.detail === DETAIL.FAR ? [
        [0.000, sy + 0.052],
        [0.070, sy + 0.006],
        [0.258, sy + 0.020]
      ] : [
        [0.000, sy + 0.052],   /* boss crown, proud of the face */
        [0.070, sy + 0.006],   /* the face itself */
        [0.246, sy + 0.000],
        [0.258, sy + 0.020]    /* iron rim, turned forward over the edge */
      ], { seg: g.detail === DETAIL.NEAR ? 10 : g.detail === DETAIL.MID ? 8 : 6,
           x: -m.x(0.372), z: 0.13 });
    }
  },

  /* ---------- BERSERK ----------
     Bare torso, no helm, long hair and beard. The only topless humanoid,
     which is exactly what makes him readable. */
  berserk: {
    profile: 'manAtArms',
    helm: () => 'none',
    hair: 'long',
    beard: true,
    bareChest: true,
    build(g, m, o) {
      buildHairAfterHelm(g, m, this, o);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      buildBelt(g, m);
      g.material(MAT.WOOD).color(0.44, 0.32, 0.20);
      g.tube(B.HAND_R, [m.x(0.14), m.y(1.14), 0.10], [m.x(0.36), m.y(1.96), 0.26],
        0.023, 0.020, { seg: 5, rings: 2 });
      g.material(MAT.PLATE).color(0.58, 0.60, 0.64);
      g.slab(B.HAND_R, [m.x(0.38), m.y(2.00), 0.27], [0.20, 0.16, 0.028], { rot: 0.28 });
    }
  },

  /* ---------- SAMURAI ----------
     Layered lamellar, a wide conical helmet, a long curved blade. The
     shoulder flares are the tell. */
  samurai: {
    profile: 'spearman',
    helm: () => 'cone',
    hair: 'short',
    beard: false,
    build(g, m, o) {
      buildHelm(g, m, 'cone', o.age);
      /* SODE: the big shoulder guards.
         This was a single three-point lathe sweeping 360 degrees round the
         CHEST bone -- an open conical shell centred on the body, which from
         the front is a dark slab lying across the collarbones with the arms
         sticking out of it. A sode is a shell over the deltoid, so it is
         built the way the pauldrons are: a cut ellipsoid concentric with
         the shoulder ball and slightly larger. */
      g.material(MAT.PLATE).color(0.34, 0.20, 0.18);
      for (const side of [-1, 1]) {
        const SHO = side < 0 ? B.SHOULDER_L : B.SHOULDER_R;
        /* A sode hangs: it is a shell that starts high and narrow at the
           shoulder and flares down and out over the upper arm. A lathe
           closed on its own axis at both ends gives exactly that, and being
           closed it has no hole to see through from below. Shells built as
           cut ellipsoids came out as flat discs -- an ellipsoid squashed in
           Y, cut flat at the top, is a mushroom cap, not a guard. */
        /* Bone-local x=0 is the centre line, not the shoulder: the joint is
           out at armX and the lathe has to be offset to reach it. Rings
           that stay close in Y and grow a long way in radius give a cone;
           rings that drop a long way give a bell. This is a shoulder cap. */
        g.lathe(SHO, [
          [0, m.y(1.446)],
          [m.x(0.094), m.y(1.434)],
          [m.x(0.146), m.y(1.356)],
          [m.x(0.170), m.y(1.268)],
          [m.x(0.166), m.y(1.222)],
          [m.x(0.150), m.y(1.196)],
          [0, m.y(1.190)]
        ], { seg: g.detail < DETAIL.FAR ? 5 : 4, squash: [1.0, 0.92],
             x: side * m.x(m.armX) });
      }
      buildBelt(g, m);
      buildSurcoat(g, m, { flares: false });
      /* a curved katana: two segments so the arc reads */
      g.material(MAT.PLATE).color(0.82, 0.84, 0.88);
      const rh = [m.x(0.250), m.y(0.82), 0.04];
      g.blade(B.HAND_R, rh, [rh[0] + 0.10, m.y(0.40), rh[2] + 0.10], 0.028,
        { thick: 0.009, guard: 0.08 });
    }
  },

  /* ---------- LONG BOWMAN ----------
     English archer: a tall bow (taller than he is wide), a hood, a
     gambeson. The bow is drawn nearly 1.9 m, which is the silhouette. */
  longbowman: {
    profile: 'archer',
    helm: () => 'hood',
    hair: 'short',
    beard: true,
    build(g, m, o) {
      buildHelm(g, m, 'hood', o.age);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      buildBelt(g, m);
      buildQuiver(g, m);
      buildBow(g, B.HAND_L, [-m.x(0.260), m.y(0.86), 0.11]);
    }
  },

  /* ---------- HAND CANNONEER ----------
     A tube on a rest, powder horn, a padded coat. Reads as a specialist:
     shorter, hunched, carrying something that is not a bow. */
  hand_cannoneer: {
    profile: 'spearman',
    helm: (age) => (age <= 2 ? 'kettle' : 'barbute'),
    hair: 'short',
    beard: true,
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      buildBelt(g, m);
      /* a short iron tube, angled up, with a wooden stock */
      g.material(MAT.WOOD).color(0.42, 0.31, 0.20);
      g.tube(B.HAND_R, [m.x(0.24), m.y(0.74), 0.06], [m.x(0.30), m.y(1.02), 0.16],
        0.024, 0.022, { seg: 4, rings: 1 });
      g.material(MAT.PLATE).color(0.34, 0.33, 0.34);
      g.tube(B.HAND_R, [m.x(0.30), m.y(1.02), 0.16], [m.x(0.35), m.y(1.34), 0.26],
        0.030, 0.032, { seg: 5, rings: 1 });
      /* powder horn on the hip */
      g.material(MAT.LEATHER).color(0.40, 0.30, 0.20);
      g.tube(B.SKIRT, [m.x(0.19), m.y(0.98), 0.06], [m.x(0.22), m.y(0.86), 0.10],
        0.030, 0.020, { seg: 4, rings: 1 });
    }
  },

  /* ---------- MANGUDai / STEPPE ARCHER ----------
     Horse archer: a cone helm, a long coat, a compact bow, a quiver. */
  mangudai: {
    profile: 'knightMounted',
    helm: () => 'cone',
    hair: 'braid',
    beard: true,
    /* A steppe pony: small, dun, unarmoured. The mangudai's whole trick is
       to shoot and run, so the horse is a light animal under a light rider. */
    mount: () => ({
      coat: [0.46, 0.38, 0.26],
      mane: [0.15, 0.12, 0.09],
      caparison: null,
      barding: false
    }),
    build(g, m, o) {
      buildHelm(g, m, 'cone', o.age);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      g.material(MAT.LINEN).color(0.48, 0.36, 0.26);
      buildSurcoat(g, m, { flares: false });
      buildBelt(g, m);
      buildQuiver(g, m);
      buildBow(g, B.HAND_L, [-m.x(0.255), m.y(0.85), 0.10]);
    }
  },

  /* ---------- MOB RIOTER ----------
     A civilian with a club and no training: narrow, hunched, ragged. */
  mob_rioter: {
    profile: 'villager',
    helm: () => 'none',
    hair: 'long',
    beard: true,
    build(g, m, o) {
      buildHairAfterHelm(g, m, this, o);
      buildFaceDetail(g, m, { hair: o.hair, beard: true });
      buildBelt(g, m);
      buildTool(g, B.HAND_R, [m.x(0.250), m.y(0.80), 0.02], 'mallet');
    }
  },

  /* ---------- CATAPHRACT ----------
     Byzantine heavy cavalry: scale or mail over the whole body, a tall
     conical helm, a kite shield. Heavier than a knight and less ornamented. */
  cataphract: {
    profile: 'knightMounted',
    mailedBody: true,
    helm: (age) => (age <= 2 ? 'nasal' : 'cone'),
    hair: 'short',
    beard: false,
    crest: (age) => (age >= 4 ? [0.30, 0.34, 0.52] : null),
    /* The cataphract is the only class whose horse is armoured, and that is
       its identity: a wall of plate that arrives at a walk and does not
       stop. Barding appears at Age III with the rider's mail. */
    mount: (o) => ({
      coat: [0.28, 0.22, 0.17],
      mane: [0.12, 0.10, 0.08],
      caparison: o.age >= 3 ? [0.30, 0.32, 0.42] : [0.36, 0.30, 0.24],
      barding: o.age >= 3
    }),
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (this.crest(o.age)) buildCrest(g, m, this.crest(o.age), 3);
      buildPauldrons(g, m);
      buildBelt(g, m);
      g.material(MAT.WOOD).color(0.46, 0.38, 0.30);
      hangHeater(g, m, [0.30, 0.46, 0.030], o.age);
      buildSword(g, B.HAND_R, [m.handX, m.handY, 0.03], m.y(0.42));
    }
  },

  /* ---------- CLAIMANT KNIGHT ----------
     The rival pretender: a knight in richer colours, plumed, with a cape.
     Deliberately reads as the same species as the player's knight but
     grander, so an impostor is recognisable. */
  claimant_knight: {
    profile: 'knight',
    helm: (age) => (age <= 2 ? 'nasal' : 'great'),
    hair: 'short',
    beard: false,
    crest: (age) => (age >= 2 ? [0.66, 0.52, 0.16] : null),
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      if (this.crest(o.age)) buildCrest(g, m, this.crest(o.age), 3);
      buildPauldrons(g, m);
      buildCape(g, m, [0.46, 0.34, 0.10]);
      /* no surcoat: the claimant has a cape, and the two overlap over the
         same skirt rings for no visible gain */
      buildBelt(g, m);
      buildSword(g, B.HAND_R, [m.handX, m.handY, 0.03], m.y(0.44));
      g.material(MAT.WOOD).color(0.50, 0.42, 0.28);
      hangHeater(g, m, [0.32, 0.48, 0.030], o.age);
    }
  },

  /* ---------- HERO GENERAL / LORD COMMANDER ----------
     The player's own king, and the most-looked-at unit on the field. Tallest
     proportions in the cast, gilded plate, a red cape, a plumed great helm
     and a gold-hilted sword. Must read as *yours* from any distance. */
  hero_general: {
    profile: 'knight',
    hero: true,
    helm: (age) => (age <= 2 ? 'nasal' : 'great'),
    hair: 'short',
    beard: false,
    crest: () => [0.78, 0.58, 0.16],
    build(g, m, o) {
      buildHelm(g, m, this.helm(o.age), o.age);
      buildCrest(g, m, this.crest(o.age), 3);
      buildPauldrons(g, m);
      buildCape(g, m, [0.52, 0.14, 0.14]);
      buildBelt(g, m);
      /* gilded cross-guard: the one place in the game a weapon is gold */
      g.material(MAT.PLATE).color(0.86, 0.70, 0.28);
      g.blade(B.HAND_R, [m.x(0.250), m.y(0.80), 0.03],
        [m.x(0.235), m.y(0.42), 0.08], 0.032, { thick: 0.011, guard: 0.13 });
      g.material(MAT.WOOD).color(0.48, 0.38, 0.26);
      hangHeater(g, m, [0.33, 0.47, 0.032], o.age);
    }
  },

  /* ---------- SCOUT CAVALRY ----------
     The rider is a light horseman: a hood or cap, a small bow or a
     javelin, no armour. */
  scout_cavalry: {
    profile: 'scoutMounted',
    helm: () => 'hood',
    hair: 'short',
    beard: false,
    /* A scout rides a light pony with a plain saddle blanket and no barding:
       the whole point of the unit is that it is cheap and fast, and plate on
       the horse would say otherwise from across the map. */
    mount: () => ({
      coat: [0.42, 0.31, 0.21],
      mane: [0.17, 0.13, 0.10],
      caparison: [0.34, 0.30, 0.26],
      barding: false
    }),
    build(g, m, o) {
      buildHelm(g, m, 'hood', o.age);
      buildBelt(g, m);
      buildBow(g, B.HAND_L, [-m.x(0.250), m.y(0.85), 0.10]);
    }
  }
};

/**
 * Hair is drawn *after* the helmet only when the helmet does not cover the
 * head — otherwise locks poke through the steel.
 */
function buildHairAfterHelm(g, m, def, o) {
  if (def.hair === 'bald') return;
  buildHair(g, m, null, { hair: o.hair, hairStyle: def.hair });
}

/** Fallback for a class with no entry: a plain unarmed figure. */
export const FALLBACK_CLASS = {
  profile: 'spearman',
  helm: () => 'none',
  hair: 'short',
  build(g, m, o) {
    buildHairAfterHelm(g, m, this, o);
    buildBelt(g, m);
  }
};
