/* ============================================================
   input.js — pointer, touch and keyboard control
   Design goals:
     • one tap = one decision (no hidden double-taps needed)
     • drag always pans, pinch always zooms, twist always turns
     • picking is a screen-space test over nearby entities only
       (no recursive raycasts, no per-frame allocations)
   ============================================================ */
import { clamp } from '../core/math.js';
import { STATE } from '../sim/entities.js';

const TAP_MOVE_PX = 12;
const TAP_TIME_MS = 460;
const LONG_PRESS_MS = 540;

export class Input {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.game = opts.game;
    this.cam = opts.camera;
    this.ui = opts.ui;
    this.audio = opts.audio || null;
    this.enabled = true;
    this.cameraLocked = false;
    this.armed = null;               // { kind, ... } pending targeted command
    this.pointers = new Map();
    this.mode = 'idle';
    this.tapStart = { x: 0, y: 0, t: 0 };
    this.lastTap = { t: 0, target: null };
    this.dragMoved = 0;
    this.box = null;
    this.keys = new Set();
    this.edgePan = { x: 0, z: 0 };
    this._out = [0, 0, 0];
    this._ground = [0, 0, 0];
    this.pinchStart = 0;
    this.pinchDist = 0;
    this.angleStart = 0;
    this.lastTapEntity = null;
    this.lastTapTime = 0;
    this._bind();
  }

  attach() { return this; }

  _bind() {
    const c = this.canvas;
    const opt = { passive: false };
    this._onDown = (e) => this.pointerDown(e);
    this._onMove = (e) => this.pointerMove(e);
    this._onUp = (e) => this.pointerUp(e);
    this._onCancel = (e) => this.pointerCancel(e);
    this._onWheel = (e) => this.wheel(e);
    this._onKey = (e) => this.key(e);
    this._onContext = (e) => e.preventDefault();
    c.addEventListener('pointerdown', this._onDown, opt);
    c.addEventListener('pointermove', this._onMove, opt);
    c.addEventListener('pointerup', this._onUp, opt);
    c.addEventListener('pointercancel', this._onCancel, opt);
    c.addEventListener('wheel', this._onWheel, opt);
    c.addEventListener('contextmenu', this._onContext, opt);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  detach() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onCancel);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('keydown', this._onKey);
  }

  /* ---------------- coordinates ---------------- */
  /** Canvas rect with sane fallbacks (a hidden canvas measures 0 x 0). */
  rect() {
    const c = this.canvas;
    let r = null;
    if (c.getBoundingClientRect) {
      try { r = c.getBoundingClientRect(); } catch (e) { r = null; }
    }
    const w = (r && r.width) || c.clientWidth || window.innerWidth || 1;
    const h = (r && r.height) || c.clientHeight || window.innerHeight || 1;
    return { left: r ? r.left : 0, top: r ? r.top : 0, width: w, height: h };
  }

  ndc(clientX, clientY) {
    const r = this.rect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  }

  groundAt(clientX, clientY, out) {
    const [nx, ny] = this.ndc(clientX, clientY);
    const o = out || this._ground;
    o[0] = o[1] = o[2] = 0;
    const hit = this.cam.pickGround(nx, ny, this.game.heightAt, o);
    if (!hit) {
      // fall back to the plane through the camera target
      const t = this.cam.target;
      o[0] = t[0]; o[1] = t[1]; o[2] = t[2];
    }
    return o;
  }

  /**
   * Find what the player tapped. Units beat buildings beat resources,
   * and anything within `slop` pixels of the finger counts.
   */
  pick(clientX, clientY) {
    const r = this.rect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const w = r.width, h = r.height;
    const cam = this.cam;
    const cull = cam.dist * 2.2 + 40;
    const cx = cam.target[0], cz = cam.target[2];
    let best = null;
    let bestScore = 1e9;
    const test = (e, radiusPx, weight) => {
      const o = this._out;
      this._proj(e.x, (e.y || 0) + (e.kind === 'building' ? 1.2 : 0.9), e.z, o, w, h);
      if (!o[2]) return;
      const d = Math.hypot(o[0] - px, o[1] - py);
      const limit = radiusPx + Math.min(26, 700 / Math.max(1, o[2]));
      if (d > limit) return;
      const score = (d / limit) * weight;
      if (score < bestScore) { bestScore = score; best = e; }
    };
    const units = this.game.units;
    const near = this.game.spatial ? this.game.spatial.query(cx, cz, cull) : units;
    const list = near && near.length ? near : units;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!u || u.dead || u.garrisoned) continue;
      if (!this.game.isVisible(u.x, u.z) && u.team !== 1) continue;
      test(u, 16, 1.0);
    }
    const bList = this.game.buildings;
    for (let i = 0; i < bList.length; i++) {
      const b = bList[i];
      if (b.dead) continue;
      if (!this.game.isVisible(b.x, b.z) && b.team !== 1) continue;
      test(b, 40, 1.35);
    }
    if (best) return best;
    // resource nodes are only interesting to villagers
    const res = this.game.resources;
    for (let i = 0; i < res.length; i++) {
      const node = res[i];
      if (node.dead) continue;
      const dx = node.x - px, dz = node.z - py;
      test(node, 15, 1.6);
    }
    return best;
  }

  _proj(x, y, z, out, w, h) {
    const m = this.cam.viewProj;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.01) { out[2] = 0; return out; }
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    out[0] = (nx * 0.5 + 0.5) * w;
    out[1] = (-ny * 0.5 + 0.5) * h;
    out[2] = cw;
    return out;
  }

  /* ---------------- pointer events ---------------- */
  pointerDown(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), button: e.button, type: e.pointerType });
    e.preventDefault();
    if (this.pointers.size === 1) {
      this.dragMoved = 0;
      this.tapStart.x = e.clientX;
      this.tapStart.y = e.clientY;
      this.tapStart.t = performance.now();
      this.mode = e.pointerType === 'mouse' && e.button === 0 ? 'maybeBox' : 'maybePan';
      if (e.pointerType === 'mouse' && e.button === 2) this.mode = 'pan';
      this.longPressTimer = setTimeout(() => this._longPress(e.clientX, e.clientY), LONG_PRESS_MS);
    } else if (this.pointers.size === 2) {
      this.clearLongPress();
      this.mode = 'pinch';
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.angleStart = Math.atan2(b.y - a.y, b.x - a.x);
      this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.ui?.hideSelBox();
    }
  }

  pointerMove(e) {
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.hover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const moved = Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y);
    if (moved > TAP_MOVE_PX) { this.dragMoved = moved; this.clearLongPress(); }

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinchDist > 4) this.cam.zoom(clamp(this.pinchDist / dist, 0.9, 1.1));
      let dAng = angle - this.angleStart;
      if (dAng > Math.PI) dAng -= Math.PI * 2;
      if (dAng < -Math.PI) dAng += Math.PI * 2;
      if (Math.abs(dAng) < 0.35) this.cam.rotate(-dAng * 0.9);
      this.angleStart = angle;
      this.pinchDist = dist;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinchMid) this._panBy(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
      this.pinchMid = mid;
      return;
    }

    if (this.mode === 'maybeBox' || this.mode === 'box') {
      if (moved > TAP_MOVE_PX) {
        this.mode = 'box';
        this.box = {
          x0: Math.min(this.tapStart.x, e.clientX), y0: Math.min(this.tapStart.y, e.clientY),
          x1: Math.max(this.tapStart.x, e.clientX), y1: Math.max(this.tapStart.y, e.clientY)
        };
        this.ui?.showSelBox(this.box);
      }
      return;
    }
    if (this.mode === 'pan' || this.mode === 'maybePan') {
      if (moved > 4) this.mode = 'pan';
      if (this.mode === 'pan') this._panBy(dx, dy);
    }
  }

  pointerUp(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    if (!p) return;
    const dt = performance.now() - p.t;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (this.pointers.size === 0) {
      if (this.mode === 'box' && this.box) {
        this.commitBox(this.box);
        this.ui?.hideSelBox();
        this.box = null;
        this.mode = 'idle';
        return;
      }
      if (moved < TAP_MOVE_PX && dt < TAP_TIME_MS && this.mode !== 'pan') {
        this.tap(e.clientX, e.clientY);
      }
      this.mode = 'idle';
    } else if (this.pointers.size === 1) {
      this.mode = 'maybePan';
      const rest = [...this.pointers.values()][0];
      this.tapStart.x = rest.x; this.tapStart.y = rest.y; this.tapStart.t = performance.now();
    }
  }

  pointerCancel(e) {
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    this.ui?.hideSelBox();
    this.mode = 'idle';
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.cam.zoom(1 + Math.sign(e.deltaY) * 0.12);
  }

  clearLongPress() {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
  }

  _panBy(dx, dy) {
    const s = this.cam.dist * 0.0022;
    this.cam.pan(-dx * s, -dy * s * 1.9);
  }

  _longPress(x, y) {
    this.longPressTimer = null;
    if (!this.enabled) return;
    const units = this.game.selectionOfTeam(1).filter((u) => u.kind === 'unit' && u.def.attack > 0 && !u.def.classes.includes('villager'));
    if (!units.length) return;
    const g = this.groundAt(x, y);
    this.game.orderAttackMove(units, g[0], g[2]);
    this.game.marker(g[0], g[2], { kind: 1, r0: 1, g0: 0.35, b0: 0.3, r: 2.0 });
    this.audio?.play('order');
    this.ui?.toast('Attack-move', 'warn');
    if (navigator.vibrate) navigator.vibrate(12);
  }

  hover(x, y) {
    const e = this.pick(x, y);
    this.game.hoverEntity = e;
  }

  /* ---------------- taps ---------------- */
  tap(x, y) {
    const game = this.game;
    const hit = this.pick(x, y);
    const g = this.groundAt(x, y, [0, 0, 0]);
    const now = performance.now();
    const doubleTap = now - this.lastTapTime < 320 && this.lastTapEntity === hit;

    // 1. an armed command takes the tap
    if (this.armed) {
      const done = this._applyArmed(hit, g);
      if (done) return;
    }

    // 2. placement mode
    if (game.placing) {
      const p = game.placing;
      /* Legality was never checked on this path: the ghost knew where a
         foundation was legal, but a tap placed the building anyway, on top of
         a house or in the sea. */
      const spot = game.canPlaceAt(p.type, 1, g[0], g[2]);
      if (!spot.ok) {
        this.ui?.toast(spot.reason === 'blocked' ? 'Something is already there'
          : spot.reason === 'water' ? 'Cannot build in the water'
          : spot.reason === 'slope' ? 'The ground is too steep'
          : spot.reason === 'resource' ? 'Resources are in the way' : 'Cannot build there', 'warn');
        this.audio?.play('warn');
        return;
      }
      const built = game.placeBuilding(p.type, 1, g[0], g[2]);
      if (built) {
        /* And the villagers who opened the build menu actually go and build
           it. Without this the foundation sat at 2 % forever unless the player
           guessed that they had to order it a second time. */
        const crew = (p.builders && p.builders.length ? p.builders : game.selectionOfTeam(1))
          .filter((u) => u && !u.dead && u.type === 'villager');
        if (crew.length) game.orderBuild(crew, built);
        this.audio?.play('build');
        game.placing = null;
        this.ui?.refreshCommands();
        if (navigator.vibrate) navigator.vibrate(16);
      } else {
        this.ui?.toast('Cannot build there', 'warn');
        this.audio?.play('warn');
      }
      return;
    }

    const own = game.selectionOfTeam(1);

    // 3. tap on an entity
    if (hit) {
      if (hit.team === 1) {
        if (own.length && hit !== game.selection[0] && (hit.kind === 'building') && this._contextOrder(hit, own, g)) return;
        this.selectEntity(hit, doubleTap);
        this.lastTapEntity = hit;
        this.lastTapTime = now;
        return;
      }
      // enemy / neutral / resource
      if (own.length) {
        if (hit.kind === 'resource') {
          const villagers = own.filter((u) => u.type === 'villager');
          if (villagers.length) {
            game.orderGather(villagers, hit);
            game.marker(hit.x, hit.z, { r: Math.max(1.4, hit.radius * 2), r0: 0.9, g0: 0.85, b0: 0.4 });
            this.audio?.play('order');
            return;
          }
        }
        const army = own.filter((u) => u.kind === 'unit' && u.def.attack > 0);
        if (army.length) {
          game.orderAttack(army, hit);
          game.marker(hit.x, hit.z, { r: 1.8, r0: 1, g0: 0.3, b0: 0.25 });
          this.audio?.play('order');
          return;
        }
      }
      this.selectEntity(hit, doubleTap);
      this.lastTapEntity = hit;
      this.lastTapTime = now;
      return;
    }

    // 4. tap on the ground
    if (own.length) {
      const units = own.filter((u) => u.kind === 'unit');
      const builds = own.filter((u) => u.kind === 'building');
      if (units.length) {
        const armedAuto = units.some((u) => u.type === 'villager') && units.every((u) => u.type === 'villager');
        if (armedAuto) {
          // villagers walk to the spot, then look for work there
          game.orderMove(units, g[0], g[2]);
        } else {
          game.orderMove(units, g[0], g[2]);
        }
        game.marker(g[0], g[2], { r: 1.3, r0: 0.5, g0: 0.95, b0: 0.6 });
        this.audio?.play('order');
      } else if (builds.length) {
        const b = builds[0];
        if (b.rally) { b.rally.x = g[0]; b.rally.z = g[2]; b.rally.y = this.game.heightAt(g[0], g[2]); }
        game.marker(g[0], g[2], { r: 1.1, r0: 0.95, g0: 0.8, b0: 0.4 });
        this.audio?.play('order');
      }
      this.lastTapEntity = null;
      this.lastTapTime = now;
      return;
    }

    game.clearSelection();
    this.ui?.refreshCommands();
    this.lastTapEntity = null;
    this.lastTapTime = now;
  }

  /** Tapping one of your own buildings while units are selected = an order. */
  _contextOrder(building, own, g) {
    const game = this.game;
    const villagers = own.filter((u) => u.kind === 'unit' && u.type === 'villager');
    const soldiers = own.filter((u) => u.kind === 'unit' && u.def.attack > 0 && u.def.classes.includes('infantry') || u.def.classes?.includes('cavalry') || u.def.classes?.includes('archer'));
    const dropoff = building.def.dropoff;
    if (dropoff) {
      let handled = false;
      for (const u of own) {
        if (u.kind !== 'unit' || !u.carry || u.carry.amount <= 0) continue;
        if (dropoff.includes(u.carry.kind)) {
          u.dropOff = building;
          u.state = STATE.RETURN;
          u.path = null;
          handled = true;
        }
      }
      if (handled) { game.marker(building.x, building.z, { r: 2, r0: 0.4, g0: 0.8, b0: 1 }); return true; }
    }
    if (villagers.length && building.hp < building.maxHp) {
      game.orderRepair(villagers, building);
      game.marker(building.x, building.z, { r: 2, r0: 1, g0: 0.75, b0: 0.3 });
      return true;
    }
    if (building.def.garrison && soldiers.length) {
      game.orderGarrison(own, building);
      return true;
    }
    return false;
  }

  _applyArmed(hit, g) {
    const game = this.game;
    const own = game.selectionOfTeam(1);
    const units = own.filter((e) => e.kind === 'unit');
    const a = this.armed;
    if (!units.length) { this.armed = null; return false; }
    switch (a.kind) {
      case 'attackMove':
        game.orderAttackMove(units, g[0], g[2]);
        game.marker(g[0], g[2], { r: 1.9, r0: 1, g0: 0.35, b0: 0.3 });
        break;
      case 'patrol':
        game.orderPatrol(units, g[0], g[2]);
        break;
      case 'garrison':
        if (hit && hit.kind === 'building') game.orderGarrison(units, hit);
        else { this.armed = null; return false; }
        break;
      case 'repair':
        if (hit && hit.kind === 'building' && hit.team === 1) game.orderRepair(units, hit);
        else { this.armed = null; return false; }
        break;
      case 'heal':
      case 'convert':
        if (hit && hit.kind === 'unit') {
          if (a.kind === 'heal') game.orderHeal(units, hit); else game.orderConvert(units, hit);
        } else { this.armed = null; return false; }
        break;
      case 'gather':
        if (hit && hit.kind === 'resource') game.orderGather(units, hit);
        else { this.armed = null; return false; }
        break;
      default:
        this.armed = null;
        return false;
    }
    this.armed = null;
    this.audio?.play('order');
    this.ui?.refreshCommands();
    return true;
  }

  selectEntity(e, doubleTap) {
    const game = this.game;
    if (doubleTap && game.selectionSet.has(e)) {
      // double tap selects every unit of the same type on screen
      const list = game.units.filter((u) => !u.dead && u.team === e.team && u.type === e.type &&
        Math.hypot(u.x - e.x, u.z - e.z) < 40);
      if (list.length > 1) {
        game.setSelection(list);
        this.ui?.toast(`${list.length} × ${e.def?.name || e.type}`, 'info');
        this.ui?.refreshCommands();
        this.audio?.play('select');
        return;
      }
    }
    game.setSelection([e]);
    this.ui?.refreshCommands();
    this.audio?.play('select');
  }

  commitBox(box) {
    const game = this.game;
    const r = this.canvas.getBoundingClientRect();
    const list = [];
    const o = [0, 0, 0];
    const cam = this.cam;
    const cull = cam.dist * 2.4 + 40;
    const near = game.spatial ? game.spatial.query(cam.target[0], cam.target[2], cull) : game.units;
    for (const u of near) {
      if (!u || u.dead || u.team !== 1 || u.garrisoned) continue;
      this._proj(u.x, (u.y || 0) + 0.8, u.z, o, r.width, r.height);
      if (!o[2]) continue;
      const sx = o[0] + r.left, sy = o[1] + r.top;
      if (sx >= box.x0 && sx <= box.x1 && sy >= box.y0 && sy <= box.y1) list.push(u);
    }
    if (list.length) {
      game.setSelection(list);
      this.ui?.refreshCommands();
      this.audio?.play('select');
    }
  }

  /* ---------------- keyboard (desktop convenience) ---------------- */
  key(e) {
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const cam = this.cam;
    if (k === 'q') cam.rotate(-0.12);
    else if (k === 'e') cam.rotate(0.12);
    else if (k === '+' || k === '=') cam.zoom(0.9);
    else if (k === '-' || k === '_') cam.zoom(1.1);
    // tilt: R/F would collide with idle-villager on F, so use T/G
    else if (k === 't') cam.nudge(0, -0.08);
    else if (k === 'g') cam.nudge(0, 0.08);
    else if (k === 'escape') {
      if (this.game.placing) { this.game.placing = null; this.ui?.refreshCommands(); }
      else if (this.armed) { this.armed = null; this.ui?.refreshCommands(); }
      else { this.game.clearSelection(); this.ui?.refreshCommands(); }
    } else if (k === 'a') {
      const units = this.game.selectionOfTeam(1).filter((u) => u.kind === 'unit' && u.def.attack > 0);
      if (units.length) { this.armed = { kind: 'attackMove' }; this.ui?.toast('Tap the ground to attack-move', 'info'); this.ui?.refreshCommands(); }
    } else if (k === 's') {
      this.game.orderStop(this.game.selectionOfTeam(1));
    } else if (k === 'h') {
      this.ui?.centreOnTownCentre();
    } else if (k === ' ') {
      e.preventDefault();
      this.ui?.togglePause();
    } else if (k === 'f') {
      this.ui?.cycleIdleVillager();
    } else if (k >= '1' && k <= '9') {
      this.ui?.selectGroup(parseInt(k, 10));
    } else if (k === 'backspace') {
      this.game.clearSelection();
      this.ui?.refreshCommands();
    }
  }

  update(dt) {
    if (!this.enabled) return;
    // keyboard panning
    const k = this.keys;
    let px = 0, pz = 0;
    if (k.has('w') || k.has('arrowup')) pz -= 1;
    if (k.has('s') || k.has('arrowdown')) pz += 1;
    if (k.has('a') || k.has('arrowleft')) px -= 1;
    if (k.has('d') || k.has('arrowright')) px += 1;
    if (px || pz) {
      const spd = this.cam.dist * 1.15 * dt;
      this.cam.pan(px * spd, pz * spd);
    }
    this.cam.setAspect(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    if (this.audio) this.audio.setListener(this.cam.target[0], this.cam.target[2]);
  }
}
