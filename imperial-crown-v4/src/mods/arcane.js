/* ============================================================
   arcane.js — The Arcane Order
   ------------------------------------------------------------
   A magician is not a unit you buy once; it is a unit you *grow*.
   Insight is earned by casting, by killing, and by standing in the
   shadow of a tower, and every rank opens new spells and changes the
   model on the field.

     rank 1  Apprentice   fireball, blink
     rank 2  Adept        + ice lance, arcane ward
     rank 3  Magus        + chain lightning, time warp, attunement
     rank 4  Archmage     + meteor, stone golem
     rank 5  Sage         + frost nova, thunderstorm
     rank 6  Ascendant    + SKYFALL, one per day, anywhere on the map

   Attunement is the long tail: two elements are woven together to
   discover a hybrid that is *not* on the card until someone finds it.
   There are six of them, and each one is a different answer to a
   different problem. That is the thing a player is still discovering
   in their fourth hour.

   The whole mod is deliberately fragile and expensive: a magician is
   the most valuable thing on the field, and the AI knows it.
   ============================================================ */
import { TEAM_PLAYER, TEAM_ENEMY } from '../sim/game.js';
import { UNIT_DEFS } from '../sim/data.js';

const MAGICIAN = 'magician';
const GOLEM = 'stone_golem';
const TOWER = 'arcane_tower';
const MAX_BASE_MAGICIANS = 4;

/* one in-game day, in seconds: the sky falls once per day */
const DAY = 240;

const RANKS = [
  { rank: 1, title: 'Apprentice', xp: 0, mana: 100, regen: 3.4, type: MAGICIAN },
  { rank: 2, title: 'Adept', xp: 80, mana: 118, regen: 3.9, type: 'magician_adept' },
  { rank: 3, title: 'Magus', xp: 220, mana: 138, regen: 4.5, type: 'magician_magus' },
  { rank: 4, title: 'Archmage', xp: 430, mana: 162, regen: 5.2, type: 'magician_archmage' },
  { rank: 5, title: 'Sage', xp: 720, mana: 190, regen: 6.0, type: 'magician_sage' },
  { rank: 6, title: 'Ascendant', xp: 1100, mana: 225, regen: 7.0, type: 'magician_ascendant' }
];
const RANK_BY_TYPE = new Map(RANKS.map((r) => [r.type, r]));

const ELEMENTS = {
  fire: { name: 'Fire', icon: 'flame', color: [1, 0.55, 0.2] },
  ice: { name: 'Ice', icon: 'mountain', color: [0.6, 0.85, 1] },
  storm: { name: 'Storm', icon: 'bolt', color: [0.75, 0.8, 1] },
  arcane: { name: 'Arcane', icon: 'relic', color: [0.75, 0.5, 1] }
};

function ustate(api, u) {
  return api.unitState(u, () => ({
    mana: 100,
    cd: Object.create(null),
    xp: 0,
    rank: 1,
    ward: null,
    slow: null,
    freeze: 0,
    castTotal: 0
  }));
}

function rankInfo(u) {
  const st = u.modState && u.modState.arcane;
  if (!st) return RANKS[0];
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, (st.rank || 1) - 1))];
}

function isMagician(u) {
  return !!u && !u.dead && !!(u.modState && u.modState.arcane);
}

function maxMana(u) { return rankInfo(u).mana; }

/** Everyone of `enemyTeam` inside a circle. */
function enemiesIn(api, unit, x, z, r) {
  const out = [];
  for (const e of api.units()) {
    if (e.dead || e.team === unit.team) continue;
    if (Math.hypot(e.x - x, e.z - z) <= r) out.push(e);
  }
  return out;
}

/** Structures of an enemy team inside a circle (their footprint counts). */
function buildingsIn(api, team, x, z, r) {
  const out = [];
  for (const b of api.buildings()) {
    if (b.dead || b.team === team || b.team === 0) continue;
    const half = (b.def && b.def.size ? b.def.size : 3) * 0.5;
    if (Math.hypot(b.x - x, b.z - z) <= r + half) out.push(b);
  }
  return out;
}

/** A jagged bolt of light between two points, drawn as sparks and a ring. */
function bolt(api, ax, az, bx, bz, color) {
  const steps = 7;
  const y0 = api.height(ax, az) + 1.2;
  const y1 = api.height(bx, bz) + 0.9;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t + (api.rng() - 0.5) * 0.7;
    const z = az + (bz - az) * t + (api.rng() - 0.5) * 0.7;
    const y = y0 + (y1 - y0) * t;
    api.fx.sparks(x, y, z, 2, color);
  }
  api.mark(bx, bz, { kind: 1, r0: color[0], g0: color[1], b0: color[2], r: 1.6, life: 0.28 });
}

function gainXp(api, unit, amount) {
  const st = ustate(api, unit);
  st.xp += amount;
  const next = RANKS[st.rank];              // the entry after the current rank
  if (!next || st.xp < next.xp) return;
  st.rank = next.rank;
  /* the model is the rank: a new type, same stats, so the renderer swaps the
     whole silhouette (robe, halo, grimoire, crown) in one assignment */
  const def = UNIT_DEFS[next.type];
  if (!def) return;
  const oldMax = unit.maxHp;
  unit.type = next.type;
  unit.def = def;
  unit.name = def.name;
  unit.classes = def.classes;
  unit._stats = null;
  unit._statsVersion = -1;
  /* a rank is worth a little more life, never a full heal: a hunted mage must
     still be at risk on the field */
  unit.maxHp = Math.round(oldMax * 1.07);
  unit.hp = Math.min(unit.maxHp, unit.hp + Math.round(oldMax * 0.18));
  st.mana = next.mana;
  api.fx.heal(unit.x, unit.y + 1.6, unit.z, 8);
  api.mark(unit.x, unit.z, { kind: 1, r0: 0.55, g0: 0.8, b0: 1, r: 3.2, life: 1.1 });
  api.say(`${unit.name || 'Magician'} — ${next.title}. ${rankBlurb(next.rank)}`, 'good');
  api.banner(`${next.title}`);
}

function rankBlurb(rank) {
  return ({
    2: 'Ice Lance and Arcane Ward are yours.',
    3: 'Chain Lightning, Time Warp — and the Attunement rite.',
    4: 'Meteor and the Stone Golem answer.',
    5: 'Frost Nova and Thunderstorm.',
    6: 'SKYFALL. Once a day, the sky is yours to drop.'
  })[rank] || '';
}

function castable(api, unit, spell) {
  const st = ustate(api, unit);
  const rank = st.rank || 1;
  if (rank < spell.rank) return { ok: false, why: `Rank ${spell.rank}` };
  if (st.mana < spell.cost) return { ok: false, why: `${Math.ceil(spell.cost - st.mana)} mana short` };
  if ((st.cd[spell.id] || 0) > api.time) return { ok: false, why: `${Math.ceil(st.cd[spell.id] - api.time)}s` };
  return { ok: true, why: '' };
}

