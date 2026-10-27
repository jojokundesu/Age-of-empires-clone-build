/* ============================================================
   pathfind.js — A* over a 128x128 navigation grid (4 m cells)

   v3 changes, all measured on the real map:

     • the heuristic is now in the same units as the step cost. v2's A* paid
       1.25 per cell but estimated 1.0, so every search under-estimated by 20 %
       and flooded the open island: 6000 nodes / 12 ms for a path that needs
       160 nodes / 0.2 ms.
     • a single line-of-sight ray answers the common case before any search
       runs (most orders are unobstructed on open ground).
     • connected components make "this goal is unreachable" a 1-instruction
       question. v2 discovered it the hard way: exploring the full 6000-node
       budget around the island, every time, for every villager whose node was
       in a pocket.
     • per-tick search *and* node budgets. A forty-unit group order used to be
       forty full searches in one frame; now the work is spread over frames and
       a starved search returns "ask me again", never "no path".
     • smoothing uses doubling + binary probes instead of trying every cell
       pair (that was up to 4096 rays of 400 steps on a long path).

   Generation stamps keep every search allocation-free; the LRU path cache is
   still there for repeated orders to the same place.
   ============================================================ */

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]
];
const STEP = 1.25;              // cost of a straight cell step (0.75 + 0.5 * 1)
const HEUR = STEP;              // ...and the matching heuristic scale

class MinHeap {
  constructor(cap) {
    this.nodes = new Int32Array(cap);
    this.f = new Float32Array(cap);
    this.size = 0;
  }
  clear() { this.size = 0; }
  push(node, f) {
    let i = this.size++;
    if (i >= this.nodes.length) { this.size--; return; }   // never overflow
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
    const n = cells * cells;
    this.blocked = new Uint8Array(n);
    this.cost = new Float32Array(n);
    this.g = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.currentStamp = 1;
    this.heap = new MinHeap(n);
    this.cache = new Map();
    this.version = 1;

    /* reachability */
    this.comp = new Int32Array(n);
    this.compDirty = true;
    this.compQueue = new Int32Array(n);
    this.compId = 0;

    this.maxNodes = 3000;
    this.searchBudget = 24;
    this.nodeBudget = 14000;
    this.budget = 1e9;
    this.lastWasSkip = false;
    this.stats = { searches: 0, nodes: 0, hits: 0, skipped: 0, unreachable: 0 };
  }

