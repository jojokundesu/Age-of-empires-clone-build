/* ============================================================
   rigs.js — the rig registry

   A rig is a proportion table plus a class definition, assembled from
   three layers:

     anatomy.js   the shared body, emitted once for every humanoid
     wardrobe.js  helmets, armour, garments and carried kit
     classes.js   which of those a given class uses

   This file is the thin part: it owns the profile table, the palette
   colours, and buildRig(). Everything is in bind-pose model space, feet
   at y = 0, facing +Z.

   The proportion numbers are the approved table. The Man-at-Arms keeps a
   second variant so the approved 1.08/1.24 and the tighter 1.05/1.18 can
   still be compared at 4 m and 12 m.
   ============================================================ */

import { B } from './skeleton.js';
import { DETAIL, SkinnedBuilder } from './meshbuilder.js';
import { buildBody } from './anatomy.js';
import { CLASSES, FALLBACK_CLASS } from './classes.js';
import { buildMount, MOUNT_STANDARD, MOUNT_PONY } from './mount.js';

/* Material ids shared with unitShaders.js */
export const MAT = {
  LINEN: 0, MAIL: 1, PLATE: 2, GAMBESON: 3,
  SKIN: 4, HAIR: 5, LEATHER: 6, WOOD: 7
};

/**
 * Anatomy profiles. `height`/`limbW`/`chestD` scale the skeleton's rest
 * offsets; the rest are direct measurements in metres at height = 1.
 */
export const PROFILES = {
  /* The approved imposing juggernaut. */
  manAtArms: {
    height: 1.08, shoulderW: 1.24, chestD: 1.22, waist: 1.02, limbW: 1.16,
    headR: 1.02, stance: 1.2
  },
  /* The tighter alternative — same read, less "different species". */
  manAtArmsTight: {
    height: 1.05, shoulderW: 1.18, chestD: 1.16, waist: 1.0, limbW: 1.10,
    headR: 1.0, stance: 1.15
  },
  villager: {
    height: 0.94, shoulderW: 0.96, chestD: 0.95, waist: 0.88, limbW: 0.90,
    headR: 0.98, stance: 1.0
  },
  spearman: {
    height: 1.0, shoulderW: 1.02, chestD: 1.0, waist: 0.94, limbW: 1.0,
    headR: 1.0, stance: 1.05
  },
  /* Approved archer row: wide shoulders, the narrowest waist in the cast. */
  archer: {
    height: 0.99, shoulderW: 1.05, chestD: 0.97, waist: 0.85, limbW: 0.96,
    headR: 1.0, stance: 1.04
  },
  /* The knight rider: tallest, broadest, standing in stirrups. */
  knight: {
    height: 1.12, shoulderW: 1.26, chestD: 1.20, waist: 1.04, limbW: 1.18,
    headR: 1.02, stance: 1.24
  },
  /* The monk: narrow, stooped, a long robe does the rest. */
  monk: {
    height: 1.02, shoulderW: 0.98, chestD: 1.0, waist: 1.04, limbW: 0.96,
    headR: 1.0, stance: 1.0
  }
};

/* Profiles for the riders, which are just the knight's frame seated. Kept
   separate from `knight` because a mounted profile also carries a `mount`
   block, and buildRig checks for it. */
PROFILES.knightMounted = { ...PROFILES.knight, mount: MOUNT_STANDARD };
PROFILES.scoutMounted = { ...PROFILES.archer, height: 0.99, mount: MOUNT_PONY };

/* Skin tones and hair colours, picked per unit from its animSeed. */
export const SKIN_TONES = [
  [0.82, 0.66, 0.54], [0.72, 0.55, 0.42],
  [0.58, 0.42, 0.31], [0.44, 0.31, 0.23]
];
export const HAIR_COLORS = [
  [0.16, 0.12, 0.09], [0.32, 0.21, 0.12],
  [0.55, 0.42, 0.22], [0.70, 0.62, 0.52]
];

/**
 * Build one humanoid.
 *
 * @param g       SkinnedBuilder
 * @param prop    a profile from PROFILES
 * @param def     a class definition from classes.js
 * @param opts    { skin:[r,g,b], hair:[r,g,b], age:1..4, tool:'axe', ... }
 */
export function buildHumanoid(g, prop, def, opts = {}) {
  const age = opts.age || 3;
  const skin = opts.skin || SKIN_TONES[0];
  const hair = opts.hair || HAIR_COLORS[0];

  /* The body is shared: same ribcage, same elbow, every class. A bare-chested
     class (the berserk) gets skin instead of cloth. */
  const bodyOpts = {
    skin,
    bodyMat: def.bareChest ? 4 : (age >= 3 ? 1 : 3),
    legMat: age >= 3 ? 1 : 3,
    /* A bare chest has to be skin-coloured as well as skin-material: using
       the gambeson's fabric colour on MAT_SKIN renders a topless warrior in
       a grey smock. */
    bodyCol: def.bareChest ? skin : [0.78, 0.76, 0.70]
  };
  const m = buildBody(g, prop, bodyOpts);

  /* Then the class dresses it. */
  def.build(g, m, { ...opts, age, skin, hair });
  return m;
}

/** Rig registry, keyed by unit type. */
export const RIGS = {};
for (const key of Object.keys(CLASSES)) {
  RIGS[key] = { profile: CLASSES[key].profile, def: CLASSES[key] };
}
/* The A/B silhouette variant of the man-at-arms. */
RIGS.man_at_arms_tight = {
  profile: 'manAtArmsTight',
  def: CLASSES.man_at_arms
};

/**
 * Build one rig at a detail tier.
 * @returns {{packed, indices, tris, vertices}}
 */
export function buildRig(key, detail = DETAIL.MID, opts = {}) {
  const rig = RIGS[key];
  const def = rig ? rig.def : FALLBACK_CLASS;
  const profileName = rig ? rig.profile : 'spearman';
  const prop = PROFILES[profileName];
  if (!prop) throw new Error('no profile for ' + key + ': ' + profileName);
  const g = new SkinnedBuilder(detail);
  buildHumanoid(g, prop, def, opts);
  /* The mount is built after the rider so the rider's kit is already
     committed; the two do not share bones, so order only matters for
     reading the file. */
  if (prop.mount) {
    const mountOpts = def.mount ? def.mount(opts) : {};
    buildMount(g, mountOpts.coat || [0.34, 0.25, 0.18], mountOpts);
  }
  return g.finish();
}

/** True when this unit type rides. */
export function isMounted(key) {
  const rig = RIGS[key];
  if (!rig) return false;
  const prop = PROFILES[rig.profile];
  return !!(prop && prop.mount);
}

/** Which unit types have a rig. Everything else stays on legacy geometry. */
export function hasRig(type) {
  return Object.prototype.hasOwnProperty.call(RIGS, type);
}