function performCast(api, unit, spell, x, z) {
  const st = ustate(api, unit);
  const ok = castable(api, unit, spell);
  if (!ok.ok) { api.say(`${spell.name}: ${ok.why}`, 'warn'); return false; }
  if (Math.hypot(unit.x - x, unit.z - z) > (spell.range || 14)) {
    api.say(`${spell.name}: out of range`, 'warn');
    return false;
  }
  if (spell.can && !spell.can(api, unit, x, z)) return false;
  const done = spell.cast(api, unit, x, z);
  if (done === false) return false;
  st.mana -= spell.cost;
  st.castTotal++;
  st.cd[spell.id] = api.time + (spell.cd || 8) * (1 - 0.04 * ((st.rank || 1) - 1));
  gainXp(api, unit, 8 + (spell.rank || 1) * 3);
  return true;
}

/* ============================================================
   the spellbook
   ============================================================ */
const SPELLS = [
  {
    id: 'fireball', name: 'Fireball', icon: 'flame', rank: 1, cost: 30, cd: 7, range: 15, radius: 2.8,
    color: [1, 0.55, 0.2],
    desc: 'Area damage plus a burn.',
    cast(api, unit, x, z) {
      const r = 3.2;
      let hit = 0;
      for (const e of enemiesIn(api, unit, x, z, r)) {
        const d = Math.hypot(e.x - x, e.z - z);
        api.damage(e, 46 * (1 - d / (r * 1.7)), unit);
        const es = api.unitState(e);
        es.burn = { until: api.time + 5, dps: 5, source: unit.team };
        hit++;
      }
      for (const b of buildingsIn(api, unit.team, x, z, r)) { api.damage(b, 20, unit); hit++; }
      api.fx.explosion(x, api.height(x, z) + 0.6, z, 1.2);
      api.fx.beamBetween(unit.x, unit.y + 1.3, unit.z, x, api.height(x, z) + 0.5, z,
        { color: [1, 0.6, 0.25], scale: 1.1, life: 0.3, jag: 0.22, width: 0.22 });
      api.fx.fire(x, api.height(x, z) + 0.4, z, 5);
      api.mark(x, z, { kind: 0, r0: 1, g0: 0.45, b0: 0.15, r: r * 1.7, life: 0.5 });
      if (!hit) api.say('The fireball found nothing', 'info');
    }
  },
  {
    id: 'blink', name: 'Blink', icon: 'bolt', rank: 1, cost: 20, cd: 9, range: 9.5,
    color: [0.5, 0.7, 1],
    desc: 'A short teleport that refuses walls.',
    cast(api, unit, x, z) {
      if (!api.line(unit.x, unit.z, x, z) || !api.passable(x, z)) {
        api.say('Something solid is in the way', 'warn');
        return false;
      }
      const spot = api.headroom(x, z) || [x, z];
      api.fx.smoke(unit.x, unit.y + 0.8, unit.z, 6, 1.2, 0.5);
      unit.x = spot[0]; unit.z = spot[1];
      unit.path = null; unit.targetPos = null; unit.pathIdx = 0;
      unit.y = api.height(unit.x, unit.z);
      api.fx.smoke(unit.x, unit.y + 0.8, unit.z, 6, 1.2, 0.5);
      api.mark(unit.x, unit.z, { kind: 0, r0: 0.6, g0: 0.75, b0: 1, r: 1.8 });
    }
  },
  {
    id: 'ice_lance', name: 'Ice Lance', icon: 'mountain', rank: 2, cost: 26, cd: 8, range: 13,
    color: [0.6, 0.85, 1],
    desc: 'A spear of ice that pierces a line of enemies and slows them.',
    cast(api, unit, x, z) {
      const dx = x - unit.x, dz = z - unit.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      let hit = 0;
      for (const e of enemiesIn(api, unit, (unit.x + x) / 2, (unit.z + z) / 2, len * 0.6 + 2)) {
        const px = e.x - unit.x, pz = e.z - unit.z;
        const along = px * ux + pz * uz;
        if (along < 0 || along > len) continue;
        const perp = Math.abs(px * uz - pz * ux);
        if (perp > 1.35) continue;
        api.damage(e, 38, unit);
        const es = api.unitState(e);
        es.slow = { mul: 0.5, until: api.time + 2.5 };
        api.fx.sparks(e.x, e.y + 1, e.z, 6, [0.7, 0.9, 1]);
        hit++;
      }
      api.fx.beamBetween(unit.x, unit.y + 1.1, unit.z, x, api.height(x, z) + 0.9, z,
        { color: [0.7, 0.92, 1], scale: 1.2, life: 0.34, jag: 0.1, width: 0.26 });
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        api.fx.sparks(unit.x + dx * t, api.height(unit.x + dx * t, unit.z + dz * t) + 1.1, unit.z + dz * t, 2, [0.65, 0.88, 1]);
      }
      api.mark(x, z, { kind: 1, r0: 0.5, g0: 0.8, b0: 1, r: 2.2, life: 0.4 });
      if (!hit) api.say('The lance found no one', 'info');
    }
  },
  {
    id: 'ward', name: 'Arcane Ward', icon: 'shield', rank: 2, cost: 34, cd: 18, range: 1,
    color: [0.7, 0.55, 1],
    desc: 'A shield that eats the next blows.',
    cast(api, unit) {
      const st = ustate(api, unit);
      st.ward = { absorb: 90 + (st.rank || 1) * 18, until: api.time + 9 };
      api.fx.heal(unit.x, unit.y + 1.1, unit.z, 6);
      api.fx.shock(unit.x, unit.y + 0.9, unit.z, 0.7, [0.78, 0.66, 1]);
      api.mark(unit.x, unit.z, { kind: 1, r0: 0.7, g0: 0.55, b0: 1, r: 1.5, life: 0.7 });
      api.say('The ward settles around you', 'good');
    }
  },
  {
    id: 'chain', name: 'Chain Lightning', icon: 'bolt', rank: 3, cost: 42, cd: 13, range: 12,
    color: [0.8, 0.85, 1],
    desc: 'Leaps between up to five enemies.',
    cast(api, unit, x, z) {
      const pool = enemiesIn(api, unit, x, z, 7);
      if (!pool.length) { api.say('No one to chain', 'info'); return false; }
      let from = { x, z };
      let dmg = 36;
      let hits = 0;
      const used = new Set();
      for (let i = 0; i < 5 && pool.length; i++) {
        let best = null, bestD = Infinity;
        for (const e of pool) {
          if (used.has(e)) continue;
          const d = Math.hypot(e.x - from.x, e.z - from.z);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (!best) break;
        used.add(best);
        bolt(api, from.x, from.z, best.x, best.z, [0.85, 0.9, 1]);
        api.fx.beamBetween(from.x, api.height(from.x, from.z) + 1.3, from.z,
          best.x, api.height(best.x, best.z) + 1.1, best.z,
          { color: [0.9, 0.95, 1], scale: 1.05, life: 0.36, jag: 1.15, width: 0.24 });
        api.damage(best, dmg, unit);
        api.fx.sparks(best.x, best.y + 1.1, best.z, 8, [0.9, 0.95, 1]);
        from = best;
        dmg *= 0.82;
        hits++;
      }
      if (hits) api.say(`Chain Lightning — ${hits} struck`, 'good');
    }
  },
  {
    id: 'warp', name: 'Time Warp', icon: 'hourglass', rank: 3, cost: 40, cd: 16, range: 13, radius: 5.5,
    color: [0.6, 0.45, 1],
    desc: 'A field that slows everything hostile inside it.',
    cast(api, unit, x, z) {
      api.state.fields.push({ x, z, r: 5.5, until: api.time + 6, team: unit.team });
      api.mark(x, z, { kind: 1, r0: 0.4, g0: 0.4, b0: 1, r: 5.5, life: 1 });
      api.fx.smoke(x, api.height(x, z) + 0.4, z, 8, 1.5, 0.8);
    }
  },
  {
    id: 'meteor', name: 'Meteor', icon: 'flame', rank: 4, cost: 62, cd: 26, range: 16, radius: 4.5,
    color: [1, 0.42, 0.16],
    desc: 'A rock from the sky. It takes a moment to arrive.',
    cast(api, unit, x, z) {
      api.state.meteors.push({ x, z, at: api.time + 1.7, team: unit.team, by: unit });
      api.mark(x, z, { kind: 1, r0: 1, g0: 0.4, b0: 0.1, r: 4.9, life: 1.7 });
      api.say('Meteor — incoming', 'warn');
    }
  },
  {
    id: 'golem', name: 'Stone Golem', icon: 'mountain', rank: 4, cost: 55, cd: 30, range: 6,
    color: [0.8, 0.75, 0.6],
    desc: 'A temporary tank that eats buildings.',
    cast(api, unit) {
      const spot = api.headroom(unit.x + 1.8, unit.z + 1.8) || [unit.x + 1.8, unit.z + 1.8];
      const g = api.spawn(GOLEM, unit.team, spot[0], spot[1]);
      if (!g) { api.say('There is no room for a golem here', 'warn'); return false; }
      g.owner = unit;
      api.state.golems.push({ unit: g, until: api.time + 26 });
      api.fx.dust(g.x, g.y, g.z, 10, 1.6);
      api.mark(g.x, g.z, { kind: 0, r0: 0.8, g0: 0.75, b0: 0.5, r: 2.2 });
      api.say('The stone walks', 'good');
    }
  },
  {
    id: 'nova', name: 'Frost Nova', icon: 'mountain', rank: 5, cost: 70, cd: 30, range: 1, radius: 7.5,
    color: [0.65, 0.9, 1],
    desc: 'Everything around the caster freezes solid.',
    cast(api, unit) {
      let n = 0;
      for (const e of enemiesIn(api, unit, unit.x, unit.z, 7.5)) {
        api.damage(e, 34, unit);
        const es = api.unitState(e);
        es.freeze = api.time + 1.9;
        es.slow = { mul: 0.4, until: api.time + 3.5 };
        api.fx.sparks(e.x, e.y + 1, e.z, 5, [0.75, 0.95, 1]);
        n++;
      }
      api.fx.smoke(unit.x, unit.y + 0.6, unit.z, 14, 2.4, 1.1);
      api.fx.shock(unit.x, unit.y + 0.4, unit.z, 2.4, [0.72, 0.92, 1]);
      api.mark(unit.x, unit.z, { kind: 1, r0: 0.6, g0: 0.9, b0: 1, r: 7.5, life: 0.9 });
      api.say(n ? `Frost Nova — ${n} frozen` : 'Frost Nova', 'good');
    }
  },
  {
    id: 'thunderstorm', name: 'Thunderstorm', icon: 'bolt', rank: 5, cost: 80, cd: 40, range: 16, radius: 7,
    color: [0.8, 0.85, 1],
    desc: 'A storm cell that keeps striking for eight seconds.',
    cast(api, unit, x, z) {
      api.state.storms.push({ x, z, until: api.time + 8, next: 0, team: unit.team, by: unit });
      api.mark(x, z, { kind: 1, r0: 0.7, g0: 0.8, b0: 1, r: 7, life: 1 });
      api.say('The sky gathers', 'warn');
    }
  },
  {
    id: 'skyfall', name: 'SKYFALL', icon: 'bolt', rank: 6, cost: 100, cd: 0, range: 999,
    daily: true, color: [0.9, 0.95, 1],
    desc: 'Once a day: the sky itself comes down, anywhere on the map.',
    cast(api, unit, x, z) {
      const day = Math.floor(api.time / DAY);
      if (api.state.skyday === day) {
        api.say('The sky is spent — it returns tomorrow', 'warn');
        return false;
      }
      api.state.skyday = day;
      skyfall(api, unit, x, z);
    }
  }
];
const SPELL_BY_ID = new Map(SPELLS.map((s) => [s.id, s]));

