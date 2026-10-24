/* Shell integrity: every local asset the page references must exist, and the
   install/meta surface (icons, manifest, viewport, theme) must stay intact.
   This is the cheap guard that would have caught the CI only finding 404s:
   headless Chrome fetching a missing favicon/apple-touch-icon used to fail the
   whole browser gate.                                                 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

let failures = 0;
const check = (cond, msg) => {
  if (cond) { console.log('  ok   ' + msg); return; }
  failures++; console.error('  FAIL ' + msg);
};

const html = readFileSync('index.html', 'utf8');
const refs = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]);
const local = refs.filter((u) => !/^(https?:|data:|mailto:)/.test(u));

console.log('index.html references ' + local.length + ' local assets');
// vite serves the project root during development and copies public/ to the
// build root, so a reference may live in either place.
const resolves = (url) => {
  const path = url.replace(/^\.?\//, '').split('?')[0];
  return existsSync(path) || existsSync('public/' + path);
};
for (const url of local) {
  check(resolves(url), `reference resolves: ${url}`);
}

check(/rel="manifest"/.test(html), 'manifest is linked');
check(/rel="icon"/.test(html), 'favicon is linked (no /favicon.ico 404)');
check(/rel="apple-touch-icon"/.test(html), 'apple-touch-icon is linked');

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
check(manifest.name && manifest.short_name, 'manifest has names');
check(manifest.start_url && manifest.scope, 'manifest has start_url + scope');
check(manifest.display === 'fullscreen' || manifest.display === 'standalone', 'manifest display is installable');
check((manifest.icons || []).some((i) => i.sizes === '192x192'), 'manifest has a 192 icon');
check((manifest.icons || []).some((i) => i.sizes === '512x512'), 'manifest has a 512 icon');
check((manifest.icons || []).some((i) => (i.purpose || '').includes('maskable')), 'manifest has a maskable icon');
for (const icon of manifest.icons) {
  const p = 'public/' + icon.src.replace(/^\.\//, '');
  check(existsSync(p), 'manifest icon exists: ' + icon.src);
  if (existsSync(p)) {
    const head = readFileSync(p).subarray(0, 8);
    check(head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG', 'icon is a real PNG: ' + icon.src);
  }
}
const svg = readFileSync('public/favicon.svg', 'utf8');
check(/<svg[^>]+viewBox=/.test(svg), 'favicon.svg is a scalable svg');

/* Android shell: the WebView must load the same bundle and be allowed to use
   the storage / fullscreen surface the game needs. */
const apkScript = readFileSync('scripts/build-apk.sh', 'utf8');
check(/dist/.test(apkScript), 'apk script copies the built web bundle');

/* A shell comment inside a line-continued command ends the command: bash stops
   at the '#', so every flag after it vanishes without an error. That is how the
   aapt2 link line lost -A, --auto-add-overlay and the version flags, shipping an
   APK with the web bundle in the wrong place and no version name. */
for (const file of ['scripts/build-apk.sh', 'scripts/browser-libs.mjs'.replace('.mjs', '.sh')]) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  const offenders = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i]) && /\\\s*$/.test(lines[i - 1])) offenders.push(i + 1);
  }
  check(offenders.length === 0, `${file}: comment inside a continued command (line ${offenders.join(', ')})`);
}

/* The shell must be able to find the game inside the package: aapt2 copies the
   contents of -A to the assets root, and MainActivity opens assets/www/. */
check(/-A "\$OUT\/assets"/.test(apkScript), 'apk assets staged as assets/www/*');
check(/--auto-add-overlay/.test(apkScript), 'apk link allows the resource overlay');
check(/--v2-signing-enabled true/.test(apkScript), 'apk is signed with the v2 scheme');
check(/imperial\.p12/.test(apkScript), 'apk uses the committed signing key (upgrades install over each other)');
check(/classes\.dex/.test(apkScript) && /-s "\$OUT\/dex\/classes\.dex"/.test(apkScript),
  'apk build fails when d8 produced no dex');
