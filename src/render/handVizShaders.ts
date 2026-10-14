import * as THREE from 'three';

/** Shared GLSL for the god hand: fresnel-rim translucent body with flowing energy. */

const NOISE = /* glsl */ `
float gh_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gh_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gh_hash(i + vec3(0,0,0)), gh_hash(i + vec3(1,0,0)), f.x),
                 mix(gh_hash(i + vec3(0,1,0)), gh_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gh_hash(i + vec3(0,0,1)), gh_hash(i + vec3(1,0,1)), f.x),
                 mix(gh_hash(i + vec3(0,1,1)), gh_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

const VERT = /* glsl */ `
attribute vec4 aInfo;
varying vec3 vW;
varying vec3 vN;
varying vec4 vInfo;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vInfo = aInfo;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform vec3 uBody;    // linear, kept dim (below bloom threshold)
uniform vec3 uRim;     // linear, allowed to bloom
uniform vec3 uHot;     // charge / armed colour
uniform vec3 uLight;   // direction towards the sun
uniform float uTime;
uniform float uVis;       // overall visibility (alpha)
uniform float uDissolve;  // 0..1 materialisation threshold
uniform float uGhost;     // >0: additive afterimage pass
uniform float uPinch;     // 0..1 thumb/index tip glow
uniform float uHeat;      // 0..1 charge level
uniform float uArmed;     // 0..1 armed pulse
uniform float uFlicker;   // random per-frame jitter while charging
uniform float uTip;       // idle fingertip glow
varying vec3 vW;
varying vec3 vN;
varying vec4 vInfo;
${NOISE}
void main() {
  float tip = vInfo.x, fid = vInfo.y, flow = vInfo.z, fade = vInfo.w;
  // dissolve in / out (same test in the depth pre-pass so depth matches)
  float dn = gh_noise(vW * 2.4 + vec3(0.0, uTime * 0.7, 0.0));
  float thr = uDissolve * 1.12;
  if (dn > thr) discard;
#ifdef PREPASS
  gl_FragColor = vec4(0.0);
#else
  float edge = smoothstep(thr - 0.1, thr, dn) * step(uDissolve, 0.995);

  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.6);
  float lam = clamp(dot(N, uLight) * 0.5 + 0.5, 0.0, 1.0);

  float heat = uHeat;
  // soft wispy body
  float n2 = gh_noise(vW * 1.3 + vec3(uTime * 0.21, -uTime * 0.37, uTime * 0.17));
  vec3 col = uBody * (0.35 + 0.85 * lam) * (0.75 + 0.5 * n2);
  // energy pulses streaming wrist -> fingertips
  float band = pow(0.5 + 0.5 * sin((flow * 3.2 - uTime * (0.55 + heat * 1.6)) * 6.2831), 10.0);
  float scan = smoothstep(0.82, 1.0, 0.5 + 0.5 * sin(vW.z * 30.0 + vW.x * 4.0 - uTime * 3.5));
  col += uBody * (band * (0.55 + heat) + scan * 0.22);
  // rim light
  col += uRim * fres * (0.95 + heat * 0.9 + uArmed * 0.8);
  // fingertips (thumb + index light up when pinching)
  float sel = 1.0 - step(1.5, fid);
  float tipG = pow(tip, 2.2) * (uTip + uPinch * sel * 1.5 + heat * 0.5 + uArmed * 0.5);
  col += uRim * tipG;
  // charge: hand heats up, crackling veins appear and densify
  float r = 1.0 - abs(gh_noise(vW * 3.4 + vec3(uTime * 1.7, uTime * 5.0, -uTime * 2.3)) * 2.0 - 1.0);
  float veins = pow(r, mix(22.0, 5.0, heat)) * smoothstep(0.0, 0.25, heat) * (0.75 + 0.5 * uFlicker);
  col = mix(col, col * 0.6 + uHot * 0.32, heat * 0.55);
  col += uHot * veins * (1.1 + uArmed * 1.4);
  col += uHot * edge * 1.6;

  // quill hatching: sepia strokes wrapping the shaded side of the hand
  float hs = (vW.x * 0.8 + vW.z * 0.6 + vW.y * 0.9) * 7.0 + gh_noise(vW * 3.0) * 0.8;
  float hl = 1.0 - smoothstep(0.12, 0.26, abs(fract(hs) - 0.5));
  float hs2 = (vW.x * -0.7 + vW.z * 0.7 + vW.y * 0.4) * 7.0 + gh_noise(vW * 3.0 + 5.0) * 0.8;
  float hl2 = 1.0 - smoothstep(0.12, 0.24, abs(fract(hs2) - 0.5));
  float shadeK = 1.0 - lam;
  float quill = hl * smoothstep(0.25, 0.6, shadeK) + hl2 * smoothstep(0.5, 0.8, shadeK);
  float a = (0.2 + 0.45 * fres + tipG * 0.25 + veins * 0.25 + heat * 0.1 + quill * 0.4) * fade;
  col *= 1.0 - quill * 0.6;
  a = clamp(a, 0.0, 0.92);
  col *= fade;
  if (uGhost > 0.0) {
    // afterimage: additive rim-only silhouette
    col = (uRim * (0.25 + fres * 0.9) + uBody * 0.4) * uGhost * fade;
    a = 0.0;
  }
  gl_FragColor = vec4(col * uVis, a * uVis);
