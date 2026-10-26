/* ============================================================
   registry.js — the mod catalogue
   ------------------------------------------------------------
   Adding a mod means adding a file that exports one object and
   listing it here. The menu reads this table, so a new mod appears
   in the Mod Workshop with no UI work at all.
   ============================================================ */
import { plague } from './zombies.js';
import { arcane } from './arcane.js';
import { beasts } from './beasts.js';
import { weather } from './weather.js';
import { artificer } from './artificer.js';
import { relics } from './relics.js';

export const MODS = [plague, arcane, beasts, weather, artificer, relics];

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

export const DEFAULT_ENABLED = ['zombies'];
