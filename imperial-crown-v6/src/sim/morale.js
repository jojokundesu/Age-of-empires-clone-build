/* ============================================================
   morale.js — the will to fight, and the carts behind it
   ------------------------------------------------------------
   An army is not a number. Every fighting unit carries morale, and
   morale comes from the ground it stands on:

     · beside a town centre, a castle or a supply tent it recovers;
     · away from all of them it bleeds away, faster at night;
     · watching a friend die within ten paces is a shock;
     · a kill within ten paces is a lift.

   Morale is a *reward*, never a punishment that takes the game away
   from the player. A well supplied, victorious army hits a little
   harder; an army that has outrun its tents simply stops getting the
   bonus. It never drops below MORALE_FLOOR, no unit ever routs, and no
   soldier ever refuses an order because of it -- the previous version
   could empty a bar in ninety seconds and turn an entire army round in
   the middle of a march, which is not a mechanic, it is a fault.

   Supply is deliberately simple to read: a radius around a building,
   drawn on the ground by the renderer, extended by a cheap Supply Tent
   that the player -- and the AI -- can place anywhere.
   ============================================================ */
import { clamp } from '../core/math.js';

/** The one string the rout behaviour is keyed on; mirrors STATE.ROUT. */
const STATE_ROUT = 'rout';

export const MORALE_MAX = 100;
/* The floor is where the multiplier is exactly 1. Nothing below it can
   happen any more; the constants are kept because saves, the AI and the
   Court all read them. */
export const MORALE_FLOOR = 60;
export const ROUT_AT = -1;         // unreachable: units do not break
export const RECOVER_AT = 45;
const PASS = 0.25;                 // the system ticks four times a second

export class Morale {
  constructor(game) {
    this.game = game;
    this._acc = 0;
    this._sources = { 1: [], 2: [] };
    this._frameSources = null;
    this.routs = 0;
  }

  homeOf(team) {
    const g = this.game;
    /* every crown has its own seat; the old two-corner fallback is kept for
       the tests and for callers that run before the world exists */
    if (g.baseOf) { const b = g.baseOf(team); if (b) return b; }
    return team === 1 ? g.playerBase : g.enemyBase;
  }

