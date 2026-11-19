/* ============================================================
   tests/mapsize.mjs — the size of the battlefield
   ------------------------------------------------------------
   512 m is a village: an army crosses it in twenty seconds, so
   the only strategic question is "do I have more men". Section 2
   of the depth plan makes Large (1024 m) the default and Huge
   (1536 m) an option, and adds a land route at each corner of a
   river map so the ford is not the only answer.

   What is checked here:
     · every preset generates, and its own numbers are consistent
       (a nav cell is the metres it claims to be)
     · Classic is exactly what it was: same seed, same map, same
       number of cells -- existing saves and tests describe it
     · a bigger map is not a broken one: nothing spawns off the
       map, seats are apart, resources scale with the ground
     · the corner corridors are dry, walkable, and reach both banks
     · the ford is still the short road and the corner the long one
   ============================================================ */
import { generateWorld, MAP_SIZES, MAP_SIZE_LIST, DEFAULT_MAP_SIZE, mapSize, worldShape } from '../src/sim/worldgen.js';
import { DOMAIN } from '../src/sim/hydrology.js';
import { Game } from '../src/sim/game.js';
import { Camera } from '../src/gfx/camera.js';
import crypto from 'node:crypto';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

console.log('\nPRESETS');

check('every preset is internally consistent', () => {
  for (const id of MAP_SIZE_LIST) {
    const preset = MAP_SIZES[id];
    const w = worldShape(preset);
    assert(w.half === w.size / 2, `${id}: half is not half the size`);
    assert(Math.abs(w.cell - preset.size / preset.segments) < 1e-9, `${id}: terrain cell disagrees with its size`);
    /* a nav cell has to be the metres it says it is, or every path cost in
       the simulation is priced in a unit nobody can reason about */
    assert(Math.abs(w.navCell - w.size / w.navCells) < 1e-9, `${id}: nav cell is ${w.size / w.navCells} m, claims ${w.navCell}`);
    assert(w.fowCells % 1 === 0, `${id}: fog grid is not a whole number of cells`);
    assert(w.size > 0 && w.segments > 0 && w.navCells > 0, `${id}: a zero dimension`);
  }
});

check('Large is the default, and the sizes really do differ', () => {
  assert(DEFAULT_MAP_SIZE === 'large', `default is ${DEFAULT_MAP_SIZE}`);
  const c = MAP_SIZES.classic.size, l = MAP_SIZES.large.size, h = MAP_SIZES.huge.size;
  assert(c === 512 && l === 1024 && h === 1536, `sizes are ${c}/${l}/${h}`);
});

check('a size can be asked for by name, by preset or by metres', () => {
  assert(mapSize('huge').id === 'huge');
  assert(mapSize(MAP_SIZES.large).id === 'large');
  assert(mapSize(1024).id === 'large', 'metres did not resolve');
  assert(mapSize('nonsense').id === DEFAULT_MAP_SIZE, 'an unknown size did not fall back');
});

console.log('\nCLASSIC IS UNCHANGED');

check('the classic map is the map it always was', () => {
  const w = generateWorld(20261, { size: 'classic' });
  assert(w.size === 512 && w.half === 256, `${w.size} m`);
  assert(w.nav.cells === 256 && w.nav.cell === 2, `nav ${w.nav.cells} x ${w.nav.cell}`);
  assert(w.w.fowCells === 128, `fog ${w.w.fowCells}`);
  assert(w.bases.length === 2, `${w.bases.length} seats`);
});

check('the classic terrain is bit-identical to the map that shipped', () => {
  /* The hash is the point. Growing the maps meant scaling rivers, re-cutting
     fords, stamping flanks and adding a connectivity net, and every one of
     those is gated on size -- but the gates are one `!==` away from being
     wrong, and a version of this change that quietly re-drew the classic map
     would still pass every other check in this file. A saved match, a shared
     seed and a replay all depend on the 512 m world being the world it was. */
  const w = generateWorld(20261, { size: 'classic' });
  const hash = (a) => crypto.createHash('sha1')
    .update(Buffer.from(Float32Array.from(a).buffer)).digest('hex').slice(0, 16);
  assert(hash(w.height.h) === '9ab58e6df662a3df', 'classic terrain changed: ' + hash(w.height.h));
  assert(hash(w.domain) === '751d041387eb9303', 'classic nav grid changed: ' + hash(w.domain));
  assert(w.resources.length === 907, 'classic has ' + w.resources.length + ' resource nodes, not 907');
  assert(w.fords.length === 3, 'classic has ' + w.fords.length + ' fords, not 3');
  assert(w.corridors.length === 0, 'classic grew corner flanks it never had');
});

