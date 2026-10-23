/* Interface contracts between the three halves of the game.

   The UI, the input layer and the simulation are written separately, so the
   expensive bugs are the ones where one side calls something the other never
   grew: a button that throws when tapped, a state id that does not exist, a
   HUD node that is null on every frame. Static checks catch all of those in a
   second, on a phone-less CI box, before a release is cut.                  */
import { readFileSync } from 'node:fs';
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const GAME_LAYER = ['src/game/ui.js', 'src/game/input.js', 'src/game/menu.js', 'src/main.js'];

const gameProto = new Set(Object.getOwnPropertyNames(Game.prototype));
const gameStatics = new Set(Object.getOwnPropertyNames(Game));

/** Collect `game.foo(` / `g.foo(` calls that look like sim API use. */
function callsIntoGame(src) {
  const out = new Map();
  const re = /\b(?:this\.)?\bg(?:ame)?\.([a-zA-Z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    out.set(name, (out.get(name) || 0) + 1);
  }
  return out;
}

check('every simulation method the UI calls exists on Game', () => {
  const missing = [];
  const canvasFns = new Set([
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'fillRect',
    'strokeRect', 'createLinearGradient', 'createRadialGradient', 'save', 'restore',
    'translate', 'scale', 'rotate', 'clearRect', 'drawImage', 'fillText', 'putImageData',
    'setLineDash', 'measureText', 'roundRect', 'ellipse', 'rect', 'clip', 'quadraticCurveTo',
    'bezierCurveTo', 'createPattern', 'getImageData', 'setTransform', 'resetTransform'
  ]);
  for (const f of GAME_LAYER) {
    const src = read(f);
    for (const name of callsIntoGame(src).keys()) {
      if (canvasFns.has(name)) continue;
      if (gameProto.has(name) || gameStatics.has(name)) continue;
      missing.push(`${f} → game.${name}()`);
    }
  }
  assert(!missing.length, 'missing: ' + missing.join(', '));
});

check('unit and building state literals all exist in STATE', () => {
  const valid = new Set(Object.values(STATE));
  const numeric = /\bstate\s*=\s*(\d+)/g;
  const stringly = /\bstate\s*(?:===?|!==?)\s*['"]([a-z]+)['"]/g;
  const bad = [];
  for (const f of GAME_LAYER.concat(['src/sim/ai.js', 'src/sim/game.js', 'src/sim/entities.js'])) {
    const src = read(f);
    let m;
    while ((m = numeric.exec(src))) bad.push(`${f}: numeric state ${m[1]}`);
    while ((m = stringly.exec(src))) {
      if (!valid.has(m[1])) bad.push(`${f}: unknown state "${m[1]}"`);
    }
  }
  assert(!bad.length, bad.join(', '));
});

check('STATE values are unique strings', () => {
  const seen = new Map();
  for (const [k, v] of Object.entries(STATE)) {
    assert(typeof v === 'string', `STATE.${k} is ${typeof v}`);
    assert(!seen.has(v), `STATE.${k} duplicates STATE.${seen.get(v)}`);
    seen.set(v, k);
  }
});

check('every HUD id the UI binds exists in index.html', () => {
  const html = read('index.html');
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  const ui = read('src/game/ui.js');
  const block = ui.slice(ui.indexOf('const ids = ['), ui.indexOf('];', ui.indexOf('const ids = [')));
  const wanted = [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert(wanted.length > 40, `only ${wanted.length} ids declared`);
  const missing = wanted.filter((id) => !ids.has(id));
  assert(!missing.length, 'not in index.html: ' + missing.join(', '));
});

check('every data-attribute the UI reads is written by some renderer', () => {
  const js = GAME_LAYER.map(read).join('\n') + read('index.html');
  const reads = [...js.matchAll(/dataset\.([a-zA-Z]+)/g)].map((m) => m[1]);
  // `civ` is read from a node that carries data-civ on the civ cards, which are
  // authored by the menu at runtime — treat it as a known dynamic attribute.
  const writes = new Set([...js.matchAll(/data-([a-z-]+)=/g)].map((m) => m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())));
  const dynamic = new Set(['key', 'index', 'civ']);
  const missing = [...new Set(reads)].filter((r) => !writes.has(r) && !dynamic.has(r));
  assert(!missing.length, 'read but never written: ' + missing.join(', '));
});

check('Game exposes the documented public surface', () => {
  const required = [
    'start', 'update', 'updateFog', 'endGame', 'checkVictory',
    'placeBuilding', 'canPlaceAt', 'canAfford', 'spend',
    'startAgeAdvance', 'activateDecree', 'marketTrade', 'marketPrice',
    'findNearestResource', 'spawnUnitRaw', 'explodeArea', 'garrisonUnit', 'convertUnit',
    'isPassable', 'walkableLine', 'unstick', 'heightAt', 'getHeightFn',
    'notify', 'marker', 'setSelection', 'popFree', 'recomputePop', 'unitCost', 'unitBuildTime',
    'refreshNav', 'markBuildingFootprint', 'buffMul', 'addBuff'
  ];
  const missing = required.filter((m) => !gameProto.has(m) && typeof Game.prototype[m] !== 'function');
  assert(!missing.length, 'missing: ' + missing.join(', '));
});

check('decrees are well formed and affordable', () => {
  const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'sandbox', difficulty: 'sandbox' });
  g.start();
  const list = g.decrees;
  assert(Array.isArray(list) && list.length >= 5, 'expected at least five decrees');
  const ids = new Set();
  for (const d of list) {
    assert(d.id && !ids.has(d.id), 'duplicate decree id ' + d.id + ' (the UI keys buttons by it)');
    ids.add(d.id);
    assert(d.name && d.desc && d.icon, `decree ${d.id} is missing display fields`);
    assert(d.cost > 0 && d.cost <= 200, `decree ${d.id} costs ${d.cost}`);
    assert(typeof d.apply === 'function', `decree ${d.id} has no apply()`);
  }
  const res = g.activateDecree(1, 'harvest');
  assert(res.ok === false, 'decree fired with no favour');
  g.teams.get(1).favor = 500;
  const ok = g.activateDecree(1, 'harvest');
  assert(ok.ok === true, 'harvest decree failed with full favour');
  assert(g.buffMul(1, 'gather') > 1.3, 'gather buff not applied');
  assert(g.activateDecree(1, 'nope').ok === false, 'unknown decree accepted');
});

check('FX presets used by the sim all exist', () => {
  const fxSrc = read('src/gfx/fx.js');
  const presets = new Set([...fxSrc.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((m) => m[1]));
  const used = new Set([...read('src/sim/game.js').matchAll(/fx\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !presets.has(u));
  assert(!missing.length, 'sim calls missing FX: ' + missing.join(', '));
});

if (fails.length) {
  console.error('\nCONTRACT CHECKS FAILED\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\nCONTRACT CHECKS PASSED (${pass})`);
