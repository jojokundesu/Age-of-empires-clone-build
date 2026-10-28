/* ============================================================
   realm.js — the Crown's Standing
   ------------------------------------------------------------
   A crown is not a building. It is a bargain with two estates,
   and both of them keep books:

     THE COMMONS   want bread, roofs and sons who come home.
                   They gather your resources and fill your army,
                   so when they are angry the whole engine slows
                   and eventually they take up pitchforks and burn
                   the town that failed them.

     THE NOBILITY  want titles, taxes and victories. They hold
                   the gold, the horses and the offices, so when
                   they are angry the treasury quietly empties and
                   a rival claimant arrives with riders at his back.

   Neither estate is a mood meter that drifts on its own. Each one
   has a TARGET computed from the actual state of your realm --
   houses, crowding, the granary, farms, markets, soldiers, the
   court, the season, the omen, the men you have buried and the
   battles you have won -- and the live value *moves toward that
   target*. Kill a dozen men in a winter war while taxing them
   into the ground and the target falls far enough that the bar
   falls with it, and the moment the bar spends a long time below
   the line, rebellion.

   The ledger is public: the committee of the realm (and the HUD)
   can read exactly which lines are pulling which way, so a player
   is never told "your people are unhappy" without being told why.
   That is the whole design rule of this file -- no hidden moods.

   Everything here is deterministic and saveable, and the AI plays
   by exactly the same rules: it sets a tax rate, it throws feasts,
   and its own commons can rise against it.
   ============================================================ */
import { clamp } from '../core/math.js';
import { STATE } from './entities.js';

/* The two crowns, and the warbands that rise against each. A rebel
   team is not a third faction: it answers exactly one crown, and
   the other crown neither fears nor fights it. `game.isHostile`
   is the single place that rule lives. */
const P = 1;
const E = 2;
/* Rebel teams live in their own range so that a war of four crowns can still
   have four separate risings. `rebelTeamOf(3)` is 13, `crownOfRebel(13)` is 3:
   one addition and one subtraction, and every kingdom -- however many there
   are -- gets a warband that answers only it. */
export const REBEL_BASE = 10;
export const TEAM_REBEL_P = REBEL_BASE + P;
export const TEAM_REBEL_E = REBEL_BASE + E;
export const rebelTeamOf = (team) => REBEL_BASE + team;
export const crownOfRebel = (team) => (team > REBEL_BASE ? team - REBEL_BASE : 0);

/** The poll tax dial. Gold is per villager per second, the rest are points of
    target standing: a tax rate is a trade, never a free number. */
export const TAX_RATES = [
  {
    id: 'merciful', name: 'Merciful', icon: 'heart',
    gold: 0.008, commons: 9, nobles: -10,
    blurb: 'Light dues. The commons bless you; the nobility mutter.'
  },
  {
    id: 'fair', name: 'Fair', icon: 'coin',
    gold: 0.026, commons: 0, nobles: 0,
    blurb: 'The old assessment. Nobody is happy, nobody is angry.'
  },
  {
    id: 'heavy', name: 'Heavy', icon: 'crown',
    gold: 0.055, commons: -12, nobles: 8,
    blurb: 'A war levy. The treasury fills while the villages empty.'
  }
];
const TAX_BY_ID = new Map(TAX_RATES.map((t) => [t.id, t]));

export const ESTATES = [
  { id: 'commons', name: 'The Commons', icon: 'people', color: '#9be08a' },
  { id: 'nobles', name: 'The Nobility', icon: 'crown', color: '#e8c47a' }
];

/** Standing 0..100. The names are what the HUD calls the bands. */
export const BANDS = [
  { at: 78, id: 'devoted', name: 'Devoted' },
  { at: 60, id: 'content', name: 'Content' },
  { at: 42, id: 'uneasy', name: 'Uneasy' },
  { at: 24, id: 'angry', name: 'Angry' },
  { at: 0, id: 'hostile', name: 'Hostile' }
];
export const bandOf = (v) => BANDS.find((b) => v >= b.at) || BANDS[BANDS.length - 1];

const START = { commons: 62, nobles: 56 };
const REVOLT_AT = 18;        // below this the estate starts counting towards a rising
const SAFE_AT = 34;          // above this the countdown unwinds
const UNREST_MAX = 100;
const CRISIS_COOLDOWN = 95;  // seconds during which a beaten estate cannot rise again
const PASS = 0.25;           // the ledger is settled four times a second

/* The omen deck's effect on the realm's temper, by id. Kept beside the
   calendar rather than inside it: the Wheel says what the sky does, the
   realm says what people make of it. */
