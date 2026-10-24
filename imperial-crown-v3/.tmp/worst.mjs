import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
g.start();
const ai = new AIController(g, 2, { aggression: 0.85 });
const dt = 1/30;
const rows = [];
for (let i = 0; i < 30*600; i++) {
  const a = process.hrtime.bigint();
  ai.update(dt);
  const am = Number(process.hrtime.bigint()-a)/1e6;
  const b = process.hrtime.bigint();
  g.update(dt);
  const gm = Number(process.hrtime.bigint()-b)/1e6;
  rows.push({ i, t: +g.time.toFixed(1), ai: +am.toFixed(2), game: +gm.toFixed(2), units: g.units.length });
  if (g.gameOver) break;
}
rows.sort((a,b)=>(b.ai+b.game)-(a.ai+a.game));
console.log(rows.slice(0,10).map(r=>JSON.stringify(r)).join('\n'));
const tail = rows.filter(r => r.i > 300).sort((a,b)=>(b.ai+b.game)-(a.ai+a.game));
console.log('excl warmup worst:', JSON.stringify(tail[0]));
