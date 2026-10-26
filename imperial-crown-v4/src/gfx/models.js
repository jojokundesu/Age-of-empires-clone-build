/* ============================================================
   models.js — every visual in the game, generated from code
   Buildings: masonry plinths, half-timbered walls, shingled and
   thatched roofs, chimneys, banners, market stalls, towers.
   Units: an articulated six-part rig (body, two legs, two arms,
   weapon/extra) so the GPU can animate walk cycles per instance.
   ============================================================ */
import { Geo, M, PART } from './geo.js';

const TAU = Math.PI * 2;

/* ============================================================
   shared helpers
   ============================================================ */
function plinth(g, w, d, h = 0.35) {
  g.material(M.STONE).color(0.78, 0.76, 0.72);
  g.box(0, h / 2 - 0.05, 0, w, h, d);
  g.material(M.STONE).color(0.62, 0.6, 0.57);
  g.box(0, h + 0.02, 0, w * 0.97, 0.09, d * 0.97);
  g.color(1, 1, 1);
}

function walls(g, w, d, h, base, mat = M.PLASTER, col = [0.92, 0.9, 0.84], thickness = 0.22) {
  g.material(mat).color(col);
  g.box(0, base + h / 2, -d / 2 + thickness / 2, w, h, thickness);
  g.box(0, base + h / 2, d / 2 - thickness / 2, w, h, thickness);
  g.box(-w / 2 + thickness / 2, base + h / 2, 0, thickness, h, d - thickness * 2);
  g.box(w / 2 - thickness / 2, base + h / 2, 0, thickness, h, d - thickness * 2);
  g.color(1, 1, 1);
  return g;
}

function timberFrame(g, w, d, h, base, color = [0.3, 0.23, 0.17]) {
  g.material(M.WOOD).color(color);
  const t = 0.15;
  // corner posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.box(sx * (w / 2 - 0.08), base + h / 2, sz * (d / 2 - 0.08), 0.2, h, 0.2);
  }
  // sill + top plate
  g.box(0, base + 0.08, 0, w, 0.16, d);
  g.box(0, base + h - 0.08, 0, w, 0.16, d);
  // horizontal bands and diagonal braces on the long faces
  const rows = Math.max(2, Math.round(h / 1.1));
  for (let i = 0; i < rows; i++) {
    const y0 = base + (i / rows) * h;
    if (i > 0) {
      g.box(0, y0, d / 2 - 0.02, w, 0.13, 0.1);
      g.box(0, y0, -d / 2 + 0.02, w, 0.13, 0.1);
      g.box(w / 2 - 0.02, y0, 0, 0.1, 0.13, d);
      g.box(-w / 2 + 0.02, y0, 0, 0.1, 0.13, d);
    }
    const y1 = base + ((i + 1) / rows) * h - 0.12;
    if (i % 2 === 0) {
      g.beam(-w * 0.34, y0 + 0.1, d / 2, w * 0.34, y1, d / 2, 0.13);
      g.beam(w * 0.34, y0 + 0.1, -d / 2, -w * 0.34, y1, -d / 2, 0.13);
    } else {
      g.beam(w * 0.34, y0 + 0.1, d / 2, -w * 0.34, y1, d / 2, 0.13);
      g.beam(-w * 0.34, y0 + 0.1, -d / 2, w * 0.34, y1, -d / 2, 0.13);
    }
  }
  g.color(1, 1, 1);
  return g;
}

function gableRoof(g, w, d, base, h, mat = M.TILE, overhang = 0.45, thickness = 0.16, rotY = 0) {
  const ww = w + overhang * 2, dd = d + overhang * 2;
  g.material(mat).color(1, 1, 1);
  g.gable(0, base, 0, ww, h, dd, { rotY });
  // fascia boards under the eaves
  g.material(M.WOOD).color(0.32, 0.24, 0.18);
  g.box(0, base + 0.03, 0, ww + 0.06, 0.1, dd + 0.06, { rotY });
  // ridge beam
  g.beam(-Math.sin(rotY) * (dd / 2 - 0.1), base + h + 0.03, Math.cos(rotY) * (dd / 2 - 0.1) + 0,
    Math.sin(rotY) * (dd / 2 - 0.1), base + h + 0.03, -Math.cos(rotY) * (dd / 2 - 0.1), 0.16);
  g.color(1, 1, 1);
  return g;
}

function thatchRoof(g, w, d, base, h, overhang = 0.55) {
  const ww = w + overhang * 2, dd = d + overhang * 2;
  g.material(M.THATCH).color(0.86, 0.76, 0.55);
  g.gable(0, base, 0, ww, h, dd);
  g.material(M.THATCH).color(0.62, 0.54, 0.38);
  g.box(0, base + h + 0.08, 0, 0.5, 0.16, dd + 0.1);
  g.color(1, 1, 1);
  return g;
}

function chimney(g, x, z, base, h, w = 0.6) {
  g.material(M.STONE).color(0.68, 0.66, 0.62);
  g.box(x, base + h / 2, z, w, h, w);
  g.material(M.STONE).color(0.54, 0.52, 0.5);
  g.box(x, base + h + 0.07, z, w + 0.16, 0.14, w + 0.16);
  g.color(1, 1, 1);
}

function banner(g, x, y, z, h = 2.2, w = 0.7) {
  g.material(M.WOOD).color(0.35, 0.28, 0.2);
  g.cyl(x, y, z, 0.05, 0.06, h, 6, { capTop: false });
  g.material(M.CLOTH).color(1, 1, 1);
  g.panel(x, y + h * 0.42, z, w, h * 0.5, 0.35);
  g.material(M.GOLD).color(1, 0.92, 0.7);
  g.sphere(x, y + h + 0.06, z, 0.08, 6, 4);
  g.color(1, 1, 1);
}

function barrel(g, x, z, y = 0) {
  g.material(M.WOOD).color(0.62, 0.46, 0.3);
  g.cyl(x, y, z, 0.26, 0.3, 0.62, 8);
  g.material(M.METAL).color(0.5, 0.48, 0.45);
  g.cyl(x, y + 0.12, z, 0.315, 0.315, 0.07, 8, { capTop: false });
  g.cyl(x, y + 0.46, z, 0.315, 0.315, 0.07, 8, { capTop: false });
  g.color(1, 1, 1);
}

function crate(g, x, z, y = 0, s = 0.5) {
  g.material(M.WOOD).color(0.7, 0.55, 0.36);
  g.box(x, y + s / 2, z, s, s, s);
  g.material(M.WOOD).color(0.42, 0.32, 0.22);
  g.box(x, y + s / 2, z, s * 1.02, 0.07, s * 1.02);
  g.color(1, 1, 1);
}

function cart(g, x, z, y = 0, rot = 0) {
  g.material(M.WOOD).color(0.62, 0.46, 0.3);
  g.box(x, y + 0.55, z, 1.5, 0.42, 0.9, { rotY: rot });
  g.material(M.METAL).color(0.4, 0.4, 0.38);
  for (const side of [-1, 1]) {
    const wx = x + Math.cos(rot) * 0 + Math.sin(rot) * (side * 0.55);
    const wz = z + Math.cos(rot) * (side * 0.55);
    g.cyl(wx, y + 0.02, wz, 0.4, 0.4, 0.1, 10, { rot: Math.PI / 2 });
  }
  g.color(1, 1, 1);
}

function ladder(g, x, y, z, h, rot = 0) {
  g.material(M.WOOD).color(0.48, 0.36, 0.24);
  g.beam(x - 0.22, y, z, x - 0.22, y + h, z, 0.08);
  g.beam(x + 0.22, y, z, x + 0.22, y + h, z, 0.08);
  for (let i = 0; i < Math.floor(h / 0.34); i++) {
    g.box(x, y + 0.2 + i * 0.34, z, 0.52, 0.06, 0.07);
  }
  g.color(1, 1, 1);
}

/* ============================================================
   BUILDINGS
   ============================================================ */
const BUILDERS = {};

function B(type, fn) { BUILDERS[type] = fn; }

B('house', () => {
  const g = new Geo();
  const w = 3.6, d = 3.4, wallH = 2.35;
  plinth(g, w + 0.3, d + 0.3, 0.3);
  walls(g, w, d, wallH, 0.3);
  timberFrame(g, w, d, wallH, 0.3);
  gableRoof(g, w, d, 0.3 + wallH, 1.5, M.TILE, 0.42);
  chimney(g, w * 0.28, -d * 0.22, 0.3, wallH + 1.7, 0.55);
  // door
  g.material(M.WOOD).color(0.3, 0.22, 0.16);
  g.box(0, 0.3 + 0.9, d / 2 - 0.02, 0.85, 1.8, 0.12);
  g.material(M.STONE).color(0.8, 0.78, 0.74);
  g.box(0, 0.3 + 1.86, d / 2, 1.05, 0.14, 0.24);
  // windows
  g.window(-1.05, 1.6, d / 2 - 0.03, 0.55, 0.6);
  g.window(1.05, 1.6, d / 2 - 0.03, 0.55, 0.6);
  g.window(w / 2 - 0.03, 1.6, 0.6, 0.55, 0.6, Math.PI / 2);
  barrel(g, -w * 0.75, d * 0.55);
  crate(g, w * 0.78, d * 0.3, 0, 0.48);
  return { geo: g, height: 4.2 };
});

B('town_center', () => {
  const g = new Geo();
  const w = 5.6, d = 5.2, wallH = 3.5;
  plinth(g, w + 0.5, d + 0.5, 0.4);
  walls(g, w, d, wallH, 0.4);
  timberFrame(g, w, d, wallH, 0.4);
  // upper storey overhang
  g.material(M.PLASTER).color(0.95, 0.93, 0.87);
  g.box(0, 0.4 + wallH + 0.9, 0, w + 0.7, 1.8, d + 0.7);
  timberFrame(g, w + 0.7, d + 0.7, 1.8, 0.4 + wallH + 0.02);
  gableRoof(g, w + 0.7, d + 0.7, 0.4 + wallH + 1.8, 2.1, M.TILE, 0.5);
  // corner tower
  g.material(M.STONE).color(0.8, 0.78, 0.74);
  g.taperBox(-w * 0.36, 0.4 + 3.2, -d * 0.36, 1.5, 6.4, 1.5, 1.3, 1.3);
  g.material(M.STONE).color(0.7, 0.68, 0.64);
  g.battlements(-w * 0.36, 0.4 + 6.4, -d * 0.36, 1.55, 1.55, 0.5);
  g.material(M.TILE).color(1, 1, 1);
  g.hip(-w * 0.36, 0.4 + 7.0, -d * 0.36, 2.0, 0.9, 2.0);
  // tower window
  g.window(-w * 0.36, 0.4 + 4.6, -d * 0.36 + 0.78, 0.5, 0.7, 0, true);
  // door
  g.material(M.WOOD).color(0.28, 0.2, 0.14);
  g.box(0, 0.4 + 1.05, d / 2 - 0.02, 1.25, 2.1, 0.14);
  g.material(M.STONE).color(0.84, 0.82, 0.78);
  g.box(0, 0.4 + 2.2, d / 2 + 0.05, 1.5, 0.2, 0.3);
  for (const sx of [-1.6, 1.6]) {
    g.window(sx, 1.8, d / 2 - 0.03, 0.6, 0.72);
    g.window(sx, 0.4 + wallH + 0.9, d / 2 + 0.32, 0.55, 0.6, 0, true);
  }
  banner(g, -w * 0.5 - 0.35, 0.4, d * 0.42, 3.0, 0.8);
  banner(g, w * 0.5 + 0.35, 0.4, d * 0.42, 3.0, 0.8);
  cart(g, w * 0.8, d * 0.7);
  barrel(g, -w * 0.8, d * 0.75);
  barrel(g, -w * 0.8 - 0.5, d * 0.62);
  return { geo: g, height: 8.4 };
});

B('farm', () => {
  const g = new Geo();
  // tilled field with furrows
  g.material(M.DIRT).color(0.46, 0.35, 0.24);
  g.box(0, 0.02, 0, 5.4, 0.06, 5.4);
  g.material(M.DIRT).color(0.32, 0.25, 0.17);
  for (let i = 0; i < 9; i++) {
    g.box(-2.4 + i * 0.6, 0.06, 0, 0.22, 0.1, 5.1);
  }
  g.material(M.LEAF).color(0.55, 0.72, 0.36);
  for (let i = 0; i < 40; i++) {
    const x = -2.3 + (i % 8) * 0.64 + ((i * 7) % 3) * 0.06;
    const z = -2.3 + Math.floor(i / 8) * 0.9;
    g.box(x, 0.16, z, 0.14, 0.22 + ((i * 13) % 5) * 0.03, 0.14);
  }
  // scarecrow
  g.material(M.WOOD).color(0.55, 0.42, 0.28);
  g.cyl(1.9, 0, -1.9, 0.05, 0.06, 1.5, 5, { capTop: false });
  g.beam(1.4, 1.25, -1.9, 2.4, 1.25, -1.9, 0.07);
  g.material(M.CLOTH).color(0.85, 0.8, 0.6);
  g.box(1.9, 1.25, -1.9, 0.4, 0.5, 0.2);
  g.color(1, 1, 1);
  return { geo: g, height: 1.6 };
});

B('mill', () => {
  const g = new Geo();
  const w = 3.2, d = 3.2, wallH = 2.8;
  plinth(g, w + 0.3, d + 0.3, 0.3);
  g.material(M.STONE).color(0.76, 0.74, 0.7);
  g.taperBox(0, 0.3 + wallH / 2, 0, w, wallH, d, w * 0.8, d * 0.8);
  timberFrame(g, w * 0.85, d * 0.85, wallH * 0.8, 0.5);
  g.material(M.THATCH).color(0.84, 0.74, 0.52);
  g.cone(0, 0.3 + wallH, 0, 2.4, 2.2, 10);
  // windmill blades
  g.part_(PART.EXTRA, 0, 2.6, d / 2 + 0.4);
  g.material(M.WOOD).color(0.44, 0.33, 0.22);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    g.box(Math.cos(a) * 1.5, 2.6 + Math.sin(a) * 1.5, d / 2 + 0.45, 0.16, 3.0, 0.1, { rotY: 0 });
  }
  g.material(M.CLOTH).color(0.9, 0.86, 0.74);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    g.panel(Math.cos(a) * 1.9, 2.6 + Math.sin(a) * 1.9, d / 2 + 0.42, 1.1, 2.2, Math.PI / 2);
  }
  g.part_(PART.BODY, 0, 0, 0);
  g.material(M.METAL).color(0.4, 0.38, 0.35);
  g.sphere(0, 2.6, d / 2 + 0.5, 0.16, 6, 4);
  cart(g, 2.4, 1.4);
  g.color(1, 1, 1);
  return { geo: g, height: 5.6, rotor: true };
});

B('lumber_camp', () => {
  const g = new Geo();
  // open shelter
  g.material(M.WOOD).color(0.52, 0.4, 0.27);
  for (const sx of [-1.4, 1.4]) for (const sz of [-1.1, 1.1]) g.cyl(sx, 0, sz, 0.09, 0.11, 2.1, 5, { capTop: false });
  g.material(M.THATCH).color(0.78, 0.68, 0.48);
  g.gable(0, 2.1, 0, 3.6, 0.7, 2.8);
  // log pile
  g.material(M.BARK).color(0.48, 0.36, 0.24);
  for (let i = 0; i < 6; i++) {
    const row = Math.floor(i / 3);
    g.cyl(-1.1 + (i % 3) * 0.5 - 0.75, 0.18 + row * 0.34, 1.7, 0.18, 0.18, 1.5, 7, { axis: 'x' });
  }
  // chopping block + axe
  g.material(M.WOOD).color(0.6, 0.46, 0.3);
  g.cyl(-1.9, 0, -1.6, 0.28, 0.3, 0.45, 8);
  g.material(M.WOOD).color(0.42, 0.3, 0.2);
  g.beam(-1.9, 0.45, -1.6, -1.75, 0.95, -1.5, 0.06);
  g.material(M.METAL).color(0.62, 0.62, 0.6);
  g.box(-1.72, 0.98, -1.48, 0.26, 0.2, 0.06);
  g.color(1, 1, 1);
  return { geo: g, height: 2.9 };
});

