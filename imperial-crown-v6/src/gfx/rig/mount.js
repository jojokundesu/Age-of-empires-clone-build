/* ============================================================
   mount.js — the horse

   A ridden horse is one body, a neck, a head, a tail and four legs.
   That is exactly the eight bones the palette has left after the
   humanoid block, and it is deliberately not more: at the distance a
   cavalry unit is ever read, a fetlock is two pixels and the line of
   the back is the whole silhouette.

   Everything here is authored in the same bind space as the rider --
   feet at y = 0, facing +Z -- so the two meshes compose without a
   transform. The rider is lifted onto the saddle by Pose.seat, which
   is applied to its pelvis only; the mount is not moved.

   THREE RULES THAT THIS FILE EXISTS TO SATISFY
   --------------------------------------------
   1. Every limb is continuous. A horse built from "upper leg" and
      "lower leg" tubes that merely touch at the knee shows a ring of
      background straight through the joint at any angle, because the
      two tapered cones meet at different radii. Segments overlap.

   2. A swinging bone's geometry starts AT its pivot. The palette
      rotates a bone about its own rest origin, so a vertex sitting on
      that origin does not move at all. Put the top cap of the thigh
      exactly on the hip bone's origin and the leg can swing as far as
      it likes without its top edge tearing out of the barrel. Put the
      cap anywhere else and the animal comes apart mid-gallop.

   3. Proportions come from LANDMARKS, one table, in metres. Scattering
      magic numbers through the builders is how the first version of
      this ended up with the head level with the withers.
   ============================================================ */

import { B } from './skeleton.js';
import { MAT } from './wardrobe.js';

/* ------------------------------------------------------------------
   Landmarks for the standard destrier, in metres, feet at y = 0.
   A profile scales these as a block; nothing else in the file moves.
   ------------------------------------------------------------------ */
export const LANDMARKS = {
  hoof: 0.00,
  kneeF: 0.58,          // front knee (carpus)
  kneeH: 0.62,          // hind hock
  /* The belly line is the number that decides whether the animal reads as a
     horse. A 1.6 m horse stands about 0.85 m at the belly, so the barrel is
     roughly 0.6 m deep and the legs are roughly 0.9 m -- near half and half.
     An earlier pass put the belly at 1.02, which left a 0.48 m barrel on
     1.02 m legs and the horse stood there on stilts. */
  belly: 0.80,
  back: 1.46,           // top of the barrel at the loin
  withers: 1.58,
  hipY: 1.28,           // hip pivots: INSIDE the barrel, see rule 2
  chestZ: 0.62,
  rumpZ: -0.82,
  hipFZ: 0.46,
  hipHZ: -0.56,
  hipX: 0.205,
  girthR: 0.270,        // barrel radius at the girth (~0.54 m across)
  neckBaseY: 1.42,
  neckBaseZ: 0.52,
  pollY: 1.82,          // top of the head
  pollZ: 0.94,
  muzzleY: 1.52,
  muzzleZ: 1.24,
  tailY: 1.34,
  tailZ: -0.84
};

/* Where the saddle sits, for a given mount profile. The rider's pelvis rest
   is y = 0.95 and Pose.seat lifts it, so the lift is however far the saddle
   is above that. This has to be derived rather than fixed: `RIDE_SEAT` was a
   constant 0.50 while the pony is 0.88 of the standard height, so a scout on
   his pony floated 6 cm above the saddle. */
export function mountSeatHeight(profile) {
  const h = (profile && profile.height) || 1;
  return LANDMARKS.back * h + 0.09;
}

export const MOUNT_STANDARD = {
  height: 1.00,   // scales every Y landmark
  length: 1.00,   // scales every Z landmark
  limbW: 1.00     // leg, neck and barrel thickness
};
/* A scout's pony: short, light, quick. */
export const MOUNT_PONY = { height: 0.88, length: 0.90, limbW: 0.92 };

/**
 * Build the horse.
 *
 * @param g    SkinnedBuilder
 * @param coat [r,g,b] body colour
 * @param opts { mane:[r,g,b], caparison:[r,g,b]|null, barding:bool }
 */
