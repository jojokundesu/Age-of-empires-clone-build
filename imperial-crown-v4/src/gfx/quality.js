/* ============================================================
   quality.js — the quality ladder and the frame governor

   The one hard fact about this game's target device: it is a 1080p 90 Hz
   phone with an Adreno 610, and a WebGL scene at 1080p costs roughly 2.6
   megapixels *per pass*. v2 treated quality as "resolution multiplier ×
   devicePixelRatio", which on a DPR-3 phone quietly asked for 2.6 Mpx of
   shading and then spent another full-screen pass on top of it. That is why
   it ran at 20 fps no matter what was on screen.

   v4 models the budget in what actually costs money on a mobile GPU:

     · `pixelBudget` — the number of pixels in the render target. Every
       expensive thing in this renderer is per-pixel, so this one number is
       the whole performance dial. All four tiers are explicit budgets, not
       multipliers, and the device pixel ratio cannot silently inflate them.
     · `shadowHz` / `shadowSize` — the depth pass is the second cost.
     · The shadow sampler is COMPARE_REF_TO_TEXTURE with LINEAR filtering, so
       one fetch already resolves a 2x2 block. There is deliberately no tap
       count in the tier: more taps would be a second fetch per pixel on a
       device whose frame is entirely fill-rate bound.
     · `clouds` — whether the model shader pays for a cloud-shadow fetch.
     · `detail` — the strength of the near-field ground detail fetch.

   `Governor` then holds a frame-time target and walks the levers in order of
   least visible change: resolution first, then the tier, then the refresh
   divisor (90 → 45 → 30 fps, which are the only rates a 90 Hz panel can show
   evenly). It only ever spends headroom after a long stable period, so the
   picture cannot flap between two settings.

   Everything here is pure logic: no DOM, no WebGL, no globals. That is what
   makes it testable in Node, which it is (tests/quality.test.mjs).
   ============================================================ */

export const TIERS = {
  low: {
    key: 'low', name: 'Low',
    pixelBudget: 0.46e6,        // ~900×510 — still sharper than a PSP
    shadowSize: 512, shadows: true, shadowHz: 20,
    clouds: 0, detail: 0.35, water: true, foliage: 0.45,
    unitCull: 82, buildingCull: 150, propDistance: 96,
    particleCap: 220, post: false, sharpen: 0, maxDpr: 1.5
  },
  medium: {
    key: 'medium', name: 'Balanced',
    pixelBudget: 0.82e6,        // ~1210×680
    shadowSize: 1024, shadows: true, shadowHz: 30,
    clouds: 0.05, detail: 0.7, water: true, foliage: 0.75,
    unitCull: 96, buildingCull: 178, propDistance: 124,
    particleCap: 380, post: false, sharpen: 0, maxDpr: 2.0
  },
  high: {
    key: 'high', name: 'High',
    pixelBudget: 1.28e6,        // ~1510×850
    shadowSize: 1536, shadows: true, shadowHz: 30,
    clouds: 0.085, detail: 1.0, water: true, foliage: 1.0,
    unitCull: 118, buildingCull: 214, propDistance: 152,
    particleCap: 560, post: true, sharpen: 0.18, maxDpr: 3.0
  },
  ultra: {
    key: 'ultra', name: 'Ultra',
    pixelBudget: 2.05e6,        // ~1910×1075
    shadowSize: 2048, shadows: true, shadowHz: 30,
    clouds: 0.10, detail: 1.0, water: true, foliage: 1.0,
    unitCull: 140, buildingCull: 250, propDistance: 180,
    particleCap: 760, post: true, sharpen: 0.22, maxDpr: 3.0
  }
};

export const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];

/* ------------------------------------------------------------------
   Device sniffing. Deliberately conservative: the names below are the
   GPUs in phones this project targets. An unknown GPU gets `medium`,
   because a wrong guess costs a stutter and the governor will recover
   from "too low" in a few seconds but a stutter is what people remember.
   ------------------------------------------------------------------ */
