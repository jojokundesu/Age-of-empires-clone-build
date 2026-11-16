/* ============================================================
   palette.js — the bone-palette texture manager

   One RGBA32F texture holds every pose in the frame. Each unit owns
   a row; the vertex shader reads its four bone matrices out of that
   row with texelFetch.

   The two performance decisions that live here:

   1. UPLOAD ONCE PER FRAME, as a sub-rectangle of only the rows that
      actually changed. A full 128x512 RGBA32F upload is 2 MB; at
      60 Hz that is 120 MB/s uploaded for nothing, since most units
      are at a reduced animation rate and their row is identical to
      last frame.

   2. ROW REUSE, not a new row per unit. Units are pooled by the sim,
      so a row is handed back when a unit leaves the field. Without
      that the texture would need 512 rows for a 300-unit match only
      because dead units never released theirs.
   ============================================================ */

import { BONE_COUNT } from './skeleton.js';
import { createTexture2D } from '../../core/gl.js';

export const BONES_PER_ROW = 32;                 // texture width / 4
export const ROW_TEXELS = BONES_PER_ROW * 4;

export class BonePalette {
  constructor(gl, maxRows = 512) {
    this.gl = gl;
    this.maxRows = maxRows;
    this.width = ROW_TEXELS;
    /* CPU staging buffer: one row = BONES_PER_ROW * 16 floats */
    this.rowFloats = BONES_PER_ROW * 16;
    this.data = new Float32Array(this.width * maxRows * 4);
    this.rowOwner = new Int32Array(maxRows).fill(0);
    this.dirty = new Uint8Array(maxRows);
    this.freeRows = [];
    for (let i = maxRows - 1; i >= 0; i--) this.freeRows.push(i);
    this.used = 0;
    this.uploadsThisFrame = 0;
    this.bytesThisFrame = 0;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;

    this.texture = createTexture2D(gl, {
      width: this.width,
      height: maxRows,
      internalFormat: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      filter: gl.NEAREST,      // texelFetch never filters; avoid the extension
      wrap: gl.CLAMP_TO_EDGE,
      mipmap: false
    });
  }

  /** Claim a row for a unit. Returns -1 when the table is full. */
  allocRow() {
    const r = this.freeRows.pop();
    if (r === undefined) return -1;
    this.used++;
    this.rowOwner[r] = 1;
    return r;
  }

  releaseRow(row) {
    if (row < 0 || row >= this.maxRows) return;
    if (this.rowOwner[row] !== 1) return;
    this.rowOwner[row] = 0;
    this.freeRows.push(row);
    this.used--;
  }

  /**
   * Copy a composed palette (BONE_COUNT*16 floats) into a row and mark it
   * dirty. `palette` is model-space, column-major, exactly as
   * buildPalette() produced it.
   */
  writeRow(row, palette) {
    if (row < 0 || row >= this.maxRows) return;
    const o = row * this.width * 4;
    const n = Math.min(BONE_COUNT * 16, this.rowFloats);
    this.data.set(palette.subarray(0, n), o);
    if (this.dirty[row] !== 1) {
      this.dirty[row] = 1;
      if (row < this.dirtyMin) this.dirtyMin = row;
      if (row > this.dirtyMax) this.dirtyMax = row;
    }
  }

  /**
   * Upload the changed span. One texSubImage2D for the whole frame when the
   * dirty rows are contiguous (the common case, because units are allocated
   * in order), otherwise one per run.
   */
  flush() {
    const gl = this.gl;
    this.uploadsThisFrame = 0;
    this.bytesThisFrame = 0;
    if (this.dirtyMax < 0) return 0;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const W = this.width;
    let runStart = -1;
    for (let r = this.dirtyMin; r <= this.dirtyMax + 1; r++) {
      const isDirty = r <= this.dirtyMax && this.dirty[r] === 1;
      if (isDirty && runStart < 0) runStart = r;
      if (!isDirty && runStart >= 0) {
        const rows = r - runStart;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, runStart, W, rows, gl.RGBA, gl.FLOAT,
          this.data, (runStart * W * 4));
        this.uploadsThisFrame++;
        this.bytesThisFrame += W * rows * 16;
        for (let k = runStart; k < r; k++) this.dirty[k] = 0;
        runStart = -1;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    /* Out-of-frame upload leaves the per-program texture cache lying. */
    if (this.onInvalidate) this.onInvalidate();
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    return this.bytesThisFrame;
  }

  dispose() {
    if (this.gl && this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
