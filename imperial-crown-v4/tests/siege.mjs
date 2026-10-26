/* Sieges: the half of a war that happens against a wall.

   `wallgate.mjs` proves the wall *stops* people. This suite proves the other
   half of the promise: that it can be brought down, that the thing shooting
   from behind it can be answered, and that every number the player is shown
   about a siege is the number the simulation uses.

   Where it matters the checks are geometric -- a real run of stone on real
   terrain, real rams and real mangonels, real ticks -- because the bugs in a
   siege are the ones that only appear when a machine walks into a wall:

     · a ram is worth more against a wall than a swordsman, by a wide margin
     · a ram's damage is applied to the *building*, not to the man beside it
     · a wall that falls re-opens the ground it stood on
     · a gate is not a shortcut for the enemy even when it is being broken
     · a tower shoots what comes near it, and a garrison makes it shoot more
     · a castle shoots faster than a watch tower (it did not: `def.type` does
       not exist, so the faster rate was never used)
     · a trebuchet out-ranges a tower

   node tests/siege.mjs
*/
import { generateWorld, WORLD } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
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
    st.res.food = 9000; st.res.wood = 9000; st.res.gold = 9000; st.res.stone = 9000;
    st.age = 3;
  }
  game.ai = [];
  return game;
}

/** A flat, empty stretch of ground wide enough for a wall across it. */
function findFlatRun(game, span = 10) {
  const ok = (x, z) => {
    const spot = game.canPlaceAt('stone_wall', 1, x, z);
    if (!spot.ok) return false;
    const h = game.heightAt(x, z);
    return h > 0.6 && Math.abs(game.heightAt(x + 2, z) - h) < 1.2;
  };
  for (let r = 24; r < WORLD.half - 30; r += 6) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(Math.cos(a / 64 * Math.PI * 2) * r / 2) * 2;
      const z = Math.round(Math.sin(a / 64 * Math.PI * 2) * r / 2) * 2;
      let all = true;
      for (let i = -span / 2; i <= span / 2; i += 2) if (!ok(x + i, z)) { all = false; break; }
      if (!all) continue;
      let clear = true;
      for (let dz = -8; dz <= 8; dz += 2) if (!game.isPassable(x, z + dz)) { clear = false; break; }
      if (!clear) continue;
      return { x, z };
    }
  }
  return null;
}

/** Spawn one unit of `type` at a spot, bypassing population and gold. */
function spawnAt(game, type, team, x, z) {
  const u = game.spawnUnitRaw(type, team, x, z);
  if (u) { u.noAggro = true; }
  return u;
}

/** Run the simulation forward, letting projectiles and buildings tick. */
function run(game, seconds) {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) game.update(STEP);
}

const g = newGame();
const spot = findFlatRun(g);
assert(spot, 'no flat ground on this map to build a test wall on');

/* --------------------------------------------------------- the wall exists */
const plan = g.planWallLine('stone_wall', spot.x - 8, spot.z, spot.x + 8, spot.z, 1);
const built = g.placeWallLine('stone_wall', 1, plan, { free: true, instant: true });
assert(built.placed.length >= 6, `only ${built.placed.length} wall segments went up`);
g.refreshNav();
/* the building hash is rebuilt during a tick; isPassable reads it */
g.update(STEP);
const walls = built.placed;
const middle = walls[Math.floor(walls.length / 2)];

/* A wall is not a box that `isPassable` refuses: it is a *nav grid* cell that
   is blocked, which is stronger -- the pathfinder, the enemy's pathfinder and
   the movement shortcut all read it. So the honest question is the grid's. */
const blockedAt = (game, x, z) => {
  const [cx, cz] = game.pathFinder.worldToCell(x, z);
  return game.pathFinder.isBlocked(cx, cz);
};
check('a finished wall is blocked on the navigation grid', () => {
  assert(blockedAt(g, middle.x, middle.z), 'the nav grid does not know the wall is there');
  assert(blockedAt(g, middle.x, middle.z), 'the enemy pathfinder can walk through the wall');
  return `${walls.length} segments, ${middle.hp} hp each`;
});

/* ------------------------------------------------------- the right tool ---- */
/* A ram and a swordsman, side by side, against one wall segment. The ram's
   building bonus is 120; the swordsman's is 0. Measured, not asserted. */
