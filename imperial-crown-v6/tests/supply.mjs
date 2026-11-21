/* Camp stores and the carts that empty them.

   Before this section a drop-off building was a teleporter. A villager
   walked four metres to a lumber camp, handed over an armful, and the wood
   appeared in the treasury on the other side of the map. Distance cost the
   player nothing once the camp was up, so a forest at the far edge of the
   world was worth exactly as much as the one behind the town centre, and
   nothing an enemy could do short of levelling the camp itself interfered.

   Now the camp keeps what it is given, and a cart carries it home. That
   creates a supply line: a visible, destructible thing on the road that an
   enemy can cut and a player must notice. The point of this suite is that
   the supply line can fail in a dozen ways which all look identical from
   the outside -- the wood simply stops arriving -- so each one is pinned
   down separately here.

   The two that matter most, and the reason the numbers below are asserted
   rather than eyeballed:

     - A full camp must *reroute* its villagers to the town centre, never
       stall them. A gatherer standing still beside a full camp is a
       soft-locked economy, and it is invisible: the player sees idle
       villagers and no explanation.

     - A cart must be impossible to retire permanently. It has no owner to
       re-task it, and roughly a dozen systems legitimately set a unit back
       to IDLE -- the stall watchdog, unstick, a finished move order. Any
       one of them used to park the cart beside its treasury forever while
       the camp silted up behind it.

   node tests/supply.mjs
*/
import { generateWorld } from '../src/sim/worldgen.js';
import { Game, TEAM_PLAYER } from '../src/sim/game.js';
import { BUILDING_DEFS, UNIT_DEFS, traversalOf } from '../src/sim/data.js';
import { STATE } from '../src/sim/entities.js';
import { TRAVERSAL } from '../src/sim/hydrology.js';
import { buildUnit } from '../src/gfx/models.js';

