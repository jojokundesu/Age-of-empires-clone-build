/* Static GLSL sanity checks. There is no GPU in this sandbox, so instead of
   compiling we verify the invariants that break WebGL2 builds most often:
   - `#version 300 es` is the first line
   - fragment shaders declare a float precision
   - no legacy GLSL 1.x keywords (attribute/varying/texture2D/gl_FragColor)
   - every `out` from a vertex shader has a matching `in` in its fragment shader
     (including `flat` qualifiers)
   - every sampler uniform is actually bound by the renderer
   - no `uniform` is redeclared inside the same shader                            */
import { readFileSync } from 'node:fs';
import { parse } from '@shaderfrog/glsl-parser';

const SRC = readFileSync(new URL('../src/gfx/shaders.js', import.meta.url), 'utf8');
const RENDERER = readFileSync(new URL('../src/gfx/renderer.js', import.meta.url), 'utf8');

// pull every `export const NAME = /* glsl */`...`` template literal out of the file
const chunks = {};
{
  // internal `const NAME = /* glsl */\`...\`` chunks (COMMON, LIGHT_UNIFORMS, ...)
  const re = /const ([A-Z_]+) = \/\* glsl \*\/`([\s\S]*?)\n`;/g;
  let m;
  while ((m = re.exec(SRC))) chunks[m[1]] = m[2];
}
const shaders = {};
{
  const re = /export const ([A-Z_]+) = \/\* glsl \*\/`([\s\S]*?)\n`;/g;
  let m;
  while ((m = re.exec(SRC))) shaders[m[1]] = m[2];
}
// expand ${CHUNK} interpolations the way the JS template literals do
const expand = (src) => src.replace(/\$\{([A-Z_]+)\}/g, (all, name) => (name in chunks ? chunks[name] : all));
for (const k of Object.keys(shaders)) shaders[k] = expand(shaders[k]);

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log(`\n${Object.keys(shaders).length} shader sources`);
check('all shaders found', () => assert(Object.keys(shaders).length >= 16, 'only ' + Object.keys(shaders).length));

for (const [name, src] of Object.entries(shaders)) {
  check(`${name}: #version first`, () => {
    const first = src.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    assert(first === '#version 300 es', `first line is "${first}"`);
  });
  check(`${name}: no legacy GLSL`, () => {
    for (const bad of [/\battribute\s/, /\bvarying\s/, /\btexture2D\s*\(/, /gl_FragColor/]) {
      assert(!bad.test(src), 'uses ' + bad);
    }
  });
}

const pairs = [
  ['SKY_VS', 'SKY_FS'], ['TERRAIN_VS', 'TERRAIN_FS'], ['MODEL_VS', 'MODEL_FS'],
  ['SHADOW_VS', 'SHADOW_FS'], ['WATER_VS', 'WATER_FS'], ['PARTICLE_VS', 'PARTICLE_FS'],
  ['BILLBOARD_VS', 'BILLBOARD_FS'], ['DECAL_VS', 'DECAL_FS'], ['POST_VS', 'POST_FS']
];

const declares = (src, kind) => {
  const out = [];
  const re = new RegExp(`^\\s*(flat\\s+)?${kind}\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+(\\w+)\\s*;`, 'gm');
  let m;
  while ((m = re.exec(src))) out.push({ flat: !!m[1], type: m[2], name: m[3] });
  return out;
};

for (const [vs, fs] of pairs) {
  check(`${vs} ↔ ${fs}: interface matches`, () => {
    const outs = declares(shaders[vs], 'out').filter((o) => o.name !== 'gl_Position');
    const ins = declares(shaders[fs], 'in');
    const inMap = new Map(ins.map((i) => [i.name, i]));
    for (const o of outs) {
      const i = inMap.get(o.name);
      assert(i, `fragment shader has no "in ${o.name}"`);
      assert(i.type === o.type, `${o.name}: ${o.type} vs ${i.type}`);
      assert(i.flat === o.flat, `${o.name}: flat qualifier mismatch`);
    }
    for (const i of ins) {
      assert(outs.find((o) => o.name === i.name), `vertex shader does not write ${i.name}`);
    }
  });
  check(`${fs}: float precision`, () => {
    assert(/precision\s+(highp|mediump)\s+float\s*;/.test(shaders[fs]) || /precision\s+\w+\s+int/.test(shaders[fs]),
      'no float precision declared');
  });
}

check('every shader parses as GLSL', () => {
  const bad = [];
  for (const [name, src] of Object.entries(shaders)) {
    try { parse(src.replace(/^#version[^\n]*\n/, '')); }
    catch (e) {
      const loc = e.location ? ` @${e.location.start.line}:${e.location.start.column}` : '';
      bad.push(`${name}${loc}: ${String(e.message).split('\n')[0]}`);
    }
  }
  assert(!bad.length, bad.join(' | '));
});

check('shader source is pure ASCII', () => {
  const bad = [];
  for (const [name, src] of Object.entries(shaders)) {
    if (/[^\x00-\x7F]/.test(src)) bad.push(name);
  }
  assert(!bad.length, 'non-ASCII in ' + bad.join(', '));
});

check('no duplicated uniform declarations', () => {
  for (const [name, src] of Object.entries(shaders)) {
    const seen = new Set();
    const re = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)/gm;
    let m;
    while ((m = re.exec(src))) {
      const key = m[1] + ' ' + m[2];
      assert(!seen.has(key), `${name} declares ${key} twice`);
      seen.add(key);
    }
  }
});

check('every sampler is bound by the renderer', () => {
  const missing = [];
  for (const [name, src] of Object.entries(shaders)) {
    const re = /uniform\s+sampler\w+\s+(\w+)\s*;/g;
    let m;
    while ((m = re.exec(src))) {
      const u = m[1];
      if (!new RegExp(`tex\\('${u}'`).test(RENDERER)) missing.push(`${name}.${u}`);
    }
  }
  assert(!missing.length, 'never bound: ' + missing.join(', '));
});

check('every uniform the renderer sets is declared', () => {
  const all = Object.values(shaders).join('\n');
  const set = new Set();
  const re = /\b(?:s|shader)\.(?:f|i|v2|v3|v4|m4|tex)\('(\w+)'/g;
  let m;
  while ((m = re.exec(RENDERER))) set.add(m[1]);
  const missing = [...set].filter((u) => !new RegExp(`uniform\\s+(?:(?:lowp|mediump|highp)\\s+)?\\w+\\s+${u}\\s*[;\\[]`).test(all));
  assert(!missing.length, 'not declared anywhere: ' + missing.join(', '));
});

console.log('');
if (fails.length) { console.log(`FAILURES (${fails.length})`); process.exit(1); }
console.log('SHADER CHECKS PASSED');
