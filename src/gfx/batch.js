/* ============================================================
   batch.js — instanced geometry batches
   One VAO + one vertex buffer per model, one streamed instance
   buffer per draw batch. 28 floats per instance (see gl.js).
   ============================================================ */
import { createMesh, InstanceBuffer, INSTANCE_FLOATS } from '../core/gl.js';

export class InstanceBatch {
  constructor(gl, geo, maxInstances = 256) {
    this.gl = gl;
    this.max = maxInstances;
    this.count = 0;
    this.mesh = createMesh(gl, geo.v || geo.vertices, geo.i || geo.indices);
    this.instances = new InstanceBuffer(gl, maxInstances);
    this.instances.attach(this.mesh);
    this.triCount = this.mesh.triCount;
  }
  begin() { this.instances.reset(); this.count = 0; }
  /**
   * Push one instance.
   * @param {Float32Array|number[]} m column-major model matrix
   */
  push(m, r = 1, g = 1, b = 1, progress = 1, damage = 0, alpha = 1, seed = 0,
    ax = 0, ay = 0, az = 0, aw = 0, ex = 0, bob = 0, atk = 0, sway = 0) {
    const ib = this.instances;
    if (ib.count >= ib.capacity) {
      // grow, re-attach (capacity only grows for walls/units)
      const prev = ib.capacity;
      ib.ensure(ib.count + 1);
      if (ib.capacity !== prev) ib.attach(this.mesh);
    }
    const o = ib.count * INSTANCE_FLOATS;
    const d = ib.data;
    d[o] = m[0]; d[o + 1] = m[1]; d[o + 2] = m[2]; d[o + 3] = m[3];
    d[o + 4] = m[4]; d[o + 5] = m[5]; d[o + 6] = m[6]; d[o + 7] = m[7];
    d[o + 8] = m[8]; d[o + 9] = m[9]; d[o + 10] = m[10]; d[o + 11] = m[11];
    d[o + 12] = m[12]; d[o + 13] = m[13]; d[o + 14] = m[14]; d[o + 15] = m[15];
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = progress;
    d[o + 20] = damage; d[o + 21] = alpha; d[o + 22] = seed; d[o + 23] = 0;
    d[o + 24] = ax; d[o + 25] = ay; d[o + 26] = az; d[o + 27] = aw;
    d[o + 28] = ex; d[o + 29] = bob; d[o + 30] = atk; d[o + 31] = sway;
    ib.count++;
    this.count = ib.count;
    return true;
  }
  flush() { this.instances.upload(); return this.count; }
  draw() {
    if (!this.instances.count) return;
    this.mesh.draw(this.instances, this.instances.count);
  }
  dispose() {
    this.mesh.dispose();
    this.instances.dispose();
  }
}

/* ============================================================
   QuadBatch — camera-facing or ground-hugging instanced quads
   12 floats per instance: pos+size, rgba, extra
   ============================================================ */
export class QuadBatch {
  constructor(gl, floatsPerInstance = 12, max = 2048) {
    this.gl = gl;
    this.fpi = floatsPerInstance;
    this.max = max;
    this.data = new Float32Array(max * floatsPerInstance);
    this.count = 0;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = floatsPerInstance * 4;
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  begin() { this.count = 0; }
  push(a, b, c, d, e, f, g, h, i, j, k, l) {
    if (this.count >= this.max) return false;
    const o = this.count * this.fpi;
    const arr = this.data;
    arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d;
    arr[o + 4] = e; arr[o + 5] = f; arr[o + 6] = g; arr[o + 7] = h;
    arr[o + 8] = i; arr[o + 9] = j; arr[o + 10] = k; arr[o + 11] = l;
    this.count++;
    return true;
  }
  flush() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * this.fpi);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  draw() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
  }
  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.cornerBuf);
  }
}
