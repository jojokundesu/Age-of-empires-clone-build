/* ============================================================
   tests/realm.mjs — the Crown's Standing
   ------------------------------------------------------------
   The realm is the only system in the game that can *hurt* the
   player for playing well, so it is the one that has to be
   pinned down hardest:

     · the ledger must be honest (every line is a real input, the
       target must move when the line says it does)
     · the tax must be a trade, not a free number
     · unrest must accumulate only below the line, and unwind above
     · a rising must actually field rebels, and they must actually
       be hostile to the crown that raised them -- and *not* to
       the other crown, which is not their war
     · the other crown must be able to hit them and then be
       remembered for it (the grudge)
     · a beaten estate must not rise again immediately (cooldown)
     · the AI must play the same rules (its taxes move, its feasts
       fire, its commons can rise)
     · and it must all survive a save.
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game, TEAM_PLAYER, TEAM_ENEMY, TEAM_NEUTRAL } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';
import { Realm, TAX_RATES, BANDS, bandOf, TEAM_REBEL_P, TEAM_REBEL_E, crownOfRebel, rebelTeamOf } from '../src/sim/realm.js';
import { UNIT_DEFS } from '../src/sim/data.js';

const world = generateWorld(20261);
let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function fresh(seed = 20261, difficulty = 'standard', mode = 'campaign') {
  const g = new Game({ world: generateWorld(seed), civ: 'franks', mode, difficulty });
  g.start();
  return g;
}
const step = (g, seconds, dt = 1 / 30) => { const n = Math.round(seconds / dt); for (let i = 0; i < n; i++) g.update(dt); };

/* ---------- the shape of the data ---------- */
check('the tax table is a real trade at every setting', () => {
  assert(TAX_RATES.length === 3, `expected three rates, got ${TAX_RATES.length}`);
  const byId = new Map(TAX_RATES.map((t) => [t.id, t]));
  for (const t of TAX_RATES) {
    assert(t.name && t.blurb && t.icon, `${t.id} is missing display fields`);
    assert(t.gold > 0, `${t.id} brings in no gold`);
  }
  const m = byId.get('merciful'), f = byId.get('fair'), h = byId.get('heavy');
  assert(m.gold < f.gold && f.gold < h.gold, 'gold must rise with the rate');
  assert(m.commons > f.commons && f.commons > h.commons, 'the commons must hate the rate that pays');
  assert(m.nobles < f.nobles && f.nobles < h.nobles, 'the nobility must like the rate that pays');
  /* and no rate may be strictly better on both axes */
  assert(!(m.gold >= h.gold && m.commons >= h.commons), 'merciful dominates');
});

check('bands are ordered worst to best and cover the whole bar', () => {
  const ids = BANDS.map((b) => b.id);
  assert(ids[0] === 'devoted' && ids[ids.length - 1] === 'hostile', ids.join(','));
  for (let v = 0; v <= 100; v++) {
    const b = bandOf(v);
    assert(b && b.name, 'no band at ' + v);
  }
  assert(bandOf(0).id === 'hostile' && bandOf(100).id === 'devoted', 'band ends wrong');
});

check('a new realm starts uneasy-but-standing, in every mode', () => {
  for (const mode of ['campaign', 'regicide', 'sandbox']) {
    const g = fresh(20261, mode === 'sandbox' ? 'sandbox' : 'standard', mode);
    const s = g.realm.state(TEAM_PLAYER);
    assert(s.commons > 40 && s.commons < 80, `${mode}: commons starts at ${s.commons}`);
    assert(s.nobles > 40 && s.nobles < 80, `${mode}: nobles starts at ${s.nobles}`);
  }
});

/* ---------- the ledger ---------- */
check('every ledger line has a label, an icon and a non-zero value', () => {
  const g = fresh();
  const led = g.realm.ledger(TEAM_PLAYER);
  for (const side of ['commons', 'nobles']) {
    assert(led[side].length > 1, `${side} has ${led[side].length} lines`);
    for (const l of led[side]) {
      assert(l.label && typeof l.label === 'string', `${side}: an unlabelled line`);
      assert(typeof l.value === 'number' && Math.abs(l.value) >= 0.05, `${side}: zero line ${l.label}`);
      assert(l.icon, `${side}: ${l.label} has no icon`);
    }
  }
});

