/* ============================================================
   audio.js — procedural WebAudio soundscape
   No sample downloads: every effect is synthesised from
   oscillators and a shared noise buffer, so the APK stays tiny
   and there is nothing to stream on a 4G-less phone.
   ============================================================ */

const NOTE = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99 };

export class Audio {
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.ambientGain = null;
    this.enabled = opts.enabled !== false;
    /* `userMuted` is the player's own choice, distinct from Android's
       onPause() suspending the context. The native shell calls
       audio.suspend() and NEVER calls resume(), so a plain visibility or
       focus listener would unmute somebody who deliberately turned sound
       off. Only the system suspension is undone automatically. */
    this.userMuted = !this.enabled;
    this.wantMusic = opts.music !== false;
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.lastPlay = new Map();
    this.musicTimer = 0;
    this.musicStep = 0;
    this.ready = false;
    this.noiseBuffer = null;
    /* Dynamic score + ambience state. All of it advances in update(dt),
       which means no extra intervals, no timers firing in a suspended tab
       and nothing that can outlive the AudioContext. */
    this.mood = 'peace';             // 'peace' | 'war'
    this.moodMix = 0;                // eased 0..1 toward war
    this.environment = { forest: 0, water: 0, fire: 0, combat: 0 };
    this.ambientTimer = 0;
    this.warTimer = 0;
    this._installed = false;
    this.installLifecycle();
  }

  /* ---------------- Android WebView lifecycle ----------------
     MainActivity.onPause() suspends the AudioContext; onResume() does not
     resume it (and cannot be changed from JS). These listeners are the fix:
     any visible/focused/user-gesture event re-opens the context, but only
     when the player has not muted the game themselves.                    */
  installLifecycle() {
    if (this._installed || typeof window === 'undefined') return this;
    this._installed = true;
    const w = window;
    const doc = typeof document !== 'undefined' ? document : null;
    const retry = () => this.ensureRunning();
    this._lifecycle = [];
    const add = (target, type, fn, opts) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      try { target.addEventListener(type, fn, opts); this._lifecycle.push([target, type, fn, opts]); }
      catch (_) { /* some WebViews reject passive options */ }
    };
    add(doc, 'visibilitychange', () => { if (!doc.hidden) retry(); });
    add(w, 'focus', retry);
    add(w, 'pageshow', retry);
    add(doc, 'pageshow', retry);
    /* A passive first-touch listener must not call preventDefault: Chrome
       would then refuse to deliver the tap to the game at all. */
    add(w, 'pointerdown', retry, { passive: true });
    add(w, 'touchstart', retry, { passive: true });
    add(doc, 'pointerdown', retry, { passive: true });
    return this;
  }

  /** Explicit bridge API: window.__imperial.audio.resume(). */
  resume(force = false) { return this.ensureRunning(force); }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') {
      this._systemSuspended = true;
      this.ctx.suspend();
    }
  }
  /** Resume only a *system* suspension, never a user mute. */
  ensureRunning(force = false) {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state !== 'suspended') { this._systemSuspended = false; return true; }
    if ((this.userMuted || (typeof document !== 'undefined' && document.hidden)) && !force) return false;
    try {
      const p = ctx.resume();
      /* Some WebViews resolve resume() a frame late. One short retry is
         enough to survive the case where onResume() fired before the page
         was actually foregrounded. */
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (typeof setTimeout === 'function') setTimeout(() => {
        if (this.ctx === ctx && ctx.state === 'suspended' && !this.userMuted
          && (typeof document === 'undefined' || !document.hidden)) {
          try { const retry = ctx.resume(); retry?.catch?.(() => {}); } catch (_) { /* ignore */ }
        }
      }, 220);
      this._systemSuspended = false;
      return true;
    } catch (_) { return false; }
  }

  /** Called from the first user gesture; mobile browsers require it. */
  unlock() {
    if (this.ctx) {
      this.ensureRunning();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.85 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 22;
    comp.ratio.value = 3.4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.wantMusic ? 0.18 : 0;
    this.musicGain.connect(this.master);
    /* Ambient nature (birds, waves, crackling fire) has its own bus so a
       battle can duck the countryside without also ducking the UI cues. */
    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.34;
    this.ambientGain.connect(this.master);

    // one shared noise buffer (2 s of pink-ish noise)
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.032;
      b2 = 0.95 * b2 + w * 0.048;
      d[i] = (b0 + b1 + b2 + w * 0.12) * 0.55;
    }
    this.noiseBuffer = buf;
    this.ready = true;
    if (this.wantMusic) this.startMusic();
    /* The context may have been created while the app was backgrounded. */
    this.ensureRunning();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.userMuted = !this.enabled;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 0.85 : 0, this.ctx.currentTime, 0.05);
    }
    if (this.enabled) this.ensureRunning();
  }

  setMusic(on) {
    this.wantMusic = !!on;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(this.wantMusic ? 0.18 : 0, this.ctx.currentTime, 0.3);
    }
    if (this.wantMusic && this.ready) this.startMusic();
  }

  setListener(x, z, yaw = 0) {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  /* ---------------- primitives ---------------- */
  _env(node, t0, attack, decay, peak = 1) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }
  _tone(type, freq, t0, dur, gain = 0.25, detune = 0, dest = null) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    const g = ctx.createGain();
    this._env(g, t0, 0.008, dur, gain);
    o.connect(g).connect(dest || this.sfxGain);
    o.start(t0);
    o.stop(t0 + dur + 0.06);
    return o;
  }
  _noise(t0, dur, gain = 0.3, filterType = 'bandpass', freq = 900, q = 1.1, sweep = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t0);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t0, 0.005, dur, gain);
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    return { src, f, g };
  }

  /* ---------------- public ---------------- */
  play(name, opts = {}) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // rate-limit identical sounds so 40 units dying at once is not a wall of noise
    const now = ctx.currentTime;
    const gap = opts.gap ?? 0.03;
    const last = this.lastPlay.get(name) || -99;
    if (now - last < gap) return;
    this.lastPlay.set(name, now);

    let gain = opts.gain ?? 1;
    let pan = 0;
    if (opts.x !== undefined) {
      const dx = opts.x - this.listener.x, dz = opts.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      const att = 1 / (1 + d * 0.09);
      gain *= att;
      if (gain < 0.035) return;
      const c = Math.cos(this.listener.yaw), s = Math.sin(this.listener.yaw);
      pan = Math.max(-0.85, Math.min(0.85, (dx * c - dz * s) / (d + 4)));
    }
    const pitch = opts.pitch || 1;
    this._panned(name, now, gain, pan, pitch);
  }

  _panned(name, t, gain, pan, pitch) {
    const ctx = this.ctx;
    let dest = this.sfxGain;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.sfxGain);
      dest = p;
    }
    const g = gain;
    switch (name) {
      case 'click':
        this._tone('triangle', 700 * pitch, t, 0.045, 0.1 * g, 0, dest);
        break;
      case 'select':
        this._tone('triangle', 880, t, 0.06, 0.13 * g, 0, dest);
        this._tone('sine', 1320, t + 0.02, 0.07, 0.07 * g, 0, dest);
        break;
      case 'order':
        this._tone('sawtooth', 320, t, 0.09, 0.09 * g, 0, dest);
        this._tone('sine', 480, t + 0.03, 0.1, 0.06 * g, 0, dest);
        break;
      case 'build':
        this._noise(t, 0.16, 0.16 * g, 'bandpass', 420, 0.9);
        this._tone('sine', 150 * pitch, t, 0.12, 0.14 * g, 0, dest);
        break;
      case 'complete':
        this._tone('sine', NOTE.G4, t, 0.24, 0.16 * g, 0, dest);
        this._tone('sine', NOTE.C5, t + 0.09, 0.32, 0.13 * g, 0, dest);
        break;
      case 'chop':
        this._noise(t, 0.1, 0.22 * g, 'bandpass', 240 * pitch, 2.2);
        this._tone('sine', 120 * pitch, t, 0.09, 0.15 * g, 0, dest);
        break;
      case 'mine':
        this._noise(t, 0.08, 0.13 * g, 'highpass', 2600, 0.7);
        this._tone('square', 1100 * pitch, t, 0.05, 0.05 * g, 0, dest);
        break;
      case 'farm':
        this._noise(t, 0.14, 0.1 * g, 'lowpass', 900, 0.6);
        break;
      case 'arrow':
        this._noise(t, 0.18, 0.1 * g, 'bandpass', 2400, 3.5, 0.35);
        break;
      case 'hit':
        this._noise(t, 0.09, 0.2 * g, 'bandpass', 700 * pitch, 1.2);
        break;
      case 'sword':
        this._noise(t, 0.12, 0.24 * g, 'bandpass', 1800 * pitch, 2.6);
        this._tone('sawtooth', 260 * pitch, t + 0.01, 0.1, 0.09 * g, 0, dest);
        break;
      case 'death':
        this._tone('sawtooth', 190 * pitch, t, 0.22, 0.14 * g, -20, dest);
        this._noise(t, 0.2, 0.12 * g, 'lowpass', 700, 0.8);
        break;
      case 'boom':
        this._noise(t, 0.55, 0.42 * g, 'lowpass', 480, 0.7, 0.25);
        this._tone('sine', 62, t, 0.5, 0.34 * g, 0, dest);
        this._tone('sine', 96, t + 0.03, 0.3, 0.16 * g, 0, dest);
        break;
      case 'catapult':
        this._noise(t, 0.3, 0.22 * g, 'bandpass', 300, 1.2, 2.2);
        break;
      case 'ageUp': {
        const notes = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5];
        notes.forEach((f, i) => this._tone('sine', f, t + i * 0.13, 0.7, 0.13 * g, 0, dest));
        break;
      }
      case 'train':
        this._tone('triangle', 520 * pitch, t, 0.07, 0.1 * g, 0, dest);
        this._tone('triangle', 660 * pitch, t + 0.05, 0.1, 0.08 * g, 0, dest);
        break;
      /* a boot on packed earth; quiet, short, and only ever heard in person */
      case 'step':
        this._noise(t, 0.055, 0.07 * g, 'lowpass', 420 * pitch, 0.9);
        break;
      /* a Champion's rank: four rising notes and a low horn under them */
      case 'promotion': {
        [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5].forEach((f, i) => this._tone('triangle', f, t + i * 0.11, 0.5, 0.12 * g, 0, dest));
        this._tone('sawtooth', NOTE.C3, t, 0.7, 0.10 * g, 0, dest);
        break;
      }
      case 'warn':
        this._tone('square', 220, t, 0.16, 0.07 * g, 0, dest);
        this._tone('square', 208, t + 0.16, 0.2, 0.06 * g, 0, dest);
        break;
      case 'win': {
        const seq = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.G5];
        seq.forEach((f, i) => this._tone('triangle', f, t + i * 0.16, 0.6, 0.14 * g, 0, dest));
        break;
      }
      case 'lose':
        [NOTE.A4, NOTE.F4, NOTE.D4, NOTE.C4].forEach((f, i) => this._tone('sine', f, t + i * 0.22, 0.7, 0.14 * g, 0, dest));
        break;
      case 'coin':
        this._tone('square', 1400, t, 0.05, 0.06 * g, 0, dest);
        this._tone('square', 1900, t + 0.04, 0.07, 0.05 * g, 0, dest);
        break;
      /* ---------------- AoE4-style feedback ----------------
         Selection cues are per unit class, drop-offs are per resource and the
         landscape has its own quiet layer. All of them go through the same
         envelope primitives, so the strict audio test exercises each one. */
      case 'scoutHorn':
        this._tone('sawtooth', 196 * pitch, t, 0.28, 0.11 * g, 0, dest);
        this._tone('sawtooth', 294 * pitch, t + 0.12, 0.36, 0.09 * g, 0, dest);
        break;
      case 'shieldBash':
        this._noise(t, 0.11, 0.18 * g, 'bandpass', 520, 1.1);
        this._tone('triangle', 150 * pitch, t, 0.1, 0.1 * g, 0, dest);
        break;
      case 'horseWhinny':
        this._tone('sawtooth', 620 * pitch, t, 0.12, 0.07 * g, 30, dest);
        this._tone('sawtooth', 460 * pitch, t + 0.11, 0.2, 0.08 * g, -28, dest);
        this._noise(t + 0.02, 0.14, 0.08 * g, 'bandpass', 1700, 1.8, 0.55);
        break;
      case 'shipBell':
        this._tone('sine', 880 * pitch, t, 0.34, 0.10 * g, 0, dest);
        this._tone('sine', 1320 * pitch, t + 0.015, 0.26, 0.055 * g, 0, dest);
        break;
      case 'elephantTrumpet':
        this._tone('sawtooth', 150 * pitch, t, 0.34, 0.11 * g, 0, dest);
        this._tone('sawtooth', 260 * pitch, t + 0.16, 0.4, 0.09 * g, 18, dest);
        this._noise(t, 0.3, 0.07 * g, 'bandpass', 780, 1.1, 1.6);
        break;
      case 'dropGold':
        this._tone('square', 1420 * pitch, t, 0.06, 0.07 * g, 0, dest);
        this._tone('square', 1900 * pitch, t + 0.045, 0.09, 0.05 * g, 0, dest);
        this._tone('sine', 2600 * pitch, t + 0.09, 0.12, 0.035 * g, 0, dest);
        break;
      case 'dropWood':
        this._noise(t, 0.11, 0.17 * g, 'lowpass', 340, 0.9);
        this._tone('sine', 112 * pitch, t, 0.14, 0.13 * g, 0, dest);
        break;
      case 'dropFood':
        this._noise(t, 0.24, 0.11 * g, 'bandpass', 3100, 0.7, 0.55);
        this._tone('triangle', 720 * pitch, t + 0.06, 0.12, 0.045 * g, 0, dest);
        break;
      case 'dropStone':
        this._noise(t, 0.09, 0.15 * g, 'highpass', 2100, 0.8);
        this._tone('triangle', 330 * pitch, t, 0.09, 0.08 * g, 0, dest);
        break;
      case 'fanfare':
        [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.E4, NOTE.G4].forEach((f, i) => {
          this._tone('sawtooth', f * 0.5 * pitch, t + i * 0.115, 0.44, 0.09 * g, 0, dest);
          this._tone('sine', f * pitch, t + i * 0.115, 0.32, 0.045 * g, 0, dest);
        });
        this._noise(t, 0.5, 0.07 * g, 'bandpass', 2400, 0.8, 0.4);
        break;
      case 'splash':
        this._noise(t, 0.28, 0.18 * g, 'bandpass', 1250, 0.7, 0.28);
        this._tone('sine', 220 * pitch, t, 0.14, 0.055 * g, 0, dest);
        break;
      case 'gull':
        this._tone('triangle', 1180 * pitch, t, 0.1, 0.045 * g, 25, dest);
        this._tone('triangle', 860 * pitch, t + 0.13, 0.14, 0.04 * g, -20, dest);
        break;
      case 'waterLap':
        this._noise(t, 0.9, 0.08 * g, 'lowpass', 460, 0.6, 0.6);
        break;
      case 'birds':
        this._tone('sine', 2100 * pitch, t, 0.06, 0.035 * g, 40, dest);
        this._tone('sine', 2650 * pitch, t + 0.08, 0.05, 0.03 * g, -30, dest);
        break;
      case 'fireCrackle':
        this._noise(t, 0.16, 0.09 * g, 'highpass', 2900, 0.9);
        break;
      case 'warDrums':
        this._tone('sine', 82 * pitch, t, 0.28, 0.16 * g, 0, dest);
        this._noise(t, 0.1, 0.09 * g, 'lowpass', 210, 0.7);
        break;
      case 'brass':
        this._tone('sawtooth', NOTE.G4 * 0.5 * pitch, t, 0.5, 0.09 * g, 0, dest);
        this._tone('sine', NOTE.C5 * pitch, t + 0.06, 0.42, 0.05 * g, 0, dest);
        break;
      case 'lute':
        this._tone('triangle', NOTE.D4 * 2 * pitch, t, 0.5, 0.06 * g, 0, dest);
        this._tone('sine', NOTE.A4 * 2 * pitch, t + 0.03, 0.4, 0.035 * g, 0, dest);
        break;
      case 'flute':
        this._tone('sine', NOTE.G5 * pitch, t, 0.6, 0.055 * g, 0, dest);
        this._noise(t, 0.22, 0.018 * g, 'bandpass', 2400, 1.4);
        break;
      case 'camouflage':
        this._tone('sine', 980 * pitch, t, 0.16, 0.055 * g, 0, dest);
        this._tone('sine', 660 * pitch, t + 0.1, 0.22, 0.045 * g, 0, dest);
        break;
      case 'highGround':
        this._tone('triangle', 740 * pitch, t, 0.12, 0.06 * g, 0, dest);
        this._tone('triangle', 1108 * pitch, t + 0.09, 0.22, 0.055 * g, 0, dest);
        break;
      case 'sacred':
        [NOTE.C4, NOTE.G4, NOTE.C5, NOTE.E5 || NOTE.E4 * 2].forEach((f, i) =>
          this._tone('sine', f * pitch, t + i * 0.17, 0.8, 0.055 * g, 0, dest));
        break;
      case 'trade':
        this._tone('square', 1320 * pitch, t, 0.07, 0.05 * g, 0, dest);
        this._tone('square', 1760 * pitch, t + 0.08, 0.12, 0.045 * g, 0, dest);
        break;
      case 'collapse':
        this._noise(t, 0.75, 0.3 * g, 'lowpass', 520, 0.7, 0.22);
        this._tone('sine', 58 * pitch, t, 0.6, 0.22 * g, 0, dest);
        break;
      case 'horn': {
        for (const [f, d] of [[NOTE.C4, 0], [NOTE.G4, 0.22], [NOTE.E4, 0.42]]) {
          const ctx2 = this.ctx;
          const o = ctx2.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f * 0.5, t + d);
          o.frequency.linearRampToValueAtTime(f, t + d + 0.12);
          const filt = ctx2.createBiquadFilter();
          filt.type = 'lowpass';
          filt.frequency.value = 1200;
          const g2 = ctx2.createGain();
          this._env(g2, t + d, 0.1, 0.5, 0.12 * g);
          o.connect(filt).connect(g2).connect(dest);
          o.start(t + d); o.stop(t + d + 0.7);
        }
        break;
      }
      default:
        this._tone('sine', 440 * pitch, t, 0.06, 0.08 * g, 0, dest);
    }
  }

  /* ---------------- rich soundscape ---------------- */

  /** The voice a unit answers with when the player selects it. */
  playSelectionFor(unit) {
    if (!unit) return this.play('select');
    const d = unit.def || {};
    const cls = d.classes || [];
    if (d.naval || cls.includes('ship')) return this.play('shipBell', { x: unit.x, z: unit.z });
    if (unit.type === 'war_elephant' || unit.type === 'tower_elephant') return this.play('elephantTrumpet', { x: unit.x, z: unit.z });
    if (cls.includes('cavalry')) return this.play('horseWhinny', { x: unit.x, z: unit.z });
    if (unit.type === 'scout_cavalry' || d.scout) return this.play('scoutHorn', { x: unit.x, z: unit.z });
    if (cls.includes('infantry') || cls.includes('unique')) return this.play('shieldBash', { x: unit.x, z: unit.z });
    if (cls.includes('archer')) return this.play('arrow', { x: unit.x, z: unit.z });
    return this.play('select', { x: unit.x, z: unit.z });
  }

  /** A satisfying chime at the drop-off, one timbre per resource. */
  playDropoff(kind, x, z) {
    const names = { gold: 'dropGold', wood: 'dropWood', food: 'dropFood', stone: 'dropStone' };
    return this.play(names[kind] || 'coin', x === undefined ? {} : { x, z });
  }

  /** 'peace' = lute/flute, 'war' = war drums and brass. Crossfaded. */
  setMood(mood) {
    if (mood === 'war' || mood === 'peace') this.mood = mood;
    return this.mood;
  }
  /** Called by the app with measured proximity to forest/water/fire and the
      number of recent combat events. Values are 0..1. */
  setEnvironment(env = {}) {
    const e = this.environment;
    for (const k of ['forest', 'water', 'fire', 'combat']) {
      if (Number.isFinite(env[k])) e[k] = Math.max(0, Math.min(1, env[k]));
    }
    if (e.combat > 0.24) this.mood = 'war';
    return e;
  }
  noteCombat(strength = 1) {
    this.environment.combat = Math.min(1, this.environment.combat + 0.35 * strength);
    this.mood = 'war';
  }

  /** Ambient nature: birds in forests, lapping water near rivers/seas,
      crackling fire near damaged buildings. Scheduled in update(dt), so a
      suspended context never leaks a timer into the background. */
  updateAmbience(dt) {
    if (!this.ready || !this.musicOn || this.ctx.state !== 'running') return;
    const e = this.environment;
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 1.1 + Math.random() * 1.4;
    const r = Math.random();
    const t = this.ctx.currentTime;
    const amb = this.ambientGain || this.musicGain;
    if (r < e.forest * 0.55) {
      // a two-note birdsong, detuned so a forest never sounds like one bird
      this._tone('sine', 1900 + Math.random() * 700, t, 0.07, 0.03, 0, amb);
      this._tone('sine', 2400 + Math.random() * 500, t + 0.1, 0.06, 0.024, 0, amb);
    } else if (r < e.forest * 0.55 + e.water * 0.5) {
      this._noise(t, 0.85, 0.045, 'lowpass', 420, 0.6, 0.65);
      if (Math.random() < 0.18) this._tone('triangle', 1100, t + 0.2, 0.1, 0.018, 0, amb);
    } else if (r < e.forest * 0.55 + e.water * 0.5 + e.fire * 0.6) {
      this._noise(t, 0.14, 0.05, 'highpass', 2800, 0.8);
    }
    e.combat *= 0.86;                 // combat intensity decays toward calm
    if (e.combat < 0.08 && this.mood === 'war') this.mood = 'peace';
  }

  /** One step of the dynamic medieval score. Peacetime plucks a lute or a
      flute over the drone; war adds a drum pulse and a brass answer. */
  _musicStep() {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain) return;
    const t = ctx.currentTime;
    this.musicStep++;
    const war = this.mood === 'war';
    if (war) {
      this._tone('sine', 78, t, 0.3, 0.12, 0, this.musicGain);
      this._noise(t, 0.09, 0.055, 'lowpass', 220, 0.7);
      if (this.musicStep % 2 === 0) {
        const f = [NOTE.C4, NOTE.E4, NOTE.G4][(this.musicStep / 2) % 3] * 0.5;
        this._tone('sawtooth', f, t, 0.52, 0.075, 0, this.musicGain);
      }
    } else {
      const scale = [NOTE.C4, NOTE.D4, NOTE.E4, NOTE.G4, NOTE.A4, NOTE.C5];
      const f = scale[(Math.random() * scale.length) | 0] * 2;
      if (this.musicStep % 3 === 0) {
        this._tone('sine', f * 1.5, t, 0.85, 0.045, 0, this.musicGain); // flute
      } else {
        this._tone('triangle', f, t, 0.62, 0.06, 0, this.musicGain);     // lute
        this._tone('sine', f * 2, t + 0.02, 0.3, 0.022, 0, this.musicGain);
      }
    }
  }

  /* ---------------- ambient music ---------------- */
  startMusic() {
    if (!this.ready || !this.wantMusic || this.musicOn) return;
    this.musicOn = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // two slowly detuned drones through a wandering low-pass
    this.drones = [];
    const base = [NOTE.C4 / 2, NOTE.G4 / 2, NOTE.C4 / 4];
    base.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'triangle';
      o.frequency.value = f * (1 + (i - 1) * 0.0016);
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.28 : 0.16;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 620;
      o.connect(filt).connect(g).connect(this.musicGain);
      o.start(t);
      this.drones.push({ o, g, filt });
    });
    // slow filter breathing
    this.musicLfo = setInterval(() => {
      if (!this.ctx || !this.musicOn) return;
      const now = this.ctx.currentTime;
      for (const d of this.drones) {
        d.filt.frequency.setTargetAtTime(420 + Math.random() * 520, now, 3.5);
      }
    }, 6500);
    this.musicTimer = 0;
  }

  stopMusic() {
    this.musicOn = false;
    if (this.musicLfo) { clearInterval(this.musicLfo); this.musicLfo = null; }
    if (this.drones) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const d of this.drones) {
        try { d.g.gain.setTargetAtTime(0.0001, now, 0.4); d.o.stop(now + 1.4); } catch (e) { /* already stopped */ }
      }
      this.drones = null;
    }
  }

  /** Advance the score and the landscape. The drone itself is continuous;
      only the melody, the war layer and the nature layer are step-driven, so
      a suspended tab costs nothing and a battle changes the music within a
      bar instead of waiting for the next 6-second pluck. */
  update(dt) {
    if (!this.ready || !this.musicOn || !this.ctx) return;
    if (this.ctx.state !== 'running') { this.ensureRunning(); return; }
    this.moodMix += ((this.mood === 'war' ? 1 : 0) - this.moodMix) * Math.min(1, dt * 0.7);
    this.updateAmbience(dt);
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer = this.mood === 'war' ? 0.62 + Math.random() * 0.35 : 2.6 + Math.random() * 2.4;
    this._musicStep();
  }
}

