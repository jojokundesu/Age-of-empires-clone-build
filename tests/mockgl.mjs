/* A recording mock of the WebGL2 API.
   It cannot rasterise, but it *does* execute every code path in gl.js,
   renderer.js and the model builders, so it catches undefined fields,
   wrong buffer sizes, missing uniforms and JavaScript errors in the render
   loop — the class of bug that otherwise only appears on the phone.   */

export function createMockGL(opts = {}) {
  const log = { drawCalls: 0, tris: 0, programs: [], uniforms: new Set(), unknownUniforms: new Set(), attribs: new Set(), textures: 0, buffers: 0 };
  const constCache = new Map();
  let nextConst = 0x1000;
  const constFor = (name) => {
    if (!constCache.has(name)) constCache.set(name, nextConst++);
    return constCache.get(name);
  };
  const programSources = new WeakMap();
  const shaderSources = new WeakMap();
  const shaderPrograms = [];

  const base = {
    /* --- shader plumbing ------------------------------------------- */
    createShader(type) { return { type, src: '' }; },
    shaderSource(sh, src) { sh.src = src; shaderSources.set(sh, src); },
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    deleteShader() {},
    createProgram() { const p = { shaders: [] }; shaderPrograms.push(p); return p; },
    attachShader(p, sh) { p.shaders.push(sh); log.programs.push(sh.src.length); programSources.set(p, p.shaders.map((s) => s.src).join('\n')); },
    linkProgram() {},
    getProgramParameter(p, what) {
      if (what === constFor('LINK_STATUS')) return true;
      if (what === constFor('ACTIVE_UNIFORMS')) return 8;
      return true;
    },
    getProgramInfoLog() { return ''; },
    useProgram() {},
    deleteProgram() {},
    getUniformLocation(p, name) {
      log.uniforms.add(name);
      const src = programSources.get(p) || '';
      const re = new RegExp(`uniform\\s+\\w+\\s+${name}\\s*[;\\[]`);
      if (!re.test(src)) log.unknownUniforms.add(name);
      return { name };
    },
    getAttribLocation(p, name) { return { name }; },

    /* --- buffers / meshes ------------------------------------------ */
    createBuffer() { log.buffers++; return { b: log.buffers, bytes: 0 }; },
    bindBuffer() {},
    bufferData(target, data) {
      if (typeof data === 'number') { if (data < 0) throw new Error('negative bufferData'); }
      else if (data && data.byteLength === 0) throw new Error('empty bufferData');
    },
    bufferSubData(target, off, data, srcOff, len) {
      if (off < 0) throw new Error('negative bufferSubData offset');
      if (data && data.buffer && (srcOff + len) > data.length) throw new Error('bufferSubData overrun');
    },
    createVertexArray() { return {}; },
    bindVertexArray() {},
    deleteVertexArray() {},
    enableVertexAttribArray(loc) { if (loc >= 16) throw new Error('attrib location ' + loc + ' out of range'); log.attribs.add(loc); },
    vertexAttribPointer(loc, size, type, norm, stride, off) {
      if (loc >= 16) throw new Error('attrib location ' + loc);
      if (stride < 0 || off < 0) throw new Error('bad stride/offset');
      if (stride && off + size * 4 > stride + 4) { /* loose check; packed formats pass */ }
    },
    vertexAttribDivisor() {},

    /* --- textures -------------------------------------------------- */
    createTexture() { log.textures++; return { t: log.textures }; },
    bindTexture() {},
    texImage2D() {},
    texImage3D() {},
    texStorage3D() {},
    texSubImage2D() {},
    texSubImage3D() {},
    texParameteri() {},
    texParameterf() {},
    generateMipmap() {},
    activeTexture() {},
    pixelStorei() {},
    deleteTexture() {},

    /* --- framebuffers ---------------------------------------------- */
    createFramebuffer() { return {}; },
    bindFramebuffer() {},
    framebufferTexture2D() {},
    framebufferRenderbuffer() {},
    createRenderbuffer() { return {}; },
    bindRenderbuffer() {},
    renderbufferStorage() {},
    checkFramebufferStatus() { return constFor('FRAMEBUFFER_COMPLETE'); },
    deleteFramebuffer() {},
    deleteRenderbuffer() {},
    drawBuffers() {},
    readBuffer() {},

    /* --- drawing ---------------------------------------------------- */
    drawElements(mode, count, type, off) {
      if (count % 3 !== 0) throw new Error('drawElements count not a multiple of 3: ' + count);
      log.drawCalls++; log.tris += count / 3;
    },
    drawElementsInstanced(mode, count, type, off, instances) {
      if (count % 3 !== 0) throw new Error('instanced count not tris: ' + count);
      if (instances < 0) throw new Error('negative instance count');
      log.drawCalls++; log.tris += (count / 3) * instances;
    },
    drawArrays(mode, first, count) { log.drawCalls++; },
    drawArraysInstanced(mode, first, count, n) {
      if (n < 0) throw new Error('negative instance count');
      log.drawCalls++;
    },

    /* --- state ------------------------------------------------------ */
    clear() {}, clearColor() {}, clearDepth() {}, colorMask() {},
    enable() {}, disable() {}, depthFunc() {}, depthMask() {},
    blendFunc() {}, blendFuncSeparate() {}, cullFace() {}, frontFace() {},
    polygonOffset() {}, viewport() {}, scissor() {},
    uniform1i() {}, uniform1f() {}, uniform2f() {}, uniform3f() {}, uniform4f() {},
    uniformMatrix4fv() {},

    /* --- queries ---------------------------------------------------- */
    getExtension(name) {
      if (name === 'EXT_texture_filter_anisotropic') return { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF };
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 };
      return null;
    },
    getParameter(p) {
      if (p === 0x9246) return 'Mock Adreno 610';
      if (p === 0x9245) return 'Mock';
      if (p === 0x84FF) return 4;
      if (p === constFor('MAX_TEXTURE_SIZE')) return 4096;
      return 4096;
    },
    getError() { return 0; },
    isContextLost() { return false; },
  };

  const gl = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return constFor(key);
      if (/^create/.test(key)) return () => ({});
      // unknown method: no-op, but remember it so tests can complain
      return (...args) => { (log.unknownMethods || (log.unknownMethods = new Set())).add(key); return undefined; };
    }
  });
  gl.log = log;
  gl.canvas = { width: 900, height: 420 };
  return gl;
}
