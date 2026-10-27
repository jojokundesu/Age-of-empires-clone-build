/* ============================================================
   host.js — the mod runtime
   ------------------------------------------------------------
   A mod session is a *separate play mode*. Nothing here runs unless
   the player launched the game from the Mod Workshop, and the only
   thing a normal match ever pays is the `if (this.modHost)` checks
   sprinkled through game.js / entities.js.

   Rules this file enforces, so that a bad mod can only hurt itself:

     1. every mod hook runs inside `_guard()`, which catches, disables
        that one mod, removes the content it registered and tells the
        player — the match keeps running;
     2. content is registered by *adding* keys to the shared tables on
        activate and *deleting exactly those keys* on deactivate, so
        leaving a mod session restores the game byte-for-byte;
     3. mods never touch the renderer, the HUD or the input directly:
        they describe what they want (a chip, a command, a targeting
        cursor, a tint) and the host builds it with the game's own UI.

   Everything a mod can do goes through `api`, so the surface is
   testable without a browser.
   ============================================================ */
import { UNIT_DEFS, BUILDING_DEFS } from '../sim/data.js';
import { installModModels, modModelTypes } from '../gfx/models.js';
import { MODS, MOD_BY_ID } from './registry.js';

const TICK_HZ = 5;            // mechanics run five times a second, not sixty
const TICK_DT = 1 / TICK_HZ;

/* Every id any mod can ever register. Used to scrub the data tables before a
   session starts, so leaving a match without a clean dispose (a crash, a tab
   closed mid-load) can never poison the next session with "id already taken".
   Base-game ids are never in this set by construction. */
const MOD_UNIT_IDS = new Set();
const MOD_BUILDING_IDS = new Set();
for (const m of MODS) {
  for (const id of Object.keys(m.units || {})) MOD_UNIT_IDS.add(id);
  for (const id of Object.keys(m.buildings || {})) MOD_BUILDING_IDS.add(id);
}

export class ModHost {
  /**
   * @param {Game} game
   * @param {{enabled?: string[], options?: Object, renderer?: Object,
   *          onError?: Function, onContent?: Function}} opts
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.renderer = opts.renderer || null;
    this.onError = opts.onError || null;
    this.onContent = opts.onContent || null;
    this.enabledIds = (opts.enabled || []).filter((id) => MOD_BY_ID[id]);
    this.options = opts.options || {};
    this.mods = new Map();                 // id -> { mod, api, state }
    this.errors = [];
    this._acc = 0;
    this._hud = { chips: [], gauges: [], banner: '' };
    this._hudTick = 0;
    this._atmosphere = null;
    this._registered = { units: [], buildings: [] };   // per mod: id -> list
    this._originalTrains = new Map();                 // building type -> original array
    this._installedModels = [];
    this.modCast = null;
    this._purgeStale();
    game.modHost = this;
    this.activate();
  }

  /* ------------------------------------------------------------
     lifecycle
     ------------------------------------------------------------ */
  _purgeStale() {
    for (const id of MOD_UNIT_IDS) delete UNIT_DEFS[id];
    for (const id of MOD_BUILDING_IDS) delete BUILDING_DEFS[id];
    for (const def of Object.values(BUILDING_DEFS)) {
      if (Array.isArray(def.trains) && def.trains.some((t) => MOD_UNIT_IDS.has(t))) {
        def.trains = def.trains.filter((t) => !MOD_UNIT_IDS.has(t));
      }
    }
  }

  activate() {
    for (const id of this.enabledIds) {
      const mod = MOD_BY_ID[id];
      if (!mod) continue;
      const state = this._guardRaw(mod, () => mod.createState?.(this.options[id] || {}) ?? {}, {});
      const api = this._apiFor(mod, state);
      const entry = { mod, api, state, opts: this.options[id] || {} };
      this.mods.set(id, entry);
      /* content first: a mod that fails to register is dropped before it can
         touch the world */
      if (this._guard(mod, () => this._registerContent(mod)) === undefined) continue;
      this._guard(mod, () => mod.setup && mod.setup(api));
    }
    this._installModels();
    this.refreshAtmosphere();
    this.refreshHud();
  }

  dispose() {
    for (const [id, entry] of [...this.mods]) {
      /* out of the map first: _unregisterContent re-applies every mod that is
         still live, and a mod that is being torn down is not live. Leaving it
         in re-added its own unit ids to the train lists after the restore, so
         a disposed Arcane session left a Mage on the Town Centre forever. */
      this.mods.delete(id);
      this._guard(entry.mod, () => entry.mod.dispose && entry.mod.dispose(entry.api));
      this._unregisterContent(entry.mod);
    }
    this.mods.clear();
    this.enabledIds = [];
    this._atmosphere = null;
    this._hud = { chips: [], gauges: [], banner: '' };
    /* models stay registered on purpose: they are inert art with no type in
       the data tables, and unregistering mid-frame could pull a batch out
       from under the renderer */
    if (this.game && this.game.modHost === this) this.game.modHost = null;
  }

