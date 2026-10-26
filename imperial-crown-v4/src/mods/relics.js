/* ============================================================
   relics.js — Relics of the Old Faith
   ------------------------------------------------------------
   Five shrines stand in the wilderness. Nobody owns them; you *hold*
   them, by standing next to them, and holding one is a permanent
   empire-wide buff — until someone else stands there long enough to
   take it away from you.

   That makes the middle of the map worth fighting over without
   adding a single new unit. The shrines stay neutral on purpose:
   they are objectives, not buildings, so they never count towards
   "destroy every building" and can never be used to dodge a loss.
   ============================================================ */
import { TEAM_PLAYER, TEAM_ENEMY } from '../sim/game.js';
import { Building } from '../sim/entities.js';

const SHRINE = 'relic_shrine';
const COUNT = 5;
const CLAIM_TIME = 6;          // seconds of uncontested presence
const CLAIM_RADIUS = 2.8;

const RELICS = [
  { id: 'harvest', name: 'Relic of Harvest', icon: 'wheat', kind: 'gather', mul: 1.15, blurb: '+15% gather rate' },
  { id: 'ward', name: 'Relic of Warding', icon: 'shield', kind: 'armor', mul: 2.6, blurb: '+2 armour to every unit' },
  { id: 'swift', name: 'Relic of the Swift', icon: 'boot', kind: 'speed', mul: 1.12, blurb: '+12% movement speed' },
  { id: 'fury', name: 'Relic of Fury', icon: 'sword', kind: 'attack', mul: 1.18, blurb: '+18% attack' },
  { id: 'bounty', name: 'Relic of Bounty', icon: 'coin', kind: 'gather', mul: 1.1, blurb: '+10% gather rate' }
];