export const GPU_CLASSES = [
  { re: /adreno \(tm\) 610|adreno 610/i, name: 'Adreno 610', class: 'low', tier: 'medium' },
  { re: /adreno \(tm\) 61[0-9]|adreno 61[0-9]/i, name: 'Adreno 610 series', class: 'low', tier: 'medium' },
  { re: /mali-g52|mali-g51|mali-g31|powervr ge8320|powervr ge8322/i, name: 'Mali-G52 class', class: 'low', tier: 'medium' },
  { re: /adreno \(tm\) 62[0-9]|adreno 62[0-9]|mali-g57|mali-g68/i, name: 'Adreno 62x / Mali-G5x', class: 'mid', tier: 'high' },
  { re: /adreno \(tm\) 6[45][0-9]|adreno 6[45][0-9]|mali-g7[0-9]|apple a1[0-9]/i, name: 'Adreno 64x / Mali-G7x', class: 'high', tier: 'high' },
  { re: /apple m|adreno \(tm\) 7[0-9][0-9]|adreno 7[0-9][0-9]|nvidia|geforce|rtx|radeon|intel.*iris|intel.*arc/i, name: 'Desktop GPU', class: 'desktop', tier: 'ultra' }
];

export function classifyGPU(rendererString) {
  const s = String(rendererString || '');
  for (const g of GPU_CLASSES) {
    if (g.re.test(s)) return { ...g };
  }
  return { re: null, name: s || 'unknown GPU', class: 'unknown', tier: 'medium' };
}

/** A starting tier from what the browser will tell us about the device. */
export function pickInitialTier(env = {}) {
  const gpu = classifyGPU(env.renderer);
  const cores = env.cores || 4;
  const mem = env.mem || 4;
  const mobile = env.mobile !== undefined ? env.mobile : /android|iphone|ipad|mobile/i.test(env.ua || '');
  let tier = gpu.tier;
  if (env.savedTier && TIERS[env.savedTier]) tier = env.savedTier;
  if (mobile && gpu.class === 'unknown') tier = 'low';
  if (cores <= 4 && mobile && tier === 'ultra') tier = 'high';
  if (mem <= 3 && tier === 'high') tier = 'medium';
  return { tier, gpu, mobile };
}

/* ------------------------------------------------------------------
   The governor. Feed it one number per *rendered* frame: the interval
   between two rendered frames in milliseconds. It owns:

     scale  0.42 .. 1.0   multiplier on the tier's pixel budget
     tier   low..ultra    the feature set
     div    1,2,3         render every Nth display refresh

   and it never changes more than one lever per step, with cooldowns, so
   the picture settles instead of flapping.
   ------------------------------------------------------------------ */
export class Governor {
  constructor(opts = {}) {
    this.tiers = TIER_ORDER;
    this.tier = TIERS[opts.tier] ? opts.tier : 'high';
    this.minScale = opts.minScale || 0.45;
    this.scale = Math.min(1, Math.max(this.minScale, opts.scale || 1));
    this.refresh = opts.refresh || 60;
    this.div = 1;
    this.maxDiv = opts.maxDiv || 3;
    this.frameCap = opts.frameCap || 'auto';   // 'auto' | 90 | 60 | 45 | 30
    this.enabled = opts.enabled !== false;
    /* A tier the player picked by hand is a promise about *looks*, so the
       governor may still spend resolution and the refresh divisor to keep the
       frame rate, but must never quietly swap the art under them. */
    this.pinTier = !!opts.pinTier;
    this.samples = [];
    this.window = opts.window || 45;
    this.cooldown = 0;
    this.lastChange = 'start';
    this.stable = 0;        // consecutive healthy render frames
    this.med = 16.7;
    this.p90 = 16.7;
    this.changes = 0;       // adjustments that make the frame cheaper
    this.probes = 0;        // attempts to spend headroom again
    this.probe = null;      // the state a live probe would revert to
    this.probeTimer = 0;
    this.probeBackoff = opts.probeBackoff || 4;   // seconds between probes
    this.probeMax = opts.probeMax || 45;
  }

  /** Display refresh detected from rAF timings (main.js feeds it once). */
  setRefresh(hz) {
    if (!(hz > 20 && hz < 260)) return;
    const r = Math.round(hz);
    if (Math.abs(r - this.refresh) < 2) { this.refresh = r; return; }
    this.refresh = r;
    this.samples.length = 0;
    if (this.frameCap === 'auto') this.div = Math.min(this.maxDiv, this.div);
  }

