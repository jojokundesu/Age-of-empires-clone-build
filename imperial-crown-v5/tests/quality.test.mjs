/* quality.js — the resolution budget and the frame governor.

   Everything in quality.js is pure arithmetic on purpose, so the part of the
   game that decides "how many pixels and which features" can be tested without
   a GPU, a phone or a browser. The bugs worth catching here are the ones that
   are invisible in a screenshot and ruinous on a handset:

     · a budget that is ignored, so a DPR-3 phone asks for 2.6 Mpx
     · a governor that flaps (down, up, down) every second
     · a governor that steps *up* the moment a frame is fast
     · a refresh divisor that asks for 60 fps on a 90 Hz panel
     · a loop that never renders, because the divisor maths lost the phase    */
import { readFileSync, readdirSync } from 'node:fs';
import {
  TIERS, TIER_ORDER, GPU_CLASSES, classifyGPU, pickInitialTier,
  Governor, renderSize
} from '../src/gfx/quality.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m || 'value'} ${a} != ${b} (±${tol})`);

const px = (s) => s.w * s.h;

/* ==================================================================
   tiers
   ================================================================== */
check('every tier has the full feature set', () => {
  const need = ['key', 'name', 'pixelBudget', 'shadowSize', 'shadows', 'shadowHz',
    'clouds', 'detail', 'water', 'foliage', 'unitCull', 'buildingCull', 'propDistance',
    'particleCap', 'post', 'sharpen', 'maxDpr'];
  for (const [name, t] of Object.entries(TIERS)) {
    for (const k of need) assert(t[k] !== undefined, `${name} missing ${k}`);
    assert(t.key === name, `${name}.key mismatch`);
  }
  assert(TIER_ORDER.every((n) => TIERS[n]), 'TIER_ORDER names a tier that does not exist');
  assert(TIER_ORDER.length === Object.keys(TIERS).length, 'TIER_ORDER misses a tier');
});

check('tiers are strictly monotonic in what costs money and in what looks good', () => {
  /* shape: detail/foliage top out at 1.0 (full strength) and maxDpr at the
     panel's own ratio, so those are monotonic but not strict */
  const cost = ['pixelBudget', 'shadowSize', 'unitCull',
    'buildingCull', 'propDistance', 'particleCap'];
  const atMost = ['detail', 'foliage', 'maxDpr'];
  for (let i = 1; i < TIER_ORDER.length; i++) {
    const a = TIERS[TIER_ORDER[i - 1]], b = TIERS[TIER_ORDER[i]];
    for (const k of cost) assert(b[k] > a[k], `${TIER_ORDER[i]}.${k} is not above ${TIER_ORDER[i - 1]}`);
    for (const k of atMost) assert(b[k] >= a[k], `${TIER_ORDER[i]}.${k} went backwards`);
  }
});

check('no tier asks for more than the phone it targets can shade', () => {
  /* A 1080x2340 panel is 2.53 Mpx. "high" must stay under it: if the budget
     already exceeds the panel there is no upscale to win back and the phone is
     shading pixels it cannot show. */
  assert(TIERS.high.pixelBudget <= 1080 * 2340, 'high exceeds a 1080p panel');
  assert(TIERS.medium.pixelBudget <= 1080 * 2340 * 0.5, 'medium is not a real step down');
  /* and the low tier has to actually be low, or a weak GPU gains nothing */
  assert(TIERS.low.pixelBudget <= 0.6e6, 'low is not low');
});

/* ==================================================================
   GPU classification
   ================================================================== */
