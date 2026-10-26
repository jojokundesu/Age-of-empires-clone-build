import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const ai = new AIController(g, 2, { aggression: 0.85 });
const slow = [];
const dt = 1/30;
for (let i = 0; i < 30*600; i++) {
  let a = process.hrtime.bigint();
  ai.update(dt);
  const aiMs = Number(process.hrtime.bigint()-a)/1e6;
  a = process.hrtime.bigint();
  g.update(dt);
  const gMs = Number(process.hrtime.bigint()-a)/1e6;
  if (aiMs + gMs > 5) slow.push({ t: +g.time.toFixed(1), ai: +aiMs.toFixed(2), game: +gMs.toFixed(2), units: g.units.length, frame: g.frame });
  if (g.gameOver) break;
}
console.log('slow ticks', slow.length);
for (const s of slow.slice(0, 15)) console.log(s);