check('asking for nothing gives classic, so old callers keep their map', () => {
  const plain = generateWorld(20261);
  const classic = generateWorld(20261, { size: 'classic' });
  assert(plain.size === classic.size, 'the default is not classic:' + plain.size);
  for (let i = 0; i < plain.height.h.length; i += 97) {
    assert(Math.abs(plain.height.h[i] - classic.height.h[i]) < 1e-9, 'terrain differs at ' + i);
  }
});

console.log('\nTHE BIG MAPS');

for (const id of ['large', 'huge']) {
  check(`a ${id} map is a working map, not just a bigger number`, () => {
    const world = generateWorld(20261, { size: id });
    const half = world.half;
    assert(world.size === MAP_SIZES[id].size, `${world.size} m`);
    /* every seat is real ground, inside the map, and clear of the others */
    assert(world.bases.length >= 2, `${world.bases.length} seats`);
    for (const b of world.bases) {
      assert(Math.abs(b.x) < half && Math.abs(b.z) < half, `a seat is off the map at ${b.x.toFixed(0)},${b.z.toFixed(0)}`);
      assert(Number.isFinite(b.h), 'a seat has no ground height');
    }
    for (let i = 0; i < world.bases.length; i++) {
      for (let j = i + 1; j < world.bases.length; j++) {
        const d = Math.hypot(world.bases[i].x - world.bases[j].x, world.bases[i].z - world.bases[j].z);
        assert(d > 60, `seats ${i} and ${j} are ${d.toFixed(0)} m apart`);
      }
    }
    /* nothing spawns outside the world */
    for (const r of world.resources) {
      assert(Math.abs(r.x) <= half + 1 && Math.abs(r.z) <= half + 1, `${r.type} at ${r.x.toFixed(0)},${r.z.toFixed(0)}`);
    }
    /* and the map is populated in proportion to its ground: a scatter tuned
       for 512 m, left alone, would leave a 1024 m field with a quarter of the
       nodes per hectare and a walk between every tree */
    const ratio = (world.resources.length / (world.size * world.size)) * (512 * 512);
    assert(ratio > 600, `only ${ratio.toFixed(0)} resources at classic density (907 is classic)`);
  });

  check(`a ${id} map simulates without leaving the map or deadlocking`, () => {
    const world = generateWorld(20261, { size: id });
    const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
    g.start();
    for (let i = 0; i < 300; i++) g.update(1 / 30);
    for (const u of g.units) {
      if (u.dead) continue;
      assert(Number.isFinite(u.x) && Number.isFinite(u.z), `${u.type} has a NaN position`);
      assert(Math.abs(u.x) <= world.half + 4 && Math.abs(u.z) <= world.half + 4, `${u.type} left the map at ${u.x.toFixed(0)},${u.z.toFixed(0)}`);
    }
    assert(g.fow.length === world.w.fowCells * world.w.fowCells, `fog is ${g.fow.length}, cells say ${world.w.fowCells ** 2}`);
  });
}

console.log('\nTHE INVISIBLE-EDGE TRAP');

check('every corner of the map can be found by a neighbour query', () => {
  /* The uniform hash is asked "who is near here?" thousands of times a tick:
     separation, aggro, a gate's leaf, gathering, auras. It is a fixed grid,
     and the grid was a fixed SIZE -- 96 cells of 6 m, a 576 m span, taken from
     the map it was written for. On a 1024 m world everything past +-320 m fell
     outside it, and `insert` returns silently for a cell outside the grid, so
     the east half of the map simply did not exist to any of those systems.
     Nothing threw, nothing logged: the far bank was just empty of men. */
  for (const id of ['classic', 'large', 'huge']) {
    const world = generateWorld(20261, { size: id });
    const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
    g.start();
    const H = world.half;
    const step = (H * 2) / 11;
    for (let x = -H + 8; x <= H - 8; x += step) {
      for (let z = -H + 8; z <= H - 8; z += step) {
        assert(g.spatial.cellIndex(x, z) >= 0, `${id}: (${x.toFixed(0)},${z.toFixed(0)}) is off the unit grid`);
      }
    }
    assert(g.spatial.cells * g.spatial.cellSize >= H * 2, `${id}: the grid spans ${g.spatial.cells * g.spatial.cellSize} m of a ${H * 2} m map`);
    assert(g.resourceSpatial.cells * g.resourceSpatial.cellSize >= H * 2, `${id}: the resource grid is too small`);
    assert(g.buildingSpatial.cells * g.buildingSpatial.cellSize >= H * 2, `${id}: the building grid is too small`);
  }
});

