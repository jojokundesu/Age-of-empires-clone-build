/* ============================================================
   direct-control.js — possession, not a second simulation

   One body, the same movement rules, combat cooldowns, projectiles,
   morale, fog and Arcane Order spell implementation as the RTS.
   The camera and touch overlay cost nothing when not in use.
   ============================================================ */
import { clamp } from '../core/math.js';
import { STATE } from '../sim/entities.js';
import { BUILDING_DEFS, BUILDING_AGE } from '../sim/data.js';
import { iconFor } from './menu.js';

const LOOK_SENSITIVITY = 0.004;
const STICK_RADIUS = 48;
const MOVE_DEADZONE = 0.12;
const AIM_CONE = 0.27; // radians, about 15 degrees; only for visible enemies
const PRECISE_CONE = 0.035;
const BUILD_TYPES = ['house','farm','supply_tent','mill','lumber_camp','mining_camp','barracks','archery_range',
  'stable','blacksmith','market','watch_tower','palissade_wall','stone_wall','stone_gate','monastery',
  'siege_workshop','university','castle','dock','wonder'];

// A decorative held kit follows the actual unit's weapon; vehicles, animals
// and other handless units intentionally have no human hand overlay.
function equipmentFor(unit) {
  const def = unit.def, classes = def.classes || [];
  if (unit.type === 'villager') return 'tool';
  if (def.caster) return 'staff';
  if (classes.includes('monk')) return 'relic';
  if (def.naval || def.siege || ['war_elephant','dire_wolf','bear','stone_golem','plague_zombie','trade_cart'].includes(unit.type)) return 'none';
  if (def.projectile === 'arrow') return 'bow';
  if (def.projectile === 'javelin' || def.icon === 'spear') return 'spear';
  if (def.icon === 'axe' || def.projectile === 'axe') return 'axe';
  if (def.projectile === 'ball') return 'none';
  return def.attack > 0 ? 'sword' : 'none';
}

export class DirectControl {
  constructor({ game, camera, input, ui, app }) {
    this.game = game;
    this.camera = camera;
    this.input = input;
    this.ui = ui;
    this.app = app;
    this.unit = null;
    this.aimAssist = true;
    this.stickX = 0;
    this.stickY = 0;
    this.attackHeld = false;
    this.pointers = new Map();
    this.keys = new Set();
    this.target = null;
    this.hudAcc = 0;
    this.spellSignature = '';
    this.mapSpell = null;
    this._ground = [0, 0, 0];
    this.el = {};
    for (const id of ['fpLayer', 'fpName', 'fpDetail', 'fpHealthFill', 'fpVitals', 'fpReticle', 'fpTarget',
      'fpEquipment', 'fpStick', 'fpStickKnob', 'fpAimToggle', 'fpPause', 'fpExit', 'fpAttack', 'fpInteract', 'fpBuild',
      'fpSpells', 'fpSpellShelf', 'fpShelfClose', 'fpSpellList', 'fpBuildShelf', 'fpBuildClose', 'fpBuildList',
      'fpMap', 'fpMapClose', 'fpMapCanvas']) this.el[id] = document.getElementById(id);
    this._wire();
  }

