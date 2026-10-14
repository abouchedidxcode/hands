import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BaseType } from '../config';

/**
 * Procedural low-poly miniatures for bases. Each base gets two merged geometries:
 *  - `stone`: everything that is NOT faction coloured (vertex colours = real colours)
 *  - `tint`:  roofs / banners / trims (vertex colours = shade multipliers, material colour = owner)
 * plus a flag (separate, animated in the vertex shader).
 */

export interface BaseModel {
  stone: THREE.BufferGeometry;
  tint: THREE.BufferGeometry;
  flagPos: THREE.Vector3;
  flagScale: number;
  labelY: number;
  /** yaw applied to the whole model */
  yaw: number;
}

// ------------------------------------------------------------------ palette (sRGB hex)
const C = {
  plinth: '#a08c6a',
  plinthDark: '#857257',
  stone: '#e6dbc3',
  stoneMid: '#cfc2a6',
  stoneShade: '#b9ab8f',
  towerStone: '#c4beb2',
  towerDark: '#9d968a',
  courtyard: '#cdb68b',
  dirt: '#b99d6b',
  wood: '#8a5a34',
  woodDark: '#5d3a21',
  opening: '#2f241d',
  plaster: '#f4ead4',
  plasterWarm: '#efdcbc',
  wheat: '#e8c95a',
  crops: '#8fbf4a',
  soil: '#7f603f',
  hay: '#e9c46a',
  water: '#3e8fb3',
  gold: '#ffd36b',
  rock: '#8e877c',
};

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmpC = new THREE.Color();

class Builder {
  parts: THREE.BufferGeometry[] = [];
  /** add a primitive with a flat colour (sRGB hex or grey multiplier number) */
  add(g: THREE.BufferGeometry, color: string | number, x = 0, y = 0, z = 0, ry = 0) {
    let n = g.index ? g.toNonIndexed() : g;
    if (n === g) n = g.clone();
    g.dispose();
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    if (ry) n.rotateY(ry);
    n.translate(x, y, z);
    if (typeof color === 'number') tmpC.setRGB(color, color, color);
    else tmpC.set(color);
    const cnt = n.attributes.position.count;
    const arr = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { arr[i * 3] = tmpC.r; arr[i * 3 + 1] = tmpC.g; arr[i * 3 + 2] = tmpC.b; }
    n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(n);
    return n;
  }
  build() {
    const m = this.parts.length ? mergeGeometries(this.parts, false)! : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    m.computeVertexNormals();
    m.computeBoundingSphere();
    return m;
  }
}

// ------------------------------------------------------------------ primitive helpers
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
function pyramid(r: number, h: number) { const g = new THREE.ConeGeometry(r, h, 4); g.rotateY(Math.PI / 4); return g; }
/** square tapered shaft */
function sqTaper(top: number, bottom: number, h: number) { const g = new THREE.CylinderGeometry(top, bottom, h, 4); g.rotateY(Math.PI / 4); return g; }

/** gable roof (triangular prism), ridge along Z, base at y=0 */
function gable(w: number, h: number, len: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  return g;
}

/** a ring of merlons around a circle */
function merlonRing(b: Builder, color: string, r: number, y: number, n: number, size = 0.08, h = 0.11) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.add(box(size, h, size * 0.9), color, Math.cos(a) * r, y + h / 2, Math.sin(a) * r, -a);
  }
}

/** merlons along a straight wall segment from (x0,z0) to (x1,z1) */
function merlonLine(b: Builder, color: string, x0: number, z0: number, x1: number, z1: number, y: number, step = 0.19) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.floor(len / step));
  const ang = Math.atan2(z1 - z0, x1 - x0);
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0.5 : i / n;
    b.add(box(0.1, 0.12, 0.09), color, x0 + (x1 - x0) * t, y + 0.06, z0 + (z1 - z0) * t, -ang);
  }
}

