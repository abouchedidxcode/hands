import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BASE_TYPES, factionColor, NEUTRAL, type BaseType } from '../config';
import type { Base } from '../game/types';

interface Kit { stone: THREE.BufferGeometry; roof: THREE.BufferGeometry; flagTop: number; flagScale: number; labelY: number }

function tx(g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) {
  g = g.toNonIndexed();
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function strip(g: THREE.BufferGeometry) {
  // ensure same attribute set for merging
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  return g;
}

function merge(list: THREE.BufferGeometry[]) {
  const m = mergeGeometries(list.map(strip), false)!;
  m.computeVertexNormals();
  return m;
}

function buildKits(): Record<BaseType, Kit> {
  // Village: platform + 3 cottages around a well/flag.
  const vStone: THREE.BufferGeometry[] = [tx(new THREE.CylinderGeometry(1.0, 1.08, 0.2, 9), 0, 0.1, 0)];
  const vRoof: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const x = Math.cos(a) * 0.52, z = Math.sin(a) * 0.52;
    const s = i === 0 ? 1.15 : 1;
    vStone.push(tx(new THREE.BoxGeometry(0.42 * s, 0.32 * s, 0.34 * s), x, 0.2 + 0.16 * s, z, -a));
    const roof = new THREE.CylinderGeometry(0.0, 0.3 * s, 0.46 * s, 3, 1);
    roof.rotateZ(Math.PI / 2);
    roof.rotateX(Math.PI / 6);
    roof.scale(1.1, 0.75, 1);
    vRoof.push(tx(roof, x, 0.2 + 0.32 * s + 0.12 * s, z, -a));
  }
  vStone.push(tx(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 5), 0, 0.85, 0));

  // Castle: keep, four towers, walls.
  const cStone: THREE.BufferGeometry[] = [tx(new THREE.CylinderGeometry(1.45, 1.55, 0.24, 10), 0, 0.12, 0)];
  const cRoof: THREE.BufferGeometry[] = [];
  cStone.push(tx(new THREE.BoxGeometry(0.8, 1.0, 0.8), 0, 0.74, 0));
  for (const [x, z] of [[-0.66, -0.66], [0.66, -0.66], [-0.66, 0.66], [0.66, 0.66]]) {
    cStone.push(tx(new THREE.CylinderGeometry(0.22, 0.25, 1.05, 8), x, 0.76, z));
    cRoof.push(tx(new THREE.ConeGeometry(0.3, 0.46, 8), x, 1.5, z));
  }
  cStone.push(tx(new THREE.BoxGeometry(1.32, 0.52, 0.14), 0, 0.5, -0.66));
  cStone.push(tx(new THREE.BoxGeometry(1.32, 0.52, 0.14), 0, 0.5, 0.66));
  cStone.push(tx(new THREE.BoxGeometry(0.14, 0.52, 1.32), -0.66, 0.5, 0));
  cStone.push(tx(new THREE.BoxGeometry(0.14, 0.52, 1.32), 0.66, 0.5, 0));
  cRoof.push(tx(new THREE.ConeGeometry(0.66, 0.6, 4), 0, 1.54, 0, Math.PI / 4));
  cStone.push(tx(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 5), 0, 2.2, 0));

  // Tower: tall round tower with battlements.
  const tStone: THREE.BufferGeometry[] = [tx(new THREE.CylinderGeometry(0.95, 1.02, 0.2, 9), 0, 0.1, 0)];
  tStone.push(tx(new THREE.CylinderGeometry(0.34, 0.42, 1.7, 9), 0, 1.05, 0));
  tStone.push(tx(new THREE.CylinderGeometry(0.5, 0.42, 0.24, 9), 0, 1.96, 0));
  const tRoof = [tx(new THREE.ConeGeometry(0.52, 0.7, 9), 0, 2.43, 0)];
  tStone.push(tx(new THREE.CylinderGeometry(0.035, 0.035, 0.6, 5), 0, 3.0, 0));

  return {
    village: { stone: merge(vStone), roof: merge(vRoof), flagTop: 1.5, flagScale: 0.8, labelY: 2.15 },
    castle: { stone: merge(cStone), roof: merge(cRoof), flagTop: 2.62, flagScale: 1.2, labelY: 3.3 },
    tower: { stone: merge(tStone), roof: merge(tRoof), flagTop: 3.27, flagScale: 0.9, labelY: 3.9 },
  };
}

