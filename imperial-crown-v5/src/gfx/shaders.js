/* ============================================================
   shaders.js — GLSL ES 3.00 sources (v3)

   v2 was a per-pixel procedural renderer: forty noise octaves in the terrain
   shader, twenty in the sky, twelve in every model, two in every fogged
   fragment of every material. It looked good in a screenshot and ran at
   single-digit FPS on an Adreno 610, because that GPU has roughly one
   twentieth of the fragment throughput the shader assumed.

   v3 keeps the same art direction but moves every *static* field into baked
   textures (see bake.js). What is left in the fragment shaders is lighting:
   a fetch or three, a Lambert term, a shadow compare, a tonemap. The result
   is the same picture at a fraction of the cost, and the baked fields can
   afford more octaves than the procedural ones could, so close-ups are
   sharper and nothing shimmers.
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
/* A cheap, sin-free hash. It only survives in the sky dither and the moon:
   everywhere else the noise lives in a baked texture now. */
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
/* pow(x, 1/2.2) costs three log2/exp2 pairs per pixel across 1280x720 pixels
   -- on an Adreno 610 that is a measurable slice of every frame. The
   two-term sqrt fit below is within ~2 % of the real curve in the midtones
   and free (sqrt is a single instruction). */
vec3 toSRGB(vec3 c){
  c = max(c, vec3(0.0));
  vec3 s = sqrt(c);
  vec3 r = s * (1.13 - 0.13 * s);
  return mix(r, c * 12.92, step(c, vec3(0.0031308)));
}
vec3 tonemap(vec3 c, float exposure){
  return toSRGB(aces(c * exposure));
}
/* constant-exponent powers without pow() */
float p4(float x){ float y = x*x; return y*y; }
float p8(float x){ float y = p4(x); return y*y; }
float p16(float x){ float y = p8(x); return y*y; }
float p32(float x){ float y = p16(x); return y*y; }
float p64(float x){ float y = p32(x); return y*y; }
float p128(float x){ float y = p64(x); return y*y; }
float p256(float x){ float y = p128(x); return y*y; }
float pow340(float x){ return p256(x) * p64(x) * p16(x) * p4(x); }
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
uniform float uCloudStrength;
uniform sampler2D uFogTex;
uniform float uFogEnabled;
uniform float uWorldHalf;
uniform vec3 uTownLight[4];   // world position of the four strongest fires
uniform float uTownLightI;    // 0 by day, 1 at night
uniform vec3 uTownLightColor;
`;

const NOISE_UNIFORM = /* glsl */`
uniform sampler2D uNoise;
`;

/* Warm pools of firelight around the town. Four cheap point lights cost a few
   ALU ops and are the difference between "a dark shader" and a hearth-lit
   village at night. The whole block is skipped by a uniform branch by day. */
const TOWN_LIGHT_FN = /* glsl */`
vec3 townLights(vec3 p, vec3 N){
  if (uTownLightI < 0.01) return vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 L = uTownLight[i] - p;
    float d2 = dot(L, L);
    float flick = 0.86 + 0.14 * sin(uTime * (5.0 + float(i) * 1.7) + float(i) * 2.1);
    /* Tighter falloff than v2's: a fire lights its own yard, not the quarter.
       The wide version washed whole meadows in orange and left the walls of
       the building that owned the fire just as dark as before. */
    float att = uTownLightI * flick / (1.0 + d2 * 0.019 + d2 * d2 * 0.00042);
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
    sum += 1.0 / (1.0 + d2 * 0.026 + d2 * d2 * 0.00055);
  }
  return uTownLightColor * sum * uTownLightI * 0.060;
}
`;

/* Shadow lookup. The map is a hardware PCF sampler (COMPARE_REF_TO_TEXTURE),
   so one fetch already filters 2x2 texels. v2 did four fetches; two diagonal
   ones give eight comparisons for half the cost and a softer edge. Outside
   the map the fragment is lit and the border is faded, which kills the hard
   dark band a shadow frustum edge used to paint across the shoreline. */
const SHADOW_FN = /* glsl */`
float shadowFactor(vec3 worldPos, float ndl){
  if (uShadowStrength <= 0.001) return 1.0;
  vec4 sp = uShadowMatrix * vec4(worldPos, 1.0);
  vec3 proj = sp.xyz / sp.w;
  proj = proj * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.045), proj.xy)
            * smoothstep(vec2(0.0), vec2(0.045), 1.0 - proj.xy);
  float inside = edge.x * edge.y;
  if (inside < 0.002) return 1.0;
  float bias = mix(0.0024, 0.0009, ndl);
  /* ONE hardware-compare tap. The sampler is COMPARE_REF_TO_TEXTURE with
     LINEAR filtering, so a single fetch already resolves 2x2 texels and
     blends the result -- four hardware comparisons for the price of one
     fetch. v2 issued four taps and got sixteen comparisons it did not need. */
  float s = texture(uShadowMap, vec3(proj.xy, proj.z - bias));
  return mix(1.0, mix(1.0, s, inside), uShadowStrength);
}
float cloudShadow(vec2 worldXZ){
  /* A drifting bank, broad and shallow. Two things used to go wrong here and
     both read as "somebody painted a wedge on the meadow":

       - clamp(c * 1.2, 0, 1) saturates over every thick bank, so the shading
         became a flat plate with a hard edge instead of a gradient;
       - the whole term was 10 % of direct sun, and at dawn and dusk -- when
         the sun barely touches the ground -- that 10 % was most of the light
         the meadow had.

     A smoothstep over the coverage gives a real falloff, and the strength is
     an explicit uniform so the quality ladder (and the settings toggle) can
     turn it down without a shader rebuild. */
  if (uCloudStrength < 0.001) return 1.0;
  vec2 uv = worldXZ * 0.0017 + uCloudOffset;
  float c = textureLod(uClouds, uv, 3.5).a;
  float k = smoothstep(0.28, 1.0, c);
  return 1.0 - k * uCloudStrength;
}
float fogOfWar(vec3 worldPos){
  if (uFogEnabled < 0.5) return 1.0;
  vec2 uv = worldPos.xz / (uWorldHalf * 2.0) + 0.5;
  // the mask is 128x128 for the whole 512 m map; LOD 1 keeps the rim soft and
  // skips trilinear filtering on every fogged pixel of every material
  return textureLod(uFogTex, uv, 2.0).r;
}
vec3 applyFog(vec3 color, float dist){
  float f = 1.0 - exp(-dist * uFogDensity);
  return mix(color, uFogColor, clamp(f, 0.0, 0.94));
}
/* The organic sight rim that v2 built out of two noise octaves per fragment
   is now baked into the fog mask on the CPU (setFog adds the same dither once
   per fog update). Same edge, no per-pixel noise anywhere in the pipeline. */
