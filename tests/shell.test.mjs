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
const manifestXml = 'android/app/src/main/AndroidManifest.xml';
if (existsSync(manifestXml)) {
  const xml = readFileSync(manifestXml, 'utf8');
  check(/android:hardwareAccelerated="true"/.test(xml), 'WebView activity is hardware accelerated');
  check(/INTERNET|WAKE_LOCK|VIBRATE/.test(xml), 'permissions declared');
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
