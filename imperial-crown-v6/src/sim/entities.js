/* ============================================================
   entities.js — Units, Buildings and Resource Nodes
   A compact but deep RTS behaviour set: gather loops with drop-offs,
   stacked construction, formation movement, aggro/stances, ballistic
   projectiles, monk conversion, garrison arrows, garrisoned healing.
   ============================================================ */
import { UNIT_DEFS, BUILDING_DEFS, AGES, TECH_DEFS } from './data.js';
import { clamp, lerp, angleLerp, dist2 } from '../core/math.js';

/* Sim-owned randomness. `rngOf(e)` is the entity's game stream; a handful of
   call sites are in the Building and Resource classes, which also hold `game`.
   Anything visual (fx.dust jitter) can stay on the entity stream too: it is
   deterministic, and it costs nothing. */
const rngOf = (e) => (e && e.game && e.game.rng ? e.game.rng : Math.random);
const randRange = (a, b, rng = Math.random) => a + rng() * (b - a);

/** Distance from an entity to a building's footprint (0 when overlapping). */
function rectDist(e, b) {
  const half = (b.def?.size || 2) * 0.5;
  const dx = Math.max(0, Math.abs(e.x - b.x) - half);
  const dz = Math.max(0, Math.abs(e.z - b.z) - half);
  return Math.hypot(dx, dz);
}

/** A point just outside a building footprint in the entity's direction. */
function edgePoint(e, b, pad, out) {
  const half = (b.def?.size || 2) * 0.5 + pad;
  const dx = e.x - b.x, dz = e.z - b.z;
  if (Math.abs(dx) > Math.abs(dz)) {
    out[0] = b.x + Math.sign(dx || 1) * half;
    out[1] = b.z + clamp(dz, -half, half);
  } else {
    out[0] = b.x + clamp(dx, -half, half);
    out[1] = b.z + Math.sign(dz || 1) * half;
  }
  return out;
}
/* Health regeneration, one place, two layers. See Unit.update. */
export const REGEN_LIMIT = 0.35;      // plain soldiers only recover a third of the wound
export const REGEN_RATE = 0.9;        // hp per second while that is true
export const REGEN_DELAY = 6;         // seconds since the last blow before any of it starts

const _edge = [0, 0];
/* scratch for Unit.strideIn(): the walls near the stride, copied out of the
   shared spatial-query buffer before isPassable() can overwrite it */
const _strideWalls = [];

export const STATE = {
  IDLE: 'idle', MOVE: 'move', ATTACK: 'attack', ATTACK_MOVE: 'attackmove',
  GATHER: 'gather', RETURN: 'return', BUILD: 'build', REPAIR: 'repair',
  HEAL: 'heal', CONVERT: 'convert', GARRISON: 'garrison', PATROL: 'patrol',
  DEAD: 'dead', TRADE: 'trade', UNPACK: 'unpack',
  /* ROUT is a state, not a flag: a broken unit runs a different behaviour
     branch entirely and the whole command layer has to be able to recognise
     it. Keeping it in STATE means every tool that reads a unit's state --
     contract tests, the inspector, a mod -- sees it. */
  ROUT: 'rout', CONTROLLED: 'controlled'
};

/* Entity ids come from the *game*, not from a module-level counter. Two games
   built from the same seed therefore number their units identically, which is
   what makes a replay byte-for-byte reproducible; and a save can restore the
   counter alongside the entities. The fallback keeps entities creatable before
   a game exists (tools, previews). */
let idCounter = 1;
export const nextEntityId = () => idCounter++;

export class Entity {
  constructor(game, type, team, x, z) {
    this.game = game;
    this.id = game && game.nextId ? game.nextId() : nextEntityId();
    this.type = type;
    this.team = team;
    this.x = x;
    this.z = z;
    this.y = game.heightAt(x, z);
    this.facing = (this.game ? this.game.rng() : Math.random()) * Math.PI * 2;
    this.dead = false;
    this.deadT = 0;
    this.hp = 1;
    this.maxHp = 1;
    this.selected = false;
    this.hitFlash = 0;
    this.hurtAt = -99;               // last time something landed (see regen)
    this.radius = 0.5;
    this.height = 1.8;
    this.lastAttacker = null;
    this.lastAttackTime = -99;
    /* Measured velocities, for aim-leading and for the renderer. They are
       filled in by Game.update, but an entity that appears *during* a tick
       (a trained unit walking out of its queue) is never visited by that
       loop, and read as undefined until the next one. */
    this.vx = 0;
    this.vz = 0;
  }
  takeDamage(amount, attacker, kind = 'melee') {
    if (this.dead) return 0;
    /* A dodge, a parry follow-through or a mod can make the body untouchable
       for a moment. The check lives here, once, so every damage source in the
       game -- arrows in flight, a spell, a wall of elephants -- respects it. */
    if (this.invulnerableUntil && this.game && this.game.time < this.invulnerableUntil) {
      if (this.game.directControl && this.game.directControl.unit === this) this.game.directControl.feedback('EVADE', 'dodge');
      return 0;
    }
    const before = this.hp;
    // Armour: melee hits are absorbed by armour, arrows/javelins by pierce
    // armour. Every hit still lands for at least 1, so nothing is immune.
    let armor = 0;
    if (this.kind === 'unit' && this.stats) {
      const st = this.stats();
      armor = kind === 'pierce' ? st.pierceArmor : st.armor;
    } else if (this.def) {
      armor = kind === 'pierce' ? (this.def.pierceArmor || 0) : (this.def.armor || 0);
    }
    if (this.squad && this.game.squads) armor += this.game.squads.armorBonus(this);
    if (kind === 'siege') armor *= 0.35;
    /* Shieldwall: a Hardened man's armour is worth more against a blow he can
       see coming. The bonus is directional, so flanking really is the answer. */
    if (this.game && this.game.elites) {
      const wall = this.game.elites.shieldwall(this, attacker, kind);
      if (wall) armor += wall;
    }
    /* a man who has turned his back is the easiest kill on the field */
    if (this.game && this.game.morale) amount *= this.game.morale.damageTakenMul(this);
    if (this.game && this.game.buffMul) {
      const blessed = this.game.buffMul(this.team, 'armor');
      if (blessed > 1) armor += blessed;
    }
    amount = Math.max(1, amount - armor);
    /* a mod may scale the hit (a ward, a shield, a cursed target). Guarded:
       with no mod session this costs one null check. */
    if (this.game && this.game.modHost) {
      const modded = this.game.modHost.onDamage(this, amount, attacker, kind);
      if (typeof modded === 'number' && modded >= 0) amount = modded;
    }
    /* The Champion's guard: blocking, parry, flat reduction and Second Wind.
       It runs after armour and after mods, so a perk cannot be duplicated by
       an earlier layer, and the number it returns is the number that lands. */
    if (this.champion && this.game && this.game.champions) {
      amount = this.game.champions.mitigate(this, amount, attacker, kind);
    }
    const hpBefore = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = Math.min(1, this.hitFlash + 0.55);
    this.hurtAt = this.game ? this.game.time : 0;
    /* the man who swung learns from the blow, whether or not it kills */
    const dealt = hpBefore - this.hp;
    if (attacker && this.game && this.game.veterancy && dealt > 0) {
      this.game.veterancy.onDamage(attacker, dealt, this);
    }
    if (attacker && attacker.champion && this.game && this.game.champions && dealt > 0) {
      this.game.champions.addRenown(attacker, dealt * 0.09, 'damage');
    }
    if (attacker) {
      this.lastAttacker = attacker;
      this.lastAttackTime = this.game.time;
      if (this.game.elites) this.game.elites.onHurt(this, kind);
      this.game.alertAttacked(this, attacker);
    }
    /* Undying is checked *before* the kill, which is the only place a
       "refuse to die" perk can honestly live. */
    if (this.hp <= 0 && this.champion && this.game && this.game.champions) {
      if (this.game.champions.rescue(this)) { /* stayed on 1 hp */ }
    }
    if (this.hp <= 0) this.kill(attacker);
    else if (attacker && this.champion && this.game && this.game.champions && dealt > 0 && kind === 'melee') {
      this.game.champions.retaliation(this, attacker, dealt);
    }
    return dealt;
  }
  heal(amount) {
    const cal = this.game && this.game.calendar;
    if (cal) amount *= cal.healMul();
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }
  kill(attacker) {
    this.dead = true;
    this.deadT = 0;
    this.onDeath(attacker);
    if (this.game && this.game.modHost) this.game.modHost.onDeath(this, attacker);
  }
  onDeath() {}
  distanceTo(e) { return Math.hypot(this.x - e.x, this.z - e.z); }
}

/* ============================================================
   UNIT
   ============================================================ */
export class Unit extends Entity {
  constructor(game, type, team, x, z) {
    super(game, type, team, x, z);
    this.xPrev = x; this.yPrev = this.y || 0; this.zPrev = z;
    const def = UNIT_DEFS[type];
    this.kind = 'unit';
    this.def = def;
    this.name = def.name;
    this.classes = def.classes;      // used by the damage bonus table
    this.maxHp = def.hp * (game.civBonus(team, 'unitHp', type) || 1);
    /* the pool before any rank was earned: a promotion is applied on top of
       this, so a demotion (a reload, a mod) can always be recomputed exactly */
    this.baseMaxHp = this.maxHp;
    this.rank = 0;
    this.xp = 0;
    this.morale = 100;
    // civ bonuses
    if (type === 'villager') this.maxHp *= 1 + (team === game.playerTeam ? (game.civOf(team) === 'japanese' ? 0.05 : 0) : 0);
    this.hp = this.maxHp;
    this.radius = type === 'war_elephant' ? 0.9 : (def.classes.includes('cavalry') ? 0.5 : (def.siege ? 0.7 : 0.32));
    this.height = def.classes.includes('cavalry') ? 2.5 : (type === 'war_elephant' ? 3.4 : (def.siege ? 2.2 : 1.85));
    this.state = STATE.IDLE;
    this.target = null;              // entity being attacked / healed / gathered
    this.targetPos = null;           // [x,z] destination
    this.destX = null;               // standing order used for hop chaining
    this.destZ = null;
    this.hopTarget = false;
    this.path = null;
    this.pathIdx = 0;
    this.repathTimer = 0;
    this.gatherTarget = null;
    this.buildTarget = null;
    this.repairTarget = null;
    this.carry = { kind: null, amount: 0 };
    this.carryCap = 10;
    this.gatherCooldown = 0;
    this.attackCooldown = (this.game ? this.game.rng() : Math.random()) * 0.3;
    this.stance = 'aggressive';
    this.garrisoned = false;
    this.garrisonTarget = null;
    this.anim = { phase: (this.game ? this.game.rng() : Math.random()) * 6.28, speed: 0, attack: 0, spin: 0, mount: 0 };
    this.speedMul = 1;
    this.attackAnimT = 0;
    this.chargeTimer = 0;
    this.homePoint = null;
    this.relic = null;
    this.convertProgress = 0;
    this.convertTarget = null;
    this.formationSlot = null;
    this.noAggro = false;
    this.dropOff = null;
    this.lastGatherKind = null;
    this.repairT = 0;
    this.synced = false;
    if (def.naval) this.y = 0.1;
  }