B('mining_camp', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  for (const sx of [-1.3, 1.3]) for (const sz of [-1, 1]) g.cyl(sx, 0, sz, 0.09, 0.11, 1.9, 5, { capTop: false });
  g.material(M.WOOD).color(0.56, 0.43, 0.3);
  g.gable(0, 1.9, 0, 3.3, 0.6, 2.6);
  // ore cart on rails
  g.material(M.METAL).color(0.45, 0.43, 0.4);
  g.box(0, 0.05, 1.9, 0.12, 0.08, 2.4);
  g.box(0.7, 0.05, 1.9, 0.12, 0.08, 2.4);
  g.material(M.WOOD).color(0.4, 0.31, 0.22);
  g.box(0.35, 0.45, 1.2, 1.0, 0.7, 0.8);
  g.material(M.GOLD).color(0.95, 0.78, 0.34);
  g.box(0.35, 0.84, 1.2, 0.85, 0.12, 0.65);
  g.material(M.STONE).color(0.6, 0.6, 0.62);
  g.sphere(1.3, 0.3, -1.2, 0.4, 6, 4);
  g.sphere(1.7, 0.2, -0.9, 0.28, 6, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 2.7 };
});

B('barracks', () => {
  const g = new Geo();
  const w = 5.4, d = 4.2, wallH = 3.0;
  plinth(g, w + 0.4, d + 0.4, 0.35);
  walls(g, w, d, wallH, 0.35, M.STONE, [0.72, 0.7, 0.67]);
  // stone quoins
  g.material(M.STONE).color(0.86, 0.84, 0.8);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    for (let i = 0; i < 6; i++) g.box(sx * (w / 2 - 0.12), 0.5 + i * 0.5, sz * (d / 2 - 0.12), 0.42, 0.38, 0.42);
  }
  gableRoof(g, w, d, 0.35 + wallH, 1.7, M.TILE, 0.5);
  // training yard fence
  g.material(M.WOOD).color(0.45, 0.34, 0.23);
  for (let i = 0; i < 7; i++) g.cyl(-w / 2 - 0.6 + i * 0.55, 0, d / 2 + 1.4, 0.05, 0.06, 0.9, 4, { capTop: false });
  g.beam(-w / 2 - 0.6, 0.75, d / 2 + 1.4, w / 2 + 0.6, 0.75, d / 2 + 1.4, 0.07);
  // weapon rack
  g.beam(-1.8, 0.1, d / 2 + 0.9, 1.8, 0.1, d / 2 + 0.9, 0.1);
  g.material(M.METAL).color(0.7, 0.7, 0.68);
  for (let i = 0; i < 5; i++) {
    g.beam(-1.5 + i * 0.7, 0.15, d / 2 + 0.9, -1.42 + i * 0.7, 1.5, d / 2 + 0.9, 0.05);
  }
  g.material(M.WOOD).color(0.32, 0.24, 0.17);
  g.box(0, 1.35, d / 2 - 0.02, 1.3, 2.2, 0.14);
  banner(g, -w / 2 - 0.4, 0, d / 2 - 0.3, 3.2, 0.8);
  banner(g, w / 2 + 0.4, 0, d / 2 - 0.3, 3.2, 0.8);
  return { geo: g, height: 5.2 };
});

B('archery_range', () => {
  const g = new Geo();
  const w = 5.0, d = 4.0, wallH = 2.7;
  plinth(g, w + 0.4, d + 0.4, 0.3);
  walls(g, w, d, wallH, 0.3, M.WOOD, [0.62, 0.5, 0.36]);
  timberFrame(g, w, d, wallH, 0.3, [0.36, 0.27, 0.19]);
  thatchRoof(g, w, d, 0.3 + wallH, 1.3);
  // archery targets
  g.material(M.WOOD).color(0.55, 0.42, 0.28);
  for (let i = 0; i < 3; i++) {
    const x = -1.8 + i * 1.8;
    g.beam(x - 0.3, 0, d / 2 + 2.2, x, 1.3, d / 2 + 2.2, 0.08);
    g.beam(x + 0.3, 0, d / 2 + 2.2, x, 1.3, d / 2 + 2.2, 0.08);
    g.material(M.THATCH).color(0.88, 0.8, 0.62);
    g.cyl(x, 0.85, d / 2 + 2.2, 0.55, 0.55, 0.12, 12, { rot: Math.PI / 2 });
    g.material(M.CLOTH).color(0.8, 0.25, 0.2);
    g.disc(x, 0.9, d / 2 + 2.3, 0.24, 10);
    g.material(M.WOOD).color(0.55, 0.42, 0.28);
  }
  banner(g, w / 2 + 0.5, 0, d / 2, 2.6, 0.7);
  return { geo: g, height: 4.6 };
});

B('stable', () => {
  const g = new Geo();
  const w = 5.4, d = 4.4, wallH = 2.6;
  plinth(g, w + 0.4, d + 0.4, 0.3);
  walls(g, w, d, wallH, 0.3, M.WOOD, [0.6, 0.48, 0.34]);
  timberFrame(g, w, d, wallH, 0.3);
  gableRoof(g, w, d, 0.3 + wallH, 1.5, M.THATCH, 0.6);
  // open stalls at the front
  g.material(M.WOOD).color(0.38, 0.29, 0.2);
  for (let i = 0; i < 4; i++) g.cyl(-2.0 + i * 1.35, 0, d / 2 + 0.9, 0.07, 0.09, 2.2, 4, { capTop: false });
  g.material(M.THATCH).color(0.72, 0.63, 0.44);
  g.gable(0, 2.2, d / 2 + 0.9, 4.6, 0.5, 1.8);
  // hay bales
  g.material(M.THATCH).color(0.9, 0.8, 0.48);
  g.cyl(-2.4, 0.5, -1.2, 0.5, 0.5, 0.9, 8, { axis: 'z' });
  g.cyl(2.3, 0.5, -1.5, 0.5, 0.5, 0.9, 8, { axis: 'z' });
  g.color(1, 1, 1);
  return { geo: g, height: 4.4 };
});

B('blacksmith', () => {
  const g = new Geo();
  const w = 4.6, d = 3.8, wallH = 2.8;
  plinth(g, w + 0.3, d + 0.3, 0.3);
  walls(g, w, d, wallH, 0.3, M.STONE, [0.62, 0.58, 0.54]);
  timberFrame(g, w, d, wallH, 0.3);
  gableRoof(g, w, d, 0.3 + wallH, 1.4, M.TILE, 0.45);
  chimney(g, -w * 0.3, -d * 0.2, 0.3, wallH + 2.4, 0.9);
  // forge glow
  g.material(M.GLOW).color(1, 0.55, 0.2);
  g.box(1.2, 0.95, d / 2 + 0.6, 0.8, 0.5, 0.8);
  g.material(M.STONE).color(0.4, 0.38, 0.36);
  g.box(1.2, 0.6, d / 2 + 0.6, 1.0, 0.6, 1.0);
  // anvil
  g.material(M.METAL).color(0.28, 0.28, 0.3);
  g.box(1.9, 0.42, d / 2 + 0.2, 0.3, 0.32, 0.7);
  g.box(1.9, 0.6, d / 2 + 0.2, 0.5, 0.14, 0.55);
  g.color(1, 1, 1);
  return { geo: g, height: 4.6 };
});

B('market', () => {
  const g = new Geo();
  // three striped stalls
  for (let i = 0; i < 3; i++) {
    const x = -1.9 + i * 1.9;
    g.material(M.WOOD).color(0.5, 0.38, 0.26);
    for (const sz of [-0.9, 0.9]) g.cyl(x - 0.9, 0, sz, 0.05, 0.06, 2.0, 4, { capTop: false });
    for (const sz of [-0.9, 0.9]) g.cyl(x + 0.9, 0, sz, 0.05, 0.06, 2.0, 4, { capTop: false });
    g.material(i === 0 ? M.CLOTH : i === 1 ? M.THATCH : M.CLOTH).color(i === 0 ? [0.75, 0.3, 0.28] : i === 1 ? [0.9, 0.82, 0.6] : [0.4, 0.5, 0.75]);
    g.panel(x, 1.75, 0, 2.2, 0.6, 0);
    g.gable(x, 2.05, 0, 2.2, 0.35, 2.0);
    g.material(M.WOOD).color(0.6, 0.46, 0.3);
    g.box(x, 0.85, 0, 1.7, 0.12, 1.0);
    // goods
    g.material(M.LEAF).color(0.6, 0.75, 0.35);
    g.sphere(x - 0.35, 1.0, 0.1, 0.16, 5, 3);
    g.material(M.GOLD).color(0.95, 0.8, 0.35);
    g.sphere(x + 0.3, 1.0, -0.1, 0.14, 5, 3);
  }
  g.material(M.DIRT).color(0.5, 0.42, 0.32);
  g.box(0, 0.02, 0, 6.2, 0.05, 4.2);
  crate(g, -2.4, 1.5, 0, 0.5);
  barrel(g, 2.5, 1.4);
  return { geo: g, height: 2.8 };
});

B('university', () => {
  const g = new Geo();
  const w = 5.2, d = 4.6, wallH = 3.4;
  plinth(g, w + 0.5, d + 0.5, 0.4);
  walls(g, w, d, wallH, 0.4, M.MARBLE, [0.92, 0.9, 0.86]);
  // columns along the front
  g.material(M.MARBLE).color(0.96, 0.95, 0.92);
  for (let i = 0; i < 4; i++) {
    g.cyl(-1.8 + i * 1.2, 0.4, d / 2 + 0.55, 0.16, 0.18, 2.6, 8, { capTop: false });
  }
  g.box(0, 0.42, d / 2 + 0.55, 4.2, 0.18, 0.5);
  g.box(0, 3.0, d / 2 + 0.55, 4.2, 0.18, 0.5);
  gableRoof(g, w, d, 0.4 + wallH, 1.5, M.TILE, 0.5);
  // pediment
  g.material(M.MARBLE).color(0.98, 0.97, 0.94);
  g.gable(0, 3.1, d / 2 + 0.5, 4.4, 0.9, 0.3);
  g.material(M.GLOW).color(1, 0.85, 0.55);
  g.window(0, 1.4, d / 2 - 0.04, 0.9, 1.3, 0, true);
  for (const sx of [-1.6, 1.6]) g.window(sx, 1.7, d / 2 - 0.04, 0.55, 0.8, 0, true);
  // astronomy dome
  g.material(M.METAL).color(0.55, 0.6, 0.55);
  g.sphere(w * 0.3, 0.4 + wallH + 1.4, -d * 0.2, 0.7, 8, 5);
  g.material(M.GOLD).color(1, 0.9, 0.6);
  g.beam(w * 0.3 - 0.8, 0.4 + wallH + 1.4, -d * 0.2, w * 0.3 + 0.8, 0.4 + wallH + 1.4, -d * 0.2, 0.05);
  g.color(1, 1, 1);
  return { geo: g, height: 6.6 };
});

B('monastery', () => {
  const g = new Geo();
  const w = 4.8, d = 4.2, wallH = 3.2;
  plinth(g, w + 0.4, d + 0.4, 0.35);
  walls(g, w, d, wallH, 0.35, M.STONE, [0.86, 0.84, 0.78]);
  timberFrame(g, w, d, wallH, 0.35, [0.4, 0.32, 0.24]);
  gableRoof(g, w, d, 0.35 + wallH, 1.6, M.TILE, 0.5);
  // bell tower
  g.material(M.STONE).color(0.9, 0.88, 0.82);
  g.taperBox(-w * 0.34, 0.35 + 3.6, -d * 0.3, 1.4, 7.2, 1.4, 1.2, 1.2);
  g.material(M.TILE).color(1, 1, 1);
  g.cone(-w * 0.34, 0.35 + 7.2, -d * 0.3, 1.0, 1.6, 8);
  g.material(M.METAL).color(0.55, 0.5, 0.32);
  g.sphere(-w * 0.34, 0.35 + 7.0, -d * 0.3 - 0.75, 0.22, 6, 4);
  g.material(M.GOLD).color(1, 0.92, 0.6);
  g.beam(-w * 0.34, 0.35 + 8.8, -d * 0.3, -w * 0.34, 0.35 + 9.5, -d * 0.3, 0.08);
  g.beam(-w * 0.34 - 0.3, 0.35 + 9.1, -d * 0.3, -w * 0.34 + 0.3, 0.35 + 9.1, -d * 0.3, 0.08);
  // arched door
  g.material(M.WOOD).color(0.32, 0.24, 0.17);
  g.box(0, 0.35 + 1.1, d / 2 - 0.02, 1.1, 2.2, 0.14);
  g.material(M.STONE).color(0.92, 0.9, 0.85);
  g.cyl(0, 0.35 + 2.2, d / 2, 0.55, 0.55, 0.14, 10, { rot: 0 });
  g.window(1.4, 1.9, d / 2 - 0.03, 0.45, 0.7, 0, true);
  g.window(-1.4, 1.9, d / 2 - 0.03, 0.45, 0.7, 0, true);
  // graveyard
  for (let i = 0; i < 4; i++) {
    g.material(M.STONE).color(0.72, 0.72, 0.7);
    g.box(w / 2 + 1.0 + (i % 2) * 0.8, 0.25, -1.0 + i * 0.9, 0.4, 0.5, 0.1);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 6.4 };
});

B('watch_tower', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.8, 0.78, 0.73);
  g.taperBox(0, 2.6, 0, 2.0, 5.2, 2.0, 1.7, 1.7);
  g.material(M.STONE).color(0.66, 0.64, 0.6);
  for (let i = 0; i < 4; i++) g.box(0, 0.4 + i * 1.2, 0, 2.05, 0.12, 2.05);
  g.material(M.STONE).color(0.86, 0.84, 0.8);
  g.battlements(0, 5.2, 0, 2.0, 2.0, 0.7);
  g.material(M.WOOD).color(0.42, 0.32, 0.22);
  g.box(0, 5.4, 0, 1.6, 0.14, 1.6);
  // torch
  g.material(M.GLOW).color(1, 0.6, 0.25);
  g.sphere(0.5, 6.1, 0.5, 0.14, 6, 4);
  banner(g, -1.2, 5.2, 0, 1.6, 0.6);
  g.color(1, 1, 1);
  return { geo: g, height: 6.6 };
});

B('stone_wall', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.78, 0.76, 0.72);
  g.box(0, 0.9, 0, 2.0, 1.8, 0.9);
  g.material(M.STONE).color(0.86, 0.84, 0.8);
  g.battlements(0, 1.8, 0, 2.0, 0.9, 0.5);
  g.material(M.STONE).color(0.62, 0.6, 0.57);
  g.box(0, 0.06, 0, 2.1, 0.16, 1.0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.4 };
});

B('palissade_wall', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.52, 0.4, 0.28);
  for (let i = 0; i < 5; i++) {
    const x = -0.8 + i * 0.4;
    g.cyl(x, 0, 0, 0.07, 0.11, 1.9 + ((i * 7) % 3) * 0.1, 6, { capTop: false });
    g.cone(x, 1.9 + ((i * 7) % 3) * 0.1, 0, 0.11, 0.22, 6);
  }
  g.beam(-0.95, 1.1, 0, 0.95, 1.1, 0, 0.12);
  g.beam(-0.95, 0.5, 0, 0.95, 0.5, 0, 0.12);
  g.color(1, 1, 1);
  return { geo: g, height: 2.2 };
});

/* The gate's timber leaf is a *separate* mesh (buildGateDoor) so it can be
   animated: it drops into the ground when the gate opens for friendly troops
   and rises again when they have passed. Baking it into the gate meant the
   doors were permanently shut while the gate claimed to let allies through. */
