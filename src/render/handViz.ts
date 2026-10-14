import * as THREE from 'three';
import { MANA } from '../config';
import type { HandState } from '../input/types';
import type { Stage } from './scene';
import { HAND_VERTS, HandSurface } from './handVizMesh';
import {
  flareTexture, ghostMaterial, handMaterial, handPrepassMaterial, handUniforms, reticleMaterial,
  shadowDepthMaterial, type HandUniforms,
} from './handVizShaders';

/** World height (above the ground plane) at which the hand floats. */
const HAND_H = 3.6;
/**
 * How much MediaPipe z (relative depth) moves joints. The player sits behind their hand, so a joint
 * closer to the webcam (negative z) is farther from them: it goes DOWN toward the map. (Lifting it
 * instead curled the fingers up at the viewer, which read as an upside-down, palm-up hand.)
 */
const DEPTH_K = 9;
/**
 * Apparent size: the hand is shrunk around the cursor so its on-screen palm
 * (wrist→middle-MCP) tends toward PALM_TARGET screen heights. SIZE_EXP < 1 keeps
 * a little of the "closer to the camera = bigger" feel.
 */
const PALM_TARGET = 0.165;
const SIZE_EXP = 0.8;
const SCALE_MIN = 0.4, SCALE_MAX = 1.2;
/** Afterimages for the swat streak. */
const GHOSTS = 4;
const GHOST_DT = 0.035;

export type HandMode = 'idle' | 'hover' | 'pinch' | 'charge' | 'armed' | 'swat';

interface Palette { body: THREE.Color; rim: THREE.Color; hot: THREE.Color }
// Linear-space colours: the body stays under the bloom threshold, the rim may bloom.
const PALETTES: Palette[] = [
  // LIVING ATLAS: sepia-ink body veiling the paper, gold-leaf rim (the only thing that blooms)
  { body: new THREE.Color().setRGB(0.34, 0.21, 0.04), rim: new THREE.Color().setRGB(1.9, 1.25, 0.32), hot: new THREE.Color().setRGB(1.9, 1.35, 0.55) },
  { body: new THREE.Color().setRGB(0.34, 0.14, 0.04), rim: new THREE.Color().setRGB(1.9, 0.85, 0.3), hot: new THREE.Color().setRGB(1.9, 1.1, 0.5) },
  // online opponent: vermilion ink with a blood-red rim
  { body: new THREE.Color().setRGB(0.32, 0.03, 0.02), rim: new THREE.Color().setRGB(1.9, 0.22, 0.12), hot: new THREE.Color().setRGB(1.9, 0.5, 0.3) },
  { body: new THREE.Color().setRGB(0.28, 0.03, 0.06), rim: new THREE.Color().setRGB(1.7, 0.18, 0.3), hot: new THREE.Color().setRGB(1.9, 0.45, 0.45) },
  // online opponent playing blue (faction 0): indigo ink, sky rim
  { body: new THREE.Color().setRGB(0.03, 0.1, 0.3), rim: new THREE.Color().setRGB(0.25, 0.95, 1.9), hot: new THREE.Color().setRGB(0.6, 1.2, 1.9) },
  { body: new THREE.Color().setRGB(0.04, 0.08, 0.26), rim: new THREE.Color().setRGB(0.3, 0.75, 1.8), hot: new THREE.Color().setRGB(0.6, 1.1, 1.9) },
  // online opponent playing amber (faction 2): burnt-umber ink, deep orange rim (distinct from our gold)
  { body: new THREE.Color().setRGB(0.32, 0.08, 0.0), rim: new THREE.Color().setRGB(1.9, 0.5, 0.02), hot: new THREE.Color().setRGB(1.9, 0.8, 0.25) },
  { body: new THREE.Color().setRGB(0.3, 0.07, 0.0), rim: new THREE.Color().setRGB(1.8, 0.42, 0.02), hot: new THREE.Color().setRGB(1.9, 0.75, 0.22) },
];

/** Ghost-hand palettes for an online opponent playing faction `f`. */
export function opponentPalettes(f: number): [number, number] {
  return f === 0 ? [4, 5] : f === 2 ? [6, 7] : [2, 3];
}
const ONES = [1, 1, 1, 1, 1];

