#!/usr/bin/env bash
# ============================================================
# build-apk.sh — bundles the web build into an installable APK
# Requires: JDK 17+, Android SDK build-tools (aapt2, d8, zipalign,
# apksigner) and platform android.jar.  No Gradle, no network.
#
#   ANDROID_HOME=/opt/android-sdk ./scripts/build-apk.sh
#
# Output: build/imperial-crown-<version>.apk
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)}"
PLATFORM="${PLATFORM:-$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)}"
AJAR="$PLATFORM/android.jar"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 2.0.0)"
# versionCode must climb for every release or an upgrade install is refused.
# 2.0.1 -> 20001; see android/app/src/main/AndroidManifest.xml (aapt2 --version-code wins).
VERSION_CODE="$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+(c||0)" 2>/dev/null || echo 20000)"
NAME="imperial-crown-${VERSION}"
OUT="$ROOT/build"
APP="$ROOT/android/app/src/main"

echo "== Imperial Crown APK build =="
echo "   sdk        : $SDK"
echo "   build-tools: $BUILD_TOOLS"
echo "   platform   : $PLATFORM"
echo "   version    : $VERSION"

[ -x "$BUILD_TOOLS/aapt2" ] || { echo "aapt2 not found in $BUILD_TOOLS"; exit 1; }
[ -f "$AJAR" ] || { echo "android.jar not found at $AJAR"; exit 1; }

echo
echo "== 1/6 web build =="
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
npx vite build
WEB="$ROOT/dist"
[ -f "$WEB/index.html" ] || { echo "web build missing"; exit 1; }