B('stone_gate', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.8, 0.78, 0.74);
  for (const sx of [-1, 1]) {
    g.box(sx * 1.1, 1.4, 0, 0.7, 2.8, 1.0);
    g.box(sx * 1.1, 2.95, 0, 0.9, 0.3, 1.2);
  }
  g.box(0, 3.2, 0, 3.0, 0.5, 1.0);
  g.material(M.STONE).color(0.88, 0.86, 0.82);
  g.battlements(0, 3.45, 0, 3.0, 1.0, 0.45);
  /* the slot the leaf slides in and out of */
  g.material(M.METAL).color(0.34, 0.32, 0.3);
  g.box(0, 0.08, 0.4, 2.1, 0.14, 0.24);
  g.color(1, 1, 1);
  return { geo: g, height: 4.2 };
});

/** The gate leaf: a studded timber door, 2 m wide, that the renderer slides. */
export function buildGateDoor() {
  const g = new Geo();
  g.material(M.WOOD).color(0.4, 0.3, 0.2);
  g.box(0, 1.1, 0, 2.0, 2.2, 0.12);
  g.material(M.METAL).color(0.5, 0.48, 0.44);
  for (let i = 0; i < 5; i++) g.box(-0.8 + i * 0.4, 1.1, 0.07, 0.06, 2.1, 0.05);
  for (const y of [0.55, 1.65]) g.box(0, y, 0.07, 1.9, 0.09, 0.06);
  g.color(1, 1, 1);
  return g.finish();
}

B('castle', () => {
  const g = new Geo();
  const w = 7.0, d = 6.6, wallH = 4.6;
  plinth(g, w + 0.6, d + 0.6, 0.5);
  walls(g, w, d, wallH, 0.5, M.STONE, [0.74, 0.72, 0.68], 0.5);
  g.material(M.STONE).color(0.84, 0.82, 0.78);
  // corner towers
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tx = sx * (w / 2 - 0.2), tz = sz * (d / 2 - 0.2);
    g.material(M.STONE).color(0.8, 0.78, 0.74);
    g.cyl(tx, 0.5, tz, 1.05, 1.2, wallH + 2.4, 10, { capTop: false });
    g.material(M.STONE).color(0.88, 0.86, 0.82);
    g.cyl(tx, 0.5 + wallH + 2.4, tz, 1.25, 1.05, 0.3, 10, { capTop: false });
    // crenellations
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      if (i % 2 === 0) continue;
      g.box(tx + Math.cos(a) * 1.05, 0.5 + wallH + 2.85, tz + Math.sin(a) * 1.05, 0.42, 0.5, 0.42);
    }
    g.material(M.TILE).color(1, 1, 1);
    g.cone(tx, 0.5 + wallH + 2.9, tz, 1.2, 1.9, 10);
  }
  // battlements on the walls
  g.battlements(0, 0.5 + wallH, 0, w, d, 0.75, 0.6, 0.5);
  // keep
  g.material(M.STONE).color(0.82, 0.8, 0.76);
  g.taperBox(0, 0.5 + wallH + 2.2, -d * 0.1, 3.2, 4.4, 3.0, 2.6, 2.4);
  g.material(M.STONE).color(0.9, 0.88, 0.84);
  g.battlements(0, 0.5 + wallH + 4.4, -d * 0.1, 2.8, 2.6, 0.6);
  g.material(M.TILE).color(1, 1, 1);
  g.hip(0, 0.5 + wallH + 5.0, -d * 0.1, 3.2, 1.8, 3.0);
  // gatehouse
  g.material(M.STONE).color(0.76, 0.74, 0.7);
  g.box(0, 0.5 + 2.2, d / 2 + 0.35, 2.6, 4.4, 1.2);
  g.material(M.WOOD).color(0.34, 0.25, 0.17);
  g.box(0, 0.5 + 1.4, d / 2 + 0.95, 1.6, 2.8, 0.14);
  g.material(M.METAL).color(0.5, 0.48, 0.44);
  for (let i = 0; i < 4; i++) g.box(-0.6 + i * 0.4, 1.9, d / 2 + 1.02, 0.06, 2.7, 0.05);
  banner(g, -w * 0.42, 0.5 + wallH + 0.4, d / 2 + 0.3, 2.6, 0.9);
  banner(g, w * 0.42, 0.5 + wallH + 0.4, d / 2 + 0.3, 2.6, 0.9);
  // braziers
  for (const sx of [-2.2, 2.2]) {
    g.material(M.METAL).color(0.35, 0.33, 0.3);
    g.cyl(sx, 0.5, d / 2 + 1.6, 0.2, 0.24, 0.7, 6);
    g.material(M.GLOW).color(1, 0.6, 0.22);
    g.sphere(sx, 1.35, d / 2 + 1.6, 0.22, 6, 4);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 13.5 };
});

B('siege_workshop', () => {
  const g = new Geo();
  const w = 5.6, d = 4.6, wallH = 3.2;
  plinth(g, w + 0.4, d + 0.4, 0.35);
  walls(g, w, d, wallH, 0.35, M.WOOD, [0.55, 0.44, 0.32]);
  timberFrame(g, w, d, wallH, 0.35);
  gableRoof(g, w, d, 0.35 + wallH, 1.6, M.TILE, 0.55);
  // big doors
  g.material(M.WOOD).color(0.28, 0.2, 0.14);
  g.box(0, 0.35 + 1.5, d / 2 - 0.02, 2.6, 3.0, 0.14);
  g.material(M.METAL).color(0.5, 0.48, 0.44);
  for (let i = 0; i < 6; i++) g.box(-1.1 + i * 0.45, 1.85, d / 2 + 0.02, 0.05, 2.9, 0.05);
  // timber stock
  g.material(M.BARK).color(0.5, 0.38, 0.26);
  for (let i = 0; i < 4; i++) g.cyl(-w / 2 - 3.3, 0.22 + (i % 2) * 0.36, -1.2 + Math.floor(i / 2) * 0.5, 0.18, 0.18, 2.4, 6, { axis: 'x' });
  // wheels leaning
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  g.cyl(w / 2 + 0.8, 0.85, 0.52, 0.85, 0.85, 0.16, 10, { axis: 'z' });
  return { geo: g, height: 4.9 };
});

B('dock', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.55, 0.42, 0.28);
  g.box(0, 0.35, 0, 5.0, 0.24, 3.4);
  for (let i = 0; i < 8; i++) g.box(-2.4 + i * 0.68, 0.24, 0, 0.3, 0.26, 3.5);
  // piles
  for (const sx of [-2.2, 0, 2.2]) for (const sz of [-1.5, 1.5]) {
    g.cyl(sx, -1.6, sz, 0.14, 0.16, 2.1, 6, { capTop: false });
  }
  // crane
  g.material(M.WOOD).color(0.45, 0.34, 0.23);
  g.beam(-1.6, 0.5, -1.0, -1.6, 3.6, -1.0, 0.18);
  g.beam(-1.6, 3.5, -1.0, 0.4, 3.9, 0.6, 0.16);
  g.beam(-1.6, 3.0, -1.0, -0.6, 3.7, -0.2, 0.1);
  g.material(M.LEATHER).color(0.35, 0.3, 0.24);
  g.beam(0.4, 3.9, 0.6, 0.4, 1.8, 0.6, 0.05);
  crate(g, 0.4, 0.6, 0.5, 0.5);
  g.material(M.WOOD).color(0.6, 0.46, 0.3);
  g.cyl(-2.6, 0.45, 1.2, 0.28, 0.32, 0.6, 8);
  g.color(1, 1, 1);
  return { geo: g, height: 4.2 };
});

B('wonder', () => {
  const g = new Geo();
  // stepped ziggurat with a temple crown
  g.material(M.MARBLE).color(0.94, 0.92, 0.86);
  for (let i = 0; i < 4; i++) {
    const s = 7.6 - i * 1.5;
    g.box(0, 0.7 + i * 1.3, 0, s, 1.3, s);
    g.material(M.STONE).color(0.86, 0.84, 0.8);
    g.box(0, 1.35 + i * 1.3, 0, s + 0.2, 0.12, s + 0.2);
    g.material(M.MARBLE).color(0.94, 0.92, 0.86);
  }
  // grand stair
  g.material(M.MARBLE).color(0.98, 0.96, 0.92);
  for (let i = 0; i < 8; i++) g.box(0, 0.16 + i * 0.45, 3.8 - i * 0.42, 2.0, 0.45, 0.5);
  // temple
  g.material(M.MARBLE).color(0.96, 0.95, 0.9);
  g.box(0, 6.0, 0, 3.6, 2.0, 3.6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    g.cyl(Math.cos(a) * 2.2, 5.2, Math.sin(a) * 2.2, 0.2, 0.22, 3.0, 8, { capTop: false });
  }
  g.box(0, 8.2, 0, 5.2, 0.3, 5.2);
  g.material(M.TILE).color(1, 1, 1);
  g.hip(0, 8.35, 0, 5.6, 2.2, 5.6);
  // gilding
  g.material(M.GOLD).color(1, 0.9, 0.55);
  g.cyl(0, 10.4, 0, 0.3, 0.4, 1.4, 8);
  g.sphere(0, 12.0, 0, 0.45, 8, 5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    g.beam(Math.cos(a) * 4.8, 8.4, Math.sin(a) * 4.8, Math.cos(a) * 4.8, 10.2, Math.sin(a) * 4.8, 0.08);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 13.0 };
});

B('outpost_shrine', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.8, 0.78, 0.74);
  g.box(0, 0.15, 0, 2.2, 0.3, 2.2);
  for (const sx of [-0.8, 0.8]) for (const sz of [-0.8, 0.8]) {
    g.cyl(sx, 0.3, sz, 0.14, 0.16, 1.8, 7, { capTop: false });
  }
  g.material(M.STONE).color(0.88, 0.86, 0.82);
  g.box(0, 2.2, 0, 2.2, 0.24, 2.2);
  g.gable(0, 2.44, 0, 2.4, 0.7, 2.4);
  g.material(M.GLOW).color(1, 0.7, 0.3);
  g.sphere(0, 1.0, 0, 0.26, 7, 5);
  g.material(M.STONE).color(0.7, 0.68, 0.64);
  g.cyl(0, 0.3, 0, 0.3, 0.4, 0.6, 8);
  g.color(1, 1, 1);
  return { geo: g, height: 3.2 };
});

/* ============================================================
   UNIT RIG
   ============================================================ */
const humanBase = (g, o) => {
  // legs (pivot at the hip, y = 0.92)
  for (const [part, sx] of [[PART.LEG_L, -1], [PART.LEG_R, 1]]) {
    g.part_(part, sx * 0.13, 0.92, 0);
    g.material(o.legMat || M.CLOTH).color(o.legCol || [0.32, 0.29, 0.26]);
    g.box(sx * 0.13, 0.46, 0, 0.19, 0.92, 0.2);
    g.material(M.LEATHER).color(0.24, 0.19, 0.15);
    g.box(sx * 0.13, 0.08, 0.03, 0.22, 0.16, 0.3);
  }
  // body
  g.part_(PART.BODY, 0, 1.25, 0);
  g.material(o.torsoMat || M.CLOTH).color(o.torsoCol || [0.5, 0.45, 0.4]);
  g.taperBox(0, 1.22, 0, 0.46, 0.66, 0.28, 0.5, 0.3);
  g.material(M.LEATHER).color(0.3, 0.24, 0.18);
  g.box(0, 0.95, 0, 0.48, 0.12, 0.3);
  // head + helmet
  g.material(M.SKIN).color(o.skin || [0.86, 0.7, 0.56]);
  g.sphere(0, 1.66, 0.01, 0.16, 7, 5);
  if (o.helmet !== false) {
    g.material(o.helmetMat || M.METAL).color(o.helmetCol || [0.62, 0.62, 0.6]);
    g.sphere(0, 1.7, 0, 0.175, 7, 4);
    g.box(0, 1.62, 0.15, 0.22, 0.16, 0.06);
    if (o.crest) {
      g.material(M.CLOTH).color(o.crestCol || [0.75, 0.2, 0.2]);
      g.box(0, 1.86, 0, 0.06, 0.16, 0.3);
    }
  }
  // shoulders
  g.material(o.torsoMat || M.CLOTH).color(o.torsoCol || [0.5, 0.45, 0.4]);
  g.box(-0.29, 1.45, 0, 0.14, 0.2, 0.26);
  g.box(0.29, 1.45, 0, 0.14, 0.2, 0.26);
  // arms
  for (const [part, sx] of [[PART.ARM_L, -1], [PART.ARM_R, 1]]) {
    g.part_(part, sx * 0.29, 1.45, 0);
    g.material(o.sleeveMat || M.CLOTH).color(o.sleeveCol || o.torsoCol || [0.5, 0.45, 0.4]);
    g.box(sx * 0.03, -0.24, 0, 0.15, 0.5, 0.16);
    g.material(M.SKIN).color(o.skin || [0.86, 0.7, 0.56]);
    g.box(sx * 0.03, -0.54, 0, 0.13, 0.13, 0.14);
  }
  g.color(1, 1, 1);
};

const sword = (g, dx, dy, dz, len = 0.85, rot = 0) => {
  g.material(M.METAL).color(0.78, 0.79, 0.82);
  g.beam(dx, dy, dz, dx + Math.sin(rot) * len, dy + Math.cos(rot) * len, dz, 0.055);
  g.material(M.GOLD).color(0.8, 0.68, 0.3);
  g.box(dx, dy + 0.02, dz, 0.22, 0.05, 0.08, { rotY: rot });
};

const spear = (g, dx, dy, dz, len = 2.0, tilt = 0.25) => {
  g.material(M.WOOD).color(0.55, 0.42, 0.28);
  g.beam(dx, dy - 0.4, dz, dx + Math.sin(tilt) * len, dy - 0.4 + Math.cos(tilt) * len, dz, 0.055);
  g.material(M.METAL).color(0.8, 0.8, 0.84);
  g.cone(dx + Math.sin(tilt) * (len + 0.1), dy - 0.4 + Math.cos(tilt) * (len + 0.1), dz, 0.06, 0.26, 5);
};

const bow = (g, dx, dy, dz) => {
  g.material(M.WOOD).color(0.45, 0.32, 0.2);
  for (let i = 0; i < 5; i++) {
    const a = -1.1 + i * 0.55;
    g.box(dx + Math.cos(a) * 0.03, dy + Math.sin(a) * 0.34, dz - Math.cos(a) * 0.12, 0.05, 0.16, 0.05);
  }
  g.material(M.CLOTH).color(0.8, 0.78, 0.7);
  g.beam(dx, dy + 0.33, dz - 0.12, dx, dy - 0.33, dz - 0.12, 0.012);
};

const shield = (g, dx, dy, dz, r = 0.3, col = [0.6, 0.25, 0.2]) => {
  g.material(M.WOOD).color(0.46, 0.34, 0.22);
  g.cyl(dx, dy, dz - 0.035, r, r, 0.07, 10, { axis: 'z' });
  g.material(M.CLOTH).color(col);
  g.cyl(dx, dy, dz + 0.02, r * 0.92, r * 0.92, 0.03, 10, { axis: 'z' });
  g.material(M.METAL).color(0.7, 0.7, 0.72);
  g.sphere(dx, dy, dz + 0.09, 0.07, 5, 3);
};

const cape = (g, col) => {
  g.part_(PART.EXTRA, 0, 1.45, -0.16);
  g.material(M.CLOTH).color(col);
  g.panel(0, 0.5, -0.02, 0.5, 0.95, 0);
  g.color(1, 1, 1);
};

const humanoid = (o = {}) => {
  const g = new Geo();
  humanBase(g, o);
  return g;
};

const UNITS = {};
const U = (type, fn) => { UNITS[type] = fn; };