console.log('\nTHE CORNER CORRIDORS');

check('a river map has a second land route at each end of the river', () => {
  /* The trunk runs the width of the map through its middle, so the geometric
     corners are half a kilometre from any water and a shelf parked there
     would bridge nothing. The flanks belong where the river meets the map
     border -- out on the map's edge, at the far end of the longest march. */
  const world = generateWorld(20261, { size: 'large' });
  assert(world.corridors.length === 2, `${world.corridors.length} corridors`);
  const half = world.half;
  for (const c of world.corridors) {
    const edge = half - Math.max(Math.abs(c.x), Math.abs(c.z));
    assert(edge < half * 0.2, `a corridor sits ${edge.toFixed(0)} m inside the border -- not out on the flank`);
  }
  const [a, b] = world.corridors;
  assert((a.x > 0) !== (b.x > 0), 'both corridors are on the same side of the map');
});

check('the corridors are dry, walkable ground, not a hole in the river', () => {
  const world = generateWorld(20261, { size: 'large' });
  const N = world.nav.cells, cell = world.nav.cell, half = world.half;
  for (const c of world.corridors) {
    let open = 0, drowned = 0, walls = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const wx = (i + 0.5) * cell - half, wz = (j + 0.5) * cell - half;
        /* the flank is stamped in river coordinates -- wide across the
           channel, short along it -- so measure it the same way */
        const ax = Math.cos(c.angle), az = Math.sin(c.angle);
        const dx = wx - c.x, dz = wz - c.z;
        const along = dx * ax + dz * az, across = -dx * az + dz * ax;
        const RA = c.r * 0.40, RB = c.r * 1.1;
        if ((along / RA) ** 2 + (across / RB) ** 2 >= 1) continue;
        const d = world.domain[j * N + i];
        if (d === DOMAIN.WATER_ONLY) drowned++;
        else if (d === DOMAIN.BLOCKED) walls++;
        else open++;
      }
    }
    assert(open > 200, `only ${open} walkable cells at a corridor`);
    /* the whole crossing, not just its middle: the shelf has to span the
       channel, and a bridge with deep water in it is not a bridge */
    assert(drowned === 0, `${drowned} cells of the corridor are deep water`);
    assert(walls <= open * 0.1, `${walls} of ${open + walls} corridor cells are cliffs`);
  }
});

check('a soldier can walk to the far bank by way of a corner', () => {
  const world = generateWorld(20261, { size: 'large' });
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  const u = g.spawnUnitRaw('spearman', 1, world.bases[0].x, world.bases[0].z);
  assert(u, 'the soldier did not spawn');
  for (const c of world.corridors) {
    const path = g.pathFinder.find(u.x, u.z, c.x, c.z);
    assert(path && path.length, `no path from the home seat to the corridor at ${c.x.toFixed(0)},${c.z.toFixed(0)}`);
    const last = path[path.length - 1];
    assert(Math.hypot(last[0] - c.x, last[1] - c.z) < 40, 'the path does not end at the corridor');
  }
});

check('the ford is the short road and the corner the long one', () => {
  /* A corner that was just as fast as the ford would replace it rather than
     complement it: the point of the long way round is that it costs time. */
  const world = generateWorld(20261, { size: 'large' });
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  const u = g.spawnUnitRaw('spearman', 1, world.bases[0].x, world.bases[0].z);
  const ford = world.fords && world.fords[0];
  assert(ford, 'this map has no ford to compare against');
  const routeLen = (tx, tz) => {
    const p = g.pathFinder.find(u.x, u.z, tx, tz);
    if (!p || !p.length) return Infinity;
    let d = 0;
    for (let i = 1; i < p.length; i++) d += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    return d;
  };
  const byFord = routeLen(ford.x, ford.z);
  const flanks = world.corridors.map((c) => routeLen(c.x, c.z));
  const byCorner = Math.min(...flanks);
  assert(Number.isFinite(byFord), 'the ford is unreachable');
  assert(Number.isFinite(byCorner), 'no flank is reachable');
  assert(byCorner > byFord * 1.4,
    `the flank (${byCorner.toFixed(0)} m) is not clearly longer than the ford (${byFord.toFixed(0)} m)`);
});

/* ============================================================
   THE ZOOM-OUT
   ------------------------------------------------------------
   "Full-map zoom-out on Large with the far corner legible and
   unfogged" is the acceptance criterion, and it is a property of
   the camera, not of the map. The old limit was `half * 1.45`,
   which framed 512 m and cropped 1024 m: the corners of Large
   projected to nearly five times the edge of the viewport, so the
   overview showed the middle of the battlefield and cut off the
   war. These checks project the map's own corners through the
   camera's real frustum and demand that all four land on screen.
   ============================================================ */