export const relics = {
  id: 'relics',
  name: 'Relics of the Old Faith',
  icon: 'relic',
  tagline: 'Hold the ground, hold the power.',
  blurb: 'Five shrines grant empire-wide buffs to whoever stands beside them long enough.',
  detail: [
    'Five shrines stand in the wilderness. Stand next to one for six seconds to claim it; the buff is empire-wide and lasts as long as you hold it.',
    'Relics are contested: an enemy standing at your shrine drains your claim, and taking it back costs the same six seconds.',
    'Relics reward map control rather than a bigger army — a scout that finds one early is worth a whole barracks.',
    'The AI knows about them and will send soldiers to take them.'
  ],
  buildings: {
    [SHRINE]: {
      name: 'Relic Shrine', icon: 'relic', hp: 900, armor: 3, pierceArmor: 6, size: 2.6,
      sight: 8, neutral: true, cost: {}, time: 1,
      desc: 'An old shrine. Hold it to gain a relic.'
    }
  },

  createState() {
    return {
      shrines: [],
      aiT: 15,
      claimed: { 1: [], 2: [] }
    };
  },

  setup(api) {
    const g = api.game;
    const base = g.playerBase;
    const used = [];
    const spots = [];
    for (let i = 0; i < COUNT * 6 && spots.length < COUNT; i++) {
      const a = api.rng() * Math.PI * 2;
      const r = 42 + api.rng() * 90;
      const x = base.x + Math.cos(a) * r;
      const z = base.z + Math.sin(a) * r;
      if (!api.passable(x, z)) continue;
      if (used.some((p) => Math.hypot(p[0] - x, p[1] - z) < 30)) continue;
      if (api.teamBuildings(TEAM_PLAYER).some((b) => Math.hypot(b.x - x, b.z - z) < 20)) continue;
      used.push([x, z]);
      spots.push([x, z]);
    }
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      const relic = RELICS[i % RELICS.length];
      /* built directly, not through placeBuilding(): a neutral shrine has no
         team to charge and must never appear in a player's building count */
      const shrine = new Building(g, SHRINE, 0, x, z, true);
      g.addBuilding(shrine);
      shrine.neutral = true;
      shrine.team = 0;
      shrine.buildProgress = 1;
      shrine.hp = shrine.maxHp;
      shrine.relic = relic;
      api.state.shrines.push({ b: shrine, relic, owner: 0, progress: 0, by: 0 });
      api.fx.heal(x, api.height(x, z) + 1.6, z, 4);
    }
    api.say('Five shrines stand in the wilds — hold them for their power', 'good');
  },

  /* ------------------------------------------------------------
     claiming
     ------------------------------------------------------------ */
  tick(api, dt) {
    const st = api.state;
    const units = api.units();

    for (const s of st.shrines) {
      if (!s.b || s.b.dead) { s.owner = 0; s.progress = 0; continue; }
      let bestTeam = 0, bestCount = 0;
      const counts = { 1: 0, 2: 0 };
      for (const u of units) {
        if (u.team !== TEAM_PLAYER && u.team !== TEAM_ENEMY) continue;
        if (Math.hypot(u.x - s.b.x, u.z - s.b.z) > CLAIM_RADIUS) continue;
        counts[u.team]++;
      }
      if (counts[TEAM_PLAYER] > counts[TEAM_ENEMY]) { bestTeam = TEAM_PLAYER; bestCount = counts[TEAM_PLAYER]; }
      else if (counts[TEAM_ENEMY] > counts[TEAM_PLAYER]) { bestTeam = TEAM_ENEMY; bestCount = counts[TEAM_ENEMY]; }

      if (!bestTeam) {
        /* nobody stands here: an unclaimed progress decays, a *held* shrine
           does not (you keep the relic until it is taken) */
        if (s.owner === 0 && s.progress > 0) s.progress = Math.max(0, s.progress - dt * 0.5);
        continue;
      }

      if (s.owner === bestTeam) {
        s.progress = 1;
        continue;
      }

      if (s.by !== bestTeam) { s.by = bestTeam; s.progress = 0; }
      s.progress += (dt / CLAIM_TIME) * Math.min(2, bestCount);
      if (s.progress >= 1) {
        const previous = s.owner;
        s.owner = bestTeam;
        s.progress = 1;
        st.claimed[TEAM_PLAYER] = st.claimed[TEAM_PLAYER].filter((r) => r !== s.relic.id);
        st.claimed[TEAM_ENEMY] = st.claimed[TEAM_ENEMY].filter((r) => r !== s.relic.id);
        st.claimed[bestTeam].push(s.relic.id);
        api.fx.glowPulse?.(s.b.x, api.height(s.b.x, s.b.z) + 1.4, s.b.z, 0.9, 0.8, 0.3);
        api.mark(s.b.x, s.b.z, { kind: 0, r0: 1, g0: 0.85, b0: 0.3, r: 3.4, life: 0.9 });
        if (bestTeam === TEAM_PLAYER) {
          api.say(`You hold the ${s.relic.name} — ${s.relic.blurb}`, 'good');
        } else {
          api.say(previous === TEAM_PLAYER
            ? `The enemy has taken the ${s.relic.name} from you`
            : `The enemy holds the ${s.relic.name}`, 'bad');
        }
      } else if (api.rng() < 0.15) {
        api.fx.heal(s.b.x, api.height(s.b.x, s.b.z) + 1.5, s.b.z, 1);
      }
    }

    /* the buffs are refreshed every tick while held, so losing the shrine
       ends its effect within a couple of seconds */
    for (const team of [TEAM_PLAYER, TEAM_ENEMY]) {
      for (const s of st.shrines) {
        if (s.owner !== team || !s.b || s.b.dead) continue;
        api.buff(team, s.relic.kind, s.relic.mul, 2.5);
      }
    }

    /* the AI contests the middle of the map */
    st.aiT -= dt;
    if (st.aiT <= 0) {
      st.aiT = 20;
      const free = st.shrines.filter((s) => s.b && !s.b.dead && s.owner !== TEAM_ENEMY);
      if (free.length) {
        const army = api.teamUnits(TEAM_ENEMY).filter((u) => u.def && u.def.attack > 0 && !u.beast);
        if (army.length) {
          const soldier = army[(api.rng() * army.length) | 0];
          let best = free[0], bd = Infinity;
          for (const s of free) {
            const d = Math.hypot(s.b.x - soldier.x, s.b.z - soldier.z);
            if (d < bd) { bd = d; best = s; }
          }
          if (bd < 140) api.game.orderMove([soldier], best.b.x + 1.6, best.b.z + 1.6, false);
        }
      }
    }
  },

  atmosphere() { return null; },

  hud(api) {
    const mine = api.state.shrines.filter((s) => s.owner === TEAM_PLAYER && s.b && !s.b.dead).length;
    const theirs = api.state.shrines.filter((s) => s.owner === TEAM_ENEMY && s.b && !s.b.dead).length;
    const total = api.state.shrines.length;
    api.hud({
      icon: 'relic', label: 'Relics',
      value: `${mine} / ${total} held${theirs ? ` · enemy ${theirs}` : ''}`,
      tone: mine > theirs ? 'good' : mine < theirs ? 'bad' : 'calm'
    });
  },

  /* a selected shrine shows what it is worth and how far a claim is */
  commands(ctx) {
    const sel = ctx.selection.filter((e) => e.kind === 'building' && e.type === SHRINE);
    if (!sel.length) return [];
    const shrine = sel[0];
    const rec = ctx.api.state.shrines.find((s) => s.b === shrine);
    if (!rec) return [];
    const owner = rec.owner === TEAM_PLAYER ? 'yours' : rec.owner === TEAM_ENEMY ? 'enemy' : 'unclaimed';
    return [{
      icon: rec.relic.icon,
      label: rec.relic.name.replace('Relic of ', ''),
      cost: `${owner} · ${Math.round(rec.progress * 100)}%`,
      enabled: false,
      reason: `${rec.relic.blurb}. Stand beside it for six seconds.`
    }];
  }
};
