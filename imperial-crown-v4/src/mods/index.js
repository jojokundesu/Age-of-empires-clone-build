/* ============================================================
   index.js — the only entry point main.js is allowed to touch
   ------------------------------------------------------------
   A mod session is loaded with a *dynamic* import (see main.js):
   a normal campaign never downloads, parses or runs any of this.
   ============================================================ */
export { ModHost, createModHost } from './host.js';
export { MODS, MOD_BY_ID, modCatalogue } from './registry.js';