/* ============================================================
   the six hybrids — nothing here is on the card until it is found
   ============================================================ */
const HYBRIDS = [
  {
    id: 'plasma', name: 'Plasma Lance', icon: 'flame', pair: ['fire', 'storm'], cost: 60, cd: 20, range: 17,
    color: [1, 0.8, 0.45],
    desc: 'Fire and storm: a beam that burns through a whole line.',
    cast(api, unit, x, z) {
      const dx = x - unit.x, dz = z - unit.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      let hit = 0;
      for (const e of enemiesIn(api, unit, (unit.x + x) / 2, (unit.z + z) / 2, len * 0.6 + 3)) {
        const px = e.x - unit.x, pz = e.z - unit.z;
        const along = px * ux + pz * uz;
        if (along < 0 || along > len) continue;
        if (Math.abs(px * uz - pz * ux) > 1.6) continue;
        api.damage(e, 95, unit);
        const es = api.unitState(e);
        es.burn = { until: api.time + 4, dps: 6, source: unit.team };
        hit++;
      }
      for (const b of buildingsIn(api, unit.team, x, z, 4)) api.damage(b, 55, unit);
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        api.fx.sparks(unit.x + dx * t, api.height(unit.x + dx * t, unit.z + dz * t) + 1.2, unit.z + dz * t, 4, [1, 0.85, 0.5]);
      }
      api.fx.beamBetween(unit.x, unit.y + 1.3, unit.z, x, api.height(x, z) + 0.9, z,
        { color: [1, 0.85, 0.45], scale: 2.0, life: 0.5, jag: 0.05, width: 0.5 });
      api.fx.explosion(x, api.height(x, z) + 0.8, z, 1.5);
      api.fx.shock(x, api.height(x, z) + 0.5, z, 1.4, [1, 0.9, 0.6]);
      api.say(hit ? `Plasma Lance — ${hit} burned` : 'Plasma Lance', 'good');
    }
  },
  {
    id: 'stasis', name: 'Stasis Field', icon: 'hourglass', pair: ['ice', 'arcane'], cost: 65, cd: 26, range: 12,
    color: [0.65, 0.85, 1],
    desc: 'Ice and arcane: a bubble where time simply stops.',
    cast(api, unit, x, z) {
      let n = 0;
      for (const e of enemiesIn(api, unit, x, z, 6)) {
        const es = api.unitState(e);
        es.freeze = api.time + 3.2;
        api.fx.sparks(e.x, e.y + 1, e.z, 4, [0.7, 0.9, 1]);
        n++;
      }
      api.mark(x, z, { kind: 1, r0: 0.6, g0: 0.85, b0: 1, r: 6, life: 3.2 });
      api.say(n ? `Stasis — ${n} held still` : 'Stasis Field', 'good');
    }
  },
  {
    id: 'phoenix', name: 'Phoenix Ember', icon: 'heart', pair: ['fire', 'arcane'], cost: 70, cd: 34, range: 12,
    color: [1, 0.7, 0.35],
    desc: 'Fire and arcane: mend and cleanse every ally near the cinder.',
    cast(api, unit, x, z) {
      let n = 0;
      for (const a of api.teamUnits(unit.team)) {
        if (a.dead || Math.hypot(a.x - x, a.z - z) > 7) continue;
        a.hp = Math.min(a.maxHp, a.hp + 95);
        const as = a.modState || {};
        for (const k of Object.keys(as)) {
          if (as[k] && typeof as[k] === 'object') {
            delete as[k].burn;
            if (as[k].plague) as[k].plague = 0;
            if (as[k].carrier) as[k].carrier = false;
          }
        }
        api.fx.heal(a.x, a.y + 1.2, a.z, 3);
        n++;
      }
      api.fx.explosion(x, api.height(x, z) + 1.0, z, 1.1);
      api.mark(x, z, { kind: 0, r0: 1, g0: 0.65, b0: 0.3, r: 7, life: 0.8 });
      api.say(n ? `Phoenix Ember — ${n} mended` : 'Phoenix Ember', 'good');
    }
  },
  {
    id: 'tempest', name: 'Tempest Step', icon: 'bolt', pair: ['storm', 'arcane'], cost: 55, cd: 22, range: 11,
    color: [0.75, 0.85, 1],
    desc: 'Storm and arcane: arrive in a clap of thunder, and stun what is there.',
    cast(api, unit, x, z) {
      if (!api.passable(x, z)) { api.say('There is no room to step there', 'warn'); return false; }
      const spot = api.headroom(x, z) || [x, z];
      api.fx.smoke(unit.x, unit.y + 0.8, unit.z, 8, 1.4, 0.6);
      unit.x = spot[0]; unit.z = spot[1];
      unit.path = null; unit.targetPos = null; unit.pathIdx = 0;
      unit.y = api.height(unit.x, unit.z);
      let n = 0;
      for (const e of enemiesIn(api, unit, unit.x, unit.z, 4.5)) {
        const es = api.unitState(e);
        es.freeze = api.time + 1.5;
        api.damage(e, 18, unit);
        n++;
      }
      api.fx.sparks(unit.x, unit.y + 1.4, unit.z, 18, [0.9, 0.95, 1]);
      api.mark(unit.x, unit.z, { kind: 1, r0: 0.8, g0: 0.9, b0: 1, r: 4.5, life: 0.6 });
      api.say(n ? `Tempest Step — ${n} stunned` : 'Tempest Step', 'good');
    }
  },
  {
    id: 'thermal', name: 'Thermal Shock', icon: 'flame', pair: ['fire', 'ice'], cost: 58, cd: 20, range: 14,
    color: [1, 0.6, 0.5],
    desc: 'Fire and ice at once: the body cannot decide, and slows to a crawl.',
    cast(api, unit, x, z) {
      let n = 0;
      for (const e of enemiesIn(api, unit, x, z, 6)) {
        api.damage(e, 48, unit);
        const es = api.unitState(e);
        es.slow = { mul: 0.45, until: api.time + 4.5 };
        api.fx.sparks(e.x, e.y + 1, e.z, 6, [1, 0.7, 0.6]);
        n++;
      }
      api.fx.explosion(x, api.height(x, z) + 0.7, z, 1.3);
      api.fx.smoke(x, api.height(x, z) + 0.6, z, 10, 2.2, 1.2);
      api.mark(x, z, { kind: 0, r0: 1, g0: 0.6, b0: 0.4, r: 6, life: 0.7 });
      api.say(n ? `Thermal Shock — ${n} caught` : 'Thermal Shock', 'good');
    }
  },
  {
    id: 'hail', name: 'Hailstorm', icon: 'mountain', pair: ['ice', 'storm'], cost: 75, cd: 34, range: 15,
    color: [0.8, 0.9, 1],
    desc: 'Ice and storm: a field of falling ice that grinds an army down.',
    cast(api, unit, x, z) {
      api.state.storms.push({ x, z, until: api.time + 7, next: 0, team: unit.team, by: unit, hail: true });
      api.fx.smoke(x, api.height(x, z) + 0.8, z, 12, 2.6, 1.4);
      api.mark(x, z, { kind: 1, r0: 0.75, g0: 0.88, b0: 1, r: 6.5, life: 1.1 });
      api.say('Hailstorm', 'good');
    }
  }
];
const HYBRID_BY_ID = new Map(HYBRIDS.map((h) => [h.id, h]));
const PAIRS = [];
for (const h of HYBRIDS) PAIRS.push({ id: h.id, pair: h.pair });

