/* ============================================================
   game.js — the match
   Owns every unit, building and resource node; resolves economy,
   production, combat, vision and victory. Written to be stepping
   friendly: one call to update(dt) advances everything by dt.
   ============================================================ */
import { Court } from './court.js';
import { Veterancy } from './veterancy.js';
import { Morale } from './morale.js';
import { Calendar } from './calendar.js';
import { Realm, freshRealmState, TEAM_REBEL_P, TEAM_REBEL_E, crownOfRebel } from './realm.js';
import { Climate } from './climate.js';
import { Elites } from './elites.js';
import { Squads } from './squads.js';
import { Champions } from './champion.js';
import { Guards } from './guards.js';
import {
  UNIT_DEFS, BUILDING_DEFS, TECH_DEFS, AGES, CIVS, DIFFICULTY, GAME_MODES,
  RES, POP_CAP, isUniqueUnit, VICTORIES, victoryFor, PARTY_NAME
} from './data.js';
import { Unit, Building, ResourceNode, STATE } from './entities.js';
import { PathFinder } from './pathfind.js';
import { SpatialHash } from './spatial.js';
import { ProjectilePool } from './projectiles.js';
import { WORLD } from './worldgen.js';
import { clamp, lerp, dist2, mulberry32 } from '../core/math.js';

export const TEAM_NEUTRAL = 0;
export const TEAM_PLAYER = 1;
export const TEAM_ENEMY = 2;

const RES_KEYS = ['food', 'wood', 'gold', 'stone'];
const FOW = WORLD.fowCells;


export class Game {
  constructor(opts) {
    /* One seeded stream for the whole simulation. Every random decision in the
       sim -- a retry timer, an AI's wave timing, a unit's spawn facing -- draws
       from it, so a match with a given seed and a given set of orders plays out
       identically every time. That is what makes a bug report reproducible, and
       it is a free replay feature. The renderer and the FX keep Math.random:
       they are not part of the world's state. */
    const seed = opts.seed !== undefined ? opts.seed : (opts.rand && opts.rand.seed) || 12345;
    this.rng = typeof opts.rand === 'function' && opts.rand !== Math.random
      ? opts.rand
      : mulberry32((seed ^ 0x9e3779b9) >>> 0);
    /* ids are per-game so that replays and save round-trips line up */
    this.seed = seed >>> 0;
    this._idCounter = 1;
    this.world = opts.world;
    this.playerBase = opts.world.playerBase;
    this.enemyBase = opts.world.enemyBase;
    this.civ = opts.civ || 'franks';
    this.enemyCiv = opts.enemyCiv || this.pickEnemyCiv(this.civ);
    this.mode = opts.mode || 'campaign';
    /* The terms of war are chosen before the match and can override what the
       mode implies: a War of Crowns can be fought for conquest, for kings,
       for a wonder, or to the clock. */
    this.victory = VICTORIES[opts.victory] ? opts.victory : victoryFor(this.mode);
    this.supremacyClock = Math.max(120, opts.matchMinutes ? opts.matchMinutes * 60 : 1500);
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
    /* Mod sessions attach a host here. Every hook below is a single null check
       when the field is empty, so a normal campaign pays nothing for the mod
       system existing. See src/mods/. */
    this.modHost = null;
    /* the campaign's long game: four offices, each held by a body on the map */
    this.court = new Court(this);
    this.veterancy = new Veterancy(this);
    this.squads = new Squads(this);
    this.guards = new Guards(this);
    /* The person you personally command. One record per unit, created the
       first time you step into that body; perks and renown live on the unit
       so every existing system (saves, HUD, damage, economy) already knows
       how to carry them. */
    this.champions = new Champions(this);
    this.directControl = null;
    /* the other half of experience: not what a man has done, but how long he
       has kept doing it. See src/sim/elites.js */
    this.elites = new Elites(this);
    this.morale = new Morale(this);
    this.calendar = new Calendar(this);
    /* The Crown's Standing. Two estates with books, and two ways for a
       realm to break. See src/sim/realm.js -- it owns its own state so a
       normal match pays one update call for the whole system. */
    this.realm = new Realm(this);
    /* The slow sky: an era clock measured in tens of minutes that changes
       the rules underneath the seasons. See src/sim/climate.js. */
    this.climate = new Climate(this);
    /* Rebel warbands answer exactly one crown; everyone else is a stranger
       to them until they are attacked. This map remembers who drew blood. */
    this.rebelGrudge = new Map();
    this.courtArmed = null;

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
    /* Nav layers, from the bottom up:
         terrain  -- water, cliffs, whatever the island generator decided
         build    -- buildings and walls (block everyone)
         gate     -- gates (block *enemies* only; allies walk through)
       Everyone shares `navFinal`; enemies search a second combined grid with
       the gate layer folded in. Two 65 kB grids is a cheap price for gates
       that mean what their description says. */
    this.navTerrain = this.world.nav.blocked;
    this.navBuild = new Uint8Array(this.navTerrain.length);
    this.navGate = new Uint8Array(this.navTerrain.length);
    this.navCarve = new Uint8Array(this.navTerrain.length);
    this.navFinal = new Uint8Array(this.navTerrain.length);
    this.navFinalEnemy = new Uint8Array(this.navTerrain.length);
    this.navFinal.set(this.navTerrain);
    this.navFinalEnemy.set(this.navTerrain);
    this.navDirty = false;
    this.navTimer = 0;
    this.pathFinder.setGrid(this.navFinal, WORLD.half);
    this.pathFinderEnemy = new PathFinder(this.world.nav.cells, this.world.nav.cell, WORLD.half);
    /* both grids string-pull against the *continuous* world, not just cells */
    const fine = (a, b, c, d) => this.segmentBlocked(a, b, c, d);
    this.pathFinder.lineBlocked = fine;
    this.pathFinderEnemy.lineBlocked = fine;
    this.pathFinderEnemy.setGrid(this.navFinalEnemy, WORLD.half);
    /* --- gates, for any number of kingdoms ---
       A gate opens for its owner and closes on everybody else. With two
       sides that was a pair of grids; with four kingdoms and rebels it
       needs one grid per team. They are built lazily (a team only pays
       when it first asks), and a map with no gates at all -- the common
       case -- never builds one. */
    /* Cells a building touches, plus a one-cell ring around it.
       `stepMovement` skips the exact passability test while a man stays
       inside one cell -- the cell he stands in is his proof. That proof is
       sound in open ground and unsound beside a wall: a 2 m cell can hold
       half a building, and a man who creeps into that half can wedge himself
       solid. This counter marks the cells where the shortcut is not allowed,
       so the honest geometric test runs exactly where geometry is subtle --
       around walls, houses and gates -- and nowhere else. A count, not a
       flag, because two huts may share a ring cell. */
    this.navHaz = new Uint8Array(this.navTerrain.length);
    /* Which blocked cells are *wall* cells. A house edge cuts a cell without
       claiming it (the grid stamps by centre containment), so a man standing
       in the sliver of a house is on open ground as far as the grid is
       concerned -- the body test catches him. A wall is 2 m on a 2 m grid and
       claims exactly the cell it stands in, but isPassable() ignores walls
       (they are a grid feature, not a geometric one), so the cell test is the
       only thing that can catch a man inside a wall. The stray rescue and the
       crash-test both have to ask the union of the two questions, and this
       layer is what lets them. */
    this.navWall = new Uint8Array(this.navTerrain.length);
    this.navGateTeam = new Int16Array(this.navTerrain.length);   // 0 = no gate, else owner
    this.navGateCount = 0;
    this._teamPf = new Map();          // team -> { pf, grid }
    this._teamPfDirty = true;

    this.teams = new Map();
    /* Every kingdom in the match. Two by default; kingdoms mode adds more,
       and rebel warbands are allocated from TEAM_REBEL_P upwards. */
    /* A War of Crowns seats three or four kingdoms on one island; every other
       mode is the classic duel. `kingdoms` is the number of *crowns*. */
    /* A sandbox seats two: the player, and the Free Company -- a third party
       that is not at war with anybody until somebody makes it one. */
    const crowns = this.mode === 'kingdoms' ? Math.max(2, Math.min(4, opts.kingdoms | 0 || 3))
      : (this.mode === 'sandbox' ? 2 : 2);
    this.crowns = crowns;
    this.partyTeam = this.mode === 'sandbox' ? TEAM_ENEMY : null;
    this.partyName = PARTY_NAME;
    /* teams that have not raised a hand: see canFight() below. A party leaves
       this set for good the first time blood is drawn. */
    this.peace = new Set(this.partyTeam ? [this.partyTeam] : []);
    this.teamIds = [];
    for (let t = TEAM_PLAYER; t < TEAM_PLAYER + crowns; t++) this.teamIds.push(t);
    for (const t of this.teamIds) {
      this.teams.set(t, {
        civ: this.civForTeam(t),
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
        buffs: [],           // { kind, mul, time, name }
        resigned: false
      });
    }
    /* one ledger per crown, in team order (the roster is known by now) */
    for (const t of this.teamIds) this.realm.teams.set(t, freshRealmState());

    // fog of war (player vision only; the AI plays fair with its own grid)
    this.fow = new Uint8Array(FOW * FOW);        // 0 hidden, 1 explored, 2 visible
    this.fowStamp = 0;                           // bumped whenever the mask changes
    this.fowDirty = true;
    this.fowTimer = 0;
    this.fowTextureData = null;

    this.selection = [];
    this.selectionSet = new Set();
    this.groups = new Map();                 // control groups 0..9
    this.groundMarkers = [];                 // tap/command feedback rings
    this.placing = null;                     // {type,x,z,y,facing,valid,footprint}
    this.formationStyle = 'box';             // box | line | wedge | column
    this.settings = { fog: true, bars: true, grid: false, shake: true };
    this.showFog = true;
    this.camera = null;                      // set by the app layer
    this.renderStats = null;
    this.notifyQueue = [];
    /* Wonder Race clock per team. v2 kept a single scalar that was written by
       the *building* update and never reset when the wonder fell, so the mode
       was a one-way trip to a victory screen -- and it fired in every other
       mode too. One clock per team, only in wonder mode, reset by any damage
       to the wonder. */
    this.wonderClocks = new Map();
    this.wonderHold = 200;
    this.elapsed = 0;
    this.worldTime = 8.6;              // hour of the day, advanced by update()
    /* One full day-night cycle is 15 real minutes: ten minutes of sun and
       five of dark. The two halves do not share a clock rate -- the dark
       passes 1.2x faster per in-game hour, which is what makes 15 daylight
       hours take 600 s and 9 night hours take 300 s. A match is meant to
       live through several days, and the night has to be long enough to
       matter for a raid without eating a third of the session. */
    this.dayLength = 960;             // real seconds for a full cycle at the neutral rate
    this.nightRateMul = 1.2;          // in-game hours per real second, dark vs light
    this.alerts = [];
    this.unitLimit = 220;
    this.stats = { tickMs: 0, units: 0, buildings: 0 };
    this.fx = opts.fx || NULL_FX;
    this.sound = opts.sound || NULL_SOUND;
    this.onEvent = opts.onEvent || (() => {});
    this.initialised = false;
    this.heightAt = (x, z) => this.world.height.sample(x, z);
    this.statsVersion = 1;          // bump to invalidate cached unit stats
    this._costCache = new Map();
    this._buildCostCache = new Map();
  }

  nextId() {
    return this._idCounter++;
  }

  /** Keep issuing fresh ids after a save is loaded. */
  syncIdCounter() {
    let max = 0;
    for (const u of this.units) if (u.id > max) max = u.id;
    for (const b of this.buildings) if (b.id > max) max = b.id;
    for (const r of this.resources) if (r.id > max) max = r.id;
    this._idCounter = max + 1;
  }

  pickEnemyCiv(civ) {
    const keys = Object.keys(CIVS).filter((k) => k !== civ);
    return keys[(this.rng() * keys.length) | 0];
  }

  /** A distinct civilisation for every crown on the island. */
  civForTeam(team) {
    if (!this._civByTeam) {
      this._civByTeam = new Map();
      this._civByTeam.set(TEAM_PLAYER, this.civ);
      const pool = Object.keys(CIVS).filter((k) => k !== this.civ);
      /* deterministic shuffle from the game seed, never the live sim stream */
      let s = (this.seed ^ 0x1b873593) >>> 0;
      const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = (next() * (i + 1)) | 0;
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      for (let t = TEAM_ENEMY; t < TEAM_PLAYER + this.crowns; t++) {
        this._civByTeam.set(t, pool[(t - TEAM_ENEMY) % pool.length]);
      }
    }
    return this._civByTeam.get(team) || this.enemyCiv;
  }

  /** The seat of a kingdom on the map. */
  baseOf(team) {
    const bases = this.world.bases;
    if (!bases || !bases.length) return team === TEAM_ENEMY ? this.enemyBase : this.playerBase;
    const i = team - TEAM_PLAYER;
    return bases[Math.min(bases.length - 1, Math.max(0, i))] || this.playerBase;
  }

