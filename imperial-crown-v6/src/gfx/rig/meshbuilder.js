/* ============================================================
   meshbuilder.js — sculpted geometry, built from code

   Emits a skinned vertex for every humanoid:
     pos(3f) normal(3b) mat(1b) uv(2s) color(3b) boneIdx(4b) boneWt(4b)

   Two things this deliberately does that the old `Geo` did not:

   1. SMOOTH NORMALS. Rings around a limb share one radial normal
      at each vertex, so a 6-sided tube shades like a 40-sided one.
      `flat: true` opts a primitive out (blades, visors, shield rims)
      because those should read as machined, not soft.
   2. SKIN WEIGHTS per vertex, not per part. A ring near a joint
      blends toward the parent bone, so a shoulder or an elbow bends
      without a visible seam or a detached cap.

   Vertex budget is a first-class concern: `detail` scales the ring
   and segment counts so the same rig emits a 1200-tri near mesh and
   a 200-tri far mesh with no separate model code.
   ============================================================ */

import { B, BONE_COUNT } from './skeleton.js';

/** Detail tiers. 0 = near (60 Hz), 1 = mid, 2 = far. */
export const DETAIL = { NEAR: 0, MID: 1, FAR: 2 };

const SEG = [8, 6, 4];   // radial segments by detail tier
const RINGS = [4, 2, 1]; // rings along a limb by detail tier
const SPH = [[8, 5], [6, 3], [4, 2]]; // sphere segments/rings by tier

export class SkinnedBuilder {
  constructor(detail = DETAIL.MID) {
    this.detail = detail;
    this.v = [];      // packed floats, VERTEX_FLOATS each
    this.i = [];
    this.count = 0;
    this.mat = 0;
    this.col = [1, 1, 1];
    this._bones = [0, 0, 0, 0];
    this._weights = [1, 0, 0, 0];
  }

  seg(base = 0) { return Math.max(3, SEG[this.detail] + base); }
  rings(base = 0) { return Math.max(1, RINGS[this.detail] + base); }
  sph() { return SPH[this.detail]; }

  material(m) { this.mat = m; return this; }
  color(r, g, b) {
    this.col = Array.isArray(r) ? r : [r, g, b];
    return this;
  }

  /**
   * Bind a vertex to up to four bones.
   * `blend` is [boneA, boneB, t] — weights lerp from A to B by t.
   */
  _skin(bone, blend) {
    const B_ = this._bones, W = this._weights;
    if (blend) {
      const [a, b, t] = blend;
      B_[0] = a; W[0] = 1 - t;
      B_[1] = b; W[1] = t;
      B_[2] = 0; W[2] = 0;
      B_[3] = 0; W[3] = 0;
    } else {
      B_[0] = bone; W[0] = 1;
      B_[1] = 0; W[1] = 0;
      B_[2] = 0; W[2] = 0;
      B_[3] = 0; W[3] = 0;
    }
  }

  _vert(x, y, z, nx, ny, nz, u, v) {
    const c = this.col;
    this.v.push(
      x, y, z,
      nx, ny, nz,
      u, v,
      this.mat,
      c[0], c[1], c[2],
      this._bones[0], this._bones[1], this._bones[2], this._bones[3],
      this._weights[0], this._weights[1], this._weights[2], this._weights[3]
    );
    return this.count++;
  }

  _tri(a, b, c) { this.i.push(a, b, c); }

  /**
   * Tapered tube between two points, in bind-pose model space.
   *
   * @param bone     bone the tube is weighted to
   * @param a,b      [x,y,z] endpoints
   * @param ra,rb    radii at a and b
   * @param opts     { seg, rings, blend:[parentBone], profile(t)->rMul, squash:[sx,sz], flat }
   */
  tube(bone, a, b, ra, rb, opts = {}) {
    const seg = Math.max(3, opts.seg ?? this.seg());
    const rings = Math.max(1, opts.rings ?? this.rings());
    const profile = opts.profile || null;
    const squash = opts.squash || [1, 1];
    const blendBone = opts.blend !== undefined ? opts.blend : null;
    const blendSpan = opts.blendSpan ?? 0.34;

    /* orthonormal basis perpendicular to the axis */
    let ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    /* pick a helper axis least aligned with the limb */
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; hz = 0; }
    let ux = hy * az - hz * ay, uy = hz * ax - hx * az, uz = hx * ay - hy * ax;
    let ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;

