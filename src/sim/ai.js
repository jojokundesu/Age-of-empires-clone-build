/* ============================================================
   ai.js — opponent brain
   Runs at 2 Hz and is fully budgeted: a fixed number of decisions
   per turn, a shared build-spot cache, and no per-tick allocation.
   The personality is defined by the difficulty preset: it builds a
   real economy, takes map control, ages up and attacks in waves.
   ============================================================ */
import { UNIT_DEFS, BUILDING_DEFS, TECH_DEFS, AGES, CIVS, BUILDING_AGE } from './data.js';
import { STATE } from './entities.js';
import { dist2, clamp } from '../core/math.js';

const BUILD_ORDER = [
  // type, age, condition
  { type: 'house', age: 0, want: 1 },
  { type: 'lumber_camp', age: 0, want: 1 },
  { type: 'mill', age: 0, want: 1 },
  { type: 'mining_camp', age: 0, want: 1 },
  { type: 'barracks', age: 1, want: 1 },
  { type: 'farm', age: 0, want: 3 },
  { type: 'blacksmith', age: 1, want: 1 },
  { type: 'archery_range', age: 1, want: 1 },
  { type: 'stable', age: 1, want: 1 },
  { type: 'market', age: 1, want: 1 },
  { type: 'watch_tower', age: 1, want: 2 },
  { type: 'farm', age: 0, want: 6 },
  { type: 'town_center', age: 1, want: 2 },
  { type: 'castle', age: 2, want: 1 },
  { type: 'siege_workshop', age: 2, want: 1 },
  { type: 'university', age: 2, want: 1 },
  { type: 'monastery', age: 2, want: 1 }
];

const TECH_PRIORITY = [
  'loom', 'wheelbarrow', 'double_bit_axe', 'horse_collar', 'gold_mining',
  'forging', 'scale_armor', 'fletching', 'hand_cart', 'bow_saw', 'stone_mining',
  'iron_casting', 'chain_mail', 'bodkin_arrow', 'barding_armor', 'masonry',
  'ballistics', 'heavy_plow', 'architecture', 'chemistry', 'conscription', 'sappers', 'hoardings'
];

export class AIController {
  constructor(game, team, opts = {}) {
    this.game = game;
    this.team = team;
    this.diff = game.difficulty;
    this.aggression = this.diff.aggression;
    this.timer = 0.6 + Math.random() * 0.4;
    this.econTimer = 0;
    this.buildTimer = 0;
    this.attackTimer = this.diff.firstWave;
    this.waveTimer = this.diff.firstWave;
    this.army = [];
    this.armyState = 'gather';
    this.attackTarget = null;
    this.base = team === 1 ? game.world.playerBase : game.world.enemyBase;
    this.enemyBase = team === 1 ? game.world.enemyBase : game.world.playerBase;
    this.spots = new Map();          // building type -> cached good spot
    this.failedSpots = new Map();
    this.rally = { x: this.base.x, z: this.base.z };
    this.lastAttackTime = 0;
    this.phase = 'boom';
    this.troopPrefs = ['spearman', 'archer', 'knight', 'skirmisher', 'swordsman'];
    this.civ = CIVS[game.civOf(team)] || CIVS.franks;
    this.units = { military: [], villagers: [], buildings: { byType: new Map(), all: [] } };
    this.waitUntil = 0;
    this.log = [];
  }

  /* ---------------- helpers ---------------- */
  myUnits() { return this.game.units.filter((u) => !u.dead && u.team === this.team); }
  myBuildings() { return this.game.buildings.filter((b) => !b.dead && b.team === this.team); }
  count(type) {
    let n = 0;
    for (const b of this.game.buildings) if (!b.dead && b.team === this.team && b.type === type) n++;
    return n;
  }
  countUnits(type) {
    let n = 0;
    for (const u of this.game.units) if (!u.dead && u.team === this.team && u.type === type) n++;
    return n;
  }
  find(type) {
    for (const b of this.game.buildings) if (!b.dead && b.team === this.team && b.type === type && b.buildProgress >= 0.99) return b;
    return null;
  }
  idleVillagers() {
    const out = [];
    for (const u of this.game.units) {
      if (u.dead || u.team !== this.team || u.type !== 'villager') continue;
      if (u.state === STATE.IDLE || (u.state === STATE.BUILD && !u.buildTarget)) out.push(u);
    }
    return out;
  }
  militaryUnits() {
    const out = [];
    for (const u of this.game.units) {
      if (u.dead || u.team !== this.team || u.garrisoned) continue;
      if (u.def.attack > 0 && !u.def.classes.includes('villager')) out.push(u);
    }
    return out;
  }

