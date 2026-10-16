import * as THREE from 'three';

/**
 * Building material for the instanced city blocks. Windows are drawn in the shader from each
 * instance's own facade coordinates (aOrigin + local position × aSize), so a chunk keeps its windows
 * while it tumbles, and intact columns line up into continuous facades.
 *
 * aStyle: 0 glass tower · 1 office · 2 brick · 3 house · 4 rubble (no windows); +10 = windows smashed.
 */
export const STYLE = { glass: 0, office: 1, brick: 2, house: 3, rubble: 4 } as const;
export const BROKEN = 10;

export function facadeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.04 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aSize;
attribute vec3 aOrigin;
attribute float aStyle;
varying vec3 vFacade;
varying vec3 vObjN;
varying float vStyle;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFacade = aOrigin + position * aSize;
vObjN = normal;
vStyle = aStyle;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFacade;
varying vec3 vObjN;
varying float vStyle;
float fcHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float winMask = 0.0;
float smashed = step(9.5, vStyle);
float st = vStyle - smashed * 10.0;
if (st < 3.5 && abs(vObjN.y) < 0.5) {
  // window grid per style: column width, floor height, frame thickness
  vec2 sp = st < 0.5 ? vec2(0.62, 0.65) : st < 1.5 ? vec2(0.9, 0.65) : st < 2.5 ? vec2(1.05, 0.65) : vec2(1.3, 0.65);
  vec2 fr = st < 0.5 ? vec2(0.07, 0.1) : st < 1.5 ? vec2(0.2, 0.22) : st < 2.5 ? vec2(0.28, 0.24) : vec2(0.3, 0.26);
  vec2 f = vec2(abs(vObjN.x) > 0.5 ? vFacade.z : vFacade.x, vFacade.y - 0.12);
  vec2 cell = fract(f / sp);
  vec2 id = floor(f / sp);
  winMask = step(fr.x, cell.x) * step(cell.x, 1.0 - fr.x) * step(fr.y, cell.y) * step(cell.y, 1.0 - fr.y * 0.7);
  // ground floors of offices are shop fronts: wider glass
  vec3 glass = mix(vec3(0.17, 0.25, 0.36), vec3(0.52, 0.68, 0.82), fcHash(id + floor(vFacade.xz * 0.3)));
  glass = mix(glass, vec3(0.04, 0.035, 0.03), smashed);
  diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);
}
// roofs a touch darker, rubble rougher
if (vObjN.y > 0.5) diffuseColor.rgb *= 0.8;
if (st > 3.5) diffuseColor.rgb *= 0.86 + 0.14 * fcHash(floor(vFacade.xz * 2.0));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, mix(0.12, 0.9, smashed), winMask);`);
  };
  return m;
}
