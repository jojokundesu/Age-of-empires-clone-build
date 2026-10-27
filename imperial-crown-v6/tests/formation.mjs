/* Formations: the geometry, and whether an army actually gets there in shape.

   A formation is only real if the soldiers *end up* standing in it. The pure
   function can be perfect and the order still fall apart, because the movement
   layer sorts units into slots, pushes them apart, and the slots have to be
   wide enough for the bodies that fill them. So this file checks both: the
   shapes themselves, and what eight soldiers look like twelve seconds after
   being ordered to march in each of them.

   node tests/formation.mjs
*/
import { generateWorld, WORLD } from '../src/sim/worldgen.js';
import { Game, formationSlots, FORMATIONS } from '../src/sim/game.js';

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const STEP = 1 / 30;
let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

/* ------------------------------------------------------------- the shapes */
check('every style places exactly one soldier per slot, with no duplicates', () => {
  for (const style of FORMATIONS) {
    for (let n = 1; n <= 40; n++) {
      const slots = formationSlots(n, 3, -7, { style, facing: 0.7, spacing: 1.5 });
      assert(slots.length === n, `${style} at ${n}: ${slots.length} slots`);
      const seen = new Set(slots.map(([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`));
      assert(seen.size === n, `${style} at ${n} has overlapping slots`);
      for (const [x, z] of slots) assert(Number.isFinite(x) && Number.isFinite(z), `${style} at ${n} produced a non-finite slot`);
    }
  }
  return '1..40 soldiers in all four styles';
});

check('slots are spaced for the bodies that fill them', () => {
  for (const style of FORMATIONS) {
    const slots = formationSlots(24, 0, 0, { style, facing: 0.3, spacing: 1.6 });
    let min = Infinity;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        min = Math.min(min, Math.hypot(slots[i][0] - slots[j][0], slots[i][1] - slots[j][1]));
      }
    }
    /* 1.6 m pitch: the closest pair is a diagonal, 1.6 * 0.9 in the tight axis */
    assert(min > 1.05, `${style}: closest pair is ${min.toFixed(2)} m apart`);
  }
  return 'no two slots closer than 1.05 m at a 1.6 m pitch';
});

check('a group is centred on the point it was ordered to', () => {
  for (const style of FORMATIONS) {
    for (const n of [1, 4, 9, 17]) {
      const slots = formationSlots(n, 12, -30, { style, facing: 1.1, spacing: 1.5 });
      const mx = slots.reduce((a, s) => a + s[0], 0) / n;
      const mz = slots.reduce((a, s) => a + s[1], 0) / n;
      assert(Math.hypot(mx - 12, mz + 30) < 1.6, `${style} n=${n} centres ${(mx - 12).toFixed(2)},${(mz + 30).toFixed(2)} off the tap`);
    }
  }
  return 'centres stay within a metre and a half of the tap';
});

/** Extent of the shape along the facing axis and across it. */
function extents(slots, facing) {
  const fwd = [Math.sin(facing), Math.cos(facing)];
  const right = [Math.cos(facing), -Math.sin(facing)];
  let mnA = Infinity, mxA = -Infinity, mnB = Infinity, mxB = -Infinity;
  for (const [x, z] of slots) {
    const a = x * right[0] + z * right[1];
    const b = x * fwd[0] + z * fwd[1];
    mnA = Math.min(mnA, a); mxA = Math.max(mxA, a);
    mnB = Math.min(mnB, b); mxB = Math.max(mxB, b);
  }
  return { across: mxA - mnA, deep: mxB - mnB };
}

check('a line is wider than a box, and a column is deeper', () => {
  const facing = 0.4;
  const line = extents(formationSlots(12, 0, 0, { style: 'line', facing, spacing: 1.5 }), facing);
  const box = extents(formationSlots(12, 0, 0, { style: 'box', facing, spacing: 1.5 }), facing);
  const col = extents(formationSlots(12, 0, 0, { style: 'column', facing, spacing: 1.5 }), facing);
  assert(line.across > box.across * 1.4, `line ${line.across.toFixed(1)} m vs box ${box.across.toFixed(1)} m across`);
  assert(col.deep > col.across, `column is ${col.across.toFixed(1)} × ${col.deep.toFixed(1)} -- not a column`);
  return `line ${line.across.toFixed(1)} m across, box ${box.across.toFixed(1)} m, column ${col.deep.toFixed(1)} m deep`;
});

check('a wedge points the way the army is marching', () => {
  const facing = 2.2;
  const slots = formationSlots(16, 0, 0, { style: 'wedge', facing, spacing: 1.5 });
  const fwd = [Math.sin(facing), Math.cos(facing)];
  const depth = slots.map(([x, z]) => x * fwd[0] + z * fwd[1]);
  const lead = Math.max(...depth);
  const leaders = depth.filter((d) => lead - d < 0.01).length;
  assert(leaders === 1, `the wedge has ${leaders} soldiers on its front edge, not a point`);
  const behind = depth.filter((d) => d < lead - 0.5).length;
  assert(behind === 15, `only ${behind}/15 soldiers are behind the point`);
  return 'one soldier at the tip, the rest echeloned behind';
});

check('the shape turns with the direction of the march', () => {
  const a = formationSlots(6, 0, 0, { style: 'line', facing: 0, spacing: 1.5 });
  const b = formationSlots(6, 0, 0, { style: 'line', facing: Math.PI / 2, spacing: 1.5 });
  const aSpread = extents(a, 0), bSpread = extents(b, Math.PI / 2);
  assert(Math.abs(aSpread.across - bSpread.across) < 0.01, 'the line is a different width when it faces east');
  assert(aSpread.deep < 0.01 && bSpread.deep < 0.01, 'a one-rank line has depth');
  return `both ranks are ${aSpread.across.toFixed(1)} m wide`;
});

/* ------------------------------------------------------- and the movement */
function newGame(seed) {
  const game = new Game({ world: generateWorld(seed), civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: { play() {} }, seed });
  game.start();
  for (const t of [1, 2]) { const st = game.teams.get(t); st.res.food = 3000; st.res.wood = 3000; st.gold = 0; st.popCap = 200; }
  return game;
}

function flatSpot(game) {
  for (let r = 20; r < WORLD.half - 40; r += 5) {
    for (let a = 0; a < 48; a++) {
      const x = Math.round(Math.cos(a / 48 * Math.PI * 2) * r / 2) * 2;
      const z = Math.round(Math.sin(a / 48 * Math.PI * 2) * r / 2) * 2;
      let clear = true;
      for (let dx = -12; dx <= 12 && clear; dx += 4) {
        for (let dz = -12; dz <= 12; dz += 4) if (!game.isPassable(x + dx, z + dz)) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  return null;
}

/** Order eight soldiers to march east in a formation and measure the result. */
function march(style) {
  const game = newGame(31337);
  const s = flatSpot(game);
  assert(s, 'no open ground');
  const units = [];
  for (let i = 0; i < 8; i++) {
    const u = game.spawnUnitRaw('swordsman', 1, s.x + (i % 3) * 1.2, s.z + ((i / 3) | 0) * 1.2);
    assert(u, 'could not spawn');
    u.stance = 'stand';
    units.push(u);
  }
  game.formationStyle = style;
  game.orderMove(units, s.x + 26, s.z);
  for (let i = 0; i < 1200; i++) game.update(STEP);
  const xs = units.map((u) => u.x), zs = units.map((u) => u.z);
  const acrossZ = Math.max(...zs) - Math.min(...zs);
  const alongX = Math.max(...xs) - Math.min(...xs);
  let minPair = Infinity;
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      minPair = Math.min(minPair, Math.hypot(units[i].x - units[j].x, units[i].z - units[j].z));
    }
  }
  const arrived = units.filter((u) => Math.hypot(u.x - (s.x + 26), u.z - s.z) < 9).length;
  return { acrossZ, alongX, minPair, arrived, units };
}

check('a line arrives as a line', () => {
  const r = march('line');
  assert(r.arrived === 8, `only ${r.arrived}/8 arrived`);
  assert(r.acrossZ > 7, `the "line" is only ${r.acrossZ.toFixed(1)} m wide`);
  assert(r.minPair > 0.7, `two soldiers ended up ${r.minPair.toFixed(2)} m apart`);
  return `${r.acrossZ.toFixed(1)} m wide, ${r.acrossZ > r.alongX ? 'wider than deep' : 'DEEPER THAN WIDE'}`;
});

check('a column arrives as a column', () => {
  const r = march('column');
  assert(r.arrived === 8, `only ${r.arrived}/8 arrived`);
  assert(r.alongX > r.acrossZ, `the column is ${r.acrossZ.toFixed(1)} m wide but only ${r.alongX.toFixed(1)} m deep`);
  assert(r.minPair > 0.7, `two soldiers ended up ${r.minPair.toFixed(2)} m apart`);
  return `${r.alongX.toFixed(1)} m deep, ${r.acrossZ.toFixed(1)} m wide`;
});

check('a box arrives together, not strung out', () => {
  const r = march('box');
  assert(r.arrived === 8, `only ${r.arrived}/8 arrived`);
  assert(Math.max(r.acrossZ, r.alongX) < 12, `the box is ${r.acrossZ.toFixed(1)} × ${r.alongX.toFixed(1)} m`);
  assert(r.minPair > 0.7, `two soldiers ended up ${r.minPair.toFixed(2)} m apart`);
  return `${r.acrossZ.toFixed(1)} × ${r.alongX.toFixed(1)} m`;
});

check('a wedge arrives pointed at the enemy', () => {
  const r = march('wedge');
  assert(r.arrived === 8, `only ${r.arrived}/8 arrived`);
  const lead = r.units.reduce((best, u) => (u.x > best.x ? u : best), r.units[0]);
  const rest = r.units.filter((u) => u !== lead);
  const behind = rest.filter((u) => u.x < lead.x - 0.4).length;
  assert(behind >= 6, `only ${behind}/7 soldiers are behind the tip`);
  assert(r.minPair > 0.7, `two soldiers ended up ${r.minPair.toFixed(2)} m apart`);
  return `tip ${(lead.x - Math.min(...rest.map((u) => u.x))).toFixed(1)} m ahead of the rearmost`;
});

check('single-unit orders ignore the formation entirely', () => {
  const game = newGame(11);
  const s = flatSpot(game);
  const u = game.spawnUnitRaw('swordsman', 1, s.x, s.z);
  game.formationStyle = 'wedge';
  game.orderMove([u], s.x + 5, s.z + 5);
  assert(u.destX !== null && Math.abs(u.destX - (s.x + 5)) < 0.01, `a lone soldier was put at ${u.destX}, not the tap`);
  return 'the lone soldier walks to the tap';
});

console.log('');
if (fails.length) {
  console.log(`FORMATION FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`FORMATION CHECKS PASSED (${pass})`);
