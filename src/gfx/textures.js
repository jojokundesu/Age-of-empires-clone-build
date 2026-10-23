/* ============================================================
   textures.js — procedural texture forge
   Every ground, wall, roof, cloth and particle texture in the game
   is painted here at boot with the 2D canvas API. Nothing is
   downloaded; the whole art budget is a few hundred ms of CPU.
   ============================================================ */
import { mulberry32, noise2, fbm2, clamp, lerp } from '../core/math.js';

function makeCanvas(w, h = w) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const ctxOf = (c) => c.getContext('2d', { willReadFrequently: true });

/* ---------- low level helpers ---------- */
function pixelPass(size, fn) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  fn(d, size);
  g.putImageData(img, 0, 0);
  return c;
}
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

function shade(base, v) {
  return [
    clamp(base[0] * v, 0, 255),
    clamp(base[1] * v, 0, 255),
    clamp(base[2] * v, 0, 255)
  ];
}

/* =====================================================================
   TERRAIN
   ===================================================================== */
const T_GRASS = 0, T_GRASS_DRY = 1, T_DIRT = 2, T_ROCK = 3, T_SAND = 4, T_FARM = 5,
  T_COBBLE = 6, T_SNOW = 7, T_MUD = 8, T_GRAVEL = 9, T_FOREST = 10, T_ASH = 11;
export const TERRAIN_LAYER = {
  grass: T_GRASS, grassDry: T_GRASS_DRY, dirt: T_DIRT, rock: T_ROCK, sand: T_SAND,
  farm: T_FARM, cobble: T_COBBLE, snow: T_SNOW, mud: T_MUD, gravel: T_GRAVEL,
  forest: T_FOREST, ash: T_ASH
};

function paintGrass(lush) {
  const S = 256;
  return pixelPass(S, (d) => {
    const cA = lush ? [74, 96, 46] : [112, 110, 62];
    const cB = lush ? [104, 128, 58] : [140, 132, 74];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const n = fbm2(x * 0.055, y * 0.055, 4) * 0.5 + 0.5;
        const fine = noise2(x * 0.5, y * 0.5) * 0.5 + 0.5;
        const blade = Math.pow(noise2(x * 0.22 + 31, y * 0.11), 1.4);
        let v = 0.55 + n * 0.5 + fine * 0.16 + blade * 0.18;
        const c = shade(cA, v);
        const t = clamp(n * 0.7 + fine * 0.4, 0, 1);
        d[i] = lerp(c[0], cB[0] * v, t * 0.8);
        d[i + 1] = lerp(c[1], cB[1] * v, t * 0.8);
        d[i + 2] = lerp(c[2], cB[2] * v, t * 0.7);
        d[i + 3] = 255;
      }
    }
  });
}

function paintDirt() {
  const S = 256;
  return pixelPass(S, (d) => {
    const base = [92, 70, 48];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.06 + 5, y * 0.06 - 3, 4) * 0.5 + 0.5;
      const f = noise2(x * 0.75, y * 0.75) * 0.5 + 0.5;
      const v = 0.62 + n * 0.42 + f * 0.12;
      const pebble = Math.pow(noise2(x * 0.3 + 12, y * 0.3), 6);
      const c = shade(base, v);
      d[i] = c[0] + pebble * 95;
      d[i + 1] = c[1] + pebble * 88;
      d[i + 2] = c[2] + pebble * 76;
      d[i + 3] = 255;
    }
  });
}

function paintRock() {
  const S = 256;
  return pixelPass(S, (d) => {
    const base = [116, 114, 108];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const warp = fbm2(x * 0.02, y * 0.02, 3) * 26;
      const strata = Math.sin((y + warp) * 0.19) * 0.5 + 0.5;
      const n = fbm2(x * 0.09 + 3, y * 0.09 + 9, 4) * 0.5 + 0.5;
      const crack = Math.pow(1 - Math.abs(noise2(x * 0.05, y * 0.05)), 22);
      const v = 0.62 + n * 0.34 + strata * 0.16 - crack * 0.34;
      const c = shade(base, v);
      const moss = clamp((fbm2(x * 0.03 + 40, y * 0.03, 2) - 0.12) * 3.4, 0, 1) * 0.35;
      d[i] = lerp(c[0], 74, moss);
      d[i + 1] = lerp(c[1], 92, moss);
      d[i + 2] = lerp(c[2], 52, moss);
      d[i + 3] = 255;
    }
  });
}

