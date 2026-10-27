/* ============================================================
   artificer.js — Artificer's Workshop
   ------------------------------------------------------------
   New *tools* rather than new soldiers:

     Spike Trench  — drawn like a wall, invisible to nobody but cheap.
                     The first enemy to walk over it is impaled and
                     snared; the trap is spent.
     Ballista Tower— a long-ranged, slow-firing tower that hits as
                     hard as a knight but cannot move or be repaired
                     mid-fight.
     Fire Arrows   — a one-off upgrade that makes every arrow burn.
                     Bought at the Town Centre, it changes how you
                     mass archers for the rest of the match.

   Traps are walkable (walkable: true), so they do not wall your own
   troops out — the line is a trap, not a fence.
   ============================================================ */
import { TEAM_PLAYER } from '../sim/game.js';

const TRAP = 'spike_trap';
const BALLISTA = 'ballista_tower';
const FIRE_ARROWS_COST = { food: 220, gold: 120 };

export const artificer = {
  id: 'artificer',
  name: "Artificer's Workshop",
  icon: 'anvil',
  tagline: 'Traps, engines and burning arrows.',
  blurb: 'Draw spike trenches in the dirt, raise a ballista tower, and set every arrow alight.',
  detail: [
    'Drag a Spike Trench exactly like a wall. It is walkable on purpose — the line is a trap, not a fence. The first enemy over it takes heavy damage and is snared for two seconds.',
    'The Ballista Tower out-ranges every archer and hits like a knight, but fires slowly and cannot be moved.',
    'Fire Arrows is a one-off Town Centre upgrade: every arrow your archers and towers loose sets its target burning.'
  ],
  buildings: {
    [TRAP]: {
      name: 'Spike Trench', icon: 'warning', hp: 140, armor: 0, pierceArmor: 0, size: 2,
      cost: { wood: 18 }, time: 5, sight: 3, walkable: true, dragLine: true, minAge: 0,
      desc: 'Hidden spikes. The first enemy unit to cross is impaled and snared. Walkable, so it never blocks your own troops.'
    },
    [BALLISTA]: {
      name: 'Ballista Tower', icon: 'tower', hp: 950, armor: 4, pierceArmor: 9, size: 3.2,
      pop: 0, sight: 13, cost: { wood: 140, gold: 70 }, time: 26,
      attack: 26, range: 11, minAge: 1,
      desc: 'Long-ranged bolt engine. Slow to fire, brutal against anything that stands still.'
    }
  },

  createState() {
    return {
      fireArrows: { 1: false, 2: false },
      burns: 0
    };
  },

  setup(api) {
    void api;
  },

  buildMenu(api, team) {
    if (team !== TEAM_PLAYER) return [];
    return [TRAP, BALLISTA];
  },

  /* ------------------------------------------------------------
     traps
     ------------------------------------------------------------ */
  tick(api, dt) {
    void dt;
    const traps = api.buildings().filter((b) => b.type === TRAP && b.buildProgress >= 1);
    if (traps.length) {
      for (const trap of traps) {
        /* armed traps pulse faintly once every few seconds so the owner can
           still see where the line is without a marker cluttering the field */
        for (const u of api.units()) {
          if (u.dead || u.team === trap.team || u.team === 0) continue;
          if (Math.hypot(u.x - trap.x, u.z - trap.z) > 1.5) continue;
          const st = api.unitState(u);
          st.snareUntil = api.time + 2.2;
          api.damage(u, 55, trap);
          api.fx.sparks(trap.x, trap.y + 0.4, trap.z, 14, [1, 0.9, 0.7]);
          api.fx.blood(u.x, u.y + 0.4, u.z, 6);
          api.mark(trap.x, trap.z, { kind: 0, r0: 1, g0: 0.3, b0: 0.2, r: 2.4, life: 0.5 });
          api.say('A spike trench was sprung', 'warn');
          trap.kill(null);
          break;
        }
      }
    }

    /* burns from fire arrows */
    const now = api.time;
    for (const u of api.units()) {
      const st = u.modState && u.modState.artificer;
      if (!st || !st.burnUntil) continue;
      if (now >= st.burnUntil) { st.burnUntil = 0; continue; }
      const dmg = 3.2 * (1 / 5);      // called at 5 Hz
      u.hp = Math.max(0, u.hp - dmg);
      if (u.hp <= 0) u.kill(st.burnBy || null);
      if (api.rng() < 0.06) api.fx.fire(u.x, u.y + 0.9, u.z, 1, 0.45);
    }
  },

  onDamage(api, ent, amount, attacker, kind) {
    /* a burning arrow: mark the target, let tick() do the damage */
    if (!attacker || !attacker.def || kind !== 'pierce') return amount;
    const team = attacker.team;
    if (!api.state.fireArrows[team]) return amount;
    const isArcher = attacker.def.classes && attacker.def.classes.includes('archer');
    if (!isArcher) return amount;
    if (!ent || ent.dead) return amount;
    const st = api.unitState(ent);
    st.burnUntil = api.time + 4;
    st.burnBy = attacker;
    return amount;
  },

  speedMul(api, unit) {
    if (!unit || !unit.modState || !unit.modState.artificer) return 1;
    return unit.modState.artificer.snareUntil > api.time ? 0.12 : 1;
  },

  atmosphere() {
    return null;
  },

  hud(api) {
    let traps = 0;
    for (const b of api.buildings()) if (b.type === TRAP) traps++;
    const fire = api.state.fireArrows[TEAM_PLAYER] ? 'fire arrows' : 'no fire arrows';
    api.hud({
      icon: 'anvil', label: 'Workshop',
      value: `${traps} trap${traps === 1 ? '' : 's'} · ${fire}`,
      tone: api.state.fireArrows[TEAM_PLAYER] ? 'good' : 'calm'
    });
  },

  commands(ctx) {
    const out = [];
    const tcs = ctx.selection.filter((e) => e.kind === 'building' && e.team === TEAM_PLAYER &&
      (e.type === 'town_center' || e.type === 'castle') && e.buildProgress >= 1);
    if (!tcs.length) return out;
    const owned = ctx.api.state.fireArrows[TEAM_PLAYER];
    const afford = ctx.game.canAfford(TEAM_PLAYER, FIRE_ARROWS_COST);
    out.push({
      icon: 'flame', label: owned ? 'Fire Arrows' : 'Fire Arrows',
      cost: owned ? 'researched' : '220 food · 120 gold',
      active: owned,
      enabled: !owned && afford,
      reason: 'Not enough resources',
      action: () => {
        if (owned) { ctx.ui?.toast('Fire arrows are already burning', 'info'); return; }
        ctx.game.spend(TEAM_PLAYER, FIRE_ARROWS_COST);
        ctx.api.state.fireArrows[TEAM_PLAYER] = true;
        ctx.ui?.toast('Fire Arrows — every shaft burns now', 'good');
        ctx.game.notify('Fire Arrows researched', 'good');
        for (const u of ctx.api.teamUnits(TEAM_PLAYER)) {
          if (u.def && u.def.classes && u.def.classes.includes('archer')) {
            ctx.api.fx.fire(u.x, u.y + 1.1, u.z, 2, 0.5);
          }
        }
        ctx.ui?.refreshCommands(true);
      }
    });
    return out;
  }
};