U('villager', () => {
  // peasants wear undyed linen and leather — the only team colour is a sash
  const g = humanoid({ torsoCol: [0.62, 0.55, 0.42], torsoMat: M.LEATHER, legCol: [0.34, 0.3, 0.24], helmet: false });
  g.part_(PART.BODY, 0, 1.25, 0);
  g.material(M.CLOTH).color(1, 1, 1);
  g.panel(0, 1.34, 0.152, 0.5, 0.16, 0);
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  g.beam(0.03, -0.5, 0.05, 0.08, 0.5, 0.4, 0.05);      // hoe handle
  g.material(M.METAL).color(0.6, 0.6, 0.62);
  g.box(0.1, 0.52, 0.45, 0.18, 0.1, 0.24);
  g.color(1, 1, 1);
  return { geo: g, height: 1.85, stride: 3.1 };
});

U('spearman', () => {
  const g = humanoid({ torsoCol: [0.45, 0.5, 0.6], legCol: [0.3, 0.3, 0.34], crest: true, crestCol: [0.7, 0.3, 0.2] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  spear(g, 0.03, 0, 0.1, 2.1, 0.22);
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(g, 0.03, -0.15, 0.2, 0.3, [0.55, 0.3, 0.22]);
  g.color(1, 1, 1);
  return { geo: g, height: 1.95, stride: 2.95 };
});

U('swordsman', () => {
  const g = humanoid({ torsoCol: [0.5, 0.52, 0.58], torsoMat: M.METAL, helmetCol: [0.66, 0.68, 0.7], crest: true, crestCol: [0.2, 0.35, 0.7] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  sword(g, 0.03, -0.2, 0.15, 0.9, 0.3);
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(g, 0.03, -0.12, 0.24, 0.34, [0.35, 0.45, 0.7]);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 2.9 };
});

U('archer', () => {
  const g = humanoid({ torsoCol: [0.4, 0.48, 0.35], legCol: [0.3, 0.33, 0.26], helmet: false, torsoMat: M.LEATHER });
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  bow(g, 0.0, -0.2, 0.2);
  g.part_(PART.EXTRA, 0, 1.3, -0.2);
  g.material(M.LEATHER).color(0.45, 0.34, 0.22);
  g.box(0, 0.2, -0.02, 0.18, 0.5, 0.14);   // quiver
  g.material(M.CLOTH).color(0.9, 0.88, 0.8);
  for (let i = 0; i < 3; i++) g.beam(-0.05 + i * 0.05, 0.45, -0.02, -0.08 + i * 0.05, 0.75, -0.02, 0.02);
  g.color(1, 1, 1);
  return { geo: g, height: 1.85, stride: 2.85 };
});

U('skirmisher', () => {
  const g = humanoid({ torsoCol: [0.55, 0.45, 0.3], legCol: [0.32, 0.28, 0.22], helmet: false, torsoMat: M.LEATHER });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.5, 0.38, 0.25);
  g.beam(0.03, -0.3, 0.05, 0.1, 0.7, 0.15, 0.05);
  g.material(M.METAL).color(0.7, 0.7, 0.72);
  g.cone(0.11, 0.7, 0.15, 0.05, 0.18, 5);
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(g, 0.03, -0.12, 0.22, 0.28, [0.55, 0.45, 0.28]);
  g.color(1, 1, 1);
  return { geo: g, height: 1.85, stride: 2.9 };
});

U('knight', () => horse(g => {
  const gg = humanoid({
    torsoCol: [0.55, 0.56, 0.62], torsoMat: M.METAL, legCol: [0.3, 0.3, 0.34],
    crest: true, crestCol: [0.7, 0.25, 0.2], helmetCol: [0.72, 0.74, 0.76]
  });
  gg.part_(PART.ARM_R, 0.29, 1.45, 0);
  sword(gg, 0.03, -0.2, 0.1, 1.0, 0.2);
  gg.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(gg, 0.03, -0.1, 0.24, 0.36, [0.5, 0.25, 0.22]);
  return gg;
}, { col: [0.4, 0.34, 0.3] }));

U('scout_cavalry', () => horse(g => {
  const gg = humanoid({ torsoCol: [0.45, 0.42, 0.35], legCol: [0.3, 0.28, 0.24], helmet: false });
  gg.part_(PART.ARM_R, 0.29, 1.45, 0);
  gg.material(M.WOOD).color(0.5, 0.38, 0.26);
  gg.beam(0.03, -0.3, 0.05, 0.1, 0.9, 0.2, 0.05);
  return gg;
}, { col: [0.55, 0.45, 0.34], mane: [0.3, 0.24, 0.18] }));

U('cataphract', () => horse(g => {
  const gg = humanoid({ torsoCol: [0.6, 0.52, 0.3], torsoMat: M.METAL, legCol: [0.3, 0.28, 0.3], helmetCol: [0.85, 0.75, 0.4], crest: true, crestCol: [0.8, 0.7, 0.3] });
  gg.part_(PART.ARM_R, 0.29, 1.45, 0);
  spear(gg, 0.03, 0, 0.12, 2.3, 0.15);
  gg.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(gg, 0.03, -0.12, 0.24, 0.36, [0.75, 0.6, 0.25]);
  return gg;
}, { col: [0.42, 0.38, 0.3], armored: true }));

U('mangudai', () => horse(g => {
  const gg = humanoid({ torsoCol: [0.5, 0.34, 0.28], legCol: [0.3, 0.26, 0.22], helmetCol: [0.55, 0.45, 0.35], torsoMat: M.LEATHER });
  gg.part_(PART.ARM_R, 0.29, 1.45, 0);
  bow(gg, 0.03, -0.3, 0.2);
  gg.part_(PART.EXTRA, 0, 1.3, -0.2);
  gg.material(M.LEATHER).color(0.45, 0.34, 0.22);
  gg.box(0, 0.2, -0.02, 0.18, 0.5, 0.14);
  return gg;
}, { col: [0.5, 0.4, 0.3] }));

U('hero_general', () => horse(g => {
  const gg = humanoid({ torsoCol: [0.7, 0.6, 0.35], torsoMat: M.METAL, legCol: [0.3, 0.28, 0.3], helmetCol: [0.9, 0.78, 0.4], crest: true, crestCol: [0.85, 0.2, 0.2], skin: [0.88, 0.72, 0.58] });
  cape(gg, [0.75, 0.2, 0.18]);
  gg.part_(PART.ARM_R, 0.29, 1.45, 0);
  sword(gg, 0.03, -0.2, 0.12, 1.15, 0.15);
  gg.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(gg, 0.03, -0.1, 0.24, 0.4, [0.85, 0.7, 0.3]);
  return gg;
}, { col: [0.35, 0.32, 0.3], armored: true, caparison: [0.7, 0.6, 0.28] }));

U('axeman', () => {
  const g = humanoid({ torsoCol: [0.5, 0.4, 0.32], legCol: [0.32, 0.28, 0.24], helmet: false, torsoMat: M.LEATHER });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.45, 0.34, 0.22);
  g.beam(0.03, -0.4, 0.08, 0.05, 0.5, 0.25, 0.06);
  g.material(M.METAL).color(0.72, 0.72, 0.74);
  g.box(0.1, 0.5, 0.32, 0.3, 0.34, 0.06);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 2.95 };
});

U('huskarl', () => {
  const g = humanoid({ torsoCol: [0.42, 0.36, 0.3], legCol: [0.3, 0.26, 0.22], crest: true, crestCol: [0.5, 0.2, 0.15] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.45, 0.34, 0.22);
  g.beam(0.03, -0.4, 0.08, 0.05, 0.45, 0.22, 0.06);
  g.material(M.METAL).color(0.65, 0.66, 0.68);
  g.box(0.1, 0.48, 0.3, 0.34, 0.4, 0.06);
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  shield(g, 0.03, -0.15, 0.2, 0.32, [0.35, 0.3, 0.28]);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 3.2 };
});

U('samurai', () => {
  const g = humanoid({ torsoCol: [0.55, 0.25, 0.25], legCol: [0.26, 0.24, 0.24], helmetCol: [0.25, 0.22, 0.2], crest: true, crestCol: [0.9, 0.75, 0.35] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.METAL).color(0.85, 0.86, 0.88);
  g.beam(0.03, -0.25, 0.1, 0.35, 0.6, 0.35, 0.045);
  g.part_(PART.EXTRA, 0, 1.2, -0.2);
  g.material(M.CLOTH).color(0.3, 0.3, 0.35);
  g.box(0, 0.1, 0, 0.4, 0.3, 0.1);
  g.color(1, 1, 1);
  return { geo: g, height: 1.88, stride: 3.1 };
});

U('berserk', () => {
  const g = humanoid({ torsoCol: [0.45, 0.4, 0.36], legCol: [0.3, 0.27, 0.24], helmet: false, skin: [0.85, 0.68, 0.55] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.42, 0.32, 0.22);
  g.beam(0.03, -0.4, 0.08, 0.05, 0.55, 0.25, 0.06);
  g.material(M.METAL).color(0.7, 0.7, 0.72);
  g.box(0.08, 0.55, 0.3, 0.32, 0.36, 0.06);
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  g.material(M.WOOD).color(0.5, 0.4, 0.28);
  g.cyl(0.03, -0.2, 0.22, 0.24, 0.24, 0.06, 8, { rot: Math.PI / 2 });
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 3.2 };
});

U('longbowman', () => {
  const g = humanoid({ torsoCol: [0.35, 0.45, 0.32], legCol: [0.3, 0.33, 0.26], helmet: false, torsoMat: M.LEATHER });
  g.part_(PART.ARM_L, -0.29, 1.45, 0);
  g.material(M.WOOD).color(0.48, 0.34, 0.2);
  for (let i = 0; i < 6; i++) {
    const a = -1.3 + i * 0.52;
    g.box(-0.02 + Math.cos(a) * 0.03, -0.2 + Math.sin(a) * 0.55, 0.15 - Math.cos(a) * 0.1, 0.05, 0.2, 0.05);
  }
  g.material(M.CLOTH).color(0.85, 0.82, 0.7);
  g.beam(-0.02, 0.35, 0.05, -0.02, -0.75, 0.05, 0.012);
  g.part_(PART.EXTRA, 0, 1.3, -0.2);
  g.material(M.LEATHER).color(0.4, 0.3, 0.2);
  g.box(0, 0.2, -0.02, 0.18, 0.55, 0.14);
  g.color(1, 1, 1);
  return { geo: g, height: 1.88, stride: 2.85 };
});

U('war_elephant', () => {
  const g = new Geo();
  // body
  g.part_(PART.BODY, 0, 1.6, 0);
  g.material(M.LEATHER).color(0.55, 0.5, 0.46);
  g.sphere(0, 1.7, 0, 0.95, 10, 6);
  g.box(0, 1.55, 0, 1.3, 1.1, 2.0);
  g.material(M.CLOTH).color(0.7, 0.25, 0.22);
  g.box(0, 1.9, 0, 1.36, 0.5, 1.6);
  // head + trunk
  g.material(M.LEATHER).color(0.58, 0.53, 0.48);
  g.sphere(0, 1.95, 1.05, 0.62, 9, 6);
  g.beam(0, 1.7, 1.5, 0, 0.5, 1.9, 0.34);
  g.material(M.GOLD).color(0.9, 0.8, 0.4);
  g.box(0, 2.1, 1.4, 0.5, 0.3, 0.2);
  // tusks
  g.material(M.MARBLE).color(0.95, 0.93, 0.86);
  g.cone(0.3, 1.55, 1.6, 0.08, 0.5, 5);
  g.cone(-0.3, 1.55, 1.6, 0.08, 0.5, 5);
  // ears
  g.material(M.LEATHER).color(0.5, 0.46, 0.42);
  g.panel(0.6, 1.7, 1.0, 0.7, 0.8, Math.PI / 2 + 0.3);
  g.panel(-0.6, 1.7, 1.0, 0.7, 0.8, Math.PI / 2 - 0.3);
  // legs
  for (const [part, sx, sz] of [[PART.LEG_L, -0.42, 0.6], [PART.LEG_L, 0.42, 0.6], [PART.LEG_R, -0.42, -0.7], [PART.LEG_R, 0.42, -0.7]]) {
    g.part_(part, sx, 1.1, sz);
    g.material(M.LEATHER).color(0.5, 0.46, 0.42);
    g.cyl(sx, 0, sz, 0.24, 0.28, 1.15, 7);
  }
  // howdah + archer
  g.part_(PART.EXTRA, 0, 2.35, -0.2);
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  g.box(0, 0.2, 0, 1.3, 0.16, 1.4);
  for (const sx of [-0.6, 0.6]) for (const sz of [-0.65, 0.65]) g.cyl(sx, 0.3, sz, 0.05, 0.06, 0.6, 4, { capTop: false });
  g.material(M.CLOTH).color(0.75, 0.3, 0.25);
  g.panel(0, 0.5, 0.7, 1.25, 0.5, 0);
  g.material(M.SKIN).color(0.8, 0.65, 0.5);
  g.sphere(0, 0.55, -0.2, 0.14, 6, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 3.4, stride: 2.4 };
});

U('monk', () => {
  const g = humanoid({ torsoCol: [0.5, 0.42, 0.32], torsoMat: M.CLOTH, legCol: [0.4, 0.34, 0.26], helmet: false, skin: [0.88, 0.74, 0.6] });
  g.part_(PART.EXTRA, 0, 1.5, -0.16);
  g.material(M.CLOTH).color(0.72, 0.32, 0.22);
  g.panel(0, 0.35, -0.02, 0.55, 1.15, 0);
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.GOLD).color(1, 0.9, 0.6);
  g.beam(0.03, -0.5, 0.15, 0.03, 0.4, 0.15, 0.05);
  g.beam(-0.12, 0.3, 0.15, 0.18, 0.3, 0.15, 0.05);
  g.material(M.METAL).color(0.9, 0.9, 0.95);
  g.sphere(0.03, 0.42, 0.15, 0.06, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 2.5 };
});

