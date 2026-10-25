/* ============================================================
   menu.js — boot screen, campaign menu and the settings modal
   The menu paints its own "campaign preview" with canvas 2D, so the
   game still has no external assets at all.
   ============================================================ */
import { CIVS, DIFFICULTY, GAME_MODES } from '../sim/data.js';
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
  constructor(opts) {
    this.onStart = opts.onStart || (() => {});
    this.onSettingsChanged = opts.onSettingsChanged || (() => {});
    this.audio = opts.audio || null;
    this.state = {
      mode: 'campaign',
      civ: 'franks',
      difficulty: 'hard',
      seed: 20261,
      quality: opts.quality || 'medium',
      music: true,
      sound: true,
      fog: true,
      shake: true,
      showBars: true
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
      seed: document.getElementById('seedInput'),
      reroll: document.getElementById('btnRerollSeed'),
      start: document.getElementById('btnStart'),
      startSub: document.getElementById('startSub'),
      art: document.getElementById('menuArtCanvas'),
      artTitle: document.getElementById('artTitle'),
      artDesc: document.getElementById('artDesc'),
      btnLoad: document.getElementById('btnLoad'),
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
      this._syncSummary();
      this.audio?.play('click');
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
      this.hideMenu();
      this.onStart({ ...this.state });
    });
    el.btnSettings?.addEventListener('click', () => this.openSettings());
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

  _syncSummary() {
    const el = this.el;
    const civ = CIVS[this.state.civ];
    const mode = GAME_MODES[this.state.mode];
    const diff = DIFFICULTY[this.state.difficulty];
    if (el.civBrief) {
      el.civBrief.innerHTML = `<b>${civ.uniqueName}</b> · ${civ.bonus}<br><span class="dim">${civ.story}</span>`;
    }
    if (el.startSub) el.startSub.textContent = `${civ.name} · ${diff.name} · ${mode.name}`;
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
    this.el.menu?.classList.remove('hidden');
    const tip = this._tips ? this._tips[(Math.random() * this._tips.length) | 0] : '';
    this.bootTip(tip);
  }
  hideBoot() { this.el.boot?.classList.add('hidden'); }
  hideMenu() { this.el.menu?.classList.add('hidden'); }
  showMenu() {
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
    if (el.modalBody) el.modalBody.innerHTML = html;
    if (el.modalFoot) el.modalFoot.innerHTML = foot;
    el.modalTabs && (el.modalTabs.innerHTML = '');
    el.modal.classList.remove('hidden');
    this.audio?.play('click');
  }
  closeModal() { this.el.modal?.classList.add('hidden'); }
  isModalOpen() { return !!this.el.modal && !this.el.modal.classList.contains('hidden'); }

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
      <p class="dim tiny" style="margin-top:10px">Picking a level fixes the detail; resolution still adapts to hold the frame rate. <b>Balanced</b> is the default for phones; <b>Low</b> removes post-processing for older devices.</p>
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
      <p class="dim tiny">Keyboard (if you play on a desktop): WASD pan · Q/E rotate · +/- zoom · A attack-move · S stop · H town centre · 1–9 groups · Space pause.</p>
    `);
  }

  static writeSave(data) {
    try { localStorage.setItem('imperial-crown-save', JSON.stringify(data)); return true; } catch (e) { return false; }
  }
  static readSave() {
    try {
      const raw = localStorage.getItem('imperial-crown-save');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.version === 3 ? d : null;
    } catch (e) { return null; }
  }
  static clearSave() {
    try { localStorage.removeItem('imperial-crown-save'); } catch (e) { /* ignore */ }
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
  'check', 'warning', 'villager'
]);
