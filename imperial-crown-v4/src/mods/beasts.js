/* ============================================================
   beasts.js — Beasts of the Wild
   ------------------------------------------------------------
   The map grows teeth. Packs of dire wolves and lone bears roam the
   wilderness and treat your villagers as food, which changes the
   opening of every match: you cannot leave the tree line unguarded
   on the far side of the town any more.

   The counter is the Beastmaster. A beast beaten down to a third of
   its health can be tamed instead of killed, and from then on it
   fights for you, levels up on every kill it makes, and is healed by
   your town centre. A tamed bear is the best wall-breaker in the
   game that costs no gold.
   ============================================================ */
import { TEAM_PLAYER, TEAM_ENEMY } from '../sim/game.js';

const WOLF = 'dire_wolf';
const BEAR = 'bear';
const MASTER = 'beastmaster';
const MAX_MASTERS = 3;

/* packs are laid out from the seed, so the same world always has its wolves
   in the same place and a replay stays honest */
const PACKS = 3;
const PACK_SIZE = 3;
const BEARS = 2;

export const beasts = {
  id: 'beasts',
  name: 'Beasts of the Wild',
  icon: 'deer',
  tagline: 'The wilderness bites back.',
  blurb: 'Wolf packs and bears hunt your villagers. Beat one down and a Beastmaster can tame it.',
  detail: [
    'Three wolf packs and two bears spawn in the wilderness. They hunt villagers and scouts, and a pack that tastes blood calls its neighbours.',
    'Wolves are fast and fragile; bears are slow, armoured and hit like a cart.',
    'Beastmasters can tame a beast below a third of its health. A tamed beast keeps its stats, gains a level for every two kills, and fights for you.',
    'Every beast you kill is butchered on the spot: 60 food, no farm needed.'
  ],
  units: {
    [WOLF]: {
      name: 'Dire Wolf', icon: 'deer', hp: 85, attack: 11, armor: 0, pierceArmor: 0,
      speed: 4.9, time: 1, cost: {}, classes: ['cavalry'], sight: 13,
      attackSpeed: 1.0, bonuses: { villager: 6 }, pop: 0,
      desc: 'Wild. Fast, weak alone, deadly in a pack.'
    },
    [BEAR]: {
      name: 'Cave Bear', icon: 'deer', hp: 330, attack: 24, armor: 3, pierceArmor: 2,
      speed: 2.45, time: 1, cost: {}, classes: ['infantry'], sight: 11,
      attackSpeed: 1.7, bonuses: { villager: 10, building: 8 }, pop: 0,
      desc: 'Wild. A living battering ram with a bad temper.'
    },
    [MASTER]: {
      name: 'Beastmaster', icon: 'deer', hp: 140, attack: 10, armor: 2, pierceArmor: 1,
      speed: 3.1, time: 18, cost: { food: 70, gold: 30 }, classes: ['infantry', 'unique'],
      sight: 15, attackSpeed: 1.5, pop: 1,
      desc: 'Tames wounded beasts. Tamed beasts level up and follow their master.'
    }
  },

  createState() {
    return {
      packs: [],
      tamed: [],        // {unit, level, kills}
      seeded: false,
      howlT: 0
    };
  },

  /* ------------------------------------------------------------
     seeding the wilderness
     ------------------------------------------------------------ */
  setup(api) {
    const g = api.game;
    const base = g.playerBase;
    const spots = [];
    const trySpot = (minR, maxR) => {
      for (let i = 0; i < 40; i++) {
        const a = api.rng() * Math.PI * 2;
        const r = minR + api.rng() * (maxR - minR);
        const x = base.x + Math.cos(a) * r;
        const z = base.z + Math.sin(a) * r;
        if (!api.passable(x, z)) continue;
        if (api.teamBuildings(TEAM_PLAYER).some((b) => Math.hypot(b.x - x, b.z - z) < 24)) continue;
        if (spots.some((s) => Math.hypot(s[0] - x, s[1] - z) < 22)) continue;
        spots.push([x, z]);
        return [x, z];
      }
      return null;
    };

    for (let p = 0; p < PACKS; p++) {
      const c = trySpot(50, 120);
      if (!c) continue;
      api.state.packs.push({ x: c[0], z: c[1], alive: 0 });
      for (let i = 0; i < PACK_SIZE; i++) {
        const a = (i / PACK_SIZE) * Math.PI * 2;
        const spot = api.headroom(c[0] + Math.cos(a) * 3, c[1] + Math.sin(a) * 3) || c;
        const u = api.spawn(WOLF, TEAM_ENEMY, spot[0], spot[1]);
        if (u) { u.beast = true; u.wild = true; api.state.packs[p].alive++; }
      }
    }
    for (let i = 0; i < BEARS; i++) {
      const c = trySpot(60, 130);
      if (!c) continue;
      const u = api.spawn(BEAR, TEAM_ENEMY, c[0], c[1]);
      if (u) { u.beast = true; u.wild = true; }
    }
    api.state.seeded = true;
    api.say('Wolves are hunting the tree line — keep your villagers close', 'warn');
  },

  trainableAt(api, building, team) {
    if (!building || building.type !== 'town_center' || building.team !== TEAM_PLAYER) return [];
    let n = 0;
    for (const u of api.teamUnits(TEAM_PLAYER)) if (u.type === MASTER) n++;
    const queued = building.queue ? building.queue.filter((q) => q.type === MASTER).length : 0;
    if (n + queued >= MAX_MASTERS) return [];
    return [MASTER];
  },

  onSpawn(api, unit) {
    if (unit.type !== MASTER) return;
    api.fx.heal(unit.x, unit.y + 1.2, unit.z, 3);
  },

  /* ------------------------------------------------------------
     kills: butchery, levels, pack morale
     ------------------------------------------------------------ */
  onDeath(api, ent, killer) {
    if (!ent || ent.kind !== 'unit') return;
    const beastTypes = [WOLF, BEAR];
    if (!beastTypes.includes(ent.type)) {
      /* a tamed beast that kills something gets stronger */
      if (killer && killer.tamedBeast) {
        const rec = api.state.tamed.find((t) => t.unit === killer);
        if (rec) {
          rec.kills++;
          if (rec.kills % 2 === 0) this.levelUp(api, killer, rec);
        }
      }
      /* the wild answers a kill: nearby wolves join in */
      if (killer && killer.wild) return;
      return;
    }

    /* butchered on the spot by whoever killed it */
    if (killer && (killer.team === TEAM_PLAYER || killer.team === TEAM_ENEMY)) {
      api.game.addResource(killer.team, 'food', ent.type === BEAR ? 110 : 60);
      if (killer.team === TEAM_PLAYER) api.say(`${ent.name} butchered · ${ent.type === BEAR ? 110 : 60} food`, 'good');
    }
    const pack = api.state.packs.find((p) => Math.hypot(p.x - ent.x, p.z - ent.z) < 26);
    if (pack) pack.alive = Math.max(0, pack.alive - 1);
    const rec = api.state.tamed.find((t) => t.unit === ent);
    if (rec) {
      api.state.tamed = api.state.tamed.filter((t) => t !== rec);
      api.say(`${ent.name} has fallen`, 'warn');
    }
    api.fx.blood(ent.x, ent.y + 0.4, ent.z, 5);
  },

  levelUp(api, unit, rec) {
    rec.level = Math.min(5, rec.level + 1);
    const d = unit.def;
    unit.def = {
      ...d,
      attack: d.attack + 3,
      armor: (d.armor || 0) + 1,
      hp: d.hp
    };
    unit.maxHp *= 1.14;
    unit.hp = Math.min(unit.maxHp, unit.hp + unit.maxHp * 0.3);
    unit._stats = null;
    unit.statsCache = null;
    api.fx.glowPulse?.(unit.x, unit.y + 1, unit.z, 0.6, 0.9, 0.4);
    api.mark(unit.x, unit.z, { kind: 0, r0: 0.9, g0: 0.85, b0: 0.35, r: 2.0 });
    api.say(`${unit.name} reached level ${rec.level}`, 'good');
  },

  speedMul(api, unit) {
    if (!unit) return 1;
    if (unit.tamedBeast) {
      const rec = api.state.tamed.find((t) => t.unit === unit);
      if (rec) return 1 + rec.level * 0.035;
    }
    return 1;
  },

  /* ------------------------------------------------------------
     tick: wild behaviour
     ------------------------------------------------------------ */
  tick(api, dt) {
    const now = api.time;

    /* tamed beasts follow their master when idle */
    for (const rec of api.state.tamed) {
      const b = rec.unit;
      if (!b || b.dead) continue;
      if (b.state !== 'idle') continue;
      let master = null, md = Infinity;
      for (const m of api.teamUnits(b.team)) {
        if (m.type !== MASTER) continue;
        const d = Math.hypot(m.x - b.x, m.z - b.z);
        if (d < md) { md = d; master = m; }
      }
      if (master && md > 7) api.game.orderMove([b], master.x + 1.5, master.z + 1.5, false);
      else if (master && md > 4 && api.rng() < dt * 0.5) {
        const spot = api.headroom(master.x, master.z) || [master.x, master.z];
        api.game.orderMove([b], spot[0], spot[1], false);
      }
    }

    /* wild beasts: hunt nearby villagers if they are idle, and howl */
    api.state.howlT -= dt;
    if (api.state.howlT <= 0) {
      api.state.howlT = 6 + api.rng() * 8;
      let howled = false;
      for (const u of api.units()) {
        if (!u.wild || u.type !== WOLF) continue;
        if (u.target) continue;
        const prey = api.units().filter((e) => e.team !== u.team && e.type === 'villager' &&
          Math.hypot(e.x - u.x, e.z - u.z) < 18 && e.team !== 0);
        if (!prey.length) continue;
        let best = prey[0], bd = Infinity;
        for (const p of prey) {
          const d = Math.hypot(p.x - u.x, p.z - u.z);
          if (d < bd) { bd = d; best = p; }
        }
        api.game.orderAttack([u], best);
        if (!howled) {
          howled = true;
          api.fx.dust(u.x, u.y + 1, u.z, 3, 0.8);
          api.mark(u.x, u.z, { kind: 1, r0: 0.5, g0: 0.5, b0: 0.5, r: 2.4 });
        }
      }
    }

    /* a wild beast that has been idle for a while wanders toward the town:
       this is what makes the wilderness feel alive instead of static */
    if (now > 20 && api.rng() < dt * 0.35) {
      for (const u of api.units()) {
        if (!u.wild || u.state !== 'idle') continue;
        const target = api.teamUnits(TEAM_PLAYER).filter((e) => Math.hypot(e.x - u.x, e.z - u.z) < 40);
        if (!target.length) continue;
        const p = target[(api.rng() * target.length) | 0];
        api.game.orderMove([u], p.x, p.z, false);
      }
    }
  },

  atmosphere(api) {
    let wild = 0;
    for (const u of api.units()) if (u.wild) wild++;
    if (!wild) return null;
    return { cloud: 0.05 };
  },

  hud(api) {
    let tamed = 0, wild = 0;
    for (const u of api.units()) {
      if (u.tamedBeast) tamed++;
      else if (u.wild) wild++;
    }
    api.hud({
      icon: 'deer', label: 'Wilds',
      value: `${wild} wild · ${tamed} tamed`,
      tone: wild > 0 ? 'calm' : 'good'
    });
  },

  /* ------------------------------------------------------------
     taming
     ------------------------------------------------------------ */
  commands(ctx) {
    const sel = ctx.selection.filter((e) => e.kind === 'unit' && e.type === MASTER && e.team === TEAM_PLAYER);
    if (!sel.length) return [];
    const api = ctx.api;
    const master = sel[0];
    return [{
      icon: 'deer', label: 'Tame', primary: true,
      cost: 'wounded beast',
      action: () => {
        ctx.cast({
          id: 'tame', label: 'Tame', range: 7.5, radius: 1, target: 'entity',
          color: [0.55, 0.9, 0.5],
          onCast: (x, z, hit) => {
            const beast = hit && hit.kind === 'unit' && (hit.type === WOLF || hit.type === BEAR) ? hit : null;
            if (!beast) { api.say('Tap a wounded wolf or bear', 'warn'); return false; }
            if (beast.team === TEAM_PLAYER) { api.say('That one already follows you', 'warn'); return false; }
            if (Math.hypot(beast.x - master.x, beast.z - master.z) > 7.5) { api.say('Too far away', 'warn'); return false; }
            if (beast.hp > beast.maxHp * 0.35) {
              api.say(`${beast.name} is too strong — beat it below a third of its health first`, 'warn');
              return false;
            }
            const wasWild = !!beast.wild;
            beast.team = TEAM_PLAYER;
            beast.wild = false;
            beast.tamedBeast = true;
            beast.beast = false;
            beast.target = null;
            beast.state = 'idle';
            beast.hp = Math.max(beast.hp, beast.maxHp * 0.55);
            beast.statsCache = null;
            beast._stats = null;
            const rec = { unit: beast, level: 1, kills: 0, wild: wasWild };
            api.state.tamed.push(rec);
            api.state.tamed = api.state.tamed.filter((t) => t.unit && !t.unit.dead);
            api.fx.heal(beast.x, beast.y + 1, beast.z, 8);
            api.mark(beast.x, beast.z, { kind: 0, r0: 0.4, g0: 1, b0: 0.4, r: 2.4 });
            api.say(`${beast.name} is yours`, 'good');
            ctx.ui?.refreshCommands(true);
            return true;
          }
        });
      }
    }];
  },

  dispose(api) {
    for (const rec of api.state.tamed) {
      if (rec.unit && !rec.unit.dead) rec.unit.tamedBeast = false;
    }
    api.state.tamed.length = 0;
  }
};