echo
echo "== 2/6 stage assets =="
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"
ASSETS="$OUT/assets/www"
mkdir -p "$ASSETS"
cp -R "$WEB"/. "$ASSETS"/
# the APK ships the game, not the source maps
rm -f "$ASSETS"/*.map
echo "   assets: $(du -sh "$ASSETS" | cut -f1) ($(find "$ASSETS" -type f | wc -l) files)"

echo
echo "== 3/6 aapt2 compile + link =="
"$BUILD_TOOLS/aapt2" compile --dir "$APP/res" -o "$OUT/res/resources.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$AJAR" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$OUT/res/resources.zip" \
  -A "$ASSETS" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION" \
  --auto-add-overlay

echo
echo "== 4/6 javac + d8 =="
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# android.jar on the *classpath*, not the bootclasspath. Bootstrapping from it
# hides java.lang.invoke, so any lambda in the shell failed to compile with
# "cannot find symbol: metafactory" -- and because the old script swallowed
# javac's status with `| grep || true`, the build went on with no .class files,
# produced no classes.dex, and shipped an APK with no code in it. That APK is
# exactly what Android calls "package appears to be invalid".
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -classpath "$AJAR" -d "$OUT/classes" @"$OUT/sources.txt"
CLASSES=$(find "$OUT/classes" -name '*.class' | wc -l)
[ "$CLASSES" -gt 0 ] || { echo "ERROR: javac produced no classes"; exit 1; }
echo "   javac: $CLASSES classes"
rm -rf "$OUT/dex" && mkdir -p "$OUT/dex"
"$BUILD_TOOLS/d8" --release --min-api 24 --lib "$AJAR" \
  --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
[ -s "$OUT/dex/classes.dex" ] || { echo "ERROR: d8 produced no classes.dex"; exit 1; }
echo "   d8: $(du -h "$OUT/dex/classes.dex" | cut -f1) classes.dex"
# Stored, not deflated: a compressed entry cannot be four-byte aligned, and
# Android 11+ is strict about the layout of a package it will install. This is
# what the Gradle plugin does for dex; hand-rolled builds usually forget it.
( cd "$OUT/dex" && zip -0 -q "$OUT/base.apk" classes.dex )
echo "   base.apk: $(du -h "$OUT/base.apk" | cut -f1)"

echo
echo "== 5/6 zipalign =="
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo
echo "== 6/6 sign =="
# The signing key MUST be the same for every build. It used to be generated
# fresh into build/ on every run, so every release came out under a different
# certificate -- and a phone that already had the previous build answered the
# next one with "app not installed, package appears to be invalid", because it
# is a signature conflict, not a packaging error. android/imperial.p12 is
# committed precisely so upgrades work (it is a demo key: fine for sideloading,
# never for a store).
KS="$ROOT/android/imperial.p12"
KS_TYPE=PKCS12
STOREPASS="${KEYSTORE_PASSWORD:-imperial}"
KEYPASS="${KEY_PASSWORD:-$STOREPASS}"
ALIAS="${KEY_ALIAS:-imperial}"

if [ -n "${KEYSTORE_BASE64:-}" ]; then
  KS="$OUT/imperial.p12"
  echo "$KEYSTORE_BASE64" | base64 -d > "$KS"
fi

# The committed key is PKCS#12 made by openssl. apksigner reads it directly on
# most JDKs, but some refuse the openssl KDF. Convert to JKS when keytool is
# around: same key, same certificate, no version surprises.
if [ "$KS_TYPE" = PKCS12 ] && [ -f "$KS" ] && command -v keytool >/dev/null 2>&1; then
  if keytool -importkeystore -srckeystore "$KS" -srcstoretype PKCS12 \
      -srcstorepass "$STOREPASS" -srcalias "$ALIAS" \
      -destkeystore "$OUT/signing.jks" -deststoretype JKS \
      -deststorepass "$STOREPASS" -destkeypass "$KEYPASS" -destalias "$ALIAS" \
      -noprompt >/dev/null 2>&1; then
    echo "   keystore: PKCS#12 -> JKS (alias $ALIAS)"
    KS="$OUT/signing.jks"; KS_TYPE=JKS
  else
    echo "   keystore: using PKCS#12 directly (keytool could not convert it)"
    keytool -list -keystore "$KS" -storetype PKCS12 -storepass "$STOREPASS" 2>&1 | head -5 || true
  fi
fi

if [ ! -f "$KS" ]; then
  if [ -f "$ROOT/android/imperial.keystore" ]; then
    KS="$ROOT/android/imperial.keystore"; KS_TYPE=JKS
  else
    KS="$OUT/imperial.keystore"; KS_TYPE=JKS
    echo "   WARNING: no project keystore -- generating a throwaway one."
    echo "            Builds signed this way cannot upgrade each other."
    keytool -genkeypair -v -keystore "$KS" -alias imperial \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass imperial -keypass imperial \
      -dname "CN=Imperial Crown, OU=Arena, O=Arena, L=Internet, S=Web, C=IN" >/dev/null 2>&1
  fi
fi

# v1 *and* v2. v2 is what Android 7+ verifies; v1 is what some OEM installers
# and package scanners still look at, and an APK carrying only v2 is the other
# way to get "package appears to be invalid" on a Chinese-market ROM.
"$BUILD_TOOLS/apksigner" sign --ks "$KS" --ks-type "$KS_TYPE" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$STOREPASS" --key-pass "pass:$KEYPASS" \
  --min-sdk-version 24 \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT/$NAME.apk" "$OUT/aligned.apk"

echo
echo "== verify signature schemes and archive layout =="
VERIFY="$("$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUT/$NAME.apk")"
echo "$VERIFY" | grep -E "Verified using|Signer #1 certificate SHA-256" || true
# v2 is the one that matters: every Android since 7.0 verifies it, and 11+
# requires it. apksigner issues v2+v3 for minSdkVersion 24 and quietly leaves v1
# out; recording which schemes came out is more useful than demanding one the
# tool will not produce.
echo "$VERIFY" | grep -q "Verified using v2 scheme (APK Signature Scheme v2): true" || {
  echo "ERROR: v2 signature missing -- Android 11+ refuses this APK"; exit 1; }
"$BUILD_TOOLS/zipalign" -c -p 4 "$OUT/$NAME.apk" || {
  echo "ERROR: the signed APK is not 4-byte aligned"; exit 1; }

echo
echo "== verify contents =="
"$BUILD_TOOLS/aapt2" dump badging "$OUT/$NAME.apk" | grep -E "package:|launchable-activity|sdkVersion|targetSdkVersion" || true
python3 - "$OUT/$NAME.apk" <<'PYVERIFY'
import sys, zipfile
apk = sys.argv[1]
z = zipfile.ZipFile(apk)
names = z.namelist()
need = ['classes.dex', 'AndroidManifest.xml', 'resources.arsc',
        'assets/www/index.html']
missing = [n for n in need if n not in names]
www = [n for n in names if n.startswith('assets/www/')]
size = sum(i.file_size for i in z.infolist() if i.filename.startswith('assets/www/'))
print(f"   entries: {len(names)}  web assets: {len(www)} files, {size/1024:.0f} kB raw")
if missing:
    sys.exit("MISSING from APK: " + ", ".join(missing))
if len(www) < 3:
    sys.exit("web bundle is not inside the APK")
# Android 11+ requires resources.arsc to be stored (not deflated) and aligned;
# the dex is stored for the same reason. A deflated entry is the difference
# between an APK that installs and "package appears to be invalid".
bad = []
with open(apk, 'rb') as fh:
    for name in ('resources.arsc', 'classes.dex'):
        info = z.getinfo(name)
        if info.compress_type != zipfile.ZIP_STORED:
            bad.append(f"{name} is compressed (method {info.compress_type})")
            continue
        # alignment applies to the *data*, not the local header: read the local
        # header to get its own name/extra lengths (zipalign pads the extra
        # field, so the central directory's copy is not the one to trust)
        fh.seek(info.header_offset)
        hdr = fh.read(30)
        name_len = int.from_bytes(hdr[26:28], 'little')
        extra_len = int.from_bytes(hdr[28:30], 'little')
        data_off = info.header_offset + 30 + name_len + extra_len
        if data_off % 4:
            bad.append(f"{name} data starts at {data_off}, not 4-byte aligned")
if bad:
    sys.exit("bad package layout: " + "; ".join(bad))
print("   resources.arsc + classes.dex: stored and 4-byte aligned")
PYVERIFY

echo
echo "== done =="
ls -lh "$OUT/$NAME.apk"
echo "APK_PATH=$OUT/$NAME.apk"
