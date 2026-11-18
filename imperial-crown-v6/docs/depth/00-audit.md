# Audit — what is actually in the simulation

Evidence for `PLAN.md`. Every claim here is a file and line reference, so the
plan can be checked without trusting it. Read this before starting a section.

Method: read `src/sim/*.js` (15.5 k lines), `src/game/*.js`, `src/gfx/renderer.js`,
`src/sim/data.js`, `tests/*.mjs`, and the README roadmap. Grep for wiring, not
for names — a system that is named everywhere and called nowhere is the pattern
this audit is looking for.

---

## 1. Systems that exist and are fully wired

Confirmed by finding call sites in the tick, not just definitions.

| System | Entry point | Wired into |
|---|---|---|
| Combat resolver | `entities.js` `attack()` | auras, squads, buffs, morale, calendar, champions, counters, projectiles |
| Pathfinding | `pathfind.js` (604 lines) | connected components for cheap unreachable, per-unit wedge watchdog |
| AI | `ai.js` (1795 lines) | economy, build order, scouting (`readEnemy`), composition (`decidePlan`), court, omens, ages, waves |
| Formations | `game.js:3616` `formationSlots()` | `formationStyle` box/line/wedge/column, UI at `ui.js:883` |
| Veterancy | `veterancy.js` | per-unit XP and ranks |
| Squads | `squads.js` | cohesion, `attackMul` used in the resolver |
| Elites / renown | `elites.js` | legends, banners, `BANNER_MORALE_FLOOR` |
| Court | `court.js` | 8+ offices, effects |
| Realm | `realm.js` (805 lines) | estates, taxes, feasts, golden age, revolt, conspiracy |
| Calendar / climate | `calendar.js`, `climate.js` | seasons, eras, omens that affect combat (`arrowMiss`, `attackMul`, `moraleMul`) |
| Technologies | `data.js:451` `TECH_DEFS` | 65 entries across 8 buildings |
| Victory | `data.js:606` `VICTORIES` | conquest, regicide, wonder |

**Conclusion: depth of *mechanism* is not missing.** Any plan that adds a new
system before making these matter is adding a fifth wheel.

---

## 2. Systems that exist and are inert

This is the finding. Each of these is built, tested, and has no or negligible
consequence.

### 2a. Morale — worth ±8 %

```js
// src/sim/morale.js:124
attackMul(unit) {
  const m = unit.morale === undefined ? MORALE_MAX : unit.morale;
  return 1 + Math.max(0, Math.min(1, (m - MORALE_FLOOR) / (MORALE_MAX - MORALE_FLOOR))) * 0.08;
}
speedMul(unit)      { return 1; }   // :129
damageTakenMul(unit){ return 1; }   // :136
```

With `MORALE_FLOOR = 60` and `MORALE_MAX = 100`, the whole band is 0.92 → 1.00.
A soldier at rock bottom hits for 8 % less. The entire apparatus — supply radius
per building, supply tents, night penalty, casualty shock within 11 m, kill
lifts within 11 m (`morale.js:173-200`) — exists to move a number worth 8 %.

`attackMul` **is** called, in `entities.js:1020`. It is wired and irrelevant.
That is worse than unwired: it looks alive.

### 2b. Rout — cannot happen

```js
// src/sim/morale.js:33-34
export const MORALE_FLOOR = 60;
export const ROUT_AT = -1;         // unreachable: units do not break
```

`ROUT_AT` is −1 and morale is clamped to ≥ 60, so no comparison can ever be
true. Confirmed by grep: **nothing in `src/` ever assigns `STATE.ROUT`** to a
unit. Yet everything downstream of it is built and waiting:

- `entities.js:57` `ROUT: 'rout'` in `STATE`
- `entities.js:598` `case STATE.ROUT: this.updateRout(dt, stats)`
- `morale.js:163` `break_(unit)` — resets a routed unit; **called from nowhere**
- `morale.js:44` `this.routs = 0` — a counter that can never increment
- `renderer.js:1976,1984` — skips the health bar and draws something else
- `ui.js:1653` — `'Falling back'` status string
- `direct-control.js:117,278,1328` — a whole branch: *"Your unit has broken and is running"*
- `guards.js:29,63,81` — guards refuse to act on routed units
- `game.js:3077` — counts `broken` units

Eight files support a state that cannot be entered.

### 2c. The design note explains why

`morale.js:1-24` is explicit that this was a deliberate retreat:

> *"Morale is a reward, never a punishment that takes the game away from the
> player. (...) It never drops below MORALE_FLOOR, no unit ever routs, and no
> soldier ever refuses an order because of it — the previous version could empty
> a bar in ninety seconds and turn an entire army round in the middle of a
> march, which is not a mechanic, it is a fault."*

And `tests/morale.mjs` encodes it: `'no order is ever refused and no unit ever
routs, at any morale'` (line 11), `'morale never touches speed'` (162),
`'morale never makes a man softer'` (163).

**This is the single most important fact for planning.** Re-enabling rout is not
a restoration, it is a change of design intent. The old failure — an army
turning round mid-march — is a concrete bug this codebase already fixed once.

### 2d. Estimates

