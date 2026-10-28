/* Runs the whole suite in order and prints a single verdict.
   `node tests/run.mjs`            — everything that works offline
   `node tests/run.mjs --ci`       — same, non-zero exit on failure
   `node tests/run.mjs --browser`  — plus the Chromium play-test and soak-lite
   The APK build itself is exercised by GitHub Actions. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SUITES = [
  ['shell', 'tests/shell.test.mjs'],
  ['contract', 'tests/contract.test.mjs'],
  ['geo', 'tests/geo.test.mjs'],
  ['audio', 'tests/audio.test.mjs'],
  ['shaders', 'tests/shaders.test.mjs'],
  ['sim', 'tests/sim.test.mjs'],
  ['survey', 'tests/survey.test.mjs'],
  ['combat', 'tests/combat.test.mjs'],
  ['daynight', 'tests/daynight.test.mjs'],
  ['quality', 'tests/quality.test.mjs'],
  ['renderer', 'tests/render.test.mjs'],
  ['perf', 'tests/perf.test.mjs'],
  ['input', 'tests/input.test.mjs'],
  ['pacing', 'tests/pacing.test.mjs'],
  ['ai', 'tests/ai.test.mjs', '240'],
  ['peak', 'tests/peak.mjs'],
  ['logistics', 'tests/logistics.mjs'],
  ['wallgate', 'tests/wallgate.mjs'],
  ['siege', 'tests/siege.mjs'],
  ['formation', 'tests/formation.mjs'],
  ['mods', 'tests/mods.mjs'],
  ['court', 'tests/court.mjs'],
  ['aihunt', 'tests/aihunt.mjs'],
  ['veterancy', 'tests/veterancy.mjs'],
  ['calendar', 'tests/calendar.mjs'],
  ['morale', 'tests/morale.mjs'],
  ['party', 'tests/party.test.mjs'],
  ['economy', 'tests/economy.mjs'],
  ['wallsite', 'tests/wallsite.mjs', true],
  ['modsite', 'tests/modsite.mjs', true],
  ['realm', 'tests/realm.mjs'],
  ['kingdoms', 'tests/kingdoms.mjs'],
  ['warcouncil', 'tests/warcouncil.mjs'],
  ['climate', 'tests/climate.mjs'],
  ['courtsite', 'tests/courtsite.mjs', true],
  ['magesite', 'tests/magesite.mjs', true],
  ['fuzz', 'tests/fuzz.mjs', ['--seconds', '90', '--seeds', '3', '--orders', '4']],
  ['hud', 'tests/ui.test.mjs'],
  ['application', 'tests/app.test.mjs'],
  ['v5', 'tests/v5.test.mjs'],
  ['v6', 'tests/champion.test.mjs'],
  ['bundle', 'tests/dist.test.mjs', true],
  ['shots', 'tests/shots.mjs', true],
  ['playtest', 'tests/playtest.mjs', true],
  ['fuzzcrowns', 'tests/fuzzcrowns.mjs', ['--seconds', '180', '--seeds', '2']]
];

/* Chromium needs NSS, and a slim container may not have it. If a local copy
   of the shared libraries has been unpacked into `.toolchain/nss` (see
   `docs-browser-tests.md`), the browser suites pick it up automatically
   instead of dying at launch with "libnss3.so: cannot open shared object". */
if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.includes('.toolchain/nss')) {
  const localNss = new URL('../.toolchain/nss/', import.meta.url).pathname;
  if (existsSync(localNss)) {
    process.env.LD_LIBRARY_PATH = [localNss, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
}

const ci = process.argv.includes('--ci');
const chromiumLibs = () => {
  const nss = process.env.LD_LIBRARY_PATH || '';
  if (nss.split(':').some((p) => p && existsSync(p) && existsSync(`${p}/libnss3.so`))) return true;
  return ['/usr/lib/x86_64-linux-gnu/libnss3.so', '/usr/lib64/libnss3.so', '/usr/lib/libnss3.so'].some((p) => existsSync(p));
};
const results = [];

function run(name, file, arg) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = Array.isArray(arg) ? [file, ...arg] : arg ? [file, arg] : [file];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const ms = Date.now() - t0;
      /* A suite that prints a failed check must not be able to exit zero. One
         of them did -- its verdict line sat above a later block -- so the
         whole run reported 40/40 with a red check inside it. The output is
         part of the contract now: a `FAIL` line fails the suite whatever the
         exit code says. */
      const printed = /^\s*FAIL\b/m.test(out) || /\bFAILED\b/.test(out);
      const failed = code !== 0 || printed;
      results.push({ name, code: failed ? (code || 1) : 0, ms, out });
      const tail = out.trim().split('\n').slice(-3).join('\n      ');
      console.log(`${failed ? 'FAIL' : 'PASS'}  ${name.padEnd(12)} ${String(ms).padStart(6)} ms`);
      if (failed) console.log('      ' + tail);
      resolve();
    });
  });
}

for (const [name, file, argOrOptional] of SUITES) {
  const optional = argOrOptional === true;
  const arg = typeof argOrOptional === 'string' ? argOrOptional : null;
  if (optional && !existsSync('dist')) {
    console.log(`SKIP  ${name.padEnd(12)} (run npm run build first)`);
    continue;
  }
  /* The browser suites need Chromium's shared libraries as well as the
     bundle; a container without libnss3.so used to turn "optional" into
     "failed". CI runs these in their own steps, after `npm run build`. */
  if (optional && (name.endsWith('site') || name === 'shots' || name === 'playtest') && !chromiumLibs()) {
    console.log(`SKIP  ${name.padEnd(12)} (Chromium libraries not found — see docs-browser-tests.md)`);
    continue;
  }
  if (!existsSync(file)) { console.log(`SKIP  ${name.padEnd(12)} (missing ${file})`); continue; }
  await run(name, file, arg);
}

/* ---- the suites that need a real browser ---------------------------------
   Play-testing is not optional, but it needs Chromium, a built bundle and two
   minutes of wall clock, so it is opt-in: `node tests/run.mjs --browser`.
   These drive the actual game in an actual page -- taps, box drags, camera
   buttons, the build menu, an age advance, a battle and the frame budget. */
if (process.argv.includes('--browser')) {
  const BROWSER_SUITES = [
    ['browse', 'tests/browser.mjs', ['--seconds', '6', '--dpr', '1.5']],
    ['playtest', 'tests/playtest.mjs', []]
  ];
  for (const [name, file, args] of BROWSER_SUITES) {
    if (!existsSync(file)) { console.log(`SKIP  ${name.padEnd(12)} (missing ${file})`); continue; }
    await run(name, file, args);
  }
}

const failed = results.filter((r) => r.code !== 0);
const total = results.reduce((s, r) => s + r.ms, 0);
console.log('');
console.log(`${results.length - failed.length}/${results.length} suites passed in ${(total / 1000).toFixed(1)} s`);
if (failed.length) {
  console.log('\nFailure output:\n');
  for (const f of failed) console.log(`--- ${f.name} ---\n${f.out.trim().split('\n').slice(-25).join('\n')}\n`);
  process.exit(1);
}
