import * as THREE from 'three';
import type { HandResult } from '../../gesture';
import type { Ctx } from '../modes';

/** Default height of the giant hands above the city. */
export const HOVER = 11;
const BONES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const TIPS = new Set([4, 8, 12, 16, 20]);
const PALM = [0, 1, 5, 9, 13, 17];
/** Joints checked against the roofs below so the hand rises over towers instead of sinking in. */
const CLEAR = [0, 4, 5, 8, 9, 12, 13, 16, 17, 20];
/** On-screen palm length (screen heights) the hand is normalised to. */
const PALM_SCREEN = 0.125;

const sphere = new THREE.SphereGeometry(1, 14, 10);
const bone = new THREE.CylinderGeometry(1, 1, 1, 10);
// every part is drawn twice: normally, then as a faint silhouette wherever a tower hides it
for (const g of [sphere, bone]) { g.addGroup(0, Infinity, 0); g.addGroup(0, Infinity, 1); }
const xrayMaterial = (color: THREE.Color, side: THREE.Side = THREE.FrontSide) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthFunc: THREE.GreaterDepth, depthWrite: false, side });

/** A huge hand made of joints and bones, hovering over the city in the player's pose. */
export class GiantHand {
  group = new THREE.Group();
  /** World positions of the 21 joints. */
  pts = Array.from({ length: 21 }, () => new THREE.Vector3());
  /** Extra height needed for what the hand carries (set by the mode). */
  carryLift = 0;
  /** How far the hand is raised above its hover plane: over towers, and while carrying. */
  private lift = 0;
  private liftTo = 0;
  private joints: THREE.Mesh[] = [];
  private bones: THREE.Mesh[] = [];
  private palm: THREE.Mesh;
  private palmPos: THREE.BufferAttribute;
  private mat: THREE.MeshStandardMaterial;
  private xray: THREE.MeshBasicMaterial;
  private palmXray: THREE.MeshBasicMaterial;
  private base: THREE.Color;
  private glowTo = new THREE.Color(0, 0, 0);
  private glow = new THREE.Color(0, 0, 0);
  private slamT = 1;
  private ray = new THREE.Ray();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private up = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  visible = false;