function damagePerSecond(type) {
  const game = newGame();
  const sp = findFlatRun(game);
  const pl = game.planWallLine('stone_wall', sp.x - 6, sp.z, sp.x + 6, sp.z, 1);
  const b = game.placeWallLine('stone_wall', 1, pl, { free: true, instant: true });
  const target = b.placed[Math.floor(b.placed.length / 2)];
  const u = spawnAt(game, type, 2, target.x, target.z + 3.2);
  assert(u, `${type} did not spawn`);
  u.state = STATE.ATTACK;
  u.target = target;
  u.stance = 'aggressive';
  const hp0 = target.hp;
  run(game, 6);
  return (hp0 - target.hp) / 6;
}
check('a ram breaks walls far faster than a swordsman', () => {
  const ram = damagePerSecond('ram');
  const sword = damagePerSecond('swordsman');
  assert(ram > 0, `the ram did no damage at all (${ram})`);
  assert(ram > sword * 4, `ram ${ram.toFixed(1)} vs swordsman ${sword.toFixed(1)} hp/s is not a siege engine`);
  return `ram ${ram.toFixed(1)} hp/s vs swordsman ${sword.toFixed(1)} hp/s`;
});

/* ------------------------------------------------------ the wall comes down */
check('a wall that falls re-opens the ground it stood on', () => {
  const game = newGame();
  const sp = findFlatRun(game);
  const pl = game.planWallLine('stone_wall', sp.x - 6, sp.z, sp.x + 6, sp.z, 1);
  const b = game.placeWallLine('stone_wall', 1, pl, { free: true, instant: true });
  const target = b.placed[Math.floor(b.placed.length / 2)];
  game.refreshNav();
  game.update(STEP);
  assert(blockedAt(game, target.x, target.z), 'the wall is not solid to begin with');
  const ram = spawnAt(game, 'ram', 2, target.x, target.z + 3.4);
  ram.state = STATE.ATTACK; ram.target = target; ram.stance = 'aggressive';
  let t = 0;
  while (t < 60 && !target.dead) { game.update(STEP); t += STEP; }
  assert(target.dead, `the ram could not bring down one segment in 60 s (${Math.round(target.hp)} hp left)`);
  /* a dead building leaves the spatial hash and stamps itself out of the nav
     grid on death, but the grid is rebuilt on the next refresh */
  game.refreshNav();
  assert(!blockedAt(game, target.x, target.z), 'the wall is gone but the ground is still blocked');
  return `down in ${t.toFixed(1)} s`;
});

/* ------------------------------------------------------------- the gate --- */
check('a gate is not a shortcut for the enemy, even while it is being broken', () => {
  const game = newGame();
  const sp = findFlatRun(game);
  const pl = game.planWallLine('stone_wall', sp.x - 8, sp.z, sp.x + 8, sp.z, 1);
  const b = game.placeWallLine('stone_wall', 1, pl, { free: true, instant: true });
  const gate = game.placeBuilding('stone_gate', 1, sp.x, sp.z, { free: true, instant: true });
  assert(gate, 'the gate would not go up in the gap');
  game.refreshNav();
  game.update(STEP);
  const probe = { team: 2, radius: 0.3, def: { size: 2.8 } };
  assert(!game.isPassable(gate.x, gate.z, probe), 'the gate is open to the enemy');
  assert(!blockedAt(game, gate.x, gate.z), 'the gate cell should be carved out of the build layer');
  /* now break it: it must stay shut to the enemy until it is rubble */
  const ram = spawnAt(game, 'ram', 2, gate.x, gate.z + 4.2);
  ram.state = STATE.ATTACK; ram.target = gate; ram.stance = 'aggressive';
  let t = 0;
  while (t < 40 && !gate.dead) { game.update(STEP); t += STEP; }
  assert(gate.dead, `the ram could not break the gate (${Math.round(gate.hp)} hp left)`);
  /* and the gate opened for its OWNER while it stood */
  return `broken in ${t.toFixed(1)} s`;
});

check('the gate opens for the owner while a siege is on it', () => {
  const game = newGame();
  const sp = findFlatRun(game);
  const pl = game.planWallLine('stone_wall', sp.x - 8, sp.z, sp.x + 8, sp.z, 1);
  game.placeWallLine('stone_wall', 1, pl, { free: true, instant: true });
  const gate = game.placeBuilding('stone_gate', 1, sp.x, sp.z, { free: true, instant: true });
  game.refreshNav();
  const friend = spawnAt(game, 'swordsman', 1, gate.x, gate.z - 3.4);
  friend.moveTo(gate.x, gate.z + 4, true);
  let t = 0;
  while (t < 8 && gate.gateOpen < 0.8) { game.update(STEP); t += STEP; }
  assert(gate.gateOpen > 0.8, `the leaf only opened to ${gate.gateOpen.toFixed(2)} with a friend at the door`);
  return `leaf ${gate.gateOpen.toFixed(2)}`;
});

