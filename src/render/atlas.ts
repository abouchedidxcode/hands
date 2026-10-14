// LIVING ATLAS — the map layer that "comes alive" under the battle.
//
//  * Territory: every owned base floods its surroundings with a watercolour wash in its faction
//    colour (noisy Voronoi between hostile bases). When a base changes hands the new pigment
//    spreads outward from it like ink dropped in water (per-cell reveal times + a wetness channel).
//  * Ink trails: marching armies stipple faint coloured trails onto the paper.
//  * Splats: smites, clashes and captures leave ink blots that slowly fade.
//
// Everything is computed on the CPU into two small RGBA DataTextures that the terrain and sea
// shaders sample (shared uniforms in `atlasUniforms`). Updates are cheap: territory is recomputed
// only on ownership changes, trails are decayed/stamped at ~30 Hz.
import * as THREE from 'three';
import { BOARD, factionColor } from '../config';
import { makeRng, makeSimplex2 } from './terrainNoise';

const CELL = 0.2;
const MARGIN = 4;
const MINX = -BOARD.width / 2 - MARGIN, MINZ = -BOARD.depth / 2 - MARGIN;
const SX = BOARD.width + 2 * MARGIN, SZ = BOARD.depth + 2 * MARGIN;
const GW = Math.round(SX / CELL), GH = Math.round(SZ / CELL);
const N = GW * GH;
/** Ink spreads this fast (world units / s) from a captured base. */
const SPREAD = 6.5;
const TRAIL_TAU = 9;

interface AtlasBase { x: number; z: number; radius: number; owner: number }

const terrData = new Uint8Array(N * 4);
const trailData = new Uint8Array(N * 4);
const terrTex = new THREE.DataTexture(terrData, GW, GH, THREE.RGBAFormat, THREE.UnsignedByteType);
const trailTex = new THREE.DataTexture(trailData, GW, GH, THREE.RGBAFormat, THREE.UnsignedByteType);
for (const t of [terrTex, trailTex]) {
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
}

/** Shared uniforms read by the terrain / sea shaders. */
export const atlasUniforms = {
  uTerr: { value: terrTex as THREE.Texture },
  uTrail: { value: trailTex as THREE.Texture },
  uAtlasRect: { value: new THREE.Vector4(MINX, MINZ, 1 / SX, 1 / SZ) },
  uAtlasTime: { value: 0 },
};

