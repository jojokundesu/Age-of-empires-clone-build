/* ============================================================
   veterancy.js — what a soldier learns by surviving
   ------------------------------------------------------------
   Every fighting man keeps a record of what he has done, and the
   record changes him:

       Recruit     0 xp    base stats
       Seasoned   26 xp    +8 % hp, +10 % attack
       Veteran    78 xp    +18 % hp, +22 % attack, +1 armour
       Elite     170 xp    +30 % hp, +35 % attack, +2 armour

   Experience comes from *doing the job*, not from being trained:

     · damage dealt pays 0.11 xp per point, weighted by what was hit
       (a building is worth more, a 90-hp peasant less);
     · a kill pays a lump sum that grows with the victim's rank, so
       killing the enemy's veterans is itself a way to make your own;
     · a monk pays for every point of healing.

   Villagers are deliberately excluded: the economy must not become a
   second army. Buildings are excluded for the same reason.

   The promotion is a real change to the unit, not a buff aura: max
   hit points go up, the difference is healed, `stats()` picks the
   multiplier up on the next call (the caller bumps `statsVersion`),
   and the man keeps it until he dies. The renderer draws one gold
   chevron per rank over his head and the inspector names the rank,
   because a player has to be able to see who their veterans are.
   ============================================================ */
import { clamp } from '../core/math.js';

export const RANKS = [
  { key: 'recruit', name: 'Recruit', xp: 0, hp: 1.00, atk: 1.00, arm: 0, chevrons: 0 },
  { key: 'seasoned', name: 'Seasoned', xp: 26, hp: 1.08, atk: 1.10, arm: 0, chevrons: 1 },
  { key: 'veteran', name: 'Veteran', xp: 78, hp: 1.18, atk: 1.22, arm: 1, chevrons: 2 },
  { key: 'elite', name: 'Elite', xp: 170, hp: 1.30, atk: 1.35, arm: 2, chevrons: 3 }
];
export const MAX_RANK = RANKS.length - 1;

/** Experience needed to *leave* `rank`. Infinity at the top. */
export function xpFor(rank) {
  return rank >= MAX_RANK ? Infinity : RANKS[rank + 1].xp;
}

export function rankOf(xp) {
  let r = 0;
  while (r < MAX_RANK && xp >= RANKS[r + 1].xp) r++;
  return r;
}

/* How much a kill is worth. Buildings are prizes; a farm is not. */
function killXp(victim) {
  const maxHp = victim.maxHp || (victim.def && victim.def.hp) || 50;
  if (victim.kind === 'building') return 14 + maxHp / 120;
  return 9 + maxHp / 45 + (victim.rank || 0) * 5;
}

/* How much damage is worth, relative to a body of 90 hit points. */
function damageWeight(victim) {
  if (victim.kind === 'building') return 1.6;
  const maxHp = victim.maxHp || 90;
  return clamp(maxHp / 90, 0.4, 2.2);
}

export class Veterancy {
  constructor(game) {
    this.game = game;
    this.promotions = 0;
  }

  /** Ranks are not a thing for workers, monks excepted, nor for buildings. */
  eligible(unit) {
    if (!unit || unit.dead || unit.kind !== 'unit') return false;
    if (unit.type === 'villager') return false;
    const def = unit.def;
    if (!def) return false;
    if ((def.attack || 0) > 0) return true;
    return (def.classes || []).includes('monk');
  }

  rank(unit) { return unit && unit.rank ? unit.rank : 0; }
  name(unit) { return RANKS[this.rank(unit)].name; }
  chevrons(unit) { return RANKS[this.rank(unit)].chevrons; }

  /** The multiplier table entry for a unit's current rank. */
  mul(unit) { return RANKS[this.rank(unit)]; }

  /** 0..1 toward the next rank, for a HUD or a test. */
  progress(unit) {
    const r = this.rank(unit);
    if (r >= MAX_RANK) return 1;
    const lo = RANKS[r].xp, hi = RANKS[r + 1].xp;
    return clamp(((unit.xp || 0) - lo) / Math.max(1, hi - lo), 0, 1);
  }

  /**
   * Award experience and promote as many times as the total allows.
   * Returns the number of ranks gained.
   */
  gain(unit, amount, _why) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (!this.eligible(unit)) return 0;
    const before = this.rank(unit);
    unit.xp = (unit.xp || 0) + amount;
    const after = Math.min(MAX_RANK, rankOf(unit.xp));
    if (after === before) return 0;
    unit.rank = after;
    unit.xp = Math.min(unit.xp, RANKS[MAX_RANK].xp + 2000);
    /* hit points are a real change: grow the pool and heal the difference, so
       a promotion is a reward in the middle of a fight and not a trap */
    const base = unit.baseMaxHp || unit.maxHp;
    unit.baseMaxHp = base;
    const hp = Math.round(base * RANKS[after].hp);
    if (hp > unit.maxHp) {
      unit.hp += hp - unit.maxHp;
      unit.maxHp = hp;
      unit.hp = Math.min(unit.hp, unit.maxHp);
    }
    unit._stats = null;
    this.game.statsVersion++;
    this.promotions++;
    /* presentation: a small flash at the man, and the horn at the top rank */
    const g = this.game;
    if (g.fx && g.fx.glowPulse) g.fx.glowPulse(unit.x, (unit.y || 0) + 1.1, unit.z, 0.9, 0.82, 0.45);
    if (after === MAX_RANK && g.sound) g.sound.play('horn');
    if (unit.team === g.playerTeam && g.notify) {
      const mark = after === MAX_RANK ? '★ ' : '';
      g.notify(`${mark}${unit.name} is now ${RANKS[after].name}`, 'good');
    }
    if (g.onEvent) {
      try { g.onEvent('promotion', { unit, rank: after, from: before }); } catch (e) { /* an event listener cannot break a promotion */ }
    }
    return after - before;
  }

  /** Called from takeDamage with the *pre-armour* amount the blow was worth. */
  onDamage(attacker, amount, victim) {
    if (!attacker || !victim || attacker === victim) return;
    if (!this.eligible(attacker)) return;
    if (victim.team === attacker.team) return;
    this.gain(attacker, Math.max(0, amount) * 0.11 * damageWeight(victim), 'damage');
  }

  onKill(attacker, victim) {
    if (!attacker || !victim) return;
    if (!this.eligible(attacker)) return;
    if (victim.team === attacker.team) return;
    this.gain(attacker, killXp(victim), 'kill');
  }

  onHeal(monk, amount) {
    if (!monk || !amount) return;
    if (!this.eligible(monk)) return;
    this.gain(monk, Math.abs(amount) * 0.06, 'heal');
  }

  /* A save carries rank and xp on the unit tuple; nothing else to store. */
  toJSON() { return { promotions: this.promotions }; }
  fromJSON(data) { if (data && Number.isFinite(data.promotions)) this.promotions = data.promotions; }
}
