/* defcheck.mjs — will my idle soldiers defend their own town? Scratch. */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';

const world = generateWorld(20261);
const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
g.checkVictory = () => {};
g.running = true;
g.gameOver = false;
const base = g.baseOf(1) || g.world.playerBase;
const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
console.log('TC at', tc.x.toFixed(0), tc.z.toFixed(0), 'hp', tc.hp);

/* six idle defenders standing around the hall, as any player would leave them */
const defenders = [];
for (let i = 0; i < 6; i++) {
  const u = g.spawnUnit('spearman', 1, tc.x + 6 + (i % 3) * 2, tc.z + 6 + Math.floor(i / 3) * 2, null, { force: true });
  if (u) { u.state = 'idle'; defenders.push(u); }
}
console.log('defenders', defenders.length, 'stance', defenders[0]?.stance);

/* a raiding party arrives at the edge of the town */
const foes = [];
for (let i = 0; i < 6; i++) {
  const u = g.spawnUnit('swordsman', 2, tc.x + 18 + (i % 3) * 1.5, tc.z + 14, null, { force: true });
  if (u) { u.stance = 'aggressive'; foes.push(u); }
}
console.log('raiders', foes.length);
for (const u of foes) { u.state = 'attack'; u.target = tc; }

for (let s = 1; s <= 40; s++) {
  for (let i = 0; i < 30; i++) g.update(1 / 30);
  if (s % 4 === 0) {
    const dmg = defenders.filter((u) => u.hp < u.maxHp).length;
    const engaged = defenders.filter((u) => u.state === 'attack' || u.target).length;
    console.log(`t+${s}s  defenders alive ${defenders.filter((u) => !u.dead).length} engaged ${engaged} hurt ${dmg}  |  raiders alive ${foes.filter((u) => !u.dead).length}  |  TC hp ${tc.hp.toFixed(0)}  houses ${g.buildings.filter((b) => b.team === 1 && !b.dead).length}`);
  }
}
for (const u of defenders) console.log(' defender', u.id, u.dead ? 'DEAD' : u.state, 'stance', u.stance, 'target', u.target ? u.target.type : 'none', 'hp', u.hp.toFixed(0));
process.exit(0);