  /** The render rate this governor is aiming at, in Hz. */
  targetHz() {
    if (this.frameCap !== 'auto') {
      const want = Number(this.frameCap) || 60;
      // only rates that divide the panel evenly; a "60" cap on 90 Hz is 45
      const n = Math.max(1, Math.round(this.refresh / want));
      return this.refresh / n;
    }
    return this.refresh / this.div;
  }

  targetMs() { return 1000 / this.targetHz(); }

  /** Frame interval that means "we missed a vsync and must get cheaper".
   *
   *  A vsync'd panel quantises the interval: a 90 Hz phone under load reports
   *  22.2 ms, not 13. A frame that misses its vsync is therefore *at least*
   *  one whole refresh late, so the threshold has to sit between one refresh
   *  and two -- 1.15x -- or a perfect frame landing exactly on the vsync
   *  (11.11 ms against an 11.11 ms target) reads as a miss because of
   *  rounding, and the game downgrades itself for doing nothing wrong. */
  missMs() { return this.targetMs() * 1.15; }

  budgetMs() { return this.missMs(); }

  tierObj() { return TIERS[this.tier]; }

  /** Pixels this governor wants right now. */
  pixelBudget() { return Math.round(this.tierObj().pixelBudget * this.scale * this.scale); }

  /** Should this display frame be rendered? */
  shouldRender(frameIndex) {
    if (this.frameCap !== 'auto') {
      const n = Math.max(1, Math.round(this.refresh / this.targetHz()));
      return frameIndex % n === 0;
    }
    return frameIndex % Math.max(1, this.div) === 0;
  }

  /* ---------- the three levers ---------- */
  setTier(name, { keepScale = false } = {}) {
    if (!TIERS[name]) return false;
    if (name === this.tier && keepScale) return false;
    this.tier = name;
    /* A tier *down* must not hand the resolution back: we are stepping down
       because we are late, and quadrupling the pixel count at the same moment
       is how a governor turns a dip into a stutter loop. Only a deliberate
       tier choice (the settings panel) resets the scale. */
    if (!keepScale) this.scale = Math.max(this.scale, 0.85);
    this.samples.length = 0;
    this.stable = 0;
    this.probeTimer = 0;
    this.changes++;
    this.lastChange = 'tier:' + name;
    return true;
  }

  setScale(s) {
    const v = Math.min(1, Math.max(this.minScale, s));
    if (Math.abs(v - this.scale) < 1e-3) return false;
    this.scale = v;
    this.samples.length = 0;
    this.stable = 0;
    this.changes++;
    this.lastChange = 'scale';
    return true;
  }

  setPinned(v) {
    this.pinTier = !!v;
    this.samples.length = 0;
    this.stable = 0;
    this.probeTimer = 0;
  }

  /* ---------- measurement ---------- */
  /** Feed one rendered-frame interval in milliseconds. */
  sample(ms) {
    if (!(ms > 0)) return;
    // Long stalls (tab switch, a GC pause, a texture upload, the boot hitch)
    // are not a performance signal -- they are noise. Keeping them out of the
    // median is what stops one bad frame from repainting the whole town at a
    // lower resolution.
    if (ms > 400) return;
    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
    this.lastMs = ms;
  }

  _stats() {
    const sorted = this.samples.slice().sort((a, b) => a - b);
    this.med = sorted[sorted.length >> 1];
    this.p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  }

