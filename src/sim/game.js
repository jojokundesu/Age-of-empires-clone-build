/* ============================================================
   game.js — the match
   Owns every unit, building and resource node; resolves economy,
   production, combat, vision and victory. Written to be stepping
   friendly: one call to update(dt) advances everything by dt.
   ============================================================ */
import {
  UNIT_DEFS, BUILDING_DEFS, TECH_DEFS, AGES, CIVS, DIFFICULTY, GAME_MODES,
  RES, POP_CAP, isUniqueUnit
} from './data.js';
import { Unit, Building, ResourceNode, STATE } from './entities.js';
import { PathFinder } from './pathfind.js';
import { SpatialHash } from './spatial.js';
import { ProjectilePool } from './projectiles.js';
import { WORLD } from './worldgen.js';
import { clamp, lerp, dist2 } from '../core/math.js';

export const TEAM_NEUTRAL = 0;
export const TEAM_PLAYER = 1;
export const TEAM_ENEMY = 2;

const RES_KEYS = ['food', 'wood', 'gold', 'stone'];
const FOW = WORLD.fowCells;

/* ============================================================
   DECREES — the council's standing offers. Each one is a short,
   decisive swing rather than a passive bonus, so they reward timing:
   save favour for the push you actually want to make.
   ============================================================ */
const DECREE_LIST = [
  {
    id: 'harvest', name: 'Harvest Festival', icon: 'leaf', cost: 40, age: 0,
    desc: 'All villagers gather 40% faster for 90 s.',
    apply(g, st, team) {
      g.addBuff(team, 'gather', 1.4, 90, 'Harvest Festival');
      for (const u of g.units) {
        if (!u.dead && u.team === team && u.type === 'villager') g.fx.glowPulse(u.x, u.y + 0.6, u.z, 0.5, 1.0, 0.6);
      }
    }
  },
  {
    id: 'rally', name: 'War Rally', icon: 'sword', cost: 55, age: 1,
    desc: 'Every soldier deals 30% more damage for 60 s.',
    apply(g, st, team) {
      g.addBuff(team, 'attack', 1.3, 60, 'War Rally');
      for (const u of g.units) {
        if (!u.dead && u.team === team && u.def.attack > 0) g.fx.sparks(u.x, u.y + 1.2, u.z, 3, [1, 0.75, 0.35]);
      }
    }
  },
  {
    id: 'forced_march', name: 'Forced March', icon: 'boot', cost: 45, age: 1,
    desc: 'Your army moves 35% faster for 50 s.',
    apply(g, st, team) {
      g.addBuff(team, 'speed', 1.35, 50, 'Forced March');
    }
  },
  {
    id: 'blessing', name: 'Field Blessing', icon: 'heart', cost: 60, age: 2,
    desc: 'Heal every unit to full and grant +2 armour for 70 s.',
    apply(g, st, team) {
      let any = false;
      for (const u of g.units) {
        if (u.dead || u.team !== team) continue;
        if (u.hp < u.maxHp) { u.heal(u.maxHp); any = true; }
        g.fx.heal(u.x, u.y + 0.9, u.z, 2);
      }
      g.addBuff(team, 'armor', 2, 70, 'Field Blessing');
      g.statsVersion++;
      return any || true;
    }
  },
  {
    id: 'conscription', name: 'Conscription', icon: 'people', cost: 80, age: 2, once: true,
    desc: 'Instantly raise 6 spearmen at your town centre.',
    apply(g, st, team) {
      const tc = g.buildings.find((b) => !b.dead && b.team === team && b.type === 'town_center');
      if (!tc) return false;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const u = g.spawnUnitRaw('spearman', team, tc.x + Math.cos(a) * 2.6, tc.z + Math.sin(a) * 2.6);
        if (u) { u.state = STATE.IDLE; g.fx.dust(u.x, u.y, u.z, 4, 0.8); }
      }
      return true;
    }
  },
  {
    id: 'golden_age', name: 'Golden Age', icon: 'crown', cost: 120, age: 3, once: true,
    desc: 'For 120 s: +20% damage, gathering and movement.',
    apply(g, st, team) {
      g.addBuff(team, 'all', 1.2, 120, 'Golden Age');
    }
  }
];

export class Game {
  constructor(opts) {
    this.world = opts.world;
    this.playerBase = opts.world.playerBase;
    this.enemyBase = opts.world.enemyBase;
    this.civ = opts.civ || 'franks';
    this.enemyCiv = opts.enemyCiv || this.pickEnemyCiv(this.civ);
    this.mode = opts.mode || 'campaign';
    this.difficultyKey = opts.difficulty || 'standard';
    this.difficulty = DIFFICULTY[this.difficultyKey] || DIFFICULTY.standard;
    this.playerTeam = TEAM_PLAYER;
    this.aiSpeed = this.difficultyKey === 'extreme' ? 1.18 : (this.difficultyKey === 'hard' ? 1.08 : 1);
    this.time = 0;
    this.frame = 0;
    this.running = true;
    this.gameOver = false;
    this.paused = false;
    this.speed = 1;

    this.units = [];
    this.buildings = [];
    this.resources = [];
    this.deadUnits = [];
    this.projectiles = new ProjectilePool(240);

    this.spatial = new SpatialHash(6, 96);
    this.spatial.half = WORLD.half;
    this.buildingSpatial = new SpatialHash(12, 48);
    this.buildingSpatial.half = WORLD.half;
    this.resourceSpatial = new SpatialHash(8, 72);
    this.resourceSpatial.half = WORLD.half;
    this.pathFinder = new PathFinder(this.world.nav.cells, this.world.nav.cell, WORLD.half);
    // Two nav layers: terrain (static) and building occupancy (dynamic).
    this.navTerrain = this.world.nav.blocked;
    this.navBuild = new Uint8Array(this.navTerrain.length);
    this.navFinal = new Uint8Array(this.navTerrain.length);
    this.navFinal.set(this.navTerrain);
    this.navDirty = false;
    this.navTimer = 0;
    this.pathFinder.setGrid(this.navFinal, WORLD.half);

    this.teams = new Map();
    for (const t of [TEAM_PLAYER, TEAM_ENEMY]) {
      this.teams.set(t, {
        civ: t === TEAM_PLAYER ? this.civ : this.enemyCiv,
        res: { food: 0, wood: 0, gold: 0, stone: 0 },
        techs: new Set(),
        age: 0,
        ageResearch: null,
        pop: 0,
        popCap: 0,
        popUsed: 0,
        kills: 0,
        losses: 0,
        gathered: 0,
        trained: 0,
        favor: 0,
        favorRate: 1,
        buffs: [],           // { kind, mul, time, name }
        decreesUsed: {},
        resigned: false
      });
    }

    // fog of war (player vision only; the AI plays fair with its own grid)
    this.fow = new Uint8Array(FOW * FOW);        // 0 hidden, 1 explored, 2 visible
    this.fowDirty = true;
    this.fowTimer = 0;
    this.fowTextureData = null;

    this.selection = [];
    this.selectionSet = new Set();
    this.groups = new Map();                 // control groups 0..9
    this.groundMarkers = [];                 // tap/command feedback rings
    this.placing = null;                     // {type,x,z,y,facing,valid,footprint}
    this.settings = { fog: true, bars: true, grid: false, shake: true };
    this.showFog = true;
    this.camera = null;                      // set by the app layer
    this.renderStats = null;
    this.notifyQueue = [];
    this.wonderProgress = 0;
    this.elapsed = 0;
    this.worldTime = 8.6;              // hour of the day, advanced by update()
    this.dayLength = 900;              // real seconds for a full cycle
    this.alerts = [];
    this.unitLimit = 220;
    this.stats = { tickMs: 0, units: 0, buildings: 0 };
    this.fx = opts.fx || NULL_FX;
    this.sound = opts.sound || NULL_SOUND;
    this.onEvent = opts.onEvent || (() => {});
    this.rng = opts.rand || Math.random;
    this.initialised = false;
    this.heightAt = (x, z) => this.world.height.sample(x, z);
    this.statsVersion = 1;          // bump to invalidate cached unit stats
    this._costCache = new Map();
    this._buildCostCache = new Map();
  }

  pickEnemyCiv(civ) {
    const keys = Object.keys(CIVS).filter((k) => k !== civ);
    return keys[(Math.random() * keys.length) | 0];
  }

