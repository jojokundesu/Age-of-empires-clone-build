# Imperial Crown 3D — Version 6

Version 6 is a separate continuation of [`imperial-crown-v4`](../imperial-crown-v4/); v5 is kept beside it. The v4 and v5 source, assets, Android packages and save slots remain untouched. V6 keeps the same procedural art, custom WebGL2 renderer, strategy simulation, 30 Hz fixed tick, LOD, and adaptive quality governor; its controls operate on the actual units in that simulation rather than a second game.

## What changed in 6.3.0

Two things: the download, and a neighbour in the sandbox.

- **A third party in the Grand Sandbox.** The sandbox now seats two crowns: you, and **The Free Company**
  (purple) -- a working town with a hall, houses, woodcutters and a watch on its own gate. It is not
  your enemy. Nobody strikes first: `Game.canFight()` is the rule every automatic decision asks --
  auto-acquire, attack-move, raiders, guards, first-person aim assist -- and while a party is in
  `game.peace` it answers false for both sides. `Game.isHostile()` still says yes, so *an order you
  give is obeyed*: tap one of their men and your soldiers attack him. The first blow ends the peace
  for good (`noteAttack` → `breakPeace`, announced once), after which the war is mutual and their
  council puts men in the field. Their council still works while at peace -- it builds, hires and
  ranks up -- it simply does not march, because its campaign clock is unreachable and its soldiers
  answer to `canFight`. The pause panel names the party and its temper: *at peace -- will not strike
  first* / *at war with you*. While at peace the party shares its map with you, so its town is
  visible instead of being a fog-shaped hole. `tests/party.test.mjs` (10 checks) proves all of it
  headless, and `tests/app.test.mjs` proves the browser wiring.

## What changed in 6.2.0

The second list that came back from playing on the phone, answered one item at a time.

- **Mana is a river, not a ration.** 250 at Apprentice, 1000 at Ascendant, regenerating 14 to 64 per
  second (`RANKS` in `src/mods/arcane.js`). Mana is no longer what limits a high-rank mage.
- **Cooldowns collapse with rank.** `cdScale(rank) = max(0.1, 1 - 0.18 * (rank - 1))`: an Ascendant
  pays a tenth of the printed number, so a fireball is repeatable every 0.32 s and Meteor, Golem and
  Thunderstorm all come back inside one fight. SKYFALL is 3 castings a day at rank 6; the book counts
  them down ("2 left") instead of saying "tomorrow" after the first.
- **One mage, and he comes back.** `MAX_BASE_MAGES = 1`; an Arcane Tower teaches faster but no longer
  raises the cap. `onDeath` schedules a replacement 45 s later at the nearest completed TC/castle, **at
  Apprentice rank**.
- **No duplicate spells.** One single-target and one area spell per element: Fireball (one body, 96 +
  burn) and Meteor (delayed 5 m blast); Ice Lance (freezes the man it hits for 1.6 s) and Frost Nova
  (area freeze). The second area-freeze, Stasis, became **Shatterfrost**: triple damage against
  anything already frozen or slowed.
- **Golems scale with rank.** Rank 4 raises one Stone Golem; rank 5 adds a Granite Colossus that slams
  the ground every 2.6 s; rank 6 adds an Obsidian Titan that hurls molten rock at 9 m and sets fire to
  what it hits. The lifetime timer stays (26 s, 34 s at Ascendant).
- **Blink is a teleport.** 30 m, and it lands as close as the ground allows instead of refusing
  because the last centimetre of the line is a wall.
- **Casting works while running.** The spell shelf casts on `pointerdown` (a `click` is never
  delivered while the other thumb holds the stick), and an armed spell can be released with a tap in
  first person, which it could not do at all.
- **Ice you can see.** A frozen body wears an ice crystal for the whole freeze (`_drawIceShells`, a
  hand-built spike mesh), and an area freeze sheets the ground with a faceted pane until it expires
  (decal kind 4). Time Warp, Thunderstorm, Hailstorm, the golems' footprint and every Arcane Ward keep
  their own mark for their real duration (`groundMarkers` now honours `hold`).
- **Health regeneration exists and is documented.** Out of combat for 6 s, a soldier recovers 0.9 hp/s
  up to 35% of his health (`REGEN_LIMIT`/`REGEN_RATE`/`REGEN_DELAY` in `src/sim/entities.js`).
  Berserkers and the Champion's Field Medic perk heal past that cap.
- **A Codex on the main menu.** `src/game/codex.js` builds four tabs -- Spells, Ranks & mana, Health,
  Perks -- from the live mod and Champion data, so it cannot drift from the rules.
