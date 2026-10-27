/* ============================================================
   morale.js — the will to fight, and the carts behind it
   ------------------------------------------------------------
   An army is not a number. Every fighting unit carries morale, and
   morale comes from the ground it stands on:

     · beside a town centre, a castle or a supply tent it recovers;
     · away from all of them it bleeds away, faster at night;
     · watching a friend die within ten paces is a shock;
     · a kill within ten paces is a lift.

   At low morale a unit hits softer and walks slower. At zero it
   *breaks*: it drops its orders, turns its back and runs for the
   nearest supply, and nothing the player taps will turn it around
   until it has recovered. Running does not save it either -- a broken
   man is slower than a formed one and takes half again as much damage.
   That is the whole point of the system: a raid that outruns its tents
   loses its teeth, and a defended town beats an army that cannot feed
   itself.

   Supply is deliberately simple to read: a radius around a building,
   drawn on the ground by the renderer, extended by a cheap Supply Tent
   that the player -- and the AI -- can place anywhere.
   ============================================================ */
import { clamp } from '../core/math.js';

/** The one string the rout behaviour is keyed on; mirrors STATE.ROUT. */
const STATE_ROUT = 'rout';

export const MORALE_MAX = 100;
export const ROUT_AT = 8;          // below this a unit breaks
export const RECOVER_AT = 45;      // and this is what it takes to come back
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
    /* a Marshal is a walking supply point for his own men (Court synergy) */
    if (this.game.court) {
      const h = this.game.court.holder(unit.team, 'marshal');
      if (h && !h.dead && (h.x - unit.x) ** 2 + (h.z - unit.z) ** 2 <= 14 * 14) return true;
    }
    return false;
  }

  /** Damage multiplier from morale: only the bottom half of the bar bites. */
  attackMul(unit) {
    const m = unit.morale === undefined ? MORALE_MAX : unit.morale;
    if (m >= 60) return 1;
    return 1 - (60 - m) * 0.004;      // 0.76 at zero
  }

  speedMul(unit) {
    /* A broken man does not outrun a formed one. Rout is a disaster, not a
       free exit: the point of holding morale up is that you never have to
       find out how the chase ends. */
    if (unit.state === STATE_ROUT) return 0.9;
    const m = unit.morale === undefined ? MORALE_MAX : unit.morale;
    return m < 30 ? 0.94 : 1;
  }

  /** Damage taken while running: the back is the softest part of a soldier. */
  damageTakenMul(unit) {
    return unit.state === STATE_ROUT ? 1.5 : 1;
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

  /** A rout is a state change with consequences; keep it in one place. */
  break_(unit) {
    if (unit.state === STATE_ROUT) return;
    unit.state = STATE_ROUT;
    unit.target = null;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIdx = 0;
    unit.routT = 0;
    unit.aiRole = null;
    this.routs++;
    if (unit.team === this.game.playerTeam) {
      this.game.notify(`${unit.name} has broken and is falling back`, 'bad');
      this.game.sound.play('warn');
      this.game.fx.dust(unit.x, (unit.y || 0) + 0.3, unit.z, 4, 1.0);
    }
    try { this.game.onEvent('rout', { unit }); } catch (e) { /* listeners are not the sim */ }
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
      u.morale = clamp((u.morale === undefined ? MORALE_MAX : u.morale) - (d2 < 25 ? 14 : 9), 0, MORALE_MAX);
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
      u.morale = clamp((u.morale === undefined ? MORALE_MAX : u.morale) + 5, 0, MORALE_MAX);
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
      const engaged = u.state === 'attack' || u.state === 'attackmove';
      let rate;
      const safe = u.state === STATE_ROUT ? this.rallyable(u) : fed;
      if (safe) rate = u.state === STATE_ROUT ? 5.5 : 2.2;
      else if (engaged) rate = -0.18;
      else rate = u.state === STATE_ROUT ? 1.6 : -1.05;
      /* the Wheel of the Year: winter is a second enemy, spring a nurse.
         The season multiplies the *gain* and sharpens the *loss*, so a fed
         army still holds in winter but a starving one dies faster there. */
      if (g.calendar) {
        const m = g.calendar.moraleMul();
        rate = rate > 0 ? rate * m : rate / Math.max(0.4, m);
      }
      if (night) rate -= 0.35;
      /* a legend's banner steadies the line: men under it bleed morale slower */
      if (g.elites && g.elites.commanded.has(u)) rate += 0.35;
      u.morale = clamp(u.morale + rate * step, 0, MORALE_MAX);
      /* Last Stand: a Renowned man who has drawn his final line does not break
         for its six seconds, whatever happens around him. */
      const floor = u.stats ? (u.stats().moraleFloor || 0) : 0;
      if (floor && u.morale < floor) u.morale = floor;
      if (u.morale <= ROUT_AT) this.break_(u);
      else if (u.state === STATE_ROUT && u.morale >= RECOVER_AT) {
        u.state = 'idle';
        u.routT = 0;
        if (u.team === g.playerTeam) g.notify(`${u.name} has recovered`, 'good');
      }
    }
    this._frameSources = null;
  }

  toJSON() { return { routs: this.routs }; }
  fromJSON(data) { if (data && Number.isFinite(data.routs)) this.routs = data.routs; }
}