// ------------------------------------------------------------------ castle
function castle(seed: number): BaseModel {
  const r = rng(seed);
  const S = new Builder(), T = new Builder();
  const P = 0.16; // plinth top
  S.add(cyl(1.28, 1.4, 0.1, 12), C.plinthDark, 0, 0.05, 0);
  S.add(cyl(1.16, 1.26, 0.08, 12), C.plinth, 0, 0.12, 0);
  S.add(box(1.5, 0.03, 1.5), C.courtyard, 0, P + 0.01, 0);

  const a = 0.78, wallH = 0.5, wt = 0.17;
  // curtain walls (front split for the gate)
  S.add(box(2 * a, wallH, wt), C.stoneMid, 0, P + wallH / 2, -a);
  S.add(box(wt, wallH, 2 * a), C.stoneMid, -a, P + wallH / 2, 0);
  S.add(box(wt, wallH, 2 * a), C.stoneMid, a, P + wallH / 2, 0);
  S.add(box(a - 0.22, wallH, wt), C.stoneMid, -(a + 0.22) / 2, P + wallH / 2, a);
  S.add(box(a - 0.22, wallH, wt), C.stoneMid, (a + 0.22) / 2, P + wallH / 2, a);
  // stone course (darker foot)
  S.add(box(2 * a + 0.06, 0.1, 2 * a + 0.06), C.stoneShade, 0, P + 0.05, 0);
  const wy = P + wallH;
  merlonLine(S, C.stone, -a, -a - 0.05, a, -a - 0.05, wy);
  merlonLine(S, C.stone, -a - 0.05, -a, -a - 0.05, a, wy);
  merlonLine(S, C.stone, a + 0.05, -a, a + 0.05, a, wy);
  merlonLine(S, C.stone, -a, a + 0.05, -0.3, a + 0.05, wy);
  merlonLine(S, C.stone, 0.3, a + 0.05, a, a + 0.05, wy);

  // corner towers with conical roofs
  for (const [x, z] of [[-a, -a], [a, -a], [-a, a], [a, a]]) {
    const th = 0.95 + (z < 0 ? 0.12 : 0);
    S.add(cyl(0.25, 0.29, th, 8), C.stone, x, P + th / 2, z);
    S.add(cyl(0.31, 0.27, 0.12, 8), C.stoneMid, x, P + th + 0.06, z);
    T.add(cone(0.36, 0.62, 8), 1, x, P + th + 0.12 + 0.31, z);
    T.add(cyl(0.36, 0.36, 0.035, 8), 0.72, x, P + th + 0.13, z); // roof eave trim
    S.add(cone(0.035, 0.12, 5), C.gold, x, P + th + 0.12 + 0.66, z);
    // arrow slit facing outwards
    const ox = Math.sign(x) * 0.27, oz = Math.sign(z) * 0.27;
    S.add(box(0.05, 0.16, 0.05), C.opening, x + ox * 0.75, P + th * 0.6, z + oz * 0.75);
  }

  // gatehouse (front, +z)
  for (const sx of [-1, 1]) {
    S.add(box(0.26, 0.82, 0.34), C.stone, sx * 0.29, P + 0.41, a + 0.02);
    T.add(pyramid(0.25, 0.34), 1, sx * 0.29, P + 0.82 + 0.17, a + 0.02);
  }
  S.add(box(0.36, 0.22, 0.3), C.stoneMid, 0, P + 0.6, a + 0.02);
  S.add(box(0.3, 0.42, 0.04), C.opening, 0, P + 0.21, a + 0.18);
  S.add(box(0.36, 0.05, 0.05), C.woodDark, 0, P + 0.44, a + 0.19);
  T.add(box(0.12, 0.32, 0.02), 0.95, -0.29, P + 0.5, a + 0.2); // gate banners
  T.add(box(0.12, 0.32, 0.02), 0.95, 0.29, P + 0.5, a + 0.2);

  // keep
  const kx = 0, kz = -0.18, kw = 0.8, kd = 0.72, kh = 1.3;
  S.add(box(kw, kh, kd), C.stone, kx, P + kh / 2, kz);
  S.add(box(kw + 0.06, 0.08, kd + 0.06), C.stoneShade, kx, P + kh, kz);
  T.add(pyramid(0.66, 0.78), 1, kx, P + kh + 0.04 + 0.39, kz);
  T.add(box(kw + 0.12, 0.04, kd + 0.12), 0.7, kx, P + kh + 0.05, kz);
  // windows & long banners on the front of the keep
  const fz = kz + kd / 2 + 0.01;
  S.add(box(0.1, 0.17, 0.03), C.opening, 0, P + 1.0, fz);
  S.add(box(0.14, 0.22, 0.03), C.opening, 0, P + 0.62, fz);
  T.add(box(0.16, 0.5, 0.025), 1, -0.27, P + 0.85, fz + 0.01);
  T.add(box(0.16, 0.5, 0.025), 1, 0.27, P + 0.85, fz + 0.01);
  S.add(box(0.2, 0.03, 0.03), C.woodDark, -0.27, P + 1.1, fz + 0.02);
  S.add(box(0.2, 0.03, 0.03), C.woodDark, 0.27, P + 1.1, fz + 0.02);
  // keep turret (asymmetry)
  const tx = r() < 0.5 ? -0.38 : 0.38;
  S.add(cyl(0.15, 0.16, 0.55, 7), C.stone, tx, P + kh + 0.1, kz - 0.32);
  T.add(cone(0.2, 0.48, 7), 1, tx, P + kh + 0.38 + 0.24, kz - 0.32);
  // small hall in the courtyard
  const hx = tx > 0 ? -0.42 : 0.42;
  S.add(box(0.3, 0.24, 0.3), C.plaster, hx, P + 0.12, 0.38);
  T.add(gable(0.38, 0.2, 0.36), 0.88, hx, P + 0.24, 0.38);
  // flag pole on the keep
  const poleTop = P + kh + 0.82 + 0.7;
  S.add(cyl(0.025, 0.03, 0.85, 5), C.woodDark, kx, poleTop - 0.42, kz);
  S.add(new THREE.IcosahedronGeometry(0.05, 0), C.gold, kx, poleTop + 0.03, kz);

  return { stone: S.build(), tint: T.build(), flagPos: new THREE.Vector3(kx, poleTop - 0.02, kz), flagScale: 1.25, labelY: 3.25, yaw: (r() - 0.5) * 0.5 };
}

