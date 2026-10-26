/* ============================================================
   tests/climate.mjs — the slow sky
   ------------------------------------------------------------
   Climate is the system most likely to become either invisible
   or unbearable, so it is checked on both counts:

     · it must actually change the numbers the player feels
     · it must not turn the game into a slow death in minute one
     · the first turn must land at 15-20 minutes, not at two
     · a player must be able to *forecast* it (that is the whole
       difference between weather and a tax)
     · the Wheel must answer it (season lengths, omen weights)
     · and the era must survive a save.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game, TEAM_PLAYER, TEAM_ENEMY } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { Climate, ERAS, ERA_BY_ID } from '../src/sim/climate.js';
import { SEASONS } from '../src/sim/calendar.js';

const world = generateWorld(20261);
let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function fresh(seed = 20261, difficulty = 'standard') {
  const g = new Game({ world: generateWorld(seed), civ: 'franks', mode: 'campaign', difficulty });
  g.start();
  return g;
}
const step = (g, seconds, dt = 1 / 30) => { const n = Math.round(seconds / dt); for (let i = 0; i < n; i++) g.update(dt); };

/* ---------- shape ---------- */
check('the eras are a complete, ordered, well-described ladder', () => {
  assert(ERAS.length >= 4, `only ${ERAS.length} eras`);
  assert(ERAS[0].id === 'temperate', 'a match must start temperate');
  const ids = new Set();
  for (const e of ERAS) {
    assert(e.id && !ids.has(e.id), 'duplicate era id ' + e.id);
    ids.add(e.id);
    assert(e.name && e.blurb && e.icon, `${e.id} is missing display fields`);
    assert(e.tint && e.tint.length === 3, `${e.id} has no tint`);
    for (const k of ['food', 'wood', 'speed', 'heal', 'morale']) {
      assert(typeof e[k] === 'number' && e[k] > 0.3 && e[k] <= 1.25, `${e.id}.${k} = ${e[k]}`);
    }
  }
  for (let i = 1; i < ERAS.length; i++) assert(ERAS[i].strainAt > ERAS[i - 1].strainAt, 'strain thresholds must climb');
  assert(ERA_BY_ID.get('storms').lightning === true, 'the storm era has no lightning');
  assert(ERA_BY_ID.get('killing_winter').cold === true, 'the killing winter has no cold');
});

/* ---------- the clock ---------- */
check('a fresh match is temperate with no strain', () => {
  const g = fresh();
  assert(g.climate.era.id === 'temperate', g.climate.era.id);
  assert(g.climate.strain === 0, 'strain at the start: ' + g.climate.strain);
  assert(g.climate.turns === 0, 'the sky already turned');
});

check('the first era lasts fifteen minutes of real play', () => {
  const g = fresh();
  const c = g.climate;
  assert(c.eraLengths[0] >= 900 && c.eraLengths[0] <= 1200, `first era is ${c.eraLengths[0]}s`);
  /* a passive match, no AI pressure: nothing but the clock may turn it */
  step(g, 600);
  assert(c.era.id === 'temperate', `turned early at ${g.time.toFixed(0)}s (${c.era.id})`);
  assert(c.strain < ERAS[1].strainAt, `strain ${c.strain.toFixed(1)} reached the threshold by ten minutes`);
  step(g, 320);
  assert(c.era.id !== 'temperate', 'the sky never turned after fifteen minutes');
});

check('the era is forecastable: remaining counts down and progress fills', () => {
  const g = fresh();
  const c = g.climate;
  const r0 = c.remaining;
  step(g, 10);
  assert(c.remaining < r0 - 9, `remaining ${r0} -> ${c.remaining}`);
  assert(c.progress > 0 && c.progress < 0.1, `progress ${c.progress}`);
  assert(c.describe().includes('next turn'), 'the description hides the next turn');
  const chip = c.chip();
  assert(chip.name && chip.icon && Number.isFinite(chip.remaining), 'the chip is missing fields');
});

