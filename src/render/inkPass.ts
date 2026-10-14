// LIVING ATLAS post-process: renders the scene (colour + depth) and redraws it as an inked,
// hatched print on parchment:
//  * wobbly "boiling" ink outlines from depth discontinuities (scale aware)
//  * tonal cross-hatching in shadowed / dark areas (screen space, hand-jittered)
//  * paper grain + burnt, foxed vignette at the edges of the sheet
//  * flash (smite) as a warm gold-white bloom of light
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const vert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const frag = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uPx;      // device px per css px (line widths)
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uFlash;
uniform float uBurn;
varying vec2 vUv;

float hsh(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), u.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), u.x), u.y); }
float lin(vec2 uv) {
  float z = texture2D(tDepth, uv).x;
  return (uNear * uFar) / (uFar - z * (uFar - uNear));
}
// hatch layer: lines at angle a, spacing sp (css px), returns 0..1 coverage
float hatch(vec2 fc, float a, float sp, float w, float boil) {
  vec2 d = vec2(cos(a), sin(a));
  float s = dot(fc, d) / sp;
  s += (vn(fc * 0.045 + boil) - 0.5) * 0.6;
  float f = abs(fract(s) - 0.5);
  float wj = w * (0.75 + 0.5 * vn(vec2(dot(fc, vec2(-d.y, d.x)) * 0.05, floor(s))));
  return 1.0 - smoothstep(wj - 0.12, wj + 0.12, f);
}
void main() {
  float boil = floor(uTime * 7.0);
  vec2 fc = gl_FragCoord.xy / uPx;
  // wobble the line lookups (hand-drawn, boiling at ~7 fps)
  vec2 wob = (vec2(vn(fc * 0.06 + boil * 7.1), vn(fc * 0.06 - boil * 3.7 + 19.0)) - 0.5) * 2.2 * uPx / uRes;
  vec2 uv = vUv + wob;
  vec2 px = uPx / uRes;
  float c0 = lin(uv);
  float l = lin(uv - vec2(px.x, 0.0)), r = lin(uv + vec2(px.x, 0.0));
  float dn = lin(uv - vec2(0.0, px.y)), up = lin(uv + vec2(0.0, px.y));
  float l2 = lin(uv - vec2(px.x, px.y)), r2 = lin(uv + vec2(px.x, px.y));
  float l3 = lin(uv + vec2(-px.x, px.y)), r3 = lin(uv + vec2(px.x, -px.y));
  float gx = (r + 0.5 * (r2 + r3)) - (l + 0.5 * (l2 + l3));
  float gy = (up + 0.5 * (r2 + l3)) - (dn + 0.5 * (l2 + r3));
  // second derivative catches creases, first derivative silhouettes
  float lap = abs(l + r + up + dn - 4.0 * c0);
  float edge = max(length(vec2(gx, gy)) * 0.5, lap) / c0;
  float ink = smoothstep(0.012, 0.03, edge);
  ink *= step(c0, uFar * 0.9);

  vec3 col = texture2D(tColor, vUv).rgb;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 inkCol = vec3(0.09, 0.055, 0.03);

  // ---- tonal hatching
  float h1 = hatch(fc, 0.785, 5.0, 0.16, boil) * (1.0 - smoothstep(0.30, 0.42, lum));
  float h2 = hatch(fc, -0.785, 5.0, 0.14, boil + 3.0) * (1.0 - smoothstep(0.17, 0.27, lum));
  float h3 = hatch(fc, 0.1, 3.6, 0.15, boil + 5.0) * (1.0 - smoothstep(0.06, 0.13, lum));
  float hat = clamp(h1 * 0.55 + h2 * 0.5 + h3 * 0.45, 0.0, 1.0);
  // lift the darks back toward paper so the hatching does the shading (print look)
  vec3 lifted = mix(col, col * 0.6 + vec3(0.30, 0.24, 0.15) * 0.55, (1.0 - smoothstep(0.05, 0.4, lum)) * 0.6);
  col = mix(lifted, inkCol, hat * 0.75);
  col = mix(col, inkCol, ink * 0.92);

  // ---- paper grain over everything (the whole frame is a printed sheet)
  float g = vn(fc * 0.9) * 0.5 + vn(fc * 2.3 + 11.0) * 0.5;
  col *= 0.95 + 0.08 * g;

  // ---- burnt / foxed edges
  vec2 q = vUv - 0.5;
  float e = length(q * vec2(1.0, 1.05 * uRes.y / uRes.x * 1.6));
  float en = vn(vUv * vec2(9.0, 6.0)) * 0.5 + vn(vUv * vec2(23.0, 15.0)) * 0.25;
  float burn = smoothstep(0.42, 0.8, e + en * 0.18);
  col *= mix(vec3(1.0), vec3(0.55, 0.34, 0.16), burn * uBurn);
  col *= 1.0 - smoothstep(0.7, 1.0, e + en * 0.22) * 0.85 * uBurn;

  col = mix(col, col * vec3(1.25, 1.12, 0.8) + vec3(0.35, 0.25, 0.08), clamp(uFlash * 1.1, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

export class InkPass extends Pass {
  rt: THREE.WebGLRenderTarget;
  mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, samples = 4) {
    super();
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1);
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture },
        uRes: { value: new THREE.Vector2(1, 1) }, uPx: { value: 1 }, uTime: { value: 0 },
        uNear: { value: camera.near }, uFar: { value: camera.far }, uFlash: { value: 0 }, uBurn: { value: 1 },
      },
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  setSize(w: number, h: number) {
    this.rt.setSize(w, h);
    this.mat.uniforms.uRes.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.mat.uniforms.uNear.value = this.camera.near;
    this.mat.uniforms.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.rt.dispose(); this.mat.dispose(); this.quad.dispose(); }
}
