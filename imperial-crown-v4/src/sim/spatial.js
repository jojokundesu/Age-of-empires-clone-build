/* ============================================================
   spatial.js — uniform hash grid
   Entities are bucketed once per tick; neighbour queries walk only
   the buckets that overlap the circle. No sorting, no allocation.
   ============================================================ */

export class SpatialHash {
  constructor(cellSize = 6, cells = 128) {
    this.cellSize = cellSize;
    this.cells = cells;
    this.buckets = new Array(cells * cells);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
    this.stamp = new Uint32Array(cells * cells);
    this.current = 1;
    this.count = 0;
    this._out = [];
    this.half = 256;
  }
  clear() {
    const b = this.buckets;
    for (let i = 0; i < b.length; i++) if (b[i].length) b[i].length = 0;
    this.count = 0;
  }
  cellIndex(x, z) {
    const cx = Math.floor((x + this.half) / this.cellSize);
    const cz = Math.floor((z + this.half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cells || cz >= this.cells) return -1;
    return cz * this.cells + cx;
  }
  insert(e) {
    const i = this.cellIndex(e.x, e.z);
    if (i < 0) return;
    this.buckets[i].push(e);
    this.count++;
  }
  insertAll(list) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || e.garrisoned) continue;
      this.insert(e);
    }
  }
  /** Fill the shared output array with entities within `radius`. */
  query(x, z, radius) {
    const out = this._out;
    out.length = 0;
    const cs = this.cellSize;
    const x0 = Math.max(0, Math.floor((x - radius + this.half) / cs));
    const x1 = Math.min(this.cells - 1, Math.floor((x + radius + this.half) / cs));
    const z0 = Math.max(0, Math.floor((z - radius + this.half) / cs));
    const z1 = Math.min(this.cells - 1, Math.floor((z + radius + this.half) / cs));
    const r2 = radius * radius;
    for (let cz = z0; cz <= z1; cz++) {
      const row = cz * this.cells;
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.buckets[row + cx];
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          const dx = e.x - x, dz = e.z - z;
          if (dx * dx + dz * dz <= r2) out.push(e);
        }
      }
    }
    return out;
  }
}
