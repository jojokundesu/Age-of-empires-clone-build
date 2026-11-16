/* ============================================================
   armory.js — the Unit Inspector

   A pedestal in a dark room with one soldier on it. Rotate, zoom, change
   the class, change the age, change what he is doing. This is how the
   overhaul is actually reviewed: a unit reads differently at 4 m than at
   12 m, and differently again mid-stride than standing still.

   It gets its own WebGL2 canvas rather than reusing the game's, because it
   opens from the main menu, where there is no world, no camera and no
   simulation. That means its own program and its own palette texture — but
   it shares the geometry, the shaders, the skeleton and the animator, so
   what you see here is exactly what the game draws.

   TOUCH FIRST
   -----------
   One finger drags to orbit, two fingers pinch to zoom. Every control is a
   pill sized for a fingertip, because this has to work on a phone. There
   is no hover state and nothing depends on a mouse.

   The animation runs off wall-clock time, not the match clock, so the
   pedestal keeps moving while the game is paused — which it is.
   ============================================================ */

import { Shader } from '../core/gl.js';
import { InstanceBatch } from '../gfx/batch.js';
import { BONE_COUNT, Pose, buildBindPalette, buildSkinPalette } from '../gfx/rig/skeleton.js';
import { DETAIL } from '../gfx/rig/meshbuilder.js';
import { buildRig, RIGS, PROFILES, SKIN_TONES, HAIR_COLORS, isMounted } from '../gfx/rig/rigs.js';
import { evaluate, AnimState } from '../gfx/rig/animator.js';
import { UNIT_VS, UNIT_FS, UNIT_MAX_ROWS, UNIT_TEX_WIDTH } from '../gfx/rig/unitShaders.js';
import { BonePalette } from '../gfx/rig/palette.js';
import { COMMON } from '../gfx/shaders.js';
import { TEAM_COLORS } from '../sim/data.js';

/* The classes worth showing. The A/B variant is included deliberately: it
   exists to be compared, and this is where you compare it. */
const PICKER = [
  ['hero_general', 'Lord Commander'],
  ['knight', 'Knight'],
  ['man_at_arms', 'Man-at-Arms'],
  ['man_at_arms_tight', 'Man-at-Arms (tight)'],
  ['cataphract', 'Cataphract'],
  ['claimant_knight', 'Claimant'],
  ['swordsman', 'Swordsman'],
  ['spearman', 'Spearman'],
  ['huskarl', 'Huskarl'],
  ['axeman', 'Axeman'],
  ['samurai', 'Samurai'],
  ['berserk', 'Berserker'],
  ['archer', 'Archer'],
  ['longbowman', 'Longbowman'],
  ['skirmisher', 'Skirmisher'],
  ['mangudai', 'Mangudai'],
  ['hand_cannoneer', 'Cannoneer'],
  ['monk', 'Monk'],
  ['villager', 'Villager'],
  ['mob_rioter', 'Rioter'],
  ['scout_cavalry', 'Scout']
];

/** The picker, exported for tests so a class cannot be offered without a rig. */
export const __PICKER_FOR_TESTS = PICKER;

const POSES = [
  ['idle', 'Idle'],
  ['walk', 'Walk'],
  ['attack', 'Attack'],
  ['fidget', 'Fidget']
];

const AGES = ['I', 'II', 'III', 'IV'];