class Label {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  sprite: THREE.Sprite;
  private shown = -999;
  private color = '';
  constructor() {
    this.canvas.width = 160; this.canvas.height = 80;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(1.5, 0.75, 1);
    this.sprite.renderOrder = 50;
  }
  set(n: number, color: string, neutral: boolean) {
    if (n === this.shown && color === this.color) return;
    this.shown = n; this.color = color;
    const c = this.ctx;
    c.clearRect(0, 0, 160, 80);
    const txt = String(n);
    c.font = '900 52px "Rubik", "Segoe UI", system-ui, sans-serif';
    const w = Math.max(64, c.measureText(txt).width + 34);
    const x = (160 - w) / 2;
    c.fillStyle = neutral ? 'rgba(30,28,26,0.72)' : 'rgba(8,16,24,0.78)';
    roundRect(c, x, 10, w, 60, 30);
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = color;
    c.stroke();
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(txt, 80, 42);
    this.tex.needsUpdate = true;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export interface Highlight { hover: Set<number>; selected: Set<number>; target: Set<number> }

interface View {
  base: Base;
  group: THREE.Group;
  body: THREE.Group;
  roofMat: THREE.MeshStandardMaterial;
  flagMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshBasicMaterial;
  selMat: THREE.MeshBasicMaterial;
  sel: THREE.Mesh;
  flag: THREE.Mesh;
  range?: THREE.Mesh;
  rangeMat?: THREE.MeshBasicMaterial;
  label: Label;
  owner: number;
  pop: number;
  y: number;
  kit: Kit;
}

const stoneMat = new THREE.MeshStandardMaterial({ color: '#d8cdb8', roughness: 0.9, flatShading: true });
const darkStone = new THREE.MeshStandardMaterial({ color: '#8f8676', roughness: 1, flatShading: true });

export class BaseViews {
  group = new THREE.Group();
  private kits = buildKits();
  private views: View[] = [];
  private flagGeo = (() => { const g = new THREE.PlaneGeometry(0.62, 0.38, 6, 1); g.translate(0.31, 0, 0); return g; })();
  private ringGeo = new THREE.RingGeometry(0.86, 1.0, 48, 1);
  private selGeo = new THREE.RingGeometry(0.8, 1.0, 64, 1);
  private tmpColor = new THREE.Color();

  constructor(private heightAt: (x: number, z: number) => number) {}

  build(bases: Base[]) {
    this.dispose();
    for (const b of bases) {
      const kit = this.kits[b.type];
      const g = new THREE.Group();
      const y = this.heightAt(b.x, b.z);
      g.position.set(b.x, y, b.z);
      g.rotation.y = (b.id * 1.37) % (Math.PI * 2);
      const body = new THREE.Group();
      g.add(body);
      const scale = b.radius / BASE_TYPES[b.type].radius;
      body.scale.setScalar(scale);
      const stone = new THREE.Mesh(kit.stone, b.type === 'tower' ? darkStone : stoneMat);
      stone.castShadow = true; stone.receiveShadow = true;
      const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.6, flatShading: true });
      const roof = new THREE.Mesh(kit.roof, roofMat);
      roof.castShadow = true;
      const flagMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7, emissiveIntensity: 0.6 });
      const flag = new THREE.Mesh(this.flagGeo, flagMat);
      flag.position.y = kit.flagTop;
      flag.scale.setScalar(kit.flagScale);
      flag.castShadow = true;
      body.add(stone, roof, flag);

      const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      ring.scale.setScalar(b.radius * 1.28);
      g.add(ring);

      const selMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const sel = new THREE.Mesh(this.selGeo, selMat);
      sel.rotation.x = -Math.PI / 2;
      sel.position.y = 0.06;
      sel.scale.setScalar(b.radius * 1.6);
      g.add(sel);