function paintSand() {
  const S = 256;
  return pixelPass(S, (d) => {
    const base = [196, 174, 134];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const ripple = Math.sin((y + fbm2(x * 0.02, y * 0.02, 2) * 16) * 0.34) * 0.5 + 0.5;
      const n = noise2(x * 0.9, y * 0.9) * 0.5 + 0.5;
      const v = 0.78 + n * 0.22 + ripple * 0.07;
      const c = shade(base, v);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  });
}

function paintFarm() {
  const S = 256;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#5d452c'; g.fillRect(0, 0, S, S);
  // furrows
  for (let y = 0; y < S; y += 16) {
    g.fillStyle = '#4a3520'; g.fillRect(0, y, S, 7);
    g.fillStyle = '#6b5033'; g.fillRect(0, y + 7, S, 5);
    for (let x = 0; x < S; x += 6) {
      const jitter = (Math.random() - 0.5) * 3;
      g.fillStyle = Math.random() < 0.5 ? '#9aa64a' : '#8a9540';
      g.fillRect(x + jitter, y + 1, 1.6, 9);
    }
  }
  return c;
}

function paintCobble() {
  const S = 256;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#4a453c'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(7);
  for (let y = 0; y < S; y += 22) {
    let x = -10 + rnd() * 8;
    while (x < S) {
      const w = 16 + rnd() * 12, h = 15 + rnd() * 6;
      const cc = 118 + rnd() * 46;
      g.fillStyle = `rgb(${cc | 0},${(cc - 4) | 0},${(cc - 12) | 0})`;
      g.beginPath();
      g.roundRect(x + 1.5, y + 1.5 + rnd() * 3, w - 3, h - 3, 5);
      g.fill();
      const grad = g.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, 'rgba(255,255,255,0.16)');
      grad.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = grad;
      g.beginPath(); g.roundRect(x + 1.5, y + 1.5 + rnd() * 3, w - 3, h - 3, 5); g.fill();
      x += w + 2;
    }
  }
  // moss in the joints
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const n = fbm2(x * 0.05, y * 0.05, 3);
    const dark = 1 - (d[i] / 150);
    if (n > 0.16 && dark > 0.25) {
      const m = clamp((n - 0.16) * 3, 0, 1) * 0.6;
      d[i] = lerp(d[i], 78, m); d[i + 1] = lerp(d[i + 1], 96, m); d[i + 2] = lerp(d[i + 2], 54, m);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function paintSnow() {
  const S = 256;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.05, y * 0.05, 4) * 0.5 + 0.5;
      const spark = Math.pow(noise2(x * 1.7, y * 1.7), 8) * 60;
      d[i] = 214 + n * 34 + spark;
      d[i + 1] = 224 + n * 30 + spark;
      d[i + 2] = 236 + n * 18 + spark;
      d[i + 3] = 255;
    }
  });
}

function paintMud() {
  const S = 256;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.05, y * 0.05, 4) * 0.5 + 0.5;
      const wet = Math.pow(noise2(x * 0.09, y * 0.09), 3) * 40;
      d[i] = 62 + n * 34 + wet;
      d[i + 1] = 50 + n * 26 + wet * 0.8;
      d[i + 2] = 38 + n * 18 + wet * 0.6;
      d[i + 3] = 255;
    }
  });
}

function paintGravel() {
  const S = 256;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#5c584f'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(19);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S, y = rnd() * S, r = 1.6 + rnd() * 4;
    const v = 96 + rnd() * 74;
    g.fillStyle = `rgb(${v | 0},${(v - 4) | 0},${(v - 10) | 0})`;
    g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, 6.28); g.fill();
  }
  return c;
}

function paintForestFloor() {
  const S = 256;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.05, y * 0.05, 4) * 0.5 + 0.5;
      const leaf = Math.pow(noise2(x * 0.14, y * 0.14), 5);
      d[i] = 58 + n * 34 + leaf * 54;
      d[i + 1] = 58 + n * 40 + leaf * 30;
      d[i + 2] = 34 + n * 20;
      d[i + 3] = 255;
    }
  });
}

