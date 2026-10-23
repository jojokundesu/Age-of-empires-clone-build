/* ============================================================
   ui.js — the in-game interface
   The DOM is built once. Every later update only patches text,
   widths and classes, so the compositor never re-lays-out the HUD
   mid-battle (the single biggest cause of stutter in v1).
   ============================================================ */
import {
  AGES, CIVS, RES_META, TECH_DEFS, UNIT_DEFS, BUILDING_DEFS, BUILDING_AGE, UNIT_AGE,
  POP_CAP, unitForCiv
} from '../sim/data.js';
import { clamp, fmtTime } from '../core/math.js';
import { iconFor } from './menu.js';
import { STATE } from '../sim/entities.js';

const CMD_HZ = 9;              // command card / text refresh rate
const MINI_HZ = 11;

const STANCE_LABEL = { aggressive: 'Aggressive', defensive: 'Defensive', stand: 'Stand ground' };

function costText(cost) {
  if (!cost) return '';
  const parts = [];
  for (const k of ['food', 'wood', 'gold', 'stone', 'favor']) {
    if (cost[k]) parts.push(`${cost[k]}${k[0].toUpperCase()}`);
  }
  return parts.join(' ');
}

function icon(name) {
  return `<svg class="ic"><use href="#i-${iconFor(name)}"/></svg>`;
}

export class UI {
  constructor(opts) {
    this.game = opts.game;
    this.renderer = opts.renderer;
    this.camera = opts.camera;
    this.input = opts.input || { armed: null };
    this.audio = opts.audio;
    this.menu = opts.menu;
    this.app = opts.app || {};
    this.root = document.getElementById('hud');
    this.el = {};
    const ids = ['resFood', 'resWood', 'resGold', 'resStone', 'resFavor', 'resPop',
      'dotFood', 'dotWood', 'dotGold', 'dotStone',
      'ageBtn', 'ageName', 'ageHint', 'clock', 'worldTime',
      'btnIdle', 'idleBadge', 'btnArmy', 'btnTech', 'btnDecrees', 'decreeBadge',
      'btnSound', 'btnPause', 'btnMenu', 'alertStrip',
      'stanceBar', 'camRotL', 'camRotR', 'camHome', 'camZoomIn', 'camZoomOut',
      'minimap', 'miniStamp', 'btnGotoTC', 'btnMiniMode', 'btnFormation',
      'inspIcon', 'inspName', 'inspSub', 'inspMultiBtn', 'hpWrap', 'hpFill', 'hpText',
      'inspStats', 'queueWrap', 'queueFill', 'queueText', 'queueDots',
      'cmdBoot', 'cmdGrid', 'toastLayer', 'perfChip', 'diagBtn',
      'tapFx', 'floatLayer', 'selBox', 'stage', 'modalScreen'];
    for (const id of ids) this.el[id] = document.getElementById(id);
    this.miniCtx = this.el.minimap ? this.el.minimap.getContext('2d') : null;
    this.miniBase = null;
    this.miniMode = 0;
    this.cmdButtons = [];
    this.sig = '';
    this.last = { food: -1, wood: -1, gold: -1, stone: -1, favor: -1, pop: '', age: -1, clock: '', idle: -1 };
    this.tAcc = 0;
    this.mAcc = 0;
    this.alertT = 0;
    this.alerts = [];
    this.perfVisible = false;
    this.toasts = [];
    this.floatPool = [];
    this._tmp = [0, 0, 0];
    this._miniDrag = false;
    this._build = this.root ? this._wire() : false;
  }