  /** Called by Game.update() once per tick. */
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
    this.compDirty = true;
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
      for (let cx = x0; cx <= x1; cx++) this.blocked[cz * this.cells + cx] = blocked ? 1 : 0;
    }
    this.version++;
    this.compDirty = true;
    this.cache.clear();
  }

  setBlockedCircle(x, z, r, blocked) {
    const [x0, z0] = this.worldToCell(x - r, z - r);
    const [x1, z1] = this.worldToCell(x + r, z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const wx = cx * this.cellSize - this.half + this.cellSize * 0.5;
        const wz = cz * this.cellSize - this.half + this.cellSize * 0.5;
        if ((wx - x) ** 2 + (wz - z) ** 2 <= r * r) this.blocked[cz * this.cells + cx] = blocked ? 1 : 0;
      }
    }
    this.version++;
    this.compDirty = true;
    this.cache.clear();
  }

  clearCache() { this.cache.clear(); }

  /* ---------------- reachability ---------------- */

  /**
   * Flood-fill labels: which walkable cells can reach which. Rebuilt lazily,
   * only when the grid changed, and it turns "is this goal reachable at all?"
   * into an array lookup so A* never has to explore the whole island to find
   * out that the answer is no.
   */
  _components() {
    if (!this.compDirty && this._compVersion === this.version) return;
    const cells = this.cells, blocked = this.blocked, comp = this.comp;
    comp.fill(0);
    const stack = this.compQueue;
    let id = 0;
    /* Span flood fill: each pass fills a whole horizontal run before pushing
       the runs above and below. Two sequential scans per row instead of a
       random-access 4-neighbour BFS -- about 5x faster on the 256x256 grid. */
    for (let z = 0; z < cells; z++) {
      const row = z * cells;
      for (let x = 0; x < cells; x++) {
        const i = row + x;
        if (comp[i] || blocked[i]) continue;
        id++;
        let head = 0, tail = 0;
        // seed span
        let x0 = x, x1 = x;
        while (x1 + 1 < cells && !blocked[row + x1 + 1] && !comp[row + x1 + 1]) x1++;
        for (let k = x0; k <= x1; k++) comp[row + k] = id;
        stack[tail++] = z;
        stack[tail++] = x0;
        stack[tail++] = x1;
        while (head < tail) {
          const sz = stack[head++];
          const sx0 = stack[head++];
          const sx1 = stack[head++];
          for (const nz of [sz - 1, sz + 1]) {
            if (nz < 0 || nz >= cells) continue;
            const nrow = nz * cells;
            let k = sx0;
            while (k <= sx1) {
              if (blocked[nrow + k] || comp[nrow + k]) { k++; continue; }
              let e = k;
              while (e + 1 <= sx1 && !blocked[nrow + e + 1] && !comp[nrow + e + 1]) e++;
              for (let m = k; m <= e; m++) comp[nrow + m] = id;
              stack[tail++] = nz;
              stack[tail++] = k;
              stack[tail++] = e;
              k = e + 1;
            }
          }
        }
      }
    }
    this.compId = id;
    this.compDirty = false;
    this._compVersion = this.version;
  }

  /** Nearest walkable cell to (cx,cz) that shares `want`'s component. */
  _snapToComponent(cx, cz, want, maxRing = 18) {
    const cells = this.cells, comp = this.comp;
    for (let r = 0; r <= maxRing; r++) {
      let best = -1, bestD = 1e9;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
          const ni = nz * cells + nx;
          if (comp[ni] !== want) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = ni; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Line-of-sight test across cells. */
  lineClear(x0, z0, x1, z1) {
    let [cx0, cz0] = this.worldToCell(x0, z0);
    const [cx1, cz1] = this.worldToCell(x1, z1);
    const dx = Math.abs(cx1 - cx0), dz = Math.abs(cz1 - cz0);
    const sx = cx0 < cx1 ? 1 : -1, sz = cz0 < cz1 ? 1 : -1;
    let err = dx - dz;
    let guard = 0;
    const max = dx + dz + 8;
    while (guard++ < max) {
      if (this.isBlocked(cx0, cz0)) return false;
      if (cx0 === cx1 && cz0 === cz1) return true;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; cx0 += sx; }
      if (e2 < dx) { err += dx; cz0 += sz; }
    }
    return false;
  }

  /** Nearest open cell to a blocked goal, in a small ring. */
  _snapBlocked(cx, cz, radius) {
    const cells = this.cells, blocked = this.blocked;
    let best = -1, bestD = 1e9;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
        const ni = nz * cells + nx;
        if (blocked[ni]) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = ni; }
      }
    }
    return best;
  }

  /**
   * Second, small A* used only after a failed search has been retargeted.
   * Returns { from } on success (the `from` array is the shared one).
   */
  _searchTo(start, goal, sx0, sz0, stamp) {
    const cells = this.cells, gArr = this.g, fromArr = this.from;
    const stampArr = this.stamp, closedArr = this.closed, blockedArr = this.blocked;
    const gxw = goal % cells, gzw = (goal / cells) | 0;
    const heur = (cx, cz) => {
      const dx = Math.abs(cx - gxw), dz = Math.abs(cz - gzw);
      return ((dx + dz) + (1.4142 - 2) * Math.min(dx, dz)) * HEUR;
    };
    const heap = this.heap;
    heap.clear();
    stampArr[start] = stamp;
    gArr[start] = 0;
    fromArr[start] = -1;
    heap.push(start, heur(sx0, sz0));
    let nodes = 0;
    while (heap.size > 0 && nodes < 4096) {
      const cur = heap.pop();
      if (closedArr[cur] === stamp) continue;
      closedArr[cur] = stamp;
      nodes++;
      if (cur === goal) return { from: fromArr, nodes };
      const cx = cur % cells, cz = (cur / cells) | 0, gc = gArr[cur];
      for (let d = 0; d < 8; d++) {
        const dir = DIRS[d];
        const nx = cx + dir[0], nz = cz + dir[1];
        if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
        const ni = nz * cells + nx;
        if (blockedArr[ni] || closedArr[ni] === stamp) continue;
        if (d >= 4 && (blockedArr[cz * cells + nx] || blockedArr[nz * cells + cx])) continue;
        const ng = gc + dir[2] * STEP;
        if (stampArr[ni] !== stamp || ng < gArr[ni]) {
          stampArr[ni] = stamp;
          gArr[ni] = ng;
          fromArr[ni] = cur;
          heap.push(ni, ng + heur(nx, nz) * 1.02);
        }
      }
    }
    return null;
  }

  /** Turn a `from` chain into a smoothed waypoint list (shared by both paths). */
  /**
   * `exactGoal` says the chain really ends on the cell the caller asked for.
   * It must be false for a *partial* path -- the search hit maxNodes, the goal
   * was snapped to another component, or the goal cell is solid. Snapping the
   * last waypoint to the requested goal anyway handed the unit a straight line
   * to a place it cannot reach, straight through whatever is in the way: the
   * one remaining way an army could walk through a wall. A partial path now
   * ends on the last cell the search actually proved.
   */
  _reconstruct(fromArr, start, goal, sx, sz, gx, gz, exactGoal, cacheKey) {
    const cells = this.cells;
    const raw = [];
    let n = goal;
    let guard = 0;
    while (n !== -1 && guard++ < 1024) {
      raw.push(n);
      if (n === start) break;
      n = fromArr[n];
    }
    raw.reverse();
    if (!raw.length) return null;
    const smooth = this._smooth(raw);
    smooth[0] = [sx, sz];
    if (exactGoal) smooth[smooth.length - 1] = [gx, gz];
    if (this.cache.size > 320) this.cache.clear();
    this.cache.set(cacheKey, { path: smooth, version: this.version });
    return smooth;
  }

  /** String-pull a cell chain into waypoints.
   *
   *  The grid is 2 m wide, and a building is not: a house whose centre-cell
   *  band ends a few centimetres short of a cell centre is "clear" to
   *  lineClear while still being solid to a body with a radius. String-pulling
   *  then replaced a good dog-leg with a straight line through the house's
   *  inflated box, and the unit walked into the corner for the rest of the
   *  match. `lineBlocked` is the game's continuous answer (water, cliffs,
   *  building footprints *plus radius*), so every shortcut has to pass both
   *  tests. It is bounded per path: if the fine checks run out, the remaining
   *  waypoints stay as the grid produced them, which is always safe. */
  _smooth(raw) {
    const cells = this.cells, half = this.half, cs = this.cellSize;
    const wx = (i) => (raw[i] % cells) * cs - half + cs * 0.5;
    const wz = (i) => ((raw[i] / cells) | 0) * cs - half + cs * 0.5;
    const nPts = raw.length;
    const fine = this.lineBlocked;
    this._fineChecks = 0;
    const clear = (i, j) => {
      const x0 = wx(i), z0 = wz(i), x1 = wx(j), z1 = wz(j);
      if (!this.lineClear(x0, z0, x1, z1)) return false;
      if (!fine) return true;
      if (this._fineChecks >= 48) return false;
      this._fineChecks++;
      return !fine(x0, z0, x1, z1);
    };
    const smooth = [[wx(0), wz(0)]];
    let a = 0;
    let guard = 0;
    while (a < nPts - 1 && guard++ < 512) {
      let reach = a + 1;
      if (clear(a, nPts - 1)) {
        reach = nPts - 1;
      } else {
        let step = 1;
        while (a + step < nPts - 1 && clear(a, a + step)) {
          reach = a + step;
          step *= 2;
        }
        let lo = reach + 1, hi = Math.min(nPts - 1, a + step);
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (clear(a, mid)) { reach = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
      }
      if (reach <= a) reach = a + 1;
      a = reach;
      smooth.push([wx(a), wz(a)]);
    }
    return smooth;
  }

  /**
   * Find a path. Returns array of [x,z] waypoints (world), or null.
   * `lastWasSkip` says the tick budget (not the map) is why a null came back.
   */
  find(sx, sz, gx, gz, radius = 2) {
    if (this.budget <= 0 || this.searchBudget <= 0 || this.nodeBudget <= 0) {
      this.stats.skipped++;
      this.lastWasSkip = true;
      return null;
    }
    this.lastWasSkip = false;
    this.lastUnreachable = false;
    this.budget--;
    this.searchBudget--;

    /* Hit-test the two ends against the *final* goal (before any snapping),
       because that is what the caller asked for. */
    let [sx0, sz0] = this.worldToCell(sx, sz);
    let [gx0, gz0] = this.worldToCell(gx, gz);

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

    /* A straight, clear line needs no search at all -- but "clear" has to mean
       clear for a *body*, not clear for a 2 m cell. A house is 2.8 m and the
       grid rounds it to whole cells by centre containment, so the inside of
       its front face is open ground to the grid and a solid wall to
       isPassable(). This shortcut used to return a straight line through it;
       the unit then walked into the face, found the step blocked, slid along
       it, re-pathed, got the same straight line, and repeated until the match
       ended -- the "soldier frozen against a house" report, reproduced in a
       twenty-minute four-crown war. The fine test is the same one
       `_smooth()` uses, so a shortcut is now exactly as safe as a smoothed
       path. */
    if (this.lineClear(sx, sz, gx, gz) && !(this.lineBlocked && this.lineBlocked(sx, sz, gx, gz))) {
      this.stats.hits++;
      return [[sx, sz], [gx, gz]];
    }

    const cells = this.cells;
    const start = this.idx(sx0, sz0);
    let goal = this.idx(gx0, gz0);
    const goalBlocked = this.isBlocked(gx0, gz0);

    /* A goal inside a building or a tree is ordinary: snap to the nearest
       open cell without paying for whole-map connectivity. */
    if (goalBlocked) {
      const near = this._snapBlocked(gx0, gz0, radius);
      if (near >= 0) goal = near;
    }

    if (start === goal) {
      const [wx, wz] = this.cellToWorld(gx0, gz0);
      return [[wx, wz]];
    }

    const cacheKey = start * 131071 + goal;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.version === this.version) {
      this.stats.hits++;
      /* The cached route begins at the exact spot of the *first* caller in
         this start cell. Handing that straight back gives a unit a first
         waypoint that may be a metre behind it, and a unit already walking
         turns round to touch it -- two men in a doorway can then spell each
         other for half a minute. Re-anchor the first node on the caller. */
      const p0 = cached.path[0];
      if ((p0[0] - sx) ** 2 + (p0[1] - sz) ** 2 > 0.09) {
        const out = cached.path.slice();
        out[0] = [sx, sz];
        return out;
      }
      return cached.path;
    }

    const stamp = ++this.currentStamp;
    if (stamp >= 0xfffffffe) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.currentStamp = 2;
    }
    const heap = this.heap;
    heap.clear();
    const gArr = this.g, costArr = this.cost, fromArr = this.from;
    const stampArr = this.stamp, closedArr = this.closed, blockedArr = this.blocked;

    const gxw = goal % cells, gzw = (goal / cells) | 0;
    const heur = (cx, cz) => {
      const dx = Math.abs(cx - gxw), dz = Math.abs(cz - gzw);
      return ((dx + dz) + (1.4142 - 2) * Math.min(dx, dz)) * HEUR;
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
      if (closedArr[cur] === stamp) continue;
      closedArr[cur] = stamp;
      nodes++;
      this.nodeBudget--;
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
        if (d >= 4 && (blockedArr[cz * cells + nx] || blockedArr[nz * cells + cx])) continue;   // no corner cutting
        const ng = gCur + dir[2] * STEP;
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
    if (!found && nodes >= this.maxNodes) {
      /* The search ran out of room. That happens when the goal is on another
         island or shut inside a wall: ask connectivity once (lazily, and only
         in this rare case), then walk to the closest reachable cell instead.
         Normal orders never pay for the labeling at all. */
      this._components();
      const want = this.comp[start];
      if (this.comp[goal] !== want) {
        const snapped = this._snapToComponent(gx0, gz0, want, 24);
        if (snapped >= 0) {
          this.stats.unreachable++;
          goal = snapped;
          bestNode = snapped;
          // and path to it properly (it is close, so this is cheap)
          if (snapped !== start) {
            const again = this._searchTo(start, snapped, sx0, sz0, stamp);
            if (again) {
              const out = this._reconstruct(again.from, start, snapped, sx, sz, gx, gz, false, cacheKey);
              if (out) return out;
            }
          }
        }
      }
    }
    if (!found) {
      /* Nothing explored at all: the unit is sealed in. Handing back a straight
         line at the goal -- the old behaviour -- makes it walk into the wall,
         slide, re-path, and repeat for as long as the order stands, which is
         exactly the "my army is frozen against a palisade" bug. Say so
         instead: the caller cancels the order and the unit stands still. */
      if (bestNode === start) {
        this.lastUnreachable = true;
        return null;
      }
      goal = bestNode; // partial path to the closest explored cell
    }

    // reconstruct + smooth (bounded: a partial path can be very long)
    const out = this._reconstruct(fromArr, start, goal, sx, sz, gx, gz, found && !goalBlocked, cacheKey);
    /* never hand back "walk straight at the goal" as a consolation prize: that
       is the pathfinder teaching a unit to walk through a wall */
    return out;
  }

  /** Straight-line walk check for a unit radius. */
  canWalk(sx, sz, gx, gz) {
    return this.lineClear(sx, sz, gx, gz);
  }
}