  /** Effective stats after techs + civ bonuses (cached per stats version). */
  stats() {
    const g = this.game;
    if (this._stats && this._statsVersion === g.statsVersion) return this._stats;
    const def = this.def;
    const team = this.team;
    const s = {
      attack: def.attack,
      armor: def.armor,
      pierceArmor: def.pierceArmor,
      range: def.range,
      speed: def.speed,
      sight: def.sight
    };
    if (this.type === 'villager') {
      if (g.hasTech(team, 'loom')) { s.armor += 1; s.pierceArmor += 1; }
      if (g.hasPersonalTech && g.hasPersonalTech(team, 'sappers')) s.buildingAttack = 15;
    }
    if (def.classes.includes('infantry')) {
      if (g.hasTech(team, 'forging')) s.attack += 1;
      if (g.hasTech(team, 'iron_casting')) s.attack += 1;
      if (g.hasTech(team, 'scale_armor')) s.armor += 1;
      if (g.hasTech(team, 'chain_mail')) s.armor += 1;
    }
    if (def.classes.includes('cavalry')) {
      if (g.hasTech(team, 'forging')) s.attack += 1;
      if (g.hasTech(team, 'iron_casting')) s.attack += 1;
      if (g.hasTech(team, 'barding_armor')) { s.armor += 1; s.pierceArmor += 1; }
      if (g.hasTech(team, 'scale_armor')) s.armor += 1;
    }
    if (def.classes.includes('archer') && !def.classes.includes('cavalry')) {
      /* the Iron Sky omen: bows that reach further than they should */
      if (g.calendar && g.calendar.omen && g.calendar.omen.archerRange) {
        s.range += g.calendar.omen.archerRange;
        s.attack *= g.calendar.omen.archerAttack || 1;
      }
      if (g.hasTech(team, 'fletching')) { s.attack += 1; s.range += 1; }
      if (g.hasTech(team, 'bodkin_arrow')) { s.attack += 1; s.range += 1; }
      if (g.hasTech(team, 'chemistry')) s.attack += 1;
    }
    if (g.hasTech(team, 'wheelbarrow')) s.speed *= 1.1;
    if (g.hasTech(team, 'hand_cart')) s.speed *= 1.1;
    if (g.hasTech(team, 'squires')) s.speed *= 1.1;
    const civ = g.civOf(team);
    const bonuses = g.civBonuses(team);
    if (civ === 'persians' && this.type === 'villager') s.speed *= 1.1;
    if (civ === 'japanese' && def.classes.includes('infantry')) s.attack *= 1.15;
    if (civ === 'mongols' && (this.type === 'mangudai' || (def.classes.includes('cavalry') && def.classes.includes('archer')))) s.speed *= 1.15;
    if (civ === 'mongols' && def.siege) s.speed *= 1.2;
    if (civ === 'vikings' && def.classes.includes('infantry')) s.maxHpScale = 1.15;
    if (civ === 'britons' && def.classes.includes('archer')) s.range += 1;
    if (g.hasTech(team, 'drill')) {
      if (def.classes.includes('cavalry')) s.speed *= 1.25;
      if (def.siege) s.speed *= 1.3;
    }
    if (civ === 'britons' && this.type === 'longbowman' && g.hasTech(team, 'yeomen')) { s.range += 1; s.attack *= 1.2; }
    if (civ === 'japanese' && this.type === 'samurai' && g.hasTech(team, 'bushido')) { s.armor += 3; s.attack *= 1.15; }
    if (civ === 'vikings' && this.type === 'berserk' && g.hasTech(team, 'berserkergang')) { s.maxHpScale = 1.2; s.regen = 3.2; }
    if (civ === 'franks' && this.type === 'axeman' && g.hasTech(team, 'chivalry')) s.attack *= 1.15;
    if (civ === 'byzantines' && this.type === 'cataphract' && g.hasTech(team, 'greek_fire')) s.attack *= 1.1;
    if (civ === 'persians' && this.type === 'war_elephant' && g.hasTech(team, 'mahouts')) { s.speed *= 1.3; s.maxHpScale = 1.3; }
    if (g.court) {
      s.sight += g.court.sightBonus(team);
      s.healMul = g.court.healMul(team);
    }
    /* rank: the multipliers the chevrons stand for. Inside stats() so the
       inspector, the projectile maths and the damage all agree. */
    if (this.rank && g.veterancy) {
      const m = g.veterancy.mul(this);
      s.armor += m.arm;
      s.pierceArmor += m.arm;
      s.attack *= m.atk;
    }
    if (g.calendar) s.sight *= g.calendar.sightMul();
    /* renown: what survival itself has taught him */
    if (g.elites) g.elites.applyStats(this, s);
    /* the Champion's perks: every one of them lands here, on the same table
       the inspector, the projectile maths and the melee all read */
    if (this.champion && g.champions) g.champions.applyStats(this, s);
    if (this.def.auraRange) s.auraRange = this.def.auraRange;
    s.maxHpScale = s.maxHpScale || 1;
    this._stats = s;
    this._statsVersion = g.statsVersion;
    return s;
  }

  onDeath(attacker) {
    const g = this.game;
    if (this.garrisoned) g.removeFromGarrison(this);
    g.onUnitKilled(this, attacker);
    if (this.def.classes.includes('cavalry')) g.fx.dust(this.x, this.y, this.z, 6, 1.3);
    g.fx.blood(this.x, this.y, this.z, 5);
  }

  setPath(destX, destZ, force = false) {
    if (!this.def.naval && !this.game.pathFinder) return;
    /* enemies search a grid where gates are shut; allies walk through them */
    const pf = this.game.pfFor ? this.game.pfFor(this) : this.game.pathFinder;
    /* Aim at somewhere the unit can actually reach. Orders land inside wall
       cells and building edges all the time -- a finger on a phone is 40 px
       wide -- and a path to an unreachable point is a unit that never arrives. */
    if (!this.def.naval && this.game.freeSpotNear) {
      const spot = this.game.freeSpotNear(destX, destZ, this, 5);
      if (spot) { destX = spot[0]; destZ = spot[1]; }
      this._exactGoal = spot ? Math.hypot(spot[0] - this.x, spot[1] - this.z) : Infinity;
    }
    this.destX = destX;
    this.destZ = destZ;
    if (!force && this.path && this.pathIdx < this.path.length) {
      const [lx, lz] = this.path[this.path.length - 1];
      if (Math.hypot(lx - destX, lz - destZ) < 1.5) return;
    }
    let ddx = destX - this.x, ddz = destZ - this.z;
    let dist = Math.hypot(ddx, ddz);
    // Short hops walk straight: no grid artefacts, no search cost.
    if (dist < 34 && this.game.walkableLine(this.x, this.z, destX, destZ, this)) {
      this.path = [[destX, destZ]];
      this.pathIdx = 0;
      this.targetPos = [destX, destZ];
      this.hopTarget = false;
      this.arrived = false;
      return;
    }
    // Long marches are chained through 60 m hops: A* searches stay small,
    // the per-tick search budget is never blown and units keep walking.
    let goalX = destX, goalZ = destZ;
    let hop = false;
    if (dist > 70 && !this.def.naval) {
      const f = 60 / dist;
      goalX = this.x + ddx * f;
      goalZ = this.z + ddz * f;
      hop = true;
    }
    const p = pf.find(this.x, this.z, goalX, goalZ, this.def.naval ? 3 : 4);
    if (p && p.length) {
      // A one-point path means the goal shares our navigation cell. Walk the
      // straight line instead of standing still, otherwise units deadlock on
      // the coarse grid right where it matters (next to buildings).
      if (p.length === 1 && Math.hypot(destX - this.x, destZ - this.z) > 0.6) {
        p[0] = [destX, destZ];
      }
      this.path = p;
      this.pathIdx = 0;
      this.targetPos = [destX, destZ];
      this.hopTarget = hop;
      this.arrived = false;
      /* A best-effort path (the goal cell was unreachable, or the search hit
         its node budget) ends short of where we asked to go. Callers that
         need to *be* somewhere -- dropping a load, building, repairing --
         must not treat "walked as far as I could" as arrival, or they re-ask
         forever from the same spot. */
      const tail = p[p.length - 1];
      this.partialPath = !hop && Math.hypot(tail[0] - destX, tail[1] - destZ) > 2.5;
      this.unreachable = false;
    } else if (pf.lastUnreachable) {
      /* There is no way through: this unit is walled off from where it was
         told to go. Cancel the order instead of grinding against the wall --
         and tell the player why, once, so a walled-in town is diagnosable. */
      this.path = null;
      this.pathIdx = 0;
      this.targetPos = null;
      this.destX = null;
      this.destZ = null;
      this.unreachable = true;
      this.state = STATE.IDLE;
      this.moving = false;
      if (this.team === 1 && !this._unreachNotified) {
        this._unreachNotified = this.game.time;
        this.game.notify('Cannot reach that place', 'warn');
      }
    } else if (pf.lastWasSkip) {
      // the pathfinder ran out of budget this tick: try again next tick
      this.path = null;
      this.targetPos = [destX, destZ];
    } else {
      this.path = null;
      this.targetPos = null;
      this.pathFails = (this.pathFails || 0) + 1;
      if (this.pathFails >= 4) {
        this.pathFails = 0;
        this.game.unstick(this);
      }
    }
  }

  moveTo(x, z, force = false) {
    if (this.def.naval) {
      // ships ignore the land nav grid
      this.targetPos = [x, z];
      this.path = [[x, z]];
      this.pathIdx = 0;
      return;
    }
    this.setPath(x, z, force);
  }

  /**
   * "Am I close enough to use that building?" with a watchdog.
   *
   * Returns true when the unit is within `near` metres of the building's
   * rectangle, *or* when it has spent 2.5 s within `near + 3` metres without
   * getting closer -- a crowd, a wall or a doorway can hold a villager a
   * couple of metres off its own town centre indefinitely, and standing there
   * with a full load is a worse answer than handing the load over the fence.
   *
   * The timer counts since the distance last really improved, so unlike the
   * old `stallT` check it cannot be reset by jitter or by a nudge from another
   * unit.
   */
  _nearEnough(dt, b, near, patience = 3.2) {
    const d = rectDist(this, b);
    if (d < (this.nearBest ?? 1e9) - 0.25) { this.nearBest = d; this.nearT = 0; }
    else this.nearT = (this.nearT || 0) + dt;
    return d <= near || (this.nearT > 2.5 && d < near + patience);
  }
  _clearNear() { this.nearBest = 1e9; this.nearT = 0; }

