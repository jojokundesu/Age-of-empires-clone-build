/* ============================================================
   pathfind.js — A* over a 256x256 navigation grid
   Generation-stamped arrays (no per-search clearing), a binary heap,
   path smoothing by line-of-sight, and a small LRU path cache.
   Worst case is bounded so a bad click can never stall a frame.
   ============================================================ */

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]
];

class MinHeap {
  constructor(cap) {
    this.nodes = new Int32Array(cap);
    this.f = new Float32Array(cap);
    this.size = 0;
  }
  clear() { this.size = 0; }
  push(node, f) {
    let i = this.size++;
    const nodes = this.nodes, fs = this.f;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fs[parent] <= f) break;
      nodes[i] = nodes[parent];
      fs[i] = fs[parent];
      i = parent;
    }
    nodes[i] = node;
    fs[i] = f;
  }
  pop() {
    if (!this.size) return -1;
    const nodes = this.nodes, fs = this.f;
    const top = nodes[0];
    const lastNode = nodes[--this.size];
    const lastF = fs[this.size];
    let i = 0;
    while (true) {
      const l = i * 2 + 1, r = l + 1;
      if (l >= this.size) break;
      let child = l;
      if (r < this.size && fs[r] < fs[l]) child = r;
      if (fs[child] >= lastF) break;
      nodes[i] = nodes[child];
      fs[i] = fs[child];
      i = child;
    }
    nodes[i] = lastNode;
    fs[i] = lastF;
    return top;
  }
}