function paintAsh() {
  const S = 256;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.06, y * 0.06, 4) * 0.5 + 0.5;
      const ember = Math.pow(noise2(x * 0.4, y * 0.4), 9);
      d[i] = 44 + n * 26 + ember * 120;
      d[i + 1] = 40 + n * 22 + ember * 44;
      d[i + 2] = 36 + n * 20;
      d[i + 3] = 255;
    }
  });
}

/* =====================================================================
   MATERIALS (buildings / props)
   ===================================================================== */
export const MAT = {
  STONE: 0, STONE_LIGHT: 1, PLASTER: 2, WOOD: 3, WOOD_DARK: 4, ROOF: 5, THATCH: 6,
  CLOTH: 7, IRON: 8, GOLD: 9, MARBLE: 10, BRICK: 11, GLASS: 12, GRAVEL: 13, LEATHER: 14, LEAF: 15
};

function paintStone(base, variation, blockW = 42, blockH = 22, mortar = '#3a3631') {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = mortar; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(base[0] * 7 + base[1]);
  for (let row = 0; row < Math.ceil(S / blockH); row++) {
    const offset = row % 2 ? blockW * 0.5 : 0;
    for (let x = -blockW; x < S + blockW; x += blockW) {
      const v = 0.86 + rnd() * 0.26;
      const w = blockW - 2.5 - rnd() * 2, h = blockH - 2.5 - rnd() * 1.5;
      const b = shade(base, v);
      g.fillStyle = `rgb(${b[0] | 0},${b[1] | 0},${b[2] | 0})`;
      g.beginPath(); g.roundRect(x + offset + 1.4, row * blockH + 1.4, w, h, 2.2); g.fill();
      // top light + bottom shadow for chiselled relief
      g.fillStyle = 'rgba(255,255,255,0.20)';
      g.fillRect(x + offset + 2, row * blockH + 1.6, w - 1, 1.6);
      g.fillStyle = 'rgba(0,0,0,0.26)';
      g.fillRect(x + offset + 2, row * blockH + h, w - 1, 1.8);
      // speckle
      for (let k = 0; k < 5; k++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.09)';
        g.fillRect(x + offset + 3 + rnd() * (w - 6), row * blockH + 3 + rnd() * (h - 6), 1.5, 1.5);
      }
    }
  }
  // grime gradient + noise
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const n = fbm2(x * 0.03, y * 0.03, 3) * 0.5 + 0.5;
    const grime = 0.90 + n * 0.20;
    d[i] *= grime; d[i + 1] *= grime; d[i + 2] *= grime * 1.01;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function paintPlaster() {
  const S = 128;
  return pixelPass(S, (d) => {
    const base = [214, 198, 166];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.04, y * 0.04, 4) * 0.5 + 0.5;
      const speck = noise2(x * 0.9, y * 0.9) * 0.5 + 0.5;
      const stain = Math.max(0, fbm2(x * 0.02 + 7, y * 0.02, 3) - 0.1) * 1.6;
      const v = 0.86 + n * 0.20 + speck * 0.06 - stain * 0.20;
      d[i] = base[0] * v; d[i + 1] = base[1] * v * 0.99; d[i + 2] = base[2] * v * 0.95;
      d[i + 3] = 255;
    }
    // hairline cracks
    const g = null;
  });
}

function paintWood(base = [120, 82, 48], plankW = 32) {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = 'rgb(40,26,14)'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(3);
  for (let x = 0; x < S; x += plankW) {
    const v = 0.86 + rnd() * 0.3;
    const b = shade(base, v);
    g.fillStyle = `rgb(${b[0] | 0},${b[1] | 0},${b[2] | 0})`;
    g.fillRect(x + 1, 0, plankW - 2, S);
    // grain
    for (let k = 0; k < 22; k++) {
      const gx = x + 2 + rnd() * (plankW - 4);
      g.strokeStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.14)' : 'rgba(255,235,200,0.10)';
      g.lineWidth = 0.8 + rnd();
      g.beginPath();
      g.moveTo(gx, 0);
      for (let y = 0; y < S; y += 8) g.lineTo(gx + Math.sin(y * 0.06 + k) * 1.6, y);
      g.stroke();
    }
    // nails
    g.fillStyle = 'rgba(30,22,16,0.7)';
    g.beginPath(); g.arc(x + 4, 8, 1.4, 0, 6.28); g.fill();
    g.beginPath(); g.arc(x + 4, S - 8, 1.4, 0, 6.28); g.fill();
  }
  return c;
}

