/* ============================================================
   gl.js — compact WebGL2 layer tuned for the Adreno 610
   ------------------------------------------------------------
   Vertex: 32 bytes, interleaved
     0  aPos     vec3   f32
     12 aNormal  vec3   i8 (normalised)
     15 aMat     u8     (texture-array layer)
     16 aUV      vec2   u16 (normalised)
     20 aColor   vec3   u8  (normalised)
     23 aPart    u8     (rig part index, integer)
     24 aPivot   vec3   i16 (model-space pivot * 256)
     30          pad
   Instance: 32 floats (8 vec4s)
     7..10  mat4 (columns)
     11     rgb + build progress
     12     damage, alpha, flags, seed
     13     anim angles (legL, legR, armL, armR)
     14     anim extra (extra, bob, attack, sway)
   ============================================================ */

export const ATTR = {
  POS: 0, NORMAL: 1, MAT: 2, UV: 3, COLOR: 4, PART: 5, PIVOT: 6,
  I_M0: 7, I_M1: 8, I_M2: 9, I_M3: 10, I_A: 11, I_B: 12, I_C: 13, I_D: 14
};

export const VERTEX_FLOATS = 16;   // CPU-side model vertex
export const VERTEX_BYTES = 32;    // GPU-side
export const INSTANCE_FLOATS = 32;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

export function createGL(canvas, opts = {}) {
  const attrs = {
    alpha: false, antialias: false, depth: true, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance', desynchronized: true,
    failIfMajorPerformanceCaveat: false, ...opts
  };
  let gl = null;
  try { gl = canvas.getContext('webgl2', attrs); } catch (e) { gl = null; }
  if (!gl) return null;
  gl.__ext = {
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
    floatBlend: gl.getExtension('EXT_float_blend'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    lose: gl.getExtension('WEBGL_lose_context'),
    dbg: gl.getExtension('WEBGL_debug_renderer_info')
  };
  gl.__renderer = gl.__ext.dbg ? gl.getParameter(gl.__ext.dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  gl.__vendor = gl.__ext.dbg ? gl.getParameter(gl.__ext.dbg.UNMASKED_VENDOR_WEBGL) : 'unknown';
  return gl;
}

/* ============================================================
   Shader
   ============================================================ */
export class Shader {
  constructor(gl, name, vsSource, fsSource) {
    this.gl = gl;
    this.name = name;
    const vs = compile(gl, gl.VERTEX_SHADER, vsSource, name + '.vs');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, name + '.fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`[${name}] link failed: ${log}`);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.program = p;
    this.loc = new Map();
    this._unit = 0;
  }
  use() { this.gl.useProgram(this.program); this._unit = 0; return this; }
  u(name) {
    let l = this.loc.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(this.program, name); this.loc.set(name, l); }
    return l;
  }
  i(n, v) { const l = this.u(n); if (l) this.gl.uniform1i(l, v); return this; }
  f(n, v) { const l = this.u(n); if (l) this.gl.uniform1f(l, v); return this; }
  v2(n, a, b) { const l = this.u(n); if (l) this.gl.uniform2f(l, a, b); return this; }
  v3(n, a, b, c) { const l = this.u(n); if (l) this.gl.uniform3f(l, a, b, c); return this; }
  v4(n, a, b, c, d) { const l = this.u(n); if (l) this.gl.uniform4f(l, a, b, c, d); return this; }
  m4(n, m) { const l = this.u(n); if (l) this.gl.uniformMatrix4fv(l, false, m); return this; }
  /** Bind a texture to the next free unit. */
  tex(n, texture, target) {
    const gl = this.gl;
    const unit = this._unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, texture);
    const l = this.u(n);
    if (l) gl.uniform1i(l, unit);
    return unit;
  }
  dispose() { if (this.program) this.gl.deleteProgram(this.program); this.program = null; }
}

function compile(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    if (typeof console !== 'undefined') {
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      console.error(`[${label}] compile failed:\n${log}\n${numbered}`);
    }
    gl.deleteShader(s);
    throw new Error(`[${label}] ${log}`);
  }
  return s;
}

/* ============================================================
   Vertex packing
   ============================================================ */
