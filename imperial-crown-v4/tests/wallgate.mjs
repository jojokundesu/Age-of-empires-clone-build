/* Walls and gates: the two buildings that only work if the *simulation* agrees
   with them.

   A wall is not a decoration. It has to stamp the navigation grid, block the
   short straight-line shortcut that most movement takes, and cost what it says
   it costs. A gate is harder still: it has to be an obstacle to the enemy, a
   doorway to its owner, and its timber leaf has to move so the player can see
   which of the two it currently is.

   These tests are deliberately geometric -- they build a real wall across a
   real piece of generated terrain and then walk real units at it -- because
   every one of these behaviours is something a player discovers in the first
   five minutes of walling a town.

   node tests/wallgate.mjs
*/
import { generateWorld, WORLD } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { BUILDING_DEFS } from '../src/sim/data.js';

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const NULL_SOUND = { play() {} };
const STEP = 1 / 30;

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

function newGame(seed = 20261) {
  const game = new Game({ world: generateWorld(seed), civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed });
  game.start();
  for (const t of [1, 2]) {
    const st = game.teams.get(t);
    st.res.food = 3000; st.res.wood = 3000; st.res.gold = 2000; st.res.stone = 3000;
    st.age = 3;
  }
  game.ai = [];
  return game;
}

/** A flat, empty stretch of ground wide enough for a wall across it. */
function findFlatRun(game, span = 8) {
  const ok = (x, z) => {
    const spot = game.canPlaceAt('stone_wall', 1, x, z);
    if (!spot.ok) return false;
    const h = game.heightAt(x, z);
    return h > 0.6 && game.heightAt(x + 2, z) > 0.6 && Math.abs(game.heightAt(x + 2, z) - h) < 1.2;
  };
  for (let r = 24; r < WORLD.half - 30; r += 6) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(Math.cos(a / 64 * Math.PI * 2) * r / 2) * 2;
      const z = Math.round(Math.sin(a / 64 * Math.PI * 2) * r / 2) * 2;
      let all = true;
      for (let i = -span / 2; i <= span / 2; i += 2) if (!ok(x + i, z)) { all = false; break; }
      if (!all) continue;
      let clear = true;
      for (let dz = -6; dz <= 6; dz += 2) if (!game.isPassable(x, z + dz)) { clear = false; break; }
      if (!clear) continue;
      return { x, z };
    }
  }
  return null;
}

/**
 * A flat, empty square, big enough to wall off a yard.
 * The rectangle's ring is on the wall lattice, so the pieces really do tile.
 */
function findFlatArea(game, half = 6) {
  const ok = (x, z) => game.canPlaceAt('stone_wall', 1, x, z).ok && game.heightAt(x, z) > 0.6;
  for (let r = 22; r < WORLD.half - 30; r += 5) {
    for (let a = 0; a < 64; a++) {
      const cx = Math.round(Math.cos(a / 64 * Math.PI * 2) * r / 2) * 2;
      const cz = Math.round(Math.sin(a / 64 * Math.PI * 2) * r / 2) * 2;
      let all = true;
      for (let i = -half; i <= half && all; i += 2) {
        for (let j = -half; j <= half; j += 2) if (!ok(cx + i, cz + j)) { all = false; break; }
      }
      if (all) return { x: cx, z: cz };
    }
  }
  return null;
}

const g = newGame();
const spot = findFlatRun(g);
assert(spot, 'no flat ground on this map to build a test wall on');
const WALL_TYPE = 'stone_wall';