function paintRoof() {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#4a2417'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(11);
  const tileW = 22, tileH = 15;
  for (let row = 0; row < S / tileH + 2; row++) {
    for (let x = -tileW; x < S + tileW; x += tileW) {
      const off = row % 2 ? tileW * 0.5 : 0;
      const v = 0.8 + rnd() * 0.45;
      const b = shade([158, 78, 48], v);
      g.fillStyle = `rgb(${b[0] | 0},${b[1] | 0},${b[2] | 0})`;
      g.beginPath();
      const px = x + off, py = row * tileH;
      g.moveTo(px + 1, py + tileH);
      g.quadraticCurveTo(px + tileW * 0.5, py - 2, px + tileW - 1, py + tileH);
      g.lineTo(px + tileW - 1, py + tileH + 4);
      g.lineTo(px + 1, py + tileH + 4);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(px + 2, py + tileH, tileW - 4, 3);
    }
  }
  return c;
}

function paintThatch() {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#6e5a2c'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(5);
  for (let i = 0; i < 1600; i++) {
    const x = rnd() * S, y = rnd() * S;
    const len = 6 + rnd() * 16;
    const v = 0.7 + rnd() * 0.6;
    const b = shade([176, 148, 88], v);
    g.strokeStyle = `rgb(${b[0] | 0},${b[1] | 0},${b[2] | 0})`;
    g.lineWidth = 0.9 + rnd() * 0.9;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + len); g.stroke();
  }
  return c;
}

function paintCloth(base = [150, 46, 40]) {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const weave = (Math.sin(x * 2.1) * Math.sin(y * 2.1)) * 0.5 + 0.5;
      const fold = fbm2(x * 0.02, y * 0.03, 3) * 0.5 + 0.5;
      const v = 0.74 + weave * 0.14 + fold * 0.30;
      d[i] = clamp(base[0] * v, 0, 255);
      d[i + 1] = clamp(base[1] * v, 0, 255);
      d[i + 2] = clamp(base[2] * v, 0, 255);
      d[i + 3] = 255;
    }
  });
}

function paintIron() {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.05, y * 0.05, 4) * 0.5 + 0.5;
      const scratch = Math.pow(Math.abs(noise2(x * 0.6 + y * 0.1, y * 0.6)), 6) * 40;
      const v = 0.42 + n * 0.30 + scratch / 255;
      d[i] = 90 * v + 34; d[i + 1] = 94 * v + 34; d[i + 2] = 100 * v + 36;
      d[i + 3] = 255;
    }
  });
}

function paintGoldMat() {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.06, y * 0.06, 3) * 0.5 + 0.5;
      const v = 0.6 + n * 0.55;
      d[i] = clamp(232 * v, 0, 255); d[i + 1] = clamp(190 * v, 0, 255); d[i + 2] = clamp(96 * v, 0, 255);
      d[i + 3] = 255;
    }
  });
}

function paintMarble() {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const w = fbm2(x * 0.02, y * 0.02, 4);
      const vein = Math.pow(Math.abs(Math.sin((x * 0.08 + y * 0.05 + w * 6))), 16);
      const v = 0.86 + w * 0.2;
      d[i] = clamp(226 * v - vein * 70, 0, 255);
      d[i + 1] = clamp(222 * v - vein * 70, 0, 255);
      d[i + 2] = clamp(216 * v - vein * 60, 0, 255);
      d[i + 3] = 255;
    }
  });
}

function paintBrick() {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  g.fillStyle = '#4b3a30'; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(23);
  for (let row = 0; row < 9; row++) {
    for (let x = -16; x < S + 16; x += 17) {
      const off = row % 2 ? 8 : 0;
      const v = 0.82 + rnd() * 0.34;
      const b = shade([148, 74, 54], v);
      g.fillStyle = `rgb(${b[0] | 0},${b[1] | 0},${b[2] | 0})`;
      g.fillRect(x + off + 1, row * 14 + 1, 15, 12);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + off + 1, row * 14 + 1, 15, 1.4);
    }
  }
  return c;
}

