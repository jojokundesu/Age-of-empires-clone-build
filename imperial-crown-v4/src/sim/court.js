/* ============================================================
   court.js — the Court of Offices
   ------------------------------------------------------------
   The campaign's long game. Four offices sit above the economy and
   the army, and none of them is a menu: each one is *held by a
   body on the map*.

     Marshal      a soldier. Soldiers fighting near him hit harder
                  and run faster; the rank grows on kills.
     Chancellor   a villager. Villagers near her gather faster; she
                  grows on the resources her people bring in.
     Spymaster    a rider or archer. The realm simply sees further
                  and earns a little intelligence money; kills feed
                  the rank, and Whisper marks a man for death.
     Hierophant   a monk. Favour flows, monks heal harder, and
                  Benediction is a battlefield miracle.

   The holder is the point. Appoint your best knight and he becomes
   the most valuable unit you own — and the AI knows it, because an
   office adds threat. Let him die and the office stands empty for a
   while and loses a rank: the appointment is a risk, not a purchase.

   Everything here is plain simulation. The UI asks it questions and
   the AI calls the same methods the player does.
   ============================================================ */
import { STATE } from './entities.js';

export const OFFICES = [
  {
    id: 'marshal',
    name: 'Marshal',
    icon: 'sword',
    color: [1.0, 0.82, 0.36],
    age: 1,
    cost: { gold: 90, favor: 12 },
    class: 'military',
    blurb: 'A soldier who leads from the front.',
    passive: [
      'Soldiers within 16 m of the Marshal strike for +18% damage.',
      'Rank II: +26% and +6% speed.',
      'Rank III: +34%, +10% speed, and they mend 1 hp/s.'
    ],
    deed: 'kills',
    deedLabel: 'kills by your soldiers',
    writ: {
      id: 'forced_march',
      name: 'Forced March',
      icon: 'boot',
      cd: 95,
      target: null,
      cost: { favor: 20 },
      desc: 'Every soldier moves 45% faster for 12 s.'
    }
  },
  {
    id: 'chancellor',
    name: 'Chancellor',
    icon: 'wheat',
    color: [0.62, 0.9, 0.52],
    age: 1,
    cost: { gold: 90, favor: 12 },
    class: 'villager',
    blurb: 'A steward who makes the land pay.',
    passive: [
      'Villagers within 18 m gather 10% faster.',
      'Rank II: 18% faster and +2 carry.',
      'Rank III: 26%, +4 carry, and farms reseed themselves.'
    ],
    deed: 'gathered',
    deedLabel: 'resources gathered',
    writ: {
      id: 'census',
      name: 'Census',
      icon: 'scroll',
      cd: 110,
      target: null,
      cost: { favor: 20 },
      desc: 'Every villager delivers a full load at once, and all gathering is 40% faster for 12 s.'
    }
  },
  {
    id: 'spymaster',
    name: 'Spymaster',
    icon: 'eye',
    color: [0.72, 0.62, 1.0],
    age: 2,
    cost: { gold: 140, favor: 22 },
    class: 'any',
    blurb: 'Someone who sees what the fog is hiding.',
    passive: [
      'Every unit sees 3 m further, and the realm earns 0.35 gold/s from informants.',
      'Rank II: 5 m, 0.55 gold/s.',
      'Rank III: 7 m, 0.8 gold/s, and enemies near the Spymaster are marked.'
    ],
    deed: 'kills',
    deedLabel: 'enemy losses',
    writ: {
      id: 'whisper',
      name: 'Whisper',
      icon: 'warning',
      cd: 60,
      target: 'unit',
      cost: { favor: 15 },
      desc: 'Mark an enemy unit for 40 s: it is revealed, and your troops deal +30% damage to it.'
    }
  },
  {
    id: 'hierophant',
    name: 'Hierophant',
    icon: 'relic',
    color: [1.0, 0.94, 0.78],
    age: 2,
    cost: { gold: 140, favor: 30 },
    class: 'monk',
    blurb: 'The voice the gods answer.',
    passive: [
      '+0.5 favour/s for the realm.',
      'Rank II: +0.8 favour/s, and your monks heal 40% faster.',
      'Rank III: +1.2 favour/s, monks heal 80% faster, and decrees cost 20% less.'
    ],
    deed: 'favour',
    deedLabel: 'favour spent on decrees',
    writ: {
      id: 'benediction',
      name: 'Benediction',
      icon: 'heart',
      cd: 100,
      target: null,
      cost: { favor: 25 },
      desc: 'Every unit within 12 m of the Hierophant is healed for a third of its health and mends for 5 s.'
    }
  }
];
export const OFFICE_BY_ID = new Map(OFFICES.map((o) => [o.id, o]));