export function packVertices(verts) {
  const n = (verts.length / VERTEX_FLOATS) | 0;
  const buf = new ArrayBuffer(n * VERTEX_BYTES);
  const f32 = new Float32Array(buf);
  const i8 = new Int8Array(buf);
  const u8 = new Uint8Array(buf);
  const u16 = new Uint16Array(buf);
  const i16 = new Int16Array(buf);
  for (let v = 0; v < n; v++) {
    const s = v * VERTEX_FLOATS;
    const b = v * VERTEX_BYTES;
    const f = b >> 2;
    f32[f] = verts[s];
    f32[f + 1] = verts[s + 1];
    f32[f + 2] = verts[s + 2];
    i8[b + 12] = clampI8(verts[s + 3]);
    i8[b + 13] = clampI8(verts[s + 4]);
    i8[b + 14] = clampI8(verts[s + 5]);
    u8[b + 15] = verts[s + 8] | 0;
    u16[(b + 16) >> 1] = u16Of(verts[s + 6]);
    u16[(b + 18) >> 1] = u16Of(verts[s + 7]);
    u8[b + 20] = clampU8(verts[s + 9]);
    u8[b + 21] = clampU8(verts[s + 10]);
    u8[b + 22] = clampU8(verts[s + 11]);
    u8[b + 23] = verts[s + 15] | 0;
    i16[(b + 24) >> 1] = clampI16(verts[s + 12] * 256);
    i16[(b + 26) >> 1] = clampI16(verts[s + 13] * 256);
    i16[(b + 28) >> 1] = clampI16(verts[s + 14] * 256);
    u8[b + 30] = 0; u8[b + 31] = 0;
  }
  return buf;
}
function clampI8(v) { v = Math.round(v * 127); return v < -127 ? -127 : v > 127 ? 127 : v; }
function clampU8(v) { v = Math.round(v * 255); return v < 0 ? 0 : v > 255 ? 255 : v; }
function u16Of(v) { v = Math.round(v * 65535); return v < 0 ? 0 : v > 65535 ? 65535 : v; }
function clampI16(v) { v = Math.round(v); return v < -32768 ? -32768 : v > 32767 ? 32767 : v; }

export function createMesh(gl, verts, indices) {
  const packed = verts instanceof ArrayBuffer ? verts : packVertices(verts);
  const vertexCount = packed.byteLength / VERTEX_BYTES;
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);

  const use32 = vertexCount > 65535;
  const idx = indices instanceof Uint32Array || indices instanceof Uint16Array
    ? indices : (use32 ? new Uint32Array(indices) : new Uint16Array(indices));
  // The index buffer binding is part of VAO state, so the VAO must be bound
  // *before* the IBO is attached — otherwise drawElements has no index buffer.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const S = VERTEX_BYTES;
  gl.enableVertexAttribArray(ATTR.POS);
  gl.vertexAttribPointer(ATTR.POS, 3, gl.FLOAT, false, S, 0);
  gl.enableVertexAttribArray(ATTR.NORMAL);
  gl.vertexAttribPointer(ATTR.NORMAL, 3, gl.BYTE, true, S, 12);
  gl.enableVertexAttribArray(ATTR.MAT);
  gl.vertexAttribPointer(ATTR.MAT, 1, gl.UNSIGNED_BYTE, false, S, 15);
  gl.enableVertexAttribArray(ATTR.UV);
  gl.vertexAttribPointer(ATTR.UV, 2, gl.UNSIGNED_SHORT, true, S, 16);
  gl.enableVertexAttribArray(ATTR.COLOR);
  gl.vertexAttribPointer(ATTR.COLOR, 3, gl.UNSIGNED_BYTE, true, S, 20);
  gl.enableVertexAttribArray(ATTR.PART);
  gl.vertexAttribPointer(ATTR.PART, 1, gl.UNSIGNED_BYTE, false, S, 23);
  gl.enableVertexAttribArray(ATTR.PIVOT);
  gl.vertexAttribPointer(ATTR.PIVOT, 3, gl.SHORT, false, S, 24);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  const mesh = new Mesh(gl, vao, vbo, ibo, idx.length,
    idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT);
  mesh.vertexCount = vertexCount;
  mesh.triCount = idx.length / 3;
  mesh.bytes = packed.byteLength + idx.byteLength;
  return mesh;
}

