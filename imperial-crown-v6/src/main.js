/* ============================================================
   main.js — application shell
   Boots the renderer, owns the match lifecycle, drives the fixed
   timestep simulation and keeps the frame budget honest on a phone.
   ============================================================ */
import { Renderer, QUALITY } from './gfx/renderer.js';
import { Camera } from './gfx/camera.js';
import { FX } from './gfx/fx.js';
import { generateWorld } from './sim/worldgen.js';
import { Game } from './sim/game.js';
import { AIController } from './sim/ai.js';
import { Audio } from './game/audio.js';
import { Menu } from './game/menu.js';
import { Input } from './game/input.js';
import { UI } from './game/ui.js';
import { DirectControl } from './game/direct-control.js';
import { Building, STATE } from './sim/entities.js';
import { saveModState, restoreModState } from './mods/save-state.js';
import { AGES, CIVS, DIFFICULTY, GAME_MODES, BUILDING_DEFS, UNIT_DEFS, VICTORIES } from './sim/data.js';
import { clamp } from './core/math.js';
import { RANKS, MAX_RANK } from './sim/veterancy.js';
import { Governor, pickInitialTier } from './gfx/quality.js';
import { renownOf } from './sim/elites.js';
import { RESOURCES } from './core/resources.js';

/* 30 Hz simulation, 60+ Hz rendering. An RTS does not need 60 sim ticks a
   second -- AoE2 ran at 20 -- and halving the rate halves the CPU the
   simulation steals from the frame. The renderer interpolates between the two
   most recent ticks, so nothing looks stepped. */
const STEP = 1 / 30;
/* 7: the unit tuple lost its morale column when morale was retired. Every
   index after `survived` shifted down one, so a version 6 save read back with
   its garrison and transport references pointing at the wrong units -- the
   passenger ends up inside a building and the order belongs to his neighbour.
   Loading refuses anything older than 4; a 6 is not a 7. */
const SAVE_VERSION = 8;
/* The size ladder was renamed in 8. These are the ids a pre-8 save carries,
   written when 512/1024/1536 m were the whole list. */
const LEGACY_SIZE_ID = { classic: 'small', large: 'normal', huge: 'large' };