  /* ---------------- main ---------------- */
  update(dt) {
    const g = this.game;
    if (g.gameOver) return;
    this.timer -= dt;
    this.econTimer -= dt;
    this.buildTimer -= dt;
    this.attackTimer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;

    const st = g.teams.get(this.team);
    const age = st.age;

    // ---------- economy ----------
    if (this.econTimer <= 0) {
      this.econTimer = 2.0;
      this.manageEconomy(st, age);
    }

    // ---------- construction ----------
    if (this.buildTimer <= 0) {
      this.buildTimer = 1.4;
      this.manageConstruction(st, age);
    }

    // ---------- production ----------
    this.manageProduction(st, age);

    // ---------- research ----------
    this.manageResearch(st, age);

    // ---------- age up ----------
    this.manageAges(st, age);

    // ---------- court: market + decrees ----------
    this.manageCourt(st, age);

    // ---------- military ----------
    this.manageMilitary(st, age);
  }

  /* ---------------- court ---------------- */
  manageCourt(st, age) {
    const g = this.game;
    const my = this.myBuildings();
    // the market turns a gold mountain into the food the army actually eats
    const hasMarket = my.some((b) => b.type === 'market' && b.buildProgress >= 1);
    if (hasMarket) {
      // gold mountains are useless unless they become food and wood
      if (st.res.gold > 260) {
        for (const k of ['food', 'wood']) {
          let guard = 0;
          while (st.res[k] < 300 && st.res.gold > 200 && guard++ < 4) {
            if (!g.marketTrade(this.team, k, 200, true).ok) break;
          }
        }
      }
      // surplus stone is dead weight; turn it into gold for techs
      if (st.res.stone > 700 && st.res.gold < 300) g.marketTrade(this.team, 'stone', 200, false);
    }
    // decrees are spent the moment they pay off
    if (st.favor < 40) return;
    const army = this.militaryUnits();
    const wounded = army.filter((u) => u.hp < u.maxHp * 0.6).length;
    const inCombat = army.some((u) => u.state === STATE.ATTACK || u.state === STATE.ATTACK_MOVE || (u.target && !u.target.dead));
    const pick = [];
    if (age >= 2 && wounded >= Math.max(3, army.length * 0.4)) pick.push('blessing');
    if (age >= 1 && inCombat && army.length >= 8) pick.push('rally');
    if (age >= 1 && inCombat && st.favor > 160) pick.push('forced_march');
    if (st.res.food < 60 && st.res.gold > 700) pick.push('harvest');
    if (age >= 2 && army.length < 3 && st.favor > 220) pick.push('conscription');
    for (const id of pick) {
      if (g.activateDecree(this.team, id).ok) break;
    }
  }

  /* ---------------- economy ---------------- */
  /** How many villagers each resource *should* have. Counts, not fractions:
      a 26-villager town with 18 % on gold still starves food if it cannot see
      that "1.7 workers" is really a hard constraint of two. */
  workerTargets(st, total, age) {
    const share = age >= 2
      ? { food: 0.34, wood: 0.34, gold: 0.22, stone: 0.10 }
      : age >= 1
        ? { food: 0.36, wood: 0.40, gold: 0.16, stone: 0.08 }
        : { food: 0.44, wood: 0.44, gold: 0.10, stone: 0.02 };
    const want = {};
    for (const k in share) want[k] = Number.isFinite(share[k]) ? Math.round(share[k] * total) : 0;
    // never bank a resource you cannot spend: gold is only useful for units,
    // techs and the market, so a full treasury means one miner, not six
    if (st.res.gold > 520) want.gold = Math.min(want.gold, 1);
    else if (st.res.gold > 320) want.gold = Math.min(want.gold, 2);
    if (st.res.wood > 800) want.wood = Math.max(2, want.wood - 3);
    // starvation rescue: food and wood run the war, so take workers from gold
    if (st.res.food < 130) {
      const need = Math.min(4, want.gold + Math.floor(want.stone * 0.5));
      want.food += Math.max(1, need);
      want.gold = Math.max(1, want.gold - need);
      want.stone = Math.max(1, want.stone - 1);
    }
    if (st.res.wood < 130 && age >= 1) {
      want.wood += 2;
      want.gold = Math.max(1, want.gold - 2);
    }
    if (st.res.stone > 700) want.stone = 1;
    // keep the totals honest after all the nudging
    let sum = 0;
    for (const k in want) { want[k] = Math.max(0, want[k]); sum += want[k]; }
    if (sum > total) {
      // trim the least urgent first: stone, then gold, then the biggest pile
      for (const k of ['stone', 'gold', 'wood', 'food']) {
        if (sum <= total) break;
        const cut = Math.min(want[k], sum - total);
        want[k] -= cut; sum -= cut;
      }
    }
    return want;
  }

