/* ============================================================
   geo.js — procedural mesh builder
   Emits the 16-float vertex the GPU layer expects:
     pos(3) normal(3) uv(2) mat(1) color(3) pivot(3) part(1)
   UVs are in *metres divided by the material's tile size*, so a
   stone wall and a plank wall both tile at their real-world scale
   with a single texture array.
   ============================================================ */

/* Layer order MUST match src/gfx/textures.js MAT (16 layers). */
export const M = {
  STONE: 0, STONE_LIGHT: 1, PLASTER: 2, WOOD: 3, WOOD_DARK: 4, ROOF: 5, THATCH: 6,
  CLOTH: 7, IRON: 8, GOLD: 9, MARBLE: 10, BRICK: 11, GLASS: 12, GRAVEL: 13,
  LEATHER: 14, LEAF: 15, SKIN: 16,
  // aliases used by the models
  TILE: 5, METAL: 8, DIRT: 13, BARK: 4, ICE: 12, GLOW: 12, SNOW: 1
};

/** 1 texture repeat per this many metres, per material. */
export const MAT_SCALE = [2.2, 2.4, 1.7, 1.2, 1.1, 1.5, 1.9, 1.3, 0.9, 1.0, 2.4, 1.6, 1.0, 2.0, 1.0, 1.5, 0.35];

export const PART = { BODY: 0, LEG_L: 1, LEG_R: 2, ARM_L: 3, ARM_R: 4, EXTRA: 5 };

const TAU = Math.PI * 2;

export class Geo {
  constructor(estimate = 512) {
    this.v = [];
    this.i = [];
    this.count = 0;
    this.part = 0;
    this.px = 0; this.py = 0; this.pz = 0;
    this.mat = M.STONE;
    this.col = [1, 1, 1];
    this.scale = MAT_SCALE[0];
  }

  part_(index, x = 0, y = 0, z = 0) {
    this.part = index;
    this.px = x; this.py = y; this.pz = z;
    return this;
  }
  material(mat) { this.mat = mat; this.scale = MAT_SCALE[mat] || 1; return this; }
  color(r, g, b) {
    if (Array.isArray(r)) { this.col = r; } else this.col = [r, g, b];
    return this;
  }
  tint(v) {
    const s = this.scale;
    this.col = [v, v, v];
    return this;
  }

  _vert(x, y, z, nx, ny, nz, u, v) {
    const s = this.scale;
    const c = this.col;
    this.v.push(
      x, y, z,
      nx, ny, nz,
      u / s, v / s,
      this.mat,
      c[0], c[1], c[2],
      this.px, this.py, this.pz,
      this.part
    );
    return this.count++;
  }

