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
import { guardGrips } from './animator.js';

/* THE PADDED JACKET, AS A COLOUR AND NOT A PLACEHOLDER.
   This default was 0.78/0.76/0.70 -- essentially white. It is the body colour
   for every class that does not override it, so the shader's quilt pattern
   was being laid over a near-white surface, and under the sun plus the tone
   curve that surface clipped to cream. A swordsman, a skirmisher and an
   axeman therefore read as white mannequins even after the palette and the
   lighting were fixed, because the largest single surface on the figure was
   authored white. Real gambeson is dirty undyed linen: oatmeal, toward tan.
   The team dye does not reach MAT_GAMBESON's authored hue, only MAT_LINEN's,
   so a class that passes bodyMat 3 keeps this colour on purpose. */
export const GAMBESON_COL = [0.56, 0.50, 0.40];

/* Material ids shared with unitShaders.js */
export const MAT = {
  LINEN: 0, MAIL: 1, PLATE: 2, GAMBESON: 3,
  SKIN: 4, HAIR: 5, LEATHER: 6, WOOD: 7,
  /* Undyed cloth. Not team-dyed, so it can frame the team colour. */
  TRIM: 8,
  /* Dyed wool. Also not team-dyed -- keeps its authored colour. */
  WOOL: 9
};

/**
 * Anatomy profiles. `height`/`limbW`/`chestD` scale the skeleton's rest
 * offsets; the rest are direct measurements in metres at height = 1.
 */
/* THE PROPORTION TABLE, and what it is aiming at.
   Age of Empires IV draws its soldiers at a heroic 6.8 heads: a head big
   enough to carry a face, a helmet and a plume at 3/4 zoom, on a body that
   is 2.2 heads wide at the shoulders. The old table was 6.1 heads on
   shoulders 2.5 heads wide, which is a bodybuilder with a pin-head -- the
   single most damaging thing about the old cast, and the reason every
   render read as a mannequin.

   `headR` is a multiplier on HEAD_R in anatomy.js. `shoulderW` scales the
   shoulder joint and every lathe that is measured across the body. The two
   are tuned together: widening one without the other breaks the ratio, and
   the ratio is the whole point. */
export const PROFILES = {
  /* The approved imposing juggernaut: tallest, broadest, and still 6.8
     heads because the head scales with the body. */
  manAtArms: {
    height: 1.08, shoulderW: 1.12, chestD: 1.16, waist: 1.02, limbW: 1.14,
    headR: 1.0, stance: 1.2
  },
  /* The tighter alternative — same read, less "different species". */
  manAtArmsTight: {
    height: 1.05, shoulderW: 1.08, chestD: 1.12, waist: 1.0, limbW: 1.08,
    headR: 1.0, stance: 1.15
  },
  villager: {
    height: 0.94, shoulderW: 0.94, chestD: 0.95, waist: 0.88, limbW: 0.92,
    headR: 1.0, stance: 1.0
  },
  spearman: {
    height: 1.0, shoulderW: 1.0, chestD: 1.0, waist: 0.94, limbW: 1.0,
    headR: 1.0, stance: 1.05
  },
  /* Approved archer row: wide shoulders, the narrowest waist in the cast. */
  archer: {
    height: 0.99, shoulderW: 1.02, chestD: 0.97, waist: 0.85, limbW: 0.96,
    headR: 1.0, stance: 1.04
  },
  /* The knight rider: tallest, broadest, standing in stirrups. */
  knight: {
    height: 1.12, shoulderW: 1.14, chestD: 1.18, waist: 1.04, limbW: 1.16,
    headR: 1.0, stance: 1.24
  },
  /* The monk: narrow, stooped, a long robe does the rest. */
  monk: {
    height: 1.02, shoulderW: 0.96, chestD: 1.0, waist: 1.04, limbW: 0.96,
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
    /* The body is what the class's own garments COVER, so it is always the
       same cheap fabric material. It used to become MAT_MAIL at Age III,
       which turned the torso, both arms and both legs into mail while the
       class's tabard, surcoat and sleeves were only ever laid over the
       front of it -- so an Age III spearman was a brown-tinted mail cylinder
       wearing a linen bib. That is the tan wedge across his chest and it has
       been there since the age ladder landed.

       Classes that are armoured to the skin (the knight, the huskarl) say so
       with bareChest: they get MAT_MAIL on the body itself; everyone else
       gets cloth and lets the wardrobe decide what armour they wear. */
    /* A class may declare `woolBody` and keep its own cloth colour instead
       of taking the team's. The torso is the biggest single surface on the
       figure, so this is the parameter that decides whether an army reads as
       a uniform or as one blue mass. */
    bodyMat: def.bodyMat !== undefined
      ? def.bodyMat
      : (def.bareChest ? 4 : (def.mailedBody ? 1 : (def.woolBody ? 9 : 3))),
    legMat: def.legMat !== undefined ? def.legMat : ((def.bareChest || def.mailedBody) ? (def.bareChest ? 4 : 1) : 3),
    /* A bare chest has to be skin-coloured as well as skin-material: using
       the gambeson's fabric colour on MAT_SKIN renders a topless warrior in
       a grey smock. */
    /* A mailed body has to be MAIL-COLOURED as well as mail-material. The
       colour was the tunic's 0.78/0.76/0.70 for everyone, so a class that
       asked for MAT_MAIL got a pale linen-tinted mail that reads as cloth
       at any distance -- the cataphract's chest was indistinguishable from
       the man-at-arms' padded jacket. */
    bodyCol: def.bodyCol || (def.bareChest ? skin
      /* MAIL IS DARK. This was 0.62/0.61/0.57 -- a light warm grey -- and
         the mail material then adds its own ring pattern on top at up to
         full luminance, so every mailed torso, arm and leg clipped to a pale
         near-white that read as a white plastic cuirass. Mail in the period
         is blackened or blued iron with a dark sheen; the rings catch light,
         the garment does not. */
      : (def.mailedBody ? [0.34, 0.34, 0.33]
        : (def.woolBody || GAMBESON_COL)))
  };
  const m = buildBody(g, prop, bodyOpts);
  /* opts carries the class key through from buildRig, so the guard lookup is
     exact rather than a reverse search through CLASSES (which would be wrong
     for the A/B variant of the man-at-arms, since both share one definition). */
  /* The class's wardrobe needs to know whether it is dressing a man on foot
     or a man in a saddle: a shield hangs differently in each, and this is
     the only place that knows. */
  m.mounted = !!prop.mount;
  /* WHERE THE HANDS ARE IN THIS CLASS'S GUARD, in model space.
     The wardrobe authors weapons in bind space and the animator poses the
     arms afterwards, so a weapon placed at the bind-pose hand swings away
     from the fist the moment the guard is applied -- which is why the
     spearman's shaft stood beside him with nothing holding it and the
     axeman's haft crossed his own face. These two points are the actual
     fist positions under IDLE_GUARD[class], measured once by the animator.
     Wardrobe code that needs a grip uses them instead of guessing. */
  m.grip = guardGrips(prop, opts.classKey || 'man_at_arms');
  m.profile = prop;

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
    /* prop.mount is the horse's own dimensions -- MOUNT_STANDARD or a
       MOUNT_PONY. Passing it through is what makes the scout's pony a pony;
       without it every cavalry class rode the same destrier. */
    mountOpts.mount = prop.mount;
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
