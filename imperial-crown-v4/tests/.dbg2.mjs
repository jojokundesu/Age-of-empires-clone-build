import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
const ROOT = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('x'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const chromium = (await import('@sparticuz/chromium')).default;
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true,
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__imperial && window.__imperial.renderer && window.__imperial.renderer.ready', { timeout: 300000 });
await page.waitForFunction(() => { const m = document.getElementById('menuScreen'); return m && !m.classList.contains('hidden'); }, { polling: 200 });
await page.click('#btnStart');
await page.waitForFunction('window.__imperial.running === true');
const out = await page.evaluate(() => {
  const a = window.__imperial, g = a.game;
  const tc = g.buildings.find((b) => b.team === 1 && b.type === 'town_center');
  // lay a wall run north-south and put a gate in the middle
  let cells = null;
  for (let r = 14; r < 80 && !cells; r += 3) for (let k = 0; k < 48 && !cells; k++) {
    const ang = k / 48 * Math.PI * 2;
    const x = tc.x + Math.cos(ang) * r, z = tc.z + Math.sin(ang) * r;
    const c = g.planWallLine('stone_wall', x, z - 8, x, z + 8, 1, 20);
    if (c.every((q) => q.ok)) cells = c;
  }
  if (!cells) return { err: 'no line' };
  const gateCell = cells[Math.floor(cells.length / 2)];
  for (const c of cells) if (c !== gateCell) g.placeBuilding('stone_wall', 1, c.x, c.z, { instant: true, free: true });
  const gate = g.placeBuilding('stone_gate', 1, gateCell.x, gateCell.z, { instant: true, free: true });
  g.refreshNav();
  const ally = g.spawnUnitRaw('swordsman', 1, gateCell.x - 6, gateCell.z);
  const N = g.world.nav.cells, cell = g.world.nav.cell, half = 256;
  const idx = (x, z) => Math.floor((z + half) / cell) * N + Math.floor((x + half) / cell);
  const samples = [];
  for (let i = 0; i <= 5; i++) {
    const x = gateCell.x - 4 + i * 1.6, z = gateCell.z;
    samples.push({
      dx: +(x - gateCell.x).toFixed(2),
      pass: g.isPassable(x, z, ally),
      allyCell: g.navFinal[idx(x, z)],
      foeCell: g.navFinalEnemy[idx(x, z)],
      build: g.navBuild[idx(x, z)], carve: g.navCarve[idx(x, z)], gateL: g.navGate[idx(x, z)]
    });
  }
  return { gate: [gateCell.x, gateCell.z], gateOpen: gate && gate.gateOpen, samples, walls: g.buildings.filter(b=>b.type==='stone_wall'&&!b.dead).length };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
