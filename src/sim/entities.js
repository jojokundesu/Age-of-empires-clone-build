/* ============================================================
   entities.js — Units, Buildings and Resource Nodes
   A compact but deep RTS behaviour set: gather loops with drop-offs,
   stacked construction, formation movement, aggro/stances, ballistic
   projectiles, monk conversion, garrison arrows, garrisoned healing.
   ============================================================ */
import { UNIT_DEFS, BUILDING_DEFS, AGES, TECH_DEFS } from './data.js';
import { clamp, lerp, angleLerp } from '../core/math.js';

const randRange = (a, b) => a + Math.random() * (b - a);

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

let idCounter = 1;
export const nextEntityId = () => idCounter++;

export class Entity {
  constructor(game, type, team, x, z) {
    this.game = game;
    this.id = nextEntityId();
    this.type = type;
    this.team = team;
    this.x = x;
    this.z = z;
    this.y = game.heightAt(x, z);
    this.facing = Math.random() * Math.PI * 2;
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
    this.attackCooldown = Math.random() * 0.3;
    this.stance = 'aggressive';
    this.garrisoned = false;
    this.garrisonTarget = null;
    this.anim = { phase: Math.random() * 6.28, speed: 0, attack: 0, spin: 0, mount: 0 };
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
    const pf = this.game.pathFinder;
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

  /** Walk to the nearest free edge of a building, never to its centre. */
  approachBuilding(b, pad = 1.2) {
    edgePoint(this, b, pad, _edge);
    this.moveTo(_edge[0], _edge[1], true);
    if (this.path) return;
    const half = (b.def?.size || 2) * 0.5 + pad * 1.1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = b.x + Math.cos(a) * half;
      const pz = b.z + Math.sin(a) * half;
      if (this.game.isPassable(px, pz, this)) {
        this.moveTo(px, pz, true);
        if (this.path) return;
      }
    }
    this.moveTo(b.x, b.z, true);
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
    // stuck guard: if we are jammed near the drop-off, deliver anyway
    if (d > 2.6 && !(this.stallT > 0.85 && d < 6.0)) {
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
      if (target && target.buildProgress >= 1 && this.lastGatherKind) {
        const node = g.findNearestResource(this.lastGatherKind, this.x, this.z, 26, this);
        if (node) { this.gatherTarget = node; this.state = STATE.GATHER; return; }
      }
      this.state = STATE.IDLE;
      return;
    }
    const d = rectDist(this, target);
    if (d > 2.0 && !(this.stallT > 0.85 && d < 4.5)) {
      this.repathTimer -= dt;
      if (!this.path || this.repathTimer <= 0) {
        this.repathTimer = 3.0;
        this.approachBuilding(target, 1.0);
      }
      if (this.targetPos) this.stepMovement(dt, stats);
      if (this.stallT > 4.0) { this.buildTarget = null; this.state = STATE.IDLE; this.stallT = 0; }
      return;
    }
    this.moving = false;
    this.path = null;
    this.stallT = 0;
    this.desiredFacing = Math.atan2(target.x - this.x, target.z - this.z);
    target.addBuilder(this, dt);
    this.anim.attack = Math.max(this.anim.attack, Math.sin(g.time * 7) * 0.5 + 0.35);
    if (Math.random() < dt * 2.2) g.fx.dust(target.x + randRange(-1, 1), target.y + 0.2, target.z + randRange(-1, 1), 1, 0.8);
    if (target.buildProgress >= 1) {
      this.buildTarget = null;
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
    const d = rectDist(this, target);
    if (d > 1.3) {
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
    if (Math.random() < dt * 3) g.fx.heal(target.x, target.y, target.z, 1);
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
    if (Math.random() < dt * 6) g.fx.glowPulse(target.x, target.y + 0.8, target.z, 0.5, 0.75, 1);
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
          this.repathTimer = 0.32 + Math.random() * 0.24;
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
      if (Math.random() < dt * 0.35 && !this.def.naval && !this.def.siege && (this.type === 'knight' || this.type === 'war_elephant' || this.type === 'scout_cavalry' || this.type === 'cataphract' || this.type === 'hero_general')) {
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
    this.attackCooldown = Math.random();
    this.target = null;
    this.facing = def.water ? Math.PI : Math.random() * 0.2 - 0.1;
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
        x: this.x + (Math.random() - 0.5) * this.size, y: this.y + Math.random() * 2, z: this.z + (Math.random() - 0.5) * this.size,
        vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, vz: (Math.random() - 0.5) * 4,
        life: 1.2 + Math.random(), size: 0.2 + Math.random() * 0.2,
        r: 0.5, g: 0.45, b: 0.4, sprite: 12, gravity: 12, drag: 0.98
      });
    }
    if (this.garrison.length) {
      for (const u of this.garrison.slice()) {
        g.units.push(u);
        u.garrisoned = false;
        u.garrisonTarget = null;
        u.x = this.x + randRange(-2, 2);
        u.z = this.z + randRange(-2, 2);
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
    if (this.queue.length >= 8) return false;
    if (this.queue.length > 0) {
      if (this.queue.length >= 5) return false;
    }
    const cost = g.unitCost(type, this.team);
    if (!g.canAfford(this.team, cost)) return false;
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
      u.x = this.x + randRange(-this.size, this.size);
      u.z = this.z + randRange(-this.size, this.size);
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
        this.smokeT = 0.25 + Math.random() * 0.4;
        g.fx.smoke(this.x + randRange(-1, 1), this.y + this.height * 0.7, this.z + randRange(-1, 1), 1, 1, 0.6);
      }
      if (this.hp / this.maxHp < 0.3) {
        if (Math.random() < dt * 8) g.fx.fire(this.x + randRange(-1.2, 1.2), this.y + this.height * 0.55, this.z + randRange(-1.2, 1.2), 1, 0.9);
      }
    }
    // wonder timer
    if (def.wonder) {
      if (this.team === g.playerTeam) {
        g.wonderProgress += dt;
        if (g.wonderProgress >= 200) g.endGame(true, 'wonder');
      }
    }
    // town centre auto-rally spawn
    if (def.dropoff && Math.random() < dt * 0.5) {
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
    this.facing = opts.facing || Math.random() * 6.28;
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
        this.wanderDir = Math.random() * 6.28;
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