const OMEN_MOOD = {
  red_comet: { commons: -4, nobles: 3 },
  long_night: { commons: -2, nobles: 0 },
  plague_winds: { commons: -6, nobles: -4 },
  bountiful: { commons: 5, nobles: 2 },
  iron_sky: { commons: 0, nobles: 3 },
  silent_march: { commons: 0, nobles: 2 },
  great_frost: { commons: -5, nobles: -2 },
  wolf_moon: { commons: -5, nobles: -1 },
  iron_harvest: { commons: 3, nobles: 2 },
  still_air: { commons: -1, nobles: -1 }
};

export const freshRealmState = () => ({
  commons: START.commons,
  nobles: START.nobles,
  tax: 'fair',
  /* shock bookkeeping: grief for the dead, glory for victories, shame for
     ground lost. They decay, and they bend the target while they last. */
  grief: 0,
  glory: 0,
  shame: 0,
  unrestC: 0,
  unrestN: 0,
  cooldownC: 0,
  cooldownN: 0,
  golden: false,
  goldenArmed: 0,
  goldenCd: 0,
  feastCd: 0,
  endowCd: 0,
  embezzle: 0,
  risenC: 0,
  risenN: 0,
  lastBand: 'content',
  // the visible ledger, rebuilt each settle
  lines: { commons: [], nobles: [] },
  target: { commons: START.commons, nobles: START.nobles },
  rate: { commons: 0, nobles: 0 }
});

export class Realm {
  constructor(game) {
    this.game = game;
    this._acc = 0;
    this.teams = new Map();
    this.events = [];          // short ring the UI can drain for notices
    this.crises = 0;
  }

  /** Never null: an unknown (rebel/neutral) team reads as an empty realm. */
  state(team) {
    let s = this.teams.get(team);
    if (!s) { s = freshRealmState(); s.empty = true; this.teams.set(team, s); }
    return s;
  }

  /** Every kingdom with a realm (rebels and shrines do not have one). */
  kingdoms() {
    const out = [];
    for (const [team, s] of this.teams) if (!s.empty) out.push(team);
    return out;
  }

  has(team) { return !!this.teams.get(team); }

  /* ------------------------------------------------------------
     the poll tax
     ------------------------------------------------------------ */
  taxOf(team) { return this.state(team).tax; }

  setTax(team, id) {
    const def = TAX_BY_ID.get(id);
    if (!def) return { ok: false, reason: 'No such tax' };
    const st = this.teams.get(team);
    if (!st) return { ok: false, reason: 'No realm' };
    if (st.tax === id) return { ok: true, unchanged: true, name: def.name };
    st.tax = id;
    if (team === P && this.game.notify) {
      this.game.notify(`Tax set to ${def.name.toLowerCase()}`, id === 'heavy' ? 'warn' : 'info');
    }
    this._emit(team, 'tax', { id, name: def.name });
    return { ok: true, name: def.name };
  }