  /** Every other living crown, nearest seat first. */
  rivalSeats(team, x, z) {
    const out = [];
    for (const t of this.teamIds) {
      if (t === team) continue;
      const b = this.baseOf(t);
      if (!b) continue;
      out.push({ team: t, base: b, d: Math.hypot(b.x - (x ?? b.x), b.z - (z ?? b.z)) });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Is this crown still in the war? (A fallen crown is out for good.) */
  aliveTeam(team) {
    if (team === TEAM_NEUTRAL) return true;
    if (this.fallenTeams && this.fallenTeams.has(team)) return false;
    return this.buildings.some((b) => !b.dead && b.team === team) || this.units.some((u) => !u.dead && u.team === team && !u.garrisoned);
  }

  /* ==========================================================
     setup
     ========================================================== */
  start() {
    const w = this.world;
    this.spawnResources();
    for (const t of this.teamIds) this.setupTeam(t, this.baseOf(t), this.civForTeam(t));
    this.fallenTeams = new Set();
    /* the short history of the war: which crown fell, to whom, and when.
       The end screen reads it, so a player who wins a war of four crowns
       can see exactly how the map became theirs. */
    this.chronicle = [];
    /* who last drew blood on whom: the crown that breaks a rival inherits
       it, so the map has to exist before the first blow, not after it */
    this.lastBlood = new Map();
    this.initialised = true;
    this.recomputePop();
    this.surveyHome(w.playerBase);
    this.updateFog(1);
    if (this.calendar) this.calendar.start(true);
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
    /* The Free Company is not scenery: five woodcutters and a market stall
       would be a massacre the day somebody drew a blade. It keeps a watch on
       its own gate, and those men hold their ground until an order or a blow
       tells them otherwise. */
    if (this.mode === 'sandbox' && team === this.partyTeam) {
      const watch = ['spearman', 'spearman', 'archer', 'swordsman'];
      for (let i = 0; i < watch.length; i++) {
        const a = (i / watch.length) * Math.PI * 2 + 0.7;
        const u = this.spawnUnitRaw(watch[i], team, tx + Math.cos(a) * 7.4, tz + Math.sin(a) * 7.4);
        if (u) { u.stance = 'defensive'; u.facing = a + Math.PI; }
      }
    }

    // a scout to explore
    if (team === TEAM_PLAYER && this.mode !== 'sandbox') {
      const s = this.spawnUnitRaw('scout_cavalry', team, tx + 4, tz + 3);
      if (s) s.stance = 'defensive';
    }
    /* Every throne has a man on it. In a regicide match his life IS the war,
       and in a war of crowns he is the crown made flesh -- but he is only a
       knife at your throat under the terms that say so, and a king is not a
       mage: the Mage is one card a kingdom plays, and losing her is not
       losing the kingdom. */
    if (this.victory === 'regicide' || this.crowns > 2) {
      const king = this.spawnUnitRaw('hero_general', team, tx - 4, tz + 2);
      if (king) {
        king.isKing = true;
        king.maxHp = 900;
        king.hp = 900;
        king.name = 'King';
        king.speedMul = 1.05;
        king.kingship = true;
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
        herd: r.herd, team: TEAM_NEUTRAL
      });
      node.scale = r.scale;
      node.herd = !!r.herd;
      /* One height, in one field. v2 mirrored the sampled terrain height into
         both `y` and `yOff`, and the renderer adds the two -- so every tree,
         rock and deer on the island floated at twice its ground height (a
         herd on the 40 m hill hung 40 m in the sky). `yOff` stays for the
         few decor props that really do want a lift above their cell. */
      node.y = r.y;
      node.facing = (i * 2.399) % 6.283;
      this.resources.push(node);
      this.resourceSpatial.insert(node);
    }
    // neutral shrines become capturable buildings
    for (const p of this.world.poi || []) {
      const b = new Building(this, 'outpost_shrine', TEAM_NEUTRAL, p.x, p.z, true);
      b.facing = this.rng() * 6.28;
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
  /**
   * The pathfinder a unit should search with. Gates block everyone except
   * their owner, so a team with no gates shares the fast common grid and a
   * team behind a gate gets its own -- built once per nav change, not per
   * path request.
   */
  pfFor(unit) {
    if (!unit) return this.pathFinder;
    const team = unit.team;
    if (this.navGateCount === 0) return team === TEAM_PLAYER ? this.pathFinder : this.pathFinderEnemy;
    let rec = this._teamPf.get(team);
    if (!rec) {
      const pf = new PathFinder(this.world.nav.cells, this.world.nav.cell, WORLD.half);
      pf.lineBlocked = (a, b, c, d) => this.segmentBlocked(a, b, c, d);
      rec = { pf, grid: new Uint8Array(this.navGateTeam.length), ready: false };
      this._teamPf.set(team, rec);
    }
    if (!rec.ready) {
      const grid = rec.grid;
      grid.set(this.navFinal);
      const owners = this.navGateTeam;
      for (let i = 0; i < grid.length; i++) {
        const o = owners[i];
        if (o && o !== team) grid[i] = 1;
      }
      rec.pf.setGrid(grid, WORLD.half);
      rec.ready = true;
    }
    return rec.pf;
  }

  /** Everything a tick's path searches draw from. One budget per team. */
  beginPathTicks() {
    this.pathFinder.beginTick();
    this.pathFinderEnemy.beginTick();
    for (const rec of this._teamPf.values()) rec.pf.beginTick();
  }
  invalidateTeamNav() {
    this._teamPfDirty = true;
    for (const rec of this._teamPf.values()) rec.ready = false;
  }

  isPassable(x, z, unit) {
    if (!this.isInside(x, z)) return false;
    const h = this.world.height.sample(x, z);
    if (unit && unit.def && unit.def.naval) return h < -0.3;
    if (h < -0.25) return false;
    if (this._steep) {
      /* the baked answer, from the same sample the nav grid used */
      const nc = this.navCell || 2;
      const cx = ((x + this.navHalf) / nc) | 0;
      const cz = ((z + this.navHalf) / nc) | 0;
      if (cx >= 0 && cz >= 0 && cx < this._steep.n && cz < this._steep.n) {
        if (this._steep.g[cz * this._steep.n + cx]) return false;
      }
    } else if (this.world.height.slope(x, z) > 0.95) return false;
    const near = this.buildingSpatial.query(x, z, 5);
    for (let i = 0; i < near.length; i++) {
      const b = near[i];
      /* farms -- and mod traps, which declare themselves walkable for the same
         reason -- are floors, not obstacles */
      if (b.dead || b.wall || (b.def && b.def.walkable)) continue;
      /* a gate opens for its owner's troops, and for nobody else */
      if (b.def.gate && unit && b.team === unit.team) continue;
      const half = (b.def.size || 3) * 0.5 - 0.05 + (unit ? unit.radius * 0.4 : 0.2);
      if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return false;
    }
    return true;
  }

  /**
   * Safety valve: relocate a wedged unit to the nearest walkable spot and let
   * it re-plan. Called rarely, so the cost of the spiral search is irrelevant.
   */
  /**
   * Lift anybody standing inside a blocked nav cell back onto open ground.
   *
   * isPassable() deliberately ignores walls: they are nav obstacles, not
   * physical ones, and that is what keeps a 2 m grid from trapping a soldier.
   * The cost is that a man a wall was raised *over* -- or one a building was
   * dropped on -- does not bounce off and does not stop. He slides about
   * inside the obstacle, jitters a metre either way, and the movement
   * watchdog never fires because he is, technically, moving. A twenty-minute
   * four-crown war produced a villager who carried a load around inside a
   * wall for thirty seconds and then did it again.
   *
   * The sweep is a single array lookup per man per half second, and the
   * rescue itself is a ring search that almost never runs.
   */
  rescueStrays() {
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.garrisoned || !u.def || u.def.naval || !u.def.hp) continue;
      const pf = this.pfFor(u);
      const [cx, cz] = pf.worldToCell(u.x, u.z);
      /* Two ways to be a stray: inside a cell the nav grid calls solid, or
         simply overlapping something solid. The grid stamps buildings by
         which cell their *centre* falls in, so a 2.8 m house whose front
         face cuts a cell is "open ground" to the grid while a man standing
         in that sliver is inside the house. A stray of the second kind
         cannot walk out -- every step away is a step he cannot take -- so he
         is lifted out too, but only after he has been overlapping for a
         moment, so a man brushing past a corner is not flung across the
         yard. */
      const N = this.navN || (this.world.nav && this.world.nav.cells) || 256;
      const wallBad = this.navWall ? this.navWall[cz * N + cx] > 0 : false;
      const bodyBad = !this.isPassable(u.x, u.z, u);
      if (!wallBad && bodyBad) {
        u.overlapN = (u.overlapN || 0) + 1;
        if (u.overlapN < 3) continue;   // ~1 s at the scan cadence
      } else {
        u.overlapN = 0;
      }
      if (!wallBad && !bodyBad) continue;
      const spot = this.freeSpotNear(u.x, u.z, u, 12);
      if (!spot) continue;
      u.x = spot[0];
      u.z = spot[1];
      /* The *order* survives the rescue: clearing destX/destZ as well left a
         man in state `move` with nothing to move to, standing there until the
         match ended. The path is dropped so the next tick plans again from the
         new ground. */
      u.path = null;
      u.pathIdx = 0;
      u.targetPos = null;
      u.repathTimer = 0;
      u.moving = false;
      u._passKey = -1;
      u._wpBlock = 0;
      u.stallT = 0;
      u.stuckScore = 0;
      u.wedgeT = 0;
      u.sealedT = 0;
      u.overlapN = 0;
      this.stats.strays = (this.stats.strays || 0) + 1;
      if (this.fx && this.fx.dust) this.fx.dust(u.x, this.heightAt(u.x, u.z) + 0.1, u.z, 1, 0.5);
    }
  }

  /**
   * The half-width of the square the *pathfinder* refuses around a building.
   *
   * markBuildingFootprint() stamps cells by centre containment with a pad, so
   * the blocked square rounds outward to whole 2 m cells: a 5.8 m hall refuses
   * an 8 m square, a metre beyond its walls on every side. That metre is
   * deliberately walkable -- isPassable() is exact, the grid is only a
   * conservative planner -- but a *path* to it can never be produced, so a
   * melee unit sent at a wall used to stop a metre short and stand there. The
   * last stride into this square is Unit.strideIn()'s job; this is the square.
   */
  navHullHalf(b) {
    const cell = this.world.nav.cell;
    const pad = b.def.wall ? 0.05 : 0.15;
    return Math.ceil(((b.def.size || 3) * 0.5 + pad) / cell) * cell;
  }

  /**
   * The nearest point to (x,z) a unit can actually stand on.
   *
   * Both tests matter. `isPassable` knows about water, cliffs and buildings;
   * the nav grid knows about *walls*, which it stamps as 2 m cells. A point can
   * be clear ground and still sit in a cell the pathfinder refuses -- and a
   * move order to such a point used to produce a one-node path to a place the
   * unit could never walk into. It then stood there, re-pathing to the same
   * impossible spot, for as long as the order stood: the single most common
   * "my army is frozen" report in the fuzzer, and in the real game.
   */
  freeSpotNear(x, z, unit, maxRing = 8) {
    const pf = this.pfFor(unit);
    if (this.isPassable(x, z, unit)) {
      const [cx, cz] = pf.worldToCell(x, z);
      if (!pf.isBlocked(cx, cz)) return [x, z];
    }
    let best = null, bestD = Infinity;
    for (let ring = 1; ring <= maxRing; ring++) {
      const r = ring * 0.85;
      const n = 8 + ring * 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.37;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (!this.isPassable(px, pz, unit)) continue;
        const [cx, cz] = pf.worldToCell(px, pz);
        if (pf.isBlocked(cx, cz)) continue;
        const d = dist2(px, pz, x, z);
        if (d < bestD) { bestD = d; best = [px, pz]; }
      }
      if (best) return best;
    }
    return null;
  }

  unstick(unit) {
    unit._passKey = -1;
    const px = unit.x, pz = unit.z;
    const best = this.freeSpotNear(px, pz, unit, 7);
    /* "the spot you are standing on" is trivially free; accepting it as a
       rescue meant a unit sealed into a pocket by a wall run was "freed" onto
       its own position every few seconds, forever. A rescue has to move him. */
    const moved = !!(best && Math.hypot(best[0] - px, best[1] - pz) > 0.7);
    if (moved) { unit.x = best[0]; unit.z = best[1]; }
    unit.path = null;
    unit.pathIdx = 0;
    unit.targetPos = null;
    unit.wedgeT = 0;
    unit.stallT = 0;
    unit.repathTimer = 0;
    unit._wpBlock = 0;
    return moved;
  }

