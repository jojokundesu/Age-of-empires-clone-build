/* ============================================================
   renderer.js — Imperial Crown v3 render pipeline

   Pass order (v3):
     shadow (throttled, texel-snapped) → terrain → models → ammo
       → sky (depth EQUAL, so it only shades what nothing covered)
       → water → decals → billboards → particles → post

   Everything here is written for a mid-range mobile GPU (Adreno 610,
   Mali-G52, PowerVR GE8320). The rules the file follows:

     • no per-pixel procedural noise -- fields are baked (see bake.js)
     • back-face culling wherever the mesh is closed (see geo.js; v2 could
       not cull because half its roofs and beams were wound inside-out)
     • every instance is frustum-culled before it is pushed into a buffer
     • draws are grouped by cull state so the driver sees long runs of one
       pipeline state
     • the sky is drawn last, against the depth buffer: zero overdraw
     • the shadow map updates at 30 Hz and snaps to its texel grid, which is
       invisible and halves the depth-pass cost
     • no allocation inside render(): every scratch object lives on `this`
   ============================================================ */
import {
  createGL, Shader, Mesh, RenderTarget, ShadowMap,
  createFullscreenVAO, drawFullscreen, invalidateTextureCache
} from '../core/gl.js';
import {
  clamp, lerp, m4ortho, m4lookAt, m4mul, m4trs, mat4, m4identity, TAU
} from '../core/math.js';
import {
  SKY_VS, SKY_FS, TERRAIN_VS, TERRAIN_FS, MODEL_VS, MODEL_FS, SHADOW_VS, SHADOW_FS,
  WATER_VS, WATER_FS, PARTICLE_VS, PARTICLE_FS, BILLBOARD_VS, BILLBOARD_FS,
  DECAL_VS, DECAL_FS, POST_VS, POST_FS
} from './shaders.js';
import { InstanceBatch, QuadBatch } from './batch.js';
import { buildTextures, uploadBaked, MAT, SPRITE } from './textures.js';
import { bakeTerrain } from './bake.js';
import { buildBuilding, buildUnit, buildProp, buildGateDoor, BUILDING_TYPES, UNIT_TYPES } from './models.js';
import { extractPlanes, sphereInFrustum } from './camera.js';
import { BUILDING_DEFS } from '../sim/data.js';
import { buildRenderTerrain } from '../sim/worldgen.js';
import { TIERS, renderSize } from './quality.js';

export { MAT, SPRITE };

/* The ladder now lives in quality.js, where it is a set of *pixel budgets*
   rather than DPR multipliers. Re-exported so every existing importer (and the
   test suite) keeps working. */
export const QUALITY = TIERS;

/** sRGB team colours (authored by eye, used for HUD-ish tinting). */
const TEAM_RGB = {
  1: [0.32, 0.55, 0.98],
  2: [0.95, 0.28, 0.22],
  0: [0.85, 0.72, 0.42],
  3: [0.5, 0.82, 0.3],
  4: [0.78, 0.52, 0.95]
};

/** The same palette in linear space, for the model shader (no pow() per px). */
const TEAM_LINEAR = (() => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const out = {};
  for (const k of Object.keys(TEAM_RGB)) {
    out[k] = TEAM_RGB[k].map(lin);
  }
  return out;
})();

/** Models that should not sway in the wind (masonry, ships, siege). */
const NO_SWAY = new Set(['stone_wall', 'palissade_wall', 'stone_gate', 'castle', 'wonder',
  'dock', 'outpost_shrine', 'fishing_boat', 'transport_ship', 'war_galley', 'fire_ship',
  'demo_ship', 'cannon_galleon', 'ram', 'mangonel', 'trebuchet', 'bombard_cannon', 'farm']);

const RES_MODELS = {
  tree: 'tree1',
  gold_mine: 'gold_mine',
  stone_mine: 'stone_mine',
  berry_bush: 'berry_bush',
  deer: 'deer',
  boar: 'boar',
  fish: 'fish',
  relic: 'relic'
};

const TREE_VARIANTS = ['tree0', 'tree1', 'tree2', 'tree3'];
/* Two LODs of every tree, resolved once. Building these keys with `+= 'L'`
   inside the resource loop allocated a fresh string for every distant tree on
   every frame -- a forest's worth of garbage per second, for no reason. */
const TREE_VARIANTS_LOD = TREE_VARIANTS.map((k) => k + 'L');
/* Falsy fallbacks, hoisted: a literal inside the per-unit loop allocates an
   object per unit per frame, which is exactly the kind of steady garbage that
   turns into a minor GC inside the frame budget on a phone. */
const TERRAIN_TEX = 512;    // texels across the 512 m island (1 per metre)
const NO_ANIM = Object.freeze({ phase: 0, speed: 0, attack: 0, spin: 0 });
const UNIT_META_FALLBACK = Object.freeze({ height: 1.8, stride: 3, mounted: false, siege: false, naval: false });

/* Ground clutter that is thin enough to be seen from both sides (grass tufts,
   reeds, fence rails) stays two-sided; everything else is culled. */
