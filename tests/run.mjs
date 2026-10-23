/* Runs the whole suite in order and prints a single verdict.
   `node tests/run.mjs`          — everything that works offline
   `node tests/run.mjs --ci`     — same, non-zero exit on failure
   The APK build itself is exercised by GitHub Actions. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SUITES = [
  ['shaders', 'tests/shaders.test.mjs'],
  ['sim', 'tests/sim.test.mjs'],
  ['combat', 'tests/combat.test.mjs'],
  ['renderer', 'tests/render.test.mjs'],
  ['hud', 'tests/ui.test.mjs'],
  ['application', 'tests/app.test.mjs'],
  ['bundle', 'tests/dist.test.mjs', true]
];

const ci = process.argv.includes('--ci');
const results = [];

function run(name, file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
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

for (const [name, file, optional] of SUITES) {
  if (optional && !existsSync(file.replace('dist.test.mjs', '../dist'))) {
    if (!existsSync('dist')) { console.log(`SKIP  ${name.padEnd(12)} (run npm run build first)`); continue; }
  }
  if (!existsSync(file)) { console.log(`SKIP  ${name.padEnd(12)} (missing ${file})`); continue; }
  await run(name, file);
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
