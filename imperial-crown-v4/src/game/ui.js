/* ============================================================
   ui.js — the in-game interface
   The DOM is built once. Every later update only patches text,
   widths and classes, so the compositor never re-lays-out the HUD
   mid-battle (the single biggest cause of stutter in v1).
   ============================================================ */
import {
  AGES, CIVS, RES_META, TECH_DEFS, UNIT_DEFS, BUILDING_DEFS, BUILDING_AGE, UNIT_AGE,
  POP_CAP, unitForCiv, teamColor, TEAM_COLORS
} from '../sim/data.js';
import { clamp, fmtTime } from '../core/math.js';
import { iconFor } from './menu.js';
import { STATE } from '../sim/entities.js';
const TEAM_NEUTRAL = 0;
/* The minimap has always drawn the player in blue and the enemy in red, on a
   parchment ground; that is part of the map's look, so the extra crowns take
   colours that read well at six pixels rather than reusing the 3D palette. */
const MINIMAP_TEAM = { 1: TEAM_COLORS[1].css, 2: TEAM_COLORS[2].css, 3: TEAM_COLORS[3].css, 4: TEAM_COLORS[4].css };
import { OFFICES as COURT_OFFICES, RANK_AT } from '../sim/court.js';
import { TAX_RATES } from '../sim/realm.js';

const CMD_HZ = 9;              // command card / text refresh rate
const MINI_HZ = 11;

const STANCE_LABEL = { aggressive: 'Aggressive', defensive: 'Defensive', stand: 'Stand ground' };