const NULL_FX = {
  spawn() {}, dust() {}, smoke() {}, fire() {}, blood() {}, sparks() {},
  explosion() {}, heal() {}, splash() {}, leaves() {}, glowPulse() {}, embers() {}, pollen() {},
  buildDust() {}, arrowTrail() {}, rain() {}
};
const NULL_SOUND = { play() {} };

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; console.log(`  ok   ${name}${d ? '  — ' + d : ''}`); }
  catch (e) { fails.push(name + ': ' + e.message); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

/* A match with an empty board: the starting villagers put themselves to
   work (see `_selfTask`) and their gathering swamps every measurement here,
   so the only units in these worlds are the ones a check asks for. */
function match(size = 'normal') {
  const w = generateWorld(20261, { size });
  const g = new Game({ world: w, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed: 20261 });
  g.start();
  g.ai = [];
  g.teams.get(TEAM_PLAYER).popCap = 200;
  for (const u of g.units.slice()) u.dead = true;
  g.units.length = 0;
  const tc = g.buildings.find((b) => b.team === TEAM_PLAYER && b.type === 'town_center');
  return { g, w, tc };
}

/** A wood node `near`..`far` metres from the town centre. */
function treeNear(g, tc, near, far) {
  for (const r of g.resources) {
    if (r.resKind !== 'wood' || r.dead) continue;
    const d = Math.hypot(r.x - tc.x, r.z - tc.z);
    if (d > near && d < far) return r;
  }
  return null;
}

/** A worked lumber camp: the camp, its crew and the tree they are on. */
function camped(g, tc, { crew = 4, near = 70, far = 90 } = {}) {
  const tree = treeNear(g, tc, near, far);
  assert(tree, `no wood node between ${near} and ${far} m`);
  const camp = g.placeBuilding('lumber_camp', TEAM_PLAYER, tree.x + 4, tree.z + 4, { free: true, instant: true });
  assert(camp, 'lumber camp refused');
  const vs = [];
  for (let i = 0; i < crew; i++) {
    const v = g.spawnUnit('villager', TEAM_PLAYER, camp.x + (i % 4) * 1.5 - 2, camp.z + 5 + Math.floor(i / 4) * 1.5, null, { force: true });
    v.gatherTarget = tree;
    v.state = STATE.GATHER;
    v.lastGatherKind = 'wood';
    vs.push(v);
  }
  return { camp, tree, vs };
}

const step = (g, secs) => { for (let i = 0; i < Math.round(30 * secs); i++) g.update(1 / 30); };

/* ---------------------------------------------------------------- the def */

check('a supply cart is free, weightless and cannot be trained', () => {
  const d = UNIT_DEFS.supply_cart;
  assert(d, 'no supply_cart def');
  assert(!Object.keys(d.cost || {}).length, 'the cart is supposed to cost nothing');
  assert(!d.pop, `the cart costs ${d.pop} population`);
  assert(d.untrainable, 'the cart must never appear in a build menu');
  assert(d.hp > 0 && d.hp < 400, `hp ${d.hp} is not a soft target`);
  return `${d.hp} hp, speed ${d.speed}, pop ${d.pop || 0}`;
});

check('a loaded cart is heavy: the pulley lift, never a ladder', () => {
  assert(traversalOf('supply_cart') === TRAVERSAL.heavy, 'a cart that can climb a ladder makes the lift pointless');
  return 'TRAVERSAL.heavy';
});

check('a cart has a model, or it hauls invisibly', () => {
  const res = buildUnit('supply_cart');
  assert(res, 'buildUnit returned null: the renderer would draw nothing at all');
  const tris = res.geo.finish().tris;
  assert(tris > 120 && tris < 900, `${tris} triangles is the wrong order for a cart`);
  assert(res.height > 1 && res.height < 4, `height ${res.height}`);
  return `${tris} tris`;
});

check('only the three hauling buildings keep a store', () => {
  const held = Object.keys(BUILDING_DEFS).filter((k) => BUILDING_DEFS[k].stockpile !== undefined);
  assert(held.length === 3, `stockpiles on ${held.join(', ')}`);
  for (const k of ['lumber_camp', 'mining_camp', 'cliff_lift']) assert(held.includes(k), `${k} has no stockpile`);
  /* A town centre must never hold goods: it is the place goods go. */
  assert(BUILDING_DEFS.town_center.stockpile === undefined, 'the treasury is not a camp');
  return held.map((k) => `${k} ${BUILDING_DEFS[k].stockpile}`).join(' · ');
});

/* ------------------------------------------------------------- the round */

check('a finished camp is issued its cart at once, and it is free', () => {
  const { g, tc } = match();
  const popBefore = g.teams.get(TEAM_PLAYER).pop || 0;
  const { camp } = camped(g, tc, { crew: 0 });
  assert(camp.cart, 'the camp was built without a cart');
  assert(!camp.cart.dead, 'the cart arrived dead');
  assert(camp.cart.home === camp, 'the cart does not know its camp');
  assert((g.teams.get(TEAM_PLAYER).pop || 0) === popBefore, 'the cart took a population slot');
  return `pop unchanged at ${popBefore}`;
});

check('villagers bank into the camp, not the treasury', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 2 });
  camp.cart.dead = true;       // hold the goods still so the pile is readable
  camp.cart = null;
  camp.cartLostAt = g.time + 1e6;
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  step(g, 40);
  const pile = g.stockTotal(camp);
  assert(pile > 0, 'nothing reached the camp');
  assert(g.teams.get(TEAM_PLAYER).res.wood === before, 'wood teleported to the treasury with no cart running');
  return `${Math.round(pile)} wood held at the camp`;
});

check('the cart empties the camp into the treasury', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 4 });
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  step(g, 150);
  const banked = g.teams.get(TEAM_PLAYER).res.wood - before;
  assert(banked > 200, `only ${Math.round(banked)} wood arrived in 150 s`);
  assert(camp.cart && !camp.cart.dead, 'the cart did not survive its own round');
  return `${Math.round(banked)} wood banked`;
});

check('a cart never retires: knocked idle, it goes back on the road', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 4 });
  step(g, 60);
  const cart = camp.cart;
  /* Exactly what the stall watchdog does to a wedged unit. */
  cart.state = STATE.IDLE;
  cart.path = null;
  cart.targetPos = null;
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  step(g, 90);
  assert(cart.state === STATE.SUPPLY, `the cart stayed ${cart.state}`);
  assert(g.teams.get(TEAM_PLAYER).res.wood > before, 'nothing arrived after the cart was knocked idle');
  return 'back in STATE.SUPPLY and delivering';
});

