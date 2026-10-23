/* ============================================================
   shaders.js — GLSL ES 3.00 sources
   A physically-inspired (but mobile-priced) pipeline:
     sky → terrain (6-way splat + cloud shadows + FoW) → water
     → instanced models (team tint, sway, damage, construction)
     → particles → billboards → tonemapped output.
   ============================================================ */

/* ---------------- shared chunks ---------------- */
const COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;

const float PI = 3.14159265359;
float saturate(float x){ return clamp(x, 0.0, 1.0); }
vec3 saturate3(vec3 x){ return clamp(x, 0.0, 1.0); }
float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
float hash13(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm2(vec2 p){
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8,0.6,-0.6,0.8);
  for(int i=0;i<5;i++){ s += a*vnoise(p); p = r*p*2.03; a *= 0.5; }
  return s;
}
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
vec3 srgbToLinear(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * (1.0 / 12.92), pow((c + 0.055) * (1.0 / 1.055), vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c){
  return mix(1.055*pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, c*12.92, step(c, vec3(0.0031308)));
}
vec3 tonemap(vec3 c, float exposure){
  return toSRGB(aces(c * exposure));
}
`;

const LIGHT_UNIFORMS = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uNight;
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowTexel;
uniform float uShadowStrength;
uniform sampler2D uClouds;
uniform vec2 uCloudOffset;
uniform sampler2D uFogTex;
uniform float uFogEnabled;
uniform float uWorldHalf;
uniform vec3 uTownLight[4];   // world position of the four strongest fires
uniform float uTownLightI;    // 0 by day, 1 at night
uniform vec3 uTownLightColor;
`;

/* Warm pools of firelight around the town. Three cheap point lights cost a
   few ALU ops and are the difference between "a dark shader" and a hearth-lit
   village at night. */
const TOWN_LIGHT_FN = /* glsl */`
vec3 townLights(vec3 p, vec3 N){
  if (uTownLightI < 0.01) return vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 L = uTownLight[i] - p;
    float d2 = dot(L, L);
    float flick = 0.86 + 0.14 * sin(uTime * (5.0 + float(i) * 1.7) + float(i) * 2.1);
    float att = uTownLightI * flick / (1.0 + d2 * 0.013 + d2 * d2 * 0.00022);
    sum += max(dot(N, normalize(L)), 0.0) * att;
  }
  return sum * uTownLightColor;
}
/* A wider, non-directional bloom of warm air around each fire. This is what
   makes a lit street read as "lit" instead of "a sphere of paint". */
vec3 townGlow(vec3 p){
  if (uTownLightI < 0.01) return vec3(0.0);
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 L = uTownLight[i] - p;
    float d2 = dot(L, L);
    sum += 1.0 / (1.0 + d2 * 0.020 + d2 * d2 * 0.00030);
  }
  return uTownLightColor * sum * uTownLightI * 0.030;
}
`;

const SHADOW_FN = /* glsl */`
float shadowFactor(vec3 worldPos, float ndl){
  if (uShadowStrength <= 0.001) return 1.0;
  vec4 sp = uShadowMatrix * vec4(worldPos, 1.0);
  vec3 proj = sp.xyz / sp.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.002 || proj.x > 0.998 || proj.y < 0.002 || proj.y > 0.998) return 1.0;
  float bias = mix(0.0022, 0.0009, ndl);
  float texel = uShadowTexel;
  float s = 0.0;
  s += texture(uShadowMap, vec3(proj.xy + vec2(-0.55,-0.55)*texel, proj.z - bias));
  s += texture(uShadowMap, vec3(proj.xy + vec2( 0.55,-0.55)*texel, proj.z - bias));
  s += texture(uShadowMap, vec3(proj.xy + vec2(-0.55, 0.55)*texel, proj.z - bias));
  s += texture(uShadowMap, vec3(proj.xy + vec2( 0.55, 0.55)*texel, proj.z - bias));
  s *= 0.25;
  return mix(1.0, s, uShadowStrength);
}
float cloudShadow(vec2 worldXZ){
  vec2 uv = worldXZ * 0.0011 + uCloudOffset;
  float c = texture(uClouds, uv).a;
  return mix(1.0, 0.80, clamp(c*1.25, 0.0, 1.0));
}
float fogOfWar(vec3 worldPos, out float explored){
  if (uFogEnabled < 0.5) { explored = 1.0; return 1.0; }
  vec2 uv = worldPos.xz / (uWorldHalf * 2.0) + 0.5;
  float v = texture(uFogTex, uv).r;
  explored = v;
  return v;
}
vec3 applyFog(vec3 color, float dist){
  float f = 1.0 - exp(-dist * uFogDensity);
  return mix(color, uFogColor, clamp(f, 0.0, 0.94));
}
vec3 applyFoW(vec3 color, vec3 worldPos){
  float explor;
  float vis = fogOfWar(worldPos, explor);
  if (uFogEnabled < 0.5) return color;
  // Explored-but-not-visible ground keeps its shapes: desaturate and cool it
  // slightly instead of sinking it into black, so the map stays readable.
  float l = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 memory = mix(vec3(l), color, 0.52) * vec3(0.80, 0.84, 0.93);
  vec3 shown = mix(color, memory, clamp((1.0 - vis) * 1.35, 0.0, 0.55));
  // After dark, visibility matters more than tone: an unexplored-but-seen area
  // only dims to 40 %, while unseen ground still drops to a near-black 16 %.
  float dark = smoothstep(0.015, 0.30, vis);
  vec3 floorC = mix(vec3(0.16), vec3(0.16, 0.20, 0.30), uNight);
  return shown * mix(floorC, vec3(1.0), dark);
}
`;

/* ============================================================
   SKY
   ============================================================ */
const SKY_GLSL = /* glsl */`
vec3 skyRadiance(vec3 dir, vec3 sunDir, vec3 zenith, vec3 horizon, vec3 sunColor){
  float h = clamp(dir.y, -1.0, 1.0);
  float t = pow(1.0 - clamp(h, 0.0, 1.0), 2.6);
  vec3 col = mix(zenith, horizon, t);
  // ground haze below the horizon
  col = mix(col, horizon * 0.62, smoothstep(0.0, -0.35, h));
  float mu = max(dot(dir, sunDir), 0.0);
  // forward scattering halo
  col += sunColor * pow(mu, 8.0) * 0.55;
  col += sunColor * pow(mu, 2.0) * 0.10;
  return col;
}
`;

export const SKY_VS = /* glsl */`#version 300 es
${COMMON}
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.999999, 1.0);
}
`;

export const SKY_FS = /* glsl */`#version 300 es
${COMMON}
${SKY_GLSL}
${LIGHT_UNIFORMS}
in vec2 vUV;
out vec4 fragColor;
uniform mat4 uInvViewProj;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform float uCloudCover;
uniform float uStarAmount;

vec3 stars(vec3 dir){
  if (uStarAmount < 0.01) return vec3(0.0);
  vec3 p = dir * 220.0;
  vec3 id = floor(p);
  float h = hash13(id);
  if (h < 0.9965) return vec3(0.0);
  vec3 f = fract(p) - 0.5;
  float d = length(f);
  float twinkle = 0.6 + 0.4 * sin(uTime * 2.2 + h * 80.0);
  float core = smoothstep(0.14, 0.0, d) * twinkle;
  return vec3(0.85, 0.9, 1.0) * core * uStarAmount * 2.2;
}

void main(){
  vec4 clip = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  vec3 dir = normalize(world.xyz / world.w - uCameraPos);

  vec3 col = skyRadiance(dir, uSunDir, uZenithColor, uHorizonColor, uSunColor);
  col += stars(dir) * smoothstep(0.0, 0.2, dir.y);

  // sun disc + glow
  float mu = dot(dir, uSunDir);
  col += uSunColor * smoothstep(0.9993, 0.9998, mu) * 26.0;
  col += uSunColor * pow(max(mu, 0.0), 220.0) * 1.6;

  // clouds: two scrolling layers projected on a dome
  if (dir.y > 0.015) {
    vec2 cuv = dir.xz / (dir.y + 0.35);
    float c1 = fbm2(cuv * 0.85 + uCloudOffset * 2.0);
    float c2 = fbm2(cuv * 2.1 + uCloudOffset * 3.4 + 4.0);
    float cover = mix(c1, c2, 0.45);
    float mask = smoothstep(0.55 - uCloudCover * 0.28, 0.86, cover);
    float horizonFade = smoothstep(0.02, 0.24, dir.y);
    float sunGlow = pow(max(mu, 0.0), 6.0);
    vec3 cloudLit = mix(uSkyColor * 0.55 + uSunColor * 0.35, vec3(1.0, 0.96, 0.9) * (0.6 + uSunColor * 0.35), 0.55);
    cloudLit += uSunColor * sunGlow * 0.9;
    col = mix(col, cloudLit, mask * horizonFade * 0.86);
  }

  // slight dithering to kill banding on 8-bit displays
  col += (hash12(gl_FragCoord.xy) - 0.5) * 0.006;
  fragColor = vec4(tonemap(col, 1.0), 1.0);
}
`;

/* ============================================================
   TERRAIN
   ============================================================ */
export const TERRAIN_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aSplat;
layout(location=3) in vec2 aSplat2;
${LIGHT_UNIFORMS}
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vSplat;
out vec2 vSplat2;
out float vDist;
void main(){
  vec4 wp = vec4(aPos, 1.0);
  vWorld = aPos;
  vNormal = aNormal;
  vSplat = aSplat;
  vSplat2 = aSplat2;
  vec4 cp = uViewProj * wp;
  vDist = length(aPos - uCameraPos);
  gl_Position = cp;
}
`;

export const TERRAIN_FS = /* glsl */`#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
${TOWN_LIGHT_FN}
${SHADOW_FN}
in vec3 vWorld;
in vec3 vNormal;
in vec4 vSplat;
in vec2 vSplat2;
in float vDist;
out vec4 fragColor;
uniform sampler2DArray uTerrain;
uniform float uLayerScale;
uniform float uDetail;

#define L_GRASS 0
#define L_GRASS_DRY 1
#define L_DIRT 2
#define L_ROCK 3
#define L_SAND 4
#define L_FARM 5
#define L_COBBLE 6
#define L_SNOW 7
#define L_MUD 8
#define L_GRAVEL 9
#define L_FOREST 10
#define L_ASH 11

vec3 terrainSample(vec2 uv){
  vec4 w = vSplat;
  vec2 we = vSplat2;
  float macro = fbm2(vWorld.xz * 0.013 + vec2(3.0));
  float patchn = fbm2(vWorld.xz * 0.055 - vec2(7.0));

  vec3 grass = mix(
    texture(uTerrain, vec3(uv, L_GRASS)).rgb,
    texture(uTerrain, vec3(uv * 0.86, L_GRASS_DRY)).rgb,
    smoothstep(0.42, 0.82, macro + patchn * 0.25)
  );
  float forestMask = smoothstep(0.55, 0.9, fbm2(vWorld.xz * 0.02 + vec2(11.0))) * 0.5;
  vec3 forest = texture(uTerrain, vec3(uv, L_FOREST)).rgb;
  grass = mix(grass, forest, forestMask);

  vec3 dirt = texture(uTerrain, vec3(uv * 0.8, L_DIRT)).rgb;
  vec3 rock = texture(uTerrain, vec3(uv * 1.15, L_ROCK)).rgb;
  vec3 sand = texture(uTerrain, vec3(uv * 1.3, L_SAND)).rgb;
  vec3 cobble = texture(uTerrain, vec3(uv * 1.6, L_COBBLE)).rgb;
  vec3 snow = texture(uTerrain, vec3(uv * 0.9, L_SNOW)).rgb;

  vec3 col = grass * w.x;
  col += dirt * w.y;
  col += rock * w.z;
  col += sand * w.w;
  col += cobble * we.x;
  col += snow * we.y;
  float sum = w.x + w.y + w.z + w.w + we.x + we.y;
  return col / max(sum, 0.0001);
}

void main(){
  vec2 uv = vWorld.xz * uLayerScale;
  vec3 albedo = srgbToLinear(terrainSample(uv));
  // macro tint + micro breakup
  float micro = texture(uClouds, vWorld.xz * 0.021).a;
  albedo *= 0.92 + micro * 0.16;
  albedo *= uDetail;

  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = shadowFactor(vWorld, ndl);
  float cl = cloudShadow(vWorld.xz);

  // Hemisphere ambient, deliberately desaturated: a saturated blue fill on
  // vertical walls reads as "grey and washed out" from an RTS camera.
  // After dark the ground loses saturation and takes a cool cast.
  albedo *= mix(vec3(1.0), vec3(0.66, 0.76, 1.06), uNight * 0.62);
  vec3 skyFill = mix(uSkyColor * 0.86, vec3(0.30, 0.31, 0.30), 0.5);
  vec3 ambient = mix(uGroundColor * 1.15, skyFill, N.y * 0.5 + 0.5) * (0.66 + 0.46 * N.y);
  vec3 color = albedo * (uSunColor * ndl * sh * cl * 1.02 + ambient);
  color += albedo * townLights(vWorld, N) * 0.9;
  color += townGlow(vWorld) * mix(albedo, vec3(0.5), 0.5) * 0.8;

  // wet sheen near the waterline
  float wet = smoothstep(0.55, 0.0, vWorld.y);
  color *= mix(1.0, 0.72, wet * 0.8);

  color = applyFog(color, vDist);
  color = applyFoW(color, vWorld);
  // the terrain runs a hotter exposure than the models by day; after dark that
  // same curve turns night into a green-grey soup, so it comes down at night
  fragColor = vec4(tonemap(color, mix(1.72, 1.06, uNight)), 1.0);
}
`;

/* ============================================================
   INSTANCED MODELS (buildings, props, units)
   ============================================================ */
export const MODEL_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aMat;
layout(location=3) in vec2 aUV;
layout(location=4) in vec3 aColor;
layout(location=5) in float aPart;
layout(location=6) in vec3 aPivot;
layout(location=7) in vec4 iM0;
layout(location=8) in vec4 iM1;
layout(location=9) in vec4 iM2;
layout(location=10) in vec4 iM3;
layout(location=11) in vec4 iA;   // rgb = team/tint, a = build progress
layout(location=12) in vec4 iB;   // x damage, y alpha, z flags, w seed
layout(location=13) in vec4 iC;   // legL, legR, armL, armR
layout(location=14) in vec4 iD;   // extra, bob, attack, sway
${LIGHT_UNIFORMS}
uniform mat4 uViewProj;
uniform float uSwayAmount;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
flat out int vMat;
out vec4 vTint;
out vec4 vState;
out float vDist;

float partAngle(int part){
  if (part == 1) return iC.x;
  if (part == 2) return iC.y;
  if (part == 3) return iC.z;
  if (part == 4) return iC.w;
  if (part == 5) return iD.x;
  return 0.0;
}

void main(){
  mat4 model = mat4(iM0, iM1, iM2, iM3);
  int part = int(aPart + 0.5);
  vec3 p = aPos;
  vec3 n = aNormal;
  float ang = partAngle(part);
  if (abs(ang) > 0.0001) {
    vec3 piv = aPivot * (1.0 / 256.0);
    vec3 lp = p - piv;
    float c = cos(ang), s = sin(ang);
    lp = vec3(lp.x, lp.y * c - lp.z * s, lp.y * s + lp.z * c);
    p = lp + piv;
    n = vec3(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
  }
  p.y += iD.y;

  vec4 wp = model * vec4(p, 1.0);
  vec3 wn = normalize(mat3(model) * n);

  // foliage / banner sway, in world space
  float sway = iD.w * uSwayAmount;
  if (sway > 0.001) {
    float ph = uTime * 1.4 + wp.x * 0.32 + wp.z * 0.27;
    float amt = sway * max(p.y, 0.0) * 0.028;
    wp.x += sin(ph) * amt + sin(ph * 2.7) * amt * 0.3;
    wp.z += cos(ph * 0.85) * amt * 0.7;
  }

  // construction: geometry rises out of the ground as the foundation is laid
  float prog = iA.a;
  if (prog < 0.999) {
    float h = max(wp.y - iM3.y, 0.0);
    wp.y = iM3.y + min(h, prog * 13.0);
  }

  vWorld = wp.xyz;
  vNormal = wn;
  vUV = aUV;
  vColor = aColor;
  vMat = int(aMat + 0.5);
  vTint = iA;
  vState = iB;
  vDist = length(wp.xyz - uCameraPos);
  gl_Position = uViewProj * wp;
}
`;

export const MODEL_FS = /* glsl */`#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
${TOWN_LIGHT_FN}
${SHADOW_FN}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
flat in int vMat;
in vec4 vTint;
in vec4 vState;
in float vDist;
out vec4 fragColor;
uniform sampler2DArray uMaterials;

#define M_STONE 0
#define M_STONE_LIGHT 1
#define M_PLASTER 2
#define M_WOOD 3
#define M_WOOD_DARK 4
#define M_ROOF 5
#define M_THATCH 6
#define M_CLOTH 7
#define M_IRON 8
#define M_GOLD 9
#define M_MARBLE 10
#define M_BRICK 11
#define M_GLASS 12
#define M_GRAVEL 13
#define M_LEATHER 14
#define M_LEAF 15
#define M_SKIN 16

void main(){
  int layer = vMat;
  vec4 tex = texture(uMaterials, vec3(vUV, float(layer)));
  vec3 albedo = srgbToLinear(tex.rgb) * vColor;

  // Team colour replaces the garment hue instead of multiplying it: the
  // texture's own luminance keeps the weave and folds, so a red-dyed cloth
  // still reads as folded cloth when the team is blue.
  float teamW = 0.0;
  if (layer == M_CLOTH) teamW = 0.94;
  else if (layer == M_GOLD) teamW = 0.30;
  else if (layer == M_LEATHER) teamW = 0.12;
  if (teamW > 0.0) {
    float shade = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
    // the team colour is authored in sRGB like the textures
    vec3 teamAlb = srgbToLinear(vTint.rgb) * (0.55 + shade * 1.25);
    albedo = mix(albedo, teamAlb, teamW);
  }

  // battle damage
  float dmg = vState.x;
  if (dmg > 0.01) {
    float scorch = fbm2(vWorld.xz * 0.8 + vWorld.y * 0.5);
    albedo = mix(albedo, vec3(0.07, 0.06, 0.055), dmg * clamp(scorch * 1.5, 0.0, 0.9));
    albedo *= 1.0 - dmg * 0.28;
  }

  // moonlight strips colour: albedo cools and loses saturation after dark
  albedo *= mix(vec3(1.0), vec3(0.70, 0.79, 1.02), uNight * 0.55);

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = shadowFactor(vWorld, ndl);
  float cl = cloudShadow(vWorld.xz);
  // hemisphere ambient: warm bounce from the ground, cool from the sky. The
  // wet-down blend keeps vertical walls from going flat blue-grey.
  vec3 ambient = mix(uGroundColor * 1.15, uSkyColor * 0.86, N.y * 0.5 + 0.5) * (0.62 + 0.5 * N.y);

  vec3 V = normalize(uCameraPos - vWorld);
  float specMask = (layer == M_IRON || layer == M_GOLD || layer == M_GLASS) ? 1.0
                 : (layer == M_STONE || layer == M_MARBLE || layer == M_STONE_LIGHT) ? 0.22
                 : (layer == M_LEATHER) ? 0.14 : 0.05;
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), mix(20.0, 110.0, specMask)) * specMask;

  vec3 emissive = vec3(0.0);
  if (layer == M_GLASS) {
    emissive = vec3(1.0, 0.62, 0.26) * (0.18 + uNight * 3.4) * (0.55 + 0.45 * fbm2(vWorld.xz * 3.0));
  } else if (layer == M_GOLD) {
    emissive = vec3(1.0, 0.62, 0.22) * uNight * 0.22;
  }

  vec3 color = albedo * (uSunColor * ndl * sh * cl * 1.25 + ambient);
  color += albedo * townLights(vWorld, N);
  color += townGlow(vWorld) * mix(albedo, vec3(0.5), 0.5);
  color += uSunColor * spec * sh * cl * 1.4;
  color += emissive;

  if (layer == M_LEAF) {
    float back = max(dot(-N, uSunDir), 0.0);
    color += uSunColor * albedo * back * 0.42;
    color += uSkyColor * albedo * 0.12;
  }

  // rim light helps units read against the terrain from the RTS camera
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  color += uSkyColor * rim * 0.16;

  color = applyFog(color, vDist);
  color = applyFoW(color, vWorld);
  fragColor = vec4(tonemap(color, 1.02), vState.y * tex.a);
}
`;

/* ============================================================
   SHADOW PASS
   ============================================================ */
export const SHADOW_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=5) in float aPart;
layout(location=6) in vec3 aPivot;
layout(location=7) in vec4 iM0;
layout(location=8) in vec4 iM1;
layout(location=9) in vec4 iM2;
layout(location=10) in vec4 iM3;
layout(location=11) in vec4 iA;
layout(location=13) in vec4 iC;
layout(location=14) in vec4 iD;
uniform mat4 uLightViewProj;
uniform float uTime;
uniform float uSwayAmount;
void main(){
  mat4 model = mat4(iM0, iM1, iM2, iM3);
  int part = int(aPart + 0.5);
  vec3 p = aPos;
  float ang = 0.0;
  if (part == 1) ang = iC.x;
  else if (part == 2) ang = iC.y;
  else if (part == 3) ang = iC.z;
  else if (part == 4) ang = iC.w;
  else if (part == 5) ang = iD.x;
  if (abs(ang) > 0.0001) {
    vec3 piv = aPivot * (1.0 / 256.0);
    vec3 lp = p - piv;
    float c = cos(ang), s = sin(ang);
    lp = vec3(lp.x, lp.y * c - lp.z * s, lp.y * s + lp.z * c);
    p = lp + piv;
  }
  p.y += iD.y;
  vec4 wp = model * vec4(p, 1.0);
  float prog = iA.a;
  if (prog < 0.999) {
    float h = max(wp.y - iM3.y, 0.0);
    wp.y = iM3.y + min(h, prog * 13.0);
  }
  gl_Position = uLightViewProj * wp;
}
`;

export const SHADOW_FS = /* glsl */`#version 300 es
precision mediump float;
void main(){ }
`;

/* ============================================================
   WATER
   ============================================================ */
export const WATER_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
${LIGHT_UNIFORMS}
uniform mat4 uViewProj;
uniform float uWaveAmp;
out vec3 vWorld;
out float vDist;
void main(){
  vec3 p = aPos;
  float w = sin(p.x * 0.22 + uTime * 1.3) * 0.06 + sin(p.z * 0.31 - uTime * 1.05) * 0.05
          + sin((p.x + p.z) * 0.11 + uTime * 0.7) * 0.03;
  p.y += w * uWaveAmp;
  vWorld = p;
  vDist = length(p - uCameraPos);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const WATER_FS = /* glsl */`#version 300 es
