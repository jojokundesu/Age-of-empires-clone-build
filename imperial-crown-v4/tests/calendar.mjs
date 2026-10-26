/* ============================================================
   calendar.mjs — the Wheel of the Year
   ------------------------------------------------------------
   The rule under test is *the world changes the rules*:

     · four seasons, each with a real, different economy and tempo;
     · every turn of the season draws an omen from a deck that does
       not repeat until it is empty, and the omen really changes a
       number the simulation reads;
     · the wheel is deterministic from the seed, and survives a save;
     · the omens with a body count (the Frost, the Plague Winds, the
       Wolf Moon) actually kill things, and never finish a building.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game } from '../src/sim/game.js';
import { Calendar, SEASONS, OMENS, OMEN_BY_ID } from '../src/sim/calendar.js';
import { UNIT_DEFS } from '../src/sim/data.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m} (got ${a}, expected ${b})`); }
function near(a, b, tol, m) { if (Math.abs(a - b) > tol) throw new Error(`${m} (got ${a}, expected ~${b})`); }

function makeGame(seed = 5150) {
  const world = generateWorld(seed);
  const g = new Game({ world, civ: 'franks', mode: 'campaign', difficulty: 'standard', seed });
  g.start();
  g.checkVictory = () => {};
  g.running = true;
  g.worldTime = 12;
  for (const st of g.teams.values()) {
    st.res.food = st.res.wood = st.res.gold = st.res.stone = 5000;
    st.favor = 200;
    st.age = 2;
  }
  return g;
}
function placeAt(g, type, team, x, z) {
  const p = g.freeSpotNear(x, z, { radius: 0.5, def: UNIT_DEFS[type] }, 8) || [x, z];
  return g.spawnUnitRaw(type, team, p[0], p[1]);
}
/* Force a season + omen without waiting out the clock. */
function setWheel(g, seasonKey, omenId) {
  const i = SEASONS.findIndex((s) => s.key === seasonKey);
  g.calendar.seasonIndex = i < 0 ? 0 : i;
  g.calendar.t = 0;
  g.calendar.omen = omenId ? OMEN_BY_ID.get(omenId) : null;
  g.statsVersion++;
}

/* ============================================================ */
console.log('\nTHE SEASONS');
check('a match starts in Spring with an omen already drawn', () => {
  const g = makeGame();
  eq(g.calendar.season.key, 'spring', 'starts in Spring');
  eq(g.calendar.year, 1, 'year one');
  assert(g.calendar.omen, 'the first season must have an omen');
  return `${g.calendar.season.name}, omen: ${g.calendar.omen.name}`;
});

check('the four seasons are genuinely different economies', () => {
  const g = makeGame();
  const rate = (kind) => {
    const u = g.units.find((x) => x.team === 1 && x.type === 'villager');
    return g.gatherRate(u, kind);
  };
  setWheel(g, 'spring', 'none');
  g.calendar.omen = null;
  const springFood = rate('food');
  setWheel(g, 'winter', 'none');
  g.calendar.omen = null;
  const winterFood = rate('food');
  assert(springFood > winterFood * 1.4, `spring must feed far better than winter (${springFood.toFixed(2)} vs ${winterFood.toFixed(2)})`);
  setWheel(g, 'autumn', 'none');
  g.calendar.omen = null;
  const autumnWood = rate('wood');
  setWheel(g, 'spring', 'none');
  g.calendar.omen = null;
  const springWood = rate('wood');
  assert(autumnWood > springWood * 1.15, `autumn must be the timber season (${autumnWood.toFixed(2)} vs ${springWood.toFixed(2)})`);
  return `food spring ${springFood.toFixed(2)} / winter ${winterFood.toFixed(2)}; wood autumn ${autumnWood.toFixed(2)} / spring ${springWood.toFixed(2)}`;
});

