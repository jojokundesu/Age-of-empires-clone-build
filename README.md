# Imperial Crown 3D

> **Version 6.0.1 (current):** [`imperial-crown-v6/`](imperial-crown-v6/README.md) — touch-only first person, a Champion with perks, audited squads, and the 6.0.0 fixes: armies no longer rout on the march, villagers keep working, farms produce food, the spellbook survives the daily spell, and the watch warns of incoming armies. [Download the v6 Android preview APK](https://github.com/jojokundesu/Age-of-empires-clone-build/releases/download/v6.0.1-preview/imperial-crown-3d-v6.apk) (SHA-256 `847d666f4664c0b6ab6e4890bba0d5173881d8fb1d7414044f4bc97306639a9f`). It installs beside v5 (`ai.arena.imperialcrown.v6`) and is signed with a public demo key; sustained performance on a physical Realme 9i is still unmeasured.
>
> **Version 5:** the earlier continuation is in [`imperial-crown-v5/`](imperial-crown-v5/README.md); [its preview APK](https://github.com/jojokundesu/Age-of-empires-clone-build/releases/download/v5.0.0-preview/imperial-crown-3d-v5.apk) remains published. The original v4 stays in [`imperial-crown-v4/`](imperial-crown-v4/); the historical measurements below describe earlier builds.

A real-time strategy game written from scratch for one device class: a mid-range Android
phone with an **Adreno 610** (Realme 9i class), a 90 Hz screen and 4 GB of RAM. No game
engine, no 3D library, no downloaded assets. Every mesh, texture, shader, sound and note is
generated in code, at runtime, on the phone.

It ships two ways: a signed **APK** that runs entirely offline, and a **static web build**
that runs in any browser with WebGL2.

> **Status:** playable end to end, tested in CI on every push, and released.
> See [Where the project stands](#where-the-project-stands) for the verified numbers and
> [What is still wrong or missing](#known-limitations-honest-list) for the parts that are not
> finished. This README is deliberately written as a handover document — if you are picking
> this up cold, read [Field notes and traps](#field-notes-and-traps-read-this-before-you-change-anything)
> before you touch the code.

---

## Contents

1. [Download and play](#download-and-play)
2. [Where the project stands](#where-the-project-stands)
3. [How the game plays](#how-the-game-plays)
4. [Content inventory](#content-inventory)
5. [Architecture](#architecture)
6. [The performance model](#the-performance-model-why-this-runs-on-a-cheap-phone)
7. [History: what was built and what was fixed](#history-what-was-built-and-what-was-fixed)
8. [Testing](#testing)
9. [Field notes and traps](#field-notes-and-traps-read-this-before-you-change-anything)
10. [Known limitations](#known-limitations-honest-list)
11. [Roadmap: how to take this to another level](#roadmap-how-to-take-this-to-another-level)
12. [Recipes: how to extend it](#recipes-how-to-extend-it)
13. [Credits](#credits)

---

## Download and play

| | |
|---|---|
| **Android APK** | https://github.com/jojokundesu/Age-of-empires-clone-build/releases/latest/download/imperial-crown.apk |
| **Browser build (zip)** | https://github.com/jojokundesu/Age-of-empires-clone-build/releases/latest/download/imperial-crown-web.zip |
| **Checksum** | https://github.com/jojokundesu/Age-of-empires-clone-build/releases/latest/download/apk-sha256.txt |

The APK is a thin Android `WebView` shell (`android/`, package `ai.arena.imperialcrown`,
minSdk 24, target 34) with the whole game's `dist/` folder inside the package. It is about
**175 KB**, because almost nothing in the game is an asset — the geometry, textures and
audio are code.

* Install: tap the download on the phone, allow "install unknown apps" when prompted.
* It requests **no internet permission**. There is no network code in the game.
* Assets are served from `https://appassets.local/` by a `WebViewClient` override rather
  than `file://`. That matters: a secure origin gives working `localStorage` (saves),
  pointer events, WebAudio autoplay policy and WebGL2 with no CORS surprises. See
  [Field notes](#field-notes-and-traps-read-this-before-you-change-anything).
* Landscape only, screen kept awake, status/nav bars black.

---

## Where the project stands

Verified on **2026-10-23**, branch `arena/486bc82a-age-of-empires-clone-build`, PR
[#2](https://github.com/jojokundesu/Age-of-empires-clone-build/pull/2).

| Area | Result |
|---|---|
| Unit / contract / render suites | **15 / 15 pass** (`npm test`, ~24 s) |
| Chromium play-test | **12 / 12 checks pass** (`npm run test:play`, ~2–3 min) |
| Chromium smoke + pixel test | **26 checks, 0 failed** (`npm run test:browser`) |
| Phone-profile soak | **pass** — 220–260 units, tick 0.26 ms, heap 14.3 MB after GC |
| CI | **23 steps green**, run `39998853001` (tests → browser → play test → soak → APK → release) |
| Typical frame | 63–68 draw calls, 50–97 k triangles, 686 DOM nodes, 0.05–0.07 ms/tick |
| Bundle | 359 kB JS + 31 kB CSS (one chunk, no splitting — it is offline) |
| Release | `v2.0.0-mobile` — APK 177,446 B, web zip 163,667 B |

Everything in the table above is measured **headless**, on a CPU rasteriser. It is a lower
bound on how much headroom the GPU path has, not a substitute for holding the phone. See
[Known limitations](#known-limitations-honest-list) — that is the single biggest open item.

---

## How the game plays

Four modes (`get gameModes()` in `src/sim/data.js`):

| Mode | Win condition |
|---|---|
| **Imperial Conquest** | destroy every enemy building |
| **Regicide** | protect your king, kill theirs |
| **Wonder Race** | build a wonder and hold it for 200 s |
| **Grand Sandbox** | 10 000 of every resource, no opponent, no win condition |

Four difficulties scale the AI's gather rate, build speed, reaction time, population, start
villagers and wave timing:

| Difficulty | Gather | Aggression | Pop cap | First wave | Wave every |
|---|---|---|---|---|---|
| Standard | ×1.00 | 0.62 | 60 | 420 s | 95 s |
| Hard | ×1.16 | 0.85 | 80 | 330 s | 78 s |
| Imperious | ×1.34 | 1.00 | 100 | 250 s | 62 s |
| Peaceful (sandbox) | ×1.00 | 0 | 60 | — | — |

Eight civilisations, each with a passive bonus package and one unique unit: Franks,
Britons, Byzantines, Goths, Persians, Japanese, Mongols, Vikings.

Four ages — Dark, Feudal, Castle, Imperial — costing 420 f / 160 g, 700 / 380 and
1 000 / 650, researched at the town centre in 22 / 32 / 42 s. Ages gate buildings, units
and techs.

### The two resources that are not resources

**Favour** accrues over time and from every kill, and is spent on **Imperial Decrees** —
six timed swings rather than passive bonuses, so they reward timing:

| Decree | Cost | Effect |
|---|---|---|
| Harvest Festival | 40 | villagers gather +40 % for 90 s |
| War Rally | 55 | soldiers +30 % damage for 60 s |
| Forced March | 45 | army +35 % speed for 50 s |
| Field Blessing | 60 | heal everything, +2 armour for 70 s |
| Conscription | 80 | instantly raise 6 spearmen at the town centre |
| Golden Age | 120 | +20 % damage, gathering and movement for 120 s |

**The clock** is the second. See below.

### Day and night are two different games

The cycle is 900 s (`game.dayLength`), so a normal match sees two or three nights.

| Phase | Villager gathering | Melee damage | Sight |
|---|---|---|---|
| Noon (12:00) | 110 % | ×1.00 | 100 % |
| Dawn / dusk | ~98 % | ×1.06 | 98 % |
| Night (00:00) | 86 % | ×1.16 | 84 % |

* **Day is for the economy.** Villagers produce 24 % more at noon than at midnight.
* **Night is for the raid.** Melee hits 16 % harder and every vision radius shrinks by a
  sixth, so a small force can slip between two watch posts and hit a wood line before the
  defender sees it. Ranged units get **no** damage bonus — the night belongs to spears,
  swords and cavalry.
* The HUD clock changes icon and colour per phase, and its tooltip states the current
  multipliers (`Day — working hours / Melee damage 105% / Gathering 109% / Sight 100%`),
  because a moon icon alone does not teach the rule.
* Visually the phase drives sun angle and colour, the ambient hemisphere, fog density,
  starfield and moon, and four flickering hearth lights placed at your most important
  buildings.

### Controls

| Gesture | Action |
|---|---|
| tap | select / order |
| drag | pan |
| two-finger pinch | zoom |
| two-finger twist | rotate |
| box drag | select an army |
| long-press ground | attack-move |
| minimap tap / drag | jump the camera |
| tilt buttons (hold) | pitch toward the horizon (this is how you see the sky) / back to top-down |
| Build → tap a spot | place a building; the villagers who opened the menu walk over and build it |

Keyboard on desktop: WASD/arrows pan, Q/E rotate, T/G tilt, +/− zoom, Space pause,
H home, A attack-move, S stop, F next idle villager, 1–9 control groups, Esc deselect.

---

## Content inventory

| | Count |
|---|---|
| Buildings | 22 |
| Units | 29 |
| Prop types | 30 |
| Technologies | 37 |
| Civilisations | 8 |
| Ages | 4 |
| Game modes | 4 |
| Decrees | 6 |
| Master geometry | 22 091 triangles across 81 models |
| Source | 16 040 lines across `src/`, `index.html`, `ui.css` |

**World**, generated from a seed (`20261` by default; the menu lets you re-roll):

* 512 × 512 m island, ridged multifractal heightfield, seven biomes, 128×128 fog-of-war
  grid at 4 m per cell.
* 961 resource nodes: forests, gold and stone veins, berry bushes, deer, boar, fish, relics.
* 3 100+ pieces of decorative clutter, roads stamped into the terrain splat map, three
  neutral shrine points of interest, three river fords.
* A flattened plateau under each base, a town apron of ±17 m, and a ragged "known country"
  survey around your starting valley (see [History](#history-what-was-built-and-what-was-fixed)).

**Economy:** villagers gather food/wood/gold/stone at 3.3 / 3.25 / 2.6 / 2.2 per second,
carry 15, drop at the nearest matching building, farms reseed, trees regrow to 55 %,
markets trade, houses raise the population cap.

**Combat:** a real counter triangle with armour that subtracts rather than multiplies:

```
   spears ──▶ cavalry ──▶ archers ──▶ spears
   (skirmishers counter archers; swordsmen counter spears)
```

`damage = max(1, attack + classBonus − armour)`; arrows use pierce armour, siege weapons
bypass 65 % of it. Archers, skirmishers, hand cannoneers, mangudai, towers and castles fire
pooled projectiles with arc, splash and impact FX.

**Audio:** a WebAudio synthesiser, no samples. ~20 named sounds (build, chop, mine, arrow,
sword, death, boom, horn, coin, warn, win, lose…), stereo panning from the unit's position
on screen, plus generative
music: two slowly detuned drones through a wandering low-pass with occasional pentatonic
plucks.

---

## Architecture

```
   ┌───────────┐   ┌─────────────┐   ┌──────────────┐
   │  sim/     │──▶│  gfx/       │──▶│  game/       │
   │ world,    │   │ WebGL2,     │   │ HUD, menu,   │
   │ economy,  │   │ instancing, │   │ input, audio │
   │ combat,AI │   │ PBR-ish     │   │              │
   └───────────┘   └─────────────┘   └──────────────┘
```

The simulation knows nothing about WebGL, the renderer knows nothing about the HUD, and the
HUD talks to the game only through its public methods. `tests/contract.test.mjs` enforces
that separation statically.

```
index.html              HUD, menu, modals, 90-symbol SVG icon sprite, boot screen
src/main.js             app shell: boot, match lifecycle, fixed-step loop, adaptive
                        quality, autosave (579 lines)
src/core/math.js        vec3 / mat4 / noise / helpers (342)
src/core/gl.js          WebGL2 wrapper: createGL, Shader, Mesh, textures, ShadowMap,
                        framebuffers, fullscreen helpers (430)
src/sim/worldgen.js     island, biomes, splat maps, resources, decor, roads (684)
src/sim/data.js         unit / building / tech / civ / age / difficulty tables (514)
src/sim/entities.js     Unit and Building classes, state machine (1270)
src/sim/pathfind.js     A* over a coarse grid with line-of-sight smoothing (293)
src/sim/spatial.js      uniform spatial hash used by every query (66)
src/sim/projectiles.js  fixed-size projectile pool, arcs, splash (138)
src/sim/ai.js           opponent controller: economy, army, waves (635)
src/sim/game.js         rules: economy, combat, vision, ages, victory (1690)
src/gfx/textures.js     procedural canvas textures for 17 materials (944)
src/gfx/geo.js          the geometry builder: boxes, cylinders, spheres, gables, beams (394)
src/gfx/models.js       81 models: buildings, units, props (1713)
src/gfx/shaders.js      every GLSL program, 1 057 lines of shader source
src/gfx/batch.js        instanced draw batches (117)
src/gfx/renderer.js     frame orchestration, quality ladder, shadow pass, fog upload (1319)
src/gfx/camera.js       orbit camera with pan / zoom / yaw / pitch rails (185)
src/gfx/fx.js           pooled particles, decals, floating text (224)
src/game/ui.js          the whole HUD, built once and diffed (1188)
src/game/input.js       pointer gestures, selection, placement, orders (594)
src/game/menu.js        menu, modals, save/load (406)
src/game/audio.js       WebAudio synth and generative music (343)
src/styles/ui.css       the entire interface (572)
android/                WebView shell; assets served over https://appassets.local
scripts/build-apk.sh    aapt2 → javac → d8 → zipalign → apksigner, no Gradle
scripts/browser-libs.mjs unpacks Chromium's NSS libraries for headless runs
.github/workflows/      CI: tests, browser, play test, soak, APK, release
```

### The frame

`App.loop()` in `src/main.js`:

1. **Fixed 60 Hz simulation** with a capped catch-up (so a slow frame never cascades into
   a spiral), independent of render rate — on a 90 Hz panel the game still simulates 60.
2. `renderer.render(dt, game)` — one shadow pass, one main pass, an optional post pass.
3. `ui.update(dt)` — text/width/class patching at 9 Hz, minimap at 11 Hz, nothing per frame.
4. **Adaptive quality** — median frame time over ~90 samples. Above 21 ms it steps the
   quality ladder down; below 11.5 ms it steps up; above 26 ms it also lowers the render
   scale (floor 0.62). Each step has a cooldown (6–14 s) so one GC spike cannot downgrade
   the game and a calm moment cannot yank it back up.
5. Autosave every 60 s to `localStorage['imperial-crown-save']`; settings to
   `['imperial-crown-settings']`.

### Quality ladder

| Preset | Shadow map | Render scale | Max DPR | Particles | Prop distance |
|---|---|---|---|---|---|
| Low | 512 | 0.68 | 1.25 | 240 | 105 m |
| Balanced | 1024 | 0.84 | 1.5 | 420 | 132 m |
| High | 1536 | 0.95 | 1.8 | 620 | 165 m |
| Ultra | 2048 | 1.00 | 2.0 | 900 | 200 m |

---

## The performance model (why this runs on a cheap phone)

v1 of this project hung. It hung for four specific reasons, and the rewrite removes each by
construction rather than by tuning:

| v1 problem | What it cost | v2 answer |
|---|---|---|
| Geometry and materials created in `spawnVFX` / projectile spawn and never disposed | WebGL memory climbed until the driver reset the context | Fx and projectiles are **fixed-size pools** created once; no allocation at spawn |
| O(N²) scans over ~450 entities per frame (collision, aura, aggro) | frame time grew quadratically with army size | **Uniform spatial hash** (`sim/spatial.js`), every query is local |
| 9 recursive raycasts per tap in `pickEntity` | a tap could take 40 ms and stutter the game | **Screen-space picking** against the same hash — no raycasts |
| `#actions.innerHTML = ''` rebuilt every 0.35 s | style/layout/paint thrash, jank, growing DOM | **HUD built once**; text, widths and classes are patched only when a signature changes |

The rest of the budget discipline:

* **Zero per-frame allocation.** Scratch vectors and matrices live on the object that uses
  them; particle, projectile and unit pools are fixed arrays; the frame loop creates no
  closures, arrays or objects. `tests/perf.test.mjs` fails if the heap grows more than
  24 MB over 4 s.
* **One draw call per model type.** Instances are streamed into instanced buffers and the
  walk cycle, arm swing, siege wheels, banner sway and construction rise are all evaluated
  **in the vertex shader**. A 40-unit melee is one draw call.
* **Picking and selection are screen-space** against the hash.
* **Quality is a ladder, not a setting** — and the ladder is measured, not guessed.
* **Static decor never enters the shadow pass** (`batch.noShadow`), which roughly halves the
  prop cost: a barrel's shadow is two pixels at an RTS camera.

Hard budgets, asserted in `tests/perf.test.mjs`:

| Metric | Budget | Typical |
|---|---|---|
| Tick, 99th percentile | < 2.5 ms | 0.2–0.5 ms |
| Ticks over 2 ms | < 2 % | ~0 |
| 300-unit crowd tick | < 3.0 ms avg, < 25 ms worst | 1.3–1.5 ms |
| Draw calls | < 90 | 63–68 |
| Triangles per frame | < 220 k | 50–97 k |
| Heap growth over 4 s | < 24 MB | ~0 |
| DOM nodes during a match | must not grow | 686 |

---

## History: what was built and what was fixed

This section exists so that nobody re-derives the same conclusions. It is roughly
chronological.

### 1. The foundation rewrite

v1 was a single 5 020-line HTML file with three.js r128 from a CDN, a flat-looking scene
and a set of hangs. It was treated as a **reference only**. The replacement is the current
`src/` tree: a custom WebGL2 renderer, a deterministic simulation, a DOM HUD and a WebAudio
synth, 16 040 lines in total, with no runtime dependency except the browser.

Highlights of the rewrite:

* **Renderer** — instanced batching, a shadow pass with a camera-following PCF map, ACES
  tone mapping, procedural sky with sun/moon/stars, exponential fog, animated water,
  a post pass (grade, vignette, grain), and a quality ladder.
* **Models** — every building, unit and prop generated by `Geo` from primitives, with
  half-timbered walls, plaster infill, shingled and thatched roofs, crenellations, chimneys,
  banners, market stalls. Units use a six-part rig (body, two legs, two arms, weapon/extra)
  animated on the GPU.
* **Textures** — 17 procedural materials painted on canvases at boot (stone, plaster, wood,
  roof tile, thatch, cloth, iron, gold, marble, brick, glass, gravel, leather, leaf, skin,
  grass, dirt, rock, sand, cobble, snow, mud, ash…).
* **Simulation** — seeded worldgen, A* pathfinding with smoothing, spatial hash, combat with
  armour and counter classes, projectiles, economy, ages, techs, decrees, vision, victory
  conditions, an AI opponent.
* **Interface** — the full HUD in `index.html` with a 90-symbol SVG sprite: resources, age
  card, clock, idle-villager button, army button, tech/decrees modals, stance bar, camera
  rail, minimap with three modes, inspector, production queue, command card, toasts, perf
  chip, pause/settings/end screens.
* **Audio** — synthesised SFX and generative music.
* **Android + CI** — WebView shell, Gradle-free APK build, GitHub Actions that test, build
  and publish the release.

### 2. The visual passes

The first version ran well and looked like a board game. Several passes followed, each one
driven by a screenshot rather than a guess:

* **Daylight and exposure.** The scene was washing out through ACES. Root cause: `_bindLight()`
  never uploaded `uCameraPos`, so every specular term was garbage. Separately,
  `renderer.timeOfDay` was inert — the clock only moved when the *game* called
  `setTimeOfDay()`. Both fixed; daytime exposure came down 1.72 → 1.40 and the grass kept
  its colour.
* **Terrain detail.** A meadow at 40 m was a flat green plane. Added two octaves of
  procedural ground noise that fade with distance. (A second texture repeat was tried first
  and aliased into confetti — the answer is noise, not a tiled fetch.)
* **Grass and ground cover.** Blades fade out between 38 and 120 m at 0.80, flowers became
  rare (`fsel > 0.978`) instead of confetti, and the palette was desaturated to olive:
  over-saturated emerald plus tiny flowers read as a bowling green with sprinkles.
* **Fog of war.** v1-style grey haze over unexplored ground looked like fog, not the
  unknown. Now: dark unseen country, bright seen country, with a **long gradient** across
  the boundary (~30 m of transition rather than a rim). Memory of explored ground stays near
  full brightness (200/255) instead of 118, so there is exactly one honest boundary — the
  edge of the known world.
* **The starting valley.** A fresh match used to reveal a ~22 m disc, which read as a
  spotlight parked on a dark field. `surveyHome()` now draws a ragged, deterministic
  boundary at **68 m** with three harmonics, wide enough that the edge sits off-screen at
  the default camera distance, and stopping well short of the enemy base so exploring is
  still the opening move.
* **Town dressing.** Eight new props (crate, barrel, haystack, firewood, cart, well, fence,
  drying rack) stream in with the prop chunks, plus a town apron and decor clumps.
* **Night.** A real moon (limb darkening, maria, craters, cool halo, atmospheric reddening
  when low, hidden behind geometry), a three-layer starfield with twinkle and a milky band,
  and braziers — the four `uTownLight` slots are now visible stone-and-iron objects with a
  three-layer flame, one instanced draw call.
* **The sky became reachable.** The camera pitch floor dropped 0.42 → 0.22 rad and the rail
  gained hold-to-tilt buttons, because before that nothing on a phone could point the camera
  high enough to see any sky.

### 3. Bugs found by play-testing

A screenshot pass says "the pixels are not broken". It does not say "the button works".
Driving a whole session through Chromium (`tests/playtest.mjs`) found these, all now fixed
and covered by tests:

| Symptom | Cause | Fix |
|---|---|---|
| Age advance was impossible from the HUD all match | `canAdvanceAge()` returned a boolean, the HUD read `.ok` (always `undefined` → falsy) | returns `{ok, reason}` with `Already advancing` / `Final age` / `Not enough resources` / `Needs a town centre` |
| A card that became affordable still said "not enough resources" forever | `ui.update()` stamped `this.sig` *before* calling `refreshCommands()`, which then early-returned | the update path computes the signature, resets `sig`, and lets `refreshCommands` own it; the signature includes the enabled flag |
| Build, Gather, Stop, Atk-Move and every utility card swallowed their own clicks | the card tested `!c.enabled`; `enabled` is **opt-in**, so an absent flag meant "disabled" | only an explicit `enabled === false` blocks a command, and it gets `aria-disabled` |
| Re-entering a match stacked two sets of command cards | `#cmdGrid` outlives the UI instance; `setGame()` never cleared it | `setGame()` clears the grid, the button pool and the ad-hoc guard |
| The build menu flashed and closed before a thumb could reach it | the selection's own commands overwrote it on the next 9 Hz tick | the menu is modal via `_adHocUntil`, and `ui.update` respects it |
| A foundation could be placed inside a house or in the sea, then sat at 2 % forever | placement never validated, and nobody was ordered to build it | `canPlaceAt()` with a reason toast, plus `orderBuild(p.builders)` for the villagers who opened the menu |
| In sandbox, a hand-placed enemy unit marched off across the island | sandbox still constructed an AI controller for team 2, which does not exist there | no AI in sandbox (`app.ai === null`) |
| Every log pile in the game stood on end; the cannon barrel pointed at the sky; hay bales were barrels | `cyl()`'s `rot` option is the **angular start** (a UV seam offset), not a tip-over — and ten call sites used it as one | `cyl()` gained a real `axis: 'x' \\| 'z'` with proper rotations (det +1, so winding and normals stay outward); ten call sites converted |
| Barrels, haystacks, the well and firewood hung half a metre off the ground | the prop origin was not at the base | geometry moved down; `tests/geo.test.mjs` now asserts every prop touches the ground and matches its declared height |
| Every wall in town was painted with horizontal zebra stripes | the plaster texture's trowel sweeps were 6:1 anisotropic at 0.42 amplitude | gentler anisotropy (0.016 × 0.030) at 0.21 |
| Large grey smudges drifting across the meadow | cloud shadows at 20 % strength on a ~900 m wavelength | softer (0.90), smaller (0.0017 scale) |
| Bushes read as mossy boulders; broadleaf canopies were emerald | three fat spheres in a row; over-saturated leaf colour | four uneven lobes, olive leaf palette |
| Firewood was six brown tubes | one material, no sawn ends | bark body plus pale sawn end caps |
| The start button was below the fold on a phone | menu layout | menu card re-laid out for 640 × 360-ish viewports |

The test that found them is described in [Testing](#testing). It is now a CI gate.

---

## Testing

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static bundle in dist/

npm test             # 15 offline suites, ~24 s
npm test -- --ci     # same, explicit non-zero exit (this is what CI runs)
npm test -- --browser # adds the Chromium smoke test and the play-test

npm run test:play    # 12-check play session in Chromium (needs a build first)
npm run test:browser # 26-check boot/play/pixel run
npm run test:soak    # 220–260 unit battle: heap, tick cost, draw calls, DOM growth
npm run balance      # headless battle matrix; add --full for the mixed army
npm run apk          # needs JDK 17 + Android build-tools; see scripts/build-apk.sh
```

`npm run test:play`, `test:browser` and `test:soak` all call
`scripts/browser-libs.mjs` first, which unpacks the shared libraries that ship with
`@sparticuz/chromium`. On a machine without NSS installed that is the difference between a
2.5-minute test and `libnss3.so: cannot open shared object file`.

### What each suite proves

| Suite | What it protects |
|---|---|
| `shell.test.mjs` | every asset the page references exists; manifest/icons installable; APK shell files present |
| `contract.test.mjs` | UI/input ↔ simulation API: every `game.*()` the HUD calls exists, every HUD id the UI binds exists in `index.html`, every `data-*` attribute read is written somewhere, state literals all exist in `STATE` |
| `geo.test.mjs` | every primitive is wound outwards (divergence-theorem volume), normals unit length, no NaN/degenerate triangles, triangle budget, prop ground contact and size, the brazier's flame sits at the firelight height |
| `audio.test.mjs` | the WebAudio graph against a strict fake that throws on wrong node types |
| `shaders.test.mjs` | GLSL parses; version/precision/interface/uniform rules; no `sampler2DShadow` misuse; texture-array layers match |
| `sim.test.mjs` | world math, pathfinding, economy, gathering, building |
| `survey.test.mjs` | the starting valley is known ground: area, ragged (non-circular) edge, enemy base still hidden, deterministic, cheap |
| `combat.test.mjs` | equal-cost armies trade evenly; armour subtracts; the counter triangle holds |
| `daynight.test.mjs` | gather/melee/sight multipliers, fog radius, phase events fire once, sun and firelight follow the clock, terrain mesh is clock-independent (no rebuild hitch at dusk) |
| `render.test.mjs` | the whole GL pipeline runs against a mock WebGL2 context: no bad buffers, no unknown uniforms |
| `perf.test.mjs` | hard CPU budgets (the table above) |
| `ai.test.mjs` | AI-vs-AI soak: no dead economy, no idle army, age progression, tick budget |
| `ui.test.mjs` | every HUD button for every unit and building type in jsdom, plus command-card regressions (no duplicate cards, stale closures, modal build menu) |
| `app.test.mjs` | boot → match → taps/drag/pinch → pause/save/end, then a **sandbox** match that asserts no AI exists and a hand-placed unit is left alone |
| `dist.test.mjs` | the minified production bundle boots and renders |
| `browser.mjs` | real Chromium: boot, play, taps, day/night pixels, night-sky pixels |
| `playtest.mjs` | a whole session through the real DOM — see below |
| `soak.mjs` | phone-profile soak: 260-unit battle, post-GC heap, tick cost, draw calls, DOM growth |

### The play-test in detail

`tests/playtest.mjs` boots the **production bundle** at a Realme-9i-sized viewport and plays
a campaign opening the way a person would. Twelve checks:

1. the menu opens a match (5 villagers, 3 buildings, 6/15 pop)
2. tapping a villager selects it, dragging a box selects the group
3. a gather order sends villagers to the woodline and wood goes up (300 → 405)
4. the build menu places a house and villagers finish it (pop cap 15 → 20)
5. the town centre queues and delivers a villager
6. advancing an age costs resources and changes the age (earned, not cheated:
   the test puts villagers on whatever is short and waits)
7. night falls: shader, firelight and clock agree
8. the camera rail: zoom, tilt and rotate all move the camera
9. the minimap and pause menu work
10. a sandbox battle: build a barracks (age ≥ 2), train soldiers, order an attack, take losses
11. the frame stays inside the phone budget afterwards
12. no console or page errors during the whole session

It writes `ci/playtest-report.md` and one screenshot per checkpoint (`ci/screenshots/pt-*.png`).

Two design notes that matter if you extend it:

* Headless Chrome renders in software at 1–2 fps, so the **simulation is advanced
  deterministically** at 60 Hz from inside the page (`__pt.step(seconds)`), while every
  *input* still goes through the real DOM and the real pointer handlers. Never quote headless
  fps as device performance.
* The harness exposes `window.__pt` (`startMatch`, `step`, `tap`, `drag`, `cmd`, `labels`,
  `state`, `screen`, `unitScreen`, `center`, `selectBuilding`, `tapBuilding`, `setTime`).
  It is installed per test session and torn down with the page.

### CI

`.github/workflows/android.yml`, one job, 23 steps, on every push to `main`, `arena/**`
and any pull request to `main`:

```
checkout → node 22 → JDK 17 → Android build-tools
→ npm ci → npm run test:ci (15 suites)
→ npm run build
→ browser.mjs (smoke + pixels)        [report posted to the PR]
→ soak.mjs (phone profile)
→ playtest.mjs                        [12 checks, gated]
→ assert all three reports exist and passed
→ upload screenshots + reports
→ build APK (aapt2 → javac → d8 → zipalign → apksigner)
→ verify signature, dump badging, sha256
→ upload artifact → publish/refresh the GitHub release
```

The browser steps run with `continue-on-error` **on purpose** (so the diagnostics get
published even when they fail) and are then re-checked by explicit assertion steps that
fail the job. A run that produces no report fails; that is what stops a 191-byte artifact
from passing as a green browser test.

### Screenshots

```bash
node tests/shot.mjs --out ci/shots --quality high --warm 2200 --settle 700 \
  --shots '[{"name":"noon","tod":0.5,"yaw":0.7,"pitch":0.62,"dist":34},
            {"name":"night","tod":0.93,"yaw":0.55,"pitch":0.5,"dist":30}]'
```

`tod` is a 0–1 fraction of the day. Also useful: `dx`/`dz` to offset the camera target,
and `"hide":["log","rock"]` to drop a decor family and see what it contributes. `settle` is
in milliseconds; it exists because a headless frame may take a second.

`node tests/px.mjs shot.png x,y` prints the sRGB pixel — the cheapest way to prove a
day/night colour change actually reached the framebuffer.

---

## Field notes and traps (read this before you change anything)

Hard-won, in rough order of how much time each cost.

### Environment

* **`apt-get` is unusable in this sandbox** and there is no local JDK or Android SDK, so the
  APK must be built in CI. Don't waste a turn trying to install build-tools locally.
* **`npm i puppeteer` fails** (it wants to download a browser). Use
  `@sparticuz/chromium@131` + `puppeteer-core@23`, which is what the test scripts do.
* **Chromium needs NSS.** `@sparticuz/chromium`'s `executablePath()` unpacks the binary but
  **not** the shared libraries, so a bare container dies with
  `libnss3.so: cannot open shared object file`. `scripts/browser-libs.mjs` brotli-decompresses
  `al2.tar.br` and `al2023.tar.br`, extracts both over each other (al2023 carries the full
  `libnspr4` / `libplc4` / `libplds4` set) and exports an `LD_LIBRARY_PATH`. Verify with
  `ldd $(node -e "…executablePath()") | grep 'not found'` → must be empty.
* Harness scripts must live **inside the repo**; the snapshot only keeps the workspace.

### Headless Chrome

* **SwiftShader runs at 1–2 fps.** Never measure or quote fps from it. Drive
  `game.update(1/60)` in a loop from the page instead, and measure *tick* cost and draw
  counts. Real device performance needs a real phone (see limitations).
* **A "wait 2 seconds" is not a rendered frame.** After `setTimeOfDay()` you must poll until
  `renderer.worldTime` matches `game.worldTime`, otherwise you screenshot the previous hour.
  `shot.mjs` and `playtest.mjs` both do this.
* Use long timeouts (120–180 s) for `waitForFunction`; boot + worldgen in software GL is slow.
* **Taps land behind the HUD.** A tap within ~210 px of the minimap or ~150 px of the bottom
  bar hits the interface, not the world. Centre the camera first
  (`camera.setTarget(x, z, true)`), then project the world point with `camera.project(x, y, z, out)`
  — **not** `camera.project(x, y, z, [0,0,0,0])`, which returns nulls.
* Entities use `dead`, not `alive`. `unit.stats` is a method. Track deaths through
  `game.onEvent` rather than diffing arrays.
* `game.daylight` is never exactly 1 (0.9983 at noon). `game.stats` is an object.
* `performance.memory` needs `--js-flags=--expose-gc`; the meaningful signal is heap delta
  across identical batches, not absolute heap.

### Writing browser tests

* Drive the simulation through a helper installed **in the page** (`window.__pt`), and keep
  the Node side to assertions and screenshots. Crossing the boundary per frame is far too
  slow.
* One `step(seconds)` should advance the sim **and** the HUD at its real cadence
  (`ui.update(0.12–0.25)`). A step that skipped the 9 Hz command-card tick left a button
  whose closure still thought the age was unaffordable — a genuinely confusing failure.
* Prefer asserting on **state** (`ageResearch`, `buildings`, `res.wood`) and only then on
  the DOM. When both are available, a state assertion tells you *what* broke.
* Make the test earn its economy. The opening cannot afford an age; putting villagers on the
  shortfall and waiting is both the honest test and the thing a new player must learn.

### Geometry and models (`src/gfx/geo.js`, `src/gfx/models.js`)

* **`cyl(x, y, z, rTop, rBot, h, seg, opts)` has an `axis` option** (`'x'` or `'z'`);
  `opts.rot` is the angular start, a UV seam offset, **not** a rotation of the whole
  cylinder. Ten call sites had this wrong and built vertical poles where logs, cannon
  barrels, hay bales and the ram's log should have been.
* `gable()` / `hip()` take `{rotY, ridge}` only — **no `mat` option**. Set the material
  before the call.
* Normals come from winding. Any transform you add to a primitive must have determinant
  +1, or the faces turn inside out and render black.
* **Props are placed with their origin on the terrain.** A prop whose geometry starts at
  y = 0.36 floats. `tests/geo.test.mjs` checks ground contact and declared height for every
  prop — keep it passing.
* `MAT_SCALE` is texture repeats per metre, per material. A 2.2 repeat looks fine on a wall
  and obviously tiled on a 6 m roof (currently the town centre's roof is the worst offender).
* Tiny instanced props read as black slivers at RTS distance; flatness is a shader and
  composition problem, not a density problem. Adding more pebbles will not fix it.

### Shaders (`src/gfx/shaders.js`)

* Anything that uses `N` must follow this order, or backfaces light wrongly:
  ```glsl
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  ```
* `sampler2DShadow` for the shadow map; texture-array layers must all be the same size.
* Emissive above ~2 blows flames to white through ACES. The brazier flame lives in
  `(1, 0.42, 0.10) * (0.14 + uNight * 2.3) * flicker`.
* Firelight has to be **added** with a warm base, not multiplied by the night albedo — the
  multiply gave a few percent and the braziers lit nothing but themselves.
* Avoid a second texture repeat for ground detail: it aliases into confetti. Use procedural
  noise faded by distance.
* The `stampRoad` splat byte must be **raised** for the layer you want; lowering it is
  invisible.
* Grey haze over unexplored terrain looks like fog, not the unknown. Dark unseen + long
  gradient is right.

### The HUD (`src/game/ui.js`)

* **`enabled` is opt-in.** Only `enabled === false` blocks a click. Writing `!c.enabled`
  disables every flag-less card — which is exactly what happened.
* **`refreshCommands()` stamps `this.sig` itself.** Never assign `sig` before calling it;
  the early return leaves stale closures behind. Any signature that gates a rebuild must
  include the enabled flag.
* `ui.setGame()` must clear `#cmdGrid` and the button pool: the grid element outlives the UI
  instance, so a restart stacked two sets of cards pointing at the dead match.
* The build menu is modal through `_adHocUntil` (60 s). Don't remove that guard — without
  it the panel closes on the next 9 Hz tick.
* Tooltips keyed on a coarse phase never update. Key them on the **numbers**
  (`_lastDayKey` = phase + rounded multipliers).
* Don't rebuild text you can patch. Every `innerHTML = ''` in a hot path is a layout thrash.

### Simulation (`src/sim/`)

* Aggro, auras, splash and unit pushing all go through the spatial hash. If you add a query,
  do the same — `tests/perf.test.mjs` will catch a regression as a 99th-percentile tick.
* The sim is fixed-step; anything time-based must use `dt`, never wall clock.
* `canAdvanceAge` returns `{ok, reason}`; `startAgeAdvance` still returns a boolean and
  refunds if there is no town centre.
* Room for growth: the AI is one controller with scripted waves. It does not scout, expand,
  wall or deny. That is the largest gameplay gap.

### Android and the APK

* Serve assets from `https://appassets.local/`, **not `file://`**. A secure origin is what
  gives you `localStorage`, pointer events, WebAudio and WebGL2 without surprises.
* The APK build is plain `aapt2 → javac → d8 → zipalign → apksigner`. No Gradle, no
  network. Keep it that way; it is why CI finishes in three minutes.
* Ship the built `dist/`, never source maps.

### Git and CI

* Commit to the session branch and push only to it. CI publishes a release from
  `arena/**` as well as `main`.
* If the workspace is rolled back to the base commit, the branch still exists on the
  remote: `git fetch origin <branch> && git reset FETCH_HEAD` restores the working tree
  with all uncommitted edits intact.
* `gh pr edit` is unreliable in this environment — use
  `gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -F body=@file`.

---

## Known limitations (honest list)

Ordered by how much they matter.

1. **It has never run on an actual Realme 9i.** Every number in this README comes from a CPU
   rasteriser or jsdom. The adaptive-quality ladder is the safety net, but its thresholds
   (21 ms down, 11.5 ms up, 26 ms scale drop) were tuned against measurements from a
   different machine. The first thing anyone with the phone should do is run with the perf
   chip enabled (`diagBtn`) for ten minutes and record the quality level it settles on.
2. **Units are the weakest visual.** At the default 34–44 m camera distance a soldier is
   ~50 px tall and reads mostly as team colour. Weapons are thin, there is no rim light, no
   contact shadow, and helmets are a single box. This is the highest-value art work left.
3. **No ambient occlusion or contact shadows.** Buildings and props look pasted onto the
   ground because their only grounding is the shadow map. A cheap blob-shadow decal under
   units and props would fix 80 % of it.
4. **Texture tiling is visible** on large surfaces: the town centre roof, the castle keep,
   and the plaster on long walls. Needs a detail-scale break-up (two-scale UVs or a
   triplanar-ish blend) rather than a new texture.
5. **The AI is shallow.** One controller, scripted waves, fixed villager target. No scouting,
   no expansions, no walling, no counter-composition. It is a decent sparring partner and a
   poor opponent.
6. **No multiplayer.** No netcode, no lockstep, no lobby. Nothing in the architecture
   prevents it — the sim is deterministic and fixed-step — but it is unbuilt.
7. **No campaign.** Four modes, no missions, no progression, no scripting layer for
   objectives.
8. **Water is a shader, not a reflection.** No planar reflection, no shoreline blending; the
   waterline is a hard edge where terrain meets water.
9. **Balance has known soft spots.** In the headless matrix archers lose badly to knights
   (0–6) and to swordsmen; kiting is what makes them work in real play, and the AI does not
   kite. Ranged units also get no night bonus by design.
10. **Accessibility is thin.** No colour-blind team palette, no UI scale slider, no
    reduced-motion mode, no remappable touch layout. Text is English only.
11. **No crash diagnostics from the field.** No telemetry (good for privacy, bad for
    debugging), so a bug on a specific Adreno driver will be hard to reproduce.
12. **Touch command depth is limited.** No shift-queue equivalent, no waypoint chains, no
    formation drawing. Orders are single-shot.
13. **Save is autosave-only.** One slot, no naming, no export/import.
14. **No visual regression tests.** Screenshots are produced and eyeballed, but nothing
    compares them to a baseline; a shader regression that keeps the page "working" would
    only be caught by a human looking.
15. Bundle is a single chunk. Irrelevant for an offline APK, relevant if this ever becomes
    a web-first product with a cold-start budget.

---

## Roadmap: how to take this to another level

Grouped by cost. Every item lists what it buys and what it costs on an Adreno 610, because
"make it prettier" is not a plan on a 4 GB phone.

### Tier A — cheap, high impact, safe on this GPU

| Idea | What it buys | Cost |
|---|---|---|
| **Blob contact shadows** — a small dark decal under each unit and prop, drawn into the existing decal batch | everything stops floating; the single biggest perceived-quality jump available | ~1 draw call, no shader change |
| **Unit silhouette pass** — thicker spears, real bows, helmet shapes, a 1 px rim light on the team colour | armies read as armies at 40 m | geometry only, +2–3 k master tris |
| **Two-scale roof and plaster** — multiply the texture by a low-frequency procedural break-up | kills visible tiling with no new assets | a few ALU in the model shader |
| **Footstep dust and grass sway** near moving units | the world responds to the army | existing particle pool |
| **Corpse decals that fade** and a small blood/impact decal pool | battles leave a mark; reads as consequence | decals already exist |
| **Order feedback** — dashed path line for the selected group, ground ring at the destination | far better touch feedback; the player can see what the game heard | one line batch, no new pipeline |
| **Damage numbers off by default, hit flashes on** | readability in melee | instance attribute already exists (build progress slot) |
| **Day/night gameplay HUD** — a small ring on the clock showing the next phase | teaches the rule without a tooltip | DOM only |
| **Save slots with names and timestamps** | people will play more than one game | localStorage, no engine work |
| **UI scale + colour-blind palette + reduced motion** | accessibility, and it is genuinely cheap | CSS variables |

### Tier B — medium, needs a design decision

| Idea | What it buys | Cost / risk |
|---|---|---|
| **Real AI: scouting, expansions, army composition** — a behaviour tree over the existing controller | the game becomes an opponent rather than a wave generator | sim CPU only; test with `ai.test.mjs` soak |
| **Campaign of 8 hand-authored missions** with objectives, triggers and a briefing screen | a reason to play solo; the biggest missing *product* feature | needs a small scripting/mission format and content |
| **A third resource axis: stone walls and siege** — currently walls exist but sieges are shallow | tactical depth in the Castle/Imperial ages | balance pass required |
| **Formations and waypoint queues** (line, wedge, box; drag a path with two fingers) | the tactical layer the roadmap promises | input work, mostly |
| **Hero units with abilities** (one per civ, active button in the command card) | personality; something to build a campaign around | needs ability cooldowns in the sim |
| **Replay + observer mode** (record inputs, deterministic sim) | debuggability, content for social, cheap because the sim is deterministic | file format + playback UI |
| **Local multiplayer over LAN/WebRTC data channel** | two phones, one match | netcode: lockstep with input delay; the deterministic sim is the hard part already done |
| **Map editor / scenario seed sharing** (seed string in a URL) | community content for near-zero cost | menu + serialisation |
| **Audio depth: per-biome ambience layers, battle intensity music** | atmosphere | WebAudio synth, no assets |
| **Screen-space AO at low quality** (half-res, 4 taps, no blur) | contact darkening in corners | ~0.5–1 ms at 0.68 scale on this class of GPU — measure before shipping |
| **Terrain LOD / clipmap** | lets the camera pull further out without 97 k tris | moderate renderer work |
| **Weather** (rain with wet-ground specular, snow that tints the splat) | a whole different look for the same world | shader work; rain is cheap as a particle system |

### Tier C — ambitious, but this codebase can carry it

| Idea | What it buys | Notes |
|---|---|---|
| **Skinned-unit LOD with 2-part impostors** for distant armies | 200+ units on screen at 60 fps | bake the rig into a texture, billboard beyond the cull distance |
| **Clustered forward lighting** (replace the 4-slot `uTownLight` array) | dozens of torches, windows and fires at night | the night would become the showcase feature; ~1 ms risk |
| **Planar water reflection at low res** with a stencil clip | the island finally looks like an island | half-res RT + one extra pass; must be quality-gated |
| **Naval gameplay** — transports, galleys, docks with real pathing | the map is an island; the water is currently scenery | pathfinding on water, boarding, ship combat |
| **Seasons that change the terrain and the economy** | a long match has an arc | splat + palette + multipliers, cheap in simulation |
| **Deterministic replay-driven tutorials** recorded once and played back | onboarding without writing a tutorial system | free if replays exist |
| **Cross-platform saves** (share a seed + a compact state blob) | phone → desktop continuity | serialisation only |

### The one thing to do first

If exactly one improvement is possible: **contact shadows plus a unit silhouette pass.**
That combination changes the game from "a competent RTS that looks like a board game" to
"a game that looks expensive", for a few GPU microseconds and no new architecture. The
second is **one ten-minute session on the actual phone with the perf chip on**, because
everything else in this document is calibrated against a machine that is not the target.

---

## Recipes: how to extend it

**Add a unit.** Add a definition to `UNIT_DEFS` in `src/sim/data.js` (cost, hp, attack,
armour, speed, `classes`, `age`, `icon`, `trains`), add a model with `U('name', …)` in
`src/gfx/models.js` using the six-part rig, and add it to a building's `trains` list. Then
run `npm run test:geo` (triangle budget), `npm run test:ui` (every button for every unit
type is clicked), and `npm run balance` (the counter triangle must still hold).

**Add a building.** Same shape: `BUILDING_DEFS` entry, `B('name', …)` model, `BUILDING_AGE`
if it is gated. If it produces, research or garrisons, the HUD picks it up automatically —
`commandsForSelection()` derives the card from `def.trains`, `def.research`, `def.ageAdvance`,
`def.market` and `def.garrison`.

**Add a technology.** `TECH_DEFS` entry with its `at` building; the HUD lists it on that
building's card when the age allows and the tech is not yet owned.

**Add a decree.** Append to `DECREE_LIST` in `src/sim/game.js`; `apply()` gets the game, the
team state and the team id, and should either start a buff (`g.addBuff`) or do something
immediate.

**Add a test.** Copy the `check(name, fn)` pattern at the top of any suite; `tests/run.mjs`
picks up new files only when you add them to `SUITES`. Browser checks belong in
`tests/playtest.mjs` (through `__pt`) or `tests/browser.mjs` (through `expect`).

**Change the look.** Work in `tests/shot.mjs`, not in the game: pose the camera, shoot the
same three views (noon wide, noon close, 22:30 at a brazier), and keep them side by side
while you edit. Every visual change in this project's history was chosen that way, and the
two that were chosen without a screenshot (the 6:1 plaster anisotropy and the 20 % cloud
shadows) were both wrong.

---

## Credits

Every mesh, texture, shader and note is generated in code at runtime; the only runtime
dependency is the browser. No image, font, sound or model file ships with the game.

Built with a lot of profiling, a lot of screenshots, and an unreasonable number of
`cyl(…, { rot: Math.PI / 2 })` calls that should have been `axis: 'z'`.
