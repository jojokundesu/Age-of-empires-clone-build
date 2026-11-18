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
#define MAT_TRIM     8   /* undyed cloth: hems, borders, sashes, trim */

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

/* TRIPLANAR UV.
   Every material pattern below used to be sampled at vWorld.xz -- a single
   horizontal plane. That is correct for a flat roof and wrong for
   everything else: on a vertical surface the pattern is extruded straight
   up, so mail rings became vertical streaks and plate brushing became wood
   grain. It is the reason a mail hauberk read as bark.

   Projecting the pattern on whichever world axis the surface actually
   faces, and blending between them by the normal, is the standard fix and
   costs two more pattern evaluations blended by weight rather than any
   extra geometry. */
vec3 triWeights(vec3 n) {
  vec3 a = abs(n);
  a = a * a * a;               // sharpen so one axis dominates
  return a / (a.x + a.y + a.z + 1e-5);
}

vec2 triUV(vec3 w, vec3 n) {
  vec3 a = triWeights(n);
  vec2 xy = w.xy, zy = w.zy, xz = w.xz;
  return xy * a.z + zy * a.x + xz * a.y;
}

void main() {
  int mat = vMat;
  vec3 albedo = vColor;
  float metalness = 0.0;
  float roughness = 0.85;
  float ao = 1.0;
  /* Specular is tinted by the surface by default; the plate branch lowers
     the gain and lets the metal tint its own reflection. */
  vec3 specTint = vec3(1.0);
  float specGain = 1.0;
  /* wp is the pattern plane. It must follow the surface, not the ground. */
  vec3 nrm = normalize(vNormal);
  vec2 wp = triUV(vWorld, nrm);
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
    /* Anti-aliasing, analytically. A 74-ring-per-metre pattern is about
       seven rings across a soldier at Armory distance and finer than a
       pixel further out, and a procedural pattern sampled finer than a pixel
       does not blur -- it turns into static, which is exactly how every
       mailed class looked on the pedestal: a figure cut out of television
       noise. Fade the ring contrast out as the pattern's screen footprint
       approaches a pixel, and the mail reads as smooth dark metal instead of
       as interference. */
    /* Blend the PATTERN, not the UV. Interpolating two pattern planes
       before sampling them is fine for a smooth field (weave, quilt) and
       wrong for a discrete one: two projections of the ring lattice are at
       different phases, so their average is neither, and the band where the
       triplanar weights cross -- a vertical line down the front quarter of
       every torso and hauberk -- renders as a washed-out stripe. Sample all
       three planes and blend the results by the same weights. */
    vec3 tw = triWeights(nrm);
    float ring = mailRing(vWorld.xy, 74.0) * tw.z
               + mailRing(vWorld.zy, 74.0) * tw.x
               + mailRing(vWorld.xz, 74.0) * tw.y;
    /* Distance, not fwidth. fwidth is the obvious way to find a pattern's
       screen footprint and it is wrong here: every lathe and every tube
       wraps its UV from 1 back to 0 on the seam quad, so the derivative
       across that one quad is enormous, the fade collapses to 0 there, and the
       seam renders as a pale stripe running the whole length of the
       hauberk -- which is the sash down every mailed soldier's spine and
       down the back of both legs. The camera distance does not know about
       UV seams. */
    float aa = 1.0 - smoothstep(9.0, 22.0, vDist);
    /* Fade to the pattern's own MEAN, not to the trough: mix(0.42, 1.16, 0.5)
       is 0.79, which is mid-grey steel. An earlier version also multiplied a
       brightness term by (1 - aa), and because fwidth is discontinuous
       where triUV switches axes, that put a bright band down the middle of
       every mailed torso -- the pale ribbon that looked like a sash. */
    /* Ring contrast is gentle: 0.42..1.16 over a 74-ring lattice at these
       sizes was a 3:1 stripe, and on an arm or a thigh -- where the lattice
       runs with the limb -- it read as a pale bandage rather than as rings.
       Mail at gameplay distance is a dark grey surface with a sheen; the
       pattern is what you see when you stop to look. */
    /* Ceiling, not just contrast. Mail authored at 0.62 and modulated up to
       1.10 luminance peaks at 0.68; with the sun at 1.25 plus ambient that
       saturates, and any limb whose whole tube faces the key light comes
       out white -- an arm and a shin in bright mail read as pale bandages
       against the dark torso behind them. Cap the modulation below 1.0 and
       the same limb reads as lit steel with a ring texture on it. */
    albedo *= mix(0.30, 0.62, mix(0.45, ring, aa));
    /* Mail is a very rough metal. At 0.78 metalness with a 0.28 roughness
       floor the arm and the thigh -- smooth tubes facing the light -- took a
       broad specular that ran their whole length, and the figure read as
       wearing pale bandages over its limbs. Roughness floor 0.44 keeps the
       sheen to the ring highlights. */
    /* A RANGE, not a value. Mail is a rough metal everywhere; the ring
       pattern only decides how much the highlights vary. Varying the
       roughness itself from 0.44 to 0.62 gave a hard specular crest along
       each limb that tracked the lattice, and on the upper arm -- the one
       smooth convex tube facing the key light -- that crest was the pale
       bandage. Hold roughness near 0.6 and let the pattern move the albedo
       alone. */
    metalness = 0.58;
    roughness = mix(0.60, mix(0.66, 0.52, ring), aa);
  } else if (mat == MAT_PLATE) {
    float brush = sin(y * 41.0 + hash12(floor(wp * 90.0)) * 3.0) * 0.5 + 0.5;
    vec2 b = abs(fract(wp * 2.2) - 0.5);
    float border = smoothstep(0.44, 0.50, max(b.x, b.y));
    vec2 rc = fract(wp * 6.6) - 0.5;
    float rivet = smoothstep(0.16, 0.07, length(rc));
    float p = mix(brush, 0.18, border);
    /* age tier lives in the packed word: bits 12+ are the age (1..4) */
    float ageTier = floor(fract(vPack.y / 4096.0) * 16.0);
    /* THE AUTHORED COLOUR IS THE STEEL.
       This block used to build the albedo out of a hard-coded
       vec3(0.62, 0.64, 0.68) and throw away whatever the wardrobe had
       written -- so every helmet, every pauldron and every shield boss in the
       game was the same bright laboratory steel, which is why they read as
       white plastic against a dark figure. Real armour of the period is
       largely iron: dark, warm, and mostly not shiny. The authored colour now
       drives the metal, so a class can ask for bright polished plate or for
       blackened iron and get it.
       The value is normalised to the metal's own luminance and the enamel is
       rebuilt from HUE with a fixed, believable saturation ceiling -- a
       brown-grey iron must not come out as brown paint. */
    float steelL = dot(albedo, vec3(0.299, 0.587, 0.114));
    /* A little warmth is added to the hue and the saturation is clamped, so
       an authored colour that is nearly neutral still reads as metal rather
       than as flat clay, while a deliberately dark one stays dark. */
    vec3 tint = mix(vec3(steelL), albedo, 0.55);
    vec3 steel = tint * (0.70 + p * 0.55);
    albedo = mix(steel, vec3(0.92, 0.72, 0.30), rivet * 0.85);
    /* Imperial gold trim: gilded panel borders from Age III up. */
    float gild = smoothstep(2.5, 3.5, ageTier) * border;
    albedo = mix(albedo, vec3(0.95, 0.76, 0.34) * (0.8 + brush * 0.5), gild * 0.8);
    /* FINISH FOLLOWS THE AUTHORED VALUE: bright plate is polished, dark
       iron is dull and rough. That single coupling is what makes a helmet
       look forged rather than moulded, and it costs nothing -- the numbers
       are already in the vertex.
       NOTE: the rig shots pass a white team tint, and this material is not
       team-dyed, so the authored colour is what a viewer sees. */
    float plish = smoothstep(0.30, 0.80, steelL);
    metalness = mix(0.45, 0.92, plish);
    roughness = mix(0.62, 0.22, plish) - rivet * 0.10;
    /* THE SPECULAR WAS THE WHITE, NOT THE ALBEDO.
       With the authored colour respected, a bright-polished helm (0.66)
       still rendered as a white blob -- because the specular term is
       uSunColor * spec * sh * cl * 1.3, ADDED to a metal already at 0.66,
       at 1.5x metalness weight and with a roughness that a smooth dome walks
       straight through. Every convex surface facing the key light clips to
       white, and a helmet is the most convex thing on the figure.
       Metal does not add a broad white highlight on top of its own colour;
       its reflection is TINTED by the metal. So the specular is now
       multiplied by the albedo and its weight is cut, which is both more
       physical and the actual fix. */
    specTint = albedo / max(steelL, 0.12);
    specGain = mix(0.30, 0.62, plish);
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
  } else if (mat == MAT_TRIM) {
    /* UNDYED CLOTH -- the cream that frames every AoE4 team colour.
       Its whole point is that the team tint does NOT reach it, so a blue
       soldier has royal blue panels and cream borders rather than a uniform
       blue blob. Slightly coarse linen weave, a warm off-white, and a shallow
       value gradient so a border on a curved surface still turns over. */
    float w = weave(wp + y * 0.7, 34.0, 0.4);
    albedo *= 0.90 + w * 0.20;
    roughness = 0.90;
  } else if (mat == MAT_WOOD) {
    float grain = sin(y * 52.0 + hash12(floor(wp * 30.0)) * 2.0) * 0.5 + 0.5;
    albedo *= 0.78 + grain * 0.36;
    roughness = 0.80;
  } else if (mat == 9) {
    /* DYED WOOL. The same weave as the dyed cloth above, but the colour is
       the one the wardrobe authored rather than the team's. This is what
       keeps an army from being one blue mass: the uniform is LINEN and takes
       the player's colour, while hose, habits and mercenary coats are WOOL
       and stay rust, oatmeal or grey. */
    float w2 = weave(wp + y * 0.7, 46.0, 0.5);
    float n2 = hash12(floor(wp * 190.0));
    albedo *= 0.84 + w2 * 0.20 + n2 * 0.05;
    roughness = 0.86;
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
  /* specTint and specGain are set by the plate branch; everything else gets
     the old untinted highlight at its old weight. */
  color += uSunColor * spec * sh * cl * 1.3 * specGain * specTint;

  /* Team colour on cloth: take the HUE from the team, the VALUE from the
     garment, and the weave's luminance variation from the cloth itself, so a
     dyed tunic still reads as folded linen rather than as poured plastic. */
  if (mat == MAT_LINEN || mat == MAT_GAMBESON) {
    float shade = dot(albedo, vec3(0.299, 0.587, 0.114));
    /* Normalise the team colour by its LARGEST channel, not by luminance.
       Dividing by luminance turns the blue [0.32, 0.55, 0.98] into
       [0.60, 1.04, 1.85]: out of gamut, and its blue channel saturates on
       its own, so the surcoat rendered as a fluorescent pastel whatever
       multiplier followed. Dividing by the max keeps the hue exactly and
       pins the brightest channel at 1.0, which makes the shade a real value
       control. White stays white, so a neutral tint gives back undyed
       cloth. */
    vec3 tintMax = vTint.rgb / max(max(vTint.r, vTint.g), max(vTint.b, 1e-3));
    /* The dye is darker than the cloth it soaks into: a woad or madder bath
       costs most of the value. Scale that cost by SATURATION, so a neutral
       tint leaves the garment exactly as authored -- the offline rig
       renderer passes white, and a flat 0.62 there turned every tunic and
       surcoat a muddy grey, which is how this was found. */
    float sat = 1.0 - min(min(vTint.r, vTint.g), vTint.b) /
                      max(max(vTint.r, vTint.g), max(vTint.b, 1e-3));
    /* A dye bath absorbs most of the light that hits it, and the richer the
       colour the more it absorbs. 0.85 at full saturation brings the player
       blue down to a real woad -- a deep slate blue with the hue intact --
       while leaving a neutral tint at exactly 1.0, so the offline rig
       renderer (which passes white) still shows the cloth as authored. */
    /* Deepen the hue as well as the value: a saturated dye is not just a
       darker version of the same pastel, it is a purer colour. Raising the
       normalised hue to a power above 1 pulls the weak channels down and
       leaves the dominant one where it is, which is the difference between
       "pale sky blue" and "woad". Neutral tints have all three channels
       equal, so a power leaves them untouched. */
    /* A DYE, not a repaint. The dye soaks a saturation in proportion to how
       saturated the team colour is, so a neutral tint leaves every garment
       exactly as authored. This is the bug that made every offline render a
       grey mannequin: the old line dropped the authored colour entirely and
       rebuilt the garment out of its own luminance, so white tint in meant
       flat grey out, and the authored cream trim and tan leather on every
       tunic never appeared in a single screenshot. */
    /* 1.7, not 0.45. The dye bath should recolour the cloth, not extinguish
       it: at 0.55 a deep navy crushed every garment -- the tunic, both
       sleeves and the skirt -- to within a few per cent of one another and
       to near-black, so a soldier was one flat silhouette. Keeping more of
       the authored value means two different cloth values stay two
       different values after dyeing, which is what gives a uniform its
       panels. */
    vec3 dye = pow(tintMax, vec3(1.8)) * shade * 1.25;
    vec3 teamAlb = mix(albedo, dye, sat);
    color = mix(color, teamAlb * (uSunColor * ndl * sh * cl * 1.25 + ambient), 0.82);
  }

  float dmg = vState.x;
  if (dmg > 0.01) color *= 1.0 - dmg * 0.3;

  color = applyFog(color, vDist);
  color = applyFoW(color, vWorld);
  fragColor = vec4(tonemap(color, 1.02), vState.y);
}
`;