const manifestXml = 'android/app/src/main/AndroidManifest.xml';
const androidXml = existsSync(manifestXml) ? readFileSync(manifestXml, 'utf8') : '';
if (androidXml) {
  check(/android:hardwareAccelerated="true"/.test(androidXml), 'WebView activity is hardware accelerated');
  check(/INTERNET|WAKE_LOCK|VIBRATE/.test(androidXml), 'permissions declared');
  /* The manifest versionCode is what a package installer compares on upgrade.
     If it does not climb with the package version the phone refuses the
     install with "app not installed", which reads like a corrupted APK. */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  const expected = maj * 10000 + min * 100 + (patch || 0);
  const code = Number((androidXml.match(/android:versionCode="(\d+)"/) || [])[1]);
  check(code >= expected, `manifest versionCode ${code} climbs with package ${pkg.version} (>= ${expected})`);
  check(new RegExp(`android:versionName="${pkg.version}"`).test(androidXml),
    `manifest versionName matches package.json (${pkg.version})`);
}

/* ---- the WebView shell itself -------------------------------------------
   Every one of these is a frame-rate or an installability property, and every
   one of them is invisible from the web side -- so they are asserted here. */
const mainJava = 'android/app/src/main/java/ai/arena/imperialcrown/MainActivity.java';
if (existsSync(mainJava)) {
  const java = readFileSync(mainJava, 'utf8');
  check(/setRendererPriorityPolicy\(WebView\.RENDERER_PRIORITY_IMPORTANT/.test(java),
    'the WebView renderer process runs at IMPORTANT priority');
  check(!/^\s*WebView\.setWebContentsDebuggingEnabled\(true\);\s*$/m.test(java),
    'WebView debugging is not forced on in release builds');
  check(/boolean debuggable/.test(java), 'WebView debugging is gated on FLAG_DEBUGGABLE');
  check(/onRenderProcessGone/.test(java), 'a killed renderer reloads instead of taking the game down');
  check(/OVER_SCROLL_NEVER/.test(java), 'no overscroll glow layer over the game');
  check(/setCacheMode\(WebSettings\.LOAD_DEFAULT\)/.test(java), 'the asset cache is left on');
  check(/setMediaPlaybackRequiresUserGesture\(false\)/.test(java), 'audio unlocks on the first tap');
  /* Comments mention file:// on purpose (they explain why it is avoided), so
     the assertions look at real statements only: the host constant, the url
     the shell loads, and the asset path it opens. */
  check(/String HOST = "https:\/\/appassets\.local\/"/.test(java), 'assets come from a secure (https) origin');
  check(!/loadUrl\(\s*"file:/.test(java) && !/WebViewAssetLoader|file:\/\/android_asset/.test(java),
    'the shell never loads a file:// url');
  check(/getAssets\(\)\.open\("www\/"/.test(java), 'the shell serves the bundle from assets/www/');
  // no blocking calls on the UI thread
  check(!/Thread\.sleep|strictmode/i.test(java), 'no blocking sleeps in the shell');
}

/* Nothing may be left referenced from a public directory that vite does not
   copy, and dist (when built) must contain the same shell. */
if (existsSync('dist/index.html')) {
  const dist = readFileSync('dist/index.html', 'utf8');
  const distRefs = [...dist.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|mailto:)/.test(u));
  let missing = 0;
  for (const url of distRefs) {
    const p = 'dist/' + url.replace(/^\.?\//, '').split('?')[0];
    if (!existsSync(p)) { missing++; console.error('  missing in dist: ' + url); }
  }
  check(missing === 0, `dist references resolve (${distRefs.length} urls)`);
  for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.svg', 'apple-touch-icon.png']) {
    check(existsSync('dist/' + f), 'dist ships ' + f);
  }
  check(readdirSync('dist/assets').some((f) => f.endsWith('.js')), 'dist has a js bundle');
}

console.log(failures ? `SHELL FAILED (${failures})` : 'SHELL OK');
process.exit(failures ? 1 : 0);
