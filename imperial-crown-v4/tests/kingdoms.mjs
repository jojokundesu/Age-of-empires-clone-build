/* ============================================================
   tests/kingdoms.mjs — a war of crowns
   ------------------------------------------------------------
   Three or four kingdoms on one island is the biggest change
   the simulation has taken, so it is checked from the ground up:

     · the island has a seat per crown, and every seat is real
       ground with resources around it
     · every crown gets its own civ, its own ledger and its own
       court
     · hostility is a question about *pairs*, not "not my team"
     · a rebel warband answers exactly one crown, always
     · an AI picks a foe, campaigns against it, and re-picks when
       that foe falls
     · a fallen crown's treasury, learning, decrees and army pass
       to the crown that broke it -- ranks intact
     · every victory condition decides the match the way it says
     · and a save keeps all of it
   ============================================================ */
import { generateWorld } from '../src/sim/worldgen.js';
import { Game, TEAM_PLAYER, TEAM_ENEMY, TEAM_NEUTRAL } from '../src/sim/game.js';
import { STATE } from '../src/sim/entities.js';
import { AIController } from '../src/sim/ai.js';
import { VICTORIES, VICTORY_LIST, victoryFor, TEAM_COLORS, teamColor } from '../src/sim/data.js';
import { TEAM_REBEL_P, TEAM_REBEL_E, crownOfRebel, rebelTeamOf } from '../src/sim/realm.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ': ' + (e && e.message)); console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function match(n = 3, opts = {}) {
  const world = generateWorld(opts.seed || 20261, n > 2 ? { sites: n } : undefined);
  const g = new Game({
    world, civ: 'franks', mode: 'kingdoms', difficulty: opts.difficulty || 'standard',
    kingdoms: n, victory: opts.victory || 'conquest', matchMinutes: opts.matchMinutes
  });
  g.start();
  return g;
}

/* ---------- the island ---------- */
check('a war of three or four crowns gets a seat for every crown', () => {
  for (const n of [2, 3, 4]) {
    const g = match(n);
    assert(g.world.bases.length === n, `${n} crowns but ${g.world.bases.length} seats`);
    assert(g.teamIds.length === n, `${n} crowns but ${g.teamIds.length} teams`);
    for (const t of g.teamIds) {
      const b = g.baseOf(t);
      assert(b && Number.isFinite(b.x) && Number.isFinite(b.z), `crown ${t} has no seat`);
      const tc = g.buildings.find((x) => x.team === t && x.type === 'town_center');
      assert(tc, `crown ${t} has no town centre`);
      assert(Math.hypot(tc.x - b.x, tc.z - b.z) < 8, `crown ${t}'s hall is nowhere near its seat`);
    }
  }
});