// Only explored/not-explored needs to be saved. Visibility is recalculated
// from the restored army, so an old sight radius cannot reveal enemies.
function packExplored(fow) {
  const bytes = new Uint8Array(Math.ceil(fow.length / 8));
  for (let i = 0; i < fow.length; i++) if (fow[i]) bytes[i >> 3] |= 1 << (i & 7);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function restoreExplored(game, packed) {
  if (!packed) return;
  try {
    const binary = atob(packed);
    if (binary.length !== Math.ceil(game.fow.length / 8)) return;
    for (let i = 0; i < game.fow.length; i++) game.fow[i] = (binary.charCodeAt(i >> 3) & (1 << (i & 7))) ? 1 : 0;
    game.updateFog(0);
    game.fowStamp = (game.fowStamp + 1) | 0;
  } catch (_) { /* a damaged optional fog snapshot must not prevent loading */ }
}   // keep in step with Menu.SAVE_VERSION

const DEFAULT_SETTINGS = {
  quality: 'medium', autoQuality: true, music: true, sound: true, fog: true, shake: true, showBars: true,
  /* First-person feel; every one of these is read live by DirectControl.
     The defaults are phone defaults: generous look, no inversion, swings on
     its own so one thumb can steer, and a short buzz when steel lands. */
  lookSensitivity: 1, invertLookY: false, swapSticks: false, headBob: true,
  autoAttack: true, haptics: true, buttonSize: 'comfortable',
  /* Realme 9i / Adreno 610: the hardware DPR is 3 but the balanced target
     is 1.35. `resolutionPreset` is the player-facing dial (Performance
     1.0x, Balanced 1.35x, Ultra 1.75x) applied on top of the frame
     governor, which still lowers resolution when frames get expensive. */
  resolutionPreset: 'balanced',
  mapType: 'confluence'
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('imperial-crown-v6-settings')
      ?? localStorage.getItem('imperial-crown-v5-settings')
      ?? localStorage.getItem('imperial-crown-settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* storage may be blocked */ }
  // pick a sensible default for the device class
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem <= 3 || cores <= 4) return { ...DEFAULT_SETTINGS, quality: 'low' };
  return { ...DEFAULT_SETTINGS };
}

class App {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.settings = loadSettings();
    document.body.dataset.fpButtons = this.settings.buttonSize || 'comfortable';
    this.audio = new Audio({ enabled: this.settings.sound, music: this.settings.music });
    this.renderer = null;
    this.game = null;
    this.ai = null;
    this.camera = null;
    this.ui = null;
    this.input = null;
    this.directControl = null;
    this.fx = null;
    this.paused = false;
    this.running = false;
    this.last = 0;
    this.acc = 0;
    this.frameTimes = [];
    this.qualityCooldown = 0;
    /* The frame governor owns resolution, tier and the refresh divisor. It is
       created in boot() once the GPU string is readable. */
    this.governor = null;
    this.displayFrame = 0;
    this.lastRenderMs = 0;
    this._rafTimes = [];
    this.saveTimer = 0;
    this.statsFrames = 0;
    this.fps = 60;
    this.matchOpts = null;
    this.menu = new Menu({
      audio: this.audio,
      settings: this.settings,
      quality: this.settings.quality,
      mapType: this.settings.mapType,
      resolutionPreset: this.settings.resolutionPreset,
      onStart: (opts) => this.startMatch(opts),
      /* Native Back -> closeModal() must RESUME the match. */
      onClose: () => this.resumeFromOverlay(),
      onOverlayOpen: () => this.pauseForOverlay(),
      isInGame: () => !!this.game && (this.running || this.paused),
      onSettingsChanged: (state) => this.applySettings(state)
    });
  }

  boot() {
    if (!this._bootPromise) this._bootPromise = this._boot();
    return this._bootPromise;
  }

  async _boot() {
    this.menu.bind();
    this.menu.showBoot();
    this.menu.bootTip('Preparing the forge…');
    this.menu.bootProgress(0.02, 'Waking the empire…');
    // keep the boot screen animated while the GL layer compiles
    await new Promise((r) => requestAnimationFrame(r));

    this.renderer = new Renderer(this.canvas, { quality: this.settings.quality });
    if (!this.renderer.ok) {
      this.menu.bootProgress(1, 'WebGL2 is not available on this device.');
      this.menu.bootDone();
      if (this.menu.el.start) this.menu.el.start.disabled = true;
      this.menu.openModal('HARDWARE', 'WebGL2 required',
        '<p>This device could not create a WebGL2 context. Update Android System WebView or Chrome, ' +
        'check that hardware acceleration is enabled, then restart the game. Some devices or drivers do not support WebGL2.</p>');
      return;
    }
    try {
      await this.renderer.init((label, frac) => this.menu.bootProgress(frac, label));
    } catch (err) {
      console.error(err);
      this.menu.bootProgress(1, 'The renderer failed to start.');
      this.menu.bootDone();
      if (this.menu.el.start) this.menu.el.start.disabled = true;
      this.menu.openModal('HARDWARE', 'Renderer error',
        `<p class="dim">${String(err && err.message || err)}</p>`);
      return;
    }
    /* Every GPU object now has one owner. A lost context (Android's
       onRenderProcessGone) or a map regeneration releases through this
       manager instead of three scattered hand-written disposal loops. */
    RESOURCES.attachGL(this.renderer.gl);
    this.renderer.trackPersistentResources();
    this.renderer.onContextLost = () => {
      // Stop the simulation while the battlefield is invisible. Preserve a
      // pre-existing pause/modal instead of resuming it behind the player's back.
      if (!this._recoveringGraphics) {
        this._graphicsWasPaused = this.paused;
        try { if (this.game && !this.game.gameOver) this.saveMatch(); }
        catch (err) { console.warn('Could not save after graphics interruption:', err); }
      }
      this._recoveringGraphics = true;
      this.paused = true;
      this.directControl?.resetInput?.();
      this.menu.el.boot?.classList.remove('hidden');
      this.menu.bootProgress(0, 'Graphics interrupted. Waiting for the device…');
      this.menu.bootTip('The battle is paused while graphics recover.');
    };
    this.renderer.onContextRestored = () => {
      const epoch = this.renderer._contextEpoch;
      // Serialize rebuilds if the device loses the context again mid-recovery.
      this._graphicsRecovery = (this._graphicsRecovery || Promise.resolve()).then(async () => {
        if (this.renderer.ctxLost || epoch !== this.renderer._contextEpoch) return;
        try {
          await this.renderer.restoreContext((label, frac) => this.menu.bootProgress(frac, label));
          if (this.game) { this.game.fowDirty = true; }
          this._syncGovernor();
          this.onResize();
          this._recoveringGraphics = false;
          this.paused = this._graphicsWasPaused || document.hidden || this.menu.isModalOpen();
          this.menu.hideBoot();
        } catch (err) {
          if (epoch !== this.renderer._contextEpoch) return;
          console.error('Graphics recovery failed:', err);
          this.menu.bootProgress(0, 'Graphics could not be restored.');
          this.menu.bootTip('Restart the app to continue from your last save.');
        }
      });
    };
    this._initGovernor();
    if (this.renderer && this.settings.resolutionPreset) {
      this.renderer.setResolutionPreset(this.settings.resolutionPreset);
    }
    /* The WebAudio context is suspended by MainActivity.onPause() and is
       NEVER resumed by onResume(). Audio installs its own visibility,
       focus, pageshow and passive pointer/touch listeners at construction;
       this is the belt-and-braces path for WebViews that swallow those. */
    this.audio.installLifecycle?.();
    window.addEventListener('focus', () => this.audio.ensureRunning?.());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.audio.ensureRunning?.();
    });
    this.menu.bootProgress(1, 'Ready.');
    this.menu.bootTip(this.hardwareLine());
    await new Promise((r) => setTimeout(r, 260));
    this.menu.bootDone();

    // a lightweight pre-warmed world so the menu isn't staring at a black canvas
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.onResize(), 240));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.prevPaused = this._recoveringGraphics ? this._graphicsWasPaused : this.paused;
        if (this.running) { this.paused = true; this.audio.suspend(); }
      } else {
        this.audio.resume();
        if (this.running && !this.prevPaused && !this.menu.isModalOpen() && !this._recoveringGraphics) this.paused = false;
      }
    });
    this.onResize();
  }

  /**
   * Decide where to start, from the two things a browser will tell us: the
   * GPU string and the core/memory counts. Automatic mode starts
   * conservatively; a quality setting explicitly pinned by the player remains
   * their choice, while resolution can still adapt under load.
   */
  _initGovernor() {
    const gl = this.renderer && this.renderer.gl;
    let rendererName = '';
    try {
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      rendererName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
    } catch (e) { /* privacy mode blocks it */ }
    const saved = this.settings.autoQuality === false ? this.settings.quality : null;
    const info = pickInitialTier({
      renderer: rendererName,
      cores: navigator.hardwareConcurrency || 4,
      mem: navigator.deviceMemory || 4,
      ua: navigator.userAgent || '',
      savedTier: saved
    });
    const tier = info.tier;
    this.deviceInfo = { ...info, tier };
    this.governor = new Governor({
      tier,
      refresh: 60,
      pinTier: this.settings.autoQuality === false
    });
    this.settings.quality = tier;
    if (this.menu?.state) this.menu.state.quality = tier;
    if (this.renderer && this.renderer.ready) {
      this.renderer.setQuality(tier);
      this.renderer.setPixelScale(this.governor.scale);
    }
    console.log(`[imperial] ${info.gpu.name || 'GPU'} (${info.gpu.class}) → ${tier} (saved: ${saved})`);
    return this.governor;
  }

  /**
   * The panel rate, measured rather than assumed. requestAnimationFrame is
   * vsync'd, so the *fastest* frames we see are one refresh apart. Phones ship
   * with 60, 90 and 120 Hz panels and the difference decides whether the
   * governor should be aiming at 90, 45 or 30 fps -- guessing 60 on a 90 Hz
   * panel would have it chase a rate the hardware cannot show evenly.
   */
  _detectRefresh(nowMs) {
    const t = this._rafTimes;
    if (this._refreshHz) {
      if (t.length) t.length = 0;
      return this._refreshHz;
    }
    t.push(nowMs);
    if (t.length < 2) return 60;
    const dts = [];
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 2 && d < 60) dts.push(d);
    }
    if (dts.length < 40) return 60;
    dts.sort((a, b) => a - b);
    const typical = dts[Math.max(0, Math.floor(dts.length * 0.2))];
    const hz = 1000 / typical;
    const snapped = [24, 30, 48, 50, 60, 90, 120, 144, 165, 240].find((v) => Math.abs(v - hz) < v * 0.12);
    this._refreshHz = snapped || Math.round(hz);
    if (this.governor) this.governor.setRefresh(this._refreshHz);
    t.length = 0;
    console.log(`[imperial] display ${this._refreshHz} Hz (${typical.toFixed(1)} ms)`);
    return this._refreshHz;
  }

  /** Push the governor's decision into the renderer and the HUD. */
  _syncGovernor() {
    const gov = this.governor, r = this.renderer;
    if (!gov || !r || !r.ready) return;
    if (r.qualityName !== gov.tier) r.setQuality(gov.tier);
    r.setPixelScale(gov.scale);
    const line = document.getElementById('qualityLine');
    if (line) line.textContent = gov.describe();
  }

  /** Percent of native pixels being shaded -- the honest number for the HUD. */
  resolutionPct() {
    const r = this.renderer;
    if (!r || !r.width || !r.height) return 100;
    const dpr = Math.min(r.dprNative || 1, r.quality.maxDpr || 3);
    const native = r.width * r.height * dpr * dpr;
    return Math.round(100 * (r.renderW * r.renderH) / Math.max(1, native));
  }

  hardwareLine() {
    const r = this.renderer && this.renderer.gl ? this.renderer.gl.__renderer : 'WebGL2';
    const short = String(r).replace(/ANGLE \(|\)|Direct3D11|vs_5_0|ps_5_0/g, '').trim().slice(0, 42);
    const tier = this.governor ? this.governor.tier : this.settings.quality;
    return `GPU: ${short || 'unknown'} · ${tier} quality`;
  }

  onResize() {
    if (!this.renderer) return;
    this.renderer.resize();
    if (this.camera) {
      const vw = this.canvas.clientWidth || window.innerWidth;
      const vh = this.canvas.clientHeight || window.innerHeight;
      this.camera.setAspect(vw / Math.max(1, vh));
      this.camera.setViewport(vw, vh);
      /* A phone turned upright sees a narrower world, so the same map needs a
         longer lens to frame: re-solve the zoom-out limit on every resize. */
      if (this.worldHalf) this.camera.setWorldExtent(this.worldHalf);
    }
    const portrait = window.innerHeight > window.innerWidth * 1.1;
    document.getElementById('rotateHint')?.classList.toggle('hidden', !portrait || !this.running);
    /* the HUD's own layout shifts with the viewport: the top bar is one row
       of chips in portrait and three in landscape, and the strips below it
       are placed from its measured height */
    this.ui?.layoutTopBar?.();
  }

  applySettings(state) {
    const prev = this.settings.quality;
    this.settings = { ...this.settings, ...state };
    // Returning to automatic mode hands the current tier to the governor;
    // do not jump to a more expensive tier in the middle of a battle.
    if (this.governor && this.settings.autoQuality !== false) {
      this.settings.quality = this.governor.tier;
      if (this.menu?.state) this.menu.state.quality = this.governor.tier;
    }
    /* the first-person HUD reads its own size off the body, so a change is
       visible the moment the sheet closes */
    document.body.dataset.fpButtons = this.settings.buttonSize || 'comfortable';
    if (this.renderer) {
      this.renderer.setQuality(this.settings.quality);
      if (state.resolutionPreset) this.renderer.setResolutionPreset(state.resolutionPreset);
    }
    if (this.governor) {
      /* A hand-picked tier is a promise: the governor keeps the art but is
         still allowed to spend resolution and the refresh divisor to hold the
         frame rate. Choosing "auto" hands the tier back. */
      this.governor.setPinned(this.settings.autoQuality === false);
      if (this.settings.autoQuality === false && this.settings.quality !== prev) {
        this.governor.tier = this.settings.quality;
        this.governor.setScale(1);
        this.governor.div = 1;
      }
      this._syncGovernor();
    }
    try { localStorage.setItem('imperial-crown-v6-settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
    this.audio.setEnabled(this.settings.sound);
    this.audio.setMusic(this.settings.music);
    if (this.game) {
      this.game.settings.fog = this.settings.fog;
      this.game.showFog = this.settings.fog;
      this.game.settings.bars = this.settings.showBars;
    }
  }

  /* ================= match lifecycle ================= */
  async startMatch(opts) {
    // Do not build a world against half-initialised renderer batches.
    if (!this.renderer?.ready) {
      await this.boot();
      if (!this.renderer?.ready) return;
    }
    // A restart/new match owns new input handlers and a new mod registry.
    /* Releasing the previous battle's transient pools is the difference
       between a restart that reuses fixed arrays and one that slowly grows
       the JS heap (and the GPU's instance buffers) forever. */
    RESOURCES.releaseMatch();
    this.directControl?.dispose();
    this.input?.detach();
    this.ui?.dispose();
    if (this.modHost) { try { this.modHost.dispose(); } catch (_) { /* keep starting */ } this.modHost = null; }
    this.directControl = null;
    this.input = null;
    document.body.classList.remove('firstPerson');
    /* Defensive: the app is also driven head-lessly by the test suites, which
       call startMatch without going through boot(). */
    if (!this.governor && this.renderer && this.renderer.ready) this._initGovernor();
    this.matchOpts = opts;
    /* a previous mod session's chips are not this match's: clear them before
       the first frame, not at the first HUD tick */
    const modHud = document.getElementById('modHud');
    if (modHud) { modHud.replaceChildren(); modHud.classList.add('hidden'); }
    document.body.classList.remove('mods');
    this.menu.closeModal({ silent: true });
    this.menu.hideMenu();
    this.menu.hideBoot();
    document.getElementById('endScreen')?.classList.add('hidden');
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('bootScreen')?.classList.remove('hidden');
    this.menu.bootProgress(0.05, 'Surveying the land…');
    this.menu.bootTip('Generating terrain, forests and mines…');
    await new Promise((r) => requestAnimationFrame(r));

    /* A save carries the match it belongs to: the island is rebuilt from the
       save's own seed and crown count, so a four-crown war reloads as the
       same four-crown war instead of being squashed into a duel. */
    if (opts.load) {
      opts.seed = opts.load.seed;
      opts.mode = opts.load.mode || opts.mode;
      opts.civ = opts.load.civ || opts.civ;
      opts.difficulty = opts.load.difficulty || opts.difficulty;
      opts.victory = opts.load.victory || opts.victory;
      opts.kingdoms = opts.load.kingdoms || opts.kingdoms;
      opts.matchMinutes = opts.load.matchMinutes || opts.matchMinutes;
      /* a saved workshop/sandbox match reloads with its mods */
      if (opts.load.mods && opts.load.mods.length) opts.mods = opts.load.mods;
    }
    const seed = (opts.seed | 0) || 20261;
    const t0 = performance.now();
    /* A War of Crowns needs a seat per crown; every other mode is the classic
       two-corner island, generated exactly as it always was. */
    const kingdoms = opts.mode === 'kingdoms' ? Math.max(2, Math.min(4, opts.kingdoms | 0 || 3)) : 2;
    /* The menu can opt into experimental hydrology maps. Old saves retain
       their original terrain by defaulting to the classic generator. */
    const mapType = opts.load ? (opts.load.mapType || 'confluence') : (opts.mapType || this.settings.mapType || 'confluence');
    /* The map's size. A loaded save keeps the ground it was played on; a new
       match takes the menu's choice. A world made before sizes existed has no
       `sizeId`, and Classic is exactly that map.

       The fallback for a caller that names no size at all is Classic, not the
       menu's default. `startMatch({ seed: 20261 })` is a hundred call sites in
       the suites and in saved replays, and every one of them means "the map
       this seed has always made". Growing the default must not silently
       redraw them: a seed that no longer rebuilds its own island breaks
       determinism, replays and every assertion written against that ground.
       The menu always passes an explicit `mapSize`, so a real player still
       starts on Large. */
    /* A save's size id was written under the ladder it was played on. Version
       7 and older used 'classic'/'large'/'huge' for 512/1024/1536 m, and
       'large' now means 2048 m -- so those three are translated here rather
       than passed through, or an old campaign would reload onto a map twice
       the size it was fought on and every building in it would be somewhere
       else. Version 8 onwards records the current ids and needs no map. */
    const saveSizeId = opts.load && opts.load.sizeId
      ? (opts.load.version >= 8 ? opts.load.sizeId : LEGACY_SIZE_ID[opts.load.sizeId] || opts.load.sizeId)
      : null;
    const sizeId = opts.load ? (saveSizeId || 'small')
      : (opts.mapSize || this.settings.mapSize || 'normal');
    const world = generateWorld(seed, { sites: kingdoms > 2 ? kingdoms : 2, mapType, size: sizeId });
    /* world.mapType is the *resolved* archetype ('confluence', not 'classic'):
       a save records what was actually generated, so reloading it cannot
       silently pick a different landform. 'classic' is still accepted on the
       way in, for old saves. */
    this.menu.bootProgress(0.4, 'Settling villages…');

    const fx = new FX();
    /* Clear the existing particle and projectile pools on match teardown. */
    const sound = {
      play: (name, o, z) => this.audio.play(name,
        (o && typeof o === 'object') ? o : (Number.isFinite(o) ? { x: o, z: z || 0 } : {})),
      playSelectionFor: (unit) => this.audio.playSelectionFor?.(unit),
      playDropoff: (kind, x, z) => this.audio.playDropoff?.(kind, x, z),
      noteCombat: (n) => this.audio.noteCombat?.(n)
    };
    const game = new Game({
      world,
      civ: opts.civ,
      mode: opts.mode,
      difficulty: opts.difficulty,
      kingdoms,
      victory: opts.victory,
      matchMinutes: opts.matchMinutes,
      fx,
      sound,
      rand: Math.random
    });
    RESOURCES.registerPool('particles', fx);
    RESOURCES.registerPool('projectiles', game.projectiles);
    game.settings.fog = this.settings.fog;
    game.settings.bars = this.settings.showBars;
    game.showFog = this.settings.fog;
    game.worldTime = 8.6;
    game.onNotify = (text, kind) => {
      if (!this.ui) return;
      const k = kind === 'bad' ? 'warn' : kind === 'good' ? 'good' : '';
      this.ui.toast(text, k);
      if (kind === 'bad') this.audio.play('warn', { gap: 0.4 });
    };
    game.onEvent = (type, data) => this.onGameEvent(type, data);

    const camera = new Camera({ yaw: Math.PI * 0.24, pitch: 0.86, dist: 44, fov: 47 });
    camera.heightAt = world.heightAt;
    camera.worldHalf = world.half;
    /* The zoom-out limit is solved against the frustum rather than guessed:
       the whole map has to fit the screen, with the far corner still legible,
       on a phone held upright as well as on a desktop. `setWorldExtent` also
       exports a `<half * linear>` constant's job to the camera, which is the
       only thing that knows its own field of view. */
    camera.far = Math.max(820, world.half * 4);
    camera.setAspect((this.canvas.clientWidth || window.innerWidth || 900) / Math.max(1, this.canvas.clientHeight || window.innerHeight || 420));
    camera.setWorldExtent(world.half);
    this.worldHalf = world.half;
    camera.setTarget(world.playerBase.x + 6, world.playerBase.z + 10, true);
    game.camera = camera;

    this.renderer.buildWorld(world);
    this.menu.bootProgress(0.7, 'Laying foundations…');
    await new Promise((r) => requestAnimationFrame(r));

    game.start();

    /* A mod session is assembled *after* the renderer has its base batches, so
       the extra unit and building meshes can be registered lazily. This is the
       only place in the app that imports src/mods: a normal campaign never
       downloads or parses a byte of it. */
    /* THE ARCANE ORDER IS AVAILABLE IN EVERY MODE.
       This used to require `opts.mode === 'mods' || opts.mode === 'sandbox'`,
       which is why the one mod worth keeping was locked out of every match a
       player actually starts. There is no reason for the gate: the host is
       additive (it registers units and buildings on activate and deletes
       exactly those keys on dispose), so a match that asked for the mod gets
       it wherever it is fought -- conquest, kingdoms, regicide, wonder,
       sandbox or the workshop -- for the player and the enemy crown alike.
       A match that asks for nothing still never loads a byte of mod code. */
    /* Read the selection defensively. The menu hands over a list, but a saved
       match, a URL or a caller can hand over a map of id -> bool, and the map
       for "nothing is enabled" is `{}` -- which is truthy. Treating that as a
       one-entry list started a mod host for every plain campaign, and the
       empty mod's activation is what ballooned the tab. A selection is a list
       of non-empty strings and nothing else. */
    const rawMods = opts.mods;
    const listed = Array.isArray(rawMods) ? rawMods
      : rawMods && typeof rawMods === 'object' ? Object.keys(rawMods).filter((id) => rawMods[id])
      : rawMods ? [rawMods] : [];
    const wantMods = listed.filter((id) => typeof id === 'string' && id);
    const modMatch = wantMods.length > 0;
    if (modMatch) {
      this.menu.bootProgress(0.8, 'Opening the workshop…');
      try {
        const { createModHost } = await import('./mods/index.js');
        this.modHost = createModHost(game, {
          enabled: wantMods,
          renderer: this.renderer,
          onError: (e) => {
            this.ui?.toast(`${e.name || 'A mod'} failed and was disabled: ${e.message}`, 'warn');
          }
        });
        game.modHost = this.modHost;
        document.body.classList.add('mods');
      } catch (err) {
        /* the workshop itself must never be able to stop a match starting */
        console.error('mod session failed to start', err);
        document.body.classList.remove('mods');
        this.modHost = null;
      }
    } else {
      document.body.classList.remove('mods');
      this.modHost = null;
    }
    this.menu.bootProgress(0.86, 'Raising banners…');
    await new Promise((r) => requestAnimationFrame(r));

    // apply a saved campaign on top of the fresh world
    if (opts.load) this.applySave(game, opts.load);

    /* Sandbox has no opponent: team 2 is never set up, so an AI controller
       there has no base to defend and would grab any team-2 unit that appeared
       (a spawned raid, a scenario) and march it across the map. */
    /* One opponent in every classic mode; a War of Crowns fields one AI per
       rival crown, each with its own economy, its own grudges and its own
       idea of who the real enemy is. `this.ai` stays the first one so every
       older caller and test keeps working. */
    const ais = [];
    if (opts.mode === 'sandbox') {
      /* The Free Company keeps its own council: a real town, a real economy,
         and a temper. It does not march on the clock -- it answers the first
         blow, which is what `game.canFight` decides. */
      if (game.partyTeam) {
        ais.push(new AIController(game, game.partyTeam, {
          diff: DIFFICULTY.company, aggression: 0.4
        }));
      }
    } else {
      for (const t of game.teamIds) {
        if (t === game.playerTeam) continue;
        ais.push(new AIController(game, t, {
          aggression: DIFFICULTY[opts.difficulty]?.aggression ?? 0.85
        }));
      }
    }
    /* `this.ai` is the war council that runs the match. A sandbox has none --
       its one controller belongs to a party that is not at war. */
    const ai = opts.mode === 'sandbox' ? null : (ais[0] || null);
    this.ais = ais;
    this.fx = fx;
    this.game = game;
    this.ai = ai;
    this.camera = camera;
    this.menu.hideBoot();
    document.getElementById('hud')?.classList.remove('hidden');

    const ui = new UI({
      game, renderer: this.renderer, camera, audio: this.audio, menu: this.menu,
      app: { togglePause: () => this.togglePause(), openPause: () => this.openPause(), quit: () => this.requestQuit() }
    });
    const input = new Input({ canvas: this.canvas, game, camera, ui, audio: this.audio });
    ui.input = input;
    input.ui = ui;
    const directControl = new DirectControl({ game, camera, input, ui, app: this });
    game.directControl = directControl;
    this.directControl = directControl;
    ui.show();
    ui.setGame(game);
    ui.setStance?.('aggressive');
    this.ui = ui;
    this.input = input;
    game.input = input;
    game.ui = ui;

    this.paused = false;
    this.running = true;
    this.acc = 0;
    this.frameTimes.length = 0;
    this.qualityCooldown = 0;
    /* a new match is a new measurement: throw away everything the governor
       learned about the menu's idle scene */
    if (this.governor) {
      this.governor.samples.length = 0;
      this.governor.stable = 0;
      this.governor.probeTimer = 0;
      this.lastRenderMs = 0;
      this._syncGovernor();
    }
    this.saveTimer = 0;
    this.startTime = performance.now();
    /* One toast, not three. The match-start stack used to cover the town for
       the first five seconds -- the exact seconds a new player spends working
       out where they are. */
    ui.toast(`${CIVS[game.civ].name} · ${DIFFICULTY[opts.difficulty]?.name || ''} · ${GAME_MODES[opts.mode]?.name || ''} — drag to pan, tap to command`, 'gold');
    this.audio.unlock();
    this.audio.play('horn');
    console.log(`[imperial] world + match built in ${(performance.now() - t0).toFixed(0)} ms`);
    this.onResize();
    this.running = true;
    // the world was rebuilt: refresh the fog texture binding
    this.renderer.fogTexture = null;
    this.renderer.propDirty = true;
  }

  onGameEvent(type, data) {
    const g = this.game;
    if (!g) return;
    const ui = this.ui;
    switch (type) {
      case 'death': {
        const u = data.unit;
        if (!u) break;
        this.audio.play('death', { x: u.x, z: u.z });
        if (u.team === 1 && ui) ui.toast(`${u.name || u.type} lost`, 'warn');
        break;
      }
      case 'championRank': {
        const u = data.unit;
        this.audio.play('promotion');
        ui?.toast(`★ ${u.name} — ${data.name}. Press P to choose a perk.`, 'gold');
        break;
      }
      case 'championDeath': {
        const u = data.unit;
        this.audio.play('lose');
        if (this.directControl?.unit === u) this.directControl.exit('Your Champion has fallen');
        ui?.toast(`${u.name} has fallen. ${this.game.champions.stats.kills} kills, ${this.game.champions.stats.parries} parries.`, 'warn');
        break;
      }
      case 'built': {
        const b = data.building;
        if (b && b.team === 1) { this.audio.play('complete'); }
        break;
      }
      case 'buildingDeath': {
        const b = data.building;
        if (b) {
          this.audio.play('boom', { x: b.x, z: b.z });
          if (this.camera) this.camera.addShake(clamp(b.size * 0.05, 0.1, 0.5));
        }
        break;
      }
      case 'age': {
        if (data.team === 1) {
          this.audio.play('ageUp');
          if (ui) ui.toast(`Welcome to the ${AGES[data.age].name}`, 'gold');
        }
        break;
      }
      case 'phase': {
        // a phase flip is the one time of day that changes the rules, so it is
        // worth a toast: gather speed drops, raids hit harder, sight shrinks
        const ui2 = this.ui;
        const d = data.phase;
        if (d === 'night') ui2?.toast('Night falls — gathering slows, raids hit harder', 'info');
        else if (d === 'dawn') ui2?.toast('Dawn — villagers are at full speed again', 'good');
        else if (d === 'dusk') ui2?.toast('Dusk — the light is going', 'info');
        break;
      }
      case 'tech': {
        if (data.team === 1) ui?.toast('Research complete', 'good');
        break;
      }
      case 'place': {
        const b = data.building;
        if (b) this.audio.play('build', { x: b.x, z: b.z });
        break;
      }
      case 'collapse': {
        /* A crown has fallen. This is the loudest thing that can happen in a
           War of Crowns short of the end, so it gets a toast of its own, a
           shake scaled to distance and a column of gold over the fallen seat. */
        const heir = data.heir;
        const fallenName = CIVS[g.civOf(data.team)]?.name || 'A crown';
        const heirName = heir ? (CIVS[g.civOf(heir)]?.name || 'a rival') : 'nobody';
        if (data.team === 1) {
          ui?.toast('Your crown has fallen', 'warn');
        } else if (heir === 1) {
          ui?.toast(`${fallenName} has fallen — ${data.spoils.units} soldiers and ${Math.round(data.spoils.resources?.gold || 0)} gold are yours`, 'good');
        } else {
          ui?.toast(`${fallenName} has fallen to ${heirName}`, 'info');
        }
        const seat = g.baseOf(data.team);
        if (seat) {
          this.audio.play('boom', { x: seat.x, z: seat.z });
          const cam = this.camera;
          if (cam) {
            const d = Math.hypot(cam.target[0] - seat.x, cam.target[2] - seat.z);
            cam.addShake(clamp(1.1 - d / 220, 0.12, 1.1));
          }
        }
        break;
      }
      case 'gameover': {
        this.running = false;
        if (ui) setTimeout(() => ui.showEnd(g.result?.win !== false, g.result?.reason), 900);
        this.audio.play(g.result?.win !== false ? 'win' : 'lose');
        break;
      }
      default: break;
    }
  }

  togglePause() {
    if (!this.running) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.audio.play('click');
      this.openPause();
    } else {
      this.menu.closeModal();
    }
  }

  /* ---------- device check -------------------------------------------
     The phone is the only place that can answer "is it smooth", so the pause
     menu measures it there: the real frame loop, six seconds, camera orbiting
     (a still camera is too easy to render and reads as a fake 60). What comes
     back is the median and the 95th-percentile frame time plus what the
     governor settled on -- enough to tell "it is fine" from "it is dropping
     every third frame". */
  perfSnapshot() {
    const ft = this.frameTimes;
    if (!ft || ft.length < 8) return { fps: this.fps || 0, med: 16.7, p95: 16.7, n: 0 };
    const s = ft.slice().sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    return { fps: 1000 / Math.max(1, med), med, p95, n: s.length };
  }

  perfLine() {
    const p = this.perfSnapshot();
    if (!this.renderer) return `${Math.round(p.fps)} fps`;
    const q = this.governor ? this.governor.describe() : this.renderer.qualityName;
    return `${Math.round(p.fps)} fps · p95 ${Math.round(p.p95)} ms · ${q} · ${this.resolutionPct()}% of native`;
  }

  runDeviceCheck() {
    if (this._check || !this.running) return;
    const line = document.getElementById('perfLine');
    if (line) line.textContent = 'Measuring… hold still for six seconds';
    const cam = this.camera;
    this._check = {
      t0: performance.now(), n: 0, samples: [], line,
      yaw: cam ? cam.desiredYaw : 0, pitch: cam ? cam.desiredPitch : 0.6
    };
  }

  _pumpDeviceCheck(dt) {
    const c = this._check;
    c.n++;
    if (c.n > 4) c.samples.push(Math.min(200, dt * 1000));
    const el = (performance.now() - c.t0) / 1000;
    const cam = this.camera;
    if (cam) cam.desiredYaw = c.yaw + el * 0.55;
    if (el < 6) return;
    this._check = null;
    if (cam) { cam.desiredYaw = c.yaw; cam.desiredPitch = c.pitch; }
    const s = c.samples.sort((a, b) => a - b);
    const med = s[s.length >> 1] || 16.7;
    const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] || med;
    const r = this.renderer;
    const fps = Math.round(1000 / Math.max(1, med));
    const pct = this.resolutionPct();
    /* Both numbers matter. A phone can hold a 60 fps *median* and still feel
       broken if every fifth frame takes 60 ms, so the verdict is only "smooth"
       when the median is under 18 ms AND the 95th percentile under 30. */
    const verdict = (med <= 18 && p95 <= 30) ? 'smooth'
      : (med <= 26 && p95 <= 60) ? 'playable' : 'slow';
    const txt = `${fps} fps · p95 ${Math.round(p95)} ms · ${r ? (this.governor ? this.governor.describe() : r.qualityName) : '?'} · ${pct}% of native — ${verdict}`;
    if (c.line) c.line.textContent = txt;
    this.ui?.toast(`Device check: ${txt}`, verdict === 'slow' ? 'warn' : 'good');
    this.deviceCheck = txt;
  }

  /* ---------------- Android back-button contract ----------------
     MainActivity.onBackPressed():
       if (a.menu.isModalOpen())  { a.menu.closeModal(); return 'handled'; }
       if (a.running)             { a.openPause();       return 'handled'; }
       ...otherwise quitToMenu().
     A pause/tech/diplomacy/forge sheet is therefore an OPEN MODAL, and
     closing it resumes the very same match. No fall-through to the menu. */
  pauseForOverlay(kind = 'overlay') {
    if (!this.game || this.game.gameOver) return;
    this.paused = true;
    this.directControl?.resetInput?.();
  }
  resumeFromOverlay(kind = 'overlay') {
    if (!this.game || this.game.gameOver || this._quitting) return;
    this.paused = false;
    this.running = true;
  }

  /** Explicit "Quit to Menu": confirm first, then auto-save and leave. The
      save happens BEFORE the confirmation so a mis-tap or a killed WebView
      still leaves a resumable match in localStorage. */
  requestQuit() {
    if (!this.game) { this.quitToMenu(); return; }
    const saved = this.saveMatch();
    this.menu.openModal('LEAVE THE FIELD', 'Quit to menu?', `
      <p class="dim">Your campaign is ${saved ? 'saved on this device' : 'running, but this device refused the save'}.
      Resume from the main menu with <b>Load Campaign</b>.</p>
      <div class="metricRow"><span>Match time</span><b>${Math.floor((this.game.time || 0) / 60)} min ${Math.floor((this.game.time || 0) % 60)} s</b></div>
      <div class="row" style="margin-top:10px;gap:6px;display:flex;flex-wrap:wrap">
        <button class="ghostBtn" data-quit="cancel"><svg class="ic"><use href="#i-play"/></svg> Keep playing</button>
        <button class="ghostBtn" data-quit="confirm"><svg class="ic"><use href="#i-home"/></svg> Save and quit</button>
      </div>`, '<span class="dim tiny">A native Back press closes this sheet and resumes the match instead.</span>',
      { kind: 'quit' });
    const body = document.getElementById('modalBody');
    if (body) body.onclick = (e) => {
      const b = e.target.closest('[data-quit]');
      if (!b) return;
      if (b.dataset.quit === 'confirm') this.quitToMenu();
      else this.menu.closeModal();
    };
  }

  openPause() {
    if (!this.running) return;
    this.paused = true;
    this.directControl?.resetInput();
    const g = this.game;
    const t = g.teams.get(1);
    const terms = VICTORIES[g.victory] || VICTORIES.conquest;
    const crowns = (g.crowns || 2) > 2 ? `<div class="metricRow"><span>Crowns</span><b>${g.teamIds.filter((x) => !g.fallenTeams.has(x)).length} of ${g.crowns} still standing</b></div>` : '';
    /* the sandbox's third party, and the state of its temper, in one line */
    const party = g.partyTeam ? `<div class="metricRow"><span>${g.partyName}</span><b>${g.atPeace(g.partyTeam) ? 'at peace — will not strike first' : 'at war with you'}</b></div>` : '';
    this.menu.openModal('CAMPAIGN', 'Paused', `
      <div class="metricRow"><span>Terms of war</span><b>${terms.name}</b></div>
      <div class="dim tiny" style="margin:0 0 6px">${terms.desc}</div>
      ${crowns}${party}
      <div class="metricRow"><span>Age</span><b>${AGES[t.age].name}</b></div>
      <div class="metricRow"><span>Army</span><b>${g.units.filter((u) => !u.dead && u.team === 1 && u.def.attack > 0 && !u.def.classes.includes('villager')).length}</b></div>
      <div class="metricRow"><span>Villagers</span><b>${g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager').length}</b></div>
      <div class="metricRow"><span>Population</span><b>${t.popUsed} / ${t.popCap}</b></div>
      ${g.champions && g.champions.current ? (() => {
        const c = g.champions.current;
        const pr = g.champions.rank(c);
        return `<div class="metricRow"><span>Champion</span><b>${c.name} · ${['Sworn', 'Banneret', 'Captain', 'Warden', 'Marshal', 'Legend'][pr]}</b></div>
      <div class="metricRow"><span>Renown</span><b>${Math.round(c.champion.renown)} · ${c.champion.picks.length} perks</b></div>`;
      })() : ''}
      <div class="metricRow"><span>This device</span><b id="perfLine">${this.perfLine()}</b></div>
      <div class="row" style="margin-top:10px;gap:6px;display:flex;flex-wrap:wrap">
        <button class="ghostBtn" data-act="resume"><svg class="ic"><use href="#i-play"/></svg> Resume</button>
        <button class="ghostBtn" data-act="save"><svg class="ic"><use href="#i-save"/></svg> Save</button>
        <button class="ghostBtn" data-act="settings"><svg class="ic"><use href="#i-cog"/></svg> Settings</button>
        <button class="ghostBtn" data-act="check"><svg class="ic"><use href="#i-hourglass"/></svg> Check device</button>
        <button class="ghostBtn" data-act="restart"><svg class="ic"><use href="#i-load"/></svg> Restart</button>
        <button class="ghostBtn" data-act="quit"><svg class="ic"><use href="#i-home"/></svg> Quit</button>
      </div>`,
      '<span class="dim tiny">Tip: the game auto-saves every minute. “Check device” runs a six-second orbit and reports the frame rate — useful when reporting how the game runs on your phone.</span>',
      { kind: 'pause' });
    const body = document.getElementById('modalBody');
    if (body) body.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'resume') { this.paused = false; this.menu.closeModal(); }
      else if (act === 'save') { const ok = this.saveMatch(); this.ui?.toast(ok ? 'Campaign saved' : 'Could not save on this device', ok ? 'good' : 'warn'); }
      else if (act === 'settings') this.menu.openSettings();
      else if (act === 'check') this.runDeviceCheck();
      else if (act === 'restart') { this.menu.closeModal({ silent: true }); this.startMatch(this.matchOpts); }
      else if (act === 'quit') this.requestQuit();
    };
  }

  quitToMenu() {
    /* An explicit quit always leaves a resumable campaign behind. */
    this._quitting = true;
    if (this.game && !this.game.gameOver) this.saveMatch();
    this.directControl?.dispose();
    this.input?.detach();
    this.ui?.dispose();
    this.directControl = null;
    this.input = null;
    document.body.classList.remove('firstPerson');
    this.running = false;
    this.paused = false;
    /* silent: tearing down a match must not resume the game being discarded */
    this.menu.closeModal({ silent: true });
    if (this.modHost) {
      try { this.modHost.dispose(); } catch (e) { /* a dead mod cannot block the menu */ }
      this.modHost = null;
    }
    /* GPU memory is freed the moment a match ends, not at the next GC. */
    RESOURCES.releaseMatch();
    if (this.renderer) {
      this.renderer.disposeWorld?.();
      this.renderer.modAtmosphere = null;
      this.renderer.climateAtmosphere = null;
      this.renderer.flash = 0;
    }
    document.body.classList.remove('mods');
    const hud = document.getElementById('modHud');
    if (hud) { hud.classList.add('hidden'); hud.replaceChildren(); }
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('rotateHint')?.classList.add('hidden');
    document.getElementById('endScreen')?.classList.add('hidden');
    this.game = null;
    this.ai = null;
    this.ais = [];
    this.ui = null;
    this.menu.showMenu();
    this.audio.setMood?.('peace');
    this.audio.setEnvironment?.({ forest: 0, water: 0, fire: 0, combat: 0 });
    this.audio.stopMusic?.();
    this.audio.startMusic?.();
    this.audio.ensureRunning?.();
    this._quitting = false;
  }

  /* ================= save / load ================= */
  saveMatch() {
    const g = this.game;
    if (!g) return false;
    /* Supply carts are deliberately not saved. Each one belongs to a
       building that re-issues it on load (`onBuildingComplete` runs for
       every restored camp), so saving them too would double the fleet on
       every reload. Their cargo is not lost: it is folded back into the
       camp's pile below, as though the cart were standing in the yard when
       the game was put down. */
    const liveUnits = g.units.filter((u) => !u.dead && !u.def.supply);
    const liveBuildings = g.buildings.filter((b) => !b.dead);
    /* A camp's pile, plus whatever its cart happens to be carrying. */
    const storeOf = (b) => {
      if (b.def.stockpile === undefined) return undefined;
      const out = {};
      let any = 0;
      for (const [k, v] of Object.entries(b.store || {})) if (v > 0) { out[k] = Math.round(v); any += v; }
      const cart = b.cart;
      if (cart && !cart.dead && cart.load) {
        for (const [k, v] of Object.entries(cart.load)) if (v > 0) { out[k] = Math.round((out[k] || 0) + v); any += v; }
      }
      return any > 0 ? out : undefined;
    };
    const unitIndex = new Map(liveUnits.map((u, i) => [u, i]));
    const buildingIndex = new Map(liveBuildings.map((b, i) => [b, i]));
    const ref = e => {
      if (!e || e.dead) return null;
      if (unitIndex.has(e)) return ['unit', unitIndex.get(e)];
      if (buildingIndex.has(e)) return ['building', buildingIndex.get(e)];
      if (e.kind === 'resource' && Number.isInteger(e.worldResourceIndex)) return ['resource', e.worldResourceIndex];
      return null;
    };
    const order = u => ({
      state: u.state, destX: u.destX, destZ: u.destZ,
      target: ref(u.target), gather: ref(u.gatherTarget), build: ref(u.buildTarget),
      repair: ref(u.repairTarget), convert: ref(u.convertTarget), garrison: ref(u.garrisonTarget),
      carry: u.carry ? { kind: u.carry.kind, amount: u.carry.amount } : null,
      lastGatherKind: u.lastGatherKind, stance: u.stance,
      patrolPoints: u.patrolPoints, patrolIdx: u.patrolIdx,
      convertProgress: u.convertProgress
    });
    const data = {
      version: SAVE_VERSION,
      seed: g.world.seed,
      mapType: g.world.mapType,
      /* the ground it was fought on: a save reloads onto its own map, never
         onto whatever size the menu happens to be showing */
      sizeId: g.mapw.id,
      civ: g.civ,
      mode: g.mode,
      difficulty: g.difficultyKey,
      kingdoms: g.crowns,
      victory: g.victory,
      matchMinutes: Math.round(g.supremacyClock / 60),
      fallenTeams: [...(g.fallenTeams || [])],
      lastBlood: [...(g.lastBlood || [])],
      time: g.time,
      worldTime: g.worldTime,
      explored: packExplored(g.fow),
      /* Both sides. Saving only the player's economy meant a reload handed
         the AI a brand-new Dark Age town while the player kept Castle Age --
         a free win that also made the enemy look broken. */
      teams: Object.fromEntries(g.teamIds.map((t) => [t, g.exportTeam(t)])),
      wonder: [...g.wonderClocks.entries()],
      sacredClock: { ...g.sacredClock },
      calendar: g.calendar ? g.calendar.toJSON() : null,
      climate: g.climate ? g.climate.toJSON() : null,
      elites: g.elites ? g.elites.toJSON() : null,
      squads: g.squads.toJSON(unitIndex),
      guards: g.guards.toJSON(unitIndex, buildingIndex),
      /* the Champion: renown, rank and the perks chosen, per unit */
      champions: g.champions ? g.champions.toJSON(unitIndex) : null,
      mods: g.modHost ? g.modHost.activeIds() : [],
      modState: saveModState(g.modHost, liveUnits, liveBuildings, unitIndex, buildingIndex),
      // The indices below share exactly the same live arrays as squads,
      // guards and workshop state; no volatile runtime entity ids are used.
      units: liveUnits.map((u) => [u.type, u.team, Math.round(u.x * 10) / 10, Math.round(u.z * 10) / 10, Math.round(u.hp), u.rank || 0, Math.round((u.xp || 0) * 10) / 10, Math.round(u.survived || 0), (u.garrisoned ? buildingIndex.get(u.garrisonTarget) : undefined) ?? -1, u.maxHp, (u.garrisoned ? unitIndex.get(u.garrisonTarget) : undefined) ?? -1, order(u)]),
      buildings: liveBuildings.map((b) => [b.type, b.team, Math.round(b.x * 10) / 10, Math.round(b.z * 10) / 10, Math.round(b.hp), b.buildProgress, b.facing || 0, { queue: b.queue, researchQueue: b.researchQueue, rally: b.rally, amount: b.def && b.def.resKind ? Math.round(b.amount || 0) : undefined, poiType: b.poiType, poiId: b.poiId, siteOwner: b.siteOwner, captureTeam: b.captureTeam, captureProgress: b.captureProgress, store: storeOf(b) }]),
      resources: g.resources.filter((r) => !r.dead).map((r) => [r.type, Math.round(r.x * 10) / 10, Math.round(r.z * 10) / 10, Math.round(r.amount), r.variant || 0, r.worldResourceIndex ?? null])
    };
    const ok = Menu.writeSave(data);
    this.saveTimer = 0;
    return ok;
  }

  applySave(game, save) {
    if (!save || (save.version !== SAVE_VERSION && save.version !== 5 && save.version !== 4)) return;
    /* Clean removal, not array truncation: footprints and spatial hashes have
       to come out with the entities or the reloaded map is subtly poisoned. */
    game.clearEntities();
    game.time = save.time || 0;
    game.elapsed = save.time || 0;
    game.worldTime = save.worldTime || 8.6;

    game.fallenTeams = new Set((save.fallenTeams || []).filter((t) => game.teamIds.includes(t)));
    game.lastBlood = new Map((save.lastBlood || []).filter(([v, a]) => game.teamIds.includes(v) && game.teamIds.includes(a)));
    if (save.victory) game.victory = save.victory;
    if (save.matchMinutes) game.supremacyClock = Math.max(120, save.matchMinutes * 60);
    for (const team of game.teamIds) {
      const t = save.teams?.[team];
      if (t) game.importTeam(team, t);
    }
    if (save.climate && game.climate) game.climate.fromJSON(save.climate);
    game.wonderClocks = new Map((save.wonder || []).filter(([team]) => game.teamIds.includes(team)));
    if (save.sacredClock && game.teamIds.includes(save.sacredClock.team) && Number.isFinite(save.sacredClock.time))
      game.sacredClock = { team: save.sacredClock.team, time: Math.max(0, save.sacredClock.time) };

    /* the saved order of `buildings` is the index space the units refer to */
    const placed = [];
    for (const [type, team, x, z, hp, prog, facing, extra] of save.buildings || []) {
      placed.push(null); // every tuple occupies its index, even if invalid
      if (!BUILDING_DEFS[type]) continue;
      const complete = (prog ?? 1) >= 1;
      // Rebuild authoritative saved foundations without paying again or
      // completing an unfinished building as a side effect of loading.
      const b = new Building(game, type, team, x, z, complete);
      game.addBuilding(b);
      b.hp = Math.min(b.maxHp, hp);
      b.buildProgress = prog ?? 1;
      b.completedOnce = complete;
      b.facing = facing || 0;
      if (extra) {
        b.queue = Array.isArray(extra.queue) ? extra.queue : [];
        b.researchQueue = Array.isArray(extra.researchQueue) ? extra.researchQueue : [];
        b.rally = extra.rally || null;
        /* a half-harvested field comes back half-harvested */
        if (Number.isFinite(extra.amount)) b.amount = clamp(extra.amount, 0, b.maxAmount);
        /* and a camp comes back with its pile, cart included */
        if (extra.store && b.def.stockpile !== undefined) {
          b.store = {};
          b.storeTotal = 0;
          for (const [k, v] of Object.entries(extra.store)) {
            if (!(v > 0)) continue;
            b.store[k] = v;
            b.storeTotal += v;
          }
        }
      }
      if (b.type === 'outpost_shrine') {
        const source = (game.world.poi || []).find(p => Math.hypot(p.x - x, p.z - z) < 0.2);
        b.poiType = extra?.poiType || (source?.type === 'sacred' || (source?.type === 'shrine' && !game.world.hydrology) ? 'sacred' : source?.type);
        b.poiId = extra?.poiId || source?.id || null;
        if (b.poiType === 'sacred') {
          b.name = 'Sacred Site';
          b.siteOwner = game.teamIds.includes(extra?.siteOwner) ? extra.siteOwner : 0;
          b.captureTeam = game.teamIds.includes(extra?.captureTeam) ? extra.captureTeam : 0;
          b.captureProgress = Number.isFinite(extra?.captureProgress) ? clamp(extra.captureProgress, 0, 10) : 0;
        }
      }
      if (complete && team !== 0) game.onBuildingComplete(b);
      placed[placed.length - 1] = b;
    }
    // v4 omitted neutral outposts entirely; restore them when importing an old save.
    if (save.version === 4) for (const p of game.world.poi || []) game.addBuilding(new Building(game, 'outpost_shrine', 0, p.x, p.z, true));
    const restoredUnits = [];
    for (const [type, team, x, z, hp, rank, xp, survived, inBuilding, savedMaxHp] of save.units || []) {
      restoredUnits.push(null);
      if (!UNIT_DEFS[type]) continue;
      const u = team === 0 ? game.spawnUnitRaw(type, team, x, z) : game.spawnUnit(type, team, x, z, null, { force: true });
      if (!u) continue;
      restoredUnits[restoredUnits.length - 1] = u;
      if (inBuilding !== undefined && inBuilding >= 0 && placed[inBuilding]) {
        const host = placed[inBuilding];
        if (host.garrisonUnit(u)) game.popDirty = true;
      }
      u.xp = Number.isFinite(xp) ? Math.max(0, xp) : 0;
      if (rank) {
        /* restore the rank before the hit points: the pool the save was taken
           with is the pool the rank had already bought */
        u.rank = Math.min(MAX_RANK, rank | 0);
        u.xp = xp || 0;
        u.maxHp = Math.round(u.baseMaxHp * RANKS[u.rank].hp);
      }
      if (Number.isFinite(savedMaxHp) && savedMaxHp > 0) u.maxHp = savedMaxHp;
      u.maxHp = Math.max(u.maxHp, hp);
      u.hp = Math.min(u.maxHp, hp);
      /* renown is survival time: a veteran of the old campaign comes back a
         veteran, with whatever the field taught him */
      if (Number.isFinite(survived) && survived > 0 && game.elites) {
        u.survived = survived;
        u.renown = Math.min(4, renownOf(survived));
      }
    }
    // Transport references use the same live-unit index space and are linked
    // after every unit exists, so passenger/ship ordering in saves is irrelevant.
    for (let i = 0; i < restoredUnits.length; i++) {
      /* 10, not 11: the unit tuple lost its morale column in 6.5 */
      const hostIndex = save.units[i]?.[10];
      if (Number.isInteger(hostIndex) && hostIndex >= 0 && restoredUnits[i] && restoredUnits[hostIndex]) {
        game.boardTransport(restoredUnits[i], restoredUnits[hostIndex], true);
      }
    }
    if (game.elites && save.elites) game.elites.fromJSON(save.elites);
    if (save.modState && game.modHost) restoreModState(game.modHost, save.modState, restoredUnits, placed);
    game.squads.fromJSON(save.squads, restoredUnits);
    game.guards.fromJSON(save.guards, restoredUnits, placed);
    if (game.champions && save.champions) game.champions.fromJSON(save.champions, restoredUnits);
    if (save.resources) {
      const byIndex = new Map(), legacy = new Map();
      for (const row of save.resources) {
        if (!Array.isArray(row)) continue;
        const [type, x, z, , , index] = row;
        if (Number.isInteger(index) && index >= 0) byIndex.set(index, row);
        else legacy.set(`${Math.round(x)},${Math.round(z)},${type}`, row);
      }
      for (const r of game.resources) {
        const k = `${Math.round(r.x)},${Math.round(r.z)},${r.type}`;
        const indexed = byIndex.get(r.worldResourceIndex);
        const row = indexed?.[0] === r.type ? indexed : legacy.get(k);
        r.amount = row && Number.isFinite(row[3]) ? Math.max(0, row[3]) : 0;
        if (r.amount <= 0) { r.dead = true; r.deadT = 9; continue; }
        // The saved position matters for herds. Matching their moved position
        // to the regenerated spawn position made deer disappear after reload.
        if (r.herd && Number.isFinite(row[1]) && Number.isFinite(row[2]) && game.isInside(row[1], row[2])) {
          r.x = r.xPrev = row[1]; r.z = r.zPrev = row[2];
          r.y = r.yPrev = game.heightAt(r.x, r.z);
        }
      }
    }
    // Reconnect standing orders only after all units, buildings and resource
    // nodes exist. Legacy saves have no order record and remain supported.
    game.resourceSpatial.clear();
    game.resourceSpatial.insertAll(game.resources);
    game.buildingSpatial.clear();
    game.buildingSpatial.insertAll(game.buildings);
    game.buildingSpatialDirty = false;
    game.refreshNav();
    game.beginPathTicks();
    const resourceByIndex = new Map(game.resources.filter(r => !r.dead).map(r => [r.worldResourceIndex, r]));
    const deref = ref => {
      if (!Array.isArray(ref) || !Number.isInteger(ref[1]) || ref[1] < 0) return null;
      if (ref[0] === 'unit') return restoredUnits[ref[1]] || null;
      if (ref[0] === 'building') return placed[ref[1]] || null;
      if (ref[0] === 'resource') return resourceByIndex.get(ref[1]) || null;
      return null;
    };
    for (let i = 0; i < restoredUnits.length; i++) {
      const u = restoredUnits[i], o = save.units[i]?.[11];
      if (!u || !o || typeof o !== 'object') continue;
      if (['aggressive', 'defensive', 'stand'].includes(o.stance)) u.stance = o.stance;
      if (o.carry && ['food', 'wood', 'gold', 'stone'].includes(o.carry.kind) && Number.isFinite(o.carry.amount) && o.carry.amount > 0)
        u.carry = { kind: o.carry.kind, amount: o.carry.amount };
      if (['food', 'wood', 'gold', 'stone'].includes(o.lastGatherKind)) u.lastGatherKind = o.lastGatherKind;
      if (u.garrisoned) continue;
      const gather = deref(o.gather), build = deref(o.build), repair = deref(o.repair), target = deref(o.target);
      const validDestination = Number.isFinite(o.destX) && Number.isFinite(o.destZ) && game.isInside(o.destX, o.destZ);
      if ((o.state === STATE.GATHER || o.state === STATE.RETURN) && (u.type === 'villager' || u.type === 'fishing_boat')) {
        if (gather && gather.resKind && gather.amount > 0) {
          u.gatherTarget = u.homeNode = gather;
          u.lastGatherKind = gather.resKind;
        }
        if (o.state === STATE.RETURN || (u.carry.amount && gather && u.carry.kind !== gather.resKind)) {
          u.returnResources();
        } else if (u.gatherTarget) game.orderGather([u], u.gatherTarget);
        else if (u.lastGatherKind) u.state = STATE.GATHER;
      } else if (o.state === STATE.BUILD && build?.kind === 'building' && !build.dead && build.team === u.team) {
        game.orderBuild([u], build);
      } else if (o.state === STATE.REPAIR && repair?.kind === 'building' && !repair.dead && repair.team === u.team) {
        game.orderRepair([u], repair);
      } else if (o.state === STATE.ATTACK && target && !target.dead && game.canFight(u.team, target.team)) {
        game.orderAttack([u], target);
      } else if (o.state === STATE.HEAL && target && !target.dead && target.team === u.team) {
        game.orderHeal([u], target);
      } else if (o.state === STATE.CONVERT && deref(o.convert)) {
        game.orderConvert([u], deref(o.convert));
        if (Number.isFinite(o.convertProgress)) u.convertProgress = Math.max(0, o.convertProgress);
      } else if (o.state === STATE.GARRISON && deref(o.garrison)) {
        game.orderGarrison([u], deref(o.garrison));
      } else if ((o.state === STATE.MOVE || o.state === STATE.ATTACK_MOVE) && validDestination) {
        if (o.state === STATE.MOVE) game.orderMove([u], o.destX, o.destZ, false);
        else game.orderAttackMove([u], o.destX, o.destZ);
      } else if (o.state === STATE.PATROL && Array.isArray(o.patrolPoints) && o.patrolPoints.length === 2 &&
        o.patrolPoints.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && game.isInside(p[0], p[1]))) {
        u.patrolPoints = o.patrolPoints.map(p => [p[0], p[1]]);
        u.patrolIdx = o.patrolIdx === 0 ? 0 : 1;
        u.state = STATE.PATROL;
        u.moveTo(...u.patrolPoints[u.patrolIdx], true);
      }
    }
    if (save.explored) restoreExplored(game, save.explored);
    /* the wheel is restored before anything reads a multiplier from it */
    if (game.calendar && save.calendar) game.calendar.fromJSON(save.calendar);
    // clearEntities clears the resource hash too; restore it before build,
    // gather and first-person interaction can query resources again.
    game.resourceSpatial.clear();
    game.resourceSpatial.insertAll(game.resources);
    game.syncIdCounter();
    game.spawnUnit && game.recomputePop();
    game.buildingSpatialDirty = true;
    game.refreshNav();
    game.statsVersion++;
  }

  /* ================= frame loop ================= */
  loop(now) {
    requestAnimationFrame(this.loop);
    this._detectRefresh(now);
    if (!this.last) this.last = now;
    /* Strict delta-time clamp. After a native onPause(), a screen lock or a
       tab switch the next rAF can be seconds late: 0.25 s of catch-up let
       units teleport across rivers and made siege physics explode. 0.05 s
       is one and a half sim ticks at 30 Hz -- the largest honest step. */
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), 0.05);
    this.last = now;
    // A restored context is rebuilt asynchronously; no GL upload or game
    // simulation may run against partially rebuilt or invalid GPU objects.
    if (this._recoveringGraphics) return;

    const g = this.game;
    /* The landscape's soundscape follows the camera: forest birds, lapping
       water and crackling fire are mixed from the actual world, not a loop
       that plays everywhere. Cheap: one query per half second. */
    if (g && this.camera) {
      this._envT = (this._envT || 0) + dt;
      if (this._envT > 0.55) {
        this._envT = 0;
        const cx = this.camera.target?.[0] || 0, cz = this.camera.target?.[2] || 0;
        const nearWater = g.world?.domainAt ? g.world.domainAt(cx, cz) : (g.heightAt(cx, cz) < 0 ? 2 : 1);
        let forest = 0, fire = 0;
        for (const f of g.world?.stealthForests || []) {
          const d = Math.hypot(f.x - cx, f.z - cz);
          if (d < f.radius + 40) forest = Math.max(forest, 1 - d / (f.radius + 40));
        }
        for (const b of g.buildings) {
          if (b.dead || b.hp > b.maxHp * 0.55) continue;
          const d = Math.hypot(b.x - cx, b.z - cz);
          if (d < 55) fire = Math.max(fire, (1 - d / 55) * (1 - b.hp / b.maxHp));
        }
        this.audio.setEnvironment?.({ forest, water: nearWater === 2 || nearWater === 3 ? 0.85 : 0.08, fire });
      }
    }
    this.audio.update(dt);
    if (!g) {
      // menu: idle rotation of the camera over a static painted backdrop
      if (this.renderer && this.renderer.ready && this.menuIdle) this.menuIdle(dt);
      return;
    }

    this.acc += this.paused ? 0 : dt;
    let steps = 0;
    /* Three steps of catch-up is the ceiling. Six was enough to turn one slow
       frame into a quarter of a second of frozen screen on a phone: the sim
       tries to make up lost time, each tick costs more because the frame is
       already late, and the catch-up itself becomes the stall. Past three the
       backlog is dropped instead -- the war runs a fraction of a second slow
       for a moment, and the player never sees it. */
    while (this.acc >= STEP && steps < 3) {
      g.update(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps >= 3) this.acc = 0;
    g.renderAlpha = this.paused ? 1 : Math.min(1, this.acc / STEP);

    if (!this.paused && !g.gameOver) for (const a of this.ais || (this.ai ? [this.ai] : [])) a.update(dt);

    // camera smoothing always runs so the view never feels stuck
    const cam = this.camera;
    if (cam) {
      if (this.settings.shake === false) cam.shake = 0;
      cam.update(dt);
    }
    if (this.input) this.input.update(dt);
    if (this._check) this._pumpDeviceCheck(dt);
    if (cam) this.audio.setListener(cam.firstPerson ? cam.eye[0] : cam.target[0], cam.firstPerson ? cam.eye[2] : cam.target[2], cam.firstPerson?.yaw ?? cam.yaw);
    if (this.fx) this.fx.update(dt);
    if (g.fowDirty && this.renderer) {
      this.pushFog(g);
      g.fowDirty = false;
    }
    /* The governor decides whether this display frame gets drawn at all.
       When the panel is 90 Hz and the scene only fits 30, rendering every
       third frame at the *panel's* pacing is smoother than rendering 30
       uneven ones -- and it gives the phone two idle-frames to breathe, which
       is what keeps the touch latency down while the camera pans. */
    const gov = this.governor;
    const drawFrame = !gov || gov.shouldRender(this.displayFrame);
    this.displayFrame = (this.displayFrame + 1) % 100000;
    /* the slow sky: one small read per frame, no allocation when the era is
       temperate (the common case for the first fifteen minutes) */
    if (this.renderer && g.climate) {
      this.climateAtmpT = (this.climateAtmpT || 0) + dt;
      if (this.climateAtmpT > 0.4) {
        this.climateAtmpT = 0;
        this.renderer.climateAtmosphere = g.climate.atmosphere();
      }
    }
    if (this.renderer && this.renderer.ready && drawFrame) {
      this.renderer.render(dt, g);
      const t = performance.now();
      if (gov && this.lastRenderMs) gov.sample(t - this.lastRenderMs);
      this.lastRenderMs = t;
    }
    if (this.ui) this.ui.update(dt);

    // ---- frame governor ---------------------------------------------------
    /* The old code here ran three separate controllers (an adaptive ladder, a
       quality ladder and a cooldown) that each watched the same median and
       fought each other. The governor owns all three levers and applies at
       most one change per step, so the picture settles instead of pulsing. */
    if (gov && gov.enabled) {
      /* A device check is a measurement, so it must not be allowed to spend
         headroom mid-run -- but it still has to be *fixed* if the scene is too
         slow, otherwise the check reports a problem instead of solving it. */
      if (this._check) gov.probeTimer = 0;
      const act = gov.update(dt);
      if (act) this._syncGovernor();
      if (this.settings.quality !== gov.tier && this.settings.autoQuality !== false) {
        this.settings.quality = gov.tier;
        if (this.menu?.state) this.menu.state.quality = gov.tier;
      }
    }
    this.statsFrames++;
    if (this.statsFrames >= 30) {
      this.statsFrames = 0;
      const sorted = this.frameTimes.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1] || 16.7;
      this.fps = 1000 / Math.max(1, med);
      this.qualityCooldown = 0;
    }

    // v5 saves workshop state, squads and protection orders as well.
    if (!this.paused && !g.gameOver) {
      this.saveTimer += dt;
      if (this.saveTimer > 60) this.saveMatch();
    }
    if (g.gameOver && this.running) this.running = false;
  }

  pushFog(g) {
    // the renderer wants a byte per cell: 0 hidden, 1 explored memory, 2 visible
    const fow = g.fow;
    const size = Math.round(Math.sqrt(fow.length));
    if (!this.fogBuf || this.fogBuf.length !== fow.length) {
      this.fogBuf = new Uint8Array(fow.length);
      this.fogTmp = new Uint8Array(fow.length);
    }
    const buf = this.fogBuf, tmp = this.fogTmp;
    for (let i = 0; i < fow.length; i++) {
      const v = fow[i];
      /* Explored ground stays almost fully lit: a three-zone brightness ramp
         (bright vision disc / dim memory / black unknown) is what made the
         town look like a spotlight on a dark field. Keeping memory near full
         brightness leaves one honest boundary -- the edge of the known world. */
      buf[i] = v === 2 ? 255 : v === 1 ? 200 : 0;
    }
    /* Two separable 3-tap blurs per axis = a 5-tap gaussian over ~24 m of
       world, which is the difference between "a soft edge of the known world"
       and "a spotlight parked on the town". 16 000 cells, twice a second. */
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < size; y++) {
        const row = y * size;
        for (let x = 0; x < size; x++) {
          const i = row + x;
          const a = buf[i - (x > 0 ? 1 : 0)], b = buf[i], c = buf[i + (x < size - 1 ? 1 : 0)];
          tmp[i] = (a + b + b + c) >> 2;
        }
      }
      for (let y = 0; y < size; y++) {
        const row = y * size;
        const up = (y > 0 ? y - 1 : y) * size, dn = (y < size - 1 ? y + 1 : y) * size;
        for (let x = 0; x < size; x++) {
          const a = tmp[up + x], b = tmp[row + x], c = tmp[dn + x];
          buf[row + x] = (a + b + b + c) >> 2;
        }
      }
    }
    this.renderer.setFog(buf, size);
  }
}

/* ================= boot ================= */
export { App };
const app = new App();
/* What exists, for the tooling: the play-test, the tour and the balance
   report all need the catalogue, and the built bundle does not export it.
   Read-only, and not on any hot path. */
app.catalogue = {
  buildings: Object.keys(BUILDING_DEFS),
  units: Object.keys(UNIT_DEFS),
  ages: AGES.length
};
window.__imperial = app;

window.addEventListener('error', (e) => {
  console.error('[imperial] uncaught', e.error || e.message);
  const tip = document.getElementById('bootStatus');
  if (tip) tip.textContent = `Error: ${e.message}`;
});

const start = () => {
  app.boot().catch((err) => {
    console.error(err);
    const s = document.getElementById('bootStatus');
    if (s) s.textContent = 'Failed to start: ' + (err && err.message);
  });
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

// tapping anywhere unlocks audio on mobile
window.addEventListener('pointerdown', () => app.audio.unlock(), { once: true });
