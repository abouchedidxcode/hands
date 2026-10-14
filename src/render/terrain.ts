// Procedural island terrain for GODHAND.
// Contract (DESIGN.md): buildTerrain(spec) → { group, heightAt, update, dispose }.
import * as THREE from 'three';
import { makeRng, makeSimplex2, fbm, ridged, smoothstep, clamp, lerp } from './terrainNoise';
import { createWater } from './terrainWater';
import {
  pineGeometry, firGeometry, roundTreeGeometry, palmGeometry, bushGeometry,
  rockGeometry, grassGeometry, flowerGeometry,
} from './terrainProps';

export interface TerrainSpec { seed: number; width: number; depth: number; bases: { x: number; z: number; r: number }[] }
export interface Terrain { group: THREE.Group; heightAt(x: number, z: number): number; update(dt: number, t: number): void; dispose(): void }

/** World height of the water surface. */
export const WATER_LEVEL = -0.3;
const SEABED = -4.2;
const PLATEAU_Y = 0.25;
const CELL = 0.5;            // target grid cell size (world units)
const DEPTH_SCALE = 4.5;     // coast texture R channel range
const DIST_SCALE = 12;       // coast texture G channel range

const C = (hex: string) => new THREE.Color(hex);
const COL = {
  seabedShallow: C('#d8c07c'),
  seabedDeep: C('#3f8a86'),
  wetSand: C('#d6bb76'),
  sand: C('#ecd696'),
  grassA: C('#66ad47'),
  grassB: C('#4a9440'),
  grassLight: C('#b2d466'),
  grassDark: C('#367833'),
  forestFloor: C('#2f6a2f'),
  dirt: C('#b89b62'),
  rock: C('#8d8a83'),
  rockLight: C('#a9a49a'),
  rockDark: C('#6f6c66'),
};

interface Bump { x: number; z: number; R: number; A: number }

const dist2 = (a: number, b: number) => Math.sqrt(a * a + b * b);

