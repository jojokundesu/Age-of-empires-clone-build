/* ============================================================
   direct-control.js — possession, not a second simulation
   ------------------------------------------------------------
   One body. The same movement rules, combat cooldowns, projectiles,
   armour, morale, fog and Arcane Order spell implementation as the
   strategy view. What is new in v6 is the *person* inside it:

     · a Champion record (src/sim/champion.js) that earns renown for
       deeds and offers a permanent perk at every rank;
     · a real action layer — sprint, dodge, block/parry, rally — that
       spends stamina and obeys cooldowns;
     · squad commands you can give without leaving the body
       ("follow me", "focus my target") built on the guard and order
       systems the RTS already owns;
     · a legible first-person HUD: compass, stamina, renown, target
       card, hit feedback.

   Two thumbs, one phone. There is no keyboard and no mouse-look: the
   left thumb steers with a stick that sprints when pushed past its
   ring, the right thumb drags to look and taps a man to lock on, and
   the attack itself is automatic so a single thumb is enough to fight
   with. Every other action is a button tall enough for a fingertip.

   Directions are the one thing this file must never get wrong again.
   Every horizontal vector comes from `camera.moveBasis()`, which is
   derived from the same yaw the view matrix is built from. v5 computed
   its own "right" with the opposite sign, so every strafe was mirrored
   and a drag to the right turned the camera left.
   ============================================================ */
import { clamp } from '../core/math.js';
import { STATE } from '../sim/entities.js';
import { BUILDING_DEFS, BUILDING_AGE } from '../sim/data.js';
import { iconFor } from './menu.js';
import { CHAMPION_RANKS, rankProgress } from '../sim/champion.js';

const STICK_RADIUS = 48;
const MOVE_DEADZONE = 0.14;
const AIM_CONE = 0.27;        // radians, about 15 degrees; only for visible enemies
const PRECISE_CONE = 0.035;
const BASE_LOOK = 0.0034;     // radians per CSS pixel of drag
const DODGE_DISTANCE = 4.6;
const DODGE_TIME = 0.22;
const SPRINT_DRAIN = 17;      // stamina per second
const BUILD_TYPES = ['house', 'farm', 'supply_tent', 'mill', 'lumber_camp', 'mining_camp', 'barracks', 'archery_range',
  'stable', 'blacksmith', 'market', 'watch_tower', 'palissade_wall', 'stone_wall', 'stone_gate', 'monastery',
  'siege_workshop', 'university', 'castle', 'dock', 'wonder'];

const HOLD_KEYS = new Set(['shift', 'q']);

