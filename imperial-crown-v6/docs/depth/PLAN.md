# Depth plan — making the simulation the game

A plan for adding depth to gameplay and game logic, written after reading the
code rather than the roadmap. Each section is separately shippable, has its own
test, and can be abandoned without leaving the game broken.

Companion: `docs/depth/00-audit.md` holds the evidence for every claim here.

---

## The finding that shapes the plan

The README's roadmap is grouped by **GPU cost**. That was the right axis while
the bottleneck was drawing. It is not the axis for depth, and measuring the
code shows the roadmap is now wrong about what is missing.

**Most of the "missing" systems already exist and work.** Formations with four
styles, waypoint pathing, unit veterancy, squad ranks and cohesion, elite
renown, a court of offices, a realm with two estates and rising risk, rebellion
and conspiracy, 65 technologies, three victory conditions, a 1.8 k-line AI that
scouts, expands and composes armies against a counter-triangle. The simulation
is not thin. `src/sim/` is 15.5 k lines and the combat resolver already honours
terrain, auras, squads, buffs, omen weather, champions, veterancy and counters.

**What is thin is consequence.** Scanning those systems for the ones wired to
nothing turns up a consistent pattern: a mechanism is built, then deliberately
neutered so it cannot take a match away from the player, and the scaffolding is
left behind.

| System | Built | Effect today | Evidence |
|---|---|---|---|
| **Morale** | full supply net, deaths, kills, night | **±8 % attack.** Speed and damage-taken are literally `return 1` | `morale.js:124-138` |
| **Rout** | `STATE.ROUT`, `updateRout`, death spiral, recovery, renderer, HUD, direct-control | **Cannot happen.** `ROUT_AT = -1`, floor 60, nothing sets the state | `morale.js:33-34` |
| **Rebellion** | `realm.revolt()`, `conspiracy()`, mobs that march on your hall | fires only when an **estate** collapses | `realm.js:674-675` |
| **Campaign** | menu card, per-civ missions in codex, 3 victory types | **no mission system at all** — "campaign" is a difficulty label | `game.js:61` |
| **Naval** | ships, transports, docks, boarding damage | water is mostly scenery | `data.js`, `entities.js` |

The user's report that the game is "in a lot of pieces" is this table. Nothing
is broken; things are *inert*.

So this plan is about **making the existing motors bite**, then adding the two
things genuinely absent (a strategic layer and a reason to play a session).
It is not about adding more systems.

### The trap this plan is written to avoid

Rout was removed on purpose, and `tests/morale.mjs` documents why:

> *"the previous version could empty a bar in ninety seconds and turn an entire
> army round in the middle of a march, which is not a mechanic, it is a fault."*

Re-enabling a rout without addressing that failure mode is a regression, not
depth. Section 1 exists to re-introduce rout **with the fault mode fixed**, and
its first acceptance test is the exact scenario that killed it the last time:
an army on a two-minute march must **never** break.

---

## Section 0 — Baseline the arc

**Goal.** A number for "is the game deep" that is not an opinion, measured
*before* anything changes.

**Diagnostic — what actually happens.** Long-run matches are not currently
characterised. There is no way to answer "does a standard match reach Age IV",
"is the realm system ever felt", "how often does a rebellion fire", "how many
units die to counter-bonus versus raw stats". Without this, every later claim
of depth is unfalsifiable.

**Files.** New `tests/depth.mjs`. Reads `src/sim/*` only.

**Method.** Extend the existing headless harness (`tests/fuzz.mjs` and
`tests/aihunt.mjs` already run the sim without a renderer) to play N matches
A-vs-A at standard difficulty and record a trace:

- age reached by minute 5 / 10 / 15 / 20, per team
- time of first blood, first army-on-army fight, first building razed
- peak units on field; army composition histogram per age
- techs researched per match; total spent
- estate values reached; unrest maxima; revolts and conspiracies fired
- kills attributed to counter-bonus, to morale-modified damage, to auras
- match length distribution and victory type

**Acceptance.** A committed `docs/depth/baseline.md` with these numbers over
≥ 20 matches, plus a `< 60 s` version wired into `tests/run.mjs` that only
asserts the trace is non-empty and the match terminates. The trace is the point.

**Risk.** Low. New file, no engine change.

**Explicitly not in scope.** Balancing. This section only measures.

---

## Section 1 — Make morale a position, not a bonus

**Goal.** Morale becomes the thing that decides *where* a fight is won, without
ever taking control away from the player during normal play.