${COMMON}
${SKY_GLSL}
${LIGHT_UNIFORMS}
${SHADOW_FN}
in vec3 vWorld;
in float vDist;
out vec4 fragColor;
uniform sampler2D uNormalMap;
uniform sampler2D uHeightMap;
uniform vec2 uNormalOffset;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;

void main(){
  vec2 uv1 = vWorld.xz * 0.045 + uNormalOffset * 1.0;
  vec2 uv2 = vWorld.xz * 0.021 - uNormalOffset * 0.6;
  vec3 n1 = texture(uNormalMap, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture(uNormalMap, uv2).xyz * 2.0 - 1.0;
  vec3 nrm = normalize(vec3(n1.x + n2.x * 0.8, 2.2, n1.y + n2.y * 0.8));

  // terrain depth beneath the surface
  vec2 huv = vWorld.xz / (uWorldHalf * 2.0) + 0.5;
  float bed = texture(uHeightMap, huv).r * 46.0 - 8.0;
  float depth = max(vWorld.y - bed, 0.0);
  float shallow = smoothstep(3.4, 0.05, depth);

  vec3 V = normalize(uCameraPos - vWorld);
  vec3 L = uSunDir;
  float fres = pow(1.0 - max(dot(nrm, V), 0.0), 4.0);
  vec3 R = reflect(-V, nrm);
  vec3 sky = skyRadiance(R, L, uZenithColor, uHorizonColor, uSunColor);

  float spec = pow(max(dot(R, L), 0.0), 340.0) * 3.4 + pow(max(dot(R, L), 0.0), 24.0) * 0.32;
  vec3 body = mix(uDeepColor, uShallowColor, shallow);
  float sh = shadowFactor(vWorld, 1.0);
  vec3 col = mix(body, sky * 0.95, clamp(0.16 + fres * 0.95, 0.0, 1.0));
  col += uSunColor * spec * sh;

  // shoreline foam
  float foamNoise = fbm2(vWorld.xz * 0.35 + uTime * 0.18);
  float foam = smoothstep(0.55, 0.02, depth + foamNoise * 0.5 - 0.18);
  col = mix(col, vec3(0.92, 0.96, 0.98), foam * 0.65);

  col = applyFog(col, vDist);
  col = applyFoW(col, vWorld);
  float alpha = mix(0.82, 0.94, fres) * mix(1.0, 0.92, foam);
  fragColor = vec4(tonemap(col, 1.0), alpha);
}
`;

/* ============================================================
   PARTICLES (instanced billboards)
   ============================================================ */
export const PARTICLE_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iP0;   // xyz position, w size
layout(location=2) in vec4 iP1;   // rgb colour, a alpha
layout(location=3) in vec4 iP2;   // x rotation, y sprite layer, z stretch, w fade curve
uniform mat4 uViewProj;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uCameraPos;
out vec2 vUV;
out vec3 vColor;
out float vAlpha;
out float vLayer;
void main(){
  float rot = iP2.x;
  float s = sin(rot), c = cos(rot);
  vec2 corner = aCorner;
  vec2 rc = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  vec3 world = iP0.xyz
    + uRight * rc.x * iP0.w
    + uUp * rc.y * iP0.w * mix(1.0, 1.0 + iP2.z, 0.35);
  vUV = corner * 0.5 + 0.5;
  vColor = iP1.rgb;
  vAlpha = iP1.a;
  vLayer = iP2.y;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const PARTICLE_FS = /* glsl */`#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
in vec2 vUV;
in vec3 vColor;
in float vAlpha;
in float vLayer;
out vec4 fragColor;
uniform sampler2DArray uSprites;
uniform float uAdditive;
void main(){
  vec4 tex = texture(uSprites, vec3(vUV, vLayer));
  float a = tex.a * vAlpha;
  if (a < 0.003) discard;
  vec3 col = tex.rgb * vColor;
  if (uAdditive > 0.5) {
    fragColor = vec4(col * a, a);
  } else {
    col = mix(col, uFogColor, clamp(1.0 - exp(-0.004 * uFogDensity * 1000.0), 0.0, 0.5));
    fragColor = vec4(tonemap(col, 1.0), a);
  }
}
`;

/* ============================================================
   WORLD-SPACE BILLBOARDS (health bars, selection rings, markers)
   ============================================================ */
export const BILLBOARD_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPos;    // xyz, width
layout(location=2) in vec4 iCol;    // rgba
layout(location=3) in vec4 iExtra;  // height scale, round?, border alpha, unused
uniform mat4 uViewProj;
uniform vec3 uCameraPos;
uniform vec3 uRight;
out vec2 vUV;
out vec4 vCol;
out vec4 vExtra;
void main(){
  vec3 world = iPos.xyz + uRight * aCorner.x * iPos.w + vec3(0.0, aCorner.y * iExtra.x, 0.0);
  vUV = aCorner * 0.5 + 0.5;
  vCol = iCol;
  vExtra = iExtra;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const BILLBOARD_FS = /* glsl */`#version 300 es
${COMMON}
in vec2 vUV;
in vec4 vCol;
in vec4 vExtra;
out vec4 fragColor;
void main(){
  vec2 d = vUV * 2.0 - 1.0;
  float a;
  if (vExtra.y > 0.5) {
    // ring
    float r = length(d);
    a = smoothstep(1.0, 0.94, r) * smoothstep(0.72, 0.86, r);
  } else {
    // bar: rounded rect
    vec2 q = abs(d) - vec2(0.86, 0.55);
    float rr = 0.0;
    float m = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rr;
    a = smoothstep(0.14, -0.02, m);
  }
  a *= vCol.a;
  if (a < 0.01) discard;
  fragColor = vec4(vCol.rgb, a);
}
`;

/* ============================================================
   DECAL (flat terrain-hugging quads: footprints, rally markers)
   ============================================================ */
export const DECAL_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPos;    // xyz, size
layout(location=2) in vec4 iCol;
layout(location=3) in vec4 iExtra;  // rot, kind, progress, unused
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vCol;
out vec4 vExtra;
out vec3 vWorld;
void main(){
  float s = iExtra.x;
  vec2 c = vec2(aCorner.x * cos(s) - aCorner.y * sin(s), aCorner.x * sin(s) + aCorner.y * cos(s));
  vec3 world = iPos.xyz + vec3(c.x * iPos.w, 0.01, c.y * iPos.w);
  vUV = aCorner * 0.5 + 0.5;
  vCol = iCol;
  vExtra = iExtra;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const DECAL_FS = /* glsl */`#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
in vec2 vUV;
in vec4 vCol;
in vec4 vExtra;
in vec3 vWorld;
out vec4 fragColor;
void main(){
  vec2 d = vUV * 2.0 - 1.0;
  float r = length(d);
  float kind = vExtra.y;
  float a;
  vec3 col = vCol.rgb;
  if (kind < 0.5) {
    // soft blob (footprint / ambient occlusion / crater)
    a = smoothstep(1.0, 0.15, r) * vCol.a;
  } else if (kind < 1.5) {
    // selection ring
    a = smoothstep(1.0, 0.93, r) * smoothstep(0.80, 0.93, r) * vCol.a;
  } else if (kind < 2.5) {
    // build footprint grid
    vec2 g = abs(fract(d * 3.0) - 0.5);
    float grid = smoothstep(0.46, 0.49, max(g.x, g.y));
    a = max(grid * 0.55, smoothstep(1.0, 0.9, r) * 0.7) * vCol.a;
  } else {
    // rally marker (chevrons)
    float band = sin(d.y * 6.0 + 1.2) * 0.5 + 0.5;
    a = smoothstep(1.0, 0.3, r) * (0.35 + band * 0.65) * vCol.a;
  }
  if (a < 0.01) discard;
  col *= 1.0 + vExtra.z * 0.6;
  fragColor = vec4(col, a);
}
`;

/* ============================================================
   FXAA-ish full screen (optional quality pass)
   ============================================================ */
export const POST_VS = /* glsl */`#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const POST_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uVignette;
uniform float uTime;
uniform float uGrain;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  // cheap unsharp mask: keeps hand-painted texture detail crisp on a phone
  vec3 blur = (
      texture(uScene, vUV + vec2( uTexel.x, 0.0)).rgb +
      texture(uScene, vUV + vec2(-uTexel.x, 0.0)).rgb +
      texture(uScene, vUV + vec2(0.0, uTexel.y)).rgb +
      texture(uScene, vUV + vec2(0.0, -uTexel.y)).rgb) * 0.25;
  c = clamp(c + (c - blur) * 0.42, 0.0, 1.0);
  // grade: a touch of warmth in the highlights, cool in the shadows
  float l = luma(c);
  c *= mix(vec3(0.97, 1.0, 1.05), vec3(1.03, 1.0, 0.97), smoothstep(0.25, 0.85, l));
  // vignette
  vec2 q = vUV - 0.5;
  c *= 1.0 - dot(q, q) * uVignette;
  // dither instead of visible film grain
  float g = fract(sin(dot(vUV * vec2(1234.5, 987.6) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * uGrain;
  fragColor = vec4(c, 1.0);
}
`;