  /* ------------------------------------------------------------
     content registration
     ------------------------------------------------------------ */
  _registerContent(mod) {
    const units = mod.units || {};
    const buildings = mod.buildings || {};
    const reg = { units: [], buildings: [] };
    /* claimed before the loops: a mod that throws on its third type must still
       have its first two removed */
    this._registered[mod.id] = reg;
    for (const [id, def] of Object.entries(units)) {
      if (UNIT_DEFS[id]) throw new Error(`unit id "${id}" is already taken`);
      UNIT_DEFS[id] = def;
      reg.units.push(id);
    }
    for (const [id, def] of Object.entries(buildings)) {
      if (BUILDING_DEFS[id]) throw new Error(`building id "${id}" is already taken`);
      BUILDING_DEFS[id] = def;
      reg.buildings.push(id);
      /* a building that trains something adds to the host building's queue
         list; the original array is restored on dispose */
      const trains = def.trains;
      if (trains && trains.length) {
        for (const host of def.trainAt || []) {
          const hd = BUILDING_DEFS[host];
          if (!hd || !hd.trains) continue;
          if (!this._originalTrains.has(host)) this._originalTrains.set(host, hd.trains.slice());
          for (const t of trains) if (!hd.trains.includes(t)) hd.trains.push(t);
        }
      }
    }
    /* A *unit* may also name the buildings that can train it. That is how a
       mod-added unit (the Arcane Order's mage, for instance) joins a Town
       Centre's queue list without a modded building to host it. v5 only
       supported building -> trainAt, so the workshop drew a Mage card while
       Building.queueUnit() rejected the order: the button existed, the
       resources were there, and nothing was ever produced. */
    for (const [id, def] of Object.entries(units)) {
      if (!Array.isArray(def.trainAt)) continue;
      for (const host of def.trainAt) {
        const hd = BUILDING_DEFS[host];
        if (!hd || !Array.isArray(hd.trains)) continue;
        if (!this._originalTrains.has(host)) this._originalTrains.set(host, hd.trains.slice());
        if (!hd.trains.includes(id)) hd.trains.push(id);
      }
    }
    this._registered[mod.id] = reg;
    return reg;
  }

  _unregisterContent(mod) {
    const reg = this._registered[mod.id];
    if (reg) {
      for (const id of reg.units) delete UNIT_DEFS[id];
      for (const id of reg.buildings) delete BUILDING_DEFS[id];
      delete this._registered[mod.id];
    }
    /* restore every trains list this mod could have touched */
    for (const [host, original] of this._originalTrains) {
      const hd = BUILDING_DEFS[host];
      if (!hd) continue;
      hd.trains = original.slice();
    }
    this._originalTrains.clear();
    /* re-apply the lists of the mods that are still active -- and only those
       whose content is actually registered right now */
    const dying = mod && mod.id;
    for (const [id, entry] of this.mods) {
      if (id === dying || !this._registered[id]) continue;
      const buildings = entry.mod.buildings || {};
      for (const def of Object.values(buildings)) {
        if (!def.trains || !def.trains.length) continue;
        for (const host of def.trainAt || []) {
          const hd = BUILDING_DEFS[host];
          if (!hd || !hd.trains) continue;
          if (!this._originalTrains.has(host)) this._originalTrains.set(host, hd.trains.slice());
          for (const t of def.trains) if (!hd.trains.includes(t)) hd.trains.push(t);
        }
      }
      for (const [id, def] of Object.entries(entry.mod.units || {})) {
        if (!Array.isArray(def.trainAt)) continue;
        for (const host of def.trainAt) {
          const hd = BUILDING_DEFS[host];
          if (!hd || !Array.isArray(hd.trains)) continue;
          if (!this._originalTrains.has(host)) this._originalTrains.set(host, hd.trains.slice());
          if (!hd.trains.includes(id)) hd.trains.push(id);
        }
      }
    }
  }

  _installModels() {
    const types = installModModels();
    this._installedModels = types;
    if (!this.renderer || !this.renderer.registerTypes) return;
    /* only the types some active mod actually uses */
    const used = { units: [], buildings: [] };
    for (const [, entry] of this.mods) {
      for (const id of Object.keys(entry.mod.units || {})) used.units.push(id);
      for (const id of Object.keys(entry.mod.buildings || {})) used.buildings.push(id);
    }
    this._guardRaw(null, () => this.renderer.registerTypes(used.units, used.buildings), null);
    if (this.onContent) this.onContent(used);
  }