/* ============================================================
   skyfall — the once-a-day
   ============================================================ */
function skyfall(api, unit, x, z) {
  const y = api.height(x, z);
  /* SKYFALL is the end of the ladder, so it is staged rather than flashed:
     the air goes heavy, the thunder rolls in from the edge of the map, and
     only then does the sky actually come down. Everything below happens in
     the same frame -- the *staging* is in the FX lifetimes, which is what
     makes it read as a minute of weather in two seconds of play.

       1. a dark pressure ring spreads 26 m, the sound of it a beat early
       2. three forked strokes at 40 m, wide and pale, then the core
       3. a column of light that does not fade for a second
       4. four aftershocks walking outward, each with its own thunder
       5. the ground is scarred and the screen is white for an instant     */
  const strokes = [
    { at: 0, main: true, ox: 0, oz: 0, dmg: 1.0 },
    { at: 0.18, main: false, ox: 3.4, oz: -2.2, dmg: 0.45 },
    { at: 0.36, main: false, ox: -3.8, oz: 2.6, dmg: 0.45 },
    { at: 0.54, main: false, ox: 1.4, oz: 4.0, dmg: 0.45 },
    { at: 0.72, main: false, ox: -1.0, oz: -4.2, dmg: 0.45 },
    { at: 0.92, main: false, ox: 5.0, oz: 0.4, dmg: 0.5 },
    { at: 1.12, main: false, ox: -5.2, oz: -0.8, dmg: 0.5 }
  ];
  for (const st of strokes) {
    api.state.strikes.push({ x: x + st.ox, z: z + st.oz, at: api.time + st.at, by: unit, main: st.main, dmg: st.dmg });
  }
  /* 1. the pressure front: a wide, dim ring that announces the column */
  api.mark(x, z, { kind: 1, r0: 0.55, g0: 0.6, b0: 0.85, r: 26, life: 1.5 });
  api.mark(x, z, { kind: 1, r0: 0.8, g0: 0.85, b0: 1, r: 16, life: 1.1 });
  /* 2/3. the column: a hard white core inside a wide cold halo */
  api.fx.beam(x, z, y, y + 70, { color: [1, 1, 1], scale: 3.0, life: 1.1, jag: 0.55, width: 1.1, alpha: 1 });
  api.fx.beam(x, z, y, y + 70, { color: [0.95, 0.97, 1], scale: 2.0, life: 0.75, jag: 1.1, width: 0.55, alpha: 0.95 });
  api.fx.beam(x, z, y, y + 55, { color: [0.55, 0.7, 1], scale: 7.5, life: 1.6, jag: 0.18, width: 3.0, alpha: 0.26, grow: 1.7 });
  api.fx.beam(x, z, y, y + 44, { color: [1, 0.98, 0.9], scale: 5.0, life: 0.4, jag: 0.05, width: 2.2, alpha: 0.5 });
  /* 4. the ground answers */
  api.fx.explosion(x, y + 1.4, z, 5.2);
  for (let i = 0; i < 3; i++) api.fx.shock(x, y + 0.5 + i * 0.25, z, 4.4 + i * 1.6, [0.92, 0.96, 1]);
  api.fx.fire(x, y + 0.4, z, 26);
  api.fx.smoke(x, y + 0.8, z, 26, 3.8, 3.4);
  api.fx.embers(x, y + 1.2, z, 30);
  api.fx.dust(x, y + 0.3, z, 22, 4.0);
  api.mark(x, z, { kind: 0, r0: 1, g0: 0.96, b0: 0.85, r: 14, life: 2.2 });
  api.mark(x, z, { kind: 1, r0: 1, g0: 1, b0: 1, r: 10, life: 2.8 });
  api.mark(x, z, { kind: 1, r0: 1, g0: 0.82, b0: 0.45, r: 6, life: 4.4 });
  api.shake(1.2);
  api.flash(0.55, [0.98, 0.99, 1]);
  api.banner('SKYFALL');
  /* the men: 320 in the core, tapering to a fifth of that at the rim, and
     every survivor is slowed for four seconds because the air is still
     ringing */
  let units = 0, builds = 0;
  for (const e of enemiesIn(api, unit, x, z, 11)) {
    const d = Math.hypot(e.x - x, e.z - z);
    const falloff = Math.max(0.18, 1 - (d / 13) ** 1.6);
    api.damage(e, 340 * falloff, unit);
    const es = api.unitState(e);
    es.slow = { mul: 0.32, until: api.time + 4 };
    api.fx.sparks(e.x, e.y + 1.2, e.z, 7, [1, 1, 1]);
    units++;
  }
  /* structures: this is the pillar that breaks a fortress. A castle in the
     core takes ~700; a farm on the rim still loses 90. */
  for (const b of buildingsIn(api, unit.team, x, z, 11)) {
    const d = Math.hypot(b.x - x, b.z - z);
    const falloff = Math.max(0.15, 1 - (d / 13) ** 1.5);
    api.damage(b, 780 * falloff, unit);
    api.fx.sparks(b.x, (b.y || 0) + 2, b.z, 5, [1, 0.95, 0.8]);
    builds++;
  }
  /* the sky is spent and the ground remembers */
  api.state.scars.push({ x, z, until: api.time + 90 });
  api.state.skyDark = api.time + 3.2;
  api.say(`SKYFALL — ${units} in the blast, ${builds} structures broken`, 'good');
}