/** GLSL helpers shared by every "paper" shader. */
export const ATLAS_GLSL = /* glsl */ `
uniform sampler2D uTerr;
uniform sampler2D uTrail;
uniform vec4 uAtlasRect;
uniform float uAtlasTime;
float at_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float at_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(at_hash(i), at_hash(i + vec2(1.0, 0.0)), u.x), mix(at_hash(i + vec2(0.0, 1.0)), at_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float at_fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * at_noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// aged parchment: mottling, fibres, foxing, tide-mark stains
vec3 at_paper(vec2 p) {
  vec3 light = vec3(0.84, 0.77, 0.62);
  vec3 dark = vec3(0.70, 0.58, 0.40);
  float m = at_fbm(p * 0.09);
  vec3 c = mix(light, dark, smoothstep(0.35, 0.85, m) * 0.55);
  float fib = at_noise(vec2(p.x * 9.0, p.y * 1.3) + at_noise(p * 2.0) * 3.0);
  float fib2 = at_noise(vec2(p.x * 1.4, p.y * 8.0) - 11.0);
  c *= 0.965 + 0.05 * fib + 0.03 * fib2;
  // foxing: sparse brown spots
  float fx = at_noise(p * 1.7 + 40.0);
  c = mix(c, c * vec3(0.78, 0.62, 0.42), smoothstep(0.78, 0.86, fx) * 0.55);
  // tide-mark stains: rings of darker pigment
  float st = at_fbm(p * 0.05 + 3.0);
  float ring = smoothstep(0.03, 0.0, abs(st - 0.62)) * 0.5 + smoothstep(0.6, 0.75, st) * 0.18;
  c *= 1.0 - ring * vec3(0.18, 0.24, 0.32);
  return c;
}
// watercolour territory + ink trails on top of a paper colour (world xz)
vec3 at_wash(vec3 paper, vec2 p, out float terrA) {
  vec2 uv = (p - uAtlasRect.xy) * uAtlasRect.zw;
  terrA = 0.0;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return paper;
  float t = uAtlasTime;
  // bleeding: warp the lookup a little, slowly drifting
  vec2 w = vec2(at_noise(p * 0.9 + t * 0.03), at_noise(p * 0.9 + 9.3 - t * 0.025)) - 0.5;
  vec4 terr = texture2D(uTerr, uv + w * 0.012);
  vec3 pig = terr.rgb;
  float a = terr.a;
  float grain = at_noise(p * 7.0) * 0.6 + at_noise(p * 19.0) * 0.4;
  float edgeN = at_fbm(p * 1.4 + t * 0.02) - 0.5;
  float thr = 0.5 - edgeN * 0.16;
  float mask = smoothstep(thr - 0.035, thr + 0.035, a);
  // pigment pools at the wet edge, thins in the middle
  float pool = mask * (1.0 - smoothstep(thr, thr + 0.12, a));
  float body = mask * (0.5 + 0.22 * smoothstep(0.45, 0.9, at_fbm(p * 0.35 + 5.0)));
  float k = clamp(body * (0.85 + 0.3 * grain) + pool * 0.95, 0.0, 0.97);
  // watercolour on parchment: the wash lifts the yellow of the paper, then the pigment filters it
  vec3 base = mix(paper, vec3(0.86, 0.84, 0.78) * (0.9 + 0.1 * grain), 0.55 * mask);
  vec3 c = base * mix(vec3(1.0), pig, k);
  // dark pooled edge line
  c *= 1.0 - pool * 0.3;
  terrA = mask;
  // ink trails: stippled dots in the army's colour
  vec4 tr = texture2D(uTrail, uv);
  if (tr.a > 0.01) {
    vec3 tc = tr.rgb / max(tr.a, 0.001);
    vec2 cell = floor(p * 9.0);
    float h = at_hash(cell);
    vec2 cp = fract(p * 9.0) - 0.5 - (vec2(at_hash(cell + 3.1), at_hash(cell + 7.7)) - 0.5) * 0.5;
    float dotm = smoothstep(0.34, 0.2, length(cp)) * step(h, tr.a * 2.2);
    float blot = smoothstep(0.55, 0.85, tr.a);
    c = mix(c, c * tc, clamp(dotm * 0.85 + blot * 0.9, 0.0, 1.0));
  }
  return c;
}
`;

/** CPU side: territory + trails. One instance per game (textures are fixed size). */
export class Atlas {
  private bases: AtlasBase[] = [];
  private owners: number[] = [];
  private wx = new Float32Array(N);
  private wz = new Float32Array(N);
  private jit = new Float32Array(N);
  // territory display state
  private cur = new Float32Array(N * 4);
  private from = new Float32Array(N * 4);
  private to = new Float32Array(N * 4);
  private reveal = new Float32Array(N);
  private animUntil = -1;
  // trails (premultiplied colour + amount)
  private trail = new Float32Array(N * 4);
  private trailAcc = 0;
  private time = 0;
  private cols: THREE.Color[] = [];

  constructor() {
    for (let f = -1; f < 4; f++) this.cols[f + 1] = new THREE.Color(factionColor(f));
  }