U('hand_cannoneer', () => {
  const g = humanoid({ torsoCol: [0.4, 0.34, 0.3], legCol: [0.28, 0.25, 0.22], helmetCol: [0.5, 0.5, 0.52] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.METAL).color(0.35, 0.34, 0.36);
  g.beam(0.03, -0.25, 0.1, 0.05, 0.15, 0.6, 0.1);
  g.material(M.GLOW).color(1, 0.6, 0.2);
  g.sphere(0.05, 0.17, 0.64, 0.06, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.86, stride: 2.9 };
});

U('trade_cart', () => {
  const g = new Geo();
  g.part_(PART.BODY, 0, 0.6, 0);
  g.material(M.WOOD).color(0.6, 0.46, 0.3);
  g.box(0, 0.75, 0, 1.2, 0.6, 2.0);
  g.material(M.CLOTH).color(0.85, 0.78, 0.6);
  g.box(0, 1.05, 0, 1.25, 0.14, 2.05);
  crate(g, 0, 0.9, 0, 0.5);
  for (const sz of [-0.7, 0.7]) {
    g.part_(sz > 0 ? PART.LEG_L : PART.LEG_R, 0, 0.5, sz);
    g.material(M.WOOD).color(0.5, 0.38, 0.26);
    g.cyl(0, 0.0, sz, 0.5, 0.5, 0.12, 10, { rot: Math.PI / 2 });
  }
  // ox
  g.part_(PART.EXTRA, 0, 1.0, 1.6);
  g.material(M.LEATHER).color(0.6, 0.5, 0.4);
  g.box(0, 0.9, 0, 0.8, 0.9, 1.6);
  g.sphere(0, 1.1, 0.95, 0.36, 8, 5);
  g.color(1, 1, 1);
  return { geo: g, height: 2.0, stride: 2.2 };
});

/* ---- siege ---- */
U('ram', () => {
  const g = new Geo();
  g.part_(PART.BODY, 0, 1.0, 0);
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  g.gable(0, 0.9, 0, 2.4, 1.1, 4.0);
  g.material(M.LEATHER).color(0.55, 0.42, 0.28);
  g.gable(0, 1.3, 0, 2.2, 0.9, 3.8);
  // ram head
  g.part_(PART.EXTRA, 0, 1.1, 0);
  g.material(M.BARK).color(0.42, 0.32, 0.22);
  g.cyl(0, 1.0, 0.2, 0.3, 0.34, 3.6, 8, { axis: 'z', capTop: false });
  g.material(M.METAL).color(0.4, 0.4, 0.42);
  g.cone(0, 1.0, 3.8, 0.36, 0.5, 7, { axis: 'z' });
  // wheels
  for (const [part, sx, sz] of [[PART.LEG_L, -1.1, 1.2], [PART.LEG_L, -1.1, -1.2], [PART.LEG_R, 1.1, 1.2], [PART.LEG_R, 1.1, -1.2]]) {
    g.part_(part, sx, 0.55, sz);
    g.material(M.WOOD).color(0.45, 0.34, 0.23);
    g.cyl(sx, 0, sz, 0.55, 0.55, 0.18, 10, { rot: Math.PI / 2 });
  }
  g.color(1, 1, 1);
  return { geo: g, height: 2.6, stride: 1.5 };
});

U('mangonel', () => {
  const g = new Geo();
  g.part_(PART.BODY, 0, 1.0, 0);
  g.material(M.WOOD).color(0.52, 0.4, 0.27);
  g.box(0, 0.75, 0, 1.6, 0.35, 2.4);
  g.beam(-0.8, 0.95, -1.0, -0.8, 1.6, 0.6, 0.14);
  g.beam(0.8, 0.95, -1.0, 0.8, 1.6, 0.6, 0.14);
  // arm
  g.part_(PART.ARM_R, 0, 1.2, 0.2);
  g.material(M.BARK).color(0.44, 0.34, 0.24);
  g.beam(0, 0.2, 0.4, 0, 1.9, -0.5, 0.12);
  g.material(M.LEATHER).color(0.4, 0.32, 0.24);
  g.box(0, 1.95, -0.55, 0.4, 0.3, 0.2);
  // wheels
  for (const [part, sx, sz] of [[PART.LEG_L, -0.9, 0.8], [PART.LEG_R, 0.9, 0.8]]) {
    g.part_(part, sx, 0.5, sz);
    g.material(M.WOOD).color(0.45, 0.34, 0.23);
    g.cyl(sx, 0, sz, 0.5, 0.5, 0.16, 10, { rot: Math.PI / 2 });
  }
  g.color(1, 1, 1);
  return { geo: g, height: 2.8, stride: 1.6 };
});

U('trebuchet', () => {
  const g = new Geo();
  g.part_(PART.BODY, 0, 1.4, 0);
  g.material(M.WOOD).color(0.5, 0.38, 0.26);
  g.box(0, 0.3, 0, 1.8, 0.4, 3.0);
  g.beam(-0.75, 0.5, -1.2, -0.4, 3.4, 0, 0.2);
  g.beam(0.75, 0.5, -1.2, 0.4, 3.4, 0, 0.2);
  g.beam(-0.75, 0.5, 1.2, -0.4, 3.4, 0, 0.2);
  g.beam(0.75, 0.5, 1.2, 0.4, 3.4, 0, 0.2);
  g.beam(-0.4, 3.4, 0, 0.4, 3.4, 0, 0.22);
  // arm
  g.part_(PART.ARM_R, 0, 3.4, 0);
  g.material(M.BARK).color(0.42, 0.32, 0.22);
  g.beam(0, 1.6, -0.3, 0, -1.0, 1.6, 0.16);
  g.material(M.LEATHER).color(0.35, 0.28, 0.2);
  g.box(0, -1.0, 1.65, 0.5, 0.5, 0.12);
  // sling stone
  g.part_(PART.EXTRA, 0, 1.0, 0);
  g.material(M.STONE).color(0.5, 0.5, 0.52);
  g.sphere(0, 1.2, -1.4, 0.26, 6, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 4.6, stride: 1.4 };
});

U('bombard_cannon', () => {
  const g = new Geo();
  g.part_(PART.BODY, 0, 1.0, 0);
  g.material(M.WOOD).color(0.48, 0.36, 0.24);
  g.box(0, 0.7, 0, 1.2, 0.4, 2.2);
  g.material(M.METAL).color(0.3, 0.3, 0.32);
  g.cyl(0, 1.0, -0.2, 0.28, 0.42, 2.4, 8, { axis: 'z', capTop: false });
  g.material(M.METAL).color(0.22, 0.22, 0.24);
  g.cyl(0, 1.0, 2.0, 0.34, 0.34, 0.2, 8, { axis: 'z' });
  for (const [part, sx, sz] of [[PART.LEG_L, -0.75, 0.7], [PART.LEG_L, 0.75, 0.7], [PART.LEG_R, -0.75, -0.7], [PART.LEG_R, 0.75, -0.7]]) {
    g.part_(part, sx, 0.45, sz);
    g.material(M.WOOD).color(0.42, 0.32, 0.22);
    g.cyl(sx, 0, sz, 0.45, 0.45, 0.14, 9, { rot: Math.PI / 2 });
  }
  g.part_(PART.EXTRA, 0, 0.6, 0.9);
  barrel(g, 0, 0, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.4, stride: 1.5 };
});

/* ---- ships ---- */
const shipBase = (g, o = {}) => {
  g.part_(PART.BODY, 0, 0.6, 0);
  g.material(M.WOOD).color(o.hull || [0.45, 0.34, 0.24]);
  // hull: tapered box + prow
  g.taperBox(0, 0.55, 0, 2.6, 1.1, 5.6, 2.2, 4.4);
  g.material(M.WOOD).color(0.36, 0.27, 0.19);
  g.box(0, 0.05, 0, 2.0, 0.2, 4.8);
  g.box(0, 0.9, 0, 2.5, 0.16, 5.4);
  // prow + stern
  g.material(M.WOOD).color(o.hull || [0.45, 0.34, 0.24]);
  g.cone(0, 0.6, 3.0, 0.9, 1.1, 7);
  g.beam(0, 1.0, 2.9, 0, 1.9, 3.2, 0.16);
  g.beam(0, 1.0, -2.8, 0, 1.7, -3.0, 0.16);
  // mast
  g.part_(PART.EXTRA, 0, 1.7, 0);
  g.material(M.WOOD).color(0.4, 0.3, 0.2);
  g.cyl(0, 0, 0, 0.09, 0.12, 3.4, 6, { capTop: false });
  g.material(o.sailMat || M.CLOTH).color(o.sail || [0.9, 0.87, 0.78]);
  g.panel(0, 1.4, 0.1, 2.2, 1.8, 0);
  g.beam(-1.1, 3.2, 0.1, 1.1, 3.2, 0.1, 0.08);
  if (o.stripes) {
    g.material(M.CLOTH).color(o.stripes);
    g.panel(0, 1.9, 0.14, 2.1, 0.4, 0);
  }
  // oars
  if (o.oars) {
    g.material(M.WOOD).color(0.5, 0.38, 0.26);
    for (let i = 0; i < 4; i++) {
      const z = -1.6 + i * 1.1;
      g.beam(-1.4, 0.7, z, -2.9, 0.2, z, 0.08);
      g.beam(1.4, 0.7, z, 2.9, 0.2, z, 0.08);
    }
  }
  g.color(1, 1, 1);
};

U('fishing_boat', () => {
  const g = new Geo();
  shipBase(g, { sail: [0.85, 0.8, 0.68] });
  g.part_(PART.ARM_R, 0, 1.2, 0);
  g.material(M.WOOD).color(0.5, 0.4, 0.28);
  g.beam(0, 0, 0, 1.6, 1.2, 1.2, 0.05);
  g.material(M.CLOTH).color(0.6, 0.6, 0.55);
  g.cyl(0.6, 0.2, 0.4, 0.3, 0.3, 0.2, 6);
  g.color(1, 1, 1);
  return { geo: g, height: 3.6, stride: 3.2 };
});

U('transport_ship', () => {
  const g = new Geo();
  shipBase(g, { hull: [0.4, 0.32, 0.24], sail: [0.8, 0.78, 0.7], oars: true });
  crate(g, -0.5, 1.2, 1.0, 0.5);
  crate(g, 0.5, 1.0, 1.0, 0.4);
  g.color(1, 1, 1);
  return { geo: g, height: 3.8, stride: 3.6 };
});

U('war_galley', () => {
  const g = new Geo();
  shipBase(g, { hull: [0.42, 0.28, 0.22], sail: [0.85, 0.82, 0.74], oars: true, stripes: [0.7, 0.25, 0.22] });
  g.material(M.WOOD).color(0.38, 0.28, 0.2);
  g.box(0, 1.1, 2.4, 1.4, 0.2, 1.2);
  g.material(M.METAL).color(0.6, 0.6, 0.62);
  for (let i = 0; i < 3; i++) g.beam(-0.5 + i * 0.5, 0.8, 2.6, -0.4 + i * 0.5, 1.6, 2.7, 0.05);
  g.color(1, 1, 1);
  return { geo: g, height: 3.9, stride: 4.0 };
});

U('fire_ship', () => {
  const g = new Geo();
  shipBase(g, { hull: [0.35, 0.24, 0.2], sail: [0.7, 0.3, 0.2], oars: true });
  g.part_(PART.ARM_R, 0, 1.0, 2.8);
  g.material(M.METAL).color(0.35, 0.3, 0.28);
  g.cyl(0, 0, 0, 0.2, 0.26, 1.2, 6, { rot: Math.PI / 2 });
  g.material(M.GLOW).color(1, 0.55, 0.2);
  g.sphere(0, 0.1, 0.7, 0.22, 6, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 3.4, stride: 4.4 };
});

U('demo_ship', () => {
  const g = new Geo();
  shipBase(g, { hull: [0.3, 0.26, 0.22], sail: [0.5, 0.48, 0.42] });
  barrel(g, -0.4, 0.8, 1.0);
  barrel(g, 0.4, 0.6, 1.0);
  g.material(M.GLOW).color(1, 0.4, 0.15);
  g.sphere(0, 2.0, 0, 0.18, 6, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 3.2, stride: 4.6 };
});

U('cannon_galleon', () => {
  const g = new Geo();
  shipBase(g, { hull: [0.38, 0.3, 0.24], sail: [0.9, 0.88, 0.82], oars: false });
  g.material(M.METAL).color(0.28, 0.28, 0.3);
  for (const sx of [-0.9, 0.9]) {
    for (let i = 0; i < 3; i++) {
      g.cyl(sx, 0.9, -1.2 + i * 1.1, 0.14, 0.16, 0.9, 7, { rot: Math.PI / 2 });
    }
  }
  g.material(M.WOOD).color(0.4, 0.3, 0.2);
  g.box(0, 1.3, -1.8, 1.6, 0.8, 1.4);
  g.color(1, 1, 1);
  return { geo: g, height: 4.0, stride: 2.9 };
});

/* horse helper: body + four legs + rider */
function horse(riderFn, o = {}) {
  const g = new Geo();
  // horse legs
  for (const [part, sx, sz] of [[PART.LEG_L, -0.34, 0.62], [PART.LEG_L, 0.34, 0.62], [PART.LEG_R, -0.34, -0.66], [PART.LEG_R, 0.34, -0.66]]) {
    g.part_(part, sx, 0.95, sz);
    g.material(M.LEATHER).color(o.col || [0.42, 0.34, 0.26]);
    g.box(sx, 0.48, sz, 0.2, 0.95, 0.22);
    g.material(M.METAL).color(0.4, 0.4, 0.42);
    g.box(sx, 0.06, sz, 0.24, 0.12, 0.26);
  }
  g.part_(PART.BODY, 0, 1.4, 0);
  g.material(M.LEATHER).color(o.col || [0.45, 0.36, 0.27]);
  g.box(0, 1.25, 0, 0.72, 0.78, 1.9);
  g.sphere(0, 1.35, 1.0, 0.42, 8, 5);
  g.taperBox(0, 1.55, 1.24, 0.4, 0.5, 0.6, 0.3, 0.4);
  g.material(M.LEATHER).color(0.3, 0.24, 0.18);
  g.box(0, 1.72, 1.42, 0.34, 0.3, 0.5);
  // mane + tail
  g.material(M.CLOTH).color(o.mane || [0.25, 0.2, 0.16]);
  g.box(0, 1.75, 0.9, 0.14, 0.2, 0.9);
  g.box(0, 1.25, -0.98, 0.12, 0.7, 0.16);
  // saddle
  g.material(M.LEATHER).color(0.32, 0.22, 0.16);
  g.box(0, 1.68, -0.1, 0.6, 0.16, 0.7);
  if (o.armored) {
    g.material(M.METAL).color(0.6, 0.6, 0.62);
    g.box(0, 1.55, 0.75, 0.8, 0.5, 0.9);
    g.box(0, 1.7, 1.35, 0.5, 0.4, 0.5);
  }
  if (o.caparison) {
    g.material(M.CLOTH).color(o.caparison);
    g.panel(0, 0.7, 0.55, 0.95, 0.85, 0);
    g.panel(0, 0.7, -0.55, 0.95, 0.85, Math.PI);
  }
  // rider (merged, pivots shifted up)
  const rider = riderFn();
  const rv = rider.v;
  const base = g.count;
  for (let k = 0; k < rider.count; k++) {
    const oo = k * 16;
    g.v.push(
      rv[oo], rv[oo + 1] + 1.45, rv[oo + 2] - 0.05,
      rv[oo + 3], rv[oo + 4], rv[oo + 5],
      rv[oo + 6], rv[oo + 7], rv[oo + 8],
      rv[oo + 9], rv[oo + 10], rv[oo + 11],
      rv[oo + 12], rv[oo + 13] + 1.45, rv[oo + 14] - 0.05,
      rv[oo + 15]
    );
    g.count++;
  }
  for (let k = 0; k < rider.i.length; k++) g.i.push(base + rider.i[k]);
  g.color(1, 1, 1);
  return { geo: g, height: 2.6, stride: 4.4, mounted: true };
}

/* ============================================================
   PROPS
   ============================================================ */
const PROPS = {};
const P = (name, fn) => { PROPS[name] = fn; };

function pine(g, h = 5, r = 1.2, tiers = 3) {
  g.material(M.BARK).color(0.36, 0.28, 0.2);
  g.cyl(0, 0, 0, 0.12, 0.22, h * 0.55, 6, { capTop: false });
  g.material(M.LEAF).color(0.26, 0.38, 0.23);
  for (let i = 0; i < tiers; i++) {
    const y = h * 0.3 + i * h * 0.22;
    g.cone(0, y, 0, r * (1 - i * 0.24), h * 0.42, 7);
  }
  g.color(1, 1, 1);
}
function broadleaf(g, h = 4.6, r = 1.6, col = [0.3, 0.5, 0.26]) {
  g.material(M.BARK).color(0.36, 0.28, 0.2);
  g.cyl(0, 0, 0, 0.16, 0.3, h * 0.5, 6, { capTop: false });
  g.beam(0, h * 0.4, 0, 0.6, h * 0.62, 0.2, 0.12);
  g.beam(0, h * 0.42, 0, -0.5, h * 0.6, -0.3, 0.11);
  g.material(M.LEAF).color(col);
  g.sphere(0, h * 0.72, 0, r, 8, 5);
  g.sphere(0.65, h * 0.62, 0.3, r * 0.65, 7, 4);
  g.sphere(-0.55, h * 0.66, -0.35, r * 0.7, 7, 4);
  g.color(1, 1, 1);
}

P('tree0', () => { const g = new Geo(); broadleaf(g, 5.2, 1.85, [0.30, 0.42, 0.21]); return { geo: g, height: 6.4 }; });
P('tree1', () => { const g = new Geo(); broadleaf(g, 4.4, 1.6, [0.36, 0.43, 0.19]); return { geo: g, height: 5.6 }; });
P('tree2', () => { const g = new Geo(); pine(g, 6.4, 1.5, 4); return { geo: g, height: 7.2 }; });
P('tree3', () => { const g = new Geo(); pine(g, 5.4, 1.2, 3); return { geo: g, height: 6.2 }; });
P('tree_lod', () => { const g = new Geo(); pine(g, 5.6, 1.3, 2); return { geo: g, height: 6.4 }; });
P('bush', () => {
  /* A low, flattish scrub of four uneven lobes. Three fat spheres in a row read
     as a mossy boulder, which is what every bush in the valley looked like. */
  const g = new Geo();
  g.material(M.LEAF).color(0.33, 0.42, 0.20);
  g.sphere(0, 0.38, 0, 0.52, 7, 4);
  g.sphere(0.40, 0.28, 0.16, 0.34, 6, 4);
  g.sphere(-0.36, 0.30, -0.10, 0.30, 6, 3);
  g.sphere(0.05, 0.26, -0.38, 0.26, 6, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 0.9 };
});
P('berry_bush', () => {
  const g = new Geo();
  g.material(M.LEAF).color(0.30, 0.41, 0.21);
  g.sphere(0, 0.55, 0, 0.62, 7, 4);
  g.sphere(0.4, 0.42, 0.25, 0.4, 6, 4);
  g.material(M.CLOTH).color(0.75, 0.16, 0.22);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    g.sphere(Math.cos(a) * 0.5, 0.55 + ((i * 7) % 3) * 0.14, Math.sin(a) * 0.5, 0.07, 5, 3);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 1.2 };
});
P('rock', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.6, 0.59, 0.56);
  g.sphere(0, 0.45, 0, 0.7, 6, 4);
  g.sphere(0.5, 0.25, 0.3, 0.35, 5, 3);
  g.material(M.LEAF).color(0.3, 0.4, 0.24);
  g.sphere(0.2, 0.78, -0.1, 0.18, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.2 };
});
P('stump', () => {
  const g = new Geo();
  g.material(M.BARK).color(0.4, 0.31, 0.22);
  g.cyl(0, 0, 0, 0.32, 0.4, 0.5, 7);
  g.material(M.WOOD).color(0.62, 0.48, 0.32);
  g.cyl(0, 0.5, 0, 0.3, 0.3, 0.04, 7);
  g.color(1, 1, 1);
  return { geo: g, height: 0.6 };
});
P('reed', () => {
  const g = new Geo();
  g.material(M.LEAF).color(0.5, 0.55, 0.3);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const x = Math.cos(a) * 0.2, z = Math.sin(a) * 0.2;
    g.beam(x, 0, z, x * 1.6, 0.9 + (i % 3) * 0.25, z * 1.6, 0.045);
  }
  g.material(M.BARK).color(0.45, 0.36, 0.24);
  for (let i = 0; i < 3; i++) g.cyl(Math.cos(i * 2) * 0.2, 0.9 + i * 0.1, Math.sin(i * 2) * 0.2, 0.05, 0.05, 0.22, 5);
  g.color(1, 1, 1);
  return { geo: g, height: 1.3 };
});
P('tuft', () => {
  const g = new Geo();
  g.material(M.LEAF).color(0.42, 0.56, 0.28);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    g.beam(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1, Math.cos(a) * 0.28, 0.32 + (i % 2) * 0.1, Math.sin(a) * 0.28, 0.03);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 0.45 };
});
P('flower', () => {
  const g = new Geo();
  g.material(M.LEAF).color(0.4, 0.55, 0.3);
  g.beam(0, 0, 0, 0, 0.3, 0, 0.025);
  g.material(M.CLOTH).color(0.9, 0.7, 0.85);
  g.sphere(0, 0.32, 0, 0.08, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 0.4 };
});
P('pebble', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.55, 0.54, 0.5);
  g.sphere(0, 0.09, 0, 0.16, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 0.25 };
});
P('log', () => {
  const g = new Geo();
  g.material(M.BARK).color(0.42, 0.32, 0.22);
  g.cyl(-0.75, 0.17, 0, 0.16, 0.18, 1.5, 6, { axis: 'x' });
  g.material(M.WOOD).color(0.6, 0.46, 0.3);
  g.cyl(0.75, 0.17, 0, 0.16, 0.16, 0.02, 6, { axis: 'x' });
  g.color(1, 1, 1);
  return { geo: g, height: 0.4 };
});
P('gold_mine', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.5, 0.48, 0.45);
  g.sphere(0, 0.7, 0, 1.2, 7, 4);
  g.sphere(0.9, 0.4, 0.5, 0.6, 6, 3);
  g.sphere(-0.8, 0.35, -0.4, 0.55, 6, 3);
  g.material(M.GOLD).color(1, 0.86, 0.4);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + (i % 3);
    const r = 0.7 + (i % 4) * 0.22;
    g.sphere(Math.cos(a) * r, 0.5 + (i % 5) * 0.16, Math.sin(a) * r, 0.14 + (i % 3) * 0.05, 5, 3);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 1.8 };
});
P('stone_mine', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.62, 0.61, 0.58);
  g.sphere(0, 0.75, 0, 1.3, 6, 4);
  g.material(M.STONE).color(0.72, 0.71, 0.68);
  g.box(0.6, 1.0, 0.3, 0.9, 0.7, 0.8, { rotY: 0.5 });
  g.box(-0.5, 0.9, -0.5, 0.8, 0.6, 0.9, { rotY: -0.3 });
  g.material(M.STONE).color(0.5, 0.49, 0.46);
  g.sphere(1.0, 0.3, -0.4, 0.5, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9 };
});
P('deer', () => {
  const g = new Geo();
  g.material(M.LEATHER).color(0.55, 0.4, 0.27);
  g.box(0, 0.85, 0, 0.5, 0.55, 1.3);
  g.sphere(0, 1.0, 0.75, 0.24, 6, 4);
  g.beam(0, 1.1, 0.8, 0, 1.6, 0.95, 0.16);
  for (const [sx, sz] of [[-0.2, 0.45], [0.2, 0.45], [-0.2, -0.5], [0.2, -0.5]]) {
    g.beam(sx, 0.6, sz, sx, 0.05, sz + 0.05, 0.09);
  }
  g.material(M.BARK).color(0.4, 0.32, 0.22);
  g.beam(-0.1, 1.15, 0.85, -0.3, 1.55, 0.75, 0.04);
  g.beam(0.1, 1.15, 0.85, 0.3, 1.55, 0.75, 0.04);
  g.color(1, 1, 1);
  return { geo: g, height: 1.7 };
});
P('boar', () => {
  const g = new Geo();
  g.material(M.LEATHER).color(0.32, 0.26, 0.22);
  g.box(0, 0.6, 0, 0.6, 0.6, 1.1);
  g.sphere(0, 0.7, 0.65, 0.3, 6, 4);
  for (const [sx, sz] of [[-0.22, 0.35], [0.22, 0.35], [-0.22, -0.4], [0.22, -0.4]]) {
    g.beam(sx, 0.4, sz, sx, 0.05, sz, 0.1);
  }
  g.material(M.MARBLE).color(0.9, 0.88, 0.8);
  g.cone(-0.14, 0.66, 0.9, 0.05, 0.2, 4);
  g.cone(0.14, 0.66, 0.9, 0.05, 0.2, 4);
  g.color(1, 1, 1);
  return { geo: g, height: 1.0 };
});
P('fish', () => {
  const g = new Geo();
  g.material(M.ICE).color(0.4, 0.6, 0.7);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    g.sphere(Math.cos(a) * 0.7, 0.2, Math.sin(a) * 0.7, 0.16, 5, 3);
    g.beam(Math.cos(a) * 0.7, 0.2, Math.sin(a) * 0.7, Math.cos(a) * 1.1, 0.2, Math.sin(a) * 1.1, 0.06);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 0.4 };
});
/* A standing brazier: the visible source of every town firelight. The bowls
   sit at the exact height the renderer puts uTownLight, so the glowing pool on
   the ground always has a flame at its centre. */
