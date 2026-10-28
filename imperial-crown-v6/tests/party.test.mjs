/* ============================================================
   party.test.mjs — the sandbox's third party
   ------------------------------------------------------------
   A sandbox now seats two: the player, and the Free Company.
   This suite nails down what "not my enemy at first" has to mean,
   in the simulation rather than in a promise:

     · the party is a real town: hall, houses, villagers, and a
       watch on its own gate;
     · nobody strikes first -- not the player's soldiers passing
       through, not the party's own watch, not their council;
     · the player CAN strike: an order against them is obeyed;
     · the first blow ends the peace for good, once, and loudly;
     · after it, the fight is real in both directions and their
       council puts men in the field.

   `node tests/party.test.mjs`
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game, TEAM_PLAYER } from '../src/sim/game.js';
import { AIController } from '../src/sim/ai.js';
import { DIFFICULTY, PARTY_NAME } from '../src/sim/data.js';
import { STATE } from '../src/sim/entities.js';

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

function sandbox(seed = 4242, withAI = true) {
  const g = new Game({ world: generateWorld(seed), civ: 'franks', mode: 'sandbox', difficulty: 'standard' });
  g.start();
  const ai = withAI ? new AIController(g, g.partyTeam, { diff: DIFFICULTY.company, aggression: 0.4 }) : null;
  return { g, ai };
}
function tick(g, ai, seconds) {
  const step = 1 / 30;
  for (let t = 0; t < seconds; t += step) {
    g.update(step);
    if (ai) ai.update(step);
  }
}
/** A patch of open ground next to a man, in a given direction. */
function freeSpot(g, x, z, d = 3) {
  for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    const px = x + ux * d, pz = z + uz * d;
    if (g.isPassable(px, pz, { radius: 0.6 })) return [px, pz];
  }
  return [x, z];
}

