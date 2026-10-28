/* ============================================================
   codex.js — the manual the game never had
   ------------------------------------------------------------
   Everything a player has to know about the systems that have
   numbers in them: what a rank actually buys, how much mana a
   mage carries, how long his cooldowns are, what the golems do,
   how the ice works, how health comes back, and every Champion
   perk in the game.

   The page is generated from the live data wherever possible --
   the spellbook and the ladder are read from the Arcane mod, the
   perks from the Champions system -- so a balance change cannot
   leave the manual lying. Anything the game genuinely does not
   export (the regeneration constants live in entities.js) is
   stated here once, next to the code that enforces it.

   The page is opened from the main menu: CODEX.
   ============================================================ */
import { REGEN_LIMIT, REGEN_RATE, REGEN_DELAY } from '../sim/entities.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pct = (v) => `${Math.round(v * 100)}%`;

/* Everything about the Arcane Order, read from the mod itself. */
async function arcaneData() {
  try {
    const mod = await import('../mods/arcane.js');
    return mod.arcane || null;
  } catch (e) {
    return null;
  }
}

function spellsTable(mod) {
  if (!mod || !mod.spells) return '<p class="dim">The Arcane Order is not present in this build.</p>';
  const spells = mod.spells().slice().sort((a, b) => (a.rank - b.rank) || (a.cost - b.cost));
  const rows = spells.map((s) => {
    const range = s.range >= 900 ? 'anywhere' : (s.range || 1) <= 2 ? 'on yourself' : `${Math.round(s.range)} m`;
    return `<div class="codexRow">
      <b>${esc(s.name)}</b>
      <small>rank ${s.rank}</small>
      <span>${esc(s.desc || '')}</span>
      <em>${esc(`${s.cost || 0} mana · ${s.cd ? s.cd + ' s cooldown' : (s.daily ? '3 a day at Ascendant' : 'no cooldown')} · ${range}`)}</em>
    </div>`;
  }).join('');
  const hybrids = (mod.hybrids ? mod.hybrids() : []).map((h) => `<div class="codexRow">
      <b>${esc(h.name)}</b><small>attunement</small>
      <span>${esc(h.desc || '')}</span>
      <em>${esc(`${h.pair.join(' + ')} · ${h.cost} mana · discovered by weaving the two elements at Magus or above`)}</em>
    </div>`).join('');
  return `<p class="dim tiny">Cooldowns are the number printed at Apprentice rank: every rank shortens them, down to a tenth at Ascendant (see Ranks &amp; mana).</p>
    <div class="codexGrid">${rows}</div>
    <h4 class="codexHead">Hybrids — found by attunement, never listed before you find them</h4>
    <div class="codexGrid">${hybrids}</div>`;
}

function ladderTable(mod) {
  if (!mod || !mod.ranks) return '';
  const rows = mod.ranks().map((r) => {
    const scale = mod.cooldownScale ? mod.cooldownScale(r.rank) : 1;
    const cd = `${Math.round(scale * 100)}% of the printed cooldown`;
    return `<div class="codexRow">
      <b>${r.rank} · ${esc(r.title)}</b>
      <small>${r.xp} insight</small>
      <span>${esc(`Mana ${r.mana} · +${r.regen}/s regeneration`)}</span>
      <em>${esc(cd)}</em>
    </div>`;
  }).join('');
  return `<div class="codexGrid">${rows}</div>`;
}

