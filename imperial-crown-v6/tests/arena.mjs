/* A dry, flat parade ground for the suites that need one.

   Every map is now a hydrology map: Confluence, Headwaters and the rest put
   a river, a sea or a wadi through the middle of the world, and the centre of
   the map is frequently *water*. The combat, siege, wall and pick suites used
   to spawn their armies at (0, 0) because the legacy island happened to be
   dry there. That was never a property of the game -- it was a property of
   one seed of one island -- and hard-coding it made those suites assert the
   map's shape rather than the mechanic they exist to test.

   This finds real ground instead: flat, dry, clear of resources and buildings,
   as close to a hint point as the map allows. Suites call it and then place
   their own units relative to the answer.
*/

/**
 * Score every candidate on a coarse lattice and return the best dry clearing.
 *
 * @param {object} world   a generated world
 * @param {object} [opts]
 * @param {number} [opts.radius=26]  half-size of the clearing that must be dry
 * @param {number} [opts.hintX=0]    where we would like it to be
 * @param {number} [opts.hintZ=0]
 * @param {number} [opts.maxSlope=0.16]
 * @param {boolean}[opts.clearResources=true]
 * @param {number} [opts.minH=1.1]   metres above the water line
 * @returns {{x:number,z:number,h:number}|null}
 */
export function findDryClearing(world, opts = {}) {
  const radius = opts.radius ?? 26;
  const hintX = opts.hintX ?? 0;
  const hintZ = opts.hintZ ?? 0;
  const maxSlope = opts.maxSlope ?? 0.16;
  const minH = opts.minH ?? 1.1;
  const clearResources = opts.clearResources !== false;
  const hf = world.height;
  const half = world.size * 0.5;
  const limit = half - radius - 6;

  const resources = (world.resources || []).filter((r) => !r.dead);

  let best = null;
  let bestScore = -Infinity;
  const step = 6;
  for (let z = -limit; z <= limit; z += step) {
    for (let x = -limit; x <= limit; x += step) {
      /* The centre and a ring of probes both have to be dry and gentle: a
         clearing with a spring in the middle is not a parade ground. */
      if (hf.sample(x, z) < minH || hf.slope(x, z) > maxSlope) continue;
      let ok = true;
      let worst = 0;
      for (let a = 0; a < 8 && ok; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const px = x + Math.cos(ang) * radius * 0.62;
        const pz = z + Math.sin(ang) * radius * 0.62;
        const h = hf.sample(px, pz);
        if (h < minH * 0.8) ok = false;
        const sl = hf.slope(px, pz);
        if (sl > maxSlope * 1.6) ok = false;
        if (sl > worst) worst = sl;
      }
      if (!ok) continue;
      if (clearResources) {
        const r2 = radius * radius;
        for (let i = 0; i < resources.length; i++) {
          const r = resources[i];
          const dx = r.x - x, dz = r.z - z;
          if (dx * dx + dz * dz < r2) { ok = false; break; }
        }
        if (!ok) continue;
      }
      /* Prefer flat, then central, then high enough to be unmistakably land. */
      const score = -worst * 60 - Math.hypot(x - hintX, z - hintZ) * 0.05
        + Math.min(6, hf.sample(x, z) * 0.8);
      if (score > bestScore) { bestScore = score; best = { x, z, h: hf.sample(x, z) }; }
    }
  }
  return best;
}

/**
 * A clearing plus a facing axis, for suites that want "two armies, this far
 * apart, on ground they can both stand on".
 */
export function findBattlefield(world, opts = {}) {
  const spot = findDryClearing(world, opts);
  if (!spot) return null;
  const sep = opts.separation ?? 18;
  return { x: spot.x, z: spot.z, h: spot.h, separation: sep };
}

/**
 * A straight run of wall-sized cells that `planWallLine` will accept in full:
 * flat, dry, and clear of resources along the whole length.
 *
 * @param {object} game  a started Game
 * @param {object} [opts]
 * @param {string} [opts.type='stone_wall']
 * @param {number} [opts.team=1]
 * @param {number} [opts.length=16]  metres of run
 * @param {number} [opts.tries=240]
 * @returns {{x:number,z:number,ang:number,length:number}|null}
 */
export function findWallRun(game, opts = {}) {
  const type = opts.type || 'stone_wall';
  const team = opts.team ?? 1;
  const length = opts.length ?? 16;
  const tries = opts.tries ?? 240;
  const half = game.world.size * 0.5;
  const limit = half - 40;
  for (let t = 0; t < tries; t++) {
    const ang = (t / tries) * Math.PI * 2 * 7;            // a spiral of angles
    const r = 30 + (t / tries) * (limit - 30);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (Math.abs(x) > limit || Math.abs(z) > limit) continue;
    const cells = game.planWallLine(type, x, z, x + length, z, team);
    if (cells.length >= 6 && cells.every((c) => c.ok)) {
      return { x, z, ang: 0, length, cells };
    }
  }
  return null;
}
