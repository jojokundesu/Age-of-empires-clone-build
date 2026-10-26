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
  ['logistics', 'tests/logistics.mjs'],
  ['wallgate', 'tests/wallgate.mjs'],
  ['formation', 'tests/formation.mjs'],
  ['wallsite', 'tests/wallsite.mjs'],
  ['fuzz', 'tests/fuzz.mjs', ['--seconds', '90', '--seeds', '3', '--orders', '4']],
  ['hud', 'tests/ui.test.mjs'],
  ['application', 'tests/app.test.mjs'],
  ['bundle', 'tests/dist.test.mjs', true]
];

const ci = process.argv.includes('--ci');
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
      results.push({ name, code, ms, out });
      const tail = out.trim().split('\n').slice(-3).join('\n      ');
      console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${String(ms).padStart(6)} ms`);
      if (code !== 0) console.log('      ' + tail);
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