export class PathFinder {
  constructor(cells = 128, cellSize = 4, half = 256) {
    this.cells = cells;
    this.cellSize = cellSize;
    this.half = half;
    this.blocked = new Uint8Array(cells * cells);
    this.cost = new Float32Array(cells * cells);
    this.g = new Float32Array(cells * cells);
    this.from = new Int32Array(cells * cells);
    this.stamp = new Uint32Array(cells * cells);
    this.closed = new Uint32Array(cells * cells);
    this.currentStamp = 1;
    this.heap = new MinHeap(cells * cells);
    this.cache = new Map();
    this.version = 1;
    this.maxNodes = 6000;
    /* Two budgets, both reset every tick by Game.update(). Counting *nodes*
       rather than searches is what keeps a 40-unit group order from turning
       into one long frame: a search that runs out of budget still returns the
       best partial path it found, so units start walking instead of freezing. */
    this.searchBudget = 24;
    this.nodeBudget = 14000;
    this.budget = 1e9;              // legacy: max searches per tick
    this.stats = { searches: 0, nodes: 0, hits: 0, skipped: 0 };
  }
  beginTick() {
    this.searchBudget = 24;
    this.nodeBudget = 14000;
    this.budget = 1e9;
    this.stats.searches = 0;
    this.stats.nodes = 0;
    this.stats.hits = 0;
    this.stats.skipped = 0;
  }
  idx(cx, cz) { return cz * this.cells + cx; }
  setGrid(blocked, half) {
    if (blocked.length === this.blocked.length) this.blocked.set(blocked);
    if (half) this.half = half;
    this.version++;
    this.cache.clear();
  }
  worldToCell(x, z) {
    const h = this.half;
    return [
      Math.max(0, Math.min(this.cells - 1, Math.floor((x + h) / this.cellSize))),
      Math.max(0, Math.min(this.cells - 1, Math.floor((z + h) / this.cellSize)))
    ];
  }
  cellToWorld(cx, cz) {
    return [cx * this.cellSize - this.half + this.cellSize * 0.5, cz * this.cellSize - this.half + this.cellSize * 0.5];
  }
  isBlocked(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.cells || cz >= this.cells) return true;
    return this.blocked[cz * this.cells + cx] !== 0;
  }
  setBlockedWorld(x, z, w, d, blocked, pad = 0) {
    const [x0, z0] = this.worldToCell(x - w / 2 - pad, z - d / 2 - pad);
    const [x1, z1] = this.worldToCell(x + w / 2 + pad, z + d / 2 + pad);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        this.blocked[cz * this.cells + cx] = blocked ? 1 : 0;
      }
    }
    this.version++;
  }
  setBlockedCircle(x, z, r, blocked) {
    const [x0, z0] = this.worldToCell(x - r, z - r);
    const [x1, z1] = this.worldToCell(x + r, z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const [wx, wz] = this.cellToWorld(cx, cz);
        if ((wx - x) ** 2 + (wz - z) ** 2 <= r * r) this.blocked[cz * this.cells + cx] = blocked ? 1 : 0;
      }
    }
    this.version++;
  }
  clearCache() { this.cache.clear(); }

  /** Line-of-sight test across cells. */
  lineClear(x0, z0, x1, z1) {
    let [cx0, cz0] = this.worldToCell(x0, z0);
    const [cx1, cz1] = this.worldToCell(x1, z1);
    let dx = Math.abs(cx1 - cx0), dz = Math.abs(cz1 - cz0);
    const sx = cx0 < cx1 ? 1 : -1, sz = cz0 < cz1 ? 1 : -1;
    let err = dx - dz;
    let guard = 0;
    while (guard++ < 400) {
      if (this.isBlocked(cx0, cz0)) return false;
      if (cx0 === cx1 && cz0 === cz1) return true;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; cx0 += sx; }
      if (e2 < dx) { err += dx; cz0 += sz; }
    }
    return false;
  }

  /**
   * Find a path. Returns array of [x,z] waypoints (world), or null.
   * @param {number} sx start x
   * @param {number} sz start z
   * @param {number} gx goal x
   * @param {number} gz goal z
   * @param {number} radius goal tolerance in cells
   */
  find(sx, sz, gx, gz, radius = 2) {
    if (this.budget <= 0 || this.searchBudget <= 0 || this.nodeBudget <= 0) {
      /* Out of budget: say so explicitly. Callers must not treat this as
         "there is no path" -- that used to increment the failure counter and
         fire the (very expensive) unstick routine on every unit in the queue. */
      this.stats.skipped++;
      this.lastWasSkip = true;
      return null;
    }
    this.lastWasSkip = false;
    this.budget--;
    this.searchBudget--;
    let [sx0, sz0] = this.worldToCell(sx, sz);
    const [gx0, gz0] = this.worldToCell(gx, gz);

    /* One line-of-sight ray answers most requests outright. On an open island
       nearly every order has a clear line, and a ray costs a few microseconds
       against a 0.5 ms search -- this is the cheapest 80 % of the pathfinder. */
    if (this.lineClear(sx, sz, gx, gz)) {
      this.stats.hits++;
      return [[sx, sz], [gx, gz]];
    }
    if (this.isBlocked(sx0, sz0)) {
      // walk out of a blocked start cell
      let found = false;
      for (let r = 1; r <= 4 && !found; r++) {
        for (let dz = -r; dz <= r && !found; dz++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (!this.isBlocked(sx0 + dx, sz0 + dz)) { sx0 += dx; sz0 += dz; found = true; }
          }
        }
      }
      if (!found) return null;
    }
    let goal = this.idx(gx0, gz0);
    let goalBlocked = this.isBlocked(gx0, gz0);
    if (goalBlocked) {
      let best = -1, bestD = 1e9;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = gx0 + dx, nz = gz0 + dz;
          if (this.isBlocked(nx, nz)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = this.idx(nx, nz); }
        }
      }
      if (best < 0) return null;
      goal = best;
    }
    const start = this.idx(sx0, sz0);
    if (start === goal) {
      const [wx, wz] = this.cellToWorld(gx0, gz0);
      return [[wx, wz]];
    }
    const cacheKey = start * 131071 + goal;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.version === this.version) {
      this.stats.hits++;
      return cached.path;
    }

    const stamp = ++this.currentStamp;
    if (stamp >= 0xfffffffe) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.currentStamp = 2;
    }
    const cells = this.cells;
    const heap = this.heap;
    heap.clear();
    const gArr = this.g, costArr = this.cost, fromArr = this.from, stampArr = this.stamp, closedArr = this.closed, blockedArr = this.blocked;

    const gxw = goal % cells, gzw = (goal / cells) | 0;
    /* The step cost is 1.25 per straight cell (0.75 + 0.5 * cost), so the
       heuristic has to be in the same units or A* under-estimates by 20 % and
       floods the open map: 6000 nodes instead of ~120, 12 ms instead of 0.2. */
    const heur = (cx, cz) => {
      const dx = Math.abs(cx - gxw), dz = Math.abs(cz - gzw);
      return ((dx + dz) + (1.4142 - 2) * Math.min(dx, dz)) * 1.25;
    };
    stampArr[start] = stamp;
    gArr[start] = 0;
    fromArr[start] = -1;
    costArr[start] = 1;
    heap.push(start, heur(sx0, sz0));
    let found = false;
    let nodes = 0;
    let bestNode = start;
    let bestH = heur(sx0, sz0);
    while (heap.size > 0 && nodes < this.maxNodes && this.nodeBudget > 0) {
      const cur = heap.pop();
      this.nodeBudget--;
      if (closedArr[cur] === stamp) continue;
      closedArr[cur] = stamp;
      nodes++;
      if (cur === goal) { found = true; break; }
      const cx = cur % cells, cz = (cur / cells) | 0;
      const h = heur(cx, cz);
      if (h < bestH) { bestH = h; bestNode = cur; }
      const gCur = gArr[cur];
      for (let d = 0; d < 8; d++) {
        const dir = DIRS[d];
        const nx = cx + dir[0], nz = cz + dir[1];
        if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
        const ni = nz * cells + nx;
        if (blockedArr[ni] || closedArr[ni] === stamp) continue;
        // no corner cutting
        if (d >= 4) {
          if (blockedArr[cz * cells + nx] || blockedArr[nz * cells + cx]) continue;
        }
        const stepCost = dir[2] * (0.75 + 0.5 * (costArr[ni] || 1));
        const ng = gCur + stepCost;
        if (stampArr[ni] !== stamp || ng < gArr[ni]) {
          stampArr[ni] = stamp;
          gArr[ni] = ng;
          fromArr[ni] = cur;
          costArr[ni] = 1;
          heap.push(ni, ng + heur(nx, nz) * 1.02);
        }
      }
    }
    this.stats.searches++;
    this.stats.nodes += nodes;
    if (!found) {
      // Nothing explored at all (we are in a pocket): hand back a straight line
      // and let local avoidance deal with it rather than freezing the unit.
      if (bestNode === start) return [[gx, gz]];
      goal = bestNode; // partial path to the closest explored cell
    }
    // reconstruct -- a partial path can be thousands of cells long, so keep a
    // hard ceiling rather than trusting the map to be small
    const raw = [];
    let n = goal;
    let guard = 0;
    while (n !== -1 && guard++ < 1024) {
      raw.push(n);
      if (n === start) break;
      n = fromArr[n];
    }
    raw.reverse();
    if (raw.length < 2) {
      const [wx, wz] = this.cellToWorld(goal % cells, (goal / cells) | 0);
      const out = [[wx, wz]];
      this.cache.set(cacheKey, { path: out, version: this.version });
      return out;
    }
    /* String-pull the raw cell chain with a doubling + binary-search probe.
       The old code tried every cell pair (up to 4096 rays of 400 steps each,
       16 ms on a long path); this reaches the same corners in a handful of
       rays per waypoint. */
    const smooth = [];
    const nPts = raw.length;
    let a = 0;
    const cx0 = (i) => (raw[i] % cells) * this.cellSize - this.half + this.cellSize * 0.5;
    const cz0 = (i) => ((raw[i] / cells) | 0) * this.cellSize - this.half + this.cellSize * 0.5;
    smooth.push([cx0(0), cz0(0)]);
    while (a < nPts - 1) {
      let reach = a + 1;
      // exponential probe for an upper bound that is definitely blocked
      let probe = Math.min(nPts - 1, a + 2);
      let last = probe;
      while (probe < nPts - 1 && this.lineClear(cx0(a), cz0(a), cx0(probe), cz0(probe))) {
        reach = probe;
        last = probe;
        probe = Math.min(nPts - 1, a + (probe - a) * 2);
        if (probe === last) break;
      }
      if (this.lineClear(cx0(a), cz0(a), cx0(nPts - 1), cz0(nPts - 1))) reach = nPts - 1;
      // binary refine between the last known-good and the blocked probe
      let lo = reach + 1, hi = Math.min(nPts - 1, probe);
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.lineClear(cx0(a), cz0(a), cx0(mid), cz0(mid))) { reach = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (reach <= a) reach = a + 1;
      a = reach;
      smooth.push([cx0(a), cz0(a)]);
    }
    // anchor the path at the unit's true position so it never walks back to
    // the centre of its own cell, and finish exactly on the target
    smooth[0] = [sx, sz];
    if (!goalBlocked) smooth[smooth.length - 1] = [gx, gz];
    if (this.cache.size > 320) this.cache.clear();
    this.cache.set(cacheKey, { path: smooth, version: this.version });
    return smooth;
  }

  /** Straight-line walk check for a unit radius. */
  canWalk(sx, sz, gx, gz) {
    return this.lineClear(sx, sz, gx, gz);
  }
}
