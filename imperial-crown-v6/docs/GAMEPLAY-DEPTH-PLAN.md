# Gameplay Depth Plan — Imperial Crown

**Status:** Section 1 complete. Sections 2–5 specified, not started. Section 6 parked.
**Version:** 6.4.0 → 6.5.0 (Section 1)
**Rule for every section:** narrow, deep, thorough. One section at a time, green tests
before the next begins, no section half-finished and left in the build.

---

## Why this plan exists

A match today is flat. You build an army, you walk it across the map, you win; or you
sit and lose. There is no tug-of-war, no defensive stalemate that forces a change of
plan, no moment where the map itself is the problem to solve rather than a distance to
cross. Four things are missing, and each one is a section below:

1. The map is too small to have a shape.
2. The AI only plays the half of the map it starts on.
3. Walls are a frustration, not a decision.
4. The terrain's most dramatic features — the cliffs — are dead space.

Around those four, two housekeeping sections: a cleanup of experimental systems that
never earned their keep (Section 1, done), and a campaign mode that is worth doing
properly later or not at all (Section 6, parked).

---

## Section 1 — De-bloat and a universal Arcane Mage ✅ COMPLETE

### The argument

Five experiments were added over the life of the project and none was ever finished:
Court Offices, Realm Estates and Taxes, Rebellions and mobs, the Morale/Rout system,
and five of the six workshop mods. Each one cost CPU every tick, a HUD element, a menu
toggle, a save field and a test — and each one was half-wired. A system that is
half-wired is worse than no system: it looks like it does something, so players plan
around it, and it does not.

The Arcane Mage is the exception. It is the one experimental addition that plays well,
that a player can feel, and that reads as a real addition to the game. It was kept —
and it was the only thing in the workshop that was kept.

### What was removed

| System | What went |
|---|---|
| **Morale / Rout** | `src/sim/morale.js` deleted; `STATE.ROUT`, `unit.morale`, rout timers, the break-away rule, the morale column in the save tuple, and every call site |
| **Court Offices** | `src/sim/court.js` deleted; `ui.openCourt`, the panel, the appointment rules, the AI's `manageCourtOffices`, the `courtOffice` threat weight |
| **Realm Estates / Tax / Unrest** | `src/sim/realm.js` deleted; the ledger, tax bands, the treasury inheritance hook, the HUD realm chip, `#btnCourt` |
| **Rebellions / Mobs** | `TEAM_REBEL_P` / `TEAM_REBEL_E`, `rebelTeamOf`, `crownOfRebel`, `ensureRebelTeam`, the rising scheduler |
| **Workshop mods** | `beasts.js`, `weather.js`, `artificer.js`, `relics.js`, `zombies.js` deleted; `plague_zombie` art removed from `models.js`; the 6-entry registry replaced by a 1-entry catalogue |
| **Dead climate fields** | The `morale` column in every era and season table, and `climate.moraleMul()` — five numbers on a table nothing read |

`realmBlock` / `realmBar` CSS **stays**: the slow-sky panel still uses those class
names for its own bars. Only the `.realmChip*` family was removed.

### What was fixed on the way

Three real bugs surfaced during the cleanup, and all three were in the blast radius of
the removal, so all three are fixed here rather than deferred:

- **The save tuple shifted and nobody noticed.** Removing morale's column from the
  serialised unit tuple moved every later index down one, but the loader still read
  transport passengers at index 11 and standing orders at index 12. Every reload put
  passengers inside buildings and gave each man his neighbour's orders. Caught by
  `tests/app.test.mjs`; fixed at `main.js` (indices 10 and 11); `SAVE_VERSION` is now
  **7** and loading refuses a 6, because a 6 is not a 7.
- **`opts.mods` was a map, not a list.** The menu spreads its state into the match
  options, and `state.mods` is an `{id: bool}` map. The gate read a truthy non-list as
  a one-entry array, so **every plain campaign started a mod host** with an empty
  selection — and the empty activation is what ballooned the tab. Caught by the
  browser suite; the gate now accepts only a non-empty list of non-empty strings, and
  the menu always hands over a list.
