/* ============================================================
   camera.js — RTS orbit camera with smooth spring follow

   Geometry convention (do not change it without changing pan()):
     eye     = target + (sin(yaw)*cos(pitch), sin(pitch), cos(yaw)*cos(pitch)) * dist
     forward = -normalize(eye - target)
     right   = (cos(yaw), 0, -sin(yaw))          [ground plane]
     ahead   = (-sin(yaw), 0, -cos(yaw))         [ground plane, "up the screen"]

   pan(dx, dz) moves the *target* by dx metres along `right` and dz metres
   along `ahead`. v2 had the z row of that rotation negated, which mirrored
   every drag on one axis: dragging sideways moved the map diagonally, and
   dragging up/down moved it sideways. That is the "scrolling direction is
   completely messed up" bug, and it lived here.
   ============================================================ */
import { mat4, m4perspective, m4lookAt, m4mul, m4invert, m4transformPoint, clamp, lerp } from '../core/math.js';

export const MIN_PITCH = 0.20;
export const MAX_PITCH = 1.36;

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
    this.minDist = 16;
    this.maxDist = 92;
    this.fov = opts.fov ?? 46;
    this.near = 0.6;
    this.far = 820;
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
    // scratch used by zoom-to-point; never allocated in the frame loop
    this._groundO = [0, 0, 0];
    this._groundD = [0, 0, 0];
    this._hit = [0, 0, 0];
  }

  setAspect(a) { this.aspect = Math.max(0.25, Math.min(5, Number.isFinite(a) && a > 0 ? a : 1)); }

  /** Canvas size in CSS pixels. Drag maths needs it to map pixels to metres. */
  setViewport(w, h) {
    this.viewportW = Math.max(2, w | 0);
    this.viewportH = Math.max(2, h | 0);
  }

  setTarget(x, z, immediate = false) {
    this.desired[0] = clamp(x, -this.worldHalf + 8, this.worldHalf - 8);
    this.desired[2] = clamp(z, -this.worldHalf + 8, this.worldHalf - 8);
    if (immediate) { this.target[0] = this.desired[0]; this.target[2] = this.desired[2]; }
  }

  /**
   * Move the target by `dx` metres screen-right and `dz` metres up-screen.
   *
   * Direct manipulation must be *direct*: the smoothed target jumps with the
   * desired one instead of easing toward it. v2 eased everything, so a drag
   * arrived a third of a second late and the map slid out from under the
   * thumb -- half of what "the camera is broken" felt like.
   */
  pan(dx, dz) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.setTarget(this.desired[0] + dx * c - dz * s,
      this.desired[2] - dx * s - dz * c);
    this.target[0] = this.desired[0];
    this.target[2] = this.desired[2];
  }

  /**
   * Pan from a drag in screen pixels, so that the ground point the finger
   * grabbed moves *with* the finger.
   *
   * v2 multiplied the pixel delta by a constant (dist * 0.0021) and hoped for
   * the best: at a tilted camera that constant was off by 2.5x (the drag felt
   * like it was flying) and it changed with pitch, which is why the map never
   * tracked the thumb. The camera does it properly now -- project the two
   * screen axes onto the ground plane at the target, invert the 2x2 Jacobian,
   * and move the target by exactly the metres the finger asked for.
   */
  panPixels(dxPx, dyPx) {
    const t = this.target;
    const J = this._panJacobian(t);
    if (!J) {                       // degenerate (looking at the horizon)
      const s = this.dist * 0.0021;
      this.pan(-dxPx * s, dyPx * s * 1.6);
      return;
    }
    // px -> NDC (y flips: screen y grows downward)
    const W = this.viewportW || 1280, H = this.viewportH || 720;
    const nx = (2 * dxPx) / W;
    const ny = (-2 * dyPx) / H;
    const det = J.b1x * J.b2y - J.b2x * J.b1y;
    if (Math.abs(det) < 1e-9) return;
    // metres along screen-right and up-screen so the *world* moves by (nx,ny)
    const a = (nx * J.b2y - J.b2x * ny) / det;
    const b = (J.b1x * ny - nx * J.b1y) / det;
    // content follows the finger: the camera moves the opposite way
    this.pan(-a, -b);
  }

  /**
   * Screen-space derivatives (in NDC) of a one-metre ground step along
   * screen-right and up-screen, measured at the camera target.
   */
  _panJacobian(t) {
    const p0 = this.project(t[0], t[1], t[2], this._jac0 || (this._jac0 = [0, 0, 0]));
    if (!p0 || p0[2] <= 0.01) return null;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ahead = this._jac1 || (this._jac1 = [0, 0, 0]);
    const right = this._jac2 || (this._jac2 = [0, 0, 0]);
    this.project(t[0] + c, t[1], t[2] - s, right);
    this.project(t[0] - s, t[1], t[2] - c, ahead);
    if (right[2] <= 0.01 || ahead[2] <= 0.01) return null;
    const out = this._jac || (this._jac = { b1x: 0, b1y: 0, b2x: 0, b2y: 0 });
    out.b1x = right[0] - p0[0];
    out.b1y = right[1] - p0[1];
    out.b2x = ahead[0] - p0[0];
    out.b2y = ahead[1] - p0[1];
    return out;
  }

  zoom(delta) {
    this.desiredDist = clamp(this.desiredDist * delta, this.minDist, this.maxDist);
  }

  /** Zoom from a wheel notch: positive = closer. */
  zoomSteps(steps) {
    this.zoom(Math.pow(0.88, steps));
  }

  /**
   * Zoom while keeping the ground point under a screen position fixed.
   * `nx`/`ny` are 0..1 canvas fractions. Falls back to a plain zoom when the
   * ray misses the terrain (looking at the sky).
   */
  zoomAt(delta, nx, ny) {
    const hit = this.pickGround(nx, ny, this.heightAt, this._hit);
    const d0 = this.desiredDist;
    const d1 = clamp(d0 * delta, this.minDist, this.maxDist);
    this.desiredDist = d1;
    if (!hit) return;
    /* Scale the whole camera about the point under the finger: the eye and
       the target both move in proportion, so the grabbed ground point stays
       under the finger exactly. (v2 re-picked the ground with a view matrix
       that had not been rebuilt yet, so every zoom drifted.) */
    const k = d1 / d0;
    const ax = this._hit[0], az = this._hit[2];
    this.setTarget(ax + (this.desired[0] - ax) * k, az + (this.desired[2] - az) * k);
  }

  rotate(delta) { this.desiredYaw += delta; }

  /* 0.20 rad is low enough that the sky (and with it the moon and the stars)
     fills a good slice of the frame; the old 0.42 floor cropped the sky out
     entirely, so the night sky was never actually seen during play. */
  nudge(dyh, dpitch = 0) {
    this.desiredYaw += dyh;
    this.desiredPitch = clamp(this.desiredPitch + dpitch, MIN_PITCH, MAX_PITCH);
  }

  setPitch(p) { this.desiredPitch = clamp(p, MIN_PITCH, MAX_PITCH); }

  addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  /** Snap the smoothed state to the desired state (used after teleports). */
  snap() {
    this.target[0] = this.desired[0];
    this.target[2] = this.desired[2];
    this.yaw = this.desiredYaw;
    this.pitch = this.desiredPitch;
    this.dist = this.desiredDist;
  }

  update(dt, opts = {}) {
    const smooth = opts.instant ? 1 : 1 - Math.pow(0.0016, Math.min(dt, 0.1));
    this.target[0] = lerp(this.target[0], this.desired[0], smooth);
    this.target[2] = lerp(this.target[2], this.desired[2], smooth);
    const groundY = this.heightAt(this.target[0], this.target[2]);
    this.target[1] = lerp(this.target[1], groundY + 1.2, opts.instant ? 1 : 1 - Math.pow(0.01, Math.min(dt, 0.1)));
    this.yaw = lerp(this.yaw, this.desiredYaw, smooth);
    this.pitch = lerp(this.pitch, this.desiredPitch, smooth);
    this.dist = lerp(this.dist, this.desiredDist, smooth);

    if (this.shake > 0.001) {
      this.shakeT += dt * 40;
      this.shake *= Math.pow(0.02, Math.min(dt, 0.1));
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

  /** Project a world point to NDC. Returns [x, y, w]; w <= 0 means behind. */
  project(x, y, z, out) {
    return m4transformPoint(out || [0, 0, 0], this.viewProj, x, y, z);
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

  /** March a ray against the terrain heightfield. Same cost as v2 (one tap). */
  pickGround(nx, ny, heightAt, out) {
    const o = [0, 0, 0], d = [0, 0, 0];
    this.screenRay(nx, ny, o, d);
    let t = 0;
    for (let i = 0; i < 80; i++) {
      t += i < 8 ? 2.5 : 10;
      const px = o[0] + d[0] * t;
      const py = o[1] + d[1] * t;
      const pz = o[2] + d[2] * t;
      const h = heightAt(px, pz);
      if (py <= h + 0.05) {
        // refine with a bisection
        let lo = Math.max(0, t - 10), hi = t;
        for (let k = 0; k < 10; k++) {
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
    }
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