  /** Walk to the nearest free edge of a building, never to its centre. */
  approachBuilding(b, pad = 1.2) {
    const g = this.game;
    /* Three pads, nearest side first. A town centre with a house and a farm
       pushed against it has sides whose "1.2 m outside the wall" point is
       inside the neighbour's footprint; the old code then asked for a path to
       a blocked cell, got a short best-effort path, walked it, asked again,
       and looped there forever (a villager jiggling by its own town centre
       with a full load and never depositing). Widening the ring until a
       genuinely free, genuinely reachable point is found fixes the cause; the
       caller's progress timer handles whatever is left. */
    /* A point can be perfectly walkable and still be *inside a blocked nav
       cell*: the grid is 2 m, so a 5.8 m town centre stamps 8 m of it, and a
       "1.0 m outside the wall" point lands in a cell the pathfinder refuses.
       Asking for a path there returns a best-effort path that stops a couple
       of metres short, which is how villagers ended up circling their own
       drop-off with a full load. Every candidate is now checked against both
       the walk test and the nav cell. */
    const pf = g.pfFor ? g.pfFor(this) : g.pathFinder;
    const free = (x, z) => {
      if (!g.isPassable(x, z, this)) return false;
      if (!pf) return true;
      const [cx, cz] = pf.worldToCell(x, z);
      return !pf.isBlocked(cx, cz);
    };
    for (let k = 0; k < 3; k++) {
      const p = pad + 0.5 + k * 0.8;
      edgePoint(this, b, p, _edge);
      if (free(_edge[0], _edge[1])) {
        this.moveTo(_edge[0], _edge[1], true);
        if (this.path) return;
      }
      const half = (b.def?.size || 2) * 0.5 + p;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + k * 0.4;
        const px = b.x + Math.cos(a) * half;
        const pz = b.z + Math.sin(a) * half;
        if (!free(px, pz)) continue;
        this.moveTo(px, pz, true);
        if (this.path) return;
      }
    }
    /* Nothing around the building is reachable. Aim at the wall anyway so the
       unit closes the distance instead of standing still; the callers' own
       "close enough, just do it" rules take over from there. */
    edgePoint(this, b, 0.2, _edge);
    this.moveTo(_edge[0], _edge[1], true);
  }

  /**
   * Which way round an obstacle to go when the waypoint points straight at
   * the wall it is hiding behind. The answer is whichever side has more open
   * ground within a couple of metres, and it is remembered for the slide so a
   * man does not dither at the corner.
   */
  _pickSlideSide(dx, dz, step) {
    const g = this.game;
    const probe = Math.max(1.2, step * 6);
    const opts = Math.abs(dx) >= Math.abs(dz) ? [1, -1] : [1, -1];
    for (const s of opts) {
      const x = this.x + (Math.abs(dx) >= Math.abs(dz) ? 0 : s * probe);
      const z = this.z + (Math.abs(dx) >= Math.abs(dz) ? s * probe : 0);
      if (g.isPassable(x, z, this)) { this._slideSign = s; return s; }
    }
    return 0;
  }

  stop() {
    this.state = STATE.IDLE;
    this.path = null;
    this.targetPos = null;
    this.destX = this.destZ = null;
    this.target = null;
    this.gatherTarget = null;
    this.buildTarget = null;
    this.repairTarget = null;
    if (this.carry.amount > 0) this.returnResources();
  }

  update(dt) {
    const g = this.game;
    /* Render interpolation needs last tick's position. One write per entity per
       tick, no allocation -- and it is what lets the simulation run at 30 Hz
       while the screen still updates at 60. */
    this.xPrev = this.x; this.yPrev = this.y; this.zPrev = this.z;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.2);
    this.anim.attack = Math.max(0, this.anim.attack - dt * 3.0);
    if (this.state === STATE.DEAD || this.dead) {
      this.deadT += dt;
      this.anim.speed = lerp(this.anim.speed, 0, dt * 4);
      return;
    }
    if (this.garrisoned) { this.updateGarrisoned(dt); return; }
    const def = this.def;
    const stats = this.stats();
    if (g.directControl?.unit === this) g.directControl.prepareUnit(this);

    /* ---- health regeneration ----
       Two layers, both deliberately small:

         · *Field stitching.* Every living man who has not been hit for six
           seconds knits himself back together, but only up to a third of his
           wounds. A beaten soldier recovers enough to hold a wall; he does
           not become a new man, and a fight still ends with dead soldiers.
         · *Trained or gifted regeneration.* Berserkers, doctors and the
           Champion's own perk heal past that cap and much faster -- that is
           what those things are for, and it is the reason to buy them.

       The universal layer used to not exist at all: a soldier at 4 hp stayed
       at 4 hp for the rest of the match unless a monk came by, which read as
       a missing system rather than a design. */
    const woundCap = this.maxHp * REGEN_LIMIT;
    if (this.hp < this.maxHp && g.time - (this.hurtAt ?? -99) > REGEN_DELAY) {
      if (this.hp < woundCap) this.hp = Math.min(woundCap, this.hp + REGEN_RATE * dt);
    }
    // passive regeneration (trained: berserkers, doctors, mod units)
    const regen = this.type === 'berserk' ? (g.hasTech(this.team, 'berserkergang') ? 3.2 : 1.4) : (this.def.regen || 0);
    if (regen && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + regen * dt);

    // attack cooldown
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    const prevX = this.x, prevZ = this.z;

    // regen for garrisoned handled elsewhere
    switch (this.state) {
      case STATE.MOVE: this.updateMove(dt, stats); break;
      case STATE.ATTACK_MOVE: this.updateAttackMove(dt, stats); break;
      case STATE.ATTACK: this.updateAttack(dt, stats); break;
      case STATE.GATHER: this.updateGather(dt, stats); break;
      case STATE.RETURN: this.updateReturn(dt, stats); break;
      case STATE.BUILD: this.updateBuild(dt, stats); break;
      case STATE.REPAIR: this.updateRepair(dt, stats); break;
      case STATE.HEAL: this.updateHeal(dt, stats); break;
      case STATE.CONVERT: this.updateConvert(dt, stats); break;
      case STATE.PATROL: this.updatePatrol(dt, stats); break;
      case STATE.TRADE: this.updateTrade(dt, stats); break;
      case STATE.GARRISON: this.updateGarrisonMove(dt, stats); break;
      case STATE.ROUT: this.updateRout(dt, stats); break;
      case STATE.CONTROLLED: if (g.directControl?.unit === this) g.directControl.moveUnit(this, dt, stats); else this.state = STATE.IDLE; break;
      default: this.updateIdle(dt, stats); break;
    }

    // stall detection: real displacement, not the intent flag
    const movedSq = (this.x - prevX) * (this.x - prevX) + (this.z - prevZ) * (this.z - prevZ);
    /* Standing still on purpose is not being stuck. A woodcutter at a tree, a
       mason on a wall and a villager handing over a load all stand perfectly
       still for seconds at a time, and `targetPos` -- the leftover from the
       walk that brought them here -- made the watchdog below count every one
       of those seconds. It fired every 3.5 s, dropped the gather target and
       put the villager back to IDLE, so a work force quietly dissolved into a
       crowd of people staring at the horizon. Only travelling states can
       stall; a working one is cleared here. */
    const working = this.state === STATE.GATHER || this.state === STATE.BUILD || this.state === STATE.REPAIR;
    if (working) this.stallT = 0;
    else if (movedSq < 0.00001 && (this.path || this.targetPos)) this.stallT = (this.stallT || 0) + dt;
    else this.stallT = 0;
    // progress watchdog: a unit that has not really moved for ~2 s is wedged
    this.chkTimer = (this.chkTimer || 0) + dt;
    if (this.chkTimer > 0.7) {
      this.chkTimer = 0;
      const px = this.chkX ?? this.x, pz = this.chkZ ?? this.z;
      const net = Math.hypot(this.x - px, this.z - pz);
      /* "Has somewhere to be" is a property of the *order*, not of the two
         fields that implement it. A unit whose re-path fails for one tick has
         `path` and `targetPos` both null for that tick, so a rule keyed on
         them reset the counter every time -- and a man sliding up and down
         against the face of a house, re-pathing every half second, was
         declared healthy for thirty seconds at a time. A travelling state is
         the honest test; working states (gather, build, repair) stand still
         on purpose and are not travelling. */
      const travelling = this.state === STATE.MOVE || this.state === STATE.ATTACK_MOVE
        || this.state === STATE.PATROL || this.state === STATE.RETURN
        || this.state === STATE.GARRISON;
      if (!travelling) this.stuckScore = 0;
      else if (net < 0.8) this.stuckScore = (this.stuckScore || 0) + 1;
      else this.stuckScore = 0;
      this.chkX = this.x;
      this.chkZ = this.z;
      if (this.stuckScore >= 3) {
        this.stuckScore = 0;
        /* First try to put the unit on open ground. If there is no open
           ground within reach it is genuinely sealed in -- by a wall run, a
           cliff pocket or a building placed on top of it -- and a unit that
           spends the rest of the match walking into a wall is worse than a
           unit that simply stops. */
        const freed = g.unstick(this);
        if (freed) this.sealedT = 0;
        else {
          this.sealedT = (this.sealedT || 0) + 1;
          if (this.sealedT >= 3 && this.state !== STATE.ATTACK && this.state !== STATE.GATHER && this.state !== STATE.BUILD) {
            this.sealedT = 0;
            this.path = null;
            this.pathIdx = 0;
            this.targetPos = null;
            this.destX = this.destZ = null;
            this.moving = false;
            this.stallT = 0;
            this.state = STATE.IDLE;
          }
        }
      }
    }
    // watchdog: nothing may stay wedged forever
    if (this.stallT > 3.5) {
      this.stallT = 0;
      this.path = null;
      this.pathIdx = 0;
      this.targetPos = null;
      this.gatherTarget = null;
      this.buildTarget = null;
      this.repairTarget = null;
      this.dropOff = null;
      this.state = this.carry.amount > 0.01 ? STATE.RETURN : STATE.IDLE;
      if (this.state === STATE.RETURN) this.returnResources();
    }

    // animation
    const moving = this.moving ? 1 : 0;
    this.anim.speed = lerp(this.anim.speed, moving, dt * 7);
    this.anim.phase += dt * (2.6 + stats.speed * 0.55) * (0.25 + this.anim.speed * 1.4);
    if (def.siege) this.anim.spin += dt * (moving ? 1.6 : 0);
    /* A man standing still does not need the terrain sampled again, and a
       turn rate is a per-tick constant, not a per-unit power. Together these
       were two of the most expensive instructions in the whole tick. */
    if (this.x !== this.xPrev || this.z !== this.zPrev || this._yDirty) {
      this.y = def.naval ? 0.1 : g.heightAt(this.x, this.z);
      this._yDirty = false;
    }
    const turn = g._facingLerp !== undefined ? g._facingLerp : 0.06;
    this.facing = angleLerp(this.facing, this.desiredFacing ?? this.facing, turn);
  }

  updateGarrisoned(dt) {
    const g = this.game;
    const b = this.garrisonTarget;
    if (!b || b.dead) { g.removeFromGarrison(this); return; }
    if (this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 1.5 * dt);
    this.x = b.x; this.z = b.z;
  }

  /**
   * Broken men run for the nearest supply and keep running until they find
   * their nerve. They cannot be ordered, and they will not stop to fight.
   */
  updateRout(dt, stats) {
    const g = this.game;
    const m = g.morale;
    if (!m) { this.state = STATE.IDLE; return; }
    this.target = null;
    let gx, gz;
    const src = m.nearestSupply(this);
    if (src) { gx = src.x; gz = src.z; }
    else { const home = m.homeOf(this.team); gx = home.x; gz = home.z; }
    if (Math.hypot(gx - this.x, gz - this.z) < 3) { this.moving = false; this.path = null; return; }
    this.repathTimer -= dt;
    if (!this.path || !this.targetPos || this.repathTimer <= 0) {
      this.repathTimer = 1.2;
      /* fan out around the tent instead of forming a queue at its door */
      const a = ((this.id * 37) % 100) / 100 * Math.PI * 2;
      this.destX = gx + Math.cos(a) * 2.4;
      this.destZ = gz + Math.sin(a) * 2.4;
      this.setPath(this.destX, this.destZ, true);
    }
    if (this.path) this.stepMovement(dt, stats);
    else this.moving = false;
  }

  updateIdle(dt, stats) {
    this.moving = false;
    /* An idle villager is a job the player has to notice and fix with a thumb,
       and on a phone that is a summon-and-retask ritual per man. A villager who
       has worked before looks for work again by himself, on a slow staggered
       timer -- never taking a unit the player has deliberately parked, and
       never before a manual order has had a moment to land. */
    if (this.type === 'villager' && !this.noAggro && this.team !== 0) this._selfTask(dt);
    // auto-acquire targets based on stance
    if (this.noAggro) return;
    if (this.def.classes.includes('monk')) return;
    /* A villager runs rather than fights -- see _flee -- and a soldier on
       "stand" holds his ground but still swings at whatever walks into him. */
    if (this.type === 'villager') { this._flee(dt); return; }
    if (this.stance === 'stand') {
      if (this.attackCooldown <= 0 && this.def.attack > 0) {
        const near = this.game.findEnemyNear(this, Math.max(2.5, this.stats().range + 0.5));
        if (near) { this.target = near; this.state = STATE.ATTACK; }
      }
      return;
    }
    if (this.attackCooldown > 0) return;
    /* A standing man does not need to re-scan the horizon thirty times a
       second. Each idle unit looks around on its own eighth of a second,
       staggered by id, so the whole crowd costs an eighth as much and no
       single tick carries the bill. Nothing a player can see changes: an
       enemy walking into a spear wall is still noticed inside a quarter of
       a second, and it is the *wall* that notices, not one man. */
    if ((((this.game.frame || 0) + this.id) & 7) !== 0) return;
    /* How far an idle soldier will look for a fight. This used to be 7 m,
       which meant that a raider standing eight metres away, burning your
       town hall, was invisible to the six men guarding it -- they had killed
       their first target and then simply watched. A man guarding his own
       town now looks as far as he can shoot plus a wide margin, and a town
       under attack calls him further still (see Game.raiseAlarm). */
    const base = this.stance === 'defensive' ? 10 : (this.def.classes.includes('archer') ? 16 : 13);
    const range = Math.max(base, stats.range + 5);
    const enemy = this.game.findEnemyNear(this, range);
    if (enemy) {
      /* a man does not abandon the gate to chase a scout across the map */
      const leash = this.homeBuilding && !this.homeBuilding.dead ? 26 : 34;
      const home = this.homeBuilding || this.game.nearestOwnBuilding(this.team, this.x, this.z);
      if (!home || dist2(home.x, home.z, enemy.x, enemy.z) < leash * leash) {
        this.state = STATE.ATTACK;
        this.target = enemy;
      }
    }
  }

  /**
   * A villager's answer to an armed man is not a hoe.
   *
   * They used to stand at their tree and be cut down one by one while the
   * player watched, which on a phone means losing an economy you cannot even
   * see happening. Now they drop the load and run for the nearest roof, and
   * go back to work once the ground is clear.
   */
  _flee(dt) {
    const g = this.game;
    const threat = g.findEnemyNear(this, 10);
    if (threat) {
      this._fleeFrom = threat;
      const home = g.nearestOwnBuilding(this.team, this.x, this.z);
      this.gatherTarget = null;
      this.buildTarget = null;
      this.carry.amount = 0;
      this.carry.kind = null;
      this.state = STATE.MOVE;
      this.noAggro = true;
      if (home) {
        if (!this.path || g.frame % 8 === 0) this.approachBuilding(home, 1.4);
        if (this.targetPos) this.stepMovement(dt, this.stats());
      }
      return;
    }
    if (this._fleeFrom) {
      this._fleeFrom = null;
      this.noAggro = false;
      this.retaskT = 0;
      this.state = STATE.IDLE;
    }
  }

  updateMove(dt, stats) {
    /* Either half of a move can be lost: a path can be dropped by the
       watchdog or by an abandoned waypoint while the order still stands.
       Both cases re-issue the path -- otherwise the unit walks in the state
       machine forever without moving, which is the worst bug in an RTS. */
    if (!this.targetPos || !this.path) {
      /* nothing to walk to at all: the order is over. Without this a unit
         whose destination was cleared elsewhere sat in state `move` for ever
         -- the state machine's worst failure mode, and invisible in the HUD. */
      if (this.destX == null && this.destZ == null) { this.state = STATE.IDLE; this.moving = false; return; }
      this.repathTimer -= dt;
      if (this.destX != null && this.repathTimer <= 0) {
        this.repathTimer = 0.45;
        this.setPath(this.destX, this.destZ, true);
        if (!this.path) { this.targetPos = null; return; }
      } else return;
    }
    const arrived = this.stepMovement(dt, stats);
    if (arrived) {
      this.moving = false;
      this.path = null;
      if (this.destX != null && (this.destX - this.x) ** 2 + (this.destZ - this.z) ** 2 > 6.25) {
        this.setPath(this.destX, this.destZ, true);
        if (this.path) return;
      }
      this.state = STATE.IDLE;
      this.destX = this.destZ = null;
    }
  }

  updateAttackMove(dt, stats) {
    // engage anything hostile within sight, otherwise keep marching
    if (this.attackCooldown <= 0 && !this.target) {
      const enemy = this.game.findEnemyNear(this, Math.max(7, stats.sight * 0.8));
      if (enemy) { this.target = enemy; this.state = STATE.ATTACK; return; }
    }
    if (!this.targetPos) {
      this.repathTimer -= dt;
      if (this.destX != null && this.repathTimer <= 0) {
        this.repathTimer = 0.45;
        this.setPath(this.destX, this.destZ, true);
        if (!this.path) return;
      } else return;
    }
    if (this.stepMovement(dt, stats)) {
      this.moving = false;
      this.path = null;
      if (this.destX != null && Math.hypot(this.destX - this.x, this.destZ - this.z) > 2.5) {
        this.setPath(this.destX, this.destZ, true);
        if (this.path) return;
      }
      this.state = STATE.IDLE;
      this.destX = this.destZ = null;
    }
  }

  updateAttack(dt, stats) {
    const target = this.target;
    if (!target || target.dead) { this.target = null; this.state = STATE.IDLE; return; }
    if (target.garrisoned && target.garrisonTarget && !target.garrisonTarget.dead) {
      // reachable only through the host building
    }
    const d = Math.hypot(target.x - this.x, target.z - this.z);
    const stopAt = this.attackRangeTo(target, stats);
    this.desiredFacing = Math.atan2(target.x - this.x, target.z - this.z);
    if (d > stopAt) {
      // chase
      this.moving = false;
      const chaseRange = this.stance === 'stand' ? 0 : 14;
      if (chaseRange <= 0) { this.state = STATE.IDLE; this.target = null; return; }
      this.repathTimer -= dt;
      if (this.repathTimer <= 0) {
        this.repathTimer = 0.55;
        const angle = Math.atan2(this.z - target.z, this.x - target.x);
        const tx = target.x + Math.cos(angle) * Math.max(0.1, stopAt - 0.35);
        const tz = target.z + Math.sin(angle) * Math.max(0.1, stopAt - 0.35);
        /* At the wall, the nav grid's conservative square is the only thing
           between this man and his target, so take the last stride directly.
           Further out, plan properly. */
        if (Math.hypot(tx - this.x, tz - this.z) > 4 || !this.strideIn(target, tx, tz)) {
          this.moveTo(tx, tz);
        }
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      if (d > chaseRange + 10) { this.target = null; this.state = STATE.IDLE; }
      return;
    }
    // in range: stop and attack
    this.moving = false;
    this.path = null;
    /* Standing still to swing is not being stuck. The stall watchdog keys off
       "has somewhere to be", so a man in range must drop the destination he
       was walking to -- otherwise every melee in the game was classified as a
       wedged unit and teleported to open ground every couple of seconds. */
    this.targetPos = null;
    this.destX = this.destZ = null;
    this.stallT = 0;
    this.stuckScore = 0;
    if (this.attackCooldown <= 0) {
      this.performAttack(target, stats);
    }
  }

  /**
   * The last stride to a building.
   *
   * The pathfinder will not plan into the square markBuildingFootprint() stamps
   * around a building, and that square is rounded outward to whole 2 m cells --
   * up to a metre beyond the walls. Physically the ground is free (isPassable
   * is exact and radius-aware), so a melee unit sent at a hall walks to the
   * edge of the square, is told by the grid that the wall is there, and stops
   * out of range for ever: the "army frozen at the enemy town centre" bug,
   * from three of the four sides. This walks the remainder, and only the
   * remainder: both ends and every sample in between must lie inside the
   * target's own hull, so the stride can never cut a wall or a neighbour.
   */
  strideIn(target, tx, tz) {
    const g = this.game;
    if (!target || target.kind !== 'building' || !g.navHullHalf) return false;
    const hull = g.navHullHalf(target) + 0.9;
    const inside = (x, z) => Math.abs(x - target.x) <= hull && Math.abs(z - target.z) <= hull;
    if (!inside(this.x, this.z) || !inside(tx, tz)) return false;
    if (!g.isPassable(tx, tz, this)) return false;
    const d = Math.hypot(tx - this.x, tz - this.z);
    const steps = Math.min(8, Math.max(1, Math.ceil(d / 0.35)));
    const pf = g.pfFor ? g.pfFor(this) : g.pathFinder;
    /* walls are not physical (isPassable ignores them on purpose) but they must
       still never be vaulted, so collect the ones near the stride and test the
       samples against their boxes. The shared query buffer is copied now: any
       isPassable() call below would overwrite it. */
    let wallN = 0;
    if (g.buildingSpatial) {
      const near = g.buildingSpatial.query((this.x + tx) * 0.5, (this.z + tz) * 0.5, d * 0.5 + 4);
      for (let i = 0; i < near.length; i++) if (near[i].wall && !near[i].dead) _strideWalls[wallN++] = near[i];
    }
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = this.x + (tx - this.x) * t, pz = this.z + (tz - this.z) * t;
      if (!g.isPassable(px, pz, this)) { _strideWalls.length = 0; return false; }
      for (let k = 0; k < wallN; k++) {
        const w = _strideWalls[k];
        if (Math.abs(px - w.x) < 1.1 && Math.abs(pz - w.z) < 1.1) { _strideWalls.length = 0; return false; }
      }
      if (!pf) continue;
      const [cx, cz] = pf.worldToCell(px, pz);
      if (!pf.isBlocked(cx, cz)) continue;
      /* a blocked cell may only be crossed while it is the target's own hull */
      if (Math.abs(px - target.x) > hull || Math.abs(pz - target.z) > hull) { _strideWalls.length = 0; return false; }
    }
    _strideWalls.length = 0;
    this.path = [[tx, tz]];
    this.pathIdx = 0;
    this.targetPos = [tx, tz];
    this.destX = tx; this.destZ = tz;
    this.arrived = false;
    return true;
  }

  /**
   * The distance from the target's *centre* at which this unit is in range,
   * measured along the line the unit actually stands on.
   *
   * Buildings are square: `isPassable` refuses a box of half-width `size/2`,
   * so a soldier coming in along a face can stand 2.9 m from the centre of a
   * hall, but one coming in on the diagonal can only get to 4.1 m -- the
   * corner of the box. Measuring reach against the inscribed circle (as this
   * used to) told every diagonal attacker it was 0.9 m short, so it hovered at
   * the corner of the town centre for ever and never swung: "my army is frozen
   * at the enemy hall", reproducible every time from three of the four sides.
   * The answer is the box's support distance along that ray, not its radius.
   */
  attackRangeTo(target, stats) {
    const reach = this.def.range > 1.2 ? stats.range : this.radius + 0.55;
    if (target.kind !== 'building') return reach + (target.radius || 0.4);
    const dx = target.x - this.x, dz = target.z - this.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return reach + (target.def.size || 3) * 0.5;
    const half = (target.def.size || 3) * 0.5;
    const support = half / Math.max(Math.abs(dx / len), Math.abs(dz / len));
    return support + reach;
  }

  performAttack(target, stats) {
    const g = this.game;
    const def = this.def;
    const rate = def.attackSpeed || (def.classes.includes('archer') ? 1.55 : (def.siege ? 2.6 : 1.35));
    this.attackCooldown = rate;
    this.anim.attack = 1;
    if (def.classes.includes('monk')) return;
    // damage multipliers
    let dmg = stats.attack;
    const bonus = def.bonuses || {};
    for (const cls of target.classes || []) {
      if (bonus[cls]) dmg += bonus[cls];
    }
    if (target.kind === 'building') {
      dmg += bonus.building || 0;
      if (this.type === 'villager') dmg += 2 + (g.hasTech(this.team, 'sappers') ? 13 : 0);
      if (this.def.siege) dmg = stats.attack + (bonus.building || 0);
    }
    // aura and realm buffs
    const aura = g.auraBonusFor(this);
    dmg *= 1 + aura;
    if (this.squad && g.squads) dmg *= g.squads.attackMul(this);
    dmg *= g.buffMul(this.team, 'attack');
    if (g.morale) dmg *= g.morale.attackMul(this);
    if (g.calendar) dmg *= g.calendar.attackMul();
    /* Champion: armour-piercing, long-range and execution bonuses */
    if (this.champion && g.champions) dmg = g.champions.modifyOutgoing(this, target, dmg);
    const isRanged = this.def.range > 1.2 && def.attack > 0;
    /* the Still Air omen: an arrow that loses its way never lands. Only
       arrows -- a cannonball is not bothered by a still evening. */
    if (isRanged && g.calendar && g.calendar.omen && g.calendar.omen.arrowMiss
        && def.projectile !== 'boulder' && def.projectile !== 'cannon') {
      if (g.rng() < g.calendar.omen.arrowMiss) {
        g.fx.sparks(this.x + (g.rng() - 0.5) * 1.5, this.y + 1.4, this.z + (g.rng() - 0.5) * 1.5, 2, [0.75, 0.75, 0.75]);
        return;
      }
    }
    // Night raids: melee strikes land harder after dark.
    if (!isRanged) dmg *= g.nightRaidMul;
    if (isRanged && def.attack > 0) {
      g.fireProjectile(this, target, dmg, def.projectile || 'arrow');
      g.sound.play(this.def.classes.includes('archer') ? 'bow' : 'siegeFire', this.x, this.z);
    } else if (def.attack > 0) {
      target.takeDamage(dmg, this, 'melee');
      g.fx.sparks((this.x + target.x) / 2, this.y + 0.9, (this.z + target.z) / 2, 2, [1, 0.9, 0.7]);
      g.sound.play('hit', this.x, this.z);
      /* Cleave: the swing does not stop at the first body. */
      if (this.champion && g.champions) g.champions.splash(this, target, dmg);
      // splash for elephants
      if (def.splash) {
        const victims = g.unitsNear(target.x, target.z, def.splash, (u) => u.team !== this.team && !u.dead && u !== target);
        for (const v of victims) v.takeDamage(dmg * 0.45, this, 'melee');
      }
    }
    if (this.type === 'demo_ship') {
      g.explodeArea(this.x, this.z, 3.2, 80, this);
      this.takeDamage(this.maxHp * 2, this);
    }
  }

  /**
   * The nearest thing worth doing for this villager.
   *
   * The old search was a single 26 m ring around the villager and, when that
   * came back empty, he simply stopped -- for ever. A town that has stripped
   * the trees and berries around its own walls is a normal town by the tenth
   * minute, so a dozen villagers would silently retire while the player was
   * busy. The search now widens until something is found, and falls back to
   * whatever the island does still have, so nobody ever stands about while
   * there is work anywhere.
   */
  _findWork(kind) {
    const g = this.game;
    const first = kind || this.lastGatherKind || 'wood';
    /* His own field, grove or seam first. A farmer sent back to a field he
       was already working should walk eight metres to it, not across the map
       to whichever berry bush the search happens to like today -- and a field
       with 400 food left in it is exactly where he left it. */
    const home = this.homeNode;
    if (home && !home.dead && home.amount > 0 && !home.buildProgress && home.resKind === first) {
      if (dist2(this.x, this.z, home.x, home.z) < 160 * 160) return home;
    }
    if (home && home.kind === 'building' && !home.dead && home.amount > 0 && home.buildProgress >= 0.99 && home.resKind === first) {
      if (dist2(this.x, this.z, home.x, home.z) < 160 * 160) return home;
    }
    for (const r of [26, 90, 260, 900]) {
      const node = g.findNearestResource(first, this.x, this.z, r, this);
      if (node) return node;
    }
    for (const other of ['wood', 'food', 'gold', 'stone']) {
      if (other === first) continue;
      for (const r of [90, 260, 900]) {
        const node = g.findNearestResource(other, this.x, this.z, r, this);
        if (node) return node;
      }
    }
    return null;
  }

  /** See updateIdle: put an idle villager back to work without being asked. */
  _selfTask(dt) {
    if (this.carry.amount > 0.01 && this.carry.kind) { this.returnResources(); return; }
    this.retaskT = (this.retaskT === undefined ? 1.5 + (this.id % 9) * 0.35 : this.retaskT) - dt;
    if (this.retaskT > 0) return;
    this.retaskT = 3;
    if (this.buildTarget || this.gatherTarget) return;
    /* A villager parked on purpose next to nothing stays parked: only a unit
       that has had a job before, or that is standing on a resource it can
       see, is helped out. */
    const node = this._findWork(this.lastGatherKind);
    if (!node) { this.retaskT = 10; return; }
    this.gatherTarget = node;
    this.homeNode = node;
    this.lastGatherKind = node.resKind;
    this.state = STATE.GATHER;
    this.moveTo(node.x, node.z, true);
  }

  updateGather(dt, stats) {
    const g = this.game;
    let node = this.gatherTarget;
    if (!node || node.dead || node.amount <= 0) {
      node = this._findWork(this.lastGatherKind);
      this.gatherTarget = node;
      if (!node) { this.state = STATE.IDLE; this.retaskT = 2; return; }
      this.homeNode = node;
      this.moveTo(node.x, node.z, true);
    }
    this.homeNode = node;
    const d = Math.hypot(node.x - this.x, node.z - this.z);
    const reach = (node.radius || 1) + 1.5 + this.radius;
    if (d > reach) {
      this.moving = false;
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 1.4;
        const ang = Math.atan2(this.z - node.z, this.x - node.x);
        this.moveTo(node.x + Math.cos(ang) * reach * 0.82, node.z + Math.sin(ang) * reach * 0.82);
        if (!this.path) {
          this.moveTo(node.x, node.z, true);
        }
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    this.desiredFacing = Math.atan2(node.x - this.x, node.z - this.z);
    this.anim.attack = Math.max(this.anim.attack, Math.sin(g.time * 4) > 0.6 ? 0.45 : 0);
    this.gatherCooldown -= dt;
    if (this.gatherCooldown > 0) return;
    const kind = node.resKind;
    const rate = g.gatherRate(this, kind);
    const cap = this.carryCapFor(kind);
    if (this.carry.kind && this.carry.kind !== kind) {
      if (this.carry.amount > 0.01) { this.returnResources(); return; }
      this.carry.kind = null;
      this.carry.amount = 0;
    }
    this.carry.kind = kind;
    const take = Math.min(rate * 0.55, node.amount, cap - this.carry.amount);
    if (take <= 0) {
      if (this.carry.amount >= cap) this.returnResources();
      else if (node.amount <= 0) { this.gatherTarget = null; }
      return;
    }
    this.gatherCooldown = 0.55;
    node.amount -= take;
    this.carry.amount += take;
    this.lastGatherKind = kind;
    g.onGather(this, node, take);
    if (node.amount <= 0.01) {
      this.gatherTarget = null;
      /* A bare field is resown, never killed: `kill()` on a building is an
         explosion, a notification and a razed farm, which is what harvesting
         your own wheat used to look like. */
      if (node.kind === 'building') g.tryReseedFarm(this, node);
      else node.kill(this);
    }
    if (this.carry.amount >= cap - 0.01) this.returnResources();
  }

  carryCapFor(kind) {
    const g = this.game;
    let cap = 15;
    if (g.hasTech(this.team, 'wheelbarrow')) cap += 8;
    if (g.hasTech(this.team, 'hand_cart')) cap += 12;
    if (g.court) cap += g.court.carryBonus(this);
    if (this.champion && g.champions) cap += g.champions.carryBonus(this);
    return cap;
  }

  returnResources() {
    if (this.carry.amount <= 0 || !this.carry.kind) { this.carry.amount = 0; this.carry.kind = null; return; }
    const g = this.game;
    const drop = g.findDropoff(this.team, this.carry.kind, this.x, this.z);
    if (!drop) {
      // no drop-off: deposit instantly at any TC if close (prevents softlock)
      const tc = g.findDropoff(this.team, 'any', this.x, this.z, 60);
      if (tc && Math.hypot(tc.x - this.x, tc.z - this.z) < 12) {
        g.deposit(this, this.carry.kind, this.carry.amount);
        this.carry.amount = 0;
      }
      return;
    }
    this.state = STATE.RETURN;
    this.dropOff = drop;
    this.approachBuilding(drop, 1.2);
  }

  updateReturn(dt, stats) {
    const g = this.game;
    const drop = this.dropOff;
    if (!drop || drop.dead) {
      this.dropOff = null;
      this.returnResources();
      if (!this.dropOff) this.state = STATE.IDLE;
      return;
    }
    const d = rectDist(this, drop);
    /* Two ways out of a jammed approach, because either one alone can be
       fooled:
         - progress: the distance stopped improving for 2.5 s (a crowd, a
           blocked doorway);
         - patience:  this villager has been carrying this load for 6 s while
           inside 14 m of the drop-off. If a building cluster has grown around
           the drop-off, the closest point it can actually stand on may be
           eight metres away -- and no excuse is worth a villager holding wood
           forever.                                                        */
    this.returnT = (this.returnT || 0) + dt;
    if (d > 2.6 && !this._nearEnough(dt, drop, 2.6) && !(this.returnT > 6 && d < 14)) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 3.0;
        this.approachBuilding(drop, 1.0);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    this.stallT = 0;
    this._clearNear();
    this.returnT = 0;
    this.desiredFacing = Math.atan2(drop.x - this.x, drop.z - this.z);
    g.deposit(this, this.carry.kind, this.carry.amount);
    this.turnIn();
    this.carry.amount = 0;
    this.dropOff = null;
    // go back to the node
    if (this.gatherTarget && !this.gatherTarget.dead && this.gatherTarget.amount > 0) {
      this.state = STATE.GATHER;
      this.moveTo(this.gatherTarget.x, this.gatherTarget.z, true);
    } else {
      const node = this._findWork(this.carry.kind || this.lastGatherKind || 'wood');
      if (node) {
        this.gatherTarget = node;
        this.homeNode = node;
        this.state = STATE.GATHER;
        this.moveTo(node.x, node.z, true);
      } else {
        this.state = STATE.IDLE;
      }
    }
  }

  /** Small animation + audit hook when resources are dropped off. */
  turnIn() {
    if (this.team === this.game.playerTeam && this.carry.amount > 0) {
      this.game.onEvent('turnIn', { kind: this.carry.kind, amount: this.carry.amount });
    }
  }

  updateBuild(dt, stats) {
    const g = this.game;
    const target = this.buildTarget;
    if (!target || target.dead || target.buildProgress >= 1) {
      this.buildTarget = null;
      /* A wall is built as a run, not a segment: when one piece is finished,
         keep going down the line to the next unfinished piece nearby. Without
         this a crew of four raised four segments and then stood about while
         seven foundations sat unfinished, which on a phone (where walls are
         dragged, not tapped) meant walling a town was an endless chore. */
      if (target && target.buildProgress >= 1 && target.def && target.def.wall) {
        const next = g.nextFoundation(target, this);
        if (next) {
          this.buildTarget = next;
          this.state = STATE.BUILD;
          this.approachBuilding(next, 1.0);
          return;
        }
      }
      if (target && target.buildProgress >= 1 && this.lastGatherKind) {
        const node = g.findNearestResource(this.lastGatherKind, this.x, this.z, 26, this);
        if (node) { this.gatherTarget = node; this.state = STATE.GATHER; return; }
      }
      this.state = STATE.IDLE;
      return;
    }
    /* A wall run is 2 m thick and is raised shoulder to shoulder, so four
       villagers cannot all stand inside 2 m of the centre of their piece.
       The ones squeezed out to 2.4 m used to land a single hammering frame
       every 2.5 s (nearEnough's patience window, which building then reset)
       -- walls crawled up at a quarter speed no matter how many villagers
       were on them. A wall/bastion piece gets a wider, honest stand-off. */
    const isWall = !!(target.def && (target.def.wall || target.def.gate));
    const nearWork = isWall ? 1.9 : 2.0;
    /* Walls get a wide stand-off but a *short* patience leash: without it a
       villager that could not squeeze through a crowd hammered the wall from
       6 m away, which reads as a broken animation. */
    if (!this._nearEnough(dt, target, nearWork, isWall ? 0.9 : 3.2)) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 3.0;
        this.approachBuilding(target, 1.0);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    this.stallT = 0;
    /* only reset the patience timer when we are genuinely at the work spot;
       resetting it from arm's length is what turned "one frame of work" into
       "one frame per 2.5 s" */
    if (rectDist(this, target) <= nearWork) this._clearNear();
    this.desiredFacing = Math.atan2(target.x - this.x, target.z - this.z);
    target.addBuilder(this, dt);
    this.anim.attack = Math.max(this.anim.attack, Math.sin(g.time * 7) * 0.5 + 0.35);
    if (g.rng() < dt * 2.2) g.fx.dust(target.x + randRange(-1, 1, g.rng), target.y + 0.2, target.z + randRange(-1, 1, g.rng), 1, 0.8);
    if (target.buildProgress >= 1) {
      /* the piece is up: carry on down the same run instead of standing about */
      const next = target.def && (target.def.wall || target.def.gate) ? g.nextFoundation(target, this) : null;
      if (next) {
        this.buildTarget = next;
        this.state = STATE.BUILD;
        this.approachBuilding(next, 1.0);
        return;
      }
      this.buildTarget = null;
      this._clearNear();
      this.state = STATE.IDLE;
    }
  }

  updateRepair(dt, stats) {
    const g = this.game;
    const target = this.repairTarget;
    if (!target || target.dead || target.hp >= target.maxHp) {
      this.repairTarget = null;
      this.state = STATE.IDLE;
      return;
    }
    if (!this._nearEnough(dt, target, 1.3)) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 3.0;
        this.approachBuilding(target, 1.0);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    target.hp = Math.min(target.maxHp, target.hp + target.maxHp * 0.06 * dt);
    this.repairT += dt;
    if (this.repairT > 1.2) {
      this.repairT = 0;
      g.spend(this.team, { wood: 1 });
    }
    this.anim.attack = Math.max(this.anim.attack, Math.sin(g.time * 7) * 0.5 + 0.3);
  }

  updateHeal(dt, stats) {
    const g = this.game;
    const target = this.target;
    if (!target || target.dead || target.garrisoned || target.hp >= target.maxHp) {
      // find a wounded ally
      const ally = g.findWoundedAlly(this, 10);
      if (!ally) { this.state = STATE.IDLE; return; }
      this.target = ally;
      this.moveTo(ally.x, ally.z, true);
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    const d = Math.hypot(target.x - this.x, target.z - this.z);
    if (d > 5.5) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) { this.repathTimer = 1.0; this.moveTo(target.x, target.z, true); }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    const courtHeal = g.court ? g.court.healMul(this.team) : 1;
    const heal = (this.def.heal || 10) * dt * (g.civBonuses(this.team).monkHeal || 1) * courtHeal;
    const beforeHeal = target.hp;
    target.heal(heal);
    if (g.veterancy) g.veterancy.onHeal(this, target.hp - beforeHeal);
    if (g.court) g.court.onHeal(this, target.hp - beforeHeal);
    this.anim.attack = Math.max(this.anim.attack, Math.sin(g.time * 3) * 0.35 + 0.3);
    if (g.rng() < dt * 3) g.fx.heal(target.x, target.y, target.z, 1);
  }

  updateConvert(dt, stats) {
    const g = this.game;
    const target = this.convertTarget;
    if (!target || target.dead) { this.convertTarget = null; this.state = STATE.IDLE; return; }
    if (target.convertImmune) { this.convertTarget = null; this.state = STATE.IDLE; return; }
    const d = Math.hypot(target.x - this.x, target.z - this.z);
    if (d > 6.5) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) { this.repathTimer = 1.0; this.moveTo(target.x, target.z, true); }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.moving = false;
    this.path = null;
    this.convertProgress += dt * (1 + (g.hasTech(this.team, 'illumination') ? 0.3 : 0));
    if (g.rng() < dt * 6) g.fx.glowPulse(target.x, target.y + 0.8, target.z, 0.5, 0.75, 1);
    if (this.convertProgress >= 1) {
      this.convertProgress = 0;
      g.convertUnit(target, this.team);
      this.convertTarget = null;
      this.state = STATE.IDLE;
    }
  }

  updatePatrol(dt, stats) {
    if (!this.patrolPoints || this.patrolPoints.length < 2) { this.state = STATE.IDLE; return; }
    if (!this.targetPos) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
      const p = this.patrolPoints[this.patrolIdx];
      this.moveTo(p[0], p[1], true);
    }
    if (this.stepMovement(dt, stats)) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
      const p = this.patrolPoints[this.patrolIdx];
      this.moveTo(p[0], p[1], true);
    }
  }

  updateTrade(dt, stats) {
    const g = this.game;
    const markets = g.buildings.filter((b) => b.team === this.team && !b.dead && b.def.market);
    if (markets.length < 2) { this.state = STATE.IDLE; return; }
    if (!this.tradeTarget) {
      this.tradeTarget = markets.find((m) => m !== this.tradeFrom) || markets[0];
      this.moveTo(this.tradeTarget.x, this.tradeTarget.z, true);
    }
    const d = Math.hypot(this.tradeTarget.x - this.x, this.tradeTarget.z - this.z);
    if (d < (this.tradeTarget.def.size || 3) * 0.6 + 1) {
      this.moving = false;
      const gain = (g.hasTech(this.team, 'guilds') ? 1.4 : 1) * 0.9;
      g.addResource(this.team, 'gold', gain);
      this.tradeFrom = this.tradeTarget;
      this.tradeTarget = null;
      this.state = STATE.IDLE;
      this.anim.speed = 0;
    } else {
      if (this.stepMovement(dt, stats)) { this.tradeTarget = null; }
    }
  }

  updateGarrisonMove(dt, stats) {
    const b = this.garrisonTarget;
    if (!b || b.dead) { this.garrisonTarget = null; this.state = STATE.IDLE; return; }
    const d = rectDist(this, b);
    if (d > 1.0 && !(this.stallT > 0.8 && d < 3.5)) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 3.0;
        this.approachBuilding(b, 0.7);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      return;
    }
    this.game.garrisonUnit(this, b);
  }

  /** Advance along the current path; returns true when arrived. */
  stepMovement(dt, stats) {
    const g = this.game;
    if (!this.path || this.pathIdx >= this.path.length) {
      this.moving = false;
      if (this.targetPos && (this.targetPos[0] - this.x) ** 2 + (this.targetPos[1] - this.z) ** 2 > 1.44) {
        this.path = null;
        this.pathIdx = 0;
        return false;
      }
      return true;
    }
    const speedBase = stats.speed * (this.speedMul || 1) * g.speedMulOnStep(this);
    let remaining = speedBase * dt;
    this.moving = true;

    let guard = 0;
    while (remaining > 0 && guard++ < 6) {
      const wp = this.path[this.pathIdx];
      let dx = wp[0] - this.x;
      let dz = wp[1] - this.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      if (d < 0.28) {
        this.pathIdx++;
        if (this.pathIdx >= this.path.length) { this.moving = false; return true; }
        continue;
      }
      const step = Math.min(d, remaining);
      dx /= d; dz /= d;
      // Direction is never rotated by neighbours (that used to make crowds
      // orbit forever); overlaps are resolved as a separate positional push.
      // (The old code normalised twice here -- a second hypot per waypoint
      // per unit per tick, for a vector that was already unit length.)
      const nx = this.x + dx * step;
      const nz = this.z + dz * step;
      /* A full passability test is a terrain sample, a slope lookup and a
         building query -- and it was being paid three times a tick for every
         man on the field. Walk is checked once per two-metre nav cell instead:
         inside a cell the ground is the same ground, so a unit that was free
         to stand here is free to stand a hand's width further on. Walls,
         cliffs and buildings are all stamped at cell scale, so nothing can be
         slipped through that the pathfinder would have refused. */
      if (this.def.naval) {
        this.x = clamp(nx, -250, 250);
        this.z = clamp(nz, -250, 250);
        this.desiredFacing = Math.atan2(dx, dz);
        remaining -= step;
        continue;
      }
      /* The cell the man is *standing in*, tested against the cell he last
         proved walkable. Standing in a cell that was checked is the proof;
         stepping into a new one is the question. Teleports (unstick, a
         garrison door, a crown changing hands) move the man to a different
         cell, so the proof lapses by itself. */
      /* the key is the nav grid's own index for the cell (row-major, z first),
         so it can be looked up in the hazard counters and in nothing else */
      const N = g.navN || 256;
      const hereKey = (((this.z + g.navHalf) * g.navInv) | 0) * N + (((this.x + g.navHalf) * g.navInv) | 0);
      const haz = g.navHaz;
      if ((this._passKey === hereKey && !(haz && haz[hereKey]))
          || g.isPassable(nx, nz, this)) {
        this.x = nx; this.z = nz;
        this._passKey = (((nz + g.navHalf) * g.navInv) | 0) * N + (((nx + g.navHalf) * g.navInv) | 0);
        this._wpBlock = 0;
      } else {
        /* A waypoint that stays blocked is a waypoint from a stale grid: the
           nav grid knows about walls and buildings, not about the tree the
           unit is now standing beside. Sliding around it forever is the
           classic RTS livelock, so after a moment the waypoint is abandoned
           and the next one (which came from the grid) is tried. */
        this._passKey = -1;
        this._wpBlock = (this._wpBlock || 0) + dt;
        if (this._wpBlock > 0.4) {
          this._wpBlock = 0;
          this.pathIdx++;
          if (this.pathIdx >= this.path.length) {
            /* the whole path is blocked: report arrival so the caller can
               decide whether to re-path or give up */
            this.moving = false;
            this.path = null;
            this.pathIdx = 0;
            return true;
          }
          continue;
        }
        /* Slide along the obstacle. Sliding is a detour, so it keeps a
           walking pace: the old code advanced the man by the waypoint's
           *smaller* component, which for a house three metres to the side of
           a four-metre march is two centimetres a tick. He crept, something
           nudged him back, and he spent half a minute on the same square
           metre of a house's face while every watchdog read "moving". */
        const sgnX = Math.abs(dx) > 1e-4 ? Math.sign(dx) : 0;
        const sgnZ = Math.abs(dz) > 1e-4 ? Math.sign(dz) : 0;
        const slide = Math.min(step, 0.45);
        let slid = false;
        const trySlide = (tx, tz) => {
          if (!tx && !tz) return false;
          const px = this.x + tx * slide, pz = this.z + tz * slide;
          if (!g.isPassable(px, pz, this)) return false;
          this.x = px; this.z = pz;
          return true;
        };
        /* One free axis: take it. Two free axes with a solid corner between
           them is *not* two free axes -- stepping on both is how a man walks
           into the front face of a house and wedges there. */
        const order = Math.abs(dx) >= Math.abs(dz)
          ? [[sgnX, 0], [0, sgnZ]]
          : [[0, sgnZ], [sgnX, 0]];
        for (const [tx, tz] of order) if (trySlide(tx, tz)) { slid = true; break; }
        if (!slid) {
          /* Both faces are solid: round the corner with a sidestep, on the
             side the man was already going (or the side with more ground). */
          const side = this._slideSign || this._pickSlideSide(dx, dz, step) || 1;
          const cands = [[-sgnZ * side, sgnX * side], [sgnZ * side, -sgnX * side], [sgnX, 0], [0, sgnZ]];
          for (const [tx, tz] of cands) if (trySlide(tx, tz)) { slid = true; break; }
        }
        if (slid) {
          this._passKey = -1;
          /* still a detour: keep the clock running so the order re-plans from
             the new ground rather than trusting the plan that walked him into
             the wall */
          this.repathTimer -= dt;
          if (this.repathTimer <= 0 && this.targetPos) {
            this.repathTimer = 0.32 + g.rng() * 0.24;
            this.setPath(this.targetPos[0], this.targetPos[1], true);
            if (!this.path) { this.moving = false; return true; }
          }
          this.wedgeT = 0;
          this.desiredFacing = Math.atan2(dx, dz);
          remaining -= slide;
          continue;
        }
        /* nothing free at all: the waypoint belongs to a stale grid, or the
           man is inside geometry. Abandon the waypoint after a beat, and
           sidestep for a moment before that to break the symmetry. */
        this.wedgeT = (this.wedgeT || 0) + dt;
        if (this.wedgeT > 0.25) {
          this.wedgeT = 0;
          const side = (this._wedgeDir = -(this._wedgeDir || 1));
          const px = this.x + (-dz) * 1.6 * side;
          const pz = this.z + dx * 1.6 * side;
          if (g.isPassable(px, pz, this)) {
            this.path = [[px, pz]];
            this.pathIdx = 0;
            this.targetPos = this.targetPos || [px, pz];
            this.repathTimer = 0.5;
            return false;
          }
        }
        if (this._wpBlock > 1.2) {
          this._wpBlock = 0;
          this.pathIdx++;
          if (this.pathIdx >= this.path.length) {
            /* the whole path is blocked: report arrival so the caller can
               decide whether to re-path or give up */
            this.moving = false;
            this.path = null;
            this.pathIdx = 0;
            return true;
          }
          continue;
        }
        this.repathTimer = Math.min(this.repathTimer, 0.12);
        this.moving = false;
        return false;
      }
      this.desiredFacing = Math.atan2(dx, dz);
      remaining -= step;
      // Crowding near a drop-off or a tree only stalls the economy, so the
      // separation push is skipped within a few metres of the destination.
      const nearGoal = this.targetPos ? Math.hypot(this.targetPos[0] - this.x, this.targetPos[1] - this.z) < 3.5 : true;
      if (!nearGoal && !this.def.naval && this.radius > 0.2) {
        const near = g.spatial.query(this.x, this.z, this.radius + 0.85);
        let pushX = 0, pushZ = 0;
        for (let k = 0; k < near.length; k++) {
          const o = near[k];
          if (o === this || o.dead || o.garrisoned || (o.def && o.def.naval)) continue;
          const ox = this.x - o.x, oz = this.z - o.z;
          const od2 = ox * ox + oz * oz;
          const minD = (this.radius + o.radius) * 0.92;
          if (od2 < minD * minD && od2 > 1e-5) {
            const od = Math.sqrt(od2);
            const w = (minD - od) / od * 0.5;
            pushX += ox * w;
            pushZ += oz * w;
          }
        }
        if (pushX !== 0 || pushZ !== 0) {
          const px = clamp(this.x + pushX, -250, 250);
          const pz = clamp(this.z + pushZ, -250, 250);
          if (g.isPassable(px, pz, this)) { this.x = px; this.z = pz; }
          else if (g.isPassable(px, this.z, this)) this.x = px;
          else if (g.isPassable(this.x, pz, this)) this.z = pz;
        }
      }
      if (g.rng() < dt * 0.35 && !this.def.naval && !this.def.siege && (this.type === 'knight' || this.type === 'war_elephant' || this.type === 'scout_cavalry' || this.type === 'cataphract' || this.type === 'hero_general')) {
        g.fx.dust(this.x, this.y, this.z, 1, 0.7);
      }
      const wpd = Math.hypot(wp[0] - this.x, wp[1] - this.z);
      if (wpd < 0.3) {
        this.pathIdx++;
        if (this.pathIdx >= this.path.length) { this.moving = false; return true; }
      }
    }
    return false;
  }
}