**Diagnostic — what actually happens.** `attackMul` is `1 + 0.08 * t`. A soldier
at floor morale hits for 92 % of one at full. `speedMul` and `damageTakenMul`
return 1 unconditionally. The entire supply-tent, night, casualty-shock and
kill-lift apparatus exists to move a number that is worth eight per cent. The
player has no reason to ever look at it, so a whole system is invisible.

**Files.** `src/sim/morale.js` (main), `src/sim/entities.js` (rout entry/exit),
`src/sim/game.js` (order interception), `src/gfx/renderer.js` (already handles
`ROUT` — verify, do not change), `tests/morale.mjs` (rewrite of the rout
clauses), new `tests/rout.mjs`.

**Design.**

1. **Widen the reward.** `attackMul` spans 0.80 → 1.15 across the band rather
   than 0.92 → 1.00. Being supplied and winning is now worth a 35 % swing, which
   is enough to make "where do I fight" a decision.
2. **`damageTakenMul` stays 1 below the pivot.** A shaken man does not become
   softer; otherwise a rout cascade is self-accelerating and we rebuild the old
   fault. This one line is the safeguard.
3. **Rout becomes reachable but bounded.** `ROUT_AT` moves from −1 to 30, floor
   drops to 30. Rout is entered only when morale < `ROUT_AT`, and only for
   units in `STATE.ATTACK`/`STATE.ATTACK_MOVE` — never for a unit the player has
   explicitly ordered to move or hold.
4. **Rout is short, local and recovers.** Duration 4–7 s scaled by how far below
   the threshold the man is. The man flees *toward the nearest supply source*,
   not away from the enemy, and re-enters `IDLE` on arrival or on recovery. He
   cannot be re-routed for 20 s.
5. **The player can always override.** Any explicit order from the player
   cancels a rout immediately (`routT = 0`, `break_()`). `morale.break_` already
   exists and is called from nowhere — this is its caller.
6. **Cascades are capped.** At most `ceil(0.25 * n)` of a squad may be routing
   at once. The cap is what prevents the ninety-second army turnaround.
7. **Night and the march are where morale is lost.** Keep the existing
   "fighting barely costs morale" rule; it is correct and was learned the hard
   way.

**Acceptance.**

- The old failure is a test: a 12-man column on a **120 s march** outside supply
  ends with **zero** routed and worst morale ≥ 40.
- A scripted 10-vs-10 where one side is at 35 morale before contact: that side
  loses ≥ 70 % of the time, and never faster than 20 s.
- A routed unit reaches supply and returns to `IDLE` within 12 s.
- An explicit player order to a routing unit takes effect on the next tick.
- A parked army (idle, supplied) never routes, over 300 s.
- `tests/morale.mjs`'s "never below floor / never refuses an order" clauses are
  rewritten to the new contract, not deleted.

**Risk.** Medium — this touches combat. Mitigation: `damageTakenMul` unchanged
below pivot, the cascade cap, the 20 s immunity, and the player override. Each
of those is separately testable and separately revertible.

---

## Section 2 — Give terrain teeth

**Goal.** Ground matters, and the player can see why a fight went the way it
did.

**Diagnostic — what actually happens.** `resolver` in `entities.js` consults
auras, squads, buffs, omens, champions and veterancy, but terrain contributes
only through pathing cost and a `hill` flag. Fighting uphill, in a forest, or
across a river costs nothing. Since the map already generates elevation,
forests, rivers and fords (`worldgen.js`, `hydrology.js`), the terrain richness
is authored and then discarded by combat.

**Files.** `src/sim/entities.js` (`attack`, damage application),
`src/sim/worldgen.js` (expose a cheap terrain-query, cached), new
`src/sim/ground.js`, `tests/geo.test.mjs` (extend), new `tests/ground.mjs`.

**Design.**

1. `ground.js` returns a small struct per position: `cover` (0–1 from forest /
   trees / buildings adjacency), `slope` (signed relative-height delta between
   attacker and target), `ford` (crossing a river at a ford vs a bank).
2. **Ranged units gain cover** from forest, up to −25 % damage taken. Melee
   does not, so a forest is an archer's position and infantry must come in.
3. **Uphill favours the defender**: attacking uphill −15 % damage, downhill
   +10 %. Small numbers, deliberately — this is texture, not a win button.
4. **Fords are chokepoints**: crossing a river not at a ford costs a slow, and
   units in water take +15 % damage. This is what makes a river a border rather
   than a decoration.
5. **Legibility is part of the feature.** A unit's detail panel shows Cover,
   Slope and Ford when they are active, and combat logs are tagged so a
   post-match summary can say "31 % of damage taken was absorbed by the
   treeline". A modifier the player cannot see is a modifier that does not
   exist — this is the same mistake as the ±8 % morale.

