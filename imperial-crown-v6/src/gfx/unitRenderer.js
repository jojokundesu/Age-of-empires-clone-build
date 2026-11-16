/* ============================================================
   unitRenderer.js — the rigged unit draw pass

   Owns everything that is specific to skinned humanoids, so renderer.js
   only has to call four methods. The legacy MODEL path keeps its own
   batches for buildings, props, ships and siege; nothing here touches
   those.

   WHY A PALETTE TEXTURE AND NOT PER-UNIT UNIFORMS
   ----------------------------------------------
   A uniform cannot vary per instance inside an instanced draw. 150 units
   would therefore need either one shared pose (unacceptable) or 150 draw
   calls (also unacceptable). Instead every visible unit owns one row of
   a 2D RGBA32F texture and the vertex shader pulls its bone matrices
   with texelFetch. One draw call per unit class per LOD tier.

   The rows are reclaimed when a unit stops being drawn, so the texture
   does not grow without bound as units are trained and killed.

   ANIMATION LOD
   -------------
   Pose evaluation is the expensive part (24 bones x a few hundred
   springs and trig calls per unit), so it runs at 60 Hz close in and
   20 Hz far away, with the result reused between updates. Springs still
   integrate at the reduced rate, which is invisible at that distance.
   ============================================================ */

import { B, BONE_COUNT, Pose, buildBindPalette, buildSkinPalette } from './rig/skeleton.js';
import { DETAIL } from './rig/meshbuilder.js';
import { buildRig, PROFILES, SKIN_TONES, HAIR_COLORS, RIGS, hasRig, isMounted } from './rig/rigs.js';
import { evaluate, AnimState } from './rig/animator.js';
import { mountSeatHeight } from './rig/mount.js';
import { UNIT_MAX_ROWS, UNIT_TEX_WIDTH } from './rig/unitShaders.js';
import { InstanceBatch } from './batch.js';
import { BonePalette } from './rig/palette.js';

/* Animation LOD thresholds, in metres from the camera. */
export const ANIM_LOD = { NEAR: 20, MID: 60 };
/* And the *geometry* LOD, which is about triangles rather than CPU. */
export const GEO_LOD = { NEAR: 26, MID: 70 };

/**
 * Unit classes that have a rig. Everything else — ships, siege engines, the
 * trade cart — stays on legacy geometry.
 *
 * The A/B silhouette variant (man_at_arms_tight) is deliberately not in this
 * map: it exists to be inspected on the pedestal, not to be shipped.
 */
/**
 * Saddle height above the rider's pelvis rest, for this unit's mount.
 * A scout's pony is 0.88 of a destrier, so the lift has to come from the
 * mount's own profile rather than from a constant.
 */
export function seatFor(key) {
  const prof = PROFILES[(RIGS[key] || {}).profile];
  if (!prof || !prof.mount) return undefined;
  return mountSeatHeight(prof.mount) - 0.95;
}

export function rigKeyFor(type) {
  if (type === 'man_at_arms_tight') return null;
  return hasRig(type) ? type : null;
}

export class UnitRenderer {
  /**
   * @param gl        WebGL2 context
   * @param program   the shared 'unit' Shader, owned by the renderer so the
   *                  lighting uniforms are bound in one place
   */
  constructor(gl, program) {
    this.gl = gl;
    this.program = program || null;
    this.palette = new BonePalette(gl, UNIT_MAX_ROWS, UNIT_TEX_WIDTH);
    /* One batch per (rig, detail tier). A rig is built once per tier and
       never rebuilt: geometry is static, only the pose changes. */
    this.batches = new Map();
    this.meshes = new Map();
    this.meta = new Map();
    /* Per unit: pose state, palette row, cached bind. Keyed by unit id. */
    this.actors = new Map();
    this._pose = new Pose();
    this._pal = new Float32Array(BONE_COUNT * 16);
    this._bindCache = new Map();
    this.stats = { units: 0, rows: 0, posed: 0, tris: 0 };
    this.cullDist2 = 150 * 150;
  }

