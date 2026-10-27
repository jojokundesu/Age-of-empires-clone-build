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
    this.enabled = opts.enabled !== false;
    this.wantMusic = opts.music !== false;
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.lastPlay = new Map();
    this.musicTimer = 0;
    this.musicStep = 0;
    this.ready = false;
    this.noiseBuffer = null;
  }

  /** Called from the first user gesture; mobile browsers require it. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 0.85 : 0, this.ctx.currentTime, 0.05);
    }
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

  /** Occasionally plucks a pentatonic note over the drone. */
  update(dt) {
    if (!this.ready || !this.musicOn) return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer = 6 + Math.random() * 6;
    const scale = [NOTE.C4, NOTE.D4, NOTE.E4, NOTE.G4, NOTE.A4, NOTE.C5];
    const f = scale[(Math.random() * scale.length) | 0] * 2;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    o.connect(g).connect(this.musicGain);
    o.start(t); o.stop(t + 2.7);
  }
}

export const NULL_AUDIO = {
  play() {}, unlock() {}, setEnabled() {}, setMusic() {}, setListener() {},
  startMusic() {}, stopMusic() {}, update() {}, resume() {}, suspend() {}
};

export const SOUND_NAMES = ['click', 'select', 'order', 'build', 'complete', 'chop', 'mine', 'farm',
  'arrow', 'hit', 'sword', 'death', 'boom', 'catapult', 'ageUp', 'train', 'warn', 'win', 'lose', 'coin',
  'horn', 'step', 'promotion'];
