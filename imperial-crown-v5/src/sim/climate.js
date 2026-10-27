/* ============================================================
   climate.js — the slow sky
   ------------------------------------------------------------
   The Wheel of the Year is the weather. This file is the CLIMATE:
   a much slower clock that decides what kind of world the
   weather happens in.

   A match begins in the Temperate Years. Somewhere between
   fifteen and twenty minutes in — once the first towns are big
   and the first forests are gone — the era turns, and the rules
   underneath the seasons change:

     The Thaw        the seas rise, rivers swell, low ground
                     floods. Farms near water drown.
     The Long Drought  rain stops. Farms yield little, herds
                     wander off, and the wells run dry: keeping
                     a food economy alive becomes a *choice*.
     The Storm Years  the sky is angry. Lightning strikes tall
                     buildings, rain slows every road, and the
                     omens come doubled.
     The Killing Winter  the world does not warm again. Food is
                     half, armies far from a hearth freeze, and
                     the Wheel's winter comes early and stays.

   The climate is not on a timer alone. It is driven by STRAIN:
   every farm, every building, every trunk felled adds to it,
   every standing forest takes some back. Two greedy kingdoms
   burn the sky faster than two careful ones — so "play well"
   and "keep the world" are, eventually, the same instruction.

   Everything here is data plus a handful of multipliers, so a
   normal match pays a few branches per tick, and every number is
   exposed through the accessors at the bottom for the HUD, the
   AI and the tests.
   ============================================================ */
import { clamp } from '../core/math.js';

/** The eras, in order. `at` is the strain each one needs to begin. */
export const ERAS = [
  {
    id: 'temperate', name: 'The Temperate Years', icon: 'leaf',
    blurb: 'Rain when it should rain. The world is as it was.',
    tint: [1, 1, 1], fog: 0, cloud: 0, night: 0,
    food: 1, wood: 1, speed: 1, heal: 1, morale: 1,
    omenWeights: {}, strainAt: 0
  },
  {
    id: 'thaw', name: 'The Great Thaw', icon: 'ship',
    blurb: 'The ice gives up the coast. Roads turn to mud and the low fields drown.',
    tint: [0.9, 1.0, 1.02], fog: 0.0004, cloud: 0.1, night: 0,
    food: 0.94, wood: 1.02, speed: 0.93, heal: 1.05, morale: 0.96,
    omenWeights: { long_night: 2, bountiful: 1.5, great_frost: 0.4 }, strainAt: 26
  },
  {
    id: 'drought', name: 'The Long Drought', icon: 'flame',
    blurb: 'No rain at all. The fields crack; the herds go looking for water and do not come back.',
    tint: [1.08, 0.94, 0.76], fog: -0.0003, cloud: -0.18, night: 0,
    food: 0.78, wood: 0.88, speed: 1.04, heal: 0.85, morale: 0.9,
    omenWeights: { wolf_moon: 2, bountiful: 0.5, plague_winds: 1.6 }, strainAt: 52
  },
  {
    id: 'storms', name: 'The Storm Years', icon: 'bolt',
    blurb: 'The sky answers what was done to it. Lightning finds high roofs and the rain never stops.',
    tint: [0.82, 0.88, 1.0], fog: 0.0011, cloud: 0.34, night: 0.06,
    food: 0.9, wood: 1.0, speed: 0.9, heal: 0.9, morale: 0.86,
    omenWeights: { still_air: 0.3, iron_sky: 1.6, great_frost: 1.8 }, strainAt: 78,
    lightning: true
  },
  {
    id: 'killing_winter', name: 'The Killing Winter', icon: 'mountain',
    blurb: 'It does not warm again. The fields are gone, the roads are ice, and the cold is an enemy with a body count.',
    tint: [0.76, 0.84, 1.0], fog: 0.0009, cloud: 0.22, night: 0.1,
    food: 0.58, wood: 0.8, speed: 0.86, heal: 0.7, morale: 0.72,
    omenWeights: { great_frost: 3, long_night: 2, bountiful: 0.2 }, strainAt: 100,
    cold: true
  }
];
export const ERA_BY_ID = new Map(ERAS.map((e) => [e.id, e]));

/** Seconds an era lasts. The first is 15 minutes: long enough to build a
    realm, short enough that a session sees the sky change. */
const ERA_LENGTH = [900, 1000, 1050, 900, Infinity];
/* Strain per minute of *holding* an era, so even a hermit's valley turns
   eventually — this is the "climate change happens anyway" pressure. */
const DRIFT = 0.055;
const PASS = 0.5;              // the climate is a slow system: twice a second
const STRAIN_MAX = 100;