/* ---------------------------------------------------------- wall geometry */
check('a wall run snaps to the segment lattice and tiles', () => {
  const cells = g.planWallLine(WALL_TYPE, spot.x - 7.3, spot.z, spot.x + 8.6, spot.z);
  assert(cells.length >= 8, `expected a run, got ${cells.length} cells`);
  const size = BUILDING_DEFS[WALL_TYPE].size;
  /* segments sit on the centres of the nav cells (odd offsets), so each one
     owns exactly one cell instead of straddling four */
  const off = size * 0.5;
  for (const c of cells) {
    const q = (c.x - off) / size;
    assert(Math.abs(q - Math.round(q)) < 1e-9, `cell ${c.x} is off the lattice`);
  }
  for (let i = 1; i < cells.length; i++) {
    assert(Math.abs(cells[i].x - cells[i - 1].x) === size || Math.abs(cells[i].z - cells[i - 1].z) === size,
      'segments are not contiguous');
  }
  return `${cells.length} segments, ${cells[0].x} → ${cells[cells.length - 1].x}`;
});

check('a drag with a corner turns once, on the dominant axis first', () => {
  const cells = g.planWallLine(WALL_TYPE, spot.x, spot.z, spot.x + 8, spot.z + 4);
  const xs = new Set(cells.map((c) => c.x)), zs = new Set(cells.map((c) => c.z));
  assert(xs.size === 5 && zs.size === 3, `expected an L (5 × 3 lattice), got ${xs.size} × ${zs.size}`);
  const firstTurn = cells.findIndex((c, i) => i > 0 && c.z !== cells[i - 1].z);
  assert(firstTurn === 5, `the corner should come after the whole long leg (index 5), not at ${firstTurn}`);
  return `${cells.length} segments with one corner`;
});

check('the run stops where the ground refuses, and says why', () => {
  /* walk a line until it hits water or a slope -- on a river island, a long
     enough line always does */
  let hit = null;
  for (let a = 0; a < 16 && !hit; a++) {
    const ang = a / 16 * Math.PI * 2;
    const cells = g.planWallLine(WALL_TYPE, spot.x, spot.z, spot.x + Math.cos(ang) * 90, spot.z + Math.sin(ang) * 90, 1, 64);
    const bad = cells.findIndex((c) => !c.ok);
    if (bad > 0) hit = { cells, bad };
  }
  assert(hit, 'no line ever hit terrain it could not build on');
  const c = hit.cells[hit.bad];
  assert(c.reason && c.reason.length, 'the blocked cell gave no reason');
  /* nothing past the obstruction is claimed to be buildable */
  for (let i = hit.bad + 1; i < hit.cells.length; i++) assert(!hit.cells[i].ok, 'cells past the break were marked buildable');
  return `stopped after ${hit.bad} segments (${c.reason})`;
});

check('a run costs exactly its segments and never overdraws', () => {
  const game = newGame();
  const s = findFlatRun(game);
  assert(s, 'no flat ground');
  const st = game.teams.get(1);
  const each = game.buildingCost(WALL_TYPE, 1);
  const perRun = each.stone || 0;
  st.res.stone = perRun * 4 + 1;                 // enough for four segments, and a spare
  const cells = game.planWallLine(WALL_TYPE, s.x - 5, s.z, s.x + 12, s.z);
  const { placed, stopped } = game.placeWallLine(WALL_TYPE, 1, cells, { instant: true });
  assert(placed.length === 4, `placed ${placed.length} for stone ${perRun * 4 + 1}`);
  assert(stopped === 'resources', `should have run out of stone, stopped with "${stopped}"`);
  assert(st.res.stone >= 0, `stone went negative: ${st.res.stone}`);
  assert(st.res.stone <= 1, `stone left over: ${st.res.stone}`);
  return `4 segments for ${perRun * 4} stone, then "resources"`;
});

/* --------------------------------------------------------------- the wall */
const wallLine = g.planWallLine(WALL_TYPE, spot.x - 6, spot.z, spot.x + 6, spot.z).filter((c) => c.ok);
const gateCell = wallLine[Math.floor(wallLine.length / 2)];
const wallCells = wallLine.filter((c) => c !== gateCell);
const built = g.placeWallLine(WALL_TYPE, 1, wallCells, { instant: true, free: true });
const gate = g.placeBuilding('stone_gate', 1, gateCell.x, gateCell.z, { instant: true, free: true });

