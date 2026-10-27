/* Workshop saves: encode entity references as indices, never stringify a
   Unit (which points back to the entire Game). This module is used only at
   save/load time, not in the frame loop. Unavailable/dead references become
   null, so a spent projectile or a dead summoner cannot resurrect on load. */
import { UNIT_DEFS } from '../sim/data.js';

function encoder(unitIndex, buildingIndex) {
  const stack = new Set();
  function encode(value, depth = 0) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'object' || depth > 20) return null;
    if (unitIndex.has(value)) return { $ref: 'unit', i: unitIndex.get(value) };
    if (buildingIndex.has(value)) return { $ref: 'building', i: buildingIndex.get(value) };
    if (value.game && value.kind) return null; // an entity that was not saved
    if (stack.has(value)) return null;
    stack.add(value);
    let out;
    if (value instanceof Set) out = { $set: [...value].map((v) => encode(v, depth + 1)) };
    else if (Array.isArray(value)) out = value.map((v) => encode(v, depth + 1));
    else {
      out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === '__proto__' || k === 'constructor' || typeof v === 'function') continue;
        out[k] = encode(v, depth + 1);
      }
    }
    stack.delete(value);
    return out;
  }
  return encode;
}

function decoder(units, buildings) {
  function decode(value, depth = 0) {
    if (value == null || typeof value !== 'object' || depth > 20) return value;
    if (value.$ref === 'unit') return units[value.i] || null;
    if (value.$ref === 'building') return buildings[value.i] || null;
    if (Array.isArray(value.$set)) return new Set(value.$set.map((v) => decode(v, depth + 1)));
    if (Array.isArray(value)) return value.map((v) => decode(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = decode(v, depth + 1);
    }
    return out;
  }
  return decode;
}

export function saveModState(host, units, buildings, unitIndex, buildingIndex) {
  if (!host) return null;
  const encode = encoder(unitIndex, buildingIndex);
  const states = {};
  for (const [id, entry] of host.mods) states[id] = encode(entry.state);
  return {
    states,
    units: units.map((u) => encode({
      modState: u.modState || null, owner: u.owner || null,
      wild: !!u.wild, beast: !!u.beast, tamedBeast: !!u.tamedBeast,
      // Beasts can acquire a per-instance definition as they level up.
      override: u.def !== UNIT_DEFS[u.type] ? { attack: u.def.attack, armor: u.def.armor, pierceArmor: u.def.pierceArmor } : null
    })),
    buildings: buildings.map((b) => encode({ modState: b.modState || null, relic: b.relic || null }))
  };
}

export function restoreModState(host, data, units, buildings) {
  if (!host || !data) return;
  const decode = decoder(units, buildings);
  for (const [id, entry] of host.mods) {
    if (!data.states || !data.states[id]) continue;
    const saved = decode(data.states[id]);
    if (!saved || typeof saved !== 'object') continue;
    for (const key of Object.keys(entry.state)) delete entry.state[key];
    Object.assign(entry.state, saved);
    entry.api.state = entry.state;
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i], saved = data.units?.[i] && decode(data.units[i]);
    if (!u || !saved) continue;
    if (saved.modState) u.modState = saved.modState;
    if (saved.owner) u.owner = saved.owner;
    u.wild = !!saved.wild; u.beast = !!saved.beast; u.tamedBeast = !!saved.tamedBeast;
    if (saved.override) { u.def = { ...u.def, ...saved.override }; u._stats = null; }
  }
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i], saved = data.buildings?.[i] && decode(data.buildings[i]);
    if (!b || !saved) continue;
    if (saved.modState) b.modState = saved.modState;
    if (saved.relic) b.relic = saved.relic;
  }
  host.refreshAtmosphere();
  host.refreshHud();
}