/* rank II and III thresholds, in deeds */
const RANK_AT = [0, 45, 130];
const VACANCY = 25;          // seconds an office stands empty after a death
const MAX_RANK = 3;

function emptyOffice() {
  return { holder: null, rank: 1, deeds: 0, writUntil: 0, vacantUntil: 0, buffUntil: 0, gathered: 0 };
}

export class Court {
  constructor(game) {
    this.game = game;
    this.teams = new Map();
    for (const team of [1, 2]) {
      const rec = { offices: {} };
      for (const o of OFFICES) rec.offices[o.id] = emptyOffice();
      this.teams.set(team, rec);
    }
    this._acc = 0;
  }

  rec(team) { return this.teams.get(team) || null; }
  office(team, id) { const r = this.rec(team); return r ? r.offices[id] : null; }

  /** Walk every filled office without allocating: the renderer calls this
      once a frame to hang a sigil over each officer. */
  eachHolder(fn) {
    for (const t of [1, 2]) {
      const r = this.teams.get(t);
      if (!r) continue;
      for (const o of OFFICES) {
        const rec = r.offices[o.id];
        if (rec.holder && !rec.holder.dead) fn(rec.holder, o, rec.rank);
      }
    }
  }

  /** A court change invalidates every cached unit stat (sight, speed...). */
  _dirty() { this.game.statsVersion++; }

  /** Gold, wood, stone *and* favour: canAfford only knows about st.res. */
  _afford(team, cost) {
    const st = this.game.teams.get(team);
    if (!st) return false;
    for (const k in cost) {
      if (k === 'favor') { if ((st.favor || 0) < cost[k]) return false; }
      else if ((st.res[k] || 0) < cost[k]) return false;
    }
    return true;
  }

  _pay(team, cost) {
    const st = this.game.teams.get(team);
    if (!st) return;
    const res = {};
    let favor = 0;
    for (const k in cost) {
      if (k === 'favor') favor += cost[k];
      else res[k] = cost[k];
    }
    if (Object.keys(res).length) this.game.spend(team, res);
    if (favor) st.favor = Math.max(0, (st.favor || 0) - favor);
  }

  /* ---------------- appointment ---------------- */
  /** Why an appointment would fail, or '' when it can go ahead. */
  canAppoint(team, id, unit) {
    const def = OFFICE_BY_ID.get(id);
    if (!def) return 'no such office';
    const st = this.game.teams.get(team);
    if (!st) return 'no realm';
    if (st.age < def.age) return `needs the ${def.age === 1 ? 'Feudal' : 'Castle'} Age`;
    if (!unit || unit.dead) return 'no candidate';
    if (unit.team !== team) return 'that is not your subject';
    if (unit.kind !== 'unit') return 'only a person can hold an office';
    const rec = this.office(team, id);
    if (rec.vacantUntil > this.game.time) return 'the office is in mourning';
    const cls = (unit.def && unit.def.classes) || [];
    if (def.class === 'military' && !(unit.def.attack > 0 && !cls.includes('villager'))) {
      return 'the Marshal must be a soldier';
    }
    if (def.class === 'villager' && unit.type !== 'villager') return 'the Chancellor must be a villager';
    if (def.class === 'monk' && !cls.includes('monk')) return 'the Hierophant must be a monk';
    if (!this._afford(team, def.cost)) return 'the appointment costs gold and favour';
    /* one office per person */
    for (const o of OFFICES) {
      const other = this.office(team, o.id);
      if (other.holder === unit) return 'already holds an office';
    }
    return '';
  }