export class Mesh {
  constructor(gl, vao, vbo, ibo, count, type) {
    this.gl = gl; this.vao = vao; this.vbo = vbo; this.ibo = ibo;
    this.count = count; this.indexType = type;
    this.triCount = count / 3;
    this.vertexCount = 0; this.bytes = 0;
  }
  draw(instBuffer, instances) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (instBuffer && instances > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer.buffer);
      gl.drawElementsInstanced(gl.TRIANGLES, this.count, this.indexType, 0, instances);
    } else {
      gl.drawElements(gl.TRIANGLES, this.count, this.indexType, 0);
    }
  }
  dispose() {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    this.vao = this.vbo = this.ibo = null;
  }
}

/* ============================================================
   InstanceBuffer — 28 floats, streamed per frame
   ============================================================ */
export class InstanceBuffer {
  constructor(gl, capacity = 128) {
    this.gl = gl;
    this.capacity = capacity;
    this.count = 0;
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  reset() { this.count = 0; }
  ensure(n) {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.capacity = cap;
    const next = new Float32Array(cap * INSTANCE_FLOATS);
    next.set(this.data.subarray(0, this.count * INSTANCE_FLOATS));
    this.data = next;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  /** Write one instance, returns its offset in floats (or -1 when full). */
  alloc() {
    if (this.count >= this.capacity) this.ensure(this.count + 1);
    const off = this.count * INSTANCE_FLOATS;
    this.count++;
    return off;
  }
  upload() {
    if (!this.count) return 0;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * INSTANCE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return this.count;
  }
  attach(mesh) {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const S = INSTANCE_BYTES;
    const setup = (loc, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, S, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    setup(ATTR.I_M0, 0); setup(ATTR.I_M1, 16); setup(ATTR.I_M2, 32); setup(ATTR.I_M3, 48);
    setup(ATTR.I_A, 64); setup(ATTR.I_B, 80); setup(ATTR.I_C, 96); setup(ATTR.I_D, 112);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  dispose() { if (this.buffer) this.gl.deleteBuffer(this.buffer); this.buffer = null; }
}

/* ============================================================
   Textures
   ============================================================ */
export function createTexture2D(gl, o) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const ifmt = o.internalFormat || gl.RGBA8;
  const fmt = o.format || gl.RGBA;
  const type = o.type || gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, o.width, o.height, 0, fmt, type, o.data || null);
  const wrap = o.wrap ?? gl.REPEAT;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.filter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
    o.mipmap === false ? (o.filter || gl.LINEAR) : gl.LINEAR_MIPMAP_LINEAR);
  if (o.mipmap !== false) gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  tex.__w = o.width; tex.__h = o.height;
  return tex;
}

export function createTextureArray(gl, o) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, o.width, o.height, o.layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, o.data || null);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, o.wrap ?? gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, o.wrap ?? gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER,
    o.mipmap === false ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR);
  if (o.mipmap !== false) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}

export function updateTextureLayer(gl, tex, layer, w, h, rgba) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
}

/* ============================================================
   Render targets
   ============================================================ */
export class RenderTarget {
  constructor(gl, width, height, o = {}) {
    this.gl = gl;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    const ifmt = o.float ? gl.RGBA16F : gl.RGBA8;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, this.width, this.height, 0, gl.RGBA,
      o.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    if (o.depth) {
      this.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }
  dispose() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.color) gl.deleteTexture(this.color);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    this.fbo = this.color = this.depth = null;
  }
}

export class ShadowMap {
  constructor(gl, size = 1024) {
    this.gl = gl;
    this.size = size;
    this.fbo = gl.createFramebuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.size, this.size);
  }
  dispose() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fbo = this.tex = null;
  }
}

/* ============================================================
   Fullscreen triangle helpers
   ============================================================ */
export function createFullscreenVAO(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buf };
}
export function drawFullscreen(gl, fs) {
  gl.bindVertexArray(fs.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
