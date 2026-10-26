/* ============================================================
   weather.js — Seasons & Storm
   ------------------------------------------------------------
   A weather system with teeth. The sky is not decoration here: rain
   softens the harvest, snow slows every march, a storm grounds your
   archers and throws lightning at the battlefield, and fog blinds
   the long shots.

   Everything is telegraphed in the HUD ("Storm in 12s") so it reads
   as a rhythm to plan around rather than as bad luck.
   ============================================================ */
import { TEAM_PLAYER, TEAM_ENEMY } from '../sim/game.js';

const PHASES = [
  {
    id: 'clear', name: 'Clear skies', icon: 'eye', min: 45, max: 80,
    gather: 1, speed: 1, archer: 1, fog: 0, sun: 1,
    line: 'Nothing in the way of a good harvest.'
  },
  {
    id: 'rain', name: 'Rain', icon: 'leaf', min: 40, max: 70,
    gather: 0.85, speed: 0.97, archer: 0.95, fog: 0.0014, sun: 0.9,
    line: 'Fields are soft: gathering is 15% slower.'
  },
  {
    id: 'snow', name: 'Snow', icon: 'mountain', min: 45, max: 75,
    gather: 0.75, speed: 0.9, archer: 0.95, fog: 0.0018, sun: 0.96,
    line: 'Snow: marching is 10% slower and the harvest is thin.'
  },
  {
    id: 'storm', name: 'Storm', icon: 'bolt', min: 35, max: 55,
    gather: 0.8, speed: 0.94, archer: 0.75, fog: 0.0028, sun: 0.72,
    line: 'Archers loose badly in the wind. Lightning strikes the field.'
  },
  {
    id: 'fog', name: 'Thick fog', icon: 'eye', min: 35, max: 55,
    gather: 0.95, speed: 0.98, archer: 0.82, fog: 0.006, sun: 0.86,
    line: 'Fog: arrows are blind and the battlefield shrinks.'
  }
];

export const weather = {
  id: 'weather',
  name: 'Seasons & Storm',
  icon: 'bolt',
  tagline: 'The sky is a participant.',
  blurb: 'Rain, snow, storms and fog that change harvesting, marching, archery and the sky itself.',
  detail: [
    'Weather changes every minute or so, and every phase has a real effect: rain thins the harvest, snow slows the march, storms spoil archery and throw lightning, fog blinds the long shots.',
    'The HUD always shows the current phase and what it is doing, so it is something to plan around rather than a surprise.',
    'Snow only falls after the first few minutes of a match — early rushes are fought in the dry.'
  ],

  createState() {
    return {
      phase: PHASES[0],
      next: null,
      t: 25,
      lightningT: 8,
      warned: false
    };
  },

  setup(api) {
    api.state.phase = PHASES[0];
    api.state.t = 18 + api.rng() * 12;
    api.state.next = this.pick(api, true);
    api.say('Seasons turn over this land — watch the sky', 'info');
  },

  pick(api, first = false) {
    const now = api.time;
    let pool = PHASES;
    /* the opening minutes stay dry, so an early rush is not decided by snow */
    if (now < 180) pool = PHASES.filter((p) => p.id === 'clear' || p.id === 'rain' || p.id === 'fog');
    let choice = pool[(api.rng() * pool.length) | 0];
    if (choice.id === api.state.phase.id && pool.length > 1) {
      choice = pool[(pool.indexOf(choice) + 1) % pool.length];
    }
    return choice;
  },

  tick(api, dt) {
    const st = api.state;
    st.t -= dt;

    if (st.t <= 0) {
      st.phase = st.next || this.pick(api);
      st.t = st.phase.min + api.rng() * (st.phase.max - st.phase.min);
      st.next = this.pick(api);
      st.warned = false;
      st.lightningT = 4 + api.rng() * 6;
      api.say(`${st.phase.name} — ${st.phase.line}`, st.phase.id === 'storm' ? 'warn' : 'info');
      api.banner(`${st.phase.name}`);
    } else if (!st.warned && st.t < 8 && st.next) {
      st.warned = true;
      api.say(`${st.next.name} in ${Math.ceil(st.t)}s`, 'info');
    }

    /* gather penalty: a short buff refreshed while the weather holds. Applied
       to both sides, so it is weather and not a handicap. */
    const g = st.phase.gather;
    if (g < 1) {
      api.buff(TEAM_PLAYER, 'gather', g, 2.5);
      api.buff(TEAM_ENEMY, 'gather', g, 2.5);
    }

    /* lightning in a storm: a real hazard, and it hits both sides */
    if (st.phase.id === 'storm') {
      st.lightningT -= dt;
      if (st.lightningT <= 0) {
        st.lightningT = 5 + api.rng() * 9;
        const pool = api.units().filter((u) => !u.dead && (u.team === TEAM_PLAYER || u.team === TEAM_ENEMY));
        if (pool.length) {
          const victim = pool[(api.rng() * pool.length) | 0];
          const x = victim.x + (api.rng() - 0.5) * 2.2;
          const z = victim.z + (api.rng() - 0.5) * 2.2;
          const y = api.height(x, z);
          api.fx.explosion(x, y + 0.5, z, 1.1);
          api.fx.sparks(x, y + 2.2, z, 16, [0.85, 0.9, 1]);
          api.mark(x, z, { kind: 1, r0: 1, g0: 1, b0: 1, r: 2.4, life: 0.45 });
          for (const e of api.units()) {
            if (e.dead) continue;
            if (Math.hypot(e.x - x, e.z - z) > 3) continue;
            api.damage(e, 26, null);
          }
          for (const b of api.buildings()) {
            if (b.dead || Math.hypot(b.x - x, b.z - z) > 3 + b.size * 0.5) continue;
            api.damage(b, 10, null);
          }
        }
      }
    }
  },

  speedMul(api, unit) {
    if (!unit || unit.dead) return 1;
    return api.state.phase.speed;
  },

  onDamage(api, ent, amount, attacker, kind) {
    const phase = api.state.phase;
    if (!attacker || !attacker.def || phase.archer >= 1) return amount;
    if (kind !== 'pierce') return amount;
    if (!attacker.def.classes || !attacker.def.classes.includes('archer')) return amount;
    return amount * phase.archer;
  },

  atmosphere(api) {
    const p = api.state.phase;
    const tint = p.id === 'storm' ? [0.72, 0.76, 0.86]
      : p.id === 'rain' ? [0.82, 0.87, 0.95]
      : p.id === 'snow' ? [0.94, 0.97, 1.0]
      : p.id === 'fog' ? [0.9, 0.92, 0.94]
      : [1, 1, 1];
    return {
      tint,
      fog: p.fog,
      exposure: p.id === 'storm' ? 0.86 : p.id === 'rain' ? 0.94 : 1,
      cloud: p.id === 'clear' ? 0 : p.id === 'storm' ? 0.35 : 0.18
    };
  },

  hud(api) {
    const st = api.state;
    api.hud({
      icon: st.phase.icon,
      label: st.phase.name,
      value: st.next ? `${st.phase.line.split(':')[0]} · ${st.next.name} in ${Math.ceil(st.t)}s` : st.phase.line,
      tone: st.phase.id === 'storm' ? 'bad' : st.phase.id === 'clear' ? 'good' : 'calm'
    });
  },

  banner(api) {
    return api.state.phase.name;
  }
};