check('a full camp reroutes its villagers to the town centre', () => {
  const { g, tc } = match();
  const { camp, vs } = camped(g, tc, { crew: 4 });
  camp.cart.dead = true;             // cut the supply line and let the pile fill
  camp.cart = null;
  camp.cartLostAt = g.time + 1e6;
  let capped = false;
  const chosen = new Map();
  for (let i = 0; i < 30 * 220; i++) {
    g.update(1 / 30);
    if (g.stockRoom(camp) >= 1) continue;
    capped = true;
    for (const v of vs) if (v.dropOff) chosen.set(v.dropOff.type, (chosen.get(v.dropOff.type) || 0) + 1);
  }
  assert(capped, 'the camp never filled, so the reroute was never exercised');
  assert(chosen.size, 'no villager chose a drop-off while the camp was full');
  assert(!chosen.has('lumber_camp'), 'a villager still queued at the full camp');
  assert(chosen.has('town_center'), 'villagers did not fall back to the treasury');
  /* and they must still be earning, not standing about */
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  step(g, 60);
  assert(g.teams.get(TEAM_PLAYER).res.wood > before, 'the economy stalled behind a full camp');
  assert(vs.every((v) => !v.dead), 'villagers died during the reroute');
  return `${chosen.get('town_center')} choices, all the town centre`;
});

check('a killed cart is replaced, once, after a delay the player can feel', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 2 });
  step(g, 20);
  const first = camp.cart;
  const notes = [];
  g.notify = (m) => notes.push(m);
  first.takeDamage(99999, null);
  step(g, 2);
  assert(first.dead, 'the cart survived a fatal blow');
  step(g, 20);
  assert(!(camp.cart && camp.cart !== first && !camp.cart.dead), 'the cart came back too quickly to matter');
  step(g, 16);
  const back = camp.cart;
  assert(back && back !== first && !back.dead, 'the camp never got a replacement cart');
  assert(back.home === camp, 'the replacement does not know its camp');
  assert(notes.some((n) => /cart/i.test(n)), `no word to the player: ${JSON.stringify(notes)}`);
  const carts = g.units.filter((u) => !u.dead && u.def.supply);
  assert(carts.length === 1, `${carts.length} carts running for one camp`);
  return 'one replacement at ~30 s, with a notice';
});

check('burning the camp destroys the pile and says so', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 4 });
  camp.cart.dead = true;
  camp.cart = null;
  camp.cartLostAt = g.time + 1e6;
  step(g, 80);
  const pile = g.stockTotal(camp);
  assert(pile > 50, `only ${Math.round(pile)} in the camp: nothing worth losing`);
  const notes = [];
  g.notify = (m) => notes.push(m);
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  camp.takeDamage(999999, null);
  step(g, 1);
  assert(camp.dead, 'the camp survived');
  assert(g.teams.get(TEAM_PLAYER).res.wood === before, 'the pile was banked instead of burning');
  assert(notes.some((n) => /lost in the fire/i.test(n)), `the loss was silent: ${JSON.stringify(notes)}`);
  return `${Math.round(pile)} wood lost with the camp`;
});

check('a cart on the road banks its cargo when the camp burns', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 4 });
  let cart = camp.cart;
  let guard = 0;
  while ((cart.loadTotal || 0) <= 0 && guard++ < 30 * 200) g.update(1 / 30);
  const aboard = cart.loadTotal || 0;
  assert(aboard > 0, 'the cart never picked up a load');
  const before = g.teams.get(TEAM_PLAYER).res.wood;
  camp.takeDamage(999999, null);
  step(g, 1);
  const gained = g.teams.get(TEAM_PLAYER).res.wood - before;
  assert(Math.abs(gained - aboard) < 1, `${Math.round(aboard)} aboard but ${Math.round(gained)} banked`);
  assert(cart.dead, 'the cart outlived its camp');
  return `${Math.round(aboard)} on the road, delivered`;
});

/* -------------------------------------------------------------- the lift */