// ------------------------------------------------------------------ village
function cottage(S: Builder, T: Builder, r: () => number, x: number, z: number, ang: number, big: boolean) {
  const w = big ? 0.48 : 0.34 + r() * 0.1;
  const d = big ? 0.4 : 0.28 + r() * 0.08;
  const h = big ? 0.42 : 0.22 + r() * 0.08;
  const rh = big ? 0.32 : 0.2 + r() * 0.06;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // local → world (rotate around Y by ang). Door faces local +z.
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * ca + lz * sa, ly, z - lx * sa + lz * ca];
  const wall = r() < 0.5 ? C.plaster : C.plasterWarm;
  let p = P(0, 0.06, 0); S.add(box(w + 0.03, 0.08, d + 0.03), C.woodDark, p[0], 0.06 + 0.02, p[2], ang);
  p = P(0, 0, 0); S.add(box(w, h, d), wall, p[0], 0.06 + h / 2, p[2], ang);
  // timber corner posts
  for (const sx of [-1, 1]) {
    p = P(sx * (w / 2), 0, d / 2); S.add(box(0.035, h, 0.035), C.wood, p[0], 0.06 + h / 2, p[2], ang);
  }
  // door + window
  p = P(-w * 0.18, 0, d / 2 + 0.01); S.add(box(0.09, 0.15, 0.02), C.woodDark, p[0], 0.06 + 0.075, p[2], ang);
  p = P(w * 0.22, 0, d / 2 + 0.01); S.add(box(0.07, 0.07, 0.02), C.opening, p[0], 0.06 + h * 0.62, p[2], ang);
  if (big) { p = P(-w * 0.18, 0, d / 2 + 0.01); S.add(box(0.07, 0.07, 0.02), C.opening, p[0], 0.06 + h * 0.75, p[2], ang); }
  // gable roof; ridge runs along local x so the long side faces the front
  const roof = gable(d + 0.12, rh, w + 0.1);
  roof.rotateY(Math.PI / 2);
  p = P(0, 0, 0); T.add(roof, big ? 1 : 0.9 + r() * 0.1, p[0], 0.06 + h, p[2], ang);
  // chimney
  if (big || r() < 0.6) {
    p = P(w * 0.28, 0, -d * 0.18); S.add(box(0.07, rh + 0.12, 0.07), C.stoneMid, p[0], 0.06 + h + (rh + 0.12) / 2, p[2], ang);
  }
}