export const NULL_AUDIO = {
  play() {}, unlock() {}, setEnabled() {}, setMusic() {}, setListener() {},
  startMusic() {}, stopMusic() {}, update() {}, resume() {}, suspend() {},
  installLifecycle() {}, ensureRunning() {}, playSelectionFor() {}, playDropoff() {},
  setMood() {}, setEnvironment() {}, noteCombat() {}, updateAmbience() {}
};

export const SOUND_NAMES = ['click', 'select', 'order', 'build', 'complete', 'chop', 'mine', 'farm',
  'arrow', 'hit', 'sword', 'death', 'boom', 'catapult', 'ageUp', 'train', 'warn', 'win', 'lose', 'coin',
  'horn', 'step', 'promotion',
  /* AoE4 feedback: selection voices, drop-off chimes, landmarks, nature,
     the war score, stealth / elevation / naval cues. */
  'scoutHorn', 'shieldBash', 'horseWhinny', 'shipBell', 'elephantTrumpet',
  'dropGold', 'dropWood', 'dropFood', 'dropStone', 'fanfare',
  'splash', 'gull', 'waterLap', 'birds', 'fireCrackle', 'warDrums', 'brass', 'lute', 'flute',
  'camouflage', 'highGround', 'sacred', 'trade', 'collapse'];