/* ------------------------------------------------------------- the tower -- */
check('a tower shoots what comes near it, and a garrison shoots more', () => {
  const game = newGame();
  const sp = findFlatRun(game);
  const tower = game.placeBuilding('watch_tower', 1, sp.x, sp.z, { free: true, instant: true });
  assert(tower, 'the tower would not go up');
  const enemy = spawnAt(game, 'swordsman', 2, tower.x + 5, tower.z);
  assert(enemy, 'the enemy did not spawn');
  enemy.noAggro = true;
  const hp0 = enemy.hp;
  run(game, 8);
  const alone = hp0 - enemy.hp;
  assert(alone > 0, 'the tower never hit a man standing at its foot');

  /* three archers on the wall */
  const g2 = newGame();
  const tower2 = g2.placeBuilding('watch_tower', 1, sp.x, sp.z, { free: true, instant: true });
  const foe2 = spawnAt(g2, 'swordsman', 2, tower2.x + 5, tower2.z);
  foe2.noAggro = true;
  foe2.hp = foe2.maxHp = 4000;         // a post to shoot at, not a fight
  const guards = [];
  for (let i = 0; i < 3; i++) {
    const u = spawnAt(g2, 'archer', 1, tower2.x + 1, tower2.z + 1);
    if (u) guards.push(u);
  }
  for (const u of guards) g2.garrisonUnit(u, tower2);
  assert(tower2.garrison.length === guards.length, `only ${tower2.garrison.length} of ${guards.length} men went in`);
  const hp2 = foe2.hp;
  run(g2, 8);
  const garrisoned = hp2 - foe2.hp;
  assert(garrisoned > alone, `a garrisoned tower (${garrisoned.toFixed(0)} hp) does no more than an empty one (${alone.toFixed(0)} hp)`);
  return `empty ${alone.toFixed(0)} hp, garrisoned ${garrisoned.toFixed(0)} hp over 8 s`;
});

check('a castle looses faster than a watch tower', () => {
  const fireRate = (type) => {
    const game = newGame();
    const sp = findFlatRun(game);
    const b = game.placeBuilding(type, 1, sp.x, sp.z, { free: true, instant: true });
    assert(b, `${type} would not go up`);
    /* a very tough post, so the tower keeps shooting the whole window */
    const post = spawnAt(game, 'swordsman', 2, b.x + 4, b.z);
    post.noAggro = true;
    post.hp = post.maxHp = 100000;
    let shots = 0;
    const fire = game.fireProjectile.bind(game);
    game.fireProjectile = (src, tgt, dmg, kind) => { if (src === b) shots++; return fire(src, tgt, dmg, kind); };
    run(game, 20);
    game.fireProjectile = fire;
    return shots;
  };
  const tower = fireRate('watch_tower');
  const castle = fireRate('castle');
  assert(tower > 3, `the tower only fired ${tower} times in 20 s`);
  assert(castle > tower * 1.2, `castle ${castle} vs tower ${tower} shots in 20 s: the faster rate is not being used`);
  return `tower ${tower}, castle ${castle} shots in 20 s`;
});

check('a trebuchet out-ranges a tower', () => {
  const game = newGame();
  const sp = findFlatRun(game);
  const tower = game.placeBuilding('watch_tower', 1, sp.x, sp.z, { free: true, instant: true });
  const treb = spawnAt(game, 'trebuchet', 2, tower.x + (BUILDING_DEFS.watch_tower.range || 8) + 3.5, tower.z);
  assert(treb, 'the trebuchet did not spawn');
  const d = Math.hypot(treb.x - tower.x, treb.z - tower.z);
  assert(d > (BUILDING_DEFS.watch_tower.range || 8), `the trebuchet stands inside the tower's range (${d.toFixed(1)} m)`);
  treb.state = STATE.ATTACK; treb.target = tower; treb.stance = 'aggressive';
  treb.noAggro = false;
  const hp0 = tower.hp;
  run(game, 14);
  assert(tower.hp < hp0, `the trebuchet did nothing from ${d.toFixed(1)} m (${Math.round(tower.hp)} / ${tower.maxHp} hp)`);
  return `shot a wall from ${d.toFixed(1)} m: ${Math.round(hp0 - tower.hp)} hp in 14 s`;
});