  appoint(team, id, unit) {
    const why = this.canAppoint(team, id, unit);
    if (why) return { ok: false, reason: why };
    const def = OFFICE_BY_ID.get(id);
    const rec = this.office(team, id);
    this._pay(team, def.cost);
    rec.holder = unit;
    rec.rank = Math.max(1, rec.rank);
    rec.vacantUntil = 0;
    unit.courtOffice = id;
    unit.courtTeam = team;
    unit.courtRank = rec.rank;
    this._dirty();
    if (team === this.game.playerTeam) {
      this.game.notify(`${unit.def.name} is raised to ${def.name}`, 'good');
      this.game.fx.heal(unit.x, unit.y + 1.4, unit.z, 6);
    }
    return { ok: true, office: rec };
  }

  dismiss(team, id) {
    const rec = this.office(team, id);
    if (!rec || !rec.holder) return false;
    rec.holder.courtOffice = null;
    rec.holder.courtRank = 0;
    rec.holder = null;
    rec.vacantUntil = this.game.time + VACANCY;
    this._dirty();
    return true;
  }

  holder(team, id) {
    const rec = this.office(team, id);
    if (!rec || !rec.holder || rec.holder.dead) return null;
    return rec.holder;
  }

  /* ---------------- rank ---------------- */
  deed(team, id, amount) {
    const def = OFFICE_BY_ID.get(id);
    const rec = this.office(team, id);
    if (!def || !rec || !rec.holder || rec.holder.dead) return;
    rec.deeds += amount;
    let ranked = false;
    /* a single great deed (a whole battle's worth of kills) can carry a man
       through two ranks at once, so this is a while, not an if */
    while (rec.rank < MAX_RANK && rec.deeds >= RANK_AT[rec.rank]) {
      rec.deeds -= RANK_AT[rec.rank];
      rec.rank++;
      ranked = true;
    }
    if (rec.rank >= MAX_RANK) rec.deeds = Math.min(rec.deeds, 9999);
    if (ranked) { rec.holder.courtRank = rec.rank; this._dirty(); }
    if (ranked && team === this.game.playerTeam) {
      this.game.notify(`${def.name} reaches rank ${rec.rank}`, 'good');
      this.game.fx.heal(rec.holder.x, rec.holder.y + 1.6, rec.holder.z, 8);
    }
  }

  /* ---------------- auras ---------------- */
  /** The marshal's aura, read by damage and speed. */
  _aura(team, id, x, z, radius) {
    const h = this.holder(team, id);
    if (!h) return 0;
    const dx = h.x - x, dz = h.z - z;
    if (dx * dx + dz * dz > radius * radius) return 0;
    return this.office(team, id).rank;
  }

  /** Damage multiplier for an attacker (marshal aura + whisper mark). */
  damageMul(attacker) {
    if (!attacker || !attacker.team) return 1;
    let m = 1;
    const r = this._aura(attacker.team, 'marshal', attacker.x, attacker.z, 16 + this.rank(attacker.team, 'marshal') * 2);
    if (r) m += 0.1 + 0.08 * r;
    const target = attacker.target;
    if (target && target.markedBy === attacker.team && target.markedUntil > this.game.time) m *= 1.3;
    return m;
  }

  rank(team, id) {
    const rec = this.office(team, id);
    return rec && rec.holder && !rec.holder.dead ? rec.rank : 0;
  }

  speedMul(unit) {
    if (!unit || !unit.team) return 1;
    const classes = (unit.def && unit.def.classes) || [];
    const soldier = !!(unit.def && unit.def.attack > 0) && !classes.includes('villager');
    if (!soldier) return 1;
    const rec = this.office(unit.team, 'marshal');
    if (rec && rec.buffUntil > this.game.time) return 1.45;      // Forced March
    const r = this._aura(unit.team, 'marshal', unit.x, unit.z, 16 + this.rank(unit.team, 'marshal') * 2);
    return r >= 3 ? 1.10 : (r >= 2 ? 1.06 : 1);                  // +6% / +10%
  }

  gatherMul(unit, kind) {
    if (!unit || !unit.team) return 1;
    const r = this._aura(unit.team, 'chancellor', unit.x, unit.z, 18 + this.rank(unit.team, 'chancellor') * 2);
    if (r) return 1 + 0.02 + 0.08 * r;
    return 1;
  }

