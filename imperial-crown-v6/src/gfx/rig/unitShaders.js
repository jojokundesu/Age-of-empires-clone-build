/* ============================================================
   unitShaders.js — the skinned unit pipeline

   This replaces the MODEL program for rigged humanoids only.
   Buildings, props, ships and siege keep MODEL_VS/MODEL_FS
   completely untouched — they are not part of this overhaul.

   THE BONE PALETTE TEXTURE
   ------------------------
   A uniform cannot vary per instance inside an instanced draw, so the
   palette cannot be a uniform array: 24 matrices x 150 units would
   either be one shared pose or 150 draw calls. Instead every unit in
   the frame owns one row of a 2D float texture and the vertex shader
   pulls its four bones with texelFetch.

   Row layout, 4 texels per matrix (one matrix column per texel):
     texel 0..3   bone 0
     texel 4..7   bone 1
     ...
   With BONE_COUNT = 24 a row is 96 texels; the texture is 128 wide
   to leave room for a rider's extra bones later.

   RGBA32F, not RGBA16F. A half float's 10-bit mantissa quantises a
   1 m bone transform to roughly 1 mm, which shimmers on a helmet rim
   at distance and compounds down a parent chain.

   VERTEX LAYOUT (32 bytes — the same stride the engine already uses,
   so nothing else in the renderer changes):
     0   vec3    position
     12  char4   normal (normalised; only xyz read)
     15  uchar   material
     16  ushort2 uv (1/1024 m, normalised)
     20  uchar4  colour (rgb)
     23  uchar4  bone indices
     27  uchar4  bone weights (normalised)
   ============================================================ */

import { COMMON, LIGHT_UNIFORMS, SHADOW_FN } from '../shaders.js';

export const UNIT_MAX_ROWS = 512;
export const UNIT_TEX_WIDTH = 128;   // 32 bones * 4 texels

export const UNIT_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aMat;
layout(location=3) in vec2 aUV;
layout(location=4) in vec3 aColor;
layout(location=5) in vec4 aBoneIdx;   // reuses the old PART slot
layout(location=6) in vec4 aBoneWt;    // reuses the old PIVOT slot
layout(location=7) in vec4 iM0;
layout(location=8) in vec4 iM1;
layout(location=9) in vec4 iM2;
layout(location=10) in vec4 iM3;
layout(location=11) in vec4 iA;   // rgb team tint
layout(location=12) in vec4 iB;   // x damage, y alpha, z flags, w seed
layout(location=13) in vec4 iC;   // x paletteRow, y packed(class|variant|age), z animSeed, w gearFlags
layout(location=14) in vec4 iD;   // spare
${LIGHT_UNIFORMS}
uniform mat4 uViewProj;
uniform highp sampler2D uBoneTex;
uniform float uSwayAmount;      // garment/foliage flutter, matching MODEL_VS
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
out vec4 vTint;
out vec4 vState;
out float vDist;
flat out int vMat;
flat out vec4 vPack;

mat4 boneMat(int row, int bone) {
  int x = bone * 4;
  /* texelFetch, not texture(): RGBA32F is not guaranteed filterable
     without OES_texture_float_linear, and filtering a matrix would be
     wrong even if it were. */
  return mat4(
    texelFetch(uBoneTex, ivec2(x + 0, row), 0),
    texelFetch(uBoneTex, ivec2(x + 1, row), 0),
    texelFetch(uBoneTex, ivec2(x + 2, row), 0),
    texelFetch(uBoneTex, ivec2(x + 3, row), 0)
  );
}