/** Deeds needed for the next rank of an office. */
function rankTarget(rank) { return RANK_AT[Math.min(RANK_AT.length - 1, rank)] || 0; }

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
      'ageBtn', 'ageName', 'ageHint', 'clock', 'worldTime', 'wonderTimer', 'seasonChip', 'realmChip', 'climateChip',
      'btnIdle', 'idleBadge', 'btnArmy', 'btnTech', 'btnDecrees', 'decreeBadge', 'btnCourt', 'courtBadge',
      'btnSound', 'btnPause', 'btnMenu', 'alertStrip',
      'stanceBar', 'formationBar', 'camRotL', 'camRotR', 'camHome', 'camZoomIn', 'camZoomOut', 'camTiltUp', 'camTiltDown',
      'minimap', 'miniStamp', 'btnGotoTC', 'btnMiniMode', 'btnFormation',
      'inspIcon', 'inspName', 'inspSub', 'inspMultiBtn', 'hpWrap', 'hpFill', 'hpText',
      'inspStats', 'queueWrap', 'queueFill', 'queueText', 'queueDots',
      'cmdBoot', 'cmdGrid', 'toastLayer', 'perfChip', 'diagBtn',
      'tapFx', 'floatLayer', 'selBox', 'stage', 'modalScreen', 'crownStrip'];
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
    click(el.btnCourt, () => this.openCourt());
    click(el.realmChip, () => this.openCourt());
    click(el.climateChip, () => this.openClimate());
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
    // Tilt: the only way to see the horizon (and with it the night sky) on a
    // touch device, where yaw comes from twisting and pitch had no control at
    // all. Held down, it sweeps.
    const tilt = (el2, dir) => {
      if (!el2) return;
      let timer = 0;
      const step = () => this.camera.nudge(0, dir * 0.06);
      el2.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        step();
        clearInterval(timer);
        timer = setInterval(step, 90);
      }, { passive: false });
      const stop = () => { clearInterval(timer); timer = 0; };
      el2.addEventListener('pointerup', stop);
      el2.addEventListener('pointercancel', stop);
      el2.addEventListener('pointerleave', stop);
    };
    tilt(el.camTiltUp, -1);
    tilt(el.camTiltDown, 1);
    click(el.inspMultiBtn, () => this.selectAllOfType());

    el.stanceBar?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-stance]');
      if (!b) return;
      this.setStance(b.dataset.stance);
    });

    el.formationBar?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-formation]');
      if (!b) return;
      this.setFormation(b.dataset.formation);
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
    /* A new match gets a new UI instance, but the DOM grid survives the one
       before it: without this, quitting to the menu and starting again left two
       sets of command cards stacked in the same grid, and the top ones still
       pointed at the match that had just been closed. */
    if (this.el.cmdGrid) this.el.cmdGrid.replaceChildren();
    this.cmdButtons.length = 0;
    this._adHocUntil = 0;
    this.buildMinimapBase();
    this.refreshCommands();
  }

  /* ---------------- command card ---------------- */
  refreshCommands() {
    const list = this.commandsForSelection();
    const sig = list.map((c) => `${c.icon}|${c.label}|${c.cost || ''}|${c.enabled === false ? 0 : 1}|${c.active ? 1 : 0}`).join('~');
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
      /* Only an explicit `enabled: false` blocks a command. Most commands --
         Build, Gather, Stop, Atk-Move, the whole utility card -- carry no
         enabled flag at all, and `!c.enabled` made every one of them swallow
         its own click with a "not enough resources" toast. */
      slot.el.classList.toggle('poor', c.enabled === false);
      slot.el.setAttribute('aria-disabled', c.enabled === false ? 'true' : 'false');
      slot.el.onclick = (e) => {
        e.preventDefault();
        if (c.enabled === false) { this.audio?.play('warn'); this.toast(c.reason || 'Not enough resources', 'warn'); return; }
        this.audio?.play('click');
        c.action();
      };
    }
  }

  _applyEnabled(list) {
    for (let i = 0; i < list.length && i < this.cmdButtons.length; i++) {
      const c = list[i], slot = this.cmdButtons[i];
      if (!slot) continue;
      slot.el.classList.toggle('poor', c.enabled === false);
      slot.el.classList.toggle('toggled', !!c.active);
      slot.cost.textContent = c.cost || '';
    }
  }

  /**
   * The command card. In a mod session the host appends whatever the active
   * mods want to offer for the current selection (spells, taming, upgrades);
   * in a normal match this is exactly the list it always was.
   */
  commandsForSelection() {
    const list = this._baseCommands();
    if (this.game && this.game.modHost) return this.game.modHost.decorateCommands(list, this);
    return list;
  }

  _baseCommands() {
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
          const popRoom = g.popFree(1) - g.queuedPop(1) >= ((UNIT_DEFS[type]?.pop) ?? 1);
          const afford = g.canAfford(1, cost) && popRoom;
          out.push({
            icon: u.icon, label: u.name.split(' ')[0], cost: costText(cost),
            enabled: afford, reason: !afford ? (!popRoom ? 'Population full — build houses' : 'Not enough resources') : '',
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
      out.push({ icon: 'people', label: 'Formation', action: () => this.cycleFormation() });
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
    /* capped or conditional units come from the running mod */
    if (g.modHost) {
      for (const t of g.modHost.trainableAt(b, 1)) {
        if (!UNIT_DEFS[t] || out.includes(t)) continue;
        out.push(t);
      }
    }
    return out;
  }

  trainUnit(building, type) {
    const g = this.game;
    if (!g.canAfford(1, g.unitCost(type, 1))) { this.toast('Not enough resources', 'warn'); return; }
    if (g.popFree(1) - g.queuedPop(1) < ((UNIT_DEFS[type]?.pop) ?? 1)) {
      this.toast('Population full — build houses', 'warn');
      return;
    }
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
    const types = ['house', 'farm', 'supply_tent', 'mill', 'lumber_camp', 'mining_camp', 'barracks', 'archery_range',
      'stable', 'blacksmith', 'market', 'watch_tower', 'palissade_wall', 'stone_wall', 'stone_gate',
      'monastery', 'siege_workshop', 'university', 'castle', 'dock', 'wonder'];
    /* a mod session adds its own tools to the same menu, in the same idiom */
    if (g.modHost) {
      for (const t of g.modHost.buildTypes(1)) if (BUILDING_DEFS[t] && !types.includes(t)) types.push(t);
    }
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
          g.placing = {
            type, x: this.camera.target[0], z: this.camera.target[2],
            y: g.heightAt(this.camera.target[0], this.camera.target[2]),
            footprint: def.size || 3, valid: true,
            /* walls (and mod traps) are drawn, not tapped: a drag lays the run */
            line: !!def.wall || !!def.dragLine, cells: null,
            builders: villagers.slice()   // the crew that opened the menu
          };
          this.toast(def.wall ? `Drag to draw a wall, tap for one ${def.name}` : `Tap the ground to place the ${def.name}`, 'gold');
          this._adHocUntil = 0;
          this.sig = '';
          this.refreshCommands();
        }
      });
    }
    out.push({ icon: 'close', label: 'Back', action: () => { this._adHocUntil = 0; this.sig = ''; this.refreshCommands(); } });
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

  /**
   * Formation is a property of the *next* move order, so it applies to the
   * whole game rather than to a selection that may be about to change. The rail
   * only shows it while troops are selected, which is when it matters.
   */
  setFormation(style) {
    const g = this.game;
    g.formationStyle = style;
    const label = { box: 'Box', line: 'Line', wedge: 'Wedge', column: 'Column' }[style] || style;
    this.toast(`Formation: ${label}`, 'info');
    this.sig = '';
    this.refreshCommands(true);
  }

  cycleFormation() {
    const order = ['box', 'line', 'wedge', 'column'];
    const next = order[(order.indexOf(this.game.formationStyle) + 1) % order.length];
    this.setFormation(next);
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
    const t = g.teams.get(1);
    const favor = t.favor || 0;
    const list = g.decrees || [];
    const buffs = (t.buffs || []);
    const buffRows = buffs.length ? `<div class="buffStrip">${buffs.map((b) => `
      <span class="buffPill" title="${b.name}"><i style="width:${Math.round((g.buffProgress ? g.buffProgress(1, b.name) : 0) * 100)}%"></i>
        ${b.name} · ${Math.ceil(b.time)}s</span>`).join('')}</div>` : '';
    const rows = list.map((d) => {
      const st = g.decreeState ? g.decreeState(1, d.id) : { ok: favor >= d.cost };
      const price = Math.round(d.cost * (g.court ? g.court.decreeDiscount(1) : 1));
      const why = st.ok ? `${price} favour` : st.used ? 'Already done' : (st.reason || 'Not yet');
      const cls = st.ok ? '' : 'locked';
      const saved = price < d.cost ? ` <em class="gold tiny">Hierophant −${Math.round((1 - price / d.cost) * 100)}%</em>` : '';
      return `
      <div class="row ${cls}" data-decree-row="${d.id}">
        <b>${icon(d.icon)} ${d.name}</b>
        <span>${d.desc}${saved}<br>
          <button class="ghostBtn" data-decree="${d.id}" ${st.ok ? '' : 'disabled'} title="${why}">${why}</button>
        </span>
      </div>`;
    }).join('');
    this.menu?.openModal('COUNCIL', `Imperial Decrees · ${Math.floor(favor)} favour`,
      `${buffRows}<div class="decreeList">${rows || '<p class="dim">No decrees available.</p>'}</div>`,
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

  /* ---------------- the Court ----------------
     Four offices, each held by a person on the map. The panel only *arms*
     an appointment or a writ: the next tap on the battlefield chooses the
     subject, which keeps the whole system inside the grammar the player
     already knows (pick a card, tap a target). */
  /* ---------------- the slow sky ----------------
     The climate panel is deliberately small: what the era is, what it is
     doing to every number, how much strain has built, and *when* the next
     turn lands. Those four things are everything a player needs to plan. */
  openClimate() {
    const g = this.game;
    if (!g || !g.climate) return;
    const c = g.climate;
    const era = c.era;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const nextTxt = c.isFinal
      ? '<em class="dim">There is no next sky. This one has to be survived.</em>'
      : `<em class="dim">${c.next.name} in ${Math.floor(c.remaining / 60)}:${String(Math.ceil(c.remaining % 60)).padStart(2, '0')} — or at strain ${c.next.strainAt}</em>`;
    const effects = [
      ['Wheat and meat', pct(era.food)],
      ['Timber', pct(era.wood)],
      ['Marching', pct(era.speed)],
      ['Healing', pct(era.heal)],
      ['Nerve', pct(era.morale)]
    ].map(([k, v]) => `<div class="row"><b>${k}</b><span class="dim">${v}</span></div>`).join('');
    this.menu?.openModal('THE SLOW SKY', era.name,
      `<div class="realmBlock">
        <p class="dim tiny">${era.blurb}</p>
        <div class="realmBar"><i style="width:${Math.round(c.strain)}%;background:linear-gradient(90deg,#8fd48a,#ffc861,#ff8f75)"></i></div>
        <em class="dim tiny">Strain ${Math.round(c.strain)} of 100 · ${c._forests} trees left on the island · ${c._buildings} buildings, ${c._farms} farms feeding it</em>
        <div style="margin:5px 0">${effects}</div>
        ${nextTxt}
        <p class="dim tiny" style="margin-top:5px">Every farm, every roof and every log on the fire adds strain; standing forest takes it back. Cut the island bare and the sky changes early — for both crowns.</p>
      </div>`,
      '<span class="dim tiny">The Wheel of the Year is the weather. This is the climate: a slower clock that decides which weather is even possible.</span>');
  }

  /* ---------------- The Crown's Standing ----------------
     The realm is the one system in the game whose numbers a player *must*
     be able to argue with, so the panel prints the whole ledger: every line
     that moves an estate is a row with its value and its icon. No hidden
     moods, no "your people are unhappy" without a reason on screen. */
  realmPanelHtml() {
    const g = this.game;
    if (!g || !g.realm) return '';
    const s = g.realm.state(1);
    const led = g.realm.ledger(1);
    const rowFor = (lines, value, target, colour, label) => {
      const rows = lines
        .filter((l) => l.label !== 'The crown endures' && l.label !== 'A lord with a seat')
        .map((l) => `<span class="${l.value >= 0 ? 'up' : 'down'}">${icon(l.icon)} ${l.label} ${l.value > 0 ? '+' : ''}${l.value.toFixed(1)}</span>`)
        .join('');
      const gap = target - value;
      const arrow = gap > 0.4 ? `↑ ${gap.toFixed(0)} to settle` : gap < -0.4 ? `↓ ${(-gap).toFixed(0)} to settle` : 'settled';
      return `
      <div class="realmHead">
        <h4 style="color:${colour}">${label} · ${g.realm.band(1, value === s.commons ? 'commons' : 'nobles').name}</h4>
        <div class="realmBar"><i style="width:${Math.round(value)}%;background:${colour}"></i><b class="tick" style="left:${Math.round(Math.max(0, Math.min(100, target)))}%"></b></div>
        <div class="realmLedger"><em class="dim">${arrow}</em><br>${rows || '<span class="dim">nothing moves it</span>'}</div>
      </div>`;
    };
    const taxRows = (TAX_RATES || []).map((tr) => `
      <button class="ghostBtn ${s.tax === tr.id ? 'on' : ''}" data-tax="${tr.id}" title="${tr.blurb}">${tr.name}</button>`).join('');
    const unrest = Math.max(s.unrestC, s.unrestN);
    return `
    <div class="realmBlock">
      <div class="realmHeads">
        ${rowFor(led.commons, s.commons, led.targetC, '#9be08a', 'Commons')}
        ${rowFor(led.nobles, s.nobles, led.targetN, '#e8c47a', 'Nobility')}
      </div>
      <div class="realmTax" data-tax-row>${taxRows}</div>
      ${unrest > 1 ? `<div class="realmUnrest">Unrest ${Math.round(unrest)}% — at 100% the ${s.unrestC >= s.unrestN ? 'commons rise' : 'nobility raise a claimant'}</div>` : ''}
      <div class="realmBtnRow">
        <button class="ghostBtn" data-realm="feast" ${s.feastCd > 0 ? 'disabled' : ''}>Feast · 140f 90g${s.feastCd > 0 ? ` · ${Math.ceil(s.feastCd)}s` : ''}</button>
        <button class="ghostBtn" data-realm="endow" ${s.endowCd > 0 ? 'disabled' : ''}>Endowments · 180g${s.endowCd > 0 ? ` · ${Math.ceil(s.endowCd)}s` : ''}</button>
      </div>
    </div>`;
  }

  openCourt() {
    const g = this.game;
    if (!g || !g.court) return;
    const t = g.teams.get(1);
    const age = t.age;
    const rows = g.court.summary(1).map((o) => {
      const def = COURT_OFFICES.find((d) => d.id === o.id);
      const locked = age < def.age;
      const holder = o.holder;
      const rankPips = '●'.repeat(o.rank) + '○'.repeat(3 - o.rank);
      const writ = o.writ;
      const writWhy = !holder ? 'No holder' : (!writ.ready ? (writ.cooldown > 0 ? `${Math.ceil(writ.cooldown)}s` : `${def.writ.cost.favor} favour`) : '');
      const deedBar = `<div class="deedBar"><i style="width:${Math.round(o.progress * 100)}%"></i></div>`;
      return `
      <div class="courtRow ${locked ? 'locked' : ''} ${holder ? 'on' : ''}" data-office-row="${o.id}">
        <b>${icon(o.icon)} ${o.name} <span class="tiny dim">${rankPips}</span></b>
        <span>
          ${holder
            ? `<em>${holder.def.name} · rank ${o.rank}</em> ${o.rank < 3 ? deedBar + `<em class="dim tiny">${o.deeds}/[${rankTarget(o.rank)}] ${def.deedLabel}</em>` : '<em class="gold tiny">rank III</em>'}`
            : `<em class="dim">${o.vacantFor > 0 ? `in mourning · ${Math.ceil(o.vacantFor)}s` : 'vacant'}</em>`}
          <br><span class="tiny dim">${def.passive[Math.min(o.rank - 1, 2)]}</span>
          <br>
          ${locked ? `<span class="tiny dim">Unlocks in the ${def.age === 1 ? 'Feudal' : 'Castle'} Age</span>` : holder
            ? `<button class="ghostBtn" data-appoint="${o.id}">Replace · ${costText(def.cost)}</button>
               <button class="ghostBtn" data-dismiss="${o.id}">Dismiss</button>`
            : `<button class="ghostBtn" data-appoint="${o.id}" ${o.vacantFor > 0 ? 'disabled' : ''}>Appoint · ${costText(def.cost)}</button>`}
          <button class="ghostBtn" data-writ="${o.id}" ${writ.ready ? '' : 'disabled'} title="${writWhy}">${def.writ.name}${writWhy ? ` · ${writWhy}` : ''}</button>
        </span>
      </div>`;
    }).join('');
    this.menu?.openModal('THE COURT', 'Offices of the realm', `${this.realmPanelHtml()}<div class="courtList">${rows}</div>`,
      `<span class="dim tiny">An office is held by a body on the battlefield: appoint a soldier, a villager, a rider or a monk, keep them alive, and the rank comes. Lose them and the office stands empty.</span>`);
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.addEventListener('click', (e) => {
      const tax = e.target.closest('[data-tax]');
      if (tax) {
        const r = g.realm.setTax(1, tax.dataset.tax);
        this.toast(r.ok ? `Tax: ${r.name}` : r.reason, r.ok ? 'info' : 'warn');
        this.openCourt();
        return;
      }
      const realmBtn = e.target.closest('[data-realm]');
      if (realmBtn) {
        const kind = realmBtn.dataset.realm;
        const r = kind === 'feast' ? g.realm.feast(1) : g.realm.endow(1);
        if (r.ok) { this.toast(kind === 'feast' ? 'A feast is thrown' : 'Titles granted', 'good'); this.audio?.play('horn'); }
        else this.toast(r.reason || 'Not possible', 'warn');
        this.openCourt();
        return;
      }
      const app = e.target.closest('[data-appoint]');
      if (app) {
        g.courtArmed = { office: app.dataset.appoint };
        g.courtWrit = null;
        this.menu?.closeModal();
        const def = COURT_OFFICES.find((d) => d.id === app.dataset.appoint);
        this.toast(`Tap one of your ${def.class === 'military' ? 'soldiers' : def.class === 'villager' ? 'villagers' : def.class === 'monk' ? 'monks' : 'units'} to raise them to ${def.name}`, 'gold');
        return;
      }
      const dis = e.target.closest('[data-dismiss]');
      if (dis) {
        g.court.dismiss(1, dis.dataset.dismiss);
        this.refreshCommands(true);
        this.openCourt();
        return;
      }
      const w = e.target.closest('[data-writ]');
      if (w) {
        const id = w.dataset.writ;
        const info = g.court.writ(1, id);
        if (!info || !info.ready) { this.toast('That writ is not ready', 'warn'); return; }
        if (info.target === 'unit') {
          g.courtWrit = { office: id };
          g.courtArmed = null;
          this.menu?.closeModal();
          this.toast(`${info.name} — tap an enemy unit`, 'gold');
          return;
        }
        const res = g.court.useWrit(1, id, null);
        if (res.ok) { this.toast(`${info.name} is proclaimed`, 'good'); this.audio?.play('horn'); this.openCourt(); }
        else this.toast(res.reason || 'The writ fails', 'warn');
      }
    }, { once: true });
  }

  openMarket() {
    const g = this.game;
    const t = g.teams.get(1);
    const price = (kind) => Math.max(1, Math.round((g.marketPrice ? g.marketPrice(kind, 1) : 100)));
    // the market is the one place the price of gold is visible, so show the
    // live number and what the store can actually pay for
    const gold = Math.floor(t.res.gold);
    const rows = ['food', 'wood', 'gold', 'stone'].map((k) => {
      const buy = price(k) * 100;
      const sell = Math.max(1, Math.round(buy * 0.72));
      const canBuy = gold >= buy;
      const canSell = Math.floor(t.res[k]) >= 100;
      const trend = (g.marketTrend ? g.marketTrend(k) : 0);
      const arrow = trend > 0.02 ? '▲' : trend < -0.02 ? '▼' : '·';
      return `
      <div class="row marketRow">
        <b>${RES_META[k].name}</b>
        <span>${Math.floor(t.res[k])} in store · <em class="dim tiny">${arrow} ${buy} gold / 100</em>
          <br><button class="ghostBtn" data-buy="${k}" ${canBuy ? '' : 'disabled'} title="${canBuy ? '' : 'Not enough gold'}">Buy 100 · ${buy}g</button>
          <button class="ghostBtn" data-sell="${k}" ${canSell ? '' : 'disabled'} title="${canSell ? '' : 'Nothing to sell'}">Sell 100 · +${sell}g</button></span>
      </div>`;
    }).join('');
    this.menu?.openModal('MARKET', `Trade goods · ${gold} gold`, rows,
      '<span class="dim tiny">Prices rise as your stores run low; selling pays 72% of the buy price.</span>');
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
    /* The same message twice is one message. A click that is ignored because
       the card is not affordable used to spawn a fresh toast on every tap, so
       tapping a dead button three times filled the screen with three identical
       lines. Refreshing the existing bubble says the same thing better: the
       message is still there, and it is obviously not going away. */
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      if (t.text === text && t.kind === kind) {
        t.t = 0;
        t.node.classList.remove('out');
        return;
      }
    }
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = text;
    layer.appendChild(node);
    this.toasts.push({ node, t: 0, life: 2.6, text, kind });
    /* Two at a time. Four toasted messages stacked over the middle of the
       play area, which is exactly where a build, a training click and a
       population warning all land together. */
    while (layer.children.length > 2) {
      const gone = layer.firstChild;
      layer.removeChild(gone);
      /* keep this.toasts honest: a node removed from the DOM but left in the
         list would swallow the next identical message into a dead bubble */
      const idx = this.toasts.findIndex((t) => t.node === gone);
      if (idx >= 0) this.toasts.splice(idx, 1);
    }
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
      this.updateModHud();
      /* An open build menu is modal. This used to overwrite it with the
         selection's own commands on the very next tick -- a quarter of a second
         on a phone -- which made the Build button look broken: the panel
         flashed and closed before a thumb could reach a card. */
      const adHoc = performance.now() < (this._adHocUntil || 0);
      if (!adHoc) {
        if (this._adHocUntil) { this._adHocUntil = 0; this.sig = ''; }
        if (!this.el.cmdGrid?.childElementCount) {
          this.refreshCommands();
        } else {
          /* Keep the card in sync with affordability. The signature must
             include the enabled flag, and the rebuild must go through
             refreshCommands (which stamps this.sig itself): stamping it here
             first made refreshCommands return early, so a card that became
             affordable kept its old "not enough resources" onclick. */
          const list = this.commandsForSelection();
          const sig = list.map((c) => `${c.icon}|${c.label}|${c.cost || ''}|${c.enabled === false ? 0 : 1}|${c.active ? 1 : 0}`).join('~');
          if (sig !== this.sig) { this._adHocUntil = 0; this.sig = ''; this.refreshCommands(); }
          else this._applyEnabled(list);
        }
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

  /**
   * The mod strip under the top bar. Built once per refresh, only in a mod
   * session, and torn down completely outside one so the normal HUD is
   * pixel-for-pixel what it always was.
   */
  updateModHud() {
    const el = this.el.modHud || (this.el.modHud = document.getElementById('modHud'));
    if (!el) return;
    const host = this.game && this.game.modHost;
    if (!host) {
      if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.replaceChildren(); }
      return;
    }
    el.classList.remove('hidden');
    const data = host.hud();
    const gauges = data.gauges || [];
    /* a mod may publish a chip and a gauge for the same thing (mana reads as
       both); the chip already carries its bar, so the gauge is dropped */
    const chipIds = new Set((data.chips || []).map((c) => c.id));
    const chips = (data.chips || []).filter((c) => c.id);
    const extraGauges = gauges.filter((gg) => !chipIds.has(gg.id));
    /* a stable signature: rebuild only when something actually changed */
    let sig = '';
    for (const c of chips) sig += `${c.id}|${c.icon}|${c.label}|${c.value}|${c.tone}|${c.pct || ''}~`;
    for (const g of extraGauges) sig += `g${g.id}|${Math.round(g.value * 40)}~`;
    if (sig === this._modSig) return;
    this._modSig = sig;
    const frag = document.createDocumentFragment();
    for (const c of chips) {
      const div = document.createElement('div');
      div.className = 'modChip' + (c.tone === 'good' ? ' good' : c.tone === 'bad' ? ' bad' : '');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ic');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#i-${iconFor(c.icon)}`);
      svg.appendChild(use);
      const b = document.createElement('b');
      b.textContent = c.label;
      const span = document.createElement('span');
      span.textContent = c.value;
      div.append(svg, b, span);
      if (c.pct !== undefined) {
        const bar = document.createElement('div');
        bar.className = 'modBar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.max(0, Math.min(1, c.pct)) * 100}%`;
        bar.appendChild(fill);
        div.appendChild(bar);
      }
      frag.appendChild(div);
    }
    for (const g of extraGauges) {
      const div = document.createElement('div');
      div.className = 'modChip';
      const b = document.createElement('b');
      b.textContent = g.label;
      const span = document.createElement('span');
      span.textContent = g.text || '';
      const bar = document.createElement('div');
      bar.className = 'modBar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(1, g.value)) * 100}%`;
      bar.appendChild(fill);
      div.append(b, span, bar);
      frag.appendChild(div);
    }
    el.replaceChildren(frag);
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
    if (el.wonderTimer) {
      /* The same pill carries the wonder countdown and, under a supremacy
         term, the clock until the war is decided by strength. A player who
         cannot see how long is left cannot make the decision the term asks
         of them: spend everything now, or hold. */
      const w = g.wonderStatus ? g.wonderStatus() : null;
      let str = '', side = 'mine', done = false;
      if (w) {
        const left = Math.max(0, Math.ceil(w.hold - Math.max(w.mine, w.theirs)));
        str = `\u2726 ${fmtTime(left)}`;
        side = w.theirs > w.mine ? 'enemy' : 'mine';
        done = left <= 0;
      } else if (g.victory === 'supremacy' && g.supremacyClock) {
        const left = Math.max(0, Math.ceil(g.supremacyClock - g.time));
        const board = g.scoreboard ? g.scoreboard() : null;
        str = `\u29d7 ${fmtTime(left)}`;
        side = board && board.length && board[0].team !== 1 ? 'enemy' : 'mine';
        done = left <= 0;
      }
      if (last.wonder !== str) {
        last.wonder = str;
        el.wonderTimer.textContent = str;
        el.wonderTimer.classList.toggle('hidden', !str);
        el.wonderTimer.dataset.side = side;
        el.wonderTimer.classList.toggle('done', done);
      }
    }
    /* ---- the Wheel of the Year ----
       A season pill under the clock. It carries the season's name and
       colour, and its tooltip is the actual rule table plus the omen: the
       omen is *not* discoverable from an icon, so it is spelled out. */
    if (el.seasonChip && g.calendar) {
      const cal = g.calendar;
      const key = `${cal.season.key}|${cal.omen ? cal.omen.id : ''}|${Math.round(cal.progress * 20)}`;
      if (this._lastSeasonKey !== key) {
        this._lastSeasonKey = key;
        const s = cal.season;
        const o = cal.omen;
        el.seasonChip.dataset.season = s.key;
        el.seasonChip.dataset.bad = o && o.bad ? '1' : '0';
        const use = el.seasonChip.querySelector('use');
        if (use) use.setAttribute('href', `#i-${iconFor(s.icon)}`);
        const b = el.seasonChip.querySelector('b');
        if (b) b.textContent = s.name;
        const left = Math.ceil(cal.remaining);
        const text = `${cal.describe()}\n${left}s left in ${s.name} (year ${cal.year})`;
        el.seasonChip.title = text;
        el.seasonChip.setAttribute('aria-label', text.replace(/\n/g, ', '));
      }
    }
    /* ---- the Crown's Standing ----
       One number, because the chip is read at a glance: the *lower* of the
       two estates. The tooltip carries both bars and the unrest clock, and
       tapping it opens the Court, where the ledger lives. */
    if (el.realmChip && g.realm) {
      const w = g.realm.worst(1);
      const key = `${Math.round(w.value)}|${w.band.id}|${g.realm.state(1).golden ? 1 : 0}`;
      if (this._lastRealmKey !== key) {
        this._lastRealmKey = key;
        const b = el.realmChip.querySelector('b');
        if (b) b.textContent = String(Math.round(w.value));
        el.realmChip.dataset.band = w.band.id;
        el.realmChip.dataset.golden = g.realm.state(1).golden ? '1' : '0';
        const use = el.realmChip.querySelector('use');
        if (use) use.setAttribute('href', w.band.id === 'angry' || w.band.id === 'hostile' ? '#i-warning' : '#i-crown');
        const d = g.realm.describe(1);
        const unrest = Math.max(g.realm.state(1).unrestC, g.realm.state(1).unrestN);
        const text = [`The Crown's Standing`,
          `Commons: ${d.commons}`, `Nobility: ${d.nobles}`, `Tax: ${d.tax}`,
          unrest > 1 ? `Unrest: ${Math.round(unrest)}% — a rising gathers` : 'No unrest',
          d.golden ? 'A golden age' : ''
        ].filter(Boolean).join('\n');
        el.realmChip.title = text;
        el.realmChip.setAttribute('aria-label', text.replace(/\n/g, ', '));
      }
    }
    /* ---- the slow sky ----
       Names the era and carries a strain bar under it. The tooltip is the
       whole rules table plus when the next turn is coming, because a climate
       a player cannot forecast is just a random tax. */
    /* ---- the crowns ----
       Only in a War of Crowns, and only every half second: one pill per
       kingdom with its strength, struck through when it falls. This is the
       scoreboard a player needs to decide who to hit next. */
    if (el.crownStrip && g.teamIds && g.teamIds.length > 2) {
      this.crownAcc = (this.crownAcc || 0) + dt;
      if (this.crownAcc > 0.5) {
        this.crownAcc = 0;
        el.crownStrip.classList.remove('hidden');
        const rows = g.scoreboard();
        const sig = rows.map((r) => `${r.team}${r.alive ? 1 : 0}${Math.round(r.score / 10)}`).join('|');
        if (this._lastCrownKey !== sig) {
          this._lastCrownKey = sig;
          el.crownStrip.innerHTML = rows.map((r) => {
            const col = MINIMAP_TEAM[r.team] || '#b9a678';
            const label = r.name.split(' ')[0];
            return `<span class="crown${r.team === 1 ? ' me' : ''}${r.alive ? '' : ' fallen'}" title="${r.name} · ${r.alive ? `${Math.round(r.score)} strength` : 'fallen'}">
              <i style="background:${col}"></i>${label}<b>${r.alive ? Math.round(r.score) : '✕'}</b></span>`;
          }).join('');
        }
      }
    } else if (el.crownStrip) {
      el.crownStrip.classList.add('hidden');
    }
    if (el.climateChip && g.climate) {
      const c = g.climate.chip();
      const key = `${c.id}|${Math.round(c.strain)}|${Math.round(c.progress * 12)}`;
      if (this._lastClimateKey !== key) {
        this._lastClimateKey = key;
        el.climateChip.dataset.era = c.id;
        const b = el.climateChip.querySelector('b');
        if (b) b.textContent = c.id === 'temperate' ? 'Temperate' : g.climate.era.name.replace(/^The /, '');
        const use = el.climateChip.querySelector('use');
        if (use) use.setAttribute('href', `#i-${iconFor(g.climate.era.icon)}`);
        let bar = el.climateChip.querySelector('.strain');
        if (!bar) {
          bar = document.createElement('span');
          bar.className = 'strain';
          bar.innerHTML = '<i></i>';
          el.climateChip.appendChild(bar);
        }
        const fill = bar.querySelector('i');
        if (fill) fill.style.width = `${Math.round(g.climate.strain)}%`;
        el.climateChip.title = g.climate.describe();
      }
    }
    if (el.worldTime) {
      const wt = g.worldTime || 12;
      const hh = Math.floor(wt);
      const mm = Math.floor((wt - hh) * 60);
      const phase = g.dayPhase || (wt < 6 || wt > 19.5 ? 'night' : 'day');
      const iconTxt = phase === 'night' ? '☾' : phase === 'dusk' ? '☾' : phase === 'dawn' ? '☀' : '☀';
      const str = `${iconTxt} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      if (el.worldTime.textContent !== str) el.worldTime.textContent = str;
      // the pill changes colour with the phase so "it is getting dark" is
      // readable at a glance without reading the numbers
      if (this._lastPhase !== phase) {
        this._lastPhase = phase;
        el.worldTime.dataset.phase = phase;
      }
      /* Say what the phase is *worth*, not just that it is dark: the rules
         table is the whole point of the cycle and it is not discoverable from a
         moon icon. Rewritten only when the numbers actually move (in ~2 %
         steps), so this is not a per-frame DOM write. */
      const dl = typeof g.daylight === 'number' ? g.daylight : 1;
      const gather = Math.round((0.86 + 0.24 * dl) * 100);
      const melee = Math.round((1 + 0.16 * (1 - dl)) * 100);
      const sight = Math.round((0.84 + 0.16 * dl) * 100);
      const dayKey = `${phase}|${gather}|${melee}|${sight}`;
      if (this._lastDayKey !== dayKey) {
        this._lastDayKey = dayKey;
        const when = phase === 'night' ? 'Night — raiding hours'
          : phase === 'dusk' ? 'Dusk — raid or defend'
          : phase === 'dawn' ? 'Dawn — back to work'
          : 'Day — working hours';
        const text = `${when}\nMelee damage ${melee}%\nGathering ${gather}%\nSight ${sight}%`;
        el.worldTime.title = text;
        el.worldTime.setAttribute('aria-label', text.replace(/\n/g, ', '));
      }
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
    if (el.courtBadge && g.court) {
      /* the badge is a nudge, not a census: only seats the player could fill
         this instant, i.e. unlocked by age and not in mourning */
      let open = 0;
      for (const o of g.court.summary(1)) {
        const def = COURT_OFFICES.find((d) => d.id === o.id);
        if (!def || o.holder || o.vacantFor > 0) continue;
        if (t.age < def.age) continue;
        open++;
      }
      if (el.courtBadge.textContent !== String(open)) {
        el.courtBadge.textContent = String(open);
        el.courtBadge.style.display = open ? '' : 'none';
      }
    }
    // stance highlight
    const selUnits = g.selection.filter((e) => e.kind === 'unit' && e.team === 1);
    const stance = selUnits.length ? selUnits[0].stance : null;
    if (this.el.stanceBar) {
      this.el.stanceBar.style.display = selUnits.length ? '' : 'none';
      if (stance) for (const b of this.el.stanceBar.children) b.classList.toggle('active', b.dataset.stance === stance);
    }
    if (this.el.formationBar) {
      this.el.formationBar.style.display = selUnits.length ? '' : 'none';
      for (const b of this.el.formationBar.children) b.classList.toggle('active', b.dataset.formation === g.formationStyle);
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
    const teamName = e.team === 0 ? 'Neutral' : (g.civOf(e.team) ? CIVS[g.civOf(e.team)]?.name : 'Rebels');
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
                : st === STATE.REPAIR ? 'Repairing' : st === STATE.HEAL ? 'Healing'
                  : st === STATE.ROUT ? 'Falling back' : 'Ready';
        sub = `${teamName} · ${stateName}`;
        if (e.rank && g.veterancy) sub += ` · ${g.veterancy.name(e)}`;
        /* renown is a different axis from rank: how long he has lived, not
           what he has done. The player needs both names to read a company. */
        if (g.elites) {
          const rn = g.elites.describe(e);
          if (rn) sub += ` · ${rn.name}`;
        }
      }
      el.inspSub.textContent = sub;
    }
    this._hp(e.hp, e.maxHp);
    if (el.inspStats) {
      if (e.kind === 'unit') {
        const s = e.stats ? e.stats() : e.def;
        const vet = e.rank
          ? `<span class="rankChip" title="${Math.round(e.xp || 0)} xp">${'▴'.repeat(e.rank)}</span>`
          : '';
        /* the flag is the game's own sprite, not a text glyph: U+2691 is
           missing from the device's fallback font and rendered as a box */
        const morale = (e.def && e.def.attack > 0)
          ? `<span class="morale${(e.morale ?? 100) < 40 ? ' bad' : ''}" title="Morale — kept up by supply buildings${e.fed ? '' : ' (out of supply)'}"><svg class="ic"><use href="#i-flag"/></svg>${Math.round(e.morale ?? 100)}</span>`
          : '';
        /* the renown power, named: a player cannot counter what is invisible */
        let renown = '';
        if (g.elites) {
          const rn = g.elites.describe(e);
          if (rn) {
            const next = rn.next ? ` · next ${rn.next} in ${rn.left}s` : '';
            renown = `<span class="renownChip" title="${rn.power} Counter: ${rn.counter}${next}">★ ${rn.name}</span>`;
          }
        }
        el.inspStats.innerHTML = vet + renown + morale + `<span>⚔ ${Math.round(s.attack || 0)}</span><span>🛡 ${s.armor || 0}/${s.pierceArmor || 0}</span>` +
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
    const buff = t.buffs && t.buffs.length ? t.buffs[t.buffs.length - 1] : null;
    if (buff) msg = `${buff.name} · ${Math.ceil(buff.time)}s`;
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
    /* Fog overlay, as one scaled blit.
       v2 drew this as 128x128 = 16384 fillRect() calls, eleven times a second,
       on the same thread that builds the frame -- nearly two hundred thousand
       canvas operations per second on a phone, for a 128-pixel thumbnail. The
       mask is a byte grid, so it goes into an ImageData (256 bytes a row) and
       is drawn once with bilinear upscaling. */
    if (g.showFog !== false && g.fow && g.fow.length) {
      const FOW = Math.round(Math.sqrt(g.fow.length));
      this._fogImage ||= document.createElement('canvas');
      const fc = this._fogImage;
      if (fc.width !== FOW || fc.height !== FOW) { fc.width = FOW; fc.height = FOW; }
      if (!this._fogCtx) this._fogCtx = fc.getContext('2d');
      if (this._fogStamp !== g.fowStamp) {
        this._fogStamp = g.fowStamp;
        if (!this._fogData || this._fogData.width !== FOW) {
          this._fogData = this._fogCtx.createImageData(FOW, FOW);
        }
        const d = this._fogData.data;
        const fow = g.fow;
        for (let i = 0; i < fow.length; i++) {
          const v = fow[i];
          const o = i << 2;
          if (v === 2) { d[o + 3] = 0; continue; }
          // cool, opaque haze over ground you have seen but cannot watch
          d[o] = 6; d[o + 1] = 10; d[o + 2] = 14;
          d[o + 3] = v === 1 ? 96 : 226;
        }
        this._fogCtx.putImageData(this._fogData, 0, 0);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fc, 0, 0, W, H);
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
        ctx.fillStyle = b.team === TEAM_NEUTRAL ? '#b9a678' : (MINIMAP_TEAM[b.team] || '#b9a678');
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
      /* the player keeps the blue/green it always had; rivals carry their
         crown's colour so four armies can be told apart on one map */
      ctx.fillStyle = u.type === 'villager'
        ? (u.team === 1 ? '#9adfe8' : MINIMAP_TEAM[u.team] || '#e0564b')
        : (u.team === 1 ? '#7ac25b' : MINIMAP_TEAM[u.team] || '#e0564b');
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
    /* A war of crowns has one more way to end and one more way to read: a
       fallen kingdom's army changes colours, so "conquest" is not always the
       banner picture a player saw. */
    const crowns = g.crowns || 2;
    const winDesc = {
      wonder: 'Your wonder stood unchallenged for two hundred seconds. History will remember.',
      regicide: crowns > 2 ? 'Every rival king is dead. Three thrones, one crown.' : 'The enemy king is dead. Their lords kneel before yours.',
      dominance: 'Nothing of the enemy stands. The land is yours by right of arms.',
      supremacy: crowns > 2 ? 'The clock ran out with your kingdom the strongest on the island. The others bend the knee.' : 'The time of decision came, and your realm stood strongest. The war is won.',
      conquest: crowns > 2 ? 'Every rival crown is broken. Their armies march under your banner now.' : 'The enemy banners are down. Your rule begins.'
    };
    const loseDesc = {
      wonder: 'Their wonder stood unchallenged. The chronicles will not be kind.',
      regicide: 'Your king has fallen. The line ends here.',
      dominance: 'Not one stone of yours still stands. There is nothing left to defend.',
      supremacy: 'The clock ran out with another crown stronger than yours. The war is theirs by right of strength.',
      conquest: crowns > 2 ? 'The other crowns outlasted you. Your lands are theirs now, and your soldiers too.' : 'Your last banner has fallen. The chronicles will record this defeat.'
    };
    const desc = win ? (winDesc[reason] || winDesc.conquest) : (loseDesc[reason] || loseDesc.conquest);
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