`realm.js` has two estates (`commons`, `nobles`), tax rates, feasts, endowments,
embezzlement, a golden age, `revolt()` and `conspiracy()`. Mobs spawned by a
revolt march on the crown's hall and fight (`realm.js:370-410`).

But the trigger is narrow:

```js
// src/sim/realm.js:674-675
if (s.cooldownC <= 0 && s.unrestC >= UNREST_MAX) this.revolt(team);
if (s.cooldownN <= 0 && s.unrestN >= UNREST_MAX) this.conspiracy(team);
```

Unrest only accumulates when an estate falls below `REVOLT_AT`, and estates are
driven by tax rate and events — not by casualties or losses. A crown that taxes
moderately can fight forever without political cost. So the system exists, is
correct, and is never *felt*.

### 2e. The campaign

There is no mission system. Searching `src/game/*.js` for mission/campaign
returns only menu chrome — a painted card (`menu.js:311`), a save label
(`menu.js:194`), mod warnings. The "campaign" is a mode string that selects a
victory condition:

```js
// src/sim/data.js:635
export function victoryFor(mode) {
  if (mode === 'regicide') return 'regicide';
  if (mode === 'wonder') return 'wonder';
  return 'conquest';
}
```

No objectives, no triggers, no briefing, no debrief, no scripted content. The
README roadmap calls this *"the biggest missing product feature"* and it is the
one roadmap claim that is still true.

### 2f. Naval

Ships, transports, docks and boarding damage exist in `data.js` and are resolved
in combat. The map is an island. There is no evidence in the code of water
mattering to the outcome of a match; it appears to function as a border with a
combat model attached. **Unverified** — Section 0 should measure it before
anyone spends time on it.

---

## 3. What combat actually consults

From `entities.js:1000-1035`, the outgoing-damage path:

1. `stats.attack`
2. per-class `bonuses` (the counter-triangle)
3. building bonus, villager/sappers bonus, siege substitution
4. `g.auraBonusFor(this)`
5. `g.squads.attackMul(this)`
6. `g.buffMul(team, 'attack')`
7. `g.morale.attackMul(this)` — the ±8 %
8. `g.calendar.attackMul()`
9. `g.champions.modifyOutgoing(...)`
10. omen `arrowMiss` for ranged

Terrain is **absent** from this list. Elevation, forest and water contribute
nothing to damage. Given that `worldgen.js` and `hydrology.js` (1459 lines)
generate elevation, forests, rivers and fords, this is authored richness that
the combat model discards.

---

## 4. What the README roadmap gets right and wrong

Grouped by GPU cost, which was the correct axis when rendering was the
bottleneck.

**Already done, still listed as to-do:**

| Roadmap item | Reality |
|---|---|
| *"Real AI: scouting, expansions, army composition"* | `ai.js` does all three: `readEnemy()`, `decidePlan()`, `manageEconomy()` |
| *"Formations and waypoint queues"* | four styles, `formationSlots()`, per-unit waypoints |
| *"Hero units with abilities"* | `champion.js` (682 lines) + `elites.js` |
| *"A third resource axis: stone walls and siege"* | stone exists with walls, gates, rams, siege workshop |
| *"Replay + observer (deterministic sim)"* | determinism exists (`g.rng`, fixed step); replay not verified |

**Still genuinely missing:**

| Item | Note |
|---|---|
| Campaign of 8 missions | §2e — the largest real gap |
| Naval gameplay | §2f — needs measurement before work |
| Map editor / seed sharing | small, real |

**Not in the roadmap at all, and more important than most of it:** the inert
systems in §2. The roadmap cannot see them because it was written about
rendering.

---

## 5. Test surface relevant to this plan

- `tests/morale.mjs` — **encodes the current no-rout contract.** Any change here
  must rewrite these clauses deliberately, not delete them.
- `tests/perf.test.mjs` — 3 ms crowd tick, 1.1 ms per tick. Section 2's terrain
  query must fit inside this.
- `tests/ai.test.mjs`, `tests/aihunt.mjs`, `tests/fuzz.mjs` — headless sim runs;
  the basis for Section 0's harness.
- `tests/balance.test.mjs` — the counter-triangle; Sections 1, 2 and 5 change
  damage and must keep it green.
- `tests/geo.test.mjs` — triangle budgets; unaffected by sim work.
- Today: **61/61 suites, 792.6 s.**

---

## 6. Confidence

| Claim | Confidence |
|---|---|
| Morale is ±8 % and speed/damage-taken are literal `return 1` | **Certain** — read the code |
| Nothing ever sets `STATE.ROUT` | **High** — grep of `src/` for assignment; `break_` has no caller |
| Rout was removed deliberately after a bad version | **Certain** — the design note and the test names say so |
| No mission system exists | **High** — no objectives/triggers/briefing code found |
| Terrain does not affect damage | **High** — read the full damage path |
| Realm revolt is rarely reached | **Medium** — inferred from the trigger condition; needs Section 0 to confirm |
| Naval does not matter | **Low** — code exists, play impact unmeasured |
| Matches never reach Age IV, etc. | **Unknown** — no trace exists. This is why Section 0 is first |
