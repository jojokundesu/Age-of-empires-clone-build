/* A repeatable CPU-only stress probe for v5's opt-in systems.
   This is not a GPU, browser-frame-rate or phone benchmark. */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';

function run(withOrders) {
  const world = generateWorld(20261);
  const game = new Game({ world, seed: 20261, civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
  game.start();
  const town = game.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  if (!town) throw new Error('No player town centre');
  const units = [];
  // Twelve full squads, all protecting one building: deliberately more than
  // a typical player army, so cohesion and guard scans are exercised together.
  for (let i = 0; i < 288; i++) {
    const angle = i * 2.399963, radius = 10 + (i % 24) * .7;
    units.push(game.spawnUnitRaw('swordsman', 1,
      town.x + Math.cos(angle) * radius, town.z + Math.sin(angle) * radius));
  }
  if (withOrders) {
    for (let i = 0; i < 12; i++) {
      const result = game.squads.create(units.slice(i * 24, (i + 1) * 24));
      if (!result.ok) throw new Error(result.reason);
    }
    if (game.orderGuard(units, town) !== units.length) throw new Error('Guard assignment failed');
  }
  const samples = [];
  for (let i = 0; i < 330; i++) {
    const start = performance.now();
    game.update(1 / 30);
    if (i >= 30) samples.push(performance.now() - start); // warm-up and first path planning excluded
  }
  samples.sort((a, b) => a - b);
  const average = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  return { units: game.units.length, squads: game.squads.list.length, guards: game.guards.records.size,
    mean_ms: +average.toFixed(3), p95_ms: +percentile(.95).toFixed(3), p99_ms: +percentile(.99).toFixed(3) };
}

console.log('CPU-only simulation tick probe (milliseconds; not device FPS)');
console.log('Same army, no v5 orders:', run(false));
console.log('12 squads, 288 guards:  ', run(true));
console.log('No rendering, GPU, real input or physical-device performance is measured.');