function village(seed: number): BaseModel {
  const r = rng(seed);
  const S = new Builder(), T = new Builder();
  S.add(cyl(0.98, 1.05, 0.06, 11), C.plinthDark, 0, 0.03, 0);
  S.add(cyl(0.9, 0.98, 0.05, 11), C.dirt, 0, 0.07, 0);

  const n = 3 + Math.floor(r() * 3); // 3..5 cottages
  const start = r() * Math.PI * 2;
  const bigIdx = Math.floor(r() * n);
  const angles: number[] = [];
  for (let i = 0; i < n; i++) angles.push(start + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.4);
  for (let i = 0; i < n; i++) {
    const a = angles[i];
    const rad = (i === bigIdx ? 0.5 : 0.6) + (r() - 0.5) * 0.08;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    // door faces the village centre
    const face = Math.atan2(-x, -z);
    cottage(S, T, r, x, z, face, i === bigIdx);
  }
  // fields in the biggest gap between cottages
  let gapA = 0, gapW = 0;
  for (let i = 0; i < n; i++) {
    const a0 = angles[i], a1 = angles[(i + 1) % n] + (i + 1 === n ? Math.PI * 2 : 0);
    if (a1 - a0 > gapW) { gapW = a1 - a0; gapA = (a0 + a1) / 2; }
  }
  {
    const fx = Math.cos(gapA) * 0.66, fz = Math.sin(gapA) * 0.66;
    const fa = -gapA + Math.PI / 2;
    S.add(box(0.5, 0.03, 0.34), C.soil, fx, 0.1, fz, fa);
    const crop = r() < 0.5 ? C.wheat : C.crops;
    const ca = Math.cos(fa), sa = Math.sin(fa);
    for (let k = -1; k <= 1; k++) {
      const lz = k * 0.1;
      S.add(box(0.44, 0.06, 0.06), crop, fx + lz * sa, 0.13, fz + lz * ca, fa);
    }
    // little fence posts at the field corners
    for (const [lx, lz] of [[-0.27, -0.19], [0.27, -0.19], [-0.27, 0.19], [0.27, 0.19]]) {
      S.add(box(0.03, 0.12, 0.03), C.wood, fx + lx * ca + lz * sa, 0.15, fz - lx * sa + lz * ca);
    }
  }
  // haystacks
  const hayA = gapA + Math.PI + (r() - 0.5) * 0.6;
  S.add(cone(0.1, 0.16, 6), C.hay, Math.cos(hayA) * 0.88, 0.17, Math.sin(hayA) * 0.88);
  // well in the square
  const wx = (r() - 0.5) * 0.1, wz = 0.08;
  S.add(cyl(0.12, 0.13, 0.12, 8), C.stoneMid, wx, 0.15, wz);
  S.add(cyl(0.09, 0.09, 0.01, 8), C.water, wx, 0.215, wz);
  S.add(box(0.025, 0.26, 0.025), C.woodDark, wx - 0.11, 0.22, wz);
  S.add(box(0.025, 0.26, 0.025), C.woodDark, wx + 0.11, 0.22, wz);
  T.add(gable(0.32, 0.12, 0.2).rotateY(Math.PI / 2), 0.85, wx, 0.35, wz);
  // flag pole behind the well
  const px = 0.0, pz = -0.18, top = 1.45;
  S.add(cyl(0.022, 0.028, top - 0.1, 5), C.woodDark, px, 0.1 + (top - 0.1) / 2, pz);
  S.add(new THREE.IcosahedronGeometry(0.04, 0), C.gold, px, top + 0.02, pz);
  return { stone: S.build(), tint: T.build(), flagPos: new THREE.Vector3(px, top - 0.02, pz), flagScale: 0.85, labelY: 2.1, yaw: r() * Math.PI * 2 };
}

