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

   The barrel is a cage of tubes rather than one lathe because a lathe
   is circular and a horse is a wedge: deepest at the girth, narrow at
   the withers, and tapering to a chest that a spear can glance off.
   ============================================================ */

import { B } from './skeleton.js';
import { MAT } from './wardrobe.js';

/* Sizing. The rider's profile does not scale these -- see buildPalette. */
export const MOUNT_STANDARD = {
  height: 1.00,   // withers height, metres
  length: 1.00,   // barrel length
  limbW: 1.00     // leg and neck thickness
};
/* A scout's pony: short, light, quick. */
export const MOUNT_PONY = {
  height: 0.86, length: 0.88, limbW: 0.90
};

/**
 * Build the horse.
 *
 * @param g    SkinnedBuilder
 * @param coat [r,g,b] body colour
 * @param opts { mane:[r,g,b], caparison:[r,g,b]|null, caparisonMat, barding:bool }
 */
export function buildMount(g, coat, opts = {}) {
  const mane = opts.mane || [0.14, 0.11, 0.08];
  const caparison = opts.caparison || null;
  const barding = !!opts.barding;

  const body = B.HORSE_BODY;
  const neck = B.HORSE_NECK;
  const head = B.HORSE_HEAD;
  const tail = B.HORSE_TAIL;

  /* ---------------- barrel ----------------
     The barrel is the whole read of a horse, so it is built from three
     tapered segments with a real girth: deepest under the saddle, narrowing
     to chest and croup. The chest is a separate wedge so the animal has a
     front to it rather than ending in a tube mouth.

     Numbers are chosen against a 1.6 m withers. A destrier of that height
     is ~2.3 m nose to tail and its barrel is ~0.55 m across the ribs; the
     rider's thigh then sits on the flank instead of disappearing into it. */
  const chestZ = 0.46, croupZ = -0.50;
  const girthR = 0.30;

  g.material(MAT.HAIR).color(coat[0], coat[1], coat[2]);
  /* chest -> girth: widening back to the ribs */
  g.tube(body, [0, 1.22, chestZ], [0, 1.16, 0.06], 0.215, girthR,
    { seg: 6, rings: 2, squash: [1.0, 0.88] });
  /* girth -> croup: the loin, narrower and a touch higher */
  g.tube(body, [0, 1.16, 0.06], [0, 1.20, croupZ], girthR, 0.235,
    { seg: 6, rings: 2, squash: [1.0, 0.90] });

  /* shoulder mass, rising to the withers where the saddle sits */
  g.tube(body, [0, 1.30, 0.26], [0, 1.36, 0.02], 0.20, 0.235,
    { seg: 6, rings: 1, squash: [1.20, 0.72] });

  /* rump, rounding off the croup so the tail root has something to leave */
  g.ellipsoid(body, [0, 1.18, croupZ - 0.07], [0.24, 0.215, 0.185],
    { sph: [5, 4] });

  /* breast, so the front of the animal is a chest and not a cut tube */
  g.ellipsoid(body, [0, 1.16, chestZ + 0.02], [0.20, 0.235, 0.16],
    { sph: [6, 4] });

  /* ---------------- neck ----------------
     Leaves the withers steeply and flattens toward the poll; that change of
     angle is most of what makes a head look attached rather than glued on. */
  g.material(MAT.HAIR).color(coat[0] * 0.97, coat[1] * 0.97, coat[2] * 0.97);
  g.tube(neck, [0, 1.34, 0.30], [0, 1.54, 0.66], 0.185, 0.115,
    { seg: 5, rings: 2, squash: [0.80, 1.25] });

  /* ---------------- head ----------------
     A long wedge with a jaw. The muzzle stays blocky: a rounded tip at this
     poly budget reads as a dog, not a horse. */
  g.material(MAT.HAIR).color(coat[0], coat[1], coat[2]);
  g.tube(head, [0, 1.58, 0.70], [0, 1.44, 1.00], 0.115, 0.075,
    { seg: 6, rings: 1, squash: [0.78, 1.05] });
  /* the muzzle */
  g.ellipsoid(head, [0, 1.43, 1.02], [0.078, 0.070, 0.068], { sph: [5, 4] });
  /* jaw, set back under the cheek */
  g.ellipsoid(head, [0, 1.48, 0.78], [0.095, 0.085, 0.105], { sph: [5, 4] });
  /* ears, two small cones raked back */
  for (const sx of [-1, 1]) {
    g.tube(head, [sx * 0.050, 1.62, 0.74], [sx * 0.070, 1.73, 0.68], 0.030, 0.006,
      { seg: 4, rings: 1 });
  }
  /* mane: a flat crest down the neck, offset a little to one side so it does
     not fight the silhouette from the front */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  g.tube(neck, [0.040, 1.38, 0.28], [0.034, 1.58, 0.68], 0.070, 0.034,
    { seg: 4, rings: 1, squash: [0.32, 1.0] });

  /* ---------------- tail ----------------
     One bone, tapering, leaving the rump high and hanging behind. */
  g.material(MAT.HAIR).color(mane[0], mane[1], mane[2]);
  g.tube(tail, [0, 1.32, croupZ - 0.12], [0, 0.78, croupZ - 0.30], 0.060, 0.022,
    { seg: 5, rings: 1 });

  /* ---------------- legs ----------------
     Split in two, and the split matters. The haunch is thick and is built on
     the body, so it does not move; the cannon and hoof are thin and swing on
     the leg bones, whose origins are at the knee. Pivoting a thick mass about
     its top edge is what made the first version of this come apart at a walk.

     Front legs are straighter and sit under the neck; hind legs angle forward
     at the hock. Four identical straight legs reads as a table. */
  const hoof = [0.16, 0.14, 0.13];
  const legs = [
    /* bone,       x,     kneeY, kneeZ, footZ,  r,     haunchR */
    [B.HORSE_FL, -0.205, 0.52, 0.42, 0.44, 0.080, 0.165],
    [B.HORSE_FR, 0.205, 0.52, 0.42, 0.44, 0.080, 0.165],
    [B.HORSE_HL, -0.215, 0.54, -0.38, -0.44, 0.090, 0.190],
    [B.HORSE_HR, 0.215, 0.54, -0.38, -0.44, 0.090, 0.190]
  ];

  /* haunches: static, on the barrel */
  for (const [, x, kneeY, kneeZ, , , haunchR] of legs) {
    g.material(MAT.HAIR).color(coat[0] * 0.93, coat[1] * 0.93, coat[2] * 0.93);
    g.tube(body, [x * 0.82, kneeY + 0.46, kneeZ * 0.92], [x, kneeY + 0.04, kneeZ],
      haunchR, haunchR * 0.52, { seg: 5, rings: 1, squash: [1.0, 0.92] });
  }

  /* cannon + hoof: these swing */
  for (const [bone, x, kneeY, kneeZ, footZ, r] of legs) {
    g.material(MAT.HAIR).color(coat[0] * 0.95, coat[1] * 0.95, coat[2] * 0.95);
    g.tube(bone, [x, kneeY, kneeZ], [x, 0.10, footZ], r, r * 0.80,
      { seg: 5, rings: 1 });
    g.material(MAT.LEATHER).color(hoof[0], hoof[1], hoof[2]);
    g.tube(bone, [x, 0.10, footZ], [x, 0.005, footZ + 0.015], r * 0.94, r * 0.86,
      { seg: 4, rings: 1 });
  }

  /* ---------------- saddle ----------------
     Always present: a ridden horse without one reads as a bareback rider
     about to slide off. */
  g.material(MAT.LEATHER).color(0.34, 0.22, 0.14);
  g.tube(body, [0, 1.42, 0.18], [0, 1.43, -0.16], 0.245, 0.255,
    { seg: 6, rings: 1, squash: [1.0, 0.50] });
  /* saddle blanket, peeking out from under the leathers */
  if (caparison) {
    g.material(MAT.LINEN).color(caparison[0], caparison[1], caparison[2]);
    g.tube(body, [0, 1.36, 0.24], [0, 1.36, -0.30], 0.295, 0.295,
      { seg: 6, rings: 1, squash: [1.0, 0.58] });
  }

  /* ---------------- barding ----------------
     Cataphract plate: chamfron, peytral and a crinet of overlapping plates.
     Only the heavy cavalry pays for this. */
  if (barding) {
    g.material(MAT.PLATE).color(0.54, 0.56, 0.60);
    /* chamfron over the face */
    g.tube(head, [0, 1.60, 0.72], [0, 1.46, 1.00], 0.125, 0.090,
      { seg: 6, rings: 1, squash: [0.72, 1.0] });
    /* peytral: a plate across the chest */
    g.tube(body, [0, 1.26, 0.48], [0, 1.02, 0.52], 0.225, 0.185,
      { seg: 6, rings: 1, squash: [1.0, 0.72] });
    /* crinet: overlapping plates down the neck */
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      const z0 = 0.34 + t * 0.22, y0 = 1.36 + t * 0.22;
      g.tube(neck, [0, y0, z0], [0, y0 + 0.10, z0 + 0.09], 0.190 - t * 0.025,
        0.175 - t * 0.025, { seg: 6, rings: 1, squash: [0.85, 1.15] });
    }
  }

  return { body, neck, head };
}
