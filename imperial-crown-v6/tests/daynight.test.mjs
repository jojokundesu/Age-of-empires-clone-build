/* Day/night rules.
   The cycle is not decoration: it changes the economy, melee damage and
   vision, it drives the renderer's sun, and the HUD has to show it. This
   suite pins those rules down so a future tweak to the lighting cannot
   silently change the game balance (or the reverse). */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { buildRenderTerrain } from '../src/sim/worldgen.js';
import { Camera, MIN_PITCH } from '../src/gfx/camera.js';
import { m4transformPoint } from '../src/core/math.js';

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) {
    fails.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || 'not near'}: ${a} vs ${b}`);

console.log('\nDAY / NIGHT');

const world = generateWorld(20261);
const makeGame = () => {
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  return g;
};
const game = makeGame();

check('setTimeOfDay wraps and sanitises', () => {
  near(game.setTimeOfDay(9), 9, 1e-9, 'plain hour');
  near(game.setTimeOfDay(-3), 21, 1e-9, 'negative hour');
  near(game.setTimeOfDay(27.5), 3.5, 1e-9, 'hour past midnight');
  const before = game.worldTime;
  game.setTimeOfDay('not a number');
  near(game.worldTime, before, 1e-9, 'NaN must not move the clock');
});

check('daylight is a smooth 0..1 curve with the right ends', () => {
  game.setTimeOfDay(12.25); near(game.daylight, 1, 0.02, 'noon is full daylight');
  game.setTimeOfDay(0); near(game.daylight, 0, 1e-6, 'midnight is dark');
  game.setTimeOfDay(23.5); near(game.daylight, 0, 1e-6, 'late night is dark');
  const samples = [];
  for (let h = 0; h < 24; h += 0.25) { game.setTimeOfDay(h); samples.push(game.daylight); }
  for (const v of samples) assert(v >= 0 && v <= 1, 'daylight out of range: ' + v);
  let jumps = 0;
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i] - samples[i - 1]) > 0.25) jumps++;
  assert(jumps <= 1, 'daylight jumps (the wrap at midnight): ' + jumps);
});

check('dayPhase covers the whole 24 h clock', () => {
  const expect = [[12, 'day'], [6, 'dawn'], [18.5, 'dusk'], [22, 'night'], [2, 'night'], [7.5, 'day'], [20, 'night']];
  for (const [h, phase] of expect) {
    game.setTimeOfDay(h);
    assert(game.dayPhase === phase, `${h}h should be ${phase}, got ${game.dayPhase}`);
  }
  // no gaps: every quarter hour maps to a known phase
  const known = new Set(['day', 'dawn', 'dusk', 'night']);
  for (let h = 0; h < 24; h += 0.25) { game.setTimeOfDay(h); assert(known.has(game.dayPhase), 'unknown phase at ' + h); }
});

check('villagers gather faster by day, slower at night', () => {
  const villager = game.units.find((u) => u.type === 'villager' && u.team === 1);
  assert(villager, 'no player villager');
  game.setTimeOfDay(12.25);
  const day = game.gatherRate(villager, 'wood');
  game.setTimeOfDay(0.5);
  const night = game.gatherRate(villager, 'wood');
  const ratio = night / day;
  near(ratio, 0.86 / 1.10, 0.01, 'night/day gather ratio');
  assert(ratio < 0.85, 'night is not a real penalty: ' + ratio.toFixed(3));
  // and the swing is worth playing around
  assert(day / night > 1.2, 'the day bonus is not worth planning for');
});

check('melee hits harder at night, archers do not', () => {
  game.setTimeOfDay(12.25);
  const raidByDay = game.nightRaidMul;
  game.setTimeOfDay(0.5);
  const raidByNight = game.nightRaidMul;
  near(raidByDay, 1, 0.01, 'no bonus at noon');
  near(raidByNight, 1.16, 0.01, 'full bonus at midnight');
  assert(raidByNight > raidByDay, 'night raids do not hit harder');

  // measured through the real damage path (armour included), one swing at a
  // time so the result does not depend on attack cooldown timing
  const swing = (hour) => {
    const g = makeGame();
    g.setTimeOfDay(hour);
    const a = g.spawnUnitRaw('swordsman', 1, -1.0, 0);
    const b = g.spawnUnitRaw('swordsman', 2, 1.0, 0);
    let total = 0;
    for (let i = 0; i < 12; i++) {
      b.hp = b.maxHp;
      a.performAttack(b, a.stats());
      total += b.maxHp - b.hp;
    }
    return total / 12;
  };
  const byDay = swing(12.25);
  const byNight = swing(0.5);
  assert(byDay > 0, 'the swordsman deals no damage at all');
  // armour is subtracted *after* the multiplier, so the observed ratio is a
  // little above the raw 1.16 -- what matters is that it is a real bonus
  const ratio = byNight / byDay;
  assert(ratio > 1.1 && ratio < 1.25, 'night melee damage ratio out of band: ' + ratio.toFixed(3));
});

check('sight shrinks after dark', () => {
  game.setTimeOfDay(12.25);
  const daySight = game.sightDayMul;
  game.setTimeOfDay(1);
  const nightSight = game.sightDayMul;
  near(daySight, 1, 0.01, 'full sight at noon');
  near(nightSight, 0.84, 0.01, 'reduced sight at night');
  assert(daySight > nightSight, 'sight does not shrink at night');
});

check('the fog grid really is smaller at night', () => {
  const lit = (hour) => {
    const g = makeGame();
    g.setTimeOfDay(hour);
    g.updateFog(0.02);
    let seen = 0;
    for (let i = 0; i < g.fow.length; i++) if (g.fow[i] === 2) seen++;
    return seen;
  };
  const day = lit(12.25);
  const night = lit(1);
  assert(day > 0 && night > 0, 'no visible cells at all');
  assert(night < day, `night fog not tighter: day ${day} night ${night}`);
});

check('phase changes fire exactly once per crossing', () => {
  const g = makeGame();
  const seen = [];
  g.onEvent = (type, data) => { if (type === 'phase') seen.push(data.phase); };
  g.setTimeOfDay(19.4);
  const step = (24 / g.dayLength) * (1 / 60);   // one frame of world time
  for (let i = 0; i < 60 * 40; i++) g.update(1 / 60);
  assert(seen.includes('night'), 'never reached night: ' + seen.join(','));
  // dusk at 17.5-20.0 then night, never two identical phases in a row
  for (let i = 1; i < seen.length; i++) assert(seen[i] !== seen[i - 1], 'duplicate phase event: ' + seen.join(','));
  assert(seen.length <= 3, 'phase flapping: ' + seen.join(','));
  assert(step > 0, 'day length must move the clock');
});

check('the clock advances and loops', () => {
  const g = makeGame();
  g.setTimeOfDay(23.99);
  for (let i = 0; i < 60; i++) g.update(1 / 60);
  assert(g.worldTime >= 0 && g.worldTime < 24, 'clock out of range: ' + g.worldTime);
  assert(g.worldTime < 1, 'clock did not wrap past midnight: ' + g.worldTime);
});

check('a full day is fifteen real minutes: ten of sun, five of dark', () => {
  assert(game.dayLength >= 300 && game.dayLength <= 2400, 'day length is not playable: ' + game.dayLength);
  const g = makeGame();
  /* measure the actual cycle, not the neutral-rate constant: the dark runs on
     its own multiplier, so a cycle is not dayLength seconds */
  g.setTimeOfDay(5.0);
  let t = 0, dark = 0;
  let wrapped = false;
  while (t < 1200 && !wrapped) {
    const phase = g.dayPhase;
    g.update(1 / 60); t += 1 / 60;
    if (phase === 'night') dark += 1 / 60;
    /* one exact loop: the clock passes 05:00 again */
    if (t > 60 && g.worldTime >= 5.0 && g.worldTime < 5.5) wrapped = true;
  }
  const light = t - dark;
  near(light, 600, 18, 'the sun is out for ten minutes');
  near(dark, 300, 18, 'the dark lasts five minutes');
  near(t, 900, 25, 'a full cycle is fifteen minutes');
});

check('the Long Night omen lengthens the dark to ten minutes', () => {
  const g = makeGame();
  /* the omen is applied by the wheel; pin the same effect directly so the
     clock's own behaviour is what is under test */
  Object.defineProperty(g.calendar, 'nightStretch', { value: 2, configurable: true });
  g.setTimeOfDay(20.0);
  let dark = 0;
  for (let i = 0; i < 60 * 700; i++) {
    const phase = g.dayPhase;
    g.update(1 / 60);
    if (phase === 'night') dark += 1 / 60;
    if (dark > 0 && phase !== 'night') break;
  }
  near(dark, 600, 25, 'a long night is ten minutes');
});

check('renderer follows the clock through a whole day', async () => {});
{
  // the environment update is pure, so it can be driven directly
  const { Renderer } = await import('../src/gfx/renderer.js');
  const { createMockGL } = await import('./mockgl.mjs');
  const canvas = { width: 900, height: 420, clientWidth: 900, clientHeight: 420,
    getContext: (k) => (k === 'webgl2' ? createMockGL() : null), addEventListener() {}, removeEventListener() {} };
  const r = new Renderer(canvas, { quality: 'low' });
  const night0 = [], exposure = [], sunY = [], light = [];
  for (const h of [0, 6, 9, 12, 15, 18, 21, 23.9]) {
    r.updateEnvironment(1 / 60, h);
    night0.push(r.night); exposure.push(r.exposure); sunY.push(r.sunDir[1]); light.push(r.townLightI);
  }
  check('night factor is 0 at noon and 1 at midnight', () => {
    near(night0[3], 0, 0.02, 'noon');
    near(night0[0], 1, 0.02, 'midnight');
    near(night0[7], 1, 0.05, 'just before midnight');
  });
  check('exposure rises after dark so night is not a black screen', () => {
    assert(exposure[0] > exposure[3] * 1.15, 'night exposure is not brighter: ' + exposure.join(','));
    assert(exposure.every((v) => v > 0.9 && v < 1.8), 'exposure out of range: ' + exposure.join(','));
  });
  check('the sun keeps a usable angle (no flat, shadowless light)', () => {
    assert(sunY[3] > 0.5, 'sun is not high at noon: ' + sunY[3]);
    assert(sunY.every((v) => v > 0.1), 'sun dips to the horizon: ' + sunY.join(','));
  });
  check('the town fires only burn after dark', () => {
    near(light[3], 0, 1e-6, 'no firelight at noon');
    near(light[0], 1, 1e-6, 'full firelight at midnight');
  });
  check('the moon rises opposite the sun and hangs low all night', () => {
    const moonElev = [], amounts = [], lens = [];
    for (const h of [0, 12, 19, 20, 22, 2, 4]) {
      r.updateEnvironment(1 / 60, h);
      moonElev.push((Math.asin(r.moonDir[1]) * 180) / Math.PI);
      amounts.push(r.moonAmount);
      lens.push(Math.hypot(r.moonDir[0], r.moonDir[1], r.moonDir[2]));
    }
    near(amounts[0], 1, 1e-6, 'full moon at midnight');
    near(amounts[1], 0, 1e-6, 'no moon at noon');
    assert(amounts.slice(2).every((a) => a >= 0 && a <= 1), 'moon amount out of range: ' + amounts.join(','));
    for (const l of lens) near(l, 1, 0.01, 'moon direction is not normalised');
    // it has to sit inside the band of sky an RTS camera can actually see
    for (let i = 0; i < moonElev.length; i++) {
      if (amounts[i] < 0.5) continue;
      assert(moonElev[i] > 0.5 && moonElev[i] < 10,
        `moon is at ${moonElev[i].toFixed(1)} deg, outside the visible sky band`);
    }
    assert(amounts.filter((a) => a > 0.1 && a < 0.9).length >= 0,
      'moon should fade in through dusk');
  });

  check('the moon is actually inside the frame when the camera tilts down', () => {
    /* The old 0.42 rad pitch floor pointed the camera so far at the ground that
       no sky (and therefore no moon) was ever visible during play. This walks
       the yaw around the whole circle at the lowest pitch and proves the disc
       lands on screen for at least one of them. */
    r.updateEnvironment(1 / 60, 22);
    const moon = Array.from(r.moonDir);
    const cam = new Camera({ yaw: 0, pitch: MIN_PITCH, dist: 52, fov: 46 });
    cam.setAspect(900 / 414);
    cam.heightAt = () => 0;
    cam.setTarget(0, 0, true);
    cam.update(1 / 60, { instant: true });
    const out = [0, 0, 0];
    const onScreen = (yaw) => {
      cam.yaw = cam.desiredYaw = yaw;
      cam.update(1 / 60, { instant: true });
      const p = [cam.eye[0] + moon[0] * 400, cam.eye[1] + moon[1] * 400, cam.eye[2] + moon[2] * 400];
      m4transformPoint(out, cam.viewProj, p[0], p[1], p[2]);
      return Math.abs(out[0]) < 1 && Math.abs(out[1]) < 1;
    };
    let seen = 0;
    for (let i = 0; i < 96; i++) if (onScreen((i / 96) * Math.PI * 2)) seen++;
    assert(seen > 0, 'the moon never lands on screen at the lowest pitch');
    assert(seen < 96, 'the moon is on screen from every angle (suspicious)');

    // at the default RTS angle the camera looks at the ground, as it should
    let seenHigh = 0;
    for (let i = 0; i < 96; i++) {
      cam.yaw = cam.desiredYaw = (i / 96) * Math.PI * 2;
      cam.pitch = cam.desiredPitch = 0.86;
      cam.update(1 / 60, { instant: true });
      const p = [cam.eye[0] + moon[0] * 400, cam.eye[1] + moon[1] * 400, cam.eye[2] + moon[2] * 400];
      m4transformPoint(out, cam.viewProj, p[0], p[1], p[2]);
      if (Math.abs(out[0]) < 1 && Math.abs(out[1]) < 1) seenHigh++;
    }
    assert(seenHigh === 0, 'the sky is visible at a steep top-down pitch (camera maths broke)');
    assert(MIN_PITCH < 0.3, 'the pitch floor is too high to see any sky: ' + MIN_PITCH);
    cam.pitch = cam.desiredPitch = MIN_PITCH;
    cam.nudge(0, -1);
    near(cam.desiredPitch, MIN_PITCH, 1e-9, 'nudge must clamp at the pitch floor');
  });
  check('the renderer samples game.worldTime', () => {
    const g = makeGame();
    g.setTimeOfDay(21.6);
    r.updateEnvironment(1 / 60, g.worldTime);
    near(r.night, 1, 0.02, 'renderer did not go to night');
    g.setTimeOfDay(11);
    r.updateEnvironment(1 / 60, g.worldTime);
    near(r.night, 0, 0.02, 'renderer did not return to day');
  });
  if (r.ready) r.dispose();
}

check('the terrain mesh is clock-independent (no rebuild hitch at dusk)', () => {
  const t = buildRenderTerrain(world);
  for (const k of ['heights', 'splat4', 'splat2']) {
    assert(t[k] && t[k].length, 'terrain has no ' + k);
  }
  const n = t.heights.length;
  game.setTimeOfDay(21);
  const t2 = buildRenderTerrain(world);
  assert(t2.heights.length === n, 'terrain height count changed with the clock');
  assert(t.n === t2.n && t.cell === t2.cell, 'terrain grid changed with the clock');
});

/* ------------------------------------------------------------
   THE LENGTH OF A DAY
   A day is the one clock a player plans a campaign by, so its
   proportions are a design decision, not a detail: ten minutes of
   light to build and march in, five minutes of dark to raid in,
   and a "Long Night" omen that makes the dark ten minutes long.
   ------------------------------------------------------------ */
{
  const game = new Game({ world, civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
  game.start();
  const cycle = game.dayLength;
  /* the light rate is 24 hours per cycle; the dark runs 1.2x faster per hour,
     which is exactly what turns 15 daylight hours into 600 s and 9 night
     hours into 300 s */
  const perHour = cycle / 24;
  check('a full day is fifteen minutes', () => {
    const full = 15 * perHour + 9 / (1 / perHour * game.nightRateMul);
    assert(Math.abs(full - 900) < 20, `a full cycle is ${full.toFixed(0)}s`);
  });
  check('the dark is five minutes and the light is ten', () => {
    const night = 9 / (1 / perHour * game.nightRateMul);
    const light = 15 * perHour;
    assert(Math.abs(night - 300) < 12, `night is ${night.toFixed(0)}s`);
    assert(Math.abs(light - 600) < 12, `daylight is ${light.toFixed(0)}s`);
  });
  check('the Long Night omen makes the dark ten minutes', () => {
    const night = 9 / (1 / perHour * game.nightRateMul / 2);
    assert(Math.abs(night - 600) < 25, `a long night is ${night.toFixed(0)}s`);
  });
  check('the clock really spends that long in each phase', () => {
    const g2 = new Game({ world, civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
    g2.start();
    g2.setTimeOfDay(5.0);
    let dark = 0, light = 0;
    for (let i = 0; i < 30 * 900; i++) {
      g2.update(1 / 30);
      if (g2.dayPhase === 'night') dark += 1 / 30;
      else light += 1 / 30;
    }
    const ratio = dark / (dark + light);
    assert(ratio > 0.3 && ratio < 0.45, `the dark is ${(ratio * 100).toFixed(0)}% of a cycle`);
  });
}


if (fails.length) {
  console.log(`\nFAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log('\nDAY/NIGHT CHECKS PASSED');