P('brazier', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.66, 0.64, 0.60);
  g.cyl(0, 0.05, 0, 0.30, 0.36, 0.10, 8);
  // the legs are thick enough to read as a tripod from 30 m, and warm enough
  // in colour that daylight does not turn the brazier into a black post
  g.material(M.IRON).color(0.52, 0.48, 0.43);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const sx = Math.sin(a) * 0.34, sz = Math.cos(a) * 0.34;
    g.beam(sx, 0.09, sz, sx * 0.58, 1.16, sz * 0.58, 0.075);
  }
  // a brace ring between the legs: silhoutte, and it catches the sun
  g.cyl(0, 0.68, 0, 0.30, 0.30, 0.05, 8);
  g.material(M.IRON).color(0.44, 0.41, 0.37);
  g.cyl(0, 1.26, 0, 0.24, 0.44, 0.34, 10);
  g.material(M.IRON).color(0.58, 0.54, 0.48);
  g.cyl(0, 1.44, 0, 0.48, 0.44, 0.07, 10);
  g.material(M.GLOW).color(1.0, 0.44, 0.10);
  g.sphere(0, 1.40, 0, 0.40, 8, 5);
  g.material(M.GLOW).color(1.0, 0.66, 0.22);
  g.sphere(0, 1.62, 0, 0.28, 7, 4);
  g.material(M.GLOW).color(1.0, 0.86, 0.52);
  g.sphere(0, 1.78, 0, 0.15, 6, 4);
  return { geo: g, height: 1.72 };
});

/* ------------------------------------------------------------------
   VILLAGE CLUTTER
   A town made only of buildings reads as a diorama. These are the things a
   settlement accumulates: barrels, crates, a hay cart, stacked firewood, a
   well with a bucket, fence runs and a drying rack. They are static decor, so
   they stream in with the prop chunks and cost no draw calls of their own.
   ------------------------------------------------------------------ */
P('crate', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.66, 0.52, 0.35);
  g.box(0, 0.26, 0, 0.62, 0.52, 0.62);
  g.material(M.WOOD_DARK).color(0.36, 0.27, 0.18);
  for (const s of [-1, 1]) {
    g.box(s * 0.27, 0.26, 0, 0.07, 0.54, 0.66);
    g.box(0, 0.26, s * 0.27, 0.66, 0.54, 0.07);
  }
  g.box(0, 0.53, 0, 0.68, 0.05, 0.68);
  return { geo: g, height: 0.55 };
});
P('barrel', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.62, 0.45, 0.28);
  g.cyl(0, 0.02, 0, 0.23, 0.19, 0.72, 10);
  g.material(M.IRON).color(0.32, 0.30, 0.28);
  for (const y of [0.14, 0.58]) g.cyl(0, y, 0, 0.245, 0.245, 0.055, 10);
  g.material(M.WOOD_DARK).color(0.38, 0.28, 0.18);
  g.cyl(0, 0.73, 0, 0.20, 0.20, 0.04, 10);
  return { geo: g, height: 0.76 };
});
P('haystack', () => {
  const g = new Geo();
  g.material(M.THATCH).color(0.78, 0.66, 0.34);
  g.cyl(0, 0, 0, 0.55, 0.72, 1.10, 10);
  g.cone(0, 1.10, 0, 0.62, 0.62, 10);
  g.material(M.WOOD_DARK).color(0.36, 0.28, 0.18);
  g.beam(-0.2, 1.62, 0, 0.1, 2.0, 0.1, 0.05);
  return { geo: g, height: 1.9 };
});
P('firewood', () => {
  const g = new Geo();
  // six split rounds, bark on the outside and pale sawn ends so the stack reads
  // as cut timber instead of six brown tubes
  for (let i = 0; i < 6; i++) {
    const row = i < 3 ? 0 : 1;
    const x = (i % 3) * 0.19 - 0.19;
    const y = 0.11 + row * 0.19;
    g.material(M.BARK).color(0.42, 0.32, 0.20);
    g.cyl(x, y, 0, 0.09, 0.09, 0.62, 6, { axis: 'z' });
    g.material(M.WOOD).color(0.80, 0.66, 0.44);
    g.cyl(x, y, 0.62, 0.092, 0.092, 0.02, 6, { axis: 'z' });
    g.cyl(x, y, -0.02, 0.092, 0.092, 0.02, 6, { axis: 'z' });
    g.material(M.BARK).color(0.42, 0.32, 0.20);
  }
  g.color(1, 1, 1);
  return { geo: g, height: 0.4 };
});
P('cart', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.68, 0.52, 0.34);
  g.box(0, 0.58, 0, 1.25, 0.16, 0.78);
  for (const s of [-1, 1]) {
    g.box(0, 0.72, s * 0.38, 1.25, 0.30, 0.07);
    g.box(s * 0.60, 0.72, 0, 0.07, 0.30, 0.78);
  }
  g.material(M.WOOD_DARK).color(0.38, 0.29, 0.19);
  for (const s of [-1, 1]) {
    g.cyl(0, 0.36, -0.485, 0.36, 0.36, 0.09, 10, { axis: 'z' });
    g.cyl(0, 0.36, 0.395, 0.36, 0.36, 0.09, 10, { axis: 'z' });
  }
  g.beam(0.62, 0.62, 0, 1.30, 0.50, 0, 0.06);
  // a load of hay
  g.material(M.THATCH).color(0.80, 0.68, 0.36);
  g.box(0, 0.86, 0, 1.05, 0.34, 0.62);
  return { geo: g, height: 1.05 };
});
P('well', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.62, 0.60, 0.55);
  g.cyl(0, 0, 0, 0.62, 0.68, 0.72, 12);
  g.material(M.STONE_LIGHT).color(0.78, 0.76, 0.70);
  g.cyl(0, 0.72, 0, 0.60, 0.62, 0.09, 12);
  g.material(M.WOOD_DARK).color(0.40, 0.30, 0.20);
  for (const s of [-1, 1]) g.beam(s * 0.58, 0.78, 0, s * 0.58, 1.72, 0, 0.075);
  g.material(M.THATCH).color(0.74, 0.62, 0.32);
  g.gable(0, 1.74, 0, 1.5, 0.52, 1.0);
  g.material(M.WOOD).color(0.52, 0.40, 0.27);
  g.cyl(-0.58, 1.48, 0, 0.05, 0.05, 1.16, 6, { axis: 'x' });
  g.beam(0, 1.48, 0, 0, 1.02, 0, 0.02);
  g.material(M.IRON).color(0.42, 0.40, 0.36);
  g.cyl(0, 0.95, 0, 0.15, 0.13, 0.22, 8);
  return { geo: g, height: 2.0 };
});
P('fence', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.62, 0.49, 0.32);
  for (const x of [-1.05, 0, 1.05]) g.beam(x, 0, 0, x, 1.02, 0, 0.065);
  g.material(M.WOOD_DARK).color(0.40, 0.31, 0.20);
  g.beam(-1.1, 0.78, 0, 1.1, 0.78, 0, 0.045);
  g.beam(-1.1, 0.44, 0, 1.1, 0.44, 0, 0.045);
  return { geo: g, height: 1.05 };
});
P('drying_rack', () => {
  const g = new Geo();
  g.material(M.WOOD).color(0.48, 0.37, 0.25);
  for (const s of [-1, 1]) {
    g.beam(s * 0.55, 0, 0, s * 0.55, 1.18, 0, 0.055);
    g.beam(s * 0.55, 1.0, 0, s * 0.75, 1.18, 0, 0.035);
  }
  g.beam(-0.6, 1.16, 0, 0.6, 1.16, 0, 0.045);
  g.material(M.CLOTH).color(0.82, 0.76, 0.62);
  for (let i = 0; i < 3; i++) g.panel(-0.34 + i * 0.34, 0.92, 0, 0.26, 0.42, 0);
  return { geo: g, height: 1.25 };
});

P('relic', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.8, 0.78, 0.72);
  g.box(0, 0.2, 0, 0.8, 0.4, 0.8);
  g.material(M.GOLD).color(1, 0.86, 0.45);
  g.box(0, 0.65, 0, 0.6, 0.5, 0.5);
  g.sphere(0, 0.95, 0, 0.14, 6, 4);
  g.material(M.GLOW).color(1, 0.9, 0.6);
  g.sphere(0, 0.65, 0.26, 0.08, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.1 };
});
P('ruin', () => {
  const g = new Geo();
  g.material(M.MARBLE).color(0.82, 0.8, 0.74);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const h = 0.8 + (i % 3) * 0.5;
    g.cyl(Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8, 0.18, 0.2, h, 7, { capTop: false });
  }
  g.material(M.STONE).color(0.7, 0.69, 0.65);
  g.box(0, 0.12, 0, 2.0, 0.24, 2.0, { rotY: 0.2 });
  g.color(1, 1, 1);
  return { geo: g, height: 2.0 };
});