// A decorative held kit follows the actual unit's weapon; vehicles, animals
// and other handless units intentionally have no human hand overlay.
function equipmentFor(unit) {
  const def = unit.def, classes = def.classes || [];
  if (unit.type === 'villager') return 'tool';
  if (def.caster) return 'staff';
  if (classes.includes('monk')) return 'relic';
  if (def.naval || def.siege || ['war_elephant', 'dire_wolf', 'bear', 'stone_golem', 'plague_zombie', 'trade_cart'].includes(unit.type)) return 'none';
  if (def.projectile === 'arrow') return 'bow';
  if (def.projectile === 'javelin' || def.icon === 'spear') return 'spear';
  if (def.icon === 'axe' || def.projectile === 'axe') return 'axe';
  if (def.projectile === 'ball') return 'none';
  return def.attack > 0 ? 'sword' : 'none';
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class DirectControl {
  constructor({ game, camera, input, ui, app }) {
    this.game = game;
    this.camera = camera;
    this.input = input;
    this.ui = ui;
    this.app = app;
    this.unit = null;
    this.champion = null;
    this.aimAssist = true;
    this.stickX = 0;
    this.stickY = 0;
    this.attackHeld = false;
    this.sprintHeld = false;
    this.blockHeld = false;
    this.pointers = new Map();
    this.target = null;
    this.hudAcc = 0;
    this.spellSignature = '';
    this.mapSpell = null;
    this._ground = [0, 0, 0];
    this._basis = [0, 1, 0, 0];
    this._dodge = null;
    this._feedT = 0;
    this._pausedForPerks = false;
    this._hintT = 9;
    this._seenHp = new Map();
    this._compassBuilt = false;
    /* --- phone-first input --- */
    this.locked = null;          // tap-to-lock target
    this.stickSprint = false;     // the stick has been pushed past its ring
    this._rotCheck = 0;
    this._buzzAt = 0;
    this.el = {};
    for (const id of ['fpLayer', 'fpName', 'fpDetail', 'fpHealthFill', 'fpVitals', 'fpReticle', 'fpTarget',
      'fpEquipment', 'fpStick', 'fpStickKnob', 'fpAimToggle', 'fpPause', 'fpExit', 'fpAttack', 'fpInteract', 'fpBuild',
      'fpSpells', 'fpSpellShelf', 'fpShelfClose', 'fpSpellList', 'fpBuildShelf', 'fpBuildClose', 'fpBuildList',
      'fpMap', 'fpMapClose', 'fpMapCanvas',
      /* v6 */
      'fpRank', 'fpPerkCount', 'fpPerkOpen', 'fpStaminaFill', 'fpRenownFill', 'fpSprint', 'fpDodge', 'fpBlock',
      'fpRally', 'fpSquad', 'fpSquadName', 'fpSquadInfo', 'fpFollow', 'fpFocus', 'fpPerkPanel', 'fpPerkCards',
      'fpPerkSub', 'fpPerkClose', 'fpFloats', 'fpFeed', 'fpCompassTape', 'fpCompassCard', 'fpHint',
      'fpChampionBadge', 'fpSprintLamp', 'fpRotate', 'fpLookHint']) this.el[id] = document.getElementById(id);
    this._wire();
    this._buildCompass();
  }

  get active() { return !!this.unit; }
  canAct() {
    return !!this.unit && !this.unit.dead && this.unit.team === this.game.playerTeam && !this.unit.garrisoned &&
      this.unit.state !== STATE.ROUT && !this.game.gameOver && !this.app.paused;
  }

  /* ==========================================================
     wiring
     ========================================================== */
  _wire() {
    const e = this.el;
    if (e.fpExit) e.fpExit.onclick = () => this.exit();
    if (e.fpPause) e.fpPause.onclick = () => { this.resetInput(); this.app.openPause?.(); };
    if (e.fpAimToggle) e.fpAimToggle.onclick = () => {
      this.aimAssist = !this.aimAssist;
      e.fpAimToggle.classList.toggle('active', this.aimAssist);
      e.fpAimToggle.setAttribute('aria-pressed', String(this.aimAssist));
      const b = e.fpAimToggle.querySelector('b'); if (b) b.textContent = this.aimAssist ? 'ON' : 'OFF';
    };
    if (e.fpInteract) e.fpInteract.onclick = () => this.interact();
    if (e.fpBuild) e.fpBuild.onclick = () => this.toggleBuildShelf();
    if (e.fpBuildClose) e.fpBuildClose.onclick = () => this.toggleBuildShelf(false);
    if (e.fpBuildList) e.fpBuildList.onclick = (event) => {
      const b = event.target.closest('button[data-build]');
      if (b) this.chooseBuild(b.dataset.build);
    };
    if (e.fpMapClose) e.fpMapClose.onclick = () => this.closeGlobalMap();
    if (e.fpMapCanvas) e.fpMapCanvas.onclick = (event) => {
      if (!this.canAct() || !this.mapSpell) return;
      const r = e.fpMapCanvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const half = this.game.world.half || 256;
      const x = clamp((event.clientX - r.left) / r.width, 0, 1) * half * 2 - half;
      const z = clamp((event.clientY - r.top) / r.height, 0, 1) * half * 2 - half;
      if (this.cast(this.mapSpell, [x, z])) this.closeGlobalMap();
    };
    if (e.fpSpells) e.fpSpells.onclick = () => {
      e.fpBuildShelf?.classList.add('hidden'); this.closeGlobalMap();
      e.fpSpellShelf?.classList.toggle('hidden');
      this.spellSignature = '';
      this.refreshSpells();
    };
    if (e.fpShelfClose) e.fpShelfClose.onclick = () => e.fpSpellShelf?.classList.add('hidden');
    /* The spellbook rows are rebuilt every time mana or a cooldown changes,
       so the handler is delegated from the shelf rather than attached to the
       buttons. v6 shipped this shelf without a handler at all: a mage could
       open his book and not cast a single spell from it. */
    if (e.fpSpellList) e.fpSpellList.onclick = (event) => {
      const b = event.target.closest('button[data-spell]');
      if (!b) return;
      if (b.dataset.attune) this.attune(b.dataset.spell);
      else this.cast(b.dataset.spell);
    };

    /* --- champion --- */
    if (e.fpPerkOpen) e.fpPerkOpen.onclick = () => this.openPerks();
    if (e.fpPerkClose) e.fpPerkClose.onclick = () => this.closePerks(true);
    if (e.fpPerkCards) e.fpPerkCards.onclick = (event) => {
      const b = event.target.closest('button[data-perk]');
      if (b) this.pickPerk(b.dataset.perk);
    };

    /* --- actions: hold semantics on pointer, with a click fallback so the
       buttons stay operable by assistive technology --- */
    const hold = (node, down, up) => {
      if (!node) return;
      node.onpointerdown = (event) => {
        event.preventDefault();
        node.setPointerCapture?.(event.pointerId);
        node.classList.add('pressed');
        down();
      };
      const release = (event) => {
        event?.preventDefault?.();
        node.classList.remove('pressed');
        up();
      };
      node.onpointerup = release;
      node.onpointercancel = release;
      node.onlostpointercapture = release;
      node.onclick = (event) => { if (event.detail === 0) { down(); setTimeout(up, 160); } };
    };
    /* BLOCK is a toggle, not a hold: a thumb that has to stay pressed cannot
       also steer, and a phone has only two. The state is visible on the
       button, it drops by itself when stamina runs out, and pressing ATTACK
       lowers the shield for you -- so it can never trap the player. */
    if (e.fpBlock) e.fpBlock.onclick = () => { this.setBlock(!this.blockHeld); this._buzz(8); };
    if (e.fpDodge) e.fpDodge.onclick = () => this.dodge();
    if (e.fpRally) e.fpRally.onclick = () => this.rally();
    if (e.fpFollow) e.fpFollow.onclick = () => this.followSquad();
    if (e.fpFocus) e.fpFocus.onclick = () => this.focusSquad();

    const attack = e.fpAttack;
    if (attack) {
      attack.onpointerdown = (event) => {
        event.preventDefault();
        attack.setPointerCapture?.(event.pointerId);
        this.attackHeld = true;
        attack.classList.add('pressed');
        this.el.fpEquipment?.classList.add('is-striking');
        this.attackOnce();
      };
      const release = (event) => {
        event?.preventDefault();
        this.attackHeld = false;
        attack.classList.remove('pressed');
        this.el.fpEquipment?.classList.remove('is-striking');
      };
      attack.onpointerup = release; attack.onpointercancel = release; attack.onlostpointercapture = release;
      // A synthetic click (screen reader, switch access) has no pointerdown.
      attack.onclick = (event) => { if (event.detail === 0) this.attackOnce(); };
    }
  }

  _buildCompass() {
    const tape = this.el.fpCompassTape;
    if (!tape || this._compassBuilt) return;
    this._compassBuilt = true;
    const frag = document.createDocumentFragment();
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < COMPASS_POINTS.length; i++) {
        const span = document.createElement('span');
        span.textContent = COMPASS_POINTS[i];
        if (COMPASS_POINTS[i].length > 1) span.className = 'minor';
        frag.appendChild(span);
      }
    }
    tape.replaceChildren(frag);
  }

  /* ==========================================================
     entering and leaving the body
     ========================================================== */
  enter(unit) {
    if (!unit || unit.dead || unit.kind !== 'unit' || unit.team !== this.game.playerTeam || unit.garrisoned || unit.state === STATE.ROUT) {
      this.ui.toast('Select one available friendly unit first', 'warn');
      return false;
    }
    if (this.unit) this.exit();
    this.input.clearLongPress();
    this.input.pointers.clear();
    this.input.fling = null;
    this.input.armed = null;
    this.game.placing = null;
    if (this.game.modCast) this.game.modHost?.cancelCast();
    this.game.guards?.release(unit);
    unit.stop();
    unit.state = STATE.CONTROLLED;
    unit.target = null; unit.path = null; unit.targetPos = null; unit.destX = unit.destZ = null;
    this.unit = unit;
    /* the same unit object the RTS has always had, now carrying a Champion
       record: renown, rank, perks, stamina */
    this.champion = this.game.champions?.declare(unit) || null;
    this.game.setSelection([unit]);
    this.camera.enterFirstPerson(unit);
    if (this.camera.firstPerson) {
      this.camera.firstPerson.bobScale = this.bobEnabled ? 1 : 0;
      this.camera.firstPerson.fovBase = 66;
    }
    this.camera.update(0);
    document.body.classList.add('firstPerson');
    this.el.fpLayer?.classList.remove('hidden');
    this.el.fpSpellShelf?.classList.add('hidden');
    this.el.fpBuildShelf?.classList.add('hidden');
    this.closeGlobalMap();
    this.closePerks(false);
    this.el.fpInteract?.classList.toggle('hidden', !(unit.type === 'villager' || unit.def.classes.includes('monk')));
    this.el.fpBuild?.classList.toggle('hidden', unit.type !== 'villager');
    const mage = !!this.arcane();
    this.el.fpSpells?.classList.toggle('hidden', !mage);
    if (mage) this.el.fpSpellShelf?.classList.remove('hidden');
    this.el.fpAttack?.classList.toggle('hidden', !(unit.def.attack > 0) || unit.def.classes.includes('monk'));
    this.el.fpDodge?.classList.toggle('hidden', !this.champion);
    this.el.fpBlock?.classList.toggle('hidden', !this.champion || !(unit.def.attack > 0));
    this.el.fpSprint?.classList.toggle('hidden', !this.champion);
    this.equipment = equipmentFor(unit);
    if (this.el.fpEquipment) this.el.fpEquipment.dataset.kind = this.equipment;
    const attackIcon = this.el.fpAttack?.querySelector('use');
    if (attackIcon) attackIcon.setAttribute('href', `#i-${({ bow: 'bow', spear: 'spear', axe: 'axe', tool: 'pick', staff: 'flame' })[this.equipment] || (unit.def.siege ? 'cannon' : 'sword')}`);
    this.spellSignature = '';
    this._seenHp.clear();
    this._hintT = 10;
    this._refreshChampionUi();
    this.updateHud();
    const hint = this.champion
      ? 'Your Champion · left thumb moves · right thumb looks · tap an enemy to lock on'
      : 'Left thumb moves · right thumb looks · tap an enemy to lock on';
    this.ui.toast(hint, 'info');
    /* if a previous session left a choice unspent, ask now */
    if (this.game.champions?.pendingChoices(unit) > 0) setTimeout(() => this.openPerks(), 260);
    return true;
  }

  exit(message = '') {
    const unit = this.unit;
    if (!unit) return;
    this.closePerks(false);
    this.resetInput();
    this.camera.exitFirstPerson();
    this.unit = null;
    this.champion = null;
    if (!unit.dead && !unit.garrisoned && unit.team === this.game.playerTeam && unit.state === STATE.CONTROLLED) unit.stop();
    document.body.classList.remove('firstPerson');
    this.el.fpLayer?.classList.add('hidden');
    this.el.fpSpellShelf?.classList.add('hidden');
    this.el.fpBuildShelf?.classList.add('hidden');
    this.closeGlobalMap();
    this.game.placing = null;
    if (unit.champion) { unit.champion.blocking = false; }
    if (unit.dead || unit.team !== this.game.playerTeam || unit.garrisoned) this.game.clearSelection();
    else this.game.setSelection([unit]);
    this.ui.sig = '';
    this.ui.refreshCommands();
    if (message) this.ui.toast(message, 'warn');
  }

  dispose() {
    this.exit(); this.resetInput();
    for (const node of Object.values(this.el)) if (node) node.onclick = null;
    const attack = this.el.fpAttack;
    if (attack) attack.onpointerdown = attack.onpointerup = attack.onpointercancel = attack.onlostpointercapture = null;
  }

  resetInput() {
    this.pointers.clear();
    this.stickX = this.stickY = 0;
    this.attackHeld = false;
    this.sprintHeld = false;
    this.blockHeld = false;
    this.stickSprint = false;
    this.locked = null;
    this.el.fpStick?.classList.remove('sprinting');
    this.el.fpSprintLamp?.classList.remove('on');
    this.el.fpBlock?.classList.remove('active');
    this.el.fpReticle?.classList.remove('locked');
    if (this.unit?.champion) { this.unit.champion.blocking = false; }
    this.el.fpAttack?.classList.remove('pressed');
    this.el.fpSprint?.classList.remove('pressed');
    this.el.fpBlock?.classList.remove('pressed');
    this.el.fpEquipment?.classList.remove('is-striking');
    this._resetStick();
  }

  _resetStick() {
    const el = this.el.fpStick, knob = this.el.fpStickKnob;
    if (el) { el.style.left = ''; el.style.top = ''; el.style.bottom = ''; el.style.transform = ''; }
    if (knob) knob.style.transform = '';
  }

  /* ==========================================================
     settings the first-person layer reads live
     ========================================================== */
  get settings() { return (this.app && this.app.settings) || {}; }
  get sensitivity() {
    const s = Number(this.settings.lookSensitivity);
    return (Number.isFinite(s) && s > 0.1 ? s : 1) * BASE_LOOK;
  }
  get invertY() { return !!this.settings.invertLookY; }
  get swapSticks() { return !!this.settings.swapSticks; }
  get bobEnabled() { return this.settings.headBob !== false; }
  /** Swings whenever a locked or aimed enemy is in reach. On by default: on a
      phone the thumb that would press ATTACK is busy steering. */
  get autoAttack() { return this.settings.autoAttack !== false; }
  get haptics() { return this.settings.haptics !== false; }

  /** A short, cheap vibration. Never on a device that does not have one. */
  _buzz(ms = 10) {
    if (!this.haptics) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._buzzAt < 40) return;      // vibrate() is a syscall: throttle it
    this._buzzAt = now;
    try { navigator.vibrate?.(ms); } catch (e) { /* locked down by the browser */ }
  }
  /* ==========================================================
     pointer / touch
     ========================================================== */
  pointerDown(event) {
    if (!this.canAct()) return false;
    event.preventDefault();
    this.input.canvas.setPointerCapture?.(event.pointerId);
    const rect = this.input.rect();
    const leftSide = (event.clientX - rect.left) < rect.width * 0.48;
    const left = this.swapSticks ? !leftSide : leftSide;
    const role = left && ![...this.pointers.values()].some((p) => p.role === 'move') ? 'move' : 'look';
    const p = {
      role, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY,
      /* a look-touch that never moves is a tap: "that man, there" */
      t0: performance.now(), moved: 0
    };
    this.pointers.set(event.pointerId, p);
    if (role === 'move') {
      const stick = this.el.fpStick;
      if (stick) { stick.style.left = `${event.clientX}px`; stick.style.top = `${event.clientY}px`; stick.style.bottom = 'auto'; stick.style.transform = 'translate(-50%, -50%)'; }
      this.stickX = this.stickY = 0;
    }
    this._hintT = Math.min(this._hintT, 2.5);
    return true;
  }

  pointerMove(event) {
    if (!this.active) return false;
    const p = this.pointers.get(event.pointerId);
    if (!p) return true;
    event.preventDefault();
    p.moved = Math.max(p.moved || 0, Math.hypot(event.clientX - p.sx, event.clientY - p.sy));
    if (p.role === 'move') {
      let x = (event.clientX - p.sx) / STICK_RADIUS;
      let y = (event.clientY - p.sy) / STICK_RADIUS;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.stickX = x; this.stickY = -y;
      if (this.el.fpStickKnob) this.el.fpStickKnob.style.transform = `translate(${(x * 28).toFixed(1)}px, ${(y * 28).toFixed(1)}px)`;
      /* Push past the ring to run. Sprint on a phone has to live under the
         thumb that is already doing something -- a separate button means
         stopping, or a third hand. The ring lights up and the stick knob
         turns gold, so it is discoverable without a tutorial. */
      /* screen-up is negative clientY; the stick's forward axis is +y */
      const wantSprint = -y > 0.84 || (Math.hypot(x, y) > 0.94 && -y > 0.3);
      if (wantSprint !== this.stickSprint) {
        this.stickSprint = wantSprint;
        this.setSprint(wantSprint);
        this.el.fpStick?.classList.toggle('sprinting', wantSprint);
        if (wantSprint) this._buzz(6);
      }
    } else {
      /* Drag right = look right. The camera owns the sign so the movement
         basis and the view can never disagree. */
      const dx = (event.clientX - p.x) * this.sensitivity;
      const dy = (event.clientY - p.y) * this.sensitivity * (this.invertY ? 1 : -1);
      this.camera.lookFirstPerson(dx, dy);
    }
    p.x = event.clientX; p.y = event.clientY;
    return true;
  }

  pointerUp(event) {
    if (!this.active) return false;
    const p = this.pointers.get(event.pointerId);
    if (p?.role === 'move') {
      this.stickX = this.stickY = 0;
      this._resetStick();
      if (this.stickSprint) { this.stickSprint = false; this.setSprint(false); this.el.fpStick?.classList.remove('sprinting'); }
    }
    /* A tap, not a drag: you pointed at something. Either thumb will do --
       on the glass a tap and the start of a stick push look identical until
       it moves, so the meaning is decided on release. */
    if (p) {
      const quick = performance.now() - (p.t0 || 0) < 340;
      if (quick && (p.moved || 0) < 14) this.tapLock(event.clientX, event.clientY);
    }
    this.pointers.delete(event.pointerId);
    event.preventDefault?.();
    return true;
  }

  /* ==========================================================
     tap to lock -- the phone's aim assist
     ----------------------------------------------------------
     Dragging a reticle onto a running spearman with one thumb, while the
     other thumb steers, is the hardest thing a touch screen can ask. So the
     crosshair is generous (AIM_CONE) *and* the player can simply touch the
     enemy: the lock keeps the next blows on him while you keep steering. A
     tap on empty ground clears it. It drops by itself if he dies, leaves
     weapon range or the fight ends.
     ========================================================== */
  tapLock(clientX, clientY) {
    if (globalThis.__DBG) console.error('tapLock enter', clientX, clientY);
    const u = this.unit, g = this.game;
    if (!u || !this.canAct()) return false;
    const rect = this.input.rect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const reach = Math.max(2, u.stats().range + 2);
    let best = null, bestD = Infinity;
    const consider = (e) => {
      if (!e || e.dead || e.garrisoned || !g.isHostile(u.team, e.team)) return;
      if (g.showFog && !g.isVisible(e.x, e.z)) return;
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      if (d > Math.min(60, reach * 3)) return;
      const point = this._project(e);
      if (!point) return;
      const off = Math.hypot(point[0] - px, point[1] - py);
      const radius = e.kind === 'building' ? 46 : 40;
      if (off > radius) return;
      if (off < bestD) { bestD = off; best = e; }
    };
    const near = g.spatial.query(u.x, u.z, Math.min(70, reach * 3)).slice();
    if (globalThis.__DBG) console.error('tapLock near', near.length, 'buildings', g.buildings.length);
    for (let i = 0; i < near.length; i++) consider(near[i]);
    for (const b of g.buildings) consider(b);
    if (globalThis.__DBG) console.error('tapLock done');
    this.locked = best || null;
    if (best) {
      this.feedback('LOCKED', 'lock');
      this._buzz(10);
      this.el.fpReticle?.classList.add('locked');
    }
    return !!best;
  }

  _project(e) {
    const r = this.ui && this.ui.renderer;
    if (!r || !r.projectToScreen) return null;
    const h = e.kind === 'building' ? (e.def.size || 3) * 0.35 : Math.min(e.height || 1.7, 2.2) * 0.55;
    const p = r.projectToScreen(this.camera, e.x, (e.y || 0) + h, e.z, this._proj || (this._proj = [0, 0, 0]));
    return p && p[2] > 0 ? p : null;
  }

  /* ==========================================================
     actions
     ========================================================== */
  setSprint(on) {
    if (!this.unit || !this.champion) return;
    if (on && this.champion.stamina < 6) {
      if (!this._starved) { this.ui.toast('Out of stamina', 'warn'); this._starved = true; }
      return;
    }
    this._starved = false;
    this.sprintHeld = !!on;
    this.el.fpSprint?.classList.toggle('active', this.sprintHeld);
    this.el.fpSprintLamp?.classList.toggle('on', this.sprintHeld);
  }

  setBlock(on) {
    if (!this.unit || !this.champion) return;
    const st = this.champion;
    if (on) {
      if (st.blocking) return;
      if (st.stamina < 5) { this.ui.toast('Not enough stamina to raise the shield', 'warn'); return; }
      st.blocking = true;
      st.blockStart = this.game.time;
      st.staminaDelay = 0.35;
      this.blockHeld = true;
      this.el.fpBlock?.classList.add('active');
      this.el.fpEquipment?.classList.add('is-blocking');
    } else {
      st.blocking = false;
      st.blockStart = 0;
      this.blockHeld = false;
      this.el.fpBlock?.classList.remove('active');
      this.el.fpEquipment?.classList.remove('is-blocking');
    }
  }

  dodge() {
    const c = this.game.champions;
    if (!this.canAct() || !c) return false;
    if (!c.canDodge(this.unit)) {
      const cd = c.dodgeCooldown(this.unit);
      this.ui.toast(cd > 0 ? `Dodge ready in ${cd.toFixed(1)} s` : 'Not enough stamina to dodge', 'warn');
      return false;
    }
    const [sx, sy] = this.movement();
    const b = this.camera.moveBasis(this._basis);
    let dx = b[0] * sy + b[2] * sx;
    let dz = b[1] * sy + b[3] * sx;
    if (!dx && !dz) { dx = b[0]; dz = b[1]; }          // no input: roll forward
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    c.useDodge(this.unit);
    this._dodge = { x: dx, z: dz, t: DODGE_TIME, total: DODGE_TIME };
    this.camera.fpImpact(0.10, 2.2);
    this.game.fx?.dust?.(this.unit.x, this.unit.y, this.unit.z, 5, 0.9);
    this.game.sound?.play?.('step', this.unit.x, this.unit.z);
    this.feedback('DODGE', 'dodge');
    return true;
  }

  rally() {
    const c = this.game.champions;
    if (!this.canAct() || !c) return false;
    if (!c.canRally(this.unit)) {
      const cd = c.rallyCooldown(this.unit);
      this.ui.toast(cd > 0 ? `Rally ready in ${Math.ceil(cd)} s`
        : 'Rally is a Champion perk — choose it when you rank up', 'warn');
      return false;
    }
    c.useRally(this.unit);
    this.feedback('RALLY', 'rally');
    return true;
  }

  movement() {
    const x = this.stickX, y = this.stickY;
    const len = Math.hypot(x, y);
    if (len < MOVE_DEADZONE) return [0, 0];
    if (len > 1) { x /= len; y /= len; }
    return [x, y];
  }

  /* ==========================================================
     simulation hooks
     ========================================================== */
  /** Runs inside Unit.update, on the fixed simulation tick. */
  prepareUnit(u) {
    if (u !== this.unit || u.state === STATE.ROUT) return;
    const [x, y] = this.movement();
    if (u.state === STATE.IDLE || (u.state !== STATE.CONTROLLED && (x || y || this.attackHeld))) {
      u.state = STATE.CONTROLLED;
      u.target = null; u.gatherTarget = null; u.buildTarget = null; u.repairTarget = null;
      u.path = null; u.targetPos = null; u.destX = u.destZ = null;
    }
  }

  /** Direct motion respects terrain, water, gates, walls and other bodies. */
  moveUnit(u, dt, stats) {
    const fp = this.camera.firstPerson;
    if (!fp) { u.state = STATE.IDLE; return; }
    const champ = u.champion;
    const mods = champ && this.game.champions ? this.game.champions.mods(u) : null;

    /* A dodge is a short, committed slide: it owns movement until it ends. */
    if (this._dodge) {
      const step = (DODGE_DISTANCE / DODGE_TIME) * dt;
      const nx = u.x + this._dodge.x * step;
      const nz = u.z + this._dodge.z * step;
      if (this._walkable(u, nx, nz)) { u.x = nx; u.z = nz; }
      this._dodge.t -= dt;
      u.moving = true;
      u.desiredFacing = Math.atan2(this._dodge.x, this._dodge.z);
      u.moveSpeedNow = DODGE_DISTANCE / DODGE_TIME;
      if (this._dodge.t <= 0) this._dodge = null;
      if (this.attackHeld && u.attackCooldown <= 0) this.attackOnce(true);
      return;
    }

    const [sx, sy] = this.movement();
    const b = this.camera.moveBasis(this._basis);
    let speed = stats.speed * (u.speedMul || 1);
    if (!(mods && mods.surefoot)) speed *= this.game.speedMulOnStep(u);
    /* sprint */
    let sprinting = false;
    if (this.sprintHeld && champ && (sx || sy)) {
      const mul = mods ? mods.sprintMul : 1.55;
      sprinting = this.game.champions.spendStamina(u, SPRINT_DRAIN * (mods ? mods.staminaDrainMul : 1) * dt);
      if (sprinting) speed *= mul;
    }
    this.camera.fpSprint(sprinting ? 7 : 0);
    if (champ && champ.blocking) speed *= 0.55;

    const dx = (b[0] * sy + b[2] * sx) * speed * dt;
    const dz = (b[1] * sy + b[3] * sx) * speed * dt;
    u.desiredFacing = fp.yaw;
    u.moving = false;
    if (dx || dz) {
      const before = [u.x, u.z];
      if (this._walkable(u, u.x + dx, u.z + dz)) { u.x += dx; u.z += dz; u.moving = true; }
      else if (this._walkable(u, u.x + dx, u.z)) { u.x += dx; u.moving = !!dx; }
      else if (this._walkable(u, u.x, u.z + dz)) { u.z += dz; u.moving = !!dz; }
      u.moveSpeedNow = u.moving ? Math.hypot(u.x - before[0], u.z - before[1]) / Math.max(1e-4, dt) : 0;
      if (u.moving) {
        this._stepT = (this._stepT || 0) + Math.hypot(u.x - before[0], u.z - before[1]);
        if (this._stepT > (sprinting ? 1.5 : 2.1)) {
          this._stepT = 0;
          this.camera.fpStep(sprinting ? 0.075 : 0.045);
          this.game.sound?.play?.('step', u.x, u.z);
        }
      }
    } else {
      u.moveSpeedNow = 0;
    }
    if (this.attackHeld && u.attackCooldown <= 0) this.attackOnce(true);
    /* Hands-free swing: only when the player is not already holding ATTACK,
       only at something that is really in reach. This is what makes a phone
       fight possible with one thumb on the glass. */
    else if (this.autoAttack && !(champ && champ.blocking) && u.attackCooldown <= 0) {
      /* throttled: aiming is a spatial query plus a walk over the roofs, and
         nobody needs it thirty times a second */
      this._autoT = (this._autoT || 0) + dt;
      if (this._autoT > 0.12) { this._autoT = 0; this.attackOnce(true); }
    }
  }

  _walkable(u, x, z) {
    const g = this.game;
    if (!g.isPassable(x, z, u)) return false;
    if (!u.def.naval && g.navWall) {
      const n = g.world.nav.cells, cell = g.world.nav.cell, half = g.world.half || 256;
      const cx = Math.floor((x + half) / cell), cz = Math.floor((z + half) / cell);
      if (cx < 0 || cz < 0 || cx >= n || cz >= n) return false;
      const i = cz * n + cx;
      if (g.navWall[i] && !g.navCarve[i]) return false;
      if (g.navGateTeam[i] && g.navGateTeam[i] !== u.team) return false;
    }
    const near = g.spatial.query(x, z, (u.radius || .4) + 2);
    for (let i = 0; i < near.length; i++) {
      const other = near[i];
      if (other === u || other.dead || other.garrisoned) continue;
      const min = ((u.radius || .4) + (other.radius || .4)) * .8;
      const d2 = (x - other.x) ** 2 + (z - other.z) ** 2;
      const old = (u.x - other.x) ** 2 + (u.z - other.z) ** 2;
      // If spawned overlapping, always permit a step away.
      if (d2 < min * min && d2 < old) return false;
    }
    return true;
  }

  /* ==========================================================
     aiming and attacking
     ========================================================== */
  /** Screen-centred angular scoring; no locking through fog or behind us. */
  findAim(kind = 'enemy', range = 20, inAttackRange = false) {
    const u = this.unit, cam = this.camera, g = this.game;
    if (!u || !cam.firstPerson) return null;
    let best = null, bestScore = Infinity;
    const cone = this.aimAssist ? AIM_CONE : PRECISE_CONE;
    const consider = (e) => {
      if (!e || e === u || e.dead || e.garrisoned) return;
      if (kind === 'enemy') {
        if (!g.isHostile(u.team, e.team)) return;
        if (g.showFog && !g.isVisible(e.x, e.z)) return;
      } else if (kind === 'interact') {
        const villager = u.type === 'villager';
        const monk = u.def.classes.includes('monk');
        const good = (villager && (e.kind === 'resource' || (e.kind === 'building' && e.team === u.team && (e.buildProgress < 1 || e.hp < e.maxHp)))) ||
          (monk && e.kind === 'unit' && (e.team === u.team ? e.hp < e.maxHp : g.isHostile(u.team, e.team)));
        if (!good) return;
        if (e.team !== u.team && g.showFog && !g.isVisible(e.x, e.z)) return;
      }
      const dx = e.x - cam.eye[0], dz = e.z - cam.eye[2];
      const horizontal = Math.hypot(e.x - u.x, e.z - u.z);
      const r = e.kind === 'building' ? (e.def.size || 3) * 0.5 : Math.max(0.35, e.radius || 0.5);
      if (horizontal > range + r) return;
      if (inAttackRange && horizontal > u.attackRangeTo(e, u.stats()) + 0.05) return;
      /* Aim at the middle of the body, and forgive the whole body: on
         rolling ground a soldier eight metres downhill used to sit outside a
         15-degree cone even with the crosshair on him, which reads as "the
         game will not let me attack". The allowance is the angular radius of
         the target's bounding sphere, so tall things and close things are
         easier to hit, and nothing is easier to hit than it looks. */
      const halfH = Math.max(0.4, Math.min(e.height || 1.7, 4)) * 0.5;
      const dy = (e.y || 0) + halfH - cam.eye[1];
      const len = Math.hypot(dx, dy, dz) || 1;
      const dot = (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2]) / len;
      if (dot <= 0) return;
      const angle = Math.acos(clamp(dot, -1, 1));
      const allowance = Math.min(0.6, Math.atan2(Math.hypot(r, halfH), Math.max(0.5, horizontal)));
      if (angle > cone + allowance) return;
      const score = Math.max(0, angle - allowance) + horizontal * 0.001;
      if (score < bestScore) { bestScore = score; best = e; }
    };
    /* A snapshot, not the hash's shared scratch array. That buffer is reused
       by every query in the game (entities.js says as much where it guards a
       passability test), so a single re-entrant query while we walk the list
       silently rewrites the candidates under the loop -- and the enemy in the
       crosshair is the one that goes missing. */
    const near = g.spatial.query(u.x, u.z, Math.min(70, range + 6)).slice();
    for (let i = 0; i < near.length; i++) consider(near[i]);
    for (const b of g.buildings) consider(b);
    if (kind === 'interact' && u.type === 'villager') {
      const resources = g.resourceSpatial.query(u.x, u.z, range + 5);
      for (let i = 0; i < resources.length; i++) consider(resources[i]);
    }
    return best;
  }

  /** Is the locked man still worth swinging at? */
  lockTarget() {
    const t = this.locked, u = this.unit;
    if (!t || !u) return null;
    if (t.dead || t.garrisoned) { this.locked = null; return null; }
    if (!this.game.isHostile(u.team, t.team)) { this.locked = null; return null; }
    if (this.game.showFog && !this.game.isVisible(t.x, t.z)) { this.locked = null; return null; }
    return t;
  }

  attackOnce(fromTick = false) {
    const u = this.unit;
    if (!this.canAct()) return false;
    if (this.champion && this.champion.blocking) this.setBlock(false);
    // Placement is a single press, not a continuously repeated attack. In
    // particular, holding PLACE across a fixed tick must not cancel the new
    // builder order or flood the player with an invalid-placement toast.
    if (this.game.placing && u.type === 'villager') return fromTick ? false : this.placeBuild();
    if (!u.def.attack || u.def.classes.includes('monk')) return false;
    if (u.attackCooldown > 0) return false;
    const frozen = u.modState?.arcane?.freeze;
    if (frozen && frozen > this.game.time) return false;
    if (u.staggeredUntil && this.game.time < u.staggeredUntil) return false;
    // Use the current look direction, even between rendered frames.
    this.camera.update(0);
    /* A tapped lock beats the crosshair: the player already said who. */
    const locked = this.lockTarget();
    const inReach = locked && Math.hypot(locked.x - u.x, locked.z - u.z) <= u.attackRangeTo(locked, u.stats()) + 0.35;
    const target = (locked && inReach) ? locked : this.findAim('enemy', Math.max(2, u.stats().range + 2), true);
    if (!target) {
      if (!fromTick) this.ui.toast('Aim at an enemy in weapon range', 'warn');
      return false;
    }
    if (u.state !== STATE.CONTROLLED) {
      u.state = STATE.CONTROLLED; u.path = null; u.targetPos = null; u.target = null; u.destX = u.destZ = null;
    }
    u.desiredFacing = this.camera.firstPerson.yaw;
    const before = target.hp;
    u.performAttack(target, u.stats());
    this.target = target;
    /* melee lands now: show it. Ranged is polled in updateHud as the arrow
       arrives, so the number appears where and when the damage does. */
    const after = target.hp;
    if (after < before) this.hitFeedback(target, before - after);
    this.el.fpEquipment?.classList.add('is-striking');
    clearTimeout(this._strikeT);
    this._strikeT = setTimeout(() => this.el.fpEquipment?.classList.remove('is-striking'), 130);
    this.camera.fpImpact(0.05, 0.6);
    return true;
  }

  hitFeedback(target, amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const crit = target.hp <= 0;
    this.floatText(Math.round(amount), crit ? 'kill' : 'damage');
    this.el.fpReticle?.classList.add('hit');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => this.el.fpReticle?.classList.remove('hit'), 110);
    if (crit) {
      this.feedback('KILL', 'kill');
      this.camera.fpImpact(0.10, 1.4);
    }
  }

  floatText(text, kind) {
    const box = this.el.fpFloats;
    if (!box) return;
    if (box.childElementCount > 14) box.firstElementChild?.remove();
    const node = document.createElement('span');
    node.className = `fpFloat ${kind || ''}`;
    node.textContent = String(text);
    const jx = (this.game.rng() - 0.5) * 34;
    node.style.left = `calc(50% + ${jx.toFixed(0)}px)`;
    node.style.top = 'calc(50% - 26px)';
    box.appendChild(node);
    setTimeout(() => node.remove(), 900);
  }

  /** A short, loud line of text near the reticle: PARRY, BLOCK, +heal. */
  feedback(text, kind = '') {
    const buzz = { parry: 18, kill: [12, 30, 18], dodge: 8, undying: [24, 40, 24], lock: 10, block: 6, heal: 6 }[kind];
    if (buzz) this._buzz(buzz);
    const box = this.el.fpFeed;
    if (!box) return;
    box.textContent = text;
    box.className = `fpFeed show ${kind}`;
    this._feedT = 1.1;
  }

  /* ==========================================================
     interaction
     ========================================================== */
  interact() {
    const u = this.unit, g = this.game;
    if (!this.canAct()) return false;
    this.camera.update(0);
    const target = this.findAim('interact', 18);
    if (!target) { this.ui.toast('Aim at a resource, wounded ally or damaged building', 'warn'); return false; }
    if (u.type === 'villager') {
      if (target.kind === 'resource') g.orderGather([u], target);
      else if (target.buildProgress < 1) g.orderBuild([u], target);
      else g.orderRepair([u], target);
    } else if (u.def.classes.includes('monk')) {
      if (target.team === u.team) g.orderHeal([u], target);
      else g.orderConvert([u], target);
    } else return false;
    this.ui.toast(`Working with ${target.name || target.type} · move to take control`, 'good');
    return true;
  }

  /* ==========================================================
     squads: orders from inside the body
     ========================================================== */
  squadOf() {
    const u = this.unit;
    if (!u) return null;
    if (u.squad) return u.squad;
    /* no squad? use the nearest one that still has living members */
    let best = null, bestD = Infinity;
    for (const s of this.game.squads.list) {
      const alive = s.members.filter((m) => !m.dead && !m.garrisoned);
      if (!alive.length) continue;
      const d = Math.min(...alive.map((m) => Math.hypot(m.x - u.x, m.z - u.z)));
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  squadMembers(squad) {
    return (squad ? squad.members : []).filter((m) => !m.dead && !m.garrisoned && m.team === this.game.playerTeam && m !== this.unit);
  }

  followSquad() {
    const squad = this.squadOf();
    if (!squad) { this.ui.toast('Form a squad in the Squads panel, then they can follow you', 'warn'); return false; }
    const members = this.squadMembers(squad).filter((m) => !m.def.classes.includes('monk'));
    if (!members.length) { this.ui.toast(`${squad.name} has nobody else on the field`, 'warn'); return false; }
    const count = this.game.guards.assign(members, this.unit);
    this.ui.toast(`${count} of ${squad.name} fall in behind you`, 'good');
    this.feedback('FOLLOW', 'order');
    return count > 0;
  }

  focusSquad() {
    const squad = this.squadOf();
    if (!squad) { this.ui.toast('Form a squad first — then they can strike what you strike', 'warn'); return false; }
    this.camera.update(0);
    const target = this.target && !this.target.dead
      ? this.target
      : this.findAim('enemy', 60, false);
    if (!target || target.dead) { this.ui.toast('Look at an enemy to focus the squad', 'warn'); return false; }
    const members = this.squadMembers(squad).filter((m) => m.def.attack > 0);
    if (!members.length) { this.ui.toast(`${squad.name} has no fighters nearby`, 'warn'); return false; }
    this.game.orderAttack(members, target);
    this.ui.toast(`${squad.name} focuses ${target.name || target.type}`, 'good');
    this.feedback('FOCUS', 'order');
    return true;
  }

  /* ==========================================================
     the Champion card
     ========================================================== */
  _refreshChampionUi() {
    const u = this.unit, c = this.game.champions;
    if (!u || !c) return;
    const pr = rankProgress(u);
    const rank = CHAMPION_RANKS[pr.rank];
    if (this.el.fpRank) this.el.fpRank.textContent = rank.name.toUpperCase();
    if (this.el.fpRenownFill) this.el.fpRenownFill.style.width = `${(pr.frac * 100).toFixed(0)}%`;
    const st = u.champion;
    const picks = st ? st.picks.length : 0;
    const pending = c.pendingChoices(u);
    if (this.el.fpPerkCount) {
      this.el.fpPerkCount.textContent = pending ? `${pending} perk${pending === 1 ? '' : 's'} to choose` : `${picks} perk${picks === 1 ? '' : 's'}`;
      this.el.fpPerkCount.classList.toggle('ready', pending > 0);
    }
    this.el.fpPerkOpen?.classList.toggle('ready', pending > 0);
    this.el.fpChampionBadge?.classList.toggle('hidden', !pending);
    this.el.fpRally?.classList.toggle('hidden', !c.canRally(u) && c.rallyCooldown(u) <= 0 && !this._hasRally(u));
    this.el.fpStaminaFill?.parentElement?.classList.toggle('low', (st?.stamina ?? 100) < 25);
  }

  _hasRally(u) {
    const m = this.game.champions.mods(u);
    return !!(m && m.rally);
  }

  openPerks() {
    const c = this.game.champions, u = this.unit;
    if (!c || !u) return false;
    if (c.pendingChoices(u) <= 0) {
      const pr = rankProgress(u);
      this.ui.toast(pr.max ? `${u.name} is a Legend — every perk earned`
        : `${CHAMPION_RANKS[pr.rank].name} · ${Math.round(u.champion.renown)} renown · next at ${pr.next}`, 'info');
      return false;
    }
    const offers = c.offers(u);
    const box = this.el.fpPerkCards;
    if (!box) return false;
    const frag = document.createDocumentFragment();
    offers.forEach((perk, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.perk = perk.id;
      b.setAttribute('aria-label', `${perk.name}: ${perk.desc}`);
      const num = document.createElement('em'); num.textContent = String(i + 1);
      const title = document.createElement('b'); title.textContent = perk.name;
      const desc = document.createElement('small'); desc.textContent = perk.desc;
      const cat = document.createElement('span'); cat.className = 'fpPerkCat'; cat.textContent = perk.cat.toUpperCase();
      b.append(num, title, desc, cat);
      frag.appendChild(b);
    });
    box.replaceChildren(frag);
    if (this.el.fpPerkSub) {
      this.el.fpPerkSub.textContent = `${CHAMPION_RANKS[c.rank(u)].name} — choose one of three`;
    }
    this.el.fpPerkPanel?.classList.remove('hidden');
    /* Time stops for a decision. It is the one pause in the game that is a
       reward rather than an interruption. */
    if (!this.app.paused) { this.app.paused = true; this._pausedForPerks = true; }
    this.resetInput();
    return true;
  }

  pickPerk(id) {
    const c = this.game.champions, u = this.unit;
    if (!c || !u) return false;
    const result = c.choose(u, id);
    if (!result.ok) { this.ui.toast(result.reason, 'warn'); return false; }
    this.ui.toast(`${u.name}: ${result.perk.name} — ${result.perk.desc}`, 'good');
    this.game.fx?.glowPulse?.(u.x, u.y + 1.3, u.z, 1, 0.85, 0.4);
    this.game.sound?.play?.('ageUp');
    this._refreshChampionUi();
    this.updateHud();
    if (c.pendingChoices(u) > 0) { this.openPerks(); return true; }
    this.closePerks(true);
    return true;
  }

  closePerks(resume = true) {
    this.el.fpPerkPanel?.classList.add('hidden');
    if (this._pausedForPerks && resume && this.app.paused) this.app.paused = false;
    this._pausedForPerks = false;
  }

  /* ==========================================================
     Arcane Order (unchanged rules, unchanged implementation)
     ========================================================== */
  arcane() {
    if (!this.unit?.modState?.arcane || !this.unit.def?.caster) return null;
    return this.game.modHost?.mods.get('arcane') || null;
  }

  availableSpells() {
    const entry = this.arcane();
    if (!entry) return [];
    const rank = this.unit.modState.arcane.rank || 1;
    const list = entry.mod.spells().map((s) => ({ ...s, locked: rank < (s.rank || 1) }));
    for (const h of entry.mod.hybrids()) if (entry.state.discovered.has(h.id)) list.push({ ...h, locked: false });
    return list;
  }

  aimPoint(spell) {
    const u = this.unit, cam = this.camera, g = this.game;
    const range = spell.range || 14;
    if (range <= 2) return [u.x, u.z];
    const mobility = spell.id === 'construction' || spell.id === 'blink' || spell.id === 'tempest' || spell.id === 'golem' || spell.id === 'phoenix';
    const target = mobility ? null : this.findAim('enemy', Math.min(range, 70));
    let x, z;
    if (target) { x = target.x; z = target.z; }
    else if (cam.pickGround(0.5, 0.5, g.heightAt, this._ground)) { x = this._ground[0]; z = this._ground[2]; }
    else {
      const d = Math.min(range * 0.85, 45);
      const dir = cam.lookDir(this._look || (this._look = [0, 0, 0]));
      x = u.x + dir[0] * d;
      z = u.z + dir[2] * d;
    }
    let dx = x - u.x, dz = z - u.z;
    const d = Math.hypot(dx, dz);
    if (d > range - 0.05) { const k = (range - 0.05) / d; dx *= k; dz *= k; }
    return [clamp(u.x + dx, -250, 250), clamp(u.z + dz, -250, 250)];
  }

  cast(id, mapPoint = null) {
    const entry = this.arcane();
    if (!entry || !this.canAct()) return false;
    const spell = this.availableSpells().find((s) => s.id === id);
    if (!spell) return false;
    if (spell.locked) { this.ui.toast(`${spell.name} unlocks at mage rank ${spell.rank}`, 'warn'); return false; }
    if (id === 'skyfall' && !mapPoint) {
      const state = this.unit.modState.arcane;
      if (state.mana < spell.cost) { this.ui.toast(`${spell.name}: not enough mana`, 'warn'); return false; }
      if (entry.state.skyday === Math.floor(this.game.time / (entry.mod.dayLength?.() || 240))) { this.ui.toast('The sky returns tomorrow', 'warn'); return false; }
      this.openGlobalMap(id);
      return true;
    }
    this.camera.update(0);
    const [x, z] = mapPoint || this.aimPoint(spell);
    const result = this.game.modHost._guard(entry.mod, () => entry.mod.castSpell(entry.api, this.unit, spell, x, z));
    if (result) {
      this.game.champions?.addRenown(this.unit, 6, 'spell');
      this.game.champions && (this.game.champions.stats.spells++);
    }
    this.spellSignature = '';
    this.refreshSpells();
    return !!result;
  }

  toggleBuildShelf(open = this.el.fpBuildShelf?.classList.contains('hidden')) {
    if (!this.canAct() || this.unit.type !== 'villager') return;
    if (open) {
      this.game.placing = null;
      this.el.fpSpellShelf?.classList.add('hidden');
      this.closeGlobalMap();
      this.refreshBuilds();
    }
    this.el.fpBuildShelf?.classList.toggle('hidden', !open);
    this.updateHud();
  }

  refreshBuilds() {
    const list = this.el.fpBuildList, u = this.unit, g = this.game;
    if (!list || !u) return;
    const age = g.ageOf(u.team), types = [...BUILD_TYPES];
    if (g.modHost) for (const type of g.modHost.buildTypes(u.team)) if (!types.includes(type)) types.push(type);
    const frag = document.createDocumentFragment();
    for (const type of types) {
      const def = BUILDING_DEFS[type];
      if (!def) continue;
      const cost = g.buildingCost(type, u.team);
      const price = Object.entries(cost).filter(([, n]) => n).map(([kind, n]) => `${n}${kind[0].toUpperCase()}`).join(' ');
      const req = BUILDING_AGE[type] || 0;
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.build = type; b.className = 'fpSpell';
      b.classList.toggle('locked', req > age || !g.canAfford(u.team, cost));
      const title = document.createElement('span'), detail = document.createElement('small');
      title.textContent = def.name; detail.textContent = `${price || 'Free'}${req > age ? ` · Age ${req + 1}` : ''}`;
      b.append(title, detail); frag.appendChild(b);
    }
    list.replaceChildren(frag);
  }

  chooseBuild(type) {
    const u = this.unit, g = this.game, def = BUILDING_DEFS[type];
    if (!this.canAct() || u.type !== 'villager' || !def) return;
    if ((BUILDING_AGE[type] || 0) > g.ageOf(u.team)) { this.ui.toast('Requires a later age', 'warn'); return; }
    if (!g.canAfford(u.team, g.buildingCost(type, u.team))) { this.ui.toast('Not enough resources', 'warn'); return; }
    g.placing = { type, builders: [u], x: u.x, z: u.z, y: u.y, footprint: def.size || 3, valid: false };
    this.el.fpBuildShelf?.classList.add('hidden');
    this.ui.toast(`Aim at the ground and press PLACE for ${def.name}`, 'gold');
    this.updateHud();
  }

  placeBuild() {
    if (!this.canAct() || !this.game.placing) return false;
    const u = this.unit, g = this.game, type = g.placing.type;
    this.camera.update(0);
    const [x, z] = this.aimPoint({ id: 'construction', range: 10 });
    const spot = g.canPlaceAt(type, u.team, x, z);
    if (!spot.ok) { this.ui.toast(`Cannot build here: ${spot.reason || 'blocked'}`, 'warn'); return false; }
    const b = g.placeBuilding(type, u.team, x, z);
    if (!b) { this.ui.toast('Cannot place that building', 'warn'); return false; }
    g.placing = null;
    this.attackHeld = false;
    this.el.fpAttack?.classList.remove('pressed');
    this.el.fpEquipment?.classList.remove('is-striking');
    g.orderBuild([u], b);
    this.ui.toast(`${b.name} placed · move to take control`, 'good');
    this.updateHud();
    return true;
  }

  updatePlacement() {
    const p = this.game.placing, u = this.unit;
    if (!p || !u || u.type !== 'villager') return;
    this.camera.update(0);
    const [x, z] = this.aimPoint({ id: 'construction', range: 10 });
    p.x = x; p.z = z; p.y = this.game.heightAt(x, z);
    p.valid = this.game.canPlaceAt(p.type, u.team, x, z).ok;
  }

  openGlobalMap(id) {
    this.mapSpell = id;
    this.el.fpSpellShelf?.classList.add('hidden');
    this.ui.drawMinimap();
    const source = document.getElementById('minimap'), canvas = this.el.fpMapCanvas;
    if (source && canvas) canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    this.el.fpMap?.classList.remove('hidden');
  }

  closeGlobalMap() { this.mapSpell = null; this.el.fpMap?.classList.add('hidden'); }

  attune(id) {
    const entry = this.arcane();
    if (!entry || !this.canAct()) return false;
    const result = this.game.modHost._guard(entry.mod, () => entry.mod.attune(entry.api, this.unit, id));
    this.spellSignature = '';
    this.refreshSpells();
    return !!result;
  }

  refreshSpells() {
    const entry = this.arcane(), box = this.el.fpSpellList;
    if (!entry || !box || this.el.fpSpellShelf?.classList.contains('hidden')) return;
    const state = this.unit.modState.arcane, rank = state.rank || 1;
    const spells = this.availableSpells();
    const pairs = rank >= 3 ? entry.mod.attunementPairs().filter((p) => !entry.state.discovered.has(p.id)) : [];
    const sig = `${rank}|${Math.floor(state.mana)}|${spells.map((s) => `${s.id}:${Math.max(0, Math.ceil((state.cd[s.id] || 0) - this.game.time))}`).join(',')}|${entry.state.skyday}|${pairs.map((p) => p.id).join(',')}`;
    if (sig === this.spellSignature) return;
    this.spellSignature = sig;
    const scroll = box.scrollLeft;
    const frag = document.createDocumentFragment();
    for (const s of spells) {
      const cd = Math.max(0, Math.ceil((state.cd[s.id] || 0) - this.game.time));
      const daily = s.daily && entry.state.skyday === Math.floor(this.game.time / (entry.mod.dayLength?.() || 240));
      const text = s.locked ? `Rank ${s.rank}` : daily ? 'Tomorrow' : cd ? `${cd}s` : `${s.cost || 0} mana`;
      const b = document.createElement('button'); b.type = 'button'; b.className = `fpSpell${s.locked || cd || daily || state.mana < s.cost ? ' locked' : ''}`;
      b.dataset.spell = s.id; b.title = `${s.name}: ${s.desc || ''}`;
      b.setAttribute('aria-label', `${s.name}, ${text}. ${s.desc || ''}`);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'ic');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${iconFor(s.icon)}`); svg.appendChild(use);
      const label = document.createElement('span'); label.textContent = s.name;
      const cost = document.createElement('small'); cost.textContent = text;
      b.append(svg, label, cost); frag.appendChild(b);
    }
    for (const pair of pairs) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fpSpell';
      b.dataset.spell = pair.id; b.dataset.attune = '1'; b.title = `Attune ${pair.name}: ${pair.desc}`;
      b.textContent = `Attune ${pair.name}`;
      const cost = document.createElement('small'); cost.textContent = '80 mana'; b.appendChild(cost); frag.appendChild(b);
    }
    box.replaceChildren(frag); box.scrollLeft = scroll;
  }

  /* ==========================================================
     per-frame HUD
     ========================================================== */
  frame(dt) {
    if (!this.unit) return;
    const u = this.unit;
    if (u.dead || u.team !== this.game.playerTeam || u.garrisoned || u.state === STATE.ROUT || this.game.gameOver) {
      this.exit(u.dead ? 'Your Champion has fallen' : 'Direct control ended');
      return;
    }
    /* the possessed body stepped in a gate / got converted: drop the lens */
    if (u.state === STATE.ROUT) { this.exit('Your unit has broken and is running'); return; }
    if (this.camera.firstPerson) this.camera.firstPerson.bobScale = this.bobEnabled ? 1 : 0;
    this._rotCheck += dt;
    if (this._rotCheck > 0.5) { this._rotCheck = 0; this._syncOrientation(); }
    this.hudAcc += dt;
    if (this._feedT > 0) {
      this._feedT -= dt;
      if (this._feedT <= 0) this.el.fpFeed?.classList.remove('show');
    }
    if (this._hintT > 0) {
      this._hintT -= dt;
      if (this._hintT <= 0) this.el.fpHint?.classList.remove('show');
    }
    /* arrows land later than the swing: watch the aimed target's health */
    const t = this.target;
    if (t && !t.dead) {
      const seen = this._seenHp.get(t);
      if (seen !== undefined && t.hp < seen - 0.5) this.hitFeedback(t, seen - t.hp);
      this._seenHp.set(t, t.hp);
      if (this._seenHp.size > 12) this._seenHp.clear();
    }
    if (this.hudAcc >= 0.12) { this.hudAcc = 0; this.updateHud(); }
  }

  updateHud() {
    const u = this.unit, e = this.el, c = this.game.champions;
    if (!u) return;
    if (this.game.placing) this.updatePlacement();
    if (e.fpName) e.fpName.textContent = u.name;
    const squad = u.squad ? ` · ${u.squad.name}` : '';
    const rankName = u.rank ? this.game.veterancy.name(u) : 'Recruit';
    if (e.fpDetail) e.fpDetail.textContent = `${rankName}${squad}${u.state !== STATE.CONTROLLED ? ' · working' : ''}`;
    const hpFrac = clamp(u.hp / Math.max(1, u.maxHp), 0, 1);
    if (e.fpHealthFill) e.fpHealthFill.style.width = `${hpFrac * 100}%`;
    document.body.classList.toggle('lowHealth', hpFrac < 0.32);
    const mana = u.modState?.arcane;
    const rankInfo = this.arcane()?.mod.rankOf(u);
    const manaCap = rankInfo ? rankInfo.mana + (c ? c.manaMax(u) : 0) : 0;
    if (e.fpVitals) {
      e.fpVitals.textContent = `HP ${Math.ceil(u.hp)} / ${Math.ceil(u.maxHp)}${mana ? `  ·  MANA ${Math.floor(mana.mana)} / ${manaCap}` : ''}`;
    }
    /* stamina + renown */
    const st = u.champion;
    if (c && st) {
      if (e.fpStaminaFill) e.fpStaminaFill.style.width = `${clamp(st.stamina / c.staminaMax(), 0, 1) * 100}%`;
      const pr = rankProgress(u);
      if (e.fpRenownFill) e.fpRenownFill.style.width = `${(pr.frac * 100).toFixed(0)}%`;
      this._refreshChampionUi();
      if (e.fpBlock) {
        const up = !!st.blocking;
        this.blockHeld = up;
        e.fpBlock.classList.toggle('active', up);
        e.fpBlock.textContent = up ? 'LOWER' : 'BLOCK';
        if (!up) e.fpBlock.classList.toggle('cooling', st.stamina < 12);
      }
      if (e.fpDodge) {
        const cd = c.dodgeCooldown(u);
        e.fpDodge.textContent = cd > 0 ? `${cd.toFixed(1)}s` : 'DODGE';
        e.fpDodge.classList.toggle('cooling', cd > 0 || st.stamina < 22);
      }
      if (e.fpRally) {
        if (this._hasRally(u)) {
          const cd = c.rallyCooldown(u);
          e.fpRally.classList.remove('hidden');
          e.fpRally.textContent = cd > 0 ? `RALLY ${Math.ceil(cd)}` : 'RALLY';
          e.fpRally.classList.toggle('cooling', cd > 0);
        } else e.fpRally.classList.add('hidden');
      }
    }
    const target = u.def.attack > 0 && !u.def.classes.includes('monk')
      ? this.findAim('enemy', Math.max(2, u.stats().range + 2), true)
      : this.findAim('interact', 18);
    this.target = target;
    e.fpReticle?.classList.toggle('locked', !!target);
    const lock = this.lockTarget();
    if (lock) e.fpReticle?.classList.add('locked');
    if (e.fpTarget) {
      e.fpTarget.textContent = this.game.placing
        ? `PLACE ${BUILDING_DEFS[this.game.placing.type]?.name?.toUpperCase() || 'BUILDING'}`
        : target
          ? `${target.name || target.type} · ${Math.round(Math.hypot(target.x - u.x, target.z - u.z))} M · ${Math.ceil(Math.max(0, target.hp))}/${Math.ceil(target.maxHp || target.def?.hp || 1)}`
          : 'LOOK TO AIM';
    }
    const label = e.fpAttack?.querySelector('span');
    if (label) label.textContent = this.game.placing ? 'PLACE' : (this.equipment === 'bow' ? 'SHOOT' : 'ATTACK');
    /* compass */
    this._updateCompass();
    /* squad strip */
    this._updateSquadStrip();
    this.refreshSpells();
  }

  /**
   * A phone held upright halves the horizon and puts both thumbs in the
   * middle of the picture. Say so once, quietly, instead of letting the
   * player work it out; the game stays playable either way.
   */
  _syncOrientation() {
    const portrait = (() => {
      try { return !!(window.matchMedia && window.matchMedia('(orientation: portrait)').matches); } catch (e) { return false; }
    })();
    this.el.fpRotate?.classList.toggle('show', portrait);
    const size = this.settings.buttonSize;
    document.body.dataset.fpButtons = size === 'large' ? 'large' : size === 'compact' ? 'compact' : 'comfortable';
  }

  _updateCompass() {
    const tape = this.el.fpCompassTape;
    if (!tape) return;
    const yaw = this.camera.firstPerson ? this.camera.firstPerson.yaw : this.camera.yaw;
    /* yaw 0 looks toward +z. Split the tape into 8 named sectors. */
    const turns = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const width = tape.scrollWidth || 480;
    const offset = -(turns / (Math.PI * 2)) * (width / 3) - width / 3;
    tape.style.transform = `translateX(${offset.toFixed(1)}px)`;
    const idx = Math.round(turns / (Math.PI / 4)) % 8;
    if (this.el.fpCompassCard) this.el.fpCompassCard.textContent = COMPASS_POINTS[idx];
  }

  _updateSquadStrip() {
    const box = this.el.fpSquad;
    if (!box) return;
    const squad = this.squadOf();
    if (!squad) { box.classList.add('hidden'); return; }
    const members = this.squadMembers(squad);
    box.classList.remove('hidden');
    if (this.el.fpSquadName) this.el.fpSquadName.textContent = squad.name;
    if (this.el.fpSquadInfo) {
      const rank = this.game.squads.rank(squad);
      this.el.fpSquadInfo.textContent = `${members.length} near · ${['Formed', 'Drilled', 'Battlebound', 'Elite'][rank]}`;
    }
  }
}