// ------------------------------------------------------------------ tower
function tower(seed: number): BaseModel {
  const r = rng(seed);
  const S = new Builder(), T = new Builder();
  // rocky mound
  S.add(cyl(0.7, 0.86, 0.14, 7), C.rock, 0, 0.07, 0);
  S.add(cyl(0.58, 0.7, 0.1, 7), C.plinth, 0, 0.18, 0);
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2;
    const g = new THREE.DodecahedronGeometry(0.1 + r() * 0.06, 0);
    S.add(g, C.rock, Math.cos(a) * 0.68, 0.14, Math.sin(a) * 0.68);
  }
  const B = 0.23, H = 2.0;
  // shaft
  S.add(sqTaper(0.46, 0.52, 0.28), C.towerDark, 0, B + 0.14, 0);
  S.add(sqTaper(0.34, 0.44, H), C.towerStone, 0, B + H / 2, 0);
  // quoins / bands
  S.add(sqTaper(0.38, 0.4, 0.07), C.towerDark, 0, B + H * 0.55, 0);
  // arrow slits on all four faces at two heights
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    for (const [hy, rr] of [[0.95, 0.295], [1.55, 0.262]]) {
      S.add(box(0.05, 0.2, 0.04), C.opening, Math.sin(a) * rr, B + hy, Math.cos(a) * rr, a);
    }
  }
  // door
  S.add(box(0.18, 0.28, 0.06), C.woodDark, 0, B + 0.28 + 0.14, 0.32);
  S.add(box(0.26, 0.04, 0.12), C.wood, 0, B + 0.28, 0.42);
  // timber hoarding (overhanging archer gallery)
  const G = B + H;
  S.add(box(0.98, 0.07, 0.98), C.woodDark, 0, G + 0.03, 0);
  for (const [cx, cz] of [[-0.3, 0.3], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3]]) S.add(box(0.06, 0.2, 0.06), C.woodDark, cx * 1.15, G - 0.08, cz * 1.15);
  S.add(box(0.92, 0.3, 0.92), C.wood, 0, G + 0.22, 0);
  // archer windows in the gallery
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    for (const off of [-0.2, 0.2]) {
      const ox = Math.cos(a) * off, oz = -Math.sin(a) * off;
      S.add(box(0.1, 0.12, 0.03), C.opening, Math.sin(a) * 0.465 + ox, G + 0.24, Math.cos(a) * 0.465 + oz, a);
    }
  }
  T.add(box(1.0, 0.05, 1.0), 0.72, 0, G + 0.39, 0);
  T.add(pyramid(0.8, 1.05), 1, 0, G + 0.4 + 0.52, 0);
  const top = G + 0.4 + 1.05 + 0.45;
  S.add(cyl(0.022, 0.028, 0.5, 5), C.woodDark, 0, top - 0.22, 0);
  S.add(new THREE.IcosahedronGeometry(0.045, 0), C.gold, 0, top + 0.02, 0);
  // little lean-to store at the foot
  const sx = r() < 0.5 ? -1 : 1;
  S.add(box(0.3, 0.26, 0.3), C.plaster, sx * 0.5, B + 0.13, -0.05);
  const lean = gable(0.36, 0.16, 0.36);
  T.add(lean, 0.85, sx * 0.5, B + 0.26, -0.05);
  // a few spare arrows / straw target
  S.add(cyl(0.1, 0.1, 0.03, 10).rotateX(Math.PI / 2), C.hay, -sx * 0.5, B + 0.12, 0.25);
  S.add(cyl(0.05, 0.05, 0.035, 8).rotateX(Math.PI / 2), '#d8402f', -sx * 0.5, B + 0.12, 0.255);
  return { stone: S.build(), tint: T.build(), flagPos: new THREE.Vector3(0, top - 0.02, 0), flagScale: 0.95, labelY: 4.35, yaw: (r() - 0.5) * 0.6 };
}

export function buildModel(type: BaseType, seed: number): BaseModel {
  if (type === 'castle') return castle(seed);
  if (type === 'tower') return tower(seed);
  return village(seed);
}

// ------------------------------------------------------------------ flags
/** swallow-tailed banner; pole at x = 0, hangs from y = 0 downward */
export function flagGeometry(tattered: boolean) {
  const W = 0.62, Hh = 0.4;
  const s = new THREE.Shape();
  const N = 6;
  s.moveTo(0, 0);
  for (let i = 1; i <= N; i++) s.lineTo((W * i) / N, 0);
  if (tattered) {
    // ragged trailing edge
    const pts = [[W * 0.86, -0.06], [W * 0.95, -0.12], [W * 0.7, -0.17], [W * 0.82, -0.25], [W * 0.62, -0.3], [W * 0.72, -Hh]];
    for (const [x, y] of pts) s.lineTo(x, y);
    for (let i = N - 2; i >= 0; i--) s.lineTo((W * 0.72 * i) / (N - 1) + (i % 2 ? 0.02 : 0), -Hh + (i % 2 ? 0.04 : 0));
  } else {
    s.lineTo(W * 0.78, -Hh / 2);
    s.lineTo(W, -Hh);
    for (let i = N - 1; i >= 0; i--) s.lineTo((W * i) / N, -Hh);
  }
  s.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(s);
  return g;
}

/** Shared time uniform for waving flags. */
export const flagTime = { value: 0 };

export function makeFlagMaterial() {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFlagT = flagTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlagT;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float fk = clamp(position.x / 0.62, 0.0, 1.0);
        float fph = modelMatrix[3][0] * 1.7 + modelMatrix[3][2] * 0.9;
        transformed.z += sin(position.x * 9.0 - uFlagT * 7.0 + fph) * 0.07 * fk;
        transformed.y += sin(position.x * 6.0 - uFlagT * 5.0 + fph) * 0.025 * fk;`);
  };
  m.customProgramCacheKey = () => 'godhand-flag';
  return m;
}