/* ============================================================
   MOD CONTENT
   ------------------------------------------------------------
   Everything below only exists inside a mod session. The builders
   live in their own tables so that a normal campaign never even
   looks at them, and installModModels() copies them into the same
   registries the renderer already knows how to batch. Kept in this
   file on purpose: they reuse humanBase, the rig parts and the
   masonry helpers above, so a mod unit animates with the same
   articulated rig as a knight.
   ============================================================ */
const MOD_UNITS = {};
const MOD_BUILDINGS = {};
const MU = (type, fn) => { MOD_UNITS[type] = fn; };
const MB = (type, fn) => { MOD_BUILDINGS[type] = fn; };

/* ---- plague zombie: hunched, grey-green, arms out ----
   Flesh is SKIN, not CLOTH: the cloth layer is dyed almost entirely in team
   colour, which turned a shambler into a red (or blue) soldier. A rotting
   green body with one team-coloured rag reads as undead and still says whose
   side it is on. */
MU('plague_zombie', () => {
  const g = humanoid({
    torsoCol: [0.36, 0.42, 0.28], torsoMat: M.SKIN, legCol: [0.28, 0.30, 0.22],
    skin: [0.58, 0.68, 0.46], sleeveCol: [0.34, 0.40, 0.27], sleeveMat: M.SKIN,
    legMat: M.SKIN, helmet: false
  });
  /* the hunch: a bent back plate, shoulders tipped forward */
  g.part_(PART.BODY, 0, 1.2, 0);
  g.material(M.SKIN).color(0.44, 0.52, 0.34);
  g.taperBox(0, 0.92, 0.06, 0.44, 0.62, 0.34, 0.5, 0.4);
  /* a torn tunic hanging off one shoulder: the team colour, and only that */
  g.material(M.CLOTH).color(1, 1, 1);
  g.panel(-0.08, 1.42, 0.02, 0.34, 0.5, 0.12);
  /* both arms reach forward, the way a shambler walks */
  g.part_(PART.ARM_R, 0.29, 1.42, 0);
  g.material(M.SKIN).color(0.56, 0.66, 0.44);
  g.beam(0.03, -0.12, 0.02, 0.06, -0.30, 0.52, 0.11);
  g.part_(PART.ARM_L, -0.29, 1.42, 0);
  g.material(M.SKIN).color(0.56, 0.66, 0.44);
  g.beam(-0.03, -0.12, 0.02, -0.06, -0.30, 0.52, 0.11);
  /* sunken eye sockets with a little glow inside */
  g.material(M.GLOW).color(0.62, 1.0, 0.55);
  g.sphere(0.055, 1.62, 0.115, 0.038, 5, 3);
  g.sphere(-0.055, 1.62, 0.115, 0.038, 5, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.7, stride: 2.4 };
});

/* ---- magician: long robe, wide hat, staff with a live orb ----
   The robe is a skirt from the ankles to the waist, not a cone from the
   chest to the sky: the previous version read as a blue traffic cone. */
MU('magician', () => {
  const g = humanoid({
    torsoCol: [0.18, 0.22, 0.50], legCol: [0.14, 0.16, 0.34],
    sleeveCol: [0.20, 0.24, 0.54], sleeveMat: M.CLOTH, skin: [0.84, 0.70, 0.58],
    helmet: false
  });
  /* robe skirt: wide at the hem, cinched at the waist */
  g.part_(PART.BODY, 0, 1.2, 0);
  g.material(M.CLOTH).color(1, 1, 1);
  g.cyl(0, 0.04, 0, 0.30, 0.46, 1.18, 10, { capTop: false });
  g.material(M.GOLD).color(0.85, 0.70, 0.30);
  g.cyl(0, 1.18, 0, 0.31, 0.31, 0.07, 10);
  /* shoulders/collar in gold, so the silhouette is not one flat colour */
  g.material(M.GOLD).color(0.82, 0.68, 0.28);
  g.box(0, 1.52, 0, 0.4, 0.06, 0.26);
  /* wide-brimmed hat and a short crown */
  g.material(M.CLOTH).color(0.9, 0.9, 0.95);
  g.cyl(0, 1.80, 0, 0.36, 0.34, 0.05, 10);
  g.material(M.CLOTH).color(0.14, 0.16, 0.40);
  g.cone(0, 1.84, 0, 0.19, 0.36, 9);
  /* beard */
  g.material(M.MARBLE).color(0.9, 0.88, 0.84);
  g.cyl(0, 1.30, 0.12, 0.10, 0.02, 0.24, 7, { capTop: true });
  /* staff in the right hand, orb at the top */
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.WOOD).color(0.36, 0.25, 0.17);
  g.beam(0.05, -0.62, 0.10, 0.05, 0.62, 0.10, 0.045);
  g.material(M.GLOW).color(0.55, 0.78, 1.0);
  g.sphere(0.05, 0.74, 0.10, 0.115, 7, 5);
  g.material(M.GOLD).color(0.8, 0.68, 0.3);
  g.box(0.05, 0.64, 0.10, 0.09, 0.05, 0.09);
  g.color(1, 1, 1);
  return { geo: g, height: 2.2, stride: 3.0 };
});


/* ---- the five higher ranks of the magician ------------------------------
   Same rig, one family of silhouettes. Three things carry the ladder, in
   order of how far away they read:

     1. the colour of the robe -- blue, violet, crimson, ivory, white-gold;
        the rank colours are self-lit materials, NOT team cloth, or every
        rank would be the same blue;
     2. the light above the head -- a circlet, a halo, a crown, a crown of
        three rings, and finally a column of light;
     3. the clutter that floats where it should not -- one book, four motes,
        six motes, wings.

   Each builder ends with the part reset: geometry added after the staff
   belongs to the body, or the halo swings with the arm and reads as a
   stick lying on the ground. */
const mageRing = (g, y, r, thick, seg = 10) => {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    g.beam(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r, thick);
  }
};

const mageBody = (o = {}) => {
  const g = humanoid({
    torsoCol: o.cloth || [0.18, 0.22, 0.50],
    legCol: o.leg || [0.14, 0.16, 0.34],
    sleeveCol: o.sleeve || o.cloth || [0.2, 0.24, 0.54],
    sleeveMat: M.CLOTH,
    skin: o.skin || [0.84, 0.72, 0.58],
    helmet: false
  });
  /* robe skirt. A high rank wears a self-coloured robe; only the belt and the
     sash stay in team cloth, so ownership is still readable */
  g.part_(PART.BODY, 0, 1.2, 0);
  const robeCol = o.robeCol || [1, 1, 1];
  g.material(o.robeMat || M.CLOTH).color(robeCol[0], robeCol[1], robeCol[2]);
  g.cyl(0, 0.04, 0, 0.30, o.hem || 0.46, 1.18, 12, { capTop: false });
  if (o.overRobe) {
    /* a second, shorter layer: heavier cloth at the hem, so the skirt is not
       one flat triangle from the chest down */
    g.material(o.robeMat || M.CLOTH).color(
      Math.min(1, robeCol[0] * 0.82), Math.min(1, robeCol[1] * 0.82), Math.min(1, robeCol[2] * 0.82));
    g.cyl(0, 0.02, 0, 0.34, 0.54, 0.52, 12, { capTop: false });
  }
  g.material(M.GOLD).color(0.88, 0.72, 0.3);
  g.cyl(0, 1.18, 0, 0.31, 0.31, 0.07, 10);
  /* the team sash across the chest */
  g.material(M.CLOTH).color(1, 1, 1);
  g.panel(0, 1.34, 0.16, 0.4, 0.12, 0.35);
  g.material(M.GOLD).color(0.85, 0.7, 0.3);
  g.box(0, 1.52, 0, 0.4, 0.06, 0.26);
  /* staff, held in the right hand */
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.WOOD).color(0.36, 0.25, 0.17);
  g.beam(0.05, -0.58, 0.10, 0.05, 0.66, 0.10, 0.045);
  /* back on the body: everything a rank adds hangs off the chest */
  g.part_(PART.BODY, 0, 1.2, 0);
  return g;
};

/* rank 2 — a circlet instead of a hat, a white mantle, twin orbs */
MU('magician_adept', () => {
  const g = mageBody({ hem: 0.46, overRobe: true });
  g.material(M.GOLD).color(0.9, 0.76, 0.34);
  mageRing(g, 1.80, 0.16, 0.032, 9);
  g.material(M.MARBLE).color(0.9, 0.9, 0.86);
  g.taperBox(0, 1.46, 0, 0.56, 0.2, 0.36, 0.36, 0.28);
  g.material(M.GLOW).color(0.6, 0.85, 1.0);
  g.sphere(0, 1.2, 0.18, 0.06, 6, 4);
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.GLOW).color(0.55, 0.8, 1.0);
  g.sphere(0.05, 0.78, 0.10, 0.11, 7, 5);
  g.material(M.GLOW).color(0.35, 0.62, 1.0);
  g.sphere(0.05, 0.54, 0.10, 0.06, 6, 4);
  g.part_(PART.BODY, 0, 1.2, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.3, stride: 3.0 };
});

/* rank 3 — violet, a cape, a halo, and a book that hangs in the air */
MU('magician_magus', () => {
  const g = mageBody({ hem: 0.5, robeMat: M.MARBLE, robeCol: [0.44, 0.33, 0.66], overRobe: true });
  /* cape behind the shoulders */
  g.part_(PART.EXTRA, 0, 1.5, -0.18);
  g.material(M.MARBLE).color(0.3, 0.22, 0.5);
  g.taperBox(0, 0.0, -0.02, 0.56, 1.4, 0.08, 0.92, 0.1);
  g.material(M.GOLD).color(0.88, 0.74, 0.32);
  g.box(0, -0.66, -0.02, 0.94, 0.06, 0.1);
  /* hood, then a halo of gold above it */
  g.part_(PART.BODY, 0, 1.2, 0);
  g.material(M.MARBLE).color(0.4, 0.3, 0.62);
  g.cone(0, 1.86, -0.02, 0.25, 0.34, 9);
  g.material(M.GOLD).color(0.95, 0.8, 0.36);
  mageRing(g, 2.1, 0.3, 0.034, 12);
  g.material(M.GLOW).color(0.72, 0.9, 1.0);
  g.sphere(0, 2.1, 0, 0.05, 6, 4);
  /* the grimoire, pages down, orbiting the left hand */
  g.part_(PART.EXTRA, -0.62, 1.32, 0.24);
  g.material(M.LEATHER).color(0.42, 0.2, 0.26);
  g.box(0, 0, 0, 0.28, 0.36, 0.08);
  g.material(M.MARBLE).color(0.94, 0.92, 0.86);
  g.box(0, 0, 0.05, 0.23, 0.31, 0.03);
  g.material(M.GLOW).color(0.75, 0.9, 1.0);
  g.sphere(0, 0.22, 0, 0.05, 6, 4);
  /* staff crystal */
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.GLOW).color(0.6, 0.82, 1.0);
  g.cone(0.05, 0.9, 0.10, 0.12, 0.24, 6);
  g.sphere(0.05, 0.84, 0.10, 0.09, 6, 4);
  g.part_(PART.BODY, 0, 1.2, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.45, stride: 3.0 };
});

/* rank 4 — crimson, gold pauldrons, a crown of three points, four motes */
MU('magician_archmage', () => {
  const g = mageBody({ hem: 0.54, robeMat: M.MARBLE, robeCol: [0.62, 0.21, 0.24], overRobe: true });
  g.part_(PART.EXTRA, 0, 1.5, -0.2);
  g.material(M.MARBLE).color(0.4, 0.13, 0.16);
  g.taperBox(0, 0.0, -0.02, 0.6, 1.5, 0.08, 0.98, 0.1);
  g.part_(PART.BODY, 0, 1.2, 0);
  /* crown */
  g.material(M.GOLD).color(0.98, 0.84, 0.4);
  mageRing(g, 1.84, 0.18, 0.042, 9);
  g.cone(0, 1.9, 0.15, 0.055, 0.22, 5);
  g.cone(-0.15, 1.9, 0.03, 0.055, 0.18, 5);
  g.cone(0.15, 1.9, 0.03, 0.055, 0.18, 5);
  /* two halos, one gold and one of light */
  mageRing(g, 2.2, 0.34, 0.032, 12);
  g.material(M.GLOW).color(0.62, 0.8, 1.0);
  mageRing(g, 2.32, 0.25, 0.024, 12);
  /* pauldrons */
  g.material(M.GOLD).color(0.9, 0.76, 0.34);
  g.box(-0.31, 1.52, 0, 0.22, 0.14, 0.3);
  g.box(0.31, 1.52, 0, 0.22, 0.14, 0.3);
  /* four motes */
  g.part_(PART.EXTRA, 0, 0, 0);
  g.material(M.GLOW).color(0.66, 0.86, 1.0);
  for (const [mx, my, mz] of [[-0.54, 1.62, 0.08], [0.54, 1.62, 0.08], [-0.48, 1.04, 0.14], [0.48, 1.04, 0.14]]) {
    g.sphere(mx, my, mz, 0.055, 6, 4);
  }
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.WOOD).color(0.3, 0.22, 0.16);
  g.beam(0.05, 0.66, 0.10, 0.05, 0.96, 0.10, 0.035);
  g.material(M.GLOW).color(0.75, 0.92, 1.0);
  g.cone(0.05, 1.08, 0.10, 0.13, 0.28, 6);
  g.sphere(0.05, 1.0, 0.10, 0.1, 6, 4);
  g.part_(PART.BODY, 0, 1.2, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.6, stride: 3.0 };
});

/* rank 5 — ivory, a white beard, an open book, four motes and a halo */
MU('magician_sage', () => {
  const g = mageBody({ hem: 0.52, robeMat: M.MARBLE, robeCol: [0.95, 0.93, 0.86], overRobe: true, skin: [0.9, 0.82, 0.72] });
  g.part_(PART.BODY, 0, 1.2, 0);
  /* mantle and beard */
  g.material(M.MARBLE).color(0.99, 0.98, 0.94);
  g.taperBox(0, 1.34, 0, 0.64, 0.62, 0.42, 0.44, 0.32);
  g.cyl(0, 1.18, 0.22, 0.14, 0.02, 0.56, 7);
  g.material(M.GOLD).color(0.95, 0.8, 0.36);
  mageRing(g, 1.86, 0.18, 0.04, 9);
  mageRing(g, 2.18, 0.32, 0.028, 12);
  g.material(M.GLOW).color(0.8, 0.94, 1.0);
  g.sphere(0, 2.18, 0, 0.06, 6, 4);
  /* the open book, and a second one circling it */
  g.part_(PART.EXTRA, -0.68, 1.46, 0.26);
  g.material(M.MARBLE).color(0.97, 0.96, 0.9);
  g.box(0, 0, 0, 0.36, 0.05, 0.28);
  g.box(0, -0.07, 0, 0.32, 0.045, 0.24);
  g.material(M.GLOW).color(0.8, 0.95, 1.0);
  g.box(0, 0.04, 0, 0.32, 0.03, 0.24);
  g.part_(PART.EXTRA, 0.68, 1.22, 0.14);
  g.material(M.LEATHER).color(0.38, 0.26, 0.42);
  g.box(0, 0, 0, 0.22, 0.3, 0.11);
  /* motes */
  g.part_(PART.EXTRA, 0, 0, 0);
  g.material(M.GLOW).color(0.85, 0.95, 1.0);
  for (const [mx, my, mz] of [[-0.5, 1.7, 0.1], [0.5, 1.7, 0.1], [-0.44, 0.9, 0.16], [0.44, 0.9, 0.16]]) {
    g.sphere(mx, my, mz, 0.05, 6, 4);
  }
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.GLOW).color(0.9, 0.97, 1.0);
  g.sphere(0.05, 0.86, 0.10, 0.13, 7, 5);
  g.part_(PART.BODY, 0, 1.2, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 2.72, stride: 3.0 };
});