  /**
   * Cheap straight-walk test used for short, direct movement.
   *
   * It has to consult the nav grid as well as isPassable. isPassable ignores
   * walls on purpose (they are nav obstacles, not physical ones), so a
   * *straight-line* shortcut of a few metres used to walk clean through a
   * palisade -- which made walls decorative and left the enemy inside the
   * village. Sampling the combined grid costs a handful of array lookups per
   * shortcut and closes that hole.
   */
  walkableLine(x0, z0, x1, z1, unit) {
    const dx = x1 - x0, dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) return true;
    const naval = !!(unit && unit.def && unit.def.naval);
    const N = this.world.nav.cells, cell = this.world.nav.cell, half = WORLD.half;
    const grid = naval ? null : this.pfFor(unit).blocked;
    const steps = Math.min(40, Math.ceil(d / 1.6));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + dx * t, pz = z0 + dz * t;
      if (!this.isPassable(px, pz, unit)) return false;
      if (grid) {
        const cx = Math.floor((px + half) / cell), cz = Math.floor((pz + half) / cell);
        if (cx >= 0 && cz >= 0 && cx < N && cz < N && grid[cz * N + cx]) return false;
      }
    }
    return true;
  }

  teamOf(team) { return this.teams.get(team); }
  civOf(team) {
    const t = this.teams.get(team);
    if (t && t.civ) return t.civ;
    return t && t.rebel ? null : this.civ;
  }
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
  /** Population already promised to queued units, across every building. */
  queuedPop(team) {
    let n = 0;
    for (const b of this.buildings) {
      if (b.dead || b.team !== team || !b.queue.length) continue;
      for (const item of b.queue) n += (UNIT_DEFS[item.type]?.pop ?? 1);
    }
    return n;
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
    if (this.court) rate *= this.court.gatherMul(unit, kind);
    if (this.calendar) rate *= this.calendar.gatherMul(kind);
    /* a sullen commons works slowly; a devoted one bends its back */
    if (this.realm) rate *= this.realm.gatherMul(team);
    /* the slow sky: a drought is a food problem, a thaw a wood one */
    if (this.climate) rate *= (kind === 'food' ? this.climate.foodMul() : kind === 'wood' ? this.climate.woodMul() : 1);
    /* a Champion villager works with the hands of someone who chose to be here */
    if (unit.champion && this.champions) rate *= this.champions.gatherMul(unit);
    return rate;
  }

  /** Yield of a newly sown field, before any of it has been harvested. */
  farmYieldBonus(team) {
    let bonus = 0;
    if (this.hasTech(team, 'horse_collar')) bonus += 75;
    if (this.hasTech(team, 'heavy_plow')) bonus += 125;
    return bonus;
  }

  findNearestResource(kind, x, z, maxDist, unit) {
    // Deterministic per-unit jitter spreads a work crew across a whole mine
    // or grove instead of stacking everybody on one node.
    const jitter = unit ? (((unit.id * 2654435761) >>> 0) % 1000) / 1000 : 0.5;
    let best = null, bestScore = maxDist * maxDist;
    let nearest = null, nearestD = maxDist * maxDist;
    const consider = (r, i) => {
      const d = dist2(x, z, r.x, r.z);
      if (d < nearestD) { nearestD = d; nearest = r; }
      const score = d * (0.72 + 0.56 * (((i * 31 + jitter * 997) % 100) / 100));
      if (score < bestScore) { bestScore = score; best = r; }
    };
    for (let i = 0; i < this.resources.length; i++) {
      const r = this.resources[i];
      if (r.dead || r.amount <= 0) continue;
      if (r.resKind !== kind) continue;
      consider(r, i);
    }
    /* Fields are buildings, not scenery, so they live in `buildings` -- but
       they are food, and a villager looking for food has to be able to find
       one. A field still going up is skipped: you cannot harvest a furrow. */
    const buildings = this.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b.dead || !b.def || b.def.resKind !== kind) continue;
      if (b.buildProgress < 0.99 || !(b.amount > 0)) continue;
      consider(b, i + this.resources.length);
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
    if (this.court) this.court.onGather(unit, amount, kind);
    this.onEvent('deposit', { team: unit.team, kind, amount });
  }

  onGather(unit, node, amount) {
    if (this.rng() < 0.25) {
      if (node.resKind === 'wood') this.fx.leaves(node.x, node.y, node.z, 1);
      else if (node.resKind === 'stone' || node.resKind === 'gold') this.fx.sparks(node.x, node.y + 0.4, node.z, 1, [0.9, 0.85, 0.7]);
      else this.fx.dust(node.x, node.y, node.z, 1, 0.6);
    }
    if (this.climate) this.climate.noteGather(node.resKind || node.kind, amount);
  }

  onResourceDepleted(node) {
    if (node.type === 'tree') this.fx.leaves(node.x, node.y + 1, node.z, 5);
    else if (node.type === 'gold_mine' || node.type === 'stone_mine') this.fx.explosion(node.x, node.y + 0.5, node.z, 0.5);
    this.resourcesDirty = true;
  }

  /**
   * A harvested field is resown for a little wood, exactly as its card says.
   *
   * The farmer asks, the treasury pays, the field refills and he carries on --
   * one continuous job instead of a villager who vanishes into "idle" the
   * moment his first field runs out. If the wood is not there the field simply
   * stays bare and he goes looking for other work, which is what a person
   * would do; the explanation is given once per field rather than every time
   * somebody walks past it.
   */
  tryReseedFarm(unit, node) {
    const team = unit.team;
    node.amount = Math.max(0, node.amount || 0);
    unit.gatherTarget = null;
    if (this.canAfford(team, { wood: 60 })) {
      this.spend(team, { wood: 60 });
      node.amount = 280 + this.farmYieldBonus(team);
      node.maxAmount = Math.max(node.maxAmount || 0, node.amount);
      if (node.dead) { node.dead = false; node.deadT = 0; this.resources.push(node); }
      unit.gatherTarget = node;
      unit.lastGatherKind = node.resKind || 'food';
      unit.state = STATE.GATHER;
      if (team === TEAM_PLAYER) this.onEvent('reseed', { farm: node });
      return true;
    }
    unit.state = STATE.IDLE;
    unit.retaskT = 0;
    const now = this.time;
    if (team === TEAM_PLAYER && !(node._seedNotice > now - 45)) {
      node._seedNotice = now;
      this.notify('Not enough wood to reseed the farm', 'bad');
    }
    return false;
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
    /* A sparring partner is not an opponent: in the sandbox the second team
       exists to be drilled against, and a dummy that wanders off to chase a
       woodcutter is not a dummy. It holds its ground until it is ordered. */
    if (this.mode === 'sandbox' && team === this.partyTeam) {
      u.stance = u.type === 'villager' ? 'stand' : 'defensive';
    }
    u.statsCache = null;
    this.units.push(u);
    if (this.elites) this.elites.enrol(u);
    if (this.modHost) this.modHost.onSpawn(u);
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

  /**
   * `opts.force` skips the population gate. A reload is authoritative: the
   * state being restored is the state the match was in, and a save taken while
   * a crown was over its cap (its houses had been burned after the men were
   * trained) used to silently drop soldiers -- a reload could cost an army.
   */
  spawnUnit(type, team, x, z, fromBuilding, opts = {}) {
    const st = this.teams.get(team);
    if (!st) return null;
    this.recomputePop();
    const def = UNIT_DEFS[type];
    if (!opts.force && st.popUsed + (def.pop || 1) > st.popCap) {
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
    /* a levy believes what his village believes */
    if (this.realm && def.attack > 0) u.morale = this.realm.spawnMorale(team);
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

  /**
   * Remove every unit and building *cleanly*: footprints un-marked, spatial
   * hashes emptied, selection cleared. Loading a save used to do
   * `units.length = 0` on the arrays, which left every building's nav
   * footprint counted in navBuild forever -- each load stacked another +1 on
   * the same cells, so after two or three loads the whole town centre was
   * permanently unwalkable and villagers piled up at its edge.
   */
  clearEntities() {
    for (const b of this.buildings) if (!b.dead) this.markBuildingFootprint(b, false);
    this.buildings.length = 0;
    this.units.length = 0;
    this.spatial.clear();
    this.buildingSpatial.clear();
    this.resourceSpatial.clear();
    this.buildingSpatialDirty = true;
    this.navBuild.fill(0);
    this.navGate.fill(0);
    this.navCarve.fill(0);
    this.navFinal.set(this.navTerrain);
    this.navFinalEnemy.set(this.navTerrain);
    this.navDirty = true;
    this.selection.length = 0;
    this.selectionSet.clear();
    this.popDirty = true;
    this.refreshNav();
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
    /* a walkable building never blocks the nav grid: a farm used to stamp four
       cells of solid obstacle into the middle of a field */
    if (b.def.walkable) return;
    const N = this.world.nav.cells;
    const cell = this.world.nav.cell;
    const half = WORLD.half;
    /* Cells are stamped by *centre containment*, not by box overlap.
       Overlap inflated every footprint by up to a full cell in each direction,
       so two wall segments standing 2 m apart (the lattice pitch) shared their
       cells and a 2 m wall claimed a 4 m band -- which is why gates kept
       blocking their own troops and why diagonal walls ate six metres of
       ground. A wall is 2 m on a 2 m grid: it should own exactly one cell. */
    const pad = b.def.wall ? 0.05 : 0.15;
    const s = (b.def.size || 3) * 0.5 + pad;
    const x0 = Math.max(0, Math.floor((b.x - s + half) / cell));
    const x1 = Math.min(N - 1, Math.floor((b.x + s + half) / cell));
    const z0 = Math.max(0, Math.floor((b.z - s + half) / cell));
    const z1 = Math.min(N - 1, Math.floor((b.z + s + half) / cell));
    const delta = blocked ? 1 : -1;
    /* the ring of cells around the footprint: the last metre a man can stand
       in before his next step would put him against the wall */
    {
      const haz = this.navHaz;
      const hs = s + cell;
      const hx0 = Math.max(0, Math.floor((b.x - hs + half) / cell));
      const hx1 = Math.min(N - 1, Math.floor((b.x + hs + half) / cell));
      const hz0 = Math.max(0, Math.floor((b.z - hs + half) / cell));
      const hz1 = Math.min(N - 1, Math.floor((b.z + hs + half) / cell));
      for (let cz = hz0; cz <= hz1; cz++) {
        for (let cx = hx0; cx <= hx1; cx++) {
          const i = cz * N + cx;
          if (blocked) { if (haz[i] < 255) haz[i]++; }
          else if (haz[i]) haz[i]--;
        }
      }
    }
    if (b.def.gate) {
      /* A gate is an obstacle to the enemy and a doorway to its owner. It lives
         in its own layer so allies path straight through; the doors themselves
         are visual (the renderer reads b.gateOpen). It also *carves* its
         doorway out of the build layer: the gate is 2.8 m on a 2 m grid, so
         without a carve its centre cell is a wall cell and the gate blocks its
         own troops. The carve is exactly the gate's own cell. */
      const ng = this.navGate, nfe = this.navFinalEnemy, t2 = this.navTerrain, nb2 = this.navBuild;
      const nc = this.navCarve, nf2 = this.navFinal;
      const carveR = (b.def.size || 2.8) * 0.5 - 0.1;
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const wx = (cx + 0.5) * cell - half, wz = (cz + 0.5) * cell - half;
          const inBox = Math.abs(wx - b.x) <= s && Math.abs(wz - b.z) <= s;
          const inCore = Math.abs(wx - b.x) <= carveR && Math.abs(wz - b.z) <= carveR;
          if (!inBox) continue;
          const i = cz * N + cx;
          const gv = Math.max(0, ng[i] + delta);
          ng[i] = gv;
          /* the ownership layer that per-team pathfinding reads */
          if (blocked) { if (!this.navGateTeam[i]) { this.navGateTeam[i] = b.team; this.navGateCount++; } }
          else if (this.navGateTeam[i] === b.team) { this.navGateTeam[i] = 0; this.navGateCount--; }
          this.invalidateTeamNav();
          const cv = inCore ? Math.max(0, nc[i] + delta) : nc[i];
          nc[i] = cv;
          nf2[i] = (t2[i] || (nb2[i] && !cv)) ? 1 : 0;
          nfe[i] = (t2[i] || nb2[i] || gv) ? 1 : 0;
        }
      }
      this.navDirty = true;
      return;
    }
    const t = this.navTerrain, nb = this.navBuild, nf = this.navFinal;
    const nfe = this.navFinalEnemy, ng = this.navGate, nc = this.navCarve;
    const isWall = b.def.wall ? 1 : 0;
    const nw = this.navWall;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const wx = (cx + 0.5) * cell - half, wz = (cz + 0.5) * cell - half;
        if (Math.abs(wx - b.x) > s || Math.abs(wz - b.z) > s) continue;
        const i = cz * N + cx;
        const v = Math.max(0, nb[i] + delta);
        nb[i] = v;
        if (isWall) nw[i] = blocked ? Math.min(255, nw[i] + 1) : Math.max(0, nw[i] - 1);
        /* Patch the combined grids in place. Recombining all 65 536 cells on
           every house was a 1.2 ms spike for a change that touches ~36. */
        nf[i] = (t[i] || (v && !nc[i])) ? 1 : 0;
        nfe[i] = (t[i] || v || ng[i]) ? 1 : 0;
      }
    }
    this.navDirty = true;
  }

  /** Recombine the nav layers and hand the result to the path finder. */
  /**
   * The continuous, radius-aware answer to "can a body walk this line?".
   * The nav grid is 2 m; buildings are not, so the pathfinder's string-pulling
   * asks this before it cuts a corner (see PathFinder._smooth).
   */
  segmentBlocked(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    if (d < 0.6) return false;
    const probe = { radius: 0.42, def: { naval: false }, kind: 'unit', team: 0 };
    /* Sampling has to be finer than the narrowest thing a man can clip. A
       house corner is a few centimetres of intrusion into a line, so one
       sample per 1.1 m could walk a "clear" straight line through a corner
       -- which is exactly how a soldier ended up oscillating on the face of
       a house for half a minute. One sample per 0.4 m still costs far less
       than a search, and a straight segment is at most a map diagonal. */
    const steps = Math.min(90, Math.ceil(d / 0.4));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isPassable(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, probe)) return true;
    }
    return false;
  }

  refreshNav() {
    this.navDirty = false;
    this.pathFinderEnemy.setGrid(this.navFinalEnemy, WORLD.half);
    this.invalidateTeamNav();
    /* navFinal is already up to date (markBuildingFootprint patches it), so
       this is just a byte copy into the pathfinder + a version bump. A full
       recombine is only needed when the terrain layer itself changes. */
    this.pathFinder.setGrid(this.navFinal, WORLD.half);
  }

  /* ==========================================================
     combat
     ========================================================== */
  /* ==========================================================
     diplomacy
     ----------------------------------------------------------
     Every kingdom is hostile to every other kingdom, and rebels
     are hostile to the one crown they rose against -- plus to
     anybody who draws their blood. That last clause is what keeps
     a revolt from being a free lunch for the player: kick the mob
     and it kicks back.
     ========================================================== */
  /** Has this crown kept its hands to itself so far? */
  atPeace(team) {
    return this.peace.size > 0 && this.peace.has(team);
  }

  /* Two questions, kept apart on purpose.
     `isHostile` is the law of the map: which crowns may be struck. It is true
     between any two crowns, including a party at peace -- so an order the
     player gives is always obeyed.
     `canFight` is what a man does without being told. Nobody of either side
     picks a fight with a party that has not raised a hand: no auto-aim, no
     raiders, no "engage anything hostile in sight". The first blow is a
     decision, and only a decision. */
  canFight(a, b) {
    if (!this.isHostile(a, b)) return false;
    if (this.peace.size === 0) return true;
    return !(this.peace.has(a) || this.peace.has(b));
  }

  /** What a crown is called in a message to the player. */
  teamNameOf(team) {
    if (team === this.partyTeam) return this.partyName;
    return CIVS[this.teams.get(team)?.civ]?.name || (team === TEAM_PLAYER ? 'Your crown' : `Crown ${team}`);
  }

  /** Blood was drawn, and it was not theirs: the party takes up arms. */
  breakPeace(team, by) {
    if (!this.peace.delete(team)) return false;
    this.peaceAnnounced = (this.peaceAnnounced || 0) + 1;
    const theirs = team === this.partyTeam;
    const name = this.teamNameOf ? this.teamNameOf(team) : this.partyName;
    if (theirs) {
      this.notify(`${name} has taken up arms against you`, 'bad');
      this.partyWarAt = this.time;
      if (this.onPartyWar) this.onPartyWar(team, by);
    }
    return true;
  }

  isHostile(a, b) {
    if (a === b) return false;
    if (a === TEAM_NEUTRAL || a === undefined || b === undefined) return false;
    if (b === TEAM_NEUTRAL) return false;
    const ra = crownOfRebel(a);
    const rb = crownOfRebel(b);
    if (ra && rb) return false;                       // two risings ignore each other
    if (ra) return b === ra || this._grudgeHas(a, b);
    if (rb) return a === rb || this._grudgeHas(b, a);
    return true;                                      // two crowns
  }

  _grudgeHas(rebelTeam, other) {
    const set = this.rebelGrudge.get(rebelTeam);
    return !!set && set.has(other);
  }

  /** A blow was struck: rebels remember who hit them. */
  noteAttack(victim, attacker) {
    if (!victim || !attacker || attacker === victim) return;
    this.noteBlood(victim.team, attacker.team);
    if (attacker.team === undefined || victim.team === undefined) return;
    const a = attacker.team, v = victim.team;
    if (a === v || a === TEAM_NEUTRAL) return;
    /* a party is only a neighbour until the first blow lands on it */
    if (this.peace.size) {
      if (this.peace.has(v)) this.breakPeace(v, a);
      else if (this.peace.has(a)) this.breakPeace(a, v);
    }
    const va = crownOfRebel(v);
    if (va && a !== va) {
      let set = this.rebelGrudge.get(v);
      if (!set) this.rebelGrudge.set(v, (set = new Set()));
      if (!set.has(a) && set.size < 8) set.add(a);
    }
  }

  /** Rebel teams are not kingdoms: they get a bare state so lookups work. */
  ensureRebelTeam(team) {
    if (this.teams.has(team)) return this.teams.get(team);
    const st = {
      civ: null, res: { food: 0, wood: 0, gold: 0, stone: 0 }, techs: new Set(),
      age: 0, ageResearch: null, pop: 0, popCap: 0, popUsed: 0, kills: 0, losses: 0,
      gathered: 0, trained: 0, buffs: [],
      resigned: false, rebel: true
    };
    this.teams.set(team, st);
    return st;
  }

  /** Every live fighting body of a team (rebels included). */
  armyOf(team) {
    const out = [];
    for (const u of this.units) {
      if (u.dead || u.team !== team) continue;
      if (!u.def || !(u.def.attack > 0)) continue;
      out.push(u);
    }
    return out;
  }

  findEnemyNear(entity, range) {
    const team = entity.team;
    const r2 = range * range;
    const near = this.spatial.query(entity.x, entity.z, range + 2);
    let best = null, bestD = r2;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o === entity || o.dead || !this.canFight(team, o.team)) continue;
      const d = dist2(entity.x, entity.z, o.x, o.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best) return best;
    // buildings are checked separately (few, and mostly static)
    const bn = this.buildingSpatial.query(entity.x, entity.z, range + 4);
    for (let i = 0; i < bn.length; i++) {
      const o = bn[i];
      if (o.dead || !this.canFight(team, o.team)) continue;
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
      if (u.dead || !this.isHostile(team, u.team)) continue;
      if (dist2(x, z, u.x, u.z) <= r2) {
        u.takeDamage(damage * (u.def.classes.includes('cavalry') ? 0.9 : 1), source, 'siege');
      }
    }
    for (const b of this.buildings) {
      if (b.dead || !this.isHostile(team, b.team)) continue;
      const half = (b.def.size || 3) * 0.5;
      if (dist2(x, z, b.x, b.z) <= (radius + half) * (radius + half)) b.takeDamage(damage * 0.8, source, 'siege');
    }
    this.fx.explosion(x, this.heightAt(x, z) + 0.4, z, radius * 0.5);
    this.sound.play('explosion', x, z);
  }

  auraBonusFor(unit) {
    let best = 0;
    if (this.court) {
      const m = this.court.damageMul(unit);
      if (m > 1) best = m - 1;
    }
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

  /**
   * The multiplier on a man's speed: the court, the mods, his own
   * nerve, the season and the sky. Six systems consulted per unit per tick,
   * so the answer is remembered for the tick -- none of them can change
   * twice inside one thirtieth of a second.
   */
  unitSpeedMul(unit) {
    let base = this.buffMul(unit.team, 'speed');
    if (this.court) base *= this.court.speedMul(unit);
    if (this.modHost) base *= this.modHost.speedMul(unit);
    if (unit.squad) base *= this.squads.speedMul(unit);
    if (this.morale) base *= this.morale.speedMul(unit);
    if (this.calendar) base *= this.calendar.speedMul();
    if (this.climate) base *= this.climate.speedMul();
    return base;
  }

  /**
   * The same number, remembered for the length of one tick.
   *
   * Six systems are consulted for every man on every step of his march, and
   * none of them can change twice inside a thirtieth of a second. The public
   * `unitSpeedMul` stays pure -- the court, the calendar and the tests all
   * ask it directly and expect a fresh answer -- and only the movement loop
   * takes the cached one.
   */
  speedMulOnStep(unit) {
    if (unit._smFrame === this.frame) return unit._sm;
    const v = this.unitSpeedMul(unit);
    unit._smFrame = this.frame;
    unit._sm = v;
    return v;
  }

  /* ==========================================================
     STANDING BONUSES (realm events, omen, the golden age)
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

  /** 0..1 progress of a running buff (for the HUD countdown bars). */
  buffProgress(team, name) {
    const st = this.teams.get(team);
    const b = st && st.buffs ? st.buffs.find((x) => x.name === name) : null;
    if (!b || !b.duration) return 0;
    return Math.max(0, Math.min(1, b.time / b.duration));
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
    if (this.squads) this.squads.remove(unit);
    if (this.guards) this.guards.release(unit);
    unit.team = team;
    unit.state = STATE.IDLE;
    unit.target = null;
    unit.gatherTarget = null;
    unit.carry.amount = 0;
    /* population accounting: a rebel or a fallen crown's soldier was never
       counted against the living crown's cap, and a missing team has no
       ledger to debit */
    const to = this.teams.get(team);
    const from = this.teams.get(old);
    if (to) to.popUsed = (to.popUsed || 0) + 1;
    if (from && unit.def.pop) from.popUsed = Math.max(0, (from.popUsed || 0) - unit.def.pop);
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

  /**
   * Put a man who was inside a building on open ground just outside its walls.
   *
   * The old release dropped him at a random point within two metres of the
   * *centre*, which is inside a town centre's 5.8 m footprint: he came out
   * standing in the wall, wedged, and either jittered for two seconds until
   * the watchdog teleported him or slid out through the side he was facing.
   * Same test as freeSpotNear: walkable ground *and* an open nav cell, so the
   * pathfinder can plan him away again.
   */
  placeLeaver(unit, building, index) {
    const half = (building.def.size || 3) * 0.5;
    const pf = this.pfFor(unit);
    const free = (x, z) => {
      if (!this.isPassable(x, z, unit)) return false;
      const [cx, cz] = pf.worldToCell(x, z);
      return !pf.isBlocked(cx, cz);
    };
    const base = (index * 2.399963) % (Math.PI * 2);
    for (let ring = 0; ring < 4; ring++) {
      const r = half + 0.9 + ring * 0.6;
      for (let k = 0; k < 12; k++) {
        const a = base + (k / 12) * Math.PI * 2;
        const x = building.x + Math.cos(a) * r;
        const z = building.z + Math.sin(a) * r;
        if (free(x, z)) { unit.x = x; unit.z = z; return; }
      }
    }
    const spot = this.freeSpotNear(building.x, building.z, unit, 10);
    if (spot) { unit.x = spot[0]; unit.z = spot[1]; }
  }

  /**
   * Empty a building's garrison onto the field.
   *
   * Garrisoned men stay in `units` the whole time (every system skips them by
   * flag), so a released man must *not* be pushed into the array again. The
   * old release did exactly that when the roof came down: each man appeared
   * twice, took every tick twice, drew twice and counted twice against the
   * population cap -- a garrison of four cost eight pop and walked at double
   * speed. It also leaked the flag order, so a man could be released while
   * still marked garrisoned.
   */
  releaseGarrison(building) {
    if (!building || !building.garrison.length) return 0;
    const leavers = building.garrison.slice();
    building.garrison.length = 0;
    for (let i = 0; i < leavers.length; i++) {
      const u = leavers[i];
      u.garrisoned = false;
      u.garrisonTarget = null;
      u.hp = Math.max(1, u.hp);
      u.state = STATE.IDLE;
      u.target = null;
      u.path = null;
      u.pathIdx = 0;
      u.targetPos = null;
      u.destX = u.destZ = null;
      u.moving = false;
      /* a teleport invalidates the "this cell was already proved walkable"
         shortcut that stepMovement keeps */
      u._passKey = -1;
      u.stallT = 0;
      u.stuckScore = 0;
      u.wedgeT = 0;
      this.placeLeaver(u, building, i);
      if (u.team === TEAM_PLAYER) this.popDirty = true;
    }
    this.spatial.clear();
    this.spatial.insertAll(this.units);
    return leavers.length;
  }

  /**
   * The index of the building a unit is standing in, in the order
   * `buildings.filter(b => !b.dead)` -- the same order the save writes.
   * -1 for a man on the field.
   */
  garrisonIndexOf(unit) {
    if (!unit || !unit.garrisoned || !unit.garrisonTarget) return -1;
    let i = 0;
    for (const b of this.buildings) {
      /* exactly the buildings the save writes and the load rebuilds: a dead
         roof and a neutral shrine are in neither list */
      if (b.dead || b.team === TEAM_NEUTRAL) continue;
      if (b === unit.garrisonTarget) return i;
      i++;
    }
    return -1;
  }

  removeFromGarrison(unit) {
    const b = unit.garrisonTarget;
    let index = 0;
    if (b) {
      index = Math.max(0, b.garrison.indexOf(unit));
      const i = b.garrison.indexOf(unit);
      if (i >= 0) b.garrison.splice(i, 1);
    }
    unit.garrisoned = false;
    unit.garrisonTarget = null;
    if (b) this.placeLeaver(unit, b, index);
    unit.state = STATE.IDLE;
    unit.target = null;
    unit.path = null;
    unit.pathIdx = 0;
    unit.targetPos = null;
    unit.destX = unit.destZ = null;
    unit.moving = false;
    unit._passKey = -1;
    unit.stallT = 0;
    unit.stuckScore = 0;
    if (unit.team === TEAM_PLAYER) this.popDirty = true;
    this.spatial.clear();
    this.spatial.insertAll(this.units);
  }

  /**
   * Lookouts.
   *
   * "I never saw them coming" is a fair complaint about a phone screen: the
   * enemy walks 400 m of empty island, arrives at the one building on the edge
   * of your town, and the first thing you learn about it is a burning roof.
   * Once a second the watch looks for a body of enemy soldiers near anything
   * you own and, at most every 40 s, says how many and from where. The warning
   * is a report, not an order: it tells the player what a scout would, and
   * leaves the answer to him.
   */
  _lookouts(dt) {
    this._lookoutT = (this._lookoutT || 0) + dt;
    if (this._lookoutT < 1) return;
    this._lookoutT = 0;
    const mine = this.buildings;
    if (!mine.length) return;
    let count = 0, sx = 0, sz = 0, nearest = null, nd = Infinity;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.team === TEAM_PLAYER || u.team === 0 || u.garrisoned) continue;
      if (!(u.def.attack > 0)) continue;
      let bestB = null, bestD = 70 * 70;
      for (let k = 0; k < mine.length; k++) {
        const b = mine[k];
        if (b.dead || b.team !== TEAM_PLAYER) continue;
        const d2 = (b.x - u.x) ** 2 + (b.z - u.z) ** 2;
        if (d2 < bestD) { bestD = d2; bestB = b; }
      }
      if (!bestB) continue;
      count++;
      sx += u.x; sz += u.z;
      if (bestD < nd) { nd = bestD; nearest = bestB; }
    }
    if (count < 4) return;
    const now = this.time;
    if (this._lookoutNext > now) return;
    this._lookoutNext = now + 40;
    sx /= count; sz /= count;
    const home = this.baseOf ? this.baseOf(TEAM_PLAYER) : null;
    const dir = this._compassWord((Math.atan2(sx - (home ? home.x : sx), sz - (home ? home.z : sz))));
    const where = nearest ? `the ${nearest.name.toLowerCase()}` : 'your walls';
    this.notify(`Lookouts: ${count} enemy soldiers closing on ${where} from the ${dir}`, 'warn');
    if (this.onAlarm) this.onAlarm(nearest || home);
  }

  _compassWord(a) {
    const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const t = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return words[Math.round(t / (Math.PI / 4)) % 8];
  }

  /**
   * The nearest thing of mine on the map -- the roof a villager runs to and
   * the yard a defender is leashed to.
   */
  nearestOwnBuilding(team, x, z) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b.dead || b.team !== team) continue;
      const d = (b.x - x) ** 2 + (b.z - z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /**
   * Sound the alarm in a circle.
   *
   * The old rule was one line long: the man being hit would fight back, and
   * his neighbours would keep staring at the horizon. An enemy could therefore
   * stand between six spearmen and burn down the hall they were guarding,
   * which is exactly what the player saw. Any hostile within `radius` of the
   * alarm is now treated as visible to every idle defender and every villager
   * inside it: soldiers and archers acquire the attacker, villagers run for
   * the nearest roof. It is called on every hit, not once per victim.
   */
  raiseAlarm(x, z, team, attacker, radius = 0) {
    if (!attacker || attacker.dead) return 0;
    const r = radius || (attacker.kind === 'building' ? 30 : 24);
    const r2 = r * r;
    let called = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.team !== team || u.garrisoned) continue;
      if ((u.x - x) ** 2 + (u.z - z) ** 2 > r2) continue;
      if (u.type === 'villager') {
        /* a peasant's business is somewhere else, quickly */
        if (u._fleeFrom !== attacker) { u._fleeFrom = attacker; u._fleeT = this.time; }
        continue;
      }
      if (!(u.def.attack > 0)) continue;
      if (u.state === STATE.ATTACK && u.target && !u.target.dead) continue;
      if (u.state !== STATE.IDLE && u.state !== STATE.MOVE && u.state !== STATE.STAND) continue;
      u.target = attacker;
      u.state = STATE.ATTACK;
      u.alarmedAt = this.time;
      called++;
    }
    return called;
  }

  alertAttacked(entity, attacker) {
    this.noteAttack(entity, attacker);
    if (entity.team === TEAM_PLAYER && this.time - (this._lastAlert || -99) > 6) {
      this._lastAlert = this.time;
      this.notify('Your forces are under attack!', 'bad');
      if (this.onAlarm) this.onAlarm(entity);
    }
    /* Whoever is at the sharp end of this -- a soldier, a villager, or the
       town hall itself -- every idle man of the same crown within earshot
       comes running. A building under attack rings louder than a man. */
    if (attacker && !attacker.dead) this.raiseAlarm(entity.x, entity.z, entity.team, attacker);
    if (entity.kind === 'unit' && entity.state === STATE.IDLE && entity.def.attack > 0) {
      entity.target = attacker;
      entity.state = STATE.ATTACK;
    }
  }

  onUnitKilled(unit, attacker) {
    this.guards?.release(unit);
    this.squads?.remove(unit);
    const st = this.teams.get(unit.team);
    if (st) st.losses++;
    const killer = attacker && attacker.team !== undefined ? this.teams.get(attacker.team) : null;
    if (killer) {
      killer.kills++;
      // every fallen enemy is a small offering to the court
    }
    if (this.court) this.court.onKill(attacker, unit);
    if (this.veterancy) this.veterancy.onKill(attacker, unit);
    if (attacker && attacker.champion && this.champions) {
      this.champions.addRenown(attacker, 10 + (unit.maxHp || 60) / 35 + (unit.rank || 0) * 4, 'kill');
      this.champions.stats.kills++;
    }
    /* a champion's death is a loss the player has to hear about */
    if (unit.champion) {
      if (this.champions.current === unit) this.champions.current = null;
      this.notify?.(`${unit.name} has fallen — ${this.champions.rankName(unit)} no more`, 'bad');
      this.onEvent?.('championDeath', { unit });
    }
    if (this.realm) this.realm.onUnitKilled(unit, attacker);
    if (this.morale) {
      this.morale.onAllyDeath(unit, attacker);
      this.morale.onKill(attacker);
    }
    unit.deadT = 0;
    this.deadUnits.push(unit);
    this.popDirty = true;
    this.sound.play('death', unit.x, unit.z);
    if (unit.team === TEAM_PLAYER) {
      this.selectedRemove?.(unit);
      /* A king matters only when the war is fought over kings. In a conquest
         or a war of crowns, the death of your king is a catastrophe, not a
         referee's whistle: your heir takes the throne and the war goes on. */
      if (unit.isKing && this.victory === 'regicide') this.endGame(false, 'king');
    }
    /* Any rival king's death is checked by checkVictory, which knows how many
       crowns are still standing: killing the king of one of four kingdoms
       must not end the war for the other three. */
    if (unit.isKing && unit.team !== TEAM_PLAYER && this.victory === 'regicide') this.checkVictory();
    this.onEvent('death', { unit });
  }

  onBuildingKilled(building, attacker) {
    this.markBuildingFootprint(building, false);
    /* Breaking a place is worth more than breaking a man, and a champion
       standing in the ruins earns it. */
    if (attacker && attacker.champion && this.champions) {
      this.champions.addRenown(attacker, 34 + (building.maxHp || 800) / 90, 'building');
    }
    if (this.realm) this.realm.onBuildingKilled(building, attacker);
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
    if (building.def.wonder) this.resetWonder(building.team);
    this.onEvent('buildingDeath', { building });
  }

  onBuildingComplete(building) {
    this.popDirty = true;
    if (this.realm) this.realm.onBuildingComplete(building);
    if (this.modHost) this.modHost.onBuildingComplete(building);
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
  /* ==========================================================
     save support
     ========================================================== */
  /** Everything about a side's empire that is not a unit or a building. */
  exportTeam(team) {
    const st = this.teams.get(team);
    if (!st) return null;
    return {
      civ: st.civ, res: { ...st.res },
      age: st.age, techs: [...st.techs], gathered: st.gathered,
      trained: st.trained, kills: st.kills, losses: st.losses,
      buffs: (st.buffs || []).map((b) => ({ ...b }))
    };
  }

  importTeam(team, data) {
    const st = this.teams.get(team);
    if (!st || !data) return;
    if (data.civ) st.civ = data.civ;
    if (data.res) Object.assign(st.res, data.res);
    st.age = data.age || 0;
    st.techs = new Set(data.techs || []);
    st.gathered = data.gathered || 0;
    st.trained = data.trained || 0;
    st.kills = data.kills || 0;
    st.losses = data.losses || 0;
    st.buffs = (data.buffs || []).filter((b) => b && b.time > 0);
    st.ageResearch = null;
    this.statsVersion++;
    this._costCache.clear();
    this._buildCostCache.clear();
    this.popDirty = true;
  }

  /* ==========================================================
     wonder race
     ========================================================== */
  /** Seconds a team's standing wonder has held, 0 if none stands. */
  wonderProgressOf(team) {
    return this.wonderClocks.get(team) || 0;
  }

  resetWonder(team) {
    if (this.wonderClocks.delete(team)) this.onEvent('wonderReset', { team });
  }

  /** Called by a completed wonder every tick. */
  tickWonder(team, dt) {
    /* the terms of war decide this now, not just the mode: a War of Crowns
       can be fought under a wonder term, and a wonder mode is that term */
    if ((this.victory !== 'wonder' && this.mode !== 'wonder') || this.gameOver) return;
    const t = (this.wonderClocks.get(team) || 0) + dt;
    this.wonderClocks.set(team, t);
    if (t >= this.wonderHold) this.endGame(team === this.playerTeam, 'wonder');
  }

  /** The HUD asks for this once per second: who is closest to a wonder win. */
  wonderStatus() {
    if (this.victory !== 'wonder' && this.mode !== 'wonder') return null;
    const mine = this.wonderProgressOf(this.playerTeam);
    let theirs = 0;
    for (const [team, v] of this.wonderClocks) if (team !== this.playerTeam) theirs = Math.max(theirs, v);
    if (!mine && !theirs) return null;
    return { mine, theirs, hold: this.wonderHold };
  }

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

  /* Returns { ok, reason }. It used to return a bare boolean while the HUD
     tested `.ok === false`, so every refused advance still played the success
     toast and the crown looked broken. */
  startAgeAdvance(team) {
    const st = this.teams.get(team);
    if (!st) return { ok: false, reason: 'No such team' };
    if (st.ageResearch) return { ok: false, reason: 'Already advancing' };
    if (st.age >= 3) return { ok: false, reason: 'Final age' };
    const next = st.age + 1;
    const cost = AGES[next].cost;
    if (!this.canAfford(team, cost)) return { ok: false, reason: 'Not enough resources' };
    const tc = this.buildings.find((b) => !b.dead && b.team === team && b.def.ageAdvance);
    if (!tc) return { ok: false, reason: 'Needs a town centre' };
    this.spend(team, cost);
    st.ageResearch = { next, time: AGES[next].time, total: AGES[next].time, building: tc };
    if (team === TEAM_PLAYER) this.notify(`Advancing to the ${AGES[next].name}…`, 'info');
    return { ok: true, reason: '' };
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
    if (this.navInv === undefined) {
      /* nav cells are the movement code's unit of "the same ground" */
      this.navCell = (this.world.nav && this.world.nav.cell) || 2;
      this.navHalf = this.world.half || 256;
      this.navInv = 1 / this.navCell;
      this.navN = (this.world.nav && this.world.nav.cells) || 256;
      const st = this.world.nav && this.world.nav.steep;
      if (st) this._steep = { g: st, n: this.world.nav.cells };
    }
    const t0 = performance.now();
    this.time += dt;
    this.frame++;

    // bound the cost of a pathological tick: at most N fresh searches
    this.beginPathTicks();
    // rebuild the unit hash once per tick
    this.spatial.clear();
    this.spatial.insertAll(this.units);
    if (this.buildingSpatialDirty || this.frame % 20 === 0) {
      this.buildingSpatial.clear();
      for (const b of this.buildings) if (!b.dead) this.buildingSpatial.insert(b);
      this.buildingSpatialDirty = false;
    }

    // Standing protection orders only do work when someone is actually guarding.
    this.guards.update(dt);
    this.squads.update(dt);
    this.champions.update(dt);
    this._lookouts(dt);

    // units
    /* one exponential for every unit's turn rate, instead of 4 000 a second */
    this._facingLerp = 1 - Math.pow(0.0008, dt);
    const units = this.units;
    /* One reciprocal for the whole loop (it used to divide twice per unit, and
       a caller passing dt = 0 turned every velocity into Infinity, which the
       archers then used to lead their shots). */
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    /* ---- the far half of the map ----
       In a war of four crowns most of the fighting happens somewhere the
       player cannot see. Those men still march, still fight and still die --
       but nothing about it is on screen, so they are simulated on every other
       tick and handed the elapsed time in one piece. The camera's own
       neighbourhood always runs at the full rate, and a game with no camera
       (tests, headless soaks) behaves exactly as it always did. */
    const cam = this.camera;
    const lodX = cam && Number.isFinite(cam.targetX) ? cam.targetX : (cam && cam.target ? cam.target[0] : NaN);
    const lodZ = cam && Number.isFinite(cam.targetZ) ? cam.targetZ : (cam && cam.target ? cam.target[2] : NaN);
    const lodOn = Number.isFinite(lodX) && Number.isFinite(lodZ);
    const lodR2 = 108 * 108;
    /* Thirds, spread across ticks: one third of the distant host thinks each
       tick, with a third of a second's worth of time in its hands. Every tick
       costs a third as much as the old "all of them, twice as coarsely"
       version -- and, unlike that version, no tick carries a double bill. */
    const LOD_N = 3;
    this.lodRound = ((this.lodRound | 0) + 1) % LOD_N;
    const lodRound = this.lodRound;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const px = u.x, pz = u.z;
      let step = dt;
      if (lodOn) {
        const dx = u.x - lodX, dz = u.z - lodZ;
        if (dx * dx + dz * dz > lodR2) {
          if ((i + lodRound) % LOD_N !== 0) {
            /* off screen, and not this tick: hold the render pose steady */
            u.xPrev = u.x; u.yPrev = u.y; u.zPrev = u.z;
            continue;
          }
          step = dt * LOD_N;
        }
      }
      u.update(step);
      const idt = step > 1e-6 ? 1 / step : 0;
      u.vx = (u.x - px) * idt;
      u.vz = (u.z - pz) * idt;
    }
    // buildings
    const buildings = this.buildings;
    for (let i = 0; i < buildings.length; i++) buildings[i].update(dt);
    // resources (herds wander, farms tick)
    const res = this.resources;
    for (let i = 0; i < res.length; i++) if (!res[i].dead) res[i].update(dt);

    /* half-second sweep: nobody may stand inside a wall or a roof */
    if (this.frame % 15 === 0) this.rescueStrays();

    this.projectiles.update(dt, this);

    // time of day (drives the renderer's sun, the HUD clock and unit vision)
    const prevPhase = this.dayPhase;
    let dayRate = (dt * 24) / this.dayLength;
    /* The dark runs on its own rate: 1.2x per in-game hour, so the 15 hours of
       daylight cost ten real minutes and the 9 hours of night cost five. */
    const h0 = this.worldTime;
    const isDark = (h0 >= 20.0 || h0 < 5.0);
    if (isDark) dayRate *= this.nightRateMul;
    /* The Long Night omen must *lengthen* the dark, not hasten it. Slowing the
       clock while it is dark is what turns a five-minute night into ten, and
       the omen's own words promise exactly that. */
    if (this.calendar) {
      const stretch = this.calendar.nightStretch;
      if (stretch > 1 && isDark) dayRate /= stretch;
      this.calendar.update(dt);
      this.calendar.tick(dt);
    }
    if (this.climate) this.climate.update(dt);
    this.worldTime = (this.worldTime + dayRate) % 24;
    const phase = this.dayPhase;
    if (phase !== prevPhase) {
      this.phaseChanged = true;
      this.onEvent('phase', { phase, prev: prevPhase, hour: this.worldTime });
    }

    if (this.court) this.court.update(dt);
    if (this.realm) this.realm.update(dt);

    // temporary standing bonuses (realm events, the golden age)
    for (const team of this.teamIds) {
      const st = this.teams.get(team);
      if (!st) continue;
      if (st.buffs.length) {
        let ended = false;
        for (let i = st.buffs.length - 1; i >= 0; i--) {
          const bf = st.buffs[i];
          bf.time -= dt;
          if (bf.time <= 0) {
            st.buffs.splice(i, 1);
            ended = true;
            if (team === TEAM_PLAYER) this.notify(`${bf.name} has ended`, 'info');
          }
        }
        /* A buff's multipliers do not change while it runs -- only its clock
           does. Bumping the stats version every tick invalidated every unit's
           cached stats thirty times a second for as long as any buff was
           live, which at four crowns is the entire late game. */
        if (ended) this.statsVersion++;
      }
    }

    // age research -- every crown ages, not just the first two
    for (const team of this.teamIds) {
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
          if (this.realm) this.realm.onAge(team, st.age);
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
      this.fowStamp = (this.fowStamp + 1) | 0;
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

    /* mods get a slice of every tick, strictly after the core simulation, in
       their own try/catch (inside the host): a broken mod cannot take the
       match down with it */
    this.morale.update(dt);
    if (this.elites) this.elites.update(dt);
    if (this.modHost) this.modHost.update(dt);

    this.stats.tickMs = this.stats.tickMs * 0.9 + (performance.now() - t0) * 0.1;
    this.stats.units = this.units.length;
    this.stats.buildings = this.buildings.length;
  }

  /**
   * Sweep the corpses out. Runs every second and a half, all match long, so
   * it does its work in place: the old version built a throwaway array (which
   * was then ignored) and replaced three arrays with three fresh filters.
   * At a full four-crown field that was three or four hundred slots copied
   * and three arrays allocated every 1.5 s, forever, for a list that usually
   * has nothing to remove at all.
   */
  compact() {
    const units = this.units;
    let w = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead && u.deadT > 2.4) continue;      // give the death animation time
      units[w++] = u;
    }
    if (w !== units.length) units.length = w;

    const blds = this.buildings;
    w = 0;
    for (let i = 0; i < blds.length; i++) {
      const b = blds[i];
      if (b.dead && !(b.deadT < 6)) continue;
      blds[w++] = b;
    }
    if (w !== blds.length) blds.length = w;

    const res = this.resources;
    w = 0;
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r.dead && !(r.deadT < 3)) continue;
      res[w++] = r;
    }
    if (w !== res.length) res.length = w;

    if (this.selection.length) {
      const sel = this.selection;
      w = 0;
      for (let i = 0; i < sel.length; i++) {
        const e = sel[i];
        if (e.dead) { this.selectionSet.delete(e); continue; }
        sel[w++] = e;
      }
      if (w !== sel.length) sel.length = w;
    }
  }

  /* The starting valley is known ground, not a circle of torchlight. v2
     revealed a ~22 m disc, which read as a spotlight parked on a dark field;
     v3's 96 m keeps the boundary off the top of the screen at the default 46 m
     camera (the visible ground there is 150-250 m away), so the town never
     sits inside a lit ellipse. It still stops well short of the enemy base, so
     exploring is the opening move. The edge is intentionally ragged. */
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
        if (d < 96 + wob * 1.8) fow[cz * FOW + cx] = 1;
      }
    }
  }

  /* ==========================================================
     vision
     ========================================================== */
  /**
   * Stamp one sight circle into the fog. A method rather than a closure: the
   * old version built a new function for every unit on every fog pass, which
   * at four crowns was two thousand closures a second and a visible share of
   * the garbage collector's work.
   */
  _fogStamp(x, z, radius) {
    const fow = this.fow;
    const size = WORLD.fowCell;
    const half = WORLD.half;
    const r2 = radius * radius;
    const cx0 = Math.max(0, Math.floor((x - radius + half) / size));
    const cx1 = Math.min(FOW - 1, Math.floor((x + radius + half) / size));
    const cz0 = Math.max(0, Math.floor((z - radius + half) / size));
    const cz1 = Math.min(FOW - 1, Math.floor((z + radius + half) / size));
    for (let cz = cz0; cz <= cz1; cz++) {
      const wz = (cz + 0.5) * size - half;
      const row = cz * FOW;
      const dz = wz - z;
      for (let cx = cx0; cx <= cx1; cx++) {
        const wx = (cx + 0.5) * size - half;
        const dx = wx - x;
        if (dx * dx + dz * dz <= r2) fow[row + cx] = 2;
      }
    }
  }

  updateFog(dt) {
    const fow = this.fow;
    // decay visible -> explored
    for (let i = 0; i < fow.length; i++) if (fow[i] === 2) fow[i] = 1;
    const units = this.units;
    const sightMul = this.sightDayMul;
    /* Stamp a third of the army per pass. Vision is a 2 m grid updated 5.5x a
       second, so a unit's circle is refreshed every ~0.55 s -- invisible to the
       player, and it takes the 200-unit fog pass from 25 000 cell writes to
       8 000. The round-robin offset keeps coverage even. */
    this.fogCursor = ((this.fogCursor || 0) + 1) % 3;
    for (let i = 0; i < units.length; i++) {
      if ((i % 3) !== this.fogCursor) continue;
      const u = units[i];
      /* a party at peace shares its map with you: neighbours talk */
      if (u.dead || (u.team !== TEAM_PLAYER && !this.atPeace(u.team))) continue;
      if (u.garrisoned) continue;
      this._fogStamp(u.x, u.z, (u.def.sight || 9) * sightMul);
    }
    const buildings = this.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b.dead) continue;
      if (b.team === TEAM_PLAYER || b.team === TEAM_NEUTRAL || this.atPeace(b.team)) this._fogStamp(b.x, b.z, (b.def.sight || 8) * (b.buildProgress >= 1 ? 1 : 0.5));
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
    if (this.victory === 'supremacy') {
      if (this.time >= this.supremacyClock) {
        const best = this.scoreboard()[0];
        this.endGame(best && best.team === TEAM_PLAYER, 'supremacy');
        return;
      }
    }
    /* Regicide is decided by the kings, not by the towns: a crown whose king
       is dead is out, whatever it still owns. */
    if (this.victory === 'regicide') {
      const playerKing = this.units.some((u) => !u.dead && u.team === TEAM_PLAYER && u.isKing);
      let rivalKings = 0;
      for (const t of this.teamIds) {
        if (t === TEAM_PLAYER) continue;
        if (this.units.some((u) => !u.dead && u.team === t && u.isKing)) rivalKings++;
      }
      if (!playerKing) { this.endGame(false, 'king'); return; }
      if (rivalKings === 0) { this.endGame(true, 'king'); return; }
    }
    /* Every mode still ends when only one crown is left standing. */
    const rivals = this.teamIds.filter((t) => t !== TEAM_PLAYER && this.aliveTeam(t));
    if (rivals.length === 0) { this.endGame(true, 'conquest'); return; }
    if (!this.aliveTeam(TEAM_PLAYER)) { this.endGame(false, 'conquest'); return; }

    // Dominance: a team without a single standing building cannot produce,
    // research or house anything, so it is dead even if a lone villager is
    // still hiding in a forest. Without this rule a mirror match could drag
    // on for another ten minutes over one survivor.
    if (!this._roofless) this._roofless = new Map();
    for (const team of this.teamIds) {
      if (this.fallenTeams && this.fallenTeams.has(team)) continue;
      /* A campaign is lost only when the last roof falls: a lone farm does
         not hold a kingdom together, but a farm is still a foothold to
         rebuild from, and the older modes are balanced around that.
         A war of crowns is sterner: what holds a crown together is its HALL.
         A kingdom that loses every town centre has sixty seconds to raise a
         new one or it falls, and its lands pass to whoever broke it. Without
         this, four forty-building kingdoms ground each other down for half an
         hour and nothing ever resolved -- conquest had no reachable ending. */
        const holdfast = this.crowns > 2
          ? this.buildings.some((b) => !b.dead && b.team === team && b.def && b.def.ageAdvance)
          : this.buildings.some((b) => !b.dead && b.team === team);
        const hasBuilding = holdfast;
      if (hasBuilding) { this._roofless.delete(team); continue; }
      const since = this._roofless.get(team) ?? this.time;
      this._roofless.set(team, since);
      const grace = this.difficultyKey === 'sandbox' ? Infinity : 60;
      if (this.time - since >= grace) {
        if (team === TEAM_PLAYER) { this.endGame(false, 'dominance'); return; }
        /* a rival crown that cannot raise a roof is out of the war, and the
           crown that broke it inherits what is left -- see collapse() */
        this.collapse(team, this._rooflessKiller(team));
      }
    }
    /* A crown that falls to dominance may have been the last thing between the
       player and the throne. The conquest test above ran before the fall, so
       without this the war ended on the *next* checkVictory -- a third of a
       second later -- and the end screen reported 'conquest' for a war that
       was actually won by taking the last roof. Resolve it here, with the
       honest reason, the moment the last rival's crown falls. */
    if (!this.gameOver && !this.teamIds.some((t) => t !== TEAM_PLAYER && this.aliveTeam(t))) {
      this.endGame(true, 'dominance');
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
     collapse & inheritance
     ----------------------------------------------------------
     When a crown falls, its lands do not become a wasteland and
     its army does not evaporate: the crown that broke it *inherits*
     them. Treasury, techs, standing bonuses and every soldier who
     is still breathing change allegiance -- with their hard-earned
     ranks intact, because a veteran who has survived four battles
     is exactly the asset a conqueror is fighting for.

     The inheritor is the crown that actually did the breaking: the
     last army to strike the falling crown, or failing that the
     strongest crown left standing. Inheritance is a real swing in
     the war, so it is announced loudly and drawn on the map.
     ========================================================== */
  /** Who gets the spoils: the crown that last drew blood, else the strongest. */
  _rooflessKiller(team) {
    if (this.lastBlood && this.lastBlood.get(team)) {
      const killer = this.lastBlood.get(team);
      if (killer !== team && this.teamIds.includes(killer) && this.aliveTeam(killer)) return killer;
    }
    let best = null, bestScore = -Infinity;
    for (const t of this.teamIds) {
      if (t === team) continue;
      if (!this.aliveTeam(t)) continue;
      const score = this.scoreOf(t);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /** Remember who hit whom, so the spoils go where the war was won. */
  noteBlood(victimTeam, attackerTeam) {
    if (victimTeam === undefined || attackerTeam === undefined) return;
    if (victimTeam === attackerTeam) return;
    if (!this.lastBlood) this.lastBlood = new Map();
    if (!this.teamIds.includes(victimTeam)) return;
    this.lastBlood.set(victimTeam, attackerTeam);
  }

  /** A crude but honest strength score, used by Supremacy and by spoils. */
  scoreOf(team) {
    const st = this.teams.get(team);
    if (!st) return 0;
    let score = 0;
    for (const b of this.buildings) {
      if (b.dead || b.team !== team) continue;
      score += 6 + (b.type === 'town_center' ? 12 : b.type === 'castle' ? 10 : b.type === 'wonder' ? 40 : 0);
    }
    for (const u of this.units) {
      if (u.dead || u.team !== team) continue;
      if (u.type === 'villager') { score += 2; continue; }
      score += 3 + (u.rank || 0) * 2 + (u.isKing ? 30 : 0) + (u.def.threat ? u.def.threat * 2 : 0);
    }
    score += (st.age || 0) * 14;
    score += (st.kills || 0) * 0.5;
    score += (st.res.food + st.res.wood + st.res.gold + st.res.stone) / 500;
    if (this.realm) score += Math.max(0, this.realm.state(team).commons - 40) * 0.2;
    return score;
  }

  scoreboard() {
    const rows = this.teamIds.map((team) => ({
      team,
      name: team === this.partyTeam ? this.partyName : (CIVS[this.civOf(team)]?.name || `Crown ${team}`),
      score: this.scoreOf(team),
      alive: this.aliveTeam(team),
      fallen: this.fallenTeams ? this.fallenTeams.has(team) : false
    }));
    rows.sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || b.score - a.score || a.team - b.team);
    return rows;
  }

  /**
   * Take a crown out of the war and hand what is left to `heir`.
   * Public because Regicide, Supremacy, dominance and the tests all need it.
   */
  collapse(team, heir = null) {
    if (!this.fallenTeams) this.fallenTeams = new Set();
    if (this.fallenTeams.has(team)) return { ok: false };
    this.fallenTeams.add(team);
    if (!this.chronicle) this.chronicle = [];
    this.chronicle.push({ team, heir: heir && heir !== team ? heir : null, time: this.time });
    const loser = this.teams.get(team);
    const spoils = { heir, resources: null, techs: [], units: 0, buffs: 0 };
    const target = heir && heir !== team && this.teams.has(heir) ? heir : null;
    if (target && loser) {
      const winner = this.teams.get(target);
      /* treasury */
      spoils.resources = {};
      for (const k of RES_KEYS) {
        const amount = Math.max(0, loser.res[k] || 0);
        winner.res[k] = (winner.res[k] || 0) + amount;
        loser.res[k] = 0;
        spoils.resources[k] = Math.round(amount);
      }
      /* every technology the fallen crown had researched */
      for (const tech of loser.techs) {
        if (!winner.techs.has(tech)) { winner.techs.add(tech); spoils.techs.push(tech); }
      }
      spoils.buffs = (loser.buffs || []).length;
      for (const bf of loser.buffs || []) {
        const existing = winner.buffs.find((b2) => b2.kind === bf.kind);
        if (existing) existing.time = Math.max(existing.time, bf.time);
        else winner.buffs.push({ ...bf });
      }
      loser.buffs.length = 0;
      if (loser.age > winner.age) { winner.age = loser.age; }
      this.statsVersion++;
      this._costCache.clear();
      this._buildCostCache.clear();
      this.popDirty = true;
      /* the realm remembers a rival humbled */
      if (this.realm) {
        const rs = this.realm.state(target);
        if (!rs.empty) {
          rs.commons = Math.min(100, rs.commons + 5);
          rs.nobles = Math.min(100, rs.nobles + 9);
          rs.glory = Math.min(40, rs.glory + 6);
        }
      }
    }
    /* the army changes its colours: a soldier does not stop existing because
       his king did, and the ranks he earned come with him */
    if (target) {
      for (const u of this.units) {
        if (u.dead || u.team !== team) continue;
        if (u.isKing) continue;
        this.convertUnit(u, target);
        u.morale = Math.min(u.morale ?? 100, 62);
        u.state = STATE.IDLE;
        u.target = null;
        u.aiRole = null;
        u.isRebel = false;
        u.rebelAgainst = 0;
        spoils.units++;
      }
    }
    /* The roofs change hands too. A conqueror who takes a kingdom takes its
       barracks, its farms and its walls -- otherwise the map is full of
       orphaned buildings nobody can use and nobody can burn. Footprints are
       re-stamped because a captured gate now opens for its new owner. */
    if (target) {
      for (const b of this.buildings) {
        if (b.dead || b.team !== team) continue;
        if (b.def && b.def.neutral) continue;
        b.team = target;
        if (b.def.wall || b.def.gate) {
          this.markBuildingFootprint(b, false);
          this.markBuildingFootprint(b, true);
        }
        spoils.buildings = (spoils.buildings || 0) + 1;
        if (this.fx) this.fx.sparks(b.x, this.heightAt(b.x, b.z) + 2, b.z, 6, [1, 0.85, 0.5]);
      }
      this.popDirty = true;
      this.recomputePop();
      this.refreshNav();
    }
    /* The old king cannot be inherited: a conqueror who lets the last of a
       line live is a conqueror with a rebellion in his own hall. He is killed
       outright rather than left at one hit point by armour. */
    for (const u of this.units) {
      if (!u.dead && u.team === team && u.isKing) {
        u.hp = 0;
        u.kill(null);
      }
    }
    /* and every AI that was campaigning against this crown picks a new foe */
    this.onEvent('collapse', { team, heir: target, spoils });
    if (this.notify) {
      const winnerName = target ? (CIVS[this.civOf(target)]?.name || 'a rival') : null;
      if (team === TEAM_PLAYER) this.notify('Your crown has fallen', 'bad');
      else if (target === TEAM_PLAYER) this.notify(`${CIVS[this.civOf(team)]?.name || 'A rival crown'} has fallen to you — their treasury, their learning and their army are yours`, 'good');
      else this.notify(`${CIVS[this.civOf(team)]?.name || 'A crown'} has fallen${winnerName ? ` to ${winnerName}` : ''}`, 'warn');
    }
    if (this.sound) this.sound.play('ageUp');
    if (this.fx && target) {
      const b = this.baseOf(target);
      this.fx.glowPulse?.(b.x, this.heightAt(b.x, b.z) + 2, b.z, 2.4, 0.9, 0.5);
    }
    return { ok: true, ...spoils };
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
    if (this.selection.length >= 48) this.selectionSet.delete(this.selection.shift());
    this.selection.push(e);
    this.selectionSet.add(e);
  }
  removeFromSelection(e) {
    if (!this.selectionSet.has(e)) return;
    this.selectionSet.delete(e);
    const i = this.selection.indexOf(e);
    if (i >= 0) this.selection.splice(i, 1);
  }
  clearSelection() { this.selection.length = 0; this.selectionSet.clear(); }
  selectionOfTeam(team = TEAM_PLAYER) { return this.selection.filter((e) => e.team === team && !e.dead); }
  get selectedUnits() { return this.selection.filter((e) => e.kind === 'unit'); }
  get selectedBuildings() { return this.selection.filter((e) => e.kind === 'building'); }

  /** Add a fading ground ring. */
  marker(x, z, opts = {}) {
    const m = this.groundMarkers;
    /* `hold` marks are the ones that *stay*: a sheet of ice under a frozen
       area has to be on the ground for the spell's whole duration, and a
       rotating buffer of 24 marks used to drop it in a single skirmish. */
    if (m.length > 64) {
      let victim = 0;
      for (let i = 0; i < m.length; i++) if (!m[i].hold) { victim = i; break; }
      m.splice(victim, 1);
    }
    m.push({
      x, z, y: opts.y !== undefined ? opts.y : this.heightAt(x, z),
      r: opts.r || 1.4, life: opts.life || 0.75, t: 0,
      kind: opts.kind || 1, hold: !!opts.hold,
      r0: opts.r0 ?? 0.55, g0: opts.g0 ?? 0.95, b0: opts.b0 ?? 0.7
    });
  }

  notify(text, kind = 'info') {
    this.notifyQueue.push({ text, kind, t: this.time });
    if (this.notifyQueue.length > 6) this.notifyQueue.shift();
    if (this.onNotify) this.onNotify(text, kind);
  }

  /**
   * Units that can still take an order. A man who has broken cannot be
   * commanded back into the line by tapping the ground -- that is the point of
   * the morale system, and it has to hold for every order, not just a move.
   * Callers get the men who will listen, and the player is told once per
   * frame why the rest stayed where they were.
   */
  freeUnits(units) {
    const list = units || [];
    const out = [];
    let broken = 0;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!u || u.dead || u.garrisoned || u.kind !== 'unit') continue;
      if (u.state === STATE.ROUT) { broken++; continue; }
      // An explicit new order replaces a standing guard assignment.
      this.guards?.release(u);
      out.push(u);
    }
    if (broken && this._routNoticeAt !== this.time) {
      this._routNoticeAt = this.time;
      this.notify(`${broken} broken ${broken === 1 ? 'man refuses' : 'men refuse'} orders — they are falling back`, 'bad');
    }
    return out;
  }

  orderGuard(units, target) {
    const count = this.guards.assign(units, target);
    if (count) this.notify(`${count} ${count === 1 ? 'unit is' : 'units are'} guarding ${target.name}`, 'good');
    else this.notify('Choose friendly, available units and a different friendly target', 'bad');
    return count;
  }

  orderMove(units, x, z, formation = true) {
    units = this.freeUnits(units);
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
    /* facing: from the group's centre toward the tap */
    let sx = 0, sz = 0, rmax = 0;
    for (const u of movable) { sx += u.x; sz += u.z; rmax = Math.max(rmax, u.radius || 0.4); }
    const cxg = sx / movable.length, czg = sz / movable.length;
    const facing = Math.atan2(x - cxg, z - czg);
    /* a rank of horse needs more room than a rank of archers */
    const spacing = clamp(1.15 + rmax * 2.1, 1.35, 3.2);
    const slots = formationSlots(movable.length, x, z, {
      style: this.formationStyle, facing, spacing
    });
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
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.garrisoned || u.kind !== 'unit' || !u.def.attack) continue;
      u.target = target;
      u.state = STATE.ATTACK;
      u.gatherTarget = null;
      u.buildTarget = null;
    }
  }

  orderAttackMove(units, x, z) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.garrisoned || u.kind !== 'unit') continue;
      u.state = STATE.ATTACK_MOVE;
      u.target = null;
      u.moveTo(x, z, true);
    }
  }

  orderStop(units) {
    units = this.freeUnits(units);
    for (const u of units) if (!u.dead && u.kind === 'unit') u.stop();
  }

  orderGather(units, node) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      if (u.carry.kind && u.carry.kind !== node.resKind) {
        if (u.carry.amount > 0.01) u.returnResources();
        else { u.carry.kind = null; u.carry.amount = 0; }
      }
      u.gatherTarget = node;
      /* The node the player actually pointed at is the villager's home. It
         used to be recorded only for scenery, so a farm -- which is a
         building -- was picked from the ground each time, and a farm next to
         a berry bush was worth complaining about. */
      u.homeNode = node;
      u.lastGatherKind = node.resKind;
      u.state = STATE.GATHER;
      u.buildTarget = null;
      u.target = null;
      u.moveTo(node.x, node.z, true);
    }
  }

  orderBuild(units, building) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      u.buildTarget = building;
      u.state = STATE.BUILD;
      u.gatherTarget = null;
      u.target = null;
      u.moveTo(building.x, building.z, true);
    }
  }

  /**
   * Send a crew down a run of foundations, round-robin, one villager per
   * segment to start. Three villagers sent to a ten-segment wall should spread
   * along it and raise it in parallel -- dumping all three on the first segment
   * makes a wall take five times as long as it has to.
   */
  orderBuildMany(units, buildings) {
    units = this.freeUnits(units);
    const crew = units.filter((u) => u && !u.dead && u.type === 'villager');
    if (!crew.length || !buildings.length) return;
    for (let i = 0; i < crew.length; i++) this.orderBuild([crew[i]], buildings[i % buildings.length]);
  }

  orderRepair(units, building) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      u.repairTarget = building;
      u.state = STATE.REPAIR;
      u.moveTo(building.x, building.z, true);
    }
  }

  orderHeal(units, target) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || !u.def.classes.includes('monk')) continue;
      u.target = target;
      u.state = STATE.HEAL;
      u.moveTo(target.x, target.z, true);
    }
  }

  orderConvert(units, target) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || !u.def.classes.includes('monk')) continue;
      u.convertTarget = target;
      u.convertProgress = 0;
      u.state = STATE.CONVERT;
      u.moveTo(target.x, target.z, true);
    }
  }

  orderGarrison(units, building) {
    units = this.freeUnits(units);
    for (const u of units) {
      if (u.dead || u.garrisoned) continue;
      u.garrisonTarget = building;
      u.state = STATE.GARRISON;
      u.moveTo(building.x, building.z, true);
    }
  }

  orderPatrol(units, x, z) {
    units = this.freeUnits(units);
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
    if (!opts.free && !this.canAfford(team, cost)) {
      if (team === TEAM_PLAYER) this.notify('Not enough resources', 'bad');
      return null;
    }
    if (this.ageOf(team) < (opts.ageRequired ?? 0)) return null;
    /* One rule for every caller. The AI, the wall planner, the campaign
       scripts and the player all used to have their own idea of what a legal
       footprint was, so a building could land on a woodpile or on the heads of
       four spearmen and then jitter while the collision system sorted it out.
       The ghost and the real building now ask the same question, and a unit
       standing in the way is stepped aside rather than refusing the order. */
    /* `free` is the scripting escape hatch -- campaign set-pieces, the
       scenario tests and the AI's own hand-placed opening -- so only paid
       placements are checked. What the player buys is always checked. */
    if (!opts.force && !opts.free) {
      const spot = this.canPlaceAt(type, team, x, z, { ignoreUnits: true });
      if (!spot.ok) {
        if (team === TEAM_PLAYER) this.notify(`Cannot build here: ${spot.reason}`, 'bad');
        return null;
      }
    }
    this._clearFootprint(type, x, z);
    if (!opts.free) this.spend(team, cost);
    const b = new Building(this, type, team, x, z, opts.instant);
    b.facing = opts.facing ?? (Math.atan2(-x, -z));
    this.addBuilding(b);
    if (opts.instant) this.onBuildingComplete(b);
    this.onEvent('place', { building: b });
    return b;
  }

  /** Is a building ghost position legal? */
  canPlaceAt(type, team, x, z, opts = {}) {
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
    /* A hall is not raised in the shadow of an enemy host. Without this rule
       a besieged crown simply builds another town centre as soon as the old
       one falls, and no siege ever ends a war: the attacker breaks the walls,
       marches home, and comes back to find them rebuilt. With it, an army
       that *stays* in the rubble is an army that has actually taken a crown
       -- which is the whole point of the holdfast rule it serves. */
    if (def.ageAdvance) {
      for (const u of this.units) {
        if (u.dead || u.garrisoned || !u.def || u.def.attack <= 0) continue;
        if (!this.isHostile(team, u.team)) continue;
        if (dist2(u.x, u.z, x, z) < 26 * 26) return { ok: false, reason: 'contested' };
      }
    }
    // no overlap with buildings / resources / units (walls are exempt-ish)
    for (const b of this.buildings) {
      if (b.dead) continue;
      const bh = (b.def.size || 3) * 0.5;
      if (Math.abs(b.x - x) < bh + half - 0.25 && Math.abs(b.z - z) < bh + half - 0.25) return { ok: false, reason: 'blocked' };
    }
    /* Resources block with their *trunk*, not with their canopy.
       A spruce keeps its collision radius for pathing, but only the stem is
       solid: measure the crown and half a forest becomes unbuildable and the
       player is told "blocked" by a tree he can see is twelve metres away. */
    if (!def.wall) {
      const near = this.resourceSpatial.query(x, z, half + 4);
      for (let i = 0; i < near.length; i++) {
        const r = near[i];
        if (r.dead) continue;
        const trunk = Math.max(0.5, (r.trunkRadius || 0.5));
        if (dist2(r.x, r.z, x, z) < (half + trunk) ** 2) return { ok: false, reason: 'resource' };
      }
    }
    /* A man is not a wall. He is stepped aside on placement, but the ghost has
       to know he is there, or the player watches a hall appear on top of four
       villagers and calls it broken. */
    if (!opts.ignoreUnits) {
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (u.dead || u.garrisoned || u.team === 0) continue;
        if (Math.abs(u.x - x) < half + 0.35 && Math.abs(u.z - z) < half + 0.35) return { ok: false, reason: 'unit' };
      }
    }
    return { ok: true, reason: '' };
  }

  /**
   * Step bystanders out of a new footprint.
   *
   * Refusing to build because a villager is standing on the spot is the kind
   * of rule that reads as a bug on a phone -- the player has already chosen
   * the place. The man is shoved to the nearest free ground instead.
   */
  _clearFootprint(type, x, z) {
    const def = BUILDING_DEFS[type];
    if (!def) return;
    const half = (def.size || 3) * 0.5;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.garrisoned || u.team === 0 || u.isKing) continue;
      if (Math.abs(u.x - x) >= half + 0.35 || Math.abs(u.z - z) >= half + 0.35) continue;
      const a = Math.atan2(u.z - z, u.x - x) || (i * 1.7);
      let spot = null;
      for (let r = half + 1.2; r < half + 7 && !spot; r += 1.1) {
        for (let k = 0; k < 8 && !spot; k++) {
          const th = a + (k * Math.PI) / 4;
          const px = x + Math.cos(th) * r, pz = z + Math.sin(th) * r;
          if (this.isInside(px, pz) && (!this.nav || this.isPassable(px, pz))) spot = [px, pz];
        }
      }
      if (!spot) spot = [x + Math.cos(a) * (half + 1.4), z + Math.sin(a) * (half + 1.4)];
      u.x = spot[0]; u.z = spot[1];
      u.path = null; u.targetPos = null;
      if (u.state === STATE.MOVE) u.state = STATE.IDLE;
      if (u.updateY) u.updateY();
      else u.y = this.heightAt(u.x, u.z);
    }
  }

  /* ---------------------------------------------------------------
     walls
     --------------------------------------------------------------- */

  /**
   * Plan a run of wall segments between two ground points.
   *
   * Walls are the one building you never place one at a time -- dragging a line
   * is how you enclose a town, and doing it tap by tap is the difference
   * between "walled base" and "gave up". The run snaps to the segment lattice
   * so pieces touch instead of overlapping by 40 cm, takes the dominant axis
   * first and then turns the corner (drag a rectangle's two corners and you get
   * an L, exactly like the original), and stops at the first cell it cannot
   * build on so you can see *where* the line broke.
   *
   * Returns one record per cell: { x, z, ok, reason, cost, afford }.
   */
  planWallLine(type, x0, z0, x1, z1, team = TEAM_PLAYER, limit = 48) {
    const def = BUILDING_DEFS[type];
    if (!def) return [];
    const size = def.size || 2;
    /* snap to the middle of a nav cell, not to its corner: a 2 m segment
       centred on a cell boundary claims four cells, one centred on the cell
       claims exactly one */
    const edge = WORLD.half - size;
    const navCell = this.world.nav.cell;
    const off = (size >= navCell ? navCell : size) * 0.5;
    const step = (v) => clamp(Math.round((v - off) / size), -Math.round(edge / size), Math.round(edge / size));
    const i0 = step(x0), j0 = step(z0), i1 = step(x1), j1 = step(z1);
    const cost = this.buildingCost(type, team);
    const st = this.teams.get(team);
    let purse = st ? { ...st.res } : null;

    const cells = [];
    const di = Math.sign(i1 - i0), dj = Math.sign(j1 - j0);
    const spanI = Math.abs(i1 - i0), spanJ = Math.abs(j1 - j0);
    const xFirst = spanI >= spanJ;
    let i = i0, j = j0, broken = false;
    for (let n = 0; n <= spanI + spanJ && cells.length < limit; n++) {
      const x = i * size + off, z = j * size + off;
      const spot = broken ? { ok: false, reason: 'blocked' } : this.canPlaceAt(type, team, x, z);
      let ok = spot.ok, reason = spot.reason;
      /* a wall may not grow through a forest: canPlaceAt waves resources
         through for walls, which is right for a lone segment dropped in a
         yard and wrong for a run that would thread a spruce */
      if (ok && this.resourceSpatial) {
        const half = size * 0.5;
        const near = this.resourceSpatial.query(x, z, half + 3);
        for (let k = 0; k < near.length; k++) {
          const r = near[k];
          if (r.dead) continue;
          if (dist2(r.x, r.z, x, z) < (half + r.radius * r.scale * 0.75) ** 2) { ok = false; reason = 'resource'; break; }
        }
      }
      let afford = ok;
      if (ok && purse) {
        for (const k of Object.keys(cost)) {
          if ((purse[k] || 0) < (cost[k] || 0)) { afford = false; break; }
        }
        if (afford) for (const k of Object.keys(cost)) purse[k] -= cost[k] || 0;
      }
      cells.push({ x, z, ok, reason, cost, afford, facing: 0 });
      if (!ok) broken = true;
      if (n === spanI + spanJ) break;
      if (xFirst) { if (i !== i1) i += di; else j += dj; }
      else { if (j !== j1) j += dj; else i += di; }
    }
    /* Face each segment along the run. The wall model's long axis is local X,
       so without this every segment pointed at the map origin and a diagonal
       run of square blocks came out as a scatter of separate slabs with gaps
       between them. Corner cells take the average of their two neighbours. */
    for (let n = 0; n < cells.length; n++) {
      const prev = cells[n - 1], next = cells[n + 1];
      let dx = 0, dz = 0;
      if (prev && next) { dx = next.x - prev.x; dz = next.z - prev.z; }
      else if (next) { dx = next.x - cells[n].x; dz = next.z - cells[n].z; }
      else if (prev) { dx = cells[n].x - prev.x; dz = cells[n].z - prev.z; }
      if (dx || dz) cells[n].facing = Math.atan2(-dz, dx);
    }
    return cells;
  }

  /**
   * Place a planned run. Stops at the first illegal cell and the first one the
   * treasury cannot cover -- a wall line must never silently eat the whole
   * stockpile or leave a gap in the middle of a run.
   */
  placeWallLine(type, team, cells, opts = {}) {
    const out = [];
    let stopped = 'end';
    for (const c of cells) {
      if (!c.ok) { stopped = c.reason || 'blocked'; break; }
      const spot = this.canPlaceAt(type, team, c.x, c.z);
      if (!spot.ok) { stopped = spot.reason || 'blocked'; break; }
      if (!opts.free && !this.canAfford(team, this.buildingCost(type, team))) { stopped = 'resources'; break; }
      const b = this.placeBuilding(type, team, c.x, c.z, {
        instant: opts.instant, free: opts.free,
        facing: opts.facing !== undefined ? opts.facing : c.facing
      });
      if (!b) { stopped = 'resources'; break; }
      out.push(b);
    }
    return { placed: out, stopped };
  }

  /**
   * The nearest enemy structure a frustrated unit could hit instead.
   *
   * Walls made the map honest, and an army that cannot walk to the town centre
   * has to take the wall down -- that is what siege units are for, and what
   * every player does by hand. The AI asks for this when one of its soldiers
   * reports an unreachable destination. Walls and gates come first within the
   * same radius (they are the actual obstacle); anything else is a fallback.
   */
  /** The nearest town centre of an enemy crown: the thing a war is fought over. */
  /**
   * The hall a besieging army should march on: the *weakest* one it can
   * reach, not simply the nearest. Two halls a crown apart means nothing if
   * the attacker keeps switching from the wounded one to the fresh one --
   * that is how a war of crowns grinds for an hour without a single throne
   * falling. Distance breaks the tie.
   */
  enemyHall(team, x, z, radius = 60) {
    let best = null, bestScore = Infinity;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b.dead || b.team === team || b.team === 0) continue;
      if (!b.def || !b.def.ageAdvance) continue;
      const d = Math.sqrt(dist2(b.x, b.z, x, z));
      if (d > radius) continue;
      const score = (b.hp / b.maxHp) * 30 + d * 0.6 + ((b.buildProgress || 1) < 1 ? 4 : 0);
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  nearestEnemyStructure(unit, team, radius = 26) {
    let best = null, bestD = radius * radius, bestWall = null, bestWallD = Infinity;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b.dead || b.team === team || b.team === 0) continue;
      const d = dist2(b.x, b.z, unit.x, unit.z);
      if (b.def.wall || b.def.gate) {
        if (d < bestWallD) { bestWallD = d; bestWall = b; }
      } else if (d < bestD) { bestD = d; best = b; }
    }
    if (bestWall && bestWallD < radius * radius * 2.25) return bestWall;
    return best || bestWall;
  }

  /**
   * The next unfinished piece of wall for a builder to walk to.
   * Nearest first, within a short leash, and only pieces that no other
   * villager is already working on -- two villagers hammering one foundation
   * while three idle is the behaviour this exists to avoid.
   */
  nextFoundation(from, unit, radius = 12) {
    let best = null, bestD = radius * radius;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b === from || b.dead || !b.def || !b.def.wall) continue;
      if (b.buildProgress >= 1) continue;
      if (b.team !== (unit ? unit.team : b.team)) continue;
      if (b.builders && b.builders.size && !b.builders.has(unit.id)) continue;
      /* somebody else is already walking to this piece: without the claim two
         villagers that finish their pieces on the same tick pick the same
         next one and leave another foundation idle */
      if (b.chainClaim && b.chainClaim !== (unit && unit.id) && this.time - (b.chainClaimT || 0) < 8) continue;
      const d = dist2(b.x, b.z, from.x, from.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && unit) { best.chainClaim = unit.id; best.chainClaimT = this.time; }
    return best;
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
   formations — where each soldier of a group should stand

   Four shapes, all built in a local frame (x = right, z = forward) and then
   rotated to face the direction of the march:

     box     the old default: a soft block, seven wide
     line    one or two ranks, as wide as the army allows -- the shape you want
             archers in front of the enemy and cavalry behind
     wedge   ranks of 1, 3, 5, 7: a spearhead for a charge down a lane
     column  two abreast, for marching a road or threading a gate

   Spacing is derived from the unit radius, not a constant: cavalry are twice
   the width of an archer, and a fixed 1.5 m pitch made horse float through
   horse. The whole group is centred on the point you tapped.
   ============================================================ */
