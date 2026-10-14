import * as THREE from 'three';
import type { HandState } from '../input/types';
import type { Stage } from './scene';

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
const PALM = [0, 1, 5, 9, 13, 17];
const TIPS = new Set([4, 8, 12, 16, 20]);

const HAND_H = 3.4;          // world height of the hand plane
const DEPTH_K = 9;           // how much MediaPipe z lifts fingers
const HAND_SCALE = 0.78;     // shrink around the cursor so the hand doesn't hide the board

export type HandMode = 'idle' | 'hover' | 'pinch' | 'charge' | 'armed' | 'swat';

class OneHand {
  group = new THREE.Group();
  joints: THREE.InstancedMesh;
  bones: THREE.InstancedMesh;
  palm: THREE.Mesh;
  palmGeo = new THREE.BufferGeometry();
  reticle: THREE.Mesh;
  reticleMat: THREE.MeshBasicMaterial;
  mat: THREE.MeshStandardMaterial;
  palmMat: THREE.MeshStandardMaterial;
  pts: THREE.Vector3[] = Array.from({ length: 21 }, () => new THREE.Vector3());
  vis = 0;
  base: THREE.Color;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private d = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(color: string) {
    this.base = new THREE.Color(color);
    this.mat = new THREE.MeshStandardMaterial({
      color: this.base, emissive: this.base, emissiveIntensity: 0.9,
      transparent: true, opacity: 0.72, roughness: 0.3, depthWrite: false,
    });
    this.palmMat = new THREE.MeshStandardMaterial({
      color: this.base, emissive: this.base, emissiveIntensity: 0.35,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    });
    this.joints = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.mat, 21);
    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    boneGeo.translate(0, 0.5, 0);
    this.bones = new THREE.InstancedMesh(boneGeo, this.mat, BONES.length);
    this.joints.castShadow = this.bones.castShadow = true;
    this.joints.frustumCulled = this.bones.frustumCulled = false;
    this.joints.renderOrder = this.bones.renderOrder = 40;
    for (let i = 0; i < 21; i++) this.joints.setColorAt(i, this.base);

