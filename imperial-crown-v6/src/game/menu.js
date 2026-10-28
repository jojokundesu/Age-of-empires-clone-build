/* ============================================================
   menu.js — boot screen, campaign menu and the settings modal
   The menu paints its own "campaign preview" with canvas 2D, so the
   game still has no external assets at all.
   ============================================================ */
import { CIVS, DIFFICULTY, GAME_MODES, VICTORIES } from '../sim/data.js';
import { mulberry32, clamp } from '../core/math.js';

const AREAS = {
  franks: ['The Rhine Frontier', 'Vineyards and stone keeps along a cold river. Your knights hold the ford.'],
  britons: ['The Weald of Kent', 'Rain, oak and longbows. Every hedgerow hides an archer.'],
  byzantines: ['The Golden Horn', 'Walls within walls, and fire that burns on water.'],
  goths: ['The Black Forest', 'No siege engines. No mercy. Only more axes.'],
  persians: ['The Royal Road', 'Dust, elephants and a road that leads to the sun.'],
  japanese: ['The Cherry Coast', 'A quiet bay, a shrine, and a promise of war.'],
  mongols: ['The Endless Steppe', 'Grass to the horizon and riders who never dismount.'],
  vikings: ['The Frozen Fjord', 'Longships beached on black sand. The raiders are home.']
};

export class Menu {
  /* The save format is the one handshake between a running match and the
     menu. Bump it whenever a saved field changes meaning; the menu refuses
     anything else rather than half-loading a war it does not understand. */
  static SAVE_VERSION = 6;
  constructor(opts) {
    this.onStart = opts.onStart || (() => {});
    this.onSettingsChanged = opts.onSettingsChanged || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.audio = opts.audio || null;
    this.state = {
      mode: 'campaign',
      civ: 'franks',
      difficulty: 'hard',
      victory: 'conquest',
      kingdoms: 3,
      seed: 20261,
      quality: opts.quality || 'medium',
      music: true,
      sound: true,
      fog: true,
      shake: true,
      showBars: true,
      /* first-person feel — read live by the direct-control layer. The
         defaults are the ones a phone wants: generous look, no inversion,
         auto-swing so one thumb can steer, and a buzz when a blow lands. */
      lookSensitivity: 1,
      invertLookY: false,
      swapSticks: false,
      headBob: true,
      autoAttack: true,
      haptics: true,
      buttonSize: 'comfortable',
      /* Workshop content in the sandbox, on by default: the sandbox is where
         you go to *try* things, and a mod is a thing to try. */
      sandboxMods: true,
      mods: Menu.readMods()
    };
    this.el = {
      boot: document.getElementById('bootScreen'),
      bootBar: document.getElementById('bootBarFill'),
      bootStatus: document.getElementById('bootStatus'),
      bootTip: document.getElementById('bootTip'),
      menu: document.getElementById('menuScreen'),
      modeGrid: document.querySelector('.modeGrid'),
      civGrid: document.getElementById('civGrid'),
      civBrief: document.getElementById('civBrief'),
      diffRow: document.getElementById('diffRow'),
      victoryRow: document.getElementById('victoryRow'),
      victoryBrief: document.getElementById('victoryBrief'),
      kingdomRow: document.getElementById('kingdomRow'),
      sandboxModsRow: document.getElementById('sandboxModsRow'),
      seed: document.getElementById('seedInput'),
      reroll: document.getElementById('btnRerollSeed'),
      start: document.getElementById('btnStart'),
      startSub: document.getElementById('startSub'),
      art: document.getElementById('menuArtCanvas'),
      artTitle: document.getElementById('artTitle'),
      artDesc: document.getElementById('artDesc'),
      btnLoad: document.getElementById('btnLoad'),
      btnMods: document.getElementById('btnMods'),
      modCount: document.getElementById('modCount'),
      btnSettings: document.getElementById('btnSettings'),
      btnHelp: document.getElementById('btnHelp'),
      menuPerf: document.getElementById('menuPerf'),
      rotate: document.getElementById('rotateHint'),
      modal: document.getElementById('modalScreen'),
      modalKicker: document.getElementById('modalKicker'),
      modalTitle: document.getElementById('modalTitle'),
      modalTabs: document.getElementById('modalTabs'),
      modalBody: document.getElementById('modalBody'),
      modalFoot: document.getElementById('modalFoot'),
      modalClose: document.getElementById('modalClose')
    };
    this._bound = false;
  }

