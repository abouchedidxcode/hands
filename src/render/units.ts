import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FACTION_COLORS } from '../config';
import type { Unit } from '../game/types';

const MAX = 5000;

/**
 * Chunky little soldier (faces +z). Vertex colour = real colour for untinted parts; the `aTint`
 * attribute (0..1) says how much the per-instance faction colour replaces it.
 */
function soldierGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  const add = (g: THREE.BufferGeometry, color: string, tint: number, x: number, y: number, z = 0) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    n.translate(x, y, z);
    c.set(color);
    const cnt = n.attributes.position.count;
    const col = new Float32Array(cnt * 3), tn = new Float32Array(cnt);
    for (let i = 0; i < cnt; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; tn[i] = tint; }
    n.setAttribute('color', new THREE.BufferAttribute(col, 3));
    n.setAttribute('aTint', new THREE.BufferAttribute(tn, 1));
    parts.push(n);
  };
  const DARK = '#3a3029', SKIN = '#f2c9a0', STEEL = '#d6dbe2', WOOD = '#7a5233';
  // legs
  add(new THREE.BoxGeometry(0.075, 0.16, 0.09), DARK, 0, -0.055, 0.08, 0);
  add(new THREE.BoxGeometry(0.075, 0.16, 0.09), DARK, 0, 0.055, 0.08, 0);
  // tunic (faction)
  add(new THREE.CylinderGeometry(0.12, 0.155, 0.27, 6), '#ffffff', 1, 0, 0.29, 0);
  // belt
  add(new THREE.CylinderGeometry(0.128, 0.13, 0.04, 6), DARK, 0, 0, 0.25);
  // head + helmet + plume
  add(new THREE.IcosahedronGeometry(0.085, 0), SKIN, 0, 0, 0.5, 0.01);
  const helm = new THREE.SphereGeometry(0.1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  add(helm, STEEL, 0, 0, 0.52);
  add(new THREE.CylinderGeometry(0.11, 0.11, 0.025, 7), STEEL, 0, 0, 0.525);
  add(new THREE.BoxGeometry(0.035, 0.07, 0.15), '#ffffff', 1, 0, 0.64, -0.01);
  // round shield on the left arm, faction coloured with a steel boss
  const sh = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 8); sh.rotateZ(Math.PI / 2);
  add(sh, '#ffffff', 0.85, 0.17, 0.3, 0.02);
  const boss = new THREE.CylinderGeometry(0.04, 0.05, 0.03, 6); boss.rotateZ(Math.PI / 2);
  add(boss, STEEL, 0, 0.2, 0.3, 0.02);
  // spear on the right
  const sp = new THREE.CylinderGeometry(0.016, 0.016, 0.72, 4); sp.rotateX(0.18);
  add(sp, WOOD, 0, -0.16, 0.36, 0.03);
  const tip = new THREE.ConeGeometry(0.035, 0.11, 4); tip.rotateX(0.18);
  add(tip, STEEL, 0, -0.16, 0.76, 0.1);
  const m = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  m.computeVertexNormals();
  return m;
}

function dotTexture() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

function soldierMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTint;\nvarying float vTint;')
      .replace('#include <color_vertex>', `vColor = vec4(1.0);
        vColor.rgb *= color.rgb;
        #ifdef USE_INSTANCING_COLOR
        vColor.rgb = mix(vColor.rgb, vColor.rgb * instanceColor.rgb, aTint);
        #endif
        vTint = aTint;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTint;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vTint * 0.32;');
  };
  mat.customProgramCacheKey = () => 'godhand-soldier';
  return mat;
}

/** Instanced soldiers + glowing ground dots for readability. */
export class UnitViews {
  group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private dots: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private colors: THREE.Color[];
  private dotColors: THREE.Color[];

  constructor(private heightAt: (x: number, z: number) => number) {
    this.mesh = new THREE.InstancedMesh(soldierGeometry(), soldierMaterial(), MAX);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dotGeo = new THREE.PlaneGeometry(0.62, 0.62);
    dotGeo.rotateX(-Math.PI / 2);
    const dotMat = new THREE.MeshBasicMaterial({ map: dotTexture(), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, MAX);
    this.dots.frustumCulled = false;
    this.dots.count = 0;
    this.dots.renderOrder = 2;
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.colors = FACTION_COLORS.map((c) => new THREE.Color(c));
    this.dotColors = FACTION_COLORS.map((c) => new THREE.Color(c).multiplyScalar(0.8));
    for (let i = 0; i < MAX; i++) { this.mesh.setColorAt(i, this.colors[0]); this.dots.setColorAt(i, this.dotColors[0]); }
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.dots.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.dots, this.mesh);
  }

  update(units: Unit[], t: number) {
    const n = Math.min(units.length, MAX);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (!u.alive) continue;
      const y = this.heightAt(u.x, u.z);
      const phase = t * 13 + u.id * 1.7;
      const sn = Math.sin(phase);
      const bob = Math.abs(sn) * 0.07;
      const size = 0.94 + ((u.id * 0.61803) % 1) * 0.12;
      this.p.set(u.x, y + bob, u.z);
      this.e.set(0.12 + Math.abs(sn) * 0.05, Math.atan2(u.dx, u.dz), sn * 0.13);
      this.q.setFromEuler(this.e);
      this.s.setScalar(size);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
      const f = u.faction % this.colors.length;
      this.mesh.setColorAt(k, this.colors[f]);
      this.p.y = y + 0.035;
      this.q.identity();
      this.s.setScalar(1 - bob * 1.5);
      this.m.compose(this.p, this.q, this.s);
      this.dots.setMatrixAt(k, this.m);
      this.dots.setColorAt(k, this.dotColors[f]);
      k++;
    }
    this.mesh.count = k;
    this.dots.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }
}
