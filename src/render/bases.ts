import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BASE_TYPES, factionColor, NEUTRAL } from '../config';
import type { Base } from '../game/types';
import { buildModel, flagGeometry, flagTime, makeFlagMaterial } from './basesKit';
import { Label } from './basesLabel';

export interface Highlight { hover: Set<number>; selected: Set<number>; target: Set<number> }

// ------------------------------------------------------------------ shared resources
const stoneOwned = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: true });
const stoneNeutral = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, color: '#aaa294' });
const NEUTRAL_ROOF = '#857261';
const NEUTRAL_FLAG = '#cbbfa8';

function radialTexture(stops: [number, number][]) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [p, a] of stops) g.addColorStop(p, `rgba(255,255,255,${a})`);
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** ring made of `n` dashes (fraction `fill` of each period) */
function dashedRing(inner: number, outer: number, n: number, fill: number) {
  const parts: THREE.BufferGeometry[] = [];
  const per = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) parts.push(new THREE.RingGeometry(inner, outer, 6, 1, i * per, per * fill).toNonIndexed());
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  g.rotateX(-Math.PI / 2);
  return g;
}

function flatRing(inner: number, outer: number, seg = 72) {
  const g = new THREE.RingGeometry(inner, outer, seg, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** target reticle: thick ring + 4 inward-pointing chevrons */
function reticle() {
  const parts: THREE.BufferGeometry[] = [new THREE.RingGeometry(0.86, 1.0, 72, 1).toNonIndexed()];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const s = new THREE.Shape();
    // chevron pointing toward the centre, sitting just outside the ring
    s.moveTo(1.08, 0); s.lineTo(1.42, 0.2); s.lineTo(1.32, 0); s.lineTo(1.42, -0.2); s.lineTo(1.08, 0);
    const g = new THREE.ShapeGeometry(s).toNonIndexed();
    g.rotateZ(a);
    parts.push(g);
  }
  for (const p of parts) for (const k of Object.keys(p.attributes)) if (k !== 'position') p.deleteAttribute(k);
  const g = mergeGeometries(parts)!;
  g.rotateX(-Math.PI / 2);
  return g;
}

interface View {
  base: Base;
  group: THREE.Group;
  body: THREE.Group;
  stone: THREE.Mesh;
  tintMat: THREE.MeshStandardMaterial;
  flag: THREE.Mesh;
  flagMat: THREE.MeshStandardMaterial;
  disc: THREE.Mesh;
  discMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  sel: THREE.Mesh;
  selMat: THREE.MeshBasicMaterial;
  tgt: THREE.Mesh;
  tgtMat: THREE.MeshBasicMaterial;
  ripple: THREE.Mesh;
  rippleMat: THREE.MeshBasicMaterial;
  range?: THREE.Mesh;
  rangeMat?: THREE.MeshBasicMaterial;
  label: Label;
  geos: THREE.BufferGeometry[];
  owner: number;
  popAge: number;
  tick: number;
  scale: number;
  y: number;
  labelY: number;
  tintTarget: THREE.Color;
  ringTarget: THREE.Color;
  selAmt: number;
  tgtAmt: number;
}

export class BaseViews {
  group = new THREE.Group();
  private views: View[] = [];
  private flagGeo = flagGeometry(false);
  private ragGeo = flagGeometry(true);
  private discTex = radialTexture([[0, 0.2], [0.55, 0.26], [0.8, 0.5], [0.9, 0.42], [1, 0]]);
  private discGeo = (() => { const g = new THREE.CircleGeometry(1, 48); g.rotateX(-Math.PI / 2); return g; })();
  private ringGeo = flatRing(0.95, 1.0);
  private neutralRingGeo = dashedRing(0.95, 1.0, 20, 0.55);
  private selGeo = dashedRing(0.88, 1.0, 14, 0.62);
  private tgtGeo = reticle();
  private rippleGeo = flatRing(0.93, 1.0);
  private rangeGeo = dashedRing(0.985, 1.0, 48, 0.5);
  private tmpColor = new THREE.Color();

  constructor(private heightAt: (x: number, z: number) => number) {}

  build(bases: Base[]) {
    this.dispose();
    for (const b of bases) {
      const model = buildModel(b.type, b.id * 7919 + Math.round(b.x * 13) + Math.round(b.z * 31) * 3);
      const g = new THREE.Group();
      const y = this.heightAt(b.x, b.z);
      g.position.set(b.x, y, b.z);
      const body = new THREE.Group();
      body.rotation.y = model.yaw;
      g.add(body);
      const scale = b.radius / BASE_TYPES[b.type].radius;
      body.scale.setScalar(scale);

      const stone = new THREE.Mesh(model.stone, stoneOwned);
      stone.castShadow = true; stone.receiveShadow = true;
      const tintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, flatShading: true });
      const tint = new THREE.Mesh(model.tint, tintMat);
      tint.castShadow = true; tint.receiveShadow = true;
      const flagMat = makeFlagMaterial();
      const flag = new THREE.Mesh(this.flagGeo, flagMat);
      flag.position.copy(model.flagPos);
      flag.scale.setScalar(model.flagScale);
      flag.rotation.y = -model.yaw + 0.5; // stream toward screen-right, readable from the camera
      flag.castShadow = true;
      body.add(stone, tint, flag);

      const R = b.radius;
      const discMat = new THREE.MeshBasicMaterial({ map: this.discTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 1 });
      const disc = new THREE.Mesh(this.discGeo, discMat);
      disc.position.y = 0.03; disc.scale.setScalar(R * 1.85); disc.renderOrder = 1;
      const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      ring.position.y = 0.05; ring.scale.setScalar(R * 1.6); ring.renderOrder = 2;

      const selMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const sel = new THREE.Mesh(this.selGeo, selMat);
      sel.position.y = 0.07; sel.scale.setScalar(R * 1.85); sel.renderOrder = 3; sel.visible = false;
      const tgtMat = new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const tgt = new THREE.Mesh(this.tgtGeo, tgtMat);
      tgt.position.y = 0.08; tgt.scale.setScalar(R * 1.9); tgt.renderOrder = 4; tgt.visible = false;
      const rippleMat = new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const ripple = new THREE.Mesh(this.rippleGeo, rippleMat);
      ripple.position.y = 0.08; ripple.renderOrder = 4; ripple.visible = false;
      g.add(disc, ring, sel, tgt, ripple);

      let range: THREE.Mesh | undefined, rangeMat: THREE.MeshBasicMaterial | undefined;
      if (b.type === 'tower') {
        rangeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, toneMapped: false, depthWrite: false });
        range = new THREE.Mesh(this.rangeGeo, rangeMat);
        range.position.y = 0.06;
        range.scale.setScalar(BASE_TYPES.tower.range!);
        range.renderOrder = 2;
        g.add(range);
      }

      const label = new Label();
      label.sprite.position.set(b.x, y + model.labelY * scale, b.z);
      this.group.add(label.sprite);

      this.group.add(g);
      const v: View = {
        base: b, group: g, body, stone, tintMat, flag, flagMat, disc, discMat, ring, ringMat, sel, selMat, tgt, tgtMat, ripple, rippleMat,
        range, rangeMat, label, geos: [model.stone, model.tint], owner: -99, popAge: 99, tick: 0, scale, y, labelY: model.labelY * scale,
        tintTarget: new THREE.Color(), ringTarget: new THREE.Color(), selAmt: 0, tgtAmt: 0,
      };
      this.applyOwner(v, true);
      this.views.push(v);
    }
  }

  private applyOwner(v: View, instant = false) {
    const o = v.base.owner;
    v.owner = o;
    const col = factionColor(o);
    const neutral = o === NEUTRAL;
    v.stone.material = neutral ? stoneNeutral : stoneOwned;
    v.tintTarget.set(neutral ? NEUTRAL_ROOF : col);
    if (instant) v.tintMat.color.copy(v.tintTarget);
    v.tintMat.emissive.set(neutral ? '#000000' : col);
    v.tintMat.emissiveIntensity = neutral ? 0 : 0.16;
    v.flag.geometry = neutral ? this.ragGeo : this.flagGeo;
    v.flagMat.color.set(neutral ? NEUTRAL_FLAG : col);
    v.flagMat.emissive.set(neutral ? '#000000' : col);
    v.flagMat.emissiveIntensity = neutral ? 0 : 0.35;
    v.ring.geometry = neutral ? this.neutralRingGeo : this.ringGeo;
    this.tmpColor.set(col);
    if (!neutral) this.tmpColor.multiplyScalar(1.25);
    v.ringTarget.copy(this.tmpColor);
    v.ringMat.color.copy(this.tmpColor);
    v.ringMat.opacity = neutral ? 0.55 : 1;
    v.discMat.color.set(neutral ? '#000000' : col);
    v.discMat.opacity = neutral ? 0.22 : 0.85;
    if (v.rangeMat) v.rangeMat.color.set(col);
  }

  /** Bump a base (capture). */
  pop(id: number) { const v = this.views[id]; if (v && v.popAge > 0.2) v.popAge = 0; }

  labelPos(id: number): THREE.Vector3 | null {
    const v = this.views[id];
    return v ? v.label.sprite.position : null;
  }

  update(dt: number, t: number, simTime: number, hl: Highlight) {
    flagTime.value = t;
    const k = Math.min(1, dt * 12);
    for (const v of this.views) {
      const b = v.base;
      if (b.owner !== v.owner) { this.applyOwner(v); v.popAge = 0; }
      const neutral = b.owner === NEUTRAL;
      v.popAge += dt;
      v.tintMat.color.lerp(v.tintTarget, Math.min(1, dt * 9));

      // ---- label: tick pulse when the garrison grows, red flash when hit
      const n = Math.floor(b.troops);
      if (n > v.label.shown && v.label.shown >= 0 && v.popAge > 0.3) v.tick = 1;
      v.label.shown = n;
      const sinceHit = simTime - b.lastHit;
      const hit = sinceHit >= 0 && sinceHit < 0.16;
      const col = factionColor(b.owner);
      this.tmpColor.set(col).multiplyScalar(0.55);
      v.label.set(n, col, '#' + this.tmpColor.getHexString(), hit ? 2 : neutral ? 1 : 0);
      v.tick = Math.max(0, v.tick - dt * 5);

      // ---- capture pop: squash & stretch bounce
      const age = v.popAge;
      const A = age < 1.2 ? Math.sin(age * 15) * Math.exp(-age * 4.2) * 0.3 : 0;
      const grow = age < 0.12 ? 0.75 + (age / 0.12) * 0.25 : 1;
      const sy = (1 + A) * grow, sxz = (1 - A * 0.45) * grow;
      v.body.scale.set(v.scale * sxz, v.scale * sy, v.scale * sxz);
      // hit shake
      const wob = sinceHit >= 0 && sinceHit < 0.3 ? (0.3 - sinceHit) * 0.22 : 0;
      v.body.position.x = Math.sin(t * 61 + b.id) * wob;
      v.body.position.z = Math.cos(t * 53 + b.id * 2) * wob;

      const lp = Math.max(0, A) * 0.9 + (age < 0.3 ? (0.3 - age) : 0);
      const ls = (1 + Math.min(0.3, b.troops / 260) + v.tick * 0.14 + lp + (hit ? 0.1 : 0)) ;
      v.label.sprite.scale.set(Label.W * ls, Label.W * 0.5 * ls, 1);
      v.label.sprite.position.y = v.y + v.labelY + wob * 0.5;

      // ---- ownership ring: flash white when hit, breathe gently
      if (wob > 0) v.ringMat.color.setRGB(1.6, 0.5, 0.5);
      else v.ringMat.color.lerp(v.ringTarget, k);
      v.discMat.opacity = neutral ? 0.22 : 0.75 + Math.sin(t * 2 + b.id) * 0.1;

      // ---- selection / hover / target
      const sel = hl.selected.has(b.id), hov = hl.hover.has(b.id), tgt = hl.target.has(b.id);
      const wantSel = sel ? 1 : hov && !tgt ? 0.6 : 0;
      v.selAmt += (wantSel - v.selAmt) * Math.min(1, dt * 16);
      v.sel.visible = v.selAmt > 0.01;
      if (v.sel.visible) {
        v.selMat.opacity = v.selAmt;
        v.selMat.color.set(sel ? '#bff8ff' : '#e8fdff');
        v.sel.rotation.y += dt * (sel ? 1.4 : 0.5);
        v.sel.scale.setScalar(b.radius * (sel ? 1.8 + Math.sin(t * 9) * 0.04 : 1.9));
      }
      v.tgtAmt += ((tgt ? 1 : 0) - v.tgtAmt) * Math.min(1, dt * 18);
      v.tgt.visible = v.ripple.visible = v.tgtAmt > 0.01;
      if (v.tgt.visible) {
        const friendly = b.owner === 0;
        const c = friendly ? '#7ff3ff' : '#ffd84a';
        v.tgtMat.color.set(c); v.rippleMat.color.set(c);
        v.tgtMat.opacity = v.tgtAmt;
        // reticle breathes inward
        const ph = (t * 1.6) % 1;
        v.tgt.scale.setScalar(b.radius * (2.0 - 0.12 * Math.sin(t * 10)) * (0.6 + 0.4 * v.tgtAmt));
        v.tgt.rotation.y -= dt * 1.2;
        // ripple collapses toward the base
        v.ripple.scale.setScalar(b.radius * (3.1 - ph * 1.5));
        v.rippleMat.opacity = v.tgtAmt * ph * 0.9;
      }

      if (v.rangeMat) v.rangeMat.opacity = neutral ? 0 : 0.28 + (hov || sel ? 0.4 : 0);
      if (v.range) v.range.rotation.y += dt * 0.08;
    }
  }

  dispose() {
    for (const v of this.views) {
      v.tintMat.dispose(); v.flagMat.dispose(); v.discMat.dispose(); v.ringMat.dispose(); v.selMat.dispose();
      v.tgtMat.dispose(); v.rippleMat.dispose(); v.rangeMat?.dispose();
      for (const g of v.geos) g.dispose();
      v.label.dispose();
    }
    this.views = [];
    this.group.clear();
  }
}