#endif
}`;

export interface HandUniforms {
  [k: string]: THREE.IUniform;
  uBody: THREE.IUniform<THREE.Color>; uRim: THREE.IUniform<THREE.Color>; uHot: THREE.IUniform<THREE.Color>;
  uLight: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>; uVis: THREE.IUniform<number>; uDissolve: THREE.IUniform<number>;
  uGhost: THREE.IUniform<number>; uPinch: THREE.IUniform<number>; uHeat: THREE.IUniform<number>;
  uArmed: THREE.IUniform<number>; uFlicker: THREE.IUniform<number>; uTip: THREE.IUniform<number>;
}

export function handUniforms(): HandUniforms {
  return {
    uBody: { value: new THREE.Color() }, uRim: { value: new THREE.Color() }, uHot: { value: new THREE.Color() },
    uLight: { value: new THREE.Vector3(-18, 32, 12).normalize() },
    uTime: { value: 0 }, uVis: { value: 0 }, uDissolve: { value: 0 }, uGhost: { value: 0 },
    uPinch: { value: 0 }, uHeat: { value: 0 }, uArmed: { value: 0 }, uFlicker: { value: 0 }, uTip: { value: 0.35 },
  };
}

/** Premultiplied-alpha blending: rgb = emitted light, a = how much of the ground it veils. */
function premult(m: THREE.ShaderMaterial) {
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return m;
}

export function handMaterial(u: HandUniforms): THREE.ShaderMaterial {
  return premult(new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, fog: false,
  }));
}

/** Depth-only pre-pass so only the front-most hand surface gets shaded (no stacked overlaps). */
export function handPrepassMaterial(u: HandUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VERT, fragmentShader: FRAG, defines: { PREPASS: 1 },
    transparent: true, colorWrite: false, depthWrite: true, fog: false,
  });
}

export function ghostMaterial(u: HandUniforms): THREE.ShaderMaterial {
  return premult(new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, fog: false,
  }));
}

/**
 * Solid shadow caster that fades with a screen-door dither (PCF blurs it into a
 * smoothly fading shadow) — the hand itself is translucent, the shadow is not.
 */
export function shadowDepthMaterial(vis: THREE.IUniform<number>): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uShadowVis = vis;
    sh.fragmentShader = 'uniform float uShadowVis;\n' + sh.fragmentShader.replace(
      'void main() {',
      `void main() {
  if (fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > uShadowVis) discard;`,
    );
  };
  m.customProgramCacheKey = () => 'godhand-shadow';
  return m;
}

// ---------------------------------------------------------------- ground reticle

const RETICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uDanger;
uniform float uRm;       // world half-size of the quad
uniform float uRing;     // ring radius (world)
uniform float uWidth;    // ring width (world)
uniform float uDash;     // number of dashes (0 = solid)
uniform float uRot;
uniform float uDot;      // centre dot radius
uniform float uFill;     // inner fill strength
uniform float uDangerK;  // 0..1 armed
uniform float uVis;
uniform float uTime;
varying vec2 vUv;
float band(float d, float r, float w, float aa) { return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d - r)); }
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uRm;
  float d = length(p);
  float aa = max(fwidth(d) * 1.2, 0.012);
  float ang = atan(p.y, p.x) + uRot;
  float fa = fract(ang / 6.2831853 * uDash);
  float dashes = smoothstep(0.0, 0.05, fa) * (1.0 - smoothstep(0.6, 0.65, fa));
  float ring = band(d, uRing, uWidth, aa) * mix(1.0, dashes, step(0.5, uDash));
  // four inward ticks
  float tickA = abs(fract((ang - uRot * 2.0) / 1.5707963 + 0.5) - 0.5) * 1.5707963 * d;
  float ticks = (1.0 - smoothstep(uWidth * 0.35, uWidth * 0.35 + aa, tickA))
    * step(uRing - uWidth * 2.6, d) * step(d, uRing - uWidth * 0.5);
  float dotM = 1.0 - smoothstep(uDot - aa, uDot + aa, d);
  float inside = 1.0 - smoothstep(uRing - aa, uRing, d);
  float fill = inside * uFill * (0.35 + 0.65 * smoothstep(0.0, uRing, d));
  // danger: outer hazard ring with rotating chevrons + inner pulse ring
  float haz = band(d, uRing + uWidth * 2.2, uWidth * 0.9, aa)
    * step(0.5, fract((atan(p.y, p.x) - uTime * 0.8) / 6.2831853 * 28.0));
  float pulseR = uRing * fract(uTime * 1.6);
  float pulse = band(d, pulseR, uWidth * 0.7, aa) * (1.0 - fract(uTime * 1.6));
  float dk = uDangerK;
  float glow = ring + ticks * 0.9 + dotM * 0.9 + fill + (haz * 0.9 + pulse * 0.6) * dk;
  vec3 col = mix(uColor, uDanger, dk * 0.85);
  // dark under-halo for contrast on bright terrain
  float halo = band(d, uRing, uWidth * 3.0, aa * 2.0) * 0.28 + dotM * 0.2 + inside * dk * 0.12;
  gl_FragColor = vec4(col * glow * uVis, clamp(halo, 0.0, 0.6) * uVis);
}`;

export function reticleMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() }, uDanger: { value: new THREE.Color().setRGB(1.6, 0.32, 0.12) },
      uRm: { value: 4.4 }, uRing: { value: 0.5 }, uWidth: { value: 0.07 }, uDash: { value: 4 }, uRot: { value: 0 },
      uDot: { value: 0.07 }, uFill: { value: 0 }, uDangerK: { value: 0 }, uVis: { value: 0 }, uTime: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: RETICLE_FRAG,
    transparent: true, depthWrite: false, depthTest: false, fog: false,
  });
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  return m;
}

/** Soft star-flare sprite texture for the pinch spark (built once). */
let flareTex: THREE.Texture | null = null;
export function flareTexture(): THREE.Texture {
  if (flareTex) return flareTex;
  const s = 128, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.12, 'rgba(255,255,255,0.85)');
  rg.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 2; k++) {
    g.save();
    g.translate(s / 2, s / 2);
    g.rotate((k * Math.PI) / 2);
    const lg = g.createLinearGradient(-s / 2, 0, s / 2, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(-s / 2, -1.5, s, 3);
    g.restore();
  }
  flareTex = new THREE.CanvasTexture(c);
  return flareTex;
}
