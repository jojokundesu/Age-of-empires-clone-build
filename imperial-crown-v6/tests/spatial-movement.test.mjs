import assert from 'node:assert/strict';
import { SpatialHash } from '../src/sim/spatial.js';
import { ResourceNode } from '../src/sim/entities.js';
import { Game } from '../src/sim/game.js';
import { generateWorld } from '../src/sim/worldgen.js';

const hash = new SpatialHash(8, 72);
const game = { resourceSpatial: hash, heightAt: () => 2, isWater: () => false, rng: () => 0.5 };
const deer = new ResourceNode(game, 'deer', 7.9, 0, 100, { resKind: 'food', herd: true });
hash.insert(deer);
deer.wanderDir = 0;
deer.moveT = 2;
deer.update(0.5);
assert(deer.x > 8, 'test herd must cross a bucket');
assert(hash.query(deer.x, deer.z, 0.1).includes(deer), 'moving herd missing from new bucket');
assert(!hash.query(7.9, 0, 0.1).includes(deer), 'moving herd remains at old position');
assert.equal(hash.count, 1);
for (let i = 0; i < 100; i++) {
  const oldX = deer.x, oldZ = deer.z;
  deer.x = i % 2 ? 7.9 : 8.2;
  hash.move(deer, oldX, oldZ);
}
assert.equal(hash.count, 1, 'moving an entity must not duplicate it');
assert.equal(hash.used.length, 2, 'revisiting an emptied bucket must not grow the used list');
hash.clear();
assert.equal(hash.count, 0);
assert.equal(hash.used.length, 0);
assert.equal(hash.query(deer.x, deer.z, 1).length, 0);
hash.insert(deer);
assert(hash.query(deer.x, deer.z, 1).includes(deer), 'cleared bucket must be reusable');
{
  const g = new Game({ world: generateWorld(786), seed: 786, mode: 'campaign' });
  g.start();
  const depletedTree = g.resources.find(r => r.resKind === 'wood' && !r.dead);
  const fullTree = g.resources.find(r => r.resKind === 'wood' && r !== depletedTree && !r.dead);
  depletedTree.amount = depletedTree.maxAmount * 0.2;
  const before = depletedTree.amount, full = fullTree.amount;
  for (let i = 0; i < 30; i++) g.update(1 / 30);
  assert(Math.abs(depletedTree.amount - before - 0.45) < 1e-5, 'living depleted trees must regrow at the original rate');
  assert.equal(fullTree.amount, full, 'healthy trees must not change');
}
console.log('MOVING RESOURCE SPATIAL CHECKS PASSED');