**Acceptance.** `ground.js` is pure and table-tested (a slope of +1 m over 1 m
is a full uphill penalty; a forest tile gives cover, a cleared one does not).
A scripted archer-duel in trees outperforms the same duel on grass by the
predicted margin. No change to path cost or perf: a capped, cached query, and
`perf.test.mjs`'s 3 ms crowd budget must still hold.

**Risk.** Medium. Balance-sensitive; keep the multipliers ≤ 15 % except cover.

---

## Section 3 — Make the realm visible and the rebellion earnable

**Goal.** The realm actually drives decisions; a rebellion is something you see
coming and can head off — or provoke.

**Diagnostic — what actually happens.** `realm.js` has two estates, taxes,
feasts, endowments, embezzlement, a golden age, revolt and conspiracy. The
revolt only triggers when an estate decays below `REVOLT_AT`, and in practice
that is rare enough that most matches never see one. Nothing in the HUD puts
commons/nobles in front of the player as a *decision*, so the whole system is
furniture.

**Files.** `src/sim/realm.js`, `src/sim/game.js` (tick budget),
`src/game/ui.js` (one panel), `src/sim/ai.js` (`manageCourt` already exists —
make the AI act on unrest), `tests/realm` coverage to be added.

**Design.**

1. **War weariness is the missing feed.** Estates currently move on tax and
   events; add casualties and lost buildings as sustained drags on *nobles* and
   *commons* respectively, so a long war erodes the political base that sustains
   it. This is the mechanic that makes "when do I stop attacking" a real
   question, and it is the natural bridge between Sections 1 and 3.
2. **Unrest is forecast, not surprised.** The HUD shows a countdown to revolt
   with the two levers (tax rate, feast) that move it. The AI reads the same
   number and will sue for a lull when its own is low.
3. **A conspiracy has a face.** `conspiracy()` already exists; give it a
   named claimant (the `claimant_knight` rig exists and is unused in play), so
   the political layer produces an enemy you can see and duel rather than an
   anonymous malus.
4. **Reward high legitimacy.** Golden age already exists; tie it to a visible
   bonus (morale floor lift, trade rate) so there is a positive loop as well as
   a negative one.