  bind() {
    if (this._bound) return this;
    this._bound = true;
    const el = this.el;
    el.modeGrid?.addEventListener('click', (e) => {
      const card = e.target.closest('.modeCard');
      if (!card) return;
      this.state.mode = card.dataset.mode;
      for (const c of el.modeGrid.querySelectorAll('.modeCard')) c.classList.toggle('active', c === card);
      if (this.state.mode === 'sandbox') this.state.difficulty = 'sandbox';
      this._syncDiff();
      this._syncVictory();
      this._syncSummary();
      this.audio?.play('click');
    });
    el.victoryRow?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      this.state.victory = b.dataset.victory;
      this._syncVictory();
      this._syncSummary();
      this.audio?.play('click');
    });
    el.kingdomRow?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      this.state.kingdoms = parseInt(b.dataset.kingdoms, 10) || 3;
      this._syncVictory();
      this._syncSummary();
      this.audio?.play('click');
    });
    el.sandboxModsRow?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sandboxmods]');
      if (!b) return;
      this.state.sandboxMods = b.dataset.sandboxmods === '1';
      for (const seg of el.sandboxModsRow.querySelectorAll('.seg')) seg.classList.toggle('active', seg === b);
      this.audio?.play('click');
      this._syncSummary();
    });
    el.diffRow?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      this.state.difficulty = b.dataset.diff;
      this._syncDiff();
      this._syncSummary();
      this.audio?.play('click');
    });
    el.reroll?.addEventListener('click', () => {
      this.state.seed = (Math.random() * 999999) | 0;
      if (el.seed) el.seed.value = String(this.state.seed);
      this._paintArt();
      this.audio?.play('click');
    });
    el.seed?.addEventListener('input', () => {
      const v = parseInt(el.seed.value.replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(v)) { this.state.seed = v; this._paintArt(); }
    });
    el.start?.addEventListener('click', () => {
      this.audio?.unlock();
      this.audio?.play('horn');
      this._matchStarting = true;
      this.hideMenu();
      const opts = { ...this.state };
      /* A sandbox with Workshop mods enabled starts exactly like a mod
         session, only with the sandbox's economy and no opponent. */
      if (this.state.mode === 'sandbox' && this.state.sandboxMods) {
        opts.mods = this.enabledMods();
      }
      this.onStart(opts);
    });
    el.btnSettings?.addEventListener('click', () => this.openSettings());
    el.btnMods?.addEventListener('click', () => this.openMods());
    el.btnHelp?.addEventListener('click', () => this.openHelp());
    el.btnLoad?.addEventListener('click', () => {
      const save = Menu.readSave();
      if (!save) { this.openModal('SAVED CAMPAIGN', 'Nothing to load', '<p class="dim">No saved campaign was found on this device. Start a new one and use Menu → Save Game.</p>'); return; }
      this.hideMenu();
      this.onStart({ ...this.state, load: save });
    });
    el.modalClose?.addEventListener('click', () => this.closeModal());
    el.modal?.addEventListener('click', (e) => { if (e.target.dataset.close) this.closeModal(); });
    this._buildCivGrid();
    this._syncDiff();
    this._syncVictory();
    this._syncSummary();
    this._paintArt();
    this._tips = [
      'Spearmen shred cavalry. Archers shred spearmen. Cavalry shred archers.',
      'Every Town Centre accepts resources — build farms near one.',
      'Farms reseed themselves. Wood regrows. Gold does not.',
      'Long-press the ground to attack-move your army.',
      'Pinch to zoom, twist two fingers to rotate the camera.',
      'Imperial Favour buys Decrees: harvest booms, war drums, cheap levies.',
      'Houses raise your population cap. Build them before you need them.',
      'Garrison villagers inside the Town Centre when raiders arrive.'
    ];
    return this;
  }

  _buildCivGrid() {
    const grid = this.el.civGrid;
    if (!grid) return;
    grid.textContent = '';
    for (const [key, civ] of Object.entries(CIVS)) {
      const b = document.createElement('button');
      b.className = 'civChip' + (key === this.state.civ ? ' active' : '');
      b.dataset.civ = key;
      b.innerHTML = `<svg class="ic"><use href="#i-${iconFor(civ.icon)}"/></svg><span>${civ.name}</span>`;
      b.addEventListener('click', () => {
        this.state.civ = key;
        for (const c of grid.children) c.classList.toggle('active', c === b);
        this._syncSummary();
        this._paintArt();
        this.audio?.play('click');
      });
      grid.appendChild(b);
    }
  }

  _syncDiff() {
    const row = this.el.diffRow;
    if (!row) return;
    for (const b of row.children) b.classList.toggle('active', b.dataset.diff === this.state.difficulty);
  }

  /* The terms of war. The row is always visible; the crown count only
     matters in a War of Crowns, so it is hidden in a duel and the brief
     line explains what the chosen condition actually asks of the player. */
  _syncVictory() {
    const el = this.el;
    /* A mode that is already defined by its terms locks them: there is no
       such thing as a wonder race won by conquest, or a regicide match with
       no king. Campaign and War of Crowns leave the choice to the player. */
    const forced = this.state.mode === 'regicide' ? 'regicide'
      : this.state.mode === 'wonder' ? 'wonder'
        : this.state.mode === 'sandbox' || this.state.mode === 'mods' ? null
          : VICTORIES[this.state.victory] ? this.state.victory : 'conquest';
    if (forced) this.state.victory = forced;
    const v = VICTORIES[this.state.victory] || VICTORIES.conquest;
    document.body.classList.toggle('mode-kingdoms', this.state.mode === 'kingdoms');
    const locked = forced === 'regicide' || forced === 'wonder';
    if (el.victoryRow) {
      el.victoryRow.classList.toggle('locked', locked);
      el.victoryRow.classList.toggle('hidden', this.state.mode === 'sandbox' || this.state.mode === 'mods');
    }
    for (const b of el.victoryRow ? el.victoryRow.querySelectorAll('.seg') : []) {
      b.classList.toggle('active', b.dataset.victory === this.state.victory);
    }
    for (const b of el.kingdomRow ? el.kingdomRow.querySelectorAll('.seg') : []) {
      b.classList.toggle('active', parseInt(b.dataset.kingdoms, 10) === this.state.kingdoms);
    }
    if (el.sandboxModsRow) {
      el.sandboxModsRow.classList.toggle('hidden', this.state.mode !== 'sandbox');
      for (const b of el.sandboxModsRow.querySelectorAll('[data-sandboxmods]')) {
        b.classList.toggle('active', (b.dataset.sandboxmods === '1') === !!this.state.sandboxMods);
      }
    }
    if (el.victoryBrief) {
      const crowns = this.state.mode === 'kingdoms' ? this.state.kingdoms : 2;
      const lines = [`<b>${v.name}</b> — ${v.desc}`];
      if (this.state.mode === 'kingdoms') {
        lines.push(`${crowns} crowns. A fallen kingdom's treasury, learning, standing bonuses and surviving soldiers pass to the crown that broke it.`);
      }
      el.victoryBrief.innerHTML = lines.join(' ');
    }
  }

  _syncSummary() {
    const el = this.el;
    const civ = CIVS[this.state.civ];
    const mode = GAME_MODES[this.state.mode];
    const diff = DIFFICULTY[this.state.difficulty];
    if (el.civBrief) {
      el.civBrief.innerHTML = `<b>${civ.uniqueName}</b> · ${civ.bonus}<br><span class="dim">${civ.story}</span>`;
    }
    const modCount = this.enabledMods().length;
    if (el.startSub) {
      const terms = VICTORIES[this.state.victory] || VICTORIES.conquest;
      const crowns = this.state.mode === 'kingdoms' ? ` · ${this.state.kingdoms} crowns` : '';
      const modsOn = this.state.mode === 'sandbox' ? (this.state.sandboxMods ? modCount : 0) : modCount;
      el.startSub.textContent = `${civ.name} · ${diff.name} · ${modsOn ? `${modsOn} mod${modsOn === 1 ? '' : 's'}` : mode.name}${crowns} · ${terms.name}`;
    }
    if (el.modCount) {
      el.modCount.textContent = String(modCount);
      el.modCount.classList.toggle('hidden', modCount === 0);
    }
    if (el.btnMods) el.btnMods.classList.toggle('active', modCount > 0);
    if (el.artTitle) el.artTitle.textContent = AREAS[this.state.civ]?.[0] || 'The Frontier';
    if (el.artDesc) el.artDesc.textContent = AREAS[this.state.civ]?.[1] || '';
    if (el.menuPerf) el.menuPerf.textContent = `WebGL2 · ${this.state.quality}`;
  }

  /* A painted campaign card: layered hills, keep silhouette and weather. */
  _paintArt() {
    const cv = this.el.art;
    if (!cv) return;
    const w = cv.width, h = cv.height;
    const g = cv.getContext('2d');
    if (!g) return;
    const civ = CIVS[this.state.civ];
    const rng = mulberry32(this.state.seed + this.state.civ.length * 977);
    const tint = civ.color || '#5b7ee0';
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1a2436');
    sky.addColorStop(0.42, '#3c4b5e');
    sky.addColorStop(0.62, '#7d7a68');
    sky.addColorStop(1, '#2a241c');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // sun / moon glow
    const sunX = w * (0.24 + rng() * 0.5), sunY = h * (0.3 + rng() * 0.12);
    const glow = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, w * 0.5);
    glow.addColorStop(0, 'rgba(255,232,178,0.85)');
    glow.addColorStop(0.18, 'rgba(255,190,110,0.34)');
    glow.addColorStop(1, 'rgba(255,160,80,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    // layered ridgelines
    const layers = 5;
    const horizon = h * 0.58;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const base = horizon + t * h * 0.36;
      const amp = 30 + i * 16;
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, base);
      for (let x = 0; x <= w; x += 12) {
        const n = Math.sin(x * 0.006 + i * 2.4) * amp * 0.5 + Math.sin(x * 0.017 + i) * amp * 0.3 + Math.sin(x * 0.041 + i * 3.1) * amp * 0.16;
        g.lineTo(x, base - n);
      }
      g.lineTo(w, h);
      g.closePath();
      const shade = Math.round(58 - t * 34);
      g.fillStyle = `rgb(${shade + 8},${shade + 4},${shade - 6})`;
      g.fill();
    }

    // river / lake ribbon
    g.beginPath();
    const yMid = h * 0.78;
    g.moveTo(0, yMid + 40);
    for (let x = 0; x <= w; x += 16) {
      g.lineTo(x, yMid + Math.sin(x * 0.008 + 1.4) * 22 + Math.sin(x * 0.03) * 6);
    }
    g.lineTo(w, yMid + 90);
    g.lineTo(0, yMid + 110);
    g.closePath();
    const water = g.createLinearGradient(0, yMid, 0, h);
    water.addColorStop(0, 'rgba(120,160,180,0.55)');
    water.addColorStop(1, 'rgba(40,60,72,0.8)');
    g.fillStyle = water;
    g.fill();

    // castle silhouette on the ridge
    const cx = w * (0.58 + rng() * 0.12);
    const cy = horizon + 6;
    const scale = 1 + rng() * 0.25;
    g.save();
    g.translate(cx, cy);
    g.scale(scale, scale);
    g.fillStyle = 'rgba(18,16,14,0.88)';
    g.fillRect(-90, -50, 180, 62);
    for (let i = 0; i < 9; i++) g.fillRect(-90 + i * 20, -62, 11, 16);
    g.fillRect(-124, -84, 40, 96);
    g.fillRect(86, -84, 40, 96);
    for (let i = 0; i < 4; i++) { g.fillRect(-124 + i * 11, -96, 6, 14); g.fillRect(86 + i * 11, -96, 6, 14); }
    g.beginPath(); g.moveTo(-124, -84); g.lineTo(-104, -126); g.lineTo(-84, -84); g.fill();
    g.beginPath(); g.moveTo(86, -84); g.lineTo(106, -126); g.lineTo(126, -84); g.fill();
    g.fillRect(-26, -110, 52, 62);
    for (let i = 0; i < 3; i++) g.fillRect(-26 + i * 20, -120, 11, 14);
    // gate glow
    g.fillStyle = 'rgba(255,196,96,0.55)';
    g.fillRect(-10, -18, 20, 30);
    g.restore();

    // banner colour wash
    g.fillStyle = tint;
    g.globalAlpha = 0.10;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;

    // snow / rain / motes
    for (let i = 0; i < 220; i++) {
      const x = rng() * w, y = rng() * h * 0.85;
      g.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.18})`;
      const s = 0.6 + rng() * 1.7;
      g.fillRect(x, y, s, s);
    }
    // vignette
    const vig = g.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.5, h * 0.86);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.72)');
    g.fillStyle = vig;
    g.fillRect(0, 0, w, h);
  }

  /* ---------------- boot ---------------- */
  showBoot() {
    this.el.boot?.classList.remove('hidden');
    this.el.menu?.classList.add('hidden');
  }
  bootProgress(frac, label) {
    const el = this.el;
    if (el.bootBar) el.bootBar.style.width = `${clamp(frac, 0, 1) * 100}%`;
    if (el.bootStatus && label) el.bootStatus.textContent = label;
  }
  bootTip(text) { if (this.el.bootTip) this.el.bootTip.textContent = text; }
  bootDone() {
    this.el.boot?.classList.add('hidden');
    /* A match that started while the boot overlay was still up (an impatient
       tap, a slow texture compile) must not have the menu dropped on top of
       it when the boot finally finishes. */
    if (!this.state || !this._matchStarting) this.el.menu?.classList.remove('hidden');
    const tip = this._tips ? this._tips[(Math.random() * this._tips.length) | 0] : '';
    this.bootTip(tip);
  }
  hideBoot() { this.el.boot?.classList.add('hidden'); }
  hideMenu() { this.el.menu?.classList.add('hidden'); }
  showMenu() {
    this._matchStarting = false;
    this.el.menu?.classList.remove('hidden');
    this._syncSummary();
    this._paintArt();
  }

  /* ---------------- modals ---------------- */
  openModal(kicker, title, html, foot = '') {
    const el = this.el;
    if (!el.modal) return;
    if (el.modalKicker) el.modalKicker.textContent = kicker;
    if (el.modalTitle) el.modalTitle.textContent = title;
    if (el.modalBody) { el.modalBody.onclick = null; el.modalBody.innerHTML = html; }
    if (el.modalFoot) el.modalFoot.innerHTML = foot;
    el.modalTabs && (el.modalTabs.innerHTML = '');
    el.modal.classList.remove('hidden');
    this.audio?.play('click');
  }
  closeModal() { const wasOpen = this.isModalOpen(); this.el.modal?.classList.add('hidden'); if (wasOpen) this.onClose(); }
  isModalOpen() { return !!this.el.modal && !this.el.modal.classList.contains('hidden'); }

  /* ---------------- Mod Workshop ----------------
     The catalogue is imported *lazily*: a normal campaign never loads a byte
     of mod code, and the workshop is one dynamic import away. */
  enabledMods() {
    return Object.keys(this.state.mods || {}).filter((id) => this.state.mods[id]);
  }

  async openMods() {
    let catalogue;
    try {
      const mods = await import('../mods/index.js');
      catalogue = mods.modCatalogue();
    } catch (e) {
      this.openModal('MOD WORKSHOP', 'Mods unavailable',
        '<p class="dim">The mod catalogue could not be loaded on this device. The normal game is unaffected.</p>');
      return;
    }
    const mods = this.state.mods || {};
    const cards = catalogue.map((m) => `
      <div class="modCard ${mods[m.id] ? 'on' : ''}" data-mod="${m.id}">
        <div class="modHead">
          <svg class="ic"><use href="#i-${iconFor(m.icon)}"/></svg>
          <div style="flex:1 1 auto"><b>${m.name}</b><small>${m.tagline}</small></div>
          <button class="modToggle ${mods[m.id] ? 'on' : ''}" data-toggle="${m.id}">${mods[m.id] ? 'ON' : 'OFF'}</button>
        </div>
        <div class="modBody">
          <div>${m.blurb}</div>
          <ul>${m.detail.map((d) => `<li>${d}</li>`).join('')}</ul>
          <div class="modTags">${[...m.units, ...m.buildings].map((n) => `<span class="modTag">${n}</span>`).join('')}</div>
        </div>
      </div>`).join('');
    this.openModal('MOD WORKSHOP', 'Bend the rules', `
      <div class="modIntro">
        Mods are <b>opt-in</b>: enable them here, then use <b>Start mod session</b> — or leave the
        set enabled and play a <b>Grand Sandbox</b>, which now carries them too. A normal campaign is
        never touched.
        Each one is isolated: if a mod ever misbehaves it disables itself and the match goes on.
        Turn on as many as you like — they are designed to work together.
      </div>
      <div class="modList" id="modList">${cards}</div>
    `, `
      <div class="modFoot">
        <span class="modWarn" id="modWarn">${this.enabledMods().length ? `${this.enabledMods().length} mod(s) ready` : 'No mods enabled yet'} · the normal game stays untouched</span>
        <button class="ghostBtn" id="modAll">Toggle all</button>
        <button class="startBtn small" id="modStart"><span>START MOD SESSION</span><small id="modStartSub"></small></button>
      </div>
    `);
    const body = this.el.modal;
    const sync = () => {
      const n = this.enabledMods().length;
      const warn = body.querySelector('#modWarn');
      if (warn) warn.textContent = n ? `${n} mod${n === 1 ? '' : 's'} enabled · the normal game stays untouched` : 'No mods enabled yet · the normal game stays untouched';
      const sub = body.querySelector('#modStartSub');
      if (sub) {
        const civ = CIVS[this.state.civ];
        sub.textContent = `${civ.name} · ${DIFFICULTY[this.state.difficulty].name} · ${n} mod${n === 1 ? '' : 's'}`;
      }
      Menu.writeMods(this.state.mods);
      this._syncSummary();
    };
    body.querySelector('#modList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle]');
      const card = e.target.closest('.modCard');
      if (!card) return;
      const id = card.dataset.mod;
      if (!btn) return;              // clicking the body only reads
      this.state.mods[id] = !this.state.mods[id];
      card.classList.toggle('on', !!this.state.mods[id]);
      btn.classList.toggle('on', !!this.state.mods[id]);
      btn.textContent = this.state.mods[id] ? 'ON' : 'OFF';
      this.audio?.play('click');
      sync();
    });
    body.querySelector('#modAll')?.addEventListener('click', () => {
      const anyOff = catalogue.some((m) => !this.state.mods[m.id]);
      for (const m of catalogue) this.state.mods[m.id] = anyOff;
      for (const card of body.querySelectorAll('.modCard')) {
        const on = !!this.state.mods[card.dataset.mod];
        card.classList.toggle('on', on);
        const b = card.querySelector('.modToggle');
        if (b) { b.classList.toggle('on', on); b.textContent = on ? 'ON' : 'OFF'; }
      }
      this.audio?.play('click');
      sync();
    });
    body.querySelector('#modStart')?.addEventListener('click', () => {
      const ids = this.enabledMods();
      if (!ids.length) {
        const warn = body.querySelector('#modWarn');
        if (warn) warn.textContent = 'Turn on at least one mod first — or close this and play a normal campaign.';
        this.audio?.play('warn');
        return;
      }
      this.audio?.unlock();
      this.audio?.play('horn');
      this.closeModal();
      this.hideMenu();
      this.onStart({ ...this.state, mode: 'mods', mods: ids });
    });
    sync();
  }

  openSettings() {
    const s = this.state;
    this.openModal('SYSTEM', 'Settings', `
      <div class="metricRow"><span>Graphics quality</span>
        <div class="segRow" id="setQuality" style="flex:0 0 auto">
          ${['low', 'medium', 'high', 'ultra'].map((q) => `<button class="seg ${s.quality === q ? 'active' : ''}" data-q="${q}">${q}</button>`).join('')}
        </div>
      </div>
      <div class="metricRow"><span>Sound effects</span><button class="seg ${s.sound ? 'active' : ''}" id="setSound">${s.sound ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Music</span><button class="seg ${s.music ? 'active' : ''}" id="setMusic">${s.music ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Fog of war</span><button class="seg ${s.fog ? 'active' : ''}" id="setFog">${s.fog ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Screen shake</span><button class="seg ${s.shake ? 'active' : ''}" id="setShake">${s.shake ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Thumb buttons</span>
        <div class="segRow" id="setBtns" style="flex:0 0 auto">
          ${[['compact', 'Small'], ['comfortable', 'Comfort'], ['large', 'Large']].map(([v, n]) => `<button class="seg ${(s.buttonSize || 'comfortable') === v ? 'active' : ''}" data-btns="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="metricRow"><span>Swing automatically</span><button class="seg ${s.autoAttack !== false ? 'active' : ''}" id="setAuto">${s.autoAttack !== false ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Vibration</span><button class="seg ${s.haptics !== false ? 'active' : ''}" id="setHaptics">${s.haptics !== false ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Look sensitivity</span>
        <div class="segRow" id="setSens" style="flex:0 0 auto">
          ${[[0.55, 'Calm'], [1, 'Normal'], [1.6, 'Quick'], [2.4, 'Snap']].map(([v, n]) => `<button class="seg ${Math.abs((s.lookSensitivity ?? 1) - v) < 0.01 ? 'active' : ''}" data-sens="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="metricRow"><span>Invert vertical look</span><button class="seg ${s.invertLookY ? 'active' : ''}" id="setInvert">${s.invertLookY ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Move stick on the right</span><button class="seg ${s.swapSticks ? 'active' : ''}" id="setSwap">${s.swapSticks ? 'On' : 'Off'}</button></div>
      <div class="metricRow"><span>Head bob</span><button class="seg ${s.headBob !== false ? 'active' : ''}" id="setBob">${s.headBob !== false ? 'On' : 'Off'}</button></div>
      <p class="dim tiny" style="margin-top:10px">Thumb buttons, auto-swing, vibration, look sensitivity, inversion and stick side apply the moment you take a body in first person. Picking a level fixes the detail; resolution still adapts to hold the frame rate. <b>Balanced</b> is the default for phones; <b>Low</b> removes post-processing for older devices.</p>
    `);
    const body = this.el.modalBody;
    body.querySelector('#setQuality')?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      s.quality = b.dataset.q;
      s.autoQuality = false;      // an explicit choice wins over the auto-scaler
      for (const c of body.querySelectorAll('#setQuality .seg')) c.classList.toggle('active', c === b);
      this.onSettingsChanged(this.state);
      this._syncSummary();
    });
    const toggle = (id, key) => body.querySelector(id)?.addEventListener('click', (e) => {
      s[key] = !s[key];
      e.currentTarget.classList.toggle('active', s[key]);
      e.currentTarget.textContent = s[key] ? 'On' : 'Off';
      this.onSettingsChanged(this.state);
    });
    toggle('#setSound', 'sound');
    toggle('#setMusic', 'music');
    toggle('#setFog', 'fog');
    toggle('#setShake', 'shake');
    toggle('#setInvert', 'invertLookY');
    toggle('#setSwap', 'swapSticks');
    body.querySelector('#setBob')?.addEventListener('click', (e) => {
      s.headBob = s.headBob === false;
      e.currentTarget.classList.toggle('active', s.headBob);
      e.currentTarget.textContent = s.headBob ? 'On' : 'Off';
      this.onSettingsChanged(this.state);
    });
    toggle('#setAuto', 'autoAttack');
    toggle('#setHaptics', 'haptics');
    body.querySelector('#setBtns')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-btns]');
      if (!b) return;
      s.buttonSize = b.dataset.btns;
      for (const c of body.querySelectorAll('#setBtns .seg')) c.classList.toggle('active', c === b);
      document.body.dataset.fpButtons = s.buttonSize;
      this.onSettingsChanged(this.state);
    });
    body.querySelector('#setSens')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sens]');
      if (!b) return;
      s.lookSensitivity = Number(b.dataset.sens) || 1;
      for (const c of body.querySelectorAll('#setSens .seg')) c.classList.toggle('active', c === b);
      this.onSettingsChanged(this.state);
    });
  }

  openHelp() {
    this.openModal('FIELD MANUAL', 'How to wage war', `
      <div class="row"><b>Camera</b><span>Drag to pan · pinch to zoom · twist two fingers to rotate.</span></div>
      <div class="row"><b>Select</b><span>Tap a unit or building. Tap it twice to grab every soldier of that type nearby.</span></div>
      <div class="row"><b>Move</b><span>With something selected, tap the ground.</span></div>
      <div class="row"><b>Attack</b><span>Tap an enemy. Long-press the ground for an attack-move.</span></div>
      <div class="row"><b>Gather</b><span>Select villagers, then tap a tree, berry bush, deer or mine.</span></div>
      <div class="row"><b>Build</b><span>Villagers → Build → tap a building → tap the ground to place it.</span></div>
      <div class="row"><b>Economy</b><span>Food, wood, gold and stone. Drop-off buildings shorten every trip.</span></div>
      <div class="row"><b>Counter triangle</b><span>Spears beat cavalry · cavalry beats archers · archers beat infantry.</span></div>
      <div class="row"><b>Favour</b><span>Earned from battle. Spend it on Decrees that buff your whole empire.</span></div>
      <div class="row"><b>First person</b><span>Select one of your units and press <b>First Person</b>. That unit becomes your <b>Champion</b>: the same soldier in the same battle, now with renown, ranks and a perk at every rank.</span></div>
      <div class="row"><b>Your thumbs</b><span>Left thumb on the glass steers. Push it past the gold ring to sprint — no extra button. Right thumb drags to look; <b>tap an enemy</b> to lock on and you will swing at him automatically. <b>BLOCK</b> is a toggle, <b>DODGE</b> is a tap, both cost stamina. Everything else is a pill above your attack thumb, sized for a fingertip. No keyboard, no mouse: this is a phone game.</span></div>
      <div class="row"><b>Two hands, one screen</b><span>Turn the phone sideways: the battlefield is wider than it is tall, and the stick and the attack thumb never cover the middle of the picture.</span></div>
      <div class="row"><b>Champion</b><span>Renown comes from damage, kills, parries, spells, gathering and razing. Each rank offers one of three permanent perks — armour, cleave, sprint, banners, spell power. They keep working when you go back to the sky view, and saves carry them.</span></div>
      <div class="row"><b>Squads</b><span>A squad shares a second pool of experience. In first person, FOLLOW ME puts them on your shoulder and FOCUS sends them at your target.</span></div>
      <div class="row"><b>The Court</b><span>Top bar → Court. Give one of your own people an office: the Marshal rides with your soldiers, the Chancellor walks with your villagers, the Spymaster watches the enemy, the Hierophant holds the faith. Each earns rank from deeds — and if the officer falls, the office stands empty for a while.</span></div>
      <p class="dim tiny">Two fingers drag to pan · pinch to zoom · tap to select · long-press a soldier to attack-move. Every control in both views is a button on the glass.</p>
    `);
  }

  static writeSave(data) {
    try { localStorage.setItem('imperial-crown-v6-save', JSON.stringify(data)); return true; } catch (e) { return false; }
  }
  static readSave() {
    try {
      const raw = localStorage.getItem('imperial-crown-v6-save');
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.version === Menu.SAVE_VERSION) return d;
        return null;
      }
      /* Import, never overwrite, a v5 or v4 campaign on the same origin. */
      for (const key of ['imperial-crown-v5-save', 'imperial-crown-save']) {
        const legacy = localStorage.getItem(key);
        if (!legacy) continue;
        const d = JSON.parse(legacy);
        if (d && (d.version === 5 || d.version === 4)) return d;
      }
      return null;
    } catch (e) { return null; }
  }
  static clearSave() {
    try { localStorage.removeItem('imperial-crown-v6-save'); } catch (e) { /* ignore */ }
  }
  static readMods() {
    try {
      const raw = localStorage.getItem('imperial-crown-v6-mods')
        ?? localStorage.getItem('imperial-crown-v5-mods')
        ?? localStorage.getItem('imperial-crown-mods');
      const arr = raw ? JSON.parse(raw) : [];
      const out = {};
      for (const id of Array.isArray(arr) ? arr : []) out[id] = true;
      return out;
    } catch (e) { return {}; }
  }
  static writeMods(mods) {
    try {
      const arr = Object.keys(mods || {}).filter((id) => mods[id]);
      localStorage.setItem('imperial-crown-v6-mods', JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }
}

/** data.js occasionally names an icon the sprite doesn't carry. */
export function iconFor(name) {
  const known = ICONS;
  if (name && known.has(name)) return name;
  const alias = { horse: 'deer', stableIcon: 'deer', catapult: 'catapult', tower: 'tower' };
  if (name && alias[name] && known.has(alias[name])) return alias[name];
  return 'flag';
}

const ICONS = new Set([
  'sword', 'spear', 'bow', 'shield', 'axe', 'hammer', 'pick', 'wheat', 'tool', 'coin',
  'stone', 'tree', 'house', 'tower', 'castle', 'temple', 'market', 'anvil', 'book', 'dock',
  'ship', 'ram', 'catapult', 'cannon', 'monk', 'flag', 'crown', 'flame', 'eye', 'cog',
  'pause', 'play', 'sound', 'mute', 'menu', 'close', 'up', 'down', 'plus', 'heart',
  'hourglass', 'map', 'target', 'boot', 'people', 'cart', 'fish', 'deer', 'relic', 'wall',
  'gate', 'scroll', 'helmet', 'bolt', 'skull', 'home', 'mountain', 'leaf', 'save', 'load',
  'check', 'warning', 'villager', 'tent'
]);