  /* ------------------------------------------------------------
     per-mod API
     ------------------------------------------------------------ */
  _apiFor(mod, state) {
    const game = this.game;
    const host = this;
    if (!state) state = {};
    const api = {
      mod: mod.id,
      game,
      host,
      state,
      options: this.options[mod.id] || {},
      get time() { return game.time; },
      rng: () => game.rng(),
      range: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
      units: () => game.units.filter((u) => !u.dead),
      buildings: () => game.buildings.filter((b) => !b.dead),
      teamUnits: (team) => game.units.filter((u) => !u.dead && u.team === team),
      teamBuildings: (team) => game.buildings.filter((b) => !b.dead && b.team === team),
      enemiesOf: (team) => game.units.filter((u) => !u.dead && u.team !== team && u.team !== 0),
      spawn: (type, team, x, z) => game.spawnUnitRaw(type, team, x, z),
      spawnBuilding: (type, team, x, z, instant = true) =>
        game.placeBuilding(type, team, x, z, { instant, free: true }),
      /* A spell is a Champion's deed too: one multiplier, applied once, in
         the same place every spell's damage already passes through. */
      damage: (ent, amount, source) => {
        const mul = source && game.champions ? game.champions.spellPower(source) : 1;
        return ent.takeDamage(amount * mul, source || null, 'pierce');
      },
      champion: {
        renown: (unit, amount, why) => game.champions && game.champions.addRenown(unit, amount, why),
        manaMax: (unit) => game.champions ? game.champions.manaMax(unit) : 0,
        manaRegenMul: (unit) => game.champions ? game.champions.manaRegenMul(unit) : 1,
        cooldownMul: (unit) => game.champions ? game.champions.cooldownMul(unit) : 1,
        spellCostMul: (unit) => game.champions ? game.champions.spellCostMul(unit) : 1,
        healMul: (unit) => game.champions ? game.champions.healMul(unit) : 1,
        rankName: (unit) => game.champions ? game.champions.rankName(unit) : ''
      },
      heal: (ent, amount) => ent.heal(amount),
      say: (text, kind) => game.notify(text, kind || 'info'),
      /* presentation trimmings a spell needs to land: the camera can be kicked
         and the frame can bloom white for an instant. Both are *requests* --
         the host clamps them, and the renderer owns what they mean. */
      shake: (amount = 0.3) => { if (game.camera) game.camera.addShake(Math.min(1.2, amount)); },
      flash: (amount = 0.25, color) => {
        if (host.renderer && host.renderer.flash !== undefined) {
          host.renderer.flash = Math.max(host.renderer.flash, Math.min(0.85, amount));
          if (color && host.renderer.flashTint) host.renderer.flashTint = color.slice(0, 3);
        }
      },
      mark: (x, z, o) => game.marker(x, z, o),
      fx: game.fx,
      height: (x, z) => game.heightAt(x, z),
      passable: (x, z) => game.isPassable(x, z, { radius: 0.4, def: { naval: false } }),
      line: (x0, z0, x1, z1) => game.walkableLine(x0, z0, x1, z1, { radius: 0.4, def: { naval: false } }),
      headroom: (x, z) => game.freeSpotNear(x, z, { radius: 0.4, def: { naval: false } }, 6),
      hud: (chip) => host._setChip(mod.id, chip),
      banner: (text) => { host._hud.banner = text || ''; },
      /** free-form per-unit scratch space, created once */
      unitState: (u, init) => {
        if (!u) return null;
        if (!u.modState) u.modState = {};
        if (!u.modState[mod.id]) u.modState[mod.id] = init ? init() : {};
        return u.modState[mod.id];
      },
      buff: (team, kind, mul, seconds) => game.addBuff(team, kind, mul, seconds, `mod:${mod.id}`),
      ability: (def) => def
    };
    api.state = state;
    return api;
  }

  _setChip(modId, chip) {
    const list = this._hud.chips;
    const i = list.findIndex((c) => c.id === modId);
    if (i >= 0) list[i] = { ...chip, id: modId };
    else list.push({ ...chip, id: modId });
  }

  /* ------------------------------------------------------------
     guarded hooks
     ------------------------------------------------------------ */
  _guardRaw(mod, fn, fallback) {
    try { return fn(); } catch (err) { this._fail(mod, err); return fallback; }
  }
  _guard(mod, fn) {
    const label = mod && mod.id;
    try { return fn(); } catch (err) { this._fail(mod, err); return label ? undefined : null; }
  }

