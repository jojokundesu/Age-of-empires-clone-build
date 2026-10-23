#!/usr/bin/env node
// Tiny PNG reader for screenshot QA: no deps, decodes 8-bit RGB/RGBA.
// Usage: node tests/px.mjs shot.png x,y x,y ...   (prints sRGB 0-255 + hex)
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function readPNG(file) {
  const buf = readFileSync(file);
  let off = 8, w = 0, h = 0, bpp = 4, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      const depth = data[8], color = data[9];
      if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
      bpp = color === 6 ? 4 : color === 2 ? 3 : 1;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

if (process.argv[1] && process.argv[1].endsWith('px.mjs')) {
  const [file, ...pts] = process.argv.slice(2);
  const img = readPNG(file);
  for (const pt of pts) {
    const [x, y] = pt.split(',').map(Number);
    const i = (y * img.w + x) * img.bpp;
    const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    console.log(`${pt} -> rgb(${r},${g},${b}) ${hex}`);
  }
}
