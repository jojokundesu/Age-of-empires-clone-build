/* The starting valley — known ground versus the circle of torchlight.

   A fresh match used to reveal a ~22 m disc under the town centre, which read
   as a spotlight parked on a dark field instead of a settlement whose people
   have farmed this valley for years. surveyHome() draws a much larger, ragged,
   deterministic boundary. These checks pin that behaviour down: big enough to
   feel lived in, small enough that exploring is still the opening move, and
   never overlapping the enemy base.                                         */
import { generateWorld, WORLD } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const world = generateWorld(20261);
const CELL = WORLD.fowCell;
const N = WORLD.fowCells;
const HALF = WORLD.half;

const fresh = () => {
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  return g;
};

/* Reveal radius along an angle, in metres, measured on the home fog grid.
   Walking stops at the first hole: a lone cell lit by a scout further out is
   not the edge of the valley the survey drew. */
function radiusAt(g, base, ang) {
  let last = 0;
  for (let d = 2; d < 90; d += 0.5) {
    const x = base.x + Math.cos(ang) * d;
    const z = base.z + Math.sin(ang) * d;
    const cx = Math.min(N - 1, Math.max(0, Math.floor((x + HALF) / CELL)));
    const cz = Math.min(N - 1, Math.max(0, Math.floor((z + HALF) / CELL)));
    if (g.fow[cz * N + cx]) last = d;
    else if (d > 6) break;
  }
  return last;
}

check('the home valley starts well explored, not as a torchlight disc', () => {
  const g = fresh();
  const base = world.playerBase;
  let known = 0;
  const within = (r) => {
    let n = 0;
    for (let cz = 0; cz < N; cz++) {
      for (let cx = 0; cx < N; cx++) {
        if (!g.fow[cz * N + cx]) continue;
        const wx = (cx + 0.5) * CELL - HALF;
        const wz = (cz + 0.5) * CELL - HALF;
        if (Math.hypot(wx - base.x, wz - base.z) <= r) n++;
      }
    }
    return n;
  };
  for (const v of g.fow) if (v) known++;
  const area = known * CELL * CELL;
  // a 44 m disc is ~6000 m^2; the whole 512 m island is 262 000 m^2, so this
  // is a village-sized clearing rather than the entire map
  assert(area > 11000 && area < 24000, `known ground is ${Math.round(area)} m^2`);
  assert(within(30) / within(70) > 0.14, 'the reveal is a thin ring, not a solid valley');
  assert(within(60) > 0, 'nothing is known inside 60 m of the base');
});

check('the edge of the known world is ragged, not a perfect circle', () => {
  const g = fresh();
  const base = world.playerBase;
  const rs = [];
  for (let i = 0; i < 72; i++) rs.push(radiusAt(g, base, (i / 72) * Math.PI * 2));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
  assert(mean > 58 && mean < 78, `mean reveal radius is ${mean.toFixed(1)} m`);
  assert(sd > 4, `reveal radius varies by only ${sd.toFixed(1)} m — that is a circle`);
  assert(Math.min(...rs) > 48, `some directions reveal only ${Math.min(...rs).toFixed(1)} m`);
  assert(Math.max(...rs) < 88, `some directions reveal ${Math.max(...rs).toFixed(1)} m`);
});

check('the enemy base stays hidden until somebody walks there', () => {
  const g = fresh();
  const e = world.enemyBase;
  const cx = Math.floor((e.x + HALF) / CELL);
  const cz = Math.floor((e.z + HALF) / CELL);
  assert(g.fow[cz * N + cx] === 0, 'the enemy town centre is visible from turn zero');
  const near = [];
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) near.push(g.fow[(cz + dz) * N + (cx + dx)]);
  }
  assert(near.every((v) => v === 0), 'a patch of the enemy base is already explored');
});

check('the survey is deterministic and does not wipe explored ground', () => {
  const a = fresh();
  const b = fresh();
  assert(a.fow.length === b.fow.length, 'fog grids differ in size');
  let diff = 0;
  for (let i = 0; i < a.fow.length; i++) if (a.fow[i] !== b.fow[i]) diff++;
  assert(diff === 0, `${diff} fog cells differ between two identical matches`);
  // a second call must not erase what the player has already uncovered
  a.fow[5] = 2;
  a.surveyHome(world.playerBase);
  assert(a.fow[5] === 2, 'surveyHome() overwrote an actively visible cell');
});

check('the survey cost stays off the opening frame budget', () => {
  const g = fresh();
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) g.surveyHome(world.playerBase);
  const ms = (performance.now() - t0) / 10;
  assert(ms < 8, `surveyHome() takes ${ms.toFixed(2)} ms`);
});

if (fails.length) {
  console.error('\nSURVEY CHECKS FAILED\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\nSURVEY CHECKS PASSED (${pass})`);