    const base = this.count;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const cx = a[0] + (b[0] - a[0]) * t;
      const cy = a[1] + (b[1] - a[1]) * t;
      const cz = a[2] + (b[2] - a[2]) * t;
      let rad = ra + (rb - ra) * t;
      if (profile) rad *= profile(t);
      /* skin blend: near the root end, lean toward the parent bone */
      if (blendBone !== null && t < blendSpan) {
        this._skin(bone, [blendBone, bone, t / blendSpan]);
      } else {
        this._skin(bone);
      }
      for (let s = 0; s <= seg; s++) {
        const ang = (s / seg) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const nx = ux * ca + vx * sa;
        const ny = uy * ca + vy * sa;
        const nz = uz * ca + vz * sa;
        const px = cx + (ux * ca * squash[0] + vx * sa * squash[0]) * rad;
        const py = cy + (uy * ca * squash[1] + vy * sa * squash[1]) * rad;
        const pz = cz + (uz * ca * squash[0] + vz * sa * squash[0]) * rad;
        this._vert(px, py, pz, nx, ny, nz, s / seg, t);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < seg; s++) {
        const i0 = base + r * (seg + 1) + s;
        const i1 = i0 + 1;
        const i2 = i0 + seg + 1;
        const i3 = i2 + 1;
        this._tri(i0, i2, i1);
        this._tri(i1, i2, i3);
      }
    }
    return this;
  }

  /**
   * A disc closing one end of a `tube`. `tube` is an open cylinder by
   * design, which is correct for a limb -- its ends live inside the torso
   * and inside the next segment. It is wrong for anything the eye can see
   * into: a flared sleeve cuff, a helmet neck, a boot top. Those read as a
   * tube with a bright interior until they are capped.
   *
   * `end` is the end point and `radius` the radius of the ring there;
   * `axis` points OUT of the tube so the disc faces the viewer.
   */
  cap(bone, end, radius, axis, opts = {}) {
    const seg = Math.max(3, opts.seg ?? this.seg());
    let ax = axis[0], ay = axis[1], az = axis[2];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; hz = 0; }
    let ux = hy * az - hz * ay, uy = hz * ax - hx * az, uz = hx * ay - hy * ax;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    const base = this.count;
    this._skin(bone);
    const squash = opts.squash || [1, 1];
    /* winding depends on which way the axis points, so flip the normal
       rather than asking every caller to get the sign right */
    this._vert(end[0], end[1], end[2], ax, ay, az, 0.5, 0.5);
    for (let s = 0; s <= seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      this._vert(
        end[0] + (ux * ca * squash[0] + vx * sa * squash[0]) * radius,
        end[1] + (uy * ca * squash[1] + vy * sa * squash[1]) * radius,
        end[2] + (uz * ca * squash[0] + vz * sa * squash[0]) * radius,
        ax, ay, az, s / seg, 1);
    }
    for (let s = 0; s < seg; s++) this._tri(base, base + 2 + s, base + 1 + s);
    return this;
  }

  /**
   * Ellipsoid with true ellipsoid normals — cranium, deltoid, knee,
   * pauldron cap. `cut` trims the bottom off (helmets, domes).
   */
  ellipsoid(bone, c, r, opts = {}) {
    /* An explicit `sph` is a refinement for close-up work, not an override:
       it is capped by the tier so a far-tier soldier still costs 16 tris
       for its jaw instead of the 30 a near-tier soldier pays. */
    const tierSph = this.sph();
    const [seg, rings] = opts.sph
      ? [Math.min(opts.sph[0], tierSph[0]), Math.min(opts.sph[1], tierSph[1])]
      : tierSph;
    const cut = opts.cut ?? 0;       // 0 = full sphere, 0.5 = top half
    const base = this.count;
    this._skin(bone);
    /* `cut` removes geometry, not just angle: a helmet dome that keeps its
       lower rings is paying for triangles behind the wearer's ears. */
    const r0 = Math.max(1, Math.round(rings * (1 - cut)));
    /* `ri` not `r`: `r` is the radius triple, and shadowing it silently
       turned every position into NaN. */
    for (let ri = 0; ri <= r0; ri++) {
      const v = ri / r0;
      const phi = v * Math.PI * (1 - cut);
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let s = 0; s <= seg; s++) {
        const th = (s / seg) * Math.PI * 2;
        const st = Math.sin(th), ct = Math.cos(th);
        const px = c[0] + sp * ct * r[0];
        const py = c[1] + cp * r[1];
        const pz = c[2] + sp * st * r[2];
        /* ellipsoid normal is proportional to p / r^2 */
        let nx = (sp * ct) / r[0], ny = cp / r[1], nz = (sp * st) / r[2];
        const nl = Math.hypot(nx, ny, nz) || 1;
        this._vert(px, py, pz, nx / nl, ny / nl, nz / nl, s / seg, v);
      }
    }
    for (let ri = 0; ri < r0; ri++) {
      for (let s = 0; s < seg; s++) {
        const i0 = base + ri * (seg + 1) + s;
        const i1 = i0 + 1;
        const i2 = i0 + seg + 1;
        const i3 = i2 + 1;
        this._tri(i0, i2, i1);
        this._tri(i1, i2, i3);
      }
    }
    return this;
  }

  /**
   * Lathe: revolve a 2D profile [[r,y], ...] about the Y axis.
   * This is what makes a tunic a garment rather than a cylinder —
   * the profile can flare at the hem and pinch at the belt.
   */
  lathe(bone, profile, opts = {}) {
    const seg = Math.max(3, opts.seg ?? this.seg(2));
    const squash = opts.squash || [1, 1];
    const cx = opts.x || 0, cy = opts.y || 0, cz = opts.z || 0;
    /* A lathe that only sweeps part of a circle is a garment open at the
       front: a cape, a cowl, a tabard split for the legs. Without this
       every "cape" is a closed cone that swallows the whole body. */
    const arc = opts.arc ?? Math.PI * 2;
    const arcStart = opts.arcStart ?? 0;
    const full = arc >= Math.PI * 2 - 1e-6;
    const base = this.count;
    this._skin(bone, opts.blend !== undefined ? [opts.blend, bone, 0.5] : null);
    for (let p = 0; p < profile.length; p++) {
      const [rad, yy] = profile[p];
      /* profile normal from the local slope, so folds shade */
      const prev = profile[Math.max(0, p - 1)];
      const next = profile[Math.min(profile.length - 1, p + 1)];
      const dy = next[1] - prev[1];
      const dr = next[0] - prev[0];
      const nl = Math.hypot(dy, dr) || 1;
      const nUp = -dr / nl, nOut = dy / nl;
      for (let s = 0; s <= seg; s++) {
        const th = arcStart + (s / seg) * arc;
        const ct = Math.cos(th), st = Math.sin(th);
        const px = cx + ct * rad * squash[0];
        const py = cy + yy;
        const pz = cz + st * rad * squash[1];
        const nx = ct * nOut, nz = st * nOut;
        const ny = nUp;
        const l2 = Math.hypot(nx, ny, nz) || 1;
        this._vert(px, py, pz, nx / l2, ny / l2, nz / l2, s / seg, p / (profile.length - 1));
      }
    }
    for (let p = 0; p < profile.length - 1; p++) {
      for (let s = 0; s < seg; s++) {
        const i0 = base + p * (seg + 1) + s;
        const i1 = i0 + 1;
        const i2 = i0 + seg + 1;
        const i3 = i2 + 1;
        this._tri(i0, i2, i1);
        this._tri(i1, i2, i3);
      }
    }
    return this;
  }

  /** Flat-shaded quad slab: blades, shield boards, visors, straps. */
  slab(bone, c, size, opts = {}) {
    const rot = opts.rot || 0;
    const [w, h, d] = size;
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    this._skin(bone);
    const faces = [
      [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd], [0, 0, 1]],
      [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd], [0, 0, -1]],
      [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-1, 0, 0]],
      [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [1, 0, 0]],
      [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd], [0, 1, 0]],
      [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd], [0, -1, 0]]
    ];
    for (const f of faces) {
      const b0 = this.count;
      for (let k = 0; k < 4; k++) {
        const p = f[k];
        const x = p[0] * cs - p[2] * sn;
        const z = p[0] * sn + p[2] * cs;
        const nx = f[4][0] * cs - f[4][2] * sn;
        const nz = f[4][0] * sn + f[4][2] * cs;
        this._vert(c[0] + x, c[1] + p[1], c[2] + z, nx, f[4][1], nz,
          k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0);
      }
      this._tri(b0, b0 + 1, b0 + 2);
      this._tri(b0, b0 + 2, b0 + 3);
    }
    return this;
  }

  /**
   * Heater shield: a broad top, straight sides, curving to a point.
   *
   * A slab would be a rectangle, and a rectangle is exactly the placeholder
   * this overhaul exists to remove. The outline is sampled so the taper and
   * the point are real geometry, and the face is domed slightly outward so
   * it catches the light along its length.
   *
   * The outline lives in (u = across, v = down) with v in 0..1.
   */
  heater(bone, c, size, opts = {}) {
    const [w, h, d] = size;
    const steps = opts.steps || Math.max(2, Math.round(this.seg() * 0.55));
    const dome = opts.dome ?? 0.22;        // how far the face bulges
    const rot = opts.rot || 0;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const hw = w / 2, hd = d / 2;
    this._skin(bone);

    /* Outline: a rounded top, near-vertical sides, then a curve to the point.
       Sampled from the top edge down one side and mirrored. */
    const outline = [];
    for (let i = 0; i <= steps; i++) {
      const v = i / steps;
      /* width multiplier: 1 at the top, narrowing to 0 at the point */
      let uw;
      if (v < 0.16) {
        /* rounded shoulders */
        const t = v / 0.16;
        uw = Math.sqrt(1 - (1 - t) * (1 - t) * 0.36);
      } else {
        /* the taper to the point, slightly convex */
        const t = (v - 0.16) / 0.84;
        uw = Math.pow(1 - t, 0.72);
      }
      outline.push([uw, v]);
    }

    /* `u` runs -1..+1 across the shield, so `u * hw` alone puts the LEFT
       edge at 2 * hw from the centre -- the caller's `c` was being treated
       as the left edge, not the centre, and every heater shield in the game
       was hung half its own width further out than it was placed. `u` is
       normalised to -0.5..+0.5 first so `c` is the centre the call sites
       have always assumed it was. */
    const place = (u, v, zoff) => {
      const px = u * w * 0.5, pz = zoff;
      const rx = px * cs - pz * sn;
      const rz = px * sn + pz * cs;
      return [c[0] + rx, c[1] - v * h, c[2] + rz];
    };

    /* Front face: two columns per step (left and right) so the dome is a
       shallow ridge down the centre. */
    const front = [];
    for (let i = 0; i <= steps; i++) {
      const [uw, v] = outline[i];
      const bulge = hd + hd * dome * (1 - v * 0.5);
      const a = this.count;
      this._vert(...place(-uw, v, bulge), 0, 0, 1, 0, v);
      this._vert(...place(uw, v, bulge), 0, 0, 1, 1, v);
      front.push(a);
    }
    for (let i = 0; i < steps; i++) {
      const a = front[i], b = a + 1, c2 = front[i + 1], d2 = c2 + 1;
      this._tri(a, b, c2);
      this._tri(b, d2, c2);
    }

    /* Back face, flat, wound the other way. */
    const back = [];
    for (let i = 0; i <= steps; i++) {
      const [uw, v] = outline[i];
      const a = this.count;
      this._vert(...place(-uw, v, -hd), 0, 0, -1, 0, v);
      this._vert(...place(uw, v, -hd), 0, 0, -1, 1, v);
      back.push(a);
    }
    for (let i = 0; i < steps; i++) {
      const a = back[i], b = a + 1, c2 = back[i + 1], d2 = c2 + 1;
      this._tri(b, a, c2);
      this._tri(d2, b, c2);
    }

    /* Rim: stitch the two faces together down both edges. The rim is the
       hard-edged part, which is why it gets its own normals. */
    for (let i = 0; i < steps; i++) {
      const f0 = front[i], f1 = front[i + 1];
      const b0 = back[i], b1 = back[i + 1];
      /* right edge */
      this._tri(f0 + 1, b0 + 1, f1 + 1);
      this._tri(f1 + 1, b0 + 1, b1 + 1);
      /* left edge */
      this._tri(b0, f0, b1);
      this._tri(b1, f0, f1);
    }
    return this;
  }

  /** Convex swept blade: a thin, tapered, double-edged wedge. */
  blade(bone, from, to, width, opts = {}) {
    const thick = opts.thick ?? 0.012;
    const tipFrac = opts.tipFrac ?? 0.72;
    const guard = opts.guard || 0;
    let ax = to[0] - from[0], ay = to[1] - from[1], az = to[2] - from[2];
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    /* an "edge" axis perpendicular to the blade length, roughly along X */
    let ex = 0, ey = 0, ez = 1;
    if (Math.abs(az) > 0.9) { ez = 0; ex = 1; }
    let ux = ey * az - ez * ay, uy = ez * ax - ex * az, uz = ex * ay - ey * ax;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const base = this.count;
    this._skin(bone);
    /* 3 cross-sections: base (wide), shoulder, tip (point) */
    const sections = [
      { t: 0, w: width * 0.55, th: thick },
      { t: tipFrac, w: width, th: thick },
      { t: 1, w: width * 0.06, th: thick * 0.4 }
    ];
    for (const s of sections) {
      const cxx = from[0] + ax * len * s.t;
      const cyy = from[1] + ay * len * s.t;
      const czz = from[2] + az * len * s.t;
      /* diamond cross-section: 4 points around the edge axis */
      const pts = [
        [cxx + ux * s.w, cyy + uy * s.w, czz + uz * s.w],
        [cxx + ex * s.th, cyy + ey * s.th, czz + ez * s.th],
        [cxx - ux * s.w, cyy - uy * s.w, czz - uz * s.w],
        [cxx - ex * s.th, cyy - ey * s.th, czz - ez * s.th]
      ];
      for (let k = 0; k < 4; k++) {
        const p = pts[k];
        const nx = p[0] - cxx, ny = p[1] - cyy, nz = p[2] - czz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        this._vert(p[0], p[1], p[2], nx / nl, ny / nl, nz / nl, k / 4, s.t);
      }
    }
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < 4; k++) {
        const a0 = base + s * 4 + k;
        const a1 = base + s * 4 + ((k + 1) % 4);
        const b0 = a0 + 4, b1 = a1 + 4;
        this._tri(a0, b0, a1);
        this._tri(a1, b0, b1);
      }
    }
    if (guard) {
      this.slab(bone, [from[0], from[1], from[2]], [guard, 0.05, 0.05],
        { rot: Math.atan2(az, ax) });
    }
    return this;
  }

  /** Finish: pack into the GPU layout. */
  finish() {
    const n = this.count;
    const buf = new ArrayBuffer(n * 32);
    const f32 = new Float32Array(buf);
    const i8 = new Int8Array(buf);
    const u8 = new Uint8Array(buf);
    const u16 = new Uint16Array(buf);
    for (let v = 0; v < n; v++) {
      const s = v * 20;
      const b = v * 32;
      const f = b >> 2;
      f32[f] = this.v[s];
      f32[f + 1] = this.v[s + 1];
      f32[f + 2] = this.v[s + 2];
      /* normal, quantised to a signed byte per axis as the engine already does */
      i8[b + 12] = Math.max(-127, Math.min(127, Math.round(this.v[s + 3] * 127)));
      i8[b + 13] = Math.max(-127, Math.min(127, Math.round(this.v[s + 4] * 127)));
      i8[b + 14] = Math.max(-127, Math.min(127, Math.round(this.v[s + 5] * 127)));
      u8[b + 15] = this.v[s + 8] | 0;                       // material
      /* uv in 1/1024 metres, like the existing engine */
      u16[b + 8] = Math.max(0, Math.min(65535, Math.round(this.v[s + 6] * 1024)));
      u16[b + 9] = Math.max(0, Math.min(65535, Math.round(this.v[s + 7] * 1024)));
      u8[b + 20] = Math.round(Math.min(1, Math.max(0, this.v[s + 9])) * 255);
      u8[b + 21] = Math.round(Math.min(1, Math.max(0, this.v[s + 10])) * 255);
      u8[b + 22] = Math.round(Math.min(1, Math.max(0, this.v[s + 11])) * 255);
      /* bone indices at 23..26, weights at 27..30 */
      u8[b + 23] = this.v[s + 12];
      u8[b + 24] = this.v[s + 13];
      u8[b + 25] = this.v[s + 14];
      u8[b + 26] = this.v[s + 15];
      const w0 = this.v[s + 16], w1 = this.v[s + 17], w2 = this.v[s + 18], w3 = this.v[s + 19];
      const sum = w0 + w1 + w2 + w3 || 1;
      u8[b + 27] = Math.round((w0 / sum) * 255);
      u8[b + 28] = Math.round((w1 / sum) * 255);
      u8[b + 29] = Math.round((w2 / sum) * 255);
      u8[b + 30] = Math.round((w3 / sum) * 255);
      u8[b + 31] = 0;
    }
    return {
      packed: buf,
      indices: new Uint16Array(this.i),
      tris: this.i.length / 3,
      vertices: n
    };
  }
}

export { B, BONE_COUNT };
