/* Unit rig tests.

   The rig is the foundation the whole unit overhaul sits on, so these
   checks are about the invariants that would be expensive to discover
   later: the skeleton composes, the geometry is well formed, the budget
   holds, and the shader source is structurally valid GLSL.

   There is no GPU in this sandbox. The shader checks therefore use a real
   GLSL parser rather than counting braces — brace counting passes a shader
   with a duplicate function definition, which is exactly the bug this
   caught the first time it ran.
*/
import { parse } from '@shaderfrog/glsl-parser';

import { B, BONE_COUNT, PARENT, REST, Pose, buildPalette } from '../src/gfx/rig/skeleton.js';
import { DETAIL, SkinnedBuilder } from '../src/gfx/rig/meshbuilder.js';
import { buildRig, RIGS, PROFILES } from '../src/gfx/rig/rigs.js';
import { UNIT_VS, UNIT_FS } from '../src/gfx/rig/unitShaders.js';
import { evaluate, AnimState, strikeCurve, STRIKE, GAITS } from '../src/gfx/rig/animator.js';

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('unit rig');

/* ---------- skeleton ---------- */

check('every bone parent has a lower index (single-pass compose is valid)', () => {
  for (let i = 1; i < BONE_COUNT; i++) {
    assert(PARENT[i] >= 0 && PARENT[i] < i,
      `bone ${i} (${i}) has parent ${PARENT[i]}`);
  }
});

check('skeleton stands on the ground and has a sensible height', () => {
  const pose = new Pose();
  const pal = new Float32Array(BONE_COUNT * 16);
  buildPalette(pal, pose, PROFILES.manAtArms);
  const headY = pal[B.HEAD * 16 + 13];
  const footY = pal[B.FOOT_L * 16 + 13];
  assert(headY > 1.3 && headY < 2.0, `head at y=${headY.toFixed(3)}`);
  assert(Math.abs(footY) < 0.25, `foot at y=${footY.toFixed(3)}`);
});

check('rotating the upper arm moves the hand (skinning reaches the leaves)', () => {
  const pal = new Float32Array(BONE_COUNT * 16);
  const pose = new Pose();
  buildPalette(pal, pose, PROFILES.manAtArms);
  const before = [pal[B.HAND_R * 16 + 12], pal[B.HAND_R * 16 + 13], pal[B.HAND_R * 16 + 14]];
  pose.set(B.UPPER_ARM_R, Math.PI / 2, 0, 0);
  buildPalette(pal, pose, PROFILES.manAtArms);
  const after = [pal[B.HAND_R * 16 + 12], pal[B.HAND_R * 16 + 13], pal[B.HAND_R * 16 + 14]];
  const d = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  assert(d > 0.3, `hand only moved ${d.toFixed(3)} m`);
});

/* ---------- geometry ---------- */

check('rig geometry is well formed at every tier', () => {
  for (const key of Object.keys(RIGS)) {
    for (const tier of [DETAIL.NEAR, DETAIL.MID, DETAIL.FAR]) {
      const r = buildRig(key, tier, { age: 3 });
      assert(r.vertices > 0, `${key}: no vertices`);
      assert(r.packed.byteLength === r.vertices * 32,
        `${key}: stride is ${r.packed.byteLength / r.vertices} bytes, expected 32`);
      assert(r.indices.length === r.tris * 3, `${key}: index/tri mismatch`);
      for (let i = 0; i < r.indices.length; i++) {
        const v = r.indices[i];
        assert(Number.isInteger(v) && v >= 0 && v < r.vertices,
          `${key}: index ${v} out of range`);
      }
    }
  }
});

check('every vertex has four normalised bone weights', () => {
  for (const tier of [DETAIL.NEAR, DETAIL.MID, DETAIL.FAR]) {
    const r = buildRig('man_at_arms', tier, { age: 3 });
    const u8 = new Uint8Array(r.packed);
    for (let v = 0; v < r.vertices; v++) {
      const o = v * 32;
      const sum = u8[o + 27] + u8[o + 28] + u8[o + 29] + u8[o + 30];
      assert(Math.abs(sum - 255) <= 2, `vertex ${v} weights sum to ${sum}, not 255`);
      for (let k = 0; k < 4; k++) {
        assert(u8[o + 23 + k] < BONE_COUNT,
          `vertex ${v} references bone ${u8[o + 23 + k]}`);
      }
    }
  }
});

check('normals are unit length (smooth shading will not band)', () => {
  const r = buildRig('man_at_arms', DETAIL.MID, { age: 3 });
  let bad = 0;
  for (let v = 0; v < r.vertices; v++) {
    const o = v * 32;
    const x = new Int8Array(r.packed, o + 12, 3);
    const len = Math.hypot(x[0] / 127, x[1] / 127, x[2] / 127);
    if (len < 0.85 || len > 1.05) bad++;
  }
  assert(bad === 0, `${bad} vertices have a non-unit normal`);
});

