/* A plain campaign carries none of the Arcane Order.

   This is the negative half of the mod contract, kept in its own file for a
   plain reason: it needs a cold browser. One match's terrain, unit buffers and
   baked textures come to most of this sandbox's memory, and the renderer has
   no teardown that gives it back, so a mod session followed by a campaign in
   one process gets the tab OOM-killed half-way through the second. Run alone,
   a campaign sits at a flat 35 MB for minutes on end.

   Running it alone is also the truer test. The profile is empty: no saved
   preferences, no saved match, nothing switched on. Whatever could carry a mod
   into a match -- a stored toggle, the URL, the build itself -- has to fail to
   do so here.

   It is spawned by tests/modsite.mjs, which owns the workshop side of the
   contract, and can also be run by hand:
     node tests/campaign-clean.mjs [--out ci/v4-mods]
*/
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argOf('out', 'ci/v4-mods'));
const ROOT = resolve('dist');
if (!existsSync(join(ROOT, 'index.html'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(2); }
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  protocolTimeout: 300000,
  args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

const pageErrors = [];
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));

const fail = async (why) => {
  console.error(`  FAIL a normal campaign has no mod content at all — ${why}`);
  try { await page.screenshot({ path: join(OUT, '06-clean-campaign.png') }); } catch { /* the tab may be gone */ }
  try { await browser.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  process.exit(1);
};

let pass = 0;
try {
  await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
  await page.waitForFunction(() => {
    const m = document.getElementById('menuScreen'), b = document.getElementById('bootScreen');
    return m && !m.classList.contains('hidden') && (!b || b.classList.contains('hidden'));
  }, { timeout: 300000, polling: 200 });

  /* Nothing is switched on in a fresh profile. Say so before starting, so a
     failure names the toggle rather than the match. */
  const cards = await page.evaluate(() => [...document.querySelectorAll('#modList .modCard')]
    .map((c) => ({ id: c.dataset.mod, on: c.classList.contains('on') })));
  const lit = cards.filter((c) => c.on).map((c) => c.id);
  if (lit.length) await fail(`the workshop came up with ${lit.join(', ')} already on`);

  await page.click('#btnStart');
  await page.waitForFunction('window.__imperial.running === true', { timeout: 300000, polling: 250 });
  await new Promise((r) => setTimeout(r, 1200));   // the HUD strip refreshes at 9 Hz
  const st = await page.evaluate(() => {
    const a = window.__imperial;
    return {
      host: a.game.modHost,
      mode: a.game.mode,
      mage: a.game.units.some((u) => u.type === 'mage'),
      tower: a.game.buildings.some((b) => b.type === 'arcane_tower'),
      hudHidden: document.getElementById('modHud').classList.contains('hidden'),
      chips: document.querySelectorAll('#modHud .modChip').length,
      body: document.body.classList.contains('mods'),
      mageTrainable: (() => {
        const tc = a.catalogue && a.catalogue.units;
        return Array.isArray(tc) && tc.includes('mage');
      })()
    };
  });
  const detail = JSON.stringify(st);
  if (st.host) await fail(`a campaign got a mod host (${detail})`);
  if (st.mode === 'mods') await fail(`campaign mode is ${st.mode} (${detail})`);
  if (st.mage || st.tower) await fail(`mod content leaked into the campaign (${detail})`);
  if (st.mageTrainable) await fail(`the mage is still in the unit catalogue (${detail})`);
  if (!st.hudHidden || st.chips !== 0 || st.body) await fail(`mod UI leaked into the campaign (${detail})`);
  if (pageErrors.length) await fail(`page errors: ${pageErrors.slice(0, 2).join(' | ')}`);

  await page.screenshot({ path: join(OUT, '06-clean-campaign.png') });
  pass++;
  console.log(`  ok   a normal campaign has no mod content at all  — no host, no units, no HUD, mode ${st.mode}`);
} catch (e) {
  await fail(e && e.message ? e.message : String(e));
}

try { await browser.close(); } catch { /* ignore */ }
try { server.close(); } catch { /* ignore */ }
process.exit(pass ? 0 : 1);