vec3 applyFoW(vec3 color, vec3 worldPos){
  if (uFogEnabled < 0.5) return color;
  float vis = fogOfWar(worldPos);
  float l = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 memory = mix(vec3(l), color, 0.56) * vec3(0.82, 0.86, 0.95);
  vec3 shown = mix(color, memory, clamp((1.0 - vis) * 1.25, 0.0, 0.48));
  /* Unexplored country reads as distance haze, not as a hole in the world.
     v2 painted it almost black, which from an RTS camera looks like the map
     ends in a void -- and it took a fifth of the screen on a wide shot. */
  /* Unknown country is a cool, desaturated veil at ~45 % brightness: you can
     still read the shape of the hills and the line of the coast, so it looks
     like distance haze rather than a hole in the world -- but it is clearly
     not somewhere you have been. (v2 painted it near-black, which from a 46 m
     camera reads as the map simply ending.) The transition is deliberately
     wide, because a hard rim around the surveyed disc is what made the town
     look like it was sitting under a spotlight. */
  float l2 = dot(shown, vec3(0.299, 0.587, 0.114));
  vec3 haze = mix(vec3(l2), shown, 0.34) * mix(vec3(0.46, 0.50, 0.58), vec3(0.34, 0.38, 0.47), uNight);
  haze = mix(haze, uFogColor * (0.30 - uNight * 0.10), 0.30);
  float dark = smoothstep(0.0, 0.82, vis);
  return mix(haze, shown, dark);
}
`;

/* ============================================================
   SKY
   ============================================================ */
const SKY_GLSL = /* glsl */`
vec3 skyRadiance(vec3 dir, vec3 sunDir, vec3 zenith, vec3 horizon, vec3 sunColor){
  float h = clamp(dir.y, -1.0, 1.0);
  float inv = 1.0 - clamp(h, 0.0, 1.0);
  // ^2.6, close enough to ^2.5 and two multiplies cheaper than pow()
  float t = inv * inv * sqrt(inv);
  vec3 col = mix(zenith, horizon, t);
  // ground haze below the horizon
  col = mix(col, horizon * 0.62, smoothstep(0.0, -0.35, h));
  float mu = max(dot(dir, sunDir), 0.0);
  // forward scattering halo
  col += sunColor * p8(mu) * 0.55;
  col += sunColor * mu * mu * 0.10;
  return col;
}
`;

export const SKY_VS = /* glsl */`#version 300 es
${COMMON}
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  // depth 1.0 exactly: the sky is drawn *after* the opaque scene with
  // glDepthFunc(EQUAL), so it only ever shades pixels nothing else covered.
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}
`;

export const SKY_FS = /* glsl */`#version 300 es
${COMMON}
${SKY_GLSL}
${LIGHT_UNIFORMS}
${NOISE_UNIFORM}
in vec2 vUV;
out vec4 fragColor;
uniform mat4 uInvViewProj;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform float uCloudCover;
uniform float uStarAmount;
uniform vec3 uMoonDir;
uniform float uMoonAmount;
uniform sampler2D uStars;