void main() {
  mat4 model = mat4(iM0, iM1, iM2, iM3);
  int row = int(iC.x + 0.5);

  /* Four-weight linear blend skinning. */
  float w0 = aBoneWt.x, w1 = aBoneWt.y, w2 = aBoneWt.z, w3 = aBoneWt.w;
  float wsum = w0 + w1 + w2 + w3;
  if (wsum < 0.0001) { w0 = 1.0; wsum = 1.0; }
  mat4 skin =
      boneMat(row, int(aBoneIdx.x)) * (w0 / wsum)
    + boneMat(row, int(aBoneIdx.y)) * (w1 / wsum)
    + boneMat(row, int(aBoneIdx.z)) * (w2 / wsum)
    + boneMat(row, int(aBoneIdx.w)) * (w3 / wsum);

  vec4 skinned = skin * vec4(aPos, 1.0);
  vec3 n = normalize((skin * vec4(aNormal, 0.0)).xyz);

  vec4 wp = model * skinned;
  vec3 wn = normalize(mat3(model) * n);

  vWorld = wp.xyz;
  vNormal = wn;
  vUV = aUV;
  vColor = aColor;
  vTint = iA;
  vState = iB;
  vMat = int(aMat + 0.5);
  vPack = iC;
  vDist = length(wp.xyz - uCameraPos);
  gl_Position = uViewProj * wp;
}
`;

export const UNIT_FS = /* glsl */`#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
${SHADOW_FN}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
in vec4 vTint;
in vec4 vState;
in float vDist;
flat in int vMat;
flat in vec4 vPack;
out vec4 fragColor;

/* Shared with the legacy model program: the same material atlas drives
   the same albedo and roughness lookups. */
uniform highp sampler2DArray uMaterials;
uniform float uBoneRows;
uniform float uTexWidth;

#define MAT_LINEN    0
#define MAT_MAIL     1
#define MAT_PLATE    2
#define MAT_GAMBESON 3
#define MAT_SKIN     4
#define MAT_HAIR     5
#define MAT_LEATHER  6
#define MAT_WOOD     7

/* hash12 comes from COMMON: redeclaring it is a link error on a real
   driver even though the two bodies are identical. */

/* Crossed thread weave: two sine trains at 90 degrees, jittered by a hash
   so it never reads as a printed grid. */
float weave(vec2 uv, float freq, float jitter) {
  vec2 j = vec2(hash12(floor(uv * freq * 0.5)),
                hash12(floor(uv.yx * freq * 0.5) + 7.1));
  float a = sin((uv.x + j.x * jitter) * freq * 6.2831);
  float b = sin((uv.y + j.y * jitter) * freq * 6.2831);
  return 0.5 + 0.25 * a + 0.25 * b;
}

/* Raised diamond quilting: diamond metric, deep seam, padded dome inside. */
float quilt(vec2 uv, float cells) {
  vec2 p = abs(fract(uv * cells) - 0.5);
  float d = (p.x + p.y) * 2.0;
  float seam = smoothstep(0.80, 1.0, d);
  float dome = sin(clamp((1.0 - d) * 1.6, 0.0, 1.0) * 1.5708);
  return dome * (1.0 - seam) - seam * 0.55;
}

/* Interlocking rings: two staggered grids of annuli. The overlap is what
   reads as mail rather than as dots. */
float mailRing(vec2 uv, float freq) {
  vec2 g = uv * freq;
  vec2 cell = floor(g);
  float best = 1e9;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      c.x += mod(c.y, 2.0) * 0.5;
      float r = length(g - c);
      best = min(best, abs(r - 0.42));
    }
  }
  return 1.0 - smoothstep(0.055, 0.115, best);
}