  carryBonus(unit) {
    if (!unit || !unit.team) return 0;
    const r = this._aura(unit.team, 'chancellor', unit.x, unit.z, 18 + this.rank(unit.team, 'chancellor') * 2);
    return r >= 2 ? 2 * (r - 1) : 0;
  }

  sightBonus(team) {
    const r = this.rank(team, 'spymaster');
    return r ? 2 * r : 0;
  }

  healMul(team) {
    const r = this.rank(team, 'hierophant');
    return r ? 1 + 0.4 * r : 1;
  }

  decreeDiscount(team) {
    return this.rank(team, 'hierophant') >= 3 ? 0.8 : 1;
  }

  /* ---------------- writs ---------------- */
  writ(team, id) {
    const def = OFFICE_BY_ID.get(id);
    const rec = this.office(team, id);
    if (!def || !rec) return null;
    const holder = this.holder(team, id);
    const now = this.game.time;
    return {
      id: def.writ.id,
      name: def.writ.name,
      icon: def.writ.icon,
      desc: def.writ.desc,
      target: def.writ.target,
      cost: def.writ.cost,
      holder,
      ready: !!holder && now >= rec.writUntil && this.game.teams.get(team).favor >= (def.writ.cost.favor || 0),
      cooldown: Math.max(0, rec.writUntil - now)
    };
  }