  manageEconomy(st, age) {
    const g = this.game;
    const villagers = g.units.filter((u) => !u.dead && u.team === this.team && u.type === 'villager');
    const counts = { food: 0, wood: 0, gold: 0, stone: 0 };
    const byKind = { food: [], wood: [], gold: [], stone: [] };
    for (const v of villagers) {
      if (v.state !== STATE.GATHER && v.state !== STATE.RETURN) continue;
      const k = v.carry.kind || v.lastGatherKind;
      if (k && counts[k] !== undefined) { counts[k]++; byKind[k].push(v); }
    }
    const want = this.workerTargets(st, Math.max(1, villagers.length), age);

    // One transfer per economy pass: cheap, and it never thrashes the whole
    // workforce when a store crosses a threshold for a moment.
    let overKind = null, overGap = 0, underKind = null, underGap = 0;
    for (const k in want) {
      const gap = want[k] - counts[k];
      if (gap < -1 && -gap > overGap) { overGap = -gap; overKind = k; }
      if (gap > 0 && gap > underGap) { underGap = gap; underKind = k; }
    }
    if (overKind && underKind && byKind[overKind].length > want[overKind]) {
      const movable = byKind[overKind].filter((v) => v.state === STATE.GATHER || v.carry.amount < 6);
      const v = movable[movable.length - 1];
      if (v) {
        const node = g.findNearestResource(underKind, v.x, v.z, 90, v);
        if (node) {
          if (v.carry.amount > 0.5) v.returnResources();
          g.orderGather([v], node);
          counts[overKind]--;
          counts[underKind]++;
        }
      }
    }

    // villagers that are not producing at all go to the worst deficit
    const idle = villagers.filter((v) => v.state === STATE.IDLE);
    if (idle.length) {
      let kind = 'wood', gap = -9;
      for (const k in want) {
        const d = want[k] - counts[k];
        if (d > gap) { gap = d; kind = k; }
      }
      for (const v of idle.slice(0, 3)) {
        let node = g.findNearestResource(kind, v.x, v.z, 75, v);
        if (!node) {
          for (const k of ['wood', 'food', 'gold', 'stone']) {
            node = g.findNearestResource(k, v.x, v.z, 130, v);
            if (node) break;
          }
        }
        if (node) g.orderGather([v], node);
      }
    }

    // soldiers defend the base automatically
    this.rally.x = this.base.x;
    this.rally.z = this.base.z;
  }

  /* ---------------- construction ---------------- */
  manageConstruction(st, age) {
    const g = this.game;
    const popFree = st.popCap - st.popUsed;
    const houses = this.count('house');
    // hard requirement: houses
    if (popFree <= 6 && houses < 16) {
      if (this.tryBuild('house', st)) return;
    }
    // Never boom while the army is thin: every plank spent on a second mill
    // is a plank not spent on the two spearmen that would have held the gate.
    const army = this.militaryUnits().length;
    if (age >= 1 && army < 6 && this.count('barracks') === 0) {
      if (this.tryBuild('barracks', st)) return;
    }
    if (age >= 1 && army < 6) return;
    // a town centre if we somehow lost ours
    if (this.count('town_center') === 0) {
      if (this.tryBuild('town_center', st)) return;
    }
    // follow the build order
    for (const step of BUILD_ORDER) {
      if (step.age > age) continue;
      const have = step.type === 'house' ? houses : (step.type === 'farm' ? this.count('farm') : this.count(step.type));
      if (have >= step.want) continue;
      if (this.tryBuild(step.type, st)) return;
    }
    // food demand grows with the army: keep adding farms while wood allows
    const farmCap = age >= 2 ? 12 : age >= 1 ? 9 : 6;
    if (this.count('farm') < farmCap && st.res.food < 320 && this.tryBuild('farm', st)) return;
    // a second lumber camp halves the walking distance once the first ring is bare
    if (age >= 1 && this.count('lumber_camp') < 2 && st.res.wood < 200 && this.tryBuild('lumber_camp', st)) return;
    // late game: more farms and towers
    if (age >= 2 && st.res.wood > 400 && this.count('farm') < 12) this.tryBuild('farm', st);
  }