/* ---------------- the party exists, and it is a town ---------------- */
{
  const { g } = sandbox();
  check('a sandbox seats the party as a real kingdom', () => {
    eq(g.partyTeam, 2, 'the party is team 2');
    eq(g.partyName, PARTY_NAME, 'the party is named');
    const tc = g.buildings.filter((b) => b.team === 2 && b.type === 'town_center');
    assert(tc.length === 1, `the party has ${tc.length} halls`);
    const houses = g.buildings.filter((b) => b.team === 2 && b.type === 'house');
    assert(houses.length >= 2, `the party has ${houses.length} houses`);
    const villagers = g.units.filter((u) => u.team === 2 && u.type === 'villager');
    assert(villagers.length >= 4, `the party has ${villagers.length} villagers`);
    const watch = g.units.filter((u) => u.team === 2 && u.def.attack > 0 && u.type !== 'villager');
    return `${villagers.length} villagers, ${watch.length} on the gate`;
  });

  check('the party keeps a watch on its own gate', () => {
    const watch = g.units.filter((u) => u.team === 2 && u.def.attack > 0 && u.type !== 'villager');
    assert(watch.length >= 4, `only ${watch.length} men carry a weapon`);
    assert(watch.every((u) => u.stance !== 'aggressive'), 'a gate watch is not an army on the march');
    return `${watch.length} armed, stance ${watch[0].stance}`;
  });

  check('everyone is a crown, but the party is at peace', () => {
    eq(g.canFight(TEAM_PLAYER, 2), false, 'the player may not engage the party');
    eq(g.canFight(2, TEAM_PLAYER), false, 'the party may not engage the player');
    eq(g.isHostile(TEAM_PLAYER, 2), true, 'an order to strike them is still legal');
    assert(g.atPeace(2), 'the party is not marked as peaceful');
  });

  check('a campaign has no party at all', () => {
    const c = new Game({ world: generateWorld(99), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
    c.start();
    eq(c.partyTeam, null, 'a campaign grew a third party');
    eq(c.peace.size, 0, 'a campaign is at peace with someone');
  });

  g.destroy?.();
}

/* ---------------- nobody strikes first ---------------- */
{
  const { g, ai } = sandbox();
  check('a player army can stand in their yard and nobody draws', () => {
    const tc = g.buildings.find((b) => b.team === 2 && b.type === 'town_center');
    const [px, pz] = freeSpot(g, tc.x, tc.z, 6);
    const army = [];
    for (let i = 0; i < 4; i++) {
      const u = g.spawnUnit('swordsman', TEAM_PLAYER, px + i * 0.9, pz, null, { force: true });
      if (u) army.push(u);
    }
    const before = g.units.filter((u) => u.team === 2).map((u) => u.hp + u.maxHp);
    tick(g, ai, 20);
    const hurt = g.units.filter((u) => u.team === 2 && u.lastAttackTime > 0).length;
    const dead = g.units.filter((u) => u.team === 2 && u.dead).length;
    const mineHurt = army.filter((u) => u.hp < u.maxHp).length;
    assert(g.atPeace(2), 'the peace broke itself');
    eq(hurt, 0, 'a party unit was hit');
    eq(dead, 0, 'a party unit died');
    eq(mineHurt, 0, 'the watch opened fire on men who had done nothing');
    assert(before.length > 0, 'the party has nobody home');
    return `20 s in their yard: ${before.length} of theirs untouched, ${army.length} of yours`;
  });

  check('their council builds and hires, but does not march', () => {
    const start = g.units.filter((u) => u.team === 2 && !u.dead).length;
    const startBuildings = g.buildings.filter((b) => b.team === 2 && !b.dead).length;
    tick(g, ai, 60);
    const now = g.units.filter((u) => u.team === 2 && !u.dead).length;
    const buildings = g.buildings.filter((b) => b.team === 2 && !b.dead).length;
    const marching = g.units.filter((u) => u.team === 2 && u.state === STATE.ATTACK).length;
    assert(marching === 0, `${marching} of theirs are attacking somebody`);
    assert(buildings >= startBuildings, `their town shrank (${startBuildings} → ${buildings})`);
    return `${start} → ${now} people, ${startBuildings} → ${buildings} roofs, none attacking`;
  });

  g.destroy?.();
}

/* ---------------- the player can start it ---------------- */
{
  const { g, ai } = sandbox();
  check('an order against them is obeyed, and the peace ends', () => {
    const victim = g.units.find((u) => u.team === 2 && u.def.attack > 0 && !u.dead);
    assert(victim, 'no one to hit');
    const [px, pz] = freeSpot(g, victim.x, victim.z, 2.6);
    const man = g.spawnUnit('swordsman', TEAM_PLAYER, px, pz, null, { force: true });
    const notices = [];
    g.notify = (text, kind) => notices.push({ text, kind });
    g.orderAttack([man], victim);
    eq(man.state, STATE.ATTACK, 'the soldier ignored the order');
    eq(man.target, victim, 'the soldier picked somebody else');
    tick(g, ai, 4);
    eq(g.atPeace(2), false, 'blood was drawn and the party is still at peace');
    assert(g.canFight(TEAM_PLAYER, 2) && g.canFight(2, TEAM_PLAYER), 'the war is not mutual');
    const notice = notices.find((n) => /taken up arms/i.test(n.text));
    assert(notice, `nothing was announced (${notices.map((n) => n.text).join(' / ')})`);
    return notice.text;
  });

  check('they hit back, and they hit the man who started it', () => {
    const players = g.units.filter((u) => u.team === TEAM_PLAYER && u.def.attack > 0 && !u.dead);
    assert(players.length, 'the player has nobody on the field');
    let hurt = 0;
    for (let i = 0; i < 20 && hurt === 0; i++) {
      tick(g, ai, 1);
      hurt = players.filter((u) => u.dead || u.hp < u.maxHp * 0.995).length;
    }
    assert(hurt > 0, 'twenty seconds of war and not a scratch on the player');
    return `${hurt} of yours cut`;
  });

  check('the peace is broken once, not once per blow', () => {
    const before = g.peaceAnnounced;
    for (let i = 0; i < 6; i++) {
      const victim = g.units.find((u) => u.team === 2 && !u.dead);
      if (!victim) break;
      g.noteAttack(victim, g.units.find((u) => u.team === TEAM_PLAYER));
    }
    eq(g.peaceAnnounced, before, 'the war was declared again');
  });

  g.destroy?.();
}

/* ---------------- their council answers a war ---------------- */
{
  const { g, ai } = sandbox(7777);
  check('once at war their council puts men in the field', () => {
    const victim = g.units.find((u) => u.team === 2 && !u.dead);
    const man = g.spawnUnit('swordsman', TEAM_PLAYER, victim.x + 2, victim.z, null, { force: true });
    g.orderAttack([man], victim);
    tick(g, ai, 2);
    eq(g.atPeace(2), false, 'the war never started');
    let field = 0;
    for (let i = 0; i < 120 && field === 0; i++) {
      tick(g, ai, 1);
      field = ai.militaryUnits().length;
    }
    assert(field > 0, 'their council kept its army at home');
    return `${field} under arms after ${Math.round(g.time)} s`;
  });
  g.destroy?.();
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`\n${f.name}\n${f.e.stack || f.e}`);
  process.exit(1);
}
console.log('PARTY CHECKS PASSED');
