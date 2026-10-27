/* ============================================================
   guards.js — a standing, interruptible protection order

   Guards keep separated slots around a person or a building, engage
   threats near that principal, and return afterwards. The order is
   not an escort teleport or a repeated full-army pathfind: only
   guards with a standing order are checked, at 2.5 Hz, and a new
   path is requested only when their slot has moved meaningfully.
   Any ordinary player order supersedes protection.
   ============================================================ */
import { STATE } from './entities.js';

const CHECK_INTERVAL = 0.4;
const LEASH = 14;
const THREAT_RADIUS = 10;

export class Guards {
  constructor(game) {
    this.game = game;
    this.records = new Map();
    this.acc = 0;
  }

  /** Prevent self-guarding and circular follow chains. */
  canGuard(unit, target) {
    if (!unit || !target || unit === target || unit.dead || target.dead) return false;
    if (unit.kind !== 'unit' || (target.kind !== 'unit' && target.kind !== 'building')) return false;
    if (unit.team !== this.game.playerTeam || target.team !== unit.team) return false;
    if (unit.garrisoned || unit.state === STATE.ROUT) return false;
    let next = target;
    for (let i = 0; i <= this.records.size; i++) {
      if (next === unit) return false;
      const rec = this.records.get(next);
      if (!rec) return true;
      next = rec.target;
    }
    return false;
  }

  assign(units, target) {
    const used = new Set();
    for (const [u, r] of this.records) if (!u.dead && r.target === target) used.add(r.slot);
    let count = 0;
    for (const u of new Set(units || [])) {
      if (!this.canGuard(u, target)) continue;
      const previous = this.records.get(u);
      if (previous && previous.target === target) continue;
      this.release(u, false);
      let slot = 0;
      while (used.has(slot)) slot++;
      used.add(slot);
      u.stop();
      u.guardTarget = target;
      this.records.set(u, { target, slot, x: NaN, z: NaN, nextPath: 0 });
      count++;
    }
    return count;
  }

  release(unit, stop = false) {
    if (!this.records.delete(unit)) return false;
    unit.guardTarget = null;
    if (stop && !unit.dead && unit.state !== STATE.ROUT) unit.stop();
    return true;
  }

  update(dt) {
    if (!this.records.size) return;
    this.acc += dt;
    if (this.acc < CHECK_INTERVAL) return;
    this.acc = 0;
    const g = this.game;
    for (const [u, rec] of this.records) {
      const target = rec.target;
      if (u.dead || u.team !== g.playerTeam || !target || target.dead || target.team !== u.team) {
        this.release(u, true);
        continue;
      }
      // A broken guard, a garrisoned one or a possessed one must not be
      // overridden by an automatic order. It resumes on release/rally.
      if (u.garrisoned || u.state === STATE.ROUT || g.directControl?.unit === u) continue;
      const anchor = target.garrisoned && target.garrisonTarget && !target.garrisonTarget.dead
        ? target.garrisonTarget : target;
      const pd = Math.hypot(u.x - anchor.x, u.z - anchor.z);
      const half = anchor.kind === 'building' ? (anchor.def.size || 3) * 0.5 : (anchor.radius || 0.5);

      // Monks protect by healing the principal, not by trying to swing a bow.
      if (u.def.classes.includes('monk') && target.kind === 'unit' && !target.garrisoned && target.hp < target.maxHp * 0.98 && pd < LEASH + half) {
        if (u.state !== STATE.HEAL || u.target !== target) {
          u.target = target; u.state = STATE.HEAL; u.path = null; u.targetPos = null;
        }
        continue;
      }

      // Attackers are only chased inside a leash around the protected person.
      let enemy = u.state === STATE.ATTACK && u.target && !u.target.dead ? u.target : null;
      if (enemy && Math.hypot(enemy.x - anchor.x, enemy.z - anchor.z) > LEASH + half) enemy = null;
      if (!enemy && u.def.attack > 0 && pd < LEASH + half) {
        const recent = target.lastAttacker;
        if (recent && !recent.dead && g.isHostile(u.team, recent.team) &&
            g.time - (target.lastAttackTime || 0) < 5 &&
            Math.hypot(recent.x - anchor.x, recent.z - anchor.z) <= THREAT_RADIUS + half) {
          enemy = recent;
        } else {
          enemy = g.findEnemyNear(anchor, THREAT_RADIUS + half);
        }
      }
      if (enemy && !enemy.dead && g.isHostile(u.team, enemy.team)) {
        if (u.state !== STATE.ATTACK || u.target !== enemy) {
          u.target = enemy; u.state = STATE.ATTACK; u.path = null; u.targetPos = null;
        }
        continue;
      }

      const radius = half + 3 + Math.floor(rec.slot / 8) * 1.7;
      // Golden angle spreads successive assignments even when guards are
      // added one at a time, without reshuffling everyone else's position.
      const angle = rec.slot * 2.399963229728653;
      const x = anchor.x + Math.cos(angle) * radius;
      const z = anchor.z + Math.sin(angle) * radius;
      const away = Math.hypot(u.x - x, u.z - z);
      if (away < 1.8) {
        if (u.state !== STATE.IDLE) { u.state = STATE.IDLE; u.path = null; u.targetPos = null; u.target = null; u.destX = u.destZ = null; }
        continue;
      }
      if (g.time < rec.nextPath) continue;
      const movedSlot = !Number.isFinite(rec.x) || Math.hypot(x - rec.x, z - rec.z) > 2.2;
      if (movedSlot || u.state !== STATE.MOVE || !u.path) {
        rec.x = x; rec.z = z;
        rec.nextPath = g.time + 0.8 + (u.id % 5) * 0.11;
        u.target = null; u.state = STATE.MOVE;
        u.moveTo(x, z, true);
      }
    }
  }

  toJSON(unitIndex, buildingIndex) {
    const out = [];
    for (const [u, rec] of this.records) {
      const targetMap = rec.target.kind === 'building' ? buildingIndex : unitIndex;
      if (!unitIndex.has(u) || !targetMap.has(rec.target)) continue;
      out.push([unitIndex.get(u), rec.target.kind, targetMap.get(rec.target), rec.slot]);
    }
    return out;
  }

  fromJSON(data, units, buildings) {
    if (!Array.isArray(data)) return;
    for (const row of data) {
      const u = units[row[0]], target = row[1] === 'building' ? buildings[row[2]] : units[row[2]];
      if (!this.canGuard(u, target)) continue;
      const slot = Number.isInteger(row[3]) ? Math.max(0, Math.min(255, row[3])) : 0;
      u.guardTarget = target;
      this.records.set(u, { target, slot, x: NaN, z: NaN, nextPath: 0 });
    }
  }
}
