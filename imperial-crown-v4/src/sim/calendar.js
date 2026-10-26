/* ============================================================
   calendar.js — the Wheel of the Year
   ------------------------------------------------------------
   A match is not one long summer. The year turns on its own clock,
   one season per in-game day, and every season is a different game:

     Spring   food flows, the wounded recover, the roads are mud
     Summer   farms are rich and armour is hot: slow, but fast to build
     Autumn   wood and gold are easy, and the granary fills once
     Winter   food dies, the cold eats morale, and the roads freeze

   And at every turn of the season the sky shows an OMEN: one rule
   changed for the whole season, announced to both players and drawn
   from a deck that does not repeat a card until it has been through
   the whole deck. The omens are not decoration -- each one changes a
   number the player can plan around, and several of them make a
   strategy that was working stop working:

     The Red Comet      +18 % damage, but no man heals
     The Long Night     darkness lasts half again as long
     Plague Winds       enemies on your soil rot
     Bountiful Earth    +25 % from every resource
     The Iron Sky       archers reach further and hit harder
     The Silent March   +14 % speed, -45 % sight: you are blind
     The Great Frost    buildings take cold damage; repair or lose them
     The Wolf Moon      the wild turns on everyone

   Reading the omen and changing plan is the point. The Wheel is
   deterministic from the game seed and saved with the match, so a
   reload does not reshuffle the sky.
   ============================================================ */

export const SEASONS = [
  {
    key: 'spring', name: 'Spring', icon: 'leaf', tint: [0.72, 0.95, 0.62],
    blurb: 'The roads are mud, but nothing starves.',
    food: 1.12, wood: 0.95, gold: 0.95, stone: 1.0,
    speed: 0.96, morale: 1.25, heal: 1.25
  },
  {
    key: 'summer', name: 'Summer', icon: 'flame', tint: [1.0, 0.86, 0.45],
    blurb: 'Rich fields, hot armour.',
    food: 1.18, wood: 1.0, gold: 1.0, stone: 1.0,
    speed: 0.94, morale: 1.0, heal: 1.0
  },
  {
    key: 'autumn', name: 'Autumn', icon: 'wheat', tint: [1.0, 0.7, 0.34],
    blurb: 'Timber and gold, and one last harvest.',
    food: 1.0, wood: 1.18, gold: 1.16, stone: 1.0,
    speed: 1.0, morale: 1.0, heal: 1.0,
    harvest: true
  },
  {
    key: 'winter', name: 'Winter', icon: 'mountain', tint: [0.72, 0.84, 1.0],
    blurb: 'The fields are dead and the cold is an enemy.',
    food: 0.72, wood: 0.86, gold: 0.94, stone: 1.06,
    speed: 0.9, morale: 0.6, heal: 0.75,
    cold: true
  }
];

/* The omen deck. `apply` is data, not code: the multipliers are read by the
   simulation through the small accessor set at the bottom of this file. */
export const OMENS = [
  {
    id: 'red_comet', name: 'The Red Comet', icon: 'flame', bad: false,
    text: '+18 % damage for every army; no wound closes on its own.',
    attack: 1.18, heal: 0
  },
  {
    id: 'long_night', name: 'The Long Night', icon: 'eye', bad: true,
    text: 'Darkness lasts half again as long. Night raids pay double.',
    nightStretch: 1.5
  },
  {
    id: 'plague_winds', name: 'Plague Winds', icon: 'skull', bad: true,
    text: 'Soldiers standing on enemy soil sicken and rot.',
    plague: true
  },
  {
    id: 'bountiful', name: 'Bountiful Earth', icon: 'wheat', bad: false,
    text: '+25 % from every resource, everywhere.',
    gather: 1.25
  },
  {
    id: 'iron_sky', name: 'The Iron Sky', icon: 'bow', bad: false,
    text: 'Archers reach 2 m further and strike 20 % harder.',
    archerRange: 2, archerAttack: 1.2
  },
  {
    id: 'silent_march', name: 'The Silent March', icon: 'boot', bad: false,
    text: '+14 % speed for every soldier — and 45 % less sight.',
    speed: 1.14, sight: 0.55
  },
  {
    id: 'great_frost', name: 'The Great Frost', icon: 'mountain', bad: true,
    text: 'Buildings crack in the cold. Repair them or lose them.',
    buildingDamage: 0.9
  },
  {
    id: 'wolf_moon', name: 'The Wolf Moon', icon: 'deer', bad: true,
    text: 'The wild turns on every camp. Herds bite back.',
    wolves: true
  },
  {
    id: 'iron_harvest', name: 'The Iron Harvest', icon: 'anvil', bad: false,
    text: 'Every building goes up 30 % faster.',
    buildSpeed: 1.3
  },
  {
    id: 'still_air', name: 'The Still Air', icon: 'ship', bad: true,
    text: 'Arrows lose their way: ranged attacks miss a third of the time.',
    arrowMiss: 0.33
  }
];
export const OMEN_BY_ID = new Map(OMENS.map((o) => [o.id, o]));

