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
  belly: 0.88,
  back: 1.46,           // top of the barrel at the loin
  withers: 1.58,
  hipY: 1.28,           // hip pivots: INSIDE the barrel, see rule 2
  chestZ: 0.54,
  rumpZ: -0.70,
  hipFZ: 0.40,
  hipHZ: -0.48,
  hipX: 0.205,
  girthR: 0.270,        // barrel radius at the girth (~0.54 m across)
  neckBaseY: 1.42,
  neckBaseZ: 0.46,
  pollY: 1.82,          // top of the head
  pollZ: 0.86,
  muzzleY: 1.52,
  muzzleZ: 1.16,
  tailY: 1.34,
  tailZ: -0.72
};

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

  const L = LANDMARKS;
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
  g.tube(body, [0, L.withers - 0.12, L.chestZ], [0, (L.back + L.belly) / 2 + 0.04, 0.04],
    R * 0.74, R, { seg: 6, rings: 2, squash: [1.0, 0.90] });
  /* girth -> loin */
  g.tube(body, [0, (L.back + L.belly) / 2 + 0.04, 0.04], [0, L.back - 0.16, L.rumpZ + 0.22],
    R, R * 0.82, { seg: 6, rings: 2, squash: [1.0, 0.92] });
  /* croup: the rump, rounded and a touch higher than the loin */
  g.ellipsoid(body, [0, L.back - 0.14, L.rumpZ + 0.08], [R * 0.80, R * 0.78, 0.20],
    { sph: [7, 5] });
  /* breast: gives the front of the animal a chest instead of a cut tube.
     Gated at far tier -- the barrel's own front cap covers it there. */
  if (g.detail !== 2) {
    g.ellipsoid(body, [0, L.withers - 0.20, L.chestZ - 0.02], [R * 0.70, R * 0.86, 0.18],
      { sph: [6, 4] });
  }
  /* withers: the ridge the saddle sits behind */
  g.tube(body, [0, L.withers - 0.10, L.chestZ - 0.18], [0, L.withers, 0.06],
    R * 0.62, R * 0.70, { seg: 6, rings: 1, squash: [1.25, 0.62] });

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
    R * 0.66, R * 0.46, { seg: 5, rings: 2, squash: [0.80, 1.30] });
  /* upper neck into the poll */
  g.tube(neck, [0, nMidY - 0.04, nMidZ - 0.02], [0, L.pollY - 0.06, L.pollZ],
    R * 0.50, R * 0.34, { seg: 6, rings: 1, squash: [0.78, 1.20] });

  /* ---------------- head ----------------
     A long wedge with a jaw. The muzzle stays blunt: a rounded tip at this
     poly budget reads as a dog. */
  g.material(MAT.HAIR).color(coat[0], coat[1], coat[2]);
  g.tube(head, [0, L.pollY - 0.08, L.pollZ - 0.02], [0, L.muzzleY + 0.06, L.muzzleZ - 0.06],
    R * 0.36, R * 0.24, { seg: 5, rings: 1, squash: [0.78, 1.05] });
  /* muzzle */
  g.ellipsoid(head, [0, L.muzzleY, L.muzzleZ], [R * 0.26, R * 0.23, R * 0.22],
    { sph: [5, 4] });
  /* jaw, set back under the cheek */
  g.ellipsoid(head, [0, L.muzzleY + 0.20, L.muzzleZ - 0.26], [R * 0.30, R * 0.27, R * 0.30],
    { sph: [5, 4] });
  /* ears, two small cones raked back off the poll */
  for (const sx of [-1, 1]) {
    g.tube(head, [sx * R * 0.16, L.pollY + 0.02, L.pollZ - 0.10],
      [sx * R * 0.22, L.pollY + 0.14, L.pollZ - 0.17], 0.030, 0.006,
      { seg: 4, rings: 1 });
  }
  /* mane: a flat crest down the neck, offset slightly so it does not fight
     the silhouette head-on */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  g.tube(neck, [R * 0.13, L.withers - 0.16, L.neckBaseZ - 0.06],
    [R * 0.10, L.pollY - 0.04, L.pollZ - 0.06], 0.075, 0.036,
    { seg: 4, rings: 1, squash: [0.30, 1.0] });

  /* ---------------- tail ----------------
     One bone. Leaves the rump high and hangs behind. */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  g.tube(tail, [0, L.tailY, L.tailZ], [0, L.tailY - 0.52, L.tailZ - 0.20],
    0.062, 0.024, { seg: 5, rings: 1 });

  /* ---------------- legs ----------------
     Rule 1 and rule 2 together: each leg is ONE continuous tapered form
     built on its own bone, and its top cap sits exactly on the bone's
     origin so a swing cannot tear it free of the barrel.

     Front legs are straighter and carry the neck; hind legs angle forward
     at the hock. Four identical straight legs is what makes a horse read
     as a table. */
  const legs = [
    /* bone,       x,           hipY,       hipZ,      kneeY,     footZ,     topR,        kneeR */
    [B.HORSE_FL, -L.hipX, L.hipY, L.hipFZ, L.kneeF, 0.46, R * 0.66, R * 0.30],
    [B.HORSE_FR, L.hipX, L.hipY, L.hipFZ, L.kneeF, 0.46, R * 0.66, R * 0.30],
    [B.HORSE_HL, -L.hipX * 1.04, L.hipY - 0.02, L.hipHZ, L.kneeH, -0.52, R * 0.78, R * 0.34],
    [B.HORSE_HR, L.hipX * 1.04, L.hipY - 0.02, L.hipHZ, L.kneeH, -0.52, R * 0.78, R * 0.34]
  ];
  /* The haunch is BODY, not leg. On a horse the mass above the knee is
     shoulder and rump: it does not swing, it is part of the barrel. Building
     it as the top of the leg makes a triangular sail that pivots, which is
     what the previous pass looked like. So the mass goes here, on the body,
     and the leg below is a column. */
  /* Skipped at far tier: below ~700 tris a horse is four lines and a back,
     and the haunch mass costs 120 of them for something nobody can see. */
  if (g.detail !== 2) {
    for (const [, x, hipY, hipZ, kneeY, , topR] of legs) {
      g.material(MAT.HAIR).color(coatDark[0], coatDark[1], coatDark[2]);
      g.ellipsoid(body, [x * 0.92, (hipY + kneeY) / 2 + 0.10, hipZ * 0.94],
        [topR * 1.02, Math.abs(hipY - kneeY) * 0.52, topR * 1.20], { sph: [5, 4] });
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
      kneeR * 1.24, kneeR * 1.10, { seg: 6, rings: 1 });
    /* cannon: overlaps the joint, near-constant width */
    g.tube(bone, [x, kneeY + 0.01, kneeZ + 0.01], [x, L.hoof + 0.11, footZ],
      kneeR * 1.12, kneeR * 0.86, { seg: 6, rings: 1 });
    /* hoof */
    g.material(MAT.LEATHER).color(hoofCol[0], hoofCol[1], hoofCol[2]);
    g.tube(bone, [x, L.hoof + 0.13, footZ], [x, L.hoof, footZ + 0.02],
      kneeR * 0.92, kneeR * 0.86, { seg: 5, rings: 1 });
  }

  /* ---------------- saddle ----------------
     Always present: a ridden horse without one reads as a bareback rider
     about to slide off. Sits in the dip behind the withers. */
  const seatY = L.back - 0.02;
  g.material(MAT.LEATHER).color(0.34, 0.22, 0.14);
  g.tube(body, [0, seatY, 0.22], [0, seatY + 0.01, -0.20], R * 0.80, R * 0.82,
    { seg: 6, rings: 1, squash: [1.0, 0.42] });
  if (caparison) {
    g.material(MAT.LINEN).color(caparison[0], caparison[1], caparison[2]);
    g.tube(body, [0, seatY - 0.06, 0.28], [0, seatY - 0.06, -0.30], R * 0.92, R * 0.92,
      { seg: 6, rings: 1, squash: [1.0, 0.52] });
  }

  /* ---------------- barding ----------------
     Plate that follows the form it covers. The first version put these on
     fixed coordinates and they floated clear of the animal.
       chamfron  over the face
       peytral   across the chest
       crinet    three plates down the neck, each overlapping the last */
  if (barding) {
    g.material(MAT.PLATE).color(0.54, 0.56, 0.60);
    /* Every plate is built from the SAME landmark as the form it covers and
       is slightly LARGER than it. The first version gave the plates their own
       coordinates and they floated clear of the animal; a plate has to be the
       thing underneath, inflated by a centimetre. */

    /* chamfron: the head wedge, inflated */
    g.tube(head, [0, L.pollY - 0.06, L.pollZ - 0.02], [0, L.muzzleY + 0.18, L.muzzleZ - 0.12],
      R * 0.40, R * 0.27, { seg: 5, rings: 1, squash: [0.86, 1.05] });

    /* crinet: three overlapping bands following the neck's own lean */
    for (let i = 0; i < 3; i++) {
      const t0 = i / 3, t1 = Math.min(1, (i + 1) / 3 + 0.14);   // +0.14 overlap
      const y0 = (L.withers - 0.20) + (L.pollY - L.withers) * t0;
      const z0 = (L.neckBaseZ - 0.10) + (L.pollZ - L.neckBaseZ) * t0;
      const y1 = (L.withers - 0.20) + (L.pollY - L.withers) * t1;
      const z1 = (L.neckBaseZ - 0.10) + (L.pollZ - L.neckBaseZ) * t1;
      g.tube(neck, [0, y0, z0], [0, y1, z1],
        R * (0.62 - t0 * 0.16), R * (0.62 - t1 * 0.16),
        { seg: 5, rings: 1, squash: [0.84, 1.22] });
    }

    /* peytral: the breast, inflated. Built on the BODY from the same points
       the breast ellipsoid uses, so it sits on the animal instead of beside
       it -- this is the plate that was hanging off the near flank. */
    g.tube(body, [0, L.withers - 0.22, L.chestZ + 0.04], [0, L.belly + 0.10, L.chestZ - 0.04],
      R * 0.78, R * 0.66, { seg: 6, rings: 1, squash: [1.0, 0.64] });
  }

  return { body, neck, head };
}