export function buildMount(g, coat, opts = {}) {
  const mane = opts.mane || [0.14, 0.11, 0.08];
  const caparison = opts.caparison || null;
  const barding = !!opts.barding;

  /* RULE 3, actually applied.
     `MOUNT_STANDARD` and `MOUNT_PONY` have been declared since the mount
     existed and were never read: rigs.js tested `prop.mount` for truthiness
     and then built the same destrier for everybody, so the scout's pony was
     a full-size warhorse with a shorter rider on it. Scaling the landmark
     block here is the whole reason the block is one table -- every
     coordinate in this file comes from L, so this is the only line needed. */
  const prof = opts.mount || MOUNT_STANDARD;
  const L = {};
  for (const k of Object.keys(LANDMARKS)) {
    /* Z landmarks grow with `length`, Y with `height`; the radius is a limb
       dimension and takes the mean of the two, which keeps the barrel round
       instead of oval when a profile is stretched on one axis. */
    const isY = /Y$|^hoof$|^belly$|^back$|^withers$/.test(k);
    const isR = /R$/.test(k) || k === 'hipX';
    L[k] = isR
      ? LANDMARKS[k] * (prof.limbW ?? 1)
      : LANDMARKS[k] * (isY ? (prof.height ?? 1) : (prof.length ?? 1));
  }
  const limbW = prof.limbW ?? 1;
  const body = B.HORSE_BODY;
  const neck = B.HORSE_NECK;
  const head = B.HORSE_HEAD;
  const tail = B.HORSE_TAIL;

  const coatDark = [coat[0] * 0.90, coat[1] * 0.90, coat[2] * 0.90];
  const hoofCol = [0.17, 0.15, 0.14];

  /* ---------------- barrel ----------------
     A barrel is deepest at the girth and narrows both ways, so it is four
     overlapping tubes rather than one lathe: a circular section reads as a
     sausage from the front, and a horse is a wedge. */
  g.material(MAT.HAIR).color(coat[0], coat[1], coat[2]);
  const R = L.girthR;

  /* chest -> girth */
  /* The barrel is TWO tubes with one ring of curvature each at near and
     none below it. A horse's barrel is a smooth ellipsoid; the rings were
     sampling a smooth curve with straight chords, at 8 and 6 segments, on a
     thing that is a fifth of the screen at the closest the camera ever
     gets to a horse. */
  /* One ring. A horse's barrel is close to a straight taper over the
     0.6 m between the withers and the loin, and the second ring was
     sampling curvature the two end rings already describe. */
  const barrelRings = 1;
  g.tube(body, [0, L.withers - 0.12, L.chestZ], [0, (L.back + L.belly) / 2 + 0.04, 0.04],
    R * 0.74, R, { seg: g.seg(0), rings: barrelRings, squash: [1.0, 0.90] });
  /* girth -> loin */
  g.tube(body, [0, (L.back + L.belly) / 2 + 0.04, 0.04], [0, L.back - 0.16, L.rumpZ + 0.22],
    R, R * 0.82, { seg: g.seg(0), rings: 1, squash: [1.0, 0.92] });
  /* croup: the rump, rounded and a touch higher than the loin */
  g.ellipsoid(body, [0, L.back - 0.14, L.rumpZ + 0.08], [R * 0.80, R * 0.78, 0.20],
    { sph: [g.sph()[0], g.detail === 0 ? 4 : 3] });
  /* breast: gives the front of the animal a chest instead of a cut tube.
     Gated at far tier -- the barrel's own front cap covers it there. */
  if (g.detail !== 2) {
    g.ellipsoid(body, [0, L.withers - 0.20, L.chestZ - 0.02], [R * 0.70, R * 0.86, 0.18],
      { sph: [5, 3] });
  }
  /* withers: the ridge the saddle sits behind */
  g.tube(body, [0, L.withers - 0.10, L.chestZ - 0.18], [0, L.withers, 0.06],
    R * 0.62, R * 0.70, { seg: g.seg(-3), rings: 1, squash: [1.25, 0.62] });

  /* ---------------- neck ----------------
     Long, and it must LEAVE the withers at a steep angle then flatten
     toward the poll. The first version ran almost straight out from the
     chest and the head ended up level with the saddle.

     Two overlapping segments, tapering, on the neck bone. */
  g.material(MAT.HAIR).color(coat[0] * 0.97, coat[1] * 0.97, coat[2] * 0.97);
  const nMidY = (L.neckBaseY + L.pollY) / 2 - 0.02;
  const nMidZ = (L.neckBaseZ + L.pollZ) / 2 - 0.08;
  /* lower neck: thick at the shoulder */
  g.tube(neck, [0, L.withers - 0.26, L.neckBaseZ - 0.10], [0, nMidY, nMidZ],
    R * 0.66, R * 0.46, { seg: g.seg(-1), rings: 2, squash: [0.80, 1.30] });
  /* upper neck into the poll */
  g.tube(neck, [0, nMidY - 0.04, nMidZ - 0.02], [0, L.pollY - 0.06, L.pollZ],
    R * 0.50, R * 0.34, { seg: g.seg(-1), rings: 1, squash: [0.78, 1.20] });

  /* ---------------- head ----------------
     A long wedge with a jaw. The muzzle stays blunt: a rounded tip at this
     poly budget reads as a dog. */
  g.material(MAT.HAIR).color(coat[0], coat[1], coat[2]);
  /* ONE continuous run from the poll to the nose.
     This used to be a tube stopping at L.muzzleZ - 0.06 plus an ellipsoid
     centred at L.muzzleZ, and the two did not meet: the nose hung in front of
     a chopped-off snout like a meatball on a wire. A horse's head IS a
     single tapered surface from the poll over the forehead, down the nasal
     bridge, to the muzzle -- so build it as one, with the rings placed along
     that curve and the radii narrowing as it goes. `rings` is raised because
     four rings cannot describe a curve. */
  g.tube(head,
    [0, L.pollY - 0.08, L.pollZ - 0.02],
    [0, L.muzzleY, L.muzzleZ],
    R * 0.36, R * 0.24,
    { seg: 5, rings: g.detail === 0 ? 3 : 2, squash: [0.78, 1.05] });
  /* The nose itself: a blunt pad covering the END of that tube, not a ball
     floating past it. It is centred back inside the tube's last ring. */
  g.ellipsoid(head, [0, L.muzzleY - 0.01, L.muzzleZ - R * 0.10],
    [R * 0.245, R * 0.215, R * 0.20], { sph: [4, 2] });
  /* jaw, set back under the cheek */
  g.ellipsoid(head, [0, L.muzzleY + 0.20, L.muzzleZ - 0.26], [R * 0.30, R * 0.27, R * 0.30],
    { sph: [4, 3] });
  /* ears, two small cones raked back off the poll */
  for (const sx of [-1, 1]) {
    g.tube(head, [sx * R * 0.16, L.pollY + 0.02, L.pollZ - 0.10],
      [sx * R * 0.22, L.pollY + 0.14, L.pollZ - 0.17], 0.030, 0.006,
      { seg: 4, rings: 1 });
  }
  /* mane: a flat crest down the neck, offset slightly so it does not fight
     the silhouette head-on */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  /* The mane is the crest of the neck made visible: a thick slab of hair
     standing proud of the spine, not a 2 cm fin. At 0.075 it was narrower
     than the ears and disappeared from every angle but dead abeam; a
     destrier's mane is a hand's breadth of dark hair and it is one of the
     two things that separates a horse from a donkey at gameplay distance. */
  g.tube(neck, [R * 0.10, L.withers - 0.20, L.neckBaseZ - 0.04],
    [R * 0.07, L.pollY + 0.02, L.pollZ - 0.04], 0.088, 0.050,
    { seg: g.seg(-1), rings: g.detail === 0 ? 2 : 1, squash: [0.34, 1.0] });

  /* ---------------- tail ----------------
     One bone. Leaves the rump high and hangs behind. */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  g.tube(tail, [0, L.tailY, L.tailZ], [0, L.tailY - 0.52, L.tailZ - 0.20],
    0.062, 0.024, { seg: g.seg(-2), rings: 1 });

  /* ---------------- legs ----------------
     Rule 1 and rule 2 together: each leg is ONE continuous tapered form
     built on its own bone, and its top cap sits exactly on the bone's
     origin so a swing cannot tear it free of the barrel.

     Front legs are straighter and carry the neck; hind legs angle forward
     at the hock. Four identical straight legs is what makes a horse read
     as a table. */
  const legs = [
    /* bone,       x,           hipY,       hipZ,      kneeY,     footZ,     topR,        kneeR */
    /* topR/kneeR were 0.66/0.30 of the barrel radius, which is a 89 mm
       forearm on a 540 mm barrel -- deer's legs under a cow's body. A
       destrier's forearm is nearer 0.9 and the cannon 0.45. */
    /* kneeR is the CANNON radius, and 0.44 R was a 119 mm cannon on an
       180 mm forearm: the lower leg was nearly as thick as the upper, which
       is what made the horse look like it was standing on four posts. A real
       cannon is a third of the forearm, and rule 5 asks for R * 0.26. */
    [B.HORSE_FL, -L.hipX, L.hipY, L.hipFZ, L.kneeF, 0.46, R * 0.90, R * 0.30],
    [B.HORSE_FR, L.hipX, L.hipY, L.hipFZ, L.kneeF, 0.46, R * 0.90, R * 0.30],
    [B.HORSE_HL, -L.hipX * 1.04, L.hipY - 0.02, L.hipHZ, L.kneeH, -0.56, R * 1.04, R * 0.34],
    [B.HORSE_HR, L.hipX * 1.04, L.hipY - 0.02, L.hipHZ, L.kneeH, -0.56, R * 1.04, R * 0.34]
  ];
  /* The haunch is BODY, not leg. On a horse the mass above the knee is
     shoulder and rump: it does not swing, it is part of the barrel. Building
     it as the top of the leg makes a triangular sail that pivots, which is
     what the previous pass looked like. So the mass goes here, on the body,
     and the leg below is a column. */
  /* Skipped at far tier: below ~700 tris a horse is four lines and a back,
     and the haunch mass costs 120 of them for something nobody can see. */
  if (g.detail !== 2) {
    /* Four spheres at 40 triangles each is a tenth of the horse. The haunch
       is a bulge where the leg meets the barrel, and the barrel already
       swells there: two rings of a four-segment sphere is plenty, and the
       hind pair -- which the tail and the cantle cover -- is dropped. */
    for (const [bone, x, hipY, hipZ, kneeY, , topR] of legs) {
      if (bone === B.HORSE_HL || bone === B.HORSE_HR) continue;
      /* A caparisoned horse's haunch is under 16 mm of cloth: the bulge is
         not on the silhouette at all, and the panel would z-fight it. */
      if (caparison) continue;
      g.material(MAT.HAIR).color(coatDark[0], coatDark[1], coatDark[2]);
      g.ellipsoid(body, [x * 0.92, (hipY + kneeY) / 2 + 0.10, hipZ * 0.94],
        [topR * 1.02, Math.abs(hipY - kneeY) * 0.52, topR * 1.20],
        { sph: g.detail === 0 ? [4, 3] : [4, 2] });
    }
  }

  for (const [bone, x, hipY, hipZ, kneeY, footZ, topR, kneeR] of legs) {
    const kneeZ = hipZ * 0.35 + footZ * 0.65;
    g.material(MAT.HAIR).color(coatDark[0], coatDark[1], coatDark[2]);
    /* forearm / gaskin: a column from the hip to the knee, barely tapering.
       The top cap sits on the bone origin, inside the barrel, so the swing
       cannot tear it free (rule 2). */
    g.tube(bone, [x, hipY, hipZ], [x, kneeY - 0.03, kneeZ], topR, kneeR * 1.15,
      { seg: 6, rings: 1, squash: [1.0, 0.92] });
    /* knee / hock knob */
    g.tube(bone, [x, kneeY + 0.06, kneeZ + 0.01], [x, kneeY - 0.06, kneeZ],
      kneeR * 1.24, kneeR * 1.10,
      { seg: g.detail === 0 ? g.seg(-1) : g.seg(-2), rings: 1 });
    /* THE CANNON AND THE FETLOCK.
       A cannon is a thin column that runs almost plumb to just above the
       ground, then the fetlock JOINT kicks the hoof forward and the pastern
       slopes down into it. Running one cone from the knee to the hoof made a
       post: the leg met the floor at a right angle, which no horse's leg
       does, and at 1.12 of the knee radius the cannon was as thick as the
       joint above it. Taper hard, then angle. */
    const cannonTopR = kneeR * 1.06;
    const cannonR = R * 0.26;
    const fetY = L.hoof + 0.15;
    const fetZ = footZ - 0.02;
    g.tube(bone, [x, kneeY + 0.01, kneeZ + 0.01], [x, fetY, fetZ],
      cannonTopR, cannonR, { seg: g.seg(-1), rings: 2 });
    /* fetlock knob, then the pastern raked forward into the hoof */
    g.tube(bone, [x, fetY + 0.035, fetZ], [x, fetY - 0.020, fetZ + 0.010],
      cannonR * 1.34, cannonR * 1.14, { seg: g.seg(-2), rings: 1 });
    g.material(MAT.LEATHER).color(hoofCol[0], hoofCol[1], hoofCol[2]);
    g.tube(bone, [x, fetY - 0.010, fetZ + 0.010], [x, L.hoof + 0.012, footZ + 0.055],
      cannonR * 1.10, cannonR * 1.22, { seg: g.seg(-2), rings: 1 });
    /* hoof: wider and darker than the pastern, flat on the ground */
    g.tube(bone, [x, L.hoof + 0.055, footZ + 0.045], [x, L.hoof, footZ + 0.065],
      cannonR * 1.34, cannonR * 1.46,
      { seg: g.detail === 0 ? g.seg(-2) : g.seg(-3), rings: 1 });
  }

  /* ---------------- saddle ----------------
     Always present: a ridden horse without one reads as a bareback rider
     about to slide off. Sits in the dip behind the withers. */
  const seatY = L.back - 0.02;
  g.material(MAT.LEATHER).color(0.34, 0.22, 0.14);
  g.tube(body, [0, seatY, 0.22], [0, seatY + 0.01, -0.20], R * 0.80, R * 0.82,
    { seg: g.detail === 0 ? g.seg(-1) : 5, rings: 1, squash: [1.0, 0.42] });
  if (caparison) {
    /* A DRAPED TRAPPER, not a blanket.
       The old caparison was one short tube across the saddle: a pad. What
       makes a medieval warhorse unmistakable at gameplay distance is cloth
       hanging over both flanks from under the saddle to knee height,
       framing the animal in the player's colour. It is built with `loft`,
       because a trapper is the one shape in this file that is genuinely not
       a surface of revolution: its section climbs the spine, rolls over the
       top of the barrel, drops past the flank and then falls STRAIGHT to the
       hem. Every attempt with lathe/tube/skirt turned the hem back in under
       the belly, because a circle returns. */
    const midY = (L.back + L.belly) / 2;
    const hemY = L.kneeF + 0.02;         /* knee height, as specified */
    const topY = L.back - 0.06;
    const wallX = R * 1.06;              /* the cloth stands 16 mm off the ribs */
    const SPINE = R * 0.34;              /* half-width of the spine ridge */

    /* The section: five points. Spine centre, over the shoulder of the
       barrel, out to the wall, and down. rV is folded into the authored
       points, so the hem depth is stated directly rather than derived. */
    const section = (z, k) => {
      /* k < 1 tucks the panel under the saddle at the front and the cantle
         at the back, where the cloth disappears under the leather. */
      const wx = wallX * k;
      const ty = (midY + 0.30) * k + topY * (1 - k);
      const hy = hemY;
      return [
        [0, ty],
        [SPINE * k, ty + (topY - ty) * 0.1],
        [wx * 0.86, ty - 0.03],
        [wx, (ty + hy) * 0.5],
        [wx * 1.01, hy]
      ];
    };
    /* one panel per flank, mirrored in X */
    for (const side of [1, -1]) {
      const rings = [
        { z: 0.30, k: 0.55 },
        { z: 0.10, k: 0.95 },
        { z: -0.24, k: 1.00 },
        { z: -0.46, k: 0.96 }
      ];
      const flip = (pts) => pts.map(([x, y]) => [x * side, y]);
      g.material(MAT.LINEN).color(caparison[0], caparison[1], caparison[2]);
      g.loft(body, rings.map((r) => {
        const p = flip(section(r.z, r.k));
        /* the fold: a slow ripple along Z in the wall, so the hem is not a
           machined edge. Only at near tier -- at mid it reads as a wobble. */
        if (g.detail === 0) {
          const t = (r.z + 0.46) / 0.76;
          p[3][0] *= 1 + 0.020 * Math.cos(t * 12);
          p[4][0] *= 1 + 0.026 * Math.cos(t * 12);
        }
        return { z: r.z, pts: p };
      }), {});

      /* THE HERALDIC BORDER: an undyed band along the hem, the same trick
         the tunic hem and the shield rim use. It is the panel's OWN section,
         cut down to the bottom of the wall and grown 5 mm absolute, lofted
         over the same span of Z -- so its winding, its normal direction and
         its curvature are the panel's by construction. Writing the strip out
         by hand got the mirrored side's normals backwards and the band was
         culled on the far flank. */
      if (g.detail === 0) {
      g.material(MAT.TRIM).color(0.93, 0.91, 0.84);
      const bandPts = (z, k) => {
        const p = flip(section(z, k));
        const gx = (v) => v * 1.0 + Math.sign(v) * 0.014;
        return [
          [gx(p[3][0]), p[3][1]],
          [gx(p[4][0]), p[4][1]],
          [gx(p[4][0] * 0.99), hemY + 0.13]
        ];
      };
      g.loft(body, [
        { z: -0.28, pts: bandPts(-0.28, 0.99) },
        { z: -0.46, pts: bandPts(-0.46, 0.96) }
      ], {});
      }
    }
  }

  /* ---------------- barding ----------------
     Plate that follows the form it covers, and nothing that does not.

     This block has now failed four times in the same way: a plate built on
     its own axis while the form underneath curves in another direction.
     A tube along the breast stands off the flanks as a flat card; an
     ellipsoid big enough to wrap the breast dips below the barrel as a
     detached slab. The rule that actually holds is that every plate is
     CONCENTRIC with the piece under it and inflated by about 20 mm, and
     where the form is not a body of revolution there is no plate at all.

       chamfron  concentric with the head's own wedge
       peytral   concentric with the breast ellipsoid, plus a drop under it

     A crinet and a pair of flanchards were built and removed. Both are
     plates over forms that are not bodies of revolution -- a raked neck and
     a barrel with a saddle on it -- and both rendered as sheets of paper
     hung on the side of the animal. The caparison already covers the barrel
     and the flanks, which is what a cataphract's horse actually wears over
     its armour, so the plate that remains is the plate that can be built
     correctly.
     */
  if (barding) {
    g.material(MAT.PLATE).color(0.50, 0.52, 0.56);

    /* Chamfron: the head's own wedge, inflated by 20 mm, spanning the same
       two endpoints -- and NOTHING else, because a plate over the horse's
       face is the one piece of barding that is unmistakable at gameplay
       distance. The crinet and the flanchards are gone: both covered forms
       that are not bodies of revolution (a raked neck, a barrel with a
       saddle on it) and both rendered as sheets of paper hung on the side
       of the animal. The caparison already covers the barrel and flanks,
       which is what a cataphract's horse actually wears.
       The muzzle end is cut where the nose is, not extended past it: at
       muzzleZ - 0.10 the plate hung 100 mm off the end of the head and read
       as a mask floating in front of the horse. */
    g.tube(head, [0, L.pollY - 0.06, L.pollZ - 0.01], [0, L.muzzleY + 0.14, L.muzzleZ - 0.20],
      R * 0.36 + 0.018, R * 0.25 + 0.018,
      { seg: 5, rings: g.detail === 0 ? 2 : 1 });

    /* peytral: the breast, concentric, 20 mm up. */
    g.ellipsoid(body, [0, L.withers - 0.20, L.chestZ - 0.02],
      [R * 0.70 + 0.020, R * 0.86 + 0.020, 0.18 + 0.020], { sph: [5, 3] });
    /* and its lower edge, a smaller shell of the same family */
    g.ellipsoid(body, [0, L.withers - 0.44, L.chestZ - 0.22],
      [R * 0.52, 0.09, 0.11], { sph: [4, 2] });
  }

  return { body, neck, head };
}