  /** New map: reset everything and paint the initial territories instantly. */
  build(bases: AtlasBase[], seed: number) {
    this.bases = bases;
    this.owners = bases.map(() => -99);
    const rng = makeRng(seed ^ 0x51a7);
    const n1 = makeSimplex2(rng), n2 = makeSimplex2(rng);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        const x = MINX + (i + 0.5) * CELL, z = MINZ + (j + 0.5) * CELL;
        this.wx[k] = x + 1.6 * n1(x * 0.12, z * 0.12) + 0.5 * n1(x * 0.5 + 9, z * 0.5);
        this.wz[k] = z + 1.6 * n2(x * 0.12, z * 0.12) + 0.5 * n2(x * 0.5, z * 0.5 - 9);
        this.jit[k] = 0.35 * n1(x * 0.35 + 40, z * 0.35);
      }
    }
    this.trail.fill(0);
    this.cur.fill(0);
    this.time = 0;
    this.animUntil = -1;
    this.refresh(-1, true);
    this.uploadTrail();
  }

  /** Ink blot (smite / clash / capture). `strength` 0..1+, `color` defaults to sepia ink. */
  splat(x: number, z: number, radius: number, strength = 1, color: THREE.ColorRepresentation = '#2a1a10', drops = 10, seed = Math.random() * 1000) {
    const c = new THREE.Color(color);
    const rng = makeRng(Math.floor(seed * 9973));
    const stamp = (cx: number, cz: number, r: number, a: number) => {
      const i0 = Math.max(0, Math.floor((cx - r - MINX) / CELL)), i1 = Math.min(GW - 1, Math.ceil((cx + r - MINX) / CELL));
      const j0 = Math.max(0, Math.floor((cz - r - MINZ) / CELL)), j1 = Math.min(GH - 1, Math.ceil((cz + r - MINZ) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = MINX + (i + 0.5) * CELL, pz = MINZ + (j + 0.5) * CELL;
        const k = j * GW + i;
        const d = Math.hypot(px - cx, pz - cz) / r + this.jit[k] * 0.6;
        if (d >= 1) continue;
        const w = a * Math.min(1, (1 - d) * 3);
        const o = k * 4;
        this.trail[o] += c.r * w; this.trail[o + 1] += c.g * w; this.trail[o + 2] += c.b * w; this.trail[o + 3] += w;
      }
    };
    stamp(x, z, radius * 0.55, strength * 1.4);
    for (let d = 0; d < drops; d++) {
      const ang = rng() * Math.PI * 2, rr = radius * (0.45 + rng() * 0.75);
      const sr = radius * (0.06 + rng() * 0.16) * (1.2 - rr / (radius * 1.3));
      stamp(x + Math.cos(ang) * rr, z + Math.sin(ang) * rr, Math.max(CELL * 0.8, sr), strength * 1.3);
      // a streak of smaller droplets toward the outside
      if (rng() < 0.5) stamp(x + Math.cos(ang) * rr * 1.25, z + Math.sin(ang) * rr * 1.25, Math.max(CELL * 0.7, sr * 0.5), strength * 1.2);
    }
  }

  update(dt: number, bases: AtlasBase[], units: { x: number; z: number; faction: number; alive: boolean }[]) {
    this.time += dt;
    atlasUniforms.uAtlasTime.value = this.time;
    // ---- ownership changes → recompute territory, spread from the changed base(s)
    let changed = -1;
    for (let b = 0; b < bases.length; b++) if (bases[b].owner !== this.owners[b]) { changed = b; break; }
    if (changed >= 0) this.refresh(changed, false);
    if (this.time <= this.animUntil) this.animate();

    // ---- trails
    this.trailAcc += dt;
    if (this.trailAcc >= 1 / 30) {
      const step = this.trailAcc;
      this.trailAcc = 0;
      const decay = Math.exp(-step / TRAIL_TAU);
      const tr = this.trail;
      for (let i = 0; i < tr.length; i++) tr[i] *= decay;
      const amt = step * 1.6;
      for (const u of units) {
        if (!u.alive) continue;
        const i = Math.floor((u.x - MINX) / CELL), j = Math.floor((u.z - MINZ) / CELL);
        if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
        const o = (j * GW + i) * 4;
        if (tr[o + 3] > 0.7) continue;
        const c = this.cols[u.faction + 1] ?? this.cols[0];
        tr[o] += c.r * amt; tr[o + 1] += c.g * amt; tr[o + 2] += c.b * amt; tr[o + 3] += amt;
      }
      this.uploadTrail();
    }
  }

  private uploadTrail() {
    const tr = this.trail, d = trailData;
    for (let k = 0; k < N; k++) {
      const o = k * 4, a = tr[o + 3];
      if (a < 0.004) { d[o + 3] = 0; continue; }
      const ca = Math.min(1, a), s = ca / a; // keep colour, clamp amount
      d[o] = Math.min(255, tr[o] * s * 255); d[o + 1] = Math.min(255, tr[o + 1] * s * 255); d[o + 2] = Math.min(255, tr[o + 2] * s * 255);
      d[o + 3] = ca * 255;
    }
    trailTex.needsUpdate = true;
  }

  /** Recompute the territory target; if `instant`, show it immediately. */
  private refresh(origin: number, instant: boolean) {
    const bases = this.bases;
    const nb = bases.length;
    const owners = this.owners;
    const prevOwners = owners.slice();
    for (let b = 0; b < nb; b++) owners[b] = bases[b].owner;
    const ox = origin >= 0 ? bases[origin].x : 0, oz = origin >= 0 ? bases[origin].z : 0;
    // all bases that changed since last refresh spread at the same time
    const changedB: number[] = [];
    for (let b = 0; b < nb; b++) if (prevOwners[b] !== owners[b]) changedB.push(b);
    const T = this.time;
    let maxReveal = T;
    for (let k = 0; k < N; k++) {
      const x = this.wx[k], z = this.wz[k];
      let d1 = 1e9, b1 = -1;
      for (let b = 0; b < nb; b++) {
        const B = bases[b];
        const ex = x - B.x, ez = z - B.z;
        const d = Math.sqrt(ex * ex + ez * ez) - B.radius * 1.1;
        if (d < d1) { d1 = d; b1 = b; }
      }
      const o1 = owners[b1];
      let d2 = 1e9;
      for (let b = 0; b < nb; b++) {
        if (owners[b] === o1) continue;
        const B = bases[b];
        const ex = x - B.x, ez = z - B.z;
        const d = Math.sqrt(ex * ex + ez * ez) - B.radius * 1.1;
        if (d < d2) d2 = d;
      }
      const R = 4.6 + bases[b1].radius * 1.6;
      // signed distance (world units, + inside) to this faction's territory boundary
      const sd = Math.min((d2 - d1) * 0.5 - 0.25, R - d1);
      const o = k * 4;
      const c = this.cols[o1 + 1];
      const tr = this.to;
      const a = o1 < 0 ? 0 : Math.max(0, Math.min(1, 0.5 + sd / 3));
      if (a <= 0) { tr[o] = this.cur[o]; tr[o + 1] = this.cur[o + 1]; tr[o + 2] = this.cur[o + 2]; tr[o + 3] = 0; }
      else { tr[o] = c.r; tr[o + 1] = c.g; tr[o + 2] = c.b; tr[o + 3] = a; }
      for (let q = 0; q < 4; q++) this.from[o + q] = this.cur[o + q];
      if (instant) {
        for (let q = 0; q < 4; q++) this.cur[o + q] = tr[o + q];
        this.reveal[k] = -1;
      } else {
        // distance to the nearest changed base drives when the new pigment arrives here
        let dd = 1e9;
        for (const b of changedB) { const B = bases[b]; dd = Math.min(dd, Math.hypot(x - B.x, z - B.z)); }
        if (dd > 1e8) dd = Math.hypot(x - ox, z - oz);
        const rv = T + Math.max(0, dd - 0.5) / SPREAD + this.jit[k] * 0.35 + 0.05;
        this.reveal[k] = rv;
        if (rv > maxReveal) maxReveal = rv;
      }
    }
    if (instant) this.upload();
    else this.animUntil = Math.min(maxReveal, T + 6) + 0.6;
  }

  private animate() {
    const T = this.time;
    for (let k = 0; k < N; k++) {
      const o = k * 4;
      const r = this.reveal[k];
      if (r < 0) continue;
      const u = Math.max(0, Math.min(1, (T - r) / 0.45));
      const e = u * u * (3 - 2 * u);
      const fa = this.from[o + 3], ta = this.to[o + 3];
      // pigment: colour switches fast as the front passes; alpha bleeds in
      const cu = Math.min(1, u * 3);
      for (let q = 0; q < 3; q++) this.cur[o + q] = this.from[o + q] + (this.to[o + q] - this.from[o + q]) * (fa < 0.05 ? 1 : cu);
      // wet front: briefly over-saturate as the ink flows in
      const wet = u > 0 && u < 1 ? Math.sin(u * Math.PI) * 0.18 : 0;
      this.cur[o + 3] = fa + (ta - fa) * e + (ta > 0.3 ? wet : 0);
      if (u >= 1) this.reveal[k] = -1;
    }
    this.upload();
  }

  private upload() {
    const c = this.cur, d = terrData;
    for (let i = 0; i < N * 4; i++) d[i] = Math.max(0, Math.min(255, c[i] * 255));
    terrTex.needsUpdate = true;
  }
}

export const atlas = new Atlas();
