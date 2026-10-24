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
import { AGES, CIVS, DIFFICULTY, GAME_MODES } from './sim/data.js';
import { clamp } from './core/math.js';

/* 30 Hz simulation, 60+ Hz rendering. An RTS does not need 60 sim ticks a
   second -- AoE2 ran at 20 -- and halving the rate halves the CPU the
   simulation steals from the frame. The renderer interpolates between the two
   most recent ticks, so nothing looks stepped. */
const STEP = 1 / 30;
const SAVE_VERSION = 3;

const DEFAULT_SETTINGS = {
  quality: 'medium', autoQuality: true, music: true, sound: true, fog: true, shake: true, showBars: true
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('imperial-crown-settings');
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
    this.audio = new Audio({ enabled: this.settings.sound, music: this.settings.music });
    this.renderer = null;
    this.game = null;
    this.ai = null;
    this.camera = null;
    this.ui = null;
    this.input = null;
    this.fx = null;
    this.paused = false;
    this.running = false;
    this.last = 0;
    this.acc = 0;
    this.frameTimes = [];
    this.qualityCooldown = 0;
    this.saveTimer = 0;
    this.statsFrames = 0;
    this.fps = 60;
    this.matchOpts = null;
    this.menu = new Menu({
      audio: this.audio,
      quality: this.settings.quality,
      onStart: (opts) => this.startMatch(opts),
      onSettingsChanged: (state) => this.applySettings(state)
    });
  }

  async boot() {
    this.menu.bind();
    this.menu.showBoot();
    this.menu.bootTip('Preparing the forge…');
    this.menu.bootProgress(0.02, 'Waking the empire…');
    // keep the boot screen animated while the GL layer compiles
    await new Promise((r) => requestAnimationFrame(r));

    this.renderer = new Renderer(this.canvas, { quality: this.settings.quality });
    if (!this.renderer.ok) {
      this.menu.bootProgress(1, 'WebGL2 is not available on this device.');
      this.menu.openModal('HARDWARE', 'WebGL2 required',
        '<p>This browser could not create a WebGL2 context. Chrome on Android 10+ supports it. ' +
        'Try updating Chrome or enabling hardware acceleration.</p>');
      return;
    }
    try {
      await this.renderer.init((label, frac) => this.menu.bootProgress(frac, label));
    } catch (err) {
      console.error(err);
      this.menu.bootProgress(1, 'The renderer failed to start.');
      this.menu.openModal('HARDWARE', 'Renderer error',
        `<p class="dim">${String(err && err.message || err)}</p>`);
      return;
    }
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
        this.prevPaused = this.paused;
        if (this.running) { this.paused = true; this.audio.suspend(); }
      } else {
        this.audio.resume();
        if (this.running && !this.prevPaused) this.paused = false;
      }
    });
    this.onResize();
  }

  hardwareLine() {
    const r = this.renderer && this.renderer.gl ? this.renderer.gl.__renderer : 'WebGL2';
    const short = String(r).replace(/ANGLE \(|\)|Direct3D11|vs_5_0|ps_5_0/g, '').trim().slice(0, 42);
    return `GPU: ${short || 'unknown'} · ${this.settings.quality} quality`;
  }

  onResize() {
    if (!this.renderer) return;
    this.renderer.resize();
    if (this.camera) {
      const vw = this.canvas.clientWidth || window.innerWidth;
      const vh = this.canvas.clientHeight || window.innerHeight;
      this.camera.setAspect(vw / Math.max(1, vh));
      this.camera.setViewport(vw, vh);
    }
    const portrait = window.innerHeight > window.innerWidth * 1.1;
    document.getElementById('rotateHint')?.classList.toggle('hidden', !portrait || !this.running);
  }

  applySettings(state) {
    this.settings = { ...this.settings, ...state };
    try { localStorage.setItem('imperial-crown-settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
    if (this.renderer) this.renderer.setQuality(this.settings.quality);
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
    this.matchOpts = opts;
    this.menu.closeModal();
    this.menu.hideMenu();
    this.menu.hideBoot();
    document.getElementById('endScreen')?.classList.add('hidden');
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('bootScreen')?.classList.remove('hidden');
    this.menu.bootProgress(0.05, 'Surveying the land…');
    this.menu.bootTip('Generating terrain, forests and mines…');
    await new Promise((r) => requestAnimationFrame(r));

    const seed = (opts.seed | 0) || 20261;
    const t0 = performance.now();
    const world = generateWorld(seed);
    this.menu.bootProgress(0.4, 'Settling villages…');

    const fx = new FX();
    const sound = {
      play: (name, o) => this.audio.play(name, o)
    };
    const game = new Game({
      world,
      civ: opts.civ,
      mode: opts.mode,
      difficulty: opts.difficulty,
      fx,
      sound,
      rand: Math.random
    });
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
    camera.worldHalf = 256;
    camera.setAspect((this.canvas.clientWidth || window.innerWidth || 900) / Math.max(1, this.canvas.clientHeight || window.innerHeight || 420));
    camera.setTarget(world.playerBase.x + 6, world.playerBase.z + 10, true);
    game.camera = camera;

    this.renderer.buildWorld(world);
    this.menu.bootProgress(0.7, 'Laying foundations…');
    await new Promise((r) => requestAnimationFrame(r));

    game.start();
    this.menu.bootProgress(0.86, 'Raising banners…');
    await new Promise((r) => requestAnimationFrame(r));

    // apply a saved campaign on top of the fresh world
    if (opts.load) this.applySave(game, opts.load);

    /* Sandbox has no opponent: team 2 is never set up, so an AI controller
       there has no base to defend and would grab any team-2 unit that appeared
       (a spawned raid, a scenario) and march it across the map. */
    const ai = opts.mode === 'sandbox' ? null : new AIController(game, 2, {
      aggression: DIFFICULTY[opts.difficulty]?.aggression ?? 0.85
    });
    this.fx = fx;
    this.game = game;
    this.ai = ai;
    this.camera = camera;
    this.menu.hideBoot();
    document.getElementById('hud')?.classList.remove('hidden');

    const ui = new UI({
      game, renderer: this.renderer, camera, audio: this.audio, menu: this.menu,
      app: { togglePause: () => this.togglePause(), openPause: () => this.openPause(), quit: () => this.quitToMenu() }
    });
    const input = new Input({ canvas: this.canvas, game, camera, ui, audio: this.audio });
    ui.input = input;
    input.ui = ui;
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
    this.qualityCooldown = 2;
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

  openPause() {
    if (!this.running) return;
    this.paused = true;
    const g = this.game;
    const t = g.teams.get(1);
    this.menu.openModal('CAMPAIGN', 'Paused', `
      <div class="metricRow"><span>Age</span><b>${AGES[t.age].name}</b></div>
      <div class="metricRow"><span>Army</span><b>${g.units.filter((u) => !u.dead && u.team === 1 && u.def.attack > 0 && !u.def.classes.includes('villager')).length}</b></div>
      <div class="metricRow"><span>Villagers</span><b>${g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager').length}</b></div>
      <div class="metricRow"><span>Population</span><b>${t.popUsed} / ${t.popCap}</b></div>
      <div class="row" style="margin-top:10px;gap:6px;display:flex;flex-wrap:wrap">
        <button class="ghostBtn" data-act="resume"><svg class="ic"><use href="#i-play"/></svg> Resume</button>
        <button class="ghostBtn" data-act="save"><svg class="ic"><use href="#i-save"/></svg> Save</button>
        <button class="ghostBtn" data-act="settings"><svg class="ic"><use href="#i-cog"/></svg> Settings</button>
        <button class="ghostBtn" data-act="restart"><svg class="ic"><use href="#i-load"/></svg> Restart</button>
        <button class="ghostBtn" data-act="quit"><svg class="ic"><use href="#i-home"/></svg> Quit</button>
      </div>`,
      '<span class="dim tiny">Tip: the game auto-saves every minute.</span>');
    const body = document.getElementById('modalBody');
    body?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'resume') { this.paused = false; this.menu.closeModal(); }
      else if (act === 'save') { this.saveMatch(); this.ui?.toast('Campaign saved', 'good'); }
      else if (act === 'settings') this.menu.openSettings();
      else if (act === 'restart') { this.menu.closeModal(); this.startMatch(this.matchOpts); }
      else if (act === 'quit') this.quitToMenu();
    });
  }

  quitToMenu() {
    this.running = false;
    this.paused = false;
    this.menu.closeModal();
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('rotateHint')?.classList.add('hidden');
    document.getElementById('endScreen')?.classList.add('hidden');
    this.game = null;
    this.ai = null;
    this.ui = null;
    this.menu.showMenu();
    this.audio.stopMusic?.();
    this.audio.startMusic?.();
  }

  /* ================= save / load ================= */
  saveMatch() {
    const g = this.game;
    if (!g) return false;
    const data = {
      version: SAVE_VERSION,
      seed: g.world.seed,
      civ: g.civ,
      mode: g.mode,
      difficulty: g.difficultyKey,
      time: g.time,
      worldTime: g.worldTime,
      /* Both sides. Saving only the player's economy meant a reload handed
         the AI a brand-new Dark Age town while the player kept Castle Age --
         a free win that also made the enemy look broken. */
      teams: { 1: g.exportTeam(1), 2: g.exportTeam(2) },
      wonder: [...g.wonderClocks.entries()],
      units: g.units.filter((u) => !u.dead).map((u) => [u.type, u.team, Math.round(u.x * 10) / 10, Math.round(u.z * 10) / 10, Math.round(u.hp)]),
      buildings: g.buildings.filter((b) => !b.dead).map((b) => [b.type, b.team, Math.round(b.x * 10) / 10, Math.round(b.z * 10) / 10, Math.round(b.hp), b.buildProgress, b.facing || 0]),
      resources: g.resources.filter((r) => !r.dead).map((r) => [r.type, Math.round(r.x * 10) / 10, Math.round(r.z * 10) / 10, Math.round(r.amount), r.variant || 0])
    };
    const ok = Menu.writeSave(data);
    this.saveTimer = 0;
    return ok;
  }

  applySave(game, save) {
    if (!save || save.version !== SAVE_VERSION) return;
    /* Clean removal, not array truncation: footprints and spatial hashes have
       to come out with the entities or the reloaded map is subtly poisoned. */
    game.clearEntities();
    game.time = save.time || 0;
    game.elapsed = save.time || 0;
    game.worldTime = save.worldTime || 8.6;

    for (const team of [1, 2]) {
      const t = save.teams?.[team];
      if (t) game.importTeam(team, t);
    }
    game.wonderClocks = new Map((save.wonder || []).filter(([team]) => team === 1 || team === 2));

    for (const [type, team, x, z, hp, prog, facing] of save.buildings || []) {
      if (team !== 1 && team !== 2) continue;   // neutral shrines regenerate with the world
      const b = game.placeBuilding(type, team, x, z, { instant: true, free: true, facing });
      if (b) {
        b.hp = Math.min(b.maxHp, hp);
        b.buildProgress = prog ?? 1;
        if (b.buildProgress >= 1) game.onBuildingComplete(b);
      }
    }
    for (const [type, team, x, z, hp] of save.units || []) {
      if (team !== 1 && team !== 2) continue;
      const u = game.spawnUnit(type, team, x, z);
      if (u) { u.maxHp = Math.max(u.maxHp, hp); u.hp = Math.min(u.maxHp, hp); }
    }
    if (save.resources) {
      const map = new Map();
      for (const [type, x, z, amount] of save.resources) map.set(`${Math.round(x)},${Math.round(z)},${type}`, amount);
      for (const r of game.resources) {
        const k = `${Math.round(r.x)},${Math.round(r.z)},${r.type}`;
        if (map.has(k)) { r.amount = map.get(k); if (r.amount <= 0) { r.dead = true; r.deadT = 9; } }
      }
    }
    game.spawnUnit && game.recomputePop();
    game.buildingSpatialDirty = true;
    game.refreshNav();
    game.statsVersion++;
  }

  /* ================= frame loop ================= */
  loop(now) {
    requestAnimationFrame(this.loop);
    if (!this.last) this.last = now;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.25) dt = 0.25;
    if (dt <= 0) dt = 1 / 60;

    const g = this.game;
    this.audio.update(dt);
    if (!g) {
      // menu: idle rotation of the camera over a static painted backdrop
      if (this.renderer && this.renderer.ready && this.menuIdle) this.menuIdle(dt);
      return;
    }

    this.acc += this.paused ? 0 : dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 6) {
      g.update(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps >= 6) this.acc = 0;
    g.renderAlpha = this.paused ? 1 : Math.min(1, this.acc / STEP);

    if (this.ai && !this.paused && !g.gameOver) this.ai.update(dt);

    // camera smoothing always runs so the view never feels stuck
    const cam = this.camera;
    if (cam) {
      if (this.settings.shake === false) cam.shake = 0;
      cam.update(dt);
    }
    if (this.input) this.input.update(dt);
    if (cam) this.audio.setListener(cam.target[0], cam.target[2], cam.yaw);
    if (this.fx) this.fx.update(dt);
    if (g.fowDirty && this.renderer) {
      this.pushFog(g);
      g.fowDirty = false;
    }
    if (this.renderer && this.renderer.ready) this.renderer.render(dt, g);
    if (this.ui) this.ui.update(dt);

    // ---- adaptive quality -------------------------------------------------
    // Median frame time over ~1.5 s, with hysteresis: step down when we miss
    // 60 fps consistently, step back up when we have plenty of headroom. A
    // single GC spike must never downgrade the game, and a downgrade must not
    // be undone the moment the camera stops moving.
    this.frameTimes.push(Math.min(200, dt * 1000));
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.statsFrames++;
    if (this.statsFrames >= 30) {
      this.statsFrames = 0;
      const sorted = this.frameTimes.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1] || 16.7;
      this.fps = 1000 / Math.max(1, med);
      this.qualityCooldown -= 0.5;
      if (this.settings.autoQuality !== false && this.renderer && this.renderer.ready && this.frameTimes.length > 45) {
        /* Three levers, applied in order of least visible change:
             1. render scale (adaptive, 1.0 -> 0.8): invisible on a 400 ppi
                phone screen, and it is the only lever that removes work
                without touching the look
             2. the quality ladder (shadow size, cull distances, particles)
             3. nothing -- we never drop below 0.8 scale
           v2 jumped straight from "high" to "low" on the first bad second,
           which is why the game could go from beautiful to ugly mid-battle. */
        this.renderer.adapt(med);
        const r = this.renderer;
        if (this.qualityCooldown <= 0 && med > 24 && r.adaptiveScale <= 0.801 && r.scale > 0.999) {
          const ladder = ['low', 'medium', 'high', 'ultra'];
          const idx = ladder.indexOf(r.qualityName);
          if (idx > 0) {
            const next = ladder[idx - 1];
            this.qualityCooldown = 12;
            this.settings.quality = next;
            r.setQuality(next);
            this.ui?.toast(`Graphics set to ${next === 'medium' ? 'balanced' : next} for smoother play`, 'warn');
          }
        }
      }
    }

    // autosave
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