- **The AI still called the court.** `ai.js` ran `manageCourtOffices` every decision
  tick into a system that no longer existed (it was guarded, so it silently did
  nothing) — and the market logic that shared the method went with it. Separated into
  `manageMarket`, which is what it was actually doing.

### Arcane Mage — universal

The mod is no longer sandbox-only. The gate was
`wantMods.length > 0 && (mode === 'mods' || mode === 'sandbox')`; it is now
`wantMods.length > 0`. Consequences, all verified:

- Enabling **Arcane Order** in the workshop applies it in **all six modes**.
- The **enemy crown** gets the same spellbook: `host.js` injects `trains` / `trainAt`
  onto the shared `BUILDING_DEFS`, and `ai.js#pickUnitFor` already reads
  `building.def.trains`, so no AI wiring was needed.
- With the toggle **off**, no mod byte is loaded, no unit exists, no HUD strip appears,
  and `game.modHost` is `null` — confirmed in a cold browser in
  `tests/campaign-clean.mjs`.
- `dispose()` deletes exactly the keys it added; a campaign started after a mod session
  is indistinguishable from a campaign started cold.

### The ratchet

Three suites now fail if the removed systems come back:

- `tests/contract.test.mjs` — "the retired side systems are gone and stay gone":
  `g.court`, `g.realm`, `g.morale`, `favor`, `decrees`, `unit.morale` all absent.
- `tests/kingdoms.mjs` — the same for crowns and units, plus `STATE.ROUT`.
- `tests/ui.test.mjs` — no `#btnCourt`, no `#courtBadge`, no `#realmChip`, no
  `ui.openCourt`, no `.realmChip` styling.

`tests/app.test.mjs` also pins the `{}`-is-not-a-list bug: a campaign with nothing
enabled must start **no** mod host.

### Verification

```
57/57 suites passed in 663.3 s
```
`contract` 8 · `combat` (recalibrated — removal moved the measured figure 34 % → 75 %)
· `mods` 9 · `modsite` 14 browser checks in 41 s · `campaign-clean` 1 cold-browser
check · `kingdoms` 28 · `climate` 20 · `elites` 22 · `v5` · `v6` · `ai soak` 0.380 ms
per tick worst 19.54 ms.

---

## Section 2 — A map worth crossing (512 m → 1024 m default)

### The argument

512 m is a village. An army crosses it in twenty seconds, so the only strategic
question is "do I have more men", and the answer is decided by the build order. There
is no room to scout, no room to expand, no room to fortify a flank, and no room to
manoeuvre — which means no reason to ever do any of those things. Everything that
makes an RTS replayable is downstream of distance.

Two maps in three is a river map. On a river map the only crossing is a ford, so the
ford is the whole match: one chokepoint, one fight, decided once. Adding **land
corridors at the map corners** gives the river a second answer — a long, slow, exposed
walk — so a player can choose the hard way round and the defender has to watch two
threats instead of one. The corner route is *deliberately* worse: longer travel, worse
terrain, no cover. It is a choice, not an equal alternative.

And zoom must reach far enough to see it. Full-map zoom-out at 1024 m, clean, with no
screenshot button — the player photographs the screen with their phone.

### Why before the AI

Fixing AI river-crossing on a 512 m map means tuning routing, scouting radii, seat
margins and expansion distances against a map that is about to double. All of it would
be rewritten. The map comes first; the AI is taught the new map once.

### Technical audit (measured, not estimated)

**Hard-coded to 512 / 256 — these are the work:**

