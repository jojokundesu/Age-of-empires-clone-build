# Imperial Crown 3D — Version 5

Version 5 is a separate continuation of [`imperial-crown-v4`](../imperial-crown-v4/). The v4 source, assets, Android package and save slot remain untouched. V5 keeps the same procedural art, custom WebGL2 renderer, strategy simulation, 30 Hz fixed tick, LOD, and adaptive quality governor; its new controls operate on the actual units in that simulation rather than a second game.

## Run it

Requires Node.js 20+ and a browser with WebGL2:

```sh
cd imperial-crown-v5
npm ci
npm run dev             # http://localhost:5273
npm run build           # static, offline-capable dist/
npm run preview         # preview the production build
```

The server binds to `0.0.0.0` and accepts proxied preview hosts. The historical download links in the root README are for earlier releases, **not** a v5 APK.

## Field guide

### Control one unit

1. In strategy view, select **one** available friendly unit and tap **First Person** on its command card. Tap **Strategy** or press Escape to return to the overhead camera.
2. On a phone, drag anywhere on the **left** to move and on the **right** to look. Hold **Attack** to use that unit's normal weapon, range, damage, projectile and cooldown. Aim assist is switchable at the top right and only targets visible enemies. A lightweight decorative held-kit overlay distinguishes swords, bows, spears, axes, a builder's hammer, a mage's staff and a monk's relic; creatures and vehicles do not get a human hand. On desktop use WASD or arrow keys, drag on the right to look, Space to attack, and F to use a tool.
3. Villagers can aim at resources or unfinished/damaged friendly buildings and tap **Use** to gather, construct or repair. Their **Build** kit lets them choose an affordable building, aim at the ground and tap **Place**; moving takes direct control back from the work order. Monks can aim and **Use** to heal allies or convert enemies. Other fighting units retain their normal melee, ranged, mounted or siege attacks.
4. A controlled unit remains vulnerable in the same live battle. Direct control ends if it dies, routs, is captured or garrisoned, or the match ends. Pausing clears held controls.

### Play a mage

Mages belong to the existing **Arcane Order** workshop mod: open **Mod Workshop** on the main menu, enable it, and start a mod session. Train a mage at a Town Centre, select it, then enter first person. The **Spells** shelf exposes the mod's real eleven base spells, rank and mana requirements, cooldowns, six discoverable attunements and discovered hybrids. Aim and choose a spell; self-casts affect the mage. Skyfall opens a tactical map so its original map-wide reach and once-per-in-game-day limit are retained. This is the same Arcane implementation and progression used in strategy view, not a separate simplified spell system.

### Create a squad and defend someone

- Open **Squads**, choose **Pick units**, and tap friendly individuals to add/remove them from the current selection. Alternatively select a group in the normal way. Give it an optional name and choose **Create squad**. A squad accepts 2–24 initially selected units; there can be 12 squads. Each individual can belong to one squad.
- In the drawer, **Select** recalls surviving members. Select additional units to add them, select members to remove them, or tap **Disband** twice. A squad retains its history after casualties as long as at least one member survives.
- Select a unit, several units, or a recalled squad; choose **Defend** on the command card, then tap another friendly unit or a friendly building. Guards use distinct positions, follow a moving principal, fight nearby threats with a leash, and return; monks can heal a wounded protected unit. New movement, combat, stop, work or garrison orders replace that unit's guard order. A unit cannot guard itself or form a circular escort chain.
- Tap **Hide Panels** to collapse the bottom selection and command panels (the ones shown on the right of the battlefield) without losing the selection; the minimap remains. Tap **Show Panels** to restore them. The **×** in the inspector—or beside the panel toggle while collapsed—deselects and cancels a pending targeting/placement action without selecting something else. Backspace also clears the selection on desktop. Workshop **Status** and the squad drawer are opened only on demand and can be closed.

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

[Download the v5 Android preview APK](https://github.com/jojokundesu/Age-of-empires-clone-build/releases/download/v5.0.0-preview/imperial-crown-3d-v5.apk). It is signed with a public demo key for testing and has not been installed or performance-tested on a physical Realme 9i.

The v5 Android application ID is `ai.arena.imperialcrown.v5`, distinct from v4's `ai.arena.imperialcrown`, so installing it does not replace v4. A build requires JDK 17+, Android SDK platform and build-tools, and produces `build/imperial-crown-5.0.0.apk`:

```sh
ANDROID_HOME=/path/to/android-sdk npm run apk
```

The repository's v4 PKCS#12 key is a **public demo key**. For local sideload builds, the v5 script can reuse the sibling `imperial-crown-v4/android/imperial.p12` without copying it into v5. For production use your own securely held keystore through `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD` and `KEY_ALIAS`, and retain the same certificate for future v5 upgrades. Never commit a production signing key. If neither a key nor the sibling demo key is available, the script warns and generates a throwaway key that cannot provide stable upgrades. A v5 APK was built and its signatures, alignment, manifest and bundled assets were checked; installation and performance on a physical Android handset have not been verified.

## Why these changes

- **One simulation:** control, guarding, spells and progression reuse existing unit, collision, combat and mod systems, keeping strategy and direct control consistent.
- **Separate squad and individual histories:** veterans are still individuals; a squad's shared achievements reward survival and staying together without instantly making late recruits elite.
- **Interruptible protection:** guards persist through fighting and movement but any explicit replacement order remains authoritative.
- **Optional surfaces:** the bottom selection/command panels can be collapsed without losing selection; squads and workshop status open on demand, and explicit deselection needs no replacement target.
- **A separate version:** v4 remains a dependable reference, while v5's app ID and save slot make experimentation safer.