  constructor(color: string) {
    this.base = new THREE.Color(color);
    this.mat = new THREE.MeshStandardMaterial({ color: this.base, roughness: 0.35, metalness: 0.15, emissive: new THREE.Color(0, 0, 0), transparent: true, opacity: 0.93 });
    this.xray = xrayMaterial(this.base.clone().lerp(new THREE.Color('#ffffff'), 0.25));
    this.palmXray = xrayMaterial(this.base, THREE.DoubleSide);
    this.palmXray.opacity = 0.2;
    for (let i = 0; i < 21; i++) {
      const m = new THREE.Mesh(sphere, [this.mat, this.xray]);
      m.castShadow = true;
      this.joints.push(m);
      this.group.add(m);
    }
    for (let i = 0; i < BONES.length; i++) {
      const m = new THREE.Mesh(bone, [this.mat, this.xray]);
      m.castShadow = true;
      this.bones.push(m);
      this.group.add(m);
    }
    const g = new THREE.BufferGeometry();
    this.palmPos = new THREE.BufferAttribute(new Float32Array(7 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.palmPos);
    const idx: number[] = [];
    for (let k = 1; k < 6; k++) idx.push(0, k, k + 1);
    idx.push(0, 6, 1);
    g.setIndex(idx);
    g.addGroup(0, Infinity, 0);
    g.addGroup(0, Infinity, 1);
    this.palm = new THREE.Mesh(g, [new THREE.MeshStandardMaterial({ color: this.base, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }), this.palmXray]);
    this.palm.castShadow = true;
    this.palm.frustumCulled = false;
    this.group.add(this.palm);
    this.group.visible = false;
  }

  /** Power colour the hand glows with (null = none). */
  setGlow(c: THREE.ColorRepresentation | null) { if (c === null) this.glowTo.setRGB(0, 0, 0); else this.glowTo.set(c); }
  /** Start the dive-down-and-back animation of a palm slam. */
  slam() { this.slamT = 0; }
  /** 0 → 1 → 0 over a slam (1 = touching the city). */
  get slamDepth() { const t = this.slamT; return t < 0.13 ? t / 0.13 : t < 0.55 ? 1 - (t - 0.13) / 0.42 : 0; }

  /** Centre of the palm (world). */
  palmCenter(out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    for (const i of [0, 5, 9, 13, 17]) out.add(this.pts[i]);
    return out.divideScalar(5);
  }

  /** Current palm height. */
  get hover() { return HOVER + this.lift; }

  /** Pose the hand; `roof(x, z)` is the height of whatever stands below a point. */
  update(r: HandResult | null, ctx: Ctx, dt: number, roof?: (x: number, z: number) => number) {
    this.visible = !!r;
    this.group.visible = !!r;
    if (!r) return;
    this.slamT = Math.min(1, this.slamT + dt);
    const depth = this.slamDepth;
    // the joints sit where the player's hand is on screen, in the hover plane...
    const y0 = HOVER - (HOVER - 1.2) * depth;
    const c = ctx.toView(r.features.center);
    const w0 = ctx.toView(r.landmarks[0]), m9 = ctx.toView(r.landmarks[9]);
    const aspect = innerWidth / innerHeight;
    const palmLen = Math.hypot((m9.x - w0.x) * aspect, m9.y - w0.y) || 1;
    const k = THREE.MathUtils.clamp(PALM_SCREEN / palmLen, 0.2, 1.4);
    for (let i = 0; i < 21; i++) {
      const l = r.landmarks[i];
      const v = ctx.toView(l);
      ctx.viewRay({ x: c.x + (v.x - c.x) * k, y: c.y + (v.y - c.y) * k }, this.ray);
      // joints nearer the webcam (negative z) hang lower, toward the city
      this.plane.constant = -(y0 + l.z * 14 * k);
      if (!this.ray.intersectPlane(this.plane, this.pts[i])) this.pts[i].set(0, y0, 0);
    }
    // ...then lift straight up (so it stays over the same spot) to clear the roofs below and
    // whatever it carries. Rises quickly, settles slowly; a slam dives through regardless.
    if (depth === 0) {
      let need = this.carryLift;
      if (roof) for (const i of CLEAR) need = Math.max(need, roof(this.pts[i].x, this.pts[i].z) + 0.9 - this.pts[i].y);
      this.liftTo = need;
    }
    this.lift += (this.liftTo - this.lift) * Math.min(1, dt * (this.liftTo > this.lift ? 9 : 2.5));
    const lift = this.lift * (1 - depth);
    for (const p of this.pts) p.y += lift;
    for (let i = 0; i < 21; i++) {
      const m = this.joints[i];
      m.position.copy(this.pts[i]);
      m.scale.setScalar(TIPS.has(i) ? 0.34 : i === 0 ? 0.55 : PALM.includes(i) ? 0.45 : 0.36);
    }
    BONES.forEach(([a, b], n) => {
      const m = this.bones[n];
      const pa = this.pts[a], pb = this.pts[b];
      this.tmp.subVectors(pb, pa);
      const len = this.tmp.length();
      m.position.addVectors(pa, pb).multiplyScalar(0.5);
      if (len > 1e-4) m.quaternion.setFromUnitVectors(this.up, this.tmp.divideScalar(len));
      const r0 = a === 0 || PALM.includes(b) && PALM.includes(a) ? 0.3 : 0.27;
      m.scale.set(r0, Math.max(len, 1e-3), r0);
    });
    // palm membrane: fan around its centre
    const pc = this.palmCenter(this.tmp);
    this.palmPos.setXYZ(0, pc.x, pc.y, pc.z);
    PALM.forEach((i, n) => this.palmPos.setXYZ(n + 1, this.pts[i].x, this.pts[i].y, this.pts[i].z));
    this.palmPos.needsUpdate = true;
    this.palm.geometry.computeVertexNormals();
    this.palm.geometry.computeBoundingSphere();
    // glow eases toward the active power's colour, flickering a little
    this.glow.lerp(this.glowTo, Math.min(1, dt * 10));
    this.mat.emissive.copy(this.glow).multiplyScalar(0.85 + 0.3 * Math.random());
    (this.palm.material as THREE.MeshStandardMaterial[])[0].emissive.copy(this.mat.emissive).multiplyScalar(0.6);
  }

  dispose() {
    this.mat.dispose();
    this.xray.dispose();
    for (const m of this.palm.material as THREE.Material[]) m.dispose();
    this.palm.geometry.dispose();
  }
}