  _fail(mod, err) {
    const id = mod && mod.id;
    const name = (mod && mod.name) || id || 'mod';
    const msg = err && err.message ? err.message : String(err);
    this.errors.push({ mod: id, message: msg, time: this.game ? this.game.time : 0 });
    if (id && this.mods.has(id)) {
      const entry = this.mods.get(id);
      this.mods.delete(id);
      this._unregisterContent(mod);
      this._guardRaw(null, () => mod.dispose && mod.dispose(entry.api), null);
    }
    if (this.onError) this.onError({ mod: id, name, message: msg });
    /* the report goes to the player, not to the console the phone cannot show */
    if (this.game && this.game.notify) {
      this.game.notify(`${name} disabled itself (${msg}) — the match goes on`, 'bad');
    }
  }

  activeList() {
    const out = [];
    for (const entry of this.mods.values()) out.push(entry);
    return out;
  }
  isActive(id) { return this.mods.has(id); }
  activeIds() { return [...this.mods.keys()]; }

  /* ------------------------------------------------------------
     simulation hooks (called from game.js / entities.js)
     ------------------------------------------------------------ */
  update(dt) {
    this._acc += dt;
    /* never let a long frame pile up hooks: mods see at most one tick per
       frame and at most TICK_HZ per second of game time */
    if (this._acc < TICK_DT) return;
    const step = Math.min(this._acc, TICK_DT * 3);
    this._acc = 0;
    for (const entry of this.activeList()) {
      this._guard(entry.mod, () => entry.mod.tick && entry.mod.tick(entry.api, step));
    }
    this.refreshAtmosphere();
    this._hudTick++;
    if (this._hudTick % 2 === 0) this.refreshHud();
  }

  onSpawn(unit) {
    for (const entry of this.activeList()) {
      this._guard(entry.mod, () => entry.mod.onSpawn && entry.mod.onSpawn(entry.api, unit));
    }
  }
  onBuildingComplete(b) {
    for (const entry of this.activeList()) {
      this._guard(entry.mod, () => entry.mod.onBuildingComplete && entry.mod.onBuildingComplete(entry.api, b));
    }
  }
  onDeath(ent, killer) {
    for (const entry of this.activeList()) {
      this._guard(entry.mod, () => entry.mod.onDeath && entry.mod.onDeath(entry.api, ent, killer));
    }
  }
  onDamage(ent, amount, attacker, kind) {
    let out = amount;
    for (const entry of this.activeList()) {
      const r = this._guard(entry.mod, () => entry.mod.onDamage && entry.mod.onDamage(entry.api, ent, out, attacker, kind));
      if (typeof r === 'number' && Number.isFinite(r) && r >= 0) out = r;
    }
    return out;
  }
  speedMul(unit) {
    let m = 1;
    for (const entry of this.activeList()) {
      const r = this._guard(entry.mod, () => entry.mod.speedMul && entry.mod.speedMul(entry.api, unit));
      if (typeof r === 'number' && Number.isFinite(r) && r > 0) m *= r;
    }
    return m;
  }

  /* ------------------------------------------------------------
     presentation hooks
     ------------------------------------------------------------ */
  refreshAtmosphere() {
    let at = null;
    for (const entry of this.activeList()) {
      const r = this._guard(entry.mod, () => entry.mod.atmosphere && entry.mod.atmosphere(entry.api));
      if (!r) continue;
      at = at || { tint: [1, 1, 1], fog: 0, exposure: 1, cloud: 0, night: 0 };
      if (r.tint) { at.tint[0] *= r.tint[0]; at.tint[1] *= r.tint[1]; at.tint[2] *= r.tint[2]; }
      if (r.fog) at.fog += r.fog;
      if (r.exposure) at.exposure *= r.exposure;
      if (r.cloud) at.cloud += r.cloud;
      if (r.night) at.night = Math.max(at.night, r.night);
    }
    this._atmosphere = at;
    if (this.renderer) this.renderer.modAtmosphere = at;
  }

  refreshHud() {
    for (const entry of this.activeList()) {
      this._guard(entry.mod, () => entry.mod.hud && entry.mod.hud(entry.api));
    }
    /* drop chips of mods that were disabled */
    this._hud.chips = this._hud.chips.filter((c) => this.mods.has(c.id));
    this._hud.gauges = [];
    for (const entry of this.activeList()) {
      const g = this._guard(entry.mod, () => entry.mod.gauge && entry.mod.gauge(entry.api));
      if (g) this._hud.gauges.push({ id: entry.mod.id, ...g });
    }
  }
  hud() { return this._hud; }