    this.palmGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PALM.length * 3 * 3), 3));
    this.palm = new THREE.Mesh(this.palmGeo, this.palmMat);
    this.palm.castShadow = true;
    this.palm.frustumCulled = false;
    this.palm.renderOrder = 39;

    this.reticleMat = new THREE.MeshBasicMaterial({ color: this.base, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 40), this.reticleMat);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.renderOrder = 41;
    this.group.add(this.palm, this.bones, this.joints, this.reticle);
  }

  update(h: HandState, stage: Stage, dt: number, t: number, mode: HandMode, charge: number, ground: (x: number, z: number) => number) {
    const want = h.present && h.landmarks.length === 21 ? 1 : 0;
    this.vis += (want - this.vis) * Math.min(1, dt * (want ? 12 : 5));
    this.group.visible = this.vis > 0.02;
    if (!this.group.visible || !h.landmarks.length) return;

    const cx = h.x, cy = h.y;
    for (let i = 0; i < 21; i++) {
      const l = h.landmarks[i];
      const sx = cx + (l.x - cx) * HAND_SCALE;
      const sy = cy + (l.y - cy) * HAND_SCALE;
      const hh = THREE.MathUtils.clamp(HAND_H - l.z * DEPTH_K, 1.6, 7);
      if (!stage.screenToGround(sx, sy, hh, this.pts[i])) this.pts[i].set(0, hh, 0);
    }

    // palm-size based thickness so it feels like a solid hand
    const span = this.pts[0].distanceTo(this.pts[9]);
    const th = THREE.MathUtils.clamp(span * 0.085, 0.08, 0.3);

    // colors by mode
    const col = this.c.copy(this.base);
    let glow = 0.9;
    if (mode === 'pinch') { col.lerp(new THREE.Color('#ffffff'), 0.35); glow = 1.4; }
    if (mode === 'charge' || mode === 'armed') {
      col.lerp(new THREE.Color('#fff6b0'), 0.4 + charge * 0.5);
      glow = 1.2 + charge * 2.2 + (mode === 'armed' ? Math.sin(t * 40) * 0.6 : 0);
    }
    if (mode === 'swat') { col.lerp(new THREE.Color('#ffffff'), 0.5); glow = 2; }
    this.mat.color.copy(col);
    this.mat.emissive.copy(col);
    this.mat.emissiveIntensity = glow;
    this.mat.opacity = 0.75 * this.vis;
    this.palmMat.color.copy(col);
    this.palmMat.emissive.copy(col);
    this.palmMat.opacity = 0.2 * this.vis;

    for (let i = 0; i < 21; i++) {
      const tip = TIPS.has(i);
      let r = th * (tip ? 1.25 : 1.05);
      if (mode === 'pinch' && (i === 4 || i === 8)) r *= 1.5;
      this.s.setScalar(r);
      this.m.compose(this.pts[i], this.q.identity(), this.s);
      this.joints.setMatrixAt(i, this.m);
    }
    this.joints.instanceMatrix.needsUpdate = true;

    BONES.forEach(([a, b], i) => {
      const pa = this.pts[a], pb = this.pts[b];
      this.d.subVectors(pb, pa);
      const len = this.d.length();
      this.q.setFromUnitVectors(this.up, this.d.normalize());
      this.s.set(th * 0.82, len, th * 0.82);
      this.m.compose(pa, this.q, this.s);
      this.bones.setMatrixAt(i, this.m);
    });
    this.bones.instanceMatrix.needsUpdate = true;

    // palm fan
    const pos = this.palmGeo.attributes.position as THREE.BufferAttribute;
    const ctr = this.d.set(0, 0, 0);
    for (const i of PALM) ctr.add(this.pts[i]);
    ctr.multiplyScalar(1 / PALM.length);
    for (let k = 0; k < PALM.length; k++) {
      const a = this.pts[PALM[k]], b = this.pts[PALM[(k + 1) % PALM.length]];
      pos.setXYZ(k * 3, ctr.x, ctr.y, ctr.z);
      pos.setXYZ(k * 3 + 1, a.x, a.y, a.z);
      pos.setXYZ(k * 3 + 2, b.x, b.y, b.z);
    }
    pos.needsUpdate = true;
    this.palmGeo.computeVertexNormals();

    // ground reticle under the cursor
    const g = stage.screenToGround(cx, cy, 0.25);
    if (g) {
      g.y = ground(g.x, g.z) + 0.08;
      this.reticle.position.copy(g);
      const rs = mode === 'pinch' ? 0.8 : mode === 'armed' ? 1.6 + Math.sin(t * 30) * 0.08 : mode === 'charge' ? 0.9 + charge * 0.8 : 1;
      this.reticle.scale.setScalar(rs);
      this.reticleMat.color.copy(col);
      this.reticleMat.opacity = 0.85 * this.vis;
      this.reticle.rotation.z += dt * 2;
    }
  }
}

/** The player's giant translucent "god hands" floating over the board, casting shadows. */
export class HandViz {
  group = new THREE.Group();
  hands = [new OneHand('#8ff1ff'), new OneHand('#ffe3a0')];
  constructor() { for (const h of this.hands) this.group.add(h.group); }
  update(hands: HandState[], stage: Stage, dt: number, t: number, modes: HandMode[], charges: number[], ground: (x: number, z: number) => number) {
    hands.forEach((h, i) => this.hands[i].update(h, stage, dt, t, modes[i], charges[i], ground));
  }
  /** World position of a hand's palm centre (for FX). */
  palm(i: number, out: THREE.Vector3) {
    const p = this.hands[i].pts;
    return out.copy(p[0]).add(p[5]).add(p[9]).add(p[17]).multiplyScalar(0.25);
  }
}
