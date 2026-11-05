# In-place APK updates: how Imperial Crown ships them, and how to copy it

You do not need GitHub Actions secrets to make an APK update in place. The signing key has to be
**permanent**, not **secret**. Those are different requirements, and only the first one matters to
Android.

This document is a hand-off for another agent working on another repo. Everything below is what this
repository actually does; the file names and fingerprints are real, and the same recipe works for a
Gradle/Flutter/Capacitor/React Native build with the snippets in §4.

---

## 1. The rule Android enforces

The package installer replaces an installed app in place (keeping its data, its icon position, its
permissions) **only when all three of these are true**:

| | Condition | If it fails |
|---|---|---|
| 1 | **Same application id** (`applicationId` / `package`), character for character | two icons, two installs |
| 2 | **Same signing certificate** as the copy already on the phone | *"App not installed"* / *"package appears to be invalid"* — the only cure is uninstall |
| 3 | **`versionCode` strictly greater** than the installed one | *"App not installed"* (newer build refused over older… or over itself) |

Condition 2 is the whole story. Android will never let an APK signed by a different key overwrite an
installed one. It is not a packaging error and it is not fixable in the manifest: the installer is
protecting your app's data from an impostor.

### Why the other repo breaks that

Almost always one of these:

- the CI (or a local build) signs with the **debug keystore**, which Gradle generates per machine at
  `~/.android/debug.keystore`. A fresh GitHub runner has no `~/.android`, so **every release is
  signed by a brand-new key** → every release is a different certificate → uninstall required;
