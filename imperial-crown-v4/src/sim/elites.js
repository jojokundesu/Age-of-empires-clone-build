/* ============================================================
   elites.js — what a soldier becomes by *not dying*
   ------------------------------------------------------------
   Veterancy (veterancy.js) is the XP ladder: it pays for work
   done and turns a peasant into an Elite in one battle. This is
   the other axis, and the more frightening one: *time*. A man
   who has stood on the line for fifteen minutes has seen things
   a fresh recruit has not, and he does not simply have more
   numbers -- he has learned tricks, and each trick has an answer.

       Untested    0:00   nothing yet
       Blooded     2:00   Field Dressing   (wounds close when unhurt)
       Hardened    5:00   Shieldwall       (+3 armour from the front)
       Renowned   9:00   Last Stand       (a cornered elite turns savage)
       Legend     15:00   Banner           (allies nearby fight harder)

   Every tier has a *specific* counter, and the counters are not
   the same shape, so an army cannot answer a veteran line with a
   single unit type:

     Field Dressing   any sustained pressure -- the cloth only works
                      while nothing is hitting him. Siege wounds
                      (a rock, a bolt from a scorpion) stop it for
                      four seconds even after the barrage ends.
     Shieldwall       flanking (the bonus is a frontal 140-degree
                      arc), siege (ignores armour), and fire.
     Last Stand       isolation: a Renowned man only finds the fury
                      when at least one ally is within 12 m, so
                      cutting him off is the counter. Monks convert
                      him and the corpse never gets to be a martyr.
     Banner           break the legend's morale below 50 and the
                      banner falls; kill him and it dies with him.
                      The enemy AI puts a large bounty on him, so
                      the real counter is that everyone wants him
                      dead at once.

   Elites are deliberately *visible*: chevrons show rank, a small
   rising star shows renown. A player must be able to tell at a
   glance which of the enemy's men is the one worth killing.
   ============================================================ */
import { clamp } from '../core/math.js';

export const RENOWN = [
  {
    key: 'untested', name: 'Untested', at: 0, star: 0,
    blurb: 'A soldier who has not yet been tested.',
    power: '—', counter: '—'
  },
  {
    key: 'blooded', name: 'Blooded', at: 120, star: 1,
    blurb: 'He has been in the line and walked out of it.',
    power: 'Field Dressing: closes 1.6 hp/s after six seconds without a wound.',
    counter: 'Sustained pressure. Siege wounds keep it closed for four seconds.'
  },
  {
    key: 'hardened', name: 'Hardened', at: 300, star: 2,
    blurb: 'He has learned to stand where the arrows fall.',
    power: 'Shieldwall: +3 armour against blows from the front arc.',
    counter: 'Flanking, siege engines, and fire. None of them care about a shield.'
  },
  {
    key: 'renowned', name: 'Renowned', at: 540, star: 3,
    blurb: 'Men tell stories about him. Some of them are even true.',
    power: 'Last Stand: below a quarter health, with an ally within 12 m, +30% attack and +2 armour for 6 s (75 s cooldown).',
    counter: 'Isolate him, or convert him. A cornered man with no line behind him finds nothing.'
  },
  {
    key: 'legend', name: 'Legend', at: 900, star: 4,
    blurb: 'The banner is not a flag any more. It is him.',
    power: 'Banner: allies within 9 m strike 10% harder. He is always visible to the enemy.',
    counter: 'Break his morale below 50 (the banner falls) or kill him. Expect the enemy to hunt him.'
  }
];
export const MAX_RENOWN = RENOWN.length - 1;

/** The renown tier a survival time buys. */
export function renownOf(seconds) {
  let r = 0;
  while (r < MAX_RENOWN && seconds >= RENOWN[r + 1].at) r++;
  return r;
}

/* How long Field Dressing needs without a wound, and how long a siege wound
   keeps it shut. */
const REGEN_DELAY = 6;
const SIEGE_WOUND = 4;
const REGEN_RATE = 1.6;
/* Last Stand */
const LAST_STAND_AT = 0.25;
const LAST_STAND_TIME = 6;
const LAST_STAND_COOLDOWN = 75;
const LAST_STAND_ALLY_RANGE = 12;
/* Banner */
const BANNER_RANGE = 9;
const BANNER_ATTACK = 1.10;
const BANNER_MORALE_FLOOR = 50;

export class Elites {
  constructor(game) {
    this.game = game;
    this.ascensions = 0;
    this.lastStand = 0;
    this._acc = 0;
    /* units that serve under a living banner, refreshed twice a second */
    this.commanded = new Set();
  }