check('the wall and its gate went up', () => {
  assert(built.placed.length === wallCells.length, `only ${built.placed.length}/${wallCells.length} segments placed`);
  assert(gate && !gate.dead, 'the gate was refused');
  return `${built.placed.length} segments + 1 gate`;
});

check('walls stamp the navigation grid', () => {
  const N = g.world.nav.cells, cell = g.world.nav.cell, half = WORLD.half;
  const idx = (x, z) => Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell);
  const seg = built.placed[0];
  assert(g.navBuild[idx(seg.x, seg.z)] > 0, 'the segment is not in the building nav layer');
  assert(g.navFinal[idx(seg.x, seg.z)] === 1, 'the combined grid does not block the segment');
  return `segment at ${seg.x.toFixed(0)},${seg.z.toFixed(0)} blocks`;
});

check('a gate is a doorway for its owner and a wall for the enemy', () => {
  const N = g.world.nav.cells, cell = g.world.nav.cell, half = WORLD.half;
  const idx = (x, z) => Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell);
  const i = idx(gate.x, gate.z);
  assert(g.navGate[i] > 0, 'the gate is not in the gate layer');
  assert(g.navFinal[i] === 0, 'the gate blocks its owner');
  assert(g.navFinalEnemy[i] === 1, 'the gate does not block the enemy');
  const ally = { team: 1, def: {}, radius: 0.4 };
  const foe = { team: 2, def: {}, radius: 0.4 };
  assert(g.pfFor(ally) !== g.pfFor(foe), 'both teams search the same grid');
  g.update(STEP);                          // flush the building spatial hash
  assert(g.isPassable(gate.x, gate.z, ally) === true, 'an ally cannot stand in its own gateway');
  assert(g.isPassable(gate.x, gate.z, foe) === false, 'an enemy can walk through a shut gate');
  return 'ally opens, enemy blocked';
});

/* ------------------------------------------------------------- walking it */
const southOf = (dz) => [gate.x, gate.z + dz];

check('a friendly soldier walks through the gate', () => {
  const u = g.spawnUnitRaw('swordsman', 1, gate.x, gate.z + 4);
  assert(u, 'could not spawn the soldier');
  u.stance = 'stand';
  g.orderMove([u], gate.x, gate.z - 4);
  let crossed = false, leaf = 0;
  for (let i = 0; i < 900; i++) {
    g.update(STEP);
    leaf = Math.max(leaf, gate.gateOpen);
    if (u.z < gate.z - 1.5) { crossed = true; break; }
  }
  assert(crossed, `stopped at z=${(u.z - gate.z).toFixed(1)} relative to the gate (state ${u.state})`);
  assert(leaf > 0.5, `the leaf never rose (peak ${leaf.toFixed(2)})`);
  return `through, leaf reached ${leaf.toFixed(2)}`;
});

check('the leaf settles again once the troops have passed', () => {
  for (let i = 0; i < 600; i++) g.update(STEP);
  assert(gate.gateOpen < 0.05, `the leaf is still ${gate.gateOpen.toFixed(2)} open with nobody near`);
  return 'shut again';
});

