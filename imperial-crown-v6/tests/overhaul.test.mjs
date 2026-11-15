import assert from 'node:assert/strict';
import { ResourceDisposalManager, ObjectPool } from '../src/core/resources.js';
import { buildHydrology, MAP_TYPES } from '../src/sim/hydrology.js';
import { generateWorld } from '../src/sim/worldgen.js';

const pool = new ObjectPool('test', (i) => ({ value: i }), 2);
const a = pool.acquire();
assert.equal(pool.acquire().idx, 1);
assert.equal(pool.acquire(), null);
pool.release(a.idx);
assert.equal(pool.acquire(), a, 'pooled handle should be reused');
const manager = new ResourceDisposalManager();
let clears = 0;
manager.registerPool('fx', { clear() { clears++; } });
manager.releaseMatch();
manager.registerPool('fx', { clear() { clears++; } });
manager.releaseMatch();
assert.equal(clears, 2, 'each match pool is cleared once');
let disposed = 0;
const resource = { dispose() { disposed++; } };
manager.track(resource, 'world');
manager.releaseWorld();
manager.releaseWorld();
assert.equal(disposed, 1);

assert.equal(MAP_TYPES.length, 5);
for (const type of MAP_TYPES) {
  const first = buildHydrology(1234, type.id);
  const second = buildHydrology(1234, type.id);
  assert.deepEqual(first.heights, second.heights, `${type.id}: terrain must be deterministic`);
  assert.deepEqual(first.domain, second.domain, `${type.id}: nav domains must be deterministic`);
  assert.equal(first.domain.length, 256 * 256);
  assert.equal(first.flowTex.data.length, 128 * 128 * 4);
  assert(first.domain.every((d) => d <= 3));
  assert.equal(first.fords.length, type.fords);
  assert.equal(first.sacredSites.length, 3, `${type.id}: three sacred sites`);
  assert.deepEqual(first.sacredSites, second.sacredSites, `${type.id}: sacred sites deterministic`);
  for (let i = 0; i < first.sacredSites.length; i++) for (let j = 0; j < i; j++)
    assert(Math.hypot(first.sacredSites[i].x - first.sacredSites[j].x, first.sacredSites[i].z - first.sacredSites[j].z) >= 25);
}
const classic = generateWorld(1234);
assert.equal(classic.mapType, 'classic');
const experimental = generateWorld(1234, { mapType: 'confluence' });
assert.equal(experimental.mapType, 'confluence');
assert.equal(experimental.fords.length, 3);
assert(experimental.nav.domain instanceof Uint8Array);
console.log('OVERHAUL FOUNDATION CHECKS PASSED');
