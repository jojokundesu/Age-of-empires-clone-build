import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the real runner in an isolated fixture, without launching dozens of
// real browsers. The fake suite files record arguments and inherited libraries.
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const source = readFileSync(runner, 'utf8');
const files = new Set([...source.matchAll(/\['[^']+',\s*'(tests\/[^']+\.mjs)'/g)].map(m => m[1]));
const dir = mkdtempSync(join(tmpdir(), 'imperial-runner-'));
try {
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/browser-libs.mjs'), 'console.log("/fixture/chromium-libs")');
  const fake = `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.RUNNER_LOG, JSON.stringify({file: process.argv[1].split('/').pop(), args: process.argv.slice(2), libs: process.env.LD_LIBRARY_PATH || ''}) + '\\n');\nconsole.log('passed');\n`;
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fake);
  }
  const log = join(dir, 'calls.jsonl');
  const env = { ...process.env, RUNNER_LOG: log, LD_LIBRARY_PATH: '/existing/lib' };
  execFileSync(process.execPath, [runner, '--ci', '--browser'], { cwd: dir, env, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const find = file => calls.filter(c => c.file === file);
  assert.deepEqual(find('fuzz.mjs')[0].args, ['--seconds', '90', '--seeds', '3', '--orders', '4']);
  assert.deepEqual(find('fuzzcrowns.mjs')[0].args, ['--seconds', '180', '--seeds', '2']);
  assert.deepEqual(find('browser.mjs')[0].args, ['--seconds', '6', '--dpr', '1.5']);
  assert.equal(find('playtest.mjs').length, 1, 'playtest must not run twice with --browser');
  if (process.platform === 'linux') assert.equal(find('wallsite.mjs')[0].libs, '/fixture/chromium-libs:/existing/lib');

  rmSync(join(dir, 'dist'), { recursive: true });
  rmSync(join(dir, 'tests/shell.test.mjs'));
  const missing = spawnSync(process.execPath, [runner, '--ci'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(missing.status, 0, 'CI must reject missing test files and bundle');
  assert.match(missing.stdout, /FAIL\s+shell\s+\(missing tests\/shell\.test\.mjs\)/);
  assert.match(missing.stdout, /FAIL\s+wallsite\s+\(run npm run build first\)/);
  console.log('RUNNER CHECKS PASSED');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