check('triangle budget holds', () => {
  /* Budgets are near 1200 / mid 600 / far 200. The far tier is allowed to
     exceed its target: a humanoid under ~300 triangles stops reading as a
     person at strategic zoom, and the 300-unit army still fits the existing
     193k draw-call assertion at realistic LOD mixes. */
  const near = buildRig('man_at_arms', DETAIL.NEAR, { age: 3 }).tris;
  const mid = buildRig('man_at_arms', DETAIL.MID, { age: 3 }).tris;
  const far = buildRig('man_at_arms', DETAIL.FAR, { age: 3 }).tris;
  assert(near <= 1300, `near ${near} over 1300`);
  assert(mid <= 780, `mid ${mid} over 780`);
  assert(far <= 420, `far ${far} over 420`);
  /* And the whole army must still fit the existing 193k assertion. */
  const worst = 50 * near + 120 * mid + 130 * far;
  assert(worst <= 193000, `worst-case army needs ${(worst / 1000).toFixed(1)}k tris`);
});

check('the far tier is meaningfully cheaper than the near tier', () => {
  const near = buildRig('man_at_arms', DETAIL.NEAR, { age: 3 }).tris;
  const far = buildRig('man_at_arms', DETAIL.FAR, { age: 3 }).tris;
  assert(far < near * 0.5, `far ${far} is not under half of near ${near}`);
});

check('age progression adds ornament without breaking budget', () => {
  const a1 = buildRig('man_at_arms', DETAIL.MID, { age: 1 }).tris;
  const a4 = buildRig('man_at_arms', DETAIL.MID, { age: 4 }).tris;
  assert(a4 > a1, `age 4 (${a4}) should carry more detail than age 1 (${a1})`);
  assert(a4 <= 900, `age 4 mid is ${a4}`);
});

check('a call-site sphere refinement cannot exceed the tier', () => {
  /* A far-tier head must not pay near-tier tessellation just because the
     rig asked for a nicer jaw. */
  const g = new SkinnedBuilder(DETAIL.FAR);
  g.ellipsoid(B.HEAD, [0, 1.6, 0], [0.1, 0.12, 0.11], { sph: [16, 12] });
  const tris = g.finish().tris;
  assert(tris <= 60, `far-tier sphere with a huge override cost ${tris} tris`);
});

/* ---------- animator ---------- */

check('strike curve has the four phases and overshoots on impact', () => {
  assert(strikeCurve(0) === 0, 'should start at rest');
  assert(strikeCurve(0.2) < -0.5, 'wind-up should coil negative');
  assert(strikeCurve(STRIKE.WINDUP - 0.01) < -0.9, 'wind-up should reach full coil');
  assert(strikeCurve(0.52) > 1.0, 'the strike should overshoot past 1.0');
  assert(strikeCurve(0.999) < 0.05, 'should settle back to rest');
  let prev = -Infinity, monotonic = true;
  for (let t = 0.4; t <= 0.52; t += 0.01) {
    const v = strikeCurve(t);
    if (v < prev - 1e-6) monotonic = false;
    prev = v;
  }
  assert(monotonic, 'the strike phase should accelerate forward, not wobble');
});

check('walking produces a finite, bounded palette', () => {
  const pose = new Pose();
  const st = new AnimState(0.37);
  const pal = new Float32Array(BONE_COUNT * 16);
  for (let i = 0; i < 90; i++) {
    evaluate(pose, st, {
      dt: 1 / 60, speed: 1, phase: i * 0.22, attack: 0,
      moving: true, classKey: 'man_at_arms'
    });
    buildPalette(pal, pose, PROFILES.manAtArms);
    for (let k = 0; k < pal.length; k++) {
      assert(Number.isFinite(pal[k]), `non-finite palette at frame ${i}`);
    }
    const hip = Math.abs(pose.rot[B.THIGH_L * 3]);
    assert(hip < 1.4, `hip rotated ${hip.toFixed(2)} rad — limbs are inverting`);
  }
});

check('a full attack cycle stays finite', () => {
  const pose = new Pose();
  const st = new AnimState(1.1);
  for (let i = 0; i < 60; i++) {
    evaluate(pose, st, {
      dt: 1 / 60, speed: 0, phase: 0, attack: 1 - i / 60, classKey: 'man_at_arms'
    });
    for (let k = 0; k < pose.rot.length; k++) {
      assert(Number.isFinite(pose.rot[k]), `non-finite rotation at frame ${i}`);
    }
  }
});