  /** Extra building types offered in the villager build menu. */
  buildTypes(team = 1) {
    const out = [];
    for (const entry of this.activeList()) {
      const list = this._guard(entry.mod, () => entry.mod.buildMenu && entry.mod.buildMenu(entry.api, team)) || [];
      out.push(...list);
    }
    return out;
  }

  /** Does any active mod register this unit type? */
  ownsUnitType(type) {
    for (const entry of this.activeList()) if (entry.mod.units && entry.mod.units[type]) return true;
    return false;
  }

  /** Extra units a production building can train. */
  trainableAt(building, team = 1) {
    const out = [];
    for (const entry of this.activeList()) {
      const list = this._guard(entry.mod, () => entry.mod.trainableAt && entry.mod.trainableAt(entry.api, building, team)) || [];
      out.push(...list);
    }
    return out;
  }

  /**
   * May this building train this mod unit *right now*?
   *
   * Returns { ok, reason }. `reason` is player-facing and is shown on the
   * disabled command card, so a cap ("the Order will not take a fifth") is
   * never mistaken for "the game is broken".
   */
  trainVerdict(building, type) {
    if (!building) return { ok: false, reason: 'No building selected' };
    for (const entry of this.activeList()) {
      if (!entry.mod.canTrain) continue;
      const units = entry.mod.units || {};
      if (!units[type]) continue;
      const verdict = this._guard(entry.mod, () => entry.mod.canTrain(entry.api, building, type, entry.state));
      if (verdict === false) return { ok: false, reason: `${units[type].name || type} cannot be trained here` };
      if (verdict && typeof verdict === 'object') return verdict.ok ? { ok: true, reason: '' } : { ok: false, reason: verdict.reason || 'Not available' };
    }
    return { ok: true, reason: '' };
  }

  /** Append a unit/building's mod commands to the command card. */
  decorateCommands(list, ui) {
    if (!list) return list;
    for (const entry of this.activeList()) {
      const extra = this._guard(entry.mod, () => entry.mod.commands && entry.mod.commands({
        api: entry.api, game: this.game, host: this, ui,
        selection: this.game.selection.filter((e) => !e.dead),
        cast: (spell) => this.beginCast(spell)
      })) || [];
      for (const c of extra) if (c && c.icon && c.label) list.push(c);
    }
    return list;
  }

  /* ------------------------------------------------------------
     targeted abilities
     ------------------------------------------------------------ */
  beginCast(spell) {
    if (!spell || !spell.onCast) return false;
    this.modCast = {
      id: spell.id,
      label: spell.label || 'Cast',
      range: spell.range || 14,
      radius: spell.radius || 1.5,
      target: spell.target || 'ground',
      color: spell.color || [0.55, 0.8, 1],
      unit: spell.unit || null,
      onCast: spell.onCast,
      onCancel: spell.onCancel || null
    };
    /* the shared flag the input layer and the renderer read */
    this.game.modCast = this.modCast;
    this.game.castReticle = null;
    if (this.game.ui) {
      this.game.ui.toast(`${this.modCast.label} — tap the ${this.modCast.target === 'entity' ? 'target' : 'ground'}`, 'gold');
      this.game.ui.refreshCommands(true);
    }
    return true;
  }

  cancelCast() {
    if (this.modCast && this.modCast.onCancel) this._guardRaw(null, () => this.modCast.onCancel(), null);
    this.modCast = null;
    if (this.game) { this.game.modCast = null; this.game.castReticle = null; }
    if (this.game.ui) this.game.ui.refreshCommands(true);
  }

  /** Called from input when a cast is armed and the player taps. */
  castAt(x, z, hit) {
    const cast = this.modCast;
    if (!cast) return false;
    const ok = this._guardRaw(null, () => cast.onCast(x, z, hit || null), false);
    /* a spell that keeps running (a channelled field) returns 'keep' */
    if (ok !== 'keep') {
      this.modCast = null;
      this.game.modCast = null;
      this.game.castReticle = null;
    }
    if (this.game.ui) this.game.ui.refreshCommands(true);
    return true;
  }

  /* ------------------------------------------------------------
     status
     ------------------------------------------------------------ */
  status() {
    return this.activeList().map((e) => ({ id: e.mod.id, name: e.mod.name, icon: e.mod.icon }));
  }
}

/** Convenience for tests and for main.js. */
export function createModHost(game, opts) {
  return new ModHost(game, opts);
}

export { MODS, MOD_BY_ID };
