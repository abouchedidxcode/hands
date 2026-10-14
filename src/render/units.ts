import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FACTION_COLORS } from '../config';
import type { Unit } from '../game/types';

const MAX = 5000;

function soldierGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.06, 0.085, 0.2, 6); body.translate(0, 0.12, 0); parts.push(body);
  const head = new THREE.IcosahedronGeometry(0.06, 0); head.translate(0, 0.27, 0); parts.push(head);
  const shield = new THREE.BoxGeometry(0.03, 0.13, 0.11); shield.translate(0.085, 0.14, 0.02); parts.push(shield);
  const spear = new THREE.CylinderGeometry(0.012, 0.012, 0.42, 4); spear.translate(-0.08, 0.2, 0.03); parts.push(spear);
  const clean = parts.map((g) => {
    const n = g.toNonIndexed();
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  const m = mergeGeometries(clean)!;
  m.computeVertexNormals();
  m.scale(1.25, 1.25, 1.25);
  return m;
}

/** Instanced soldiers + glowing ground dots for readability. */
export class UnitViews {
  group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private dots: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private colors: THREE.Color[];
  private dotColors: THREE.Color[];

  constructor(private heightAt: (x: number, z: number) => number) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, flatShading: true });
    this.mesh = new THREE.InstancedMesh(soldierGeometry(), mat, MAX);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dotGeo = new THREE.CircleGeometry(0.15, 10);
    dotGeo.rotateX(-Math.PI / 2);
    const dotMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, MAX);
    this.dots.frustumCulled = false;
    this.dots.count = 0;
    this.dots.renderOrder = 2;
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.colors = FACTION_COLORS.map((c) => new THREE.Color(c).multiplyScalar(1.15));
    this.dotColors = FACTION_COLORS.map((c) => new THREE.Color(c).multiplyScalar(0.9));
    // init color buffers
    for (let i = 0; i < MAX; i++) { this.mesh.setColorAt(i, this.colors[0]); this.dots.setColorAt(i, this.dotColors[0]); }
    this.group.add(this.dots, this.mesh);
  }

  update(units: Unit[], t: number) {
    const n = Math.min(units.length, MAX);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (!u.alive) continue;
      const y = this.heightAt(u.x, u.z);
      const phase = t * 15 + u.id * 1.7;
      const bob = Math.abs(Math.sin(phase)) * 0.06;
      this.p.set(u.x, y + bob, u.z);
      this.e.set(Math.sin(phase) * 0.12, Math.atan2(u.dx, u.dz), 0);
      this.q.setFromEuler(this.e);
      this.s.setScalar(1);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
      this.mesh.setColorAt(k, this.colors[u.faction % this.colors.length]);
      this.p.y = y + 0.03;
      this.q.identity();
      this.m.compose(this.p, this.q, this.s);
      this.dots.setMatrixAt(k, this.m);
      this.dots.setColorAt(k, this.dotColors[u.faction % this.dotColors.length]);
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
