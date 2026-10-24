/* Writes the baked terrain radiance map (and the detail/cloud tiles) as PNGs
   so the bake can be inspected without a GPU. */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateWorld, buildRenderTerrain } from '../src/sim/worldgen.js';
import { bakeTerrain, bakeGroundDetail, bakeClouds } from '../src/gfx/bake.js';

// stand-ins for the painted layer canvases (textures.js needs a 2D canvas)
function fakeLayers() {
  const out = [];
  const palettes = [
    [74, 96, 46], [124, 118, 70], [96, 74, 52], [140, 136, 130], [206, 190, 150],
    [120, 100, 60], [120, 116, 108], [236, 240, 248], [86, 66, 48], [150, 146, 138],
    [46, 66, 38], [40, 38, 36]
  ];
  for (let l = 0; l < 12; l++) {
    const p = palettes[l];
    const a = new Uint8ClampedArray(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const n = 0.86 + 0.28 * (((x * 7 + y * 13) % 17) / 17);
      a[i] = p[0] * n; a[i + 1] = p[1] * n; a[i + 2] = p[2] * n; a[i + 3] = 255;
    }
    out.push(a);
  }
  return out;
}

const world = generateWorld(20261);
const RT = buildRenderTerrain(world);
const t0 = Date.now();
const clouds = bakeClouds(512);
const albedo = bakeTerrain(world, RT, fakeLayers(), { size: 512, cloudData: clouds, cloudSize: 512 });
console.log('bake ms', Date.now() - t0);

function writePPM(path, data, w, h, flip = true) {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = flip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * 4, d = (y * w + x) * 3;
      body[d] = data[s]; body[d + 1] = data[s + 1]; body[d + 2] = data[s + 2];
    }
  }
  writeFileSync(path, Buffer.concat([header, body]));
  execFileSync('convert', [path, path.replace(/\.ppm$/, '.png')]);
}
writePPM('.tmp/terrain-bake.ppm', albedo, 512, 512);
// AO channel
const ao = new Uint8ClampedArray(512 * 512 * 4);
for (let i = 0; i < 512 * 512; i++) {
  const v = albedo[i * 4 + 3];
  ao[i * 4] = v; ao[i * 4 + 1] = v; ao[i * 4 + 2] = v; ao[i * 4 + 3] = 255;
}
writePPM('.tmp/terrain-ao.ppm', ao, 512, 512);
const det = bakeGroundDetail(512);
writePPM('.tmp/detail.ppm', det, 512, 512, false);
console.log('wrote previews');
