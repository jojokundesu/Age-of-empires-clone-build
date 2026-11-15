/* Android-sized viewport regression. Chromium emulation verifies CSS geometry
   and touch interaction, not actual Android WebView or GPU performance. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(root, url === '/' ? 'index.html' : url);
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true,
    protocolTimeout: 300000, args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const sizes = [
    [480, 320], [568, 320], [640, 320], [740, 360], [800, 360],
    [915, 412, { left: 30, right: 18, top: 5, bottom: 8 }],
    [1024, 600], [1280, 800], [653, 280], [360, 800]
  ];
  async function viewport([width, height, safe = {}]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: width > height });
    await page.evaluate(safe => {
      for (const edge of ['left', 'right', 'top', 'bottom']) document.documentElement.style.setProperty(`--safe-${edge}`, `${safe[edge] || 0}px`);
      window.dispatchEvent(new Event('resize'));
      window.__imperial?.ui?.layoutTopBar();
    }, safe);
    await new Promise(r => setTimeout(r, 120));
  }
  await viewport([800, 360]);
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready && !document.getElementById("menuScreen").classList.contains("hidden")', { timeout: 300000 });
  await page.evaluate(() => {
    const a = window.__imperial; a.settings.autoQuality = false;
    if (a.governor) a.governor.enabled = false;
    a.renderer.setQuality('low'); a.renderer.setPixelScale(0.4);
    const draw = a.renderer.render.bind(a.renderer); let last = 0;
    a.renderer.render = (...args) => { const now = performance.now(); if (now - last > 500) { last = now; draw(...args); } };
  });
  for (const size of sizes) {
    await viewport(size);
    const data = await page.evaluate(() => {
      const btn = document.getElementById('btnStart'); btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2);
      return { r: [r.left,r.top,r.right,r.bottom], hit: hit === btn || btn.contains(hit),
        scroll: ['.menuLeft','.menuRight'].map(s => getComputedStyle(document.querySelector(s)).touchAction) };
    });
    const [w,h] = size;
    assert(data.r[0] >= 0 && data.r[1] >= 0 && data.r[2] <= w && data.r[3] <= h && data.hit, `${w}x${h}: start is inaccessible: ${JSON.stringify(data)}`);
    assert(data.scroll.every(s => s.includes('pan-y')), `${w}x${h}: menu cannot be touch-scrolled`);
    console.log(`  ok   ${w}x${h} menu start and scrolling`);
  }
  await viewport([800, 360]);
  await page.evaluate(() => window.__imperial.startMatch({ mode:'kingdoms', civ:'franks', difficulty:'standard', seed:4242, kingdoms:4, victory:'conquest' }));
  await page.waitForFunction('window.__imperial.running && window.__imperial.game.units.length > 8', { timeout: 120000 });
  await page.evaluate(() => {
    const a = window.__imperial, u = a.game.units.find(u => !u.dead && u.team === 1 && u.type === 'villager');
    a.game.setSelection([u]); a.ui.openBuildMenu([u]);
    Object.assign(a.game.teams.get(1).res, { food: 99999, wood: 99999, gold: 99999, stone: 99999 });
    a.ui.updateText(1);
  });
  for (const size of sizes) {
    await viewport(size);
    const [w,h,safe = {}] = size;
    if (h > w) {
      const hint = await page.evaluate(() => { const e = document.getElementById('rotateHint'), r = e.getBoundingClientRect(); return !e.classList.contains('hidden') && r.width === innerWidth && r.height === innerHeight; });
      assert(hint, `${w}x${h}: rotate prompt missing`);
      console.log(`  ok   ${w}x${h} rotate prompt`);
      continue;
    }
    const data = await page.evaluate(() => {
      const rect = s => { const e = document.querySelector(s), r = e.getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom }; };
      const hit = s => { const e = document.querySelector(s), r = e.getBoundingClientRect(), at = document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2); return at === e || e.contains(at); };
      return { res:rect('.resPanel'), center:rect('.centerPanel'), actions:rect('.topActions'), bottom:rect('#bottomBar'),
        mini:rect('#minimap'), toggle:rect('#railToggle'), rail:rect('#leftRail'), tools:rect('#v5Tools'), crowns:rect('#crownStrip'),
        pause:hit('#btnPause'), map:hit('#minimap'), tool:hit('#btnPanelToggle'), crownCount:document.querySelectorAll('#crownStrip .crown').length };
    });
    const inSafe = r => r.l >= (safe.left || 0) - 1 && r.t >= (safe.top || 0) - 1 && r.r <= w - (safe.right || 0) + 1 && r.b <= h - (safe.bottom || 0) + 1;
    const overlap = (a,b) => a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1;
    for (const key of ['res','center','actions','bottom','mini','tools']) assert(inSafe(data[key]), `${w}x${h}: ${key} outside safe area: ${JSON.stringify(data[key])}`);
    assert(!overlap(data.res,data.center) && !overlap(data.res,data.actions) && !overlap(data.center,data.actions), `${w}x${h}: top panels overlap`);
    assert(!overlap(data.crowns,data.tools), `${w}x${h}: crowns cover tools`);
    assert(data.pause && data.map && data.tool, `${w}x${h}: key controls covered: ${JSON.stringify(data)}`);
    assert.equal(data.crownCount, 4, `${w}x${h}: four crowns not rendered`);
    if (h <= 700) {
      assert(inSafe(data.toggle) && data.rail.b <= data.toggle.b + 1, `${w}x${h}: closed controls drawer blocks the map`);
      await page.touchscreen.tap((data.toggle.l+data.toggle.r)/2, (data.toggle.t+data.toggle.b)/2);
      const expanded = await page.evaluate(() => {
        const rail = document.getElementById('leftRail');
        const button = document.getElementById('camZoomOut'); button.scrollIntoView({ block:'nearest' });
        const r = button.getBoundingClientRect(), p = rail.getBoundingClientRect();
        window.__imperial.camera.desiredDist = 44;
        return { open:document.getElementById('railToggle').getAttribute('aria-expanded'), scroll:rail.scrollTop,
          visible:r.top >= p.top - 1 && r.bottom <= p.bottom + 1, x:(r.left+r.right)/2, y:(r.top+r.bottom)/2,
          distance:window.__imperial.camera.desiredDist };
      });
      assert(expanded.open === 'true' && expanded.scroll > 0 && expanded.visible, `${w}x${h}: controls drawer cannot scroll to camera actions: ${JSON.stringify(expanded)}`);
      await page.touchscreen.tap(expanded.x, expanded.y);
      const after = await page.evaluate(() => window.__imperial.camera.desiredDist);
      assert(after > expanded.distance, `${w}x${h}: camera action did not respond to touch`);
      await page.tap('#railToggle');
      assert.equal(await page.$eval('#railToggle', e => e.getAttribute('aria-expanded')), 'false', 'controls drawer did not close');
    }
    console.log(`  ok   ${w}x${h} HUD, safe area and controls`);
  }
  await viewport([800, 360]);
  assert(await page.evaluate(() => {
    const a = window.__imperial;
    const unit = a.game.units.find(u => !u.dead && u.team === 1 && u.def.attack > 0 && !u.garrisoned);
    return !!unit && a.game.directControl.enter(unit);
  }), 'could not enter first-person mode');
  for (const size of sizes.filter(([w,h]) => w > h)) {
    await viewport(size);
    for (const mode of ['comfortable','large']) {
      const data = await page.evaluate(mode => {
        document.body.dataset.fpButtons = mode;
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom }; };
        const hit = s => { const e = document.querySelector(s), r=e.getBoundingClientRect(), p=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2); return p === e || e.contains(p); };
        return { identity:rect('.fpIdentity'), actions:rect('.fpTopActions'), stick:rect('#fpStick'), attack:rect('#fpAttack'), dodge:rect('#fpDodge'), block:rect('#fpBlock'), exit:hit('#fpExit'), attackHit:hit('#fpAttack') };
      }, mode);
      const [w,h,safe={}] = size;
      const inSafe = r => r.l >= (safe.left || 0) - 1 && r.t >= (safe.top || 0) - 1 && r.r <= w - (safe.right || 0) + 1 && r.b <= h - (safe.bottom || 0) + 1;
      const overlap = (a,b) => a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1;
      for (const key of ['identity','actions','stick','attack','dodge','block']) assert(inSafe(data[key]), `${w}x${h} ${mode}: ${key} outside safe area: ${JSON.stringify(data)}`);
      assert(!overlap(data.identity,data.actions) && !overlap(data.stick,data.attack) && !overlap(data.stick,data.block), `${w}x${h} ${mode}: first-person controls overlap`);
      assert(data.exit && data.attackHit, `${w}x${h} ${mode}: first-person controls covered`);
    }
    console.log(`  ok   ${size[0]}x${size[1]} first-person controls`);
  }
  await page.evaluate(() => { document.body.dataset.fpButtons = 'comfortable'; window.__imperial.game.directControl.exit(); });
  await viewport([568, 320]);
  await page.evaluate(() => window.__imperial.menu.openSettings());
  await new Promise(r => setTimeout(r, 350)); // allow the entrance animation to finish
  const modal = await page.evaluate(() => {
    const card = document.querySelector('.modalCard').getBoundingClientRect(), close = document.getElementById('modalClose').getBoundingClientRect();
    const hit = document.elementFromPoint((close.left + close.right) / 2, (close.top + close.bottom) / 2);
    return { card:[card.left,card.top,card.right,card.bottom], close:[close.left,close.top,close.right,close.bottom], hit:hit?.outerHTML?.slice(0, 250), scroll:getComputedStyle(document.getElementById('modalBody')).touchAction };
  });
  assert(modal.card[0] >= -1 && modal.card[1] >= -1 && modal.card[2] <= 569 && modal.card[3] <= 321 && modal.scroll.includes('pan-y'), `settings modal is not usable: ${JSON.stringify(modal)}`);
  const qualityButtons = await page.$$eval('#setQuality .seg', buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return [r.left, r.right, r.width, r.height]; }));
  assert(qualityButtons.length === 5 && qualityButtons.every(r => r[0] >= modal.card[0] && r[1] <= modal.card[2] && r[2] >= 42 && r[3] >= 36), `graphics choices outside modal or too small: ${JSON.stringify(qualityButtons)}`);
  await page.tap('#setQuality [data-q="auto"]');
  assert(await page.evaluate(() => window.__imperial.settings.autoQuality), 'auto graphics choice did not respond');
  await page.tap('#modalClose');
  assert(await page.$eval('#modalScreen', e => e.classList.contains('hidden')), `settings close did not respond: ${JSON.stringify(modal)}`);
  // Exercise actual browser context invalidation, not just mocked GL handles.
  assert(await page.evaluate(() => {
    const a = window.__imperial, ext = a.renderer.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    a._testLoseContext = ext; a._testGame = a.game; a._testProgram = a.renderer.pModel.program;
    ext.loseContext(); return true;
  }), 'WEBGL_lose_context extension unavailable');
  await page.waitForFunction('window.__imperial._recoveringGraphics && !window.__imperial.renderer.ready', { timeout: 30000 });
  assert(await page.evaluate(() => window.__imperial.paused && !document.getElementById('bootScreen').classList.contains('hidden')), 'context loss did not pause or show recovery');
  await page.evaluate(() => window.__imperial._testLoseContext.restoreContext());
  await page.waitForFunction('!window.__imperial._recoveringGraphics && window.__imperial.renderer.ready', { timeout: 120000 });
  assert(await page.evaluate(() => {
    const a = window.__imperial;
    return a.game === a._testGame && a.renderer.pModel.program !== a._testProgram && a.renderer.chunks.length === 16 && !a.paused && document.getElementById('bootScreen').classList.contains('hidden');
  }), 'graphics restoration did not restore the same battle');
  console.log('  ok   browser WebGL context loss and battle restoration');
  assert.deepEqual(errors, [], 'page errors');
  console.log('RESPONSIVE VIEWPORT CHECKS PASSED (emulated Chromium)');
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
