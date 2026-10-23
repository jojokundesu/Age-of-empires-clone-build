/* ============================================================
   camera.js — RTS orbit camera with smooth spring follow
   ============================================================ */
import { mat4, m4perspective, m4lookAt, m4mul, m4invert, m4transformPoint, clamp, lerp } from '../core/math.js';

export class Camera {
  constructor(opts = {}) {
    this.target = new Float32Array([0, 0, 0]);
    this.desired = new Float32Array([0, 0, 0]);
    this.yaw = opts.yaw ?? Math.PI * 0.25;
    this.desiredYaw = this.yaw;
    this.pitch = opts.pitch ?? 0.86;          // ~49 degrees above the horizon
    this.desiredPitch = this.pitch;
    this.dist = opts.dist ?? 46;
    this.desiredDist = this.dist;
    this.minDist = 18;
    this.maxDist = 96;
    this.fov = opts.fov ?? 46;
    this.near = 0.6;
    this.far = 780;
    this.aspect = 1;
    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.invViewProj = mat4();
    this.eye = new Float32Array([0, 0, 0]);
    this.right = new Float32Array([1, 0, 0]);
    this.up = new Float32Array([0, 1, 0]);
    this.fwd = new Float32Array([0, 0, -1]);
    this.worldHalf = 256;
    this.heightAt = () => 0;
    this.shake = 0;
    this.shakeT = 0;
  }
  setAspect(a) { this.aspect = Math.max(0.25, Math.min(5, Number.isFinite(a) && a > 0 ? a : 1)); }
  setTarget(x, z, immediate = false) {
    this.desired[0] = clamp(x, -this.worldHalf + 8, this.worldHalf - 8);
    this.desired[2] = clamp(z, -this.worldHalf + 8, this.worldHalf - 8);
    if (immediate) { this.target[0] = this.desired[0]; this.target[2] = this.desired[2]; }
  }
  pan(dx, dz) {
    // pan in camera-relative ground directions
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.setTarget(this.desired[0] + dx * c - dz * s, this.desired[2] + dx * s + dz * c);
  }
  zoom(delta) {
    this.desiredDist = clamp(this.desiredDist * delta, this.minDist, this.maxDist);
  }
  rotate(delta) { this.desiredYaw += delta; }
  nudge(dyh, dpitch = 0) { this.desiredYaw += dyh; this.desiredPitch = clamp(this.desiredPitch + dpitch, 0.42, 1.32); }
  addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  update(dt, opts = {}) {
    const smooth = opts.instant ? 1 : 1 - Math.pow(0.0016, dt);
    this.target[0] = lerp(this.target[0], this.desired[0], smooth);
    this.target[2] = lerp(this.target[2], this.desired[2], smooth);
    const groundY = this.heightAt(this.target[0], this.target[2]);
    this.target[1] = lerp(this.target[1], groundY + 1.2, opts.instant ? 1 : 1 - Math.pow(0.01, dt));
    this.yaw = lerp(this.yaw, this.desiredYaw, smooth);
    this.pitch = lerp(this.pitch, this.desiredPitch, smooth);
    this.dist = lerp(this.dist, this.desiredDist, smooth);

    if (this.shake > 0.001) {
      this.shakeT += dt * 40;
      this.shake *= Math.pow(0.02, dt);
      if (this.shake < 0.002) this.shake = 0;
    }
    const shakeX = Math.sin(this.shakeT * 1.7) * this.shake * 0.6;
    const shakeY = Math.cos(this.shakeT * 2.3) * this.shake * 0.4;

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cx = this.target[0] + sy * cp * this.dist + shakeX;
    const cz = this.target[2] + cy * cp * this.dist;
    const cyy = this.target[1] + sp * this.dist + shakeY;
    // keep above the terrain
    const terrainY = this.heightAt(cx, cz) + 3.0;
    this.eye[0] = cx;
    this.eye[1] = Math.max(cyy, terrainY);
    this.eye[2] = cz;

    m4perspective(this.proj, this.fov * Math.PI / 180, this.aspect, this.near, this.far);
    m4lookAt(this.view, this.eye[0], this.eye[1], this.eye[2], this.target[0], this.target[1], this.target[2]);
    m4mul(this.viewProj, this.proj, this.view);
    m4invert(this.invViewProj, this.viewProj);

    // camera basis for billboards
    this.fwd[0] = this.target[0] - this.eye[0];
    this.fwd[1] = this.target[1] - this.eye[1];
    this.fwd[2] = this.target[2] - this.eye[2];
    const fl = Math.hypot(this.fwd[0], this.fwd[1], this.fwd[2]) || 1;
    this.fwd[0] /= fl; this.fwd[1] /= fl; this.fwd[2] /= fl;
    // right = normalize(cross(fwd, worldUp))
    this.right[0] = this.fwd[2]; this.right[1] = 0; this.right[2] = -this.fwd[0];
    const rl = Math.hypot(this.right[0], this.right[2]) || 1;
    this.right[0] /= rl; this.right[2] /= rl;
    // up = cross(right, fwd)
    this.up[0] = this.right[1] * this.fwd[2] - this.right[2] * this.fwd[1];
    this.up[1] = this.right[2] * this.fwd[0] - this.right[0] * this.fwd[2];
    this.up[2] = this.right[0] * this.fwd[1] - this.right[1] * this.fwd[0];
  }