  /** Soldiers only: workers, monks and buildings do not grow harder with age. */
  eligible(u) {
    if (!u || u.dead || u.kind !== 'unit') return false;
    if (u.type === 'villager') return false;
    const d = u.def;
    if (!d) return false;
    return (d.attack || 0) > 0 || (d.classes || []).includes('monk');
  }

  tier(u) { return u && u.renown ? u.renown : 0; }

  /** Called when the unit is created. Survival is measured from here. */
  enrol(u) {
    if (!u || u.dead) return;
    u.survived = 0;                   // seconds this soldier has stayed alive under arms
    u.renown = 0;
    u.lastHurt = -99;
    u.rally = 0;                      // time the current Last Stand ends
    u.rallyCd = 0;                    // time the next one may begin
  }

  /** A wound: records the time and, for siege, keeps the dressing shut. */
  onHurt(unit, kind) {
    if (!unit) return;
    unit.lastHurt = this.game.time;
    if (kind === 'siege') unit.regenBlocked = this.game.time + SIEGE_WOUND;
  }

  /* ------------------------------------------------------------
     the clock: survival, promotion, regeneration and last stands
     ------------------------------------------------------------ */
  update(dt) {
    const g = this.game;
    this._acc += dt;
    if (this._acc < 0.5) return;      // twice a second is plenty
    const step = this._acc;
    this._acc = 0;
    const before = this.commanded;
    this.commanded = new Set();
    let commandedHash = 0;

    const legends = [];
    let statsChanged = false;
    for (let i = 0; i < g.units.length; i++) {
      const u = g.units[i];
      if (u.dead) continue;
      if (!this.eligible(u)) continue;
      if (u.survived === undefined) this.enrol(u);
      u.survived += step;

      /* ---- promotion by survival ---- */
      const r = renownOf(u.survived);
      if (r > this.tier(u)) {
        u.renown = r;
        statsChanged = true;
        this.ascensions++;
        const tier = RENOWN[r];
        if (g.fx) g.fx.glowPulse(u.x, (u.y || 0) + 1.2, u.z, 1, 0.86, 0.5);
        if (u.team === g.playerTeam && g.notify) {
          g.notify(`${u.name || u.type} has become ${tier.name} — ${tier.power.split(':')[0]}`, 'good');
        }
        if (g.onEvent) {
          try { g.onEvent('renown', { unit: u, tier: r, name: tier.name }); } catch (e) { /* never break a promotion */ }
        }
      }
      const tier = this.tier(u);

      /* ---- Field Dressing ---- */
      if (tier >= 1 && this.eligibleHealing(u)) {
        const blocked = u.regenBlocked && g.time < u.regenBlocked;
        const since = Number.isFinite(u.lastHurt) ? u.lastHurt : -99;
        if (!blocked && g.time - since >= REGEN_DELAY && u.hp < u.maxHp) {
          u.hp = Math.min(u.maxHp, u.hp + REGEN_RATE * step);
        }
      }

      /* ---- Last Stand ---- */
      if (tier >= 3) {
        const ratio = u.hp / Math.max(1, u.maxHp);
        if (ratio > 0 && ratio <= LAST_STAND_AT && g.time >= (u.rallyCd || 0) && this.hasAllyNear(u, LAST_STAND_ALLY_RANGE)) {
          u.rally = g.time + LAST_STAND_TIME;
          u.rallyCd = g.time + LAST_STAND_COOLDOWN;
          this.lastStand++;
          statsChanged = true;
          if (g.fx) g.fx.sparks(u.x, (u.y || 0) + 1.4, u.z, 10, [1, 0.55, 0.2]);
          if (u.team === g.playerTeam && g.notify) g.notify(`${u.name || u.type} makes a last stand`, 'warn');
        }
      }
      if (u.rally && g.time >= u.rally) { u.rally = 0; statsChanged = true; }

      /* ---- Banner ---- */
      if (tier >= MAX_RENOWN && (u.morale === undefined || u.morale >= BANNER_MORALE_FLOOR)) legends.push(u);
    }

    /* Banner auras: a handful of legends against a company, so the plain
       double loop is cheaper than building a spatial grid for it. */
    for (const l of legends) {
      const r2 = BANNER_RANGE * BANNER_RANGE;
      for (let i = 0; i < g.units.length; i++) {
        const u = g.units[i];
        if (u === l || u.dead || u.team !== l.team) continue;
        if ((u.x - l.x) ** 2 + (u.z - l.z) ** 2 > r2) continue;
        this.commanded.add(u);
        commandedHash = (commandedHash ^ u.id) >>> 0;
      }
    }
    /* the banner's aura is part of a unit's stat block, so a change in who
       stands under it has to invalidate the cache */
    if (before.size !== this.commanded.size || commandedHash !== this._cmdHash) {
      this._cmdHash = commandedHash;
      statsChanged = true;
    }
    if (statsChanged) g.statsVersion++;
  }