/** A dark studio, so the silhouette is what the eye reads. */
const ARMORY_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const ARMORY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uGlow;
void main() {
  /* A very slightly lit backdrop: a flat fill reads as a dead screen, and a
     gradient puts the unit's feet on something. */
  vec3 c = mix(uBottom, uTop, pow(vUV.y, 0.8));
  float d = length((vUV - vec2(0.5, 0.34)) * vec2(1.0, 1.35));
  c += uGlow * vec3(0.30, 0.28, 0.24) * smoothstep(0.55, 0.0, d);
  fragColor = vec4(c, 1.0);
}`;

/**
 * A 1x1 depth texture in compare mode.
 *
 * uShadowMap is a sampler2DShadow. WebGL2 rejects any draw that has a
 * non-depth texture bound to a shadow sampler's unit, so a program carrying
 * the shared lighting block cannot be drawn unless something depth-shaped is
 * bound -- even when shadow strength is zero and the fetch never happens.
 * One texel is enough to satisfy the rule.
 */
function createDummyDepth(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0,
    gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  return tex;
}

export class Armory {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this.ok = false;
    this.classKey = 'man_at_arms';
    this.age = 3;
    this.pose = 'idle';
    this.yaw = 0.6;
    this.pitch = 0.06;
    this.dist = 3.4;
    this.autoSpin = true;
    this._raf = 0;
    this._t = 0;
    this._last = 0;
    this._dragging = false;
    this._pinch = 0;
    this._batches = new Map();
    this._pose = new Pose();
    this._pal = new Float32Array(BONE_COUNT * 16);
    this._bind = null;
    this._state = new AnimState(0.37);
    this._needsPose = true;
  }

  /* ---------- lifecycle ---------- */

  /** Create the GL context. Called when the panel opens, not before. */
  init(canvas) {
    if (this.gl) { this.canvas = canvas; return true; }
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: true, depth: true,
      powerPreference: 'low-power', preserveDrawingBuffer: false
    });
    if (!gl) return false;
    this.gl = gl;

    this.pUnit = new Shader(gl, 'armory-unit', UNIT_VS, UNIT_FS);
    this.pBackdrop = new Shader(gl, 'armory-bg', ARMORY_VS, ARMORY_FS);
    this.palette = new BonePalette(gl, 4, UNIT_TEX_WIDTH);
    this._dummyDepth = createDummyDepth(gl);

    /* One full-screen triangle pair for the backdrop. */
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this._bgVao = vao;

    this.ok = true;
    /* Exposed for the browser harness: it needs to read the yaw and the
       draw counters to prove the pedestal is really rendering, which a
       screenshot alone cannot do when the backdrop also draws. */
    if (typeof window !== 'undefined') window.__imperialArmory = this;
    return true;
  }

  /** Build (or reuse) the geometry for the current class at each tier. */
  _batchFor(key, tier) {
    const id = key + ':' + tier;
    let b = this._batches.get(id);
    if (!b) {
      const rig = buildRig(key, tier, { age: this.age });
      b = new InstanceBatch(this.gl, rig, 4);
      b.cull = false;        // the inspector shows the whole figure, both sides
      this._batches.set(id, b);
    }
    return b;
  }

  /** Drop the cached geometry. Needed when the age changes, because the age
      ladder changes the mesh, not just the texture. */
  _invalidate() {
    for (const b of this._batches.values()) b.dispose();
    this._batches.clear();
    this._needsPose = true;
  }

  setClass(key) {
    if (this.classKey === key) return;
    this.classKey = key;
    this._state = new AnimState(0.37);
    this._invalidate();
  }

  setAge(age) {
    age = Math.max(1, Math.min(4, age | 0));
    if (this.age === age) return;
    this.age = age;
    this._invalidate();
  }

  setPose(pose) {
    if (this.pose === pose) return;
    this.pose = pose;
    this._state = new AnimState(0.37);
    this._needsPose = true;
  }

  /* ---------- input ---------- */

  /**
   * Wire touch and mouse. One finger orbits, two pinch to zoom. Returns a
   * teardown function so the caller can drop the listeners with the panel.
   */
  bindInput(canvas) {
    let lastX = 0, lastY = 0, pointers = new Map(), startDist = 0;
    const onDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) {
        this._dragging = true; this.autoSpin = false;
        lastX = e.clientX; lastY = e.clientY;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        startDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    };
    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (startDist > 4) {
          this.dist = Math.max(1.6, Math.min(6.5, this.dist * (startDist / Math.max(1, d))));
        }
        startDist = d;
        return;
      }
      if (!this._dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.yaw -= dx * 0.010;
      this.pitch = Math.max(-0.55, Math.min(0.85, this.pitch + dy * 0.006));
    };
    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) { this._dragging = false; this.autoSpin = false; }
      if (pointers.size === 1) {
        const [a] = [...pointers.values()];
        lastX = a[0]; lastY = a[1];
      }
      startDist = 0;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }

  /* ---------- render ---------- */

  start() {
    if (!this.ok || this._raf) return;
    this._last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this._t += dt;
      if (this.autoSpin) this.yaw += dt * 0.45;
      this._advance(dt);
      this._draw();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  dispose() {
    this.stop();
    for (const b of this._batches.values()) b.dispose();
    this._batches.clear();
    this.palette?.dispose();
    if (this._dummyDepth) { this.gl?.deleteTexture(this._dummyDepth); this._dummyDepth = null; }
    this.gl = null;
    this.ok = false;
  }

  /** Step the simulation-free animation state. */
  _advance(dt) {
    const key = this.classKey;
    const st = this._state;
    /* A mounted class has to be told, or the inspector shows a rider
       standing on the ground with a horse through its middle. */
    const ride = { classKey: key, mounted: isMounted(key) };
    if (this.pose === 'walk') {
      evaluate(this._pose, st, {
        ...ride, dt, speed: 1, phase: st.t * 5.4, attack: 0, moving: true
      });
    } else if (this.pose === 'attack') {
      /* loop the four-phase strike so the whole curve is visible */
      const period = 1.4;
      const u = (st.t % period) / period;
      evaluate(this._pose, st, {
        ...ride, dt, speed: 0, phase: 0, attack: 1 - u
      });
    } else if (this.pose === 'fidget') {
      /* run the idle state fast-forward until a fidget is mid-gesture */
      evaluate(this._pose, st, { ...ride, dt: dt * 3, speed: 0, phase: 0, attack: 0 });
    } else {
      evaluate(this._pose, st, { ...ride, dt, speed: 0, phase: 0, attack: 0 });
    }
    this._needsPose = true;
  }

  _draw() {
    const gl = this.gl;
    if (!gl) return;
    this.frames = (this.frames || 0) + 1;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    /* Clear BOTH buffers. The backdrop paints every pixel of colour, so
       skipping the colour clear is invisible — but skipping the depth clear
       is not: with the depth test enabled the unit is then compared against
       whatever garbage the buffer held, and every fragment is rejected. That
       is a blank pedestal with no GL error to show for it. */
    gl.clearColor(0.07, 0.08, 0.10, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    /* backdrop. Depth writes OFF: this is a full-screen triangle sitting at
       depth 0.5, so if it is allowed to write depth it stamps 0.5 over the
       whole canvas and the unit behind it then fails the depth test and is
       rejected outright -- a completely blank pedestal with no GL error.
       The clear above still resets depth to 1. */
    gl.depthMask(false);
    const bg = this.pBackdrop.use();
    bg.v3('uTop', 0.15, 0.17, 0.21);
    bg.v3('uBottom', 0.07, 0.08, 0.10);
    bg.f('uGlow', 0.85);
    gl.bindVertexArray(this._bgVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);

    /* the unit */
    const key = this.classKey;
    /* LOD comes from the raw orbit distance, NOT from the mount-scaled one.
       The multiplier exists only to keep a long animal inside the frame; if
       it also drove the LOD then every cavalry class would be inspected at
       far detail and the whole point of the panel -- looking closely at the
       geometry -- would be lost. */
    const tier = this.dist < 2.8 ? DETAIL.NEAR : this.dist < 4.6 ? DETAIL.MID : DETAIL.FAR;
    const batch = this._batchFor(key, tier);
    if (!batch) return;

    const profileName = (RIGS[key] || { profile: 'spearman' }).profile;
    const prop = PROFILES[profileName];
    if (!this._bind) this._bind = new Float32Array(BONE_COUNT * 16);
    buildBindPalette(this._bind, prop);
    buildSkinPalette(this._pal, this._pose, prop, this._bind);
    const row = this.palette.allocRow('armory');
    this.palette.writeRow(row, this._pal);
    this.palette.flush();

    const cam = this._camera();
    batch.begin();
    /* The tint is the team colour, and the shader replaces the hue of every
       linen and gambeson surface with it. Passing white here -- which is the
       neutral default in push() -- turns every tunic and cape into a bright
       white sheet, which is what the first pass of this inspector looked
       like. Show the player's own blue, the same colour they see in play. */
    const tc = TEAM_COLORS[1].unit;
    batch.push(identity(), tc[0], tc[1], tc[2], 1, 0, 1, 0, row, this.age << 12, 0, 0);
    batch.flush();

    gl.enable(gl.DEPTH_TEST);
    const s = this.pUnit.use();
    s.m4('uViewProj', cam);
    s.f('uSwayAmount', 0);
    /* A neutral studio light: the game's sun is warm and low, which hides
       half the geometry the inspector exists to show.

       The values matter more than they look. This shader multiplies the sun
       term by 1.25 and then adds an ambient term of roughly its own weight,
       so a sun colour near 1.0 lands at ~1.7x albedo and the tonemap clips
       it: every tunic, mail shirt and cape saturates to white and the
       inspector shows a blank silhouette. Keep the sun under 0.8 and the
       ambient low so the materials read at their real albedo. */
    s.v3('uSunDir', -0.35, 0.86, 0.38);
    s.v3('uSunColor', 0.74, 0.72, 0.68);
    s.v3('uSkyColor', 0.17, 0.20, 0.26);
    s.v3('uGroundColor', 0.09, 0.085, 0.08);
    s.v3('uFogColor', 0.0, 0.0, 0.0);
    s.f('uFogDensity', 0);
    s.v3('uCameraPos', 0, 1.1, 3.2);
    s.f('uTime', this._t);
    s.f('uNight', 0);
    s.f('uCloudOffset', 0);
    s.f('uCloudStrength', 0);
    s.f('uShadowStrength', 0);
    s.f('uShadowTexel', 1 / 2048);
    s.f('uWorldHalf', 256);
    s.f('uFogEnabled', 0);
    s.f('uTownLight', 0);
    s.f('uTownLightI', 0);
    s.v3('uTownLightColor', 0, 0, 0);
    s.f('uBoneRows', this.palette.maxRows);
    s.f('uTexWidth', this.palette.width);
    /* The unit shader declares the game's whole lighting block, so these
       four samplers are ACTIVE uniforms even though the inspector samples
       none of them.

       Two things go wrong if they are left alone, and both produce a blank
       pedestal with no compile or link error to explain it:

         - every sampler defaults to texture unit 0, so all four collide
           with uBoneTex;
         - uShadowMap is a sampler2DShadow, and a draw is INVALID_OPERATION
           unless a DEPTH_COMPONENT texture with COMPARE_REF_TO_TEXTURE is
           bound to its unit. Handing it the palette texture rejects the
           whole draw.

       The game never hits this because _bindLight fills all four for real.
       Here there is no shadow map, so bind a 1x1 dummy depth texture to the
       shadow unit and point the rest at the palette. Nothing reads them. */
    s.tex('uBoneTex', this.palette.texture, gl.TEXTURE_2D);
    s.tex('uShadowMap', this._dummyDepth, gl.TEXTURE_2D);
    s.tex('uClouds', this.palette.texture, gl.TEXTURE_2D);
    s.tex('uFogTex', this.palette.texture, gl.TEXTURE_2D);
    batch.draw();
    gl.disable(gl.DEPTH_TEST);
  }

  /** Orbit camera as a view-projection matrix. */
  _camera() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const d = this.dist;
    /* A mounted unit is 2.1 m tall and 1.9 m nose to tail. Aiming at a foot
       soldier's chest crops the horse's head and hooves off, so the aim point
       and the eye height both move up when there is a mount on the pedestal. */
    const mt = isMounted(this.classKey) ? 1 : 0;
    const de = d * (mt ? 1.5 : 1);
    const eye = [sy * cp * de, 1.05 + mt * 0.55 + sp * de, cy * cp * de];
    const target = [0, 1.02 + mt * 0.42, mt * 0.10];
    const up = [0, 1, 0];
    /* look-at */
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    let xl = Math.hypot(x[0], x[1], x[2]) || 1;
    const xn = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [z[1] * xn[2] - z[2] * xn[1], z[2] * xn[0] - z[0] * xn[2], z[0] * xn[1] - z[1] * xn[0]];
    const view = new Float32Array([
      xn[0], y[0], z[0], 0,
      xn[1], y[1], z[1], 0,
      xn[2], y[2], z[2], 0,
      -(xn[0] * eye[0] + xn[1] * eye[1] + xn[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1
    ]);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const fov = 0.62, near = 0.1, far = 40;
    const f = 1 / Math.tan(fov / 2);
    const proj = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    ]);
    /* proj * view, column-major */
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = proj[r] * view[c * 4] + proj[4 + r] * view[c * 4 + 1] +
          proj[8 + r] * view[c * 4 + 2] + proj[12 + r] * view[c * 4 + 3];
      }
    }
    return o;
  }

  /* ---------- DOM ---------- */

  /** The panel HTML. Buttons carry data attributes; attach() wires them. */
  html() {
    const chips = PICKER.map(([k, label]) =>
      `<button type="button" class="armChip${k === this.classKey ? ' active' : ''}" data-cls="${k}">${label}</button>`
    ).join('');
    const poses = POSES.map(([k, label]) =>
      `<button type="button" class="armChip${k === this.pose ? ' active' : ''}" data-pose="${k}">${label}</button>`
    ).join('');
    const ages = AGES.map((label, i) =>
      `<button type="button" class="armChip${i + 1 === this.age ? ' active' : ''}" data-age="${i + 1}">${label}</button>`
    ).join('');
    return `
      <div class="armoryWrap">
        <div class="armoryStage">
          <canvas class="armoryCanvas" width="720" height="900"></canvas>
          <div class="armoryHint">Drag to turn · pinch to zoom</div>
        </div>
        <div class="armoryControls">
          <div class="armRow"><span class="armLabel">Age</span><div class="armChips">${ages}</div></div>
          <div class="armRow"><span class="armLabel">Pose</span><div class="armChips">${poses}</div></div>
          <div class="armRow"><span class="armLabel">Class</span><div class="armChips armChipsWrap">${chips}</div></div>
        </div>
      </div>`;
  }

  /** Wire the panel's controls and start the render loop. */
  attach(root) {
    const canvas = root.querySelector('.armoryCanvas');
    if (!canvas) return () => {};
    /* Size the drawing buffer to the CSS box, capped so a phone is not
       asked to render a 2000px-tall canvas. */
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(200, Math.round((r.width || 360) * dpr));
      const h = Math.max(280, Math.round((r.height || 480) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
    };
    fit();
    if (!this.init(canvas)) return () => {};

    const unbind = this.bindInput(canvas);

    const onChip = (e) => {
      const btn = e.target.closest('.armChip');
      if (!btn) return;
      if (btn.dataset.cls) this.setClass(btn.dataset.cls);
      if (btn.dataset.pose) this.setPose(btn.dataset.pose);
      if (btn.dataset.age) this.setAge(parseInt(btn.dataset.age, 10));
      /* reflect state */
      for (const b of root.querySelectorAll('.armChip')) {
        if (b.dataset.cls) b.classList.toggle('active', b.dataset.cls === this.classKey);
        if (b.dataset.pose) b.classList.toggle('active', b.dataset.pose === this.pose);
        if (b.dataset.age) b.classList.toggle('active', parseInt(b.dataset.age, 10) === this.age);
      }
    };
    root.addEventListener('click', onChip);
    const onResize = () => { fit(); };
    window.addEventListener('resize', onResize);
    this.start();

    return () => {
      root.removeEventListener('click', onChip);
      window.removeEventListener('resize', onResize);
      unbind?.();
      this.stop();
    };
  }
}

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
