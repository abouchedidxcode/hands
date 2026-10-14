// Stylised animated water: depth-tinted, sun glints, animated shore foam.
import * as THREE from 'three';
import { ATLAS_GLSL, atlasUniforms } from './atlas';

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
uniform vec3 uSeaTint;
uniform vec3 uInk;
varying vec3 vWorld;
${ATLAS_GLSL}

// Antique chart sea: parchment with a blue-grey wash, an inked coastline, concentric
// "water-lining" ripples hugging the coast, and little wave squiggles out at sea.
void main() {
  vec2 p = vWorld.xz;
  float t = uTime;
  vec2 uv = (p - uCoastRect.xy) * uCoastRect.zw;
  vec2 cd = vec2(1.0);
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) cd = texture2D(uCoast, uv).rg;
  float depth = cd.r * uDepthScale;
  float dist = cd.g * uDistScale;

  vec3 paper = at_paper(p);
  float wash = 0.55 + 0.4 * smoothstep(0.3, 9.0, dist) + 0.1 * (at_fbm(p * 0.2 + t * 0.01) - 0.5);
  vec3 col = paper * mix(vec3(1.0), uSeaTint, clamp(wash, 0.0, 1.0));
  // pigment pools along the shore
  col *= 1.0 - 0.22 * exp(-dist * 2.2);
  float terrA;
  col = at_wash(col, p, terrA);

  float d = dist + (at_noise(p * 0.9) - 0.5) * 0.12;
  // ---- coastline: heavy ink stroke
  float fwd = max(fwidth(dist), 1e-3);
  float coast = 1.0 - smoothstep(0.05, 0.05 + fwd * 1.5 + 0.04, d);
  // ---- water lines: ripples hugging the coast, spacing widening seaward, gently breathing
  float rr = sqrt(max(d - 0.12, 0.0)) * 3.2 - t * 0.08;
  float frr = max(fwidth(rr), 1e-3);
  float rip = 1.0 - smoothstep(frr * 0.6, frr * 1.6, abs(fract(rr) - 0.5) * 1.0);
  rip *= (1.0 - smoothstep(0.8, 3.4, d)) * smoothstep(0.1, 0.2, d);
  rip *= 0.55 + 0.45 * smoothstep(0.2, 0.45, at_noise(p * 0.6 + 2.0));
  // ---- wave squiggles out at sea
  vec2 g = p * vec2(0.42, 0.85) + vec2(t * 0.03, 0.0);
  vec2 cell = floor(g);
  vec2 q = fract(g);
  float hsh = at_hash(cell);
  float yc = 0.5 + 0.11 * sin((q.x + hsh) * 6.2831 * 1.5) + (hsh - 0.5) * 0.3;
  float sq = 1.0 - smoothstep(0.025, 0.06, abs(q.y - yc));
  sq *= smoothstep(0.15, 0.3, q.x) * smoothstep(0.85, 0.7, q.x) * step(hsh, 0.42);
  sq *= smoothstep(3.0, 5.0, d);
  float ink = clamp(coast * 0.95 + rip * 0.5 + sq * 0.45, 0.0, 1.0);
  col = mix(col, uInk, ink);

  gl_FragColor = vec4(col, 1.0);
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
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>;
  Object.assign(uniforms, {
    uTime: time,
    uCoast: { value: opts.coastTex },
    uCoastRect: { value: new THREE.Vector4(opts.rect.minX, opts.rect.minZ, 1 / opts.rect.sizeX, 1 / opts.rect.sizeZ) },
    uDepthScale: { value: opts.depthScale },
    uDistScale: { value: opts.distScale },
    uSeaTint: { value: new THREE.Color('#a9cfc8') },
    uInk: { value: new THREE.Color('#2a1c12') },
    ...atlasUniforms,
  });
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: false,
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