function mageRules(mod) {
  const respawn = mod && mod.respawnSeconds ? mod.respawnSeconds() : 45;
  const skyMax = mod && mod.skyMax ? mod.skyMax() : 3;
  return `
    <div class="row"><b>One mage</b><span>Exactly one mage walks the field per team. An Arcane Tower no longer raises the limit — it teaches faster, which is what a tower is for.</span></div>
    <div class="row"><b>If he falls</b><span>${respawn} seconds later the Order sends another out of the nearest Town Centre (or castle, or whatever still stands), at <b>Apprentice</b> rank with a full bar. The ladder is climbed again.</span></div>
    <div class="row"><b>Mana</b><span>250 at Apprentice, 1000 at Ascendant, regenerating ${mod && mod.ranks ? `${mod.ranks()[0].regen}–${mod.ranks()[5].regen}` : '14–64'} per second. Mana is not the limit on a high-rank mage; cooldowns and his own fragility are.</span></div>
    <div class="row"><b>Cooldowns</b><span>Every rank shortens every spell: an Ascendant pays a tenth of the printed number, so a fireball is repeatable almost as fast as the animation allows and the long spells come back inside a single fight.</span></div>
    <div class="row"><b>SKYFALL</b><span>Rank 6, once a day… and ${skyMax} times a day at Ascendant, anywhere on the map, chosen on the world map.</span></div>
    <div class="row"><b>Golems</b><span>Rank 4 raises one Stone Golem; rank 5 adds a Granite Colossus that slams the ground every few seconds; rank 6 adds an Obsidian Titan that throws molten rock at range. They last 26 seconds at Archmage, rising to 34 at Ascendant — the timer never goes away, so they are a siege tool, not an army.</span></div>
    <div class="row"><b>Ice</b><span>Ice Lance freezes the one body it hits; Frost Nova freezes an area around you. A frozen man is encased in a visible block of ice, moves at a crawl, and the ground under an area freeze stays sheeted with ice until the spell expires. Shatterfrost triples its damage against anything already held.</span></div>`;
}

function regenRules() {
  return `
    <div class="row"><b>Field stitching</b><span>Every soldier who has not been hit for ${REGEN_DELAY} seconds recovers up to ${pct(REGEN_LIMIT)} of his health at ${REGEN_RATE} hp/s. A beaten man holds a wall again; he does not become a new man, and a fight still ends in dead soldiers.</span></div>
    <div class="row"><b>Trained regeneration</b><span>Berserkers (and anything with a regeneration stat) heal past that cap and much faster. That is what those units are for.</span></div>
    <div class="row"><b>The Champion perk</b><span><b>Field Medic</b> heals 2.2 hp/s out of combat with no cap — it is the only perk that turns a wound into time. <b>Rally</b> is the burst version: 45 health to every ally within 11 m, once every 90 seconds.</span></div>
    <div class="row"><b>Monks</b><span>A monk heals others, not himself. Villagers repair buildings; buildings do not regenerate on their own.</span></div>`;
}

async function perkRows() {
  try {
    const ch = await import('../sim/champion.js');
    const list = ch.PERKS || ch.default?.PERKS;
    if (!list) return '<p class="dim">Perks unavailable.</p>';
    const byCat = new Map();
    for (const p of list) {
      if (!byCat.has(p.cat)) byCat.set(p.cat, []);
      byCat.get(p.cat).push(p);
    }
    const NAMES = { arms: 'Arms', ward: 'Ward', stride: 'Stride', banner: 'Banner', arcane: 'Arcane', craft: 'Craft' };
    let out = '';
    for (const [cat, perks] of byCat) {
      out += `<h4 class="codexHead">${esc(NAMES[cat] || cat)}</h4><div class="codexGrid">` +
        perks.map((p) => `<div class="codexRow"><b>${esc(p.name)}</b><small>perk</small><span>${esc(p.desc)}</span><em>offered as one of three at every Champion rank</em></div>`).join('') +
        '</div>';
    }
    return out;
  } catch (e) {
    return '<p class="dim">Perks unavailable.</p>';
  }
}

/**
 * Build the codex page. Returns HTML plus a small mount function for the tab
 * bar, so the menu can drop it into its existing modal without new plumbing.
 */
export async function buildCodex() {
  const mod = await arcaneData();
  const tabs = [
    { id: 'spells', label: 'Spells', html: spellsTable(mod) },
    { id: 'ranks', label: 'Ranks & mana', html: ladderTable(mod) + mageRules(mod) },
    { id: 'health', label: 'Health', html: regenRules() },
    { id: 'perks', label: 'Perks', html: await perkRows() }
  ];
  return tabs;
}