/** One in-game day per season. */
const DEFAULT_SEASON_SECONDS = 300;   // five minutes a season: a 15-minute match is most of a year

export class Calendar {
  constructor(game, opts = {}) {
    this.game = game;
    this.seasonLength = opts.seasonLength || DEFAULT_SEASON_SECONDS;
    this.year = 1;
    this.seasonIndex = 0;
    this.t = 0;                       // seconds into the current season
    this.omen = null;
    this.deck = [];
    this.history = [];
    this._rng = null;
  }

  /* ------------------------------------------------------------
     the deck
     ------------------------------------------------------------ */
  /** A private, deterministic stream: the Wheel must not eat the sim's rng. */
  rng() {
    if (!this._rng) {
      const seed = ((this.game && this.game.seed) || 20261) ^ 0x5f3759df;
      let s = seed >>> 0;
      this._rng = () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
      };
    }
    return this._rng();
  }

  /** Draw the next omen, never repeating a card until the deck is empty. */
  drawOmen() {
    if (!this.deck.length) {
      this.deck = OMENS.map((o) => o.id);
      /* shuffle without touching the sim rng */
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        const tmp = this.deck[i]; this.deck[i] = this.deck[j]; this.deck[j] = tmp;
      }
    }
    const id = this.deck.pop();
    return OMEN_BY_ID.get(id) || null;
  }

  /* ------------------------------------------------------------
     accessors the simulation reads
     ------------------------------------------------------------ */
  get season() { return SEASONS[this.seasonIndex] || SEASONS[0]; }
  get omenMul() { return this.omen || {}; }

  /** 0..1 through the current season, for the HUD. */
  get progress() { return Math.min(1, this.t / this.seasonLength); }
  get remaining() { return Math.max(0, this.seasonLength - this.t); }

  gatherMul(kind) {
    const s = this.season;
    const base = kind === 'food' ? s.food : kind === 'wood' ? s.wood : kind === 'gold' ? s.gold : s.stone;
    return base * (this.omenMul.gather || 1);
  }
  speedMul() { return this.season.speed * (this.omenMul.speed || 1); }
  attackMul() { return this.omenMul.attack || 1; }
  healMul() { return this.season.heal * (this.omenMul.heal !== undefined ? this.omenMul.heal : 1); }
  sightMul() { return this.omenMul.sight || 1; }
  moraleMul() { return this.season.morale; }
  buildMul() { return this.omenMul.buildSpeed || 1; }
  /** how much longer the dark lasts (1 = normal) */
  get nightStretch() { return this.omenMul.nightStretch || 1; }

  /* ------------------------------------------------------------
     the turn of the season
     ------------------------------------------------------------ */
  start(immediate = true) {
    this.t = 0;
    this.seasonIndex = 0;
    this.year = 1;
    this.omen = this.drawOmen();
    this._announce(true);
    if (immediate) this._applySeasonStart();
  }

  _announce(first = false) {
    const g = this.game;
    const s = this.season;
    const o = this.omen;
    if (!g.notify) return;
    const head = first ? 'The wheel turns' : `${s.name} comes again`;
    g.notify(`${head} — ${s.blurb}`, s.key === 'winter' ? 'bad' : 'info');
    if (o) g.notify(`Omen: ${o.name} — ${o.text}`, o.bad ? 'bad' : 'good');
    if (g.onEvent) {
      try { g.onEvent('season', { season: s.key, name: s.name, omen: o && o.id }); } catch (e) { /* listeners */ }
    }
  }

  /** Autumn fills the granary once; winter costs the unprepared. */
  _applySeasonStart() {
    const g = this.game;
    const s = this.season;
    if (s.harvest) {
      for (const team of [1, 2]) {
        const st = g.teams.get(team);
        if (!st) continue;
        const villagers = g.units.filter((u) => !u.dead && u.team === team && u.type === 'villager').length;
        const bonus = Math.round(18 + villagers * 4);
        st.res.food += bonus;
        if (team === g.playerTeam) g.notify(`Harvest: +${bonus} food`, 'good');
      }
      if (g.sound) g.sound.play('coin');
    }
    if (s.key === 'winter' && g.fx) {
      /* a breath of cold over the whole map: cheap, and it sells the turn */
      const b = g.playerBase || { x: 0, z: 0 };
      g.fx.smoke(b.x, g.heightAt(b.x, b.z) + 1.2, b.z, 14, 6, 3.2);
    }
  }

  update(dt) {
    this.t += dt;
    if (this.t < this.seasonLength) return;
    this.t -= this.seasonLength;
    this.seasonIndex++;
    if (this.seasonIndex >= SEASONS.length) {
      this.seasonIndex = 0;
      this.year++;
    }
    this.omen = this.drawOmen();
    this.history.push({ year: this.year, season: this.season.key, omen: this.omen && this.omen.id });
    if (this.history.length > 24) this.history.shift();
    this._announce(false);
    this._applySeasonStart();
    if (this.game.statsVersion !== undefined) this.game.statsVersion++;
  }

  /* ------------------------------------------------------------
     things that happen every tick, not every season
     ------------------------------------------------------------ */
  /** Called from the game tick. The two omens with a body count. */
  tick(dt) {
    const g = this.game;
    const o = this.omen;
    if (o && o.buildingDamage) {
      for (const b of g.buildings) {
        if (b.dead || b.team === 0) continue;
        if (b.buildProgress !== undefined && b.buildProgress < 0.999) continue;
        /* the Frost never finishes a building -- it makes you spend on
           repair, which is the whole cost of the omen */
        if (b.hp <= b.maxHp * 0.25) continue;
        b.hp = Math.max(b.maxHp * 0.25, b.hp - o.buildingDamage * dt);
      }
    }
    if (o && o.plague) this._plagueT = (this._plagueT || 0) + dt;
    if (o && o.plague && this._plagueT >= 1) {
      this._plagueT = 0;
      for (const u of g.units) {
        if (u.dead || u.garrisoned || u.type === 'villager') continue;
        if (u.team === 0) continue;
        const enemyBase = u.team === 1 ? g.enemyBase : g.playerBase;
        if (!enemyBase) continue;
        if ((u.x - enemyBase.x) ** 2 + (u.z - enemyBase.z) ** 2 > 58 * 58) continue;
        u.takeDamage(1.4, null, 'pierce');
        if (g.fx && g.rng() < 0.3) g.fx.sparks(u.x, (u.y || 0) + 1, u.z, 1, [0.6, 0.9, 0.4]);
      }
    }
    if (o && o.wolves && (this._wolfT = (this._wolfT || 0) + dt) > 26) {
      this._wolfT = 0;
      /* an omen should not be a random unit deletion: it is aimed at whoever
         is furthest from home, which is the raid the player just sent out */
      let victim = null, worst = -1;
      for (const u of g.units) {
        if (u.dead || u.garrisoned || u.team === 0 || u.type === 'villager') continue;
        const home = u.team === 1 ? g.playerBase : g.enemyBase;
        if (!home) continue;
        const d = Math.hypot(u.x - home.x, u.z - home.z);
        if (d > 26 && d > worst) { worst = d; victim = u; }
      }
      if (victim) {
        victim.takeDamage(16, null, 'pierce');
        if (g.fx) {
          g.fx.sparks(victim.x, victim.y + 1.2, victim.z, 8, [0.9, 0.2, 0.15]);
          g.fx.glowPulse(victim.x, victim.y + 1, victim.z, 1, 0.2, 0.1);
        }
        if (victim.team === g.playerTeam && g.notify) g.notify('Wolves take a straggler', 'bad');
      }
    }
  }

  /* ------------------------------------------------------------ */
  toJSON() {
    return {
      year: this.year, season: this.seasonIndex, t: Math.round(this.t),
      omen: this.omen ? this.omen.id : null, deck: this.deck.slice()
    };
  }
  fromJSON(d) {
    if (!d) return;
    if (Number.isFinite(d.year)) this.year = d.year;
    if (Number.isFinite(d.season)) this.seasonIndex = Math.max(0, Math.min(SEASONS.length - 1, d.season));
    if (Number.isFinite(d.t)) this.t = d.t;
    if (Array.isArray(d.deck)) this.deck = d.deck.filter((id) => OMEN_BY_ID.has(id));
    this.omen = d.omen ? (OMEN_BY_ID.get(d.omen) || null) : null;
  }

  /** What the tooltip in the top bar says. */
  describe() {
    const s = this.season;
    const o = this.omen;
    const pct = (v) => `${Math.round(v * 100)}%`;
    return [
      `${s.name} — ${s.blurb}`,
      `Food ${pct(s.food)}  Wood ${pct(s.wood)}  Gold ${pct(s.gold)}`,
      `Speed ${pct(s.speed)}  Healing ${pct(s.heal)}`,
      o ? `Omen: ${o.name} — ${o.text}` : 'No omen'
    ].join('\n');
  }
}