check('building houses raises the commons target', () => {
  const g = fresh();
  const before = g.realm.ledger(TEAM_PLAYER).targetC;
  const base = g.world.playerBase;
  for (let i = 0; i < 3; i++) {
    const b = g.placeBuilding('house', TEAM_PLAYER, base.x - 16 + i * 5, base.z + 14, { instant: true, free: true });
    assert(b, 'could not place house ' + i);
  }
  const after = g.realm.ledger(TEAM_PLAYER).targetC;
  assert(after > before + 1.5, `houses: ${before.toFixed(1)} -> ${after.toFixed(1)}`);
});

check('an empty granary lowers it, and so does crowding', () => {
  const g = fresh();
  const base = g.realm.ledger(TEAM_PLAYER).targetC;
  g.teams.get(TEAM_PLAYER).res.food = 12;
  const hungry = g.realm.ledger(TEAM_PLAYER).targetC;
  assert(hungry < base - 3, `hunger: ${base.toFixed(1)} -> ${hungry.toFixed(1)}`);
  g.teams.get(TEAM_PLAYER).res.food = 400;
  const st = g.teams.get(TEAM_PLAYER);
  st.popUsed = st.popCap;
  const crowded = g.realm.ledger(TEAM_PLAYER).targetC;
  assert(crowded < base - 3, `crowding: ${base.toFixed(1)} -> ${crowded.toFixed(1)}`);
});

check('the tax line is in the ledger and it points the way the dial does', () => {
  const g = fresh();
  g.realm.setTax(TEAM_PLAYER, 'merciful');
  const kind = g.realm.ledger(TEAM_PLAYER).targetC;
  g.realm.setTax(TEAM_PLAYER, 'heavy');
  const harsh = g.realm.ledger(TEAM_PLAYER).targetC;
  assert(kind > harsh + 4, `merciful ${kind.toFixed(1)} vs heavy ${harsh.toFixed(1)}`);
});

check('a war with graves in it lowers the target', () => {
  const g = fresh();
  const base = g.realm.ledger(TEAM_PLAYER).targetC;
  const u = g.spawnUnitRaw('spearman', TEAM_PLAYER, g.world.playerBase.x + 4, g.world.playerBase.z + 4);
  for (let i = 0; i < 6; i++) {
    const v = g.spawnUnitRaw('villager', TEAM_PLAYER, g.world.playerBase.x, g.world.playerBase.z);
    g.onUnitKilled(v, null);
  }
  assert(u && !u.dead, 'spawn failed');
  const after = g.realm.ledger(TEAM_PLAYER).targetC;
  assert(after < base - 2, `grief: ${base.toFixed(1)} -> ${after.toFixed(1)}`);
});

check('the standing chases its target instead of jumping to it', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  g.teams.get(TEAM_PLAYER).res.food = 0;
  for (let i = 0; i < 6; i++) {
    const b = g.placeBuilding('house', TEAM_PLAYER, g.world.playerBase.x - 18 + i * 4, g.world.playerBase.z + 16, { instant: true, free: true });
    g.onBuildingKilled(b, null);
  }
  const target = g.realm.ledger(TEAM_PLAYER).targetC;
  const start = s.commons;
  step(g, 1);
  const oneSecond = s.commons;
  assert(Math.abs(oneSecond - start) < Math.abs(target - start) + 0.001, 'overshot its own target');
  assert(Math.abs(oneSecond - start) > 0.01, 'did not move at all toward a far target');
  const moved = Math.abs(oneSecond - start);
  const gap = Math.abs(target - start);
  assert(moved < gap * 0.5, `a one-second step closed ${moved.toFixed(2)} of a ${gap.toFixed(1)} gap -- too fast`);
});

/* ---------- the tax itself ---------- */
check('gold arrives from the poll tax, and a heavier rate brings more', () => {
  const g = fresh();
  g.realm.setTax(TEAM_PLAYER, 'merciful');
  g.teams.get(TEAM_PLAYER).res.gold = 0;
  step(g, 10);
  const light = g.teams.get(TEAM_PLAYER).res.gold;
  const g2 = fresh();
  g2.realm.setTax(TEAM_PLAYER, 'heavy');
  g2.teams.get(TEAM_PLAYER).res.gold = 0;
  step(g2, 10);
  const heavy = g2.teams.get(TEAM_PLAYER).res.gold;
  assert(light > 0, 'merciful tax paid nothing');
  assert(heavy > light * 2, `heavy ${heavy.toFixed(1)} vs light ${light.toFixed(1)}`);
});