  /** Gold per second the poll tax brings in, after season, age and graft. */
  taxIncome(team) {
    const g = this.game;
    const st = g.teams.get(team);
    if (!st || st.rebel || team === 0) return 0;
    const rate = TAX_BY_ID.get(this.state(team).tax) || TAX_BY_ID.get('fair');
    let villagers = 0;
    const units = g.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.team !== team || u.type !== 'villager') continue;
      villagers++;
    }
    if (!villagers) return 0;
    let income = villagers * rate.gold * (1 + st.age * 0.12);
    /* the Wheel prices gold too, and a hostile nobility lets it slip away */
    if (g.calendar) income *= g.calendar.gatherMul('gold');
    if (g.difficultyKey !== 'sandbox' && team !== P) income *= this.game.difficulty?.income ?? 1;
    const state = this.state(team);
    if (state.nobles < 25) income *= 1 - (25 - state.nobles) * 0.012;   // quiet embezzlement
    if (state.embezzle > 0) income *= 0.5;                             // an open conspiracy
    return Math.max(0, income);
  }

  /* ------------------------------------------------------------
     the ledger: where a realm's standing *wants* to be
     ------------------------------------------------------------ */
  /**
   * Reads the whole board once and returns the two targets with the
   * line items that produced them. The UI prints the lines verbatim, so
   * every number a player sees here has to be a real input to the model.
   */
  ledger(team) {
    const g = this.game;
    const st = g.teams.get(team);
    const s = this.state(team);
    const c = [];
    const n = [];
    const add = (arr, label, value, icon) => { if (Math.abs(value) >= 0.05) arr.push({ label, value, icon }); };

    if (!st) return { commons: c, nobles: n, targetC: START.commons, targetN: START.nobles };

    let commons = 50, nobles = 50;
    add(c, 'The crown endures', 50, 'crown');
    add(n, 'A lord with a seat', 50, 'crown');

    /* --- roofs, bread, crowding --- */
    let houses = 0, farms = 0, mills = 0, monasteries = 0, markets = 0, military = 0, tc = 0, castles = 0;
    for (const b of g.buildings) {
      if (b.dead || b.team !== team || b.buildProgress < 0.99) continue;
      switch (b.type) {
        case 'house': houses++; break;
        case 'farm': farms++; break;
        case 'mill': mills++; break;
        case 'monastery': monasteries++; break;
        case 'outpost_shrine': monasteries++; break;
        case 'market': markets++; break;
        case 'barracks': case 'stable': case 'archery_range': case 'siege_workshop': military++; break;
        case 'town_center': tc++; break;
        case 'castle': case 'keep': castles++; break;
        default: break;
      }
    }
    add(c, `${houses} house${houses === 1 ? '' : 's'}`, Math.min(9, houses * 0.9), 'house');
    const cap = st.popCap || 0, used = st.popUsed || 0;
    const crowd = cap > 0 ? used / cap : 0;
    if (crowd > 0.85) add(c, 'Every roof is full', -Math.min(8, (crowd - 0.85) * 46), 'warning');
    if (cap > 0 && cap - used <= 1) add(c, 'No room left to grow', -4, 'warning');
    const food = st.res ? st.res.food : 0;
    if (food < 60) add(c, 'The granary is empty', -7, 'wheat');
    else if (food > 250) add(c, 'Full granaries', 4, 'wheat');
    if (farms) add(c, `${farms} farm${farms === 1 ? '' : 's'}`, Math.min(5, farms * 0.7), 'wheat');
    if (mills) add(c, 'A working mill', Math.min(2, mills), 'cog');
    if (monasteries) add(c, 'The faith is kept', Math.min(6, monasteries * 2.5), 'temple');

    /* --- the nobility's side: a host, a market, stone halls --- */
    if (military) add(n, `${military} muster${military === 1 ? '' : 's'}`, Math.min(5, military * 1.4), 'sword');
    if (markets) add(n, 'Trade and coin', Math.min(4, markets * 2), 'market');
    if (castles) add(n, 'A castle seat', Math.min(6, castles * 3), 'castle');
    if (!tc) add(n, 'No hall to hold court in', -9, 'warning');
    let army = 0;
    for (const u of g.units) {
      if (u.dead || u.team !== team || u.type === 'villager') continue;
      if ((u.def.attack || 0) > 0) army++;
    }
    if (army) {
      add(n, `${army} under arms`, Math.min(6, army * 0.35), 'shield');
      const levy = Math.max(0, army - 10) * 0.32;
      if (levy > 0.05) add(c, 'Too many levies taken', -Math.min(5, levy), 'boot');
    }

    /* --- the court --- */
    if (g.court) {
      for (const office of ['chancellor', 'hierophant', 'marshal', 'spymaster']) {
        const h = g.court.holder(team, office);
        if (!h || h.dead) continue;
        if (office === 'chancellor') { add(c, 'The Chancellor speaks for you', 5, 'wheat'); add(n, 'A Chancellor in office', 2, 'scroll'); }
        if (office === 'hierophant') { add(c, 'The Hierophant blesses the fields', 5, 'temple'); }
        if (office === 'marshal') { add(n, 'A Marshal leads your host', 4, 'sword'); }
        if (office === 'spymaster') { add(n, 'A Spymaster watches the halls', 2, 'eye'); add(c, 'Whispers in the night', -2, 'eye'); }
      }
    }

    /* --- the sky --- */
    if (g.calendar) {
      const season = g.calendar.season;
      if (season) {
        if (season.key === 'winter') { add(c, 'Winter bites', -7, 'mountain'); add(n, 'Winter quarters', -3, 'mountain'); }
        else if (season.key === 'spring') add(c, 'Spring planting', 2, 'leaf');
        else if (season.key === 'summer') add(c, 'A warm summer', 1, 'flame');
      }
      const omen = g.calendar.omen;
      if (omen && OMEN_MOOD[omen.id]) {
        const m = OMEN_MOOD[omen.id];
        add(c, `${omen.name}`, m.commons, 'warning');
        add(n, `${omen.name}`, m.nobles, 'warning');
      }
    }

    /* --- the tax --- */
    const tax = TAX_BY_ID.get(s.tax) || TAX_BY_ID.get('fair');
    add(c, `Tax: ${tax.name}`, tax.commons, tax.icon);
    add(n, `Tax: ${tax.name}`, tax.nobles, tax.icon);

    /* --- graves and victories --- */
    if (s.grief > 0.05) add(c, 'Mourning the dead', -Math.min(18, s.grief * 4), 'skull');
    if (s.grief > 0.05) add(n, 'Their sons are gone', -Math.min(8, s.grief * 1.6), 'skull');
    if (s.glory > 0.05) add(n, 'Victories remembered', Math.min(12, s.glory * 3), 'sword');
    if (s.shame > 0.05) add(c, 'Homes burned unavenged', -Math.min(10, s.shame * 2.2), 'flame');

    /* --- the golden day --- */
    if (s.golden) { add(c, 'A golden age', 8, 'bolt'); add(n, 'A golden age', 8, 'bolt'); }
    if (st.age) { add(c, `The ${st.age + 1}th age`, st.age * 1.5, 'castle'); add(n, 'The realm grows', st.age * 2, 'castle'); }

    const tcPenalty = tc ? 0 : -12;
    if (tcPenalty) add(c, 'No Town Centre', tcPenalty, 'warning');

    const targetC = clamp(commons + c.reduce((a, l) => a + l.value, 0) - 50, 4, 96);
    const targetN = clamp(nobles + n.reduce((a, l) => a + l.value, 0) - 50, 4, 96);
    return { commons: c, nobles: n, targetC, targetN };
  }

  /* ------------------------------------------------------------
     effects other systems ask about
     ------------------------------------------------------------ */
  /** How much the realm's temper helps or hurts the work of its people. */
  gatherMul(team) {
    const s = this.teams.get(team);
    if (!s || s.empty || s.rebel) return 1;
    let m;
    if (s.commons >= 50) m = 1 + Math.min(0.08, (s.commons - 50) * 0.0016);
    else m = 1 - Math.min(0.18, (50 - s.commons) * 0.0045);
    if (s.golden) m *= 1.06;
    return m;
  }

  /** A young soldier's first morning: he believes what his village believes. */
  spawnMorale(team) {
    const s = this.teams.get(team);
    if (!s) return 100;
    const avg = (s.commons + s.nobles) * 0.5;
    if (s.golden) return 100;
    if (avg >= 55) return 100;
    return clamp(70 + avg * 0.55, 70, 100);
  }

  band(team, estate) {
    const s = this.teams.get(team);
    return bandOf(s ? s[estate] : 50);
  }

  /** The single worst estate on a team, for a one-glance HUD warning. */
  worst(team) {
    const s = this.teams.get(team);
    if (!s) return { id: 'commons', value: 50, band: bandOf(50) };
    return s.commons <= s.nobles
      ? { id: 'commons', value: s.commons, band: bandOf(s.commons) }
      : { id: 'nobles', value: s.nobles, band: bandOf(s.nobles) };
  }

  /* ------------------------------------------------------------
     the two ways a realm breaks
     ------------------------------------------------------------ */
  /** Cost the crown pays to a mob: wood and food are burned, men are lost. */
  revolt(team) {
    const g = this.game;
    const s = this.teams.get(team);
    if (!s) return { ok: false };
    const rebel = rebelTeamOf(team);
    const homes = [];
    for (const b of g.buildings) {
      if (b.dead || b.team !== team || b.buildProgress < 0.99) continue;
      if (b.type === 'house' || b.type === 'town_center' || b.type === 'mill' || b.type === 'farm') homes.push(b);
    }
    let villagers = 0;
    for (const u of g.units) if (!u.dead && u.team === team && u.type === 'villager') villagers++;
    const count = clamp(3 + Math.floor(villagers / 3), 3, 9);
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const home = homes.length ? homes[(i * 7 + (g.frame | 0)) % homes.length] : null;
      const seat = g.baseOf ? g.baseOf(team) : g.playerBase;
      const bx = home ? home.x : seat.x;
      const bz = home ? home.z : seat.z;
      const a = g.rng() * Math.PI * 2;
      const r = 2.5 + g.rng() * 3.5;
      g.ensureRebelTeam(rebel);
      const u = g.spawnUnitRaw('mob_rioter', rebel, bx + Math.cos(a) * r, bz + Math.sin(a) * r);
      if (!u) continue;
      /* a mob is brave in numbers and breaks the moment it is hit -- the
         definition's own morale, not the 100 a soldier gets */
      u.morale = u.def.morale || 60;
      u.isRebel = true;
      u.rebelAgainst = team;
      spawned.push(u);
      if (g.fx) {
        g.fx.dust(u.x, (u.y || 0) + 0.4, u.z, 3, 0.8);
        if (i % 2 === 0) g.fx.fire(u.x, (u.y || 0) + 1.2, u.z, 1, 0.5);
      }
      /* they march on the nearest hall of the crown that failed them */
      const goal = this._crownTarget(team, u.x, u.z);
      if (goal) {
        u.state = STATE.ATTACK_MOVE;
        u.target = goal;
        u.noAggro = false;
        u.moveTo(goal.x, goal.z, true);
      }
    }
    s.commons = 34;
    s.unrestC = 0;
    s.cooldownC = CRISIS_COOLDOWN;
    s.risenC++;
    this.crises++;
    if (team === P) {
      g.notify('The commons have risen — pitchforks in the streets!', 'bad');
      g.sound?.play('warn');
      g.onEvent?.('revolt', { team, count: spawned.length });
    } else if (g.realm && g.realm !== this) { /* nothing */ }
    this._emit(team, 'revolt', { count: spawned.length });
    return { ok: true, units: spawned, count: spawned.length };
  }

  /** A claimant with riders: the nobility's answer to a crown they no longer trust. */
  conspiracy(team) {
    const g = this.game;
    const s = this.teams.get(team);
    if (!s) return { ok: false };
    const rebel = rebelTeamOf(team);
    let seat = null;
    for (const b of g.buildings) {
      if (b.dead || b.team !== team || b.buildProgress < 0.99) continue;
      if (b.type === 'castle' || b.type === 'barracks' || b.type === 'stable' || b.type === 'town_center') { seat = b; break; }
    }
    const home = g.baseOf ? g.baseOf(team) : g.playerBase;
    const bx = seat ? seat.x : home.x;
    const bz = seat ? seat.z : home.z;
    const spawned = [];
    g.ensureRebelTeam(rebel);
    const lord = g.spawnUnitRaw('claimant_knight', rebel, bx + 5, bz + 4);
    if (lord) {
      lord.isRebel = true;
      lord.rebelAgainst = team;
      lord.morale = 100;
      spawned.push(lord);
    }
    for (let i = 0; i < 2; i++) {
      const u = g.spawnUnitRaw('knight', rebel, bx + 2 + i * 2.5, bz + 6);
      if (!u) continue;
      u.isRebel = true;
      u.rebelAgainst = team;
      u.morale = 100;
      spawned.push(u);
    }
    const goal = this._crownTarget(team, bx, bz);
    for (const u of spawned) {
      if (!goal) break;
      u.state = STATE.ATTACK_MOVE;
      u.target = goal;
      u.noAggro = false;
      u.moveTo(goal.x, goal.z, true);
    }
    if (g.fx) for (const u of spawned) g.fx.sparks(u.x, (u.y || 0) + 1.4, u.z, 5, [1, 0.7, 0.3]);
    s.nobles = 34;
    s.unrestN = 0;
    s.cooldownN = CRISIS_COOLDOWN;
    s.embezzle = 45;
    s.risenN++;
    this.crises++;
    if (team === P) {
      g.notify('A rival claimant has risen — riders are burning your estates!', 'bad');
      g.sound?.play('warn');
      g.onEvent?.('conspiracy', { team });
    }
    this._emit(team, 'conspiracy', { count: spawned.length });
    return { ok: true, units: spawned, count: spawned.length };
  }

  /** The nearest completed building of the crown's own, used as a marching goal. */
  _crownTarget(team, x, z, px, pz) {
    const g = this.game;
    /* A mob picks the nearest thing the crown owns, with the *seat* of the
       crown preferred once it is close enough to see one: a rising that
       burns a far barn and then stands around has been defused, and the
       point of a rising is that it reaches the hall. */
    let best = null, bestD = Infinity;
    let seat = null, seatD = Infinity;
    for (const b of g.buildings) {
      if (b.dead || b.team !== team || b.buildProgress < 0.99) continue;
      const d = (b.x - x) ** 2 + (b.z - z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
      if (b.type === 'town_center' || b.type === 'castle' || b.type === 'keep') {
        if (d < seatD) { seatD = d; seat = b; }
      }
    }
    if (seat && seatD < 70 * 70) return seat;
    if (best) return best;
    /* no buildings at all: march on the old capital */
    const base = g.baseOf ? g.baseOf(team) : g.playerBase;
    return base ? { x: base.x, z: base.z, dead: false, kind: 'point' } : null;
  }

  /* ------------------------------------------------------------
     the two ways a crown buys goodwill
     ------------------------------------------------------------ */
  feast(team) {
    const g = this.game;
    const s = this.teams.get(team);
    if (!s) return { ok: false, reason: 'No realm' };
    if (s.feastCd > 0) return { ok: false, reason: `The tables are still being cleared (${Math.ceil(s.feastCd)}s)` };
    const cost = { food: 140, gold: 90 };
    if (!g.canAfford(team, cost)) return { ok: false, reason: 'A feast needs 140 food and 90 gold' };
    g.spend(team, cost);
    s.commons = clamp(s.commons + 14, 0, 100);
    s.nobles = clamp(s.nobles + 5, 0, 100);
    s.unrestC = Math.max(0, s.unrestC - 25);
    s.feastCd = 70;
    if (g.addBuff) g.addBuff(team, 'gather', 1.08, 45, 'Feast');
    if (team === P) {
      g.notify('A feast in every square — the commons are yours again', 'good');
      g.sound?.play('complete');
    }
    this._emit(team, 'feast', {});
    return { ok: true };
  }

  endow(team) {
    const g = this.game;
    const s = this.teams.get(team);
    if (!s) return { ok: false, reason: 'No realm' };
    if (s.endowCd > 0) return { ok: false, reason: `The titles are still being drawn up (${Math.ceil(s.endowCd)}s)` };
    const cost = { gold: 180 };
    if (!g.canAfford(team, cost)) return { ok: false, reason: 'Endowments need 180 gold' };
    g.spend(team, cost);
    s.nobles = clamp(s.nobles + 14, 0, 100);
    s.commons = clamp(s.commons + 2, 0, 100);
    s.unrestN = Math.max(0, s.unrestN - 25);
    s.endowCd = 80;
    if (team === P) {
      g.notify('Titles and endowments granted — the nobility rally', 'good');
      g.sound?.play('complete');
    }
    this._emit(team, 'endow', {});
    return { ok: true };
  }

  /* ------------------------------------------------------------
     bookkeeping from the rest of the simulation
     ------------------------------------------------------------ */
  onUnitKilled(unit, attacker) {
    if (!unit || !unit.kind) return;
    const s = this.teams.get(unit.team);
    const rebel = unit.team === TEAM_REBEL_P || unit.team === TEAM_REBEL_E;
    if (s && !rebel) {
      const civilian = unit.type === 'villager';
      const fighter = !civilian && (unit.def.attack || 0) > 0;
      s.grief = Math.min(60, s.grief + (civilian ? 2.4 : fighter ? 1.2 : 0.6));
      s.commons = clamp(s.commons - (civilian ? 1.5 : 0.7), 0, 100);
      if (fighter) s.nobles = clamp(s.nobles - 0.25, 0, 100);
      /* slain by their own people: the crown could not keep the peace */
      if (attacker && (attacker.team === TEAM_REBEL_P || attacker.team === TEAM_REBEL_E)) {
        s.commons = clamp(s.commons - 1.1, 0, 100);
      }
    }
    const killerState = attacker ? this.teams.get(attacker.team) : null;
    if (killerState && !killerState.empty) {
      if (rebel) {
        /* breaking a rising is what a crown is *for*: the realm steadies */
        killerState.commons = clamp(killerState.commons + 2.2, 0, 100);
        killerState.nobles = clamp(killerState.nobles + 1.6, 0, 100);
        killerState.glory = Math.min(40, killerState.glory + 1.2);
      } else if (unit.kind === 'unit') {
        const fighter = unit.type !== 'villager';
        killerState.glory = Math.min(40, killerState.glory + (fighter ? 0.6 : 0.15));
        if (fighter) killerState.nobles = clamp(killerState.nobles + 0.35, 0, 100);
      }
    }
  }

  onBuildingKilled(building, attacker) {
    const s = this.teams.get(building.team);
    if (!s) return;
    const rebels = attacker && (attacker.team === TEAM_REBEL_P || attacker.team === TEAM_REBEL_E);
    s.commons = clamp(s.commons - (rebels ? 5 : 3.5), 0, 100);
    s.nobles = clamp(s.nobles - (rebels ? 3 : 2.5), 0, 100);
    s.shame = Math.min(40, s.shame + 1.4);
    s.grief = Math.min(60, s.grief + 0.8);
  }

  onBuildingComplete(building) {
    const s = this.teams.get(building.team);
    if (!s || !building.type) return;
    switch (building.type) {
      case 'house': case 'farm': case 'mill': case 'lumber_camp': case 'mining_camp':
        s.commons = clamp(s.commons + 1.1, 0, 100); break;
      case 'barracks': case 'stable': case 'archery_range': case 'castle': case 'keep':
        s.nobles = clamp(s.nobles + 1.3, 0, 100); break;
      case 'market': case 'monastery': case 'university':
        s.commons = clamp(s.commons + 0.7, 0, 100);
        s.nobles = clamp(s.nobles + 0.7, 0, 100); break;
      case 'town_center':
        s.commons = clamp(s.commons + 2, 0, 100);
        s.nobles = clamp(s.nobles + 2, 0, 100); break;
      default: break;
    }
  }

  onAge(team, age) {
    const s = this.teams.get(team);
    if (!s) return;
    s.commons = clamp(s.commons + 4 + age, 0, 100);
    s.nobles = clamp(s.nobles + 5 + age, 0, 100);
  }

  /* ------------------------------------------------------------
     the tick
     ------------------------------------------------------------ */
  update(dt) {
    this._acc += dt;
    if (this._acc < PASS) return;
    const step = this._acc;
    this._acc = 0;
    const g = this.game;
    for (const team of this.kingdoms()) {
      const s = this.teams.get(team);
      if (!s) continue;
      const led = this.ledger(team);
      s.lines.commons = led.commons;
      s.lines.nobles = led.nobles;
      s.target.commons = led.targetC;
      s.target.nobles = led.targetN;

      for (const key of ['commons', 'nobles']) {
        const target = s.target[key];
        const before = s[key];
        /* Move toward the target as a proportion of the distance. A realm
           settles quickly when the gap is large and drifts when it is small,
           which is what makes the bar readable: the number is *where the
           realm is heading*, not a random walk. */
        const next = before + (target - before) * Math.min(1, 0.075 * step);
        s[key] = clamp(next, 0, 100);
        s.rate[key] = (s[key] - before) / Math.max(1e-6, step);
      }

      /* decay of the shock books */
      s.grief = Math.max(0, s.grief - 0.11 * step);
      s.glory = Math.max(0, s.glory - 0.16 * step);
      s.shame = Math.max(0, s.shame - 0.09 * step);
      s.feastCd = Math.max(0, s.feastCd - step);
      s.endowCd = Math.max(0, s.endowCd - step);
      s.cooldownC = Math.max(0, s.cooldownC - step);
      s.cooldownN = Math.max(0, s.cooldownN - step);
      s.embezzle = Math.max(0, s.embezzle - step);
      s.goldenCd = Math.max(0, s.goldenCd - step);

      /* the poll tax */
      const income = this.taxIncome(team);
      if (income > 0) g.addResource(team, 'gold', income * step);

      /* the two countdowns */
      if (s.cooldownC <= 0) {
        if (s.commons < REVOLT_AT) s.unrestC = Math.min(UNREST_MAX, s.unrestC + (REVOLT_AT - s.commons) * 0.42 * step);
        else if (s.commons > SAFE_AT) s.unrestC = Math.max(0, s.unrestC - (s.commons - SAFE_AT) * 0.3 * step);
      } else s.unrestC = Math.max(0, s.unrestC - 8 * step);
      if (s.cooldownN <= 0) {
        if (s.nobles < REVOLT_AT) s.unrestN = Math.min(UNREST_MAX, s.unrestN + (REVOLT_AT - s.nobles) * 0.36 * step);
        else if (s.nobles > SAFE_AT) s.unrestN = Math.max(0, s.unrestN - (s.nobles - SAFE_AT) * 0.28 * step);
      } else s.unrestN = Math.max(0, s.unrestN - 8 * step);

      if (s.cooldownC <= 0 && s.unrestC >= UNREST_MAX) this.revolt(team);
      if (s.cooldownN <= 0 && s.unrestN >= UNREST_MAX) this.conspiracy(team);

      /* a golden age: both estates devoted for a while, then it fades */
      if (!s.golden) {
        if (s.goldenCd <= 0 && s.commons >= 78 && s.nobles >= 78) {
          s.goldenArmed += step;
          if (s.goldenArmed > 6) {
            s.golden = true;
            s.goldenArmed = 0;
            if (team === P) {
              g.notify('A golden age — the realm is devoted to your crown', 'good');
              g.sound?.play('ageUp');
              const seat = g.baseOf ? g.baseOf(team) : g.playerBase;
              g.fx?.glowPulse(seat.x, g.heightAt(seat.x, seat.z) + 1, seat.z, 1, 0.9, 0.6);
            }
            this._emit(team, 'golden', {});
          }
        } else s.goldenArmed = Math.max(0, s.goldenArmed - step);
      } else if (s.commons < 62 || s.nobles < 62) {
        s.golden = false;
        s.goldenCd = 180;
        if (team === P) g.notify('The golden age fades', 'info');
        this._emit(team, 'golden_end', {});
      }

      /* A mob with nowhere to go does not stand in a field. A rioter that
         has beaten its way through the yard looks around and marches on the
         nearest hall: the rising ends when the crown puts it down, not when
         the nearest house falls. Cheap -- there are rarely more than nine. */
      {
        for (const u of g.units) {
          if (u.dead || !u.isRebel || u.rebelAgainst !== team) continue;
          if (u.state !== STATE.IDLE || u.target) continue;
          const goal = this._crownTarget(team, u.x, u.z, u.x, u.z);
          if (!goal) continue;
          u.state = STATE.ATTACK_MOVE;
          u.target = goal;
          u.noAggro = false;
          u.moveTo(goal.x, goal.z, true);
        }
      }

      /* band changes are announcements, not spam */
      const w = this.worst(team);
      if (w.band.id !== s.lastBand) {
        if (team === P && (w.band.id === 'angry' || w.band.id === 'hostile' || w.band.id === 'devoted')) {
          const label = w.id === 'commons' ? 'The commons' : 'The nobility';
          if (w.band.id === 'hostile' || w.band.id === 'angry') {
            g.notify(`${label} are ${w.band.name.toLowerCase()} — see the Court`, 'warn');
          } else g.notify(`${label} are ${w.band.name.toLowerCase()}`, 'good');
        }
        s.lastBand = w.band.id;
      }
    }
  }

  /* ------------------------------------------------------------
     notices and persistence
     ------------------------------------------------------------ */
  _emit(team, kind, data) {
    this.events.push({ team, kind, data, t: this.game ? this.game.time : 0 });
    if (this.events.length > 24) this.events.shift();
  }

  /** Drain the notices (the UI and tests both read this). */
  drain() {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  /** One line per estate for the HUD strip, e.g. { commons: "Content" }. */
  describe(team) {
    const s = this.state(team);
    return {
      commons: `${bandOf(s.commons).name} (${Math.round(s.commons)})`,
      nobles: `${bandOf(s.nobles).name} (${Math.round(s.nobles)})`,
      tax: (TAX_BY_ID.get(s.tax) || TAX_BY_ID.get('fair')).name,
      unrest: Math.max(s.unrestC, s.unrestN),
      golden: s.golden
    };
  }

  toJSON() {
    const out = { teams: {} };
    for (const team of this.kingdoms()) {
      const s = this.teams.get(team);
      if (!s) continue;
      out.teams[team] = {
        commons: Math.round(s.commons * 10) / 10,
        nobles: Math.round(s.nobles * 10) / 10,
        tax: s.tax,
        grief: Math.round(s.grief * 100) / 100,
        glory: Math.round(s.glory * 100) / 100,
        shame: Math.round(s.shame * 100) / 100,
        unrestC: Math.round(s.unrestC),
        unrestN: Math.round(s.unrestN),
        golden: s.golden,
        risenC: s.risenC,
        risenN: s.risenN
      };
    }
    out.crises = this.crises;
    return out;
  }

  fromJSON(data) {
    if (!data || !data.teams) return;
    /* a save may carry kingdoms this match does not have (or the other way
       round); only the ones that exist are restored */
    for (const key of Object.keys(data.teams)) {
      const team = Number(key);
      const d = data.teams[key];
      if (!Number.isFinite(team)) continue;
      const s = this.state(team);
      if (!d) continue;
      s.commons = clamp(Number(d.commons) || 50, 0, 100);
      s.nobles = clamp(Number(d.nobles) || 50, 0, 100);
      s.tax = TAX_BY_ID.has(d.tax) ? d.tax : 'fair';
      s.grief = Number(d.grief) || 0;
      s.glory = Number(d.glory) || 0;
      s.shame = Number(d.shame) || 0;
      s.unrestC = Number(d.unrestC) || 0;
      s.unrestN = Number(d.unrestN) || 0;
      s.golden = !!d.golden;
      s.risenC = Number(d.risenC) || 0;
      s.risenN = Number(d.risenN) || 0;
    }
    this.crises = Number(data.crises) || 0;
  }
}
