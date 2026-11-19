/* ============================================================
   registry.js — the mod catalogue
   ------------------------------------------------------------
   Adding a mod means adding a file that exports one object and
   listing it here. The menu reads this table, so a new mod appears
   in the Mod Workshop with no UI work at all.

   The Arcane Order is the one mod the game ships. It is not a
   separate play mode: when it is switched on it is available in
   every other mode too, for the player and for the enemy crown.
   ============================================================ */
import { arcane } from './arcane.js';

export const MODS = [arcane];

export const MOD_BY_ID = Object.create(null);
for (const mod of MODS) MOD_BY_ID[mod.id] = mod;

/** Everything the menu needs, without touching the definition objects. */
export function modCatalogue() {
  return MODS.map((m) => ({
    id: m.id,
    name: m.name,
    icon: m.icon,
    tagline: m.tagline || '',
    blurb: m.blurb || '',
    detail: m.detail || [],
    units: Object.values(m.units || {}).map((u) => u.name),
    buildings: Object.values(m.buildings || {}).map((b) => b.name)
  }));
}

/* Off by default: a plain match is a plain match. */
export const DEFAULT_ENABLED = [];