check('no villagers, no tax', () => {
  const g = fresh();
  for (const u of g.units) if (u.team === TEAM_PLAYER && u.type === 'villager') g.onUnitKilled(u, null);
  g.teams.get(TEAM_PLAYER).res.gold = 0;
  step(g, 6);
  assert(g.teams.get(TEAM_PLAYER).res.gold < 1, 'tax paid with no one to pay it');
});

check('a sullen commons works slower and a devoted one faster', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  const v = g.units.find((u) => u.team === TEAM_PLAYER && u.type === 'villager');
  s.commons = 90;
  const high = g.gatherRate(v, 'wood');
  s.commons = 10;
  const low = g.gatherRate(v, 'wood');
  assert(high > low * 1.1, `devoted ${high.toFixed(2)} vs sullen ${low.toFixed(2)}`);
});

check('a fully built realm with a court can actually reach a golden age', () => {
  /* The whole point of a bar that chases a target is that the target has to
     be reachable: an estate nobody can please is just a slow death sentence.
     A capital with houses, farms, faith, a castle, two markets, a university,
     a second hall, a full army and three offices -- under the fair tax and a
     clear sky -- must be able to clear the devoted line. If a future tuning
     pass makes this fail, the golden age has become unearnable. */
  const g = fresh();
  const b = g.world.playerBase;
  const ring = (type, r, c) => {
    for (let i = 0; i < c; i++) {
      const a = (i / c) * 6.283;
      g.placeBuilding(type, TEAM_PLAYER, b.x + Math.cos(a) * r, b.z + Math.sin(a) * r, { instant: true, free: true });
    }
  };
  ring('house', 15, 8); ring('house', 21, 8); ring('farm', 26, 6);
  ring('market', 12, 2); ring('barracks', 18, 2); ring('monastery', 24, 2);
  ring('castle', 22, 1); ring('stable', 28, 1); ring('university', 31, 1); ring('town_center', 34, 1);
  for (let i = 0; i < 24; i++) g.spawnUnitRaw('knight', TEAM_PLAYER, b.x + 10 + (i % 6), b.z + 10 + ((i / 6) | 0));
  g.teams.get(TEAM_PLAYER).age = 3;
  g.teams.get(TEAM_PLAYER).res.food = 600;
  g.calendar.omen = null;
  const v = g.units.find((u) => u.team === TEAM_PLAYER && u.type === 'villager');
  const monk = g.spawnUnitRaw('monk', TEAM_PLAYER, b.x + 2, b.z + 2);
  const knight = g.units.find((u) => u.type === 'knight' && u.team === TEAM_PLAYER);
  const st = g.teams.get(TEAM_PLAYER);
  st.favor = 400; st.res.gold = 900;
  g.court.appoint(TEAM_PLAYER, 'chancellor', v);
  g.court.appoint(TEAM_PLAYER, 'hierophant', monk);
  g.court.appoint(TEAM_PLAYER, 'marshal', knight);
  const led = g.realm.ledger(TEAM_PLAYER);
  assert(led.targetC >= 78, `a model capital only reaches ${led.targetC.toFixed(1)} commons`);
  assert(led.targetN >= 70, `a model capital only reaches ${led.targetN.toFixed(1)} nobility`);
});

/* ---------- the two ways a realm breaks ---------- */
check('unrest only gathers below the line, and unwinds above it', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 70;
  step(g, 4);
  assert(s.unrestC === 0, `unrest at 70: ${s.unrestC}`);
  s.commons = 10;
  step(g, 4);
  assert(s.unrestC > 1, `no unrest at 10: ${s.unrestC}`);
  const mark = s.unrestC;
  s.commons = 70;
  s.unrestC = mark;
  step(g, 4);
  assert(s.unrestC < mark, `unrest did not unwind: ${mark} -> ${s.unrestC}`);
});

check('a starving commons raises a mob, and the mob answers that crown', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 6;
  s.unrestC = 99;
  s.cooldownC = 0;
  step(g, 3);
  const mob = g.units.filter((u) => !u.dead && u.isRebel);
  assert(mob.length >= 3, `only ${mob.length} rioters`);
  for (const u of mob) {
    assert(u.team === TEAM_REBEL_P, `rioter on team ${u.team}`);
    assert(u.rebelAgainst === TEAM_PLAYER, 'rioter forgot who it rose against');
    assert(g.isHostile(TEAM_REBEL_P, TEAM_PLAYER), 'the crown cannot fight its own mob');
    assert(!g.isHostile(TEAM_REBEL_P, TEAM_ENEMY), 'the mob is fighting the other kingdom too -- it should not');
    assert(UNIT_DEFS[u.type], 'rioter has no definition');
  }
  assert(s.cooldownC > 0, 'no cooldown after a rising');
  assert(g.realm.crises >= 1, 'the rising was not counted');
});