function paintGlass() {
  const S = 128;
  const c = makeCanvas(S);
  const g = ctxOf(c);
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, '#2a3b46');
  grad.addColorStop(0.45, '#6d8590');
  grad.addColorStop(0.5, '#8fa6ac');
  grad.addColorStop(1, '#1d2a33');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(16,20,22,0.8)'; g.lineWidth = 4;
  g.strokeRect(2, 2, S - 4, S - 4);
  g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  return c;
}

function paintLeather() {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.07, y * 0.07, 4) * 0.5 + 0.5;
      const grain = Math.pow(noise2(x * 0.5, y * 0.5), 2) * 26;
      d[i] = 108 + n * 44 + grain; d[i + 1] = 74 + n * 32 + grain * 0.7; d[i + 2] = 48 + n * 22 + grain * 0.5;
      d[i + 3] = 255;
    }
  });
}

function paintLeaf() {
  const S = 128;
  return pixelPass(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = fbm2(x * 0.06, y * 0.06, 4) * 0.5 + 0.5;
      const vein = Math.pow(Math.abs(Math.sin(x * 0.25 + y * 0.1 + n * 4)), 12);
      d[i] = 58 + n * 46 - vein * 20;
      d[i + 1] = 92 + n * 62 - vein * 12;
      d[i + 2] = 40 + n * 30;
      d[i + 3] = 255;
    }
  });
}

/* =====================================================================
   PARTICLES / SPRITES
   ===================================================================== */
export const SPRITE = {
  PUFF: 0, SMOKE: 1, FIRE: 2, SPARK: 3, DUST: 4, LEAF: 5, BLOOD: 6, STAR: 7,
  RING: 8, GLOW: 9, STREAK: 10, SNOW: 11, CHIP: 12, RUNE: 13, NOTE: 14, WATER: 15
};

function radial(size, stops) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) grd.addColorStop(t, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

function puffSprite(size, softness = 1, color = [255, 255, 255]) {
  return pixelPass(size, (d) => {
    const h = size / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - h) / h, dy = (y - h) / h;
      const r = Math.hypot(dx, dy);
      const n = fbm2(x * 0.06, y * 0.06, 4) * 0.5 + 0.5;
      let a = clamp(1 - r * (1.0 + (1 - softness)), 0, 1);
      a = Math.pow(a, 1.6) * (0.55 + n * 0.75);
      d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2];
      d[i + 3] = clamp(a * 255, 0, 255);
    }
  });
}

function flameSprite(size) {
  return pixelPass(size, (d) => {
    const h = size / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const nx = (x - h) / h, ny = (y - h) / h;
      const r = Math.hypot(nx, ny * 0.8);
      const n = fbm2(x * 0.12, y * 0.09, 4) * 0.5 + 0.5;
      const core = clamp(1 - r * (1.5 + (1 - n)), 0, 1);
      const a = Math.pow(core, 1.3) * (0.5 + n * 0.9);
      const t = clamp(core * 1.3, 0, 1);
      d[i] = 255;
      d[i + 1] = clamp(120 + t * 135, 0, 255);
      d[i + 2] = clamp(30 + t * 150 * t, 0, 255);
      d[i + 3] = clamp(a * 255, 0, 255);
    }
  });
}

function leafSprite(size) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  g.translate(size / 2, size / 2);
  g.fillStyle = '#9ab04a';
  g.beginPath();
  g.ellipse(0, 0, size * 0.22, size * 0.42, 0.5, 0, 6.28);
  g.fill();
  g.strokeStyle = 'rgba(60,80,30,0.9)'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(-size * 0.16, size * 0.3); g.lineTo(size * 0.16, -size * 0.3); g.stroke();
  return c;
}

function ringSprite(size) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = size * 0.06;
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.40, 0, 6.28); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = size * 0.14;
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.40, 0, 6.28); g.stroke();
  return c;
}

function runeSprite(size) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  g.translate(size / 2, size / 2);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = size * 0.025;
  g.beginPath(); g.arc(0, 0, size * 0.40, 0, 6.28); g.stroke();
  g.beginPath(); g.arc(0, 0, size * 0.31, 0, 6.28); g.stroke();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * size * 0.32, Math.sin(a) * size * 0.32);
    g.lineTo(Math.cos(a) * size * 0.39, Math.sin(a) * size * 0.39);
    g.stroke();
  }
  // star
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    const x = Math.cos(a) * size * 0.22, y = Math.sin(a) * size * 0.22;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath(); g.stroke();
  return c;
}