/* ============================================================
   BUILDING
   ============================================================ */
export class Building extends Entity {
  constructor(game, type, team, x, z, instant = false) {
    super(game, type, team, x, z);
    const def = BUILDING_DEFS[type];
    this.kind = 'building';
    this.def = def;
    this.name = def.name;
    this.maxHp = def.hp * (game.civBonuses(team).buildingHp || 1);
    this.hp = instant ? this.maxHp : this.maxHp * 0.08;
    this.buildProgress = instant ? 1 : 0.02;
    this.size = def.size || 3;
    this.radius = this.size * 0.5;
    this.height = Math.max(3, this.size * 1.3);
    /* A farm is a field, and a field is food. The data has said so since the
       first build -- `farm: { resKind: 'food', yield: 420 }` -- but nothing
       ever turned the building into something a villager could harvest, so a
       farm cost 60 wood and produced nothing at all. The building now carries
       its own remaining yield and the villager search reads it directly. */
    if (def.resKind && def.yield) {
      this.resKind = def.resKind;
      this.maxAmount = def.yield + (game ? game.farmYieldBonus(team) : 0);
      this.amount = this.maxAmount;
    }
    this.queue = [];
    this.researchQueue = [];
    this.rally = null;
    this.garrison = [];
    this.builders = new Map();
    this.attackCooldown = this.game ? this.game.rng() : Math.random();
    this.target = null;
    this.facing = def.water ? Math.PI : ((this.game ? this.game.rng() : Math.random()) * 0.2 - 0.1);
    this.trainProgress = 0;
    this.relics = 0;
    this.wonderTimer = 0;
    this.neutral = !!def.neutral;
    this.wall = !!def.wall;
    this.classes = ['building'];
    if (def.wall) this.classes.push('wall');
    this.lastDamageT = -99;
    this.smokeT = 0;
    this.gateOpen = false;
    if (this.neutral) { this.team = 0; this.hp = this.maxHp; this.buildProgress = 1; }
  }
  get isComplete() { return this.buildProgress >= 1; }