  /** Called once per display frame; returns an action string or null. */
  update(dt = 0) {
    if (!this.enabled) return null;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const enough = this.samples.length >= Math.min(24, this.window);
    if (enough) this._stats();
    const late = enough && this.med > this.missMs();

    /* ---- a live probe is judged on the frames it created ---- */
    if (this.probe) {
      const p = this.probe;
      p.age += dt;
      if (p.age < 0.6 || this.samples.length < 8) return null;
      this.probe = null;
      if (this.med > this.missMs() * 1.02) {
        /* it did not fit: go back, and wait twice as long before trying again.
           The backoff is what stops the "sharper, slower, sharper" flicker
           that reads as a broken game even at 50 fps. */
        this.probeBackoff = Math.min(this.probeMax, Math.max(5, this.probeBackoff * 2));
        this.probeTimer = 0;
        this.cooldown = 2.5;
        this.stable = 0;
        this._apply(p);
        this.lastChange = 'probe-revert';
        return 'probe-revert';
      }
      this.probeBackoff = Math.max(2.5, this.probeBackoff * 0.7);
      this.probeTimer = 0;
      this.stable = Math.max(this.stable, 40);
      this.lastChange = 'probe-ok';
      return 'probe-ok';
    }

    if (!enough) return null;

    /* ---- too slow: resolution, then tier, then the refresh divisor ---- */
    if (late) {
      this.stable = 0;
      this.probeTimer = 0;
      if (this.cooldown > 0) return null;
      if (this.scale > this.minScale + 1e-3) {
        this.setScale(Math.max(this.minScale, this.scale - 0.07));
        this.cooldown = 0.9;
        return 'scale-down';
      }
      const idx = this.tiers.indexOf(this.tier);
      if (idx > 0 && !this.pinTier) {
        this.setTier(this.tiers[idx - 1], { keepScale: true });
        this.cooldown = 4.5;
        return 'tier-down';
      }
      if (this.div < this.maxDiv && this.refresh / (this.div + 1) >= 24) {
        this.div++;
        this.samples.length = 0;
        this.cooldown = 4.5;
        this.changes++;
        this.lastChange = 'fps:' + Math.round(this.targetHz());
        return 'fps-down';
      }
      // nothing left: keep the cheapest settings and stop churning
      this.cooldown = 10;
      return null;
    }

    /* ---- healthy. On a vsync'd panel a locked frame reports the same
       interval whether it took 4 ms or 16, so interval alone cannot tell us
       there is headroom. Probe for it: spend one small step up, watch half a
       second, keep it if it holds. ---- */
    this.stable++;
    if (this.cooldown > 0) return null;
    this.probeTimer += dt;
    if (this.stable < 45 || this.probeTimer < this.probeBackoff) return null;

    const before = { scale: this.scale, div: this.div, tier: this.tier };
    let target = null;
    if (this.scale < 1 - 1e-3) target = { scale: Math.min(1, this.scale + 0.05) };
    else if (this.div > 1) target = { div: this.div - 1 };
    else {
      const idx = this.tiers.indexOf(this.tier);
      if (idx < this.tiers.length - 1 && !this.pinTier && this.stable > 900) {
        target = { tier: this.tiers[idx + 1] };
      }
    }
    if (!target) { this.probeTimer = 0; return null; }

    this.probes++;
    this.probe = { ...before, age: 0 };
    this._apply(target);
    this.samples.length = 0;
    this.lastChange = 'probe';
    return 'probe';
  }

  _apply(st) {
    if (st.tier !== undefined) {
      this.tier = st.tier;
      this.changes++;              // a tier swap rebuilds the shadow map
    }
    if (st.scale !== undefined) this.scale = Math.min(1, Math.max(this.minScale, st.scale));
    if (st.div !== undefined) this.div = Math.min(this.maxDiv, Math.max(1, st.div));
  }

  /** A one-line description for the perf HUD. */
  describe() {
    const hz = Math.round(this.targetHz());
    return `${this.tierObj().name} · ${hz} fps · ${Math.round(this.scale * 100)}%`;
  }
}

/**
 * Compute the render target size for a pixel budget.
 * Never upscales past the native pixel count (a 1080p panel does not need a
 * 4 Mpx buffer) and never drops below half the CSS resolution (below that the
 * HUD would look sharper than the world, which reads as a bug).
 */
export function renderSize(cssW, cssH, budgetPx, dpr, maxDpr = 3) {
  const w0 = Math.max(2, cssW), h0 = Math.max(2, cssH);
  const native = Math.min(dpr, maxDpr);
  const maxPx = w0 * h0 * native * native;
  const px = Math.min(budgetPx, maxPx);
  const aspect = w0 / h0;
  let h = Math.round(Math.sqrt(px / aspect));
  let w = Math.round(h * aspect);
  const minW = Math.round(w0 * 0.55), minH = Math.round(h0 * 0.55);
  if (w < minW) { w = minW; h = Math.round(w / aspect); }
  if (h < minH) { h = minH; w = Math.round(h * aspect); }
  return { w: Math.max(2, w), h: Math.max(2, h) };
}
