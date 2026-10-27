#!/usr/bin/env node
/* Headless Chromium on a bare Linux box.

   @sparticuz/chromium ships a Chromium build plus its shared libraries as two
   brotli-compressed tarballs. `executablePath()` unpacks the binary but not the
   libraries, so on a machine without NSS installed puppeteer dies with
   "libnss3.so: cannot open shared object file" before the first page loads --
   which is how every browser-based suite used to fail after a clean checkout.

   This unpacks both library sets and prints the LD_LIBRARY_PATH to use:

     eval "$(node scripts/browser-libs.mjs)"      # exports IMPERIAL_LD_PATH
     LD_LIBRARY_PATH=$IMPERIAL_LD_PATH node tests/browser.mjs

   or simply:  eval "$(node scripts/browser-libs.mjs --export)"
   which exports LD_LIBRARY_PATH directly.
*/
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let BIN;
try { BIN = join(dirname(require.resolve('@sparticuz/chromium/package.json')), 'bin'); }
catch (_) { console.error('browser-libs: @sparticuz/chromium is not installed (npm install)'); process.exit(1); }
const OUT = '/tmp/imperial-chromium-libs';
/* al2023 carries the full NSS/nspr set (libnspr4, libplc4, libplds4 as well as
   libnss3); al2 does not, so it is unpacked first and al2023 on top. */
const SETS = ['al2', 'al2023'];

if (!existsSync(BIN)) {
  console.error('browser-libs: @sparticuz/chromium is not installed (npm install)');
  process.exit(1);
}

for (const name of SETS) {
  const src = join(BIN, name + '.tar.br');
  if (!existsSync(src)) continue;
  const tar = '/tmp/' + name + '.tar';
  writeFileSync(tar, brotliDecompressSync(readFileSync(src)));
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', tar, '-C', dir]);
}

const libDir = join(OUT, 'al2023', 'lib');
if (!existsSync(join(libDir, 'libnss3.so'))) {
  console.error('browser-libs: extraction produced no libnss3.so in ' + libDir);
  process.exit(1);
}

if (process.argv.includes('--export')) {
  console.log(`export LD_LIBRARY_PATH="${libDir}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`);
} else {
  console.log(libDir);
}