/* rank 6 — the robe does not reach the ground, and the air is crowded */
MU('magician_ascendant', () => {
  const g = humanoid({
    torsoCol: [0.94, 0.95, 1.0], legCol: [0.9, 0.93, 1.0],
    sleeveCol: [0.95, 0.96, 1.0], sleeveMat: M.MARBLE,
    skin: [0.92, 0.9, 0.86], helmet: false
  });
  g.part_(PART.BODY, 0, 1.2, 0);
  /* the skirt hovers a hand's width off the grass, and the gap glows */
  g.material(M.MARBLE).color(0.98, 0.97, 0.94);
  g.cyl(0, 0.3, 0, 0.28, 0.46, 1.0, 14, { capTop: false, capBottom: true });
  g.material(M.GLOW).color(0.72, 0.88, 1.0);
  g.cyl(0, 0.27, 0, 0.44, 0.5, 0.05, 14);
  mageRing(g, 0.2, 0.56, 0.03, 16);
  /* gold trim + team sash */
  g.material(M.GOLD).color(1.0, 0.88, 0.5);
  mageRing(g, 1.26, 0.31, 0.04, 12);
  g.material(M.CLOTH).color(1, 1, 1);
  g.panel(0, 1.38, 0.19, 0.44, 0.13, 0.35);
  /* crown: a ring and three points */
  g.material(M.GOLD).color(1.0, 0.9, 0.52);
  mageRing(g, 1.86, 0.19, 0.042, 9);
  g.cone(0, 1.94, 0.17, 0.06, 0.26, 5);
  g.cone(-0.17, 1.94, 0.02, 0.06, 0.2, 5);
  g.cone(0.17, 1.94, 0.02, 0.06, 0.2, 5);
  /* three rings of light */
  g.material(M.GLOW).color(0.75, 0.92, 1.0);
  mageRing(g, 2.18, 0.38, 0.03, 14);
  mageRing(g, 2.34, 0.28, 0.026, 14);
  mageRing(g, 2.48, 0.17, 0.022, 10);
  /* a shard of sky hanging above the crown: the silhouette's top third */
  g.material(M.GLOW).color(0.9, 0.98, 1.0);
  g.sphere(0, 2.86, 0, 0.13, 8, 6);
  g.cone(0, 2.98, 0, 0.1, 0.26, 6);
  g.material(M.GOLD).color(1.0, 0.9, 0.5);
  mageRing(g, 2.76, 0.42, 0.022, 16);
  /* wings: three tapered panels a side, wide enough to read from above */
  g.part_(PART.EXTRA, 0, 1.6, -0.22);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const y = 0.16 - i * 0.36;
      const w = 1.35 - i * 0.26;
      g.material(M.GLOW).color(0.5 + i * 0.08, 0.74 + i * 0.07, 1.0);
      g.taperBox(sx * (0.22 + w * 0.42), y, -0.06, w * 0.86, 0.06, 0.16, w * 0.3, 0.08);
    }
  }
  /* six motes in two rings */
  g.part_(PART.EXTRA, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const r = i % 2 ? 0.46 : 0.66;
    g.material(M.GLOW).color(i % 2 ? 0.9 : 0.7, i % 2 ? 0.97 : 0.86, 1.0);
    g.sphere(Math.cos(a) * r, 1.5 + Math.sin(a * 2) * 0.24, Math.sin(a) * r, 0.06, 6, 4);
  }
  /* the staff is a rod of light with a shard in it */
  g.part_(PART.ARM_R, 0.30, 1.44, 0);
  g.material(M.GLOW).color(0.85, 0.96, 1.0);
  g.beam(0.05, 0.4, 0.10, 0.05, 1.02, 0.10, 0.055);
  g.sphere(0.05, 1.14, 0.10, 0.15, 8, 6);
  g.cone(0.05, 1.4, 0.10, 0.1, 0.34, 6);
  g.part_(PART.BODY, 0, 1.2, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 3.25, stride: 3.0 };
});

/* ---- golem: a walking cairn ---- */
MU('stone_golem', () => {
  const g = new Geo();
  g.material(M.STONE).color(0.62, 0.62, 0.58);
  g.part_(PART.LEG_L, -0.22, 0.9, 0);
  g.box(-0.24, 0.44, 0, 0.34, 0.9, 0.38);
  g.part_(PART.LEG_R, 0.22, 0.9, 0);
  g.box(0.24, 0.44, 0, 0.34, 0.9, 0.38);
  g.part_(PART.BODY, 0, 1.55, 0);
  g.material(M.STONE).color(0.68, 0.68, 0.63);
  g.taperBox(0, 1.55, 0, 1.05, 1.15, 0.7, 1.2, 0.8);
  g.material(M.GRAVEL).color(0.5, 0.5, 0.46);
  g.box(0, 1.1, 0, 1.12, 0.16, 0.76);
  /* neck + head, so the block has a top that reads at a glance */
  g.material(M.STONE).color(0.72, 0.72, 0.67);
  g.box(0, 2.18, 0, 0.34, 0.22, 0.34);
  g.box(0, 2.42, 0.02, 0.5, 0.34, 0.44);
  g.material(M.GRAVEL).color(0.44, 0.44, 0.41);
  g.box(0, 2.52, 0.22, 0.44, 0.09, 0.06);
  g.part_(PART.ARM_L, -0.72, 1.8, 0);
  g.material(M.STONE).color(0.6, 0.6, 0.55);
  g.box(-0.06, -0.5, 0, 0.36, 1.0, 0.4);
  g.box(-0.06, -1.06, 0, 0.44, 0.26, 0.46);
  g.part_(PART.ARM_R, 0.72, 1.8, 0);
  g.box(0.06, -0.5, 0, 0.36, 1.0, 0.4);
  g.box(0.06, -1.06, 0, 0.44, 0.26, 0.46);
  g.material(M.GLOW).color(1.0, 0.72, 0.25);
  g.box(-0.12, 2.44, 0.235, 0.11, 0.07, 0.05);
  g.box(0.12, 2.44, 0.235, 0.11, 0.07, 0.05);
  g.color(1, 1, 1);
  return { geo: g, height: 2.6, stride: 2.2 };
});

/* ---- wolf and bear: low quadruped rigs, no humanoid parts ---- */
function quadruped(g, o) {
  const c = o.col;
  g.material(M.SKIN).color(c[0], c[1], c[2]);
  g.box(0, o.bodyY, 0, o.w, o.h, o.len);
  g.sphere(0, o.bodyY + o.h * 0.18, o.len * 0.52, o.headR, 7, 5);
  g.beam(0, o.bodyY + o.h * 0.3, o.len * 0.5, 0, o.bodyY + o.h * 0.55, o.len * 0.85, o.snout);
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    g.beam(sx * o.w * 0.36, o.bodyY - o.h * 0.4, sz * o.len * 0.34, sx * o.w * 0.4, 0.05, sz * o.len * 0.38, o.leg);
  }
  g.material(M.BARK).color(0.28, 0.22, 0.16);
  g.beam(0, o.bodyY, -o.len * 0.5, 0, o.bodyY + 0.32, -o.len * 0.86, 0.08);
  g.color(1, 1, 1);
}
MU('dire_wolf', () => {
  const g = new Geo();
  quadruped(g, { col: [0.66, 0.58, 0.48], bodyY: 0.78, w: 0.44, h: 0.5, len: 1.35, headR: 0.22, snout: 0.13, leg: 0.1 });
  /* a darker saddle along the back, so the silhouette is not one grey blob */
  g.material(M.BARK).color(0.40, 0.33, 0.26);
  g.box(0, 1.02, -0.02, 0.40, 0.07, 1.05);
  g.material(M.GLOW).color(0.95, 0.72, 0.2);
  g.sphere(-0.09, 0.95, 0.66, 0.035, 4, 3);
  g.sphere(0.09, 0.95, 0.66, 0.035, 4, 3);
  g.color(1, 1, 1);
  return { geo: g, height: 1.25, stride: 3.4 };
});
MU('bear', () => {
  const g = new Geo();
  quadruped(g, { col: [0.58, 0.44, 0.30], bodyY: 0.95, w: 0.72, h: 0.8, len: 1.75, headR: 0.3, snout: 0.2, leg: 0.18 });
  g.material(M.BARK).color(0.38, 0.27, 0.18);
  g.box(0, 1.34, -0.05, 0.6, 0.1, 1.1);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 2.8 };
});
MU('beastmaster', () => {
  const g = humanoid({ torsoCol: [0.34, 0.32, 0.22], torsoMat: M.LEATHER, helmet: false, sleeveCol: [0.3, 0.28, 0.2] });
  g.part_(PART.ARM_R, 0.29, 1.45, 0);
  g.material(M.WOOD).color(0.4, 0.3, 0.2);
  g.beam(0.03, -0.7, 0.08, 0.03, 0.9, 0.08, 0.05);
  g.material(M.METAL).color(0.75, 0.75, 0.78);
  g.cone(0.03, 1.02, 0.08, 0.07, 0.24, 5);
  g.material(M.CLOTH).color(0.5, 0.42, 0.2);
  g.panel(0, 1.3, -0.16, 0.36, 0.6, 0);
  g.color(1, 1, 1);
  return { geo: g, height: 1.9, stride: 2.9 };
});

/* ---- necropolis: a crypt that breathes green light ---- */
MB('necropolis', () => {
  const g = new Geo();
  plinth(g, 4.4, 4.4, 0.4);
  g.material(M.STONE).color(0.34, 0.35, 0.32);
  g.box(0, 1.5, 0, 3.8, 2.4, 3.8);
  g.material(M.STONE).color(0.28, 0.29, 0.27);
  g.box(0, 2.85, 0, 4.1, 0.3, 4.1);
  g.battlements(0, 3.0, 0, 4.1, 4.1, 0.5, 0.34, 0.3);
  /* skull-topped pillars either side of the door */
  for (const sx of [-1, 1]) {
    g.material(M.MARBLE).color(0.72, 0.72, 0.66);
    g.cyl(sx * 1.45, 1.4, 1.92, 0.22, 0.26, 2.6, 8, { capTop: false });
    g.material(M.STONE).color(0.82, 0.8, 0.74);
    g.sphere(sx * 1.45, 2.85, 1.92, 0.26, 7, 5);
  }
  g.material(M.WOOD_DARK).color(0.2, 0.16, 0.14);
  g.box(0, 1.0, 1.92, 1.5, 2.0, 0.14);
  g.material(M.GLOW).color(0.4, 1.0, 0.45);
  g.box(0, 2.3, 1.94, 1.6, 0.1, 0.06);
  g.sphere(0, 3.35, 0, 0.34, 8, 5);
  g.color(1, 1, 1);
  return { geo: g, height: 5.4 };
});

/* ---- ballista tower: a squat tower with a war engine on the roof ---- */
MB('ballista_tower', () => {
  const g = new Geo();
  plinth(g, 3.2, 3.2, 0.35);
  g.material(M.STONE).color(0.7, 0.68, 0.63);
  g.taperBox(0, 2.4, 0, 3.0, 4.1, 3.0, 2.4, 2.4);
  g.material(M.STONE).color(0.8, 0.78, 0.74);
  g.box(0, 4.5, 0, 3.0, 0.3, 3.0);
  g.battlements(0, 4.65, 0, 3.0, 3.0, 0.5, 0.36, 0.3);
  /* engine */
  g.material(M.WOOD).color(0.44, 0.32, 0.2);
  g.box(0, 4.78, 0, 1.6, 0.24, 1.2);
  g.beam(-0.55, 4.9, -0.9, 0.55, 4.9, -0.9, 0.12);
  g.material(M.METAL).color(0.62, 0.62, 0.66);
  g.beam(0, 5.05, -0.9, 0, 5.05, 1.15, 0.1);
  g.material(M.CLOTH).color(0.6, 0.2, 0.18);
  g.panel(0, 5.2, 0.5, 0.5, 0.3, 0);
  g.window(0, 2.2, 1.52, 0.5, 0.7);
  g.color(1, 1, 1);
  return { geo: g, height: 5.6 };
});

/* ---- spike trap: a low ring of iron spikes and timber ---- */
MB('spike_trap', () => {
  const g = new Geo();
  g.material(M.DIRT).color(0.34, 0.3, 0.24);
  g.cyl(0, 0.05, 0, 1.0, 1.05, 0.14, 10);
  g.material(M.WOOD_DARK).color(0.3, 0.22, 0.16);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.2;
    g.beam(Math.cos(a) * 0.72, 0.1, Math.sin(a) * 0.72, Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2, 0.07);
  }
  g.material(M.METAL).color(0.66, 0.66, 0.7);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    g.cone(Math.cos(a) * 0.34, 0.12, Math.sin(a) * 0.34, 0.09, 0.62, 5);
  }
  g.cone(0, 0.12, 0, 0.12, 0.8, 6);
  g.color(1, 1, 1);
  return { geo: g, height: 0.9 };
});

/* ---- relic shrine: a small altar under a floating stone ---- */
MB('relic_shrine', () => {
  const g = new Geo();
  g.material(M.MARBLE).color(0.8, 0.78, 0.72);
  g.cyl(0, 0.18, 0, 1.1, 1.25, 0.36, 8);
  g.cyl(0, 0.5, 0, 0.72, 0.86, 0.4, 8);
  g.box(0, 0.78, 0, 0.86, 0.16, 0.86);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.cyl(sx * 0.62, 0.95, sz * 0.62, 0.1, 0.12, 1.5, 6, { capTop: false });
  }
  g.material(M.MARBLE).color(0.86, 0.84, 0.78);
  g.box(0, 1.78, 0, 1.5, 0.16, 1.5);
  g.material(M.GOLD).color(0.9, 0.74, 0.3);
  g.sphere(0, 2.1, 0, 0.3, 8, 5);
  g.color(1, 1, 1);
  return { geo: g, height: 2.6 };
});

/** Types that installModModels() can add. */
export function modModelTypes() {
  return { units: Object.keys(MOD_UNITS), buildings: Object.keys(MOD_BUILDINGS) };
}

/** Copy the mod builders into the live registries (idempotent). */
export function installModModels() {
  for (const [k, fn] of Object.entries(MOD_UNITS)) UNITS[k] = fn;
  for (const [k, fn] of Object.entries(MOD_BUILDINGS)) BUILDERS[k] = fn;
  return modModelTypes();
}

/* ============================================================
   public API
   ============================================================ */
export function buildBuilding(type) {
  const fn = BUILDERS[type] || BUILDERS.house;
  const res = fn();
  return res;
}
export function buildUnit(type) {
  const fn = UNITS[type];
  if (!fn) return null;
  const res = fn();
  res.height = res.height || 1.8;
  res.stride = res.stride || 3.0;
  return res;
}
export function buildProp(name) {
  const fn = PROPS[name] || PROPS.rock;
  return fn();
}

export const BUILDING_TYPES = Object.keys(BUILDERS);
export const UNIT_TYPES = Object.keys(UNITS);
export const PROP_TYPES = Object.keys(PROPS);

/** Quick triangle census for loaders and tests. */
export function census() {
  const out = { buildings: {}, units: {}, props: {} };
  let total = 0;
  for (const t of BUILDING_TYPES) { const r = buildBuilding(t).geo.finish(); out.buildings[t] = r.tris; total += r.tris; }
  for (const t of UNIT_TYPES) { const r = buildUnit(t); if (r) { const f = r.geo.finish(); out.units[t] = f.tris; total += f.tris; } }
  for (const t of PROP_TYPES) { const r = buildProp(t).geo.finish(); out.props[t] = r.tris; total += r.tris; }
  out.total = total;
  return out;
}