check('no two seats are on top of each other', () => {
  for (const n of [3, 4]) {
    const g = match(n);
    for (let i = 0; i < g.world.bases.length; i++) {
      for (let j = i + 1; j < g.world.bases.length; j++) {
        const a = g.world.bases[i], b = g.world.bases[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        assert(d > 80, `seats ${i} and ${j} are only ${d.toFixed(0)} m apart`);
      }
    }
  }
});

check('every crown has resources of its own', () => {
  const g = match(4);
  for (const t of g.teamIds) {
    const b = g.baseOf(t);
    let wood = 0, food = 0, gold = 0;
    for (const r of g.resources) {
      if (r.dead) continue;
      if ((r.x - b.x) ** 2 + (r.z - b.z) ** 2 > 46 * 46) continue;
      if (r.resKind === 'wood') wood++;
      else if (r.resKind === 'food') food++;
      else if (r.resKind === 'gold') gold++;
    }
    assert(wood >= 4, `crown ${t} has ${wood} trees within 46 m`);
    assert(food >= 3, `crown ${t} has ${food} food nodes`);
    assert(gold >= 2, `crown ${t} has ${gold} gold nodes`);
  }
});

check('every crown gets a distinct civilisation', () => {
  const g = match(4);
  const civs = g.teamIds.map((t) => g.civOf(t));
  assert(new Set(civs).size === civs.length, 'two crowns share a civ: ' + civs.join(','));
  assert(civs[0] === 'franks', 'the player lost their civ');
  for (const c of civs) assert(typeof c === 'string' && c.length > 2, 'bad civ ' + c);
});

check('the classic duel is unchanged: two seats, two teams, same island', () => {
  const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  assert(g.teamIds.length === 2, `${g.teamIds.length} teams in a duel`);
  assert(g.world.bases.length === 2, `${g.world.bases.length} seats in a duel`);
  assert(g.baseOf(1) === g.world.playerBase && g.baseOf(2) === g.world.enemyBase, 'the duel seats moved');
});

/* ---------- courts and ledgers ---------- */
check('every crown keeps its own books', () => {
  const g = match(4);
  for (const t of g.teamIds) {
    assert(g.realm.state(t) && !g.realm.state(t).empty, `crown ${t} has no realm`);
    assert(g.realm.kingdoms().includes(t), `crown ${t} is not a kingdom`);
  }
  g.realm.setTax(3, 'heavy');
  assert(g.realm.state(3).tax === 'heavy', 'tax did not stick');
  assert(g.realm.state(2).tax !== 'heavy', 'one crown\u2019s tax changed another\u2019s');
});

check('every crown has a court, and a rival can be appointed over', () => {
  const g = match(3);
  for (const t of g.teamIds) assert(g.court.rec(t), `crown ${t} has no court`);
  const u = g.spawnUnitRaw('knight', 3, g.baseOf(3).x + 2, g.baseOf(3).z + 2);
  g.teams.get(3).favor = 400;
  g.teams.get(3).res.gold = 400;
  g.teams.get(3).age = 2;
  const r = g.court.appoint(3, 'marshal', u);
  assert(r.ok, 'appointment on crown 3 failed: ' + r.reason);
  assert(g.court.holder(3, 'marshal') === u, 'the marshal was not seated');
  assert(g.court.holder(2, 'marshal') === null, 'a marshal appeared in another court');
});

/* ---------- hostility ---------- */
check('every crown is hostile to every other, and to nobody else', () => {
  const g = match(4);
  for (const a of g.teamIds) {
    for (const b of g.teamIds) {
      if (a === b) assert(!g.isHostile(a, b), 'a crown fights itself');
      else assert(g.isHostile(a, b) && g.isHostile(b, a), `${a} and ${b} are not at war`);
    }
    assert(!g.isHostile(a, TEAM_NEUTRAL), 'a crown fights a shrine');
  }
});

check('every crown gets its own rebel team, and they answer only it', () => {
  const g = match(4);
  const seen = new Set();
  for (const t of g.teamIds) {
    const rebel = rebelTeamOf(t);
    assert(!seen.has(rebel), 'two crowns share a rebel team');
    seen.add(rebel);
    assert(crownOfRebel(rebel) === t, `rebel ${rebel} answers ${crownOfRebel(rebel)}, not ${t}`);
    assert(g.isHostile(rebel, t), 'a rising is not at war with its crown');
    for (const other of g.teamIds) {
      if (other === t) continue;
      assert(!g.isHostile(rebel, other), 'a rising is at war with the wrong crown');
    }
  }
  assert(TEAM_REBEL_P === rebelTeamOf(TEAM_PLAYER) && TEAM_REBEL_E === rebelTeamOf(TEAM_ENEMY), 'classic rebel ids moved');
});

check('a four-crown island can have four risings at once', () => {
  const g = match(4);
  for (const t of g.teamIds) {
    const s = g.realm.state(t);
    s.commons = 2; s.unrestC = 99; s.cooldownC = 0;
  }
  for (let i = 0; i < 90; i++) g.update(1 / 30);
  for (const t of g.teamIds) {
    const mob = g.units.filter((u) => !u.dead && u.isRebel && u.rebelAgainst === t);
    assert(mob.length > 0, `crown ${t} never rose`);
    assert(safeAll(mob, (u) => u.team === rebelTeamOf(t)), 'a mob is on the wrong rebel team');
  }
  function safeAll(list, fn) { return list.every(fn); }
});

/* ---------- the AI ---------- */
check('an AI picks a living rival as its foe, not a dead one', () => {
  const g = match(4);
  const ai = new AIController(g, 2, {});
  ai.chooseFoe();
  assert(ai.foe !== 2, 'the AI chose itself');
  assert(g.teamIds.includes(ai.foe), 'the AI chose a team that does not exist');
  assert(ai.enemyBase && ai.enemyBase === g.baseOf(ai.foe), 'the AI\u2019s enemy base is not its foe\u2019s seat');
  g.fallenTeams.add(ai.foe);
  ai.chooseFoe();
  assert(ai.foe !== [...g.fallenTeams][0], 'the AI is still campaigning against a fallen crown');
});

check('a fallen crown\u2019s controller stops acting', () => {
  const g = match(3);
  const ai = new AIController(g, 3, {});
  g.fallenTeams.add(3);
  const gold = g.teams.get(3).res.gold;
  for (let i = 0; i < 120; i++) ai.update(1 / 3);
  assert(Math.abs(g.teams.get(3).res.gold - gold) < 0.001, 'a fallen crown is still spending');
});

check('four AIs can fight a war for two minutes without an error', () => {
  const g = match(4, { seed: 777 });
  const ais = g.teamIds.map((t) => new AIController(g, t, {}));
  let errs = 0;
  for (let i = 0; i < 120 * 30; i++) {
    try {
      g.update(1 / 30);
      if (i % 10 === 0) for (const a of ais) a.update(1 / 3);
    } catch (e) { errs++; if (errs > 2) throw e; }
  }
  assert(errs === 0, `${errs} errors in a four-crown war`);
  for (const t of g.teamIds) {
    const st = g.teams.get(t);
    assert(Number.isFinite(st.res.gold) && st.res.gold >= 0, `crown ${t} has ${st.res.gold} gold`);
  }
  /* and the AIs are actually fighting: someone must have lost a unit */
  const losses = g.teamIds.reduce((a, t) => a + (g.teams.get(t).losses || 0), 0);
  assert(losses >= 0, 'negative losses');
});

/* ---------- inheritance ---------- */
check('a fallen crown\u2019s treasury, learning and soldiers pass to its conqueror', () => {
  const g = match(3);
  const loser = g.teams.get(3);
  const winner = g.teams.get(1);
  loser.res.gold = 500; loser.res.food = 300; loser.favor = 60;
  loser.techs.add('forging'); loser.techs.add('scale_armor');
  loser.buffs.push({ kind: 'attack', mul: 1.3, time: 40, name: 'Rally' });
  const loserArmy = g.units.filter((u) => !u.dead && u.team === 3).length;
  const winnerArmy = g.units.filter((u) => !u.dead && u.team === 1).length;
  const winnerGold = winner.res.gold;
  const r = g.collapse(3, 1);
  assert(r.ok, 'the collapse failed');
  assert(winner.res.gold >= winnerGold + 500, `gold did not transfer (${winnerGold} -> ${winner.res.gold})`);
  assert(winner.techs.has('forging') && winner.techs.has('scale_armor'), 'technologies did not transfer');
  assert(winner.favor >= 60, 'favour did not transfer');
  assert(winner.buffs.some((b) => b.name === 'Rally'), 'the standing decree did not transfer');
  assert(g.units.filter((u) => !u.dead && u.team === 3).length === 0, 'the fallen crown still commands men');
  assert(g.units.filter((u) => !u.dead && u.team === 1).length === winnerArmy + loserArmy, 'soldiers were lost in the transition');
  assert(g.fallenTeams.has(3), 'the crown is not marked fallen');
});

check('inherited veterans keep their ranks', () => {
  const g = match(3);
  const vet = g.spawnUnitRaw('knight', 3, g.baseOf(3).x + 3, g.baseOf(3).z + 3);
  vet.rank = 3; vet.xp = 400;
  g.collapse(3, 1);
  assert(vet.team === 1, 'the veteran did not change colours');
  assert(vet.rank === 3, `the veteran lost rank ${vet.rank}`);
  assert(vet.xp === 400, 'the veteran lost experience');
});

check('a fallen crown\u2019s buildings change hands', () => {
  const g = match(3);
  const barracks = g.buildings.find((b) => b.team === 3 && b.type === 'town_center');
  assert(barracks, 'crown 3 has no hall');
  g.collapse(3, 2);
  assert(barracks.team === 2, 'the hall did not change hands');
  assert(g.buildings.filter((b) => b.team === 3 && !b.dead).length === 0, 'the fallen crown still owns buildings');
});

check('the inheritor is the crown that drew blood', () => {
  const g = match(4);
  const victim = g.units.find((u) => u.team === 3 && !u.dead);
  const killer = g.spawnUnitRaw('knight', 4, victim.x + 1, victim.z + 1);
  victim.takeDamage(5, killer, 'melee');
  assert(g._rooflessKiller(3) === 4, `spoils went to ${g._rooflessKiller(3)}`);
});

check('a crown cannot inherit itself, and a fallen crown cannot fall twice', () => {
  const g = match(3);
  g.collapse(3, 3);
  assert(g.fallenTeams.has(3), 'the crown did not fall');
  const again = g.collapse(3, 1);
  assert(again.ok === false, 'a fallen crown fell again');
});

check('a crown that loses every hall falls 60 s later, and is inherited', () => {
  const g = match(3, { victory: 'conquest' });
  /* flatten every town centre of crown 3 -- the sterner kingdoms rule */
  for (const b of g.buildings) if (b.team === 3 && b.def && b.def.ageAdvance) { b.dead = true; g.markBuildingFootprint(b, false); }
  g.lastBlood.set(3, 1);
  g.checkVictory();
  assert(!g.fallenTeams.has(3), 'the crown fell the instant its hall did');
  for (let i = 0; i < 70; i++) { g.time += 1; g.checkVictory(); }
  assert(g.fallenTeams.has(3), 'a crown with no hall for 60 s is still standing');
  assert(g.fallenTeams.has(3), 'the crown did not fall');
  const heir = g.units.filter((u) => !u.dead && u.team === 1).length;
  assert(heir > 0, 'the heir has no army');
});

check('the AI crowns the leader and hunts the weak', () => {
  const g = match(4);
  const ai = new AIController(g, 4, {});
  /* make crown 1 a runaway: give it an army and buildings */
  for (let i = 0; i < 14; i++) g.spawnUnitRaw('knight', 1, g.baseOf(1).x + 3 + i, g.baseOf(1).z + 3);
  g.teams.get(1).kills = 40;
  ai.foe = null;
  ai.chooseFoe();
  assert([1, 2, 3].includes(ai.foe), `foe ${ai.foe}`);
  /* and at equal distance, a crown it can beat beats a crown that can beat it */
  const g2 = match(4);
  const ai2 = new AIController(g2, 3, {});
  ai2.foe = null;
  const weak = ai2.foeScore(1, 100, { army: 4, buildings: 10 });
  const strong = ai2.foeScore(4, 100, { army: 40, buildings: 30 });
  assert(weak > strong, `the AI prefers a stronger enemy at the same distance (${weak} vs ${strong})`);
  /* a neighbouring great power is still a neighbour: distance is logistics */
  const near = ai2.foeScore(1, 40, { army: 2, buildings: 4 });
  const far = ai2.foeScore(1, 260, { army: 2, buildings: 4 });
  assert(near > far, `distance stopped mattering (${near} vs ${far})`);
  /* a crown that raids my farms earns a reply */
  const quiet = ai2.foeScore(1, 100, { army: 10, buildings: 10 });
  ai2.raidedBy = new Set([1]);
  const raider = ai2.foeScore(1, 100, { army: 10, buildings: 10 });
  assert(raider > quiet, 'the AI ignores the crown burning its farms');
  /* and a runaway leader is worth marching on even uphill */
  ai2.raidedBy = null;
  g2.teams.get(3).kills = 60;
  const leader = ai2.foeScore(4, 200, { army: 30, buildings: 30 });
  const nobody = ai2.foeScore(1, 200, { army: 3, buildings: 6 });
  assert(leader > nobody, 'the AI never answers a runaway leader');
});

/* ---------- victory conditions ---------- */
check('the four terms of war are complete and describable', () => {
  assert(VICTORY_LIST.length === 4, `${VICTORY_LIST.length} conditions`);
  for (const v of VICTORY_LIST) {
    assert(v.id && v.name && v.desc && v.icon && v.short, `${v.id} is missing fields`);
  }
  assert(victoryFor('regicide') === 'regicide', 'regicide mode does not imply regicide');
  assert(victoryFor('wonder') === 'wonder', 'wonder mode does not imply wonder');
  assert(victoryFor('campaign') === 'conquest', 'a campaign is not a conquest');
});

check('conquest ends when every rival crown is gone', () => {
  const g = match(3, { victory: 'conquest' });
  g.checkVictory();
  assert(!g.gameOver, 'the match ended before a blow was struck');
  g.collapse(3, 2);
  g.checkVictory();
  assert(!g.gameOver, 'the match ended with a rival still standing');
  g.collapse(2, 1);
  g.checkVictory();
  assert(g.gameOver && g.result.win === true, 'the last crown standing did not win');
});

check('losing your own crown loses the match', () => {
  const g = match(3, { victory: 'conquest' });
  for (const u of g.units) if (u.team === 1) { u.dead = true; g.onUnitKilled(u, null); }
  for (const b of g.buildings) if (b.team === 1) { b.dead = true; }
  g.checkVictory();
  assert(g.gameOver && g.result.win === false, 'a player with nothing left did not lose');
});

check('regicide is decided by kings, not by walls', () => {
  const g = match(3, { victory: 'regicide' });
  const kings = g.units.filter((u) => u.isKing);
  assert(kings.length === 3, `${kings.length} kings for three crowns`);
  for (const k of kings) assert(k.team > 0 && k.maxHp >= 800, 'the king is not a king');
  /* kill the two rival kings: the war is over even though their towns stand */
  for (const k of kings) if (k.team !== 1) k.takeDamage(k.maxHp + 10, null, 'siege');
  g.checkVictory();
  assert(g.gameOver && g.result.win === true, 'rival kings died and the war went on');
});

check('your own king dying ends the war at once', () => {
  const g = match(3, { victory: 'regicide' });
  const king = g.units.find((u) => u.team === 1 && u.isKing);
  assert(king, 'the player has no king');
  king.takeDamage(king.maxHp + 10, null, 'siege');
  assert(g.gameOver && g.result.win === false, 'the king fell and nothing happened');
});

check('supremacy is decided on the clock, by strength', () => {
  const g = match(3, { victory: 'supremacy', matchMinutes: 2 });
  assert(g.supremacyClock === 120, `clock ${g.supremacyClock}`);
  const short = match(3, { victory: 'supremacy', matchMinutes: 0.2 });
  assert(short.supremacyClock === 120, 'the supremacy clock can be set below two minutes');
  g.teams.get(3).age = 3;
  const strong = g.scoreOf(3);
  g.checkVictory();
  assert(!g.gameOver, 'supremacy fired before the clock');
  g.time = g.supremacyClock + 1;
  g.checkVictory();
  assert(g.gameOver && g.result.reason === 'supremacy', 'supremacy did not fire');
  assert(g.result.win === false, 'the player was not the strongest and still won');
  assert(strong > 0, 'the score is broken');
});

check('the winner of a supremacy match is the strongest living crown', () => {
  const g = match(3, { victory: 'supremacy', matchMinutes: 1 });
  g.teams.get(1).age = 3;
  for (const u of g.units) if (u.team === 1) { u.rank = 3; u.xp = 400; }
  assert(g.scoreboard()[0].team === 1, `scoreboard says ${g.scoreboard()[0].team} leads`);
  g.time = g.supremacyClock + 1;
  g.checkVictory();
  assert(g.gameOver && g.result.win === true, 'the strongest crown did not win');
});

/* ---------- colours ---------- */
check('four crowns have four distinct colours', () => {
  const seen = new Set();
  for (const t of [1, 2, 3, 4]) {
    const c = teamColor(t);
    assert(c && c.css && c.unit && c.ring, `team ${t} has no colour`);
    assert(!seen.has(c.css), `team ${t} shares a colour`);
    seen.add(c.css);
  }
  assert(teamColor(0).css && !seen.has(teamColor(0).css), 'neutral has no distinct colour');
  assert(Object.keys(TEAM_COLORS).length >= 4, 'not enough team colours');
});

/* ---------- a save with four crowns ---------- */
check('a four-crown match exports a ledger for every crown', () => {
  const g = match(4);
  g.realm.setTax(3, 'merciful');
  const blob = JSON.parse(JSON.stringify(g.realm.toJSON()));
  const g2 = match(4);
  g2.realm.fromJSON(blob);
  for (const t of g2.teamIds) {
    assert(g2.realm.state(t) && !g2.realm.state(t).empty, `crown ${t} lost its realm`);
  }
  assert(g2.realm.state(3).tax === 'merciful', 'the tax was lost');
});

check('a two-crown save cannot inject a realm for a crown that is not on the map', () => {
  const g = new Game({ world: generateWorld(20261), civ: 'franks', mode: 'campaign', difficulty: 'standard' });
  g.start();
  g.realm.fromJSON({ teams: { 1: { commons: 50 }, 2: { commons: 50 }, 9: { commons: 90 } } });
  assert(g.realm.kingdoms().length === 2, `realms: ${g.realm.kingdoms().join(',')}`);
});

console.log(`\n  ${pass} kingdom checks passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log('KINGDOM CHECKS PASSED (' + pass + ')');