  /** Build the geometry for every rig at every tier, once. */
  async init(onProgress) {
    const keys = Object.keys(RIGS);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      for (const tier of [DETAIL.NEAR, DETAIL.MID, DETAIL.FAR]) {
        const id = key + ':' + tier;
        const rig = buildRig(key, tier, { age: 3 });
        const batch = new InstanceBatch(this.gl, rig, 256);
        batch.cull = true;
        this.batches.set(id, batch);
        this.meshes.set(id, { tris: rig.tris, verts: rig.vertices });
      }
      if (onProgress) onProgress(keys[i], (i + 1) / keys.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  _bindFor(key) {
    let b = this._bindCache.get(key);
    if (!b) {
      b = new Float32Array(BONE_COUNT * 16);
      const rig = RIGS[key];
      buildBindPalette(b, PROFILES[rig.profile]);
      this._bindCache.set(key, b);
    }
    return b;
  }

  _actor(u) {
    let a = this.actors.get(u.id);
    if (!a) {
      a = {
        state: new AnimState(u.animSeed !== undefined ? u.animSeed : Math.random()),
        row: -1,
        lastPose: -1,
        key: null
      };
      this.actors.set(u.id, a);
    }
    return a;
  }

  /**
   * Pose and enqueue every visible unit, then upload the palette.
   *
   * @param cam     {eye:[x,y,z]}
   * @param game    the simulation
   * @param viewProj
   * @param alpha   interpolation fraction for the current frame
   */
  update(cam, game, viewProj, alpha) {
    const gl = this.gl;
    const cx = cam.eye[0], cz = cam.eye[2];
    this.stats.units = 0; this.stats.posed = 0; this.stats.tris = 0;

    /* Which actors were touched this frame, so stale rows can be freed. */
    const live = this._live || (this._live = new Set());
    live.clear();
    for (const b of this.batches.values()) b.begin();

    const units = game.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.garrisoned) continue;
      if (u.dead && (u.deadT || 0) > 6) continue;
      const key = rigKeyFor(u.type);
      if (!key) continue;

      const dx = u.x - cx, dz = u.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > this.cullDist2) continue;
      const dist = Math.sqrt(d2);

      const tier = dist < GEO_LOD.NEAR ? DETAIL.NEAR
        : dist < GEO_LOD.MID ? DETAIL.MID : DETAIL.FAR;
      const batch = this.batches.get(key + ':' + tier);
      if (!batch) continue;

      /* Interpolate the position between ticks, like the legacy path, and
         reject off-screen units *before* posing them. Posing is the
         expensive part; three hundred units should not pay for twenty-four
         bones each when most of them are behind the camera. */
      const rx = u.xPrev === undefined ? u.x : u.xPrev + (u.x - u.xPrev) * alpha;
      const rz = u.zPrev === undefined ? u.z : u.zPrev + (u.z - u.zPrev) * alpha;
      const ry = u.yPrev === undefined ? u.y : u.yPrev + (u.y - u.yPrev) * alpha;
      if (!inFrustum(viewProj, rx, ry + 0.9, rz, 1.4)) continue;

      const a = this._actor(u);
      live.add(u.id);

      /* Evaluate the pose, but not every frame far away. */
      const hz = dist < ANIM_LOD.NEAR ? 60 : dist < ANIM_LOD.MID ? 30 : 20;
      const now = this.time || 0;
      const minStep = 1 / hz;
      if (a.lastPose < 0 || now - a.lastPose >= minStep * 0.99) {
        const dt = a.lastPose < 0 ? minStep : Math.min(now - a.lastPose, 0.1);
        const anim = u.anim || {};
        evaluate(this._pose, a.state, {
          dt,
          speed: anim.speed || 0,
          phase: anim.phase || 0,
          attack: anim.attack || 0,
          moving: !!u.moving,
          hitFlash: u.hitFlash || 0,
          classKey: key,
          seat: seatFor(key),
          lookYaw: u.lookYaw || 0,
          lookPitch: u.lookPitch || 0,
          /* Without this a rider stands on the ground with a horse through
             its middle: the mount is a separate bone block and nothing else
             tells the pose to seat the rider. */
          mounted: isMounted(key)
        });
        /* write the skinning palette into this unit's texture row */
        const row = this.palette.allocRow(u.id);
        a.row = row;
        buildSkinPalette(this._pal, this._pose, PROFILES[RIGS[key].profile], this._bindFor(key));
        this.palette.writeRow(row, this._pal);
        this.stats.posed++;
        a.lastPose = now;
      }
      if (a.row < 0) continue;

      const m = m4trs(rx, ry, rz, u.facing || 0);
      /* iC = palette row, packed class/age/variant, anim seed, gear flags */
      const age = game.ageOf ? game.ageOf(u.team) : 3;
      const packed = (key === 'man_at_arms' ? 1 : 0) | (age << 12);
      const seed = u.animSeed !== undefined ? u.animSeed : 0;
      const gear = 0;
      batch.push(m, 1, 1, 1, 1, 0, 1, seed,
        a.row, packed, seed, gear);
      this.stats.units++;
    }

    /* Release the rows of units that are no longer drawn. */
    for (const [id, a] of this.actors) {
      if (!live.has(id) && a.row >= 0) {
        this.palette.releaseRow(a.row, id);
        a.row = -1;
        a.lastPose = -1;
      }
    }

    this.palette.flush();
    for (const b of this.batches.values()) {
      if (b.count) b.flush();
    }
    this.stats.rows = this.palette.usedRows;
    this.stats.tris = 0;
    for (const b of this.batches.values()) this.stats.tris += b.triCount * b.count;
  }

  /** Draw every non-empty rigged batch. Assumes the program is current. */
  draw(loader, s, stats, gl) {
    for (const b of this.batches.values()) {
      if (!b.count) continue;
      b.draw();
      if (stats) stats.drawCalls++;
      this._drawn = (this._drawn || 0) + 1;
    }
  }
}

/* Small helpers kept local so this file does not need the renderer's maths. */
function m4trs(x, y, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    x, y, z, 1
  ]);
}

function inFrustum(vp, x, y, z, r) {
  /* Cheap sphere-vs-frustum using the clip-space planes, matching the
     renderer's own test closely enough that units never pop early. */
  const m = vp;
  const planes = _planes || (_planes = new Float32Array(24));
  /* left, right, bottom, top, near, far, extracted from the view-proj */
  planes[0] = m[3] + m[0]; planes[1] = m[7] + m[4]; planes[2] = m[11] + m[8]; planes[3] = m[15] + m[12];
  planes[4] = m[3] - m[0]; planes[5] = m[7] - m[4]; planes[6] = m[11] - m[8]; planes[7] = m[15] - m[12];
  planes[8] = m[3] + m[1]; planes[9] = m[7] + m[5]; planes[10] = m[11] + m[9]; planes[11] = m[15] + m[13];
  planes[12] = m[3] - m[1]; planes[13] = m[7] - m[5]; planes[14] = m[11] - m[9]; planes[15] = m[15] - m[13];
  planes[16] = m[3] + m[2]; planes[17] = m[7] + m[6]; planes[18] = m[11] + m[10]; planes[19] = m[15] + m[14];
  planes[20] = m[3] - m[2]; planes[21] = m[7] - m[6]; planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];
  for (let p = 0; p < 24; p += 4) {
    const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
    const len = Math.hypot(a, b, c) || 1;
    if ((a * x + b * y + c * z + d) / len < -r) return false;
  }
  return true;
}
let _planes = null;