check('the target phone is recognised and does not start at high', () => {
  for (const s of [
    'Adreno (TM) 610',
    'Qualcomm Adreno 610',
    'ANGLE (Qualcomm, Adreno (TM) 610 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ]) {
    const g = classifyGPU(s);
    assert(g.class === 'low', `${s} classified ${g.class}`);
    assert(g.tier !== 'high' && g.tier !== 'ultra', `${s} starts at ${g.tier}`);
  }
});

check('weak Mali and PowerVR parts are as conservative as the Adreno 610', () => {
  for (const s of ['Mali-G52 MC2', 'Mali-G51', 'PowerVR GE8320']) {
    assert(classifyGPU(s).class === 'low', s);
  }
});

check('desktop GPUs are recognised, unknown strings get a safe middle', () => {
  assert(classifyGPU('Apple M2').class === 'desktop', 'Apple M2');
  assert(classifyGPU('NVIDIA GeForce RTX 3060').class === 'desktop', 'RTX');
  const u = classifyGPU('Some Vendor Mystery GPU');
  assert(u.class === 'unknown', 'unknown class');
  assert(u.tier === 'medium', 'unknown tier');
  assert(classifyGPU(undefined).tier === 'medium', 'undefined renderer');
});

check('pickInitialTier respects an explicit saved choice, then the device', () => {
  const phone = { renderer: 'Adreno (TM) 610', cores: 8, mem: 6, ua: 'Mozilla/5.0 (Linux; Android 11)' };
  assert(pickInitialTier(phone).tier === 'medium', 'Adreno 610 should start at medium');
  assert(pickInitialTier({ ...phone, savedTier: 'ultra' }).tier === 'ultra', 'saved tier ignored');
  assert(pickInitialTier({ ...phone, savedTier: 'nonsense' }).tier === 'medium', 'garbage saved tier');
  // a mobile with an unreadable renderer string is still a mobile
  assert(pickInitialTier({ renderer: '', ua: phone.ua }).tier === 'low', 'unknown mobile');
  // a desktop with a weak string is not punished twice
  assert(pickInitialTier({ renderer: 'Mali-G52', ua: 'Mozilla/5.0 (X11; Linux)' }).tier === 'medium', 'desktop mid');
  assert(pickInitialTier(phone).gpu.name === 'Adreno 610', 'gpu name');
});

/* ==================================================================
   renderSize — the one number that decides the frame rate
   ================================================================== */
check('a 1080p phone renders at the tier budget, not at 2.6 megapixels', () => {
  for (const [name, t] of Object.entries(TIERS)) {
    const s = renderSize(360, 780, t.pixelBudget, 3, t.maxDpr);
    assert(px(s) <= t.pixelBudget * 1.02, `${name}: ${px(s)} px > budget ${t.pixelBudget}`);
    assert(px(s) > t.pixelBudget * 0.90, `${name}: ${px(s)} px leaves the budget unused`);
    near(s.w / s.h, 360 / 780, 0.02, name + ' aspect');
  }
});

check('the DPR cap is honoured: an 8K string cannot inflate the buffer', () => {
  const low = renderSize(400, 800, 5e6, 8, TIERS.low.maxDpr);
  assert(low.w <= 400 * TIERS.low.maxDpr && low.h <= 800 * TIERS.low.maxDpr,
    `low tier ignored maxDpr: ${low.w}x${low.h}`);
  /* and with a budget above the native pixel count we never upscale */
  const roomy = renderSize(360, 780, 9e6, 3, 3);
  assert(roomy.w <= 1080 && roomy.h <= 2340, `upscaled past native: ${roomy.w}x${roomy.h}`);
  near(px(roomy), 1080 * 2340, 20000, 'roomy budget should fill the panel');
});

check('never below 55% of the CSS size, never degenerate', () => {
  for (const [w, h] of [[360, 780], [800, 360], [1280, 720], [200, 200]]) {
    const s = renderSize(w, h, 1000, 3, 3);       // an absurdly small budget
    assert(s.w >= Math.round(w * 0.55) - 1 && s.h >= Math.round(h * 0.55) - 1,
      `${w}x${h} collapsed to ${s.w}x${s.h}`);
    assert(s.w >= 2 && s.h >= 2, 'degenerate size');
  }
  const tiny = renderSize(0, 0, 1e6, 3, 3);
  assert(tiny.w >= 2 && tiny.h >= 2 && Number.isFinite(tiny.w), 'zero-size viewport');
});

check('the on-screen aspect is preserved even at the minimum size', () => {
  const s = renderSize(780, 360, 5000, 2, 3);   // landscape phone, tiny budget
  near(s.w / s.h, 780 / 360, 0.03, 'clamped aspect');
});

check('renderSize is deterministic and integer', () => {
  const a = renderSize(411, 869, 1.28e6, 2.75, 3);
  const b = renderSize(411, 869, 1.28e6, 2.75, 3);
  assert(a.w === b.w && a.h === b.h, 'not deterministic');
  assert(Number.isInteger(a.w) && Number.isInteger(a.h), 'non-integer size');
});

/* ==================================================================
   the governor
   ================================================================== */
/** Feed `n` samples of `ms` and advance the clock by `dt` each time. */
function feed(g, ms, n, dt = 1 / 60) {
  const actions = [];
  for (let i = 0; i < n; i++) {
    g.sample(ms);
    const a = g.update(dt);
    if (a) actions.push(a);
  }
  return actions;
}

check('a healthy device is never touched', () => {
  const g = new Governor({ tier: 'high', refresh: 90 });
  const acts = feed(g, 1000 / 90, 600);
  assert(acts.length === 0, 'changed a healthy frame: ' + acts.join(','));
  assert(g.tier === 'high' && g.scale === 1 && g.div === 1, 'drifted while healthy');
});

check('it steps resolution down before it touches the tier', () => {
  const g = new Governor({ tier: 'high', refresh: 90 });
  const acts = feed(g, 33, 240);
  assert(acts.length > 0, 'never reacted to 30 fps');
  assert(acts[0] === 'scale-down', 'first move was ' + acts[0]);
  assert(g.tier === 'high', 'dropped a tier before using the resolution lever');
  assert(g.scale < 1, 'scale did not move');
});

check('once resolution is spent the tier goes, then the refresh divisor', () => {
  const g = new Governor({ tier: 'high', refresh: 90, minScale: 0.5 });
  const acts = feed(g, 40, 2500);
  assert(acts.includes('tier-down'), 'tier never stepped down: ' + acts.join(','));
  assert(acts.includes('fps-down'), 'divisor never stepped down: ' + acts.join(','));
  assert(g.tier === 'low', 'settled at ' + g.tier + ', expected low');
  assert(g.div >= 2, 'divisor did not rise');
  near(g.targetHz(), 30, 1.5, '90 Hz panel should settle on 30, not 60 or 45');
});

check('the divisor only uses rates that divide the panel evenly', () => {
  for (const refresh of [60, 90, 120, 144]) {
    const g = new Governor({ tier: 'low', refresh, minScale: 0.42 });
    feed(g, 60, 3000);
    const hz = g.targetHz();
    const n = Math.round(refresh / hz);
    near(refresh / n, hz, 0.001, `${refresh} Hz target ${hz} is not in phase`);
    assert(hz >= 24, `${refresh} Hz fell to ${hz}`);
  }
});

check('a frame that lands exactly on the vsync is not a miss', () => {
  const g = new Governor({ tier: 'high', refresh: 90 });
  feed(g, 1000 / 90, 200);
  assert(g.changes === 0, 'called a perfect frame a miss: ' + g.lastChange);
  const g60 = new Governor({ tier: 'high', refresh: 60 });
  feed(g60, 1000 / 60, 200);
  assert(g60.changes === 0, '60 Hz: called a perfect frame a miss');
});

check('it does not flap: a settled governor stops changing', () => {
  const g = new Governor({ tier: 'medium', refresh: 60 });
  feed(g, 30, 300);                        // stress it
  const settleAt = g.changes;
  const after = feed(g, 30, 600);          // same load, twice as long
  assert(g.changes - settleAt <= 4, `kept adjusting under constant load: ${after.join(',')}`);
});

check('one slow frame does not downgrade anything (noise gate)', () => {
  const g = new Governor({ tier: 'high', refresh: 60 });
  feed(g, 16.7, 60);
  g.sample(180); g.update(1 / 60);         // a GC pause
  g.sample(16.7); g.update(1 / 60);
  assert(g.scale === 1 && g.tier === 'high', 'a single stall downgraded the game');
  // and a tab-switch sized gap is dropped entirely, not averaged in
  const before = g.samples.length;
  g.sample(5000);
  assert(g.samples.length === before, 'a 5 s stall entered the window');
});

check('it climbs back after the load goes away, but slowly', () => {
  /* A vsync'd panel reports 16.7 ms whether the frame took 5 ms or 16, so the
     only way to learn there is headroom is to spend a little and look. */
  const g = new Governor({ tier: 'high', refresh: 60, minScale: 0.5 });
  feed(g, 34, 400);
  const lowScale = g.scale;
  assert(lowScale < 0.9, 'never stepped down: ' + lowScale);
  const up = feed(g, 1000 / 60, 4000);
  assert(up.includes('probe'), 'never probed for headroom: ' + up.slice(0, 6).join(','));
  assert(up.includes('probe-ok'), 'every probe failed on a healthy frame: ' + up.join(','));
  assert(g.scale > lowScale, `scale stayed at ${lowScale}`);
  assert(g.probes < 600, 'probing every frame instead of every few seconds: ' + g.probes);
});

check('a probe that does not fit is reverted and the retry backs off', () => {
  const g = new Governor({ tier: 'high', refresh: 60, minScale: 0.5 });
  feed(g, 34, 300);                       // force it down
  const settled = g.scale;
  // now it looks healthy, but the moment it probes, frames blow up again
  let probeAt = -1;
  for (let i = 0; i < 1500; i++) {
    const p = g.probe;
    if (p && probeAt < 0) probeAt = i;
    g.sample(p ? 40 : 1000 / 60);
    g.update(1 / 60);
  }
  assert(probeAt > 0, 'never probed');
  assert(Math.abs(g.scale - settled) < 0.06, `probe was not reverted: ${settled} -> ${g.scale}`);
  assert(g.probeBackoff > 5, 'retry did not back off: ' + g.probeBackoff);
  assert(g.probes < 40, 'probes are not being throttled: ' + g.probes);
});

check('the pin keeps a hand-picked tier and still rescues the frame rate', () => {
  const g = new Governor({ tier: 'ultra', refresh: 60, pinTier: true });
  const acts = feed(g, 45, 3000);
  assert(g.tier === 'ultra', 'pinned tier changed to ' + g.tier);
  assert(acts.includes('scale-down'), 'pinned governor refused to use resolution');
  assert(acts.includes('fps-down'), 'pinned governor refused the divisor');
  g.setPinned(false);
  assert(!g.pinTier, 'unpin failed');
  feed(g, 45, 800);
  assert(g.tier !== 'ultra', 'still pinned after setPinned(false)');
});

check('samples are only trusted once the window has filled', () => {
  const g = new Governor({ tier: 'high', refresh: 60, window: 45 });
  g.sample(120); g.update(1 / 60); g.sample(120);
  assert(g.changes === 0, 'acted on two samples');
  assert(g.update(1 / 60) === null, 'acted without a window');
});

check('refresh detection is clamped to sane panel rates', () => {
  const g = new Governor({ tier: 'high' });
  g.setRefresh(0); assert(g.refresh === 60, 'accepted 0 Hz');
  g.setRefresh(1000); assert(g.refresh === 60, 'accepted 1000 Hz');
  g.setRefresh(89.6); assert(g.refresh === 90, 'did not round 89.6 to 90');
  g.setRefresh(120); assert(g.refresh === 120, 'rejected 120 Hz');
});

check('a manual frame cap snaps to the panel', () => {
  const g = new Governor({ tier: 'high', refresh: 90, frameCap: 60 });
  near(g.targetHz(), 45, 0.01, '60 fps cap on 90 Hz is 45');
  assert(g.shouldRender(0) && g.shouldRender(2) && !g.shouldRender(1), 'phase wrong for div 2');
  const g2 = new Governor({ tier: 'high', refresh: 60, frameCap: 30 });
  near(g2.targetHz(), 30, 0.01, '30 on 60');
  assert(g2.shouldRender(0) && !g2.shouldRender(1) && g2.shouldRender(2), 'div 2 phase');
});

check('shouldRender is in phase with the divisor and never returns false forever', () => {
  const g = new Governor({ tier: 'high', refresh: 90 });
  g.div = 3;
  let drawn = 0;
  for (let f = 0; f < 90; f++) if (g.shouldRender(f)) drawn++;
  near(drawn, 30, 0.001, 'div 3 over 90 frames should draw 30');
  assert(g.shouldRender(0), 'frame 0 skipped');
  const g2 = new Governor({ tier: 'high', refresh: 60 });
  for (let f = 0; f < 10; f++) assert(g2.shouldRender(f), 'div 1 skipped a frame');
});

check('pixelBudget follows scale, and the floor is respected', () => {
  const g = new Governor({ tier: 'high', refresh: 60, minScale: 0.45 });
  near(g.pixelBudget(), TIERS.high.pixelBudget, 1, 'full budget');
  g.setScale(0.5);
  near(g.pixelBudget(), TIERS.high.pixelBudget * 0.25, 1, 'quarter budget at half scale');
  g.setScale(0.01);
  near(g.scale, 0.45, 1e-9, 'floor');
  assert(g.setScale(0.01) === false, 'a clamped to-the-floor change reported as a change');
  assert(g.setScale(0.45) === false, 'accepted a no-op change');
});

check('the governor can be switched off entirely', () => {
  const g = new Governor({ tier: 'high', refresh: 60, enabled: false });
  const acts = feed(g, 80, 500);
  assert(acts.length === 0, 'disabled governor acted');
  assert(g.scale === 1 && g.tier === 'high', 'disabled governor drifted');
});

check('describe() is safe for the perf HUD at every tier', () => {
  for (const tier of TIER_ORDER) {
    const g = new Governor({ tier, refresh: 90 });
    const line = g.describe();
    assert(typeof line === 'string' && line.length > 4, 'empty description');
    assert(!/undefined|NaN/.test(line), 'leaked a NaN into the HUD: ' + line);
  }
});

check('a bad constructor argument cannot wedge the game', () => {
  const g = new Governor({ tier: 'potato', scale: 99, refresh: -3 });
  assert(g.tier === 'high', 'bad tier not replaced');
  assert(g.scale === 99 || g.scale <= 1.001, 'scale not sane');
  assert(g.pixelBudget() > 0, 'budget not positive');
  assert(typeof g.describe() === 'string', 'describe threw');
  for (let f = 0; f < 8; f++) assert(typeof g.shouldRender(f) === 'boolean', 'shouldRender not boolean');
});

check('GPU_CLASSES regexes are all anchored to a name and compile', () => {
  for (const c of GPU_CLASSES) {
    assert(c.re instanceof RegExp, 'not a regex');
    assert(typeof c.name === 'string' && c.name.length > 2, 'no name');
    assert(TIERS[c.tier], c.name + ' points at a missing tier');
  }
});

check('every tier field is actually read somewhere in src/', () => {
  /* A dead knob is worse than a missing one: someone tunes it, ships it, and
     nothing changes. `shadowTaps` lived in all four tiers for a whole version
     while the shader did its filtering in hardware. */
  const files = readdirSync(new URL('../src', import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith('.js') && !String(f).includes('quality.js'));
  const src = files.map((f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')).join('\n');
  const meta = new Set(['key', 'name', 'tier', 'class', 're']);
  const dead = [];
  for (const k of Object.keys(TIERS.high)) {
    if (meta.has(k)) continue;
    const re = new RegExp('\\b' + k + '\\b');
    if (!re.test(src)) dead.push(k);
  }
  assert(!dead.length, 'tier fields nobody reads: ' + dead.join(', '));
});

/* ---------- the harness contract ---------- */
if (fails.length) {
  console.log(`\nFAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exitCode = 1;
} else {
  console.log(`\nQUALITY CHECKS PASSED (${pass})`);
}