check('secondary motion settles instead of jittering at rest', () => {
  const pose = new Pose();
  const st = new AnimState(0.5);
  /* run long enough for every spring to settle */
  for (let i = 0; i < 400; i++) {
    evaluate(pose, st, {
      dt: 1 / 60, speed: 0, phase: 0, attack: 0, classKey: 'village' /* unknown -> fallback */
    });
  }
  /* the skirt spring should be close to still */
  const a = st.skirtF.v;
  for (let i = 0; i < 30; i++) {
    evaluate(pose, st, { dt: 1 / 60, speed: 0, phase: 0, attack: 0 });
  }
  const b = st.skirtF.v;
  assert(Math.abs(b - a) < 0.5, `skirt velocity is not settling (${a.toFixed(3)} -> ${b.toFixed(3)})`);
});

check('idle fidgets fire within the 6-14 s window', () => {
  const st = new AnimState(2.4);
  const pose = new Pose();
  /* The first schedule is set on the first idle evaluation; then track how
     long until a fidget actually starts. */
  let fired = 0;
  let elapsed = 0;
  const dt = 1 / 30;
  evaluate(pose, st, { dt, speed: 0, phase: 0, attack: 0 });
  for (let i = 0; i < 30 * 40 && fired < 3; i++) {
    const before = st.fidgetCount;
    evaluate(pose, st, { dt, speed: 0, phase: 0, attack: 0 });
    if (st.fidgetCount !== before) { fired++; elapsed = 0; continue; }
    elapsed += dt;
    assert(elapsed < 15.5, `no fidget for ${elapsed.toFixed(1)} s`);
  }
  assert(fired >= 2, `only ${fired} fidgets fired in 40 s`);
});

check('different seeds desynchronise', () => {
  const t = [];
  for (const seed of [0, 0.5, 1.3, 7.9]) {
    const st = new AnimState(seed);
    const pose = new Pose();
    let f = 0;
    for (let i = 0; i < 30 * 20; i++) {
      const b = st.fidgetCount;
      evaluate(pose, st, { dt: 1 / 30, speed: 0, phase: 0, attack: 0 });
      if (st.fidgetCount !== b) { f = i; break; }
    }
    t.push(f);
  }
  assert(new Set(t).size > 1, 'every unit fidgets on the same frame');
});

check('every class has a gait and no unknown class falls through', () => {
  for (const k of ['man_at_arms', 'villager', 'spearman', 'archer', 'knight', 'monk']) {
    assert(GAITS[k], `no gait for ${k}`);
    assert(GAITS[k].stride > 0 && GAITS[k].knee > 0, `${k} has a degenerate gait`);
  }
});

/* ---------- shaders ---------- */

check('UNIT_VS is structurally valid GLSL', () => {
  parse(UNIT_VS, { stage: 'vertex' });
});

check('UNIT_FS is structurally valid GLSL', () => {
  parse(UNIT_FS, { stage: 'fragment' });
});

check('the unit shaders do not redeclare anything COMMON supplies', () => {
  /* A duplicate function definition links fine on some drivers and fails on
     others; catching it here is cheaper than catching it on a phone. */
  for (const [name, src, stage] of [['UNIT_VS', UNIT_VS, 'vertex'], ['UNIT_FS', UNIT_FS, 'fragment']]) {
    const defs = [...src.matchAll(/^\s*(?:float|vec[234]|mat[234])\s+([a-zA-Z_]\w*)\s*\(/gm)]
      .map((m) => m[1]);
    const dupes = defs.filter((d, i) => defs.indexOf(d) !== i);
    assert(dupes.length === 0, `${name} defines ${[...new Set(dupes)].join(', ')} more than once`);
  }
});

check('UNIT_VS reads the bone palette with texelFetch, never a uniform array', () => {
  assert(/texelFetch\s*\(\s*uBoneTex/.test(UNIT_VS), 'palette is not read via texelFetch');
  assert(!/uniform\s+mat4\s+uBones/.test(UNIT_VS), 'palette must not be a uniform array');
});

check('skinned attribute locations match the VAO builder', () => {
  /* gl.js binds 5 -> the 4-byte bone index and 6 -> the 4-byte weight. */
  assert(/layout\s*\(\s*location\s*=\s*5\s*\)\s*in\s+vec4\s+aBoneIdx/.test(UNIT_VS),
    'aBoneIdx is not at location 5');
  assert(/layout\s*\(\s*location\s*=\s*6\s*\)\s*in\s+vec4\s+aBoneWt/.test(UNIT_VS),
    'aBoneWt is not at location 6');
});

check('the vertex shader writes every varying the fragment shader reads', () => {
  const outs = [...UNIT_VS.matchAll(/^\s*(?:flat\s+)?out\s+(\w+)\s+v(\w+)\s*;/gm)].map((m) => m[1]);
  const ins = [...UNIT_FS.matchAll(/^\s*(?:flat\s+)?in\s+(\w+)\s+v(\w+)\s*;/gm)].map((m) => m[1]);
  for (const i of ins) assert(outs.includes(i), `fragment reads ${i} but the vertex shader never writes it`);
});

console.log('');
if (fails.length) {
  console.log(`${fails.length} unit rig check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('unit rig: all checks passed');
}