const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * Math.min(1, dt * rate);

class OneHand {
  group = new THREE.Group();
  /** World-space joints (kept after the hand disappears so it can fade out in place). */
  pts: THREE.Vector3[] = Array.from({ length: 21 }, () => new THREE.Vector3());
  vis = 0;
  private surface = new HandSurface();
  private u: HandUniforms;
  private mesh: THREE.Mesh;
  private prepass: THREE.Mesh;
  private shadowVis = { value: 0 };
  private ghosts: THREE.Mesh[] = [];
  private ghostU: HandUniforms[] = [];
  private ghostHead = 0;
  private ghostAcc = 0;
  private spark: THREE.Sprite;
  private sparkMat: THREE.SpriteMaterial;
  private reticle: THREE.Mesh;
  private ret: THREE.ShaderMaterial;
  private pal: Palette;
  private scale = 1;
  private hasShape = false;
  // smoothed mode amounts
  private pinchAmt = 0;
  private heat = 0;
  private armedAmt = 0;
  private swatAmt = 0;
  private boost = [1, 1, 1, 1, 1];
  // smoothed reticle params
  private rRing = 0.55; private rWidth = 0.07; private rDot = 0.06; private rFill = 0; private rDanger = 0; private rSpin = 0.8;
  private tmp = new THREE.Vector3();

  constructor(slot: number) {
    this.pal = PALETTES[slot];
    this.u = handUniforms();
    this.u.uBody.value.copy(this.pal.body);
    this.u.uRim.value.copy(this.pal.rim);
    this.u.uHot.value.copy(this.pal.hot);
    this.u.uTime.value = slot * 17.3;

    const geo = this.surface.geometry;
    this.prepass = new THREE.Mesh(geo, handPrepassMaterial(this.u));
    this.prepass.renderOrder = 39;
    this.mesh = new THREE.Mesh(geo, handMaterial(this.u));
    this.mesh.renderOrder = 40;
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = shadowDepthMaterial(this.shadowVis);
    this.prepass.frustumCulled = this.mesh.frustumCulled = false;

    for (let g = 0; g < GHOSTS; g++) {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
      gg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(HAND_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
      gg.setAttribute('aInfo', this.surface.info);
      gg.setIndex(this.surface.index);
      const gu: HandUniforms = { ...this.u, uGhost: { value: 0 }, uVis: { value: 1 }, uDissolve: { value: 1 }, uHeat: { value: 0 } };
      const m = new THREE.Mesh(gg, ghostMaterial(gu));
      m.renderOrder = 38;
      m.frustumCulled = false;
      m.visible = false;
      this.ghosts.push(m);
      this.ghostU.push(gu);
    }

    this.sparkMat = new THREE.SpriteMaterial({
      map: flareTexture(), color: this.pal.rim.clone(), transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0,
    });
    this.spark = new THREE.Sprite(this.sparkMat);
    this.spark.renderOrder = 42;
    this.spark.visible = false;

    this.ret = reticleMaterial();
    (this.ret.uniforms.uColor.value as THREE.Color).copy(this.pal.rim).multiplyScalar(0.75);
    this.reticle = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.ret);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.scale.setScalar(this.ret.uniforms.uRm.value as number);
    this.reticle.renderOrder = 36;
    this.reticle.frustumCulled = false;

    this.group.add(this.reticle, ...this.ghosts, this.prepass, this.mesh, this.spark);
    this.group.visible = false;
  }