check('winter slows the army and spring hurries the healing', () => {
  const g = makeGame();
  const u = placeAt(g, 'spearman', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  setWheel(g, 'summer', null); g.calendar.omen = null;
  const summer = g.unitSpeedMul(u);
  setWheel(g, 'winter', null); g.calendar.omen = null;
  const winter = g.unitSpeedMul(u);
  assert(winter < summer * 0.97, `winter is slower (${summer.toFixed(2)} → ${winter.toFixed(2)})`);
  eq(g.calendar.season.heal, 0.75, 'winter heals at three quarters');
  eq(SEASONS[0].heal, 1.25, 'spring heals at five quarters');
  return `speed ×${summer.toFixed(2)} summer, ×${winter.toFixed(2)} winter`;
});

check('autumn fills the granary once, for both sides', () => {
  const g = makeGame();
  const before1 = g.teams.get(1).res.food;
  const before2 = g.teams.get(2).res.food;
  g.calendar.seasonIndex = 1;        // summer, about to turn to autumn
  g.calendar.t = g.calendar.seasonLength - 0.01;
  g.calendar.omen = null;
  g.update(1 / 30);
  assert(g.teams.get(1).res.food > before1, 'the player got no harvest');
  assert(g.teams.get(2).res.food > before2, 'the AI got no harvest');
  return `+${Math.round(g.teams.get(1).res.food - before1)} food each`;
});

/* ============================================================ */
console.log('\nTHE WHEEL');
check('the wheel turns a full year and comes back to Spring', () => {
  const g = makeGame();
  g.calendar.seasonLength = 2;
  const seen = [];
  for (let i = 0; i < 8 * 30; i++) {
    g.update(1 / 30);
    const k = g.calendar.season.key;
    if (seen[seen.length - 1] !== k) seen.push(k);
  }
  const order = ['spring', 'summer', 'autumn', 'winter'];
  eq(seen.slice(0, 5).join(','), order.concat('spring').join(','), 'the year runs in order and repeats: ' + seen.slice(0, 6).join(' '));
  assert(g.calendar.year >= 2, `the year counter advanced (${g.calendar.year})`);
  return seen.slice(0, 6).join(' → ');
});

check('the omen deck never repeats a card until it is empty', () => {
  const g = makeGame();
  const cal = g.calendar;
  cal.deck = [];
  cal._rng = null;
  const drawn = [];
  for (let i = 0; i < OMENS.length; i++) drawn.push(cal.drawOmen().id);
  eq(new Set(drawn).size, OMENS.length, 'every omen appears exactly once per deck: ' + drawn.join(','));
  const next = cal.drawOmen().id;
  assert(OMENS.some((o) => o.id === next), 'a fresh deck still deals');
  return `${drawn.length} omens, no repeats`;
});

check('the wheel is deterministic from the seed', () => {
  const a = new Calendar({ seed: 777, teams: new Map(), units: [], buildings: [] });
  const b = new Calendar({ seed: 777, teams: new Map(), units: [], buildings: [] });
  const c = new Calendar({ seed: 778, teams: new Map(), units: [], buildings: [] });
  const seq = (cal) => { const out = []; for (let i = 0; i < 6; i++) out.push(cal.drawOmen().id); return out.join(','); };
  eq(seq(a), seq(b), 'the same seed deals the same hand');
  assert(seq(a) !== seq(c), 'a different seed deals a different hand');
  return 'seeded';
});

/* ============================================================ */
console.log('\nTHE OMENS');
check('the Red Comet makes every blow heavier and closes no wound', () => {
  const g = makeGame();
  const a = placeAt(g, 'swordsman', 1, 6, 6);
  const t = placeAt(g, 'spearman', 2, 12, 6);
  assert(a && t, 'the cast');
  setWheel(g, 'summer', null); g.calendar.omen = null;
  let hp = t.hp; a.performAttack(t, a.stats());
  const plain = hp - t.hp;
  setWheel(g, 'summer', 'red_comet');
  t.hp = t.maxHp;
  hp = t.hp; a.performAttack(t, a.stats());
  const comet = hp - t.hp;
  assert(comet > plain * 1.1, `the comet must bite (${plain.toFixed(1)} → ${comet.toFixed(1)})`);
  /* and no wound closes */
  const u = placeAt(g, 'swordsman', 1, 8, 9);
  u.hp = u.maxHp * 0.5;
  const before = u.hp;
  u.heal(20);
  eq(u.hp, before, 'healing is dead under the Red Comet');
  return `${plain.toFixed(0)} → ${comet.toFixed(0)} damage, healing sealed`;
});

check('the Iron Sky extends the bow', () => {
  const g = makeGame();
  const archer = placeAt(g, 'archer', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  assert(archer, 'the archer');
  setWheel(g, 'summer', null); g.calendar.omen = null;
  const plainRange = archer.stats().range;
  setWheel(g, 'summer', 'iron_sky');
  const omenRange = archer.stats().range;
  near(omenRange - plainRange, 2, 0.001, 'the bow reaches');
  return `range ${plainRange.toFixed(1)} → ${omenRange.toFixed(1)}`;
});

check('the Silent March trades eyes for legs', () => {
  const g = makeGame();
  const u = placeAt(g, 'spearman', 1, g.playerBase.x + 6, g.playerBase.z + 6);
  setWheel(g, 'summer', null); g.calendar.omen = null;
  const plainSight = u.stats().sight, plainSpeed = g.unitSpeedMul(u);
  setWheel(g, 'summer', 'silent_march');
  const omenSight = u.stats().sight, omenSpeed = g.unitSpeedMul(u);
  assert(omenSpeed > plainSpeed * 1.1, `faster (${plainSpeed.toFixed(2)} → ${omenSpeed.toFixed(2)})`);
  assert(omenSight < plainSight * 0.6, `blinder (${plainSight.toFixed(1)} → ${omenSight.toFixed(1)})`);
  return `×${(omenSpeed / plainSpeed).toFixed(2)} speed, ×${(omenSight / plainSight).toFixed(2)} sight`;
});

check('the Still Air makes arrows miss a third of the time', () => {
  const g = makeGame();
  const archer = placeAt(g, 'archer', 1, 6, 6);
  const dummy = placeAt(g, 'knight', 2, 20, 6);
  assert(archer && dummy, 'the cast');
  setWheel(g, 'summer', 'still_air');
  let loosed = 0;
  const realFire = g.fireProjectile.bind(g);
  g.fireProjectile = (...a) => { loosed++; return realFire(...a); };
  for (let i = 0; i < 40; i++) { archer.attackCooldown = 0; archer.performAttack(dummy, archer.stats()); }
  g.fireProjectile = realFire;
  assert(loosed > 15 && loosed < 36, `about two thirds of the shots should fly: ${loosed}/40`);
  return `${loosed}/40 arrows loosed`;
});

check('the Long Night really is longer', () => {
  const g = makeGame();
  setWheel(g, 'summer', null); g.calendar.omen = null;
  g.worldTime = 21;
  const plainRate = (() => { const w = g.worldTime; g.update(1 / 30); return g.worldTime - w; })();
  setWheel(g, 'summer', 'long_night');
  g.worldTime = 21;
  const omenRate = (() => { const w = g.worldTime; g.update(1 / 30); return g.worldTime - w; })();
  assert(omenRate > plainRate * 1.3, `the night must pass slower (${plainRate.toFixed(4)} vs ${omenRate.toFixed(4)})`);
  return `×${(omenRate / plainRate).toFixed(1)} slower after dark`;
});

check('the Great Frost cracks buildings but never finishes one', () => {
  const g = makeGame();
  setWheel(g, 'winter', 'great_frost');
  const b = g.buildings.find((x) => !x.dead && x.team === 1 && x.buildProgress >= 0.999);
  assert(b, 'the town centre');
  const hp0 = b.hp;
  for (let i = 0; i < 400; i++) g.calendar.tick(0.1);
  assert(b.hp < hp0, `the frost must bite (${hp0} → ${b.hp})`);
  assert(b.hp >= b.maxHp * 0.249, `the frost must never finish a building (${b.hp} vs ${b.maxHp * 0.25})`);
  return `${hp0.toFixed(0)} → ${b.hp.toFixed(0)} hp, floor held`;
});

check('the Plague Winds rot an army on enemy soil and spare the men at home', () => {
  const g = makeGame();
  setWheel(g, 'summer', 'plague_winds');
  const away = placeAt(g, 'swordsman', 1, g.enemyBase.x + 6, g.enemyBase.z + 6);
  const home = placeAt(g, 'swordsman', 1, g.playerBase.x + 8, g.playerBase.z + 8);
  assert(away && home, 'the cast');
  const a0 = away.hp, h0 = home.hp;
  for (let i = 0; i < 60; i++) g.calendar.tick(0.1);
  assert(away.hp < a0, `a man on enemy soil must sicken (${a0} → ${away.hp})`);
  eq(home.hp, h0, 'a man at home is untouched');
  return `${a0.toFixed(0)} → ${away.hp.toFixed(0)} away, home untouched`;
});

check('the Wolf Moon takes a straggler, never a defender', () => {
  const g = makeGame();
  setWheel(g, 'summer', 'wolf_moon');
  const defender = g.units.find((u) => !u.dead && u.team === 2 && u.def.attack > 0)
    || placeAt(g, 'spearman', 2, g.enemyBase.x + 4, g.enemyBase.z + 4);
  const straggler = placeAt(g, 'swordsman', 1, g.enemyBase.x + 30, g.enemyBase.z + 30);
  assert(straggler, 'the straggler');
  const d0 = defender.hp, s0 = straggler.hp;
  for (let i = 0; i < 300; i++) g.calendar.tick(0.1);
  assert(straggler.hp < s0, `the straggler must be bitten (${s0} → ${straggler.hp})`);
  eq(defender.hp, d0, 'a defender standing at home is not touched');
  return `${s0.toFixed(0)} → ${straggler.hp.toFixed(0)}`;
});

/* ============================================================ */
console.log('\nTHE SAVE');
check('the wheel survives a save and a reload', () => {
  const g = makeGame(999);
  for (let i = 0; i < 600; i++) g.update(1 / 20);
  const before = g.calendar.toJSON();
  const g2 = makeGame(999);
  g2.calendar.fromJSON(before);
  eq(g2.calendar.seasonIndex, before.season, 'the season came back');
  eq(g2.calendar.year, before.year, 'the year came back');
  eq(g2.calendar.omen && g2.calendar.omen.id, before.omen, 'the omen came back');
  eq(g2.calendar.t, before.t, 'the clock came back');
  /* and the deck is not reshuffled: the same hand follows */
  const nextA = g.calendar.deck[g.calendar.deck.length - 1];
  const nextB = g2.calendar.deck[g2.calendar.deck.length - 1];
  eq(nextB, nextA, 'the deck order came back');
  return `year ${before.year}, ${SEASONS[before.season].name}, ${before.omen}`;
});

check('a reload does not draw a new omen', () => {
  const g = makeGame(1234);
  g.calendar.omen = OMEN_BY_ID.get('bountiful');
  const json = g.calendar.toJSON();
  const g2 = makeGame(1234);
  g2.calendar.fromJSON(json);
  eq(g2.calendar.omen.id, 'bountiful', 'the omen was replaced on load');
  return 'stable sky';
});

/* ============================================================ */
console.log(`\n${failures.length ? `CALENDAR CHECKS FAILED (${failures.length})` : `CALENDAR CHECKS PASSED (${passed})`}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.e && f.e.message ? f.e.message : f.e}`);
  process.exit(1);
}
