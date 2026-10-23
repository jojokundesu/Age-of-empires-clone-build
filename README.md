# Imperial Crown 3D

A hand-built real-time strategy game — **not** a web page with a 3D library bolted on.
The renderer, the simulation, the interface and the audio are all written from scratch
for one target: a solid 60 fps (90 Hz display) on a **Realme 9i / Adreno 610**, with no
asset downloads at all.

```
   ┌───────────┐   ┌─────────────┐   ┌──────────────┐
   │  sim/     │──▶│  gfx/       │──▶│  game/       │
   │ world,    │   │ WebGL2,     │   │ HUD, menu,   │
   │ economy,  │   │ instancing, │   │ input, audio │
   │ combat,AI │   │ PBR-ish     │   │              │
   └───────────┘   └─────────────┘   └──────────────┘
```

## Download the game

| | |
|---|---|
| **Android APK** | https://github.com/jojokundesu/Age-of-empires-clone-build/releases/latest/download/imperial-crown.apk |
| **Browser build (zip)** | https://github.com/jojokundesu/Age-of-empires-clone-build/releases/latest/download/imperial-crown-web.zip |

The APK is a signed WebView shell that ships the whole game offline inside the package
(≈5 MB): open it on the phone, allow "install unknown apps" when prompted, play.
No internet permission is required or requested for gameplay.

## What is in the box

**World** — a 512 × 512 m island generated from a seed: ridged multifractal heightfield,
seven biomes, roads stamped into the terrain splat, 961 resource nodes (forests, gold and
stone veins, berry bushes, deer, fish, relics), 2 100+ pieces of decorative clutter, three
neutral shrine points of interest and three river fords.

**Economy** — villagers gather food/wood/gold/stone, carry 12 units, drop off at the
nearest matching building, farms reseed themselves, trees regrow to 55 %, markets trade,
techs and Imperial Decrees (favour) change the maths, four ages, population houses.

**Combat** — a real counter triangle with armour that actually subtracts:

```
   spears ──▶ cavalry ──▶ archers ──▶ spears
   (skirmishers counter archers, swordsmen counter spears)
```

Damage is `max(1, attack + classBonus − armour)`; arrows use pierce armour, sieges
bypass 65 % of it. Archers, skirmishers, hand cannoneers, mangudai, towers and castles
fire pooled projectiles with arc, splash and impact FX.

**Presentation** — 22 buildings, 29 units, 21 prop types, all procedurally modelled
(22 k triangles of master geometry, instanced): half-timbered houses with plaster infill
and timber framing, shingled and thatched roofs, crenellated stone walls, a cathedral-like
castle keep, 20-sided round towers. Multi-jointed units (hips, shoulders, extra parts)
animate **on the GPU** from a single instance stream — a 40-unit melee is one draw call.

**Lighting** — ACES-tonemapped HDR-ish pipeline: directional sun + hemispheric ambient,
2048² PCF shadow map that follows the camera, exponential fog, procedural cloud shadows,
baked terrain splatting (grass/dirt/rock/sand/cobble/snow), animated water with normal
maps, fresnel and depth tint, a full day/night cycle with stars and a moon, a post pass
with bloom-ish grade, vignette and film grain.

## Controls (touch)

| Gesture | Action |
|---|---|
| tap | select / order |
| drag | pan the camera |
| two-finger pinch | zoom |
| two-finger twist | rotate |
| drag a box | select an army |
| long-press ground | attack-move |
| minimap tap / drag | jump the camera |
| ⛏ Build → tap a spot | place a building |

Keyboard (desktop): WASD/arrows pan, Q/E rotate, +/- zoom, Space pause, H home,
A attack-move, S stop, F next idle villager, 1-9 groups, Esc deselect.

## Why it runs smoothly on a phone

v1 of this project hung because of leaks, O(N²) scans and DOM thrash. The rewrite removes
all three by construction:

* **Zero per-frame allocation.** Every scratch vector/matrix lives on the object that uses
  it; particle, projectile and unit pools are fixed-size arrays; the frame loop never
  creates a closure, array or object.
* **One draw call per model type.** Instances are streamed into 32-byte-per-instance
  buffers; animation (leg swing, arm raise, siege wheels, banner sway, construction rise)
  is evaluated in the vertex shader.
* **Spatial hashing for every query** (`sim/spatial.js`): aggro, auras, splash damage and
  pushing are O(1)-ish per unit instead of O(N²) over ~450 entities.
* **Picking is screen-space** against the same spatial hash — no recursive raycasts.
* **The HUD is built once.** Updates patch text/widths only when a signature changes;
  the command card is diffed at 9 Hz, the minimap at 11 Hz.
* **Adaptive quality.** If the frame time drifts over 26 ms the renderer steps down
  (shadows, resolution scale, prop distance, particle cap) and tells you.
* **Fixed 60 Hz simulation** with a capped catch-up, so a slow frame never cascades.

Measured headless on this repo: 0.23 ms average tick for a 600 s AI-vs-AI match,
48 k triangles / 58 draw calls in a typical frame.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle in dist/
npm test           # 6 suites: sim, combat, renderer, HUD, app, bundle
npm run balance    # headless battle matrix (counter triangle)
npm run apk        # needs JDK 17 + Android SDK build-tools
```

### Tests

| suite | what it proves |
|---|---|
| `tests/sim.test.mjs` | world math, pathfinding, economy, gathering, building |
| `tests/combat.test.mjs` | equal-cost armies trade evenly, armour, counter triangle |
| `tests/render.test.mjs` | the whole GL pipeline runs (mock WebGL2), no bad buffers/uniforms |
| `tests/ui.test.mjs` | every HUD button for every unit/building type (jsdom) |
| `tests/app.test.mjs` | boot → match → taps/drag/pinch → pause/save/end (jsdom) |
| `tests/dist.test.mjs` | the minified production bundle boots and renders |
| `tests/ai.test.mjs` | long AI-vs-AI soak; tick cost, no errors |

## Repository layout

```
index.html              HUD, menu, modals, icon sprite, boot screen
src/main.js             app shell: boot, match lifecycle, fixed-step loop, autosave
src/core/               math (vec/mat/noise), WebGL2 wrapper (shaders, mesh, RT, shadow)
src/sim/                worldgen, data tables, pathfinding, units/buildings, projectiles,
                        spatial hash, AI, game rules
src/gfx/                procedural textures, geometry builder, models, shaders, batcher,
                        renderer, camera, particles
src/game/               HUD (ui.js), menu, input, WebAudio synth
src/styles/ui.css       the entire interface
android/                WebView shell (serves assets over https://appassets.local)
scripts/build-apk.sh    aapt2 → javac → d8 → zipalign → apksigner, no Gradle
.github/workflows/      CI: tests, APK, release assets
```

## Credits

Everything (geometry, textures, shaders, sound) is generated in code at runtime; the only
external runtime dependency is the browser. Built with a lot of profiling.
