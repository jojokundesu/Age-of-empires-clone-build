/* ============================================================
   renderer.js — Imperial Crown render pipeline
   shadow → sky → terrain → water → models → decals → billboards
   → particles → post (upscale + grade + vignette)

   Tuning notes for the Realme 9i / Adreno 610:
     • every model is one instanced draw, animation runs on the GPU
       (part pivots are baked into the vertex stream)
     • static props are packed into per-cell buckets and only the
       visible ring is streamed into instance buffers
     • no allocation inside render(): all scratch lives on `this`
     • terrain is 64 culled chunks, water is a single mesh
   ============================================================ */
import {
  createGL, Shader, Mesh, RenderTarget, ShadowMap,
  createFullscreenVAO, drawFullscreen, createTexture2D
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
import { buildTextures, MAT, SPRITE } from './textures.js';
import { buildBuilding, buildUnit, buildProp, BUILDING_TYPES, UNIT_TYPES } from './models.js';
import { extractPlanes, sphereInFrustum } from './camera.js';
import { BUILDING_DEFS } from '../sim/data.js';
import { buildRenderTerrain } from '../sim/worldgen.js';

export { MAT, SPRITE };

export const QUALITY = {
  low: {
    name: 'Low', shadowSize: 512, shadows: true, resolution: 0.68, maxDpr: 1.25,
    particleCap: 240, propDistance: 105, water: true, post: false, foliage: 0.5,
    unitCull: 78, buildingCull: 150
  },
  medium: {
    name: 'Balanced', shadowSize: 1024, shadows: true, resolution: 0.84, maxDpr: 1.5,
    particleCap: 420, propDistance: 132, water: true, post: true, foliage: 0.8,
    unitCull: 96, buildingCull: 185
  },
  high: {
    name: 'High', shadowSize: 1536, shadows: true, resolution: 0.95, maxDpr: 1.8,
    particleCap: 620, propDistance: 165, water: true, post: true, foliage: 1.0,
    unitCull: 118, buildingCull: 225
  },
  ultra: {
    name: 'Ultra', shadowSize: 2048, shadows: true, resolution: 1.0, maxDpr: 2.0,
    particleCap: 900, propDistance: 200, water: true, post: true, foliage: 1.0,
    unitCull: 140, buildingCull: 260
  }
};

const TEAM_RGB = {
  1: [0.32, 0.55, 0.98],
  2: [0.95, 0.28, 0.22],
  0: [0.85, 0.72, 0.42],
  3: [0.5, 0.82, 0.3],
  4: [0.78, 0.52, 0.95]
};

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

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.gl = createGL(canvas, opts.gl);
    this.ok = !!this.gl;
    this.qualityName = opts.quality || 'medium';
    this.quality = QUALITY[this.qualityName] || QUALITY.medium;
    this.width = 1; this.height = 1;
    this.renderW = 1; this.renderH = 1;
    this.scale = 1;
    this.time = 0;
    this.worldTime = 8.5;
    this.dayLength = 720;          // seconds per full day/night cycle
    this.sunDir = new Float32Array([0.4, 0.7, 0.3]);
    this.sunColor = new Float32Array([1.35, 1.2, 1.0]);
    this.skyColor = new Float32Array([0.4, 0.55, 0.75]);
    this.groundColor = new Float32Array([0.24, 0.2, 0.15]);
    this.fogColor = new Float32Array([0.6, 0.68, 0.76]);
    this.zenith = new Float32Array([0.16, 0.3, 0.55]);
    this.horizon = new Float32Array([0.7, 0.76, 0.8]);
    this.cloudOffset = new Float32Array([0, 0]);
    this.cloudCover = 0.5;
    this.starAmount = 0;
    this.night = 0;
    this.exposure = 1;
    this.fogDensity = 0.0032;
    this.shadowMatrix = mat4();
    this.frustum = new Float32Array(24);
    this.stats = { drawCalls: 0, tris: 0, instances: 0, particles: 0 };
    this.ready = false;
    this.ctxLost = false;
    this.fogTexture = null;
    this.fogEnabled = false;
    this.playerTeam = 1;
    // scratch
    this._mB = mat4(); this._mR = mat4(); this._mOut = mat4(); this._mS = mat4();
    this._propCam = { x: 1e9, z: 1e9, t: 0 };
    this._activeProps = [];
    this.propDirty = true;
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
    onProgress('Compiling shaders…', 0.62);
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

    onProgress('Raising walls and roofs…', 0.7);
    await frame();
    this.buildingBatches = new Map();
    this.buildingMeta = new Map();
    for (const type of BUILDING_TYPES) {
      const res = buildBuilding(type);
      const geo = res.geo.finish();
      const def = BUILDING_DEFS[type] || {};
      const max = (type === 'stone_wall' || type === 'palissade_wall') ? 320
        : (type === 'house') ? 70 : (type === 'farm') ? 60 : 16;
      this.buildingBatches.set(type, new InstanceBatch(gl, geo, max));
      this.buildingMeta.set(type, {
        height: res.height || 4,
        footprint: def.size || 3,
        radius: (def.size || 3) * 0.72
      });
    }

    onProgress('Assembling armies…', 0.8);
    await frame();
    this.unitBatches = new Map();
    this.unitMeta = new Map();
    for (const type of UNIT_TYPES) {
      const res = buildUnit(type);
      if (!res) continue;
      const geo = res.geo.finish();
      this.unitBatches.set(type, new InstanceBatch(gl, geo, type === 'villager' ? 160 : 90));
      this.unitMeta.set(type, {
        height: res.height, stride: res.stride,
        mounted: !!res.mounted, siege: !!res.siege, naval: !!res.naval
      });
    }

    onProgress('Growing forests…', 0.88);
    await frame();
    // decor (static, bucketed) and resource nodes (dynamic) get separate batches
    this.propBatches = new Map();
    this.resBatches = new Map();
    const decorNames = ['bush', 'rock', 'stump', 'reed', 'tuft', 'flower', 'pebble', 'log', 'ruin'];
    for (const name of decorNames) {
      const res = buildProp(name);
      if (!res) continue;
      this.propBatches.set(name, new InstanceBatch(gl, res.geo.finish(), 900));
    }
    const resNames = ['tree0', 'tree1', 'tree2', 'tree3', 'tree0L', 'tree1L', 'tree2L', 'tree3L',
      'gold_mine', 'stone_mine', 'berry_bush', 'deer', 'boar', 'fish', 'relic'];
    for (const name of resNames) {
      const res = buildProp(name.endsWith('L') ? 'tree_lod' : name);
      if (!res) continue;
      this.resBatches.set(name, new InstanceBatch(gl, res.geo.finish(), name.startsWith('tree') ? 700 : 120));
    }

    onProgress('Fletching arrows…', 0.94);
    await frame();
    this.arrowGeo = this._makeArrowGeo();
    this.boulderGeo = this._makeBoulderGeo();
    this.arrowBatch = new InstanceBatch(gl, this.arrowGeo, 300);
    this.boulderBatch = new InstanceBatch(gl, this.boulderGeo, 80);

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
    const g = this._geoBox(0.035, 0.035, 0.92, 3, [0.72, 0.56, 0.34]);
    return g;
  }
  _makeBoulderGeo() {
    const g = this._geoBox(0.42, 0.42, 0.42, 5, [0.55, 0.53, 0.5]);
    return g;
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
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.quality = QUALITY[name];
    this._createShadowTarget(this.quality.shadowSize);
    this.renderW = 0;
    this.resize();
    this.propDirty = true;
  }

  /* ================= world ================= */
  /** Free GPU memory from a previous world so restarts never leak. */
  _disposeWorld() {
    const gl = this.gl;
    for (const c of this.chunks || []) c.mesh.dispose();
    this.chunks = [];
    if (this.waterMesh) { this.waterMesh.dispose(); this.waterMesh = null; }
    if (this.heightTex) { gl.deleteTexture(this.heightTex); this.heightTex = null; }
    this.propCells = null;
  }

  buildWorld(world) {
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
    this.heightTex = createTexture2D(gl, {
      width: VN, height: VN, data, internalFormat: gl.R8, format: gl.RED,
      wrap: gl.CLAMP_TO_EDGE, mipmap: false
    });
    this._buildTerrain(RT);
    this._buildWater();
    this._bucketProps(world);
    return this;
  }

  _buildTerrain(RT) {
    const gl = this.gl;
    const VN = RT.n, cell = RT.cell, HALF = RT.size * 0.5;
    const heights = RT.heights, s4 = RT.splat4, s2 = RT.splat2;
    const cellsPerChunk = 32;
    const chunkCount = Math.ceil((VN - 1) / cellsPerChunk);
    this.chunks = [];
    for (let cz = 0; cz < chunkCount; cz++) {
      for (let cx = 0; cx < chunkCount; cx++) {
        const i0 = cx * cellsPerChunk, j0 = cz * cellsPerChunk;
        if (i0 >= VN - 1 || j0 >= VN - 1) continue;
        const w = Math.min(cellsPerChunk, VN - 1 - i0) + 1;
        const h = Math.min(cellsPerChunk, VN - 1 - j0) + 1;
        const verts = new Float32Array(w * h * 12);
        let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const gi = i0 + i, gj = j0 + j;
            const k = gj * VN + gi;
            const x = gi * cell - HALF, z = gj * cell - HALF;
            const y = heights[k];
            const o = (j * w + i) * 12;
            verts[o] = x; verts[o + 1] = y; verts[o + 2] = z;
            const hl = heights[k - (gi > 0 ? 1 : 0)];
            const hr = heights[k + (gi < VN - 1 ? 1 : 0)];
            const hd = heights[k - (gj > 0 ? VN : 0)];
            const hu = heights[k + (gj < VN - 1 ? VN : 0)];
            let nx = hl - hr, ny = 2 * cell, nz = hd - hu;
            const nl = Math.hypot(nx, ny, nz) || 1;
            verts[o + 3] = nx / nl; verts[o + 4] = ny / nl; verts[o + 5] = nz / nl;
            const o4 = k * 4, o2 = k * 2;
            verts[o + 6] = s4[o4]; verts[o + 7] = s4[o4 + 1];
            verts[o + 8] = s4[o4 + 2]; verts[o + 9] = s4[o4 + 3];
            verts[o + 10] = s2[o2]; verts[o + 11] = s2[o2 + 1];
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
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 48, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 48, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 48, 24);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 48, 40);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        const mesh = new Mesh(gl, vao, vbo, ibo, idx.length, gl.UNSIGNED_SHORT);
        mesh.triCount = idx.length / 3;
        this.chunks.push({
          mesh,
          cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
          radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5,
          y: (minY + maxY) / 2
        });
      }
    }
  }

  _buildWater() {
    const gl = this.gl;
    const N = 96, span = 512, half = span / 2;
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
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    this.waterMesh = new Mesh(gl, vao, vbo, ibo, idx.length, gl.UNSIGNED_INT);
    this.waterMesh.triCount = idx.length / 3;
  }

  /** Bucket static decor into 64 m cells per prop kind for cheap culling. */
  _bucketProps(world) {
    this.propCells = new Map();     // kind -> Map(cellIndex -> Float32Array[])
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

  setFog(data, size) {
    const gl = this.gl;
    if (!this.fogTexture) {
      this.fogTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.fogTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, data);
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
      this.sunColor[0] = lerp(1.86, 2.05, warm);
      this.sunColor[1] = lerp(1.72, 1.18, warm);
      this.sunColor[2] = lerp(1.52, 0.72, warm);
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
    this.cloudOffset[0] += dt * 0.0018;
    this.cloudOffset[1] += dt * 0.0009;
    this.fogDensity = 0.00105 + lowSun * 0.0007;
  }

  resize() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const w = Math.max(2, Math.round(cw * dpr * this.quality.resolution * this.scale));
    const h = Math.max(2, Math.round(ch * dpr * this.quality.resolution * this.scale));
    if (w === this.renderW && h === this.renderH && canvas.width === w && canvas.height === h) return;
    this.renderW = w; this.renderH = h;
    canvas.width = w; canvas.height = h;
    const gl = this.gl;
    if (this.postTarget) { this.postTarget.dispose(); this.postTarget = null; }
    if (this.quality.post) this.postTarget = new RenderTarget(gl, w, h, { depth: true });
    this.width = cw; this.height = ch;
    gl.viewport(0, 0, w, h);
  }

  setRenderScale(s) {
    const v = clamp(s, 0.5, 1);
    if (Math.abs(v - this.scale) < 0.01) return;
    this.scale = v;
    this.renderW = 0;
    this.resize();
  }

  /* ================= frame ================= */
  render(dt, game) {
    if (this.ctxLost || !this.ready || !this.gl) return;
    const gl = this.gl;
    const st = this.stats;
    st.drawCalls = 0; st.tris = 0; st.instances = 0; st.particles = 0;
    this.resize();
    const cam = game.camera;
    this.updateEnvironment(dt, game.worldTime);
    extractPlanes(cam.viewProj, this.frustum);
    this.fogEnabled = !!(game.settings && game.settings.fog);
    this._cam = cam;

    this._fillInstances(game, cam, dt);
    if (this.quality.shadows) this._shadowPass();

    const target = this.postTarget;
    if (target) target.bind();
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.renderW, this.renderH); }

    gl.depthMask(true);
    gl.clearColor(this.fogColor[0] * 0.42, this.fogColor[1] * 0.42, this.fogColor[2] * 0.44, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._drawSky(cam);
    this._drawTerrain(cam);
    if (this.quality.water) this._drawWater(cam);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._drawModels(cam);
    this._drawAmmo(cam, game);
    this._drawDecals(game, cam);
    if (game.settings?.showBars !== false) this._drawBillboards(game, cam);
    this._drawParticles(cam, game);

    if (target) this._drawPost();
    game.renderStats = st;
  }

  _bindLight(s) {
    s.v3('uSunDir', this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    s.v3('uSunColor', this.sunColor[0], this.sunColor[1], this.sunColor[2]);
    s.v3('uSkyColor', this.skyColor[0], this.skyColor[1], this.skyColor[2]);
    s.v3('uGroundColor', this.groundColor[0], this.groundColor[1], this.groundColor[2]);
    s.v3('uFogColor', this.fogColor[0], this.fogColor[1], this.fogColor[2]);
    s.f('uFogDensity', this.fogDensity);
    s.f('uTime', this.time);
    s.f('uNight', this.night);
    s.v2('uCloudOffset', this.cloudOffset[0], this.cloudOffset[1]);
    s.f('uFogEnabled', this.fogEnabled && this.fogTexture ? 1 : 0);
    s.f('uWorldHalf', 256);
    s.f('uShadowStrength', this.quality.shadows ? 0.92 : 0);
    s.f('uShadowTexel', 1 / this.shadowSize);
    s.m4('uShadowMatrix', this.shadowMatrix);
    s.tex('uShadowMap', this.shadowTarget.tex, this.gl.TEXTURE_2D);
    s.tex('uClouds', this.textures.clouds, this.gl.TEXTURE_2D);
    // the fog sampler must always be bound to a valid texture
    s.tex('uFogTex', this.fogTexture || this.textures.noise, this.gl.TEXTURE_2D);
  }

  /* ---------- instance filling ---------- */
  _fillInstances(game, cam, dt) {
    const st = this.stats;
    const cx = cam.target[0], cz = cam.target[2];
    const active = this._activeBatches || (this._activeBatches = []);
    active.length = 0;

    // ---------- buildings ----------
    for (const b of this.buildingBatches.values()) b.begin();
    const bCull = this.quality.buildingCull;
    const bCull2 = bCull * bCull;
    for (let i = 0; i < game.buildings.length; i++) {
      const b = game.buildings[i];
      if (b.dead && (b.deadT || 0) > 4.5) continue;
      const dx = b.x - cx, dz = b.z - cz;
      if (dx * dx + dz * dz > bCull2) continue;
      const batch = this.buildingBatches.get(b.type);
      if (!batch) continue;
      const tc = TEAM_RGB[b.team] || TEAM_RGB[0];
      const prog = b.buildProgress !== undefined ? clamp(b.buildProgress, 0.02, 1) : 1;
      const dmg = 1 - clamp(b.hp / Math.max(1, b.maxHp), 0, 1);
      const scale = (b.dead ? Math.max(0.02, 1 - (b.deadT || 0) / 4.5) : 1);
      const wear = dmg * 0.85 + (b.hitFlash || 0);
      const m = m4trs(this._mB, b.x, b.y - 0.04, b.z, b.facing || 0, scale, scale, scale);
      batch.push(m, tc[0], tc[1], tc[2], prog, dmg, 1, (b.team || 0) * 0.13,
        0, 0, 0, 0, 0, 0, wear, NO_SWAY.has(b.type) ? 0 : 0.35);
    }
    for (const [type, b] of this.buildingBatches) {
      if (!b.count) continue;
      b.flush();
      active.push(b);
      st.tris += b.triCount * b.count;
      st.instances += b.count;
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
      const meta = this.unitMeta.get(u.type) || { height: 1.8, stride: 3 };
      const tc = TEAM_RGB[u.team] || TEAM_RGB[0];
      const anim = u.anim || { phase: 0, speed: 0, attack: 0, spin: 0 };
      const swing = Math.sin(anim.phase);
      const spd = clamp(anim.speed, 0, 1);
      const atk = anim.attack || 0;
      const deadK = u.dead ? clamp(1 - (u.deadT || 0) / 6, 0, 1) : 1;
      const tilt = u.dead ? (1 - deadK) * 1.45 : 0;
      const m = this._mB;
      m4trs(m, u.x, u.y + (u.dead ? -0.12 * (1 - deadK) : 0), u.z, u.facing || 0, 1, 1, 1);
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
    for (const [type, b] of this.unitBatches) {
      if (!b.count) continue;
      b.flush();
      active.push(b);
      st.tris += b.triCount * b.count;
      st.instances += b.count;
    }

    // ---------- resource nodes (trees, mines, herds) ----------
    for (const b of this.resBatches.values()) b.begin();
    const rCull = uCull + 26;
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
        key = TREE_VARIANTS[(r.variant || 0) & 3];
        if (d2 > 62 * 62) key += 'L';
      } else {
        key = RES_MODELS[r.type];
        if (!key) continue;
      }
      const batch = this.resBatches.get(key);
      if (!batch) continue;
      const s = (r.scale || 1) * (0.72 + 0.28 * clamp(r.amount / Math.max(1, r.maxAmount), 0, 1));
      const rot = r.facing || 0;
      // subtle sway for foliage only
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
  }

  _streamProps(cx, cz, active, dt) {
    const far = this.quality.propDistance;
    const far2 = far * far;
    const moved = Math.abs(cx - this._propCam.x) + Math.abs(cz - this._propCam.z);
    this._propCam.t += dt;
    if (!this.propDirty && moved < 9 && this._propCam.t < 0.5) {
      // reuse the instance buffers from the previous frame
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
  _shadowPass() {
    const gl = this.gl;
    const cam = this._cam;
    const target = cam.target;
    const radius = clamp(cam.dist * 1.05, 34, 100);
    const dist = radius * 2.4;
    const eye = [target[0] + this.sunDir[0] * dist, target[1] + this.sunDir[1] * dist, target[2] + this.sunDir[2] * dist];
    const view = this._mS;
    m4lookAt(view, eye[0], eye[1], eye[2], target[0], target[1], target[2], 0, 1, 0);
    const proj = mat4();
    m4ortho(proj, -radius, radius, -radius, radius, 1, dist * 2.8);
    m4mul(this.shadowMatrix, proj, view);

    this.shadowTarget.bind();
    gl.clearDepth(1);
    gl.colorMask(false, false, false, false);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.8, 4.0);
    const s = this.pShadow.use();
    s.m4('uLightViewProj', this.shadowMatrix);
    s.f('uTime', this.time);
    s.f('uSwayAmount', this.quality.foliage);
    const list = this._activeBatches;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      b.draw();
      this.stats.drawCalls++;
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---------- passes ---------- */
  _drawSky(cam) {
    const gl = this.gl;
    const s = this.pSky.use();
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    s.m4('uInvViewProj', cam.invViewProj);
    s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.v3('uZenithColor', this.zenith[0], this.zenith[1], this.zenith[2]);
    s.v3('uHorizonColor', this.horizon[0], this.horizon[1], this.horizon[2]);
    s.f('uCloudCover', this.cloudCover);
    s.f('uStarAmount', this.starAmount);
    this._bindLight(s);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  _drawTerrain(cam) {
    const gl = this.gl;
    const s = this.pTerrain.use();
    s.m4('uViewProj', cam.viewProj);
    s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.f('uLayerScale', 0.32);
    s.f('uDetail', 1.0);
    this._bindLight(s);
    s.tex('uTerrain', this.textures.terrain, gl.TEXTURE_2D_ARRAY);
    gl.disable(gl.BLEND);
    let drawn = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!sphereInFrustum(this.frustum, c.cx, c.y, c.cz, c.radius + 12)) continue;
      c.mesh.draw();
      drawn++;
      this.stats.tris += c.mesh.triCount;
    }
    this.stats.drawCalls += drawn;
  }

  _drawWater(cam) {
    const gl = this.gl;
    const s = this.pWater.use();
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    s.m4('uViewProj', cam.viewProj);
    s.v3('uCameraPos', cam.eye[0], cam.eye[1], cam.eye[2]);
    s.f('uWaveAmp', 1.0);
    this._bindLight(s);
    s.tex('uNormalMap', this.textures.waterNormal, gl.TEXTURE_2D);
    s.tex('uHeightMap', this.heightTex || this.textures.noise, gl.TEXTURE_2D);
    s.v2('uNormalOffset', this.time * 0.018, this.time * 0.011);
    s.v3('uShallowColor', 0.20, 0.44, 0.40);
    s.v3('uDeepColor', 0.03, 0.09, 0.14);
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
    const s = this.pModel.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uSwayAmount', this.quality.foliage);
    this._bindLight(s);
    s.tex('uMaterials', this.textures.materials, gl.TEXTURE_2D_ARRAY);
    for (let i = 0; i < list.length; i++) {
      list[i].draw();
      this.stats.drawCalls++;
    }
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
    const s = this.pModel.use();
    s.m4('uViewProj', cam.viewProj);
    s.f('uSwayAmount', 0);
    this._bindLight(s);
    s.tex('uMaterials', this.textures.materials, gl.TEXTURE_2D_ARRAY);
    for (const b of [this.arrowBatch, this.boulderBatch]) {
      if (!b.count) continue;
      b.flush();
      b.draw();
      this.stats.drawCalls++;
      this.stats.instances += b.count;
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
      const col = p.valid ? [0.4, 1, 0.55] : [1, 0.3, 0.26];
      const r = p.footprint || 3;
      d.push(p.x, (p.y || 0) + 0.09, p.z, r * 0.72, col[0], col[1], col[2], 0.5, p.facing || 0, 2, 0, 0);
      d.push(p.x, (p.y || 0) + 0.1, p.z, r * 0.74, col[0], col[1], col[2], 0.8, 0, 1, 0, 0);
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
    this._bindLight(s);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
      const meta = this.unitMeta.get(u.type) || { height: 1.8 };
      const w = selected ? 1.15 : 0.85;
      const y = u.y + meta.height + 0.42;
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
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    b.draw();
    this.stats.drawCalls++;
    gl.enable(gl.DEPTH_TEST);
  }

  _drawParticles(cam, game) {
    const fx = game.fx;
    if (!fx || !fx.particles) return;
    const gl = this.gl;
    const cap = this.quality.particleCap;
    const a = this.particleAlpha, add = this.particleAdd;
    a.begin(); add.begin();
    let total = 0;
    const arr = fx.particles;
    for (let i = 0; i < fx.count && total < cap; i++) {
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
    gl.depthMask(false);
    gl.enable(gl.BLEND);
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
    const s = this.pPost.use();
    s.tex('uScene', this.postTarget.color, gl.TEXTURE_2D);
    s.v2('uTexel', 1 / this.renderW, 1 / this.renderH);
    s.f('uVignette', 0.26);
    s.f('uTime', this.time);
    s.f('uGrain', 0.004);
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
    for (const b of this.buildingBatches.values()) b.dispose();
    for (const b of this.unitBatches.values()) b.dispose();
    for (const b of this.propBatches.values()) b.dispose();
    for (const b of this.resBatches.values()) b.dispose();
    for (const c of this.chunks) c.mesh.dispose();
    if (this.waterMesh) this.waterMesh.dispose();
    if (this.shadowTarget) this.shadowTarget.dispose();
    if (this.postTarget) this.postTarget.dispose();
    for (const k of ['terrain', 'materials', 'sprites', 'waterNormal', 'clouds', 'noise']) {
      if (this.textures && this.textures[k]) gl.deleteTexture(this.textures[k]);
    }
    if (this.fogTexture) gl.deleteTexture(this.fogTexture);
    for (const p of [this.pSky, this.pTerrain, this.pModel, this.pShadow, this.pWater,
      this.pParticle, this.pBillboard, this.pDecal, this.pPost]) if (p) p.dispose();
  }
}