check('a mob reaches the crown and does real damage', () => {
  const g = fresh();
  /* Clear the field first: a mob that is spoiling for a fight will fight
     the militia before it reaches the hall, which is correct behaviour but
     not what this check is about. */
  for (const u of g.units) if (u.team === TEAM_PLAYER) g.onUnitKilled(u, null);
  g.compact();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 4;
  s.unrestC = 99;
  s.cooldownC = 0;
  const tc = g.buildings.find((b) => b.type === 'town_center' && b.team === TEAM_PLAYER);
  const before = tc.hp;
  for (let i = 0; i < 30 * 60 && tc.hp >= before; i++) g.update(1 / 30);
  assert(tc.hp < before, 'the town centre was never touched');
});

check('the other crown can kick a mob, and the mob remembers', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 4; s.unrestC = 99; s.cooldownC = 0;
  step(g, 2);
  const mob = g.units.find((u) => !u.dead && u.isRebel);
  assert(mob, 'no mob to test');
  assert(!g.isHostile(TEAM_REBEL_P, TEAM_ENEMY), 'hostile before a blow was struck');
  mob.takeDamage(5, g.spawnUnitRaw('spearman', TEAM_ENEMY, mob.x + 1, mob.z + 1), 'melee');
  assert(g.isHostile(TEAM_REBEL_P, TEAM_ENEMY), 'the mob never turned on the kingdom that hit it');
});

check('putting down a mob pays the crown back in goodwill', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 4; s.unrestC = 99; s.cooldownC = 0;
  step(g, 2);
  const mob = g.units.find((u) => !u.dead && u.isRebel);
  const guard = g.spawnUnitRaw('knight', TEAM_PLAYER, mob.x + 1, mob.z + 1);
  const before = s.commons;
  g.onUnitKilled(mob, guard);
  assert(s.commons > before, `killing a rioter cost goodwill: ${before} -> ${s.commons}`);
});

check('a beaten estate cannot rise again at once', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 2; s.unrestC = 99; s.cooldownC = 0;
  step(g, 2);
  const risings = s.risenC;
  s.commons = 2; s.unrestC = 99;
  step(g, 8);
  assert(s.risenC === risings, `rose twice in eight seconds (${risings} -> ${s.risenC})`);
});

check('a hostile nobility raises a claimant with riders', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.nobles = 5;
  s.unrestN = 99;
  s.cooldownN = 0;
  step(g, 2);
  const lord = g.units.find((u) => !u.dead && u.type === 'claimant_knight');
  assert(lord, 'no claimant');
  assert(lord.team === TEAM_REBEL_P, 'claimant on the wrong team');
  assert(g.isHostile(TEAM_REBEL_P, TEAM_PLAYER), 'the crown cannot fight the claimant');
  const riders = g.units.filter((u) => !u.dead && u.isRebel && u.type === 'knight');
  assert(riders.length >= 2, `only ${riders.length} household knights`);
  assert(s.embezzle > 0, 'a conspiracy should cost the treasury');
  const income = g.realm.taxIncome(TEAM_PLAYER);
  assert(income >= 0 && Number.isFinite(income), 'tax income broke during a conspiracy');
});

check('a conspiracy halves the poll tax while it lasts', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.tax = 'heavy';
  const before = g.realm.taxIncome(TEAM_PLAYER);
  s.embezzle = 40;
  const during = g.realm.taxIncome(TEAM_PLAYER);
  assert(during < before * 0.6, `embezzlement: ${before.toFixed(2)} -> ${during.toFixed(2)}`);
});

/* ---------- carrots ---------- */
check('a feast lifts both estates and costs real food and gold', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  const st = g.teams.get(TEAM_PLAYER);
  st.res.food = 500; st.res.gold = 500;
  s.commons = 40; s.nobles = 50;
  const r = g.realm.feast(TEAM_PLAYER);
  assert(r.ok, 'feast refused: ' + r.reason);
  assert(s.commons > 50 && s.nobles > 50, `feast did nothing: ${s.commons}/${s.nobles}`);
  assert(st.res.food < 500 && st.res.gold < 500, 'the feast was free');
  const again = g.realm.feast(TEAM_PLAYER);
  assert(!again.ok, 'two feasts in a row');
});