| File | Line | What it is |
|---|---|---|
| `src/sim/worldgen.js` | 11–20 | `WORLD = { size: 512, half: 256, segments: 128, cell: 4, navCells: 256, navCell: 2, fowCells: 128, fowCell: 512/128 }` — the single source of truth; everything else reads it, so this is where a size parameter enters |
| `src/sim/worldgen.js` | 3, 436 | comments that assert 512; the resource sprinkle density is calibrated for 512 m ("an even sprinkle across 512 × 512 reads as noise") and must be re-derived, not scaled |
| `src/sim/worldgen.js` | 733, 746 | `bakeBedTex(hf, 512)` — the baked bed texture is 512² regardless of world size. At 1024 m this is 0.5 texel/m; at 1536 m, 0.33. **This is the VRAM decision**: 1024² = 4 MB, 2048² = 16 MB per texture |
| `src/sim/hydrology.js` | 333 | `opts.size \|\| 512` |
| `src/sim/hydrology.js` | 1024 | `opts.navCells \|\| 256` |
| `src/sim/hydrology.js` | 1059 | `opts.flowSize \|\| 256` — the flow-field resolution; 256² is already 65 k cells per team grid and there are two (`navFinal`, `navFinalEnemy`) |
| `src/gfx/camera.js` | 45 | `this.worldHalf = 256` — the camera clamp; set again in `src/main.js:498` |
| `src/sim/game.js` | 100–129 | `spatial.half`, `buildingSpatial.half`, `resourceSpatial.half`, three `PathFinder` constructions and two `setGrid` calls all take `WORLD.half`; `isInside()` (481) and the nav ↔ world transform (506–507) subtract `WORLD.half` |

**Camera and fog — the zoom-out:**

| Item | Now | Needs |
|---|---|---|
| `camera.maxDist` | 92 (`camera.js:32`) | ~2.2 × 1024 m of diagonal on screen. At fov 46° and pitch 0.86 rad a 1024 m map needs ≈ 300–360 m. This is the single most visible number in the section |
| `camera.far` | 820 (`camera.js:35`) | must exceed `maxDist` plus the far corner's height; ~1500 is safe and free |
| `camera.near` | 0.6 | keep; raising it would pop walls at close zoom |
| `fogDensity` | 0.0032 base, `0.00052 + lowSun·0.00042` at dusk (`renderer.js:159`, `892`) | at 340 m the dusk value is **not** fog: it will eat the far half of the map. Overview altitude needs its own fog curve, blended in with `dist / maxDist`, or the "full-map zoom without fog" requirement fails on the first try |
| `uFogDensity` | written at `renderer.js:1169`, `2052` | both shader paths must agree |
| Zoom control | pinch / `desiredDist` clamp (`camera.js:140`, `156`) | a "fit the map" button and a gesture that reaches it |

**Terrain cost — the part that decides how big we can really go:**

- `segments: 128` at 512 m = **4 m cells**. Held constant, 1024 m needs 256 segments
  (65 k verts) and 1536 m needs 384 (147 k verts). That is affordable on desktop and is
  **not** affordable at 60 fps on a phone.
- The nav grid is `navCells: 256` × 2 m cells. At 1024 m and 2 m cells that is 512² =
  **262 k cells × 2 team grids** plus the pathfinder's own storage. Doubling the world
  at fixed nav resolution quadruples nav memory and pathfinder cost. **Recommendation:
  hold `navCell` at 2 m only up to Large, and use 3 m at Huge** (512² cells either way).
- Fog of war is 128 cells × 4 m. At 1024 m, 128 fow cells = 8 m each — too coarse for
  unit-scale reveal. Scale `fowCells` with the map, not `fowCell`.
- Baked bed texture at 1024²: 4 MB. Fine. At 2048²: 16 MB. Decide per quality tier.

**Seats and rivers:**

- Seat placement uses a coast test (`worldgen.js:416`) relative to `WORLD.half`; seat
  margins must be expressed as a fraction of the map, not a metre count, or four crowns
  collide at 512 and drift apart at 1536.
- River splines are generated in world units; `hydrology.js` takes `opts.size`. The
  corner corridors are new geometry: a walkable band at each corner that crosses the
  river band, with the ford left as the fast route. They need their own nav domain
  (like `DOMAIN.AMPHIBIOUS_SHALLO_FORD`) so pathing prefers the ford and only takes a
  corner when the ford is blocked or too well defended.

**Recommended sizes:** Classic **512 m** (unchanged, still selectable), Large
**1024 m** (new default), Huge **1536 m**. One `worldSize` option threaded through,
with `WORLD` becoming a function of it.

### Acceptance

- Three sizes selectable; Large is the default; Classic still passes every existing
  test unchanged.
- Full-map zoom-out on Large with the far corner legible and unfogged.
- Corner land corridors exist on river maps and are navigable; the ford is still faster.
- Nav grid, pathfinder and bake stay inside a stated memory budget, stated in the code
  at the numbers above.
- No in-game screenshot or capture control of any kind.

### Status: COMPLETE