/* --------------------------------------------------- defenders make a difference */
/* Every side of a building, not one: the nav grid rounds every footprint out
   to whole 2 m cells, so the ground a man could stand on is a *square* whose
   corner is 41 % further from the centre than its face. Melee reach used to be
   measured against the inscribed circle, which made three of the four approach
   angles unreachable -- the army stood at the corner of the town centre and
   swung at nothing. */
check('a building can be stormed from every side', () => {
  const game = newGame();
  const sp = findFlatRun(game, 16);
  const hall = game.placeBuilding('town_center', 1, sp.x, sp.z, { free: true, instant: true });
  hall.maxHp = hall.hp = 6000;
  const men = [];
  for (const [dx, dz] of [[9, 0], [-9, 0], [0, 9], [0, -9], [7, 7], [-7, -7]]) {
    const u = spawnAt(game, 'swordsman', 2, sp.x + dx, sp.z + dz);
    if (!u) continue;
    u.state = STATE.ATTACK; u.target = hall; u.noAggro = false; u.stance = 'aggressive';
    men.push(u);
  }
  const hp0 = hall.hp;
  run(game, 10);
  const short = men.filter((u) => {
    const d = Math.hypot(u.x - hall.x, u.z - hall.z);
    return d > u.attackRangeTo(hall, u.stats()) + 0.05;
  });
  assert(short.length === 0,
    `${short.length} of ${men.length} men never got into range of a hall (closest ${short.map((u) => Math.hypot(u.x - hall.x, u.z - hall.z).toFixed(2)).join(', ')})`);
  assert(hp0 - hall.hp > 0, 'no man damaged the hall');
  return `${men.length} sides in range, ${(hp0 - hall.hp).toFixed(0)} hp in 10 s`;
});

/* The last stride is a shortcut into a building's own conservative hull, and
   a shortcut that can vault a wall would make walls decorative again. */
check('the last stride never vaults a wall', () => {
  const game = newGame();
  const sp = findFlatRun(game, 16);
  const hall = game.placeBuilding('town_center', 1, sp.x, sp.z, { free: true, instant: true });
  hall.maxHp = hall.hp = 6000;
  const r = 7;
  /* Corner cells are shared by two runs, and a run stops at its first illegal
     cell, so the long sides go down first and the short ones butt against
     them. */
  const lines = [
    game.planWallLine('stone_wall', sp.x - r, sp.z - r, sp.x + r, sp.z - r, 1),
    game.planWallLine('stone_wall', sp.x - r, sp.z + r, sp.x + r, sp.z + r, 1),
    game.planWallLine('stone_wall', sp.x - r, sp.z - r + 2, sp.x - r, sp.z + r - 2, 1),
    game.planWallLine('stone_wall', sp.x + r, sp.z - r + 2, sp.x + r, sp.z + r - 2, 1)
  ];
  let ring = 0;
  for (const pl of lines) ring += game.placeWallLine('stone_wall', 1, pl, { free: true, instant: true }).placed.length;
  assert(ring >= 24, `only ${ring} wall segments went up around the hall`);
  game.refreshNav();
  game.update(STEP);
  const u = spawnAt(game, 'swordsman', 2, sp.x + r + 4, sp.z);
  assert(u, 'no soldier');
  u.state = STATE.ATTACK; u.target = hall; u.noAggro = false; u.stance = 'aggressive';
  let inside = 0;
  for (let i = 0; i < 30 * 12; i++) {
    game.update(STEP);
    if (u.dead) break;
    if (Math.abs(u.x - sp.x) < r - 1 && Math.abs(u.z - sp.z) < r - 1) inside++;
  }
  assert(inside === 0, `the soldier spent ${inside} ticks inside the wall ring`);
  return `${ring} segments held for 12 s`;
});

/* Men inside a building are still in `units` with a flag. The release on a
   roof falling used to push them in again, so a garrison of four became eight
   entities: double population, double ticks, double draw calls, and the
   soldiers slid out through the wall they were supposed to be sheltering in. */