- **Farms and placement.** Tapping a finished farm with villagers selected now sends them to harvest
  it, and `orderGather` pins the tapped node as `homeNode`. The building ghost tracks the finger every
  frame and turns red where the footprint is illegal; the tap places exactly that point, and a tap
  that misses the ground is refused with a reason (`input.updatePlacementGhost`).

## What changed in 6.1.0

This round is the list that came back after 6.0.1, answered one item at a time.

- **Morale cannot stop a unit any more.** It is bonus-only: the floor (60) is worth exactly no penalty
  -- same damage, same speed, same toughness -- the ceiling (100) is +8% damage, and the rout
  threshold is unreachable. `break()` heals any stale rout back to `idle`. Every order is obeyed at
  every morale, and the suite proves it at 0, in the field, for 300 s.
- **Your side fights for its ground.** Idle and stand-ground defenders acquire at 13-16 m (archers
  16 m, villagers none) with a 26-34 m leash to their building. `Game.raiseAlarm()` pulls every idle
  defender within 24 m of a hit -- 30 m when a building is hit -- and villagers drop their load and run
  for the nearest roof. Six raiders against six idle spearmen: 0 engaged and a chipped hall before;
  first kill at ~6 s, all six dead by 28 s, hall untouched after.
- **The court is an appointment and its perk.** Writs, decrees, the favour pool and the council panel
  are gone. Four offices (Marshal, Chancellor, Spymaster, Hierophant) cost gold, are held by a person
  on the map and rank up on deeds; death empties the office for 25 s and costs a rank. The Hierophant
  now ranks on healing, which is what a monk actually does.
- **Placement is predictable.** Trees block with their trunk (`ResourceNode.trunkRadius`), not their
  canopy; a bystander is a `unit` reason in the ghost and is stepped aside by `_clearFootprint()`
  rather than refusing the order; the ghost and `placeBuilding` share one rule; first person refuses to
  put a footprint on the builder.
- **One mage, six ranks, and rank 6 is a war-ender.** The five hidden rank defs no longer appear as
  trainable cards. Damage scales with rank (`1 + 0.48 * (rank - 1)`, 3.4x at Ascendant), the book
  casts on real cooldowns, and the spells that did nothing now work: Fireball 62 + a five-second burn
  on a 3.2 s cooldown, Ice Lance hits the man it was aimed at, Chain Lightning leaps six times, Frost
  Nova freezes the circle. Casting uses the tapped lock first, then the reticle.
- **Two long-standing bugs closed.** A unit kept the first-person camera's yaw as its facing after
  you left it; and an AI wave whose target hall had been razed marched to the empty coordinates and
  stood there for ever -- it now follows the nearest thing that crown still owns.

## What changed in 6.0.1

Everything here came from playing 6.0.0 on the phone, and each one has a check in the suite now
(`tests/economy.mjs`, `tests/morale.mjs`, `tests/champion.test.mjs` and the Chromium pass).

- **Armies no longer turn round and walk home.** Morale charged -1.05 a second to any unit more than a
  supply radius from a tent, whether it was fighting, marching or standing guard. A march to the enemy
  takes about three minutes, so every army broke on the way and ran for home — "turning away for no
  reason, from the very beginning". Fighting now costs almost nothing, marching costs a slow bleed,
  standing in the open is the real cost, and your own buildings (within 18 m) steady the men around
  them.
- **Villagers keep working.** Standing still to chop was counted as being stuck, so every 3.5 s a
  woodcutter lost his tree and went idle; and once the trees near the town were gone, the 26 m search
  failed and the villager retired for ever. Working states no longer stall, the search widens until it
  finds work, and an idle villager with a trade goes back to it on his own, preferring the field or
  grove he was already working.
- **Farms work.** The card promised food and nothing ever made the building harvestable. A finished
  field is a real food source (the inspector shows what is left), it is resown for 60 wood when bare
  instead of being destroyed by its own harvest, and a bare field with no wood sends the farmer to
  other work rather than stranding him.
- **The spellbook survives the once-a-day spell.** SKYFALL is cast from the map; the map closed the
  book and nothing reopened it, so every other spell appeared to vanish. The book returns with only
  the spent spell marked "Tomorrow".
- **You are told when an army is coming.** The watch calls out enemy soldiers near anything you own,
  with a direction, at most once every 40 s.

## Run it

Requires Node.js 20+ and a browser with WebGL2:

```sh
cd imperial-crown-v6
npm ci
npm run dev             # http://localhost:5273
npm run build           # static, offline-capable dist/
npm run preview         # preview the production build
```

The server binds to `0.0.0.0` and accepts proxied preview hosts. The historical download links in the root README are for earlier releases; the v6 APK link above is the current one.

## Field guide

### Control one unit

1. In strategy view, select **one** available friendly unit and tap **First Person** on its command card. Tap **Strategy** to return to the overhead camera. There is no keyboard: every control in both views is a button or a gesture on the glass.
2. Left thumb on the glass steers; push it past the gold ring to sprint. Right thumb drags to look. **Tap an enemy** to lock on — the Champion then swings on his own as long as the target stays in reach — or hold **Attack** to swing manually. Aim assist is switchable at the top right. **Block** is a toggle (it drops by itself when stamina runs out), **Dodge** is a tap, and both spend stamina. A lightweight decorative held-kit overlay distinguishes swords, bows, spears, axes, a builder's hammer, a mage's staff and a monk's relic; creatures and vehicles do not get a human hand.
3. Villagers can aim at resources or unfinished/damaged friendly buildings and tap **Use** to gather, construct or repair. Their **Build** kit lets them choose an affordable building, aim at the ground and tap **Place**; moving takes direct control back from the work order. Monks can aim and **Use** to heal allies or convert enemies. Other fighting units retain their normal melee, ranged, mounted or siege attacks.
4. A controlled unit remains vulnerable in the same live battle. Direct control ends if it dies, routs, is captured or garrisoned, or the match ends. Pausing clears held controls.

### Play a mage

Mages belong to the existing **Arcane Order** workshop mod: open **Mod Workshop** on the main menu, enable it, and start a mod session. Train a mage at a Town Centre, select it, then enter first person. The **Spells** shelf exposes the mod's real eleven base spells, rank and mana requirements, cooldowns, six discoverable attunements and discovered hybrids. Aim and choose a spell; self-casts affect the mage. Skyfall opens a tactical map so its original map-wide reach and once-per-in-game-day limit are retained. This is the same Arcane implementation and progression used in strategy view, not a separate simplified spell system.

### Create a squad and defend someone

- Open **Squads**, choose **Pick units**, and tap friendly individuals to add/remove them from the current selection. Alternatively select a group in the normal way. Give it an optional name and choose **Create squad**. A squad accepts 2–24 initially selected units; there can be 12 squads. Each individual can belong to one squad.
- In the drawer, **Select** recalls surviving members. Select additional units to add them, select members to remove them, or tap **Disband** twice. A squad retains its history after casualties as long as at least one member survives.
- Select a unit, several units, or a recalled squad; choose **Defend** on the command card, then tap another friendly unit or a friendly building. Guards use distinct positions, follow a moving principal, fight nearby threats with a leash, and return; monks can heal a wounded protected unit. New movement, combat, stop, work or garrison orders replace that unit's guard order. A unit cannot guard itself or form a circular escort chain.
- Tap **Hide Panels** to collapse the bottom selection and command panels (the ones shown on the right of the battlefield) without losing the selection; the minimap remains. Tap **Show Panels** to restore them. The **×** in the inspector—or beside the panel toggle while collapsed—deselects and cancels a pending targeting/placement action without selecting something else. Workshop **Status** and the squad drawer are opened only on demand and can be closed.

### Progression

The existing individual veterancy and elite/renown systems remain in force. Squads have a **separate** shared pool: eligible members' individual XP also contributes `XP / sqrt(current squad size)`. Thresholds and cumulative squad perks are:

| Shared XP | Squad rank | Perk for bonded members |
| --- | --- | --- |
| 0 | Formed | Earn a shared history |
| 60 | Drilled | +5% movement speed |
| 150 | Battlebound | +1 melee and pierce armour near a squadmate |
| 300 | Elite | +10% attack near a squadmate |

Cohesion means another living, ungarrisoned squadmate is within 12 world units. A late recruit starts its own bond at the squad's current XP and earns these thresholds from subsequent shared experience; it does not inherit instant elite perks. Existing survivors keep what they earned.

## Saves and version isolation

V5 uses `imperial-crown-v5-save` in browser local storage; it never overwrites v4's `imperial-crown-save`. If there is no v5 save, an existing v4 save **on the same browser origin** can be loaded and then saved to the v5 slot. Because the original is not deleted, manually removing the v5 slot exposes that v4 fallback again. Settings and workshop selections likewise read older preferences if necessary but write only v5-specific keys. Different ports, domains and Android app sandboxes have separate storage, so cross-origin migration is not automatic.