All five criteria are met, and `node tests/mapsize.mjs` (19 checks) holds them.
Growing the world turned out to be less about the size of the map than about
every place in the codebase where 512 m had been assumed. Those are worth
recording, because each one failed silently rather than loudly:

- **Water was a 512 m plane.** The river sheet was built as a fixed 512 m mesh,
  so on a 1024 m map every channel stopped dead at ±256 m and the river read as
  a chain of disconnected blue rectangles with real water flowing past the edge
  of the mesh. Now the world's size, tessellated to the same metres-per-quad.
- **The unit hash covered 576 m of a 1024 m map.** `SpatialHash` took its half
  extent from the world but its cell *count* from a constant, and `insert`
  returns silently for a cell outside the grid. Everything past ±320 m — men,
  houses, trees — did not exist to separation, aggro, gathering, auras or a
  gate's leaf. Nothing threw. The map was just empty over there.
- **The prop culling grid was 8×8 cells of 64 m.** Scenery beyond the first
  quadrant was never drawn: correct ground, no trees.
- **The minimap divided by 512.** Blips, buildings and the view rectangle
  crowded into the top-left quarter of the panel; a tap on it jumped to the
  wrong place.
- **The pathfinder gave up at exactly 3000 nodes**, a cap sized for a 256-cell
  grid. Routes across a 512-cell grid returned a "partial path to the closest
  explored cell" — the unit walked 380 m and stopped in a field.
- **A fresh unit was invisible to neighbour queries until the next tick**, so a
  gate did not see a man standing in its own gateway.

The landform is scaled horizontally only: the same island, river and hills over
more ground, with relief unchanged, so a bigger map is a bigger landscape with
gentler slopes. River plans are scaled in position and width but *not* in depth
— a wider river is not a deeper one — and fords get their shelf resized to the
water they actually have to cross, which is what made crossings work at 1024 m.

**A note on "corner" corridors.** The trunk river runs the width of the map
through its middle, so the geometric corners are half a kilometre from any
water and a dry shelf parked there bridges nothing. The flanks are therefore
sited where the river meets the map border — out on the map's edge, at the far
end of the longest march, which is what the corner route was always for. They
are stamped in river coordinates so the shelf spans the channel wherever the
channel goes.

Classic is bit-identical to the map that shipped: same terrain hash, same nav
grid, same 907 resource nodes, same three fords. A test asserts the hashes so a
future change cannot quietly re-draw it.

### The zoom-out was the last criterion to actually pass

Everything above is about the *map*; "full-map zoom-out with the far corner
legible" is about the *camera*, and it was taken on trust. It did not hold. The
zoom-out limit was `half * 1.45` — a linear guess that frames 512 m and nothing
else. On Large the camera stopped at 742 m and the map's own corners projected
to **4.7** in normalised device coordinates, so the "overview" showed the middle
of the battlefield and cut off the war. Playing the match made it look fine,
because the camera starts over the player's town and the crop is off-screen
behind the HUD.

Framing is geometric, not linear, and it has a wrinkle an approximate closed
form gets wrong twice: the pitch tips the map so the near corner is far closer
to the eye than the far one, and a square's corners sit at 45° to the view axis.
So the limit is now *solved* — `Camera.fitDistance` projects the map's four
corners through this camera's real frustum, at this screen's real aspect and
this pitch, and bisects the distance until all four sit inside the frame with an
eighth of the screen to spare. Large needs 1599 m at 16:9 and 3218 m on a phone
held upright, which is why it is computed per resize and not per map.

Three of the bugs on that path were mine and all three were caught by the check
rather than by looking at the screen: a view basis built by dividing the eye
offset by the distance (which zeroes the horizontal terms), a bisection whose
brackets ran the wrong way (so it returned the distance that *fails*), and a
margin of 1.12 in the solver against 1.16 in its only caller.

Two things that follow from the longer lens:

- **The far plane had to grow with it.** It was `max(820, half * 3)`; at 1599 m
  of distance it clipped the back of the map into fog-coloured nothing.