check('endowments lift the nobility and pay favour', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  const st = g.teams.get(TEAM_PLAYER);
  st.res.gold = 600;
  s.nobles = 40;
  const before = st.favor;
  const r = g.realm.endow(TEAM_PLAYER);
  assert(r.ok, 'endowment refused: ' + r.reason);
  assert(s.nobles > 48, 'no noble lift');
  assert(st.favor > before, 'no favour from the endowment');
});

check('both estates devoted starts a golden age, and it can end', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  /* A golden age is *earned*: the standing chases a target built from the
     state of the realm, so simply writing 92 into the bar would decay before
     the six-second arm completed. Hold it there the way a thriving realm
     would, and the same code path the player meets is exercised. */
  for (let i = 0; i < 400 && !s.golden; i++) {
    s.commons = 92; s.nobles = 92;
    g.update(1 / 30);
  }
  assert(s.golden, 'no golden age at 92/92');
  const before = g.realm.gatherMul(TEAM_PLAYER);
  assert(before > 1.03, `golden age gather ${before}`);
  s.commons = 30;
  step(g, 1);
  assert(!s.golden, 'the golden age never ended');
  assert(s.goldenCd > 0, 'no cooldown after a golden age');
});

/* ---------- the realm and the rest of the sim ---------- */
check('realm state survives a save and a reload', () => {
  const g = fresh();
  const s = g.realm.state(TEAM_PLAYER);
  s.commons = 71.5; s.nobles = 33.25; s.tax = 'heavy'; s.grief = 4.5; s.glory = 2;
  s.unrestN = 40; s.golden = true; s.risenC = 2;
  const blob = JSON.parse(JSON.stringify(g.realm.toJSON()));
  const g2 = fresh();
  g2.realm.fromJSON(blob);
  const t = g2.realm.state(TEAM_PLAYER);
  assert(Math.abs(t.commons - 71.5) < 0.2, `commons ${t.commons}`);
  assert(Math.abs(t.nobles - 33.25) < 0.2, `nobles ${t.nobles}`);
  assert(t.tax === 'heavy', 'tax lost');
  assert(t.grief === 4.5, 'grief lost');
  assert(t.golden === true, 'golden age lost');
  assert(g2.realm.crises === g.realm.crises, 'crisis count lost');
});

check('a corrupt save cannot put an estate outside its bar', () => {
  const g = fresh();
  g.realm.fromJSON({ teams: { 1: { commons: 900, nobles: -400, tax: 'nonsense' }, 2: { commons: NaN } } });
  const s = g.realm.state(TEAM_PLAYER);
  assert(s.commons === 100, `clamped to ${s.commons}`);
  assert(s.nobles === 0, `clamped to ${s.nobles}`);
  assert(s.tax === 'fair', `bad tax id kept as ${s.tax}`);
  const e = g.realm.state(TEAM_ENEMY);
  assert(Number.isFinite(e.commons) && e.commons >= 0 && e.commons <= 100, 'NaN leaked in');
});

check('neutral and rebel teams never read as a realm', () => {
  const g = fresh();
  assert(!g.realm.has(TEAM_NEUTRAL), 'the shrine has a realm');
  assert(g.realm.state(TEAM_REBEL_P).empty === true, 'a rebel warband has a realm');
  assert(g.realm.gatherMul(TEAM_REBEL_P) === 1, 'a rebel warband has an economy');
  assert(g.realm.taxIncome(TEAM_NEUTRAL) === 0, 'neutral team pays tax');
});

check('the AI sets a tax, and can throw a feast', () => {
  const g = fresh();
  const ai = new AIController(g, TEAM_ENEMY, {});
  const s = g.realm.state(TEAM_ENEMY);
  g.teams.get(TEAM_ENEMY).res.gold = 40;
  s.commons = 70;
  ai.manageRealm(g.teams.get(TEAM_ENEMY), 1);
  assert(s.tax === 'heavy', `AI left its tax at ${s.tax} with 40 gold`);
  g.teams.get(TEAM_ENEMY).res.gold = 400;
  g.teams.get(TEAM_ENEMY).res.food = 400;
  s.commons = 20;
  s.feastCd = 0;
  ai.manageRealm(g.teams.get(TEAM_ENEMY), 1);
  assert(s.feastCd > 0, 'the AI let its commons starve next to a full treasury');
});

