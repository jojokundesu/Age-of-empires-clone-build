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
      const rh = [m.x(0.258), m.y(0.79), 0.03];
      buildSword(g, B.HAND_R, rh, m.y(0.35));
      /* A heater shield is carried on the forearm, tilted, hanging just
         below the elbow. */
      g.material(MAT.WOOD).color(0.55, 0.46, 0.34);
      /* The shield hangs on the forearm just outside the flank. `rot` swings
         a 0.34 m plate about its own centre, so 0.22 rad alone threw it to
         x = -0.51 and laid it across the near arm; 0.10 keeps it on the
         armature and the centre is set to clear the elbow. */
      g.heater(B.HAND_L, [-m.x(0.300), m.y(1.10), 0.15], [0.32, 0.46, 0.030],
        { rot: 0.10, dome: 0.30 });
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
      buildTool(g, B.HAND_R, [m.x(0.255), m.y(0.80), 0.02], o.tool || 'axe');
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
      /* The spear is the silhouette: nearly two metres of it. */
      buildSpear(g, B.HAND_R, [m.x(0.250), m.y(0.82), 0.04], m.y(2.10));
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
      g.heater(B.HAND_L, [-m.x(0.295), m.y(1.10), 0.14], [0.28, 0.34, 0.026],
        { rot: 0.20, dome: 0.24 });
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
      buildSword(g, B.HAND_R, [m.x(0.252), m.y(0.80), 0.03], m.y(0.36));
      g.material(MAT.WOOD).color(0.50, 0.42, 0.32);
      g.heater(B.HAND_L, [-m.x(0.298), m.y(1.12), 0.15], [0.30, 0.44, 0.028],
        { rot: 0.10, dome: 0.26 });
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
      const rh = [m.x(0.250), m.y(0.80), 0.03];
      buildSword(g, B.HAND_R, rh, m.y(0.38));
      g.material(MAT.WOOD).color(0.44, 0.36, 0.26);
      g.heater(B.HAND_L, [-m.x(0.300), m.y(1.14), 0.15], [0.32, 0.46, 0.030],
        { rot: 0.10, dome: 0.30 });
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
        [m.x(0.118), m.y(1.582)],
        [m.x(0.196), m.y(1.548)],
        [m.x(0.240), m.y(1.500)],
        [m.x(0.232), m.y(1.260)],
        [m.x(0.246), m.y(0.92)],
        [m.x(0.278), m.y(0.52)],
        [m.x(0.294), m.y(0.13)]
      ], { seg: g.seg(0), squash: [1.0, m.cd / m.sw * 1.02] });

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
        g.lathe(UP, [
          [0.000, m.y(1.566)],
          [0.096, m.y(1.520)],
          [0.120, m.y(1.440)],
          [0.100, m.y(1.300)],
          [0.098, m.y(1.040)],
          [0.126, m.y(0.920)]
        ], { seg: g.seg(-1), x: sx, blend: SHO });
        /* the cuff is still an open cylinder -- cap it, the wrist goes in */
        g.cap(UP, [sx * 0.955, m.y(0.920), 0], 0.124 * sl, [0, -1, 0],
          { seg: g.seg(0) });
        /* The robe collar closes to 0.118 at the jaw and the sleeve crown
           starts 0.268 out, so the bare deltoid shows between them as a pale
           notch. Bridge the yoke -- but only where the seam can be seen; half
           a sphere each side is not worth 60 triangles at mid range. */
        if (g.detail === DETAIL.NEAR) {
          g.ellipsoid(SHO, [side * m.x(0.200), m.y(1.474), 0],
            [0.096 * sl, 0.086 * sl, 0.114 * sl], { sph: [4, 2] });
        }
      }

      /* Two fold ridges down the front of the robe. A lathe can only shade
         by its own slope, and a near-vertical profile has almost none, so
         without something breaking the face the front is one flat tone.
         Off-centre and unequal: a symmetric pair reads as armour. */
      for (const [fx, fz, r] of [[-0.085, 0.255, 0.028], [0.115, 0.235, 0.019]]) {
        g.tube(B.SKIRT, [m.x(fx), m.y(1.16), fz * m.cd / m.sw],
          [m.x(fx * 1.30), m.y(0.24), fz * m.cd / m.sw * 1.25], r, r * 0.85,
          { seg: 4, rings: 1 });
      }

      buildBelt(g, m);
      /* planted on the ground beside the hem, not hanging past it */
      /* Outside the robe's 0.25 radius at hip height, and inside the cuff's
         0.124 mouth, so the sleeve reads as gripping it. */
      buildStaff(g, B.HAND_R, [m.x(0.320), m.y(0.85), 0.0, m.y(0.03), B.SKIRT]);
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
      buildSword(g, B.HAND_R, [m.x(0.252), m.y(0.80), 0.03], m.y(0.32));
      /* round shield: a shallow disc, not a heater */
      g.material(MAT.WOOD).color(0.52, 0.42, 0.30);
      g.ellipsoid(B.HAND_L, [-m.x(0.285), m.y(1.06), 0.14],
        [0.30, 0.30, 0.045], { sph: [7, 3] });
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
      /* The wide neck guard: a shallow cone flaring off the shoulders. */
      g.material(MAT.PLATE).color(0.46, 0.30, 0.24);
      g.lathe(B.CHEST, [
        [m.x(0.150), m.y(1.50)],
        [m.x(0.300), m.y(1.40)],
        [m.x(0.320), m.y(1.34)]
      ], { seg: g.seg(0) });
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
      g.heater(B.HAND_L, [-m.x(0.300), m.y(1.14), 0.15], [0.30, 0.46, 0.030],
        { rot: 0.10, dome: 0.28 });
      buildSword(g, B.HAND_R, [m.x(0.250), m.y(0.80), 0.03], m.y(0.36));
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
      buildSurcoat(g, m);
      buildBelt(g, m);
      buildSword(g, B.HAND_R, [m.x(0.250), m.y(0.80), 0.03], m.y(0.38));
      g.material(MAT.WOOD).color(0.50, 0.42, 0.28);
      g.heater(B.HAND_L, [-m.x(0.300), m.y(1.14), 0.15], [0.32, 0.48, 0.030],
        { rot: 0.10, dome: 0.30 });
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
      g.heater(B.HAND_L, [-m.x(0.300), m.y(1.14), 0.15], [0.33, 0.47, 0.032],
        { rot: 0.10, dome: 0.32 });
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