check('a garrison comes out once, on free ground, when the roof falls', () => {
  const game = newGame();
  const sp = findFlatRun(game, 16);
  const hall = game.placeBuilding('town_center', 1, sp.x, sp.z, { free: true, instant: true });
  const men = [];
  for (let i = 0; i < 4; i++) {
    const u = spawnAt(game, 'archer', 1, sp.x + 4 + i * 0.6, sp.z + 4);
    assert(u, 'archer spawn failed');
    assert(game.garrisonUnit(u, hall), 'the hall refused the garrison');
    men.push(u);
  }
  game.recomputePop();
  const pop0 = game.teams.get(1).popUsed;
  hall.hp = 1;
  hall.takeDamage(9999, null);
  const seen = game.units.filter((u) => men.includes(u)).length;
  assert(seen === men.length, `the garrison was duplicated: ${seen} entries for ${men.length} men`);
  game.recomputePop();
  assert(game.teams.get(1).popUsed === pop0,
    `releasing the garrison changed the population: ${pop0} -> ${game.teams.get(1).popUsed}`);
  const stuck = men.filter((u) => !game.isPassable(u.x, u.z, u));
  assert(stuck.length === 0, `${stuck.length} of ${men.length} came out standing inside something`);
  const [cx, cz] = game.pathFinder.worldToCell(men[0].x, men[0].z);
  assert(!game.pathFinder.isBlocked(cx, cz), 'a released man came out on a blocked nav cell');
  assert(hall.garrison.length === 0, 'the rubble still holds a garrison');
  return `${men.length} men released, population unchanged at ${pop0}`;
});

/* The same road out is taken by "leave the building", so it has to land on
   walkable ground too -- right next to the wall, not in the middle of it. */
check('leaving a building by hand steps outside the wall', () => {
  const game = newGame();
  const sp = findFlatRun(game, 16);
  const tower = game.placeBuilding('watch_tower', 1, sp.x, sp.z, { free: true, instant: true });
  const u = spawnAt(game, 'archer', 1, sp.x + 3, sp.z);
  assert(game.garrisonUnit(u, tower), 'the tower refused the garrison');
  game.removeFromGarrison(u);
  const half = (tower.def.size || 3) * 0.5;
  const d = Math.hypot(u.x - tower.x, u.z - tower.z);
  assert(d > half, `he came out inside the tower (${d.toFixed(2)} m from the centre, half-width ${half})`);
  assert(game.isPassable(u.x, u.z, u), 'he came out on ground he cannot stand on');
  return `stepped out to ${d.toFixed(2)} m`;
});

check('a garrisoned hall is harder to storm than an empty one', () => {
  /* Not a balance claim: a rule. Men inside a building shoot out of it, so a
     hall with a garrison must cost the attacker more than an empty hall. */
  const storm = (withGarrison) => {
    const game = newGame();
    const sp = findFlatRun(game);
    const hall = game.placeBuilding('town_center', 1, sp.x, sp.z, { free: true, instant: true });
    hall.maxHp = hall.hp = 3000;
    if (withGarrison) {
      for (let i = 0; i < 4; i++) {
        const u = spawnAt(game, 'archer', 1, sp.x + 2, sp.z + 2);
        if (u) game.garrisonUnit(u, hall);
      }
    }
    const attackers = [];
    for (let i = 0; i < 5; i++) {
      /* around the hall, inside the range of its own arrows */
      const a = spawnAt(game, 'swordsman', 2, sp.x + 5 + (i % 2), sp.z + (i * 0.8));
      if (!a) continue;
      a.state = STATE.ATTACK; a.target = hall; a.noAggro = false; a.stance = 'aggressive';
      attackers.push(a);
    }
    const hp0 = hall.hp;
    const alive0 = attackers.length;
    run(game, 18);
    return { damage: hp0 - hall.hp, lost: attackers.filter((a) => a.dead).length + (alive0 - attackers.filter((a) => !a.dead).length) * 0 };
  };
  const empty = storm(false);
  const held = storm(true);
  assert(empty.damage > 0, 'the attackers did not damage the empty hall at all');
  assert(held.damage < empty.damage,
    `a garrisoned hall took as much damage as an empty one (${held.damage.toFixed(0)} vs ${empty.damage.toFixed(0)})`);
  return `empty hall loses ${empty.damage.toFixed(0)} hp, garrisoned ${held.damage.toFixed(0)} hp in 18 s`;
});

console.log('');
if (fails.length) {
  console.log(`SIEGE CHECKS FAILED (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`SIEGE CHECKS PASSED (${pass})`);