check('the AI throws its army at its own mob', () => {
  const g = fresh();
  const ai = new AIController(g, TEAM_ENEMY, {});
  const s = g.realm.state(TEAM_ENEMY);
  s.commons = 2; s.unrestC = 99; s.cooldownC = 0;
  step(g, 3);
  const mob = g.units.find((u) => !u.dead && u.isRebel && u.rebelAgainst === TEAM_ENEMY);
  assert(mob, 'the AI never rose');
  /* a garrison worth the name: at three seconds in the AI has villagers */
  const knight = g.spawnUnitRaw('knight', TEAM_ENEMY, g.world.enemyBase.x + 3, g.world.enemyBase.z + 3);
  assert(knight, 'could not raise a knight for the AI');
  ai.manageRealm(g.teams.get(TEAM_ENEMY), 1);
  /* the AI sends everything it has at the *nearest* rioter, so check any */
  const defenders = g.units.filter((u) => u.team === TEAM_ENEMY && u.target && u.target.isRebel);
  assert(defenders.length > 0, 'the AI ignored the mob in its own base');
});

/* ---------- diplomacy plumbing ---------- */
check('hostility is symmetric and excludes the innocent', () => {
  const g = fresh();
  assert(g.isHostile(TEAM_PLAYER, TEAM_ENEMY), 'the two crowns are friends');
  assert(g.isHostile(TEAM_ENEMY, TEAM_PLAYER), 'hostility is one-way');
  assert(!g.isHostile(TEAM_PLAYER, TEAM_PLAYER), 'a crown fights itself');
  assert(!g.isHostile(TEAM_PLAYER, TEAM_NEUTRAL), 'a crown fights a shrine');
  assert(!g.isHostile(TEAM_NEUTRAL, TEAM_ENEMY), 'a shrine fights a crown');
  assert(crownOfRebel(TEAM_REBEL_P) === TEAM_PLAYER && crownOfRebel(TEAM_REBEL_E) === TEAM_ENEMY, 'rebel crowns wrong');
  assert(rebelTeamOf(TEAM_PLAYER) === TEAM_REBEL_P && rebelTeamOf(TEAM_ENEMY) === TEAM_REBEL_E, 'rebel teams wrong');
});

check('rebels never fight each other', () => {
  const g = fresh();
  assert(!g.isHostile(TEAM_REBEL_P, TEAM_REBEL_E), 'two risings are at war');
});

check('the grudge is bounded and survives being remembered', () => {
  const g = fresh();
  for (let i = 0; i < 40; i++) {
    const v = g.spawnUnitRaw('mob_rioter', TEAM_REBEL_P, g.world.playerBase.x, g.world.playerBase.z);
    g.noteAttack(v, { team: TEAM_ENEMY + i });
  }
  const set = g.rebelGrudge.get(TEAM_REBEL_P);
  assert(set && set.size <= 8, `grudge grew to ${set && set.size}`);
});

/* ---------- a real match, played out ---------- */
check('a two-minute AI match keeps both realms sane and pays its taxes', () => {
  const g = fresh();
  const ai = new AIController(g, TEAM_ENEMY, {});
  for (let i = 0; i < 120 * 30; i++) {
    g.update(1 / 30);
    if (i % 10 === 0) ai.update(1 / 3);
  }
  for (const team of [TEAM_PLAYER, TEAM_ENEMY]) {
    const s = g.realm.state(team);
    assert(Number.isFinite(s.commons) && s.commons >= 0 && s.commons <= 100, `team ${team} commons ${s.commons}`);
    assert(Number.isFinite(s.nobles) && s.nobles >= 0 && s.nobles <= 100, `team ${team} nobles ${s.nobles}`);
    const led = g.realm.ledger(team);
    assert(Number.isFinite(led.targetC) && led.targetC >= 0 && led.targetC <= 100, 'target C out of range');
    assert(Number.isFinite(led.targetN) && led.targetN >= 0 && led.targetN <= 100, 'target N out of range');
  }
  const gold = g.teams.get(TEAM_PLAYER).res.gold;
  assert(gold >= 0 && Number.isFinite(gold), `player gold ${gold}`);
});

console.log(`\n  ${pass} realm checks passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log('REALM CHECKS PASSED (' + pass + ')');