/* The three point-star layers and the Milky Way used to be evaluated per
   pixel (six sin-hashes, two fbm octaves). They are static, so v3 bakes the
   dome once into a 1024x512 map and reads one texel per fragment. */
vec3 stars(vec3 dir){
  if (uStarAmount < 0.01) return vec3(0.0);
  float u = atan(dir.z, dir.x) * 0.15915494 + 0.5;
  float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
  // explicit LOD 0: the equirect seam has no usable screen-space derivative
  // and an automatic mip choice would draw a bright line down the sky
  return textureLod(uStars, vec2(u, v), 0.0).rgb * uStarAmount;
}

/* The moon is a real disc, not a bright pixel: limb darkening, maria, and a
   soft halo so it reads at a glance without a bloom pass. */
vec3 moon(vec3 dir){
  if (uMoonAmount < 0.01) return vec3(0.0);
  vec3 up = abs(uMoonDir.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 mx = normalize(cross(up, uMoonDir));
  vec3 my = cross(uMoonDir, mx);
  vec2 q = vec2(dot(dir, mx), dot(dir, my));
  float r = length(q);
  const float R = 0.032;
  float hx = max(0.0, 1.0 - r / (R * 9.0));
  float halo = hx * hx * hx * 0.30;
  vec3 col = vec3(0.52, 0.64, 0.92) * halo * uMoonAmount;
  float disc = smoothstep(R, R * 0.93, r);
  if (disc <= 0.001) return col;
  vec2 uv = q / R;
  float limb = sqrt(max(0.0, 1.0 - dot(uv, uv)));
  float maria = texture(uNoise, uv * 0.09 + 0.31).g * 0.55
              + texture(uNoise, uv * 0.23 + 0.67).b * 0.45;
  float craters = smoothstep(0.66, 0.94, texture(uNoise, uv * 0.44 + 0.12).a) * 0.10;
  float albedo = 0.52 + 0.48 * limb - 0.34 * smoothstep(0.38, 0.76, maria) - craters;
  // a low moon is reddened by the same air the setting sun goes through
  float low = smoothstep(0.17, 0.02, uMoonDir.y);
  vec3 tint = mix(vec3(1.0, 0.975, 0.905), vec3(1.0, 0.62, 0.34), low);
  vec3 base = tint * albedo * 1.35;
  return col + base * disc * uMoonAmount;
}

void main(){
  vec4 clip = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  vec3 dir = normalize(world.xyz / world.w - uCameraPos);

  vec3 col = skyRadiance(dir, uSunDir, uZenithColor, uHorizonColor, uSunColor);
  // low haze: the air near the horizon scatters warm town light and moonlight.
  float hzx = max(0.0, 1.0 - dir.y * 4.2);
  float hz = p4(hzx) * hzx * smoothstep(-0.06, 0.015, dir.y);
  col += vec3(0.055, 0.052, 0.075) * hz * uMoonAmount;
  col += moon(dir);
  col += stars(dir) * smoothstep(0.0, 0.2, dir.y);

  // sun disc + glow (the moon replaces it after dark)
  float mu = dot(dir, uSunDir);
  float sunUp = smoothstep(0.0, 0.15, uSunDir.y) * (1.0 - uMoonAmount);
  col += uSunColor * smoothstep(0.9993, 0.9998, mu) * 26.0 * sunUp;
  float mg = max(mu, 0.0);
  col += uSunColor * p256(mg) * p64(mg) * 1.6 * sunUp;   // ~mu^220

  // clouds: two scrolling layers projected on a dome, shape from a baked tile
  if (dir.y > 0.015) {
    vec2 cuv = dir.xz / (dir.y + 0.35);
    /* Explicit LOD: trilinear sampling costs eight texel reads on mobile
       GPUs and eight more on the software rasteriser. Cloud shapes live in
       the low mips, so ask for those directly -- it is also the correct
       anti-aliasing choice for a projected dome. */
    float c1 = textureLod(uClouds, cuv * 0.10 + uCloudOffset * 3.0, 1.0).r;
    float c2 = textureLod(uClouds, cuv * 0.27 + uCloudOffset * 5.2 + 0.37, 1.5).g;
    float c3 = textureLod(uClouds, cuv * 0.61 - uCloudOffset * 7.0 + 0.71, 2.0).b;
    float cover = mix(c1, c2, 0.45) * 0.82 + c3 * 0.18;
    float mask = smoothstep(0.55 - uCloudCover * 0.28, 0.86, cover);
    float horizonFade = smoothstep(0.02, 0.24, dir.y);
    float sunGlow = p4(mg) * mg * mg;   // mu^6
    vec3 cloudLit = mix(uSkyColor * 0.55 + uSunColor * 0.35, vec3(1.0, 0.96, 0.9) * (0.6 + uSunColor * 0.35), 0.55);
    cloudLit += uSunColor * sunGlow * 0.9;
    // lit rim: the part of a cloud facing the sun is brighter than its core
    cloudLit += uSunColor * smoothstep(0.55, 0.95, c2) * 0.10;
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
uniform sampler2D uAlbedo;      // baked radiance map, rgb = albedo, a = sky occlusion
uniform sampler2D uDetail;      // seamless 4 m ground detail (greyscale + specks)
uniform float uDetailStrength;

void main(){
  /* One fetch carries the entire painted ground: the 6-way splat, the field
     patchwork, the tussocks, the dry pockets, the altitude tint and the baked
     ambient occlusion. See bake.js for the bake itself. The texture is sRGB,
     so the hardware decodes it to linear for free -- no pow() per pixel. */
  vec4 alb = texture(uAlbedo, vWorld.xz / 512.0 + 0.5);
  vec3 albedo = alb.rgb;

  /* Ground detail: one mip-mapped 4 m tile, sampled twice at two scales.
     The v3 fade ran from 26 to 86 m, and at an RTS camera height of 46 m most
     of the meadow is further away than that -- so the one thing that gives the
     ground a surface was switched off wherever the player was actually
     looking, and the terrain read as flat watercolour. The tile is mip-mapped,
     so letting it run to 165 m costs a fetch and no aliasing. */
  float fade = (1.0 - smoothstep(45.0, 165.0, vDist)) * uDetailStrength;
  if (fade > 0.01) {
    /* 14 m per repeat, not 4. The tile is 512 texels, so at the RTS camera a
       4 m repeat maps about four texels to a pixel: the mip chain averages
       every blade of grass into neutral grey and the ground comes out
       featureless. At 14 m the tile is ~1:1 on the visible meadow, which is
       where its blades, clumps and pebbles actually land on screen. */
    vec4 d1 = texture(uDetail, vWorld.xz * 0.0714);
    float grain = (d1.r - 0.5) * 1.35 + (d1.g - 0.5) * 0.65;
    /* The second scale is only worth a fetch where the first has washed out:
       a 48 m repeat carries the clumping that survives being seen from 60 m
       away. Close up it would only double the contrast of the fine tile. */
    float far = smoothstep(30.0, 110.0, vDist);
    if (far > 0.01) {
      vec4 d2 = texture(uDetail, vWorld.xz * 0.0208 + vec2(0.37, 0.71));
      grain += ((d2.g - 0.5) * 0.95 + (d2.a - 0.5) * 0.30) * far;
    }
    albedo *= 1.0 + grain * fade;
    // a scatter of petals and bright grit that only exists up close
    float speck = smoothstep(0.60, 0.96, d1.a) * fade * fade;
    albedo = mix(albedo, min(albedo * 1.45 + 0.05, vec3(1.0)), speck * 0.55);
  }

  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = shadowFactor(vWorld, ndl);
  float cl = cloudShadow(vWorld.xz);
  float ao = alb.a;

  // Hemisphere ambient, deliberately desaturated: a saturated blue fill on
  // vertical walls reads as "grey and washed out" from an RTS camera.
  albedo *= mix(vec3(1.0), vec3(0.66, 0.76, 1.06), uNight * 0.62);
  vec3 skyFill = mix(uSkyColor * 0.86, vec3(0.30, 0.31, 0.30), 0.5);
  vec3 ambient = mix(uGroundColor * 1.15, skyFill, N.y * 0.5 + 0.5) * (0.66 + 0.46 * N.y);
  ambient *= mix(1.0, ao, 0.85);
  vec3 color = albedo * (uSunColor * ndl * sh * cl * 1.02 + ambient);
  color += mix(albedo, vec3(0.60, 0.44, 0.28), 0.34) * townLights(vWorld, N) * 1.55;
  color += townGlow(vWorld) * mix(albedo, vec3(0.5), 0.5) * 1.1;

  // wet sheen near the waterline
  float wet = smoothstep(0.55, 0.0, vWorld.y);
  color *= mix(1.0, 0.72, wet * 0.8);

  color = applyFog(color, vDist);
  color = applyFoW(color, vWorld);
  // the terrain runs a hotter exposure than the models by day; after dark that
  // same curve turns night into a green-grey soup, so it comes down at night
  fragColor = vec4(tonemap(color, mix(1.32, 1.06, uNight)), 1.0);
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
layout(location=11) in vec4 iA;   // linear team/tint, a = build progress
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
${NOISE_UNIFORM}
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
  /* The material atlas is an sRGB array texture: the fetch returns linear
     colour, so v2's per-pixel srgbToLinear() on every wall, roof and tunic is
     gone (and the filtering is now correct in linear space too). */
  vec4 tex = texture(uMaterials, vec3(vUV, float(layer)));
  vec3 albedo = tex.rgb * vColor;

  // Team colour replaces the garment hue instead of multiplying it: the
  // texture's own luminance keeps the weave and folds, so a red-dyed cloth
  // still reads as folded cloth when the team is blue. vTint arrives already
  // in linear space from the renderer.
  float teamW = 0.0;
  if (layer == M_CLOTH) teamW = 0.94;
  else if (layer == M_GOLD) teamW = 0.30;
  else if (layer == M_LEATHER) teamW = 0.12;
  if (teamW > 0.0) {
    float shade = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
    vec3 teamAlb = vTint.rgb * (0.55 + shade * 1.25);
    albedo = mix(albedo, teamAlb, teamW);
  }

  // battle damage: scorch pattern from the baked field-noise tile
  float dmg = vState.x;
  if (dmg > 0.01) {
    float scorch = texture(uNoise, vWorld.xz * 0.11 + vWorld.y * 0.07).r;
    albedo = mix(albedo, vec3(0.07, 0.06, 0.055), dmg * clamp((scorch - 0.18) * 2.1, 0.0, 0.9));
    albedo *= 1.0 - dmg * 0.28;
  }

  // moonlight strips colour: albedo cools and loses saturation after dark
  albedo *= mix(vec3(1.0), vec3(0.70, 0.79, 1.02), uNight * 0.55);

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  /* Canopy depth. A leaf mesh with one flat colour reads as a green ball; the
     baked noise tile breaks the mass into clusters of leaves and an ambient
     darkening toward the underside gives the crown volume. Two fetches and a
     handful of ALU, where v2 ran two live noise octaves and two hashes. */
  if (layer == M_LEAF) {
    vec2 lp = vWorld.xz * 0.16 + vec2(vState.w * 7.0, vWorld.y * 0.11);
    float dapple = texture(uNoise, lp).b * 0.66 + texture(uNoise, lp * 2.7).r * 0.34;
    albedo *= 0.80 + dapple * 0.40;
    albedo *= mix(0.60, 1.05, clamp(N.y * 0.62 + 0.5, 0.0, 1.0));
    albedo *= mix(vec3(1.0), vec3(1.10, 1.0, 0.78), vState.w);
    albedo *= vec3(0.95 + fract(vState.w * 7.31) * 0.14, 1.0, 0.92 + fract(vState.w * 3.17) * 0.12);
  }
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = shadowFactor(vWorld, ndl);
  float cl = cloudShadow(vWorld.xz);
  // hemisphere ambient: warm bounce from the ground, cool from the sky.
  vec3 ambient = mix(uGroundColor * 1.15, uSkyColor * 0.86, N.y * 0.5 + 0.5) * (0.62 + 0.5 * N.y);

  vec3 V = normalize(uCameraPos - vWorld);
  float specMask = (layer == M_IRON || layer == M_GOLD || layer == M_GLASS) ? 1.0
                 : (layer == M_STONE || layer == M_MARBLE || layer == M_STONE_LIGHT) ? 0.22
                 : (layer == M_LEATHER) ? 0.14 : 0.05;
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  /* A dynamic exponent needs a real pow(); picking between two constant
     exponents does not. The masks are per-material, so the branch is
     coherent within every wavefront. */
  float spec = specMask > 0.5 ? p128(nh) * 1.6 : p16(nh) * p8(nh) * specMask;

  vec3 emissive = vec3(0.0);
  if (layer == M_GLASS) {
    // window panes and brazier coals: warm, never clipped to white.
    float flicker = 0.86 + 0.14 * sin(uTime * 9.0 + vWorld.x * 2.3 + vWorld.z * 1.7);
    emissive = vec3(1.0, 0.46, 0.13) * (0.14 + uNight * 2.9) * flicker
             * (0.45 + 0.75 * texture(uNoise, vWorld.xz * 0.05).g);
  } else if (layer == M_GOLD) {
    emissive = vec3(1.0, 0.62, 0.22) * uNight * 0.22;
  }

  vec3 color = albedo * (uSunColor * ndl * sh * cl * 1.25 + ambient);
  color += mix(albedo, vec3(0.64, 0.48, 0.30), 0.42) * townLights(vWorld, N) * 2.0;
  color += townGlow(vWorld) * mix(albedo, vec3(0.5), 0.5) * 1.15;
  color += uSunColor * spec * sh * cl * 1.4;
  color += emissive;

  if (layer == M_LEAF) {
    float back = max(dot(-N, uSunDir), 0.0);
    color += uSunColor * albedo * back * 0.42;
    color += uSkyColor * albedo * 0.12;
  }

  // rim light helps units read against the terrain from the RTS camera
  float rimv = 1.0 - max(dot(N, V), 0.0);
  float rim = rimv * rimv * rimv;
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
uniform sampler2D uWater;       // rg = normal xy, b = height, a = foam
uniform sampler2D uHeightMap;
uniform vec2 uNormalOffset;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;

void main(){
  /* Two scrolling fetches of one baked tile replace v2's two normal-map
     fetches plus four noise octaves of foam. The tile carries the normal,
     the swell height and the foam in its four channels. */
  vec4 w1 = texture(uWater, vWorld.xz * 0.045 + uNormalOffset);
  vec4 w2 = texture(uWater, vWorld.xz * 0.021 - uNormalOffset * 0.6);
  vec2 n1 = w1.rg * 2.0 - 1.0;
  vec2 n2 = w2.rg * 2.0 - 1.0;
  vec3 nrm = normalize(vec3(n1.x + n2.x * 0.8, 2.2, n1.y + n2.y * 0.8));

  // terrain depth beneath the surface
  vec2 huv = vWorld.xz / (uWorldHalf * 2.0) + 0.5;
  float bed = texture(uHeightMap, huv).r * 46.0 - 8.0;
  float depth = max(vWorld.y - bed, 0.0);
  float shallow = smoothstep(3.4, 0.05, depth);

  vec3 V = normalize(uCameraPos - vWorld);
  vec3 L = uSunDir;
  float fv = 1.0 - max(dot(nrm, V), 0.0);
  float fres = p4(fv);
  vec3 R = reflect(-V, nrm);
  vec3 sky = skyRadiance(R, L, uZenithColor, uHorizonColor, uSunColor);

  float rl = max(dot(R, L), 0.0);
  float spec = pow340(rl) * 3.4 + p16(rl) * p8(rl) * 0.32;
  vec3 body = mix(uDeepColor, uShallowColor, shallow);
  // a third, finer ripple layer: what sells "water" from 40 m up is that the
  // horizon line never stays exactly straight
  vec4 w3 = texture(uWater, vWorld.xz * 0.115 + uNormalOffset * 2.1);
  float sh = shadowFactor(vWorld, 1.0);
  float glint = p16(max(dot(normalize(vec3((w3.r - 0.5) * 0.55 + nrm.x, 2.2, (w3.g - 0.5) * 0.55 + nrm.z)), L), 0.0));
  vec3 col = mix(body, sky * 1.02, clamp(0.23 + fres * 1.02, 0.0, 1.0));
  col += uShallowColor * shallow * 0.10;                 // light through the shallows
  col += uSunColor * (spec + glint * 0.85) * sh;

  // shoreline foam: the tile's foam channel, broken up by the second layer
  float foamTile = w1.a * 0.65 + w2.a * 0.35 + w1.b * 0.20;
  float foam = smoothstep(0.55, 0.02, depth + foamTile * 0.55 - 0.28);
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
uniform float uDecalFade;
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
    // build footprint: a square tile with a bright rim and a faint inner grid.
    // A circle here made a wall run read as a row of green dots.
    vec2 q = abs(d);
    float m = max(q.x, q.y);
    float inside = smoothstep(1.0, 0.9, m);
    float rim = smoothstep(0.70, 0.94, m);
    vec2 g = abs(fract(d * 3.0) - 0.5);
    float grid = smoothstep(0.44, 0.48, max(g.x, g.y));
    a = (0.26 + rim * 0.6 + grid * 0.18) * inside * vCol.a;
  } else {
    // rally marker (chevrons)
    float band = sin(d.y * 6.0 + 1.2) * 0.5 + 0.5;
    a = smoothstep(1.0, 0.3, r) * (0.35 + band * 0.65) * vCol.a;
  }
  if (a < 0.01) discard;
  col *= 1.0 + vExtra.z * 0.6;
  // decals sit a few centimetres above the ground and fade out when the
  // camera is very close, so a selection ring never covers the unit it marks
  fragColor = vec4(col, a * uDecalFade);
}
`;

/* ============================================================
   FINAL PASS (grade + optional sharpening)
   ============================================================ */
export const POST_VS = /* glsl */`#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/* A full-screen additive wash, drawn straight to the framebuffer. It exists
   outside the post chain on purpose: post is off on the balanced and low
   tiers, and a lightning bolt that only flashes on high-end phones is a bug,
   not a feature. */
export const FLASH_FS = /* glsl */`#version 300 es
precision highp float;
out vec4 fragColor;
uniform float uFlash;
uniform vec3 uFlashTint;
void main(){
  float a = clamp(uFlash, 0.0, 0.9);
  vec3 c = clamp(uFlashTint, 0.0, 1.0);
  fragColor = vec4(c * a, a);
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
uniform float uSharpen;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  /* Cheap unsharp mask. v2 always spent four extra full-screen fetches here;
     on the balanced and low tiers the weight is zero and the whole block is
     skipped by a uniform branch, which is a uniform-cost zero on every
     mobile driver. */
  if (uSharpen > 0.001) {
    vec3 blur = (
        texture(uScene, vUV + vec2( uTexel.x, uTexel.y)).rgb +
        texture(uScene, vUV + vec2(-uTexel.x, -uTexel.y)).rgb) * 0.5;
    c = clamp(c + (c - blur) * uSharpen, 0.0, 1.0);
  }
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