  /** Scan one team's live supply buildings. */
  _scan(team) {
    const out = [];
    const list = this.game.buildings;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dead || b.team !== team) continue;
      if (b.def && b.def.supply > 0) out.push(b);
    }
    return out;
  }

  /**
   * Every live supply building of a team. During a tick both teams are scanned
   * once and reused for every unit, so this is O(buildings) per tick rather
   * than O(units x buildings) -- the phone has ~40 buildings and ~120 men.
   */
  sourcesFor(team) {
    if (this._frameSources) return this._frameSources[team] || [];
    const out = this._sources[team] || (this._sources[team] = []);
    out.length = 0;
    for (const b of this._scan(team)) out.push(b);
    return out;
  }

  /** Closest supply source, or null. Used by routing units and the AI. */
  nearestSupply(unit) {
    const list = this.sourcesFor(unit.team);
    let best = null, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const d = (b.x - unit.x) ** 2 + (b.z - unit.z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** Is this unit inside its own supply net right now? */
  inSupply(unit) {
    const list = this.sourcesFor(unit.team);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if ((b.x - unit.x) ** 2 + (b.z - unit.z) ** 2 <= b.def.supply * b.def.supply) return true;
    }
    /* Standing among your own houses, walls and towers steadies a man as much
       as a tent does. Supply buildings still reach far further than they do --
       that is what the radius is for -- but a soldier defending a gate is not
       "out of supply" because the town centre is 40 m behind him.
       Without this clause the first army anyone sent to hold a wall broke and
       ran home while the enemy was still walking towards it. */
    const buildings = this.game.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b.dead || b.team !== unit.team) continue;
      if ((b.x - unit.x) ** 2 + (b.z - unit.z) ** 2 <= 18 * 18) return true;
    }
    /* a Marshal is a walking supply point for his own men (Court synergy) */
    if (this.game.court) {
      const h = this.game.court.holder(unit.team, 'marshal');
      if (h && !h.dead && (h.x - unit.x) ** 2 + (h.z - unit.z) ** 2 <= 14 * 14) return true;
    }
    return false;
  }

  /**
   * Damage multiplier from morale. It can only ever *help*: a full bar is
   * worth +8%, the floor is worth nothing. There is no penalty branch left,
   * because there is no state in which morale can fall below the floor.
   */
  attackMul(unit) {
    const m = unit.morale === undefined ? MORALE_MAX : unit.morale;
    return 1 + Math.max(0, Math.min(1, (m - MORALE_FLOOR) / (MORALE_MAX - MORALE_FLOOR))) * 0.08;
  }

  speedMul(unit) {
    /* Speed is never taken away from a soldier for being tired: an order
       that is slower than the player expects reads as a broken control. */
    return 1;
  }

  /** Damage taken while running: the back is the softest part of a soldier. */
  damageTakenMul(unit) {
    return 1;
  }

  /**
   * Where a broken man can find his nerve: inside the supply net, or at any
   * friendly building at all. The second clause is what keeps a rout from
   * becoming a death sentence -- men run home, the town steadies them, and
   * the army comes back. A rout should cost ground, not the army.
   */
  rallyable(unit) {
    if (this.inSupply(unit)) return true;
    const list = this.game.buildings;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dead || b.team !== unit.team) continue;
      if ((b.x - unit.x) ** 2 + (b.z - unit.z) ** 2 <= 18 * 18) return true;
    }
    return false;
  }

  /**
   * Kept for API compatibility with saves, mods and older call sites -- but
   * it no longer breaks anybody. A unit the player has ordered somewhere
   * stays ordered; losing the army's nerve is not a thing this game does.
   */
  break_(unit) {
    if (!unit || unit.state !== STATE_ROUT) return;
    unit.state = 'idle';
    unit.routT = 0;
  }

  /** Only the fighting line has morale; the economy does not break. */
  keepsMorale(u) {
    if (!u.def || u.type === 'villager') return false;
    return (u.def.attack || 0) > 0 || (u.def.classes || []).includes('monk');
  }

  /** A friend died in sight. */
  onAllyDeath(dead, killer) {
    if (!dead || dead.kind !== 'unit') return;
    if (!this.keepsMorale(dead)) return;
    const units = this.game.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u === dead || u.team !== dead.team) continue;
      if (!this.keepsMorale(u)) continue;
      const d2 = (u.x - dead.x) ** 2 + (u.z - dead.z) ** 2;
      if (d2 > 11 * 11) continue;
      u.morale = clamp((u.morale === undefined ? MORALE_MAX : u.morale) - (d2 < 25 ? 6 : 4), MORALE_FLOOR, MORALE_MAX);
    }
  }

  /** A friend killed in sight. */
  onKill(killer) {
    if (!killer || killer.kind !== 'unit') return;
    const units = this.game.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.team !== killer.team || !this.keepsMorale(u)) continue;
      if ((u.x - killer.x) ** 2 + (u.z - killer.z) ** 2 > 11 * 11) continue;
      u.morale = clamp((u.morale === undefined ? MORALE_MAX : u.morale) + 5, MORALE_FLOOR, MORALE_MAX);
    }
  }

  update(dt) {
    this._acc += dt;
    if (this._acc < PASS) return;
    const step = this._acc;
    this._acc = 0;
    const g = this.game;
    const night = g.dayPhase === 'night';
    this._frameSources = {};
    const roster = g.teamIds || [1, 2];
    for (let i = 0; i < roster.length; i++) this._frameSources[roster[i]] = this._scan(roster[i]);
    const units = g.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.garrisoned) continue;
      if (!this.keepsMorale(u)) { u.morale = MORALE_MAX; continue; }
      if (u.morale === undefined) u.morale = MORALE_MAX;
      const fed = this.inSupply(u);
      u.fed = fed;
      /* Morale is about *support and losses*, not a timer. A man with a spear
         in his hands and an enemy in front of him is not counting the miles
         home: while he is actually fighting, morale barely moves. It is the
         march, the waiting, the night and the casualties that break an army.
         Without this, any fight far from a town centre turned into a race to
         see whose damage decayed first. */
      /* Three different things used to share one number, and that number was
         -1.05 a second: an army more than a supply radius from home was empty
         in 95 seconds whether it was fighting, marching or standing guard. A
         march to the enemy's town takes three minutes on this island, so no
         army ever arrived -- the men turned their backs and walked home, which
         reads as units "turning away for no reason". The three cases are now
         separated by what they cost:
           · fighting:            almost nothing, or a battle would break men
                                  faster than the enemy could;
           · marching:            a slow bleed, so a long campaign needs tents
                                  but is never a suicide;
           · standing in the open: the real cost, so parking an army nowhere
                                  near home still eventually costs it its nerve.
      */
      const fighting = u.state === 'attack';
      const marching = u.state === 'move' || u.state === 'attackmove'
        || u.state === 'patrol' || u.state === 'return';
      let rate;
      const safe = u.state === STATE_ROUT ? this.rallyable(u) : fed;
      if (safe) rate = u.state === STATE_ROUT ? 5.5 : 2.2;
      else if (fighting) rate = -0.05;
      else if (marching) rate = -0.20;
      else rate = u.state === STATE_ROUT ? 1.6 : -0.45;
      /* the Wheel of the Year: winter is a second enemy, spring a nurse.
         The season multiplies the *gain* and sharpens the *loss*, so a fed
         army still holds in winter but a starving one dies faster there. */
      if (g.calendar) {
        const m = g.calendar.moraleMul();
        rate = rate > 0 ? rate * m : rate / Math.max(0.4, m);
      }
      if (night) rate -= 0.12;
      /* a legend's banner steadies the line: men under it bleed morale slower */
      if (g.elites && g.elites.commanded.has(u)) rate += 0.35;
      u.morale = clamp(u.morale + rate * step, MORALE_FLOOR, MORALE_MAX);
      /* Anything that was broken before this build is walking again: a rout
         is no longer a state the simulation can enter, so a save from an
         older version heals on load instead of leaving a man running. */
      if (u.state === STATE_ROUT) {
        u.state = 'idle';
        u.routT = 0;
        u.morale = MORALE_FLOOR;
      }
    }
    this._frameSources = null;
  }

  toJSON() { return { routs: this.routs }; }
  fromJSON(data) { if (data && Number.isFinite(data.routs)) this.routs = data.routs; }
}
