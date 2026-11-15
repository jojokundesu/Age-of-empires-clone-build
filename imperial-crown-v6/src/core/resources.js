/* ============================================================
   resources.js — centralised GPU + transient resource disposal
   ------------------------------------------------------------
   Every GL object this game owns is created through a small set of
   wrappers (Shader, Mesh, InstanceBatch, RenderTarget, upload8, ...).
   v6 disposed most of them by hand in three different places, which is
   exactly how one forgotten texture survives a match and quietly eats
   the Adreno 610's memory after `onRenderProcessGone`.

   This module is the single authority. It knows three scopes:

     persistent  -- lives as long as the WebGL context (shader programs,
                    baked sprite atlases). Freed by releaseAll().
     world       -- one island (terrain chunks, water mesh, height and
                    albedo textures, prop batches). Freed by
                    releaseScope('world') whenever a map regenerates.
     match       -- one battle (FX pools, projectile pool, selection
                    rings, floating damage text). Freed by
                    releaseScope('match') on quitToMenu().

   The manager offers fixed-capacity ObjectPools and can clear the
   existing particle and projectile pools during match teardown. `disposeObject` also understands
   THREE-style { geometry, material, texture } objects and calls each
   .dispose() in the order the spec asks for, so a future Three.js
   backend (or an imported mod asset) is disposed correctly too.
   ============================================================ */

/** Fixed-capacity, zero-allocation object pool. */
export class ObjectPool {
  constructor(name, factory, capacity = 128, manager = null) {
    this.name = name;
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory(i);
      this.free[i] = capacity - 1 - i;   // pop() returns index 0 first
    }
    this.freeCount = capacity;
    this.highWater = 0;
    this.acquired = 0;
    this.recycled = 0;
    this.handles = this.items.map((item, idx) => ({ idx, item }));
    this.manager = manager;
  }
  /** Borrow a pre-allocated object. Returns null when the pool is drained;
      callers recycle instead of throwing away (no allocation, ever). */
  acquire() {
    if (this.freeCount === 0) return null;
    const idx = this.free[--this.freeCount];
    this.acquired++;
    this.recycled++;
    const used = this.capacity - this.freeCount;
    if (used > this.highWater) this.highWater = used;
    return this.handles[idx];
  }
  /** Return a borrowed slot. Idempotent for a slot already returned: the
      caller never has to remember whether it recycled a dead projectile. */
  release(idx) {
    if (idx < 0 || idx >= this.capacity) return;
    for (let i = 0; i < this.freeCount; i++) if (this.free[i] === idx) return;
    if (this.freeCount >= this.capacity) return;
    this.free[this.freeCount++] = idx;
    this.acquired--;
  }
  /** The render/sim layers iterate the whole pool; this is the flat array. */
  all() { return this.items; }
  reset(onEach) {
    for (let i = 0; i < this.capacity; i++) {
      if (onEach) onEach(this.items[i]);
      this.free[i] = this.capacity - 1 - i;
    }
    this.freeCount = this.capacity;
    this.acquired = 0;
  }
  stats() {
    return { name: this.name, capacity: this.capacity, inUse: this.acquired,
      highWater: this.highWater, recycled: this.recycled };
  }
}

export class ResourceDisposalManager {
  constructor() {
    this.gl = null;
    this.scopes = new Map([['persistent', new Set()], ['world', new Set()], ['match', new Set()]]);
    this.pools = new Map();
    this.externalPools = new Map();      // ProjectilePool / FX: already pooled
    this.disposed = new WeakSet();
    this.counts = { created: 0, disposed: 0, textures: 0, buffers: 0, programs: 0, pools: 0 };
    this.onRelease = null;               // (scope, count) => void, for the HUD
  }

  attachGL(gl) { if (gl && gl !== this.gl) { this.gl = gl; } return this; }
  scope(name) {
    let s = this.scopes.get(name);
    if (!s) { s = new Set(); this.scopes.set(name, s); }
    return s;
  }

  /** Register a disposable object. `obj` may be:
        - { dispose() }               (Shader, Mesh, RenderTarget, InstanceBatch)
        - { geometry, material, texture } (THREE-like, all .dispose()d)
        - { glHandle, kind }          (raw WebGL handle: 'texture'|'buffer'|...)
        - a function                  (custom disposer)                       */
  track(obj, scopeName = 'world') {
    if (!obj) return obj;
    this.scope(scopeName).add(obj);
    this.counts.created++;
    if (obj && typeof obj === 'object' && obj.kind && obj.glHandle !== undefined) {
      if (obj.kind === 'texture') this.counts.textures++;
      else if (obj.kind === 'buffer') this.counts.buffers++;
      else if (obj.kind === 'program') this.counts.programs++;
    }
    return obj;
  }
  forget(obj, scopeName = 'world') {
    const s = this.scopes.get(scopeName);
    if (s) s.delete(obj);
  }
  isDisposed(obj) { return !obj || this.disposed.has(obj); }

  /** Raw WebGL handle convenience: trackRaw(gl.createTexture(), 'texture'). */
  trackRaw(handle, kind = 'texture', scopeName = 'world') {
    if (!handle) return handle;
    return this.track({ glHandle: handle, kind }, scopeName);
  }