      let range: THREE.Mesh | undefined, rangeMat: THREE.MeshBasicMaterial | undefined;
      if (b.type === 'tower') {
        rangeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, toneMapped: false, depthWrite: false });
        range = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 64, 1), rangeMat);
        range.rotation.x = -Math.PI / 2;
        range.position.y = 0.05;
        range.scale.setScalar(BASE_TYPES.tower.range!);
        g.add(range);
      }

      const label = new Label();
      label.sprite.position.set(b.x, y + kit.labelY * scale, b.z);
      this.group.add(label.sprite);

      this.group.add(g);
      const v: View = { base: b, group: g, body, roofMat, flagMat, ringMat, selMat, sel, flag, range, rangeMat, label, owner: -99, pop: 0, y, kit };
      this.applyOwner(v);
      this.views.push(v);
    }
  }

  private applyOwner(v: View) {
    const o = v.base.owner;
    v.owner = o;
    const col = factionColor(o);
    const neutral = o === NEUTRAL;
    v.roofMat.color.set(neutral ? '#8a8378' : col);
    v.roofMat.emissive.set(neutral ? '#000000' : col);
    v.roofMat.emissiveIntensity = neutral ? 0 : 0.12;
    v.flagMat.color.set(neutral ? '#d8d2c4' : col);
    v.flagMat.emissive.set(neutral ? '#000000' : col);
    v.flagMat.emissiveIntensity = neutral ? 0 : 0.5;
    v.flag.visible = true;
    this.tmpColor.set(col);
    if (!neutral) this.tmpColor.multiplyScalar(1.6);
    v.ringMat.color.copy(this.tmpColor);
    v.ringMat.opacity = neutral ? 0.35 : 0.95;
    if (v.rangeMat) v.rangeMat.color.set(col);
  }

  /** Bump a base (capture). */
  pop(id: number) { const v = this.views[id]; if (v) v.pop = 1; }

  labelPos(id: number): THREE.Vector3 | null {
    const v = this.views[id];
    return v ? v.label.sprite.position : null;
  }

  update(dt: number, t: number, simTime: number, hl: Highlight) {
    for (const v of this.views) {
      const b = v.base;
      if (b.owner !== v.owner) { this.applyOwner(v); v.pop = 1; }
      v.label.set(Math.floor(b.troops), factionColor(b.owner), b.owner === NEUTRAL);

      // capture pop + hit wobble
      v.pop = Math.max(0, v.pop - dt * 1.6);
      const p = v.pop;
      const s = 1 + Math.sin(p * Math.PI * 3) * p * 0.25;
      const sinceHit = simTime - b.lastHit;
      const wob = sinceHit < 0.25 ? (0.25 - sinceHit) * 0.25 : 0;
      v.body.scale.setScalar((b.radius / BASE_TYPES[b.type].radius) * s);
      v.body.position.x = (Math.random() - 0.5) * wob;
      v.body.position.z = (Math.random() - 0.5) * wob;
      v.flag.rotation.y = Math.sin(t * 3 + b.id) * 0.35 - 0.2;
      v.flag.rotation.z = Math.sin(t * 5.3 + b.id * 2) * 0.05;

      // label pulses when it ticks up, grows with garrison
      const ls = 1 + Math.min(0.45, b.troops / 160) + p * 0.4;
      v.label.sprite.scale.set(1.5 * ls, 0.75 * ls, 1);

      // selection / hover ring
      const sel = hl.selected.has(b.id), hov = hl.hover.has(b.id), tgt = hl.target.has(b.id);
      const want = sel ? 1 : tgt ? 0.95 : hov ? 0.55 : 0;
      v.selMat.opacity += (want - v.selMat.opacity) * Math.min(1, dt * 14);
      if (tgt) v.selMat.color.set(b.owner === 0 ? '#9cf6ff' : '#ffd2d2');
      else v.selMat.color.set('#c8fbff');
      const pulse = 1 + Math.sin(t * 8) * 0.05 * (sel || tgt ? 1 : 0);
      v.sel.scale.setScalar(b.radius * 1.6 * pulse);
      v.sel.rotation.z += dt * 0.6;

      if (v.rangeMat) v.rangeMat.opacity = b.owner === NEUTRAL ? 0 : 0.18 + (hov || sel ? 0.25 : 0);
    }
  }

  dispose() {
    for (const v of this.views) {
      v.roofMat.dispose(); v.flagMat.dispose(); v.ringMat.dispose(); v.selMat.dispose(); v.rangeMat?.dispose();
      v.range?.geometry.dispose();
      v.label.tex.dispose(); (v.label.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.views = [];
    this.group.clear();
  }
}