  tryBuild(type, st) {
    const g = this.game;
    const cost = g.buildingCost(type, this.team);
    if (!g.canAfford(this.team, cost)) return false;
    // do not let farms and houses eat the wood a barracks needs
    const military = type === 'barracks' || type === 'archery_range' || type === 'stable' || type === 'castle' || type === 'siege_workshop';
    const eco = type === 'farm' || type === 'house' || type === 'market' || type === 'blacksmith';
    if (eco && this.needsMilitaryWood(st) && st.res.wood < (cost.wood || 0) + 130) return false;
    // keep a wood float for units: a barracks can wait, a spearman cannot
    if (eco && this.game.ageOf(this.team) >= 1 && st.res.wood < (cost.wood || 0) + 70) return false;
    if (g.ageOf(this.team) < (BUILDING_AGE[type] ?? 0)) return false;
    const spot = this.findSpot(type);
    if (!spot) return false;
    const building = g.placeBuilding(type, this.team, spot.x, spot.z, { facing: spot.facing });
    if (!building) return false;
    this.spots.delete(type);
    // assign builders
    const builders = this.pickBuilders(type === 'town_center' || type === 'castle' ? 4 : 2);
    if (builders.length) g.orderBuild(builders, building);
    return true;
  }

  needsMilitaryWood(st) {
    const age = this.game.ageOf(this.team);
    if (age < 1) return false;
    if (!this.find('barracks')) return true;
    if (age >= 1 && !this.find('archery_range') && st.res.wood < 130) return true;
    return false;
  }

  pickBuilders(max) {
    const g = this.game;
    const out = [];
    const idle = this.idleVillagers().sort((a, b) => dist2(a.x, a.z, this.base.x, this.base.z) - dist2(b.x, b.z, this.base.x, this.base.z));
    for (const v of idle) { if (out.length >= max) break; out.push(v); }
    if (out.length < max) {
      // pull villagers that are still walking to a resource
      for (const u of g.units) {
        if (out.length >= max) break;
        if (u.dead || u.team !== this.team || u.type !== 'villager') continue;
        if (u.state === STATE.GATHER && u.carry.amount === 0) out.push(u);
      }
    }
    return out;
  }