  /** Field Dressing does not work on a machine, a building or the dead. */
  eligibleHealing(u) {
    return u.kind === 'unit' && (u.def.attack || 0) >= 0 && !(u.def.classes || []).includes('siege');
  }

  hasAllyNear(u, range) {
    const g = this.game;
    const r2 = range * range;
    for (let i = 0; i < g.units.length; i++) {
      const o = g.units[i];
      if (o === u || o.dead || o.team !== u.team) continue;
      if (o.type === 'villager') continue;
      if ((o.x - u.x) ** 2 + (o.z - u.z) ** 2 <= r2) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------
     what the rest of the simulation asks
     ------------------------------------------------------------ */

  /** Fold the current renown bonuses into a unit's stat block. */
  applyStats(u, s) {
    const tier = this.tier(u);
    if (tier >= 1 && this.eligibleHealing(u)) s.regen = Math.max(s.regen || 0, REGEN_RATE);
    if (tier >= 3 && u.rally && u.rally > this.game.time) {
      s.attack *= 1.30;
      s.armor += 2;
      s.pierceArmor += 2;
      s.moraleFloor = Math.max(s.moraleFloor || 0, 60);
    }
    if (this.commanded.has(u)) s.attack *= BANNER_ATTACK;
    if (tier >= 1) s.renown = tier;
    return s;
  }

  /**
   * The extra armour Shieldwall is worth against *this* attacker.
   * Zero for anything that does not come at the front of the man.
   */
  shieldwall(u, attacker, kind) {
    const tier = this.tier(u);
    if (tier < 2) return 0;
    if (kind === 'siege') return 0;              // a rock does not care about a shield
    if (!attacker || attacker.kind !== 'unit') return 0;
    const dx = attacker.x - u.x, dz = attacker.z - u.z;
    const len = Math.hypot(dx, dz) || 1;
    /* the unit's facing is a direction in the x/z plane */
    const fx = Math.sin(u.facing), fz = Math.cos(u.facing);
    const dot = (dx / len) * fx + (dz / len) * fz;
    /* front 140-degree arc: cos(70 degrees) ~ 0.342 */
    return dot >= 0.342 ? 3 : 0;
  }

  /** The banner is a beacon: the enemy always knows where this man is. */
  isBeacon(u) {
    return this.tier(u) >= MAX_RENOWN && (u.morale === undefined || u.morale >= BANNER_MORALE_FLOOR);
  }

  /** How much this unit is worth to an enemy commander, as a multiplier. */
  bounty(u) {
    const tier = this.tier(u);
    return tier >= MAX_RENOWN ? 3 : tier >= 3 ? 1.8 : tier >= 2 ? 1.3 : 1;
  }

  /** The HUD inspector's description of a unit's renown, or null. */
  describe(u) {
    const tier = this.tier(u);
    if (!tier) return null;
    const t = RENOWN[tier];
    const next = tier < MAX_RENOWN ? RENOWN[tier + 1] : null;
    const left = next ? Math.max(0, Math.ceil(next.at - (u.survived || 0))) : 0;
    return {
      tier, name: t.name, star: t.star, power: t.power, counter: t.counter,
      next: next ? next.name : null, left
    };
  }

  /** Every legend on the field, for the AI's bounty board and the HUD. */
  legends(team) {
    const out = [];
    for (const u of this.game.units) {
      if (u.dead || u.team === team) continue;
      if (this.tier(u) >= MAX_RENOWN) out.push(u);
    }
    return out;
  }

  reset() {
    this.ascensions = 0;
    this.lastStand = 0;
    this.commanded = new Set();
    this._cmdHash = 0;
    this._acc = 0;
  }

  /* Survival time is stored on the unit itself (a save carries it in the
     unit tuple), so there is nothing else to write. */
  toJSON() { return { ascensions: this.ascensions, lastStand: this.lastStand }; }
  fromJSON(d) {
    if (!d) return;
    if (Number.isFinite(d.ascensions)) this.ascensions = d.ascensions;
    if (Number.isFinite(d.lastStand)) this.lastStand = d.lastStand;
  }
}