  get active() { return !!this.unit; }
  canAct() { return !!this.unit && !this.unit.dead && this.unit.team === this.game.playerTeam && !this.unit.garrisoned &&
    this.unit.state !== STATE.ROUT && !this.game.gameOver && !this.app.paused; }

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
    if (e.fpSpellList) e.fpSpellList.onclick = (event) => {
      const b = event.target.closest('button[data-spell]');
      if (!b) return;
      if (b.dataset.attune === '1') this.attune(b.dataset.spell);
      else this.cast(b.dataset.spell);
    };
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
      // A keyboard-generated click has no pointerdown.
      attack.onclick = (event) => { if (event.detail === 0) this.attackOnce(); };
    }
  }

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
    this.game.setSelection([unit]);
    this.camera.enterFirstPerson(unit);
    this.camera.update(0, { instant: true });
    document.body.classList.add('firstPerson');
    this.el.fpLayer?.classList.remove('hidden');
    this.el.fpSpellShelf?.classList.add('hidden');
    this.el.fpBuildShelf?.classList.add('hidden');
    this.closeGlobalMap();
    this.el.fpInteract?.classList.toggle('hidden', !(unit.type === 'villager' || unit.def.classes.includes('monk')));
    this.el.fpBuild?.classList.toggle('hidden', unit.type !== 'villager');
    const mage = !!this.arcane();
    this.el.fpSpells?.classList.toggle('hidden', !mage);
    if (mage) this.el.fpSpellShelf?.classList.remove('hidden');
    this.el.fpAttack?.classList.toggle('hidden', !(unit.def.attack > 0) || unit.def.classes.includes('monk'));
    this.equipment = equipmentFor(unit);
    if (this.el.fpEquipment) this.el.fpEquipment.dataset.kind = this.equipment;
    const attackIcon = this.el.fpAttack?.querySelector('use');
    if (attackIcon) attackIcon.setAttribute('href', `#i-${({ bow: 'bow', spear: 'spear', axe: 'axe', tool: 'pick', staff: 'flame' })[this.equipment] || (unit.def.siege ? 'cannon' : 'sword')}`);
    this.spellSignature = '';
    this.updateHud();
    this.ui.toast('Left: move · right: look · hold attack', 'info');
    return true;
  }

  exit(message = '') {
    const unit = this.unit;
    if (!unit) return;
    this.resetInput();
    this.camera.exitFirstPerson();
    this.unit = null;
    if (!unit.dead && !unit.garrisoned && unit.team === this.game.playerTeam && unit.state === STATE.CONTROLLED) unit.stop();
    document.body.classList.remove('firstPerson');
    this.el.fpLayer?.classList.add('hidden');
    this.el.fpSpellShelf?.classList.add('hidden');
    this.el.fpBuildShelf?.classList.add('hidden');
    this.closeGlobalMap();
    this.game.placing = null;
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
    this.pointers.clear(); this.keys.clear();
    this.stickX = this.stickY = 0;
    this.attackHeld = false;
    this.el.fpAttack?.classList.remove('pressed');
    this.el.fpEquipment?.classList.remove('is-striking');
    this._resetStick();
  }

  _resetStick() {
    const el = this.el.fpStick, knob = this.el.fpStickKnob;
    if (el) { el.style.left = ''; el.style.top = ''; el.style.bottom = ''; el.style.transform = ''; }
    if (knob) knob.style.transform = '';
  }

  pointerDown(event) {
    if (!this.canAct()) return false;
    event.preventDefault();
    this.input.canvas.setPointerCapture?.(event.pointerId);
    const rect = this.input.rect();
    const left = event.clientX - rect.left < rect.width * 0.48;
    const role = left && ![...this.pointers.values()].some((p) => p.role === 'move') ? 'move' : 'look';
    const p = { role, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY };
    this.pointers.set(event.pointerId, p);
    if (role === 'move') {
      const stick = this.el.fpStick;
      if (stick) { stick.style.left = `${event.clientX}px`; stick.style.top = `${event.clientY}px`; stick.style.bottom = 'auto'; stick.style.transform = 'translate(-50%, -50%)'; }
      this.stickX = this.stickY = 0;
    }
    return true;
  }

  pointerMove(event) {
    if (!this.active) return false;
    const p = this.pointers.get(event.pointerId);
    if (!p) return true;
    event.preventDefault();
    if (p.role === 'move') {
      let x = (event.clientX - p.sx) / STICK_RADIUS;
      let y = (event.clientY - p.sy) / STICK_RADIUS;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.stickX = x; this.stickY = -y;
      if (this.el.fpStickKnob) this.el.fpStickKnob.style.transform = `translate(${(x * 28).toFixed(1)}px, ${(y * 28).toFixed(1)}px)`;
    } else {
      this.camera.lookFirstPerson((event.clientX - p.x) * LOOK_SENSITIVITY, -(event.clientY - p.y) * LOOK_SENSITIVITY);
    }
    p.x = event.clientX; p.y = event.clientY;
    return true;
  }

  pointerUp(event) {
    if (!this.active) return false;
    const p = this.pointers.get(event.pointerId);
    if (p?.role === 'move') { this.stickX = this.stickY = 0; this._resetStick(); }
    this.pointers.delete(event.pointerId);
    event.preventDefault?.();
    return true;
  }

  keyDown(event) {
    if (!this.active) return false;
    if (this.app.paused) return true;
    const k = event.key.toLowerCase();
    if (k === 'escape') { event.preventDefault(); this.exit(); return true; }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k); event.preventDefault(); return true;
    }
    if (k === ' ') {
      event.preventDefault();
      if (!event.repeat) { this.attackHeld = true; this.attackOnce(); }
      return true;
    }
    if (k === 'f' && !event.repeat) { this.interact(); return true; }
    if (k >= '1' && k <= '9' && !event.repeat) {
      const spell = this.availableSpells().filter((s) => !s.locked)[Number(k) - 1];
      if (spell) this.cast(spell.id);
      return true;
    }
    return true; // RTS shortcuts must never issue orders while possessing a unit
  }

  keyUp(event) {
    if (!this.active) return;
    const k = event.key.toLowerCase();
    this.keys.delete(k);
    if (k === ' ') this.attackHeld = false;
  }

  movement() {
    let x = this.stickX, y = this.stickY;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y -= 1;
    const len = Math.hypot(x, y);
    if (len < MOVE_DEADZONE) return [0, 0];
    if (len > 1) { x /= len; y /= len; }
    return [x, y];
  }

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
    const [right, forward] = this.movement();
    const sy = Math.sin(fp.yaw), cy = Math.cos(fp.yaw);
    const speed = stats.speed * (u.speedMul || 1) * this.game.speedMulOnStep(u);
    const dx = (sy * forward + cy * right) * speed * dt;
    const dz = (cy * forward - sy * right) * speed * dt;
    u.desiredFacing = fp.yaw;
    u.moving = false;
    if (dx || dz) {
      if (this._walkable(u, u.x + dx, u.z + dz)) { u.x += dx; u.z += dz; u.moving = true; }
      else if (this._walkable(u, u.x + dx, u.z)) { u.x += dx; u.moving = !!dx; }
      else if (this._walkable(u, u.x, u.z + dz)) { u.z += dz; u.moving = !!dz; }
    }
    if (this.attackHeld && u.attackCooldown <= 0) this.attackOnce(true);
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
      const dy = (e.y || 0) + Math.min(e.height || 1.7, 3) * 0.58 - cam.eye[1];
      const len = Math.hypot(dx, dy, dz) || 1;
      const dot = (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2]) / len;
      if (dot <= 0) return;
      const angle = Math.acos(clamp(dot, -1, 1));
      const allowance = Math.min(0.5, Math.atan2(r, Math.max(0.5, horizontal)));
      if (angle > cone + allowance) return;
      const score = Math.max(0, angle - allowance) + horizontal * 0.001;
      if (score < bestScore) { bestScore = score; best = e; }
    };
    const near = g.spatial.query(u.x, u.z, Math.min(70, range + 6));
    for (let i = 0; i < near.length; i++) consider(near[i]);
    for (const b of g.buildings) consider(b);
    if (kind === 'interact' && u.type === 'villager') {
      const resources = g.resourceSpatial.query(u.x, u.z, range + 5);
      for (let i = 0; i < resources.length; i++) consider(resources[i]);
    }
    return best;
  }

  attackOnce(fromTick = false) {
    const u = this.unit;
    if (!this.canAct()) return false;
    // Placement is a single press, not a continuously repeated attack. In
    // particular, holding PLACE across a fixed tick must not cancel the new
    // builder order or flood the player with an invalid-placement toast.
    if (this.game.placing && u.type === 'villager') return fromTick ? false : this.placeBuild();
    if (!u.def.attack || u.def.classes.includes('monk')) return false;
    if (u.attackCooldown > 0) return false;
    const frozen = u.modState?.arcane?.freeze;
    if (frozen && frozen > this.game.time) return false;
    // Use the current look direction, even between rendered frames.
    this.camera.update(0);
    const target = this.findAim('enemy', Math.max(2, u.stats().range + 2), true);
    if (!target) {
      if (!fromTick) this.ui.toast('Aim at an enemy in weapon range', 'warn');
      return false;
    }
    if (u.state !== STATE.CONTROLLED) {
      u.state = STATE.CONTROLLED; u.path = null; u.targetPos = null; u.target = null; u.destX = u.destZ = null;
    }
    u.desiredFacing = this.camera.firstPerson.yaw;
    u.performAttack(target, u.stats());
    this.target = target;
    return true;
  }

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
      x = u.x + Math.sin(cam.firstPerson.yaw) * d;
      z = u.z + Math.cos(cam.firstPerson.yaw) * d;
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
      const b = document.createElement('button');
      b.type = 'button'; b.className = `fpSpell${s.locked || cd || daily || state.mana < s.cost ? ' locked' : ''}`;
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

  frame(dt) {
    if (!this.unit) return;
    if (this.unit.dead || this.unit.team !== this.game.playerTeam || this.unit.garrisoned || this.unit.state === STATE.ROUT || this.game.gameOver) {
      this.exit(this.unit.dead ? 'Your unit has fallen' : 'Direct control ended');
      return;
    }
    this.hudAcc += dt;
    if (this.hudAcc >= 0.16) { this.hudAcc = 0; this.updateHud(); }
  }

  updateHud() {
    const u = this.unit, e = this.el;
    if (!u) return;
    if (this.game.placing) this.updatePlacement();
    if (e.fpName) e.fpName.textContent = u.name;
    const squad = u.squad ? ` · ${u.squad.name}` : '';
    if (e.fpDetail) e.fpDetail.textContent = `${u.rank ? this.game.veterancy.name(u) : 'Recruit'}${squad}${u.state !== STATE.CONTROLLED ? ' · working' : ''}`;
    if (e.fpHealthFill) e.fpHealthFill.style.width = `${clamp(u.hp / Math.max(1, u.maxHp), 0, 1) * 100}%`;
    const mana = u.modState?.arcane;
    const rankInfo = this.arcane()?.mod.rankOf(u);
    if (e.fpVitals) e.fpVitals.textContent = `HP ${Math.ceil(u.hp)} / ${Math.ceil(u.maxHp)}${mana ? `  ·  MANA ${Math.floor(mana.mana)} / ${rankInfo?.mana || 100}  ·  ${rankInfo?.title || 'Mage'}` : ''}`;
    const target = u.def.attack > 0 && !u.def.classes.includes('monk') ? this.findAim('enemy', Math.max(2, u.stats().range + 2), true) : this.findAim('interact', 18);
    this.target = target;
    e.fpReticle?.classList.toggle('locked', !!target);
    if (e.fpTarget) e.fpTarget.textContent = this.game.placing ? `PLACE ${BUILDING_DEFS[this.game.placing.type]?.name?.toUpperCase() || 'BUILDING'}` : target ? `${target.name || target.type} · ${Math.round(Math.hypot(target.x - u.x, target.z - u.z))} M` : 'LOOK TO AIM';
    const label = e.fpAttack?.querySelector('span'); if (label) label.textContent = this.game.placing ? 'PLACE' : (this.equipment === 'bow' ? 'SHOOT' : 'ATTACK');
    this.refreshSpells();
  }
}