void main() {
  int mat = vMat;
  vec3 albedo = vColor;
  float metalness = 0.0;
  float roughness = 0.85;
  float ao = 1.0;
  vec2 wp = vWorld.xz;
  float y = vWorld.y;

  if (mat == MAT_LINEN) {
    float w = weave(wp + y * 0.7, 26.0, 0.35);
    albedo *= 0.86 + w * 0.28;
    float hem = smoothstep(1.05, 0.05, y);
    albedo *= mix(1.0, 0.74, hem * 0.8);
    roughness = 0.92;
  } else if (mat == MAT_GAMBESON) {
    float q = quilt(wp, 5.5);
    albedo *= 0.80 + q * 0.42;
    ao *= mix(0.55, 1.0, clamp(q * 1.4 + 0.45, 0.0, 1.0));
    roughness = 0.88;
  } else if (mat == MAT_MAIL) {
    float ring = mailRing(wp, 74.0);
    albedo *= mix(0.42, 1.16, ring);
    metalness = 0.78;
    roughness = mix(0.52, 0.28, ring);
  } else if (mat == MAT_PLATE) {
    float brush = sin(y * 41.0 + hash12(floor(wp * 90.0)) * 3.0) * 0.5 + 0.5;
    vec2 b = abs(fract(wp * 2.2) - 0.5);
    float border = smoothstep(0.44, 0.50, max(b.x, b.y));
    vec2 rc = fract(wp * 6.6) - 0.5;
    float rivet = smoothstep(0.16, 0.07, length(rc));
    float p = mix(brush, 0.18, border);
    /* age tier lives in the packed word: bits 12+ are the age (1..4) */
    float ageTier = floor(fract(vPack.y / 4096.0) * 16.0);
    vec3 steel = vec3(0.62, 0.64, 0.68) * (0.70 + p * 0.55);
    albedo = mix(steel, vec3(0.92, 0.72, 0.30), rivet * 0.85);
    /* Imperial gold trim: gilded panel borders from Age III up. */
    float gild = smoothstep(2.5, 3.5, ageTier) * border;
    albedo = mix(albedo, vec3(0.95, 0.76, 0.34) * (0.8 + brush * 0.5), gild * 0.8);
    metalness = 0.85;
    roughness = mix(0.30, 0.16, rivet);
  } else if (mat == MAT_SKIN) {
    float v = hash12(floor(wp * 220.0));
    albedo *= 0.94 + v * 0.12;
    roughness = 0.68;
  } else if (mat == MAT_HAIR) {
    float strand = hash12(vec2(floor(wp.x * 260.0), floor(y * 18.0)));
    albedo *= 0.62 + strand * 0.55;
    roughness = 0.75;
  } else if (mat == MAT_LEATHER) {
    float g = hash12(floor(wp * 150.0)) * 0.6 + hash12(floor(wp * 40.0)) * 0.4;
    albedo *= 0.82 + g * 0.34;
    roughness = 0.58;
    metalness = 0.05;
  } else if (mat == MAT_WOOD) {
    float grain = sin(y * 52.0 + hash12(floor(wp * 30.0)) * 2.0) * 0.5 + 0.5;
    albedo *= 0.78 + grain * 0.36;
    roughness = 0.80;
  }

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = shadowFactor(vWorld, ndl);
  float cl = cloudShadow(vWorld.xz);
  vec3 ambient = mix(uGroundColor * 1.15, uSkyColor * 0.86, N.y * 0.5 + 0.5) * (0.62 + 0.5 * N.y);
  ambient *= ao;

  vec3 V = normalize(uCameraPos - vWorld);
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, mix(8.0, 96.0, 1.0 - roughness)) * mix(0.06, 1.5, metalness);

  vec3 color = albedo * (uSunColor * ndl * sh * cl * 1.25 + ambient);
  color += uSunColor * spec * sh * cl * 1.3;

  /* Team colour on cloth: replace the hue, keep the weave's luminance so a
     dyed tunic still reads as folded cloth. */
  if (mat == MAT_LINEN || mat == MAT_GAMBESON) {
    float shade = dot(albedo, vec3(0.299, 0.587, 0.114));
    vec3 teamAlb = vTint.rgb * (0.55 + shade * 1.2);
    color = mix(color, teamAlb * (uSunColor * ndl * sh * cl * 1.25 + ambient), 0.55);
  }

  float dmg = vState.x;
  if (dmg > 0.01) color *= 1.0 - dmg * 0.3;

  color = applyFog(color, vDist);
  color = applyFoW(color, vWorld);
  fragColor = vec4(tonemap(color, 1.02), vState.y);
}
`;
