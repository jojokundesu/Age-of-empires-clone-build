/* ============================================================
   spellcheck.mjs — every spell in the book, one at a time
   ------------------------------------------------------------
   The node suite (tests/mods.mjs) proves the rules; this proves
   each spell *lands*. Every entry in the book is cast at a
   swordsman standing six metres away, with a fresh sim so a
   delayed spell (meteor, thunderstorm, golem) cannot be blamed
   on the one before it, and the damage is reported.

   Node-only and headless: `node tests/spellcheck.mjs`.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { createModHost } from '../src/mods/host.js';
import { writeSync } from 'node:fs';

const log = (...a) => writeSync(1, a.join(' ') + '\n');

function scene() {
  const g = new Game({ world: generateWorld(909), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  const host = createModHost(g, { enabled: ['arcane'] });
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  const mage = g.spawnUnit('mage', 1, tc.x + 10, tc.z + 4, null, { force: true });
  const victim = g.spawnUnit('swordsman', 2, tc.x + 14, tc.z + 4, null, { force: true });
  const entry = host.mods.get('arcane');
  mage.modState.arcane.rank = 6;
  mage.modState.arcane.mana = 1e6;
  mage.modState.arcane.cd = Object.create(null);
  mage.x = victim.x - 6; mage.z = victim.z;
  mage.y = g.heightAt(mage.x, mage.z);
  return { g, host, entry, api: entry.api, mage, victim };
}

const first = scene();
const ids = first.entry.mod.spells().map((s) => s.id);
first.host.dispose();
log(`spellbook: ${ids.join(', ')}`);

let bad = 0;
for (const id of ids) {
  const { g, host, entry, api, mage, victim } = scene();
  const spell = entry.mod.spells().find((s) => s.id === id);
  const before = victim.hp;
  const self = (spell.range || 14) <= 2;
  const ok = entry.mod.castSpell(api, mage, spell, self ? mage.x : victim.x, self ? mage.z : victim.z);
  for (let i = 0; i < 150; i++) g.update(1 / 30);      // five seconds: meteors and storms land
  const dealt = before - victim.hp;
  /* `ward` is a shield on the caster: it is supposed to deal nothing */
  const expected = id === 'ward' ? 0 : 1;
  const good = ok && (dealt > 0 || expected === 0);
  if (!good) bad++;
  log(`${id.padEnd(13)} ${ok ? 'cast' : 'FAILED'}  dealt ${dealt.toFixed(0).padStart(4)}  hp ${before.toFixed(0)} → ${victim.hp.toFixed(0)}${victim.dead ? ' (dead)' : ''}${good ? '' : '   << no effect'}`);
  host.dispose();
}

/* hybrids too, once they are discovered */
for (const h of (first.entry?.mod?.hybrids ? first.entry.mod.hybrids() : [])) {
  const { g, host, entry, api, mage, victim } = scene();
  api.state.discovered.add(h.id);
  const before = victim.hp;
  const ok = entry.mod.castSpell(api, mage, h, victim.x, victim.z);
  for (let i = 0; i < 150; i++) g.update(1 / 30);
  const dealt = before - victim.hp;
  const healer = h.id === 'phoenix';                    // mends allies, hurts nobody
  const good = ok && (dealt > 0 || healer);
  if (!good) bad++;
  log(`${h.id.padEnd(13)} ${ok ? 'cast' : 'FAILED'}  dealt ${dealt.toFixed(0).padStart(4)}${good ? '' : '   << no effect'}`);
  host.dispose();
}

log(bad ? `\n${bad} SPELL(S) DID NOTHING` : '\nEVERY SPELL IN THE BOOK LANDS');
process.exit(bad ? 1 : 0);
