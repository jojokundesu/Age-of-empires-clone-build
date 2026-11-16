/* Runs the whole suite in order and prints a single verdict.
   `node tests/run.mjs`            — suites available with the current build
   `node tests/run.mjs --ci`       — require the bundle and all suite files
   `node tests/run.mjs --browser`  — plus the Chromium smoke test
   The APK build itself is exercised by GitHub Actions. */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SUITES = [
  ['shell', 'tests/shell.test.mjs'],
  ['contract', 'tests/contract.test.mjs'],
  ['runner', 'tests/runner.test.mjs'],
  ['webgl fallback', 'tests/webgl-fallback.test.mjs'],
  ['geo', 'tests/geo.test.mjs'],
  ['audio', 'tests/audio.test.mjs'],
  ['overhaul', 'tests/overhaul.test.mjs'],
  ['naval', 'tests/naval.test.mjs'],
  ['movement', 'tests/movement-boundary.test.mjs'],
  ['spatial', 'tests/spatial-movement.test.mjs'],
  ['transport', 'tests/transport.test.mjs'],
  ['naval combat', 'tests/naval-combat.test.mjs'],
  ['projectiles', 'tests/projectiles.test.mjs'],
  ['sacred', 'tests/sacred.test.mjs'],
  ['fog', 'tests/fog.test.mjs'],
  ['ai fairness', 'tests/ai-fairness.test.mjs'],
  ['workers', 'tests/workers.test.mjs'],
  ['shaders', 'tests/shaders.test.mjs'],
  ['unit rig', 'tests/unitrig.mjs'],
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
  ['responsive', 'tests/responsive.mjs', true],
  ['playtest', 'tests/playtest.mjs', true],
  ['fuzzcrowns', 'tests/fuzzcrowns.mjs', ['--seconds', '180', '--seeds', '2']]
];

/* Prepare the Chromium libraries shipped with the dependency, just as the
   standalone browser npm scripts do. Do not guess availability from a few
   library paths: actually run the suites so launch failures are visible. */
if (process.platform === 'linux' && (existsSync('dist') || process.argv.includes('--browser'))) {
  try {
    const libDir = execFileSync(process.execPath, ['scripts/browser-libs.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  } catch (error) {
    console.warn(`Chromium library setup failed; browser suites will still run and report launch errors: ${error.message}`);
  }
}
const ci = process.argv.includes('--ci');
const results = [];

function skip(name, reason, required = ci) {
  console.log(`${required ? 'FAIL' : 'SKIP'}  ${name.padEnd(12)} (${reason})`);
  if (required) results.push({ name, code: 1, ms: 0, out: reason });
}

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
  const arg = optional ? null : argOrOptional;
  if (optional && !existsSync('dist')) {
    skip(name, 'run npm run build first', ci || process.argv.includes('--browser'));
    continue;
  }
  if (!existsSync(file)) { skip(name, `missing ${file}`); continue; }
  await run(name, file, arg);
}

/* The bundled playtest and site checks run above. The longer smoke test is
   additional and opt-in with --browser. */
if (process.argv.includes('--browser')) {
  // The playtest is already included above when the production bundle exists.
  const BROWSER_SUITES = [
    ['browse', 'tests/browser.mjs', ['--seconds', '6', '--dpr', '1.5']]
  ];
  for (const [name, file, args] of BROWSER_SUITES) {
    if (!existsSync(file)) { skip(name, `missing ${file}`, true); continue; }
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