- or the build script generates a keystore into `build/` on every run ("if it doesn't exist,
  create one") — same outcome, a new certificate every time;
- or the variant alternates (`assembleDebug` one release, `assembleRelease` the next);
- or `applicationId` was changed (for example, "so it can sit next to the old one") — that is a new
  app, not an update.

## 2. What this repository does instead (the evidence)

- **One application id, never touched:** `ai.arena.imperialcrown.v6`. It has carried 6.0.0 → 6.3.1.
  (`imperial-crown-v5` deliberately ships `…v5` — a *separate app*, which is why v5 and v6 sit
  side by side. Within one line of releases the id never changes.)
- **One keystore, committed to the repo:** `imperial-crown-v4/android/imperial.p12`
  (also `imperial-crown-v3/android/imperial.p12` and `android/imperial.p12`). Password `imperial`,
  alias `imperial`. The v6 folder's own `android/imperial.p12` is gitignored, and
  `imperial-crown-v6/scripts/build-apk.sh` falls back to the committed v4 key:

  ```bash
  KS="$ROOT/android/imperial.p12"
  if [ ! -f "$KS" ] && [ -f "$ROOT/../imperial-crown-v4/android/imperial.p12" ]; then
    KS="$ROOT/../imperial-crown-v4/android/imperial.p12"
  fi
  ```

  So CI gets the key from `git checkout`. **No secret, no manual step.**
- **One certificate for every release.** `openssl pkcs12 … | openssl x509 -fingerprint -sha256`:

  ```
  subject = CN = Imperial Crown 3D, OU = Arena, O = Arena, L = Delhi, ST = Delhi, C = IN
  valid   2026-10-23 → 2056-10-15
  SHA-256 CB:2B:46:A4:BF:16:E7:F6:A3:E6:BB:63:EF:0B:4D:61:B3:C7:A2:BD:FE:F7:CE:17:7F:E2:5B:BE:4D:3C:5A:BF
  ```

  That fingerprint is identical for v3's, v4's and every v6 release.
- **`versionCode` climbs by formula**, from `package.json`:

  ```bash
  node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+c"
  # 6.3.1 -> 60301
  ```

  and is passed to `aapt2 link --version-code` (signing a manifest bump that `aapt2` overrides).
- **Signed after aligning, v1 + v2**, with `apksigner` and that same keystore
  (`imperial-crown-v6/scripts/build-apk.sh`, step 6/6), then verified in CI:
  `apksigner verify --print-certs`, `zipalign -c -p 4`,
  `aapt2 dump badging | grep "package: name='ai.arena.imperialcrown.v6' versionCode='60301'"`.

Result: the phone sees *the same app, newer*, and does a normal in-place update. Data survives (saves
in `localStorage` inside the WebView are untouched, because the package id is unchanged).

## 3. First, find out what you have

Run these against the **last APK you published** and against a **locally built** one:

```bash
apksigner verify --print-certs app.apk | grep -i 'SHA-256'
aapt2 dump badging app.apk | head -1        # package: name='…' versionCode='…'
keytool -list -v -keystore ~/.android/debug.keystore -storepass android | grep SHA256
```

If the APK's certificate matches `debug.keystore`, that is the bug. If two releases of yours have
different SHA-256 values, that is the bug.

> **One-time cost:** if the build currently installed on the phone was signed by a key nobody kept,
> there is no way to update over it — Android will refuse forever. Uninstall **once**, install the
> next build (signed with the new permanent key), and you will never do it again. Say this plainly
> in the release notes so it does not look like a regression.

## 4. The recipe (agent-executable)

### 4.1 Create the key — exactly once, and keep it

```bash
mkdir -p keystore
keytool -genkeypair -v \
  -keystore keystore/release.p12 -storetype PKCS12 \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$STORE_PASS" -keypass "$STORE_PASS" \
  -dname "CN=<App Name>, OU=Mobile, O=<Org>, L=<City>, ST=<State>, C=<CC>"
```

- `-validity 10000` ≈ 27 years: the certificate must outlive the app.
- Never regenerate. Never "fix" it. Never let a script create it when missing — that fallback is the
  exact bug being fixed.
- Back the file up somewhere outside CI. If it is lost, every future release needs an uninstall.

### 4.2 Choose how CI gets it

**Path A — commit it (what this repo does; zero manual steps).**

```bash
git add keystore/release.p12      # and make sure it is NOT gitignored
```

Make sure `.gitignore` does not exclude `*.p12` / `*.jks`, and add a line in the README saying it is
a demo key. Anyone with the repo can then sign an APK that claims to be your app: acceptable for a
side-loaded preview, not for anything on Play or with real users' data.

**Path B — keep it private in a secret (needs one human paste, 30 seconds).**

```bash
base64 -w0 keystore/release.p12 > release.p12.b64
```

The human adds a repository secret, e.g. `KEYSTORE_BASE64`, in
*Settings → Secrets and variables → Actions*. The agent cannot create secrets — that is a platform
permission, not a missing capability — but the agent can absolutely wire it up and, in the same
commit, make Path A the default so the pipeline is not blocked while the human pastes it.

Decode in the workflow (never echo it):

```yaml
- name: Materialise the signing key
  env:
    KEYSTORE_BASE64: ${{ secrets.KEYSTORE_BASE64 }}
  run: |
    set -euo pipefail
    if [ -z "${KEYSTORE_BASE64:-}" ]; then echo "secret missing"; exit 1; fi
    echo "$KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/release.p12"
    chmod 600 "$RUNNER_TEMP/release.p12"
```

The password may go in a second secret (`KEYSTORE_PASSWORD`); the *key file* is the part that must be
byte-identical forever, the password only has to be known.

### 4.3 Wire it into Gradle (Android, Flutter, Capacitor, React Native — same file)

`android/app/build.gradle` (or `app/build.gradle.kts`):

```groovy
android {
    defaultConfig {
        // MUST NEVER CHANGE inside one line of releases
        applicationId "com.example.myapp"
        // MUST CLIMB every release
        versionCode 41
        versionName "1.4.1"
    }

    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_FILE") ?: "../../keystore/release.p12")
            storePassword System.getenv("KEYSTORE_PASSWORD") ?: "<the password>"
            keyAlias      System.getenv("KEY_ALIAS") ?: "upload"
            keyPassword   System.getenv("KEY_PASSWORD") ?: System.getenv("KEYSTORE_PASSWORD") ?: "<the password>"
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release   // <- not signingConfigs.debug
            minifyEnabled false
        }
        // optional but recommended: make debug builds use the SAME key too, so a
        // debug build can still update over a release build and vice versa
        debug {
            signingConfig signingConfigs.release
        }
    }
}
```

Framework notes:

- **Flutter** — `flutter build apk --release` uses the Gradle `signingConfigs.release` above; put it
  in `android/app/build.gradle`. If any workflow step runs `--debug`, it must use the same key too
  (see the `buildTypes.debug` override).
- **Capacitor / Cordova** — `npx cap sync` then the same `android/app/build.gradle` block.
- **React Native** — `android/app/build.gradle`, plus remove any `signingConfigs.debug` reference from
  the release block.
- **Expo (prebuild)** — the config plugin route sets `android.signingConfig`; or use EAS with a
  managed keystore (EAS keeps it and reuses it for every build — that also works, the point is that
  *something* keeps it).
- **Hand-rolled (no Gradle)** — this repo: `apksigner sign --ks <file> --ks-key-alias <alias>`,
  `--v1-signing-enabled true --v2-signing-enabled true`, after `zipalign -f -p 4`, and never re-zip
  after signing. Keep `classes.dex` **stored** (not deflated) so the 4-byte alignment survives.

### 4.4 Make CI prove it, every single release

A signature mismatch is invisible until a phone refuses the install. Catch it at build time by
pinning the certificate fingerprint:

```yaml
- name: Prove the package identity did not drift
  run: |
    set -euo pipefail
    APK="build/app-release.apk"
    EXPECTED_CERT="CB:2B:46:A4:BF:16:E7:F6:A3:E6:BB:63:EF:0B:4D:61:B3:C7:A2:BD:FE:F7:CE:17:7F:E2:5B:BE:4D:3C:5A:BF"
    EXPECTED_ID="com.example.myapp"
    EXPECTED_CODE="41"

    CERT="$("$BUILD_TOOLS/apksigner" verify --print-certs "$APK" \
      | sed -n 's/.*certificate SHA-256 digest: //p' | head -1 | tr 'a-f' 'A-F')"
    [ "$CERT" = "$EXPECTED_CERT" ] || { echo "SIGNING KEY CHANGED: $CERT"; exit 1; }

    "$BUILD_TOOLS/aapt2" dump badging "$APK" | head -1 \
      | grep -F "name='$EXPECTED_ID' versionCode='$EXPECTED_CODE'" \
      || { echo "package id or versionCode drifted"; exit 1; }

    "$BUILD_TOOLS/apksigner" verify --verbose "$APK" | grep -F 'v2 scheme (APK Signature Scheme v2): true'
    "$BUILD_TOOLS/zipalign" -c -p 4 "$APK"
```

Put the expected fingerprint in a file (`keystore/FINGERPRINT.txt`) so a human can read it and the
workflow can `cat` it instead of hard-coding it twice.

And on the device, once, after a release:

```bash
adb install -r app-release.apk          # must succeed with no uninstall
adb shell dumpsys package com.example.myapp | grep -E 'versionCode|versionName'
```

## 5. Failure table

| Symptom | Cause | Fix |
|---|---|---|
| "App not installed" / "package appears to be invalid" on an update, works after uninstall | different certificate | pin one keystore (§4.1–4.3), verify with `--print-certs` |
| Only the CI build needs an uninstall, local builds are fine | CI used the per-runner debug key | point `signingConfigs.release` (and debug) at the committed key |
| "App not installed" with the right key | `versionCode` equal or lower | derive it from the version string and assert it climbed |
| "App not installed" on Android 11+ only | APK is not 4-byte aligned, or has no v2 signature | `zipalign -p 4` before signing, sign v1 **and** v2 |
| Two icons | `applicationId` changed | keep it fixed; ship a *separate app id* only when you really mean a separate app |
| Update installs but the game starts from scratch | that is not signing — different package id, or storage cleared | check the id first |
| Random failures just after we "cleaned up the repo" | keystore was gitignored / deleted and the build regenerated one | never let the build generate a signing key; commit it or secret it |

## 6. The one-sentence version for the other agent

> A keystore is a file. Commit it (or base64 it into one secret), point every release build at it,
> keep `applicationId` fixed, raise `versionCode` every time, and assert the certificate fingerprint
> in CI — that is the entire trick, and it needs no secrets at all.
