/* spellcheck.mjs — every Arcane spell, cast at a real soldier, measured. Scratch. */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { createModHost } from '../src/mods/index.js';

const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'mods', difficulty: 'standard' });
g.start();
g.checkVictory = () => {};
g.running = true;
g.gameOver = false;
g.modHost = createModHost(g, { enabled: ['arcane'] });
const base = g.baseOf(1) || g.world.playerBase;
const arc = g.modHost.mods.get('arcane');
const { UNIT_DEFS } = await import('../src/sim/data.js');
console.log('units available', Object.keys(UNIT_DEFS).filter((k) => /mage|wizard|sorc/.test(k)).join(','), 'teams', [...g.teams.keys()]);
const mage = g.spawnUnit('mage', 1, base.x + 10, base.z + 10, null, { force: true });
mage.modState.arcane.rank = 6; mage.modState.arcane.mana = 999;
console.log('mage hp', mage.maxHp, 'mana', mage.modState.arcane.mana);

const target = g.spawnUnit('swordsman', 2, mage.x + 6, mage.z, null, { force: true });
console.log('swordsman hp', target.maxHp, 'armor', target.stats().armor, 'pierceArmor', target.stats().pierceArmor);
const hp0 = target.hp;
for (const spell of arc.mod.spells()) {
  /* fresh victim each time, at a fixed 5 m */
  const victim = g.spawnUnit('swordsman', 2, mage.x + 5, mage.z + 0.5, null, { force: true });
  victim.stance = 'stand';
  const h0 = victim.hp;
  mage.modState.arcane.mana = 999;
  mage.modState.arcane.cd = Object.create(null);
  const res = arc.mod.castSpell(arc.api, mage, spell, victim.x, victim.z);
  for (let i = 0; i < 120; i++) g.update(1 / 30);
  if (['ice_lance', 'meteor', 'thunderstorm', 'nova', 'ward', 'chain'].includes(spell.id))
    console.log('   debug', spell.id, 'mage', mage.x.toFixed(1), mage.z.toFixed(1), 'victim', victim.x.toFixed(1), victim.z.toFixed(1), 'dist', Math.hypot(victim.x - mage.x, victim.z - mage.z).toFixed(1), 'hasTeams', victim.team, 'can?', JSON.stringify(spell.can ? 'has can' : 'no can'));
  const dmg = h0 - victim.hp;
  console.log(`${spell.id.padEnd(13)} rank${spell.rank} cast=${String(res).padEnd(5)} damage ${dmg.toFixed(0).padStart(5)}  victim ${victim.dead ? 'DEAD' : victim.hp.toFixed(0) + '/' + victim.maxHp}  hp0 ${h0.toFixed(0)}`);
}
/* cooldowns and mana: how long until a fireball can be cast again */
const cd = mage.modState.arcane.cd;
console.log('cooldowns after the sweep', JSON.stringify(cd));
process.exit(0);