  useWrit(team, id, target) {
    const def = OFFICE_BY_ID.get(id);
    const rec = this.office(team, id);
    const holder = this.holder(team, id);
    if (!def || !rec) return { ok: false, reason: 'no such office' };
    if (!holder) return { ok: false, reason: `the ${def.name} is dead or unappointed` };
    if (this.game.time < rec.writUntil) return { ok: false, reason: 'the writ is still being written' };
    const st = this.game.teams.get(team);
    if (!this._afford(team, def.writ.cost)) return { ok: false, reason: 'not enough favour' };
    const t = def.writ.target;
    if (t === 'unit' && (!target || target.dead || target.team === team)) {
      return { ok: false, reason: 'choose an enemy unit' };
    }
    this._pay(team, def.writ.cost);
    rec.writUntil = this.game.time + def.writ.cd;
    const g = this.game;
    switch (def.writ.id) {
      case 'forced_march': {
        rec.buffUntil = g.time + 12;
        g.notify('Forced March — the line moves', 'good');
        for (const u of g.units) {
          if (u.dead || u.team !== team || !u.def.attack || ((u.def.classes) || []).includes('villager')) continue;
          g.fx.dust(u.x, u.y + 0.2, u.z, 3, 1.2);
        }
        break;
      }
      case 'census': {
        let n = 0;
        for (const u of g.units) {
          if (u.dead || u.team !== team || u.type !== 'villager') continue;
          const kind = u.carry && u.carry.kind;
          const amount = u.carry ? u.carry.amount : 0;
          if (kind && amount > 0) { g.addResource(team, kind, amount); u.carry.amount = 0; u.carry.kind = null; }
          n++;
        }
        rec.buffUntil = g.time + 12;
        g.addBuff(team, 'gather', 1.4, 12, 'court:census');
        g.notify(`Census — ${n} villagers surveyed`, 'good');
        break;
      }
      case 'whisper': {
        target.markedBy = team;
        target.markedUntil = g.time + 40;
        g.marker(target.x, target.z, { kind: 1, r0: 1, g0: 0.35, b0: 0.3, r: 2.2, life: 3 });
        g.fx.sparks(target.x, target.y + 1.2, target.z, 8, [1, 0.4, 0.35]);
        g.notify(`${target.def.name} has been marked`, 'warn');
        break;
      }
      case 'benediction': {
        let n = 0;
        for (const u of g.units) {
          if (u.dead || u.team !== team) continue;
          if (Math.hypot(u.x - holder.x, u.z - holder.z) > 12) continue;
          u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.34);
          u.courtMend = g.time + 5;
          g.fx.heal(u.x, u.y + 1.2, u.z, 4);
          n++;
        }
        g.fx.shock?.(holder.x, holder.y + 0.6, holder.z, 1.6, [1, 0.95, 0.7]);
        g.notify(`Benediction — ${n} mended`, 'good');
        break;
      }
      default: break;
    }
    if (team === g.playerTeam) g.audio?.play?.('click');
    return { ok: true };
  }

  /* ---------------- events ---------------- */
  onKill(killer, victim) {
    if (!killer || !victim || !killer.team) return;
    /* a tower's arrow is a valid killer, and a building's def has no classes */
    const classes = (killer.def && killer.def.classes) || [];
    const team = killer.team;
    if (team !== 1 && team !== 2) return;
    for (const o of OFFICES) {
      const rec = this.teams.get(team).offices[o.id];
      if (!rec.holder || rec.holder.dead) continue;
      const near = Math.hypot(rec.holder.x - killer.x, rec.holder.z - killer.z) < 22;
      if (o.id === 'marshal' && killer.def.attack > 0 && !classes.includes('monk')) {
        this.deed(team, 'marshal', near ? 2 : 1);
      } else if (o.id === 'spymaster') {
        const other = victim.team;
        if (other === 1 || other === 2) this.deed(team, 'spymaster', 1);
      }
    }
  }

  onGather(unit, amount, kind) {
    if (!unit || (unit.team !== 1 && unit.team !== 2)) return;
    const rec = this.teams.get(unit.team).offices.chancellor;
    if (!rec.holder || rec.holder.dead) return;
    rec.gathered += amount;
    if (rec.gathered >= 40) {
      const near = Math.hypot(rec.holder.x - unit.x, rec.holder.z - unit.z) < 26;
      const n = Math.floor(rec.gathered / 40);
      rec.gathered -= n * 40;
      this.deed(unit.team, 'chancellor', near ? n * 2 : n);
    }
  }

  onDecree(team, favorSpent) {
    if (team !== 1 && team !== 2) return;
    this.deed(team, 'hierophant', Math.max(1, Math.round(favorSpent / 4)));
  }

  /* ---------------- tick ---------------- */
  update(dt) {
    /* five passes a second is plenty for auras that change on appointment
       and on death; a per-frame pass would walk every unit twice a frame */
    this._acc += dt;
    if (this._acc < 0.2) return;
    dt = this._acc;
    this._acc = 0;
    this.game.courtGold = this.game.courtGold || { 1: 0, 2: 0 };
    const now = this.game.time;
    for (const team of [1, 2]) {
      const st = this.game.teams.get(team);
      if (!st) continue;
      const rec = this.teams.get(team);
      /* offices die with their holder */
      let changed = false;
      for (const o of OFFICES) {
        const r = rec.offices[o.id];
        if (r.holder && r.holder.dead) {
          const name = r.holder.def.name;
          r.holder.courtOffice = null;
          r.holder.courtRank = 0;
          r.holder = null;
          r.vacantUntil = now + VACANCY;
          r.rank = Math.max(1, r.rank - 1);
          changed = true;
          r.deeds = Math.min(r.deeds, RANK_AT[Math.min(MAX_RANK, r.rank)] || Infinity);
          r.buffUntil = 0;
          if (team === this.game.playerTeam) {
            this.game.notify(`Your ${o.name} has fallen — the office stands empty`, 'bad');
          }
        }
      }
      if (changed) this._dirty();
      /* spymaster's informants and the hierophant's favour */
      const spy = this.rank(team, 'spymaster');
      if (spy) {
        this.game.courtGold[team] += (0.2 + 0.2 * spy) * dt;
        if (this.game.courtGold[team] >= 1) {
          const whole = Math.floor(this.game.courtGold[team]);
          this.game.courtGold[team] -= whole;
          this.game.addResource(team, 'gold', whole);
        }
      }
      const hier = this.rank(team, 'hierophant');
      if (hier) st.favor = Math.min(400, st.favor + (0.2 + 0.3 * hier) * dt);
      /* the marshal's rank III mend */
      const marshalRank = this.rank(team, 'marshal');
      if (marshalRank >= 3) {
        const h = this.holder(team, 'marshal');
        for (const u of this.game.units) {
          if (u.dead || u.team !== team || !u.def.attack || ((u.def.classes) || []).includes('villager')) continue;
          if (Math.hypot(u.x - h.x, u.z - h.z) > 20) continue;
          if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + dt);
        }
      }
      /* benediction's mending tail */
      for (const u of this.game.units) {
        if (u.dead || u.team !== team) continue;
        if (u.courtMend && u.courtMend > now && u.hp < u.maxHp) {
          u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.02 * dt * 6);
        }
      }
    }
  }

  /* ---------------- AI + save ---------------- */
  /** The unit the AI should appoint, or null. */
  candidate(team) {
    const g = this.game;
    const base = team === 1 ? g.world.playerBase : g.world.enemyBase;
    const out = {};
    for (const o of OFFICES) {
      const rec = this.office(team, o.id);
      if (rec.holder || rec.vacantUntil > g.time) continue;
      let best = null, bestD = 1e9;
      for (const u of g.units) {
        if (u.dead || u.team !== team) continue;
        const uc = (u.def && u.def.classes) || [];
        if (o.class === 'military' && !(u.def.attack > 0 && !uc.includes('villager'))) continue;
        if (o.class === 'villager' && u.type !== 'villager') continue;
        if (o.class === 'monk' && !uc.includes('monk')) continue;
        const d = (u.x - base.x) ** 2 + (u.z - base.z) ** 2;
        if (d < bestD) { bestD = d; best = u; }
      }
      if (best) out[o.id] = best;
    }
    return out;
  }

  summary(team) {
    return OFFICES.map((o) => {
      const rec = this.office(team, o.id);
      return {
        id: o.id, name: o.name, icon: o.icon, rank: rec.rank, deeds: rec.deeds,
        holder: rec.holder && !rec.holder.dead ? rec.holder : null,
        vacantFor: Math.max(0, rec.vacantUntil - this.game.time),
        progress: rec.rank >= MAX_RANK ? 1 : Math.min(1, rec.deeds / RANK_AT[rec.rank]),
        writ: this.writ(team, o.id)
      };
    });
  }

  toJSON() {
    const out = {};
    for (const team of [1, 2]) {
      out[team] = {};
      for (const o of OFFICES) {
        const rec = this.office(team, o.id);
        out[team][o.id] = {
          rank: rec.rank, deeds: rec.deeds, vacancy: Math.max(0, rec.vacantUntil - this.game.time),
          x: rec.holder && !rec.holder.dead ? Math.round(rec.holder.x * 10) / 10 : null,
          z: rec.holder && !rec.holder.dead ? Math.round(rec.holder.z * 10) / 10 : null,
          type: rec.holder && !rec.holder.dead ? rec.holder.type : null
        };
      }
    }
    return out;
  }

  fromJSON(data) {
    if (!data) return;
    const g = this.game;
    for (const team of [1, 2]) {
      const src = data[team];
      if (!src) continue;
      for (const o of OFFICES) {
        const rec = this.office(team, o.id);
        const s = src[o.id];
        if (!rec || !s) continue;
        rec.rank = Math.max(1, Math.min(MAX_RANK, s.rank || 1));
        rec.deeds = Math.max(0, s.deeds || 0);
        rec.vacantUntil = g.time + Math.max(0, s.vacancy || 0);
        rec.holder = null;
        if (s.x === null || s.x === undefined) continue;
        /* ids do not survive a reload; the nearest survivor of the same type
           is the same person as far as the player can tell */
        let best = null, bestD = 8 * 8;
        for (const u of g.units) {
          if (u.dead || u.team !== team || u.type !== s.type) continue;
          const d = (u.x - s.x) ** 2 + (u.z - s.z) ** 2;
          if (d < bestD) { bestD = d; best = u; }
        }
        if (best) {
          rec.holder = best;
          best.courtOffice = o.id;
          best.courtTeam = team;
          best.courtRank = rec.rank;
          rec.vacantUntil = 0;
        } else {
          /* nobody came back with the office: it is vacant, and a vacant
             office holds no rank at all */
          rec.rank = 1;
          rec.deeds = 0;
        }
      }
    }
    this._dirty();
  }
}

/** Static copy for the UI, without a live Court instance. */
export function officeCatalogue() {
  return OFFICES.map((o) => ({
    id: o.id, name: o.name, icon: o.icon, age: o.age, blurb: o.blurb,
    passive: o.passive.slice(), cost: o.cost, deedLabel: o.deedLabel,
    writ: { name: o.writ.name, desc: o.writ.desc, cd: o.writ.cd, target: o.writ.target, icon: o.writ.icon }
  }));
}

export { RANK_AT, MAX_RANK, VACANCY };