  /** Create (or fetch) a zero-allocation transient pool. */
  pool(name, factory, capacity = 128) {
    let p = this.pools.get(name);
    if (!p) {
      p = new ObjectPool(name, factory, capacity, this);
      this.pools.set(name, p);
      this.counts.pools++;
      this.scope('match').add(p);
    }
    return p;
  }
  /** An existing pooled engine (FX, ProjectilePool) joins the match scope so
      quitting a battle clears it centrally. It keeps its own specialised
      implementation -- no re-plumbing of the render loop. */
  registerPool(name, engine) {
    if (!engine) return engine;
    this.externalPools.set(name, engine);
    this.scope('match').add(engine);
    return engine;
  }

  /** Dispose one object exactly once. Handles THREE-style composites. */
  disposeObject(obj) {
    if (!obj || this.disposed.has(obj)) return false;
    if (typeof obj === 'function') { obj(); this.disposed.add(obj); this.counts.disposed++; return true; }
    if (typeof obj !== 'object') return false;
    this.disposed.add(obj);
    this.counts.disposed++;
    // THREE-style: geometry.dispose(), material.dispose(), texture.dispose()
    for (const key of ['geometry', 'material', 'texture']) {
      const part = obj[key];
      if (part && typeof part.dispose === 'function') {
        try { part.dispose(); } catch (_) { /* already gone with its context */ }
      }
      if (Array.isArray(part)) for (const p of part) {
        if (p && typeof p.dispose === 'function') {
          try { p.dispose(); } catch (_) { /* ignore */ }
        }
      }
    }
    if (Array.isArray(obj.materials)) for (const m of obj.materials) {
      if (m && typeof m.dispose === 'function') { try { m.dispose(); } catch (_) { /* ignore */ } }
      if (m && m.map && typeof m.map.dispose === 'function') { try { m.map.dispose(); } catch (_) { /* ignore */ } }
    }
    if (typeof obj.dispose === 'function') {
      try { obj.dispose(); } catch (_) { /* context may already be lost */ }
    } else if (obj.glHandle !== undefined) {
      this.disposeHandle(obj.glHandle, obj.kind);
    } else if (typeof obj.clear === 'function') {
      // pooled engine: no GPU memory, but release every live transient
      try { obj.clear(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  disposeHandle(handle, kind = 'texture') {
    const gl = this.gl;
    if (!gl || !handle) return;
    try {
      switch (kind) {
        case 'texture': gl.deleteTexture(handle); break;
        case 'buffer': gl.deleteBuffer(handle); break;
        case 'program': gl.deleteProgram(handle); break;
        case 'shader': gl.deleteShader(handle); break;
        case 'vao': if (gl.deleteVertexArray) gl.deleteVertexArray(handle); break;
        case 'framebuffer': gl.deleteFramebuffer(handle); break;
        case 'renderbuffer': gl.deleteRenderbuffer(handle); break;
        case 'sampler': if (gl.deleteSampler) gl.deleteSampler(handle); break;
        default: break;
      }
    } catch (_) { /* the context is gone; nothing left to free */ }
  }

  /** Explicitly free temporary meshes (projectiles, rings, damage text). */
  releaseTransient(obj) {
    this.forget(obj, 'match');
    return this.disposeObject(obj);
  }

  /** Free everything owned by one scope. Pools are RESET, not destroyed:
      a restart reuses the same pre-allocated arrays. */
  releaseScope(name) {
    const set = this.scopes.get(name);
    if (!set) return 0;
    let n = 0;
    for (const obj of set) {
      if (obj instanceof ObjectPool) { obj.reset(); continue; }
      if (obj && typeof obj.reset === 'function' && obj.freeCount !== undefined) { obj.reset(); continue; }
      if (this.disposeObject(obj)) n++;
    }
    set.clear();
    if (this.onRelease) this.onRelease(name, n);
    return n;
  }

  releaseMatch() {
    const set = this.scopes.get('match');
    if (!set) return 0;
    let n = 0;
    for (const obj of set) {
      if (obj instanceof ObjectPool) { obj.reset(); n++; }
      else if (obj && typeof obj.clear === 'function') { obj.clear(); n++; }
      else if (this.disposeObject(obj)) n++;
    }
    set.clear();
    this.externalPools.clear();
    this.pools.clear();
    return n;
  }
  releaseWorld() { return this.releaseScope('world'); }
  releaseAll() {
    let n = this.releaseMatch();
    n += this.releaseWorld();
    n += this.releaseScope('persistent');
    for (const set of this.scopes.values()) set.clear();
    this.pools.clear();
    this.externalPools.clear();
    return n;
  }

  /** Context loss: mark everything disposed so a rebuild does not double-free. */
  contextLost() {
    for (const set of this.scopes.values()) {
      for (const obj of set) if (obj && typeof obj === 'object') this.disposed.add(obj);
      set.clear();
    }
    // CPU-side pools remain in use by the running match. Only GPU handles
    // become invalid, so keep their registrations for eventual teardown.
  }

  stats() {
    const p = [...this.pools.values()].map((x) => x.stats());
    return {
      ...this.counts,
      persistent: this.scopes.get('persistent').size,
      world: this.scopes.get('world').size,
      match: this.scopes.get('match').size,
      pools: p,
      external: [...this.externalPools.keys()]
    };
  }
}

/** The one manager the whole app shares. */
export const RESOURCES = new ResourceDisposalManager();
export default RESOURCES;
