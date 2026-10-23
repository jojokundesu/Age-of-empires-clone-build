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
  --version-code 20000 \
  --version-name "$VERSION" \
  --auto-add-overlay

echo
echo "== 4/6 javac + d8 =="
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$AJAR" -classpath "$AJAR" \
  -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 | grep -v "bootstrap class path" || true
"$BUILD_TOOLS/d8" --release --min-api 24 --lib "$AJAR" \
  --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
cd "$OUT/dex" && zip -q "$OUT/base.apk" classes.dex && cd "$ROOT"
echo "   base.apk: $(du -h "$OUT/base.apk" | cut -f1)"

echo
echo "== 5/6 zipalign =="
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo
echo "== 6/6 sign =="
KS="$OUT/imperial-debug.keystore"
if [ -n "${KEYSTORE_BASE64:-}" ]; then
  echo "$KEYSTORE_BASE64" | base64 -d > "$KS"
  STOREPASS="${KEYSTORE_PASSWORD:-imperial}"
  KEYPASS="${KEY_PASSWORD:-$STOREPASS}"
  ALIAS="${KEY_ALIAS:-imperial}"
elif [ -f "$ROOT/android/imperial.keystore" ]; then
  KS="$ROOT/android/imperial.keystore"
  STOREPASS="${KEYSTORE_PASSWORD:-imperial}"
  KEYPASS="${KEY_PASSWORD:-$STOREPASS}"
  ALIAS="${KEY_ALIAS:-imperial}"
else
  echo "   generating a project keystore (fine for sideloading)"
  keytool -genkeypair -v -keystore "$KS" -alias imperial \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass imperial -keypass imperial \
    -dname "CN=Imperial Crown, OU=Arena, O=Arena, L=Internet, S=Web, C=IN" >/dev/null 2>&1
  STOREPASS=imperial; KEYPASS=imperial; ALIAS=imperial
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KS" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$STOREPASS" --key-pass "pass:$KEYPASS" \
  --min-sdk-version 24 --v2-signing-enabled true \
  --out "$OUT/$NAME.apk" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT/$NAME.apk" | head -4

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
print("   APK contents OK")
PYVERIFY

echo
echo "== done =="
ls -lh "$OUT/$NAME.apk"
echo "APK_PATH=$OUT/$NAME.apk"
