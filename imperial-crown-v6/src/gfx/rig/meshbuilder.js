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

/* Radial segments by detail tier.
   FAR is 3, not 4. A unit at strategic zoom is about 25 pixels tall and its
   limbs are two or three pixels across; the fourth segment of a thigh is
   entirely inside its own silhouette. Three still closes a tube (a triangle
   is the minimum) and it is 25% off every tube and every lathe in the rig --
   which is where the far tier's whole budget goes, and far is 43% of a
   300-unit army. */
const SEG = [8, 6, 3];   // radial segments by detail tier
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
  /* ----------------------------------------------------------------
     SKIRT: cloth hanging off a body that runs along Z.

     `lathe` revolves about Y, so it cannot make a drape over a horse: a
     barrel lies along Z and a Y-lathe over it is a cone standing on its
     point beside the animal. This is the same sweep with two changes --
     the rings advance along the Z axis, and the radius is an ELLIPSE whose
     vertical semi-axis may differ from its horizontal one, because a horse
     is narrow and deep and a circle section reads as a barrel.

     Rings run front to back, the arc is centred on the back (theta = -PI/2,
     matching every other garment in the rig), and `folds` ripples the radius
     around the sweep so the hem is not a machined edge.

       skirt(bone, [[z, y, rH, rV], ...], opts)
     ---------------------------------------------------------------- */
  skirt(bone, profile, opts = {}) {
    const seg = Math.max(3, opts.seg ?? this.seg());
    const arc = opts.arc ?? Math.PI * 2;
    const arcStart = opts.arcStart ?? 0;
    const folds = opts.folds || 0;
    const foldDepth = opts.foldDepth ?? 0.07;
    const base = this.count;
    for (let r = 0; r < profile.length; r++) {
      const [zc, yc, rH, rV] = profile[r];
      const v = profile.length > 1 ? r / (profile.length - 1) : 1;
      for (let s = 0; s <= seg; s++) {
        const th = arcStart + (s / seg) * arc;
        const fold = folds ? 1 + foldDepth * v * Math.cos(th * folds) : 1;
        const ca = Math.cos(th), sa = Math.sin(th);
        const px = rH * fold * ca;
        const py = yc - rV * fold * sa;
        const pz = zc;
        /* radial normal, tilted by the profile's own slope in Z so a
           tapering panel shades as a cone rather than as a cylinder */
        let nx = ca / Math.max(0.05, rH);
        let ny = -sa / Math.max(0.05, rV);
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        this._vert(px, py, pz, nx, ny, 0, s / seg, v);
      }
    }
    for (let r = 0; r + 1 < profile.length; r++) {
      for (let s = 0; s < seg; s++) {
        const i0 = base + r * (seg + 1) + s;
        const i1 = i0 + 1;
        const i2 = i0 + seg + 1;
        const i3 = i2 + 1;
        this._tri(i0, i2, i1);
        this._tri(i1, i2, i3);
      }
    }
    this._skin(bone);
    return this;
  }

  /* ----------------------------------------------------------------
     LOFT: skin a stack of hand-authored 2D cross-sections along Z.

     Neither `lathe` (revolves about Y) nor `tube` (a circle about an
     arbitrary axis) can describe cloth hanging over a horse, because a
     trapper is NOT a surface of revolution about anything: its section goes
     up the spine, over the top of the barrel, out past the flank and then
     straight DOWN to the hem. Authoring that as a radial ellipse was four
     failed passes -- the elliptical form turns back in under the belly and
     the cloth ends up as a diaper.

     With a loft the section is just a polyline, so the vertical fall of the
     hem is stated instead of derived.

       loft(bone, [{ z, pts: [[x, y], ...] }, ...], opts)

     `pts` must be the same length in every section. Normals are the
     outward normal of the local section tangent, so a panel shades like the
     curves it actually has and a fold shades as a fold.
     ---------------------------------------------------------------- */
  loft(bone, sections, opts = {}) {
    const n = sections.length;
    if (n < 2) return this;
    const m = sections[0].pts.length;
    const base = this.count;

    /* SWEEP ABOUT Z, WITH THE NORMAL TAKEN FROM THE SURFACE ITSELF.

       A horse's barrel runs along Z, so (x, y) sections at successive Z are
       true cross-sections of the animal, and the quad between two of them is
       a patch of its surface. `lathe` revolves about Y and cannot cover a
       body lying along Z at all, which is why a caparison could never be a
       lathe.

       The normal is NOT the section's 2D normal. That version broke on the
       mirrored flank: reflecting a section in X flips its handedness, so the
       2D normal came out pointing inward on one side only, and no amount of
       flipping the winding could fix both sides at once -- each attempt
       fixed one flank and blanked the other, four times.

       Here the normal is the true surface normal, cross(dP/dk, dP/dr),
       measured from the actual neighbouring vertices. That is correct under
       any mirroring, because it is derived from the geometry rather than
       from a convention about how the points were written down.

       It is then pointed OUTWARD explicitly, away from the body's axis --
       `opts.axis` is the point the drape hangs over -- so a garment is never
       drawn inside-out however its sections happen to be ordered. */
    const axis = opts.axis || [0, 0];
    const ring = [];
    for (let r = 0; r < n; r++) {
      const { z, pts } = sections[r];
      const prev = sections[Math.max(0, r - 1)];
      const next = sections[Math.min(n - 1, r + 1)];
      const row = [];
      for (let k = 0; k < m; k++) {
        const a = pts[Math.max(0, k - 1)];
        const b = pts[Math.min(m - 1, k + 1)];
        const ap = prev.pts[k], bp = next.pts[k];
        /* dP/dk and dP/dr */
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = 0;
        const vx = bp[0] - ap[0], vy = bp[1] - ap[1], vz = next.z - prev.z;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        /* outward: away from the axis the cloth hangs over */
        const ox = pts[k][0] - axis[0];
        const oy = pts[k][1] - axis[1];
        if (nx * ox + ny * oy < 0) { nx = -nx; ny = -ny; nz = -nz; }
        row.push([nx, ny, nz]);
      }
      ring.push(row);
    }
    for (let r = 0; r < n; r++) {
      const v = n > 1 ? r / (n - 1) : 0;
      for (let k = 0; k < m; k++) {
        const [nx, ny, nz] = ring[r][k];
        this._vert(sections[r].pts[k][0], sections[r].pts[k][1], sections[r].z,
          nx, ny, nz, m > 1 ? k / (m - 1) : 0, v);
      }
    }
    /* WINDING made consistent with those normals: take one quad, cross two
       edges, and compare with the normal authored for its first corner. */
    let flipAll = false;
    if (m > 1) {
      const P = this.v, S = 20;
      const i0 = base, i1 = base + 1, i2 = base + m;
      const ax = P[i1 * S] - P[i0 * S];
      const ay = P[i1 * S + 1] - P[i0 * S + 1];
      const az = P[i1 * S + 2] - P[i0 * S + 2];
      const bx = P[i2 * S] - P[i0 * S];
      const by = P[i2 * S + 1] - P[i0 * S + 1];
      const bz = P[i2 * S + 2] - P[i0 * S + 2];
      const gx = ay * bz - az * by;
      const gy = az * bx - ax * bz;
      const gz = ax * by - ay * bx;
      flipAll = (gx * P[i0 * S + 3] + gy * P[i0 * S + 4] + gz * P[i0 * S + 5]) < 0;
    }
    for (let r = 0; r + 1 < n; r++) {
      for (let k = 0; k + 1 < m; k++) {
        const i0 = base + r * m + k;
        const i1 = i0 + 1;
        const i2 = i0 + m;
        const i3 = i2 + 1;
        if (flipAll) {
          this._tri(i0, i2, i1);
          this._tri(i1, i2, i3);
        } else {
          this._tri(i0, i1, i2);
          this._tri(i1, i3, i2);
        }
      }
    }
    this._skin(bone);
    return this;
  }

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
    /* Radius scale, so a shield can be an ellipse (a round shield is a
       disc, not a sphere) without the caller having to fake it with three
       separate non-uniform radii. */

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
    /* `folds` makes the radius wander around the sweep. A garment as a body
       of revolution has a perfectly smooth silhouette, which is why a cape
       seen from behind read as a barrel and a gown rather than as cloth.
       The wander is a cosine of an integer multiple of the angle, so it
       closes exactly at the seam, and it grows down the profile: cloth is
       gathered at the shoulder and slack at the hem. */
    const folds = opts.folds || 0;
    const foldDepth = opts.foldDepth ?? 0.085;
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
      const v = p / (profile.length - 1);
      for (let s = 0; s <= seg; s++) {
        const th = arcStart + (s / seg) * arc;
        const ct = Math.cos(th), st = Math.sin(th);
        let rr = rad, rp = 0;
        if (folds) {
          const amp = foldDepth * v;
          rr = rad * (1 + amp * Math.cos(th * folds));
          /* d(radius)/d(theta): the fold's own slope. Without this the
             ridge moves but its shading does not, so the surface stays
             perfectly smooth and the folds are invisible. */
          rp = -rad * amp * folds * Math.sin(th * folds);
        }
        const px = cx + ct * rr * squash[0];
        const py = cy + yy;
        const pz = cz + st * rr * squash[1];
        /* outward normal of the swept curve, then tilted by the profile
           slope -- the same nOut/nUp split as before */
        let hnx = ct * rr + st * rp;
        let hnz = st * rr - ct * rp;
        const hl = Math.hypot(hnx, hnz) || 1;
        hnx /= hl; hnz /= hl;
        const nx = hnx * nOut, nz = hnz * nOut;
        const ny = nUp;
        const l2 = Math.hypot(nx, ny, nz) || 1;
        this._vert(px, py, pz, nx / l2, ny / l2, nz / l2, s / seg, v);
      }
    }
    /* Winding follows the direction the profile RUNS, and getting it wrong is
       invisible in a vertex dump: the lathe is there, the vertices are
       right, the normals point outwards, and the surface simply does not
       draw. The great helm rendered as a hollow shell with the skull visible
       through it for exactly this reason, and so did every kettle hat -- a
       white shell with a black polygon inside, which read as a tiny flat hat
       slicing through a bald head. Both profiles were written bottom-up
       while every garment in the file is written top-down.
       So detect it instead of remembering it. A profile that ascends has to
       be wound the other way; there is no call site that wants to choose. */
    /* COMPUTE THE WINDING FROM THE GEOMETRY. Do not guess it from the
       profile's direction.

       Every previous rule here -- "ascending profiles are flipped", then
       "ascending AND growing radius are flipped" -- was a heuristic fitted
       to the handful of call sites that happened to be broken at the time.
       All of them are wrong for some real profile, and the failure mode is
       the nastiest kind: the surface is present, its normals point the right
       way, and it simply is not drawn, so a closed helmet reads as a
       transparent shell with the face showing through the steel.

       The rule that is actually correct is arithmetic. A quad is wound the
       way that agrees with the NORMALS this function has just computed --
       those normals are (outward radial, profile slope), and every caller
       relies on them, so the triangles are the only thing that can be
       wrong. Take the first quad, build its two cross products, and pick
       whichever ordering agrees with the normal it was given. That is
       correct for every profile, closed or open, ascending or descending,
       any arc, any fold. */
    let flip = !!opts.flip;
    if (opts.flip === undefined && seg >= 1 && this.count - base > 1) {
      const S = 20;
      const P = (i) => [this.v[i * S], this.v[i * S + 1], this.v[i * S + 2]];
      const A = P(base), Bq = P(base + 1), Cq = P(base + seg + 1);
      const e1 = [Bq[0] - A[0], Bq[1] - A[1], Bq[2] - A[2]];
      const e2 = [Cq[0] - A[0], Cq[1] - A[1], Cq[2] - A[2]];
      const cx = e1[1] * e2[2] - e1[2] * e2[1];
      const cy = e1[2] * e2[0] - e1[0] * e2[2];
      const cz = e1[0] * e2[1] - e1[1] * e2[0];
      const nAt = (i) => [this.v[i * S + 3], this.v[i * S + 4], this.v[i * S + 5]];
      const nA = nAt(base), nB = nAt(base + 1), nC = nAt(base + seg + 1);
      const nrx = nA[0] + nB[0] + nC[0];
      const nry = nA[1] + nB[1] + nC[1];
      const nrz = nA[2] + nB[2] + nC[2];
      /* the ordering below is (i0, i2, i1), so its face normal is -cross */
      flip = (cx * nrx + cy * nry + cz * nrz) > 0;
    }
    for (let p = 0; p < profile.length - 1; p++) {
      for (let s = 0; s < seg; s++) {
        const i0 = base + p * (seg + 1) + s;
        const i1 = i0 + 1;
        const i2 = i0 + seg + 1;
        const i3 = i2 + 1;
        if (flip) {
          this._tri(i0, i1, i2);
          this._tri(i1, i3, i2);
        } else {
          this._tri(i0, i2, i1);
          this._tri(i1, i2, i3);
        }
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
    /* Six steps at near, from `seg * 0.55` = 4.4 rounded to 4 -- but the
       steps also set the FACE grid, so this is the resolution of the shield's
       dome and its heraldic border, and four was visibly faceted on a 470 mm
       board. Kept at five at mid, where the board is 20 px tall. */
    const steps = opts.steps || (this.detail === 0 ? 4 : this.detail === 1 ? 4 : 3);
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

    /* ---------- RIM ----------
       A plain board with a painted face is a plank. Every real shield has an
       iron rim, and the rim is what you see at gameplay distance -- it draws
       the outline. A band of the same outline, pushed a millimetre past the
       face, scaled a hair outward and stepped in from the edge, gives a
       raised border without needing a second material: callers set the
       material before calling, and the caller sets it again after. */
    if (opts.rim !== false && this.detail <= 1) {
      const prevMat = this.mat;
      const prevCol = this.col ? this.col.slice() : null;
      this.material(2).color(0.52, 0.54, 0.58);   /* PLATE */
      const inset = 0.86;
      const rimZ = hd + hd * dome * 1.02;
      const rim = [];
      for (let i = 0; i <= steps; i++) {
        const [uw, v] = outline[i];
        const a = this.count;
        this._vert(...place(-uw * 1.01, v, rimZ + hd * 0.05), 0, 0, 1, 0, v);
        this._vert(...place(uw * 1.01, v, rimZ + hd * 0.05), 0, 0, 1, 1, v);
        this._vert(...place(-uw * inset, v, rimZ), 0, 0, 1, 0, v);
        this._vert(...place(uw * inset, v, rimZ), 0, 0, 1, 1, v);
        rim.push(a);
      }
      for (let i = 0; i < steps; i++) {
        const a = rim[i], b = rim[i + 1];
        /* left band: outer -> inner */
        this._tri(a, b, a + 2);
        this._tri(b, b + 2, a + 2);
        /* right band */
        this._tri(b + 1, a + 1, a + 3);
        this._tri(b + 1, a + 3, b + 3);
      }
      /* ---------- BOSS ----------
         The iron dome at the centre, where a shield takes the hit. */
      const bossY = c[1] - h * 0.30;
      const bossZ = hd + hd * dome * 1.1;
      this.ellipsoid(opts.bone || bone, [c[0], bossY, c[2] + bossZ],
        [w * 0.13, w * 0.13, hd * 1.5], { sph: [5, 3] });
      this.mat = prevMat;
      if (prevCol) this.col = prevCol;
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
    /* Cross-sections along the blade. The default three -- narrow at the
       base, full width at the shoulder, a point at the tip -- is a TAPER
       from the hilt, so every sword read as a spike growing out of the
       hand. A blade is parallel-sided for nearly its whole length and then
       points over the last sixth, which is what `sections` is for. */
    const sections = opts.sections || [
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
    for (let s = 0; s < sections.length - 1; s++) {
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