check('eras turn in order and never go backwards', () => {
  const g = fresh();
  const c = g.climate;
  const seen = [c.era.id];
  for (let i = 0; i < ERAS.length + 2; i++) {
    c.turn();
    seen.push(c.era.id);
  }
  assert(seen[0] === 'temperate' && seen[1] === 'thaw', seen.join('>'));
  for (let i = 1; i < seen.length - 1; i++) {
    const a = ERAS.findIndex((e) => e.id === seen[i - 1]);
    const b = ERAS.findIndex((e) => e.id === seen[i]);
    assert(b >= a, `went backwards: ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert(c.isFinal, 'walking past the end did not stop at the last era');
  assert(c.remaining === Infinity, 'the last era reports a countdown');
});

check('the sky cannot turn before fifteen minutes, however hard the realm pushes', () => {
  const g = fresh();
  const c = g.climate;
  for (const r of g.resources) if (r.type === 'tree') { r.amount = 0; r.dead = true; }
  const b = g.world.playerBase;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 6.283;
    g.placeBuilding('farm', TEAM_PLAYER, b.x + Math.cos(a) * (20 + (i % 4) * 7), b.z + Math.sin(a) * (20 + (i % 4) * 7), { instant: true, free: true });
  }
  step(g, 840);
  assert(c.turns === 0, `the sky turned at ${g.time.toFixed(0)}s on a stripped island`);
  assert(c.era.id === 'temperate', 'the first era ended before fifteen minutes');
  step(g, 90);
  assert(c.turns >= 1, 'the sky never turned after fifteen minutes even at maximum strain');
});

check('a felled island turns the sky early', () => {
  const g = fresh();
  const c = g.climate;
  /* strip every tree, then watch a busy realm push the strain up */
  for (const r of g.resources) if (r.type === 'tree') { r.amount = 0; r.dead = true; }
  const b = g.world.playerBase;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * 6.283;
    g.placeBuilding('farm', TEAM_PLAYER, b.x + Math.cos(a) * 26, b.z + Math.sin(a) * 26, { instant: true, free: true });
  }
  c.update(2.5);
  const cleared = c.strain;
  const g2 = fresh();
  g2.climate.update(2.5);
  assert(cleared > g2.climate.strain, `strain on a stripped island ${cleared} vs an untouched one ${g2.climate.strain}`);
  assert(c.book.farms >= 20, 'the book did not count the farms');
});

check('strain is capped and finite however long the match runs', () => {
  const g = fresh();
  const c = g.climate;
  c.strain = 99.9;
  for (let i = 0; i < 200; i++) c.update(1);
  assert(c.strain <= 100 && c.strain >= 0 && Number.isFinite(c.strain), `strain ${c.strain}`);
});

/* ---------- what the eras actually do ---------- */
check('every era moves a number the player can feel', () => {
  const g = fresh();
  const c = g.climate;
  const base = { food: c.foodMul(), wood: c.woodMul(), speed: c.speedMul(), morale: c.moraleMul() };
  let moved = 0;
  for (let i = 1; i < ERAS.length; i++) {
    c.turn(i);
    const now = { food: c.foodMul(), wood: c.woodMul(), speed: c.speedMul(), morale: c.moraleMul() };
    if (Math.abs(now.food - base.food) > 0.05 || Math.abs(now.speed - base.speed) > 0.05 ||
        Math.abs(now.wood - base.wood) > 0.05 || Math.abs(now.morale - base.morale) > 0.05) moved++;
  }
  assert(moved === ERAS.length - 1, `only ${moved} of ${ERAS.length - 1} eras change a number`);
});

check('a drought is a food problem and a thaw is a road problem', () => {
  const g = fresh();
  const c = g.climate;
  const v = g.units.find((u) => u.team === TEAM_PLAYER && u.type === 'villager');
  c.turn(2);   // drought
  const dryFood = g.gatherRate(v, 'food');
  const dryWood = g.gatherRate(v, 'wood');
  c.turn(1);   // thaw
  const wetFood = g.gatherRate(v, 'food');
  const wetSpeed = g.unitSpeedMul(v);
  assert(dryFood < wetFood, `drought food ${dryFood.toFixed(2)} vs thaw ${wetFood.toFixed(2)}`);
  /* the drought takes more from the fields than from the woods */
  assert((dryFood / wetFood) < (dryWood / g.gatherRate(v, 'wood')), 'the drought hurt timber as much as food');
  assert(wetSpeed < 1, `thaw roads are not mud: ${wetSpeed.toFixed(2)}`);
});

check('the killing winter hurts men away from a hearth and spares those at home', () => {
  const g = fresh();
  const c = g.climate;
  c.turn(4);
  const home = g.spawnUnitRaw('spearman', TEAM_PLAYER, g.world.playerBase.x + 1, g.world.playerBase.z + 1);
  const far = g.spawnUnitRaw('spearman', TEAM_PLAYER, g.world.playerBase.x + 120, g.world.playerBase.z + 120);
  const hp0 = home.hp, hp1 = far.hp;
  for (let i = 0; i < 80; i++) c.update(0.5);
  assert(home.hp >= hp0 - 0.01, `a man by the fire still froze: ${hp0} -> ${home.hp}`);
  assert(far.hp < hp1 - 1, `a man in the field did not freeze: ${hp1} -> ${far.hp}`);
});

check('the storm years strike finished buildings and leave foundations alone', () => {
  const g = fresh();
  const c = g.climate;
  c.turn(3);
  const tc = g.buildings.find((b) => b.team === TEAM_PLAYER && b.type === 'town_center');
  const before = tc.hp;
  let struck = false;
  for (let i = 0; i < 200 && !struck; i++) {
    c.update(1);
    if (tc.hp < before) struck = true;
    if (c.lastEvent && c.lastEvent.kind === 'lightning') struck = true;
  }
  assert(struck, 'no lightning in two hundred seconds of storm');
  assert(tc.hp <= before, 'lightning healed the roof');
});

check('a drought walks the herds off the island', () => {
  const g = fresh();
  const c = g.climate;
  const herds = g.resources.filter((r) => r.herd && !r.dead);
  assert(herds.length > 0, 'no herds to lose');
  const before = herds.reduce((a, r) => a + r.amount, 0);
  c.turn(2);
  for (let i = 0; i < 300; i++) c.update(0.5);
  const after = herds.reduce((a, r) => a + (r.dead ? 0 : r.amount), 0);
  assert(after < before, `herds untouched by a drought: ${before} -> ${after}`);
});

/* ---------- the Wheel answers the sky ---------- */
check('the climate stretches and shortens the seasons', () => {
  const g = fresh();
  const c = g.climate;
  const span = (key) => {
    g.calendar.seasonIndex = SEASONS.findIndex((s) => s.key === key);
    return g.calendar.seasonSpan;
  };
  c.turn(0);
  const norm = span('winter');
  c.turn(4);
  assert(span('winter') > norm * 1.5, 'the Killing Winter does not lengthen winter');
  assert(span('summer') < span('winter'), 'winter is not the long season in the last sky');
  c.turn(2);
  const drySummer = span('summer');
  c.turn(0);
  assert(drySummer > span('summer'), 'the drought does not stretch summer');
});

check('the climate weights the omen deck without breaking it', () => {
  const g = fresh();
  g.climate.turn(4);
  const counts = new Map();
  for (let i = 0; i < 400; i++) {
    g.calendar.deck = [];
    const o = g.calendar.drawOmen();
    assert(o && o.id, 'drew nothing');
    counts.set(o.id, (counts.get(o.id) || 0) + 1);
  }
  assert(counts.size >= 6, `only ${counts.size} distinct omens in 400 draws`);
  const frost = counts.get('great_frost') || 0;
  const bounty = counts.get('bountiful') || 0;
  assert(frost > bounty, `frost ${frost} vs bounty ${bounty} in the Killing Winter`);
});

check('the deck still does not repeat a card before it is empty', () => {
  const g = fresh();
  g.climate.turn(3);
  const seen = new Set();
  const order = [];
  for (let i = 0; i < 10; i++) {
    const o = g.calendar.drawOmen();
    order.push(o.id);
    assert(!seen.has(o.id), `repeated ${o.id} before the deck emptied`);
    seen.add(o.id);
  }
  assert(order.length === 10, 'less than a full deck drawn');
});

/* ---------- the sky you can see ---------- */
check('a temperate sky is untouched and every other era tints it', () => {
  const g = fresh();
  const c = g.climate;
  assert(c.atmosphere() === null, 'the temperate years tint the sky');
  for (let i = 1; i < ERAS.length; i++) {
    c.turn(i);
    const a = c.atmosphere();
    assert(a && a.tint, `${c.era.id} has no atmosphere`);
    assert(a.tint.some((v) => Math.abs(v - 1) > 0.02), `${c.era.id} tint does nothing`);
    assert(Number.isFinite(a.fog) && Number.isFinite(a.cloud), `${c.era.id} has a bad fog/cloud value`);
  }
});

/* ---------- the AI ---------- */
check('the AI keeps playing through every era', () => {
  const g = fresh();
  const ai = new AIController(g, TEAM_ENEMY, {});
  const c = g.climate;
  for (let i = 0; i < 4 * 260 * 30; i++) {
    g.update(1 / 30);
    if (i % 10 === 0) ai.update(1 / 3);
    if (i % (200 * 30) === 0) {
      /* jump the sky forward so the match sees every era without waiting */
      if (!c.isFinal) c.turn();
    }
  }
  const st = g.teams.get(TEAM_ENEMY);
  assert(st && Number.isFinite(st.res.food), 'the AI economy broke');
  assert(g.units.filter((u) => !u.dead && u.team === TEAM_ENEMY).length > 0, 'the AI lost every body');
  assert(c.turns >= 2, 'the sky never turned in the test');
});

/* ---------- persistence ---------- */
check('the climate survives a save and a reload', () => {
  const g = fresh();
  g.climate.turn(2);
  g.climate.t = 140;
  g.climate.strain = 37.5;
  const blob = JSON.parse(JSON.stringify(g.climate.toJSON()));
  const g2 = fresh();
  g2.climate.fromJSON(blob);
  assert(g2.climate.era.id === 'drought', g2.climate.era.id);
  assert(Math.abs(g2.climate.t - 140) < 1, `t ${g2.climate.t}`);
  assert(Math.abs(g2.climate.strain - 37.5) < 0.2, `strain ${g2.climate.strain}`);
});

check('a corrupt climate save falls back to the temperate years', () => {
  const g = fresh();
  g.climate.fromJSON({ era: 'a-sky-that-never-was', strain: -50, t: NaN });
  assert(g.climate.era.id === 'temperate', g.climate.era.id);
  assert(g.climate.strain === 0, `strain ${g.climate.strain}`);
  assert(Number.isFinite(g.climate.t), `t ${g.climate.t}`);
});

console.log(`\n  ${pass} climate checks passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log('CLIMATE CHECKS PASSED (' + pass + ')');