  onDeath(attacker) {
    const g = this.game;
    g.onBuildingKilled(this, attacker);
    g.fx.explosion(this.x, this.y + 1, this.z, 1.4);
    g.fx.smoke(this.x, this.y + 1.5, this.z, 12, 1.8, 0.8);
    for (let i = 0; i < 14; i++) {
      g.fx.spawn({
        x: this.x + (g.rng() - 0.5) * this.size, y: this.y + g.rng() * 2, z: this.z + (g.rng() - 0.5) * this.size,
        vx: (g.rng() - 0.5) * 4, vy: 2 + g.rng() * 4, vz: (g.rng() - 0.5) * 4,
        life: 1.2 + g.rng(), size: 0.2 + g.rng() * 0.2,
        r: 0.5, g: 0.45, b: 0.4, sprite: 12, gravity: 12, drag: 0.98
      });
    }
    if (this.garrison.length) {
      /* garrisoned men are still in `units`; see Game.releaseGarrison for the
         duplicate-entity bug this used to cause */
      g.releaseGarrison(this);
    }
  }

  addBuilder(unit, dt) {
    if (!this.builders.has(unit.id)) this.builders.set(unit.id, { unit, t: 0 });
    this.builders.get(unit.id).t += dt;
    // construction speed: diminishing returns per extra builder
    const n = this.builders.size;
    let speed = (3.2 * Math.min(n, 4)) / (1 + Math.max(0, n - 1) * 0.55);
    /* A Champion with the mason perk is worth more than his hands: the whole
       site moves faster while he is on it. */
    if (unit.champion && this.game.champions) {
      const mul = this.game.champions.buildMul(unit);
      if (mul !== 1) speed *= 1 + (mul - 1) / Math.max(1, n);
    }
    const civ = this.game.civBonuses(this.team);
    const bonus = (civ.buildSpeed || 1) * (this.game.hasTech(this.team, 'architecture') ? 1.3 : 1)
      * (this.game.calendar ? this.game.calendar.buildMul() : 1);
    this.buildProgress = Math.min(1, this.buildProgress + (speed * dt * bonus) / 12);
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.012 * dt * bonus * Math.min(3, n));
    if (this.buildProgress >= 1 && !this.completedOnce) {
      this.completedOnce = true;
      this.hp = Math.max(this.hp, this.maxHp * 0.55);
      this.game.onBuildingComplete(this);
    }
  }

  /**
   * Why this building cannot train `type` right now, or '' when it can.
   *
   * The command card and the queue both ask this one function, so a card can
   * never be drawn as available while the order is silently refused -- which
   * is exactly what happened to mod-trained units in v5: `def.trains` did not
   * contain the mod's unit id, so the button was painted, the click did
   * nothing, and the player was told nothing at all.
   */
  trainBlocker(type) {
    const g = this.game;
    const def = UNIT_DEFS[type];
    if (!def) return 'Unknown unit';
    const listed = !!(this.def.trains && this.def.trains.includes(type));
    const host = g.modHost;
    const ownedByMod = !!(host && host.ownsUnitType(type));
    if (!listed && !ownedByMod) return `${def.name} cannot be trained here`;
    if (host && ownedByMod) {
      const verdict = host.trainVerdict(this, type);
      if (verdict && !verdict.ok) return verdict.reason || `${def.name} is not available`;
    }
    if (this.queue.length >= 8) return 'The queue is full';
    const cost = g.unitCost(type, this.team);
    if (!g.canAfford(this.team, cost)) return 'Not enough resources';
    /* Reserve population at queue time. Without this the resources were spent
       the moment the queue finished and spawnUnit() threw the unit away at the
       cap -- eight villagers' worth of food vanishing with no message. */
    const need = UNIT_DEFS[type]?.pop ?? 1;
    if (g.popFree(this.team) - g.queuedPop(this.team) < need) return 'Population full — build houses';
    return '';
  }

  /** Queue a unit. Returns true on success. */
  queueUnit(type) {
    const g = this.game;
    /* The queue holds 8. v2 also refused the 6th item once the queue was
       non-empty, which quietly capped every building at 5 -- the HUD drew
       eight dots and the last three could never fill. */
    if (this.trainBlocker(type)) return false;
    if (this.queue.length >= 8) return false;
    const cost = g.unitCost(type, this.team);
    g.spend(this.team, cost);
    this.queue.push({ kind: 'unit', type, time: g.unitBuildTime(type, this.team), total: g.unitBuildTime(type, this.team), cost });
    return true;
  }

  queueTech(techId) {
    const g = this.game;
    const tech = TECH_DEFS[techId];
    if (!tech) return false;
    if (!this.def.research || !this.def.research.includes(techId)) return false;
    if (g.hasTech(this.team, techId)) return false;
    if (this.researchQueue.length) return false;
    if (g.ageOf(this.team) < tech.age) return false;
    if (!g.canAfford(this.team, tech.cost)) return false;
    g.spend(this.team, tech.cost);
    this.researchQueue.push({ techId, time: tech.time / (this.team === this.game.playerTeam ? 1 : g.aiSpeed), total: tech.time });
    return true;
  }

  garrisonUnit(unit) {
    if (this.garrison.length >= (this.def.garrison || 0)) return false;
    this.garrison.push(unit);
    unit.garrisoned = true;
    unit.garrisonTarget = this;
    unit.path = null;
    unit.targetPos = null;
    unit.target = null;
    unit.state = STATE.IDLE;
    return true;
  }

  ungarrisonAll() {
    return this.game.releaseGarrison(this);
  }

  update(dt) {
    if (this.dead) { this.deadT += dt; return; }
    const g = this.game;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.5);
    if (this.buildProgress < 1) {
      // decay builders that left
      for (const [id, b] of this.builders) {
        b.t -= dt;
        if (b.t < 0.35 || b.unit.state !== STATE.BUILD) this.builders.delete(id);
      }
      if (this.hp < this.maxHp * 0.08 && this.buildProgress < 0.02) this.hp = this.maxHp * 0.08;
      return;
    }
    const def = this.def;
    // production
    if (this.queue.length) {
      const item = this.queue[0];
      const speed = this.team === g.playerTeam ? 1 : g.aiSpeed;
      item.time -= dt * speed * (g.hasTech(this.team, 'conscription') ? 1.33 : 1) * (def.trainSpeed || 1);
      if (item.time <= 0) {
        /* Room is reserved when the order is placed, but a house that falls
           while the man is training takes it back. The finished levy used to be
           shifted off the queue and then thrown away by spawnUnit() at the cap:
           paid for, never seen. It waits at the gate instead, and marches out
           the moment a house goes up. */
        const need = UNIT_DEFS[item.type]?.pop ?? 1;
        if (g.popFree(this.team) < need) {
          item.time = 0;
        } else {
          this.queue.shift();
          const u = g.spawnUnit(item.type, this.team, this.x, this.z, this);
          if (u) g.onUnitTrained(this, item.type);
          else { this.queue.unshift(item); item.time = 0; }
        }
      }
    }
    if (this.researchQueue.length) {
      const item = this.researchQueue[0];
      item.time -= dt * (this.team === g.playerTeam ? 1 : g.aiSpeed);
      if (item.time <= 0) {
        this.researchQueue.shift();
        g.completeTech(this.team, item.techId);
        if (this.team === g.playerTeam) g.notify(`Researched ${TECH_DEFS[item.techId].name}`, 'good');
      }
    }
    // defensive fire
    /* Gates: a leaf rises for the owner's troops and settles again once they
       have gone through. Checked a few times a second, not every tick -- a
       walled town can have a dozen gates and the query is not free. */
    if (def.gate) {
      this.gateTimer = (this.gateTimer || 0) - dt;
      if (this.gateTimer <= 0) {
        this.gateTimer = 0.2;
        let want = false;
        const near = g.spatial.query(this.x, this.z, (def.size || 2.8) * 0.5 + 3.4);
        for (let i = 0; i < near.length; i++) {
          const u = near[i];
          if (u.dead || u.garrisoned || u.team !== this.team || (u.def && u.def.naval)) continue;
          if (Math.abs(u.x - this.x) < (def.size || 2.8) * 0.5 + 2.2 && Math.abs(u.z - this.z) < (def.size || 2.8) * 0.5 + 2.2) { want = true; break; }
        }
        this.gateWant = want;
      }
      const speed = this.gateWant ? 4.5 : 1.6;
      const target = this.gateWant ? 1 : 0;
      this.gateOpen = clamp((this.gateOpen || 0) + Math.sign(target - this.gateOpen) * speed * dt, 0, 1);
      if (this.gateOpen !== target && Math.abs(this.gateOpen - target) < 0.01) this.gateOpen = target;
    }
    if (def.attack > 0) {
      this.attackCooldown -= dt;
      const range = def.range || 8;
      if (this.attackCooldown <= 0) {
        const target = g.findEnemyNear(this, range);
        if (target) {
          const dmg = def.attack * (g.hasTech(this.team, 'fletching') ? 1.15 : 1);
          g.fireProjectile(this, target, dmg, 'arrow');
          /* a castle looses faster: `def.type` does not exist (defs are keyed,
             not stamped), so this line silently used the tower rate for years */
          this.attackCooldown = this.type === 'castle' ? 1.0 : 1.5;
        }
      }
    }
    // garrison arrows
    if (this.garrison.length && def.attack > 0) {
      this.garrisonFire = (this.garrisonFire || 0) + dt;
      if (this.garrisonFire > 0.85) {
        this.garrisonFire = 0;
        const target = g.findEnemyNear(this, (def.range || 8) + 1);
        if (target) g.fireProjectile(this, target, 5 + this.garrison.length * 0.8, 'arrow');
      }
    }
    // heal garrisoned
    for (const u of this.garrison) if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.04 * dt);
    // relic gold
    if (this.relics > 0) {
      const rate = this.relics * 0.55 * (g.hasTech(this.team, 'illumination') ? 2 : 1) / 60;
      g.addResource(this.team, 'gold', rate * dt * 60);
    }
    // fire and smoke
    if (this.hp / this.maxHp < 0.55) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = 0.25 + g.rng() * 0.4;
        g.fx.smoke(this.x + randRange(-1, 1, g.rng), this.y + this.height * 0.7, this.z + randRange(-1, 1, g.rng), 1, 1, 0.6);
      }
      if (this.hp / this.maxHp < 0.3) {
        if (g.rng() < dt * 8) g.fx.fire(this.x + randRange(-1.2, 1.2, g.rng), this.y + this.height * 0.55, this.z + randRange(-1.2, 1.2, g.rng), 1, 0.9);
      }
    }
    /* Wonder Race: the clock only runs on a *finished* wonder, and any
       damage to it knocks the clock back to zero so a half-ruined wonder
       cannot still win. */
    if (def.wonder) {
      if (this.buildProgress >= 0.999) {
        if (this.hp < this.maxHp * 0.999) g.resetWonder(this.team);
        else g.tickWonder(this.team, dt);
      } else {
        g.resetWonder(this.team);
      }
    }
    // town centre auto-rally spawn
    if (def.dropoff && g.rng() < dt * 0.5) {
      // chimney smoke
      if (this.type === 'town_center' || this.type === 'house' || this.type === 'monastery') {
        g.fx.smoke(this.x + (this.type === 'house' ? 0.55 : 1.2), this.y + this.height * 0.85, this.z, 1, 0.7, 0.8);
      }
    }
  }
}