  /* ---------------- wiring (runs once) ---------------- */
  _wire() {
    const el = this.el;
    const g = this.game;
    const click = (node, fn) => { if (node) node.addEventListener('click', (e) => { e.preventDefault(); this.audio?.play('click'); fn(e); }); };

    click(el.btnIdle, () => this.cycleIdleVillager());
    click(el.btnArmy, () => this.selectArmy());
    click(el.btnTech, () => this.openTech());
    click(el.btnDecrees, () => this.openDecrees());
    click(el.btnMenu, () => this.app.openPause?.());
    click(el.btnPause, () => this.togglePause());
    click(el.btnSound, () => this.toggleSound());
    click(el.ageBtn, () => this.ageAdvance());
    click(el.btnGotoTC, () => this.centreOnTownCentre());
    click(el.btnMiniMode, () => {
      this.miniMode = (this.miniMode + 1) % 3;
      el.miniStamp.textContent = ['MAP', 'TERRAIN', 'FORCES'][this.miniMode];
    });
    click(el.btnFormation, () => {
      g.formationSpread = !g.formationSpread;
      el.btnFormation.classList.toggle('on', !!g.formationSpread);
      this.toast(g.formationSpread ? 'Wide formation' : 'Tight formation');
    });
    click(el.camRotL, () => this.camera.rotate(-0.28));
    click(el.camRotR, () => this.camera.rotate(0.28));
    click(el.camHome, () => this.centreOnTownCentre());
    click(el.camZoomIn, () => this.camera.zoom(0.86));
    click(el.camZoomOut, () => this.camera.zoom(1.16));
    click(el.inspMultiBtn, () => this.selectAllOfType());

    el.stanceBar?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-stance]');
      if (!b) return;
      this.setStance(b.dataset.stance);
    });

    // minimap interaction
    const mini = el.minimap;
    if (mini) {
      const jump = (e) => {
        const r = mini.getBoundingClientRect();
        const nx = clamp((e.clientX - r.left) / r.width, 0, 1);
        const nz = clamp((e.clientY - r.top) / r.height, 0, 1);
        const x = nx * 512 - 256, z = nz * 512 - 256;
        this.camera.setTarget(x, z);
      };
      mini.addEventListener('pointerdown', (e) => {
        this._miniDrag = true;
        mini.setPointerCapture?.(e.pointerId);
        jump(e);
        e.preventDefault();
      });
      mini.addEventListener('pointermove', (e) => { if (this._miniDrag) jump(e); });
      mini.addEventListener('pointerup', () => { this._miniDrag = false; });
      mini.addEventListener('pointercancel', () => { this._miniDrag = false; });
    }

    // stage tap ripple
    if (el.tapFx) {
      el.tapFx.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        this.ripple(e.clientX, e.clientY);
      }, { passive: true });
    }
    return true;
  }

  /* ---------------- lifecycle ---------------- */
  show() { this.root?.classList.remove('hidden'); }
  hide() { this.root?.classList.add('hidden'); }

  setGame(game) {
    this.game = game;
    this.sig = '';
    this.last = { food: -1, wood: -1, gold: -1, stone: -1, favor: -1, pop: '', age: -1, clock: '', idle: -1 };
    this.buildMinimapBase();
    this.refreshCommands();
  }

  /* ---------------- command card ---------------- */
  refreshCommands() {
    const list = this.commandsForSelection();
    const sig = list.map((c) => `${c.icon}|${c.label}|${c.cost || ''}|${c.enabled ? 1 : 0}|${c.active ? 1 : 0}`).join('~');
    if (sig === this.sig) {
      // still refresh the disabled state so costs light up as resources arrive
      this._applyEnabled(list);
      return;
    }
    this.sig = sig;
    const grid = this.el.cmdGrid;
    if (!grid) return;
    if (this.el.cmdBoot) this.el.cmdBoot.style.display = list.length ? 'none' : 'grid';
    while (this.cmdButtons.length < list.length) {
      const b = document.createElement('button');
      b.className = 'cmdBtn';
      b.innerHTML = '<span class="lbl"></span><span class="cost"></span>';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ic');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      svg.appendChild(use);
      b.insertBefore(svg, b.firstChild);
      grid.appendChild(b);
      this.cmdButtons.push({ el: b, use, lbl: b.querySelector('.lbl'), cost: b.querySelector('.cost') });
    }
    for (let i = 0; i < this.cmdButtons.length; i++) {
      const slot = this.cmdButtons[i];
      const c = list[i];
      if (!c) { slot.el.style.display = 'none'; continue; }
      slot.el.style.display = '';
      slot.use.setAttribute('href', `#i-${iconFor(c.icon)}`);
      slot.lbl.textContent = c.label;
      slot.cost.textContent = c.cost || '';
      slot.el.classList.toggle('primary', !!c.primary);
      slot.el.classList.toggle('toggled', !!c.active);
      slot.el.classList.toggle('poor', !c.enabled);
      slot.el.onclick = (e) => {
        e.preventDefault();
        if (!c.enabled) { this.audio?.play('warn'); this.toast(c.reason || 'Not enough resources', 'warn'); return; }
        this.audio?.play('click');
        c.action();
      };
    }
  }

  _applyEnabled(list) {
    for (let i = 0; i < list.length && i < this.cmdButtons.length; i++) {
      const c = list[i], slot = this.cmdButtons[i];
      if (!slot) continue;
      slot.el.classList.toggle('poor', !c.enabled);
      slot.el.classList.toggle('toggled', !!c.active);
      slot.cost.textContent = c.cost || '';
    }
  }

  commandsForSelection() {
    const g = this.game;
    const sel = g.selection.filter((e) => !e.dead);
    const team = g.teams.get(1);
    const age = team.age;
    const out = [];
    if (!sel.length) {
      out.push({ icon: 'people', label: 'Army', action: () => this.selectArmy() });
      out.push({ icon: 'villager', label: 'Idle', action: () => this.cycleIdleVillager() });
      out.push({ icon: 'home', label: 'Town', action: () => this.centreOnTownCentre() });
      out.push({ icon: 'scroll', label: 'Tech', action: () => this.openTech() });
      out.push({ icon: 'crown', label: 'Decrees', action: () => this.openDecrees() });
      out.push({ icon: 'map', label: 'Explore', action: () => this.sendScout() });
      return out;
    }
    const units = sel.filter((e) => e.kind === 'unit');
    const buildings = sel.filter((e) => e.kind === 'building');

    /* ---- a single building: production and research ---- */
    if (buildings.length === 1 && !units.length) {
      const b = buildings[0];
      const mine = b.team === 1;
      const def = b.def;
      if (!mine) {
        out.push({ icon: 'eye', label: 'Watch', action: () => this.toast(`${b.name} · ${Math.round(b.hp)} / ${Math.round(b.maxHp)} hp`) });
        return out;
      }
      if (def.ageAdvance) {
        const nextAge = age + 1;
        const ag = AGES[nextAge];
        if (ag) {
          const can = g.canAdvanceAge(1);
          out.push({
            icon: 'crown', label: `Age ${nextAge + 1}`, cost: costText(ag.cost),
            enabled: !!can.ok, reason: can.reason, primary: true,
            action: () => this.ageAdvance()
          });
        } else {
          out.push({ icon: 'crown', label: 'Max Age', enabled: false });
        }
      }
      if (def.trains) {
        const list = this.trainableUnits(b, age);
        for (const type of list) {
          const u = UNIT_DEFS[type];
          if (!u) continue;
          const cost = g.unitCost(type, 1);
          const afford = g.canAfford(1, cost) && g.popFree(1) > 0;
          out.push({
            icon: u.icon, label: u.name.split(' ')[0], cost: costText(cost),
            enabled: afford, reason: !afford ? (g.popFree(1) <= 0 ? 'Population full — build houses' : 'Not enough resources') : '',
            action: () => this.trainUnit(b, type)
          });
        }
      }
      if (def.research) {
        for (const techId of def.research) {
          const t = TECH_DEFS[techId];
          if (!t) continue;
          if (team.techs.has(techId)) continue;
          if (t.age > age) continue;
          const afford = g.canAfford(1, t.cost);
          out.push({
            icon: t.icon, label: t.name.split(' ')[0], cost: costText(t.cost),
            enabled: afford, reason: 'Not enough resources',
            action: () => this.researchTech(b, techId)
          });
        }
      }
      if (g.buildingBatches === undefined) { /* noop, keeps lint quiet */ }
      if (b.queue.length) {
        out.push({ icon: 'close', label: 'Cancel', action: () => { b.queue.length = 0; this.audio?.play('click'); this.refreshCommands(); } });
      }
      if (def.market) {
        out.push({ icon: 'coin', label: 'Trade', action: () => this.openMarket() });
      }
      if (def.garrison && b.garrison && b.garrison.length) {
        out.push({
          icon: 'boot', label: 'Ungarrison',
          action: () => {
            for (const u of b.garrison.slice()) g.removeFromGarrison(u);
            this.refreshCommands();
          }
        });
      }
      if (!def.ageAdvance) {
        out.push({ icon: 'flag', label: 'Rally', action: () => { this.input.armed = { kind: 'rally', building: b }; this.toast('Tap the ground to set a rally point'); } });
      }
      return out;
    }

    /* ---- units (and mixed selections) ---- */
    const soldiers = units.filter((u) => u.def.attack > 0 && !u.def.classes.includes('villager'));
    const villagers = units.filter((u) => u.type === 'villager');
    if (villagers.length) {
      out.push({ icon: 'tool', label: 'Build', primary: true, action: () => this.openBuildMenu(villagers) });
      out.push({ icon: 'wheat', label: 'Gather', action: () => { this.input.armed = { kind: 'gather' }; this.toast('Tap a resource to gather'); } });
      out.push({
        icon: 'hammer', label: 'Repair',
        action: () => { this.input.armed = { kind: 'repair' }; this.toast('Tap a damaged building to repair'); }
      });
    }
    if (soldiers.length) {
      out.push({
        icon: 'sword', label: 'Atk-Move', primary: true,
        active: this.input.armed?.kind === 'attackMove',
        action: () => { this.input.armed = { kind: 'attackMove' }; this.toast('Tap the ground to attack-move', 'warn'); }
      });
      out.push({ icon: 'shield', label: 'Patrol', action: () => { this.input.armed = { kind: 'patrol' }; this.toast('Tap the ground to patrol'); } });
    }
    if (units.length && soldiers.length) {
      out.push({ icon: 'castle', label: 'Garrison', action: () => { this.input.armed = { kind: 'garrison' }; this.toast('Tap a building to garrison'); } });
    }
    const monks = units.filter((u) => u.def.classes.includes('monk'));
    if (monks.length) {
      out.push({ icon: 'heart', label: 'Heal', action: () => { this.input.armed = { kind: 'heal' }; this.toast('Tap a wounded ally to heal'); } });
      out.push({ icon: 'bolt', label: 'Convert', action: () => { this.input.armed = { kind: 'convert' }; this.toast('Tap an enemy unit to convert'); } });
    }
    if (units.length) {
      out.push({ icon: 'boot', label: 'Stop', action: () => { g.orderStop(units); this.audio?.play('order'); } });
      const stance = units[0].stance || 'aggressive';
      out.push({
        icon: stance === 'aggressive' ? 'sword' : stance === 'defensive' ? 'shield' : 'boot',
        label: 'Stance', action: () => this.cycleStance()
      });
    }
    if (buildings.length && !units.length) {
      out.push({ icon: 'people', label: 'All Type', action: () => this.selectAllOfType() });
    }
    return out;
  }

  trainableUnits(b, age) {
    const def = b.def;
    const g = this.game;
    const civ = g.civOf(1);
    const unique = CIVS[civ]?.unique;
    const out = [];
    for (const raw of def.trains) {
      let type = raw;
      if (raw === 'unique') type = unique;
      if (!type) continue;
      if (UNIT_AGE[type] !== undefined && UNIT_AGE[type] > age) continue;
      // the castle trains every unique in the data table — keep only ours
      if (def.trains.indexOf('hero_general') >= 0 && UNIT_AGE[type] !== undefined && type !== 'hero_general' && type !== unique) {
        const isUnique = Object.values(CIVS).some((c) => c.unique === type);
        if (isUnique && type !== unique) continue;
      }
      if (!UNIT_DEFS[type]) continue;
      if (out.includes(type)) continue;
      out.push(type);
    }
    return out;
  }

  trainUnit(building, type) {
    const g = this.game;
    if (!g.canAfford(1, g.unitCost(type, 1))) { this.toast('Not enough resources', 'warn'); return; }
    if (g.popFree(1) <= 0) { this.toast('Population full — build houses', 'warn'); return; }
    const ok = building.queueUnit(type);
    if (ok) {
      this.audio?.play('train');
      const u = UNIT_DEFS[type];
      this.toast(`${u.name} queued`);
    }
    this.sig = '';
    this.refreshCommands();
  }

  researchTech(building, techId) {
    const g = this.game;
    const t = TECH_DEFS[techId];
    if (!t) return;
    if (g.teams.get(1).techs.has(techId)) { this.toast('Already researched'); return; }
    const ok = building.queueTech(techId);
    if (ok) { this.audio?.play('train'); this.toast(`Researching ${t.name}`); }
    else this.toast('Not enough resources', 'warn');
    this.sig = '';
    this.refreshCommands();
  }

  openBuildMenu(villagers) {
    const g = this.game;
    const age = g.teams.get(1).age;
    const types = ['house', 'farm', 'mill', 'lumber_camp', 'mining_camp', 'barracks', 'archery_range',
      'stable', 'blacksmith', 'market', 'watch_tower', 'palissade_wall', 'stone_wall', 'stone_gate',
      'monastery', 'siege_workshop', 'university', 'castle', 'dock', 'wonder'];
    const out = [];
    for (const type of types) {
      const def = BUILDING_DEFS[type];
      if (!def) continue;
      const req = BUILDING_AGE[type] || 0;
      const cost = g.buildingCost(type, 1);
      const afford = g.canAfford(1, cost);
      out.push({
        icon: def.icon, label: def.name.replace(' Camp', '').replace('Workshop', 'Shop'),
        cost: costText(cost) + (req > age ? ` · Age ${req + 1}` : ''),
        enabled: afford && req <= age,
        reason: req > age ? 'Requires a later age' : 'Not enough resources',
        primary: type === 'house',
        action: () => {
          g.placing = { type, x: this.camera.target[0], z: this.camera.target[2], y: g.heightAt(this.camera.target[0], this.camera.target[2]), footprint: def.size || 3, valid: true };
          this.toast(`Tap the ground to place the ${def.name}`, 'gold');
          this.sig = '';
          this.refreshCommands();
        }
      });
    }
    out.push({ icon: 'close', label: 'Back', action: () => { this.sig = ''; this.refreshCommands(); } });
    // render this ad-hoc list into the card without disturbing selection state
    this._renderAdHoc(out);
  }

  _renderAdHoc(list) {
    const prev = this.commandsForSelection;
    this.commandsForSelection = () => list;
    this.sig = '';
    this.refreshCommands();
    this.commandsForSelection = prev;
    this._adHocUntil = performance.now() + 60000;
  }

  /* ---------------- selection helpers ---------------- */
  cycleIdleVillager() {
    const g = this.game;
    const idle = g.units.filter((u) => !u.dead && u.team === 1 && u.type === 'villager' &&
      (u.state === STATE.IDLE || u.state === STATE.MOVE && !u.path));
    if (!idle.length) { this.toast('No idle villagers'); return; }
    this._idleIdx = ((this._idleIdx || 0) + 1) % idle.length;
    const u = idle[this._idleIdx];
    g.setSelection([u]);
    this.camera.setTarget(u.x, u.z);
    this.refreshCommands();
    this.audio?.play('select');
  }

  selectArmy() {
    const g = this.game;
    const army = g.units.filter((u) => !u.dead && u.team === 1 && u.def.attack > 0 && !u.def.classes.includes('villager'));
    if (!army.length) { this.toast('No soldiers yet — train some at the Barracks', 'warn'); return; }
    // prefer units near the camera when the army is spread out
    const cx = this.camera.target[0], cz = this.camera.target[2];
    army.sort((a, b) => ((a.x - cx) ** 2 + (a.z - cz) ** 2) - ((b.x - cx) ** 2 + (b.z - cz) ** 2));
    g.setSelection(army.slice(0, 40));
    this.refreshCommands();
    this.audio?.play('select');
  }

  selectAllOfType() {
    const g = this.game;
    const first = g.selection[0];
    if (!first) return;
    const list = first.kind === 'unit'
      ? g.units.filter((u) => !u.dead && u.team === first.team && u.type === first.type)
      : g.buildings.filter((b) => !b.dead && b.team === first.team && b.type === first.type);
    if (list.length) {
      g.setSelection(list);
      this.toast(`${list.length} × ${first.def?.name || first.type}`);
      this.refreshCommands();
    }
  }

  selectGroup(n) {
    const g = this.game;
    if (!g.groups) g.groups = new Map();
    const list = g.groups.get(n);
    if (list) {
      g.setSelection(list.filter((e) => !e.dead));
      this.refreshCommands();
    } else if (g.selection.length) {
      g.groups.set(n, g.selection.slice());
      this.toast(`Group ${n} set`);
    }
  }

  setStance(stance) {
    const g = this.game;
    const units = g.selection.filter((e) => e.kind === 'unit' && e.team === 1);
    for (const u of units) u.stance = stance;
    for (const b of this.el.stanceBar?.children || []) b.classList.toggle('active', b.dataset.stance === stance);
    this.toast(`Stance: ${STANCE_LABEL[stance]}`);
  }

  cycleStance() {
    const g = this.game;
    const u = g.selection.find((e) => e.kind === 'unit');
    const order = ['aggressive', 'defensive', 'stand'];
    const next = order[(order.indexOf(u?.stance || 'aggressive') + 1) % 3];
    this.setStance(next);
  }

  sendScout() {
    const g = this.game;
    const scout = g.units.find((u) => !u.dead && u.team === 1 && (u.type === 'scout_cavalry' || u.def.classes.includes('cavalry')));
    if (!scout) { this.toast('No scout available'); return; }
    g.setSelection([scout]);
    const a = Math.random() * Math.PI * 2;
    g.orderMove([scout], scout.x + Math.cos(a) * 60, scout.z + Math.sin(a) * 60);
    this.camera.setTarget(scout.x, scout.z);
    this.refreshCommands();
  }

  centreOnTownCentre() {
    const g = this.game;
    const tc = g.buildings.find((b) => !b.dead && b.team === 1 && b.def.ageAdvance) ||
      g.buildings.find((b) => !b.dead && b.team === 1);
    if (tc) {
      this.camera.setTarget(tc.x, tc.z);
      if (!g.selection.length) { g.setSelection([tc]); this.refreshCommands(); }
    }
  }

  ageAdvance() {
    const g = this.game;
    const t = g.teams.get(1);
    if (t.ageResearch) { this.toast(`Advancing… ${Math.ceil(t.ageResearch.time)}s`); return; }
    const res = g.startAgeAdvance(1);
    if (res && res.ok === false) { this.toast(res.reason || 'Cannot advance yet', 'warn'); this.audio?.play('warn'); }
    else { this.toast('Advancing to the next age', 'good'); this.audio?.play('horn'); }
    this.refreshCommands();
  }

  /* ---------------- modals ---------------- */
  openTech() {
    const g = this.game;
    const age = g.teams.get(1).age;
    const techs = g.teams.get(1).techs;
    const rows = Object.entries(TECH_DEFS).map(([id, t]) => {
      const done = techs.has(id);
      const locked = t.age > age;
      return `<div class="row ${done ? 'gold' : ''}" style="opacity:${locked ? 0.4 : 1}">
        <b>${icon(t.icon)} ${t.name}</b>
        <span>${t.desc || ''}<br><em class="dim tiny">${done ? 'Researched' : `${costText(t.cost)} · ${t.time}s · ${(BUILDING_DEFS[t.at]?.name) || t.at}`}${locked ? ' · later age' : ''}</em></span>
      </div>`;
    }).join('');
    this.menu?.openModal('IMPERIAL ARCHIVES', 'Technology', `<div class="techList">${rows}</div>`,
      '<span class="dim tiny">Research at the matching building. Click a building to see what it can research.</span>');
  }

  openDecrees() {
    const g = this.game;
    const favor = g.teams.get(1).favor || 0;
    const list = g.decrees || [];
    const rows = list.map((d) => `
      <div class="row">
        <b>${icon(d.icon)} ${d.name}</b>
        <span>${d.desc}<br>
          <button class="ghostBtn" data-decree="${d.id}" ${favor < d.cost ? 'disabled' : ''}>${d.cost} favour</button>
        </span>
      </div>`).join('');
    this.menu?.openModal('COUNCIL', `Imperial Decrees · ${Math.floor(favor)} favour`, rows ||
      '<p class="dim">No decrees available.</p>',
      '<span class="dim tiny">Favour accrues over time and from every kill.</span>');
    const body = document.getElementById('modalBody');
    body?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-decree]');
      if (!b) return;
      const res = g.activateDecree(1, b.dataset.decree);
      if (res && res.ok) { this.audio?.play('horn'); this.toast(res.msg || 'Decree proclaimed', 'good'); this.openDecrees(); }
      else { this.toast(res?.reason || 'Not enough favour', 'warn'); this.audio?.play('warn'); }
    }, { once: true });
  }

  openMarket() {
    const g = this.game;
    const t = g.teams.get(1);
    const price = (kind) => Math.max(1, Math.round((g.marketPrice ? g.marketPrice(kind, 1) : 100)));
    const rows = ['food', 'wood', 'gold', 'stone'].map((k) => `
      <div class="row"><b>${RES_META[k].name}</b><span>${Math.floor(t.res[k])} in store · ${price(k)} gold per 100
        <br><button class="ghostBtn" data-buy="${k}">Buy 100</button>
        <button class="ghostBtn" data-sell="${k}">Sell 100</button></span></div>`).join('');
    this.menu?.openModal('MARKET', 'Trade goods', rows);
    const body = document.getElementById('modalBody');
    body?.addEventListener('click', (e) => {
      const buy = e.target.closest('[data-buy]');
      const sell = e.target.closest('[data-sell]');
      if (buy) { const r = g.marketTrade(1, buy.dataset.buy, 100, true); this.toast(r.ok ? 'Purchased' : r.reason, r.ok ? 'good' : 'warn'); this.openMarket(); }
      if (sell) { const r = g.marketTrade(1, sell.dataset.sell, 100, false); this.toast(r.ok ? 'Sold' : r.reason, r.ok ? 'good' : 'warn'); this.openMarket(); }
    }, { once: true });
  }

  /* ---------------- toasts and floating text ---------------- */
  toast(text, kind = '') {
    const layer = this.el.toastLayer;
    if (!layer) return;
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = text;
    layer.appendChild(node);
    this.toasts.push({ node, t: 0, life: 2.6 });
    while (layer.children.length > 4) layer.removeChild(layer.firstChild);
  }

  floatText(x, y, z, text, kind = '') {
    const layer = this.el.floatLayer;
    if (!layer) return;
    const p = this.renderer.projectToScreen(this.camera, x, y, z, this._tmp);
    if (!p || p[2] <= 0) return;
    const node = document.createElement('div');
    node.className = 'float ' + kind;
    node.textContent = text;
    node.style.left = `${p[0]}px`;
    node.style.top = `${p[1]}px`;
    layer.appendChild(node);
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 1200);
    while (layer.children.length > 24) layer.removeChild(layer.firstChild);
  }

  ripple(clientX, clientY) {
    const layer = this.el.tapFx;
    if (!layer) return;
    const r = this.renderer.canvas.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'tapRing';
    node.style.left = `${clientX - r.left}px`;
    node.style.top = `${clientY - r.top}px`;
    layer.appendChild(node);
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 620);
  }

  showSelBox(box) {
    const el = this.el.selBox;
    if (!el || !box) return;
    const cv = this.renderer && this.renderer.canvas;
    const r = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const x0 = box.x0 ?? box.x ?? 0, y0 = box.y0 ?? box.y ?? 0;
    const x1 = box.x1 ?? (x0 + (box.w || 0)), y1 = box.y1 ?? (y0 + (box.h || 0));
    el.style.display = 'block';
    el.style.left = `${Math.min(x0, x1) - r.left}px`;
    el.style.top = `${Math.min(y0, y1) - r.top}px`;
    el.style.width = `${Math.abs(x1 - x0)}px`;
    el.style.height = `${Math.abs(y1 - y0)}px`;
  }
  hideSelBox() { if (this.el.selBox) this.el.selBox.style.display = 'none'; }

  togglePause() { this.app.togglePause?.(); }
  toggleSound() {
    const on = !(this.audio && this.audio.enabled);
    this.audio?.setEnabled(on);
    const b = this.el.btnSound;
    if (b) b.querySelector('use')?.setAttribute('href', on ? '#i-sound' : '#i-mute');
    this.toast(on ? 'Sound on' : 'Sound off');
    if (on) this.audio?.unlock();
  }

  /* ---------------- per-frame ---------------- */
  update(dt) {
    const g = this.game;
    if (!g) return;
    this.tAcc += dt;
    this.mAcc += dt;
    this.alertT += dt;
    // expire toasts
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t += dt;
      if (t.t > t.life) {
        t.node.classList.add('out');
        const node = t.node;
        setTimeout(() => node.remove(), 320);
        this.toasts.splice(i, 1);
      }
    }
    if (this.tAcc >= 1 / CMD_HZ) {
      this.tAcc = 0;
      this.updateText();
      this.updateInspector();
      if (!this.el.cmdGrid?.childElementCount || performance.now() > (this._adHocUntil || 0)) {
        // keep the card in sync with affordability every refresh
        const list = this.commandsForSelection();
        const sig = list.map((c) => `${c.icon}|${c.label}|${c.cost || ''}|${c.active ? 1 : 0}`).join('~');
        if (sig !== this.sig) { this._adHocUntil = 0; this.sig = sig; this.refreshCommands(); }
        else this._applyEnabled(list);
      }
    }
    if (this.mAcc >= 1 / MINI_HZ) {
      this.mAcc = 0;
      this.drawMinimap();
    }
    // alerts
    if (this.alertT > 0.6) {
      this.alertT = 0;
      this.updateAlerts();
      if (this.perfVisible) this.updatePerf();
    }
  }

  updateText() {
    const g = this.game;
    const t = g.teams.get(1);
    const el = this.el, last = this.last;
    const setNum = (node, val, key) => {
      if (last[key] === val) return;
      last[key] = val;
      if (node) node.textContent = val;
    };
    setNum(el.resFood, Math.floor(t.res.food), 'food');
    setNum(el.resWood, Math.floor(t.res.wood), 'wood');
    setNum(el.resGold, Math.floor(t.res.gold), 'gold');
    setNum(el.resStone, Math.floor(t.res.stone), 'stone');
    setNum(el.resFavor, Math.floor(t.favor || 0), 'favor');
    const popStr = `${t.popUsed}/${t.popCap}`;
    if (last.pop !== popStr) { last.pop = popStr; if (el.resPop) el.resPop.textContent = popStr; }
    if (last.age !== t.age) {
      last.age = t.age;
      if (el.ageName) el.ageName.textContent = AGES[t.age].name;
      if (el.ageBtn) el.ageBtn.style.setProperty('--age-color', AGES[t.age].color);
    }
    const clock = fmtTime(g.elapsed || g.time);
    if (last.clock !== clock) { last.clock = clock; if (el.clock) el.clock.textContent = clock; }
    if (el.worldTime) {
      const wt = g.worldTime || 12;
      const hh = Math.floor(wt);
      const mm = Math.floor((wt - hh) * 60);
      const iconTxt = wt < 6 || wt > 19.5 ? '☾' : '☀';
      const str = `${iconTxt} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      if (el.worldTime.textContent !== str) el.worldTime.textContent = str;
    }
    // age hint
    if (el.ageHint) {
      if (t.ageResearch) {
        const txt = `${Math.ceil(t.ageResearch.time)}s`;
        if (el.ageHint.textContent !== txt) el.ageHint.textContent = txt;
      } else {
        const next = AGES[t.age + 1];
        const txt = next ? `Advance · ${costText(next.cost)}` : 'Final age';
        if (el.ageHint.textContent !== txt) el.ageHint.textContent = txt;
      }
    }
    // idle badge
    let idle = 0;
    for (const u of g.units) if (!u.dead && u.team === 1 && u.type === 'villager' && u.state === STATE.IDLE) idle++;
    if (last.idle !== idle) {
      last.idle = idle;
      if (el.idleBadge) {
        el.idleBadge.textContent = idle;
        el.idleBadge.style.display = idle ? '' : 'none';
      }
    }
    if (el.decreeBadge) {
      const n = String(Math.floor(t.favor || 0));
      if (el.decreeBadge.textContent !== n) el.decreeBadge.textContent = n;
    }
    // stance highlight
    const selUnits = g.selection.filter((e) => e.kind === 'unit' && e.team === 1);
    const stance = selUnits.length ? selUnits[0].stance : null;
    if (this.el.stanceBar) {
      this.el.stanceBar.style.display = selUnits.length ? '' : 'none';
      if (stance) for (const b of this.el.stanceBar.children) b.classList.toggle('active', b.dataset.stance === stance);
    }
  }

  updateInspector() {
    const g = this.game;
    const el = this.el;
    const sel = g.selection.filter((e) => !e.dead);
    if (!sel.length) {
      if (el.inspName) el.inspName.textContent = 'Nothing selected';
      if (el.inspSub) el.inspSub.textContent = 'Tap a unit or building';
      if (el.inspIcon) el.inspIcon.innerHTML = icon('eye');
      if (el.hpWrap) el.hpWrap.style.display = 'none';
      if (el.inspStats) el.inspStats.innerHTML = '';
      if (el.queueWrap) el.queueWrap.style.display = 'none';
      if (el.queueDots) el.queueDots.innerHTML = '';
      if (el.inspMultiBtn) el.inspMultiBtn.textContent = '';
      return;
    }
    if (sel.length > 1) {
      const counts = new Map();
      for (const e of sel) counts.set(e.def?.name || e.type, (counts.get(e.def?.name || e.type) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (el.inspName) el.inspName.textContent = `${sel.length} selected`;
      if (el.inspSub) el.inspSub.textContent = `${top[1]} × ${top[0]}`;
      if (el.inspIcon) el.inspIcon.innerHTML = icon(sel[0].def?.icon || 'flag');
      const hp = sel.reduce((s, e) => s + e.hp, 0);
      const max = sel.reduce((s, e) => s + e.maxHp, 0);
      this._hp(hp, max);
      if (el.inspStats) el.inspStats.innerHTML = '';
      if (el.queueWrap) el.queueWrap.style.display = 'none';
      if (el.queueDots) el.queueDots.innerHTML = '';
      if (el.inspMultiBtn) el.inspMultiBtn.textContent = `×${sel.length}`;
      return;
    }
    const e = sel[0];
    if (el.inspName) el.inspName.textContent = e.name || e.def?.name || e.type;
    if (el.inspIcon) el.inspIcon.innerHTML = icon(e.def?.icon || (e.kind === 'resource' ? 'tree' : 'flag'));
    const teamName = e.team === 1 ? CIVS[g.civOf(1)]?.name : e.team === 2 ? CIVS[g.civOf(2)]?.name : 'Neutral';
    if (el.inspSub) {
      let sub = '';
      if (e.kind === 'building') {
        sub = `${teamName} · ${e.buildProgress < 1 ? `Building ${Math.round(e.buildProgress * 100)}%` : 'Complete'}`;
      } else if (e.kind === 'resource') {
        sub = `${e.resKind} · ${Math.floor(e.amount)} left`;
      } else {
        const st = e.state;
        const stateName = st === STATE.GATHER ? `Gathering ${e.carry?.kind || ''}`
          : st === STATE.RETURN ? 'Returning' : st === STATE.BUILD ? 'Building'
            : st === STATE.ATTACK ? 'Fighting' : st === STATE.MOVE ? 'Moving'
              : st === STATE.ATTACK_MOVE ? 'Advancing' : st === STATE.IDLE ? 'Idle'
                : st === STATE.REPAIR ? 'Repairing' : st === STATE.HEAL ? 'Healing' : 'Ready';
        sub = `${teamName} · ${stateName}`;
      }
      el.inspSub.textContent = sub;
    }
    this._hp(e.hp, e.maxHp);
    if (el.inspStats) {
      if (e.kind === 'unit') {
        const s = e.stats ? e.stats() : e.def;
        el.inspStats.innerHTML = `<span>⚔ ${Math.round(s.attack || 0)}</span><span>🛡 ${s.armor || 0}/${s.pierceArmor || 0}</span>` +
          (s.range > 1.2 ? `<span>🎯 ${s.range.toFixed(1)}</span>` : '') +
          `<span>👟 ${(s.speed || 0).toFixed(1)}</span>` +
          (e.carry && e.carry.amount ? `<span>🎒 ${Math.round(e.carry.amount)} ${e.carry.kind}</span>` : '');
      } else if (e.kind === 'building') {
        const s = e.def;
        el.inspStats.innerHTML = `<span>🏛 ${s.size?.toFixed(1) || 0}m</span>` +
          (s.attack ? `<span>⚔ ${s.attack}</span><span>🎯 ${s.range}</span>` : '') +
          (s.pop ? `<span>👥 +${s.pop}</span>` : '') +
          (s.dropoff ? `<span>📦 ${s.dropoff.join('/')}</span>` : '');
      } else {
        el.inspStats.innerHTML = '';
      }
    }
    // production queue
    if (el.queueWrap) {
      const q = e.kind === 'building' ? e.queue : null;
      if (q && q.length) {
        const item = q[0];
        const prog = 1 - item.time / item.total;
        el.queueWrap.style.display = '';
        if (el.queueFill) el.queueFill.style.width = `${clamp(prog, 0, 1) * 100}%`;
        if (el.queueText) el.queueText.textContent = `${UNIT_DEFS[item.type]?.name || item.type} · ${Math.ceil(item.time)}s`;
        if (el.queueDots) {
          let html = '';
          for (let i = 0; i < q.length; i++) {
            const it = q[i];
            html += `<span class="qDot ${i === 0 ? 'active' : ''}">${icon(UNIT_DEFS[it.type]?.icon || 'flag')}</span>`;
          }
          el.queueDots.innerHTML = html;
        }
      } else if (e.kind === 'building' && e.buildProgress < 1) {
        el.queueWrap.style.display = '';
        if (el.queueFill) el.queueFill.style.width = `${clamp(e.buildProgress, 0, 1) * 100}%`;
        if (el.queueText) el.queueText.textContent = `Construction ${Math.round(e.buildProgress * 100)}%`;
        if (el.queueDots) el.queueDots.innerHTML = '';
      } else {
        el.queueWrap.style.display = 'none';
      }
    }
    if (el.inspMultiBtn) el.inspMultiBtn.textContent = '×1';
  }

  _hp(hp, max) {
    const el = this.el;
    const r = clamp(hp / Math.max(1, max), 0, 1);
    if (el.hpWrap) el.hpWrap.style.display = '';
    if (el.hpFill) {
      el.hpFill.style.width = `${r * 100}%`;
      el.hpFill.style.background = r > 0.6 ? 'linear-gradient(90deg,#5fa84a,#8ad06a)'
        : r > 0.3 ? 'linear-gradient(90deg,#c9a13a,#e8c46a)' : 'linear-gradient(90deg,#a83b32,#e0564b)';
    }
    if (el.hpText) el.hpText.textContent = `${Math.ceil(hp)} / ${Math.ceil(max)}`;
  }

  updateAlerts() {
    const g = this.game;
    const strip = this.el.alertStrip;
    if (!strip) return;
    const t = g.teams.get(1);
    let msg = '';
    let kind = '';
    if (g.gameOver) return;
    if (t.ageResearch) msg = `Advancing — ${Math.ceil(t.ageResearch.time)}s`;
    else if (t.popUsed >= t.popCap) { msg = 'Population capped — build houses'; kind = 'warn'; }
    else if (g.alerts && g.alerts.length) {
      const a = g.alerts[g.alerts.length - 1];
      if (g.time - a.t < 6) { msg = a.text; kind = a.kind; }
    }
    if (strip.textContent !== msg) {
      strip.textContent = msg;
      strip.className = msg ? `alert ${kind}` : '';
    }
  }

  updatePerf() {
    const s = this.game.renderStats;
    const el = this.el.perfChip;
    if (!el || !s) return;
    const tick = this.game.stats.tickMs.toFixed(2);
    el.textContent = `${this.renderer.qualityName} · ${s.drawCalls} draws · ${(s.tris / 1000).toFixed(1)}k tris · ${tick}ms sim`;
  }

  /* ---------------- minimap ---------------- */
  buildMinimapBase() {
    const cv = this.el.minimap;
    if (!cv || !this.game || !this.game.world) return;
    const world = this.game.world;
    const hf = world.height;
    if (!hf) return;
    const N = 192;
    const off = document.createElement('canvas');
    off.width = N; off.height = N;
    const ctx = off.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(N, N);
    const d = img.data;
    const splat = world.splat;
    const water = world.water;
    const res = hf.res;
    const n = res + 1;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const wx = (x / N) * hf.size - hf.size * 0.5;
        const wz = (y / N) * hf.size - hf.size * 0.5;
        const gi = clamp(Math.round((wx + hf.size * 0.5) / hf.cell), 0, res);
        const gj = clamp(Math.round((wz + hf.size * 0.5) / hf.cell), 0, res);
        const k = gj * n + gi;
        const h = hf.h[k];
        const isWater = water && water[k];
        const layer = splat ? splat[k * 2] : 0;
        const blend = splat ? splat[k * 2 + 1] / 255 : 0;
        const o = (y * N + x) * 4;
        let r, g, b;
        if (isWater) {
          const depth = clamp(-h / 6, 0, 1);
          r = 46 - depth * 20; g = 86 - depth * 40; b = 104 - depth * 40;
        } else if (h > 13) { r = 150; g = 148; b = 140; }
        else if (layer === 2 || blend > 0.6) { r = 108 + blend * 26; g = 92 + blend * 20; b = 68 + blend * 12; }
        else if (layer === 3) { r = 122; g = 118; b = 108; }
        else if (layer === 4) { r = 186 + 20 * blend; g = 170 - 8 * blend; b = 120 + 10 * blend; }
        else {
          const alt = clamp((h + 2) / 16, 0, 1);
          r = 58 + alt * 34 + Math.random() * 6;
          g = 92 + alt * 26 + Math.random() * 6;
          b = 48 + alt * 16;
        }
        d[o] = clamp(r, 0, 255); d[o + 1] = clamp(g, 0, 255); d[o + 2] = clamp(b, 0, 255); d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.miniBase = off;
  }

  drawMinimap() {
    const ctx = this.miniCtx;
    const g = this.game;
    if (!ctx || !g) return;
    const W = this.el.minimap.width, H = this.el.minimap.height;
    if (this.miniBase) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.miniBase, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#12211c';
      ctx.fillRect(0, 0, W, H);
    }
    // fog overlay
    if (g.showFog !== false && g.fow) {
      const FOW = 96;
      const step = W / FOW;
      for (let z = 0; z < FOW; z++) {
        for (let x = 0; x < FOW; x++) {
          const v = g.fow[z * FOW + x];
          if (v === 2) continue;
          ctx.fillStyle = v === 1 ? 'rgba(6,10,14,0.42)' : 'rgba(4,7,10,0.94)';
          ctx.fillRect(x * step, z * step, step + 0.6, step + 0.6);
        }
      }
    }
    const px = (x) => ((x + 256) / 512) * W;
    const pz = (z) => ((z + 256) / 512) * H;
    // resource blips (tiny, only when explored)
    if (this.miniMode !== 2) {
      ctx.fillStyle = 'rgba(60,110,60,0.85)';
      const res = g.resources;
      for (let i = 0; i < res.length; i += 3) {
        const r = res[i];
        if (r.dead) continue;
        if (g.showFog !== false && !g.isExplored(r.x, r.z)) continue;
        if (r.resKind === 'wood') {
          ctx.fillStyle = 'rgba(52,96,52,0.7)';
          ctx.fillRect(px(r.x) - 1, pz(r.z) - 1, 2, 2);
        } else if (r.resKind === 'gold') {
          ctx.fillStyle = 'rgba(226,186,84,0.9)';
          ctx.fillRect(px(r.x) - 1, pz(r.z) - 1, 2.4, 2.4);
        }
      }
    }
    // buildings
    const build = g.buildings;
    for (let i = 0; i < build.length; i++) {
      const b = build[i];
      if (b.dead) continue;
      if (b.team === 1 || g.isVisible(b.x, b.z)) {
        ctx.fillStyle = b.team === 1 ? '#63b6e8' : b.team === 2 ? '#e0564b' : '#d9c07a';
        const s = b.def.ageAdvance ? 5 : 3.4;
        ctx.fillRect(px(b.x) - s / 2, pz(b.z) - s / 2, s, s);
      }
    }
    // units
    const units = g.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.garrisoned) continue;
      if (u.team !== 1 && !g.isVisible(u.x, u.z)) continue;
      ctx.fillStyle = u.team === 1 ? (u.type === 'villager' ? '#9adfe8' : '#7ac25b') : '#e0564b';
      ctx.fillRect(px(u.x) - 1.2, pz(u.z) - 1.2, 2.6, 2.6);
    }
    // camera view
    const cam = this.camera;
    const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const nx = corners[i][0], nz = corners[i][1];
      const o = [0, 0, 0], dir = [0, 0, 0];
      cam.screenRay(nx * 0.5 + 0.5, nz * 0.5 + 0.5, o, dir);
      const t = dir[1] < -0.02 ? (cam.target[1] - o[1]) / dir[1] : 60;
      const x = o[0] + dir[0] * Math.min(Math.max(t, 5), 400);
      const z = o[2] + dir[2] * Math.min(Math.max(t, 5), 400);
      if (i === 0) ctx.moveTo(px(x), pz(z)); else ctx.lineTo(px(x), pz(z));
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,240,196,0.75)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // selection pulses
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const e of g.selection) {
      if (!e || e.dead) continue;
      ctx.fillRect(px(e.x) - 2, pz(e.z) - 2, 4, 4);
    }
  }

  /* ---------------- end screen ---------------- */
  showEnd(win, reason) {
    const screen = document.getElementById('endScreen');
    if (!screen) return;
    const g = this.game;
    const t = g.teams.get(1);
    const title = win ? 'The Crown Is Yours' : 'The Empire Falls';
    const kicker = win ? 'VICTORY' : 'DEFEAT';
    const desc = win
      ? (reason === 'wonder' ? 'Your wonder stood unchallenged for two hundred seconds. History will remember.' : 'The enemy banners are down. Your rule begins.')
      : 'Your last banner has fallen. The chronicles will record this defeat.';
    const metrics = [
      ['Time', fmtTime(g.elapsed || g.time)],
      ['Units trained', t.trained || 0],
      ['Kills', t.kills || 0],
      ['Losses', t.losses || 0],
      ['Resources gathered', Math.floor(t.gathered || 0)],
      ['Age reached', AGES[t.age].name]
    ];
    const stats = document.getElementById('endStats');
    if (stats) stats.innerHTML = metrics.map(([k, v]) => `<div class="endStat"><span>${k}</span><b>${v}</b></div>`).join('');
    const k = document.getElementById('endKicker');
    if (k) { k.textContent = kicker; k.className = `endKicker ${win ? '' : 'lose'}`; }
    const h = document.getElementById('endTitle');
    if (h) h.textContent = title;
    const p = document.getElementById('endDesc');
    if (p) p.textContent = desc;
    screen.classList.remove('hidden');
    this.audio?.play(win ? 'win' : 'lose');
  }
}
