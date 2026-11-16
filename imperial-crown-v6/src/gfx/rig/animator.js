/* ============================================================
   animator.js — pose evaluation

   The simulation decides *what* a unit is doing (state, speed, attack
   timer). This file decides what that looks like: it turns those
   numbers into joint angles. Nothing here touches the GPU or allocates
   per frame — a caller owns a Pose and an AnimState and passes them in.

   Everything is a pure function of (time, state), so a unit looks
   identical whether it is being drawn in the game or spinning on the
   Armory pedestal, and the inspector can scrub to any phase.

   THE FOUR PHASES OF A STRIKE
   ---------------------------
   A sine wave reads as a metronome. A real blow reads as preparation,
   then violence, then nothing, then recovery:

     windup    40%  easeOutCubic — slow coil, the weapon goes *up*
     strike    12%  easeInExpo  — the fast part, nearly all the travel
     hold      10%  flat + a 1-frame overshoot past the target angle
     recovery  38%  easeInOutQuad — settle back to guard

   The hold is what sells impact: a weapon that keeps moving through the
   hit looks like it passed through smoke.

   SECONDARY MOTION
   ----------------
   Capes, skirts, braids and plumes are driven by a critically damped
   spring lagging the parent bone, not by a copy of the parent's angle.
   Critically damped means no wobble at rest, which is the difference
   between a cape and a jelly.
   ============================================================ */

import { B, BONE_COUNT } from './skeleton.js';

