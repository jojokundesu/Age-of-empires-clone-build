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

/* Which units answer each role the war council can ask for. The first entry
   is the ideal; later ones are acceptable answers from another building. */
const ROLE_UNITS = {
  spear: ['spearman', 'huskarl', 'axeman', 'swordsman'],
  skirmisher: ['skirmisher', 'archer', 'longbowman'],
  archer: ['archer', 'longbowman', 'hand_cannoneer', 'skirmisher'],
  knight: ['knight', 'scout_cavalry', 'cataphract'],
  monk: ['monk']
};

const TECH_PRIORITY = [
  'loom', 'wheelbarrow', 'double_bit_axe', 'horse_collar', 'gold_mining',
  'forging', 'scale_armor', 'fletching', 'hand_cart', 'bow_saw', 'stone_mining',
  'iron_casting', 'chain_mail', 'bodkin_arrow', 'barding_armor', 'masonry',
  'ballistics', 'heavy_plow', 'architecture', 'chemistry', 'conscription', 'sappers', 'hoardings'
];

export class AIController {
  constructor(game, team, opts = {}) {
    this.game = game;
    /* The AI draws from the simulation's stream, never Math.random: an AI that
       rolls its own dice makes the whole match unreproducible. */
    this.rng = () => (game && game.rng ? game.rng() : Math.random());
    this.team = team;
    this.diff = game.difficulty;
    this.aggression = this.diff.aggression;
    this.timer = 0.6 + this.rng() * 0.4;
    this.econTimer = 0;
    this.buildTimer = 0;
    this.attackTimer = this.diff.firstWave;
    this.waveTimer = this.diff.firstWave;
    this.army = [];
    this.armyState = 'gather';
    this.attackTarget = null;
    this.base = game.baseOf ? game.baseOf(team) : (team === 1 ? game.world.playerBase : game.world.enemyBase);
    /* In a war of four crowns there is no single "the enemy". `foe` is the
       crown this AI is currently campaigning against, re-chosen every couple
       of minutes from strength and distance; `enemyBase` follows it so all
       the older code that says "march on the enemy base" keeps working. */
    this.foe = null;
    this.enemyBase = game.baseOf && game.baseOf(team === 1 ? 2 : 1)
      ? game.baseOf(team === 1 ? 2 : 1)
      : (team === 1 ? game.world.enemyBase : game.world.playerBase);
    this.foeTimer = 0;
    /* Choose a foe before the first frame. A controller that waited for its
       first update had no target at all, so a reloaded war spent its opening
       seconds doing nothing and the enemy base was stale. */
    this.chooseFoe();
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
    /* --- the hunt: a standing bounty on high-value enemy units ------------
       `threat` is a number any mod can put on a unit def (a mage is worth
       more than a spearman, a ranked mage more than a fresh one), so the AI
       hunts *interesting* things without ever naming a mod. */
    this.hunt = [];
    this.huntTarget = null;
    this.huntCooldown = 0;
    this.huntWarnAt = -99;
    this.raidUnits = [];
    this.raidGoal = null;
    this.raidTimer = 45;
    this.raidRefresh = 0;
    this.waveStrength = 0;
    this.lastWaveSeen = 0;
    /* --- the war council ------------------------------------------------
       What the enemy is actually fielding, read from what this AI has
       actually *seen* (enemy units within scouting distance of its own men
       or roofs). A good player does not train the same army all match; the
       AI must not either. `plan` is the answer the council gives the
       barracks: which arm the next wave needs. */
    this.staging = null;
    this.census = null;
    this.censusAt = -99;
    this.plan = { role: null, why: '', siege: 0, defend: 0 };
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
      /* wildlife spawned by a mod fights for nobody: it must never be drafted
         into the enemy's army list */
      if (u.wild) continue;
      if (u.def.attack > 0 && !u.def.classes.includes('villager')) out.push(u);
    }
    return out;
  }

  /* ---------------- main ---------------- */
  update(dt) {
    const g = this.game;
    if (g.gameOver) return;
    /* a crown that has fallen has no economy to run and no army to march:
       its survivors answer a new king now, and this controller is done */
    if (g.fallenTeams && g.fallenTeams.has(this.team)) return;
    /* and if the crown it was campaigning against is gone, think again now
       rather than marching an army into an empty corner of the island */
    if (this.foe && g.fallenTeams && g.fallenTeams.has(this.foe)) this.foeTimer = 0;
    this.timer -= dt;
    this.econTimer -= dt;
    this.buildTimer -= dt;
    this.attackTimer -= dt;
    this.raidTimer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;

    const st = g.teams.get(this.team);
    const age = st.age;

    this.foeTimer -= 0.5;
    if (this.foeTimer <= 0 || !this.foe) {
      this.foeTimer = 90 + this.rng() * 40;
      this.chooseFoe();
    }

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

    // ---------- the sky ----------
    this.manageOmens(st, age);

    // ---------- the realm's temper ----------
    this.manageRealm(st, age);

    // ---------- military ----------
    this.manageMilitary(st, age);
  }

  /* ============================================================
     THE WHEEL
     ------------------------------------------------------------
     The AI is not immune to weather. It reads the season and the omen
     and changes its plans the way a good player does: it booms in the
     months that feed it, hoards through winter, repays the Frost with
     wood, and attacks when the sky is on its side -- the Comet, the
     Silent March, the Iron Sky, a long night to raid through.
     ============================================================ */
  manageOmens(st, age) {
    const g = this.game;
    const cal = g.calendar;
    if (!cal) return;
    const season = cal.season.key;
    const omen = cal.omen ? cal.omen.id : null;
    /* How much the AI *wants* to attack right now, 0..1.5. It multiplies the
       raid cadence, not the army size: an AI that builds more units in summer
       is just a bigger AI, an AI that spends them in summer is a player. */
    let mood = 1;
    if (season === 'winter') mood *= 0.55;
    else if (season === 'autumn') mood *= 1.1;
    if (omen === 'red_comet' || omen === 'silent_march') mood *= 1.35;
    else if (omen === 'long_night') mood *= 1.2;
    else if (omen === 'plague_winds' || omen === 'great_frost') mood *= 0.8;
    if (g.dayPhase === 'night') mood *= 1.2;
    this.mood = mood;

    /* winter rationing: stop spending food on soldiers, put it in the barn */
    this.winterRation = season === 'winter';

    /* The Frost is a bill, not a disaster: pay it. One repair crew, one
       building at a time, whichever is most hurt. */
    if (omen === 'great_frost' && (this.repairAt || 0) <= g.time) {
      let worst = null, worstFrac = 0.92;
      for (const b of this.myBuildings()) {
        if (b.buildProgress !== undefined && b.buildProgress < 0.999) continue;
        const f = b.hp / Math.max(1, b.maxHp);
        if (f < worstFrac) { worstFrac = f; worst = b; }
      }
      if (worst) {
        const crew = this.idleVillagers().slice(0, 2);
        if (crew.length) {
          g.orderRepair(crew, worst);
          this.repairAt = g.time + 6;
        }
      }
    }
  }

  /* ---------------- court ---------------- */
  /** Appoint what can be appointed, and spend writs at the right moment. */
  manageCourtOffices(st, age) {
    const g = this.game;
    if (!g.court) return;
    /* appointments: one per decision, so the court fills over a few seconds */
    const cands = g.court.candidate(this.team);
    for (const [id, unit] of Object.entries(cands)) {
      if (g.court.canAppoint(this.team, id, unit)) continue;
      const res = g.court.appoint(this.team, id, unit);
      if (res.ok) break;
    }
    /* writs, in the order a general would use them */
    const army = this.militaryUnits();
    if (this.armyState === 'attack' && army.length >= 6) {
      const w = g.court.writ(this.team, 'marshal');
      if (w && w.ready) g.court.useWrit(this.team, 'marshal', null);
    }
    const wounded = army.filter((u) => u.hp < u.maxHp * 0.55).length;
    if (wounded >= Math.max(3, army.length * 0.35)) {
      const w = g.court.writ(this.team, 'hierophant');
      if (w && w.ready) g.court.useWrit(this.team, 'hierophant', null);
    }
    if (age >= 1 && this.countUnits('villager') >= 10) {
      const w = g.court.writ(this.team, 'chancellor');
      if (w && w.ready) g.court.useWrit(this.team, 'chancellor', null);
    }
    if (this.huntTarget && !this.huntTarget.dead) {
      const w = g.court.writ(this.team, 'spymaster');
      if (w && w.ready) g.court.useWrit(this.team, 'spymaster', this.huntTarget);
    }
  }

  manageCourt(st, age) {
    this.manageCourtOffices(st, age);
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
      // Surplus stone is dead weight -- unless it is the wonder we are saving
      // for. In Wonder Race the AI must not sell the very thing it needs.
      const savingForWonder = g.mode === 'wonder' && this.count('wonder') === 0;
      if (!savingForWonder && st.res.stone > 700 && st.res.gold < 300) g.marketTrade(this.team, 'stone', 200, false);
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
    /* Wonder Race: stone is the gate on the win condition, so it stops being
       a leftover and becomes the priority from Castle Age on. */
    if (this.game.mode === 'wonder' && this.count('wonder') === 0 && age >= 2) {
      want.stone += 4;
      want.food = Math.max(1, want.food - 2);
      want.wood = Math.max(1, want.wood - 1);
    }
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
    /* ---- the council's answer, built before the standard order ----
       If the enemy has a legend, the answer is a monastery and monks; if he
       is turtling, a siege workshop. These are cheap detours compared to the
       cost of answering a legend with spearmen for ten minutes. */
    const plan = this.plan || {};
    if (plan.role === 'monk' && age >= 2 && this.count('monastery') === 0) {
      if (this.tryBuild('monastery', st)) return;
    }
    if (plan.siege && age >= 2 && this.count('siege_workshop') === 0) {
      if (this.tryBuild('siege_workshop', st)) return;
    }
    if (plan.role === 'archer' && age >= 1 && this.count('archery_range') === 0) {
      if (this.tryBuild('archery_range', st)) return;
    }
    if (plan.role === 'knight' && age >= 1 && this.count('stable') === 0) {
      if (this.tryBuild('stable', st)) return;
    }
    /* supply: a raid that walks past its tents breaks. The AI keeps a forward
       tent on the road to the enemy and a second behind it, so its armies can
       hold ground a whole map from the town centre. */
    if (this.manageSupply(st, age)) return;
    // a town centre if we somehow lost ours
    if (this.count('town_center') === 0) {
      if (this.tryBuild('town_center', st)) return;
    }
    /* Wonder Race: the AI has to actually race, or the mode is a formality.
       It commits the moment it can pay the whole bill -- a wonder left half
       built is a thousand stone of nothing. */
    if ((g.mode === 'wonder' || g.victory === 'wonder') && age >= 3 && this.count('wonder') === 0) {
      const cost = g.buildingCost('wonder', this.team);
      if (st.res.stone >= (cost.stone || 0) && st.res.gold >= (cost.gold || 0) && st.res.wood >= (cost.wood || 0)) {
        if (this.tryBuild('wonder', st)) return;
      }
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

  /** One forward tent at ~42 % of the road, a second at ~72 %. */
  manageSupply(st, age) {
    const g = this.game;
    if (age < 1) return false;
    if ((this.supplyAt || 0) > g.time) return false;
    if (this.militaryUnits().length < 8) return false;
    const tents = this.myBuildings().filter((b) => b.type === 'supply_tent');
    if (tents.length >= 2) return false;
    const cost = g.buildingCost('supply_tent', this.team);
    if (!g.canAfford(this.team, cost)) return false;
    const eb = this.enemyBase || { x: -this.base.x, z: -this.base.z };
    const frac = tents.length === 0 ? 0.42 : 0.72;
    const tx = this.base.x + (eb.x - this.base.x) * frac;
    const tz = this.base.z + (eb.z - this.base.z) * frac;
    const spot = g.freeSpotNear(tx, tz, { radius: 1.2, def: { size: 2.4 } }, 16);
    if (!spot) { this.supplyAt = g.time + 30; return false; }
    const b = g.placeBuilding('supply_tent', this.team, spot[0], spot[1], {});
    if (!b) { this.supplyAt = g.time + 30; return false; }
    const builders = this.pickBuilders(1);
    if (builders.length) g.orderBuild(builders, b);
    this.supplyAt = g.time + 25;
    return true;
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
      const phase = this.rng() * Math.PI * 2;
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

  /* ---------------- the war council ---------------- */
  /**
   * Count what the enemy has been seen fielding, and what it is building.
   * "Seen" is honest: only enemy units within 44 m of one of this AI's own
   * units or buildings count. The AI has to scout to counter, exactly like
   * the player, and a hidden build-up stays hidden.
   *
   * Refreshed every 8 s -- this is a strategic read, not a tactical one.
   */
  readEnemy() {
    const g = this.game;
    if (this.census && g.time - this.censusAt < 8) return this.census;
    const c = { infantry: 0, archer: 0, cavalry: 0, siege: 0, monk: 0, elite: 0, legend: 0, total: 0, towers: 0, roofs: 0 };
    const mine = [];
    for (const u of g.units) if (!u.dead && u.team === this.team && !u.garrisoned) mine.push(u);
    for (const b of g.buildings) if (!b.dead && b.team === this.team) mine.push(b);
    const R2 = 44 * 44;
    for (const u of g.units) {
      if (u.dead || u.garrisoned || u.wild || !g.isHostile(this.team, u.team)) continue;
      let seen = false;
      for (let i = 0; i < mine.length; i++) {
        const m = mine[i];
        const dx = m.x - u.x, dz = m.z - u.z;
        /* a roof sees a little further than a man on foot */
        const r2 = m.kind === 'building' ? 30 * 30 : R2;
        if (dx * dx + dz * dz <= r2) { seen = true; break; }
      }
      if (!seen) continue;
      c.total++;
      const cls = u.def.classes || [];
      if (cls.includes('monk')) c.monk++;
      else if (u.def.siege) c.siege++;
      else if (cls.includes('cavalry')) c.cavalry++;
      else if (cls.includes('archer')) c.archer++;
      else if (cls.includes('infantry')) c.infantry++;
      if ((u.rank || 0) >= 2 || (u.renown || 0) >= 2) c.elite++;
      if ((u.renown || 0) >= 4) c.legend++;
    }
    for (const b of g.buildings) {
      if (b.dead || !g.isHostile(this.team, b.team)) continue;
      c.roofs++;
      if (b.def.tower || b.type === 'watch_tower' || b.type === 'castle') c.towers++;
    }
    this.census = c;
    this.censusAt = g.time;
    this.decidePlan(c);
    return c;
  }

  /**
   * The strategic answer. Each rule names the threat it is answering, so a
   * player who watches the AI's army change can infer that they were read.
   */
  decidePlan(c) {
    const plan = { role: null, why: '', siege: 0, defend: 0 };
    if (!c.total) { plan.why = 'no contact'; this.plan = plan; return plan; }
    const share = (n) => n / Math.max(1, c.total);
    /* A legend is not a soldier; a line of spears will not kill him and
       feeding him more spears is how a match is lost. Monks convert what
       cannot be killed, and archers mass fire faster than a banner heals. */
    if (c.legend > 0) { plan.role = 'monk'; plan.why = 'legend on the field'; }
    else if (share(c.cavalry) >= 0.30) { plan.role = 'spear'; plan.why = 'cavalry-heavy enemy'; }
    else if (share(c.archer) >= 0.32) { plan.role = 'skirmisher'; plan.why = 'archer-heavy enemy'; }
    else if (share(c.infantry) >= 0.46) { plan.role = 'archer'; plan.why = 'infantry-heavy enemy'; }
    else if (c.elite >= 3) { plan.role = 'archer'; plan.why = 'enemy veterans'; }
    else if (c.siege > 0) { plan.role = 'knight'; plan.why = 'enemy siege train'; }
    /* siege is a building question, not a unit question */
    if (c.towers >= 3 || c.roofs >= 18) plan.siege = 1;
    this.plan = plan;
    return plan;
  }

  /** What this AI would like to train next, as a role. */
  wantedRole() {
    const c = this.readEnemy();
    if (!c || c.total < 2) return null;
    return this.plan.role;
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

    /* ---- siege: walls do not fall to spears ----
       Once the council sees towers or a real town, it wants engines. Two is
       enough for a raid; four is an army that can actually take a castle. */
    if (this.plan && this.plan.siege) {
      const workshop = this.find('siege_workshop');
      const engines = this.countUnits('ram') + this.countUnits('mangonel') + this.countUnits('bombard_cannon') + this.countUnits('trebuchet');
      const wantEngines = this.plan.role === 'monk' ? 2 : 4;
      if (workshop && workshop.buildProgress >= 1 && workshop.queue.length < 1 && engines < wantEngines && !this.ageReserve(st, age)) {
        for (const t of ['ram', 'mangonel', 'bombard_cannon', 'trebuchet']) {
          if (!UNIT_DEFS[t] || !workshop.def.trains || !workshop.def.trains.includes(t)) continue;
          const cost = this.game.unitCost(t, this.team);
          if (this.affordableWithReserve(st, age, cost)) { workshop.queueUnit(t); break; }
        }
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
    /* winter is not a season for new mouths: the AI still trains, but only
       when the stores are deep enough to carry it to spring */
    if (this.winterRation) {
      const st = this.game.teams.get(this.team);
      if (st && st.res.food < 220) return null;
    }
    const st = this.game.teams.get(this.team);
    const role = this.wantedRole();
    const roleTypes = role ? ROLE_UNITS[role] || [] : [];
    const options = building.def.trains.filter((t) => {
      if (isUnique(t) && this.civ.unique !== t) return false;
      if (UNIT_DEFS[t].classes.includes('monk') && role !== 'monk') return false;
      return true;
    });
    if (!options.length) return null;
    // prefer units we do not have too many of
    const counts = new Map();
    for (const u of this.game.units) if (!u.dead && u.team === this.team) counts.set(u.type, (counts.get(u.type) || 0) + 1);
    options.sort((a, b) => {
      /* the council's request comes first; the usual "least of" rule only
         decides between units that answer it equally well */
      const ra = roleTypes.includes(a) ? 0 : 1;
      const rb = roleTypes.includes(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (counts.get(a) || 0) - (counts.get(b) || 0);
    });
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
    if (g.startAgeAdvance(this.team).ok) {
      this.log.push(['age', this.game.time | 0, next]);
      this.savedForAge = false;
    }
  }

  /* ---------------- who is the enemy? ----------------
     With two crowns the answer is obvious. With four it is the most
     important decision the AI makes: attack the neighbour who is winning
     and you hand the island to the far one, attack the weak and the strong
     eat you. The rule is a real one -- score every rival on how close it is,
     how much army it has, and whether it has recently been in your fields --
     then campaign against the worst of them for a couple of minutes before
     thinking again, so the army is not marched back and forth. */
  chooseFoe() {
    const g = this.game;
    if (!g.teamIds || g.teamIds.length <= 2) {
      this.foe = g.teamIds ? g.teamIds.find((t) => t !== this.team) || null : 2;
      this.enemyBase = g.baseOf ? g.baseOf(this.foe) : g.world.enemyBase;
      return this.foe;
    }
    let best = null, bestScore = -Infinity;
    for (const t of g.teamIds) {
      if (t === this.team) continue;
      if (g.fallenTeams && g.fallenTeams.has(t)) continue;
      const seat = g.baseOf(t);
      if (!seat) continue;
      const d = Math.hypot(seat.x - this.base.x, seat.z - this.base.z);
      let army = 0, buildings = 0;
      for (const u of g.units) if (!u.dead && u.team === t && u.def.attack > 0) army++;
      for (const b of g.buildings) if (!b.dead && b.team === t) buildings++;
      /* A competent commander does not march on the strongest enemy for its
         own sake. The old rule scored strength *positively*, so the AI spent
         every match attacking the one crown it could not beat and left the
         weak one alone to grow -- four equal AIs stalemated for half an hour
         because of it. The rule now is:
           - close is cheap;
           - a crown I outmatch is a crown I can actually take;
           - a crown that has been raiding me has earned a reply;
           - and a runaway leader must be stopped *before* it is unbeatable,
             even if that means fighting uphill. */
      const score = this.foeScore(t, d, { army, buildings });
      if (score > bestScore) { bestScore = score; best = t; }
    }
    this.foe = best || this.foe || 2;
    this.enemyBase = g.baseOf(this.foe);
    return this.foe;
  }

  /**
   * How attractive a rival is as the next campaign, as one number.
   * Pure and side-effect free so the strategy can be tested on its own.
   */
  foeScore(team, d, seen = { army: 0, buildings: 0 }) {
    const g = this.game;
    let score = 58 - d * 0.18;                      // distance is logistics
    const myArmy = this.militaryUnits().length;
    score += (myArmy - (seen.army || 0)) * 0.85;    // a crown I outmatch is takeable
    let rival = 0;
    if (g.scoreOf) rival = g.scoreOf(team);
    const mine = g.scoreOf ? g.scoreOf(this.team) : 0;
    /* the leader must be stopped before it is unbeatable. Compare armies,
       not scores: a score is a ledger, an army is what marches. */
    const theirArmy = seen.army || 0;
    if (theirArmy > Math.max(6, myArmy * 1.45)) score += 30;        // stop the runaway
    else if (myArmy > 3 && theirArmy < myArmy * 0.6) score += 10;   // finish the weak
    if (g.realm && g.realm.state(team) && g.realm.state(team).commons < 25) score += 12;
    if (this.raidedBy && this.raidedBy.has(team)) score += 18;
    if (this.foe === team) score += 14;              // stay the course
    return score;
  }

  /* ---------------- target value ---------------- */
  /** How much a single enemy unit is worth hunting. Renown is a big part of
      it: a Legend is not a soldier, it is a banner, and the AI knows that a
      legend left alone for a minute turns a skirmish into a rout. */
  threatOf(u) {
    let t = unitThreat(u);
    if (this.game.elites) t *= this.game.elites.bounty(u);
    return t;
  }

  /** The enemy unit this AI would most like to delete, and why. */
  eliteTargets() {
    const g = this.game;
    const out = [];
    for (const u of this.game.units) {
      if (u.dead || u.team === 0 || u.wild || !g.isHostile(this.team, u.team)) continue;
      if (this.threatOf(u) >= 4) out.push(u);
    }
    return out;
  }

  /* ---------------- the hunt ----------------
     A small, fast squad whose only job is to kill a high-value enemy. It
     ignores buildings, re-targets every time the mage moves, refuses to
     form while it is outnumbered, and disbands the moment the mage dies.
     If the target is a human player's mage, the player is told: a threat
     you never see is not a strategy, it is a dice roll. */
  /** A veteran at death's door is walked home, not spent. */
  manageWounded(army) {
    const g = this.game;
    if ((this.retreatAt || 0) > g.time) {
      /* still clear the men who have recovered */
    }
    let sent = 0;
    if ((this.retreatAt || 0) <= g.time) {
      for (const u of army) {
        if (u.dead || (u.rank || 0) < 2) continue;
        if (u.hp > u.maxHp * 0.34) continue;
        if (u.aiRole === 'retreat') continue;
        if (sent >= 2) break;
        u.aiRole = 'retreat';
        u.target = null;
        u.state = STATE.MOVE;
        u.moveTo(this.base.x + (this.rng() - 0.5) * 6, this.base.z + (this.rng() - 0.5) * 6, true);
        sent++;
      }
      if (sent) this.retreatAt = g.time + 5;
    }
    for (const u of army) {
      if (u.aiRole !== 'retreat') continue;
      if (u.dead || u.hp > u.maxHp * 0.75 || Math.hypot(u.x - this.base.x, u.z - this.base.z) < 9) u.aiRole = null;
    }
  }

  manageHunt(army) {
    const g = this.game;
    if (this.aggression < 0.45) return;
    this.hunt = this.hunt.filter((u) => !u.dead);
    const elites = this.eliteTargets();

    if (!elites.length) {
      for (const u of this.hunt) if (u.aiRole === 'hunt') u.aiRole = null;
      this.hunt.length = 0;
      this.huntTarget = null;
      return;
    }
    if (g.time < this.huntCooldown) {
      for (const u of this.hunt) if (u.aiRole === 'hunt') u.aiRole = null;
      this.hunt.length = 0;
      return;
    }

    /* score: threat first, then isolation — a mage alone is a gift, a mage
       behind six spearmen is a trap */
    let best = null;
    let bestScore = -Infinity;
    for (const e of elites) {
      let guards = 0;
      for (const f of g.units) {
        if (f === e || f.dead || f.team !== e.team) continue;
        if (dist2(f.x, f.z, e.x, e.z) < 121) guards++;
      }
      let nearest = Infinity;
      for (const f of army) {
        const d = dist2(f.x, f.z, e.x, e.z);
        if (d < nearest) nearest = d;
      }
      const score = unitThreat(e) * 26 - Math.min(guards, 16) * 8 - Math.sqrt(nearest) * 0.8;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (!best) return;
    if (this.huntTarget !== best) {
      this.huntTarget = best;
      this.huntWarnAt = 0;
    }
    const threat = unitThreat(best);
    const want = Math.min(9, 2 + Math.floor(threat / 2) + Math.floor(g.time / 240));

    /* A squad needs a chance: count the target's *bodyguards*, not the map.
       Only men who can fight are a shield -- counting villagers would make a
       mage standing in his own town permanently unattackable, which is the
       one place a player is most likely to park it. */
    let guards = 0;
    for (const f of g.units) {
      if (f === best || f.dead || f.team !== best.team) continue;
      if (!f.def || !(f.def.attack > 0)) continue;
      if (dist2(f.x, f.z, best.x, best.z) < 144) guards++;
    }
    const free = army.filter((u) => (!u.aiRole || u.aiRole === 'wave') && this.hunt.indexOf(u) < 0);
    while (this.hunt.length < want && free.length) {
      /* cavalry first (a hunt is a chase), then the men who have done this
         before -- but never a crippled elite, whose death would cost more
         than the kill would win */
      const sscore = (u) => (u.def.classes.includes('cavalry') ? 0 : 2)
        + Math.sqrt(dist2(u.x, u.z, best.x, best.z)) * 0.01
        - (u.rank || 0) * 0.35
        + ((u.rank || 0) >= 2 && u.hp < u.maxHp * 0.5 ? 1.6 : 0);
      let pick = 0;
      for (let i = 1; i < free.length; i++) if (sscore(free[i]) < sscore(free[pick])) pick = i;
      const u = free.splice(pick, 1)[0];
      this.hunt.push(u);
    }

    /* The squad is not strong enough to take the guards yet. It does not sit
       at home waiting: it *stages* -- walks to a ring 18-24 m out from the
       target and holds there, so the moment the odds improve it is already
       on top of the mage instead of forty seconds of walking away. */
    const assault = this.hunt.length >= Math.min(want, 2) && this.hunt.length * 2.2 >= guards;
    if (!assault) {
      for (const u of this.hunt) {
        u.aiRole = 'hunt';
        if (u.target) { u.target = null; }
        if (u.state !== STATE.IDLE && u.state !== STATE.MOVE) continue;
        const d = Math.hypot(u.x - best.x, u.z - best.z);
        if (d > 26 || u.state === STATE.IDLE) {
          /* moveTo sets the path; the state is what makes updateMove run it.
             Without this line the squad stood on the spot forever -- a real
             bug, and the reason the hunt had to be tested end to end. */
          const a = Math.atan2(u.z - best.z, u.x - best.x) + (this.rng() - 0.5) * 0.6;
          const r = 20 + this.rng() * 4;
          u.state = STATE.MOVE;
          u.moveTo(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r, true);
        }
      }
      return;
    }

    for (const u of this.hunt) {
      u.aiRole = 'hunt';
      u.noAggro = false;
      if (u.target !== best || (u.state !== STATE.ATTACK && u.state !== STATE.MOVE)) {
        u.target = best;
        u.state = STATE.ATTACK;
        u.unreachable = false;
      }
    }

    if (best.team === g.playerTeam && g.time - this.huntWarnAt > 24 && this.hunt.length >= 2) {
      this.huntWarnAt = g.time;
      const name = (best.def && best.def.name) || 'wizard';
      g.notify(`${this.hunt.length} enemy riders are hunting your ${name}`, 'bad');
    }

    /* losing the squad is not a reason to keep feeding it */
    const survivors = this.hunt.filter((u) => u.hp > u.maxHp * 0.28).length;
    if (survivors <= 1 && want >= 3) {
      this.huntCooldown = g.time + 14;
      for (const u of this.hunt) {
        if (u.dead) continue;
        u.aiRole = null;
        u.target = null;
        u.state = STATE.MOVE;
        u.moveTo(this.base.x + (this.rng() - 0.5) * 10, this.base.z + (this.rng() - 0.5) * 10, true);
      }
      this.hunt.length = 0;
    }
  }

  /* ---------------- fast raids ----------------
     Two or three fast units, sent early, at the economy or at a lone hero.
     They are cheap enough to lose and annoying enough that the player has to
     answer them — which is the point: an opponent that only ever attacks in
     one big wave is a metronome, not an enemy. */
  manageRaids(army) {
    const g = this.game;
    if (this.aggression < 0.5 || g.time < 55) return;
    /* keep an existing raid pointed at a target that still exists */
    this.raidUnits = this.raidUnits.filter((u) => !u.dead);
    if (this.raidUnits.length && g.time > this.raidRefresh) {
      this.raidRefresh = g.time + 8;
      const goal = this.pickRaidGoal();
      this.raidGoal = goal;
      for (const u of this.raidUnits) {
        if (u.aiRole !== 'raid') continue;
        if (goal && (u.state === STATE.IDLE || !u.target) && !u.unreachable) {
          u.state = STATE.ATTACK_MOVE;
          u.noAggro = false;
          u.moveTo(goal.x + (this.rng() - 0.5) * 7, goal.z + (this.rng() - 0.5) * 7, true);
        }
      }
    }
    if (this.raidTimer > 0) return;
    const want = Math.min(6, 2 + Math.floor((g.time - 55) / 170));
    const pool = army.filter((u) => !u.aiRole || u.aiRole === 'wave');
    /* never strip the home defence bare */
    if (pool.length < want + 4 || army.length < want + 5) return;
    const goal = this.pickRaidGoal();
    if (!goal) return;
    pool.sort((a, b) => (a.def.classes.includes('cavalry') ? 0 : 1) - (b.def.classes.includes('cavalry') ? 0 : 1));
    const raid = pool.slice(0, want);
    for (const u of raid) {
      u.aiRole = 'raid';
      u.target = null;
      u.noAggro = false;
      u.state = STATE.ATTACK_MOVE;
      u.moveTo(goal.x + (this.rng() - 0.5) * 7, goal.z + (this.rng() - 0.5) * 7, true);
    }
    this.raidUnits = raid;
    this.raidGoal = goal;
    this.raidRefresh = g.time + 8;
    this.raidTimer = Math.max(18, (58 - this.aggression * 30) / Math.max(0.5, this.mood || 1));
  }

  /** Raiders want a worker, a wizard, or failing that a wall. */
  pickRaidGoal() {
    const g = this.game;
    let best = null;
    let bestScore = -Infinity;
    for (const u of g.units) {
      if (u.dead || u.team === 0 || u.wild || !g.isHostile(this.team, u.team)) continue;
      let score = 10;
      if (u.def.classes.includes('villager')) score += 16;
      const th = unitThreat(u);
      if (th >= 4) score += 50 + th * 4;
      score -= Math.sqrt(dist2(u.x, u.z, this.base.x, this.base.z)) * 0.30;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    if (best) return best;
    for (const b of g.buildings) {
      if (b.dead || b.team === 0 || !g.isHostile(this.team, b.team)) continue;
      const score = 8 - Math.sqrt(dist2(b.x, b.z, this.base.x, this.base.z)) * 0.28;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  /* ---------------- the realm ----------------
     The AI has the same two estates and the same two ways to break, so it
     has to play the same game the player does: price its taxes, throw a
     feast when the commons are close to the line, and put down its own
     risings before they cost it a hall. It is deliberately not perfect --
     it reacts when the bar is already low, the way a player does. */
  manageRealm(st, age) {
    const g = this.game;
    const realm = g.realm;
    if (!realm) return;
    const s = realm.state(this.team);
    if (!s || s.empty) return;
    const gold = st.res.gold || 0;

    /* tax: fund the war when the bank is thin, relent before the villages
       boil over. The thresholds leave a band where it simply leaves it. */
    let wantTax = 'fair';
    if (gold < 120 && s.commons > 56) wantTax = 'heavy';
    else if (gold > 420 && s.commons < 60) wantTax = 'merciful';
    else if (s.commons < 40) wantTax = 'merciful';
    if (wantTax !== s.tax) realm.setTax(this.team, wantTax);

    /* the two ways to buy goodwill -- only when the bar is genuinely low,
       and only when the spend does not starve the army */
    if (s.commons < 33 && s.feastCd <= 0 && gold > 260 && (st.res.food || 0) > 220) {
      const r = realm.feast(this.team);
      if (r.ok) this.log.push(['feast', g.time | 0, Math.round(s.commons)]);
    }
    if (s.nobles < 33 && s.endowCd <= 0 && gold > 320) {
      const r = realm.endow(this.team);
      if (r.ok) this.log.push(['endow', g.time | 0, Math.round(s.nobles)]);
    }

    /* A rising is an emergency, not a raid. Everything home is thrown at the
       mob before it reaches a hall: rebels burn buildings, and buildings are
       the one thing an AI cannot rebuild fast enough to ignore. */
    let rebel = null, rebelD = Infinity;
    for (const u of g.units) {
      if (u.dead || !u.isRebel || u.rebelAgainst !== this.team) continue;
      const d = dist2(u.x, u.z, this.base.x, this.base.z);
      if (d < rebelD) { rebelD = d; rebel = u; }
    }
    if (rebel && rebelD < 60 * 60) {
      this.rebelAlert = { x: rebel.x, z: rebel.z, t: g.time };
      const army = this.militaryUnits();
      for (const u of army) {
        if (u.aiRole === 'hunt') continue;
        if (dist2(u.x, u.z, this.base.x, this.base.z) > 46 * 46) continue;
        u.aiRole = 'defend';
        if (u.target !== rebel) {
          u.target = rebel;
          u.state = STATE.ATTACK;
          u.noAggro = false;
        }
      }
    }
  }

  /* ---------------- military ---------------- */
  manageMilitary(st, age) {
    const g = this.game;
    const army = this.militaryUnits();
    const enemyBase = this.enemyBase;
    const base = this.base;

    /* 1. home defence. The most *dangerous* intruder wins, not the nearest:
       a mage or a ram behind your woodline matters more than a scout. */
    const intruders = [];
    for (const u of g.units) {
      if (u.dead || u.team === 0 || u.wild || !g.isHostile(this.team, u.team)) continue;
      if (dist2(u.x, u.z, base.x, base.z) < 34 * 34) intruders.push(u);
    }
    if (intruders.length && army.length) {
      intruders.sort((a, b) => (unitThreat(b) - unitThreat(a)) ||
        (dist2(a.x, a.z, base.x, base.z) - dist2(b.x, b.z, base.x, base.z)));
      const worst = intruders[0];
      for (const u of army) {
        if (u.aiRole === 'hunt') continue;      // a hunt already has a job
        u.aiRole = 'defend';
        if (u.target !== worst) {
          u.target = worst;
          u.state = STATE.ATTACK;
          u.noAggro = false;
          u.unreachable = false;
        }
      }
      if (worst.team === g.playerTeam && unitThreat(worst) >= 5 && g.time - this.huntWarnAt > 30) {
        this.huntWarnAt = g.time;
        g.notify('That caster is standing in your base — everything is on it', 'warn');
      }
      this.armyState = 'defend';
      return;
    }
    for (const u of army) if (u.aiRole === 'defend') u.aiRole = null;

    /* 2. the standing bounty, then 3. the raid clock */
    this.manageHunt(army);
    this.manageRaids(army);
    this.manageWounded(army);

    /* the line: everything that is not already hunting or raiding */
    const waveUnits = army.filter((u) => !u.aiRole || u.aiRole === 'wave');

    /* how much of the enemy's army is actually at home? A crown whose host is
       away raiding is a crown with an open gate, and a commander who cannot
       see that is not a commander -- this is the opening the AI takes. */
    let foeHome = 0;
    for (const u of g.units) {
      if (u.dead || u.team !== this.foe || !u.def || u.def.attack <= 0) continue;
      if (u.def.classes.includes('villager')) continue;
      if (dist2(u.x, u.z, enemyBase.x, enemyBase.z) < 42 * 42) foeHome++;
    }
    this.foeHome = foeHome;
    /* wave timing */
    const ready = army.length >= Math.min(this.diff.maxArmy, 5 + Math.floor((g.time - this.diff.firstWave) / this.diff.waveEvery) * 3);
    const opportunistic = !!(this.plan && this.plan.why && foeHome <= 4 && waveUnits.length >= 6 && g.time > this.diff.firstWave + 45);
    const canAttack = g.time > this.diff.firstWave &&
      (this.attackTimer <= 0 || (ready && this.armyState !== 'attack') || opportunistic);

    if (canAttack && waveUnits.length >= 4) {
      /* ---- staging ---- 
         An army that walks at the enemy town one unit at a time is defeated
         in detail: the defender's whole garrison meets each man as he
         arrives. So the wave first forms up at a staging ground a short march
         from the town, waits for most of its strength to gather (or 18 s,
         whichever comes first), and only then goes in as one body. */
      const dx = enemyBase.x - base.x, dz = enemyBase.z - base.z;
      const len = Math.hypot(dx, dz) || 1;
      const stand = Math.max(26, Math.min(46, len * 0.32));
      this.staging = {
        x: enemyBase.x - (dx / len) * stand,
        z: enemyBase.z - (dz / len) * stand,
        until: g.time + 18,
        strength: waveUnits.length
      };
      this.armyState = 'stage';
      this.waveStrength = waveUnits.length;
      for (const u of waveUnits) {
        u.aiRole = 'stage';
        u.target = null;
        u.noAggro = false;
        u.state = STATE.ATTACK_MOVE;
        u.moveTo(this.staging.x + (this.rng() - 0.5) * 12, this.staging.z + (this.rng() - 0.5) * 12, true);
      }
      return;
    }

    if (this.armyState === 'stage' && this.staging) {
      const st2 = this.staging;
      let arrived = 0;
      for (const u of waveUnits) {
        if (u.aiRole !== 'stage') continue;
        if ((u.x - st2.x) ** 2 + (u.z - st2.z) ** 2 < 14 * 14) arrived++;
      }
      const enough = arrived >= Math.max(3, st2.strength * 0.6);
      if (enough || g.time >= st2.until || waveUnits.length < 3) {
        /* go in as one body */
        this.armyState = 'attack';
        this.attackTimer = this.diff.waveEvery;
        this.lastAttackTime = g.time;
        this.waveStrength = waveUnits.length;
        this.lastWaveSeen = g.time;
        /* the hall first: a war of crowns is decided by which halls still
           stand, so the engines go for the town centre and the line follows */
        const target = g.enemyHall(this.team, enemyBase.x, enemyBase.z, 44)
          || g.nearestEnemyStructure({ x: enemyBase.x, z: enemyBase.z, team: this.team }, this.team, 40);
        for (const u of waveUnits) {
          u.aiRole = 'wave';
          if (target && u.def.classes.includes('siege')) {
            u.state = STATE.ATTACK;
            u.target = target;
            u.noAggro = false;
            continue;
          }
          u.state = STATE.ATTACK_MOVE;
          u.target = null;
          u.noAggro = false;
          u.moveTo(enemyBase.x + (this.rng() - 0.5) * 16, enemyBase.z + (this.rng() - 0.5) * 16, true);
        }
        this.staging = null;
      } else {
        /* stragglers keep walking to the colours */
        for (const u of waveUnits) {
          if (u.aiRole !== 'stage') continue;
          if (u.state === STATE.IDLE) {
            u.state = STATE.ATTACK_MOVE;
            u.moveTo(st2.x + (this.rng() - 0.5) * 10, st2.z + (this.rng() - 0.5) * 10, true);
          }
        }
      }
      return;
    }

    if (this.armyState === 'attack') {
      /* keep the push alive: refresh orders for stragglers */
      if (g.time - this.lastAttackTime > 9) {
        this.lastAttackTime = g.time;
        const alive = waveUnits.length;
        /* a wave that has lost most of its strength pulls back to reform;
           feeding a broken army into a town is how the old AI threw games */
        const broken = this.waveStrength && alive < Math.max(3, this.waveStrength * 0.45);
        /* ...but a wave that is winning does not walk home. If the defenders
           at the hall are down to almost nothing, press the advantage: this
           is the difference between a war that grinds for an hour and one
           that is decided when the enemy's army dies. */
        const guard = g.buildings.filter((b) => !b.dead && b.team === this.foe && b.def.ageAdvance);
        let foesLeft = 0;
        for (const u of g.units) {
          if (u.dead || u.team !== this.foe || !u.def || u.def.attack <= 0) continue;
          if (u.def.classes.includes('villager')) continue;
          for (const h of guard) {
            if (dist2(u.x, u.z, h.x, h.z) < 34 * 34) { foesLeft++; break; }
          }
        }
        const pressing = alive >= 6 && foesLeft <= Math.max(2, alive * 0.5);
        if ((alive < 3 || broken) && !pressing) {
          this.armyState = 'gather';
          this.staging = null;
          this.attackTimer = Math.max(20, this.diff.waveEvery * 0.5);
          for (const u of army) {
            if (u.aiRole === 'hunt' || u.aiRole === 'raid') continue;
            u.aiRole = null;
            u.target = null;
            u.state = STATE.MOVE;
            u.moveTo(base.x + (this.rng() - 0.5) * 10, base.z + (this.rng() - 0.5) * 10, true);
          }
        } else {
          for (const u of waveUnits) {
            /* A soldier that reported "no way through" is standing outside a
               wall. Put it to work on the wall: an AI army that politely stops
               at a palisade is not an opponent. */
            if (u.unreachable) {
              u.unreachable = false;
              const wall = g.nearestEnemyStructure(u, this.team, 30);
              if (wall) {
                u.state = STATE.ATTACK;
                u.target = wall;
                u.noAggro = false;
                continue;
              }
            }
            if (u.state === STATE.IDLE) {
              u.state = STATE.ATTACK_MOVE;
              u.moveTo(enemyBase.x + (this.rng() - 0.5) * 14, enemyBase.z + (this.rng() - 0.5) * 14, true);
            }
          }
        }
      }
      return;
    }

    /* gather phase: idle army regroups near the base */
    if (army.length) {
      for (const u of army) {
        if (u.state === STATE.IDLE && (!u.aiRole || u.aiRole === 'wave')) {
          u.aiRole = null;
          const a = this.rng() * Math.PI * 2;
          const r = 6 + this.rng() * 7;
          u.state = STATE.MOVE;
          u.moveTo(base.x + Math.cos(a) * r, base.z + Math.sin(a) * r, true);
        }
      }
    }
  }
}

/* A unit's worth as a target. Mods publish `def.threat`; the classes below
   are the built-in hints, so a base-game siege engine is worth killing before
   a spearman even without a mod in the session. */
const CLASS_THREAT = { caster: 4, siege: 2, unique: 2 };
export function unitThreat(u) {
  if (!u || u.dead || !u.def) return 0;
  let t = u.def.threat || 0;
  const cls = u.def.classes;
  if (cls) {
    for (let i = 0; i < cls.length; i++) {
      const v = CLASS_THREAT[cls[i]];
      if (v && v > t) t = v;
    }
  }
  if (u.def.hero) t += 2;
  /* an officer of the enemy court is worth more than the unit carrying the
     office: killing the Marshal is how you break an army's spine */
  if (u.courtOffice) t += 3;
  /* a chevron is worth more than a body: veterans are the enemy's future */
  t += (u.rank || 0) * 1.6;
  /* renown: a man who has survived long enough to earn a name is worth more
     than the man who has not, because he is standing proof that shooting him
     does not work */
  t += (u.renown || 0) * 1.2;
  /* a caster is not a unit, it is a *threat curve*. A rank 6 mage can
     delete a town centre once a day, so the bounty on its head has to grow
     faster than its rank: threat is the AI's whole vocabulary for "kill this
     now", and a linear scale would leave the Ascendant priced like a knight. */
  if (u.def.threat) {
    const caster = !!(u.def.classes && (u.def.classes.includes('caster') || u.def.classes.includes('magic')));
    if (caster) {
      const tier = u.modState && u.modState.arcane ? (u.modState.arcane.rank || 1) : 1;
      t += Math.max(0, tier - 1) * 2.2;
    }
  }
  return t;
}

function isUnique(type) {
  return ['axeman', 'longbowman', 'cataphract', 'huskarl', 'war_elephant', 'samurai', 'mangudai', 'berserk'].includes(type);
}