/* the trailing strokes of a skyfall: light, a little damage, no bookkeeping */
function resolveStrikes(api) {
  const st = api.state;
  for (let i = st.strikes.length - 1; i >= 0; i--) {
    const s = st.strikes[i];
    if (api.time < s.at) continue;
    st.strikes.splice(i, 1);
    if (s.main) continue;                 /* the first stroke already landed */
    const y = api.height(s.x, s.z);
    const k = s.dmg || 0.45;
    api.fx.beam(s.x, s.z, y, y + 44, { color: [0.95, 0.98, 1], scale: 2.0, life: 0.55, jag: 1.3, width: 0.7, alpha: 0.95 });
    api.fx.beam(s.x, s.z, y, y + 30, { color: [0.6, 0.75, 1], scale: 3.4, life: 0.8, jag: 0.3, width: 1.4, alpha: 0.3, grow: 1.5 });
    api.fx.explosion(s.x, y + 0.6, s.z, 1.8);
    api.fx.shock(s.x, y + 0.3, s.z, 2.2, [0.9, 0.95, 1]);
    api.fx.fire(s.x, y + 0.3, s.z, 5);
    api.fx.embers(s.x, y + 0.8, s.z, 8);
    api.shake(0.45 * k);
    api.flash(0.12 * k, [0.98, 0.98, 0.96]);
    for (const e of enemiesIn(api, s.by || { team: 0 }, s.x, s.z, 4.2)) api.damage(e, 150 * k, s.by);
    for (const b of buildingsIn(api, s.by ? s.by.team : 0, s.x, s.z, 4.2)) api.damage(b, 200 * k, s.by);
  }
}

/* ============================================================
   the mod
   ============================================================ */