const TWO_SIDED_PROPS = new Set(['tuft', 'reed', 'fence', 'drying_rack', 'flower', 'pebble']);

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.gl = createGL(canvas, opts.gl);
    this.ok = !!this.gl;
    this.qualityName = QUALITY[opts.quality] ? opts.quality : 'medium';
    this.quality = QUALITY[this.qualityName] || QUALITY.medium;
    /* The one number that decides whether this runs at 90 fps: how many
       pixels we shade. It is set by the governor in quality.js. */
    this.pixelBudget = this.quality.pixelBudget;
    this.pixelScale = 1;
    this.postEnabled = !!this.quality.post;
    this.width = 1; this.height = 1;
    this.renderW = 1; this.renderH = 1;
    this.scale = 1;
    this.time = 0;
    this.worldTime = 8.5;
    this.dayLength = 720;
    this.sunDir = new Float32Array([0.4, 0.7, 0.3]);
    this.sunColor = new Float32Array([1.35, 1.2, 1.0]);
    this.skyColor = new Float32Array([0.4, 0.55, 0.75]);
    this.groundColor = new Float32Array([0.24, 0.2, 0.15]);
    this.fogColor = new Float32Array([0.6, 0.68, 0.76]);
    this.zenith = new Float32Array([0.16, 0.3, 0.55]);
    this.horizon = new Float32Array([0.7, 0.76, 0.8]);
    this.cloudOffset = new Float32Array([0, 0]);
    this.cloudCover = 0.5;
    this.cloudStrength = this.quality.clouds ?? 0.085;
    this.starAmount = 0;
    this.moonAmount = 0;
    this.moonDir = new Float32Array([0.3, 0.62, -0.72]);
    this.night = 0;
    this.exposure = 1;
    this.fogDensity = 0.0032;
    this.shadowMatrix = mat4();
    this.frustum = new Float32Array(24);
    this.stats = {
      drawCalls: 0, tris: 0, instances: 0, particles: 0,
      shadowDraws: 0, culled: 0, shadow: false
    };
    this.ready = false;
    this.ctxLost = false;
    this.townLight = new Float32Array(12);
    this.townLightY = new Float32Array(4);
    this.townLightI = 0;
    this.townLightColor = new Float32Array([1.55, 0.90, 0.42]);
    this.fogTexture = null;
    this.fogEnabled = false;
    this.playerTeam = 1;
    // scratch
    this._mB = mat4(); this._mR = mat4(); this._mOut = mat4(); this._mS = mat4(); this._mDoor = mat4();
    this._propCam = { x: 1e9, z: 1e9, t: 0 };
    this._activeProps = [];
    this._activeBatches = [];
    this._cullBatches = [];
    this._noCullBatches = [];
    this.propDirty = true;
    this._frame = 0;
    this._byNear = (a, b) => (a._near === undefined ? 1e18 : a._near) - (b._near === undefined ? 1e18 : b._near);
    this._shadowT = 0;
    this._shadowKey = '';
    this._lastCamPos = [0, 0, 0];
    this._frameMs = 16.7;
    this.adaptiveScale = 1;
    // live counters that the perf tests read
    this.frameCount = 0;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ctxLost = true; }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      this.ctxLost = false;
      if (this.onContextRestored) this.onContextRestored();
    }, false);
  }

  /* ================= init ================= */
  async init(onProgress = () => {}) {
    const gl = this.gl;
    if (!gl) return this;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    onProgress('Grinding stone and weaving cloth…', 0.04);
    await frame();
    this.textures = buildTextures(gl, onProgress);
    onProgress('Compiling shaders…', 0.66);
    await frame();
    this.pSky = new Shader(gl, 'sky', SKY_VS, SKY_FS);
    this.pTerrain = new Shader(gl, 'terrain', TERRAIN_VS, TERRAIN_FS);
    this.pModel = new Shader(gl, 'model', MODEL_VS, MODEL_FS);
    this.pShadow = new Shader(gl, 'shadow', SHADOW_VS, SHADOW_FS);
    this.pWater = new Shader(gl, 'water', WATER_VS, WATER_FS);
    this.pParticle = new Shader(gl, 'particle', PARTICLE_VS, PARTICLE_FS);
    this.pBillboard = new Shader(gl, 'billboard', BILLBOARD_VS, BILLBOARD_FS);
    this.pDecal = new Shader(gl, 'decal', DECAL_VS, DECAL_FS);
    this.pPost = new Shader(gl, 'post', POST_VS, POST_FS);
    this.fsTri = createFullscreenVAO(gl);
    this.emptyVao = gl.createVertexArray();

    onProgress('Raising walls and roofs…', 0.72);
    await frame();
    this.buildingBatches = new Map();
    this.buildingMeta = new Map();
    for (const type of BUILDING_TYPES) {
      const res = buildBuilding(type);
      const geo = res.geo.finish();
      const def = BUILDING_DEFS[type] || {};
      const max = (type === 'stone_wall' || type === 'palissade_wall') ? 320
        : (type === 'house') ? 70 : (type === 'farm') ? 60 : 16;
      const batch = new InstanceBatch(gl, geo, max);
      batch.cull = true;
      this.buildingBatches.set(type, batch);
      this.buildingMeta.set(type, {
        height: res.height || 4,
        footprint: def.size || 3,
        radius: (def.size || 3) * 0.72
      });
    }
    /* gate leaves are animated, so they get their own tiny batch */
    this.gateDoorBatch = new InstanceBatch(gl, buildGateDoor(), 40);
    this.gateDoorBatch.cull = true;

    onProgress('Assembling armies…', 0.8);
    await frame();
    this.unitBatches = new Map();
    this.unitMeta = new Map();
    for (const type of UNIT_TYPES) {
      const res = buildUnit(type);
      if (!res) continue;
      const geo = res.geo.finish();
      const batch = new InstanceBatch(gl, geo, type === 'villager' ? 160 : 90);
      batch.cull = true;
      this.unitBatches.set(type, batch);
      this.unitMeta.set(type, {
        height: res.height, stride: res.stride,
        mounted: !!res.mounted, siege: !!res.siege, naval: !!res.naval
      });
    }

    onProgress('Growing forests…', 0.88);
    await frame();
    this.propBatches = new Map();
    this.resBatches = new Map();
    const decorNames = ['bush', 'rock', 'stump', 'reed', 'tuft', 'flower', 'pebble', 'log', 'ruin',
      'crate', 'barrel', 'haystack', 'firewood', 'cart', 'well', 'fence', 'drying_rack'];
    for (const name of decorNames) {
      const res = buildProp(name);
      if (!res) continue;
      const batch = new InstanceBatch(gl, res.geo.finish(), 900);
      /* Ground clutter smaller than a dog casts a shadow nobody can see at an
         RTS camera, and the shadow pass would redraw every one of those
         batches. Skipping them roughly halves the cost of the prop set. */
      batch.noShadow = true;
      batch.cull = !TWO_SIDED_PROPS.has(name);
      this.propBatches.set(name, batch);
    }
    const fireRes = buildProp('brazier');
    this.fireBatch = new InstanceBatch(gl, fireRes.geo.finish(), 4);
    this.fireBatch.cull = true;
    const resNames = ['tree0', 'tree1', 'tree2', 'tree3', 'tree0L', 'tree1L', 'tree2L', 'tree3L',
      'gold_mine', 'stone_mine', 'berry_bush', 'deer', 'boar', 'fish', 'relic'];
    for (const name of resNames) {
      const res = buildProp(name.endsWith('L') ? 'tree_lod' : name);
      if (!res) continue;
      const batch = new InstanceBatch(gl, res.geo.finish(), name.startsWith('tree') ? 700 : 120);
      batch.cull = true;
      this.resBatches.set(name, batch);
    }

    onProgress('Fletching arrows…', 0.94);
    await frame();
    this.arrowGeo = this._makeArrowGeo();
    this.boulderGeo = this._makeBoulderGeo();
    this.arrowBatch = new InstanceBatch(gl, this.arrowGeo, 300);
    this.arrowBatch.cull = true;
    this.boulderBatch = new InstanceBatch(gl, this.boulderGeo, 80);
    this.boulderBatch.cull = true;

    this.particleAlpha = new QuadBatch(gl, 12, 900);
    this.particleAdd = new QuadBatch(gl, 12, 900);
    this.billboards = new QuadBatch(gl, 12, 700);
    this.decals = new QuadBatch(gl, 12, 320);

    this._createShadowTarget(this.quality.shadowSize);
    this.postTarget = null;
    this.ready = true;
    onProgress('Ready.', 1);
    return this;
  }

  _makeArrowGeo() {
    return this._geoBox(0.035, 0.035, 0.92, 3, [0.72, 0.56, 0.34]);
  }
  _makeBoulderGeo() {
    return this._geoBox(0.42, 0.42, 0.42, 5, [0.55, 0.53, 0.5]);
  }
  /** Tiny local cube builder so ammo meshes don't need the model library. */
  _geoBox(w, h, d, mat, col) {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const v = [];
    const i = [];
    const faces = [
      [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd], [0, 0, 1]],
      [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd], [0, 0, -1]],
      [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-1, 0, 0]],
      [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [1, 0, 0]],
      [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd], [0, 1, 0]],
      [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd], [0, -1, 0]]
    ];
    for (const f of faces) {
      const base = v.length / 16;
      for (let k = 0; k < 4; k++) {
        const p = f[k], n = f[4];
        v.push(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0, mat, col[0], col[1], col[2], 0, 0, 0, 0);
      }
      i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { v: new Float32Array(v), i: new Uint16Array(i), tris: i.length / 3 };
  }

  _createShadowTarget(size) {
    if (this.shadowTarget) this.shadowTarget.dispose();
    this.shadowSize = size;
    this.shadowTarget = new ShadowMap(this.gl, size);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    const changed = name !== this.qualityName;
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.cloudStrength = this.quality.clouds !== undefined ? this.quality.clouds : 0.085;
    this.pixelBudget = Math.round(this.quality.pixelBudget * (this.pixelScale || 1) ** 2);
    this.postEnabled = !!this.quality.post;
    if (changed) {
      this._createShadowTarget(this.quality.shadowSize);
      this.propDirty = true;
    }
    this.renderW = 0;
    this.resize();
  }

  /** The governor's resolution lever (a multiplier on the tier's pixel budget). */
  setPixelScale(s) {
    const v = Math.min(1, Math.max(0.4, s));
    if (Math.abs(v - (this.pixelScale || 1)) < 1e-4) return;
    this.pixelScale = v;
    this.pixelBudget = Math.round(this.quality.pixelBudget * v * v);
    this.renderW = 0;
    this.resize();
  }

  /* ================= world ================= */
  /** Free GPU memory from a previous world so restarts never leak. */
  _disposeWorld() {
    const gl = this.gl;
    for (const c of this.chunks || []) c.mesh.dispose();
    this.chunks = [];
    if (this.waterMesh) { this.waterMesh.dispose(); this.waterMesh = null; }
    if (this.heightTex) { gl.deleteTexture(this.heightTex); this.heightTex = null; }
    if (this.terrainAlbedo) { gl.deleteTexture(this.terrainAlbedo); this.terrainAlbedo = null; }
    this.propCells = null;
  }

  buildWorld(world, opts = {}) {
    const gl = this.gl;
    this._disposeWorld();
    this.world = world;
    this.heightAt = world.heightAt || ((x, z) => world.height.sample(x, z));
    const RT = buildRenderTerrain(world);
    this.terrain = RT;
    const VN = RT.n;
    const HEIGHT_RANGE = 46;
    const HEIGHT_BIAS = 8;
    const data = new Uint8Array(VN * VN);
    for (let i = 0; i < VN * VN; i++) {
      data[i] = clamp(((RT.heights[i] + HEIGHT_BIAS) / HEIGHT_RANGE) * 255, 0, 255);
    }
    this.heightTex = upload8(gl, data, VN, VN);

    /* The whole ground albedo, baked once. v2 evaluated this per fragment:
       six texture fetches, seven fbm fields and a flower lattice on every
       pixel of the screen. One 512x512 sRGB map now carries all of it. */
    const t0 = now();
    /* One texel per metre over the 512 m island: the *large* structure of the
       land (field patchwork, dry pockets, the painted splat). A 1024 map costs
       1.4 s of extra bake on a desktop and ~8 s on the target phone for a
       ground that is still blurry where it matters, so the close-up structure
       comes from the 4 m detail tile in the shader instead -- it is already
       mip-mapped, it costs one fetch, and it is the part the eye reads. */
    const albedo = bakeTerrain(world, RT, this.textures.terrainLayers, {
      size: TERRAIN_TEX, cloudData: this.textures.cloudData, cloudSize: 512
    });
    this.terrainAlbedo = uploadBaked(gl, albedo, TERRAIN_TEX, TERRAIN_TEX, {
      srgb: true, aniso: 4, wrap: gl.CLAMP_TO_EDGE
    });
    this.bakeMs = now() - t0;
    if (opts.onBake) opts.onBake(this.bakeMs);

    this._buildTerrain(RT);
    this._buildWater();
    this._bucketProps(world);
    return this;
  }

  _buildTerrain(RT) {
    const gl = this.gl;
    const VN = RT.n, cell = RT.cell, HALF = RT.size * 0.5;
    const heights = RT.heights;
    const cellsPerChunk = 32;
    const chunkCount = Math.ceil((VN - 1) / cellsPerChunk);
    this.chunks = [];
    for (let cz = 0; cz < chunkCount; cz++) {
      for (let cx = 0; cx < chunkCount; cx++) {
        const i0 = cx * cellsPerChunk, j0 = cz * cellsPerChunk;
        if (i0 >= VN - 1 || j0 >= VN - 1) continue;
        const w = Math.min(cellsPerChunk, VN - 1 - i0) + 1;
        const h = Math.min(cellsPerChunk, VN - 1 - j0) + 1;
        // pos(3) + normal(3): the splat is baked into the albedo now, so the
        // vertex is half the size it was and the fetch unit has less to read
        const verts = new Float32Array(w * h * 6);
        let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const gi = i0 + i, gj = j0 + j;
            const k = gj * VN + gi;
            const x = gi * cell - HALF, z = gj * cell - HALF;
            const y = heights[k];
            const o = (j * w + i) * 6;
            verts[o] = x; verts[o + 1] = y; verts[o + 2] = z;
            const hl = heights[k - (gi > 0 ? 1 : 0)];
            const hr = heights[k + (gi < VN - 1 ? 1 : 0)];
            const hd = heights[k - (gj > 0 ? VN : 0)];
            const hu = heights[k + (gj < VN - 1 ? VN : 0)];
            let nx = hl - hr, ny = 2 * cell, nz = hd - hu;
            const nl = Math.hypot(nx, ny, nz) || 1;
            verts[o + 3] = nx / nl; verts[o + 4] = ny / nl; verts[o + 5] = nz / nl;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
        }
        const idx = new Uint16Array((w - 1) * (h - 1) * 6);
        let t = 0;
        for (let j = 0; j < h - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
            idx[t++] = a; idx[t++] = c; idx[t++] = b;
            idx[t++] = b; idx[t++] = c; idx[t++] = d;
          }
        }
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        const mesh = new Mesh(gl, vao, vbo, ibo, idx.length, gl.UNSIGNED_SHORT);
        mesh.triCount = idx.length / 3;
        this.chunks.push({
          mesh,
          cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
          radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5,
          y: (minY + maxY) / 2,
          d2: 0
        });
      }
    }
  }

  _buildWater() {
    const gl = this.gl;
    const N = 64, span = 512, half = span / 2;
    const verts = new Float32Array((N + 1) * (N + 1) * 3);
    let p = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      verts[p++] = -half + (i / N) * span;
      verts[p++] = 0.16;
      verts[p++] = -half + (j / N) * span;
    }
    const idx = new Uint32Array(N * N * 6);
    let t = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    this.waterMesh = new Mesh(gl, vao, vbo, ibo, idx.length, gl.UNSIGNED_INT);
    this.waterMesh.triCount = idx.length / 3;
  }

  /** Bucket static decor into 64 m cells per prop kind for cheap culling. */
  _bucketProps(world) {
    this.propCells = new Map();
    this.propCount = 0;
    const CELL = 64, HALF = 256;
    const add = (kind, x, y, z, rot, scale, tint) => {
      if (!this.propBatches.has(kind)) return;
      const cx = clamp(Math.floor((x + HALF) / CELL), 0, 7);
      const cz = clamp(Math.floor((z + HALF) / CELL), 0, 7);
      const key = cz * 8 + cx;
      if (!this.propCells.has(kind)) this.propCells.set(kind, new Map());
      const map = this.propCells.get(kind);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ x, y, z, rot, scale, tint });
      this.propCount++;
    };
    for (const d of world.decor || []) {
      add(d.type, d.x, d.y ?? world.heightAt(d.x, d.z), d.z, d.rot || 0, d.scale || 1, d.tint || 0);
    }
    // scattered ruins for a sense of history
    let r = 0;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU + 1.2;
      const rad = 70 + (i % 5) * 26;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const y = world.heightAt(x, z);
      if (y > 0.5) { add('ruin', x, y, z, a * 2.3, 0.8 + (i % 3) * 0.2, (r = (i % 7) / 7)); }
    }
    this.propDirty = true;
  }

  /**
   * Upload the fog-of-war mask. The organic rim that v2 generated with two
   * noise octaves *per fragment* is added here instead: 64x64 texels, five
   * times a second, on the CPU.
   */
  setFog(data, size) {
    const gl = this.gl;
    const dither = this.textures && this.textures.fogDither;
    let src = data;
    if (dither) {
      if (!this._fogScratch || this._fogScratch.length !== data.length) {
        this._fogScratch = new Uint8Array(data.length);
      }
      src = this._fogScratch;
      const DS = 64;
      for (let y = 0; y < size; y++) {
        const dy = ((y / size) * DS) | 0;
        for (let x = 0; x < size; x++) {
          const dx = ((x / size) * DS) | 0;
          const n = dither[dy * DS + dx];
          const v = data[y * size + x] + n * 20 + n * n * 6;
          src[y * size + x] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    if (!this.fogTexture) {
      this.fogTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, src);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, src);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /* ================= environment ================= */
  updateEnvironment(dt, worldTime) {
    this.time += dt;
    this.worldTime = ((worldTime % 24) + 24) % 24;
    const hour = this.worldTime;
    const dayT = (hour - 5.5) / 13.5;
    const elev = Math.sin(clamp(dayT, -0.35, 1.35) * Math.PI) * 1.15;
    const az = Math.PI * (0.16 + clamp(dayT, -0.25, 1.25) * 0.94);
    let sx = Math.cos(az) * Math.cos(elev) * 0.95;
    let sy = Math.sin(elev);
    let sz = Math.sin(az) * Math.cos(elev) * 0.85 + 0.2;
    const len = Math.hypot(sx, sy, sz) || 1;
    sx /= len; sy /= len; sz /= len;

    const isNight = hour < 5.9 || hour > 19.2;
    const lowSun = clamp(1 - clamp(sy / 0.5, 0, 1), 0, 1);
    const dusk = clamp(1 - clamp(sy / 0.25, 0, 1), 0, 1);

    if (!isNight) {
      this.sunDir[0] = sx; this.sunDir[1] = Math.max(sy, 0.16); this.sunDir[2] = sz;
    } else {
      this.sunDir[0] = -sx * 0.6; this.sunDir[1] = Math.max(-sy * 0.8, 0.5); this.sunDir[2] = -sz * 0.6;
    }
    const sl = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]) || 1;
    this.sunDir[0] /= sl; this.sunDir[1] /= sl; this.sunDir[2] /= sl;

    if (!isNight) {
      const warm = lowSun;
      this.sunColor[0] = lerp(1.60, 1.85, warm);
      this.sunColor[1] = lerp(1.50, 1.07, warm);
      this.sunColor[2] = lerp(1.34, 0.66, warm);
      this.zenith[0] = lerp(0.13, 0.19, warm);
      this.zenith[1] = lerp(0.30, 0.31, warm);
      this.zenith[2] = lerp(0.58, 0.46, warm);
      this.horizon[0] = lerp(0.60, 0.98, warm);
      this.horizon[1] = lerp(0.74, 0.70, warm);
      this.horizon[2] = lerp(0.86, 0.54, warm);
      this.fogColor[0] = lerp(0.40, 0.62, warm);
      this.fogColor[1] = lerp(0.46, 0.46, warm);
      this.fogColor[2] = lerp(0.52, 0.36, warm);
      this.skyColor[0] = lerp(0.30, 0.44, warm);
      this.skyColor[1] = lerp(0.40, 0.38, warm);
      this.skyColor[2] = lerp(0.56, 0.34, warm);
      this.groundColor[0] = lerp(0.15, 0.20, warm);
      this.groundColor[1] = lerp(0.14, 0.14, warm);
      this.groundColor[2] = lerp(0.11, 0.09, warm);
      this.night = dusk * 0.35;
      this.starAmount = 0;
      this.exposure = lerp(1.0, 1.06, warm);
    } else {
      this.sunColor[0] = 0.20; this.sunColor[1] = 0.26; this.sunColor[2] = 0.42;
      this.zenith[0] = 0.028; this.zenith[1] = 0.042; this.zenith[2] = 0.085;
      this.horizon[0] = 0.075; this.horizon[1] = 0.095; this.horizon[2] = 0.155;
      this.fogColor[0] = 0.045; this.fogColor[1] = 0.06; this.fogColor[2] = 0.10;
      this.skyColor[0] = 0.075; this.skyColor[1] = 0.09; this.skyColor[2] = 0.15;
      this.groundColor[0] = 0.03; this.groundColor[1] = 0.034; this.groundColor[2] = 0.05;
      this.night = 1;
      this.starAmount = 1;
      this.exposure = 1.35;
    }
    /* The moon runs the opposite half of the sky to the sun and keeps a low
       arc (peak ~34 degrees), so it is actually inside the frame when the
       player tilts the camera down toward the horizon. */
    const moonT = (((hour + 12) % 24) - 5.5) / 13.5;
    const mArc = Math.max(0, Math.sin(clamp(moonT, -0.35, 1.35) * Math.PI));
    const mElev = 0.02 + 0.10 * Math.pow(mArc, 1.3);
    const mAz = Math.PI * (0.16 + clamp(moonT, -0.25, 1.25) * 0.94);
    const me = Math.max(mElev, 0.02);
    const mx = Math.cos(mAz) * Math.cos(me);
    const my = Math.sin(me);
    const mz = Math.sin(mAz) * Math.cos(me) * 0.85 + 0.2;
    const ml = Math.hypot(mx, my, mz) || 1;
    this.moonDir[0] = mx / ml; this.moonDir[1] = my / ml; this.moonDir[2] = mz / ml;
    this.moonAmount = isNight ? 1 : clamp((this.night - 0.22) / 0.45, 0, 1);
    this.cloudCover = isNight ? 0.38 : 0.52;
    this.townLightI = clamp((this.night - 0.15) / 0.55, 0, 1);
    this.cloudOffset[0] += dt * 0.0018;
    this.cloudOffset[1] += dt * 0.0009;
    this.fogDensity = 0.00105 + lowSun * 0.0007;
  }

  /**
   * Resize the drawing buffer to the tier's *pixel budget*, not to
   * `css × devicePixelRatio × a multiplier`. On the target phone DPR is 3, so
   * the old formula asked for 2.6 megapixels of shading while the budget for a
   * 90 Hz Adreno 610 is well under one. The canvas keeps its CSS size, so the
   * compositor upscales the buffer for free -- and, because the HUD is real DOM,
   * the interface stays at native crispness either way.
   */
  resize() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.dprNative = dpr;
    const cw = canvas.clientWidth || window.innerWidth || 800;
    const ch = canvas.clientHeight || window.innerHeight || 450;
    /* On a desktop (DPR 1) the budget would *downscale* a 1080p window, which
       is a visible loss of sharpness on hardware that does not need it. There
       the budget becomes a floor on the native pixel count instead, still
       subject to the governor's scale so a slow desktop still gets helped. */
    const maxDpr = this.quality.maxDpr || 3;
    const native = Math.min(dpr, maxDpr);
    const crisp = dpr <= 1.25
      ? Math.min(cw * ch * native * native, 2.4e6) * (this.pixelScale || 1) ** 2
      : 0;
    const { w, h } = renderSize(cw, ch, Math.max(this.pixelBudget, crisp), dpr, maxDpr);
    if (w === this.renderW && h === this.renderH && canvas.width === w && canvas.height === h) return;
    this.renderW = w; this.renderH = h;
    canvas.width = w; canvas.height = h;
    const gl = this.gl;
    if (this.postTarget) { this.postTarget.dispose(); this.postTarget = null; }
    if (this.postEnabled && this.quality.sharpen > 0) {
      /* The scene is rendered *into* this target, so it needs the depth
         attachment: without it every fragment passes the depth test, the sky
         pass (which draws only where depth == 1) covers the whole frame, and
         the town comes out as a white-out. */
      this.postTarget = new RenderTarget(gl, w, h, { depth: true });
    }
    this.width = cw; this.height = ch;
    gl.viewport(0, 0, w, h);
  }

  /** Kept for the old call sites: same lever, new name. */
  setRenderScale(s) { this.setPixelScale(s); }

  /* The old adaptive ladder lived here and fought the frame-rate cap: it
     raised resolution whenever the *average* frame was fast, which on a 90 Hz
     panel is true even when every third frame is late. The governor in
     quality.js now owns resolution, tier and the refresh divisor together. */
  adapt() {}

  /* ================= frame ================= */
  render(dt, game) {
    this._alpha = game && game.renderAlpha !== undefined ? game.renderAlpha : 1;
    if (this.ctxLost || !this.ready || !this.gl) return;
    const gl = this.gl;
    const st = this.stats;
    st.drawCalls = 0; st.tris = 0; st.instances = 0; st.particles = 0;
    st.shadowDraws = 0; st.culled = 0; st.shadow = false;
    this._frame++;
    this.frameCount++;
    /* Uploads done between frames (the fog mask, a material upgrade) left the
       texture-unit cache lying; one array fill per frame keeps it honest. */
    invalidateTextureCache(gl);
    this.resize();
    const cam = game.camera;
    this.updateEnvironment(dt, game.worldTime);
    extractPlanes(cam.viewProj, this.frustum);
    this.fogEnabled = !!(game.settings && game.settings.fog);
    this._cam = cam;

    this._fillInstances(game, cam, dt);
    this._pickTownLights(game, cam, dt);
    this._fillFires(cam);
    this._shadowPass(cam, dt);

    const target = this.postTarget;
    if (target) target.bind();
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.renderW, this.renderH); }

    gl.depthMask(true);
    gl.clearColor(this.fogColor[0] * 0.42, this.fogColor[1] * 0.42, this.fogColor[2] * 0.44, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    // opaque, near-to-far: the driver's early-z kills the hidden overdraw
    this._drawTerrain(cam);
    this._drawModels(cam);
    this._drawAmmo(cam, game);

    /* The sky goes on last against the depth buffer (depth == 1 means "nothing
       was here"), so it only ever shades the pixels that are actually sky.
       v2 painted a full-screen sky first and then covered most of it. */
    this._drawSky(cam);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.quality.water) this._drawWater(cam);
    this._drawDecals(game, cam);
    if (game.settings?.showBars !== false) this._drawBillboards(game, cam);
    this._drawParticles(cam, game);

    if (target) this._drawPost();
    gl.disable(gl.BLEND);
    game.renderStats = st;
  }

  _pickTownLights(game, cam, dt = 0) {
    const cx = cam.target[0], cz = cam.target[2];
    this._fireT = (this._fireT || 0) + dt;
    const moved = Math.abs(cx - (this._fireX || 1e9)) + Math.abs(cz - (this._fireZ || 1e9));
    if (this._fireX !== undefined && moved < 6 && this._fireT < 0.4) return;
    this._fireX = cx; this._fireZ = cz; this._fireT = 0;
    const best = this._lightCand || (this._lightCand = []);
    best.length = 0;
    const list = game.buildings;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || b.dead || (b.buildProgress !== undefined && b.buildProgress < 0.99)) continue;
      const meta = b.def || {};
      const fire = meta.isTownCenter ? 3.2 : meta.pop ? 1.6 : 1.0;
      const dx = b.x - cx, dz = b.z - cz;
      best.push({ b, score: dx * dx + dz * dz - fire * 900 });
    }
    best.sort((A, B) => A.score - B.score);
    const t = this.townLight;
    const chosen = this._lightPicked || (this._lightPicked = []);
    chosen.length = 0;
    for (let i = 0; i < best.length && chosen.length < 4; i++) {
      const c = best[i];
      let far = true;
      for (const q of chosen) {
        const dx = q.b.x - c.b.x, dz = q.b.z - c.b.z;
        if (dx * dx + dz * dz < 42) { far = false; break; }
      }
      if (far || (c.b.def && c.b.def.isTownCenter)) chosen.push(c);
    }
    for (let i = 0; i < 4; i++) {
      const c = chosen[i];
      const o = i * 3;
      if (!c) { t[o] = 0; t[o + 1] = -999; t[o + 2] = 0; this.townLightY[i] = 0; continue; }
      const fp = (c.b.def && c.b.def.footprint ? c.b.def.footprint : 3) * 0.5 + 0.95;
      const ang = (c.b.facing || 0) + 0.62;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      t[o] = c.b.x + dx * fp;
      t[o + 1] = (c.b.y || 0) + 1.6;
      t[o + 2] = c.b.z + dz * fp;
      this.townLightY[i] = (c.b.y || 0);
    }
  }

  _fillFires(cam) {
    const batch = this.fireBatch;
    if (!batch) return;
    batch.begin();
    const t = this.townLight, y = this.townLightY;
    const lit = this.townLightI > 0.01;
    for (let i = 0; i < 4; i++) {
      const o = i * 3;
      if (t[o + 1] < -900) continue;
      const x = t[o], z = t[o + 2];
      const dx = x - cam.target[0], dz = z - cam.target[2];
      if (dx * dx + dz * dz > 150 * 150) continue;
      if (!this._inFrustum(x, y[i] + 1, z, 2.2)) continue;
      const fd2 = dx * dx + dz * dz;
      if (fd2 < batch._near) batch._near = fd2;
      const flick = lit ? 1.12 + 0.05 * Math.sin(this.time * (7.0 + i * 1.9) + i * 2.1) : 1;
      batch.push(m4trs(this._mB, x, y[i], z, i * 1.7, flick, flick * 1.04, flick),
        1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
    if (batch.count) {
      batch.flush();
      this.stats.tris += batch.triCount * batch.count;
      this.stats.instances += batch.count;
      this._activeBatches.push(batch);
    }
  }

  _inFrustum(x, y, z, r) {
    return sphereInFrustum(this.frustum, x, y, z, r);
  }

  _bindLight(s, withNoise = 0) {
    const cam = this._cam;
    if (cam && cam.eye) s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.v3('uSunDir', this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    s.v3('uSunColor', this.sunColor[0], this.sunColor[1], this.sunColor[2]);
    s.v3('uSkyColor', this.skyColor[0], this.skyColor[1], this.skyColor[2]);
    s.v3('uGroundColor', this.groundColor[0], this.groundColor[1], this.groundColor[2]);
    s.v3('uFogColor', this.fogColor[0], this.fogColor[1], this.fogColor[2]);
    s.f('uFogDensity', this.fogDensity);
    s.f('uTime', this.time);
    s.f('uNight', this.night);
    s.v2('uCloudOffset', this.cloudOffset[0], this.cloudOffset[1]);
    /* Cloud shading is a mood, not a mechanic: on the lowest tier it is gone
       so a 512² fetch per terrain fragment disappears with it. */
    s.f('uCloudStrength', this.cloudStrength);
    s.f('uFogEnabled', this.fogEnabled && this.fogTexture ? 1 : 0);
    s.v3('uTownLightColor', this.townLightColor[0], this.townLightColor[1], this.townLightColor[2]);
    s.f('uTownLightI', this.townLightI);
    for (let i = 0; i < 4; i++) {
      const b = i * 3;
      const loc = s.u(`uTownLight[${i}]`);
      if (loc) this.gl.uniform3f(loc, this.townLight[b], this.townLight[b + 1], this.townLight[b + 2]);
    }
    s.f('uWorldHalf', 256);
    s.f('uShadowStrength', this.quality.shadows ? 0.92 : 0);
    s.f('uShadowTexel', 1 / this.shadowSize);
    s.m4('uShadowMatrix', this.shadowMatrix);
    s.tex('uShadowMap', this.shadowTarget.tex, this.gl.TEXTURE_2D);
    s.tex('uClouds', this.textures.clouds, this.gl.TEXTURE_2D);
    s.tex('uFogTex', this.fogTexture || this.textures.noise, this.gl.TEXTURE_2D);
    /* Only the sky and the model shader read the noise and star tiles. Asking
       a program for a uniform it does not declare is legal but pointless, and
       it is exactly the kind of per-frame overhead that adds up in a driver. */
    if (withNoise) s.tex('uNoise', this.textures.noise, this.gl.TEXTURE_2D);
    if (withNoise > 1) s.tex('uStars', this.textures.stars, this.gl.TEXTURE_2D);
  }

  /* ---------- instance filling ---------- */
  _fillInstances(game, cam, dt) {
    const st = this.stats;
    const cx = cam.target[0], cz = cam.target[2];
    /* 0..1 between the last two simulation ticks. The sim runs at 30 Hz and the
       screen at 60-120, so drawing raw sim positions would show every unit
       snapping forward one notch at a time. */
    const alpha = this._alpha ?? 1;
    const active = this._activeBatches;
    active.length = 0;
    const culledList = this._cullBatches;
    const twoSided = this._noCullBatches;
    culledList.length = 0;
    // the fire batch is filled separately and shares this list
    twoSided.length = 0;

    // ---------- buildings ----------
    for (const b of this.buildingBatches.values()) b.begin();
    this.gateDoorBatch.begin();
    const bCull = this.quality.buildingCull;
    const bCull2 = bCull * bCull;
    for (let i = 0; i < game.buildings.length; i++) {
      const b = game.buildings[i];
      if (b.dead && (b.deadT || 0) > 4.5) continue;
      const dx = b.x - cx, dz = b.z - cz;
      if (dx * dx + dz * dz > bCull2) continue;
      const meta = this.buildingMeta.get(b.type);
      if (!meta) continue;
      const rad = meta.radius + 6;
      if (!this._inFrustum(b.x, (b.y || 0) + meta.height * 0.5, b.z, rad)) { st.culled++; continue; }
      const batch = this.buildingBatches.get(b.type);
      if (!batch) continue;
      const tc = TEAM_LINEAR[b.team] || TEAM_LINEAR[0];
      const prog = b.buildProgress !== undefined ? clamp(b.buildProgress, 0.02, 1) : 1;
      const dmg = 1 - clamp(b.hp / Math.max(1, b.maxHp), 0, 1);
      const scale = (b.dead ? Math.max(0.02, 1 - (b.deadT || 0) / 4.5) : 1);
      const wear = dmg * 0.85 + (b.hitFlash || 0);
      const d2 = dx * dx + dz * dz;
      if (d2 < batch._near) batch._near = d2;
      const m = m4trs(this._mB, b.x, b.y - 0.04, b.z, b.facing || 0, scale, scale, scale);
      batch.push(m, tc[0], tc[1], tc[2], prog, dmg, 1, (b.team || 0) * 0.13,
        0, 0, 0, 0, 0, 0, wear, NO_SWAY.has(b.type) ? 0 : 0.35);
      if (b.def && b.def.gate) {
        /* the leaf drops 2.1 m when open; 0.02 keeps it hidden, not z-fighting */
        const open = clamp(b.gateOpen || 0, 0, 1);
        const gm = m4trs(this._mDoor, b.x, b.y - 0.04 - open * 2.16, b.z, b.facing || 0, scale, scale, scale);
        this.gateDoorBatch.push(gm, tc[0], tc[1], tc[2], prog, dmg, 1, (b.team || 0) * 0.13,
          0, 0, 0, 0, 0, 0, wear, 0);
      }
    }
    for (const b of this.buildingBatches.values()) {
      if (!b.count) continue;
      b.flush();
      active.push(b);
      st.tris += b.triCount * b.count;
      st.instances += b.count;
    }
    if (this.gateDoorBatch.count) {
      this.gateDoorBatch.flush();
      active.push(this.gateDoorBatch);
      st.tris += this.gateDoorBatch.triCount * this.gateDoorBatch.count;
      st.instances += this.gateDoorBatch.count;
    }

    // ---------- units ----------
    for (const b of this.unitBatches.values()) b.begin();
    const uCull = this.quality.unitCull;
    const uCull2 = uCull * uCull;
    for (let i = 0; i < game.units.length; i++) {
      const u = game.units[i];
      if (u.garrisoned) continue;
      if (u.dead && (u.deadT || 0) > 6) continue;
      const dx = u.x - cx, dz = u.z - cz;
      if (dx * dx + dz * dz > uCull2) continue;
      const batch = this.unitBatches.get(u.type);
      if (!batch) continue;
      const meta = this.unitMeta.get(u.type) || UNIT_META_FALLBACK;
      const tc = TEAM_LINEAR[u.team] || TEAM_LINEAR[0];
      const anim = u.anim || NO_ANIM;
      const swing = Math.sin(anim.phase);
      const spd = clamp(anim.speed, 0, 1);
      const atk = anim.attack || 0;
      const deadK = u.dead ? clamp(1 - (u.deadT || 0) / 6, 0, 1) : 1;
      const tilt = u.dead ? (1 - deadK) * 1.45 : 0;
      const rx = u.xPrev === undefined ? u.x : u.xPrev + (u.x - u.xPrev) * alpha;
      const rz = u.zPrev === undefined ? u.z : u.zPrev + (u.z - u.zPrev) * alpha;
      const ry = u.yPrev === undefined ? u.y : u.yPrev + (u.y - u.yPrev) * alpha;
      if (!this._inFrustum(rx, ry + meta.height * 0.5, rz, meta.height + 1.2)) { st.culled++; continue; }
      if (dx * dx + dz * dz < batch._near) batch._near = dx * dx + dz * dz;
      const m = this._mB;
      m4trs(m, rx, ry + (u.dead ? -0.12 * (1 - deadK) : 0), rz, u.facing || 0, 1, 1, 1);
      if (tilt) {
        const R = this._mR;
        m4identity(R);
        const c = Math.cos(tilt), s = Math.sin(tilt);
        R[5] = c; R[6] = s; R[9] = -s; R[10] = c;
        m4mul(this._mOut, m, R);
        batch.push(this._mOut, tc[0], tc[1], tc[2], 1,
          u.dead ? 0.5 : (1 - clamp(u.hp / Math.max(1, u.maxHp), 0, 1)) * 0.8,
          deadK, 0,
          swing * 0.62 * spd, -swing * 0.62 * spd,
          -swing * 0.4 * spd + atk * 0.85, swing * 0.4 * spd - atk * 1.35,
          anim.spin || 0, Math.abs(Math.sin(anim.phase * 2)) * 0.035 * spd,
          u.hitFlash || 0, 0);
      } else {
        batch.push(m, tc[0], tc[1], tc[2], 1,
          (1 - clamp(u.hp / Math.max(1, u.maxHp), 0, 1)) * 0.8, 1, 0,
          swing * 0.62 * spd, -swing * 0.62 * spd,
          -swing * 0.4 * spd + atk * 0.85, swing * 0.4 * spd - atk * 1.35,
          anim.spin || 0, Math.abs(Math.sin(anim.phase * 2)) * 0.035 * spd,
          u.hitFlash || 0, 0);
      }
    }
    for (const b of this.unitBatches.values()) {
      if (!b.count) continue;
      b.flush();
      active.push(b);
      st.tris += b.triCount * b.count;
      st.instances += b.count;
    }

    // ---------- resource nodes (trees, mines, herds) ----------
    for (const b of this.resBatches.values()) b.begin();
    const rCull = uCull + 30;
    const rCull2 = rCull * rCull;
    const resList = game.resources;
    for (let i = 0; i < resList.length; i++) {
      const r = resList[i];
      if (r.dead) continue;
      const dx = r.x - cx, dz = r.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > rCull2) continue;
      let key;
      if (r.type === 'tree') {
        const v = (r.variant || 0) & 3;
        key = d2 > 3844 ? TREE_VARIANTS_LOD[v] : TREE_VARIANTS[v];
      } else {
        key = RES_MODELS[r.type];
        if (!key) continue;
      }
      const batch = this.resBatches.get(key);
      if (!batch) continue;
      const s = (r.scale || 1) * (0.72 + 0.28 * clamp(r.amount / Math.max(1, r.maxAmount), 0, 1));
      if (!this._inFrustum(r.x, (r.y || 0) + 4 * s, r.z, 5 * s + 2)) { st.culled++; continue; }
      if (d2 < batch._near) batch._near = d2;
      const rot = r.facing || 0;
      const sway = (r.resKind === 'wood' || r.type === 'berry_bush') ? 1 : 0;
      batch.push(m4trs(this._mB, r.x, r.y + (r.yOff || 0) - 0.06, r.z, rot, s, s, s),
        1, 1, 1, 1, 0, 1, (r.variant || 0) * 0.21, 0, 0, 0, 0, 0, 0, 0, sway);
    }
    for (const b of this.resBatches.values()) {
      if (!b.count) continue;
      b.flush();
      active.push(b);
      st.tris += b.triCount * b.count;
      st.instances += b.count;
    }

    // ---------- static decor (streamed from spatial buckets) ----------
    this._streamProps(cx, cz, active, dt);

    /* Group by cull state so the driver sees long runs. Buildings, units and
       trees are closed meshes (geo.js guarantees outward winding); grass,
       reeds and fences are cards and stay two-sided. */
    for (let i = 0; i < active.length; i++) {
      if (active[i].cull) culledList.push(active[i]);
      else twoSided.push(active[i]);
    }
    /* Front-to-back *within each pipeline state*: the driver's early-depth
       test then throws away the hidden fragments of the barracks behind the
       town centre instead of shading them and failing the depth test. On a
       fill-rate-bound phone that is free performance in exactly the scene
       where the game used to slow down (a crowded town). */
    if (culledList.length > 1) culledList.sort(this._byNear);
    if (twoSided.length > 1) twoSided.sort(this._byNear);
    active.length = 0;
    for (let i = 0; i < culledList.length; i++) active.push(culledList[i]);
    for (let i = 0; i < twoSided.length; i++) active.push(twoSided[i]);
  }

  _streamProps(cx, cz, active, dt) {
    const far = this.quality.propDistance;
    const far2 = far * far;
    const moved = Math.abs(cx - this._propCam.x) + Math.abs(cz - this._propCam.z);
    this._propCam.t += dt;
    if (!this.propDirty && moved < 9 && this._propCam.t < 0.5) {
      const prev = this._activeProps;
      for (let i = 0; i < prev.length; i++) active.push(prev[i]);
      return;
    }
    this._propCam.x = cx; this._propCam.z = cz; this._propCam.t = 0;
    this.propDirty = false;
    const CELL = 64, HALF = 256;
    const minCx = clamp(Math.floor((cx - far + HALF) / CELL), 0, 7);
    const maxCx = clamp(Math.floor((cx + far + HALF) / CELL), 0, 7);
    const minCz = clamp(Math.floor((cz - far + HALF) / CELL), 0, 7);
    const maxCz = clamp(Math.floor((cz + far + HALF) / CELL), 0, 7);
    const prev = this._activeProps;
    prev.length = 0;
    for (const [kind, cellMap] of this.propCells) {
      const batch = this.propBatches.get(kind);
      if (!batch) continue;
      batch.begin();
      for (let gz = minCz; gz <= maxCz; gz++) {
        for (let gx = minCx; gx <= maxCx; gx++) {
          const list = cellMap.get(gz * 8 + gx);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const dx = p.x - cx, dz = p.z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 > far2) continue;
            // thin out the far ring so the triangle budget stays flat
            if (d2 > far2 * 0.45 && ((p.x * 7.13 + p.z * 3.71) % 1) > 0.68) continue;
            if (!this._inFrustum(p.x, p.y + p.scale, p.z, p.scale * 2.5 + 1)) { this.stats.culled++; continue; }
            if (d2 < batch._near) batch._near = d2;
            const s = p.scale;
            batch.push(m4trs(this._mB, p.x, p.y, p.z, p.rot, s, s, s),
              1, 1, 1, 1, 0, 1, p.tint, 0, 0, 0, 0, 0, 0, 0,
              kind === 'rock' || kind === 'pebble' || kind === 'log' || kind === 'ruin' ? 0 : 0.5);
          }
        }
      }
      if (!batch.count) continue;
      batch.flush();
      prev.push(batch);
      this.stats.tris += batch.triCount * batch.count;
      this.stats.instances += batch.count;
    }
    for (let i = 0; i < prev.length; i++) active.push(prev[i]);
  }

  /* ---------- shadows ---------- */
  _shadowPass(cam, dt = 1 / 60) {
    if (!this.quality.shadows) return;
    /* The shadow map is refreshed at `shadowHz` and only when something that
       matters has moved: the (texel-snapped) camera target or the sun. A map
       that is one frame stale cannot be seen; a depth pass every frame can. */
    this._shadowT += dt;
    const interval = 1 / (this.quality.shadowHz || 30);
    const target = cam.target;
    const radius = clamp(cam.dist * 1.05, 34, 100);
    const texel = (radius * 2) / this.shadowSize;
    const tx = Math.round(target[0] / texel) * texel;
    const ty = Math.round(target[1] / texel) * texel;
    const tz = Math.round(target[2] / texel) * texel;
    const key = `${tx.toFixed(2)},${tz.toFixed(2)},${radius.toFixed(1)},${this.sunDir[0].toFixed(3)},${this.sunDir[1].toFixed(3)}`;
    if (this._shadowKey === key && this._shadowT < interval) return;
    this._shadowT = 0;
    this._shadowKey = key;

    const gl = this.gl;
    const dist = radius * 2.4;
    const eye = [tx + this.sunDir[0] * dist, ty + this.sunDir[1] * dist, tz + this.sunDir[2] * dist];
    const view = this._mS;
    m4lookAt(view, eye[0], eye[1], eye[2], tx, ty, tz, 0, 1, 0);
    const proj = this._shadowProj || (this._shadowProj = mat4());
    m4ortho(proj, -radius, radius, -radius, radius, 1, dist * 2.8);
    m4mul(this.shadowMatrix, proj, view);

    this.shadowTarget.bind();
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.8, 4.0);
    const s = this.pShadow.use();
    s.m4('uLightViewProj', this.shadowMatrix);
    s.f('uTime', this.time);
    s.f('uSwayAmount', this.quality.foliage);
    const list = this._activeBatches;
    let draws = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.noShadow) continue;
      if (b.cull === false) gl.disable(gl.CULL_FACE);
      b.draw();
      draws++;
      if (b.cull === false) gl.enable(gl.CULL_FACE);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    this.stats.shadowDraws = draws;
    this.stats.shadow = true;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---------- passes ---------- */
  _drawTerrain(cam) {
    const gl = this.gl;
    const s = this.pTerrain.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uDetailStrength', this.quality.detail !== undefined ? this.quality.detail : 1.0);
    this._bindLight(s);
    s.tex('uAlbedo', this.terrainAlbedo, gl.TEXTURE_2D);
    s.tex('uDetail', this.textures.groundDetail, gl.TEXTURE_2D);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // front-to-back so early-z rejects the hidden hillside behind the near one
    const chunks = this.chunks;
    const cx = cam.eye[0], cz = cam.eye[2];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const dx = c.cx - cx, dz = c.cz - cz;
      c.d2 = dx * dx + dz * dz;
    }
    chunks.sort((a, b) => a.d2 - b.d2);
    let drawn = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!sphereInFrustum(this.frustum, c.cx, c.y, c.cz, c.radius + 14)) continue;
      c.mesh.draw();
      drawn++;
      this.stats.tris += c.mesh.triCount;
    }
    this.stats.drawCalls += drawn;
  }

  _drawSky(cam) {
    const gl = this.gl;
    const s = this.pSky.use();
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);          // only where nothing has been drawn yet
    s.m4('uInvViewProj', cam.invViewProj);
    s.v3('uZenithColor', this.zenith[0], this.zenith[1], this.zenith[2]);
    s.v3('uHorizonColor', this.horizon[0], this.horizon[1], this.horizon[2]);
    s.f('uCloudCover', this.cloudCover);
    s.f('uStarAmount', this.starAmount);
    s.v3('uMoonDir', this.moonDir[0], this.moonDir[1], this.moonDir[2]);
    s.f('uMoonAmount', this.moonAmount);
    this._bindLight(s, 2);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  _drawWater(cam) {
    const gl = this.gl;
    const s = this.pWater.use();
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    s.m4('uViewProj', cam.viewProj);
    s.f('uWaveAmp', 1.0);
    this._bindLight(s);
    s.tex('uWater', this.textures.water, gl.TEXTURE_2D);
    s.tex('uHeightMap', this.heightTex || this.textures.noise, gl.TEXTURE_2D);
    s.v2('uNormalOffset', this.time * 0.018, this.time * 0.011);
    s.v3('uShallowColor', 0.24, 0.53, 0.48);
    s.v3('uDeepColor', 0.05, 0.13, 0.19);
    s.v3('uZenithColor', this.zenith[0], this.zenith[1], this.zenith[2]);
    s.v3('uHorizonColor', this.horizon[0], this.horizon[1], this.horizon[2]);
    gl.depthMask(false);
    this.waterMesh.draw();
    this.stats.drawCalls++;
    this.stats.tris += this.waterMesh.triCount;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  _drawModels(cam) {
    const list = this._activeBatches;
    if (!list.length) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const s = this.pModel.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uSwayAmount', this.quality.foliage);
    this._bindLight(s, 1);
    s.tex('uMaterials', this.textures.materials, gl.TEXTURE_2D_ARRAY);
    let cull = null;
    for (let i = 0; i < list.length; i++) {
      const want = list[i].cull !== false;
      if (want !== cull) {
        cull = want;
        if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
        else gl.disable(gl.CULL_FACE);
      }
      list[i].draw();
      this.stats.drawCalls++;
    }
    gl.enable(gl.CULL_FACE);
  }

  _drawAmmo(cam, game) {
    const gl = this.gl;
    const projs = game.projectiles ? game.projectiles.items : null;
    const list = projs && projs.length ? projs : null;
    this.arrowBatch.begin();
    this.boulderBatch.begin();
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || !p.active) continue;
        if (!this._inFrustum(p.x, p.y, p.z, 2)) continue;
        const heavy = p.kind === 'boulder' || p.kind === 'cannonball';
        const batch = heavy ? this.boulderBatch : this.arrowBatch;
        const m = this._mB;
        if (heavy) {
          m4trs(m, p.x, p.y, p.z, (p.yaw || 0) + this.time * 3, 1, 1, 1);
          batch.push(m, 1, 1, 1, 1, 0, 1, 0);
        } else {
          const yaw = Math.atan2(p.vx || 0.001, p.vz || 0.001);
          const pitch = -Math.atan2(p.vy || 0, Math.hypot(p.vx || 0, p.vz || 0) || 1);
          m4trs(m, p.x, p.y, p.z, yaw, 1, 1, 1);
          const R = this._mR;
          m4identity(R);
          const c = Math.cos(pitch), s = Math.sin(pitch);
          R[5] = c; R[6] = s; R[9] = -s; R[10] = c;
          m4mul(this._mOut, m, R);
          batch.push(this._mOut, 1, 1, 1, 1, 0, 1, 0);
        }
      }
    }
    if (!this.arrowBatch.count && !this.boulderBatch.count) return;
    const s = this.pModel.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uSwayAmount', 0);
    this._bindLight(s, 1);
    s.tex('uMaterials', this.textures.materials, gl.TEXTURE_2D_ARRAY);
    gl.enable(gl.CULL_FACE);
    for (const b of [this.arrowBatch, this.boulderBatch]) {
      if (!b.count) continue;
      b.flush();
      b.draw();
      this.stats.drawCalls++;
      this.stats.instances += b.count;
      this.stats.tris += b.triCount * b.count;
    }
  }

  _drawDecals(game, cam) {
    const gl = this.gl;
    const d = this.decals;
    d.begin();
    const sel = game.selection;
    for (let i = 0; i < sel.length; i++) {
      const e = sel[i];
      if (!e || e.dead) continue;
      const meta = this.buildingMeta.get(e.type);
      const r = e.kind === 'building' ? (meta ? meta.footprint * 0.72 : 2.6) : (e.radius || 0.5) * 1.9;
      const tc = e.team === 1 ? [0.35, 0.95, 0.5] : e.team === 2 ? [1, 0.36, 0.3] : [1, 0.86, 0.4];
      d.push(e.x, e.y + 0.07, e.z, r, tc[0], tc[1], tc[2], 0.9, 0, 1, 0, 0);
    }
    if (game.placing) {
      const p = game.placing;
      if (p.line && p.cells && p.cells.length) {
        /* one tile per planned segment: green where the run can go, red where
           it stops, dim where the treasury runs out */
        for (let i = 0; i < p.cells.length; i++) {
          const c = p.cells[i];
          const y = game.heightAt(c.x, c.z);
          const good = c.ok && c.afford !== false;
          const r = good ? (c.ok ? 0.4 : 1) : 1;
          const g2 = good ? 1 : 0.55;
          const b2 = good ? 0.55 : 0.26;
          const a = good ? 0.55 : 0.4;
          d.push(c.x, y + 0.09, c.z, (p.footprint || 2) * 0.38, r, g2, b2, a, 0, 2, 0, 0);
          d.push(c.x, y + 0.1, c.z, (p.footprint || 2) * 0.4, r, g2, b2, a + 0.25, 0, 1, 0, 0);
        }
      } else {
        const col = p.valid ? [0.4, 1, 0.55] : [1, 0.3, 0.26];
        const r = p.footprint || 3;
        d.push(p.x, (p.y || 0) + 0.09, p.z, r * 0.72, col[0], col[1], col[2], 0.5, p.facing || 0, 2, 0, 0);
        d.push(p.x, (p.y || 0) + 0.1, p.z, r * 0.74, col[0], col[1], col[2], 0.8, 0, 1, 0, 0);
      }
    }
    for (let i = 0; i < game.buildings.length; i++) {
      const b = game.buildings[i];
      if (b.rally && !b.dead && (b.rally.x - b.x) ** 2 + (b.rally.z - b.z) ** 2 > 1) {
        d.push(b.rally.x, (b.rally.y || b.y) + 0.1, b.rally.z, 1.0, 0.95, 0.82, 0.3, 0.7, 0, 3, 0, 0);
      }
    }
    const markers = game.groundMarkers;
    if (markers) {
      for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i];
        const t = clamp(1 - m.t / m.life, 0, 1);
        d.push(m.x, (m.y || 0) + 0.08, m.z, m.r * (0.6 + t * 0.9), m.r0 || 0.55, m.g0 || 0.95, m.b0 || 0.7,
          0.85 * (1 - t), 0, m.kind || 1, 0, 0);
      }
    }
    d.flush();
    if (!d.count) return;
    const s = this.pDecal.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uDecalFade', 1.0);
    this._bindLight(s);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    d.draw();
    this.stats.drawCalls++;
    gl.depthMask(true);
  }

  _drawBillboards(game, cam) {
    const gl = this.gl;
    const b = this.billboards;
    b.begin();
    const sel = game.selectionSet;
    const cx = cam.target[0], cz = cam.target[2];
    for (let i = 0; i < game.units.length; i++) {
      const u = game.units[i];
      if (u.dead || u.garrisoned) continue;
      const selected = sel && sel.has(u);
      const ratio = clamp(u.hp / Math.max(1, u.maxHp), 0, 1);
      if (!selected && ratio > 0.995) continue;
      if ((u.x - cx) ** 2 + (u.z - cz) ** 2 > 92 * 92) continue;
      const meta = this.unitMeta.get(u.type) || UNIT_META_FALLBACK;
      const w = selected ? 1.15 : 0.85;
      const y = u.y + meta.height + 0.42;
      if (!this._inFrustum(u.x, y, u.z, 2)) continue;
      b.push(u.x, y, u.z, w + 0.06, 0.02, 0.02, 0.02, 0.45, 0.12, 0, 0.6, 0);
      const col = u.team === 1 ? [0.42, 0.92, 0.45] : u.team === 2 ? [0.98, 0.36, 0.3] : [0.95, 0.84, 0.45];
      b.push(u.x - (w * (1 - ratio)) * 0.5, y, u.z, w * ratio, col[0], col[1], col[2], 0.95, 0.1, 0, 0.9, 0);
    }
    for (let i = 0; i < game.buildings.length; i++) {
      const bd = game.buildings[i];
      if (bd.dead) continue;
      const selected = sel && sel.has(bd);
      const ratio = clamp(bd.hp / Math.max(1, bd.maxHp), 0, 1);
      const underConstruction = bd.buildProgress !== undefined && bd.buildProgress < 0.999;
      if (ratio > 0.995 && !selected && !underConstruction) continue;
      const meta = this.buildingMeta.get(bd.type) || { height: 3, footprint: 3 };
      if ((bd.x - cx) ** 2 + (bd.z - cz) ** 2 > 150 * 150) continue;
      const y = bd.y + meta.height + 0.45;
      const w = clamp(meta.footprint * 0.5, 1.3, 3.2);
      if (!this._inFrustum(bd.x, y, bd.z, w + 2)) continue;
      b.push(bd.x, y, bd.z, w + 0.08, 0.02, 0.02, 0.02, 0.45, 0.16, 0, 0.6, 0);
      const col = bd.team === 1 ? [0.42, 0.92, 0.45] : bd.team === 2 ? [0.98, 0.36, 0.3] : [0.95, 0.84, 0.45];
      b.push(bd.x - (w * (1 - ratio)) * 0.5, y, bd.z, w * ratio, col[0], col[1], col[2], 0.95, 0.13, 0, 0.9, 0);
    }
    b.flush();
    if (!b.count) return;
    const s = this.pBillboard.use();
    s.m4('uViewProj', cam.viewProj);
    s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.v3('uRight', cam.right[0], cam.right[1], cam.right[2]);
    /* Depth-tested now. v2 disabled the depth test here, so every health bar
       floated on top of the buildings in front of it. */
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    b.draw();
    this.stats.drawCalls++;
    gl.depthMask(true);
  }

  _drawParticles(cam, game) {
    const gl = this.gl;
    const cap = this.quality.particleCap;
    const a = this.particleAlpha, add = this.particleAdd;
    a.begin(); add.begin();
    let total = 0;
    const fx = game.fx;
    const arr = fx && fx.particles ? fx.particles : null;
    for (let i = 0; arr && i < fx.count && total < cap; i++) {
      const p = arr[i];
      if (p.life <= 0) continue;
      const t = 1 - p.life / p.maxLife;
      const alpha = p.alpha * (p.fadeOut ? (1 - t * t) : 1) * Math.min(1, p.life * 4);
      if (alpha <= 0.004) continue;
      const size = p.size * (p.grow ? lerp(1, 1 + p.grow, t) : 1);
      const batch = p.additive ? add : a;
      if (!batch.push(p.x, p.y, p.z, size, p.r, p.g, p.b, alpha,
        (p.rot || 0) + (p.spin || 0) * t, p.sprite || 0, p.stretch || 0, 0)) break;
      total++;
    }
    if (this.townLightI > 0.01) {
      const t = this.townLight;
      for (let i = 0; i < 4; i++) {
        const o = i * 3;
        if (t[o + 1] < -900) continue;
        const flick = 0.86 + 0.14 * Math.sin(this.time * (6.2 + i * 1.7) + i * 2.1);
        add.push(t[o], t[o + 1] + 0.18, t[o + 2], 2.5 * flick,
          1.0, 0.56, 0.20, 0.72 * flick * this.townLightI, 0, SPRITE.GLOW, 0, 0);
        total++;
      }
    }
    a.flush(); add.flush();
    if (!a.count && !add.count) return;
    const s = this.pParticle.use();
    s.m4('uViewProj', cam.viewProj);
    s.v3('uRight', cam.right[0], cam.right[1], cam.right[2]);
    s.v3('uUp', cam.up[0], cam.up[1], cam.up[2]);
    s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.v3('uFogColor', this.fogColor[0], this.fogColor[1], this.fogColor[2]);
    s.f('uFogDensity', this.fogDensity);
    this._bindLight(s);
    s.tex('uSprites', this.textures.sprites, gl.TEXTURE_2D_ARRAY);
    gl.enable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    if (a.count) {
      s.f('uAdditive', 0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      a.draw();
      this.stats.drawCalls++;
    }
    if (add.count) {
      s.f('uAdditive', 1);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      add.draw();
      this.stats.drawCalls++;
    }
    gl.depthMask(true);
    this.stats.particles = total;
  }

  _drawPost() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderW, this.renderH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const s = this.pPost.use();
    s.tex('uScene', this.postTarget.color, gl.TEXTURE_2D);
    s.v2('uTexel', 1 / this.renderW, 1 / this.renderH);
    s.f('uVignette', 0.26);
    s.f('uTime', this.time);
    s.f('uGrain', 0.004);
    s.f('uSharpen', this.quality.sharpen || 0);
    drawFullscreen(gl, this.fsTri);
    this.stats.drawCalls++;
    gl.enable(gl.DEPTH_TEST);
  }

  /** Screen-space projection for the HUD. */
  projectToScreen(cam, x, y, z, out) {
    const m = cam.viewProj;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const o = out || [0, 0, 0];
    if (cw <= 0.001) { o[2] = 0; return null; }
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    o[0] = (nx * 0.5 + 0.5) * this.canvas.clientWidth;
    o[1] = (-ny * 0.5 + 0.5) * this.canvas.clientHeight;
    o[2] = cw;
    return o;
  }

  setCamera(cam) { this._cam = cam; }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (!this.buildingBatches) return;
    for (const b of this.buildingBatches.values()) b.dispose();
    for (const b of this.unitBatches.values()) b.dispose();
    for (const b of this.propBatches.values()) b.dispose();
    if (this.fireBatch) { this.fireBatch.dispose(); this.fireBatch = null; }
    if (this.gateDoorBatch) { this.gateDoorBatch.dispose(); this.gateDoorBatch = null; }
    for (const b of this.resBatches.values()) b.dispose();
    for (const c of this.chunks) c.mesh.dispose();
    if (this.waterMesh) this.waterMesh.dispose();
    if (this.shadowTarget) this.shadowTarget.dispose();
    if (this.postTarget) this.postTarget.dispose();
    if (this.terrainAlbedo) gl.deleteTexture(this.terrainAlbedo);
    for (const k of ['materials', 'sprites', 'water', 'clouds', 'noise', 'groundDetail', 'stars']) {
      if (this.textures && this.textures[k]) gl.deleteTexture(this.textures[k]);
    }
    if (this.fogTexture) gl.deleteTexture(this.fogTexture);
    for (const p of [this.pSky, this.pTerrain, this.pModel, this.pShadow, this.pWater,
      this.pParticle, this.pBillboard, this.pDecal, this.pPost]) if (p) p.dispose();
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Upload a single-channel 8-bit map as an R8 texture (height / fog masks). */
function upload8(gl, data, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