/* ------------------------------------------------------------
   Easing. Named because the strike curve is a design decision,
   not an implementation detail.
   ------------------------------------------------------------ */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInExpo = (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Phase boundaries of a strike, as fractions of the attack timer. */
export const STRIKE = {
  WINDUP: 0.40,
  STRIKE: 0.12,
  HOLD: 0.10,
  RECOVERY: 0.38
};

/**
 * Evaluate the strike curve at normalised time `t` (0 = trigger,
 * 1 = ready again). Returns -1..1: negative is the coil, positive is
 * the follow-through.
 */
export function strikeCurve(t) {
  const { WINDUP, STRIKE: S, HOLD } = STRIKE;
  const strikeEnd = WINDUP + S;
  const holdEnd = strikeEnd + HOLD;
  if (t <= 0 || t >= 1) return 0;
  if (t < WINDUP) {
    /* coil back: ease into the top of the wind-up */
    return -easeOutCubic(t / WINDUP);
  }
  if (t < strikeEnd) {
    /* the blow itself: from -1 to slightly past +1 */
    const u = (t - WINDUP) / S;
    return lerp(-1, 1.08, easeInExpo(u));
  }
  if (t < holdEnd) {
    /* impact hold, with a one-step settle off the overshoot */
    const u = (t - strikeEnd) / HOLD;
    return lerp(1.08, 1.0, easeOutCubic(u));
  }
  /* recovery: back to guard, and it should feel like the arm is heavy */
  const u = (t - holdEnd) / STRIKE.RECOVERY;
  return lerp(1.0, 0, easeInOutQuad(u));
}

/* ------------------------------------------------------------
   Spring lag for secondary motion.
   ------------------------------------------------------------ */

/**
 * A critically damped spring, stepped one frame.
 *
 * `stiffness` sets how fast it follows; at critical damping the return
 * is as fast as possible without overshooting, so a cape at rest stays
 * at rest instead of shivering.
 */
export class Spring {
  constructor(stiffness = 120, damping = null) {
    this.k = stiffness;
    /* critical damping for a unit mass is 2*sqrt(k) */
    this.c = damping === null ? 2 * Math.sqrt(stiffness) : damping;
    this.x = 0;      // current offset
    this.v = 0;      // velocity
  }
  /** Advance toward `target` by dt, returning the new offset. */
  step(target, dt) {
    /* semi-implicit Euler: stable at the frame times we actually see */
    const a = -this.k * (this.x - target) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  reset(v = 0) { this.x = v; this.v = 0; return this; }
}

/**
 * Per-unit animation state.
 *
 * Kept out of `sim/entities.js` deliberately: the simulation must not
 * pay for render-side springs, and a unit that is culled or at a low
 * animation LOD can simply stop being stepped.
 */
export class AnimState {
  constructor(seed = 0) {
    /* Desynchronised so a formation does not breathe in lockstep. The
       seed is per unit and stable, so a unit always fidgets the same way. */
    this.seed = seed;
    this.t = seed * 7.31;          // personal clock, seconds
    this.breath = 0;               // accumulated breathing phase
    this.weight = new Spring(90);  // weight transfer, side to side
    this.skirtF = new Spring(70);  // front/back skirt swing
    this.skirtS = new Spring(70);  // skirt side swing
    this.cape = new Spring(45);    // slower, heavier
    this.hair = new Spring(110);   // light, quick
    this.plume = new Spring(85);
    this.fidgetCount = 0;          // how many idle gestures this unit has made
    this.fidgetLeft = 0;           // seconds until the next one
    this.fidgetKind = 0;
    this.fidgetDur = 0;
    this.fidgetActive = 0;
    /* Stagger the first fidget across units, or a whole formation takes its
       first breath on the same frame — the exact thing animSeed exists to
       prevent. */
    scheduleFidget(this, 0);
    /* Look-at, in radians, driven by whatever the unit is attending to. */
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._lookYawTarget = 0;
    this._lookPitchTarget = 0;
  }
}

/* Fidget kinds. Each is a small, readable gesture — the point is that a
   unit standing still looks like it is *waiting*, not switched off. */
export const FIDGET = {
  WEIGHT_SHIFT: 0,
  LOOK_AROUND: 1,
  SCRATCH: 2,
  ADJUST_GEAR: 3,
  SHIFT_STANCE: 4,
  BREATHE_DEEP: 5
};

const FIDGET_PERIOD_MIN = 6;
const FIDGET_PERIOD_MAX = 14;

/** Deterministic 0..1 hash, so fidgets never use Math.random. */
function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Pick the next idle gesture and when it starts.
 * Deterministic from the seed and the fidget counter, so replays match.
 */
function scheduleFidget(st, counter) {
  const base = st.seed * 97.31 + counter * 13.77;
  const r1 = hash01(base + 0.5);
  const r2 = hash01(base + 1.5);
  const r3 = hash01(base + 2.5);
  st.fidgetLeft = FIDGET_PERIOD_MIN + r1 * (FIDGET_PERIOD_MAX - FIDGET_PERIOD_MIN);
  st.fidgetKind = Math.floor(r2 * 6);
  st.fidgetDur = 0.9 + r3 * 0.7;
}

/* ------------------------------------------------------------
   The evaluator
   ------------------------------------------------------------ */

/**
 * Advance and evaluate one unit's pose.
 *
 * @param pose    Pose to write (cleared first)
 * @param st      AnimState
 * @param inp     {
 *                  dt,            seconds since last evaluation
 *                  speed,         0..1 walk blend (anim.speed)
 *                  phase,         stride phase in radians (anim.phase)
 *                  attack,        1..0 attack timer (anim.attack)
 *                  moving,        bool
 *                  hitFlash,      0..1, for flinch
 *                  classKey,      'man_at_arms' | 'villager' | ...
 *                  lookYaw/Pitch, target look direction, radians
 *                  gait           optional override ('walk'|'run')
 *                }
 */
export function evaluate(pose, st, inp) {
  const dt = Math.min(inp.dt || 0, 0.05);   // never let a hitch explode a spring
  const speed = clamp01(inp.speed || 0);
  const phase = inp.phase || 0;
  const attack = clamp01(inp.attack || 0);

  pose.clear();

  /* --- personal clock --------------------------------------- */
  st.t += dt;
  /* Breathing is ~15 breaths/min: slow enough to read as calm. */
  st.breath += dt * 1.6;

  /* --- gait -------------------------------------------------
     Two gait families share the skeleton: a plod (villager, weight on
     the heel) and a march (soldier, weight forward and compact). */
  const cls = inp.classKey || 'man_at_arms';
  const gait = GAITS[cls] || GAITS.man_at_arms;

  /* legs: opposite phase, so this is the whole walk cycle */
  const swing = Math.sin(phase) * speed;
  const swing2 = Math.sin(phase + Math.PI) * speed;

  pose.set(B.THIGH_L, swing * gait.stride, 0, 0);
  pose.set(B.THIGH_R, swing2 * gait.stride, 0, 0);
  /* knee only bends one way, and it bends on the backswing */
  const kneeL = Math.max(0, -Math.sin(phase - 0.9)) * gait.knee * speed;
  const kneeR = Math.max(0, -Math.sin(phase + Math.PI - 0.9)) * gait.knee * speed;
  pose.set(B.SHIN_L, kneeL, 0, 0);
  pose.set(B.SHIN_R, kneeR, 0, 0);
  /* foot: keep the sole roughly level with the ground */
  pose.set(B.FOOT_L, -swing * gait.stride * 0.45 - kneeL * 0.5, 0, 0);
  pose.set(B.FOOT_R, -swing2 * gait.stride * 0.45 - kneeR * 0.5, 0, 0);

  /* hips counter-rotate against the shoulders — this single detail is
     most of why a walk looks like a walk and not a shuffle */
  const hipTwist = Math.sin(phase) * 0.10 * speed * gait.twist;
  pose.set(B.PELVIS, gait.lean * speed, hipTwist, 0);

  /* torso: lean into the walk, and rise/fall twice per stride */
  const bob = Math.abs(Math.sin(phase)) * 0.035 * speed;
  pose.set(B.SPINE, gait.spine + gait.lean * 0.5 * speed, -hipTwist * 1.6, 0);
  pose.set(B.CHEST, gait.chest + gait.lean * 0.3 * speed, -hipTwist * 0.8, 0);
  pose.off[B.PELVIS * 3 + 1] = bob - gait.sink * speed;

  /* --- breathing: chest scale, not rotation --------------- */
  const breath = Math.sin(st.breath) * 0.5 + 0.5;
  const bAmt = 0.012 + breath * 0.010;
  pose.scl[B.CHEST * 3] = 1 + bAmt;
  pose.scl[B.CHEST * 3 + 2] = 1 + bAmt * 0.8;

  /* --- arms: counter-swing to the legs -------------------- */
  const armSwing = Math.sin(phase + Math.PI) * speed * gait.armSwing;
  pose.set(B.UPPER_ARM_L, armSwing, 0, gait.armOut);
  pose.set(B.UPPER_ARM_R, -armSwing, 0, -gait.armOut);
  /* elbows carry the weight: bent more at rest than a T-pose */
  const elbowL = gait.elbow + Math.max(0, armSwing) * 0.35;
  const elbowR = gait.elbow + Math.max(0, -armSwing) * 0.35;
  pose.set(B.FOREARM_L, -elbowL, 0, 0);
  pose.set(B.FOREARM_R, -elbowR, 0, 0);

  /* --- idle fidgets --------------------------------------- */
  let fidgetAmt = 0;
  if (speed < 0.15 && attack < 0.02) {
    st.fidgetLeft -= dt;
    if (st.fidgetLeft <= 0) {
      st.fidgetCount++;
      scheduleFidget(st, st.fidgetCount);
      st.fidgetActive = st.fidgetDur;
    }
    if (st.fidgetActive > 0) {
      st.fidgetActive = Math.max(0, st.fidgetActive - dt);
      const u = 1 - st.fidgetActive / st.fidgetDur;
      /* a bell curve: the gesture rises and falls, never snaps */
      fidgetAmt = Math.sin(clamp01(u) * Math.PI);
      applyFidget(pose, st, st.fidgetKind, fidgetAmt);
    }
  } else {
    st.fidgetActive = 0;
  }

  /* --- weight shift: a constant low-level sway, always on -- */
  const weightTarget = Math.sin(st.t * 0.55) * 0.55;
  const weight = st.weight.step(weightTarget, dt);
  pose.off[B.PELVIS * 3] = weight * 0.018;
  pose.set(B.PELVIS, pose.rot[B.PELVIS * 3], pose.rot[B.PELVIS * 3 + 1], weight * 0.05);

  /* --- combat: the four-phase strike ---------------------- */
  if (attack > 0.001) {
    applyStrike(pose, cls, attack, inp);
  }

  /* --- flinch --------------------------------------------- */
  const flash = clamp01(inp.hitFlash || 0);
  if (flash > 0.001) {
    pose.add(B.SPINE, -flash * 0.22, 0, 0);
    pose.add(B.HEAD, -flash * 0.18, 0, 0);
    pose.add(B.CHEST, -flash * 0.10, 0, 0);
  }

  /* --- look-at -------------------------------------------- */
  const wantYaw = clampAngle(inp.lookYaw || 0, 0.70);    // +/- 40 deg
  const wantPitch = clampAngle(inp.lookPitch || 0, 0.35); // +/- 20 deg
  /* The neck does a third of the turn and the eyes/head the rest; a head
     that snaps to a target looks robotic. */
  st.lookYaw = lerp(st.lookYaw, wantYaw, Math.min(1, dt * 6));
  st.lookPitch = lerp(st.lookPitch, wantPitch, Math.min(1, dt * 5));
  pose.add(B.NECK, st.lookPitch * 0.3, st.lookYaw * 0.3, 0);
  pose.add(B.HEAD, st.lookPitch * 0.7, st.lookYaw * 0.7, 0);

  /* --- secondary motion ----------------------------------- */
  /* The skirt lags the hips; the cape lags the chest; hair lags the head. */
  const skirtTarget = -swing * 0.26 * speed;
  const skirtSide = -weight * 0.10;
  pose.set(B.SKIRT,
    st.skirtF.step(skirtTarget, dt) + gait.lean * 0.5 * speed,
    0,
    st.skirtS.step(skirtSide, dt));

  /* hair lags head motion, plus a wind flutter that never fully stops */
  const hairTarget = st.lookYaw * -0.18 + Math.sin(st.t * 1.7) * 0.012;
  pose.set(B.HAIR, st.hair.step(hairTarget, dt) * 0.5 - st.lookPitch * 0.15, 0,
    st.hair.step(hairTarget * 0.6, dt) * 0.35);

  /* --- riding ----------------------------------------------
     A mounted unit reuses the whole humanoid pose and then overrides
     the parts a saddle changes. Doing it here rather than in a second
     pose function keeps one clock, one set of springs and one strike
     curve for the entire cast. */
  if (inp.mounted) applyRiding(pose, st, inp, gait, speed, phase);

  return pose;
}

/**
 * Seating and the mount's own animation.
 *
 * The rider is lifted onto the saddle by Pose.seat, which buildPalette
 * applies to the pelvis only -- so the entire humanoid block moves and
 * the horse does not. Then the legs are folded around the barrel and
 * the horse gets its own gait.
 */
function applyRiding(pose, st, inp, gait, speed, phase) {
  /* Hips to the saddle. The saddle sits at y = 1.45 on the barrel and the
     rider's pelvis rest is y = 0.95, so 0.50 of lift puts the seat bones on
     the leathers rather than inside the horse. */
  pose.seat = RIDE_SEAT;

  /* --- rider's legs: knees forward and OUT, feet down in the stirrup ---
     The abduction is the number that matters. The hip joints sit about
     0.10 m either side of centre and the barrel is 0.27 m half-width, so a
     thigh that only splays 0.20 rad keeps the whole leg inside the horse
     and the rider appears to have none. 0.55 rad puts the knee outside the
     flank where it belongs, and the shin then hangs down the side. */
  /* Sign note: a +Z rotation swings a bone hanging below its joint toward
     +X. THIGH_L sits at negative X, so the left leg needs a NEGATIVE Z to
     abduct outward -- with the sign the other way both legs fold across the
     barrel and the rider appears to have none. */
  const post = Math.sin(phase * 2) * 0.06 * speed;
  pose.set(B.THIGH_L, -1.16 + post, 0, -0.55);
  pose.set(B.THIGH_R, -1.16 - post, 0, 0.55);
  pose.set(B.SHIN_L, 1.30, 0, 0);
  pose.set(B.SHIN_R, 1.30, 0, 0);
  pose.set(B.FOOT_L, 0.34, 0, 0);
  pose.set(B.FOOT_R, 0.34, 0, 0);

  /* --- rider's torso: forward over the withers, hands on the reins ---
     Sitting upright on a moving horse looks like a mannequin. */
  pose.add(B.SPINE, 0.10 + speed * 0.10, 0, 0);
  pose.add(B.CHEST, 0.05 + speed * 0.05, 0, 0);
  /* the near arm holds the reins low, the far arm keeps the weapon free */
  pose.set(B.UPPER_ARM_L, -0.55, 0, 0.24);
  pose.set(B.FOREARM_L, -0.95, 0, 0);
  pose.set(B.UPPER_ARM_R, -0.30 + Math.sin(phase * 2) * 0.06 * speed, 0, -0.20);
  pose.set(B.FOREARM_R, -0.70, 0, 0);

  /* --- the horse -------------------------------------------
     A walk is a four-beat gait; a gallop is a two-beat one with the
     hind pair driving. Both come from the same phase so the legs and
     the body stay in sync, which is the difference between a horse
     and a rocking chair. */
  const gallop = clamp01(inp.speed || 0);
  const bob = Math.sin(phase * 2) * (0.020 + gallop * 0.055);
  pose.off[B.HORSE_BODY * 3 + 1] = bob;
  /* the barrel pitches with the stride */
  pose.set(B.HORSE_BODY, Math.sin(phase * 2 + 0.6) * (0.02 + gallop * 0.05), 0, 0);

  /* neck counter-nods against the barrel: the head stays level while the
     body rocks, and that counter-motion is what reads as a live animal */
  pose.set(B.HORSE_NECK, -Math.sin(phase * 2 + 0.6) * (0.05 + gallop * 0.10)
    + Math.sin(st.t * 0.9) * 0.02, 0, 0);
  pose.set(B.HORSE_HEAD, 0.10 + Math.sin(phase * 2 + 1.4) * 0.04 * (0.4 + gallop), 0, 0);

  /* legs: hind pair half a phase ahead of the front pair, diagonals opposed */
  /* A horse's stride swings the whole leg about a hip that is deep inside
     the barrel, so the visible arc is much wider than the angle suggests:
     at 0.5 rad on a 0.7 m leg the hoof travels 0.34 m, which reads as a
     spidery splay rather than a gait. Keep it small. */
  const legSwing = 0.10 + gallop * 0.18;
  pose.set(B.HORSE_FL, Math.sin(phase) * legSwing * speed, 0, 0);
  pose.set(B.HORSE_FR, Math.sin(phase + Math.PI) * legSwing * speed, 0, 0);
  pose.set(B.HORSE_HL, Math.sin(phase + Math.PI * 0.85) * legSwing * speed, 0, 0);
  pose.set(B.HORSE_HR, Math.sin(phase + Math.PI * 1.85) * legSwing * speed, 0, 0);

  /* tail: a lazy pendulum at rest, streaming out at speed */
  const tailBase = -0.22 - gallop * 0.55;
  pose.set(B.HORSE_TAIL, tailBase + Math.sin(st.t * 2.1) * 0.10 * (1 - gallop * 0.6),
    0, Math.sin(st.t * 1.3) * 0.12);
}

/** Metres the whole rider is lifted to sit in the saddle. */
export const RIDE_SEAT = 0.50;

/** Clamp an angle to +/- limit, but ease rather than clip. */
function clampAngle(v, limit) {
  return v < -limit ? -limit : v > limit ? limit : v;
}

function applyFidget(pose, st, kind, amt) {
  switch (kind) {
    case FIDGET.WEIGHT_SHIFT:
      pose.off[B.PELVIS * 3] += amt * 0.030;
      pose.add(B.PELVIS, 0, 0, amt * 0.05);
      break;
    case FIDGET.LOOK_AROUND:
      /* a small, quick turn of the head, then back */
      pose.add(B.HEAD, -amt * 0.05, amt * 0.42, 0);
      pose.add(B.NECK, 0, amt * 0.16, 0);
      break;
    case FIDGET.SCRATCH:
      pose.add(B.UPPER_ARM_L, -amt * 0.55, 0, amt * 0.25);
      pose.add(B.FOREARM_L, -amt * 1.15, 0, 0);
      pose.add(B.HEAD, 0, amt * 0.18, amt * 0.06);
      break;
    case FIDGET.ADJUST_GEAR:
      pose.add(B.UPPER_ARM_R, -amt * 0.42, 0, -amt * 0.12);
      pose.add(B.FOREARM_R, -amt * 0.85, 0, 0);
      pose.add(B.CHEST, 0, -amt * 0.07, 0);
      break;
    case FIDGET.SHIFT_STANCE:
      pose.add(B.THIGH_L, amt * 0.13, 0, 0);
      pose.add(B.SHIN_L, -amt * 0.10, 0, 0);
      pose.add(B.PELVIS, 0, amt * 0.05, 0);
      break;
    case FIDGET.BREATHE_DEEP:
      pose.scl[B.CHEST * 3] += amt * 0.035;
      pose.scl[B.CHEST * 3 + 2] += amt * 0.030;
      pose.add(B.CHEST, -amt * 0.05, 0, 0);
      break;
    default: break;
  }
}

/**
 * Weapon-side choreography for a strike.
 *
 * The arm that matters depends on the class: a spearman thrusts, a
 * man-at-arms chops, an archer releases. The curve is shared; the
 * joints it drives are not.
 */
function applyStrike(pose, cls, attack, inp) {
  /* attack counts *down* from 1, so invert to get 0..1 elapsed */
  const t = 1 - attack;
  const c = strikeCurve(t);

  const w = WEAPONS[cls] || WEAPONS.man_at_arms;
  if (w.thrust) {
    /* a thrust extends the arm forward and drives the shoulder */
    const ext = (c + 1) * 0.5;                 // 0..1..0
    pose.add(B.UPPER_ARM_R, -1.15 * ext, 0, -0.35 * ext);
    pose.add(B.FOREARM_R, -(0.9 - 0.75 * ext), 0, 0);
    pose.add(B.CHEST, 0, -0.30 * ext, 0);
    pose.add(B.SPINE, 0, -0.16 * ext, 0);
    pose.off[B.PELVIS * 3 + 2] = ext * 0.05;
  } else {
    /* a chop: overhead wind-up then down through the target */
    if (c < 0) {
      /* coil: raise the weapon behind the head */
      const u = -c;
      pose.add(B.UPPER_ARM_R, -2.3 * u, 0, -0.5 * u);
      pose.add(B.FOREARM_R, -0.9 * u, 0, 0);
      pose.add(B.SHOULDER_R, 0, 0, -0.3 * u);
      pose.add(B.CHEST, 0, 0.28 * u, 0);
      pose.add(B.SPINE, -0.10 * u, 0.12 * u, 0);
    } else {
      const u = c / 1.08;
      pose.add(B.UPPER_ARM_R, lerp(-2.3, -0.15, easeInExpo(clamp01(u))), 0, lerp(-0.5, 0.4, u));
      pose.add(B.FOREARM_R, lerp(-0.9, -0.35, u), 0, 0);
      pose.add(B.SHOULDER_R, 0, 0, lerp(-0.3, 0.2, u));
      pose.add(B.CHEST, 0, lerp(0.28, -0.34, u), 0);
      pose.add(B.SPINE, lerp(-0.10, 0.14, u), lerp(0.12, -0.20, u), 0);
      /* the off hand balances */
      pose.add(B.UPPER_ARM_L, 0.3 * u, 0, 0.25 * u);
    }
  }
  /* a shield recoil, if this class has one */
  if (w.shield) {
    pose.add(B.UPPER_ARM_L, -0.15 * Math.max(0, c), 0, 0.22 * Math.max(0, c));
    pose.add(B.FOREARM_L, -0.25 * Math.max(0, c), 0, 0);
  }
}

/* ------------------------------------------------------------
   Gait and weapon tables
   ------------------------------------------------------------ */

/**
 * Per-class gait. `stride` scales the hip swing, `lean` the forward
 * pitch of the whole body, `sink` how far the body drops at mid-stride
 * (armour is heavy and a man-at-arms should look like it).
 */
export const GAITS = {
  man_at_arms: { stride: 0.62, knee: 0.75, armSwing: 0.38, armOut: 0.10, elbow: 0.35,
    lean: 0.04, spine: 0.02, chest: 0.0, sink: 0.030, twist: 1.0 },
  /* The villager's plod: shorter stride, more body sink, looser arms. */
  villager: { stride: 0.52, knee: 0.62, armSwing: 0.50, armOut: 0.06, elbow: 0.22,
    lean: 0.07, spine: 0.03, chest: 0.0, sink: 0.042, twist: 0.8 },
  spearman: { stride: 0.58, knee: 0.70, armSwing: 0.26, armOut: 0.12, elbow: 0.55,
    lean: 0.05, spine: 0.02, chest: 0.0, sink: 0.026, twist: 0.9 },
  /* The archer jogs toe-first: a little more knee, less sink. */
  archer: { stride: 0.66, knee: 0.88, armSwing: 0.30, armOut: 0.14, elbow: 0.62,
    lean: 0.06, spine: 0.02, chest: 0.0, sink: 0.020, twist: 1.1 },
  knight: { stride: 0.40, knee: 0.50, armSwing: 0.20, armOut: 0.16, elbow: 0.45,
    lean: 0.02, spine: 0.01, chest: 0.0, sink: 0.014, twist: 0.6 },
  monk: { stride: 0.46, knee: 0.55, armSwing: 0.22, armOut: 0.05, elbow: 0.30,
    lean: 0.03, spine: 0.01, chest: 0.0, sink: 0.018, twist: 0.7 }
};

/** Which hand does what, per class. */
export const WEAPONS = {
  man_at_arms: { thrust: false, shield: true },
  spearman: { thrust: true, shield: false },
  archer: { thrust: false, shield: false },
  villager: { thrust: false, shield: false },
  knight: { thrust: false, shield: true }
};