export class Climate {
  constructor(game) {
    this.game = game;
    this.eraIndex = 0;
    this.t = 0;
    this.elapsed = 0;
    this.strain = 0;
    this.eraLengths = ERA_LENGTH.slice();
    /* `years` counts how many times the sky has turned; the HUD calls it
       "the sky" and the number is the era's own year. */
    this.turns = 0;
    this.armed = { lightning: 0, event: 0 };
    this.lastEvent = null;
    this.events = [];
    /* how much of the last minute's strain came from wood, to explain it */
    this.book = { forests: 0, farms: 0, buildings: 0, drift: 0, smoke: 0 };
    this._acc = 0;
    this._scan = 0;
    this._forests = 0;
    this._farms = 0;
    this._buildings = 0;
    this._droughtT = 0;
    /* Fuel: wood goes into the fire and up the chimney. `_fuel` is a rolling
       total that decays, so the sky answers *current* consumption rather
       than a lifetime score. */
    this._fuelAcc = 0;
    this.fuel = 0;
  }

  get era() { return ERAS[Math.min(ERAS.length - 1, this.eraIndex)]; }
  get next() { return ERAS[Math.min(ERAS.length - 1, this.eraIndex + 1)]; }
  get isFinal() { return this.eraIndex >= ERAS.length - 1; }

  /** Seconds until the era turns (Infinity in the last era). */
  get remaining() {
    if (this.isFinal) return Infinity;
    return Math.max(0, this.eraLengths[this.eraIndex] - this.t);
  }

  /** How far through the era, 0..1 (for the HUD bar). */
  get progress() {
    if (this.isFinal) return 1;
    return clamp(this.t / this.eraLengths[this.eraIndex], 0, 1);
  }

  start() {
    this.eraIndex = 0;
    this.t = 0;
    this.strain = 0;
    this.turns = 0;
    this.eraLengths = ERA_LENGTH.slice();
    this._rescan();
  }

  /* ------------------------------------------------------------
     the slow clock
     ------------------------------------------------------------ */
  update(dt) {
    const g = this.game;
    this.elapsed += dt;
    this.t += dt;

    /* ---- strain: what the world is being asked to carry ---- */
    this._acc += dt;
    if (this._acc >= PASS) {
      const step = this._acc;
      this._acc = 0;
      /* a full census is a few hundred entities; every two seconds is
         nothing, and it keeps the book honest as towns grow */
      this._scan -= step;
      if (this._scan <= 0) { this._scan = 2.0; this._rescan(); }

      /* the fuel window: ~20 s of memory, so a burst of felling is felt
         while it happens and forgotten once the axes stop */
      const rateNow = this._fuelAcc / Math.max(0.2, step);
      this._fuelAcc = 0;
      const keep = Math.pow(0.5, step / 20);
      this.fuel = this.fuel * keep + rateNow * (1 - keep);
      const perSecond = this._strainRate();
      this.strain = clamp(this.strain + perSecond * step, 0, STRAIN_MAX);
      this.book.drift = perSecond;
      this.book.smoke = this.fuel;

      /* The era turns on strain *or* on time, but never before the climate
         has had a long, unhurried stretch to settle: a very busy realm used to
         be able to strip the island and turn the sky inside ten minutes, which
         made the slow clock feel like a reaction to the player rather than a
         world older than the war. Fifteen minutes is the floor, and it is a
         floor no amount of felling can break -- the first change lands in the
         15-20 minute band the mode is designed around. */
      const floor = Math.min(900, this.eraLengths[this.eraIndex]);
      if (!this.isFinal && this.t >= floor &&
        (this.strain >= this.next.strainAt || this.t >= this.eraLengths[this.eraIndex])) {
        this.turn();
      }

      /* ---- era weather ---- */
      if (this.era.cold) this._tickCold(step);
      if (this.era.lightning) this._tickLightning(step);
      this._tickDrought(step);
    }
  }

  _rescan() {
    const g = this.game;
    let forests = 0, farms = 0, buildings = 0;
    for (let i = 0; i < g.resources.length; i++) {
      const r = g.resources[i];
      if (r.dead) continue;
      if (r.type === 'tree') forests++;
    }
    for (const b of g.buildings) {
      if (b.dead) continue;
      buildings++;
      if (b.type === 'farm') farms++;
    }
    this._forests = forests;
    this._farms = farms;
    this._buildings = buildings;
    this.book = {
      forests, farms, buildings,
      drift: this.book.drift, smoke: this.book.smoke
    };
  }