function streakSprite(size) {
  const c = makeCanvas(size);
  const g = ctxOf(c);
  const grd = g.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(size * 0.42, 0, size * 0.16, size);
  return c;
}

/* =====================================================================
   TILEABLE NOISE / NORMAL MAPS
   ===================================================================== */
function tileableFbm(x, y, period, oct = 5) {
  // 4-way blended tiling trick
  let sx = x / period, sy = y / period;
  const blend = (u, v) => fbm2(u, v, oct);
  const a = blend(x, y);
  const b = blend(x - period, y);
  const c = blend(x, y - period);
  const d = blend(x - period, y - period);
  return lerp(lerp(a, b, sx), lerp(c, d, sy), 1) * 0.5 + 0.5 * (a + b + c + d) * 0.25;
}

function waterNormalMap(size = 256) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
    let h = 0;
    h += Math.sin(u * 3 + v * 1.5 + Math.sin(v * 2) * 1.2) * 0.5;
    h += Math.sin(u * 5 - v * 3 + 2.1) * 0.28;
    h += Math.sin(u * 8 + v * 6 - 1.3) * 0.14;
    h += fbm2(x * 0.05, y * 0.05, 3) * 0.8;
    h += fbm2(x * 0.12, y * 0.12, 2) * 0.3;
    height[y * size + x] = h;
  }
  const c = makeCanvas(size);
  const g = ctxOf(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const strength = 2.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const l = height[y * size + ((x - 1 + size) % size)];
    const r = height[y * size + ((x + 1) % size)];
    const u = height[((y - 1 + size) % size) * size + x];
    const dn = height[((y + 1) % size) * size + x];
    let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    d[i] = (nx / len * 0.5 + 0.5) * 255;
    d[i + 1] = (ny / len * 0.5 + 0.5) * 255;
    d[i + 2] = (nz / len * 0.5 + 0.5) * 255;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function cloudMap(size = 512) {
  return pixelPass(size, (d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // periodic-ish cloud field
      const u = x / size * 6.2832, v = y / size * 6.2832;
      let n = fbm2(Math.cos(u) * 3 + 10, Math.sin(u) * 3 + Math.cos(v) * 2, 5) * 0.5 + 0.5;
      n += fbm2(Math.cos(v) * 5, Math.sin(v) * 5 + Math.sin(u) * 2, 4) * 0.5 + 0.5;
      n *= 0.5;
      const a = clamp((n - 0.34) * 2.6, 0, 1);
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = a * 255;
    }
  });
}

function dirtDetail(size = 256) {
  return pixelPass(size, (d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = fbm2(x * 0.02, y * 0.02, 4) * 0.5 + 0.5;
      d[i] = d[i + 1] = d[i + 2] = clamp(n * 255, 0, 255);
      d[i + 3] = 255;
    }
  });
}

/* =====================================================================
   GPU UPLOAD
   ===================================================================== */
