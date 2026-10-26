/* ============================================================
   arcane.js — The Arcane Order
   ------------------------------------------------------------
   A single spellcaster with four spells that each answer a different
   problem, and a mana pool that makes choosing between them the
   actual gameplay:

     Fireball    — the answer to a clumped army (area damage + burn)
     Blink       — the answer to being caught (an escape that will
                   not teleport through a wall)
     Time Warp   — the answer to cavalry (a slow field on the ground)
     Golem       — the answer to a wall of spears (a temporary tank)

   Mana regenerates whether or not the magician is fighting, so the
   interesting decision is *when* to spend it: a Fireball now or a
   Golem in twenty seconds.
   ============================================================ */
import { TEAM_PLAYER } from '../sim/game.js';

const MAGICIAN = 'magician';
const GOLEM = 'stone_golem';
const MAX_MAGICIANS = 4;

const MANA_MAX = 100;
const MANA_REGEN = 3.4;

function ustate(api, u) {
  return api.unitState(u, () => ({
    mana: MANA_MAX,
    cd: Object.create(null),
    burns: null
  }));
}

export const arcane = {
  id: 'arcane',
  name: 'The Arcane Order',
  icon: 'monk',
  tagline: 'Four spells, one pool of mana.',
  blurb: 'Field magicians who cast fireballs, blink out of trouble, slow time and raise a stone golem.',
  detail: [
    'Magicians regenerate mana constantly and never run out of it — the limit is how fast, and how many spells you can afford to spend before the next fight.',
    'Fireball: area damage plus a burn. Blink: a short teleport that refuses to cross walls. Time Warp: a slow field that catches cavalry. Golem: a temporary stone tank with a building-damage bonus.',
    'They are fragile, expensive and worth protecting. Undead strikes do less to them.'
  ],
  units: {
    [MAGICIAN]: {
      name: 'Magician', icon: 'monk', hp: 105, attack: 7, armor: 1, pierceArmor: 2,
      range: 6.5, speed: 2.9, time: 24, cost: { food: 60, gold: 95 },
      classes: ['infantry', 'unique'], sight: 13, attackSpeed: 1.6, projectile: 'flame',
      desc: 'Casts fireball, blink, time warp and golem. Mana regenerates; spells share a cooldown clock each.'
    },
    [GOLEM]: {
      name: 'Stone Golem', icon: 'mountain', hp: 320, attack: 20, armor: 6, pierceArmor: 4,
      speed: 2.2, time: 1, cost: {}, classes: ['siege'], sight: 9,
      attackSpeed: 1.9, bonuses: { building: 24 }, pop: 0,
      desc: 'A summoned cairn. Temporary, tough, and very good at doors.'
    }
  },

  createState() {
    return {
      fields: [],          // {x, z, r, until, team}
      golems: [],          // {unit, until}
      casts: 0
    };
  },

  setup(api) {
    api.say('The Arcane Order answers the call. Train magicians at the Town Centre.', 'good');
  },

  /* ------------------------------------------------------------
     training & caps
     ------------------------------------------------------------ */
  trainableAt(api, building) {
    if (!building || building.team !== TEAM_PLAYER) return [];
    if (building.type !== 'town_center' && building.type !== 'castle') return [];
    let n = 0;
    for (const u of api.teamUnits(TEAM_PLAYER)) if (u.type === MAGICIAN) n++;
    const queued = building.queue ? building.queue.filter((q) => q.type === MAGICIAN).length : 0;
    if (n + queued >= MAX_MAGICIANS) return [];
    return [MAGICIAN];
  },

  onSpawn(api, unit) {
    if (unit.type !== MAGICIAN) return;
    ustate(api, unit);
    api.fx.heal(unit.x, unit.y + 1.4, unit.z, 3);
  },

  /* ------------------------------------------------------------
     the spells
     ------------------------------------------------------------ */
  spells() {
    return [
      {
        id: 'fireball', name: 'Fireball', icon: 'flame', cost: 30, cd: 7, range: 13, radius: 2.8,
        label: 'Fireball', color: [1, 0.55, 0.2], target: 'ground',
        can: (u, x, z) => Math.hypot(u.x - x, u.z - z) <= 13
      },
      {
        id: 'blink', name: 'Blink', icon: 'bolt', cost: 20, cd: 9, range: 9, radius: 0.6,
        label: 'Blink', color: [0.5, 0.7, 1], target: 'ground',
        can: (u, x, z) => Math.hypot(u.x - x, u.z - z) <= 9
      },
      {
        id: 'warp', name: 'Time Warp', icon: 'hourglass', cost: 40, cd: 16, range: 12, radius: 5,
        label: 'Time Warp', color: [0.6, 0.45, 1], target: 'ground',
        can: (u, x, z) => Math.hypot(u.x - x, u.z - z) <= 12
      },
      {
        id: 'golem', name: 'Stone Golem', icon: 'mountain', cost: 55, cd: 30, range: 5, radius: 1,
        label: 'Raise Golem', color: [0.8, 0.75, 0.6], target: 'self'
      }
    ];
  },

  castSpell(api, unit, spell, x, z) {
    const st = ustate(api, unit);
    if (st.mana < spell.cost) { api.say('Not enough mana', 'warn'); return false; }
    if ((st.cd[spell.id] || 0) > api.time) { api.say(`${spell.name} is still recovering`, 'warn'); return false; }
    if (spell.can && !spell.can(unit, x, z)) { api.say('Out of range', 'warn'); return false; }

    if (spell.id === 'fireball') {
      const r = spell.radius;
      let hit = 0;
      for (const e of api.units()) {
        if (e.dead || e.team === unit.team) continue;
        const d = Math.hypot(e.x - x, e.z - z);
        if (d > r) continue;
        hit++;
        api.damage(e, 46 * (1 - d / (r * 1.6)), unit);
        const es = api.unitState(e);
        es.burn = { until: api.time + 5, dps: 4, source: unit.team };
      }
      /* buildings take a smaller share: a wizard is not a trebuchet */
      for (const b of api.buildings()) {
        if (b.dead || b.team === unit.team || b.team === 0) continue;
        if (Math.hypot(b.x - x, b.z - z) > r + b.size * 0.5) continue;
        api.damage(b, 18, unit);
        hit++;
      }
      api.fx.explosion(x, api.height(x, z) + 0.6, z, 1.15);
      api.mark(x, z, { kind: 0, r0: 1, g0: 0.45, b0: 0.15, r: r * 1.6, life: 0.5 });
      api.state.casts++;
      if (hit === 0) api.say('The fireball found nothing', 'info');
    }

    if (spell.id === 'blink') {
      /* no blinking through a wall: the straight line has to be walkable, and
         the landing spot has to be inside the world and out of the water */
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
      api.state.casts++;
    }

    if (spell.id === 'warp') {
      api.state.fields.push({ x, z, r: spell.radius, until: api.time + 5.5, team: unit.team });
      api.mark(x, z, { kind: 1, r0: 0.4, g0: 0.4, b0: 1, r: spell.radius, life: 0.9 });
      api.fx.smoke(x, api.height(x, z) + 0.4, z, 8, 1.5, 0.8);
      api.state.casts++;
    }

    if (spell.id === 'golem') {
      const spot = api.headroom(unit.x + 1.6, unit.z + 1.6) || [unit.x + 1.6, unit.z + 1.6];
      const g = api.spawn(GOLEM, unit.team, spot[0], spot[1]);
      if (!g) { api.say('There is no room for a golem here', 'warn'); return false; }
      api.state.golems.push({ unit: g, until: api.time + 26 });
      api.fx.dust(g.x, g.y, g.z, 10, 1.6);
      api.mark(g.x, g.z, { kind: 0, r0: 0.8, g0: 0.75, b0: 0.5, r: 2.2 });
      api.game.notify('The stone walks', 'good');
      api.state.casts++;
    }

    st.mana -= spell.cost;
    st.cd[spell.id] = api.time + spell.cd;
    return true;
  },

  /* ------------------------------------------------------------
     auras
     ------------------------------------------------------------ */
  onDamage(api, ent, amount, attacker, kind) {
    /* the ward: undead strikes wash off a magician */
    if (ent && ent.type === MAGICIAN && attacker && attacker.def && attacker.def.classes.includes('undead')) {
      return amount * 0.6;
    }
    return amount;
  },

  speedMul(api, unit) {
    if (!unit || unit.dead) return 1;
    for (const f of api.state.fields) {
      if (f.until <= api.time) continue;
      if (unit.team === f.team) continue;           // the caster's own side walks freely
      if (Math.hypot(unit.x - f.x, unit.z - f.z) > f.r) continue;
      return 0.42;
    }
    return 1;
  },

  /* ------------------------------------------------------------
     tick: mana, burns, fields, golems
     ------------------------------------------------------------ */
  tick(api, dt) {
    const now = api.time;

    for (const u of api.teamUnits(TEAM_PLAYER)) {
      if (u.type !== MAGICIAN) continue;
      const st = ustate(api, u);
      st.mana = Math.min(MANA_MAX, st.mana + MANA_REGEN * dt);
    }
    for (const u of api.teamUnits(2)) {
      if (u.type !== MAGICIAN) continue;
      const st = ustate(api, u);
      st.mana = Math.min(MANA_MAX, st.mana + MANA_REGEN * dt);
    }

    /* burn stacks from fireballs */
    for (const u of api.units()) {
      const st = u.modState && u.modState.arcane;
      if (!st || !st.burn) continue;
      if (now >= st.burn.until) { st.burn = null; continue; }
      u.hp = Math.max(0, u.hp - st.burn.dps * dt);
      if (u.hp <= 0) u.kill(null);
      else if (api.rng() < dt * 3) api.fx.fire(u.x, u.y + 0.9, u.z, 1, 0.5);
    }

    /* expire fields and golems */
    const fields = api.state.fields;
    for (let i = fields.length - 1; i >= 0; i--) {
      if (now >= fields[i].until) fields.splice(i, 1);
    }
    const golems = api.state.golems;
    for (let i = golems.length - 1; i >= 0; i--) {
      const g = golems[i];
      if (!g.unit || g.unit.dead) { golems.splice(i, 1); continue; }
      if (now < g.until) continue;
      golems.splice(i, 1);
      api.fx.dust(g.unit.x, g.unit.y + 0.4, g.unit.z, 12, 1.4);
      g.unit.kill(null);
    }
  },

  atmosphere(api) {
    /* a faint violet shimmer, only while the player fields a magician */
    let magic = false;
    for (const u of api.teamUnits(TEAM_PLAYER)) if (u.type === MAGICIAN) { magic = true; break; }
    if (!magic) return null;
    return { tint: [1.0, 0.98, 1.06], fog: 0.0002 };
  },

  hud(api) {
    let best = null;
    for (const u of api.teamUnits(TEAM_PLAYER)) {
      if (u.type !== MAGICIAN) continue;
      const st = ustate(api, u);
      if (!best || st.mana > best.st.mana) best = { u, st };
    }
    if (!best) {
      api.hud({ icon: 'monk', label: 'Arcane', value: 'no magician yet', tone: 'calm' });
      return;
    }
    api.hud({
      icon: 'monk', label: 'Mana',
      value: `${Math.round(best.st.mana)} / ${MANA_MAX}`,
      pct: best.st.mana / MANA_MAX,
      tone: best.st.mana >= 55 ? 'good' : best.st.mana >= 30 ? 'calm' : 'bad'
    });
  },

  gauge(api) {
    let best = null;
    for (const u of api.teamUnits(TEAM_PLAYER)) {
      if (u.type !== MAGICIAN) continue;
      const st = ustate(api, u);
      if (!best || st.mana > best.st.mana) best = { u, st };
    }
    if (!best) return null;
    return { label: 'Mana', value: best.st.mana / MANA_MAX, text: `${Math.round(best.st.mana)}` };
  },

  /* ------------------------------------------------------------
     command card
     ------------------------------------------------------------ */
  commands(ctx) {
    const sel = ctx.selection.filter((e) => e.kind === 'unit' && e.type === MAGICIAN && e.team === TEAM_PLAYER);
    if (!sel.length) return [];
    const api = ctx.api;
    const unit = sel[0];
    const st = ustate(api, unit);
    const out = [];
    for (const spell of this.spells()) {
      const cooling = (st.cd[spell.id] || 0) > api.time;
      const afford = st.mana >= spell.cost;
      const left = cooling ? Math.ceil((st.cd[spell.id] || 0) - api.time) : 0;
      out.push({
        icon: spell.icon,
        label: cooling ? `${left}s` : spell.name,
        cost: `${spell.cost} mana`,
        enabled: !cooling && afford,
        reason: cooling ? `${spell.name} recovers for ${left}s` : 'Not enough mana',
        primary: spell.id === 'fireball',
        action: () => {
          if (spell.target === 'self') {
            if (this.castSpell(api, unit, spell, unit.x, unit.z)) ctx.ui?.refreshCommands(true);
            return;
          }
          ctx.cast({
            id: spell.id,
            label: spell.label,
            range: spell.range,
            radius: spell.radius,
            color: spell.color,
            target: 'ground',
            unit,
            onCast: (x, z) => {
              const done = this.castSpell(api, unit, spell, x, z);
              ctx.ui?.refreshCommands(true);
              return done;
            }
          });
          ctx.ui?.refreshCommands(true);
        }
      });
    }
    return out;
  },

  dispose(api) {
    for (const g of api.state.golems) if (g.unit && !g.unit.dead) g.unit.kill(null);
    api.state.golems.length = 0;
    api.state.fields.length = 0;
  }
};