export const FORMATIONS = ['box', 'line', 'wedge', 'column'];

export function formationSlots(count, cx, cz, opts = {}) {
  const style = FORMATIONS.includes(opts.style) ? opts.style : 'box';
  const facing = Number.isFinite(opts.facing) ? opts.facing : 0;
  const spacing = clamp(opts.spacing || 1.5, 1.1, 3.4);
  const local = [];
  if (style === 'line') {
    const perRow = count <= 14 ? count : Math.ceil(count / 2);
    for (let i = 0; i < count; i++) {
      const row = (i / perRow) | 0;
      const col = i % perRow;
      const n = Math.min(perRow, count - row * perRow);
      local.push([(col - (n - 1) / 2) * spacing, row * spacing * 0.9]);
    }
  } else if (style === 'wedge') {
    /* ranks of 1, 3, 5, ... with the leader at the tip */
    let placed = 0, rank = 0;
    while (placed < count) {
      const width = rank * 2 + 1;
      for (let k = 0; k < width && placed < count; k++, placed++) {
        local.push([(k - (width - 1) / 2) * spacing, -rank * spacing * 0.9]);
      }
      rank++;
    }
  } else if (style === 'column') {
    const perRow = 2;
    for (let i = 0; i < count; i++) {
      const row = (i / perRow) | 0;
      const col = i % perRow;
      local.push([(col - 0.5) * spacing, -row * spacing * 0.9]);
    }
  } else {
    const perRow = Math.min(7, Math.ceil(Math.sqrt(count * 1.35)));
    const rows = Math.ceil(count / perRow);
    for (let i = 0; i < count; i++) {
      const row = (i / perRow) | 0;
      const col = i % perRow;
      const n = Math.min(perRow, count - row * perRow);
      local.push([(col - (n - 1) / 2) * spacing, (row - (rows - 1) / 2) * spacing]);
    }
  }
  /* centre the shape on the tap, then turn it to face the march */
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const [lx, lz] of local) {
    if (lx < mnx) mnx = lx; if (lx > mxx) mxx = lx;
    if (lz < mnz) mnz = lz; if (lz > mxz) mxz = lz;
  }
  const ox = (mnx + mxx) / 2, oz = (mnz + mxz) / 2;
  const sin = Math.sin(facing), cos = Math.cos(facing);
  const out = [];
  for (let i = 0; i < local.length; i++) {
    const lx = local[i][0] - ox, lz = local[i][1] - oz;
    /* forward = (sin, cos), right = (cos, -sin) */
    out.push([cx + lx * cos + lz * sin, cz - lx * sin + lz * cos]);
  }
  return out;
}


/* Every effect method, forever. The simulation must never fail because a
   headless caller has no renderer, and a mod must never fail because an
   effect it asks for was added to FX after this table was written. */
const NULL_FX = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => {}) });
const NULL_SOUND = { play() {} };