export function buildTerrain(spec: TerrainSpec): Terrain {
  const rng = makeRng(spec.seed);
  const nCoast = makeSimplex2(rng);
  const nRoll = makeSimplex2(rng);
  const nHill = makeSimplex2(rng);
  const nDetail = makeSimplex2(rng);
  const nColor = makeSimplex2(rng);
  const nForest = makeSimplex2(rng);

  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const bases = spec.bases;

  // ---------------------------------------------------------------- layout
  const halfX = hw + 20;
  const halfZ = hd + 18;
  const minX = -halfX, minZ = -halfZ;
  const NX = Math.max(32, Math.round((2 * halfX) / CELL));
  const dx = (2 * halfX) / NX;
  const NZ = Math.max(24, Math.round((2 * halfZ) / (dx * 0.8660254)));
  const dz = (2 * halfZ) / NZ;
  const invDx = 1 / dx, invDz = 1 / dz;
  const VX = NX + 1;

  /** Signed distance to the playable rect (negative inside). */
  function rectDist(x: number, z: number): number {
    const qx = Math.abs(x) - hw, qz = Math.abs(z) - hd;
    const ox = qx > 0 ? qx : 0, oz = qz > 0 ? qz : 0;
    return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0);
  }
  /** 1 inside the playable rect, fading to 0 just outside it. */
  function insideAmt(x: number, z: number): number {
    const qx = Math.abs(x) - hw, qz = Math.abs(z) - hd;
    return 1 - smoothstep(-1.5, 2.0, Math.max(qx, qz));
  }
  /** Forest cluster field (> 0 ≈ forest). */
  function forestAt(x: number, z: number): number {
    return fbm(nForest, x * 0.075, z * 0.075, 2);
  }
  /** Main island coast parameter: > 0 on land (≈ distance inland), < 0 at sea. */
  const RC = 9; // corner radius of the island's base shape
  function mainCoast(x: number, z: number, dRect: number): number {
    const n1 = nCoast(x * 0.04 + 11.1, z * 0.04);
    const wx = x + 4.0 * n1;
    const wz = z + 4.0 * nCoast(x * 0.04, z * 0.04 - 23.7);
    // rounded-rect base shape (rounder than the playable rect)
    const qx = Math.abs(wx) - (hw + 1.5) + RC, qz = Math.abs(wz) - (hd + 1.5) + RC;
    const ox = qx > 0 ? qx : 0, oz = qz > 0 ? qz : 0;
    const dShape = Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - RC;
    const margin = 6.5 + 4.6 * fbm(nCoast, wx * 0.05, wz * 0.05, 2) + 0.8 * nCoast(wx * 0.22, wz * 0.22);
    const p = margin - dShape;
    // smooth max with a guaranteed land band around the playable rect
    const g = 2.7 + 1.1 * n1 - dRect;
    const k = 1.2;
    const h = clamp(0.5 + 0.5 * (p - g) / k, 0, 1);
    return lerp(g, p, h) + k * h * (1 - h);
  }

  // Rocky outcrops inside the playable rect, away from bases.
  const outcrops: Bump[] = [];
  const wantOutcrops = 2 + Math.floor(rng() * 3);
  for (let tries = 0; tries < 80 && outcrops.length < wantOutcrops; tries++) {
    const R = 1.5 + rng() * 1.0;
    const x = (rng() * 2 - 1) * (hw - 2.5);
    const z = (rng() * 2 - 1) * (hd - 2.5);
    let ok = true;
    for (const b of bases) if (dist2(x - b.x, z - b.z) < b.r * 2.2 + R * 1.6 + 1) { ok = false; break; }
    for (const o of outcrops) if (dist2(x - o.x, z - o.z) < 8) { ok = false; break; }
    if (ok) outcrops.push({ x, z, R, A: 0.5 + rng() * 0.3 });
  }

  // Small islets out in the sea (still within the height grid so they get foam).
  const islets: Bump[] = [];
  const wantIslets = 3 + Math.floor(rng() * 3);
  for (let tries = 0; tries < 300 && islets.length < wantIslets; tries++) {
    const R = 1.2 + rng() * 1.6;
    const x = (rng() * 2 - 1) * (halfX - 2.5 - R * 1.4);
    const z = (rng() * 2 - 1) * (halfZ - 2.5 - R * 1.4);
    if (mainCoast(x, z, rectDist(x, z)) > -(R * 1.4 + 2.2)) continue;
    let ok = true;
    for (const o of islets) if (dist2(x - o.x, z - o.z) < 7 + o.R + R) { ok = false; break; }
    if (ok) islets.push({ x, z, R, A: 0.3 + rng() * 1.0 });
  }

  // ---------------------------------------------------------------- height field
  let lastP = 0; // coast parameter of the last rawHeight() call
  let lastW = 0; // base-plateau weight of the last rawHeight() call
  let lastRock = 0; // outcrop weight of the last rawHeight() call
  function rawHeight(x: number, z: number): number {
    const d = rectDist(x, z);
    let p: number;
    let isle = 0;
    lastRock = 0;
    if (d < -1) {
      p = 20; // deep inside the rect: certainly land, skip coast noise
    } else {
      p = mainCoast(x, z, d);
      for (let i = 0; i < islets.length; i++) {
        const s = islets[i];
        const di = dist2(x - s.x, z - s.z);
        if (di > s.R * 1.6 + 6) continue;
        const pi = s.R * (1 + 0.35 * nCoast(x * 0.3 + i * 13, z * 0.3)) - di;
        if (pi > p) { p = pi; isle = smoothstep(0, s.R * 1.2, pi) * s.A; }
      }
    }

    let y: number;
    if (p >= 0) {
      // land surface (only evaluated above the waterline)
      let land = 0.17 + 0.27 * fbm(nRoll, x * 0.07, z * 0.07, 2) + 0.09 * nDetail(x * 0.3, z * 0.3);
      if (d > -0.5) {
        const hm = smoothstep(-0.5, 7, d) * smoothstep(1.2, 6.5, p);
        if (hm > 0) {
          const r = ridged(nHill, x * 0.055, z * 0.055, 3);
          land += hm * (2.7 * r * r + 0.45 * fbm(nHill, x * 0.11 + 5, z * 0.11, 2));
        }
      }
      land += isle;
      for (let i = 0; i < outcrops.length; i++) {
        const o = outcrops[i];
        const ddx = x - o.x, ddz = z - o.z;
        const q = (ddx * ddx + ddz * ddz) / (o.R * o.R);
        if (q < 6) {
          const e = Math.exp(-q);
          land += o.A * e * (0.8 + 0.4 * nDetail(x * 0.7, z * 0.7));
          if (e > lastRock) lastRock = e;
        }
      }
      const s = smoothstep(0.4, 3.2, p);
      y = lerp(WATER_LEVEL + 0.03 + 0.16 * p, land, s);
    } else {
      y = WATER_LEVEL + 0.03 + p * 0.2 - 0.075 * p * p;
      if (p > -8) y += 0.15 * nDetail(x * 0.2, z * 0.2) * smoothstep(0, -3, p);
      if (y < SEABED) y = SEABED + 0.25 * (y - SEABED) / (1 + Math.abs(y - SEABED));
    }

    // inside the rect keep things gentle
    if (d < 0.5) {
      const cap = 1.15;
      if (y > cap) y = cap;
    }

    // base plateaus
    let w = 0;
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      const ddx = x - b.x, ddz = z - b.z;
      const inner = b.r * 1.6, outer = inner + Math.max(1.6, b.r * 1.3);
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 >= outer * outer) continue;
      const wb = 1 - smoothstep(inner, outer, Math.sqrt(d2));
      if (wb > w) w = wb;
    }
    if (w > 0) y = lerp(y, PLATEAU_Y, w);
    lastP = p;
    lastW = w;
    return y;
  }

  // Vertex lattice: rows of NX+1 vertices, odd rows shifted by half a cell → near-equilateral
  // triangles (classic low-poly look). Per-vertex: height, coast param, plateau weight, colour.
  const NV = VX * (NZ + 1);
  const H = new Float32Array(NV);
  const SN = new Float32Array(NV); // shoreline colour noise
  const VC = new Float32Array(NV * 3);
  const vcol = new THREE.Color();
  // own function so the JIT optimises (OSR) a small body, not all of buildTerrain
  (function fillLattice() {
    for (let iz = 0; iz <= NZ; iz++) {
      const z = minZ + iz * dz;
      const off = (iz & 1) * 0.5;
      for (let ix = 0; ix <= NX; ix++) {
        const x = minX + (ix + off) * dx;
        const k = iz * VX + ix;
        const y = rawHeight(x, z);
        H[k] = y;
        if (lastP > -1 && lastP < 9) SN[k] = 0.4 * nColor(x * 0.45, z * 0.45);
        if (y > WATER_LEVEL) {
          // grass colour field with patchy meadows
          const g = nColor(x * 0.085, z * 0.085);
          vcol.copy(COL.grassA).lerp(COL.grassB, smoothstep(-0.3, 0.5, g));
          vcol.lerp(COL.grassLight, 0.45 * smoothstep(0.1, 0.75, nColor(x * 0.12 + 40, z * 0.12 - 9)));
          vcol.lerp(COL.grassDark, 0.6 * smoothstep(0.15, 0.8, nColor(x * 0.1 - 70, z * 0.1 + 20)));
          // darker, lusher floor under forests
          const fd = smoothstep(-0.05, 0.35, forestAt(x, z)) * (1 - 0.72 * insideAmt(x, z));
          if (fd > 0) vcol.lerp(COL.forestFloor, 0.55 * fd);
          if (lastRock > 0.05) vcol.lerp(COL.rock, 0.75 * smoothstep(0.3, 0.85, lastRock));
          if (lastW > 0) vcol.lerp(COL.dirt, 0.38 * smoothstep(0.35, 1.0, lastW));
        } else {
          vcol.copy(COL.wetSand);
        }
        VC[k * 3] = vcol.r; VC[k * 3 + 1] = vcol.g; VC[k * 3 + 2] = vcol.b;
      }
    }
  })();

  /** Exact height of the rendered triangle mesh at (x, z). */
  function heightAt(x: number, z: number): number {
    const gz = (z - minZ) * invDz;
    if (!(gz >= 0 && gz < NZ)) return SEABED;
    const iz = gz | 0;
    const fz = gz - iz;
    const odd = iz & 1;
    // shear the strip between rows iz and iz+1 into a regular quad grid
    const u = (x - minX) * invDx - (odd ? 0.5 - 0.5 * fz : 0.5 * fz);
    if (!(u >= 0 && u < NX)) return SEABED;
    const ix = u | 0;
    const fx = u - ix;
    const i = iz * VX + ix;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + VX], h11 = H[i + VX + 1];
    if (odd === 0) {
      // diagonal 10–01
      if (fx + fz < 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
      return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
    }
    // diagonal 00–11
    if (fx > fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h01 - h00) * fz + (h11 - h01) * fx;
  }

  function baseClearance(x: number, z: number, factor: number): number {
    let m = Infinity;
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      const v = dist2(x - b.x, z - b.z) - b.r * factor;
      if (v < m) m = v;
    }
    return m;
  }

  // ---------------------------------------------------------------- coast distance fields
  // Sampled at 1.5× lattice resolution: water depth, distance to land (sea side, for foam)
  // and distance to water (land side, for beaches and shoreline props).
  const TW = Math.round(NX * 1.5), TH = Math.round(NZ * 1.5);
  const tdx = (2 * halfX) / TW, tdz = (2 * halfZ) / TH;
  const coastData = new Uint8Array(TW * TH * 4);
  const seaDist = new Float32Array(TW * TH);
  const landDist = new Float32Array(TW * TH);
  // own function so the JIT optimises (OSR) a small body, not all of buildTerrain
  (function sampleDepth() {
    for (let j = 0; j < TH; j++) {
      const z = minZ + (j + 0.5) * tdz;
      for (let i = 0; i < TW; i++) {
        const k = j * TW + i;
        const dp = WATER_LEVEL - heightAt(minX + (i + 0.5) * tdx, z);
        coastData[k * 4] = Math.round(clamp(dp / DEPTH_SCALE, 0, 1) * 255);
        coastData[k * 4 + 3] = 255;
        seaDist[k] = dp <= 0 ? 0 : 1e9;
        landDist[k] = dp <= 0 ? 1e9 : 0;
      }
    }
  })();
  const dg = dist2(tdx, tdz);
  /** Two-pass chamfer distance transform (world units); zero cells are the sources. */
  function chamfer(dist: Float32Array) {
    for (let j = 0; j < TH; j++) {
      for (let i = 0; i < TW; i++) {
        const k = j * TW + i;
        let v = dist[k];
        if (v === 0) continue;
        if (i > 0) v = Math.min(v, dist[k - 1] + tdx);
        if (j > 0) {
          v = Math.min(v, dist[k - TW] + tdz);
          if (i > 0) v = Math.min(v, dist[k - TW - 1] + dg);
          if (i < TW - 1) v = Math.min(v, dist[k - TW + 1] + dg);
        }
        dist[k] = v;
      }
    }
    for (let j = TH - 1; j >= 0; j--) {
      for (let i = TW - 1; i >= 0; i--) {
        const k = j * TW + i;
        let v = dist[k];
        if (v === 0) continue;
        if (i < TW - 1) v = Math.min(v, dist[k + 1] + tdx);
        if (j < TH - 1) {
          v = Math.min(v, dist[k + TW] + tdz);
          if (i < TW - 1) v = Math.min(v, dist[k + TW + 1] + dg);
          if (i > 0) v = Math.min(v, dist[k + TW - 1] + dg);
        }
        dist[k] = v;
      }
    }
  }
  chamfer(seaDist);
  chamfer(landDist);
  for (let k = 0; k < TW * TH; k++) coastData[k * 4 + 1] = Math.round(clamp(seaDist[k] / DIST_SCALE, 0, 1) * 255);
  /** Distance from (x, z) on land to the nearest water (0 at sea). */
  function shoreDist(x: number, z: number): number {
    const i = clamp(Math.floor((x - minX) / tdx), 0, TW - 1);
    const j = clamp(Math.floor((z - minZ) / tdz), 0, TH - 1);
    return landDist[j * TW + i];
  }


  // ---------------------------------------------------------------- materials
  const group = new THREE.Group();
  group.name = 'terrain';
  const disposables: { dispose(): void }[] = [];
  const animTime = { value: 0 };

  /**
   * Flat-shaded vertex-coloured standard material, patched with drifting cloud shadows
   * and (for instanced foliage) a gentle wind sway.
   */
  function litMaterial(roughness: number, sway: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness, metalness: 0 });
    const swayGlsl = sway > 0 ? `
#ifdef USE_INSTANCING
  float swPh = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
  float sw = sin(uTerrainTime * 1.6 + swPh) * 0.6 + sin(uTerrainTime * 2.7 + swPh * 1.7) * 0.4;
  float swK = max(position.y - 0.25, 0.0);
  transformed.x += sw * ${sway.toFixed(4)} * swK * swK;
  transformed.z += sw * ${(sway * 0.6).toFixed(4)} * swK * swK;
#endif` : '';
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTerrainTime = animTime;
      sh.vertexShader = 'uniform float uTerrainTime;\nvarying vec2 vCloudW;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + swayGlsl)
        .replace('#include <project_vertex>', `#include <project_vertex>
  {
    vec4 cw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
    cw = instanceMatrix * cw;
#endif
    vCloudW = (modelMatrix * cw).xz;
  }`);
      sh.fragmentShader = `uniform float uTerrainTime;
varying vec2 vCloudW;
float tcHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tcNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tcHash(i), tcHash(i + vec2(1.0, 0.0)), u.x), mix(tcHash(i + vec2(0.0, 1.0)), tcHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 cp = vCloudW * 0.05 + vec2(uTerrainTime * 0.018, uTerrainTime * 0.006);
    float cn = tcNoise(cp) * 0.65 + tcNoise(cp * 2.2 + 7.1) * 0.35;
    diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.55, 0.75, cn);
  }`);
    };
    m.customProgramCacheKey = () => 'godhand-terrain-' + sway.toFixed(4);
    disposables.push(m);
    return m;
  }

  // ---------------------------------------------------------------- ground mesh

  const triCount = NX * NZ * 2;
  const pos = new Float32Array(triCount * 9);
  const nor = new Float32Array(triCount * 9);
  const col = new Float32Array(triCount * 9);
  const rgb = (c: THREE.Color) => [c.r, c.g, c.b];
  const WS = rgb(COL.wetSand), SB1 = rgb(COL.seabedShallow), SB2 = rgb(COL.seabedDeep), SA = rgb(COL.sand);
  const RK = rgb(COL.rock), RL = rgb(COL.rockLight), RD = rgb(COL.rockDark);
  let ti = 0;

  function pushTri(a: number, b: number, c: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number) {
    const ay = H[a], by = H[b], cy = H[c];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= nl; ny *= nl; nz *= nl;

    // ---- face colour (plain arithmetic: this runs ~40k times, often before the JIT warms up)
    const fy = (ay + by + cy) / 3;
    const jit = rng() - 0.5;
    let r: number, g: number, bl: number;
    if (fy < WATER_LEVEL + 0.05) {
      const dpt = WATER_LEVEL - fy;
      const t1 = smoothstep(-0.05, 0.4, dpt), t2 = smoothstep(0.6, 3.2, dpt);
      r = lerp(lerp(WS[0], SB1[0], t1), SB2[0], t2);
      g = lerp(lerp(WS[1], SB1[1], t1), SB2[1], t2);
      bl = lerp(lerp(WS[2], SB1[2], t1), SB2[2], t2);
    } else {
      r = (VC[a * 3] + VC[b * 3] + VC[c * 3]) / 3;
      g = (VC[a * 3 + 1] + VC[b * 3 + 1] + VC[c * 3 + 1]) / 3;
      bl = (VC[a * 3 + 2] + VC[b * 3 + 2] + VC[c * 3 + 2]) / 3;
      // beach: by distance from the coastline (not by height)
      const shoreN = (SN[a] + SN[b] + SN[c]) / 3;
      const sd = shoreDist((ax + bx + cx) / 3, (az + bz + cz) / 3);
      const sandT = Math.max(1 - smoothstep(0.85, 1.4, sd + shoreN), 1 - smoothstep(WATER_LEVEL + 0.05, WATER_LEVEL + 0.1, fy));
      if (sandT > 0) {
        const wet = 1 - smoothstep(WATER_LEVEL + 0.04, WATER_LEVEL + 0.12, fy);
        r = lerp(r, lerp(SA[0], WS[0], wet), sandT);
        g = lerp(g, lerp(SA[1], WS[1], wet), sandT);
        bl = lerp(bl, lerp(SA[2], WS[2], wet), sandT);
      }
      // rock on slopes and high up
      const rockT = Math.max(1 - smoothstep(0.68, 0.84, ny), smoothstep(1.7, 2.6, fy) * 0.85);
      if (rockT > 0) {
        const R2 = fy > 1.6 ? RL : RD, rt = 0.5 + jit;
        r = lerp(r, lerp(RK[0], R2[0], rt), rockT);
        g = lerp(g, lerp(RK[1], R2[1], rt), rockT);
        bl = lerp(bl, lerp(RK[2], R2[2], rt), rockT);
      }
    }
    const kk = 1 + jit * 0.08;
    r *= kk; g *= kk; bl *= kk;
    const o = ti * 9;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    for (let k = 0; k < 9; k += 3) {
      nor[o + k] = nx; nor[o + k + 1] = ny; nor[o + k + 2] = nz;
      col[o + k] = r; col[o + k + 1] = g; col[o + k + 2] = bl;
    }
    ti++;
  }

  // own function so the JIT optimises (OSR) a small body, not all of buildTerrain
  (function buildGround() {
    for (let iz = 0; iz < NZ; iz++) {
      const z0 = minZ + iz * dz, z1 = z0 + dz;
      const odd = iz & 1;
      const o0 = odd * 0.5, o1 = (1 - odd) * 0.5;
      for (let ix = 0; ix < NX; ix++) {
        const i00 = iz * VX + ix, i10 = i00 + 1, i01 = i00 + VX, i11 = i01 + 1;
        const xb0 = minX + (ix + o0) * dx, xb1 = xb0 + dx;   // row iz
        const xt0 = minX + (ix + o1) * dx, xt1 = xt0 + dx;   // row iz+1
        if (odd === 0) {
          pushTri(i00, i01, i10, xb0, z0, xt0, z1, xb1, z0);
          pushTri(i10, i01, i11, xb1, z0, xt0, z1, xt1, z1);
        } else {
          pushTri(i00, i01, i11, xb0, z0, xt0, z1, xt1, z1);
          pushTri(i00, i11, i10, xb0, z0, xt1, z1, xb1, z0);
        }
      }
    }
  })();
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  groundGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  groundGeo.computeBoundingSphere();
  const groundMat = litMaterial(0.95, 0);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.receiveShadow = true;
  group.add(ground);
  disposables.push(groundGeo);

  // Deep sea floor beyond the grid (hidden by opaque deep water, but avoids any gaps).
  const floorGeo = new THREE.PlaneGeometry(400, 400, 1, 1);
  floorGeo.rotateX(-Math.PI / 2);
  const floorMat = new THREE.MeshBasicMaterial({ color: COL.seabedDeep });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = SEABED - 0.3;
  group.add(floor);
  disposables.push(floorGeo, floorMat);

  // ---------------------------------------------------------------- coast texture
  const coastTex = new THREE.DataTexture(coastData, TW, TH, THREE.RGBAFormat, THREE.UnsignedByteType);
  coastTex.magFilter = THREE.LinearFilter;
  coastTex.minFilter = THREE.LinearFilter;
  coastTex.wrapS = coastTex.wrapT = THREE.ClampToEdgeWrapping;
  coastTex.colorSpace = THREE.NoColorSpace;
  coastTex.generateMipmaps = false;
  coastTex.needsUpdate = true;
  disposables.push(coastTex);

  const water = createWater({
    level: WATER_LEVEL,
    size: 400,
    coastTex,
    rect: { minX, minZ, sizeX: 2 * halfX, sizeZ: 2 * halfZ },
    depthScale: DEPTH_SCALE,
    distScale: DIST_SCALE,
  });
  group.add(water.mesh);
  disposables.push(water.geometry, water.material);

  // ---------------------------------------------------------------- props
  const treeMat = litMaterial(0.9, 0.035);
  const grassMat = litMaterial(0.9, 0.25);
  const rockMat = litMaterial(0.95, 0);

  interface Inst { x: number; y: number; z: number; ry: number; s: number; sy: number; tilt: number; c: THREE.Color }
  const kinds = {
    pine: [] as Inst[], fir: [] as Inst[], round: [] as Inst[], warm: [] as Inst[], palm: [] as Inst[],
    bush: [] as Inst[], rock0: [] as Inst[], rock1: [] as Inst[], grass: [] as Inst[], flower: [] as Inst[],
  };
  const tint = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
  const varyTint = (amt: number) => {
    const k = 1 + (rng() - 0.5) * amt;
    return tint(k * (1 + (rng() - 0.5) * 0.08), k * (1 + (rng() - 0.5) * 0.08), k * (1 + (rng() - 0.5) * 0.08));
  };
  const slopeAt = (x: number, z: number) => {
    const e = 0.35;
    const gx = heightAt(x + e, z) - heightAt(x - e, z);
    const gz = heightAt(x, z + e) - heightAt(x, z - e);
    return Math.sqrt(gx * gx + gz * gz) / (2 * e);
  };

  // trees / bushes / rocks: jittered grid
  const SP = 0.9;
  // own function so the JIT optimises (OSR) a small body, not all of buildTerrain
  (function scatterTrees() {
    for (let gz = minZ + SP * 0.5; gz < halfZ; gz += SP) {
      for (let gx = minX + SP * 0.5; gx < halfX; gx += SP) {
        const x = gx + (rng() - 0.5) * SP * 0.9;
        const z = gz + (rng() - 0.5) * SP * 0.9;
        const r0 = rng();
        const y = heightAt(x, z);
        if (y < WATER_LEVEL + 0.1) continue;
        if (baseClearance(x, z, 2.2) < 0.45) continue;
        const inside = insideAmt(x, z);
        const slope = slopeAt(x, z);
        const beach = shoreDist(x, z) < 1.4 + 0.5 * nColor(x * 0.45, z * 0.45);
        const forest = forestAt(x, z) + 0.12 * nForest(x * 0.4, z * 0.4);

        if (beach) {
          if (slope < 0.5 && r0 < 0.05 * (1 - inside * 0.7)) {
            kinds.palm.push({ x, y: y - 0.03, z, ry: rng() * 6.283, s: 0.85 + rng() * 0.35, sy: 1, tilt: 0, c: varyTint(0.15) });
          } else if (r0 > 0.985) {
            (rng() < 0.5 ? kinds.rock0 : kinds.rock1).push({ x, y: y - 0.05, z, ry: rng() * 6.283, s: 0.25 + rng() * 0.3, sy: 1, tilt: 0.3, c: varyTint(0.2) });
          }
          continue;
        }
        if (slope > 0.55) {
          if (r0 < 0.22 * (1 - inside * 0.5)) {
            (rng() < 0.5 ? kinds.rock0 : kinds.rock1).push({ x, y: y - 0.08, z, ry: rng() * 6.283, s: 0.3 + rng() * 0.7 * (1 - inside * 0.5), sy: 0.8 + rng() * 0.5, tilt: 0.35, c: varyTint(0.2) });
            continue;
          }
        }
        // density: forest clusters, sparser inside the playable rect
        let dens = smoothstep(0.0, 0.32, forest) * 0.9 + 0.03;
        dens *= 1 - inside * 0.72;
        if (slope > 0.9) dens *= 0.3;
        if (r0 < dens) {
          const hi = smoothstep(0.5, 1.6, y) + 0.6 * nForest(x * 0.05 + 50, z * 0.05);
          const pick = rng();
          const s = (0.8 + rng() * 0.45) * (1 - inside * 0.12);
          const inst: Inst = { x, y: y - 0.04, z, ry: rng() * 6.283, s, sy: 0.9 + rng() * 0.25, tilt: 0.06, c: varyTint(0.16) };
          if (hi > 0.35) (pick < 0.6 ? kinds.pine : kinds.fir).push(inst);
          else if (pick < 0.07) kinds.warm.push(inst);
          else if (pick < 0.75) kinds.round.push(inst);
          else if (pick < 0.88) kinds.pine.push(inst);
          else { inst.s *= 1.1; kinds.bush.push(inst); }
        } else if (r0 > 0.985 - 0.01 * (1 - inside)) {
          (rng() < 0.5 ? kinds.rock0 : kinds.rock1).push({ x, y: y - 0.05, z, ry: rng() * 6.283, s: 0.22 + rng() * 0.3, sy: 0.8 + rng() * 0.4, tilt: 0.3, c: varyTint(0.2) });
        } else if (r0 > 0.955 && forest > -0.15) {
          kinds.bush.push({ x, y: y - 0.03, z, ry: rng() * 6.283, s: 0.6 + rng() * 0.5, sy: 1, tilt: 0.05, c: varyTint(0.18) });
        }
      }
    }
  })();
  // outcrop boulders
  for (const o of outcrops) {
    const n = 6 + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) {
      const a = rng() * 6.283, rr = k === 0 ? 0 : (0.3 + 0.7 * rng()) * o.R * 0.95;
      const x = o.x + Math.cos(a) * rr, z = o.z + Math.sin(a) * rr;
      if (baseClearance(x, z, 2.2) < 0.6) continue;
      const s = k === 0 ? 0.95 + rng() * 0.3 : (0.3 + rng() * 0.5) * (1.1 - rr / (o.R * 1.6));
      (rng() < 0.5 ? kinds.rock0 : kinds.rock1).push({ x, y: heightAt(x, z) - 0.1, z, ry: rng() * 6.283, s, sy: 0.8 + rng() * 0.6, tilt: 0.4, c: varyTint(0.2) });
    }
  }
  // grass tufts + flower clusters
  const FLOWER_COLS = ['#fff6e0', '#ffd84a', '#ff8fb1', '#c59bff', '#ff7a4a'].map((h) => new THREE.Color(h));
  const GS = 1.15;
  // own function so the JIT optimises (OSR) a small body, not all of buildTerrain
  (function scatterGrass() {
    for (let gz = minZ + GS * 0.5; gz < halfZ; gz += GS) {
      for (let gx = minX + GS * 0.5; gx < halfX; gx += GS) {
        const x = gx + (rng() - 0.5) * GS;
        const z = gz + (rng() - 0.5) * GS;
        const r0 = rng();
        if (r0 > 0.36) continue;
        const y = heightAt(x, z);
        if (y > 1.8 || shoreDist(x, z) < 2.0) continue;
        if (baseClearance(x, z, 2.2) < 0.2) continue;
        if (r0 < 0.045) {
          const fc = FLOWER_COLS[Math.floor(rng() * FLOWER_COLS.length)];
          const n = 3 + Math.floor(rng() * 4);
          for (let k = 0; k < n; k++) {
            const fx = x + (rng() - 0.5) * 0.7, fz = z + (rng() - 0.5) * 0.7;
            if (baseClearance(fx, fz, 2.2) < 0.1) continue;
            kinds.flower.push({ x: fx, y: heightAt(fx, fz) - 0.01, z: fz, ry: rng() * 6.283, s: 0.8 + rng() * 0.5, sy: 1, tilt: 0.15, c: fc.clone() });
          }
        } else {
          kinds.grass.push({ x, y: y - 0.02, z, ry: rng() * 6.283, s: 0.7 + rng() * 0.6, sy: 0.8 + rng() * 0.5, tilt: 0.1, c: varyTint(0.25) });
        }
      }
    }
  })();

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  function addInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], shadow: boolean, name: string) {
    disposables.push(geo);
    if (list.length === 0) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      _e.set((rng() - 0.5) * it.tilt, it.ry, (rng() - 0.5) * it.tilt);
      _q.setFromEuler(_e);
      _m.compose(_p.set(it.x, it.y, it.z), _q, _s.set(it.s, it.s * it.sy, it.s));
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, it.c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    disposables.push(mesh);
  }
  addInstanced(pineGeometry(), treeMat, kinds.pine, true, 'pines');
  addInstanced(firGeometry(), treeMat, kinds.fir, true, 'firs');
  addInstanced(roundTreeGeometry('#6cbf45', '#5aad3c'), treeMat, kinds.round, true, 'trees');
  addInstanced(roundTreeGeometry('#f0a23a', '#e5832f'), treeMat, kinds.warm, true, 'warmTrees');
  addInstanced(palmGeometry(), treeMat, kinds.palm, true, 'palms');
  addInstanced(bushGeometry(), treeMat, kinds.bush, true, 'bushes');
  addInstanced(rockGeometry(0), rockMat, kinds.rock0, true, 'rocksA');
  addInstanced(rockGeometry(1), rockMat, kinds.rock1, true, 'rocksB');
  addInstanced(grassGeometry(), grassMat, kinds.grass, false, 'grass');
  addInstanced(flowerGeometry(), grassMat, kinds.flower, false, 'flowers');

  // ---------------------------------------------------------------- API
  return {
    group,
    heightAt,
    update(dt: number, t: number) {
      water.time.value = t;
      animTime.value = t;
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}