  findSpot(type) {
    const g = this.game;
    const def = BUILDING_DEFS[type];
    if (!def) return null;
    const cached = this.spots.get(type);
    if (cached && g.canPlaceAt(type, this.team, cached.x, cached.z).ok) return cached;
    const half = (def.size || 3) * 0.5;
    const base = this.base;
    // farms go beside the town centre; camps go to their resource
    let cx = base.x, cz = base.z;
    let ringStart = 9;
    if (type === 'lumber_camp' || type === 'mining_camp') {
      const kind = type === 'lumber_camp' ? 'wood' : 'gold';
      const node = g.findNearestResource(kind, base.x, base.z, 140, null);
      if (node) { cx = node.x; cz = node.z; ringStart = 4 + half; }
    } else if (type === 'farm' || type === 'mill') {
      cx = base.x;
      cz = base.z;
      ringStart = 8;
    } else if (type === 'watch_tower' || type === 'castle') {
      cx = base.x;
      cz = base.z;
      ringStart = 13;
    }
    for (let ring = 0; ring < 9; ring++) {
      const radius = ringStart + ring * 4.2;
      const steps = Math.min(24, 8 + ring * 3);
      const phase = Math.random() * Math.PI * 2;
      for (let i = 0; i < steps; i++) {
        const a = phase + (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(a) * radius;
        const z = cz + Math.sin(a) * radius;
        if (g.canPlaceAt(type, this.team, x, z).ok) {
          const spot = { x, z, facing: Math.atan2(-x, -z) };
          this.spots.set(type, spot);
          return spot;
        }
      }
    }
    return null;
  }

  /* ---------------- production ---------------- */
  manageProduction(st, age) {
    const g = this.game;
    const tc = this.find('town_center');
    const villagerCount = this.countUnits('villager');
    const target = this.diff.villagerTarget;
    const popFree = st.popCap - st.popUsed;
    // villagers: the goal rises with the age, and every town centre trains
    const goal = age === 0 ? Math.min(16, target) : age === 1 ? Math.min(24, target) : target;
    if (villagerCount < goal && popFree > 1) {
      const vcost = this.game.unitCost('villager', this.team);
      for (const b of this.myBuildings()) {
        if (!b.def.ageAdvance || b.buildProgress < 1) continue;
        if (b.queue.length >= 1) continue;
        if (!this.affordableWithReserve(st, age, vcost)) break;
        if (b.queueUnit('villager')) break;
      }
    }

    // military: keep a mix and never stall the barracks
    const armyTarget = Math.min(this.diff.maxArmy, 6 + Math.floor((g.time - 60) / 40));
    const armyCount = this.militaryUnits().length;
    if (armyCount < armyTarget && !this.ageReserve(st, age)) {
      const buildings = this.myBuildings().filter((b) => b.buildProgress >= 1 && b.queue.length < 1);
      for (const b of buildings) {
        if (b.type === 'town_center' || b.def.ageAdvance) continue;
        if (!b.def.trains || !b.def.trains.length) continue;
        const pick = this.pickUnitFor(b, age);
        if (pick) {
          b.queueUnit(pick);
          break;
        }
      }
    }
  }

  pickUnitFor(building, age = 0) {
    const st = this.game.teams.get(this.team);
    const options = building.def.trains.filter((t) => {
      if (isUnique(t) && this.civ.unique !== t) return false;
      if (UNIT_DEFS[t].classes.includes('monk')) return false;
      return true;
    });
    if (!options.length) return null;
    // prefer units we do not have too many of
    const counts = new Map();
    for (const u of this.game.units) if (!u.dead && u.team === this.team) counts.set(u.type, (counts.get(u.type) || 0) + 1);
    options.sort((a, b) => (counts.get(a) || 0) - (counts.get(b) || 0));
    for (const opt of options) {
      const cost = this.game.unitCost(opt, this.team);
      if (this.affordableWithReserve(st, age, cost) && this.game.popFree(this.team) >= (UNIT_DEFS[opt].pop || 1)) return opt;
    }
    return null;
  }

  /* ---------------- research ---------------- */
  manageResearch(st, age) {
    const g = this.game;
    const buildings = this.myBuildings().filter((b) => b.buildProgress >= 1 && b.researchQueue.length === 0);
    if (!buildings.length) return;
    for (const techId of TECH_PRIORITY) {
      const tech = TECH_DEFS[techId];
      if (!tech) continue;
      if (tech.age > age) continue;
      if (g.hasTech(this.team, techId)) continue;
      const b = buildings.find((bb) => bb.def.research && bb.def.research.includes(techId));
      if (!b) continue;
      if (!g.canAfford(this.team, tech.cost)) continue;
      b.queueTech(techId);
      return;
    }
    // civ unique tech
    const civTech = this.civ.tech;
    if (civTech && !g.hasTech(this.team, civTech.id)) {
      const castle = buildings.find((b) => b.type === 'castle');
      if (castle && g.canAfford(this.team, TECH_DEFS[civTech.id].cost)) castle.queueTech(civTech.id);
    }
  }

  /* ---------------- ages ---------------- */
  savingForAge(st, age) {
    if (st.ageResearch || age >= 3) return false;
    return this.countUnits('villager') >= ([6, 12, 18][age] ?? 6);
  }

  /** Resources that must stay in the bank so the pending age-up is not
      starved by unit production.

      Real players only "push" for an age once they are a good way there: while
      far off they keep a small army flowing, and once they are close they stop
      spending food/gold on anything else. Without that split an AI either never
      ages up (spends every coin) or never fights (saves from minute two). */
  ageReserve(st, age) {
    if (!this.savingForAge(st, age)) return null;
    const cost = AGES[age + 1] && AGES[age + 1].cost;
    if (!cost) return null;
    let readiness = 1;
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      if (!cost[k]) continue;
      readiness = Math.min(readiness, st.res[k] / cost[k]);
    }
    // A floor of troops is never sacrificed for an age-up, and the reserve
    // only switches on once the town is a real way towards the cost. The old
    // 0.55 threshold deadlocked: the AI spent every coin on troops, so it
    // never reached 55 % and therefore never saved for an age again.
    if (this.militaryUnits().length < 4) return null;
    if (readiness < 0.25) return null;
    const need = {};
    let any = false;
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      const short = Math.max(0, (cost[k] || 0) - st.res[k]);
      if (short > 0) { need[k] = short; any = true; }
    }
    return any ? need : null;
  }

  /** True when paying `cost` still leaves the age-up reserve intact. */
  affordableWithReserve(st, age, cost) {
    const reserve = this.ageReserve(st, age);
    if (!reserve) return true;
    return this.game.canAfford(this.team, {
      food: (cost.food || 0) + (reserve.food || 0),
      wood: (cost.wood || 0) + (reserve.wood || 0),
      gold: (cost.gold || 0) + (reserve.gold || 0),
      stone: (cost.stone || 0) + (reserve.stone || 0)
    });
  }

  manageAges(st, age) {
    const g = this.game;
    if (st.ageResearch) return;
    if (age >= 3) return;
    const next = age + 1;
    const cost = AGES[next].cost;
    const villagers = this.countUnits('villager');
    const wantVillagers = [6, 12, 18][age] ?? 6;
    if (villagers < wantVillagers) return;
    if (!g.canAfford(this.team, cost)) return;
    // in the early game the age matters more than one more house
    if (g.startAgeAdvance(this.team)) {
      this.log.push(['age', this.game.time | 0, next]);
      this.savedForAge = false;
    }
  }

  /* ---------------- military ---------------- */
  manageMilitary(st, age) {
    const g = this.game;
    const army = this.militaryUnits();
    const enemyBase = this.enemyBase;
    const base = this.base;

    // threat detection near home
    const threat = g.findEnemyNear({ x: base.x, z: base.z, team: this.team }, 34);
    if (threat && army.length) {
      // defend
      for (const u of army) {
        if (u.state === STATE.IDLE || u.state === STATE.ATTACK_MOVE || u.state === STATE.MOVE) {
          if (u.target !== threat && u.state !== STATE.ATTACK) {
            u.target = threat;
            u.state = STATE.ATTACK;
          }
        }
      }
      this.armyState = 'defend';
      return;
    }

    // wave timing
    const ready = army.length >= Math.min(this.diff.maxArmy, 5 + Math.floor((g.time - this.diff.firstWave) / this.diff.waveEvery) * 3);
    const canAttack = g.time > this.diff.firstWave && (this.attackTimer <= 0 || (ready && this.armyState !== 'attack'));

    if (canAttack && army.length >= 4) {
      this.armyState = 'attack';
      this.attackTimer = this.diff.waveEvery;
      this.lastAttackTime = g.time;
      // rally first, then march
      const targetX = enemyBase.x;
      const targetZ = enemyBase.z;
      // split: some units siege the nearest building, others attack-move
      const target = g.buildings.find((b) => !b.dead && b.team !== this.team && b.team !== 0) || null;
      for (const u of army) {
        if (u.state === STATE.ATTACK && u.target && !u.target.dead) continue;
        u.state = STATE.ATTACK_MOVE;
        u.target = null;
        u.moveTo(targetX + (Math.random() - 0.5) * 16, targetZ + (Math.random() - 0.5) * 16, true);
      }
      return;
    }

    if (this.armyState === 'attack') {
      // keep the push alive: refresh orders for stragglers
      if (g.time - this.lastAttackTime > 9) {
        this.lastAttackTime = g.time;
        const alive = army.length;
        if (alive < 3) {
          this.armyState = 'gather';
          this.attackTimer = Math.max(20, this.diff.waveEvery * 0.5);
          for (const u of army) {
            u.state = STATE.MOVE;
            u.moveTo(base.x, base.z, true);
          }
        } else {
          for (const u of army) {
            if (u.state === STATE.IDLE) {
              u.state = STATE.ATTACK_MOVE;
              u.moveTo(enemyBase.x + (Math.random() - 0.5) * 14, enemyBase.z + (Math.random() - 0.5) * 14, true);
            }
          }
        }
      }
      return;
    }

    // gather phase: idle army regroups near the base
    if (army.length) {
      for (const u of army) {
        if (u.state === STATE.IDLE) {
          const a = Math.random() * Math.PI * 2;
          const r = 6 + Math.random() * 7;
          u.state = STATE.MOVE;
          u.moveTo(base.x + Math.cos(a) * r, base.z + Math.sin(a) * r, true);
        }
      }
    }
  }
}

function isUnique(type) {
  return ['axeman', 'longbowman', 'cataphract', 'huskarl', 'war_elephant', 'samurai', 'mangudai', 'berserk'].includes(type);
}