- **The water shader had to survive the distance.** Its shoreline cut is a tenth
  of a metre of depth, which draws a crisp bank at 46 m and falls apart at a
  kilometre: a 4 m texel of a 2 m-deep bank collapses the contour, and the river
  drew as a chain of pools with dry ground between them. The cut now loosens
  with zoom and the far field gets a colour floor, so the channel keeps its
  course when what the player is reading is the battlefield.

What the overview still shows, correctly, is fog of war: the half of the map
nobody has walked is a grey memory of the terrain, and that is the design. The
terrain, the river and the far corner are all legible under it.

### One thing found and deliberately not fixed here

On Large, **55.7 % of the trunk river's own centreline is dry ground**, in two
long runs at the map's west and east ends (from −1076 to −434, and 447 to 1052,
on seed 20261). The ground there sits at 0.55 m, half a metre above the water
table, and flat. Classic is unaffected: 0 % of its centreline is dry.

The cause is the width scaling. `add()` scales a river's control-point *width*
by `riverScale` but deliberately not its depth, so at 1024 m a trunk whose bed
is −7.2 m is 62 m wide. The carve only cuts where the ground is within
`w * 6.5` — 400 m of the channel — but the *macro landform*'s hillside ramp only
starts 26 m from the waterline, so the channel does not sit in a valley; it is a
trench cut into a flat plain. At the meander's extremes the trench floor rises
to the floodplain and the noise tips it above zero, and the river breaks.

Fixing it means reconciling two scale factors that were never designed to agree
— the river plan's width and the landform's macro coordinates. Attempted here
and reverted: a distance prune in the cell scan (exact, but the landform reads
distance out to 150 m so the bound was wrong) and a bucket index on the segment
search (exact and verified over 54 000 probes, but only 1.2–1.5× faster, because
the ring walk costs as much as it saves). Both were removed rather than shipped
half-understood. The visible symptom at play is a river that has wide pools at
the ends of the map rather than a continuous channel — noticeable, not
gameplay-breaking, and it belongs with Section 3's river work, which touches the
same geometry.

---

## Section 3 — The AI crosses the river

### The argument

The AI never crosses the river. Not "rarely" — it does not path across a ford it cannot
see as a route, so on river maps the enemy is a decorative neighbour. This is the single
largest reason a match is decided in the first two minutes: half the map is not in play.

The fix is not "make it cross". It is to give the AI a plan: defend its town, wall the
approach, scout, answer the enemy's composition, keep outnumbered raiders alive, expand,
bring siege to walls, and choose between pushing the ford and taking the corner flank.

### Scope

- **Routing**: cross-river pathing via fords and the new corner corridors (Section 2).
- **Town defence**: a garrison that reacts, repairs, and does not chase into the open.
- **Walling**: the AI uses Section 4's walls, including gates it can close.
- **Scouting**: a light unit that maps the enemy base and reports composition.
- **Counter-composition**: reads what it has seen and builds the answer.
- **Raider preservation**: a raiding party that is outnumbered withdraws rather than
  trading badly. This is the single biggest behavioural difference between a bot that
  feels alive and one that feeds.
- **Expansion**: takes a second and third resource cluster.
- **Siege**: builds and uses siege against walls instead of walking into them.
- **Route choice**: ford push vs corner flank, by distance, defence and army size.

### Not in scope

No new units. No new buildings except what Sections 4 and 5 add.

### Status — done (`1e9ee3e`)

The premise turned out to be wrong in an interesting way. The AI *did* path
across the fords; what it could not do was arrive. March time scales with the
map (1.3 min on Small, 8.6 on Huge) while army strength and scouting did not, so
a column that left at eight minutes walked into a town one skirmish at a time.
The fix is concentration over distance, not a preference for fords:

- **Muster, march, camp, storm.** The army forms outside its own town, walks a
  waypointed road through a real crossing, camps before the enemy town, and goes
  in with everybody at once. A column that has clearly arrived storms even if it
  could not get every man to the camp.
- **Routing** survives as one mechanism: `pickApproach` chooses a ford or a
  corner flank, and the camp is only ever placed where the column can path.
- **Lookouts** ride out from the main loop rather than only from a march, so the
  council is never answering an army it has not seen.
- **Counter-composition, raider preservation, the reacting garrison and the
  recall of every detachment when the column leaves** are all live and tested.
