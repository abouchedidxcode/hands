// Stylised animated water: depth-tinted, sun glints, animated shore foam.
import * as THREE from 'three';

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform sampler2D uCoast;
uniform vec4 uCoastRect;   // minX, minZ, 1/sizeX, 1/sizeZ
uniform float uDepthScale;
uniform float uDistScale;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uLagoon;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
varying vec3 vWorld;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 wave(vec2 p, vec2 d, float f, float s, float a) {
  float ph = dot(d, p) * f + uTime * s;
  return d * (f * a * cos(ph));
}

void main() {
  vec2 p = vWorld.xz;
  float t = uTime;
  vec2 uv = (p - uCoastRect.xy) * uCoastRect.zw;
  vec2 cd = vec2(1.0);
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) cd = texture2D(uCoast, uv).rg;
  float depth = cd.r * uDepthScale;
  float dist = cd.g * uDistScale;

  // ---- wave normal (sum of directional sines, domain-warped) ----
  vec2 warp = vec2(vnoise(p * 0.18 + t * 0.05), vnoise(p * 0.18 - 7.3 - t * 0.04)) * 2.4;
  vec2 q = p + warp;
  vec2 g = vec2(0.0);
  g += wave(q, normalize(vec2(1.0, 0.35)), 0.55, 1.1, 0.10);
  g += wave(q, normalize(vec2(-0.4, 1.0)), 0.80, 1.4, 0.07);
  g += wave(q, normalize(vec2(0.7, -0.8)), 1.35, 1.9, 0.045);
  g += wave(q, normalize(vec2(-1.0, -0.2)), 2.10, 2.6, 0.03);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

  // ---- base colour by depth ----
  float dN = clamp(depth / 3.2, 0.0, 1.0);
  vec3 col = mix(uLagoon, uShallow, smoothstep(0.0, 0.16, dN));
  col = mix(col, uMid, smoothstep(0.1, 0.5, dN));
  col = mix(col, uDeep, smoothstep(0.45, 1.0, dN));
  float big = vnoise(p * 0.045 + vec2(t * 0.006, 0.0));
  col *= 0.9 + 0.2 * big;

  // ---- lighting ----
  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = clamp(dot(n, uSunDir), 0.0, 1.0);
  col *= 0.78 + 0.32 * ndl;
  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 4.0);
  col = mix(col, uSky, fres * 0.35);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(n, H), 0.0), 140.0);
  // glitter: sparse twinkling cells
  vec2 gc = p * 2.6 + n.xz * 6.0;
  float gl = vnoise(gc + vec2(t * 0.7, -t * 0.4)) * vnoise(gc * 1.7 - vec2(t * 0.5, t * 0.9));
  float glitter = smoothstep(0.62, 0.8, gl) * (0.3 + 0.7 * smoothstep(0.15, 0.6, dN));
  col += uSunColor * (spec * 0.9 + glitter * 0.4);

  // ---- shallow caustics ----
  float cz = vnoise(p * 1.6 + vec2(t * 0.35, t * 0.22)) + vnoise(p * 2.3 - vec2(t * 0.28, -t * 0.31));
  float caust = smoothstep(0.85, 1.0, 1.0 - abs(cz - 1.0) * 1.0);
  col += vec3(0.55, 0.85, 0.8) * caust * 0.22 * (1.0 - smoothstep(0.05, 0.35, dN));

  // ---- foam ----
  float fn = vnoise(p * 1.4 + vec2(t * 0.25, -t * 0.12));
  float fn2 = vnoise(p * 3.1 - vec2(t * 0.4, t * 0.2));
  float edge = 1.0 - smoothstep(0.0, 0.18 + 0.22 * fn + 0.08 * sin(t * 1.3 + fn * 6.0), dist);
  edge = max(edge, 1.0 - smoothstep(0.0, 0.06, depth));
  float ph = dist * 2.2 + t * 1.25 + fn * 2.8;
  float band = smoothstep(0.78, 0.93, sin(ph)) * (1.0 - smoothstep(0.5, 2.6, dist)) * smoothstep(0.3, 0.55, fn2 + 0.15);
  float foam = clamp(edge * 0.95 + band * 0.7, 0.0, 1.0);
  col = mix(col, uFoam, foam);

  float alpha = mix(0.5, 1.0, smoothstep(0.0, 1.4, depth));
  alpha = max(alpha, foam * 0.95);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterParts {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  time: { value: number };
}

export function createWater(opts: {
  level: number;
  size: number;
  coastTex: THREE.Texture;
  rect: { minX: number; minZ: number; sizeX: number; sizeZ: number };
  depthScale: number;
  distScale: number;
}): WaterParts {
  const time = { value: 0 };
  const sun = new THREE.Vector3(-20, 30, 10).normalize();
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>;
  Object.assign(uniforms, {
    uTime: time,
    uCoast: { value: opts.coastTex },
    uCoastRect: { value: new THREE.Vector4(opts.rect.minX, opts.rect.minZ, 1 / opts.rect.sizeX, 1 / opts.rect.sizeZ) },
    uDepthScale: { value: opts.depthScale },
    uDistScale: { value: opts.distScale },
    uDeep: { value: new THREE.Color('#0c3a5a') },
    uMid: { value: new THREE.Color('#14769a') },
    uShallow: { value: new THREE.Color('#25b3bf') },
    uLagoon: { value: new THREE.Color('#6fe0d2') },
    uFoam: { value: new THREE.Color('#f4fbff') },
    uSunDir: { value: sun },
    uSunColor: { value: new THREE.Color('#fff1cf') },
    uSky: { value: new THREE.Color('#bfe3ff') },
  });
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: true,
    fog: true,
  });
  const geometry = new THREE.PlaneGeometry(opts.size, opts.size, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = opts.level;
  mesh.renderOrder = -1;
  mesh.name = 'water';
  return { mesh, material, geometry, time };
}