  /** Returns [ndcX, ndcY, visible] for a world point. */
  project(x, y, z, out) {
    const p = m4transformPoint(out || [0, 0, 0], this.viewProj, x, y, z);
    return p;
  }

  /** Ray from screen (0..1) into the world. */
  screenRay(nx, ny, outOrigin, outDir) {
    const a = m4transformPoint([0, 0, 0], this.invViewProj, nx * 2 - 1, ny * 2 - 1, -1);
    const b = m4transformPoint([0, 0, 0], this.invViewProj, nx * 2 - 1, ny * 2 - 1, 1);
    outOrigin[0] = a[0]; outOrigin[1] = a[1]; outOrigin[2] = a[2];
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    outDir[0] = dx / l; outDir[1] = dy / l; outDir[2] = dz / l;
    return outDir;
  }

  /** Raycast against the terrain heightfield (marching). */
  pickGround(nx, ny, heightAt, out) {
    const o = [0, 0, 0], d = [0, 0, 0];
    this.screenRay(nx, ny, o, d);
    let t = 0;
    let prevY = 0, prevH = 0;
    // march up to 700 units
    for (let i = 0; i < 90; i++) {
      t += i < 10 ? 2 : 9;
      const px = o[0] + d[0] * t;
      const py = o[1] + d[1] * t;
      const pz = o[2] + d[2] * t;
      const h = heightAt(px, pz);
      if (py <= h + 0.05) {
        // refine with a bisection
        let lo = Math.max(0, t - 10), hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = o[0] + d[0] * mid, my = o[1] + d[1] * mid, mz = o[2] + d[2] * mid;
          if (my <= heightAt(mx, mz)) hi = mid; else lo = mid;
        }
        const ft = (lo + hi) * 0.5;
        out[0] = o[0] + d[0] * ft;
        out[1] = heightAt(out[0], o[2] + d[2] * ft);
        out[2] = o[2] + d[2] * ft;
        return true;
      }
      prevY = py; prevH = h;
    }
    // fallback: intersect the y = target plane
    return false;
  }
}

/** Frustum culling helper. */
export function extractPlanes(m, planes) {
  // m is column-major view-projection
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
  const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
  const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
  const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
  const set = (i, a, b, c, d) => {
    const l = Math.hypot(a, b, c) || 1;
    planes[i * 4] = a / l; planes[i * 4 + 1] = b / l; planes[i * 4 + 2] = c / l; planes[i * 4 + 3] = d / l;
  };
  set(0, m3 + m0, m7 + m4, m11 + m8, m15 + m12);   // left
  set(1, m3 - m0, m7 - m4, m11 - m8, m15 - m12);   // right
  set(2, m3 + m1, m7 + m5, m11 + m9, m15 + m13);   // bottom
  set(3, m3 - m1, m7 - m5, m11 - m9, m15 - m13);   // top
  set(4, m3 + m2, m7 + m6, m11 + m10, m15 + m14);  // near
  set(5, m3 - m2, m7 - m6, m11 - m10, m15 - m14);  // far
  return planes;
}

export function sphereInFrustum(planes, x, y, z, r) {
  for (let i = 0; i < 6; i++) {
    const d = planes[i * 4] * x + planes[i * 4 + 1] * y + planes[i * 4 + 2] * z + planes[i * 4 + 3];
    if (d < -r) return false;
  }
  return true;
}
