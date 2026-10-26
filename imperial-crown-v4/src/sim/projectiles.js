/* ============================================================
   projectiles.js — pooled ballistic projectiles
   Arrows, javelins, bolts, boulders and cannonballs. Fixed pool,
   no allocation, damage resolved on impact rather than on fire so
   that a shot can miss a target that has already run away.
   ============================================================ */

export const PROJ = {
  ARROW: 0, JAVELIN: 1, BOLT: 2, BOULDER: 3, CANNONBALL: 4, FLAME: 5, THROWING_AXE: 6
};

const KIND_BY_NAME = {
  arrow: PROJ.ARROW, javelin: PROJ.JAVELIN, bolt: PROJ.BOLT,
  boulder: PROJ.BOULDER, cannon: PROJ.CANNONBALL, flame: PROJ.FLAME, axe: PROJ.THROWING_AXE
};

const GRAVITY = 16.5;

export class ProjectilePool {
  constructor(capacity = 220) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items[i] = {
        active: false, kind: 0, x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0, ox: 0, oy: 0, oz: 0,
        tx: 0, ty: 0, tz: 0, time: 0, flight: 1,
        damage: 0, team: 0, source: null, target: null,
        targetX: 0, targetY: 0, targetZ: 0, track: 0, splash: 0,
        arc: 0, trailT: 0, gravity: true
      };
    }
    this.cursor = 0;
    this.activeCount = 0;
    this.onImpact = null;   // (projectile, x, y, z, hitEntity) => void
  }
  spawn(from, target, damage, kindName, opts = {}) {
    const p = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    const kind = typeof kindName === 'number' ? kindName : (KIND_BY_NAME[kindName] ?? PROJ.ARROW);
    const sx = from.x;
    const sy = (from.y ?? 0) + (opts.fromHeight ?? (from.kind === 'building' ? 4 : 1.35));
    const sz = from.z;
    const tx = target.x;
    const ty = (target.y ?? 0) + (opts.toHeight ?? 1.0);
    const tz = target.z;
    const dx = tx - sx, dz = tz - sz;
    const dist = Math.hypot(dx, dz);
    const speed = opts.speed ?? (kind === PROJ.BOULDER ? 13 : kind === PROJ.CANNONBALL ? 22 : kind === PROJ.FLAME ? 12 : 26);
    const flight = Math.max(0.12, dist / speed);
    p.active = true;
    p.kind = kind;
    p.x = sx; p.y = sy; p.z = sz;
    p.ox = sx; p.oy = sy; p.oz = sz;
    p.tx = tx; p.ty = ty; p.tz = tz;
    p.flight = flight;
    p.time = 0;
    p.damage = damage;
    p.team = from.team;
    p.source = from;
    p.target = target;
    p.track = opts.track || 0;
    p.splash = opts.splash || 0;
    p.arc = opts.arc ?? (kind === PROJ.ARROW || kind === PROJ.JAVELIN ? 2.4 + dist * 0.09 : 3.2 + dist * 0.06);
    if (kind === PROJ.CANNONBALL) p.arc = 1.2 + dist * 0.03;
    if (kind === PROJ.FLAME) p.arc = 0.4;
    p.gravity = opts.gravity !== false;
    p.trailT = 0;
    // launch velocity so that we arrive at the target in `flight` seconds
    p.vx = (dx / flight);
    p.vz = (dz / flight);
    p.vy = ((ty - sy) / flight) + 0.5 * GRAVITY * flight * (p.gravity ? 1 : 0);
    if (!p.gravity) p.vy = (ty - sy) / flight;
    this.activeCount++;
    return p;
  }
  clear() {
    for (const p of this.items) p.active = false;
    this.activeCount = 0;
  }
  update(dt, game) {
    let active = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.items[i];
      if (!p.active) continue;
      p.time += dt;
      // homing / leading
      if (p.track + p.time >= 0 && p.target && !p.target.dead && p.track > 0 && p.time < p.flight * 0.92) {
        const lead = 1 - p.time / p.flight;
        p.tx += (p.target.x + (p.target.vx || 0) * lead * 0.5 - p.tx) * Math.min(1, dt * 6 * p.track);
        p.tz += (p.target.z + (p.target.vz || 0) * lead * 0.5 - p.tz) * Math.min(1, dt * 6 * p.track);
      }
      if (p.gravity) p.vy -= GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < game.heightAt(p.x, p.z) + 0.06) {
        this.impact(p, game, p.x, p.y, p.z, null);
        continue;
      }
      if (p.time >= p.flight) {
        // final approach — resolve against the intended target
        const t = p.target;
        if (t && !t.dead) {
          this.impact(p, game, t.x, (t.y || 0) + 0.8, t.z, t);
        } else {
          this.impact(p, game, p.x, p.y, p.z, null);
        }
        continue;
      }
      p.trailT += dt;
      if (p.trailT > 0.045 && (p.kind === PROJ.BOULDER || p.kind === PROJ.CANNONBALL || p.kind === PROJ.FLAME)) {
        p.trailT = 0;
        if (p.kind === PROJ.FLAME) game.fx.fire(p.x, p.y, p.z, 1, 0.7);
        else game.fx.smoke(p.x, p.y, p.z, 1, 0.4, 1.4);
      }
      active++;
    }
    this.activeCount = active;
  }
  impact(p, game, x, y, z, hit) {
    p.active = false;
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (hit && !hit.dead) {
      const kindBonus = p.kind === PROJ.ARROW ? 'pierce' : 'melee';
      hit.takeDamage(p.damage, p.source, kindBonus);
      if (p.kind === PROJ.ARROW) game.fx.sparks(x, y, z, 3, [1, 0.92, 0.7]);
      else if (p.kind === PROJ.THROWING_AXE) game.fx.sparks(x, y, z, 4, [0.9, 0.85, 0.8]);
      else if (p.kind === PROJ.BOULDER || p.kind === PROJ.CANNONBALL) game.fx.explosion(x, y, z, 0.7);
      else game.fx.splash(x, y, z, 2);
    }
    if (p.splash > 0) {
      game.explodeArea(x, z, p.splash, p.damage * 0.55, p.source, p.team);
    }
    if (p.kind === PROJ.FLAME) game.fx.fire(x, y, z, 4, 1.1);
    if (this.onImpact) this.onImpact(p, x, y, z, hit);
  }
}