export const arcane = {
  id: 'arcane',
  name: 'The Arcane Order',
  icon: 'monk',
  tagline: 'One magician, six ranks, nineteen spells.',
  blurb: 'A magician who grows from a fireball-throwing apprentice into an Ascendant who can drop the sky on an enemy base — once a day.',
  detail: [
    'Magicians earn insight by casting, by killing, and by standing near an Arcane Tower. Every rank unlocks new spells and literally changes the model: grimoire, halo, cape, crown.',
    'Eleven base spells across fire, ice, storm and arcane — Ice Lance, Chain Lightning, Meteor, Frost Nova, Thunderstorm… and SKYFALL at rank 6, a once-per-day pillar of lightning that damages everything in a 9 m circle, anywhere on the map.',
    'Attunement is the long game: weave two elements at rank 3+ to discover one of six hybrids that are not listed anywhere until you find them.',
    'The AI knows exactly how dangerous a high-rank magician is: it watches for casters, forms hunting parties, and will spend an army to kill one.'
  ],
  units: {
    [MAGICIAN]: {
      name: 'Magician', icon: 'monk', hp: 110, attack: 7, armor: 1, pierceArmor: 2,
      range: 6.5, speed: 2.85, time: 26, cost: { food: 60, gold: 100 },
      classes: ['infantry', 'caster', 'unique'], caster: true, sight: 14, attackSpeed: 1.6,
      projectile: 'flame', pop: 1, threat: 4,
      desc: 'Earns insight by casting. Ranks up into new spells and a new silhouette.'
    },
    ...Object.fromEntries(RANKS.slice(1).map((r) => [r.type, {
      name: r.title, icon: 'monk', hp: 110, attack: 7, armor: 1, pierceArmor: 2,
      range: 6.5, speed: 2.85, time: 26, cost: { food: 60, gold: 100 },
      classes: ['infantry', 'caster', 'unique'], caster: true, sight: 14, attackSpeed: 1.6,
      projectile: 'flame', pop: 1, hidden: true, threat: 3 + r.rank,
      desc: `${r.title} of the Arcane Order.`
    }])),
    [GOLEM]: {
      name: 'Stone Golem', icon: 'mountain', hp: 340, attack: 22, armor: 6, pierceArmor: 4,
      speed: 2.2, time: 1, cost: {}, classes: ['siege'], sight: 9,
      attackSpeed: 1.9, bonuses: { building: 26 }, pop: 0, threat: 2,
      desc: 'A summoned cairn. Temporary, tough, and very good at doors.'
    }
  },
  buildings: {
    [TOWER]: {
      name: 'Arcane Tower', icon: 'tower', hp: 1250, armor: 4, pierceArmor: 8, size: 3.4,
      sight: 13, cost: { wood: 150, stone: 120 }, time: 30, minAge: 1, power: -2,
      desc: 'Teaches nearby magicians (insight over time) and raises the magician cap by one.'
    }
  },

  createState() {
    return {
      fields: [],
      golems: [],
      strikes: [],
      meteors: [],
      storms: [],
      scars: [],
      casts: 0,
      skyday: -1,
      discovered: new Set(),
      towers: []
    };
  },

  setup(api) {
    api.say('The Arcane Order answers the call. Train magicians at the Town Centre.', 'good');
  },

  /* ------------------------------------------------------------
     training, caps, towers
     ------------------------------------------------------------ */
  magicianCap(api, team) {
    let towers = 0;
    for (const b of api.teamBuildings(team)) if (b.type === TOWER && !b.dead) towers++;
    return MAX_BASE_MAGICIANS + Math.min(2, towers);
  },

  countMagicians(api, team) {
    let n = 0;
    for (const u of api.teamUnits(team)) if (isMagician(u)) n++;
    return n;
  },

  trainableAt(api, building, team = TEAM_PLAYER) {
    if (!building || building.team !== TEAM_PLAYER) return [];
    if (building.type !== 'town_center' && building.type !== 'castle') return [];
    const queued = building.queue ? building.queue.filter((q) => q.type === MAGICIAN).length : 0;
    if (this.countMagicians(api, TEAM_PLAYER) + queued >= this.magicianCap(api, TEAM_PLAYER)) return [];
    return [MAGICIAN];
  },

  buildMenu(api, team = TEAM_PLAYER) {
    if (team !== TEAM_PLAYER) return [];
    return [TOWER];
  },

  onSpawn(api, unit) {
    if (unit.type !== MAGICIAN && !RANK_BY_TYPE.has(unit.type)) return;
    const st = ustate(api, unit);
    if (unit.type !== MAGICIAN) st.rank = RANK_BY_TYPE.get(unit.type).rank;
    st.mana = maxMana(unit);
    api.fx.heal(unit.x, unit.y + 1.4, unit.z, 3);
  },

  onBuildingComplete(api, b) {
    if (b.type === TOWER) api.say('An Arcane Tower rises — magicians study faster here', 'good');
  },

  onDeath(api, ent, killer) {
    if (!ent || !killer) return;
    if (killer.modState && killer.modState.arcane && isMagician(killer)) {
      gainXp(api, killer, ent.kind === 'building' ? 40 : 26);
    }
    /* a golem that kills still feeds its master */
    if (killer.type === GOLEM && killer.owner && isMagician(killer.owner)) {
      gainXp(api, killer.owner, ent.kind === 'building' ? 30 : 18);
    }
  },

  /** Weave two elements. Returns true when something new was found. */
  attune(api, unit, id) {
    const h = HYBRID_BY_ID.get(id);
    if (!h) return false;
    if (api.state.discovered.has(id)) {
      api.say(`${h.name} is already in the book`, 'info');
      return false;
    }
    const st = ustate(api, unit);
    if ((st.rank || 1) < 3) { api.say('Attunement needs a Magus (rank 3)', 'warn'); return false; }
    if (st.mana < 80) { api.say('Not enough mana to attune', 'warn'); return false; }
    st.mana -= 80;
    api.state.discovered.add(id);
    gainXp(api, unit, 30);
    api.fx.explosion(unit.x, unit.y + 1.4, unit.z, 1.4);
    api.fx.sparks(unit.x, unit.y + 1.6, unit.z, 20, ELEMENTS[h.pair[0]].color);
    api.mark(unit.x, unit.z, { kind: 1, r0: 0.8, g0: 0.7, b0: 1, r: 3.4, life: 1.2 });
    api.say(`Attunement complete — ${h.name}. ${h.desc}`, 'good');
    api.banner(h.name);
    return true;
  },

  /** The six pairs, for the workshop card and for tests. */
  attunementPairs() {
    return PAIRS.map((p) => {
      const h = HYBRID_BY_ID.get(p.id);
      return { id: h.id, name: h.name, pair: p.pair.slice(), cost: h.cost, desc: h.desc };
    });
  },

  /* ------------------------------------------------------------
     a small scripting surface: tests and the tutorial both use it
     ------------------------------------------------------------ */
  spells() { return SPELLS.slice(); },
  hybrids() { return HYBRIDS.slice(); },
  ranks() { return RANKS.slice(); },
  rankOf(unit) { return rankInfo(unit); },
  castSpell(api, unit, spell, x, z) { return performCast(api, unit, spell, x, z); },
  spellCosts() { return SPELLS.map((s) => ({ id: s.id, mana: s.cost || 0, cd: s.cd || 0, rank: s.rank || 1 })); },

  /* ------------------------------------------------------------
     tick: mana, insight, fields, storms, meteors, scars
     ------------------------------------------------------------ */
  tick(api, dt) {
    const st = api.state;
    const time = api.time;

    for (const u of api.units()) {
      if (u.dead) continue;
      const ms = u.modState && u.modState.arcane;
      if (!ms) continue;
      const info = rankInfo(u);
      ms.mana = Math.min(info.mana, ms.mana + info.regen * dt);
      /* insight: a trickle everywhere, a stream beside a tower */
      ms.xp += dt * 0.16;
      if (u.type === MAGICIAN || RANK_BY_TYPE.has(u.type)) {
        for (const b of api.teamBuildings(u.team)) {
          if (b.dead || b.type !== TOWER) continue;
          if (Math.hypot(b.x - u.x, b.z - u.z) < 10) { ms.xp += dt * 0.7; break; }
        }
      }
      gainXp(api, u, 0);
      if (ms.ward && time > ms.ward.until) ms.ward = null;
      if (ms.slow && time > ms.slow.until) ms.slow = null;
      /* the highest ranks bleed light: a cheap, readable aura */
      if ((ms.rank || 1) >= 4 && api.rng() < dt * 1.4) {
        api.fx.heal(u.x, u.y + 1.2, u.z, 1);
      }
      if ((ms.rank || 1) >= 6 && api.rng() < dt * 2.2) {
        api.fx.sparks(u.x, u.y + 2.0, u.z, 2, [0.8, 0.9, 1]);
      }
    }

    resolveStrikes(api);

    /* slow fields */
    for (let i = st.fields.length - 1; i >= 0; i--) {
      const f = st.fields[i];
      if (time > f.until) { st.fields.splice(i, 1); continue; }
    }

    /* meteors */
    for (let i = st.meteors.length - 1; i >= 0; i--) {
      const m = st.meteors[i];
      if (time < m.at) continue;
      st.meteors.splice(i, 1);
      const y = api.height(m.x, m.z);
      api.fx.beam(m.x, m.z, y, y + 26, { color: [1, 0.55, 0.2], scale: 2.2, life: 0.6, jag: 0.5, width: 0.55 });
      api.fx.explosion(m.x, y + 0.8, m.z, 2.6);
      api.fx.shock(m.x, y + 0.5, m.z, 2.6, [1, 0.7, 0.35]);
      api.fx.fire(m.x, y + 0.4, m.z, 14);
      api.fx.smoke(m.x, y + 0.8, m.z, 14, 3, 2);
      api.mark(m.x, m.z, { kind: 0, r0: 1, g0: 0.4, b0: 0.1, r: 9, life: 1 });
      api.shake(0.5);
      for (const e of enemiesIn(api, m.by || { team: m.team, x: m.x, z: m.z }, m.x, m.z, 4.8)) {
        api.damage(e, 105, m.by);
        const es = api.unitState(e);
        es.burn = { until: time + 5, dps: 7, source: m.team };
      }
      for (const b of buildingsIn(api, m.team, m.x, m.z, 4.8)) api.damage(b, 46, m.by);
      st.scars.push({ x: m.x, z: m.z, until: time + 40 });
    }

    /* storm cells */
    for (let i = st.storms.length - 1; i >= 0; i--) {
      const s = st.storms[i];
      if (time > s.until) { st.storms.splice(i, 1); continue; }
      if (time < s.next) continue;
      s.next = time + (s.hail ? 0.55 : 0.62);
      const foes = enemiesIn(api, { team: s.team, x: s.x, z: s.z }, s.x, s.z, 7);
      if (s.hail) {
        for (const e of foes) {
          api.damage(e, 12, s.by);
          const es = api.unitState(e);
          es.slow = { mul: 0.7, until: time + 1.4 };
        }
        api.fx.sparks(s.x + (api.rng() - 0.5) * 8, api.height(s.x, s.z) + 5, s.z + (api.rng() - 0.5) * 8, 3, [0.85, 0.95, 1]);
      } else {
        const victim = foes.length ? foes[(api.rng() * foes.length) | 0] : null;
        const tx = victim ? victim.x : s.x + (api.rng() - 0.5) * 8;
        const tz = victim ? victim.z : s.z + (api.rng() - 0.5) * 8;
        const ty = api.height(tx, tz);
        api.fx.beam(tx, tz, ty, ty + 22, { color: [0.88, 0.94, 1], scale: 1.0, life: 0.32, jag: 1.3, width: 0.26 });
        api.fx.shock(tx, ty + 0.3, tz, 0.5, [0.85, 0.92, 1]);
        api.fx.sparks(tx, ty + 4.5, tz, 6, [0.85, 0.9, 1]);
        api.fx.explosion(tx, ty + 0.6, tz, 0.9);
        api.mark(tx, tz, { kind: 1, r0: 0.9, g0: 0.95, b0: 1, r: 1.8, life: 0.25 });
        if (victim) api.damage(victim, 26, s.by);
        for (const b of buildingsIn(api, s.team, tx, tz, 1.6)) api.damage(b, 8, s.by);
      }
    }

    /* golem lifetime */
    for (let i = st.golems.length - 1; i >= 0; i--) {
      const g = st.golems[i];
      if (!g.unit || g.unit.dead || time > g.until) {
        if (g.unit && !g.unit.dead) {
          api.fx.dust(g.unit.x, g.unit.y + 0.6, g.unit.z, 8, 1.4);
          g.unit.kill(null);
        }
        st.golems.splice(i, 1);
      }
    }

    /* scorch marks fade */
    for (let i = st.scars.length - 1; i >= 0; i--) {
      if (time > st.scars[i].until) st.scars.splice(i, 1);
    }
  },

  /* ------------------------------------------------------------
     combat modifiers
     ------------------------------------------------------------ */
  speedMul(api, unit) {
    if (!unit || unit.dead) return 1;
    const ms = unit.modState && unit.modState.arcane;
    if (ms && ms.freeze && api.time < ms.freeze) return 0.05;
    let m = 1;
    if (ms && ms.slow && api.time < ms.slow.until) m *= ms.slow.mul;
    for (const f of api.state.fields) {
      if (api.time > f.until) continue;
      if (unit.team === f.team) continue;
      if (Math.hypot(unit.x - f.x, unit.z - f.z) <= f.r) { m *= 0.42; break; }
    }
    return m;
  },

  onDamage(api, ent, amount, attacker, kind) {
    if (!ent) return amount;
    const st = ent.modState && ent.modState.arcane;
    if (st && st.ward && api.time < st.ward.until && st.ward.absorb > 0) {
      const soak = Math.min(st.ward.absorb, amount);
      st.ward.absorb -= soak;
      if (st.ward.absorb <= 0) st.ward = null;
      return amount - soak;
    }
    /* the old ward: undead strikes wash off a magician */
    if (ent.def && ent.def.caster && attacker && attacker.def &&
      attacker.def.classes && attacker.def.classes.includes('undead')) {
      return amount * 0.6;
    }
    return amount;
  },

  /* ------------------------------------------------------------
     the command card
     ------------------------------------------------------------ */
  commands(ctx) {
    const { api, ui } = ctx;
    const sel = ctx.selection || [];
    const mage = sel.find((e) => e && isMagician(e));
    if (!mage || !ui) return [];
    const st = ustate(api, mage);
    const info = rankInfo(mage);
    const list = [];

    /* the book */
    list.push({
      icon: 'book',
      label: 'Spells',
      cost: `${st.mana | 0}/${info.mana}`,
      primary: true,
      action: () => ui._renderAdHoc(this.spellCards(ctx, mage))
    });

    /* attunement */
    if ((st.rank || 1) >= 3) {
      list.push({
        icon: 'relic',
        label: 'Attune',
        cost: `${api.state.discovered.size}/${HYBRIDS.length}`,
        action: () => ui._renderAdHoc(this.attuneCards(ctx, mage))
      });
    }

    /* skyfall, once a day, rank 6 */
    if ((st.rank || 1) >= 6) {
      const day = Math.floor(api.time / DAY);
      const ready = api.state.skyday !== day;
      list.push({
        icon: 'bolt',
        label: 'SKYFALL',
        cost: ready ? 'once today' : 'tomorrow',
        enabled: ready,
        reason: 'The sky is already spent today',
        primary: true,
        action: () => {
          ctx.cast({
            id: 'skyfall', label: 'SKYFALL', range: 999, radius: 9,
            color: [0.95, 0.97, 1], target: 'ground', unit: mage,
            onCast: (x, z) => {
              const done = performCast(api, mage, SPELL_BY_ID.get('skyfall'), x, z);
              ui.refreshCommands(true);
              return done;
            }
          });
        }
      });
    }
    return list;
  },

  spellCards(ctx, mage) {
    const { api, ui } = ctx;
    const st = ustate(api, mage);
    const known = SPELLS.filter((s) => (st.rank || 1) >= s.rank).map((s) => s);
    const cards = [];
    for (const h of HYBRIDS) {
      if (api.state.discovered.has(h.id)) cards.push(this.spellCard(ctx, mage, h));
    }
    for (const s of known) cards.push(this.spellCard(ctx, mage, s));
    cards.sort((a, b) => (a.rank - b.rank));
    cards.push({
      icon: 'close', label: 'Back', cost: '',
      action: () => { ui._adHocUntil = 0; ui.sig = ''; ui.refreshCommands(); }
    });
    return cards;
  },

  spellCard(ctx, mage, spell) {
    const { api, ui } = ctx;
    const st = ustate(api, mage);
    const ok = castable(api, mage, spell);
    const self = (spell.range || 14) <= 2;
    return {
      icon: spell.icon,
      label: spell.name,
      cost: spell.daily ? (api.state.skyday === Math.floor(api.time / DAY) ? 'spent' : '1/day')
        : `${spell.cost} mana`,
      enabled: ok.ok,
      reason: ok.why,
      rank: spell.rank,
      action: () => {
        if (self) {
          performCast(api, mage, spell, mage.x, mage.z);
          ui._adHocUntil = 0; ui.sig = ''; ui.refreshCommands();
          return;
        }
        ui._adHocUntil = 0; ui.sig = '';
        ctx.cast({
          id: spell.id, label: spell.name, range: spell.range || 14,
          radius: spell.radius || 1.6, color: spell.color || [0.55, 0.8, 1],
          target: 'ground', unit: mage,
          onCast: (x, z) => {
            const done = performCast(api, mage, spell, x, z);
            ui.refreshCommands(true);
            return done;
          }
        });
      }
    };
  },

  attuneCards(ctx, mage) {
    const { api, ui } = ctx;
    const st = ustate(api, mage);
    const cards = [];
    for (const p of PAIRS) {
      const h = HYBRID_BY_ID.get(p.id);
      const found = api.state.discovered.has(p.id);
      const a = ELEMENTS[p.pair[0]], b = ELEMENTS[p.pair[1]];
      cards.push({
        icon: found ? h.icon : 'scroll',
        label: found ? h.name : `${a.name} + ${b.name}`,
        cost: found ? 'discovered' : '80 mana',
        enabled: !found && st.mana >= 80,
        reason: found ? 'Already in your book' : 'Not enough mana',
        rank: 3,
        action: () => {
          if (found) return;
          if (this.attune(api, mage, p.id)) {
            ui._adHocUntil = 0; ui.sig = '';
            ui.refreshCommands();
          }
        }
      });
    }
    cards.push({
      icon: 'close', label: 'Back', cost: '',
      action: () => { ui._adHocUntil = 0; ui.sig = ''; ui.refreshCommands(); }
    });
    return cards;
  },

  /* ------------------------------------------------------------
     readouts
     ------------------------------------------------------------ */
  hud(api) {
    const mages = api.teamUnits(TEAM_PLAYER).filter(isMagician);
    const best = mages.reduce((a, u) => {
      const r = rankInfo(u).rank;
      return !a || r > a.r ? { u, r, st: u.modState.arcane } : a;
    }, null);
    if (best) {
      api.hud({
        icon: 'monk',
        label: best.st.rank >= 6 ? 'Ascendant' : rankInfo(best.u).title,
        value: mages.length > 1 ? `${mages.length} magi · ${best.st.xp | 0} insight` : `${best.st.xp | 0} insight · ${best.st.mana | 0} mana`,
        pct: best.st.mana / rankInfo(best.u).mana,
        tone: best.st.rank >= 5 ? 'good' : ''
      });
    } else {
      api.hud({ icon: 'monk', label: 'Arcane', value: 'no magician', tone: '' });
    }
    const day = Math.floor(api.time / DAY);
    if (best && best.st.rank >= 6) {
      const ready = api.state.skyday !== day;
      api.hud({ icon: 'bolt', label: 'Skyfall', value: ready ? 'ready' : 'next day', tone: ready ? 'good' : '' });
    }
  },

  gauge(api) {
    const sel = (api.game.selection || []).find((e) => e && isMagician(e));
    const u = sel || api.teamUnits(TEAM_PLAYER).find(isMagician);
    if (!u) return null;
    const st = u.modState.arcane;
    return {
      id: 'arcane_mana',
      label: 'Mana',
      value: st.mana / rankInfo(u).mana,
      text: `${st.mana | 0} / ${rankInfo(u).mana}`
    };
  },

  atmosphere(api) {
    const mages = api.teamUnits(TEAM_PLAYER).filter(isMagician);
    let best = 0;
    for (const m of mages) best = Math.max(best, (m.modState.arcane.rank || 1));
    /* SKYFALL takes the sky first: for three seconds after the pillar lands
       the world is unnaturally dark and the horizon is blue-white, which is
       the difference between "a bright line appeared" and "the sky fell". */
    const dark = api.state.skyDark ? api.state.skyDark - api.time : 0;
    const t = best < 4 ? 0 : Math.min(1, (best - 3) / 3);
    if (dark <= 0 && t <= 0) return null;
    const k = Math.min(1, dark / 3.2);
    return {
      tint: [
        (1 - 0.04 * t) * (1 - 0.55 * k),
        (1 - 0.02 * t) * (1 - 0.42 * k),
        (1 + 0.03 * t) * (1 - 0.18 * k) + 0.16 * k
      ],
      fog: 0.0004 * t + 0.0016 * k,
      exposure: (1 + 0.03 * t) * (1 - 0.42 * k),
      cloud: Math.min(1, 0.06 * t + k),
      night: k > 0.5 ? 0.35 * k : 0
    };
  }
};

export { SPELLS, HYBRIDS, RANKS };
