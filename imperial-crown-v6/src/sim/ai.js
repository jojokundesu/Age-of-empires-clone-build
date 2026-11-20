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
    /* A controller may be given its own council preset: the sandbox's third
       party is not run by the sandbox's own (peaceful) numbers. */
    this.diff = opts.diff || game.difficulty;
    this.aggression = opts.aggression ?? this.diff.aggression;
    /* Councils are staggered by crown. Four controllers created in the same
       frame used to think on the same frame, and their census -- which reads
       every man on the field against every man they own -- landed as a spike
       once every half second. Spacing them by crown turns a spike into four
       small bills. */
    this.timer = 0.6 + (team % 5) * 0.11 + this.rng() * 0.08;
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
    /* --- the road to the war ------------------------------------------
       Where the column is, which men are in it, what it has left behind to
       hold the town, and which way in it has picked. See `startMarch`. */
    this.line = null;
    this.muster = null;
    this.approach = null;
    this.scouts = [];
    this.scoutRider = null;
    this.scoutTimer = 0;
    this.scoutNextAt = 0;
    this.census = null;
    this.censusAt = -99;
    this.plan = { role: null, why: '', siege: 0, defend: 0 };
    // Stores only sites that one of this crown's own units or buildings saw.
    this.knownSacred = new Map();
  }

  /* ---------------- helpers ---------------- */
  myUnits() { return this.game.units.filter((u) => !u.dead && u.team === this.team); }
  myBuildings() { return this.game.buildings.filter((b) => !b.dead && b.team === this.team); }
  observers() { return this.myUnits().filter(u => !u.garrisoned).concat(this.myBuildings()); }
  sees(x, z, observers = this.observers()) {
    const g = this.game;
    for (const o of observers) {
      const sight = o.kind === 'building'
        ? (o.def.sight || 8) * (o.buildProgress >= 1 ? 1 : 0.5)
        : (o.def.sight || 9) * g.sightDayMul;
      if (dist2(o.x, o.z, x, z) <= sight * sight) return true;
    }
    return false;
  }
  // Build a temporary broad phase for strategic scans. Every observer is
  // indexed into all cells its sight circle overlaps; the final radius test
  // remains exact, so the grid never grants extra information.
  sightQuery(observers = this.observers()) {
    /* The bucket grid is sized from the world, not from the map this was
       written on. It used to be a literal 32 buckets of 16 m centred on the
       origin -- a 512 m square -- so on anything bigger every point outside
       the middle kilometre fell off the edge of the grid and the crown was
       blind there. That is what "the AI never scouts" looked like from the
       outside: it had riders, they had eyes, and the lookup said no. */
    const cell = 16;
    const half = (this.game.world && this.game.world.size ? this.game.world.size : 512) / 2;
    const n = Math.max(32, Math.ceil((half * 2) / cell) + 1);
    const buckets = new Map();
    const coord = v => Math.floor((v + half) / cell);
    for (const o of observers) {
      const radius = o.kind === 'building'
        ? (o.def.sight || 8) * (o.buildProgress >= 1 ? 1 : 0.5)
        : (o.def.sight || 9) * this.game.sightDayMul;
      const x0 = Math.max(0, coord(o.x - radius)), x1 = Math.min(n - 1, coord(o.x + radius));
      const z0 = Math.max(0, coord(o.z - radius)), z1 = Math.min(n - 1, coord(o.z + radius));
      const entry = [o, radius * radius];
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const key = z * n + x;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(entry);
      }
    }
    return (x, z) => {
      const cx = coord(x), cz = coord(z);
      if (cx < 0 || cz < 0 || cx >= n || cz >= n) return this.sees(x, z, observers);
      const bucket = buckets.get(cz * n + cx);
      if (!bucket) return false;
      for (const [o, r2] of bucket) if (dist2(o.x, o.z, x, z) <= r2) return true;
      return false;
    };
  }
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
    const decisionInterval = clamp((this.diff.reaction || 1) * 0.5, 0.35, 1);
    this.timer = decisionInterval;

    const st = g.teams.get(this.team);
    const age = st.age;

    this.foeTimer -= decisionInterval;
    if (this.foeTimer <= 0 || !this.foe) {
      this.foeTimer = 90 + this.rng() * 40;
      this.chooseFoe();
    }

    if (g.victory === 'sacred') this.manageSacredSites(st, age);

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

    // ---------- the market ----------
    this.manageMarket(st, age);

    // ---------- the sky ----------
    this.manageOmens(st, age);


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

  /* ---------------- the market ---------------- */
  /** The market turns a gold mountain into the food and timber the army
      actually eats. This used to be reached through a court-appointments
      step; the court is gone, the market is not. */
  manageMarket(st, age) {
    const g = this.game;
    const my = this.myBuildings();
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

  /** Discover sites using this crown's own sight and send monks to known sites. */
  manageSacredSites(st, age) {
    const g = this.game;
    const observers = this.observers();
    const seenAt = this.sightQuery(observers);
    for (const site of g.buildings) {
      if (site.dead || site.poiType !== 'sacred') continue;
      if (seenAt(site.x, site.z)) this.knownSacred.set(site, site.siteOwner || 0);
    }
    if (age < 2) return;
    for (const monk of observers.filter(u => u.kind === 'unit' && u.def.classes.includes('monk'))) {
      if (monk.state !== STATE.IDLE && monk.state !== STATE.MOVE) continue;
      let target = null, best = Infinity;
      for (const [site, lastOwner] of this.knownSacred) {
        if (site.dead || lastOwner === this.team) continue;
        const d = dist2(monk.x, monk.z, site.x, site.z);
        if (d < best) { target = site; best = d; }
      }
      if (!target || best <= 25) continue;
      if (monk._sacredGoal === target && monk.state === STATE.MOVE) continue;
      const spot = g.findNearestFreeTile(target.x, target.z, monk, 4);
      if (spot) { monk._sacredGoal = target; g.orderMove([monk], spot[0], spot[1]); }
    }
    const pending = [...this.knownSacred.values()].some(owner => owner !== this.team);
    if (!pending) return;
    const monastery = this.find('monastery');
    if (monastery && monastery.queue.length === 0 && this.countUnits('monk') < 2 &&
        g.canAfford(this.team, g.unitCost('monk', this.team)) && g.popFree(this.team) >= 1)
      monastery.queueUnit('monk');
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
    if ((plan.role === 'monk' || (g.victory === 'sacred' && this.knownSacred.size)) && age >= 2 && this.count('monastery') === 0) {
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
   * Only enemies inside this crown's actual unit or building sight count.
   * The AI has to scout to counter, and a hidden build-up stays hidden.
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
    const seenAt = this.sightQuery(mine);
    for (const u of g.units) {
      if (u.dead || u.garrisoned || u.wild || !g.canFight(this.team, u.team)) continue;
      if (!seenAt(u.x, u.z)) continue;
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
      if (b.dead || !g.canFight(this.team, b.team) || !seenAt(b.x, b.z)) continue;
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
    /* A town with nobody in it is still a town.
       "Contact" used to mean "an enemy *unit* I can see", so a crown whose
       army had already been destroyed and whose roofs were in plain view read
       as no contact at all: the council had nothing to answer, the siege
       decision never fired, and the AI that had just won the field sat in the
       ruins of the village it had taken because nobody told it there was
       anything there. Roofs are contact. */
    if (c.total) {
      /* a unit's own share of the enemy's fighting arms */
    } else if (!c.roofs) { plan.why = 'no contact'; this.plan = plan; return plan; }
    else { plan.why = 'roofs and nobody behind them'; }
    /* What share of the enemy's *fighting* arms is this one? Cavalry plus
       spears plus bows, not cavalry plus everything on the map. Counted
       against the total, eight knights and ten swordsmen is a 44% cavalry
       army, and the council answered it with spears -- correct by the letter
       of the rule and wrong about the battle, where the ten swordsmen are the
       thing standing in front of you. The biggest arm is the one to answer. */
    const arms = Math.max(1, c.infantry + c.archer + c.cavalry + c.siege);
    const share = (n) => n / arms;
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

    /* Military: keep a mix and never stall the barracks.
       On a road map the war bar is not `maxArmy` -- it is `maxArmy` plus the
       march surcharge, less the distance discount, and it is that number the
       council tests before it marches. Capping training at the plain
       `maxArmy` therefore made the bar literally unreachable on Large: the
       crown stopped at sixteen men in the middle of the sixteenth minute and
       sat there for the rest of the match, because the army it was told to
       wait for was eighteen. Train to whichever bar is higher. */
    const warNeed = Math.min(this.diff.maxArmy + 6,
      this.diff.maxArmy + Math.min(6, Math.round(this.marchDistance() / 400)));
    const armyTarget = Math.min(warNeed, 6 + Math.floor((g.time - 60) / 40));
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
  /* Returns true when the item can be queued *now*. There is no reserve in
     this build, so the answer is just whether the crown can pay -- the
     reserve branch below was returning true only while a reserve existed and
     false otherwise, which is how a barracks sat empty while the stores
     climbed into four figures. */
  affordableWithReserve(st, age, cost) {
    if (!this.game.canAfford(this.team, cost)) return false;
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
    const seenAt = this.sightQuery();
    let best = null, bestScore = -Infinity;
    for (const t of g.teamIds) {
      if (t === this.team) continue;
      if (g.fallenTeams && g.fallenTeams.has(t)) continue;
      const seat = g.baseOf(t);
      if (!seat) continue;
      const d = Math.hypot(seat.x - this.base.x, seat.z - this.base.z);
      let army = 0, buildings = 0;
      for (const u of g.units) if (!u.dead && !u.garrisoned && u.team === t && u.def.attack > 0 && seenAt(u.x, u.z)) army++;
      for (const b of g.buildings) if (!b.dead && b.team === t && seenAt(b.x, b.z)) buildings++;
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
   * Where the war actually is.
   *
   * `enemyBase` is the seat the map generator placed, and it does not move.
   * Once a wave has burned that hall to the ground the coordinates are a
   * field of ash, so every order drawn from them pointed at grass: the army
   * marched in, stood in the rubble, and the war ended with two crowns
   * staring at each other. The anchor is the nearest thing the rival still
   * owns -- a wall, a barracks, and failing everything, a man.
   */
  foeAnchor() {
    const g = this.game;
    const foe = this.foe;
    const seenAt = this.sightQuery();
    let best = null, bestD = Infinity;
    for (const b of g.buildings) {
      if (b.dead || b.team !== foe || !seenAt(b.x, b.z)) continue;
      const d = (b.x - this.base.x) ** 2 + (b.z - this.base.z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) return best;
    for (const u of g.units) {
      if (u.dead || u.team !== foe || u.garrisoned || !seenAt(u.x, u.z)) continue;
      const d = (u.x - this.base.x) ** 2 + (u.z - this.base.z) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /**
   * How attractive a rival is as the next campaign, as one number.
   * Pure and side-effect free so the strategy can be tested on its own.
   */
  foeScore(team, d, seen = { army: 0, buildings: 0 }) {
    let score = 58 - d * 0.18;                      // distance is logistics
    const myArmy = this.militaryUnits().length;
    score += (myArmy - (seen.army || 0)) * 0.85;    // a crown I outmatch is takeable
    /* the leader must be stopped before it is unbeatable. Compare armies,
       not scores: a score is a ledger, an army is what marches. */
    const theirArmy = seen.army || 0;
    if (theirArmy > Math.max(6, myArmy * 1.45)) score += 30;        // stop the runaway
    else if (myArmy > 3 && theirArmy < myArmy * 0.6) score += 10;   // finish the weak
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
      if (u.dead || u.team === 0 || u.wild || !g.canFight(this.team, u.team)) continue;
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

  /**
   * The small decisions that separate a mob from an army.
   *
   *  · Focus fire. Every man in the wave that can reach the same victim hits
   *    that victim: a company that spreads its blows across ten spearmen
   *    kills nobody, and ten blows on one spearman kills a spearman.
   *  · Kiting. An archer with a swordsman in his face does not stand there;
   *    he gives ground and keeps shooting, which is the only way a ranged
   *    line survives contact.
   *
   * Runs at the AI's 2 Hz; every order is re-evaluated, so nothing sticks.
   */
  micro(waveUnits, enemyBase) {
    const g = this.game;
    if (!waveUnits.length) return;
    let cx = 0, cz = 0, n = 0;
    for (const u of waveUnits) { cx += u.x; cz += u.z; n++; }
    cx /= n; cz /= n;

    /* --- focus fire: the most dangerous enemy within reach of the line --- */
    let focus = null, bestT = 0, bestD = 22 * 22;
    const around = g.spatial.query(cx, cz, 22);
    for (let i = 0; i < around.length; i++) {
      const e = around[i];
      if (e.dead || e.garrisoned || !g.canFight(this.team, e.team)) continue;
      if (!e.def || e.def.attack <= 0) continue;
      const d = (e.x - cx) ** 2 + (e.z - cz) ** 2;
      if (d > bestD) continue;
      const t = this.threatOf(e);
      if (t > bestT + 0.5 || (focus && t > bestT && d < bestD)) { bestT = t; bestD = d; focus = e; }
    }
    if (focus && bestT >= 3) {
      for (const u of waveUnits) {
        if (u.aiRole !== 'wave') continue;
        if (u.def.siege) continue;
        const d = (u.x - focus.x) ** 2 + (u.z - focus.z) ** 2;
        if (d > 24 * 24) continue;
        if (u.target !== focus) {
          u.target = focus;
          u.state = STATE.ATTACK;
          u.noAggro = false;
        }
      }
    }

    /* --- the wall is the objective, not the farmyard ---
       Left alone, an army walking into a town picks the first shed it sees,
       spends the whole battle on a lumber camp, and goes home. A commander
       tells them the objective: once the enemy field army near the line is
       gone, every man within reach turns on the hall and works it down. Men
       still fighting hand to hand finish that fight first -- but the moment
       they are free, the wall is the job. */
    const hall = (this.siegeHall && !this.siegeHall.dead) ? this.siegeHall
      : g.enemyHall(this.team, enemyBase.x, enemyBase.z, 55);
    if (hall) {
      this.siegeHall = hall;
      for (const u of waveUnits) {
        if (u.aiRole !== 'wave') continue;
        if (u.target === hall) continue;
        if ((u.x - hall.x) ** 2 + (u.z - hall.z) ** 2 > 34 * 34) {
          /* not at the wall yet: march, do not get distracted by the farms */
          if (u.state === STATE.IDLE && !u.def.classes.includes('siege')) {
            u.state = STATE.ATTACK_MOVE;
            u.moveTo(hall.x + (this.rng() - 0.5) * 12, hall.z + (this.rng() - 0.5) * 12, true);
          }
          continue;
        }
        /* at the wall: kill whoever is in your face, then the wall */
        let man = null, md = 7 * 7;
        const close = g.spatial.query(u.x, u.z, 7);
        for (let k = 0; k < close.length; k++) {
          const e = close[k];
          if (e.dead || e.garrisoned || !e.def || e.def.attack <= 0) continue;
          if (e.def.classes.includes('villager')) continue;  // a siege is not a peasant hunt
          if (!g.canFight(this.team, e.team)) continue;
          const d = (e.x - u.x) ** 2 + (e.z - u.z) ** 2;
          if (d < md) { md = d; man = e; }
        }
        u.noAggro = false;
        if (man) {
          if (u.target !== man) { u.state = STATE.ATTACK; u.target = man; }
          continue;
        }
        if (u.target !== hall) {
          u.state = STATE.ATTACK;
          u.target = hall;
        }
      }
    }

    /* --- kiting: bows give ground, spears do not --- */
    for (const u of waveUnits) {
      if (u.aiRole !== 'wave' || !u.def || u.def.siege) continue;
      const rng = (u.def.range || 0);
      if (rng < 3) continue;                       // a melee man stands
      if (u.state === STATE.ATTACK) continue;      // already shooting
      let danger = null, dd = 3.6 * 3.6;
      for (const e of g.units) {
        if (e.dead || e.garrisoned || !g.canFight(this.team, e.team)) continue;
        if (!e.def || e.def.attack <= 0 || (e.def.range || 0) > 2.5) continue;
        const d = (e.x - u.x) ** 2 + (e.z - u.z) ** 2;
        if (d < dd) { dd = d; danger = e; }
      }
      if (danger) {
        const dx = u.x - danger.x, dz = u.z - danger.z;
        const len = Math.hypot(dx, dz) || 1;
        u.state = STATE.MOVE;
        u.target = null;
        u.moveTo(u.x + (dx / len) * 8, u.z + (dz / len) * 8, true);
      }
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
    /* A hunt is a squad, not a second army. It is allowed to grow with the
       danger and with the length of the war, but never past a third of the
       host: a crown that spends every man chasing one caster has an army in
       name only, and its own walls are the ones that fall. */
    const want = Math.min(9, 2 + Math.floor(threat / 2) + Math.floor(g.time / 240),
      Math.max(2, Math.floor(army.length * 0.34)));

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
    /* never strip a wave that is already at the enemy walls */
    const pressing = this.armyState === 'attack' && (this.lastWaveSeen || 0) + 40 > g.time;
    const free = army.filter((u) => ((!u.aiRole || (u.aiRole === 'wave' && !pressing)))
      && this.hunt.indexOf(u) < 0);
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
      u.unreachable = false;
      /* Distance decides the order, not zeal.
         `state = ATTACK` means "chase and swing", and the chase half of it
         gives up after 24 m -- so a squad told to attack a mage 166 m away
         dropped the order the next frame, idled, was re-ordered, dropped it
         again, and stood in a field twitching. From outside, a hunt that never
         leaves home. Far away, the squad walks: an attack-move towards the
         target keeps its feet and picks off whatever it meets on the road.
         Close in, it commits. */
      const gap = Math.hypot(u.x - best.x, u.z - best.z);
      if (gap > 18) {
        if (u.state !== STATE.ATTACK_MOVE || !u.destX) {
          u.target = null;
          u.state = STATE.ATTACK_MOVE;
          u.moveTo(best.x, best.z, true);
        }
      } else if (u.target !== best || (u.state !== STATE.ATTACK && u.state !== STATE.MOVE)) {
        u.target = best;
        u.state = STATE.ATTACK;
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
  /** Call the bounty off and put the hunters back in the line. */
  releaseHunt(army) {
    if (!this.hunt || !this.hunt.length) return;
    for (const u of this.hunt) {
      if (u.dead) continue;
      /* Stamp the recall: a man coming back from an errand is marching, and
         the garrison detail must not quietly take him for the wall instead. */
      if (u.aiRole === 'hunt') { u.aiRole = null; u.recalledAt = this.game.time; }
    }
    this.hunt.length = 0;
    this.huntTarget = null;
  }

  manageRaids(army) {
    const g = this.game;
    if (this.aggression < 0.5 || g.time < 55) return;
    /* keep an existing raid pointed at a target that still exists */
    this.raidUnits = this.raidUnits.filter((u) => !u.dead);
    /* ---- preservation ----
       A raiding party that is outnumbered withdraws. This is the single
       biggest difference between a bot that feels alive and one that feeds:
       the old party fought whatever it met, one skirmish at a time, until
       there was nothing left to come home. Now it counts the opposition it
       can see and leaves while it still can, and it does not go back out
       until the men it lost have been replaced. */
    if (this.raidUnits.length) {
      let cx = 0, cz = 0;
      for (const u of this.raidUnits) { cx += u.x; cz += u.z; }
      cx /= this.raidUnits.length; cz /= this.raidUnits.length;
      const foes = this.defendersNear(cx, cz, 30);
      const mine = this.raidUnits.filter((u) => !u.dead).length;
      if (foes >= mine + 2) {
        this.raidTimer = Math.max(this.raidTimer, 30 + this.rng() * 20);
        for (const u of this.raidUnits) {
          u.aiRole = 'wave';
          u.target = null;
          u.state = STATE.MOVE;
          u.moveTo(this.base.x + (this.rng() - 0.5) * 12, this.base.z + (this.rng() - 0.5) * 12, true);
        }
        this.raidUnits = [];
        this.raidGoal = null;
        return;
      }
    }
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
    /* While a column is on the road, the raiders come from the garrison and
       from men who joined after it left -- never from the column itself. Ten
       of sixteen men peeling off to chase villagers is how a campaign turns
       into two half-armies that both lose. */
    const onTheRoad = this.armyState === 'march' || this.armyState === 'stage';
    const want = Math.min(onTheRoad ? 3 : 6, 2 + Math.floor((g.time - 55) / 170));
    /* A raid is a small, cheap thing; a siege is the war. Taking the raid out
       of the line that is standing at the enemy hall is how a wave of forty
       men evaporates into a wave of eighteen, looks "broken" to its own
       commander, and walks home -- over and over, for an hour. Raiders are
       found among the men who are not already committed. */
    const siegeLive = this.armyState === 'attack' || this.armyState === 'stage';
    let pool = army.filter((u) => (!u.aiRole || (u.aiRole === 'wave' && !siegeLive)));
    if (onTheRoad) {
      /* the garrison is the only pool a marching crown may raid from, and it
         only lends men it can spare */
      const garrison = army.filter((u) => u.aiRole === 'garrison');
      if (garrison.length < want + 3) return;
      pool = garrison;
    }
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
      if (u.dead || u.team === 0 || u.wild || !g.canFight(this.team, u.team)) continue;
      let score = 10;
      if (u.def.classes.includes('villager')) score += 16;
      const th = unitThreat(u);
      if (th >= 4) score += 50 + th * 4;
      score -= Math.sqrt(dist2(u.x, u.z, this.base.x, this.base.z)) * 0.30;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    if (best) return best;
    for (const b of g.buildings) {
      if (b.dead || b.team === 0 || !g.canFight(this.team, b.team)) continue;
      const score = 8 - Math.sqrt(dist2(b.x, b.z, this.base.x, this.base.z)) * 0.28;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  /* ============================================================
     THE ROAD TO THE WAR
     ------------------------------------------------------------
     Every number in this brain was tuned on a 512 m map, where the
     enemy's town is a ninety-second walk: five men could set out and
     the reinforcement trickle would catch them up before they lost the
     advantage of numbers. On a 3 km map the same order is a
     nine-minute march, so the wave arrived as a trickle of exhausted
     men, one at a time, into a defended town -- and if it met a real
     garrison on the road it was destroyed in detail a kilometre from
     home for no gain at all.

     So a campaign is now a march followed by a war, and the march is
     the part that has to be done properly:

       - the army forms at a muster point just outside its own town,
       - waits until it has left a garrison at home and enough men to
         win the field,
       - walks as one body to a forward camp near the enemy, with the
         outriders scouting ahead of it,
       - and only then storms the town.

     The same code runs on Small, where the muster is a few steps and
     the camp is in sight of the enemy, so the behaviour degrades to
     the old one rather than being special-cased.
     ============================================================ */

  /** The fighting-strength band this crown believes it can win inside. */
  foeBand() {
    return Math.min(60, this.diff.maxArmy + 8);
  }

  /** How far the army must walk to bring the war to this crown. */
  marchDistance() {
    const base = this.base, e = this.enemyBase;
    if (!base || !e) return 0;
    return Math.hypot(e.x - base.x, e.z - base.z);
  }

  /**
   * Is it time to go to war?
   *
   * Two things decide it: how strong the army is, and how far away the enemy
   * is. The strength bar rises with the distance, because a long road costs
   * you the men who would have joined along the way and the reinforcements
   * that cannot arrive in time. It also rises with the enemy's own army,
   * because walking a small force into a large one is not aggression, it is
   * a gift.
   */
  wantsWar(waveUnits, foeHome, age) {
    const g = this.game;
    const army = this.waveArmy(age);
    if (g.time < this.diff.firstWave) return false;
    /* The strength the clock alone asks for, unchanged from the old rule so
       that Small behaves exactly as it always did. */
    const step = 3;
    let need = Math.min(this.diff.maxArmy,
      5 + Math.floor(Math.max(0, g.time - this.diff.firstWave) / this.diff.waveEvery) * step);
    /* A long road asks for a few more men up front -- but not as many more
       as a naive reading suggests, because a column on the road keeps
       collecting the men trained behind it. What actually has to stay
       constant is the time to contact: if the walk is six minutes, waiting
       eight minutes for a bigger army means the war starts in fourteen
       either way and the enemy has had eight minutes to fortify. So the bar
       comes *down* with distance, and the road does the rest. */
    need += Math.min(6, Math.round(this.marchDistance() / 400));
    /* ...and the discount for a long road is *paid for* by the column
       collecting the men trained behind it. Measured on Large: the road is
       1.07 km, the crown marched at 13.1 min, reached the camp at 20.5, and a
       column that has walked that far should have started walking sooner. The
       discount used to be a third of the surcharge (a net +3 at this
       distance); a full offset makes it a net zero and takes about two
       minutes off the time to contact. */
    need -= Math.min(6, Math.round(this.marchDistance() / 400));
    /* do not walk into a host several times your size on a rumour: if we can
       see the garrison and it outweighs us, wait. The bar is deliberately
       loose -- a crown that waits for a perfect army never marches. */
    if (foeHome >= 4 && army.length < Math.round((foeHome + 2) * 1.4)) return false;
    /* an undefended town is an open gate, and the whole point of marching is
       to arrive while it is still open */
    if (foeHome <= 2 && army.length >= 5) return true;
    return army.length >= Math.min(this.diff.maxArmy + 4, need);
  }

  /** Does this campaign have a road long enough that it has to be run? */
  hasRoad() {
    return this.marchDistance() > 320;
  }

  /** The men who would march: everything not already on another errand. */
  waveArmy(age) {
    return this.militaryUnits().filter((u) =>
      (!u.aiRole || u.aiRole === 'wave' || u.aiRole === 'march' || u.aiRole === 'stage')
      && !u.garrison);
  }

  /** Hostile men standing inside this crown's own ground. */
  intruders() {
    const g = this.game, base = this.base;
    const out = [];
    for (const u of g.units) {
      if (u.dead || u.team === 0 || u.wild || !g.canFight(this.team, u.team)) continue;
      if (dist2(u.x, u.z, base.x, base.z) < 34 * 34) out.push(u);
    }
    return out;
  }

  /**
   * How much of the army stays home.
   *
   * A crown that empties its town to go raiding loses the town. The garrison
   * is drawn from the army, so it costs something to keep: it is the same
   * rectangle of men whether the map is 512 m or 3 km, which is the point --
   * a defence that scaled with the map would be a second army.
   */
  garrisonSize(army, age) {
    const g = this.game;
    const foeNear = this.intruders().length > 0;
    if (foeNear) return Math.min(army.length, 6);
    if (g.time < 90) return Math.min(army.length, 2);
    const walls = g.buildings.some((b) => !b.dead && b.team === this.team && (b.def.tower || b.type === 'castle'));
    return Math.min(army.length, walls ? 3 : 2);
  }

  /** Where the army forms up: just outside its own town, not inside it. */
  musterPoint() {
    const base = this.base;
    if (this.muster && this.game.time < this.muster.until) return this.muster;
    const e = this.enemyBase;
    const dx = e.x - base.x, dz = e.z - base.z;
    const len = Math.hypot(dx, dz) || 1;
    const r = Math.min(46, Math.max(18, this.marchDistance() * 0.12));
    this.muster = {
      x: base.x + (dx / len) * r,
      z: base.z + (dz / len) * r,
      until: this.game.time + 25
    };
    return this.muster;
  }

  /** How far from the enemy town the army camps before it goes in. */
  forwardOffset() {
    /* How far from the enemy town the army forms up. It has to be further out
       than the town is wide, or half the men are given destinations inside
       somebody's house: the hall sits at the middle of a village of farms,
       houses and camps, and a camp 70 m from the hall put a twelve-man
       column's scattered destinations in the buildings around it. Every one
       of those orders was refused, every refused order reset the man, and
       the column stood in a field 170 m away for twenty minutes at full
       health. Two hundred and fifty metres is a town's width and a minute's
       walk. */
    const d = this.marchDistance();
    if (d < 260) return Math.max(28, d * 0.34);
    return Math.min(320, Math.max(250, d * 0.22));
  }

  /**
   * The road, as a list of places to be, rather than one place to be at the
   * end of it.
   *
   * A man ordered to walk 1.5 km over a river is a man the movement code has
   * to solve that problem for, twelve metres at a time, and it does the wrong
   * thing: it steps straight at the destination, which is into the water, and
   * progress falls to about half a metre a second while the column drifts
   * sideways. The map already knows the answer -- it has fords and corner
   * crossings -- so the planner hands them over as waypoints and every hop is
   * a short walk on dry ground.
   */
  marchWaypoints(approach) {
    const out = [];
    if (approach) out.push({ x: approach.x, z: approach.z });
    const off = this.forwardOffset();
    const base = this.base, e = this.enemyBase;
    const dx = e.x - base.x, dz = e.z - base.z;
    const len = Math.hypot(dx, dz) || 1;
    out.push({ x: e.x - (dx / len) * off, z: e.z - (dz / len) * off });
    return out;
  }

  startMarch(enemyBase, age) {
    const g = this.game;
    /* The raiders come in for the campaign. A crown that marches with half
       its army chasing villagers arrives with a quarter of it. */
    for (const u of this.raidUnits || []) {
      if (u.dead) continue;
      u.aiRole = null;
      u.target = null;
      u.recalledAt = g.time;
    }
    this.raidUnits = [];
    this.raidGoal = null;
    this.raidTimer = Math.max(this.raidTimer, 40);
    /* and the hunt too: a squad of hunters is a party left behind */
    if (this.hunt && this.hunt.length) {
      for (const u of this.hunt) {
        if (u.dead) continue;
        if (u.aiRole === 'hunt') { u.aiRole = null; u.recalledAt = g.time; }
      }
      this.hunt.length = 0;
      this.huntTarget = null;
    }
    const army = this.waveArmy(age);
    const keep = this.garrisonSize(army, age);
    /* Who stays home is a choice, not an accident of array order. The army
       list is in spawn order, and the men just recalled from the hunt are the
       oldest in it -- so "the first two stay behind" kept the two veterans who
       had been walking back to the muster anyway, and sent the rest without
       them. The wall wants men who are already here: the ones nearest the
       town, and never a man who was on an errand and has not yet come in. */
    const fromErrand = (u) => (u.recalledAt && g.time - u.recalledAt < 120) ? 1 : 0;
    const ranked = army.slice().sort((a, b) =>
      (fromErrand(a) - fromErrand(b)) ||
      (dist2(a.x, a.z, this.base.x, this.base.z) - dist2(b.x, b.z, this.base.x, this.base.z)));
    const staying = new Set(ranked.slice(0, keep));
    const marching = army.filter((u) => !staying.has(u));
    if (!marching.length) return false;
    for (const u of ranked.slice(0, keep)) {
      u.aiRole = 'garrison';
      u.target = null;
      u.garrison = true;
      u.state = STATE.MOVE;
      const a = this.rng() * Math.PI * 2, r = 4 + this.rng() * 6;
      u.moveTo(this.base.x + Math.cos(a) * r, this.base.z + Math.sin(a) * r, true);
    }
    this.muster = null;
    const m = this.musterPoint();
    for (const u of marching) {
      u.aiRole = 'march';
      u.garrison = false;
      u.target = null;
      u.noAggro = true;              // the column does not stop to chase
      u.state = STATE.ATTACK_MOVE;
      const a = this.rng() * Math.PI * 2, r = 3 + this.rng() * 5;
      u.moveTo(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r, true);
    }
    /* Which way in? Decided before the column moves, because the column has
       to walk to the crossing -- the camp is on the far bank, and an order to
       walk straight at a town across a river parks the army at the water's
       edge with nowhere to go. On a map with no river this is null and the
       column walks at the town, which is what it always did. */
    const cross = this.pickApproach(marching);
    this.line = {
      at: g.time,
      home: { x: this.base.x, z: this.base.z },
      goal: { x: enemyBase.x, z: enemyBase.z },
      strength: marching.length,
      formUntil: g.time + Math.min(30, 8 + marching.length * 0.6),
      formed: false,
      cross,
      waypoints: this.marchWaypoints(cross),
      leg: 0,
      phase: 'approach',
      camp: null,
      arrivedAt: 0
    };
    this.armyState = 'march';
    this.sendScouts(marching.length);
    return true;
  }

  /**
   * One frame of the march. Returns true when it has handled the army, so the
   * caller stops.
   *
   * The column has three phases: form at the muster, walk to the camp, and
   * wait at the camp for the stragglers. A column that is ambushed on the road
   * is not chased home -- it is allowed to fight back where it stands, and if
   * it has clearly lost it goes back to the muster and tries again with a
   * bigger army, which is what a commander does instead of feeding men into a
   * bad fight one squad at a time.
   */
  runMarch(army, waveUnits, age) {
    const g = this.game, line = this.line;
    const column = army.filter((u) => u.aiRole === 'march' || u.marchDirect);
    if (!column.length) {
      this.armyState = 'gather';
      this.line = null;
      for (const u of army) if (u.aiRole === 'garrison' && !this.intruders().length) u.garrison = false;
      return false;
    }
    /* the enemy seat has moved (their hall fell): re-aim the campaign */
    const foe = this.enemyBase;
    if (Math.hypot(line.goal.x - foe.x, line.goal.z - foe.z) > 90) {
      line.goal = { x: foe.x, z: foe.z };
      line.camp = null;
      line.formed = true;
      line.arrivedAt = 0;
    }
    line.strength = Math.max(line.strength, column.length);

    /* ---- form at the muster ---- */
    if (!line.formed) {
      const m = this.musterPoint();
      let at = 0;
      for (const u of column) if (dist2(u.x, u.z, m.x, m.z) < 22 * 22) at++;
      if (at >= Math.max(3, column.length * 0.55) || g.time > line.formUntil) {
        line.formed = true;
        line.leg = 0;
        const first = line.waypoints[0];
        for (const u of column) {
          const a = this.rng() * Math.PI * 2, r = 2 + this.rng() * 6;
          u.state = STATE.ATTACK_MOVE;
          u.noAggro = true;
          u.moveTo(first.x + Math.cos(a) * r, first.z + Math.sin(a) * r, true);
        }
        this.scoutTimer = 0;
      } else {
        for (const u of column) {
          if (u.state === STATE.IDLE) {
            const a = this.rng() * Math.PI * 2, r = this.rng() * 7;
            u.state = STATE.ATTACK_MOVE;
            u.moveTo(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r, true);
          }
        }
      }
      return true;
    }

    /* ---- the second company ----
       Men trained while the column is on the road are not left behind to
       garrison an empty town: they march to the colours and join it. This is
       what makes an early start pay rather than punish, and it is how the
       army that arrives is bigger than the army that left. */
    for (const u of this.militaryUnits()) {
      if (u.garrisoned || u.aiRole) continue;
      if (u.garrison || u.marchDirect) continue;
      if ((this.scouts || []).includes(u)) continue;
      /* a man who was already spoken for by another errand this frame has an
         order and a destination; re-rolling it every decision is how a column
         loses men it never lost in battle */
      if (u.targetPos && u.state !== STATE.IDLE) continue;
      u.aiRole = 'march';
      u.noAggro = true;
      u.state = STATE.ATTACK_MOVE;
      const target = line.phase === 'approach' && line.cross ? line.cross : (line.camp || this.campPoint());
      const a = this.rng() * Math.PI * 2, r = 2 + this.rng() * 6;
      u.moveTo(target.x + Math.cos(a) * r, target.z + Math.sin(a) * r, true);
    }

    /* ---- the scout rides ahead ---- */
    this.manageScouting(column);
    if (!(this.plan && this.plan.why && this.plan.why !== 'no contact')) this.scoutAhead();

    /* ---- a road that has turned into a battle ---- */
    const foesNear = this.foesOnTheRoad(column, 26);
    if (foesNear.length >= 2) {
      const theirs = 0 + foesNear.reduce((n, u) => n + unitThreat(u), 0);
      const mine = column.reduce((n, u) => n + unitThreat(u), 0);
      /* If the road is lost, go home and come back with the rest of the
         army. If it is even, stand: a column that runs from every skirmish
         never arrives. */
      if (column.length >= 3 && theirs > mine * 1.7 && g.time - line.at > 4) {
        this.abortMarch(army, 'outmatched on the road');
        return true;
      }
      for (const u of foesNear) this.micro(column, { x: u.x, z: u.z });
      return true;
    }

    /* ---- the legs of the road ----
       Each waypoint is walked in turn. A leg is done when most of the column
       is standing on it, and the leg after the last is the town itself. */
    const centre = this.columnCentre();
    if (line.phase === 'approach') {
      const wp = line.waypoints[line.leg];
      if (!wp) {
        line.phase = 'camp';
        line.camp = this.campPoint();
        return true;
      }
      let on = 0;
      for (const u of column) if (dist2(u.x, u.z, wp.x, wp.z) < 40 * 40) on++;
      const done = on >= Math.max(3, Math.ceil(column.length * 0.7));
      const late = g.time - line.at > 40 + line.leg * 60;
      if (done || late) {
        line.leg++;
        const next = line.waypoints[line.leg];
        if (next) {
          for (const u of column) {
            const a = this.rng() * Math.PI * 2, r = 3 + this.rng() * 8;
            u.state = STATE.ATTACK_MOVE;
            u.noAggro = true;
            u.unreachable = false;
            u.moveTo(next.x + Math.cos(a) * r, next.z + Math.sin(a) * r, true);
          }
        } else {
          line.phase = 'camp';
          line.camp = this.campPoint();
        }
        return true;
      }
      for (const u of column) {
        const walking = u.targetPos && (u.path ? u.pathIdx < u.path.length : false);
        if (walking && !u.unreachable) continue;
        if (u.state === STATE.IDLE || u.unreachable) {
          u.unreachable = false;
          const a = this.rng() * Math.PI * 2, r = 3 + this.rng() * 8;
          u.state = STATE.ATTACK_MOVE;
          u.noAggro = true;
          u.moveTo(wp.x + Math.cos(a) * r, wp.z + Math.sin(a) * r, true);
        }
      }
      return true;
    }

    /* ---- at the camp ---- */
    const camp = line.camp || (line.camp = this.campPoint());
    /* "At the camp" is a property of the army, not of each man.
       A camp beside a town is a patch of ground with houses and camps in it;
       the men scatter across it, some of them stand 90 m out because that is
       where the open ground is, and asking every one of them to reach the
       same coordinate is asking the map a question it has already answered.
       When the body of the army is on the camp, the army is at the camp. */
    const centreNow = this.columnCentre() || camp;
    /* Either the army is on the camp, or it is close enough to the town that
       the road is over. The second test matters because the camp is on the
       enemy's doorstep: the last eighty metres are through their farms, and a
       column that insists on forming up in a village stands in it. What the
       storm needs is that the army has arrived, and it has arrived when it is
       at army scale from the hall. */
    const spread = Math.max(45, Math.sqrt(column.length) * 12);
    const atCamp = Math.hypot(centreNow.x - camp.x, centreNow.z - camp.z) < spread;
    const atTown = Math.hypot(centreNow.x - this.enemyBase.x, centreNow.z - this.enemyBase.z) < spread + 90;
    const gathered = atCamp || atTown;
    /* The road is over when the army has arrived, and it has arrived when it
       is at the camp it was sent to. If it cannot get the last hundred metres
       because the enemy's own farms are in the way, that IS the battle -- a
       column stopped by a village is a column that should be storming it. A
       march that has been running this long with the enemy this close is not
       going to be improved by another lap of the camp. */
    const stalled = g.time - line.at > 150 &&
      Math.hypot(centreNow.x - this.enemyBase.x, centreNow.z - this.enemyBase.z) < 420;
    /* ...and a camp phase needs a clock of its own. The test above only fires
       once the column is within 420 m of the enemy hall, which on a 1 km road
       means the army can be camped half a kilometre out for the rest of the
       match -- three minutes standing in a field, measured on Large. Being at
       the camp IS being at the end of the road; if the men are there and the
       rest are not coming, the war starts from where the men are. */
    const campedOut = line.phase === 'camp' && g.time - line.at > 180;
    if (stalled || campedOut) { this.stormTown(column, army); return true; }
    if (gathered && !line.arrivedAt) line.arrivedAt = g.time;
    /* walk to the colours if straggling, but not forever: a man caught on a
       fence is not worth the whole campaign */
    if (gathered || g.time - (line.arrivedAt || g.time) > 40) {
      this.stormTown(column, army);
      return true;
    }
    /* A man with no order here is a man standing still at the colours. Send
       him at the camp -- not back at the crossing he is already past, where
       setPath sees a destination half a metre away and refuses to move him,
       which reads as a unit that will not march and is really a unit that was
       told to stay. */
    for (const u of column) {
      /* Re-order a man only if he has actually stopped.
         This loop runs twice a second, and it re-issued a move order to every
         idle-looking man on every pass -- which reset the 60 m hop he was in
         the middle of walking, so he took one step, was handed the same short
         path again, and shuffled in place for ten minutes. A unit with a hop in
         progress is a unit that is walking; leave him alone. `stalled` is the
         honest test: no order, or an order he has been unable to execute for a
         while. */
      const walking = u.targetPos && (u.path ? u.pathIdx < u.path.length : false);
      if (walking && !u.unreachable) { u.stalledAt = 0; continue; }
      if (u.state === STATE.IDLE || u.unreachable || (u.stalledAt && g.time - u.stalledAt > 6)) {
        if (!u.stalledAt) u.stalledAt = g.time;
        u.unreachable = false;
        u.reorderTries = (u.reorderTries || 0) + 1;
        if (u.reorderTries <= 4) {
          const a = this.rng() * Math.PI * 2, r = 5 + this.rng() * 9;
          u.state = STATE.ATTACK_MOVE;
          u.noAggro = true;
          u.stalledAt = 0;
          u.moveTo(camp.x + Math.cos(a) * r, camp.z + Math.sin(a) * r, true);
        } else if (line.phase === 'camp') {
          /* Four refusals is the map talking: this man cannot get to the camp,
             and a fifth order will not change that. He stays in the column and
             walks at the town instead of being cut loose -- as a loose 'wave'
             he was invisible to the march and got picked up by the next
             garrison or hunt order, which is how a fifteen-man column turned
             into seven men and five hunters without a shot being fired. */
          u.marchDirect = true;
          u.state = STATE.ATTACK_MOVE;
          u.noAggro = true;
          u.moveTo(this.enemyBase.x + (this.rng() - 0.5) * 20, this.enemyBase.z + (this.rng() - 0.5) * 20, true);
        } else {
          u.unreachable = false;
          u.state = STATE.IDLE;      // still on the approach: wait for the others
        }
      }
    }
    return true;
  }

  /**
   * Where the column camps: near enough to strike, far enough not to be seen.
   *
   * The point has to be somewhere an army can actually stand. The obvious
   * choice -- a fraction of the way in from the enemy, along the straight line
   * from home -- is on the far bank of the river about half the time, and an
   * order to a point across water is an order that fails: the whole column
   * stopped dead 500 m out with "no way through" and the campaign sat there.
   * So the camp is walked back along the approach until the pathfinder agrees
   * a man standing here can get there.
   */
  campPoint() {
    if (this._campCache && this._campCache.goal === this.enemyBase
        && this.game.time < this._campCache.until) return this._campCache.point;
    const base = this.base, e = this.enemyBase;
    const dx = e.x - base.x, dz = e.z - base.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const off = this.forwardOffset();
    /* The camp is a *place to gather*, not a coordinate to stand on.
       It used to be a point, checked for clearance, and pushed towards the
       army whenever the check failed -- which it always does next to a town
       full of houses, so the camp kept sliding back until it was seventy
       metres from the enemy's hall and every man in the column was being
       ordered to stand inside a farmyard. An army occupies ground; the men
       scatter across it and the map decides who can stand where. */
    let point = { x: e.x - ux * off, z: e.z - uz * off };
    /* The camp must be ground an army can *stand* on. It is computed by
       walking back from the enemy hall along the line of march, and on a big
       map that line can run straight into a river, a lake or the sea: the
       column then spends the rest of the match in the "at the camp" phase
       ordering seventeen men to a point that refuses every step, which reads
       as an army that will not attack and is really an army ordered into
       water. Found on Large, where the camp landed 5.9 m under a lake. */
    if (!this.groundIsClear(point.x, point.z, 34, 0.6) || !this.game.isPassable(point.x, point.z, { radius: 0.5, def: {} })) {
      const dry = this.dryPointNear(point, ux, uz);
      if (dry) point = dry;
    }
    this._campCache = { goal: this.enemyBase, point, until: this.game.time + 40 };
    return point;
  }

  /**
   * The nearest water-free place to gather, searching back along the line of
   * march and then sideways.
   *
   * Backwards first, because the column comes from that direction and a camp
   * behind it costs nothing; sideways second, for a ford or a lake that fills
   * the whole line. Water is the thing that actually breaks the camp -- a man
   * can always be nudged off a rock, but a man sent to the middle of a lake
   * never moves at all.
   */
  dryPointNear(point, ux, uz) {
    const g = this.game;
    const dry = (x, z) => g.isPassable(x, z, { radius: 0.5, def: {} })
      && this.groundIsClear(x, z, 30, 0.55);
    for (let back = 20; back <= 320; back += 20) {
      if (dry(point.x - ux * back, point.z - uz * back)) {
        return { x: point.x - ux * back, z: point.z - uz * back };
      }
      for (const side of [0.18, -0.18, 0.36, -0.36]) {
        const px = Math.cos(side), pz = Math.sin(side);
        const cx = point.x - ux * back * px + uz * back * pz;
        const cz = point.z - uz * back * px - ux * back * pz;
        if (dry(cx, cz)) return { x: cx, z: cz };
      }
    }
    return null;
  }

  /** Is there room for a body of men here, clear of buildings? */
  groundIsClear(x, z, half, want) {
    const g = this.game;
    for (const b of g.buildings) {
      if (b.dead) continue;
      const r = (b.radius || 2) + 2.5;
      if (dist2(b.x, b.z, x, z) < (r + half * 0.5) ** 2) return false;
    }
    const pf = g.pathFinder;
    if (!pf || !pf.blocked) return true;
    const cs = pf.cellSize, n = pf.cells;
    let free = 0, total = 0;
    const step = Math.max(cs, half / 3);
    for (let dz = -half; dz <= half; dz += step) {
      for (let dx = -half; dx <= half; dx += step) {
        const cx = Math.round((x + dx) / cs + (n - 1) / 2);
        const cz = Math.round((z + dz) / cs + (n - 1) / 2);
        if (cx < 0 || cz < 0 || cx >= n || cz >= n) continue;
        total++;
        if (!pf.blocked[cz * n + cx]) free++;
      }
    }
    return total > 0 && free >= Math.ceil(total * Math.max(0.6, want));
  }

  /**
   * Is this point on the enemy's side of the crossing?
   *
   * Measured along the line from the crown's own town to the enemy's: a point
   * that projects further toward the enemy than the crossing does has come out
   * the other side. That works for a ford on the river and for a flank at the
   * edge of the map, which are the two shapes the map generator makes.
   */
  hasCrossed(x, z, cross) {
    const base = this.base, e = this.enemyBase;
    const dx = e.x - base.x, dz = e.z - base.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const here = (x - base.x) * ux + (z - base.z) * uz;
    const at = (cross.x - base.x) * ux + (cross.z - base.z) * uz;
    return here > at + Math.max(30, cross.r * 0.5);
  }

  /** The middle of the marching column, or null when there is no column. */
  columnCentre() {
    const g = this.game;
    let n = 0, x = 0, z = 0;
    for (const u of g.units) {
      if (u.dead || u.team !== this.team || u.aiRole !== 'march') continue;
      x += u.x; z += u.z; n++;
    }
    return n ? { x: x / n, z: z / n } : null;
  }

  /**
   * Can a man stand at `from` and walk to `x,z`?
   *
   * A one-off question, so it is asked off the tick: the per-frame budget will
   * refuse a cross-map search by design, and that refusal looks exactly like
   * "there is no way through".
   */
  canReach(from, x, z) {
    const pf = this.game.pathFinder;
    if (!pf || !from) return true;
    const p = pf.find(from.x, from.z, x, z, 2, { offTick: true });
    if (!p || !p.length) return false;
    const end = p[p.length - 1];
    return Math.hypot(end[0] - x, end[1] - z) < 40;
  }

  /** Hostile fighting men within `r` of the column's centre of mass. */
  foesOnTheRoad(column, r) {
    const g = this.game;
    if (!column.length) return [];
    let cx = 0, cz = 0;
    for (const u of column) { cx += u.x; cz += u.z; }
    cx /= column.length; cz /= column.length;
    const out = [];
    for (const u of g.units) {
      if (u.dead || u.garrisoned || u.wild || !u.def || u.def.attack <= 0) continue;
      if (u.def.classes.includes('villager')) continue;
      if (!g.canFight(this.team, u.team)) continue;
      if (dist2(u.x, u.z, cx, cz) < (r + column.length * 0.5) ** 2) out.push(u);
    }
    return out;
  }

  abortMarch(army, why) {
    const g = this.game;
    this.armyState = 'gather';
    this.line = null;
    this.staging = null;
    this.attackTimer = Math.max(18, this.diff.waveEvery * 0.4);
    for (const u of army) {
      if (u.aiRole === 'hunt' || u.aiRole === 'raid') continue;
      u.aiRole = null;
      u.garrison = false;
      u.marchDirect = false;
      u.target = null;
      u.state = STATE.MOVE;
      u.moveTo(this.base.x + (this.rng() - 0.5) * 12, this.base.z + (this.rng() - 0.5) * 12, true);
    }
    if (this.team === this.game.playerTeam) this.game.notify(`Our column turns back: ${why}`, 'warn');
  }

  /**
   * The camp is as far as the army goes until it decides how to go in.
   *
   * This is where the river is answered. A town behind a river has one short
   * road (a ford) and one long one (the corner flank), and which is better is
   * not simply which is shorter: men who wade a ford arrive wet and in single
   * file, and a flank nobody is watching is often the cheaper road even
   * though it is twice the distance. So the column weights the choices by
   * length, by the defenders it can see on each, and by whether it has the
   * numbers to survive a contested crossing.
   */
  stormTown(column, army) {
    const g = this.game;
    const enemyBase = this.enemyBase;
    const route = this.pickApproach(column);
    this.approach = route;
    const goal = route ? { x: route.x, z: route.z } : { x: enemyBase.x, z: enemyBase.z };
    const dx = enemyBase.x - this.base.x, dz = enemyBase.z - this.base.z;
    const len = Math.hypot(dx, dz) || 1;
    const stand = Math.max(26, Math.min(46, len * 0.32));
    this.staging = {
      x: enemyBase.x - (dx / len) * stand,
      z: enemyBase.z - (dz / len) * stand,
      until: g.time + 18,
      strength: column.length
    };
    this.armyState = 'stage';
    this.line = null;
    for (const u of army) if (u.aiRole === 'hunt' || u.aiRole === 'raid') u.aiRole = null;
    const host = army.filter((u) => !u.aiRole || u.aiRole === 'wave' || u.aiRole === 'march');
    this.hunt.length = 0;
    this.waveStrength = host.length;
    for (const u of host) {
      u.aiRole = 'stage';
      u.garrison = false;
      u.target = null;
      u.noAggro = false;
      u.state = STATE.ATTACK_MOVE;
      u.moveTo(this.staging.x + (this.rng() - 0.5) * 12, this.staging.z + (this.rng() - 0.5) * 12, true);
    }
    return;
  }

  /**
   * Which way in: the ford, or the long way round the corner?
   *
   * Returns null when there is nothing to choose (no river, or no flank
   * within reach on this map) and the army walks straight at the town, which
   * is what it should do on a map where the river is not in the way.
   */
  pickApproach(column) {
    const g = this.game, world = g.world;
    const crossings = [];
    for (const f of world.fords || []) {
      crossings.push({ kind: 'ford', x: f.x, z: f.z, r: f.radius || 24 });
    }
    for (const c of world.corridors || []) {
      crossings.push({ kind: 'flank', x: c.x, z: c.z, r: c.r || 60 });
    }
    if (!crossings.length || !column.length) return null;
    let cx = 0, cz = 0;
    for (const u of column) { cx += u.x; cz += u.z; }
    cx /= column.length; cz /= column.length;
    const enemyBase = this.enemyBase;
    const foeHome = this.foeHome || 0;
    const myMen = column.length;
    let best = null, bestScore = Infinity;
    for (const c of crossings) {
      if (dist2(c.x, c.z, cx, cz) > 1500 * 1500) continue;
      const legA = Math.hypot(c.x - cx, c.z - cz);
      const legB = Math.hypot(enemyBase.x - c.x, enemyBase.z - c.z);
      let cost = legA + legB;
      /* A watched ford is expensive: the men who die in the water are the
         men who would have climbed the far bank. A ford with an empty far
         bank is the cheapest road on the map. */
      const guarded = this.defendersNear(c.x, c.z, c.r + 26);
      if (c.kind === 'ford') {
        cost *= 1 + (guarded / Math.max(3, myMen)) * 0.7;
        /* wading a wide ford is slow and it is where a defender wants you */
        cost += c.r * 0.35;
      } else {
        /* the flank is the long way round by construction; it is worth it
           when it is unwatched and the army is big enough to be seen */
        cost *= 1 + (guarded / Math.max(3, myMen)) * 1.1;
        if (guarded === 0 && foeHome >= 3) cost *= 0.8;
      }
      if (cost < bestScore) { bestScore = cost; best = c; }
    }
    if (!best) return null;
    /* if the best crossing is not actually cheaper than walking straight in,
       the river is not in the way on this map -- do not detour for nothing */
    const straight = Math.hypot(enemyBase.x - cx, enemyBase.z - cz);
    if (bestScore > straight * 1.9) return null;
    return best;
  }

  /** How many fighting men this crown can see around a point. */
  defendersNear(x, z, r) {
    const g = this.game;
    let n = 0;
    for (const u of g.units) {
      if (u.dead || u.garrisoned || u.wild || !u.def || u.def.attack <= 0) continue;
      if (u.def.classes.includes('villager')) continue;
      if (!g.canFight(this.team, u.team)) continue;
      if (dist2(u.x, u.z, x, z) < r * r) n++;
    }
    return n;
  }

  /* ============================================================
     SCOUTING
     ------------------------------------------------------------
     The council in decidePlan() can only answer an army it has seen,
     and a crown that never looks reports "no contact" for the whole
     match: it trains the same men regardless of what is coming at it
     and walks into a counter it could have read. A light rider is
     cheap and it fixes both. If there is no rider, the column's own
     fastest men go and have a look on the way.
     ============================================================ */

  /** Pick men to ride ahead, and keep them out of the line. */
  sendScouts(want = 1) {
    const g = this.game;
    this.scouts = (this.scouts || []).filter((u) => !u.dead);
    if (this.scouts.length >= 2 || g.time < 45) return;
    if (this.scoutTimer > g.time) return;
    this.scoutTimer = g.time + 30;
    /* A crown with no cavalry still has eyes. The first version of this only
       ever looked for a rider with speed 4.2, so a crown that never trained a
       horse scouted nothing for the whole match and its council answered an
       army it had never seen -- which is exactly the behaviour the section was
       written about, coming back through a different door. If there is no
       rider, the fastest man in the line goes. */
    const riders = this.militaryUnits().filter((u) =>
      !u.dead && u.def.attack > 0 && (!u.aiRole || u.aiRole === 'garrison'
        || u.aiRole === 'march')
      && (u.def.classes.includes('cavalry') || u.def.speed >= 4.2 || this.armyState === 'gather'));
    riders.sort((a, b) => (b.def.speed || 0) - (a.def.speed || 0));
    const pick = riders.slice(0, Math.min(want, 2, riders.length));
    for (const u of pick) {
      u.aiRole = 'scout';
      u.target = null;
      u.noAggro = true;
      u.state = STATE.ATTACK_MOVE;
      u.moveTo(this.enemyBase.x + (this.rng() - 0.5) * 30, this.enemyBase.z + (this.rng() - 0.5) * 30, true);
      this.scouts.push(u);
    }
  }

  /** Keep the scouts moving and let them come home rather than die out there. */
  manageScouting(column) {
    const g = this.game;
    this.scouts = (this.scouts || []).filter((u) => !u.dead);
    for (const u of this.scouts) {
      if (u.hp < u.maxHp * 0.35 || (u.state === STATE.IDLE && dist2(u.x, u.z, this.base.x, this.base.z) < 40 * 40)) {
        u.aiRole = null;
        u.noAggro = false;
        u.state = STATE.MOVE;
        u.moveTo(this.base.x + (this.rng() - 0.5) * 10, this.base.z + (this.rng() - 0.5) * 10, true);
        continue;
      }
      if (u.state !== STATE.IDLE) continue;
      /* a scout that has seen the town rides a ring around it */
      const a = g.time * 0.12 + (u.id || 0);
      const r = 55 + (u.id % 3) * 14;
      u.state = STATE.ATTACK_MOVE;
      u.noAggro = true;
      u.moveTo(this.enemyBase.x + Math.cos(a) * r, this.enemyBase.z + Math.sin(a) * r, true);
    }
    /* while the column is on the road, its outriders look ahead of it */
    if (column.length && this.scouts.length < 1 && g.time > 90) this.sendScouts(1);
  }

  /**
   * No riders yet: send the lead element of the column itself to look.
   *
   * This is the fallback that makes scouting work at every age, because the
   * first cavalry is not guaranteed and a crown that waits for one scouts
   * nothing for the first six minutes of the match.
   */
  scoutAhead() {
    const g = this.game;
    this.scouts = (this.scouts || []).filter((u) => !u.dead);
    if (this.scouts.length) return;
    if (this.scoutNextAt && g.time < this.scoutNextAt) return;
    /* The lookout comes from the column first, because that is where the men
       are, and from the line otherwise. He keeps count in `scouts`, so the
       next pass does not quietly promote another man and another after him. */
    const column = g.units.filter((u) => !u.dead && u.team === this.team && u.aiRole === 'march');
    const pool = column.length >= 4 ? column : this.militaryUnits().filter((u) => u.def.attack > 0 && !u.aiRole);
    if (!pool.length) return;
    let fastest = null;
    for (const u of pool) if (!fastest || (u.def.speed || 0) > (fastest.def.speed || 0)) fastest = u;
    if (!fastest) return;
    this.scoutNextAt = g.time + 25;
    this.scoutRider = fastest;
    this.scouts.push(fastest);
    fastest.aiRole = 'scout';
    fastest.noAggro = true;
    fastest.state = STATE.ATTACK_MOVE;
    fastest.moveTo(this.enemyBase.x, this.enemyBase.z, true);
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
      if (u.dead || u.team === 0 || u.wild || !g.canFight(this.team, u.team)) continue;
      if (dist2(u.x, u.z, base.x, base.z) < 34 * 34) intruders.push(u);
    }
    if (intruders.length && army.length) {
      intruders.sort((a, b) => (unitThreat(b) - unitThreat(a)) ||
        (dist2(a.x, a.z, base.x, base.z) - dist2(b.x, b.z, base.x, base.z)));
      const worst = intruders[0];
      /* How much of the army comes home? All of it, if the base is really in
         danger. But if a scout rides past the woodline while forty men are
         battering the enemy hall, recalling the assault is how a war is lost:
         the wave that is already winning keeps pressing and only the men who
         are near home answer. This is the difference between a garrison and
         a body of troops that panics at every sound. */
      let threatSum = 0, siegeSeen = false;
      for (const u of intruders) {
        threatSum += unitThreat(u);
        if (u.def.classes.includes('siege')) siegeSeen = true;
      }
      /* ...and a crown that is one blow from losing its hall does not stop
         to chase riders out of its own fields. The assault holds until the
         wall is down. */
      const wallIsDown = this.siegeHall && !this.siegeHall.dead &&
        this.siegeHall.hp < this.siegeHall.maxHp * 0.3;
      const heavy = (siegeSeen || threatSum >= 9 || intruders.length >= 6) && !wallIsDown;
      const assaulting = (this.armyState === 'attack' && (this.lastWaveSeen || 0) + 60 > g.time) || wallIsDown;
      let answered = 0;
      for (const u of army) {
        if (u.aiRole === 'hunt') continue;      // a hunt already has a job
        if (!heavy && assaulting && u.aiRole === 'wave' &&
            dist2(u.x, u.z, base.x, base.z) > 52 * 52) continue;  // the assault holds
        u.aiRole = 'defend';
        answered++;
        if (u.target !== worst) {
          u.state = STATE.ATTACK;
          u.target = worst;
          u.noAggro = false;
          u.unreachable = false;
        }
      }
      if (!answered) return;   // nothing turned back; the war goes on
      if (worst.team === g.playerTeam && unitThreat(worst) >= 5 && g.time - this.huntWarnAt > 30) {
        this.huntWarnAt = g.time;
        g.notify('That caster is standing in your base — everything is on it', 'warn');
      }
      this.armyState = 'defend';
      return;
    }
    for (const u of army) if (u.aiRole === 'defend') u.aiRole = null;
    /* A garrison job that outlives its march turns into a soldier who will
       not march again: the flag is set when a column leaves and nothing was
       clearing it when the column came home. */
    if (this.armyState !== 'march' && this.armyState !== 'stage') {
      for (const u of army) {
        if (u.aiRole === 'garrison' || u.garrison) { u.aiRole = null; u.garrison = false; }
      }
    }
    if (this.armyState === 'march' || this.armyState === 'stage') {
      /* ...and while it is on the road nobody may take a man out of it */
      for (const u of army) {
        if (u.aiRole === 'hunt' || u.aiRole === 'raid') { u.aiRole = 'march'; u.huntTarget = null; }
      }
    }

    /* ---- eyes ----
       Scouting is not part of the march; it is part of being a crown with men
       to spare. It used to be called only from the march, which meant a crown
       that had not marched yet had never looked -- so the council's census
       was always empty, the plan was always "no contact", and the counter it
       built was always the same army. */
    this.manageScouting([]);
    if (g.time > 60 && army.length >= 2) this.sendScouts(1);

    /* 2. the standing bounty, then 3. the raid clock

       ...but not while the column is on the road. A crown whose enemy is a
       kilometre away has to concentrate: sixteen men split into six raiders,
       five hunters and two men left in the line is not an army, it is three
       small defeats.

       This budget has been got wrong in both directions now, so the rule is
       written down. Drying up the errands for the whole opening starved a
       crown of its hunt and its raids, which is not concentration, it is
       paralysis -- but turning them fully on did something worse: on Large the
       crown reached eighteen soldiers with *none* in the line, ten riding at
       villages and six chasing a mage, and because the march is fed by the
       line it never marched at all. An army is the reserves, not the
       detachments.

       The line's floor is what matters, and it is a floor on the *line*, not a
       fraction of a table: the errands are refused while fewer than four men
       are left standing in the line itself. That is the cheap, honest form of
       the rule -- it stops the crown that has split itself into nothing, and
       it does not stop a crown that has one detachment out and eight men at
       home, which is a normal way to fight a war. */
    const atWar = this.armyState === 'march' || this.armyState === 'stage';
    const inLine = army.filter((u) => !u.aiRole || u.aiRole === 'wave').length;
    const reserve = this.hasRoad() && this.armyState === 'gather' && inLine < 4;
    if (atWar) this.releaseHunt(army);
    else this.manageHunt(army);
    if (!atWar && !reserve) this.manageRaids(army);
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

    /* ---- reinforcements ----
       A siege is won by the second company, not the first. Men trained while
       the wave is already at the enemy hall march straight out and join it.
       Without this the wave bleeds down to nothing outside the walls while a
       fresh company forms up behind it and walks in alone, which is the same
       defeat in detail the staging ground exists to prevent. */
    if (this.armyState === 'attack' && (this.lastWaveSeen || 0) + 60 > g.time) {
      const fresh = waveUnits.filter((u) => !u.aiRole);
      const live = waveUnits.length - fresh.length;
      if (live >= 3) {
        const hall = g.enemyHall(this.team, enemyBase.x, enemyBase.z, 60);
        const place = hall || { x: enemyBase.x, z: enemyBase.z };
        for (const u of fresh) {
          u.aiRole = 'wave';
          u.noAggro = false;
          if (hall && u.def.classes.includes('siege')) {
            u.state = STATE.ATTACK;
            u.target = hall;
          } else {
            u.state = STATE.ATTACK_MOVE;
            u.target = null;
            u.moveTo(place.x + (this.rng() - 0.5) * 14, place.z + (this.rng() - 0.5) * 14, true);
          }
        }
        if (fresh.length) {
          this.waveStrength = (this.waveStrength || 0) + fresh.length;
          this.lastWaveSeen = g.time;
          return;
        }
      }
    }

    /* A staging ground is set once. Re-entering it every time the timer
       ticked rebuilt the ring, reset the eighteen-second clock and sent the
       same men back to the same field, which is how an army can stand at the
       edge of an enemy town for ten minutes without ever touching it. */
    const alreadyStaging = this.armyState === 'stage' && this.staging;
    if (g.time > this.diff.firstWave && waveUnits.length >= 3 &&
        this.armyState !== 'attack' && !alreadyStaging && this.wantsWar(waveUnits, foeHome, age)) {
      /* Start the march instead of the siege. Everything that used to happen
         when the first five men were ready now happens at the end of the
         road, with the whole army at the colours. */
      this.startMarch(enemyBase, age);
      return;
    }
    if (canAttack && waveUnits.length >= 4 && this.armyState !== 'attack' && !alreadyStaging && !this.hasRoad()) {
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
      /* Concentration. A crown that splits its host into a raiding party, a
         mage-hunt and an assault is beaten in detail by a crown that keeps
         its men together: this is the oldest lesson in war and the AI used
         to ignore it. The hunt and the raiders are called in for the assault
         and re-formed from what survives it. */
      for (const u of army) {
        if (u.aiRole === 'hunt' || u.aiRole === 'raid') u.aiRole = null;
      }
      const host = army.filter((u) => !u.aiRole || u.aiRole === 'wave');
      this.hunt.length = 0;
      this.waveStrength = host.length;
      for (const u of host) {
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
      /* The men at the colours are the ones with the 'stage' role. This was
         the whole stalemate in one line: the block used to count `waveUnits`,
         which excludes everything holding a role, so it believed the ring was
         empty, sent nobody forward, and the army stood on a hill outside the
         enemy town for the length of a match. */
      const staged = army.filter((u) => u.aiRole === 'stage');
      let arrived = 0;
      for (const u of staged) {
        if ((u.x - st2.x) ** 2 + (u.z - st2.z) ** 2 < 14 * 14) arrived++;
      }
      const enough = arrived >= Math.max(3, st2.strength * 0.6);
      const fresh = army.filter((u) => !u.aiRole);
      if (enough || g.time >= st2.until || staged.length + fresh.length < 3) {
        /* go in as one body */
        this.armyState = 'attack';
        this.attackTimer = this.diff.waveEvery;
        this.lastAttackTime = g.time;
        this.waveStrength = staged.length + fresh.length;
        this.lastWaveSeen = g.time;
        /* the hall first: a war of crowns is decided by which halls still
           stand, so the engines go for the town centre and the line follows */
        const target = g.enemyHall(this.team, enemyBase.x, enemyBase.z, 44)
          || g.nearestEnemyStructure({ x: enemyBase.x, z: enemyBase.z, team: this.team }, this.team, 40);
        this.siegeHall = target && target.def && target.def.ageAdvance ? target : null;
        /* anyone still walking to the colours is in the wave now, not a
           straggler with a stale job */
        for (const u of [...staged, ...fresh]) {
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
        for (const u of staged) {
          if (u.state === STATE.IDLE) {
            u.state = STATE.ATTACK_MOVE;
            u.moveTo(st2.x + (this.rng() - 0.5) * 10, st2.z + (this.rng() - 0.5) * 10, true);
          }
        }
      }
      return;
    }

    /* The march has to be rehearsed before the men reach the enemy, or the
       wave is spent on the road. On a 512 m map the whole map is a 90-second
       walk, so "march at the enemy when there are five of you" was fine: the
       reinforcement trickle caught up and the wave grew as it went. On a
       3 km map that same order walks single-file for eight minutes and
       arrives as a funeral. */
    if (this.armyState === 'march' && this.line) {
      if (this.runMarch(army, waveUnits, age)) return;
    }

    if (this.armyState === 'attack') {
      /* If their hall is gone, the wave follows the crown instead of the
         coordinates of a hall that no longer exists. */
      let standingHall = false;
      for (const b of g.buildings) {
        if (b.dead || b.team !== this.foe || !b.def.ageAdvance) continue;
        standingHall = true; break;
      }
      if (!standingHall) {
        const anchor = this.foeAnchor();
        if (anchor) this.enemyBase = { x: anchor.x, z: anchor.z };
      }
      /* Men who turned back to chase a scout off the woodpile keep their
         place in the line when it is over: without this the wave quietly
         dissolves into a crowd of individuals and the AI believes it is
         still attacking with an army it no longer has. */
      for (const u of waveUnits) u.aiRole = 'wave';
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
        /* A wounded hall is worth the last of the wave. Twenty men who have
           bled to bring the enemy town centre to a tenth of its height and
           then walk home have bought nothing but a graveyard and a lesson:
           the gate is open for exactly as long as it takes them to reform. */
        let weakHall = 1;
        for (const b of g.buildings) {
          if (b.dead || b.team !== this.foe || !b.def.ageAdvance) continue;
          if ((b.buildProgress || 1) < 1) continue;   // a foundation is not a hall
          if (dist2(b.x, b.z, enemyBase.x, enemyBase.z) > 55 * 55) continue;
          const f = b.hp / b.maxHp;
          if (f < weakHall) weakHall = f;
        }
        const finishing = weakHall < 0.45 && alive >= 4;
        const pressing = finishing || (alive >= 6 && foesLeft <= Math.max(2, alive * 0.5));
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
          this.micro(waveUnits, enemyBase);
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
  /* a champion is worth more than the unit carrying the title: killing him is
     how you break an army's spine */
  if (u.champion) t += 3;
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
