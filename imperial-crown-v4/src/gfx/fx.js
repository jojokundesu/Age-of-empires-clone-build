/* ============================================================
   fx.js — pooled particle engine
   Zero allocation per spawn; a single flat array of particles and a
   free cursor that overwrites the oldest slot when full. The renderer
   turns this into two instanced draws (alpha + additive).
   ============================================================ */
import { clamp, lerp } from '../core/math.js';
import { SPRITE } from './textures.js';

const MAX = 1400;

function makeParticle() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    life: 0, maxLife: 1, size: 1, grow: 0, alpha: 1,
    r: 1, g: 1, b: 1, sprite: 0, additive: false, gravity: 0,
    drag: 0.9, rot: 0, spin: 0, stretch: 0, fadeOut: true, wind: 0
  };
}

export class FX {
  constructor() {
    this.capacity = MAX;
    this.particles = new Array(MAX);
    for (let i = 0; i < MAX; i++) this.particles[i] = makeParticle();
    this.count = MAX;
    this.cursor = 0;
    this.alive = 0;
  }
  _next() {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    return p;
  }
  spawn(spec) {
    const p = this._next();
    p.x = spec.x; p.y = spec.y; p.z = spec.z;
    p.vx = spec.vx || 0; p.vy = spec.vy || 0; p.vz = spec.vz || 0;
    p.maxLife = spec.life || 1;
    p.life = p.maxLife;
    p.size = spec.size || 0.4;
    p.grow = spec.grow || 0;
    p.alpha = spec.alpha ?? 1;
    p.r = spec.r ?? 1; p.g = spec.g ?? 1; p.b = spec.b ?? 1;
    p.sprite = spec.sprite ?? SPRITE.PUFF;
    p.additive = !!spec.additive;
    p.gravity = spec.gravity || 0;
    p.drag = spec.drag ?? 0.9;
    p.rot = spec.rot ?? Math.random() * 6.28;
    p.spin = spec.spin ?? 0;
    p.stretch = spec.stretch || 0;
    p.fadeOut = spec.fadeOut !== false;
    p.wind = spec.wind || 0;
    this.alive = Math.min(this.capacity, this.alive + 1);
    return p;
  }
  update(dt) {
    let alive = 0;
    const wind = 0.35;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = 0; continue; }
      alive++;
      p.vy -= p.gravity * dt;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag; p.vy *= drag; p.vz *= drag;
      p.x += (p.vx + p.wind * wind) * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy = Math.abs(p.vy) * 0.2; }
    }
    this.alive = alive;
  }
  clear() {
    for (let i = 0; i < this.capacity; i++) this.particles[i].life = 0;
    this.alive = 0;
  }

  /* ---------------- presets ---------------- */
  dust(x, y, z, amount = 3, scale = 1) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.6, y: y + 0.05, z: z + (Math.random() - 0.5) * 0.6,
        vx: (Math.random() - 0.5) * 1.1, vy: 0.35 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 1.1,
        life: 0.7 + Math.random() * 0.7, size: (0.28 + Math.random() * 0.3) * scale,
        grow: 1.4, r: 0.72, g: 0.63, b: 0.5, sprite: SPRITE.DUST, alpha: 0.42, drag: 0.86, gravity: -0.3
      });
    }
  }
  smoke(x, y, z, amount = 1, scale = 1, dark = 1) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.5, y: y, z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.35, vy: 0.5 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.35,
        life: 2.4 + Math.random() * 2.4, size: (0.6 + Math.random() * 0.6) * scale,
        grow: 2.2, r: 0.34 * dark, g: 0.32 * dark, b: 0.30 * dark, sprite: SPRITE.SMOKE,
        alpha: 0.34, drag: 0.97, gravity: -0.06, spin: 0.3
      });
    }
  }
  fire(x, y, z, amount = 2, scale = 1) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.5, y: y + Math.random() * 0.2, z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.4, vy: 1.0 + Math.random() * 1.1, vz: (Math.random() - 0.5) * 0.4,
        life: 0.55 + Math.random() * 0.55, size: (0.35 + Math.random() * 0.35) * scale,
        grow: 0.6, r: 1.0, g: 0.62, b: 0.22, sprite: SPRITE.FIRE, additive: true,
        alpha: 0.9, drag: 0.9, gravity: -0.8, spin: 0.6
      });
    }
  }
  embers(x, y, z, amount = 1) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 1.4, y: y + Math.random() * 1.2, z: z + (Math.random() - 0.5) * 1.4,
        vx: (Math.random() - 0.5) * 0.7, vy: 1.1 + Math.random() * 1.4, vz: (Math.random() - 0.5) * 0.7,
        life: 1.1 + Math.random(), size: 0.07 + Math.random() * 0.05,
        r: 1, g: 0.7, b: 0.25, sprite: SPRITE.SPARK, additive: true, alpha: 1, drag: 0.97, gravity: -0.4
      });
    }
  }
  blood(x, y, z, amount = 4) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x, y: y + 0.5, z,
        vx: (Math.random() - 0.5) * 2.2, vy: 0.8 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 2.2,
        life: 0.35 + Math.random() * 0.3, size: 0.16 + Math.random() * 0.14,
        r: 0.62, g: 0.09, b: 0.07, sprite: SPRITE.BLOOD, alpha: 0.85, gravity: 9.5, drag: 0.98
      });
    }
  }
  sparks(x, y, z, amount = 6, color = [1, 0.85, 0.55]) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x, y, z,
        vx: (Math.random() - 0.5) * 4.5, vy: Math.random() * 3.2, vz: (Math.random() - 0.5) * 4.5,
        life: 0.22 + Math.random() * 0.3, size: 0.09 + Math.random() * 0.1,
        r: color[0], g: color[1], b: color[2], sprite: SPRITE.SPARK, additive: true,
        alpha: 1, gravity: 7, drag: 0.94
      });
    }
  }
  explosion(x, y, z, scale = 1) {
    this.fire(x, y, z, 8, 1.6 * scale);
    this.smoke(x, y, z, 6, 1.5 * scale, 0.7);
    this.sparks(x, y + 0.3, z, 12, [1, 0.8, 0.4]);
    for (let i = 0; i < 5; i++) {
      this.spawn({
        x, y: y + 0.2, z,
        vx: (Math.random() - 0.5) * 5, vy: 1.5 + Math.random() * 3, vz: (Math.random() - 0.5) * 5,
        life: 0.9 + Math.random() * 0.6, size: 0.18 + Math.random() * 0.14,
        r: 0.5, g: 0.44, b: 0.38, sprite: SPRITE.CHIP, alpha: 0.9, gravity: 12, drag: 0.97
      });
    }
  }
  heal(x, y, z, amount = 3) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.8, y: y + Math.random() * 0.6, z: z + (Math.random() - 0.5) * 0.8,
        vx: 0, vy: 0.7 + Math.random() * 0.5, vz: 0, life: 0.9 + Math.random() * 0.5,
        size: 0.18 + Math.random() * 0.12, r: 0.6, g: 1, b: 0.6, sprite: SPRITE.GLOW,
        additive: true, alpha: 0.8, drag: 0.98
      });
    }
  }
  splash(x, y, z, amount = 5) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x, y: y + 0.1, z,
        vx: (Math.random() - 0.5) * 2.4, vy: 1.2 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 2.4,
        life: 0.4 + Math.random() * 0.4, size: 0.14 + Math.random() * 0.18,
        r: 0.86, g: 0.94, b: 1, sprite: SPRITE.WATER, alpha: 0.8, gravity: 8, drag: 0.95
      });
    }
  }
  leaves(x, y, z, amount = 2) {
    for (let i = 0; i < amount; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 1.4, y: y + 1.2 + Math.random(), z: z + (Math.random() - 0.5) * 1.4,
        vx: (Math.random() - 0.5) * 0.8, vy: -0.2, vz: (Math.random() - 0.5) * 0.8,
        life: 2.2 + Math.random() * 2, size: 0.2 + Math.random() * 0.15,
        r: 1, g: 1, b: 1, sprite: SPRITE.LEAF, alpha: 0.95, drag: 0.98, spin: 1.6
      });
    }
  }
  buildDust(x, y, z, amount = 5) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn({
        x: x + Math.cos(a) * 0.7, y: y + 0.1, z: z + Math.sin(a) * 0.7,
        vx: Math.cos(a) * 1.5, vy: 0.6, vz: Math.sin(a) * 1.5,
        life: 1.0, size: 0.4, grow: 1.8, r: 0.75, g: 0.66, b: 0.52, sprite: SPRITE.DUST,
        alpha: 0.45, drag: 0.9, gravity: -0.2
      });
    }
  }
  arrowTrail(x, y, z) {
    this.spawn({
      x, y, z, vx: 0, vy: 0, vz: 0, life: 0.25, size: 0.07,
      r: 1, g: 0.95, b: 0.8, sprite: SPRITE.STREAK, additive: false, alpha: 0.35, drag: 0.9, stretch: 1.6
    });
  }
  glowPulse(x, y, z, r = 0.6, g = 0.8, b = 1) {
    this.spawn({
      x, y, z, vx: 0, vy: 0.4, vz: 0, life: 1.4, size: 0.8, grow: 1.4,
      r, g, b, sprite: SPRITE.GLOW, additive: true, alpha: 0.55, drag: 0.98
    });
  }
  pollen(x, y, z) {
    this.spawn({
      x, y: y + 0.6 + Math.random() * 1.4, z, vx: (Math.random() - 0.5) * 0.3, vy: 0.06,
      vz: (Math.random() - 0.5) * 0.3, life: 6, size: 0.045, r: 1, g: 0.92, b: 0.6,
      sprite: SPRITE.GLOW, additive: true, alpha: 0.5, drag: 1
    });
  }
  rain(x, y, z) {
    this.spawn({
      x, y: y + 8, z, vx: 0.4, vy: -11, vz: 0.2, life: 0.75, size: 0.05,
      r: 0.7, g: 0.8, b: 0.9, sprite: SPRITE.STREAK, alpha: 0.3, drag: 1, gravity: 0
    });
  }
}