  /**
   * Strain per second right now. Read as a balance, not a score: farms and
   * buildings push, standing forest pulls, and the era itself drifts upward
   * whatever anyone does.
   */
  _strainRate() {
    const g = this.game;
    const era = this.era;
    /* Industry: every building in the world, and farms twice over -- a
       field is land that used to be forest. */
    const industry = this._buildings * 0.0022 + this._farms * 0.0055;
    /* Forest: the living half of the balance. A whole island takes back a
       fifth of what two empires put out; cut it down and nothing does. */
    const absorb = Math.min(0.24, this._forests * 0.0003);
    /* Fuel: every log that goes on a fire. This is the term a player can
       actually feel, because it answers their own axes. */
    const smoke = this.fuel * 0.004;
    /* The final era cannot be escaped, only delayed. */
    const drift = this.isFinal ? 0 : DRIFT * (1 + this.eraIndex * 0.3);
    return Math.max(0, drift + industry + smoke - absorb);
  }

  /** Turn to the next era. Public: the tests use it, and so does the HUD. */
  turn(forceIndex = -1) {
    const g = this.game;
    const next = forceIndex >= 0 ? forceIndex : this.eraIndex + 1;
    if (next >= ERAS.length) return { ok: false };
    const was = this.era;
    this.eraIndex = next;
    this.t = 0;
    this.turns++;
    /* each era is a little longer than the last, so the late game has room */
    if (!this.isFinal) this.eraLengths[this.eraIndex] = ERA_LENGTH[this.eraIndex];
    this._emit('turn', { from: was.id, to: this.era.id });
    if (g) {
      if (g.notify) g.notify(`The sky turns: ${this.era.name}`, this.era.id === 'temperate' ? 'info' : 'warn');
      if (g.sound) g.sound.play(this.era.id === 'storms' ? 'explosion' : 'ageUp');
      if (g.onEvent) g.onEvent('climate', { era: this.era.id, name: this.era.name });
      /* the turn is a spectacle, not a toast: a pressure wave over the map */
      if (g.fx && g.playerBase) {
        const x = g.playerBase.x, z = g.playerBase.z;
        g.fx.glowPulse?.(x, g.heightAt(x, z) + 2, z, 2, 0.8, 0.5);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          g.fx.dust?.(x + Math.cos(a) * 8, g.heightAt(x, z) + 0.4, z + Math.sin(a) * 8, 3, 1.2);
        }
      }
    }
    return { ok: true, era: this.era };
  }

  /* ------------------------------------------------------------
     era weather incidents
     ------------------------------------------------------------ */
  _tickCold(dt) {
    const g = this.game;
    this.armed.cold = (this.armed.cold || 0) + dt;
    if (this.armed.cold < 1.0) return;
    this.armed.cold = 0;
    /* The cold is not evenly cruel: a man beside a hearth is fine, a man on
       the far side of the island is losing fingers. */
    for (const u of g.units) {
      if (u.dead || u.garrisoned || u.type === 'villager') continue;
      if (u.team === 0) continue;
      if (this._nearHearth(u)) continue;
      u.takeDamage(0.8, null, 'pierce');
    }
  }

  _nearHearth(u) {
    const list = this.game.buildings;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dead || b.team !== u.team) continue;
      if ((b.x - u.x) ** 2 + (b.z - u.z) ** 2 <= 20 * 20) return true;
    }
    return false;
  }

  _tickLightning(dt) {
    const g = this.game;
    this.armed.lightning += dt;
    if (this.armed.lightning < 22) return;
    this.armed.lightning = 0;
    /* Tall, finished buildings are the target -- a lightning rod is a tower
       to the sky, and a town that has built high has more to lose. */
    const cands = [];
    for (const b of g.buildings) {
      if (b.dead || b.team === 0 || b.buildProgress < 0.99) continue;
      if (b.type === 'town_center' || b.type === 'castle' || b.type === 'watch_tower' || b.type === 'market' || b.type === 'monastery') cands.push(b);
    }
    if (!cands.length) return;
    const b = cands[(g.rng() * cands.length) | 0];
    const dmg = Math.min(240, b.maxHp * 0.16);
    b.takeDamage(dmg, null, 'siege');
    if (g.fx) {
      const y = g.heightAt(b.x, b.z);
      g.fx.beam?.(b.x, b.z, y + 40, y + (b.def.height || 5), { color: [0.86, 0.9, 1], scale: 2.4, life: 0.22, jag: 0.5, alpha: 0.9 });
      g.fx.explosion?.(b.x, y + 2, b.z, 1.6);
      g.fx.sparks?.(b.x, y + 3, b.z, 10, [1, 0.95, 0.7]);
    }
    if (g.sound) g.sound.play('explosion', b.x, b.z);
    if (b.team === g.playerTeam && g.notify) g.notify('Lightning has struck your roofs', 'bad');
    this.lastEvent = { kind: 'lightning', x: b.x, z: b.z, t: g.time };
    this._emit('lightning', { x: b.x, z: b.z });
  }

  _tickDrought(dt) {
    if (this.era.id !== 'drought') return;
    const g = this.game;
    this._droughtT += dt;
    if (this._droughtT < 20) return;
    this._droughtT = 0;
    /* The herds leave. A drought with no visible consequence is just a
       number; this one walks your food supply off the map, one animal at a
       time, and the corpse of the node is the evidence. */
    const herds = g.resources.filter((r) => !r.dead && r.herd && r.amount > 0);
    if (!herds.length) return;
    const r = herds[(g.rng() * herds.length) | 0];
    const lost = Math.min(r.amount, Math.ceil(r.amount * 0.35));
    r.amount -= lost;
    if (r.amount <= 0) { r.dead = true; r.deadT = 0; }
    if (g.fx) g.fx.dust?.(r.x, g.heightAt(r.x, r.z) + 0.4, r.z, 4, 1.1);
    this.lastEvent = { kind: 'herds', x: r.x, z: r.z, t: g.time };
    this._emit('herds', { x: r.x, z: r.z, lost });
    if (r.amount <= 0 && g.notify) g.notify('A herd has left the island — the wells are dry', 'warn');
  }

  /** Called by Game.onGather for every load taken off the land. */
  noteGather(kind, amount) {
    if (kind === 'wood') this._fuelAcc += amount;
  }

  /* ------------------------------------------------------------
     multiplier accessors (read by the rest of the simulation)
     ------------------------------------------------------------ */
  /** Food gathering. The era and the season multiply. */
  foodMul() { return this.era.food; }
  woodMul() { return this.era.wood; }
  speedMul() { return this.era.speed; }
  healMul() { return this.era.heal; }
  moraleMul() { return this.era.morale; }

  /** Weight for drawing an omen, so the deck answers the sky. */
  omenWeight(id) {
    const w = this.era.omenWeights[id];
    return typeof w === 'number' ? w : 1;
  }

  /** How much longer this season lasts, in this climate. */
  seasonStretch(key) {
    const id = this.era.id;
    if (id === 'killing_winter') return key === 'winter' ? 1.8 : 0.55;
    if (id === 'drought') return key === 'summer' ? 1.45 : key === 'winter' ? 0.7 : 0.9;
    if (id === 'thaw') return key === 'spring' ? 1.35 : key === 'winter' ? 0.7 : 0.95;
    if (id === 'storms') return key === 'autumn' ? 1.2 : 1;
    return 1;
  }

  /** An atmosphere the renderer can lay over the sky, or null. */
  atmosphere() {
    const e = this.era;
    if (e.id === 'temperate') return null;
    return {
      tint: e.tint,
      fog: e.fog,
      cloud: e.cloud,
      night: e.night,
      exposure: e.id === 'drought' ? 1.06 : e.id === 'storms' ? 0.92 : 1
    };
  }

  /* ------------------------------------------------------------
     reporting
     ------------------------------------------------------------ */
  describe() {
    const e = this.era;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const lines = [
      `${e.name} — ${e.blurb}`,
      `Farm yields ${pct(e.food)}  Wood ${pct(e.wood)}  March ${pct(e.speed)}`,
      `Strain ${Math.round(this.strain)} of 100`,
    ];
    if (!this.isFinal) {
      const left = Math.ceil(this.remaining);
      lines.push(`The next turn: ${this.next.name} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} (or at strain ${this.next.strainAt})`);
    } else lines.push('This is the last sky.');
    return lines.join('\n');
  }

  /** One line for the HUD strip. */
  chip() {
    return {
      id: this.era.id,
      name: this.era.name,
      icon: this.era.icon,
      strain: this.strain,
      remaining: this.remaining,
      progress: this.progress,
      threat: this.era.id === 'temperate' ? 0 : (this.isFinal ? 3 : this.eraIndex + 1)
    };
  }

  _emit(kind, data) {
    this.events.push({ kind, data, t: this.game ? this.game.time : 0 });
    if (this.events.length > 20) this.events.shift();
  }

  drain() { const e = this.events.slice(); this.events.length = 0; return e; }

  toJSON() {
    return {
      era: this.era.id, t: Math.round(this.t), strain: Math.round(this.strain * 10) / 10,
      turns: this.turns, elapsed: Math.round(this.elapsed)
    };
  }

  fromJSON(d) {
    if (!d) return;
    const idx = ERAS.findIndex((e) => e.id === d.era);
    this.eraIndex = idx >= 0 ? idx : 0;
    this.t = Number(d.t) || 0;
    this.strain = clamp(Number(d.strain) || 0, 0, STRAIN_MAX);
    this.turns = Number(d.turns) || 0;
    this.elapsed = Number(d.elapsed) || 0;
    this.eraLengths = ERA_LENGTH.slice();
  }
}
