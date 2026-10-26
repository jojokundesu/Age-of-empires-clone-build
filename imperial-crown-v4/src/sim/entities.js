/* ============================================================
   entities.js — Units, Buildings and Resource Nodes
   A compact but deep RTS behaviour set: gather loops with drop-offs,
   stacked construction, formation movement, aggro/stances, ballistic
   projectiles, monk conversion, garrison arrows, garrisoned healing.
   ============================================================ */
import { UNIT_DEFS, BUILDING_DEFS, AGES, TECH_DEFS } from './data.js';
import { clamp, lerp, angleLerp } from '../core/math.js';

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
const _edge = [0, 0];

export const STATE = {
  IDLE: 'idle', MOVE: 'move', ATTACK: 'attack', ATTACK_MOVE: 'attackmove',
  GATHER: 'gather', RETURN: 'return', BUILD: 'build', REPAIR: 'repair',
  HEAL: 'heal', CONVERT: 'convert', GARRISON: 'garrison', PATROL: 'patrol',
  DEAD: 'dead', TRADE: 'trade', UNPACK: 'unpack'
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
    if (kind === 'siege') armor *= 0.35;
    if (this.game && this.game.buffMul) {
      const blessed = this.game.buffMul(this.team, 'armor');
      if (blessed > 1) armor += blessed;
    }
    amount = Math.max(1, amount - armor);
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = Math.min(1, this.hitFlash + 0.55);
    if (attacker) {
      this.lastAttacker = attacker;
      this.lastAttackTime = this.game.time;
      this.game.alertAttacked(this, attacker);
    }
    if (this.hp <= 0) this.kill(attacker);
    return before - this.hp;
  }
  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }
  kill(attacker) {
    this.dead = true;
    this.deadT = 0;
    this.onDeath(attacker);
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

    // passive regeneration
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
      default: this.updateIdle(dt, stats); break;
    }

    // stall detection: real displacement, not the intent flag
    const movedSq = (this.x - prevX) * (this.x - prevX) + (this.z - prevZ) * (this.z - prevZ);
    if (movedSq < 0.00001 && (this.path || this.targetPos)) this.stallT = (this.stallT || 0) + dt;
    else this.stallT = 0;
    // progress watchdog: a unit that has not really moved for ~2 s is wedged
    this.chkTimer = (this.chkTimer || 0) + dt;
    if (this.chkTimer > 0.7) {
      this.chkTimer = 0;
      const px = this.chkX ?? this.x, pz = this.chkZ ?? this.z;
      const net = Math.hypot(this.x - px, this.z - pz);
      if ((this.path || this.targetPos) && net < 0.8) this.stuckScore = (this.stuckScore || 0) + 1;
      else this.stuckScore = 0;
      this.chkX = this.x;
      this.chkZ = this.z;
      if (this.stuckScore >= 3) {
        this.stuckScore = 0;
        g.unstick(this);
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
    this.y = def.naval ? 0.1 : g.heightAt(this.x, this.z);
    this.facing = angleLerp(this.facing, this.desiredFacing ?? this.facing, 1 - Math.pow(0.0008, dt));
  }

  updateGarrisoned(dt) {
    const g = this.game;
    const b = this.garrisonTarget;
    if (!b || b.dead) { g.removeFromGarrison(this); return; }
    if (this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 1.5 * dt);
    this.x = b.x; this.z = b.z;
  }

  updateIdle(dt, stats) {
    this.moving = false;
    // auto-acquire targets based on stance
    if (this.stance === 'stand' || this.noAggro) return;
    if (this.attackCooldown > 0) return;
    if (this.def.classes.includes('monk')) return;
    if (this.type === 'villager' && this.stance !== 'aggressive') return;
    const range = this.stance === 'defensive' ? 6 : (this.def.classes.includes('archer') ? Math.min(9, stats.range + 1.5) : 7);
    const enemy = this.game.findEnemyNear(this, range);
    if (enemy) {
      this.state = STATE.ATTACK;
      this.target = enemy;
    }
  }

  updateMove(dt, stats) {
    if (!this.targetPos) {
      // re-issue a lost path toward the standing order
      this.repathTimer -= dt;
      if (this.destX != null && this.repathTimer <= 0) {
        this.repathTimer = 0.45;
        this.setPath(this.destX, this.destZ, true);
        if (!this.path) return;
      } else return;
    }
    const arrived = this.stepMovement(dt, stats);
    if (arrived) {
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
        this.moveTo(tx, tz);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      if (d > chaseRange + 10) { this.target = null; this.state = STATE.IDLE; }
      return;
    }
    // in range: stop and attack
    this.moving = false;
    this.path = null;
    if (this.attackCooldown <= 0) {
      this.performAttack(target, stats);
    }
  }

  attackRangeTo(target, stats) {
    const tRadius = target.kind === 'building' ? (target.def.size || 3) * 0.5 : (target.radius || 0.4);
    if (this.def.range > 1.2) return stats.range;
    return this.radius + tRadius + 0.55;
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
    // aura and decree buffs
    const aura = g.auraBonusFor(this);
    dmg *= 1 + aura;
    dmg *= g.buffMul(this.team, 'attack');
    const isRanged = this.def.range > 1.2 && def.attack > 0;
    // Night raids: melee strikes land harder after dark.
    if (!isRanged) dmg *= g.nightRaidMul;
    if (isRanged && def.attack > 0) {
      g.fireProjectile(this, target, dmg, def.projectile || 'arrow');
      g.sound.play(this.def.classes.includes('archer') ? 'bow' : 'siegeFire', this.x, this.z);
    } else if (def.attack > 0) {
      target.takeDamage(dmg, this, 'melee');
      g.fx.sparks((this.x + target.x) / 2, this.y + 0.9, (this.z + target.z) / 2, 2, [1, 0.9, 0.7]);
      g.sound.play('hit', this.x, this.z);
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

  updateGather(dt, stats) {
    const g = this.game;
    let node = this.gatherTarget;
    if (!node || node.dead || node.amount <= 0) {
      node = g.findNearestResource(this.lastGatherKind || 'wood', this.x, this.z, 26, this);
      this.gatherTarget = node;
      if (!node) { this.state = STATE.IDLE; return; }
      this.moveTo(node.x, node.z, true);
    }
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
      node.kill(this);
      this.gatherTarget = null;
      if (node.type === 'farm') {
        // reseed
        g.tryReseedFarm(this, node);
      }
    }
    if (this.carry.amount >= cap - 0.01) this.returnResources();
  }

  carryCapFor(kind) {
    const g = this.game;
    let cap = 15;
    if (g.hasTech(this.team, 'wheelbarrow')) cap += 8;
    if (g.hasTech(this.team, 'hand_cart')) cap += 12;
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
      const node = g.findNearestResource(this.carry.kind || this.lastGatherKind || 'wood', this.x, this.z, 30, this);
      if (node) {
        this.gatherTarget = node;
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
    const heal = (this.def.heal || 10) * dt * (g.civBonuses(this.team).monkHeal || 1);
    target.heal(heal);
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
      if (this.targetPos && Math.hypot(this.targetPos[0] - this.x, this.targetPos[1] - this.z) > 1.2) {
        this.path = null;
        this.pathIdx = 0;
        return false;
      }
      return true;
    }
    const speedBase = stats.speed * (this.speedMul || 1) * (this.def.naval ? 1 : 1) * g.unitSpeedMul(this);
    let remaining = speedBase * dt;
    this.moving = true;
    let guard = 0;
    while (remaining > 0 && guard++ < 6) {
      const wp = this.path[this.pathIdx];
      let dx = wp[0] - this.x;
      let dz = wp[1] - this.z;
      let d = Math.hypot(dx, dz);
      if (d < 0.28) {
        this.pathIdx++;
        if (this.pathIdx >= this.path.length) { this.moving = false; return true; }
        continue;
      }
      const step = Math.min(d, remaining);
      dx /= d; dz /= d;
      // Direction is never rotated by neighbours (that used to make crowds
      // orbit forever); overlaps are resolved as a separate positional push.
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const nx = this.x + dx * step;
      const nz = this.z + dz * step;
      if (this.def.naval) {
        this.x = clamp(nx, -250, 250);
        this.z = clamp(nz, -250, 250);
      } else if (g.isPassable(nx, nz, this)) {
        this.x = nx; this.z = nz;
      } else {
        // slide along the obstacle on whichever axis is free
        const fx = g.isPassable(nx, this.z, this);
        const fz = g.isPassable(this.x, nz, this);
        if (fx) this.x = nx;
        if (fz) this.z = nz;
        this.repathTimer -= dt;
        if (this.repathTimer <= 0 && this.targetPos) {
          /* a jittered retry, but jittered on the *world's* stream, so two
             runs of the same seed unstick the same villagers at the same tick */
          this.repathTimer = 0.32 + g.rng() * 0.24;
          this.setPath(this.targetPos[0], this.targetPos[1], true);
          if (!this.path) { this.moving = false; return true; }
          return false;
        }
        if (!fx && !fz) {
          // fully wedged: sidestep perpendicular for a moment, then re-path
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
          this.repathTimer = Math.min(this.repathTimer, 0.12);
          this.moving = false;
          return false;
        }
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
      for (const u of this.garrison.slice()) {
        g.units.push(u);
        u.garrisoned = false;
        u.garrisonTarget = null;
        u.x = this.x + randRange(-2, 2, rngOf(this));
        u.z = this.z + randRange(-2, 2, rngOf(this));
        u.hp = Math.max(1, u.hp);
        u.state = STATE.IDLE;
      }
      this.garrison.length = 0;
    }
  }

  addBuilder(unit, dt) {
    if (!this.builders.has(unit.id)) this.builders.set(unit.id, { unit, t: 0 });
    this.builders.get(unit.id).t += dt;
    // construction speed: diminishing returns per extra builder
    const n = this.builders.size;
    const speed = (3.2 * Math.min(n, 4)) / (1 + Math.max(0, n - 1) * 0.55);
    const civ = this.game.civBonuses(this.team);
    const bonus = (civ.buildSpeed || 1) * (this.game.hasTech(this.team, 'architecture') ? 1.3 : 1);
    this.buildProgress = Math.min(1, this.buildProgress + (speed * dt * bonus) / 12);
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.012 * dt * bonus * Math.min(3, n));
    if (this.buildProgress >= 1 && !this.completedOnce) {
      this.completedOnce = true;
      this.hp = Math.max(this.hp, this.maxHp * 0.55);
      this.game.onBuildingComplete(this);
    }
  }

  /** Queue a unit. Returns true on success. */
  queueUnit(type) {
    const g = this.game;
    if (!this.def.trains || !this.def.trains.includes(type)) return false;
    /* The queue holds 8. v2 also refused the 6th item once the queue was
       non-empty, which quietly capped every building at 5 -- the HUD drew
       eight dots and the last three could never fill. */
    if (this.queue.length >= 8) return false;
    const cost = g.unitCost(type, this.team);
    if (!g.canAfford(this.team, cost)) return false;
    /* Reserve population at queue time. Without this the resources were spent
       the moment the queue finished and spawnUnit() threw the unit away at the
       cap -- eight villagers' worth of food vanishing with no message. */
    const need = UNIT_DEFS[type]?.pop ?? 1;
    if (g.popFree(this.team) - g.queuedPop(this.team) < need) return false;
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
    const g = this.game;
    for (const u of this.garrison) {
      u.garrisoned = false;
      u.garrisonTarget = null;
      u.x = this.x + randRange(-this.size, this.size, rngOf(this));
      u.z = this.z + randRange(-this.size, this.size, rngOf(this));
      u.state = STATE.IDLE;
    }
    this.garrison.length = 0;
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
        this.queue.shift();
        g.spawnUnit(item.type, this.team, this.x, this.z, this);
        g.onUnitTrained(this, item.type);
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
          this.attackCooldown = def.type === 'castle' ? 1.0 : 1.5;
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