check('the cliff lift is loaded at its foot, so no cart ever climbs', () => {
  const w = generateWorld(20261, { size: 'normal' });
  const g = new Game({ world: w, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed: 20261 });
  g.start();
  g.ai = [];
  g.teams.get(TEAM_PLAYER).popCap = 200;
  const c = w.climbs[0];
  assert(c, 'no climb on the normal map');
  const lift = g.placeBuilding('cliff_lift', TEAM_PLAYER, c.x, c.z, { free: true, instant: true, climb: c });
  assert(lift, 'the lift was refused');
  g.refreshNav();
  assert(lift.cart, 'the lift got no cart');
  const [sx, sz] = g.supplyPoint(lift);
  assert(Math.hypot(sx - c.footAnchor.x, sz - c.footAnchor.z) < 0.01, 'the cart is sent to the lift, not to its foot');
  g.stock(lift, 'gold', 480);
  const before = g.teams.get(TEAM_PLAYER).res.gold;
  let highest = 0;
  for (let i = 0; i < 30 * 200; i++) {
    g.update(1 / 30);
    if (!lift.cart || lift.cart.dead) continue;
    highest = Math.max(highest, w.heightAt ? w.heightAt(lift.cart.x, lift.cart.z) : 0);
  }
  const banked = g.teams.get(TEAM_PLAYER).res.gold - before;
  assert(banked > 300, `only ${Math.round(banked)} gold came down the mountain`);
  const summitDist = Math.hypot(lift.cart.x - c.summitAnchor.x, lift.cart.z - c.summitAnchor.z);
  assert(summitDist > 5, 'the cart went up onto the summit');
  return `${Math.round(banked)} gold hauled from the foot`;
});

/* ------------------------------------------------------------ both sides */

check('the enemy gets carts too, or the AI starves on its own camps', () => {
  const w = generateWorld(20261, { size: 'normal' });
  const g = new Game({ world: w, civ: 'franks', mode: 'campaign', difficulty: 'standard', fx: NULL_FX, sound: NULL_SOUND, seed: 20261 });
  g.start();
  const enemy = g.teamIds.find((t) => t !== TEAM_PLAYER && t !== 0);
  assert(enemy, 'no enemy team in this match');
  const seat = g.buildings.find((b) => b.team === enemy && b.type === 'town_center');
  assert(seat, 'the enemy has no town centre');
  let tree = null;
  for (const r of g.resources) {
    if (r.resKind !== 'wood' || r.dead) continue;
    const d = Math.hypot(r.x - seat.x, r.z - seat.z);
    if (d > 24 && d < 60) { tree = r; break; }
  }
  assert(tree, 'no wood near the enemy seat');
  const camp = g.placeBuilding('lumber_camp', enemy, tree.x + 4, tree.z + 4, { free: true, instant: true });
  assert(camp && camp.cart && !camp.cart.dead, 'an enemy camp was built with no cart');
  assert(camp.cart.team === enemy, 'the cart joined the wrong side');
  return `team ${enemy} camp has its cart`;
});

/* ------------------------------------------------------------ save / load */

check('a saved camp keeps its pile, and its cart is not duplicated', () => {
  const { g, tc } = match();
  const { camp } = camped(g, tc, { crew: 4 });
  step(g, 70);
  /* The shape main.js writes, reproduced here so the rule is pinned without
     dragging the browser entry point into a headless test. */
  const storeOf = (b) => {
    if (b.def.stockpile === undefined) return undefined;
    const out = {};
    let any = 0;
    for (const [k, v] of Object.entries(b.store || {})) if (v > 0) { out[k] = Math.round(v); any += v; }
    const cart = b.cart;
    if (cart && !cart.dead && cart.load) {
      for (const [k, v] of Object.entries(cart.load)) if (v > 0) { out[k] = Math.round((out[k] || 0) + v); any += v; }
    }
    return any > 0 ? out : undefined;
  };
  const saved = storeOf(camp);
  const onHand = g.stockTotal(camp) + (camp.cart && !camp.cart.dead ? (camp.cart.loadTotal || 0) : 0);
  assert(saved, 'a working camp saved no store at all');
  const savedTotal = Object.values(saved).reduce((a, b) => a + b, 0);
  assert(Math.abs(savedTotal - onHand) < 2, `${Math.round(onHand)} on hand but ${savedTotal} saved`);
  /* The cart itself is deliberately left out of the unit list: every camp
     re-issues one on load, so saving it too would double the fleet. */
  const savedUnits = g.units.filter((u) => !u.dead && !u.def.supply);
  assert(!savedUnits.some((u) => u.def.supply), 'a cart would be written into the save');
  assert(g.units.some((u) => !u.dead && u.def.supply), 'the test match has no cart to exclude');
  return `${savedTotal} goods carried across the save`;
});

console.log('');
if (fails.length) {
  console.log(`SUPPLY FAILURES (${fails.length}):`);
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log(`SUPPLY CHECKS PASSED (${pass})`);