  /** Triangle with automatic face normal. */
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, ua, va, ub, vb, uc, vc) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this._vert(ax, ay, az, nx, ny, nz, ua || 0, va || 0);
    this._vert(bx, by, bz, nx, ny, nz, ub || 0, vb || 0);
    this._vert(cx, cy, cz, nx, ny, nz, uc || 0, vc || 0);
    this.i.push(i0, i0 + 1, i0 + 2);
    return this;
  }

  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, uvs) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const u = uvs || [0, 0, 1, 0, 1, 1, 0, 1];
    const i0 = this._vert(ax, ay, az, nx, ny, nz, u[0], u[1]);
    this._vert(bx, by, bz, nx, ny, nz, u[2], u[3]);
    this._vert(cx, cy, cz, nx, ny, nz, u[4], u[5]);
    this._vert(dx, dy, dz, nx, ny, nz, u[6], u[7]);
    this.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    return this;
  }

  /* ---------------- primitives ---------------- */
  /** Axis-aligned box centred at (x,y,z). opts: rotY, uvScale */
  box(x, y, z, w, h, d, opts = {}) {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const r = opts.rotY || 0;
    const c = Math.cos(r), s = Math.sin(r);
    const P = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
    const uv = opts.uv || null;
    // +X
    let a = P(hw, -hh, -hd), b = P(hw, hh, -hd), cc = P(hw, hh, hd), dd = P(hw, -hh, hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, 0, h, d, h, d, 0]);
    // -X
    a = P(-hw, -hh, hd); b = P(-hw, hh, hd); cc = P(-hw, hh, -hd); dd = P(-hw, -hh, -hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, 0, h, d, h, d, 0]);
    // +Y
    a = P(-hw, hh, hd); b = P(hw, hh, hd); cc = P(hw, hh, -hd); dd = P(-hw, hh, -hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, w, 0, w, d, 0, d]);
    // -Y
    a = P(-hw, -hh, -hd); b = P(hw, -hh, -hd); cc = P(hw, -hh, hd); dd = P(-hw, -hh, hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, w, 0, w, d, 0, d]);
    // +Z (a → d → c → b keeps the normal pointing out of the face)
    a = P(-hw, -hh, hd); b = P(hw, -hh, hd); cc = P(hw, hh, hd); dd = P(-hw, hh, hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, w, 0, w, h, 0, h]);
    // -Z
    a = P(hw, -hh, -hd); b = P(-hw, -hh, -hd); cc = P(-hw, hh, -hd); dd = P(hw, hh, -hd);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], uv || [0, 0, w, 0, w, h, 0, h]);
    return this;
  }

  /** Box with a smaller top face (tapered tower / plinth). */
  taperBox(x, y, z, w, h, d, topW, topD, opts = {}) {
    const hw = w / 2, hd = d / 2, hh = h / 2;
    const tw = topW / 2, td = topD / 2;
    const r = opts.rotY || 0;
    const c = Math.cos(r), s = Math.sin(r);
    const P = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
    const b0 = P(-hw, -hh, -hd), b1 = P(hw, -hh, -hd), b2 = P(hw, -hh, hd), b3 = P(-hw, -hh, hd);
    const t0 = P(-tw, hh, -td), t1 = P(tw, hh, -td), t2 = P(tw, hh, td), t3 = P(-tw, hh, td);
    this.quad(b1[0], b1[1], b1[2], t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], b2[0], b2[1], b2[2], [0, 0, 0, h, d, h, d, 0]);
    this.quad(b3[0], b3[1], b3[2], t3[0], t3[1], t3[2], t0[0], t0[1], t0[2], b0[0], b0[1], b0[2], [0, 0, 0, h, d, h, d, 0]);
    this.quad(b0[0], b0[1], b0[2], t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], b1[0], b1[1], b1[2], [0, 0, 0, h, w, h, w, 0]);
    this.quad(b2[0], b2[1], b2[2], t2[0], t2[1], t2[2], t3[0], t3[1], t3[2], b3[0], b3[1], b3[2], [0, 0, 0, h, w, h, w, 0]);
    this.quad(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], t3[0], t3[1], t3[2], [0, 0, topW, 0, topW, topD, 0, topD]);
    this.quad(b0[0], b0[1], b0[2], b3[0], b3[1], b3[2], b2[0], b2[1], b2[2], b1[0], b1[1], b1[2], [0, 0, w, 0, w, d, 0, d]);
    return this;
  }

  /* `opts.axis` lays the cylinder along X or Z instead of Y. `opts.rot` is the
     angular start (a UV seam offset), *not* a tip-over: a log, a cannon barrel
     and a cart axle were all written as { rot: Math.PI / 2 } in the belief that
     it rotated them, which is why every log pile in the game stood on end. */
  cyl(x, y, z, rTop, rBot, h, seg = 8, opts = {}) {
    const capTop = opts.capTop !== false, capBottom = opts.capBottom === true;
    const rot = opts.rot || 0;
    const axis = opts.axis || 'y';
    /* Proper rotations (det +1) so the winding -- and with it the face normals
       -- stay outward-facing: Rz(-90) sends local +Y to +X, Rx(+90) sends it
       to +Z. */
    const M = axis === 'x' ? (lx, ly, lz) => [x + ly, y - lx, z + lz]
      : axis === 'z' ? (lx, ly, lz) => [x + lx, y - lz, z + ly]
        : (lx, ly, lz) => [x + lx, y + ly, z + lz];
    for (let i = 0; i < seg; i++) {
      const a0 = rot + (i / seg) * TAU;
      const a1 = rot + ((i + 1) / seg) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const b0 = M(c0 * rBot, 0, s0 * rBot);
      const b1 = M(c1 * rBot, 0, s1 * rBot);
      const t0 = M(c0 * rTop, h, s0 * rTop);
      const t1 = M(c1 * rTop, h, s1 * rTop);
      const u0 = (i / seg) * TAU * Math.max(rTop, rBot), u1 = ((i + 1) / seg) * TAU * Math.max(rTop, rBot);
      this.quad(b0[0], b0[1], b0[2], t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], b1[0], b1[1], b1[2], [u0, 0, u0, h, u1, h, u1, 0]);
      if (capTop && rTop > 0.001) {
        const c = M(0, h, 0);
        this.tri(c[0], c[1], c[2], t1[0], t1[1], t1[2], t0[0], t0[1], t0[2], 0, 0, 1, 0, 0, 1);
      }
      if (capBottom && rBot > 0.001) {
        const c = M(0, 0, 0);
        this.tri(c[0], c[1], c[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], 0, 0, 0, 1, 1, 1);
      }
    }
    return this;
  }

  cone(x, y, z, r, h, seg = 8, opts = {}) {
    return this.cyl(x, y, z, 0, r, h, seg, { ...opts, capTop: false });
  }

  sphere(x, y, z, r, seg = 8, rings = 5) {
    // Pole rows are emitted as triangle fans: a quad whose top edge has zero
    // length has a zero-area normal and renders black on real drivers.
    for (let j = 0; j < rings; j++) {
      const p0 = (j / rings) * Math.PI;
      const p1 = ((j + 1) / rings) * Math.PI;
      const y0 = y + Math.cos(p0) * r;
      const y1 = y + Math.cos(p1) * r;
      const r0 = Math.sin(p0) * r;
      const r1 = Math.sin(p1) * r;
      const v0 = (j / rings) * Math.PI * r;
      const v1 = ((j + 1) / rings) * Math.PI * r;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const u0 = (i / seg) * TAU * r, u1 = ((i + 1) / seg) * TAU * r;
        const ax = x + c0 * r0, az = z + s0 * r0;
        const bx = x + c1 * r0, bz = z + s1 * r0;
        const cx = x + c1 * r1, cz = z + s1 * r1;
        const dx = x + c0 * r1, dz = z + s0 * r1;
        if (r0 < 1e-4) {
          this.tri(x, y0, z, cx, y1, cz, dx, y1, dz, u0, v0, u1, v1, u0, v1);
        } else if (r1 < 1e-4) {
          this.tri(ax, y0, az, bx, y0, bz, x, y1, z, u0, v0, u1, v0, u0, v1);
        } else {
          this.quad(ax, y0, az, bx, y0, bz, cx, y1, cz, dx, y1, dz, [u0, v0, u1, v0, u1, v1, u0, v1]);
        }
      }
    }
    return this;
  }

  gable(x, y, z, w, h, d, opts = {}) {
    const hw = w / 2, hd = d / 2;
    const rot = opts.rotY || 0;
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
    const a = P(-hw, 0, -hd), b = P(hw, 0, -hd), cc = P(hw, 0, hd), dd = P(-hw, 0, hd);
    const r0 = P(0, h, -hd), r1 = P(0, h, hd);
    const slope = Math.hypot(hw, h);
    this.quad(a[0], a[1], a[2], r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], dd[0], dd[1], dd[2], [0, 0, slope, 0, slope, d, 0, d]);
    this.quad(cc[0], cc[1], cc[2], r1[0], r1[1], r1[2], r0[0], r0[1], r0[2], b[0], b[1], b[2], [0, 0, slope, 0, slope, d, 0, d]);
    // gable end triangles
    this.tri(a[0], a[1], a[2], cc[0], cc[1], cc[2], b[0], b[1], b[2], 0, 0, 1, 0, 0, 1);
    this.tri(dd[0], dd[1], dd[2], a[0], a[1], a[2], r1[0], r1[1], r1[2], 0, 0, 1, 0, 0, 1);
    return this;
  }

  /** Four-sided hip roof. */
  hip(x, y, z, w, h, d, opts = {}) {
    const hw = w / 2, hd = d / 2;
    const ridge = opts.ridge ?? d * 0.25;
    const rot = opts.rotY || 0;
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
    const a = P(-hw, 0, -hd), b = P(hw, 0, -hd), cc = P(hw, 0, hd), dd = P(-hw, 0, hd);
    const r0 = P(0, h, -ridge), r1 = P(0, h, ridge);
    const slope = Math.hypot(hw, h);
    this.quad(a[0], a[1], a[2], r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], dd[0], dd[1], dd[2], [0, 0, slope, 0, slope, d, 0, d]);
    this.quad(cc[0], cc[1], cc[2], r1[0], r1[1], r1[2], r0[0], r0[1], r0[2], b[0], b[1], b[2], [0, 0, slope, 0, slope, d, 0, d]);
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], r0[0], r0[1], r0[2], 0, 0, w, 0, w / 2, h);
    this.tri(cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], r1[0], r1[1], r1[2], 0, 0, w, 0, w / 2, h);
    return this;
  }

  /** Flat disc facing +Y. */
  disc(x, y, z, r, seg = 12, uvScale = 1) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
      this.tri(
        x, y, z,
        x + Math.cos(a1) * r, y, z + Math.sin(a1) * r,
        x + Math.cos(a0) * r, y, z + Math.sin(a0) * r,
        0.5, 0.5,
        0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5,
        0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5
      );
    }
    return this;
  }

  /** Vertical quad billboard for banners / cloth. */
  panel(x, y, z, w, h, rotY = 0) {
    const hw = w / 2;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (lx, ly) => [x + lx * c, y + ly, z - lx * s];
    const a = P(-hw, 0), b = P(hw, 0), cc = P(hw, h), dd = P(-hw, h);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], [0, h, w, h, w, 0, 0, 0]);
    this.quad(dd[0], dd[1], dd[2], cc[0], cc[1], cc[2], b[0], b[1], b[2], a[0], a[1], a[2], [0, 0, w, 0, w, h, 0, h]);
    return this;
  }

  /** A box beam running from point A to point B. */
  beam(ax, ay, az, bx, by, bz, t, opts = {}) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, cz = (az + bz) / 2;
    // build in local space: length along Z
    const hw = t / 2;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const P = (lx, ly, lz) => {
      // local x,y,z -> rotate pitch about X then yaw about Y
      const y1 = ly * cp - lz * sp;
      const z1 = ly * sp + lz * cp;
      return [cx + lx * cyw + z1 * syw, cy + y1, cz - lx * syw + z1 * cyw];
    };
    const hl = len / 2;
    const a = P(-hw, -hw, -hl), b = P(hw, -hw, -hl), c = P(hw, hw, -hl), d = P(-hw, hw, -hl);
    const e = P(-hw, -hw, hl), f = P(hw, -hw, hl), g = P(hw, hw, hl), h2 = P(-hw, hw, hl);
    this.quad(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], [0, 0, t, 0, t, t, 0, t]);
    this.quad(f[0], f[1], f[2], e[0], e[1], e[2], h2[0], h2[1], h2[2], g[0], g[1], g[2], [0, 0, t, 0, t, t, 0, t]);
    this.quad(e[0], e[1], e[2], a[0], a[1], a[2], d[0], d[1], d[2], h2[0], h2[1], h2[2], [0, 0, len, 0, len, t, 0, t]);
    this.quad(c[0], c[1], c[2], b[0], b[1], b[2], f[0], f[1], f[2], g[0], g[1], g[2], [0, 0, len, 0, len, t, 0, t]);
    this.quad(d[0], d[1], d[2], c[0], c[1], c[2], g[0], g[1], g[2], h2[0], h2[1], h2[2], [0, 0, len, 0, len, t, 0, t]);
    this.quad(b[0], b[1], b[2], a[0], a[1], a[2], e[0], e[1], e[2], f[0], f[1], f[2], [0, 0, len, 0, len, t, 0, t]);
    return this;
  }

  /** Crenellated parapet ring around a rectangular tower top. */
  battlements(x, y, z, w, d, h = 0.55, merlonW = 0.5, gap = 0.42) {
    const mk = (len, isX, offset) => {
      const n = Math.max(2, Math.floor(len / (merlonW + gap)));
      const step = len / n;
      for (let i = 0; i < n; i++) {
        if (i % 2 === 0) continue;
        const p = -len / 2 + i * step + step / 2;
        if (isX) this.box(x + p, y + h / 2, z + offset, step * 0.92, h, 0.34);
        else this.box(x + offset, y + h / 2, z + p, 0.34, h, step * 0.92);
      }
    };
    mk(w, true, -d / 2 + 0.17);
    mk(w, true, d / 2 - 0.17);
    mk(d, false, -w / 2 + 0.17);
    mk(d, false, w / 2 - 0.17);
    // ring base
    this.box(x, y - 0.06, z + d / 2 - 0.14, w, 0.16, 0.3);
    this.box(x, y - 0.06, z - d / 2 + 0.14, w, 0.16, 0.3);
    this.box(x + w / 2 - 0.14, y - 0.06, z, 0.3, 0.16, d);
    this.box(x - w / 2 + 0.14, y - 0.06, z, 0.3, 0.16, d);
    return this;
  }

  /** Window recess: dark frame + glowing pane + sill. */
  window(x, y, z, w, h, rotY = 0, glow = false) {
    const savedMat = this.mat, savedScale = this.scale, savedCol = this.col;
    this.beam(x - Math.cos(rotY) * w / 2, y, z + Math.sin(rotY) * w / 2, x + Math.cos(rotY) * w / 2, y, z - Math.sin(rotY) * w / 2, 0.12);
    this.material(glow ? M.GLOW : M.WOOD).color(glow ? [1, 0.82, 0.5] : [0.16, 0.13, 0.11]);
    this.panel(x, y, z, w, h, rotY);
    this.material(M.STONE).color(0.86, 0.85, 0.8);
    this.box(x, y - 0.08, z, w + 0.24, 0.12, 0.3, { rotY });
    this.mat = savedMat; this.scale = savedScale; this.col = savedCol;
    return this;
  }

  /** Horizontal timber framing on a wall face. */
  framing(x, y, z, w, h, rotY, rows = 3) {
    this.material(M.WOOD).color(0.34, 0.26, 0.19);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (let i = 1; i < rows; i++) {
      const yy = y + (i / rows) * h;
      this.box(x, yy, z, w, 0.16, 0.14, { rotY });
    }
    // diagonals
    for (let i = 0; i < rows - 1; i++) {
      const y0 = y + (i / rows) * h, y1 = y + ((i + 1) / rows) * h;
      this.beam(x - c * w * 0.3, y0 + 0.1, z + s * w * 0.3, x + c * w * 0.3, y1 - 0.1, z - s * w * 0.3, 0.14);
      this.beam(x + c * w * 0.3, y0 + 0.1, z - s * w * 0.3, x - c * w * 0.3, y1 - 0.1, z + s * w * 0.3, 0.14);
    }
    this.color(1, 1, 1);
    return this;
  }

  /** Reuse another Geo's geometry (with an optional transform). */
  merge(other, ox = 0, oy = 0, oz = 0, rotY = 0, scale = 1) {
    const base = this.count;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const v = other.v;
    for (let k = 0; k < other.count; k++) {
      const o = k * 16;
      const x = v[o] * scale, y = v[o + 1] * scale, z = v[o + 2] * scale;
      const nx = v[o + 3], ny = v[o + 4], nz = v[o + 5];
      this.v.push(
        ox + x * c + z * s, oy + y, oz - x * s + z * c,
        nx * c + nz * s, ny, -nx * s + nz * c,
        v[o + 6], v[o + 7], v[o + 8],
        v[o + 9], v[o + 10], v[o + 11],
        this.px + v[o + 12] * scale, this.py + v[o + 13] * scale, this.pz + v[o + 14] * scale,
        v[o + 15]
      );
      this.count++;
    }
    for (let k = 0; k < other.i.length; k++) this.i.push(base + other.i[k]);
    return this;
  }

  finish() {
    return { v: new Float32Array(this.v), i: this.count > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), tris: this.i.length / 3 };
  }
}

/** Radial helper used all over the models. */
export const T = TAU;