- **Walling, expansion and siege** wait for Sections 4 and 5, which add the
  things they need; the march already understands walls it cannot break.

Three engine bugs had to be fixed underneath it, each of which had been quietly
eating the army: `setPath` chained *every* long move through a fixed 60 m hop
aimed straight at the destination (so it left the road at the water and then
failed, resetting the order); a soldier who lost his attack target went idle
holding a destination and stood there for the rest of the match; and an infantry
chase gave up after 24 m, so any hunt aimed further than that dropped its order
every frame.

Also fixed in passing: army production was capped at `maxArmy` at exactly the
moment the war bar became `maxArmy` plus a march surcharge, which made the bar
literally unreachable on Large -- the crown stopped at sixteen men and waited for
eighteen for the rest of the game.

`tests/riverwar.mjs` (12 checks, wired into `run.mjs`) covers all of it on both
map sizes. Classic terrain is still bit-identical.

---

## Section 4 — Walls and gates

### The argument

Wall placement is a frustrating, broken mess. A wall is the clearest expression of a
player's plan in an RTS — *this* is where I refuse to be attacked — and today it cannot
be drawn. The fix is a proper placement gesture and walls that actually stop men.

### Scope

- **Touch drag and snap**: drag to lay a run; segments snap to the nav grid; corner
  posts land on the lattice and cannot be dragged off it.
- **Per-segment validity**: every segment is green or red on its own merit — blocked
  ground, water, an existing building, an owned wall of another crown. A run with one
  bad segment does not silently place the good ones.
- **One-tap gate conversion**: tap a placed segment, tap Gate. Gates open for the owner,
  closed to everyone else, and can be ordered shut.
- **Corner pillars**: the ends and every direction change get a real post, with the
  armour that implies.
- **Real defensive armour**: a wall is not a health pool. Melee has to break it, arrows
  chip it and mostly bounce, and siege is the answer. That means separate melee/arrow
  mitigation on wall segments, and the AI understanding it (Section 3).

---

## Section 5 — Climbable resource-rich mountains

### The argument

The cliffs are the most beautiful thing on the map and they are dead space. Nobody
goes there, nothing is there, and the player learns in the first minute that the
dramatic terrain is scenery.

Make the mountains the high-risk, high-reward ground:

- **Vast resources** — gold, stone and timber in quantities no valley site offers.
- **Danger** — bears, wolf packs and boars that attack unescorted villagers. An
  expedition needs an escort, which is a real decision about a real resource.
- **Infrastructure that evolves with age** — ladders, then switchbacks, then cut-stone
  stairs and pulley lifts. The mountain gets easier to exploit as the player commits to
  it, which is a progression the player builds rather than one they unlock.
- **Destructible** — an enemy can break the ladders and stairs. Cutting a player's
  mountain supply is a raid with a point.

This is wired into the nav grid as a *domain*, not a hack: a climbable slope is its own
traversal class, so pathing, formations and the AI all understand it without special
cases.

### Why last

It touches terrain generation, nav, wildlife, pathing, the AI and the economy at once.
Doing it before the map is settled and the AI can cross a river means doing it twice.

---

## Section 6 — Story / Campaign mode — **PARKED**

Recorded, deliberately not built.

A campaign is a content problem, not a systems problem: hand-authored maps, scripted
objectives, persistent heroes and a between-mission progression. It is worth doing
properly or not at all — a thin campaign is worse than the skirmish modes, because it
promises a story and delivers a tutorial. It is parked until Sections 2–5 have made a
single skirmish worth replaying, because a campaign on top of a flat skirmish is a flat
campaign with cutscenes.

**Do not start this without an explicit instruction.**

---

## Ground rules for every section

- **Keep untouched:** v6.4.0 water and hydrology, unit rigs and the Armory, formations,
  veterancy, sacred sites, core economy and combat.
- **Tests stay 100 % green and fast.** A section is not done because the feature works;
  it is done because the suite passes and the browser agrees.
- **Ratchet every removal and every new rule in a test.** The failure mode this project
  keeps hitting is a system that silently stops being wired; a test that names the
  behaviour is the only thing that catches it.
- **Procedural only.** `.glb` assets are postponed; no rig or colour work.
- **Validate in the running app.** A green rig PNG has never once proved the game is
  right.