**Acceptance.** A 15-minute scripted war measurably lowers both estates;
a player who taxes hard and fights hard sees a revolt countdown before it fires;
a player who feasts heads it off. The claimant appears as a real unit with a
name and can be killed. AI never revolts in more than X % of matches through
its own passivity (tune X from Section 0's numbers).

**Risk.** Medium. Adds a feedback loop; needs Section 0's trace to tune.

---

## Section 4 — A strategic layer: the mission format

**Goal.** A session has a shape, and winning a fight means something beyond the
next fight.

**Diagnostic — what actually happens.** There is no mission data, no objective
state machine, no trigger evaluation, no debrief. `game.js:61` picks a
*victory condition* from a mode string; that is the whole of "campaign". The
menu paints a convincing campaign card over a sandbox. This is the largest
genuine gap in the project, and the one the roadmap names as *"the biggest
missing product feature"*.

**Files.** New `src/sim/mission.js`, new `src/data/missions.js`,
`src/sim/game.js` (hook: objectives evaluated in the existing tick budget),
`src/game/menu.js` + `src/game/ui.js` (briefing and debrief), new
`tests/mission.mjs`.

**Design.** Deliberately small, because content is the expensive part:

1. **A declarative mission format** — plain data, no scripting language:
   `{ id, name, brief, map: {seed, size, preset}, start: {team, res, age,
   units[]}, objectives: [{id, kind, text, target, count}], triggers: [{when,
   then}], par }`.
2. **Six objective kinds only:** `kill` (n of a type), `own` (n buildings),
   `survive` (seconds), `destroy` (a named structure), `protect` (a unit alive at
   time t), `gather` (n of a resource by time t).
3. **Triggers are predicate → action** over a small allowlist: spawn a wave,
   reveal a location, grant resources, change objectives, deliver a line of
   dialogue. Enough for scripted drama, not enough to become an interpreter.
4. **Briefing and debrief screens** that reuse the existing painted-card menu
   art. Debrief shows the Section 0 trace for that mission: time, losses,
   objectives hit.
5. **Eight missions, one per civilisation**, each teaching one system:
   morale/supply, terrain, the realm, counters, siege, economy, court, and a
   final one that combines them. This is what makes the depth *discoverable* —
   systems that are only in the sandbox are systems most players never meet.

**Acceptance.** A mission can be played from the menu to a debrief; a lost
objective fails cleanly; objectives and triggers are data-validated at load
(an unknown kind is a startup error, not a silent no-op — the `armory` missing
import bug is the precedent). No mission may require touching `game.js` beyond
the single hook.

**Risk.** Medium-high — it is the biggest section and the only one with content
work. Mitigation: it is last but one, it is additive, and it is the only
section whose failure leaves the game in its current state.

---

## Section 5 — Close the loop: counter-play readability

**Goal.** The player can learn the counter-triangle from playing, not from a
wiki.

**Diagnostic — what actually happens.** `bonuses` per class and
`armor`/`pierceArmor` produce a real counter-triangle, and the AI explicitly
composes against it (`ai.js` `readEnemy`/`decidePlan`). But the player is told
nothing: no "you are being countered" signal, no post-battle breakdown, and the
HUD's unit stats do not show effective damage against the current foe.

**Files.** `src/game/ui.js` (detail panel), `src/game/codex.js` (extend),
`src/sim/game.js` (combat tallies), new totals in `src/game/ui.js` debrief.

**Design.**

1. **Effective damage on the detail card** against the last-fought enemy type,
   as a number the player can compare, rather than a raw attack value.
2. **A counter hint at selection** when the enemy army composition is lopsided
   against yours — derived from what is *visible*, so this leaks no fog.
3. **Post-battle damage attribution** using the Section 2 tagging: bonus,
   counter, terrain, morale, aura. One screen, numbers only.
4. **Codex entries per class** showing what beats it and what it beats, generated
   from `bonuses` at load so it cannot drift from the data.

**Acceptance.** The codex table is generated from `TECH_DEFS`/`UNIT_DEFS`, and a
test asserts every `bonuses` key names a real unit class. The debrief numbers
reconcile to total kills within rounding.

**Risk.** Low. Presentation only, no sim change.

---

## Section 6 — Naval, or not

**Goal.** Decide, explicitly, rather than leave it half-done.

**Diagnostic — what actually happens.** Ships, transports, docks and a boarding
damage path exist in data and combat. The map is an island. In practice water
is a border. This is the one roadmap item where the code and the intent
genuinely diverge, and it is the most expensive to finish.

**Design.** Treat this as a **decision gate**, not a work item. After Sections
1–5 ship and Section 0 can measure play, ask: does the standard match actually
reach the water? If the trace says matches are decided on land in every game,
delete the naval data rather than finish it — half-implemented systems are what
this plan exists to remove. If the trace says otherwise, scope it properly then.

**Acceptance.** A written decision in `docs/depth/` with the trace that supports
it. Deleting dead code is a successful outcome.

---

## Order and shape of work

Strictly sequential. Each section ends green (`tests/run.mjs`, 61 suites today)
and is committed separately, so any section can be reverted alone.

| # | Section | Why here | Rough size |
|---|---|---|---|
| 0 | Baseline the arc | every later claim depends on it | 1 test |
| 1 | Morale and rout | biggest inert system, cheapest to make bite, touches the thing the player does most | 1 file + 1 test |
| 2 | Terrain | multiplies Section 1: *where* you fight | 1 new module |
| 3 | Realm visibility | makes the war's length a decision | 1 file + 1 panel |
| 5 | Counter readability | cheap, and makes 1–3 learnable | UI only |
| 4 | Missions | needs 1–3 and 5 to be worth teaching | content |
| 6 | Naval decision | needs Section 0 at scale | a decision |

Section 5 is moved ahead of 4 deliberately: the missions in Section 4 teach the
counter-triangle, so the teaching materials must exist first.

## Rules this plan holds itself to

1. **Fix the rotation before adding the fifth wheel.** No new system until an
   inert one bites.
2. **A modifier the player cannot see is not a mechanic.** Every section adds a
   readout, not just a number.
3. **Never take the game away from the player.** Rout has a hard override; the
   old failure mode is an acceptance test, not a note.
4. **Test the failure that killed it last time, first.** `tests/morale.mjs`
   documents the previous rout bug; Section 1's first test reproduces it.
5. **One section, one commit, green.** No section may depend on another being
   finished to leave the build working.

## Open questions — need the user, not more research

1. **"That we discussed"** — no plan for depth exists in the repo (searched
   `README.md`, `docs/`, `deliverables/`). This plan is derived from the code and
   the README roadmap. If there was a different target, this is the wrong plan.
2. **Does rout belong in this game at all?** The code says it was removed
   deliberately. Section 1 assumes the answer is "yes, but safely". The user has
   played it since; they may now prefer morale to stay a pure reward.
3. **Missions vs sandbox** — is a scripted campaign wanted, or is the sandbox the
   product and depth should go into the sandbox only? This decides whether
   Section 4 happens at all, and it is the most expensive section.