/* ============================================================
   RESOURCE NODE
   ============================================================ */
export class ResourceNode extends Entity {
  constructor(game, type, x, z, amount, opts = {}) {
    super(game, type, team0(opts), x, z);
    this.kind = 'resource';
    this.resKind = opts.resKind || 'wood';
    this.amount = amount;
    this.maxAmount = amount;
    this.radius = opts.radius || 1.0;
    /* The solid part. A tree's collision radius is its canopy (bushes and
       deer get a generous one so villagers can path around them), but a
       building only loses the ground its trunk stands on -- see canPlaceAt. */
    this.trunkRadius = opts.trunkRadius || Math.max(0.5, this.radius * 0.34);
    this.scale = opts.scale || 1;
    this.variant = opts.variant || 0;
    this.facing = opts.facing !== undefined ? opts.facing : (this.game ? this.game.rng() : Math.random()) * 6.28;
    this.yOff = opts.yOff || 0;
    this.herd = !!opts.herd;
    this.workers = 0;
    this.hp = 9999;
    this.maxHp = 9999;
    this.dead = false;
    this.def = { size: this.radius * 2, hp: 9999, armor: 0 };
    this.type = type;
    this.team = opts.team || 0;
    this.classes = ['resource'];
    this.lod = false;
    this.refill = !!opts.refill;
    this.xPrev = x; this.zPrev = z; this.yPrev = this.y || 0;
  }
  update(dt) {
    if (this.dead) { this.deadT += dt; return; }
    // Forests regrow slowly: a match can never starve for wood entirely.
    if (this.resKind === 'wood' && this.amount < this.maxAmount * 0.55) {
      this.amount = Math.min(this.maxAmount * 0.55, this.amount + 0.45 * dt);
    }
    if (this.herd) {
      this.wander = (this.wander || 0) + dt;
      if (this.wander > 3.5) {
        this.wander = 0;
        this.wanderDir = this.game.rng() * 6.28;
        this.moving = true;
        this.moveT = 1.2;
      }
      if (this.moveT > 0) {
        this.moveT -= dt;
        const nx = this.x + Math.cos(this.wanderDir || 0) * dt * 0.7;
        const nz = this.z + Math.sin(this.wanderDir || 0) * dt * 0.7;
        if (!this.game.isWater(nx, nz) && Math.hypot(nx, nz) < 245) { this.x = nx; this.z = nz; this.y = this.game.heightAt(nx, nz); }
        this.facing = this.wanderDir || this.facing;
      }
    }
  }
  onDeath() {
    this.game.onResourceDepleted(this);
  }
  takeDamage(amount, attacker) {
    if (this.dead) return 0;
    this.amount -= amount * 4;
    if (this.amount <= 0) { this.amount = 0; this.kill(attacker); }
    return amount;
  }
}

function team0(opts) { return opts.team || 0; }
