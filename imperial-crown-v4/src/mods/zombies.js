/* ============================================================
   zombies.js — Plague of the Dead
   ------------------------------------------------------------
   The mechanic, in one sentence: *your own battlefield losses come
   back wearing the other side's colours.*

   Every unit that dies while the mod is on has a chance to rise
   again as a zombie for whoever killed it — and an infected unit
   always does. Infection is the interesting part: a zombie's bite
   leaves a stack, three stacks make a carrier, and a carrier bleeds
   out and rises when it dies. Monks are the counter (their aura
   burns the stacks off), so the mod is about protecting your monks
   and your corpse piles rather than about DPS.

   Deliberately not modelled: zombies do not need pop, do not
   gather, and cannot be healed. They are cannon fodder with a
   timer on the *other* player's patience.
   ============================================================ */
import { TEAM_PLAYER } from '../sim/game.js';

const ZOMBIE = 'plague_zombie';
const NECRO = 'necropolis';
const MAX_ZOMBIES_PER_TEAM = 26;
const MAX_ZOMBIES_TOTAL = 60;

export const plague = {
  id: 'zombies',
  name: 'Plague of the Dead',
  icon: 'skull',
  tagline: 'Every corpse is a recruit.',
  blurb: 'The fallen rise again — for whoever killed them. Infection spreads through your army.',
  detail: [
    'Fallen soldiers have a chance to claw back out of the ground as Plague Zombies. The dead serve whoever killed them, so a costly battle can hand the enemy a free horde.',
    'A zombie bite leaves a plague stack. Three stacks make a carrier: the unit bleeds, and when it dies it always rises.',
    'Monks burn the plague off nearby allies. Keep them with the army.',
    'Necropolises raise zombies for free and accept food as a drop-off.'
  ],
  units: {
    [ZOMBIE]: {
      name: 'Plague Zombie', icon: 'skull', hp: 74, attack: 9, armor: 0, pierceArmor: 0,
      speed: 2.05, time: 9, cost: { food: 20 }, classes: ['infantry', 'undead'], sight: 9,
      attackSpeed: 1.8, bonuses: { building: 3 }, pop: 0,
      desc: 'Slow, relentless and free-ish. Cannot be healed and does not count against population.'
    }
  },
  buildings: {
    [NECRO]: {
      name: 'Necropolis', icon: 'temple', hp: 1500, armor: 4, pierceArmor: 7, size: 4.4,
      pop: 5, sight: 11, cost: { wood: 180, stone: 120 }, time: 30,
      trains: [ZOMBIE], trainAt: [NECRO], dropoff: ['food'], minAge: 0,
      desc: 'Raises the dead on its own and accepts food. Every necropolis lets you keep six more zombies.'
    }
  },

  createState() {
    return {
      pending: [],        // corpses about to rise: {x, z, team, at, hp}
      risen: 0,
      infected: 0,
      capBonus: 0,
      necroT: 0
    };
  },

  setup(api) {
    api.say('Plague of the Dead: the fallen will not stay down.', 'warn');
    /* a mod is allowed to change the world it was asked to change */
    api.state.necroT = 0;
  },

  /* ------------------------------------------------------------
     caps
     ------------------------------------------------------------ */
  capFor(api, team) {
    let necro = 0;
    for (const b of api.teamBuildings(team)) if (b.type === NECRO && b.buildProgress >= 1) necro++;
    return MAX_ZOMBIES_PER_TEAM + necro * 6;
  },
  countFor(api, team) {
    let n = 0;
    for (const u of api.teamUnits(team)) if (u.type === ZOMBIE) n++;
    return n;
  },
  totalZombies(api) {
    let n = 0;
    for (const u of api.units()) if (u.type === ZOMBIE) n++;
    return n;
  },

  /* ------------------------------------------------------------
     a unit dies: mark the corpse
     ------------------------------------------------------------ */
  onDeath(api, ent, killer) {
    if (!ent || ent.kind !== 'unit') return;
    if (ent.type === ZOMBIE) {
      /* zombies do not rise twice; that would be an infinite army */
      api.fx.smoke(ent.x, ent.y + 0.4, ent.z, 2, 0.8, 0.6);
      return;
    }
    const st = api.unitState(ent);
    const carrier = !!st.carrier;
    const chance = carrier ? 1 : 0.45;
    if (api.rng() > chance) return;

    /* the corpse answers to the killer's banner. A death with no killer
       (fire, starvation, a fall) goes to the *other* side of the player, so
       an accidental wipe still feeds the plague. */
    let team = killer && killer.team && killer.team !== 0 ? killer.team
      : (ent.team === TEAM_PLAYER ? 2 : TEAM_PLAYER);
    if (this.countFor(api, team) >= this.capFor(api, team)) return;
    if (this.totalZombies(api) >= MAX_ZOMBIES_TOTAL) return;

    api.state.pending.push({
      x: ent.x, z: ent.z, team,
      at: api.time + (carrier ? 2.0 : 3.2),
      hp: carrier ? 1 : 0.75,
      carrier
    });
    if (api.state.pending.length > 40) api.state.pending.shift();
  },

  /* ------------------------------------------------------------
     infection
     ------------------------------------------------------------ */
  onDamage(api, ent, amount, attacker, kind) {
    if (!attacker || attacker.type !== ZOMBIE) return amount;
    if (!ent || ent.kind !== 'unit' || ent.dead) return amount;
    if (ent.type === ZOMBIE) return amount;
    const st = api.unitState(ent);
    st.stacks = (st.stacks || 0) + 1;
    st.lastBite = api.time;
    if (st.stacks >= 3 && !st.carrier) {
      st.carrier = true;
      api.fx.heal(ent.x, ent.y + 1.2, ent.z, 4);
      api.mark(ent.x, ent.z, { kind: 1, r0: 0.2, g0: 1, b0: 0.35, r: 1.6 });
      if (ent.team === TEAM_PLAYER) api.say(`${ent.name} is infected — a monk can still save it`, 'warn');
    }
    return amount;
  },

  /* ------------------------------------------------------------
     tick
     ------------------------------------------------------------ */
  tick(api, dt) {
    const now = api.time;

    /* corpses claw their way out */
    const pending = api.state.pending;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (now < p.at) continue;
      pending.splice(i, 1);
      if (this.countFor(api, p.team) >= this.capFor(api, p.team)) continue;
      if (this.totalZombies(api) >= MAX_ZOMBIES_TOTAL) continue;
      const spot = api.headroom(p.x, p.z) || [p.x, p.z];
      const u = api.spawn(ZOMBIE, p.team, spot[0], spot[1]);
      if (!u) continue;
      u.hp = Math.max(1, u.maxHp * p.hp);
      api.state.risen++;
      api.fx.dust(u.x, u.y, u.z, 5, 1.2);
      api.fx.smoke(u.x, u.y + 0.3, u.z, 2, 1.0, 0.7);
      api.mark(u.x, u.z, { kind: 0, r0: 0.35, g0: 0.95, b0: 0.4, r: 2.0 });
    }

    /* carriers bleed; monks burn the plague out; zombies drift toward prey */
    let infected = 0;
    const monks = api.units().filter((u) => u.def && u.def.classes.includes('monk') && !u.dead);
    for (const u of api.units()) {
      const st = u.modState && u.modState.zombies;
      if (!st) continue;
      if (st.stacks && now - (st.lastBite || 0) > 12) st.stacks = Math.max(0, st.stacks - 1);
      if (st.carrier) {
        infected++;
        const dmg = 1.1 * dt;
        u.hp = Math.max(1, u.hp - dmg);
        if (api.rng() < dt * 0.8) api.fx.heal(u.x, u.y + 1.1, u.z, 1);
        /* a friendly monk within six metres is a cure */
        for (const m of monks) {
          if (m.team !== u.team) continue;
          if (Math.hypot(m.x - u.x, m.z - u.z) > 6) continue;
          st.stacks = Math.max(0, (st.stacks || 0) - dt * 1.6);
          if (st.stacks < 1) {
            st.carrier = false;
            st.stacks = 0;
            api.fx.glowPulse?.(u.x, u.y + 1, u.z, 0.5, 1, 0.7);
            if (u.team === TEAM_PLAYER) api.say(`${u.name} was cleansed`, 'good');
          }
        }
      }
    }
    api.state.infected = infected;

    /* necropolises raise one zombie every 22 s for free */
    api.state.necroT += dt;
    if (api.state.necroT >= 22) {
      api.state.necroT = 0;
      for (const b of api.buildings()) {
        if (b.type !== NECRO || b.buildProgress < 1) continue;
        if (this.countFor(api, b.team) >= this.capFor(api, b.team)) continue;
        if (this.totalZombies(api) >= MAX_ZOMBIES_TOTAL) continue;
        const spot = api.headroom(b.x, b.z + b.size * 0.7) || [b.x, b.z + b.size];
        const u = api.spawn(ZOMBIE, b.team, spot[0], spot[1]);
        if (u) api.fx.smoke(u.x, u.y, u.z, 3, 1, 0.6);
      }
    }

    /* zombies that have no order shamble at the nearest living thing. This is
       what makes them a threat rather than scenery. */
    for (const u of api.units()) {
      if (u.type !== ZOMBIE) continue;
      if (u.target || u.state === 'attack' || u.state === 'move' || u.state === 'attackmove') continue;
      if (api.rng() > dt * 0.9) continue;
      const near = api.enemiesOf(u.team).filter((e) => Math.hypot(e.x - u.x, e.z - u.z) < 16);
      if (!near.length) continue;
      let best = near[0], bd = Infinity;
      for (const e of near) {
        const d = Math.hypot(e.x - u.x, e.z - u.z);
        if (d < bd) { bd = d; best = e; }
      }
      api.game.orderAttack([u], best);
    }
  },

  speedMul(api, unit) {
    if (unit && unit.type === ZOMBIE) return 1;
    return 1;
  },

  atmosphere() {
    /* a sickly green cast over the whole battlefield */
    return { tint: [0.93, 1.02, 0.90], fog: 0.0005, exposure: 0.98 };
  },

  hud(api) {
    const z = this.totalZombies(api);
    api.hud({
      icon: 'skull',
      label: 'Plague',
      value: `${z} walking · ${api.state.infected} infected`,
      tone: api.state.infected > 0 ? 'bad' : 'calm'
    });
  },

  commands(ctx) {
    const out = [];
    const sel = ctx.selection;
    if (!sel.length) return out;
    const necro = sel.filter((e) => e.kind === 'building' && e.type === NECRO && e.team === TEAM_PLAYER && e.buildProgress >= 1);
    for (const b of necro) {
      const api = ctx.api;
      const full = this.countFor(api, b.team) >= this.capFor(api, b.team) || this.totalZombies(api) >= MAX_ZOMBIES_TOTAL;
      const cost = { food: 25 };
      const afford = ctx.game.canAfford(TEAM_PLAYER, cost) && !full;
      out.push({
        icon: 'skull', label: 'Raise', cost: '25 food',
        enabled: afford,
        reason: full ? 'The horde is full — build another necropolis' : 'Not enough food',
        action: () => {
          ctx.game.spend(TEAM_PLAYER, cost);
          const spot = ctx.api.headroom(b.x, b.z + b.size * 0.7) || [b.x, b.z + b.size];
          const u = ctx.api.spawn(ZOMBIE, TEAM_PLAYER, spot[0], spot[1]);
          if (u) { api.fx.smoke(u.x, u.y, u.z, 4, 1.1, 0.5); api.mark(u.x, u.z, { kind: 0, r0: 0.4, g0: 1, b0: 0.4, r: 2 }); }
          ctx.ui?.toast('A zombie claws free', 'good');
          ctx.ui?.refreshCommands(true);
        }
      });
    }
    return out;
  }
};