Manual save and the one-minute autosave include squads, personal bonds, guard assignments, explored fog, building queues, garrisons, and built-in workshop state—including mage mana, ranks, cooldowns, discovered hybrids and references to summoned units. Save/load is a strategic checkpoint, not a deterministic replay: the first-person camera, current ordinary movement/work/attack orders, transient projectiles and particles are not resumed. Future third-party mods must be tested with the save codec before their state can be assumed to round-trip.

## Performance and testing

The regular strategy view keeps v4's batching, geometry, effects and quality ladder. The guard scan runs at 2.5 Hz only when assignments exist; the bounded squad-cohesion check runs at 2 Hz only when squads exist. First-person input, aiming and its overlay are active only while controlling a unit; the worker placement check and global map run only when requested. No render-scale or visual-quality reduction was added specifically for v5. `npm run bench:v5` compares simulation tick costs with and without 12 full squads and 288 guards; it is a CPU-only stress probe, not a GPU or phone benchmark.

```sh
npm run build
npm run test:v5          # v5 simulation, input, progression and save integration
npm run test:ci          # inherited offline suites plus v5, including optional browser suites when available
npm run test:v5-browser  # real Chromium, mobile-size viewport, touch, spellbook and saves
```

See [docs-browser-tests.md](docs-browser-tests.md) for Chromium libraries on minimal Linux systems. The browser test uses software WebGL and is useful for correctness, **not** for judging phone frame rate. The Realme 9i itself was not available in this environment; an on-device play/thermal/battery and long-battle test is still needed before claiming its smoothness is unchanged. Use the in-game **Menu → Check device** and test long battles, workshop combinations, and first-person movement on the actual phone.

## Android builds and signing

[Download the v6 Android preview APK](https://github.com/jojokundesu/Age-of-empires-clone-build/releases/download/v6.1.0-preview/imperial-crown-3d-v6.apk) — the same file CI builds and verifies on every push, published as the `v6.1.0-preview` release with a matching `apk-sha256.txt`. It is signed with the repository's **public demo key** for testing and has not been performance-tested on a physical Realme 9i.

The v6 Android application ID is `ai.arena.imperialcrown.v6` (versionCode 60100), distinct from v5's `ai.arena.imperialcrown.v5` and v4's `ai.arena.imperialcrown`, so it installs **beside** v5 without replacing it and without inheriting its save slot. A local build needs JDK 17+, an Android SDK platform and build-tools, and produces `build/imperial-crown-6.1.0.apk`:

```sh
ANDROID_HOME=/path/to/android-sdk npm run apk
```

Signing is unchanged from v4/v5: the repository's v4 PKCS#12 key is a **public demo key**, and the v6 script reuses the sibling `imperial-crown-v4/android/imperial.p12` without copying it. Provide your own key through `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD` and `KEY_ALIAS` for anything real, and keep the same certificate for future v6 upgrades or Android will refuse the update. Never commit a production signing key. If neither key is available the script warns and generates a throwaway key that cannot provide stable upgrades.

`.github/workflows/android-v6.yml` is the only supported path to a published v6 APK. On every push that touches `imperial-crown-v6/**` it installs the SDK, builds `dist/`, runs the whole regression suite, the Chromium first-person/panel test and the 892x412 phone-layout check, builds and signs the APK, then verifies the v1+v2 signatures, `zipalign`, the manifest identity (`ai.arena.imperialcrown.v6`, 60100, 6.1.0) and that every byte of `dist/` is inside `assets/www`. It publishes the release only from a dispatch or from a commit message containing `[release v6]`, and it refuses to overwrite the tag if it already belongs to another commit.

Installation and sustained performance on a physical handset are still unverified here. Use in-game **Menu → Check device**, then play a long battle and first-person run on the phone to judge frame rate, heat and battery.

## Why these changes

- **One simulation:** control, guarding, spells and progression reuse existing unit, collision, combat and mod systems, keeping strategy and direct control consistent.
- **Separate squad and individual histories:** veterans are still individuals; a squad's shared achievements reward survival and staying together without instantly making late recruits elite.
- **Interruptible protection:** guards persist through fighting and movement but any explicit replacement order remains authoritative.
- **Optional surfaces:** the bottom selection/command panels can be collapsed without losing selection; squads and workshop status open on demand, and explicit deselection needs no replacement target.
- **A separate version:** v4 remains a dependable reference, while v5's app ID and save slot make experimentation safer.