  update(h: HandState, stage: Stage, dt: number, t: number, mode: HandMode, charge: number, ground: (x: number, z: number) => number) {
    const live = h.present && h.landmarks.length === 21;
    this.vis = approach(this.vis, live ? 1 : 0, live ? 6 : 4, dt);
    if (!live && (this.vis < 0.01 || !this.hasShape)) {
      this.vis = 0;
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    if (!live) mode = 'idle';

    // ------------------------------------------------ mode amounts
    this.pinchAmt = approach(this.pinchAmt, mode === 'pinch' ? 1 : 0, 14, dt);
    const heatT = mode === 'armed' ? 1 : mode === 'charge' ? 0.3 + 0.7 * charge : 0;
    this.heat = approach(this.heat, heatT, heatT > this.heat ? 10 : 3, dt);
    this.armedAmt = approach(this.armedAmt, mode === 'armed' ? 1 : 0, 10, dt);
    this.swatAmt = approach(this.swatAmt, mode === 'swat' ? 1 : 0, mode === 'swat' ? 25 : 4, dt);
    const pulse = 0.5 + 0.5 * Math.sin(t * 17);

    // ------------------------------------------------ joints → world
    if (live) {
      const L = h.landmarks, cx = h.x, cy = h.y;
      const aspect = stage.camera.aspect;
      const ps = Math.hypot((L[0].x - L[9].x) * aspect, L[0].y - L[9].y);
      const kT = THREE.MathUtils.clamp(Math.pow(PALM_TARGET / Math.max(ps, 0.02), SIZE_EXP), SCALE_MIN, SCALE_MAX);
      this.scale = this.hasShape && this.vis > 0.05 ? approach(this.scale, kT, 5, dt) : kT;
      const k = this.scale;
      for (let i = 0; i < 21; i++) {
        const l = L[i];
        // each joint is placed on the ray through its (cursor-scaled) screen position,
        // so the thumb/index midpoint stays exactly under the cursor
        const sx = cx + (l.x - cx) * k;
        const sy = cy + (l.y - cy) * k;
        const hh = THREE.MathUtils.clamp(HAND_H + l.z * DEPTH_K * k, 1.8, 7);
        if (!stage.screenToGround(sx, sy, hh, this.pts[i])) this.pts[i].set(0, hh, 0);
      }
      const swell = 1 + this.armedAmt * 0.05 * pulse + this.heat * 0.03;
      for (let f = 0; f < 5; f++) this.boost[f] = ONES[f] * swell;
      this.surface.build(this.pts, this.boost);
      this.hasShape = true;
      this.captureGhost(dt);
    }

    // ------------------------------------------------ hand shading
    const u = this.u;
    u.uTime.value += dt;
    // while pinch-dragging, ghost the hand so the target base and its count stay readable
    u.uVis.value = Math.min(1, this.vis * 1.1) * (1 - 0.6 * this.pinchAmt);
    u.uDissolve.value = THREE.MathUtils.smoothstep(this.vis, 0, 0.85);
    u.uPinch.value = this.pinchAmt * (0.85 + 0.15 * Math.sin(t * 24));
    u.uHeat.value = this.heat;
    u.uArmed.value = this.armedAmt * (0.35 + 0.65 * pulse);
    u.uFlicker.value = this.heat > 0.01 ? Math.random() : 0.5;
    u.uTip.value = 0.3 + 0.25 * this.swatAmt;
    this.shadowVis.value = Math.min(1, this.vis * 1.4) * 0.999;

    // ------------------------------------------------ swat afterimages
    for (let g = 0; g < GHOSTS; g++) {
      const age = (this.ghostHead - g + GHOSTS) % GHOSTS; // 0 = newest
      const a = this.swatAmt * this.vis * 0.5 * (1 - age / GHOSTS);
      this.ghosts[g].visible = a > 0.01;
      this.ghostU[g].uGhost.value = a;
    }

    // ------------------------------------------------ pinch spark between thumb & index tips
    const sp = this.pinchAmt * this.vis;
    this.spark.visible = sp > 0.02;
    if (this.spark.visible) {
      const span = this.pts[0].distanceTo(this.pts[9]);
      this.spark.position.copy(this.pts[4]).add(this.pts[8]).multiplyScalar(0.5);
      this.spark.scale.setScalar(span * (0.35 + 0.12 * Math.sin(t * 37) + 0.05 * Math.sin(t * 13)) * sp);
      this.sparkMat.rotation = t * 1.7;
      this.sparkMat.opacity = sp * 0.7;
      this.sparkMat.color.copy(this.pal.rim).multiplyScalar(1.3);
    }

    // ------------------------------------------------ ground reticle under the cursor
    this.updateReticle(h, stage, dt, t, mode, charge, ground, live);
  }

  private captureGhost(dt: number) {
    this.ghostAcc += dt;
    if (this.ghostAcc < GHOST_DT) return;
    this.ghostAcc = 0;
    this.ghostHead = (this.ghostHead + 1) % GHOSTS;
    const gg = this.ghosts[this.ghostHead].geometry;
    const pa = gg.attributes.position as THREE.BufferAttribute, na = gg.attributes.normal as THREE.BufferAttribute;
    (pa.array as Float32Array).set(this.surface.position.array as Float32Array);
    (na.array as Float32Array).set(this.surface.normal.array as Float32Array);
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }

  private updateReticle(h: HandState, stage: Stage, dt: number, t: number, mode: HandMode, charge: number,
    ground: (x: number, z: number) => number, live: boolean) {
    const U = this.ret.uniforms;
    if (live) {
      const g = stage.screenToGround(h.x, h.y, 0.25, this.tmp);
      if (g) this.reticle.position.set(g.x, ground(g.x, g.z) + 0.06, g.z);
    }
    let ring = 0.55, width = 0.075, dot = 0.06, fill = 0, danger = 0, spin = 0.7, dash = 3;
    switch (mode) {
      case 'pinch': ring = 0.34; width = 0.1; dot = 0.09; fill = 0.4; spin = 0; dash = 0; break;
      case 'charge': ring = 0.55 + (MANA.smiteRadius - 0.55) * charge; width = 0.09; dot = 0.08; fill = 0.1; spin = 3.5; dash = 24; danger = 0.35 * charge; break;
      case 'armed': ring = MANA.smiteRadius * (1 + 0.015 * Math.sin(t * 17)); width = 0.13; dot = 0.11; fill = 0.3; spin = 0.5; dash = 0; danger = 1; break;
      case 'swat': ring = MANA.swatRadius; width = 0.1; dot = 0.05; fill = 0.12; spin = 7; dash = 8; break;
      default: break;
    }
    const r = mode === 'charge' || mode === 'armed' ? 16 : 12;
    this.rRing = approach(this.rRing, ring, r, dt);
    this.rWidth = approach(this.rWidth, width, 12, dt);
    this.rDot = approach(this.rDot, dot, 12, dt);
    this.rFill = approach(this.rFill, fill, 10, dt);
    this.rDanger = approach(this.rDanger, danger, 10, dt);
    this.rSpin = approach(this.rSpin, spin, 6, dt);
    U.uRing.value = this.rRing;
    U.uWidth.value = this.rWidth;
    U.uDot.value = this.rDot;
    U.uFill.value = this.rFill * (mode === 'armed' ? 0.7 + 0.3 * Math.sin(t * 17) : 1);
    U.uDangerK.value = this.rDanger;
    U.uDash.value = dash;
    U.uRot.value = (U.uRot.value as number) + dt * this.rSpin;
    U.uTime.value = t;
    U.uVis.value = this.vis;
  }
}

/** The player's giant translucent "god hands" floating over the board, casting shadows. */
export class HandViz {
  group = new THREE.Group();
  hands: OneHand[];
  /** `palettes`: [0, 1] for the local player, `opponentPalettes(f)` for an online opponent. */
  constructor(palettes: [number, number] = [0, 1]) {
    this.hands = palettes.map((p) => new OneHand(p));
    for (const h of this.hands) this.group.add(h.group);
  }
  update(hands: HandState[], stage: Stage, dt: number, t: number, modes: HandMode[], charges: number[], ground: (x: number, z: number) => number) {
    for (let i = 0; i < this.hands.length && i < hands.length; i++) {
      this.hands[i].update(hands[i], stage, dt, t, modes[i] ?? 'idle', charges[i] ?? 0, ground);
    }
  }
  /** World position of a hand's palm centre (for FX). */
  palm(i: number, out: THREE.Vector3) {
    const p = this.hands[i].pts;
    return out.copy(p[0]).add(p[5]).add(p[9]).add(p[17]).multiplyScalar(0.25);
  }
}