function uploadArray(gl, canvases, size, opts = {}) {
  const layers = canvases.length;
  const levels = Math.floor(Math.log2(size)) + 1;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, layers);
  for (let i = 0; i < layers; i++) {
    const cv = canvases[i];
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  }
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext && opts.aniso) {
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(opts.aniso, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  return tex;
}

function upload2D(gl, canvas, opts = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrap ?? gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrap ?? gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(opts.aniso ?? 4, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return tex;
}

export function buildTextures(gl, onStep = () => {}) {
  const t = {};
  onStep('Grinding stone and soil…', 0.05);
  const terrain = [
    paintGrass(true), paintGrass(false), paintDirt(), paintRock(),
    paintSand(), paintFarm(), paintCobble(), paintSnow(),
    paintMud(), paintGravel(), paintForestFloor(), paintAsh()
  ];
  onStep('Quarrying masonry…', 0.32);
  const materials = [
    paintStone([142, 138, 128]), paintStone([178, 172, 158], 0, 52, 26),
    paintPlaster(), paintWood([124, 86, 52]), paintWood([74, 50, 30], 22),
    paintRoof(), paintThatch(), paintCloth([150, 46, 40]), paintIron(),
    paintGoldMat(), paintMarble(), paintBrick(), paintGlass(), paintGravel(),
    paintLeather(), paintLeaf()
  ];
  onStep('Kindling sparks and smoke…', 0.58);
  const sprites = new Array(16).fill(null).map(() => puffSprite(128, 0.4));
  sprites[SPRITE.PUFF] = puffSprite(128, 0.25);
  sprites[SPRITE.SMOKE] = puffSprite(128, 0.5);
  sprites[SPRITE.FIRE] = flameSprite(128);
  sprites[SPRITE.SPARK] = radial(64, [[0, 'rgba(255,255,240,1)'], [0.35, 'rgba(255,220,140,0.85)'], [1, 'rgba(255,140,40,0)']]);
  sprites[SPRITE.DUST] = puffSprite(128, 0.75);
  sprites[SPRITE.LEAF] = leafSprite(128);
  sprites[SPRITE.BLOOD] = radial(64, [[0, 'rgba(190,30,26,0.95)'], [0.6, 'rgba(120,14,12,0.7)'], [1, 'rgba(90,10,8,0)']]);
  sprites[SPRITE.STAR] = radial(64, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
  sprites[SPRITE.RING] = ringSprite(128);
  sprites[SPRITE.GLOW] = radial(128, [[0, 'rgba(255,244,214,0.9)'], [0.45, 'rgba(255,200,110,0.35)'], [1, 'rgba(255,160,40,0)']]);
  sprites[SPRITE.STREAK] = streakSprite(128);
  sprites[SPRITE.SNOW] = radial(32, [[0, 'rgba(255,255,255,1)'], [0.6, 'rgba(240,248,255,0.8)'], [1, 'rgba(240,248,255,0)']]);
  sprites[SPRITE.CHIP] = puffSprite(64, 0.1, [214, 204, 180]);
  sprites[SPRITE.RUNE] = runeSprite(256);
  sprites[SPRITE.NOTE] = radial(64, [[0, 'rgba(255,250,220,1)'], [1, 'rgba(255,220,120,0)']]);
  sprites[SPRITE.WATER] = radial(64, [[0, 'rgba(200,235,255,0.9)'], [1, 'rgba(140,200,235,0)']]);

  onStep('Uploading to the GPU…', 0.8);
  t.terrain = uploadArray(gl, terrain, 256, { aniso: 4 });
  t.materials = uploadArray(gl, materials, 128, { aniso: 2 });
  t.sprites = uploadArray(gl, sprites, 128, { aniso: 1 });
  t.waterNormal = upload2D(gl, waterNormalMap(256), { aniso: 4 });
  t.clouds = upload2D(gl, cloudMap(256));
  t.noise = upload2D(gl, dirtDetail(256), { aniso: 1 });
  t.layers = { terrain: Object.keys(TERRAIN_LAYER), material: Object.keys(MAT), sprite: Object.keys(SPRITE) };
  onStep('Lighting the sky…', 0.92);
  return t;
}

/** Small helper used by the menu & loading screen: a painted sky strip. */
export function paintMenuBackdrop(ctx, w, h, hue = 0) {
  const g = ctx;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#1b2a3a');
  sky.addColorStop(0.42, '#6b5a4a');
  sky.addColorStop(0.62, '#d09a5e');
  sky.addColorStop(0.78, '#7a4f33');
  sky.addColorStop(1, '#241812');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  // sun
  const sun = g.createRadialGradient(w * 0.66, h * 0.55, 0, w * 0.66, h * 0.55, h * 0.5);
  sun.addColorStop(0, 'rgba(255,224,160,0.85)');
  sun.addColorStop(0.2, 'rgba(255,190,110,0.35)');
  sun.addColorStop(1, 'rgba(255,150,60,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  // distant mountains
  for (let layer = 0; layer < 3; layer++) {
    const yBase = h * (0.62 + layer * 0.06);
    const color = ['#3a3a44', '#2d2b31', '#1e1c1e'][layer];
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, yBase);
    for (let x = 0; x <= w; x += w / 24) {
      const n = fbm2(x * 0.006 + layer * 12, layer * 4, 4);
      g.lineTo(x, yBase - n * h * (0.14 - layer * 0.03) - h * 0.02);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  }
  // foreground silhouette
  g.fillStyle = '#0d0b0a';
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 60) {
    const n = fbm2(x * 0.02, 8, 3) * h * 0.03;
    g.lineTo(x, h * 0.92 - n);
  }
  g.lineTo(w, h); g.closePath(); g.fill();
}