  /* ==========================================================
     setup
     ========================================================== */
  start() {
    const w = this.world;
    this.spawnResources();
    this.setupTeam(TEAM_PLAYER, w.playerBase, this.civ);
    if (this.mode !== 'sandbox') this.setupTeam(TEAM_ENEMY, w.enemyBase, this.enemyCiv);
    this.initialised = true;
    this.recomputePop();
    this.surveyHome(w.playerBase);
    this.updateFog(1);
    this.onEvent('start', {});
    return this;
  }

  setupTeam(team, base, civ) {
    const diff = team === TEAM_PLAYER ? DIFFICULTY[this.difficultyKey] : this.difficulty;
    const st = this.teams.get(team);
    const start = this.mode === 'sandbox' ? { food: 10000, wood: 10000, gold: 10000, stone: 10000 }
      : (diff.start || { food: 300, wood: 300, gold: 150, stone: 100 });
    st.res.food = start.food;
    st.res.wood = start.wood;
    st.res.gold = start.gold;
    st.res.stone = start.stone;
    if (this.mode === 'sandbox') {
      for (const k of RES_KEYS) st.res[k] = 10000;
    }
    const bonuses = CIVS[civ].bonuses || {};
    if (bonuses.startBonus) {
      for (const k in bonuses.startBonus) st.res[k] = (st.res[k] || 0) + bonuses.startBonus[k];
    }

    // Town centre, slightly in front of the base point facing the map centre
    const face = Math.atan2(-base.x, -base.z);
    const tx = base.x + Math.sin(face) * 3.2;
    const tz = base.z + Math.cos(face) * 3.2;
    const tc = new Building(this, 'town_center', team, tx, tz, true);
    tc.facing = face;
    this.addBuilding(tc);

    // two houses for a comfortable starting population
    for (let i = 0; i < 2; i++) {
      const a = face + Math.PI * 0.78 + i * 0.55;
      const hx = base.x + Math.sin(a) * 9.5;
      const hz = base.z + Math.cos(a) * 9.5;
      const house = new Building(this, 'house', team, hx, hz, true);
      house.facing = a + Math.PI;
      this.addBuilding(house);
    }

    // starting villagers
    const count = team === TEAM_PLAYER ? (this.mode === 'sandbox' ? 8 : diff.startVillagers + 1) : diff.startVillagers;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const u = this.spawnUnitRaw('villager', team, tx + Math.cos(a) * 5.4, tz + Math.sin(a) * 5.4);
      if (u) u.facing = a;
    }
    // a scout to explore
    if (team === TEAM_PLAYER && this.mode !== 'sandbox') {
      const s = this.spawnUnitRaw('scout_cavalry', team, tx + 4, tz + 3);
      if (s) s.stance = 'defensive';
    }
    if (this.mode === 'regicide') {
      const king = this.spawnUnitRaw('hero_general', team, tx - 4, tz + 2);
      if (king) {
        king.isKing = true;
        king.maxHp = 900;
        king.hp = 900;
        king.name = 'King';
        king.speedMul = 1.05;
      }
      tc.crowns = team;
    }
    // initial gathering assignment for the player so the game starts moving
    if (team === TEAM_PLAYER) {
      const villagers = this.units.filter((u) => u.team === team && u.type === 'villager');
      const plan = ['wood', 'wood', 'food', 'gold', 'wood', 'food', 'stone', 'gold'];
      for (let i = 0; i < villagers.length; i++) {
        const kind = plan[i % plan.length];
        const node = this.findNearestResource(kind, base.x, base.z, 46, villagers[i]);
        if (node) {
          villagers[i].gatherTarget = node;
          villagers[i].state = STATE.GATHER;
          villagers[i].lastGatherKind = kind;
          villagers[i].moveTo(node.x, node.z, true);
        }
      }
    }
    st.popCap = this.computePopCap(team);
  }

  spawnResources() {
    const list = this.world.resources;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const node = new ResourceNode(this, r.type, r.x, r.z, r.amount, {
        resKind: r.resKind, radius: r.radius, scale: r.scale, variant: r.variant,
        herd: r.herd, yOff: r.y, team: TEAM_NEUTRAL
      });
      node.scale = r.scale;
      node.herd = !!r.herd;
      node.y = r.y;
      node.facing = (i * 2.399) % 6.283;
      this.resources.push(node);
      this.resourceSpatial.insert(node);
    }
    // neutral shrines become capturable buildings
    for (const p of this.world.poi || []) {
      const b = new Building(this, 'outpost_shrine', TEAM_NEUTRAL, p.x, p.z, true);
      b.facing = Math.random() * 6.28;
      this.addBuilding(b);
    }
  }

  /* ==========================================================
     queries used by entities
     ========================================================== */
  heightAt(x, z) { return this.world.height.sample(x, z); }
  getHeightFn() { return (x, z) => this.world.height.sample(x, z); }
  isWater(x, z) { return this.world.height.sample(x, z) < -0.3; }
  isInside(x, z) { return x > -WORLD.half + 2 && x < WORLD.half - 2 && z > -WORLD.half + 2 && z < WORLD.half - 2; }

  /**
   * Unit-level passability. Deliberately independent of the coarse A* grid so
   * that a 2 m cell can never trap a soldier: only real water, cliffs and
   * solid buildings stop a unit.
   */
  isPassable(x, z, unit) {
    if (!this.isInside(x, z)) return false;
    const h = this.world.height.sample(x, z);
    if (unit && unit.def && unit.def.naval) return h < -0.3;
    if (h < -0.25) return false;
    if (this.world.height.slope(x, z) > 0.95) return false;
    const near = this.buildingSpatial.query(x, z, 5);
    for (let i = 0; i < near.length; i++) {
      const b = near[i];
      if (b.dead || b.wall) continue;
      const half = (b.def.size || 3) * 0.5 - 0.05 + (unit ? unit.radius * 0.4 : 0.2);
      if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return false;
    }
    return true;
  }

  /**
   * Safety valve: relocate a wedged unit to the nearest walkable spot and let
   * it re-plan. Called rarely, so the cost of the spiral search is irrelevant.
   */
  unstick(unit) {
    const px = unit.x, pz = unit.z;
    let best = null, bestD = 1e9;
    for (let ring = 1; ring <= 7; ring++) {
      const r = ring * 0.85;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + ring * 0.37;
        const x = px + Math.cos(a) * r;
        const z = pz + Math.sin(a) * r;
        if (!this.isPassable(x, z, unit)) continue;
        const [ncx, ncz] = this.pathFinder.worldToCell(x, z);
        if (this.pathFinder.isBlocked(ncx, ncz)) continue;
        const d = dist2(x, z, unit.x, unit.z);
        if (d < bestD) { bestD = d; best = [x, z]; }
      }
      if (best) break;
    }
    if (best) { unit.x = best[0]; unit.z = best[1]; }
    unit.path = null;
    unit.pathIdx = 0;
    unit.targetPos = null;
    unit.wedgeT = 0;
    unit.stallT = 0;
    unit.repathTimer = 0;
    return !!best;
  }

  /** Cheap straight-walk test used for short, direct movement. */
  walkableLine(x0, z0, x1, z1, unit) {
    const dx = x1 - x0, dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) return true;
    const steps = Math.min(40, Math.ceil(d / 1.6));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.isPassable(x0 + dx * t, z0 + dz * t, unit)) return false;
    }
    return true;
  }

  teamOf(team) { return this.teams.get(team); }
  civOf(team) { const t = this.teams.get(team); return t ? t.civ : this.civ; }
  civBonuses(team) { return CIVS[this.civOf(team)]?.bonuses || {}; }
  civBonus(team, key, type) {
    const b = this.civBonuses(team);
    if (key === 'unitHp') {
      const def = UNIT_DEFS[type] || {};
      if (type === 'war_elephant' && b.elephantHp) return b.elephantHp;
      if (def.classes && def.classes.includes('cavalry') && b.cavalryHp) return b.cavalryHp;
      if (def.classes && def.classes.includes('infantry') && b.infantryHp) return b.infantryHp;
    }
    return b[key] || 1;
  }
  ageOf(team) { return this.teams.get(team)?.age || 0; }
  hasTech(team, id) { return this.teams.get(team)?.techs.has(id) || false; }
  hasPersonalTech(team, id) { return this.hasTech(team, id); }

  /* ==========================================================
     resources & production
     ========================================================== */
  unitCost(type, team) {
    const key = type + '|' + team;
    const cached = this._costCache.get(key);
    if (cached) return cached;
    const def = UNIT_DEFS[type];
    const cost = { ...def.cost };
    const civ = this.civOf(team);
    const b = this.civBonuses(team);
    if (def.classes.includes('infantry') && b.infantryDiscount) for (const k in cost) cost[k] *= b.infantryDiscount;
    if ((type === 'spearman' || type === 'skirmisher') && b.trashDiscount) for (const k in cost) cost[k] *= b.trashDiscount;
    if (def.classes.includes('ship') && b.shipDiscount) for (const k in cost) cost[k] *= b.shipDiscount;
    for (const k in cost) cost[k] = Math.round(cost[k]);
    this._costCache.set(key, cost);
    return cost;
  }
  unitBuildTime(type, team) {
    const def = UNIT_DEFS[type];
    let t = def.time;
    const b = this.civBonuses(team);
    const civ = this.civOf(team);
    if (def.classes.includes('infantry') && b.barracksSpeed) t /= b.barracksSpeed;
    if (def.classes.includes('archer') && b.archerySpeed && type !== 'mangudai') t /= b.archerySpeed;
    if (def.classes.includes('cavalry') && this.hasTech(team, 'chivalry')) t /= 1.4;
    if (this.ageOf(team) >= 2) t *= 0.94;
    return t;
  }
  canAfford(team, cost) {
    const st = this.teams.get(team);
    if (!st) return false;              // neutral / unowned team
    const r = st.res;
    for (const k in cost) if ((r[k] || 0) < cost[k]) return false;
    return true;
  }
  spend(team, cost) {
    const st = this.teams.get(team);
    if (!st) return;
    const r = st.res;
    for (const k in cost) r[k] = (r[k] || 0) - cost[k];
  }
  addResource(team, kind, amount) {
    const st = this.teams.get(team);
    if (!st) return;
    if (this.mode === 'sandbox' && team === TEAM_PLAYER) {
      // sandbox keeps a deep pool
      st.res[kind] = Math.max(st.res[kind], 9999);
      return;
    }
    st.res[kind] = Math.max(0, (st.res[kind] || 0) + amount);
  }
  recalcCost(type) { return UNIT_DEFS[type].cost; }

  buildingCost(type, team) {
    const key = type + '|' + team;
    const cached = this._buildCostCache.get(key);
    if (cached) return cached;
    const def = BUILDING_DEFS[type];
    const cost = { ...def.cost };
    if (type === 'castle') {
      const b = this.civBonuses(team);
      if (b.castleDiscount) for (const k in cost) cost[k] = Math.round(cost[k] * b.castleDiscount);
    }
    this._buildCostCache.set(key, cost);
    return cost;
  }

  computePopCap(team) {
    let cap = 0;
    for (const b of this.buildings) {
      if (b.dead || b.team !== team || b.buildProgress < 0.6) continue;
      cap += b.def.pop || 0;
    }
    const bonus = this.civBonuses(team).popBonus || 0;
    return Math.min(POP_CAP[3], cap + bonus);
  }
  recomputePop() {
    for (const team of this.teams.keys()) {
      const st = this.teams.get(team);
      st.popCap = this.computePopCap(team);
      let used = 0;
      for (const u of this.units) if (!u.dead && u.team === team) used += u.def.pop || 1;
      st.popUsed = used;
    }
    this.popDirty = false;
  }
  popFree(team) {
    const st = this.teams.get(team);
    return st.popCap - st.popUsed;
  }

  gatherRate(unit, kind) {
    const team = unit.team;
    const civ = this.civOf(team);
    const b = this.civBonuses(team);
    // Base rates. These are deliberately a touch above the genre norm: on a
    // phone the player has less time, and a villager that visibly pays for
    // itself keeps the early game from feeling like waiting.
    let rate = kind === 'food' ? 3.3 : kind === 'wood' ? 3.25 : kind === 'gold' ? 2.6 : 2.2;
    if (kind === 'food' && unit.gatherTarget && unit.gatherTarget.type === 'farm') {
      rate = 3.2;
      if (this.hasTech(team, 'horse_collar')) rate *= 1.15;
      if (this.hasTech(team, 'heavy_plow')) rate *= 1.15;
      rate *= b.farmRate || 1;
    }
    if (kind === 'wood') {
      if (this.hasTech(team, 'double_bit_axe')) rate *= 1.2;
      if (this.hasTech(team, 'bow_saw')) rate *= 1.2;
    }
    if (kind === 'gold' && this.hasTech(team, 'gold_mining')) rate *= 1.2;
    if (kind === 'stone' && this.hasTech(team, 'stone_mining')) rate *= 1.2;
    if (kind === 'food' && unit.gatherTarget && (unit.gatherTarget.type === 'berry_bush') && civ === 'britons') rate *= 1.25;
    if (kind === 'food' && unit.gatherTarget && (unit.gatherTarget.type === 'deer' || unit.gatherTarget.type === 'boar') && b.huntBonus) rate *= b.huntBonus;
    if (kind === 'food' && unit.gatherTarget && unit.gatherTarget.type === 'fish' && b.fishingBonus) rate *= b.fishingBonus;
    if (civ === 'persians' && unit.type === 'villager') rate *= 1.05;
    if (team !== TEAM_PLAYER) rate *= this.difficulty.gather;
    if (this.difficultyKey === 'sandbox') rate *= 1.25;
    rate *= this.buffMul(team, 'gather');
    rate *= this.gatherDayMul;
    return rate;
  }

  findNearestResource(kind, x, z, maxDist, unit) {
    // Deterministic per-unit jitter spreads a work crew across a whole mine
    // or grove instead of stacking everybody on one node.
    const jitter = unit ? (((unit.id * 2654435761) >>> 0) % 1000) / 1000 : 0.5;
    let best = null, bestScore = maxDist * maxDist;
    let nearest = null, nearestD = maxDist * maxDist;
    for (let i = 0; i < this.resources.length; i++) {
      const r = this.resources[i];
      if (r.dead || r.amount <= 0) continue;
      if (r.resKind !== kind) continue;
      const d = dist2(x, z, r.x, r.z);
      if (d < nearestD) { nearestD = d; nearest = r; }
      const score = d * (0.72 + 0.56 * (((i * 31 + jitter * 997) % 100) / 100));
      if (score < bestScore) { bestScore = score; best = r; }
    }
    return best || nearest;
  }

  findDropoff(team, kind, x, z, maxDist = 999) {
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b.dead || b.team !== team || b.buildProgress < 0.99) continue;
      if (!b.def.dropoff) continue;
      if (kind !== 'any' && b.def.dropoff.indexOf(kind) < 0) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  deposit(unit, kind, amount) {
    if (!kind || amount <= 0) return;
    this.addResource(unit.team, kind, amount);
    if (unit.team === TEAM_PLAYER) {
      this.trackFloat?.(kind, amount, unit.x, unit.z);
    }
    const st = this.teams.get(unit.team);
    if (st) st.gathered += amount;
    this.onEvent('deposit', { team: unit.team, kind, amount });
  }

  onGather(unit, node, amount) {
    if (Math.random() < 0.25) {
      if (node.resKind === 'wood') this.fx.leaves(node.x, node.y, node.z, 1);
      else if (node.resKind === 'stone' || node.resKind === 'gold') this.fx.sparks(node.x, node.y + 0.4, node.z, 1, [0.9, 0.85, 0.7]);
      else this.fx.dust(node.x, node.y, node.z, 1, 0.6);
    }
  }

  onResourceDepleted(node) {
    if (node.type === 'tree') this.fx.leaves(node.x, node.y + 1, node.z, 5);
    else if (node.type === 'gold_mine' || node.type === 'stone_mine') this.fx.explosion(node.x, node.y + 0.5, node.z, 0.5);
    this.resourcesDirty = true;
  }

  tryReseedFarm(unit, node) {
    // farms can be re-seeded for a small wood cost, keeping the villager working
    const team = unit.team;
    if (this.canAfford(team, { wood: 60 })) {
      this.spend(team, { wood: 60 });
      node.amount = 280 + (this.hasTech(team, 'horse_collar') ? 75 : 0) + (this.hasTech(team, 'heavy_plow') ? 125 : 0);
      if (node.dead) { node.dead = false; node.deadT = 0; this.resources.push(node); }
      unit.gatherTarget = node;
      unit.state = STATE.GATHER;
    } else {
      unit.gatherTarget = null;
      unit.state = STATE.IDLE;
      if (team === TEAM_PLAYER) this.notify('Not enough wood to reseed the farm', 'bad');
    }
  }

  /* ==========================================================
     spawning
     ========================================================== */
  spawnUnitRaw(type, team, x, z) {
    const def = UNIT_DEFS[type];
    if (!def) return null;
    const fx = this.isPassable(x, z, { radius: 0.4, def }) ? x : this.nudgeFree(x, z);
    const fz = this.isPassable(fx, z, { radius: 0.4, def }) ? z : this.nudgeFree(fx, z, true);
    const u = new Unit(this, type, team, fx, fz);
    u.statsCache = null;
    this.units.push(u);
    if (team === TEAM_PLAYER) this.popDirty = true;
    return u;
  }

  nudgeFree(x, z, onlyZ = false) {
    for (let r = 0.6; r < 7; r += 0.6) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const nz = z + Math.sin(ang) * r;
        if (this.isPassable(nx, nz, { radius: 0.4, def: {} })) return onlyZ ? nz : nx;
      }
    }
    return onlyZ ? z : x;
  }

  spawnUnit(type, team, x, z, fromBuilding) {
    const st = this.teams.get(team);
    if (!st) return null;
    this.recomputePop();
    const def = UNIT_DEFS[type];
    if (st.popUsed + (def.pop || 1) > st.popCap) {
      if (team === TEAM_PLAYER) this.notify('Population limit reached — build houses', 'bad');
      return null;
    }
    // spawn just in front of the building
    let sx = x, sz = z;
    if (fromBuilding) {
      const ang = fromBuilding.rally ? Math.atan2(fromBuilding.rally.z - fromBuilding.z, fromBuilding.rally.x - fromBuilding.x) : fromBuilding.facing + Math.PI;
      const r = (fromBuilding.def.size || 3) * 0.5 + 1.4;
      sx = fromBuilding.x + Math.cos(ang) * r;
      sz = fromBuilding.z + Math.sin(ang) * r;
    }
    const u = this.spawnUnitRaw(type, team, sx, sz);
    if (!u) return null;
    st.popUsed += def.pop || 1;
    st.trained++;
    if (fromBuilding) {
      u.facing = fromBuilding.facing + Math.PI;
      if (fromBuilding.rally) {
        u.state = STATE.MOVE;
        u.moveTo(fromBuilding.rally.x, fromBuilding.rally.z, true);
      } else {
        // gather automatically if it is a villager
        if (type === 'villager') {
          const kind = this.pickGatherKind(team, sx, sz);
          const node = this.findNearestResource(kind, sx, sz, 55, u);
          if (node) {
            u.gatherTarget = node;
            u.state = STATE.GATHER;
            u.lastGatherKind = kind;
            u.moveTo(node.x, node.z, true);
          }
        } else {
          // military gathers at the rally point / building front
          const a = fromBuilding.facing + Math.PI;
          u.state = STATE.MOVE;
          u.moveTo(sx + Math.cos(a) * 3.5, sz + Math.sin(a) * 3.5, true);
        }
      }
    }
    this.onEvent('spawn', { unit: u, team });
    return u;
  }

  pickGatherKind(team, x, z) {
    // keeps the economy balanced: wood > food > gold > stone
    const workers = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const u of this.units) {
      if (u.dead || u.team !== team || u.type !== 'villager') continue;
      const k = u.carry.kind || u.lastGatherKind;
      if (k && workers[k] !== undefined) workers[k]++;
    }
    const want = { wood: 0.36, food: 0.34, gold: 0.22, stone: 0.08 };
    const total = workers.food + workers.wood + workers.gold + workers.stone || 1;
    let best = 'wood', bestGap = -1e9;
    for (const k of RES_KEYS) {
      if (k === 'stone' && this.ageOf(team) < 1) continue;
      const gap = want[k] - workers[k] / total;
      if (gap > bestGap) { bestGap = gap; best = k; }
    }
    return best;
  }

  addBuilding(b) {
    this.buildings.push(b);
    this.markBuildingFootprint(b, true);
    this.buildingSpatialDirty = true;
    this.popDirty = true;
    return b;
  }

  /**
   * Buildings are *dynamic* obstacles rather than nav-grid stamps: a 4 m grid
   * cannot represent a 5.8 m town centre without blocking ~16 m of ground,
   * which used to wedge villagers against their own drop-off. Local avoidance
   * in isPassable() plus slide-and-repath in Unit.stepMovement handles them.
   */
  markBuildingFootprint(b, blocked) {
    this.buildingSpatialDirty = true;
    if (b.def.neutral && !b.def.wall) return;
    const N = this.world.nav.cells;
    const cell = this.world.nav.cell;
    const half = WORLD.half;
    const s = (b.def.size || 3) * 0.5 + 0.15;
    const x0 = Math.max(0, Math.floor((b.x - s + half) / cell));
    const x1 = Math.min(N - 1, Math.floor((b.x + s + half) / cell));
    const z0 = Math.max(0, Math.floor((b.z - s + half) / cell));
    const z1 = Math.min(N - 1, Math.floor((b.z + s + half) / cell));
    const delta = blocked ? 1 : -1;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const i = cz * N + cx;
        this.navBuild[i] = Math.max(0, this.navBuild[i] + delta);
      }
    }
    this.navDirty = true;
  }

  /** Recombine the nav layers and hand the result to the path finder. */
  refreshNav() {
    this.navDirty = false;
    const t = this.navTerrain, b = this.navBuild, out = this.navFinal;
    for (let i = 0; i < out.length; i++) out[i] = (t[i] || b[i]) ? 1 : 0;
    this.pathFinder.setGrid(out, WORLD.half);
  }

  /* ==========================================================
     combat
     ========================================================== */
  findEnemyNear(entity, range) {
    const team = entity.team;
    const r2 = range * range;
    const near = this.spatial.query(entity.x, entity.z, range + 2);
    let best = null, bestD = r2;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o === entity || o.dead || o.team === team || o.team === TEAM_NEUTRAL) continue;
      const d = dist2(entity.x, entity.z, o.x, o.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best) return best;
    // buildings are checked separately (few, and mostly static)
    const bn = this.buildingSpatial.query(entity.x, entity.z, range + 4);
    for (let i = 0; i < bn.length; i++) {
      const o = bn[i];
      if (o.dead || o.team === team || o.team === TEAM_NEUTRAL) continue;
      const half = (o.def.size || 3) * 0.5;
      const d = dist2(entity.x, entity.z, o.x, o.z) - half * half;
      if (d < r2 && d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  unitsNear(x, z, radius, filter) {
    const near = this.spatial.query(x, z, radius);
    const out = [];
    for (let i = 0; i < near.length; i++) {
      if (!filter || filter(near[i])) out.push(near[i]);
    }
    return out;
  }

  findUnitsOfTeam(team) {
    const out = [];
    for (const u of this.units) if (!u.dead && u.team === team) out.push(u);
    return out;
  }

  fireProjectile(from, target, damage, kind) {
    const def = from.def;
    const projKind = kind || def.projectile || 'arrow';
    const track = this.hasTech(from.team, 'ballistics') ? (def.classes && def.classes.includes('archer') ? 1 : 0.4) : 0;
    this.projectiles.spawn(from, target, damage, projKind, {
      track,
      splash: def.splash || 0,
      fromHeight: from.kind === 'building' ? from.height * 0.8 : 1.4,
      arc: def.projectile === 'boulder' ? 5 : undefined
    });
    if (projKind === 'boulder' || projKind === 'cannon') this.sound.play('siege', from.x, from.z);
  }

  explodeArea(x, z, radius, damage, source, team) {
    const r2 = radius * radius;
    for (const u of this.units) {
      if (u.dead || u.team === team) continue;
      if (dist2(x, z, u.x, u.z) <= r2) {
        u.takeDamage(damage * (u.def.classes.includes('cavalry') ? 0.9 : 1), source, 'siege');
      }
    }
    for (const b of this.buildings) {
      if (b.dead || b.team === team) continue;
      const half = (b.def.size || 3) * 0.5;
      if (dist2(x, z, b.x, b.z) <= (radius + half) * (radius + half)) b.takeDamage(damage * 0.8, source, 'siege');
    }
    this.fx.explosion(x, this.heightAt(x, z) + 0.4, z, radius * 0.5);
    this.sound.play('explosion', x, z);
  }

  auraBonusFor(unit) {
    let best = 0;
    const team = unit.team;
    for (const u of this.units) {
      if (u.dead || u.team !== team || u === unit) continue;
      if (!u.def.auraRange) continue;
      if (dist2(u.x, u.z, unit.x, unit.z) <= u.def.auraRange * u.def.auraRange) {
        best = Math.max(best, u.def.auraBonus || 0.15);
      }
    }
    return best;
  }

  unitSpeedMul(unit) {
    // packed formation cohesion: slight slowdown when very close to allies
    return this.buffMul(unit.team, 'speed');
  }

  /* ==========================================================
     IMPERIAL DECREES (favour)
     ========================================================== */
  buffMul(team, kind) {
    const st = this.teams.get(team);
    if (!st || !st.buffs || !st.buffs.length) return 1;
    let m = 1;
    for (let i = 0; i < st.buffs.length; i++) {
      const b = st.buffs[i];
      if (b.kind === kind) {
        m *= b.mul;
        continue;
      }
      // a golden age lifts every multiplier a little
      if (b.kind === 'all') m *= 1 + (b.mul - 1) * 0.6;
    }
    return m;
  }

  /** The council's standing offers. Cheap data so the HUD can list them. */
  get decrees() { return DECREE_LIST; }

  /** Jump the day cycle (0-24h). Used by saves, the shot tool and tests. */
  setTimeOfDay(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return this.worldTime;
    this.worldTime = ((h % 24) + 24) % 24;
    return this.worldTime;
  }

  /** 0 = deep night, 1 = high noon. Handy for AI, UI and balance rules. */
  get daylight() {
    const h = this.worldTime;
    const t = (h - 5.5) / 13.5;
    return Math.max(0, Math.min(1, Math.sin(Math.max(-0.35, Math.min(1.35, t)) * Math.PI)));
  }

  /** Coarse phase for the HUD, the AI and the soundscape. */
  get dayPhase() {
    const h = this.worldTime;
    if (h >= 7.5 && h < 17.5) return 'day';
    if (h >= 5.0 && h < 7.5) return 'dawn';
    if (h >= 17.5 && h < 20.0) return 'dusk';
    return 'night';
  }

  /* Day and night are not just lighting: they are two different games.
     - Daylight: villagers work 24 % faster, so the economy is a day job.
     - Night: gathering slows to 86 %, but every melee attack hits 16 %
       harder and sight shrinks, which makes night raids the cheapest way to
       punish a bigger army. The values are symmetric for every team. */
  get gatherDayMul() { return 0.86 + 0.24 * this.daylight; }
  get nightRaidMul() { return 1 + 0.16 * (1 - this.daylight); }
  get sightDayMul() { return 0.84 + 0.16 * this.daylight; }

  /** Everything the council panel needs to explain a decree's state. */
  decreeState(team, id) {
    const st = this.teams.get(team);
    const def = DECREE_LIST.find((d) => d.id === id);
    if (!st || !def) return { ok: false, reason: 'Unknown decree' };
    if (def.age !== undefined && st.age < def.age) return { ok: false, reason: `Needs ${AGES[def.age].name}`, needsAge: def.age };
    if (def.once && st.decreesUsed[id]) return { ok: false, reason: 'Already proclaimed', used: true };
    if (st.favor < def.cost) return { ok: false, reason: `Needs ${def.cost} favour`, short: def.cost - Math.floor(st.favor) };
    return { ok: true, reason: '', affordable: true };
  }

  /** 0..1 progress of a running buff (for the HUD countdown bars). */
  buffProgress(team, name) {
    const st = this.teams.get(team);
    const b = st && st.buffs ? st.buffs.find((x) => x.name === name) : null;
    if (!b || !b.duration) return 0;
    return Math.max(0, Math.min(1, b.time / b.duration));
  }

  activateDecree(team, id) {
    const st = this.teams.get(team);
    const def = DECREE_LIST.find((d) => d.id === id);
    if (!st || !def) return { ok: false, reason: 'Unknown decree' };
    if (st.favor < def.cost) return { ok: false, reason: `Needs ${def.cost} favour` };
    if (def.age !== undefined && st.age < def.age) return { ok: false, reason: 'Requires a later age' };
    if (def.once && st.decreesUsed[id]) return { ok: false, reason: 'Already proclaimed' };
    st.favor -= def.cost;
    st.decreesUsed[id] = (st.decreesUsed[id] || 0) + 1;
    const result = def.apply(this, st, team);
    if (result === false) {
      st.favor += def.cost;                 // refund a no-op
      return { ok: false, reason: 'Nothing to affect' };
    }
    if (team === TEAM_PLAYER) {
      this.notify(def.name + ': ' + def.desc, 'good');
      this.sound.play('horn');
    }
    this.onEvent('decree', { team, id });
    return { ok: true, msg: def.name };
  }

  addBuff(team, kind, mul, time, name) {
    const st = this.teams.get(team);
    if (!st) return;
    const existing = st.buffs.find((b) => b.kind === kind && b.name === name);
    if (existing) {
      existing.time = Math.max(existing.time, time);
      existing.duration = Math.max(existing.duration || 0, existing.time);
    } else {
      st.buffs.push({ kind, mul, time, duration: time, name });
    }
    this.statsVersion++;
  }

  /* ==========================================================
     MARKET — the classic 100-resource trade with a moving price
     ========================================================== */
  marketPrice(kind, amount = 100) {
    if (!this._marketBase) this._marketBase = { food: 100, wood: 100, gold: 100, stone: 130 };
    const base = this._marketBase[kind] ?? 100;
    const st = this.teams.get(TEAM_PLAYER);
    const stock = st ? st.res[kind] : 0;
    // scarcity: the price climbs when the store is nearly empty
    const scarcity = 1 + Math.max(0, 250 - stock) / 420;
    return Math.round(base * scarcity * (amount / 100) * 1.0);
  }

  /** Relative price change per good over the last ~2 s (market UI arrow). */
  marketTrend(kind) {
    if (!this._marketTrend) {
      this._marketTrend = { food: 0, wood: 0, gold: 0, stone: 0 };
      this._marketPrev = { food: 0, wood: 0, gold: 0, stone: 0 };
      this._marketPrevAt = -99;
    }
    if (this.time - this._marketPrevAt < 2) return this._marketTrend[kind] || 0;
    this._marketPrevAt = this.time;
    for (const k of RES_KEYS) {
      const now = this.marketPrice(k, 100);
      const prev = this._marketPrev[k] || now;
      this._marketTrend[k] = this._marketTrend[k] * 0.5 + ((now - prev) / Math.max(1, prev)) * 0.5;
      this._marketPrev[k] = now;
    }
    return this._marketTrend[kind] || 0;
  }

  marketTrade(team, kind, amount = 100, isBuy = true) {
    const st = this.teams.get(team);
    if (!st) return { ok: false, reason: 'No such team' };
    if (!RES_KEYS.includes(kind)) return { ok: false, reason: 'Unknown good' };
    const market = this.buildings.some((b) => !b.dead && b.team === team && b.type === 'market' && b.buildProgress >= 1);
    if (!market) return { ok: false, reason: 'Build a market first' };
    amount = Math.max(100, Math.round(amount / 100) * 100);
    const price = Math.max(1, Math.round(this.marketPrice(kind, amount) * (isBuy ? 1 : 0.72)));
    if (isBuy) {
      if (st.res.gold < price) return { ok: false, reason: 'Not enough gold' };
      st.res.gold -= price;
      st.res[kind] += amount;
    } else {
      if (kind === 'gold') return { ok: false, reason: 'Cannot sell gold for gold' };
      if (st.res[kind] < amount) return { ok: false, reason: `Need ${amount} ${kind}` };
      st.res[kind] -= amount;
      st.res.gold += price;
    }
    if (team === TEAM_PLAYER) this.sound.play('coin');
    return { ok: true, price, amount };
  }

  findWoundedAlly(unit, range) {
    let best = null, bestFrac = 0.95;
    for (const u of this.units) {
      if (u.dead || u.team !== unit.team || u === unit || u.garrisoned) continue;
      if (u.hp >= u.maxHp) continue;
      const d = dist2(u.x, u.z, unit.x, unit.z);
      if (d > range * range) continue;
      const frac = u.hp / u.maxHp;
      if (frac < bestFrac) { bestFrac = frac; best = u; }
    }
    return best;
  }

  convertUnit(unit, team) {
    const old = unit.team;
    unit.team = team;
    unit.state = STATE.IDLE;
    unit.target = null;
    unit.gatherTarget = null;
    unit.carry.amount = 0;
    this.teams.get(team).popUsed++;
    if (unit.def.pop) this.teams.get(old).popUsed = Math.max(0, this.teams.get(old).popUsed - unit.def.pop);
    this.fx.glowPulse(unit.x, unit.y + 1, unit.z, 0.9, 0.7, 1);
    this.sound.play('convert', unit.x, unit.z);
    if (team === TEAM_PLAYER) this.notify('Enemy converted to your cause', 'good');
    else if (old === TEAM_PLAYER) this.notify('A unit was converted by the enemy!', 'bad');
    this.onEvent('convert', { unit });
  }

  garrisonUnit(unit, building) {
    if (!building || building.dead) return false;
    if (building.team !== unit.team) return false;
    if (!building.def.garrison || building.garrison.length >= building.def.garrison) return false;
    building.garrisonUnit(unit);
    this.spatial.clear();
    this.spatial.insertAll(this.units);
    this.selectedRemove?.(unit);
    if (unit.team === TEAM_PLAYER) this.notify(`${unit.name} garrisoned`, 'info');
    return true;
  }

  removeFromGarrison(unit) {
    const b = unit.garrisonTarget;
    if (b) {
      const i = b.garrison.indexOf(unit);
      if (i >= 0) b.garrison.splice(i, 1);
    }
    unit.garrisoned = false;
    unit.garrisonTarget = null;
    unit.x = (b ? b.x : unit.x) + (Math.random() - 0.5) * 4;
    unit.z = (b ? b.z : unit.z) + (Math.random() - 0.5) * 4;
    unit.state = STATE.IDLE;
  }

  alertAttacked(entity, attacker) {
    if (entity.team === TEAM_PLAYER && this.time - (this._lastAlert || -99) > 6) {
      this._lastAlert = this.time;
      this.notify('Your forces are under attack!', 'bad');
      if (this.onAlarm) this.onAlarm(entity);
    }
    // pull nearby idle defenders in
    if (entity.kind === 'unit' && entity.state === STATE.IDLE) {
      if (attacker && !attacker.dead && entity.def.attack > 0) {
        entity.target = attacker;
        entity.state = STATE.ATTACK;
      }
    }
  }

  onUnitKilled(unit, attacker) {
    const st = this.teams.get(unit.team);
    if (st) st.losses++;
    const killer = attacker && attacker.team !== undefined ? this.teams.get(attacker.team) : null;
    if (killer) {
      killer.kills++;
      // every fallen enemy is a small offering to the court
      killer.favor = Math.min(400, killer.favor + 0.6);
    }
    unit.deadT = 0;
    this.deadUnits.push(unit);
    this.popDirty = true;
    this.sound.play('death', unit.x, unit.z);
    if (unit.team === TEAM_PLAYER) {
      this.selectedRemove?.(unit);
      if (unit.isKing) this.endGame(false, 'king');
    }
    if (unit.team === TEAM_ENEMY && unit.isKing) this.endGame(true, 'king');
    this.onEvent('death', { unit });
  }

  onBuildingKilled(building, attacker) {
    this.markBuildingFootprint(building, false);
    this.buildingSpatialDirty = true;
    this.popDirty = true;
    this.sound.play('collapse', building.x, building.z);
    if (building.team === TEAM_PLAYER) {
      this.notify(`${building.name} destroyed`, 'bad');
      if (building.def.ageAdvance && !this.buildings.some((b) => !b.dead && b.team === TEAM_PLAYER && b.def.ageAdvance)) {
        // last town centre: do not instantly end, but warn
        this.notify('You have no Town Centre left!', 'bad');
      }
    }
    if (building.def.wonder && building.buildProgress >= 1) this.wonderProgress = 0;
    this.onEvent('buildingDeath', { building });
  }

  onBuildingComplete(building) {
    this.popDirty = true;
    if (building.team === TEAM_PLAYER) {
      this.notify(`${building.name} complete`, 'good');
      this.sound.play('complete', building.x, building.z);
    }
    this.onEvent('built', { building });
  }

  onUnitTrained(building, type) {
    if (building.team === TEAM_PLAYER) this.sound.play('trained', building.x, building.z);
  }

  /* ==========================================================
     research / ages
     ========================================================== */
  /* Returns { ok, reason }: the HUD needs to know *why* the crown is dim, and
     it was reading `.ok` off a boolean, so the age card was disabled for the
     whole match and no player could ever advance an age from the UI. */
  canAdvanceAge(team) {
    const st = this.teams.get(team);
    if (!st) return { ok: false, reason: 'No such team' };
    if (st.ageResearch) return { ok: false, reason: 'Already advancing' };
    if (st.age >= 3) return { ok: false, reason: 'Final age' };
    const next = st.age + 1;
    const cost = AGES[next].cost;
    if (!this.canAfford(team, cost)) return { ok: false, reason: 'Not enough resources' };
    const tc = this.buildings.find((b) => !b.dead && b.team === team && b.def.ageAdvance);
    if (!tc) return { ok: false, reason: 'Needs a town centre' };
    return { ok: true, reason: '' };
  }

  startAgeAdvance(team) {
    const st = this.teams.get(team);
    if (st.age >= 3 || st.ageResearch) return false;
    const next = st.age + 1;
    const cost = AGES[next].cost;
    if (!this.canAfford(team, cost)) return false;
    this.spend(team, cost);
    const tc = this.buildings.find((b) => !b.dead && b.team === team && b.def.ageAdvance);
    if (!tc) {
      // refund, cannot advance without a town centre
      for (const k in cost) st.res[k] += cost[k];
      return false;
    }
    st.ageResearch = { next, time: AGES[next].time, total: AGES[next].time, building: tc };
    if (team === TEAM_PLAYER) this.notify(`Advancing to the ${AGES[next].name}…`, 'info');
    return true;
  }

  completeTech(team, techId) {
    const st = this.teams.get(team);
    if (!st) return;
    st.techs.add(techId);
    this.statsVersion++;
    this._costCache.clear();
    this._buildCostCache.clear();
    this.popDirty = true;
    if (techId === 'loom') {
      for (const u of this.units) if (!u.dead && u.team === team && u.type === 'villager') {
        u.maxHp += 15; u.hp += 15;
      }
    }
    if (techId === 'sanctity') {
      for (const u of this.units) if (!u.dead && u.team === team && u.def.classes.includes('monk')) {
        u.maxHp += 30; u.hp += 30;
      }
    }
    this.onEvent('tech', { team, techId });
  }

  /* ==========================================================
     main update
     ========================================================== */
  update(dt) {
    if (!this.running || this.paused || this.gameOver) return;
    dt = Math.min(dt, 0.1) * this.speed;
    this.navTimer -= dt;
    if (this.navDirty && this.navTimer <= 0) { this.refreshNav(); this.navTimer = 0.2; }
    const t0 = performance.now();
    this.time += dt;
    this.frame++;

    // bound the cost of a pathological tick: at most N fresh searches
    this.pathFinder.budget = 10;
    // rebuild the unit hash once per tick
    this.spatial.clear();
    this.spatial.insertAll(this.units);
    if (this.buildingSpatialDirty || this.frame % 20 === 0) {
      this.buildingSpatial.clear();
      for (const b of this.buildings) if (!b.dead) this.buildingSpatial.insert(b);
      this.buildingSpatialDirty = false;
    }

    // units
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const px = u.x, pz = u.z;
      u.update(dt);
      u.vx = (u.x - px) / dt;
      u.vz = (u.z - pz) / dt;
    }
    // buildings
    const buildings = this.buildings;
    for (let i = 0; i < buildings.length; i++) buildings[i].update(dt);
    // resources (herds wander, farms tick)
    const res = this.resources;
    for (let i = 0; i < res.length; i++) if (!res[i].dead) res[i].update(dt);

    this.projectiles.update(dt, this);

    // time of day (drives the renderer's sun, the HUD clock and unit vision)
    const prevPhase = this.dayPhase;
    this.worldTime = (this.worldTime + (dt * 24) / this.dayLength) % 24;
    const phase = this.dayPhase;
    if (phase !== prevPhase) {
      this.phaseChanged = true;
      this.onEvent('phase', { phase, prev: prevPhase, hour: this.worldTime });
    }

    // favour and temporary decree buffs
    for (const team of [TEAM_PLAYER, TEAM_ENEMY]) {
      const st = this.teams.get(team);
      if (!st) continue;
      // favour trickles in; shrines and monasteries speed it up, kills top it up
      let rate = 0.5 + st.age * 0.18;
      for (const b of this.buildings) {
        if (b.dead || b.team !== team) continue;
        if (b.type === 'outpost_shrine') rate += 0.35;
        else if (b.type === 'monastery') rate += 0.25;
      }
      st.favor = Math.min(400, st.favor + rate * dt);
      if (st.buffs.length) {
        for (let i = st.buffs.length - 1; i >= 0; i--) {
          const bf = st.buffs[i];
          bf.time -= dt;
          if (bf.time <= 0) {
            st.buffs.splice(i, 1);
            if (team === TEAM_PLAYER) this.notify(`${bf.name} has ended`, 'info');
          }
        }
        this.statsVersion++;
      }
    }

    // age research
    for (const team of [TEAM_PLAYER, TEAM_ENEMY]) {
      const st = this.teams.get(team);
      if (!st) continue;
      if (st.ageResearch) {
        st.ageResearch.time -= dt * (team === TEAM_PLAYER ? 1 : this.aiSpeed);
        if (st.ageResearch.time <= 0) {
          st.age = st.ageResearch.next;
          this.statsVersion++;
          const names = AGES[st.age];
          st.ageResearch = null;
          this.popDirty = true;
          if (team === TEAM_PLAYER) {
            this.notify(`You have reached the ${names.name}`, 'good');
            this.sound.play('ageUp');
            this.fx.glowPulse(this.playerBase.x, this.heightAt(this.playerBase.x, this.playerBase.z) + 1, this.playerBase.z, 1, 0.9, 0.6);
          }
          this.onEvent('age', { team, age: st.age });
        }
      }
    }

    // compaction (cheap, only when needed)
    if (this.frame % 45 === 0) {
      this.compact();
    }
    if (this.popDirty || this.frame % 30 === 0) this.recomputePop();

    // vision
    this.fowTimer -= dt;
    if (this.fowTimer <= 0) {
      this.fowTimer = 0.18;
      this.updateFog(dt);
    }

    // command markers (rings that fade out where you tapped)
    const gm = this.groundMarkers;
    if (gm.length) {
      for (let i = gm.length - 1; i >= 0; i--) {
        const m = gm[i];
        m.t += dt;
        if (m.t >= m.life) gm.splice(i, 1);
      }
    }

    // victory check
    if (this.frame % 22 === 0) this.checkVictory();
    if (this.mode === 'wonder' && this.wonderProgress > 0) {
      if (this.wonderProgress >= 200 && !this.gameOver) this.endGame(true, 'wonder');
    }

    this.stats.tickMs = this.stats.tickMs * 0.9 + (performance.now() - t0) * 0.1;
    this.stats.units = this.units.length;
    this.stats.buildings = this.buildings.length;
  }

  compact() {
    const aliveUnits = [];
    for (const u of this.units) {
      if (u.dead) {
        if (u.deadT > 2.4) continue;      // give the death animation time
        aliveUnits.push(u);
      } else aliveUnits.push(u);
    }
    // remove fully faded corpses
    this.units = this.units.filter((u) => !u.dead || u.deadT <= 2.4);
    this.buildings = this.buildings.filter((b) => !b.dead || b.deadT < 6);
    this.resources = this.resources.filter((r) => !r.dead || r.deadT < 3);
    // selection cleanup
    if (this.selection.length) this.selection = this.selection.filter((e) => !e.dead);
  }

  /* The starting valley is known ground, not a circle of torchlight. A fresh
     match used to reveal a ~22 m disc, which read as a spotlight parked on a
     dark field; the settlement has been here for years, so its people know the
     near country. The edge is noisy and irregular, and it stops well short of
     the enemy base -- exploring is still the opening move. 68 m also keeps
     the boundary off-screen at the default camera distance, so the town does
     not sit inside a visible lit ellipse. */
  surveyHome(base) {
    const fow = this.fow;
    const size = WORLD.fowCell;
    const half = WORLD.half;
    for (let cz = 0; cz < FOW; cz++) {
      for (let cx = 0; cx < FOW; cx++) {
        const wx = (cx + 0.5) * size - half;
        const wz = (cz + 0.5) * size - half;
        const dx = wx - base.x, dz = wz - base.z;
        const d = Math.hypot(dx, dz);
        const a = Math.atan2(dz, dx);
        // three cheap harmonics: a ragged, organic edge, identical every match
        const wob = Math.sin(a * 3.1 + 1.7) * 5.5 + Math.sin(a * 7.3 - 0.4) * 3.2
          + Math.sin(a * 13.7 + 2.2) * 1.8;
        if (d < 68 + wob * 1.4) fow[cz * FOW + cx] = 1;
      }
    }
  }

  /* ==========================================================
     vision
     ========================================================== */
  updateFog(dt) {
    const fow = this.fow;
    const size = WORLD.fowCell;
    const half = WORLD.half;
    // decay visible -> explored
    for (let i = 0; i < fow.length; i++) if (fow[i] === 2) fow[i] = 1;
    const stamp = (x, z, radius) => {
      const r2 = radius * radius;
      const cx0 = Math.max(0, Math.floor((x - radius + half) / size));
      const cx1 = Math.min(FOW - 1, Math.floor((x + radius + half) / size));
      const cz0 = Math.max(0, Math.floor((z - radius + half) / size));
      const cz1 = Math.min(FOW - 1, Math.floor((z + radius + half) / size));
      for (let cz = cz0; cz <= cz1; cz++) {
        const wz = (cz + 0.5) * size - half;
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx = (cx + 0.5) * size - half;
          if (dist2(wx, wz, x, z) <= r2) fow[cz * FOW + cx] = 2;
        }
      }
    };
    const units = this.units;
    const sightMul = this.sightDayMul;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.team !== TEAM_PLAYER) continue;
      if (u.garrisoned) continue;
      stamp(u.x, u.z, (u.def.sight || 9) * sightMul);
    }
    const buildings = this.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b.dead) continue;
      if (b.team === TEAM_PLAYER || b.team === TEAM_NEUTRAL) stamp(b.x, b.z, (b.def.sight || 8) * (b.buildProgress >= 1 ? 1 : 0.5));
    }
    this.fowDirty = true;
    this.fowTimer = 0.18;
  }

  isVisible(x, z) {
    const cx = Math.floor((x + WORLD.half) / WORLD.fowCell);
    const cz = Math.floor((z + WORLD.half) / WORLD.fowCell);
    if (cx < 0 || cz < 0 || cx >= FOW || cz >= FOW) return false;
    return this.fow[cz * FOW + cx] === 2;
  }
  isExplored(x, z) {
    const cx = Math.floor((x + WORLD.half) / WORLD.fowCell);
    const cz = Math.floor((z + WORLD.half) / WORLD.fowCell);
    if (cx < 0 || cz < 0 || cx >= FOW || cz >= FOW) return false;
    return this.fow[cz * FOW + cx] > 0;
  }

  /* ==========================================================
     victory
     ========================================================== */
  checkVictory() {
    if (this.gameOver || this.mode === 'sandbox') return;
    const enemyAlive = this.buildings.some((b) => !b.dead && b.team === TEAM_ENEMY) || this.units.some((u) => !u.dead && u.team === TEAM_ENEMY);
    const playerAlive = this.buildings.some((b) => !b.dead && b.team === TEAM_PLAYER) || this.units.some((u) => !u.dead && u.team === TEAM_PLAYER);
    if (!enemyAlive) { this.endGame(true, 'conquest'); return; }
    if (!playerAlive) { this.endGame(false, 'conquest'); return; }

    // Dominance: a team without a single standing building cannot produce,
    // research or house anything, so it is dead even if a lone villager is
    // still hiding in a forest. Without this rule a mirror match could drag
    // on for another ten minutes over one survivor.
    if (!this._roofless) this._roofless = new Map();
    for (const team of [TEAM_PLAYER, TEAM_ENEMY]) {
      const hasBuilding = this.buildings.some((b) => !b.dead && b.team === team);
      if (hasBuilding) { this._roofless.delete(team); continue; }
      const since = this._roofless.get(team) ?? this.time;
      this._roofless.set(team, since);
      const grace = this.difficultyKey === 'sandbox' ? Infinity : 60;
      if (this.time - since >= grace) {
        this.endGame(team === TEAM_ENEMY, 'dominance');
        return;
      }
    }
  }

  endGame(win, reason) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.running = false;
    this.result = { win, reason, time: this.time };
    this.onEvent('gameover', this.result);
  }

  /* ==========================================================
     orders (used by selection / input / AI)
     ========================================================== */
  /* ==========================================================
     selection helpers (shared by touch input, minimap and hotkeys)
     ========================================================== */
  setSelection(list) {
    this.selection.length = 0;
    this.selectionSet.clear();
    for (const e of list) {
      if (!e || e.dead) continue;
      if (this.selection.length >= 48) break;
      this.selection.push(e);
      this.selectionSet.add(e);
    }
    return this.selection;
  }
  addToSelection(e) {
    if (!e || e.dead || this.selectionSet.has(e)) return;
    if (this.selection.length >= 48) this.selection.shift();
    this.selection.push(e);
    this.selectionSet.add(e);
  }
  clearSelection() { this.selection.length = 0; this.selectionSet.clear(); }
  selectionOfTeam(team = TEAM_PLAYER) { return this.selection.filter((e) => e.team === team && !e.dead); }
  get selectedUnits() { return this.selection.filter((e) => e.kind === 'unit'); }
  get selectedBuildings() { return this.selection.filter((e) => e.kind === 'building'); }

  /** Add a fading ground ring. */
  marker(x, z, opts = {}) {
    const m = this.groundMarkers;
    if (m.length > 24) m.shift();
    m.push({
      x, z, y: opts.y !== undefined ? opts.y : this.heightAt(x, z),
      r: opts.r || 1.4, life: opts.life || 0.75, t: 0,
      kind: opts.kind || 1,
      r0: opts.r0 ?? 0.55, g0: opts.g0 ?? 0.95, b0: opts.b0 ?? 0.7
    });
  }

  notify(text, kind = 'info') {
    this.notifyQueue.push({ text, kind, t: this.time });
    if (this.notifyQueue.length > 6) this.notifyQueue.shift();
    if (this.onNotify) this.onNotify(text, kind);
  }

  orderMove(units, x, z, formation = true) {
    const movable = units.filter((u) => !u.dead && !u.garrisoned && u.kind === 'unit');
    if (!movable.length) return;
    if (!formation || movable.length === 1) {
      for (const u of movable) {
        u.state = STATE.MOVE;
        u.target = null;
        u.gatherTarget = null;
        u.buildTarget = null;
        u.repairTarget = null;
        u.formationSlot = null;
        u.moveTo(x, z, true);
      }
      return;
    }
    const slots = formationSlots(movable.length, x, z);
    // sort so the nearest units take the nearest slots
    movable.sort((a, b) => dist2(a.x, a.z, x, z) - dist2(b.x, b.z, x, z));
    for (let i = 0; i < movable.length; i++) {
      const u = movable[i];
      const s = slots[i];
      u.state = STATE.MOVE;
      u.target = null;
      u.gatherTarget = null;
      u.buildTarget = null;
      u.formationSlot = s;
      u.moveTo(s[0], s[1], true);
    }
  }

  orderAttack(units, target) {
    for (const u of units) {
      if (u.dead || u.garrisoned || u.kind !== 'unit' || !u.def.attack) continue;
      u.target = target;
      u.state = STATE.ATTACK;
      u.gatherTarget = null;
      u.buildTarget = null;
    }
  }

  orderAttackMove(units, x, z) {
    for (const u of units) {
      if (u.dead || u.garrisoned || u.kind !== 'unit') continue;
      u.state = STATE.ATTACK_MOVE;
      u.target = null;
      u.moveTo(x, z, true);
    }
  }

  orderStop(units) {
    for (const u of units) if (!u.dead && u.kind === 'unit') u.stop();
  }

  orderGather(units, node) {
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      if (u.carry.kind && u.carry.kind !== node.resKind) {
        if (u.carry.amount > 0.01) u.returnResources();
        else { u.carry.kind = null; u.carry.amount = 0; }
      }
      u.gatherTarget = node;
      u.lastGatherKind = node.resKind;
      u.state = STATE.GATHER;
      u.buildTarget = null;
      u.target = null;
      u.moveTo(node.x, node.z, true);
    }
  }

  orderBuild(units, building) {
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      u.buildTarget = building;
      u.state = STATE.BUILD;
      u.gatherTarget = null;
      u.target = null;
      u.moveTo(building.x, building.z, true);
    }
  }

  orderRepair(units, building) {
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      u.repairTarget = building;
      u.state = STATE.REPAIR;
      u.moveTo(building.x, building.z, true);
    }
  }

  orderHeal(units, target) {
    for (const u of units) {
      if (u.dead || !u.def.classes.includes('monk')) continue;
      u.target = target;
      u.state = STATE.HEAL;
      u.moveTo(target.x, target.z, true);
    }
  }

  orderConvert(units, target) {
    for (const u of units) {
      if (u.dead || !u.def.classes.includes('monk')) continue;
      u.convertTarget = target;
      u.convertProgress = 0;
      u.state = STATE.CONVERT;
      u.moveTo(target.x, target.z, true);
    }
  }

  orderGarrison(units, building) {
    for (const u of units) {
      if (u.dead || u.garrisoned) continue;
      u.garrisonTarget = building;
      u.state = STATE.GARRISON;
      u.moveTo(building.x, building.z, true);
    }
  }

  orderPatrol(units, x, z) {
    for (const u of units) {
      if (u.dead || u.kind !== 'unit') continue;
      u.patrolPoints = [[u.x, u.z], [x, z]];
      u.patrolIdx = 1;
      u.state = STATE.PATROL;
      u.moveTo(x, z, true);
    }
  }

  /** Place a building foundation. */
  placeBuilding(type, team, x, z, opts = {}) {
    const def = BUILDING_DEFS[type];
    const st = this.teams.get(team);
    const cost = this.buildingCost(type, team);
    if (!this.canAfford(team, cost)) {
      if (team === TEAM_PLAYER) this.notify('Not enough resources', 'bad');
      return null;
    }
    if (this.ageOf(team) < (opts.ageRequired ?? 0)) return null;
    if (!opts.free) this.spend(team, cost);
    const b = new Building(this, type, team, x, z, opts.instant);
    b.facing = opts.facing ?? (Math.atan2(-x, -z));
    this.addBuilding(b);
    if (opts.instant) this.onBuildingComplete(b);
    this.onEvent('place', { building: b });
    return b;
  }

  /** Is a building ghost position legal? */
  canPlaceAt(type, team, x, z) {
    const def = BUILDING_DEFS[type];
    const half = (def.size || 3) * 0.5;
    if (!this.isInside(x, z)) return { ok: false, reason: 'edge' };
    if (x < -WORLD.half + half || x > WORLD.half - half || z < -WORLD.half + half || z > WORLD.half - half) return { ok: false, reason: 'edge' };
    // must be on reasonably flat land (or water for docks)
    const h = this.heightAt(x, z);
    if (def.water) {
      if (h > -0.4) return { ok: false, reason: 'water' };
    } else {
      if (h < 0.1) return { ok: false, reason: 'water' };
      if (this.world.height.slope(x, z) > 0.55) return { ok: false, reason: 'slope' };
    }
    // no overlap with buildings / resources / units (walls are exempt-ish)
    for (const b of this.buildings) {
      if (b.dead) continue;
      const bh = (b.def.size || 3) * 0.5;
      if (Math.abs(b.x - x) < bh + half - 0.25 && Math.abs(b.z - z) < bh + half - 0.25) return { ok: false, reason: 'blocked' };
    }
    if (!def.wall) {
      const near = this.resourceSpatial.query(x, z, half + 4);
      for (let i = 0; i < near.length; i++) {
        const r = near[i];
        if (r.dead) continue;
        if (dist2(r.x, r.z, x, z) < (half + r.radius * r.scale + 0.4) ** 2) return { ok: false, reason: 'resource' };
      }
    }
    return { ok: true, reason: '' };
  }

  /** Everything the HUD needs about a selection. */
  getTeamSummary(team) {
    const st = this.teams.get(team);
    return {
      res: st.res, age: st.age, ageName: AGES[st.age].name,
      popUsed: st.popUsed, popCap: st.popCap,
      ageResearch: st.ageResearch ? 1 - st.ageResearch.time / st.ageResearch.total : 0,
      ageResearchLeft: st.ageResearch ? st.ageResearch.time : 0,
      ageNext: st.age < 3 ? st.age + 1 : -1
    };
  }
}

/* ============================================================
   formation helper — a soft block in front of the click point
   ============================================================ */
const _slotX = new Float32Array(256);
const _slotZ = new Float32Array(256);
export function formationSlots(count, cx, cz) {
  const out = [];
  const perRow = Math.min(7, Math.ceil(Math.sqrt(count * 1.35)));
  const spacing = 1.5;
  const rows = Math.ceil(count / perRow);
  for (let i = 0; i < count; i++) {
    const row = (i / perRow) | 0;
    const col = i % perRow;
    const rowCount = Math.min(perRow, count - row * perRow);
    const x = (col - (rowCount - 1) / 2) * spacing;
    const z = (row - (rows - 1) / 2) * spacing;
    out.push([cx + x, cz + z]);
  }
  return out;
}

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {}
};
const NULL_SOUND = { play() {} };