check('an enemy cannot use the gate, out of a sealed yard with one door', () => {
  /* a rectangular yard on the wall lattice with a single gate in its north
     wall: the only way out is through the gate, so this isolates "can an enemy
     use a gate" from "can an enemy walk around the wall" */
  const game = newGame(4242);
  const s2 = findFlatArea(game, 6);
  assert(s2, 'no flat ground for the yard');
  const H = 6;
  const ring = [];
  for (let i = -H; i <= H; i += 2) { ring.push({ x: s2.x + i, z: s2.z - H }); ring.push({ x: s2.x + i, z: s2.z + H }); }
  for (let j = -H + 2; j <= H - 2; j += 2) { ring.push({ x: s2.x - H, z: s2.z + j }); ring.push({ x: s2.x + H, z: s2.z + j }); }
  const doorCell = { x: s2.x, z: s2.z - H };
  for (const c of ring) {
    if (c.x === doorCell.x && c.z === doorCell.z) continue;
    const b = game.placeBuilding('stone_wall', 1, c.x, c.z, { instant: true, free: true });
    assert(b, `a wall would not go up at ${c.x},${c.z}`);
  }
  const door = game.placeBuilding('stone_gate', 1, doorCell.x, doorCell.z, { instant: true, free: true });
  assert(door, 'the yard has no door');
  game.refreshNav();
  game.update(STEP);                       // flush the building spatial hash
  const ally = game.spawnUnitRaw('swordsman', 1, s2.x - 2, s2.z);
  const foe = game.spawnUnitRaw('swordsman', 2, s2.x + 2, s2.z);
  assert(ally && foe, 'could not spawn the yard pair');
  ally.stance = 'stand'; foe.stance = 'stand'; foe.noAggro = true;
  game.orderMove([ally], doorCell.x, doorCell.z - 8);
  game.orderMove([foe], doorCell.x, doorCell.z - 8);
  let allyOut = false, leaf = 0;
  for (let i = 0; i < 1500; i++) {
    game.update(STEP);
    leaf = Math.max(leaf, door.gateOpen);
    if (ally.z < doorCell.z - 3) { allyOut = true; break; }
  }
  assert(allyOut, `the owner's soldier could not get out of its own gate (z=${ally.z.toFixed(1)}, gate z=${doorCell.z}, state ${ally.state})`);
  for (let i = 0; i < 900; i++) game.update(STEP);
  assert(foe.z > doorCell.z - 2, `the enemy got out through the gate (z=${foe.z.toFixed(1)})`);
  assert(leaf > 0.5, `the leaf never rose for its owner (peak ${leaf.toFixed(2)})`);
  return `ally out through the leaf (${leaf.toFixed(2)}), enemy held inside`;
});

check('a short move cannot cut through a wall', () => {
  const seg = built.placed[0];
  assert(!g.walkableLine(seg.x, seg.z - 5, seg.x, seg.z + 5, { def: {}, radius: 0.4, team: 1 }),
    'walkableLine says a straight line through a stone wall is clear');
  return 'the shortcut test respects the wall';
});

check('an enemy left inside a walled pocket gives up instead of grinding', () => {
  const game = newGame(777);
  const s = findFlatRun(game, 8);
  assert(s, 'no flat ground');
  /* a closed ring of walls around a lone enemy */
  const ring = [];
  const R = 5;
  for (let a = 0; a < 20; a++) {
    const ang = a / 20 * Math.PI * 2;
    const x = Math.round((s.x + Math.cos(ang) * R) / 2) * 2;
    const z = Math.round((s.z + Math.sin(ang) * R) / 2) * 2;
    if (!ring.some((c) => c.x === x && c.z === z)) ring.push({ x, z });
  }
  for (const c of ring) game.placeBuilding('stone_wall', 2, c.x, c.z, { instant: true, free: true });
  game.refreshNav();
  const u = game.spawnUnitRaw('swordsman', 1, s.x, s.z);
  assert(u, 'could not spawn the soldier');
  u.stance = 'stand';
  game.orderMove([u], s.x + 40, s.z);
  for (let i = 0; i < 240; i++) game.update(STEP);
  assert(u.unreachable || u.state === 'idle', `still trying: state ${u.state}, ${u.path ? u.path.length + ' node path' : 'no path'}`);
  const before = u.x;
  for (let i = 0; i < 120; i++) game.update(STEP);
  assert(Math.abs(u.x - before) < 1.5, 'it is still vibrating against the wall');
  return 'the order is dropped, the unit stands';
});

console.log('');
if (fails.length) {
  console.log(`WALL/GATE FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`WALL/GATE CHECKS PASSED (${pass})`);