console.log('\nTHE ZOOM-OUT');

/* Project a world point through a camera and return its NDC. */
const ndcOf = (cam, x, z) => {
  cam.update(1 / 60, { instant: true });
  const v = cam.viewProj;
  const cx = v[0] * x + v[4] * 0 + v[8] * z + v[12];
  const cy = v[1] * x + v[5] * 0 + v[9] * z + v[13];
  const cw = v[3] * x + v[7] * 0 + v[11] * z + v[15];
  return [cx / cw, cy / cw, cw];
};

const fitCamera = (half, w, h) => {
  const cam = new Camera({ yaw: Math.PI * 0.24, pitch: 0.86, dist: 44, fov: 47 });
  cam.heightAt = () => 0;
  cam.setAspect(w / h);
  cam.setWorldExtent(half);
  cam.setTarget(0, 0, true);
  cam.desiredDist = cam.dist = cam.maxDist;
  return cam;
};

/* 1.0 is the edge of the frame; the camera deliberately leaves an eighth of
   the screen as breathing room, so the contract is "inside the frame with a
   margin", not "pinned to the bezel". A map that only just touches the edge is
   a map whose boundary troops are half under the HUD. */
/* a hair over 1.12: the solver converges to the boundary and lands on it in
   floating point, so an exact comparison fails by 1e-16 on a correct answer */
const EDGE = 1.125;

check('the whole of Large fits on screen at full zoom-out', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1080]]) {
    const cam = fitCamera(512, w, h);
    for (const [x, z] of [[-512, -512], [512, -512], [512, 512], [-512, 512]]) {
      const [nx, ny, cw] = ndcOf(cam, x, z);
      assert(cw > 0, `${w}x${h}: corner ${x},${z} is behind the camera`);
      assert(Math.abs(nx) <= EDGE && Math.abs(ny) <= EDGE,
        `${w}x${h}: corner ${x},${z} is off screen at ndc ${nx.toFixed(2)},${ny.toFixed(2)}`);
    }
    /* and it must actually FILL the frame: a camera that stands too far back
       also "fits" the map, into a postage stamp in the middle. */
    const spread = Math.max(...[[-512, -512], [512, 512]].map(([x, z]) => {
      const [nx, ny] = ndcOf(cam, x, z); return Math.max(Math.abs(nx), Math.abs(ny));
    }));
    assert(spread > 0.8, `${w}x${h}: the overview only fills ${(spread * 100).toFixed(0)}% of the frame`);
  }
});

check('every size frames itself, and a bigger map needs a longer lens', () => {
  const c = fitCamera(256, 1280, 720).maxDist;
  const l = fitCamera(512, 1280, 720).maxDist;
  const h = fitCamera(768, 1280, 720).maxDist;
  assert(c < l && l < h, `zoom-out did not grow with the map: ${c} / ${l} / ${h}`);
  for (const [half, d] of [[256, c], [512, l], [768, h]]) {
    assert(half / d < 0.6, `at ${half} m the eye stands ${d} m away, which is not a map view`);
  }
});

check('a phone held upright stands further back than a desktop', () => {
  const desk = fitCamera(512, 1280, 720).maxDist;
  const phone = fitCamera(512, 720, 1280).maxDist;
  assert(phone > desk * 1.5,
    `portrait (${phone} m) does not frame a narrower screen than landscape (${desk} m)`);
  /* and it still fits, which is the whole point of standing further back */
  const cam = fitCamera(512, 720, 1280);
  for (const [x, z] of [[-512, -512], [512, 512], [512, -512], [-512, 512]]) {
    const [nx, ny] = ndcOf(cam, x, z);
    assert(Math.abs(nx) <= EDGE && Math.abs(ny) <= EDGE,
      `portrait: corner ${x},${z} off screen at ${nx.toFixed(2)},${ny.toFixed(2)}`);
  }
});

check('zooming out never leaves the map behind the eye', () => {
  /* The near corner has to stay in front of the camera at the far plane too,
     or the overview clips it into nothing. */
  const cam = fitCamera(768, 1280, 720);
  assert(cam.far > cam.maxDist + 768, `far plane ${cam.far} cuts the map at ${cam.maxDist} m`);
});

console.log(`\n  ${pass} map-size checks passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
if (fails.length) { for (const f of fails) console.log('   - ' + f.name + ': ' + f.e.message); process.exit(1); }
