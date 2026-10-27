# Imperial Crown 3D — Version 6

Version 6 is a separate continuation of [`imperial-crown-v4`](../imperial-crown-v4/); v5 is kept beside it. The v4 and v5 source, assets, Android packages and save slots remain untouched. V6 keeps the same procedural art, custom WebGL2 renderer, strategy simulation, 30 Hz fixed tick, LOD, and adaptive quality governor; its controls operate on the actual units in that simulation rather than a second game.

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

[Download the v6 Android preview APK](https://github.com/jojokundesu/Age-of-empires-clone-build/releases/download/v6.0.1-preview/imperial-crown-3d-v6.apk) — the same file CI builds and verifies on every push, published as the `v6.0.1-preview` release with a matching `apk-sha256.txt`. It is signed with the repository's **public demo key** for testing and has not been performance-tested on a physical Realme 9i.

The v6 Android application ID is `ai.arena.imperialcrown.v6` (versionCode 60001), distinct from v5's `ai.arena.imperialcrown.v5` and v4's `ai.arena.imperialcrown`, so it installs **beside** v5 without replacing it and without inheriting its save slot. A local build needs JDK 17+, an Android SDK platform and build-tools, and produces `build/imperial-crown-6.0.1.apk`:

```sh
ANDROID_HOME=/path/to/android-sdk npm run apk
```

Signing is unchanged from v4/v5: the repository's v4 PKCS#12 key is a **public demo key**, and the v6 script reuses the sibling `imperial-crown-v4/android/imperial.p12` without copying it. Provide your own key through `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD` and `KEY_ALIAS` for anything real, and keep the same certificate for future v6 upgrades or Android will refuse the update. Never commit a production signing key. If neither key is available the script warns and generates a throwaway key that cannot provide stable upgrades.

`.github/workflows/android-v6.yml` is the only supported path to a published v6 APK. On every push that touches `imperial-crown-v6/**` it installs the SDK, builds `dist/`, runs the whole regression suite, the Chromium first-person/panel test and the 892x412 phone-layout check, builds and signs the APK, then verifies the v1+v2 signatures, `zipalign`, the manifest identity (`ai.arena.imperialcrown.v6`, 60001, 6.0.1) and that every byte of `dist/` is inside `assets/www`. It publishes the release only from a dispatch or from a commit message containing `[release v6]`, and it refuses to overwrite the tag if it already belongs to another commit.

Installation and sustained performance on a physical handset are still unverified here. Use in-game **Menu → Check device**, then play a long battle and first-person run on the phone to judge frame rate, heat and battery.

## Why these changes

- **One simulation:** control, guarding, spells and progression reuse existing unit, collision, combat and mod systems, keeping strategy and direct control consistent.
- **Separate squad and individual histories:** veterans are still individuals; a squad's shared achievements reward survival and staying together without instantly making late recruits elite.
- **Interruptible protection:** guards persist through fighting and movement but any explicit replacement order remains authoritative.
- **Optional surfaces:** the bottom selection/command panels can be collapsed without losing selection; squads and workshop status open on demand, and explicit deselection needs no replacement target.
- **A separate version:** v4 remains a dependable reference, while v5's app ID and save slot make experimentation safer.
