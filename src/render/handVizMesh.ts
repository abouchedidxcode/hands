import * as THREE from 'three';

/**
 * CPU-built "god hand" surface: five tapered capsule-tube fingers swept along
 * Catmull-Rom curves through the landmarks, plus a pillowy palm slab. Rebuilt in
 * place every frame into preallocated buffers (no per-frame allocations).
 *
 * Per-vertex `aInfo` = (tip 0..1, finger id 0..4 | 5 = palm, flow 0..1 wrist→tips, fade).
 */

const CHAINS: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
];
/** Radius at the base / tip of each finger, as a fraction of the wrist→middle-MCP span. */
const R_BASE = [0.135, 0.104, 0.11, 0.1, 0.088];
const R_TIP = [0.098, 0.074, 0.078, 0.072, 0.064];

const RADIAL = 12;
const SEG_SAMPLES = 5;                           // body rings per joint segment
const BODY_RINGS = 3 * SEG_SAMPLES + 1;          // 16
const BASE_CAP = [-90, -50];                     // degrees, base hemisphere (buried in the palm)
const TIP_CAP = [24, 48, 70, 90];                // tip hemisphere
const FINGER_RINGS = BASE_CAP.length + BODY_RINGS + TIP_CAP.length;
const FINGER_VERTS = FINGER_RINGS * RADIAL;

const OUT_SAMPLES = 5;                           // palm outline samples per control segment
const OUT_CTRL = 8;
const OUT_N = OUT_CTRL * OUT_SAMPLES;            // 40
/** Palm rows from the top centre outward and around: (radial lerp, height factor, normal mix). */
const PALM_ROWS: readonly [number, number][] = [
  [0.55, 1], [0.86, 0.82], [1, 0], [0.86, -0.82], [0.55, -1],
];
const PALM_VERTS = 2 + PALM_ROWS.length * OUT_N;

export const HAND_VERTS = 5 * FINGER_VERTS + PALM_VERTS;

const _v = () => new THREE.Vector3();

export class HandSurface {
  readonly geometry = new THREE.BufferGeometry();
  readonly position: THREE.BufferAttribute;
  readonly normal: THREE.BufferAttribute;
  readonly info: THREE.BufferAttribute;
  readonly index: THREE.BufferAttribute;
  private P: Float32Array;
  private N: Float32Array;
  private I: Float32Array;

  // scratch
  private ctrl = Array.from({ length: 6 }, _v);
  private T = _v(); private Nf = _v(); private B = _v(); private c = _v(); private tmp = _v();
  private pn = _v(); private axis = _v(); private side = _v(); private ctr = _v();
  private ringC = Array.from({ length: BODY_RINGS }, _v);
  private ringT = Array.from({ length: BODY_RINGS }, _v);
  private outP = Array.from({ length: OUT_N }, _v);
  private outO = Array.from({ length: OUT_N }, _v);
  private oc = Array.from({ length: OUT_CTRL }, _v);

  constructor() {
    this.P = new Float32Array(HAND_VERTS * 3);
    this.N = new Float32Array(HAND_VERTS * 3);
    this.I = new Float32Array(HAND_VERTS * 4);
    this.position = new THREE.BufferAttribute(this.P, 3).setUsage(THREE.DynamicDrawUsage);
    this.normal = new THREE.BufferAttribute(this.N, 3).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(this.I, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('normal', this.normal);
    this.geometry.setAttribute('aInfo', this.info);

    const idx: number[] = [];
    const strip = (a0: number, b0: number, n: number) => {
      for (let j = 0; j < n; j++) {
        const j1 = (j + 1) % n;
        idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
      }
    };
    for (let f = 0; f < 5; f++) {
      const o = f * FINGER_VERTS;
      for (let r = 0; r < FINGER_RINGS - 1; r++) strip(o + r * RADIAL, o + (r + 1) * RADIAL, RADIAL);
    }
    const po = 5 * FINGER_VERTS;
    const top = po, bot = po + 1, row = (k: number) => po + 2 + k * OUT_N;
    for (let j = 0; j < OUT_N; j++) {
      const j1 = (j + 1) % OUT_N;
      idx.push(top, row(0) + j1, row(0) + j);
      idx.push(bot, row(PALM_ROWS.length - 1) + j, row(PALM_ROWS.length - 1) + j1);
    }
    for (let k = 0; k < PALM_ROWS.length - 1; k++) strip(row(k), row(k + 1), OUT_N);
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1);
    this.geometry.setIndex(this.index);
  }

  /** Rebuild from 21 world-space joints. `boost[f]` scales finger f's thickness. */
  build(p: readonly THREE.Vector3[], boost: readonly number[]) {
    const span = Math.max(1e-3, p[0].distanceTo(p[9]));
    // palm frame
    const axis = this.axis.subVectors(p[9], p[0]).normalize();
    const pn = this.pn.crossVectors(this.tmp.subVectors(p[5], p[0]), this.c.subVectors(p[17], p[0]));
    if (pn.lengthSq() < 1e-8) pn.set(0, 1, 0);
    pn.normalize();
    if (pn.y < 0) pn.negate(); // face the sky so frames are stable for both hands
    const side = this.side.subVectors(p[17], p[5]);
    side.addScaledVector(axis, -side.dot(axis));
    if (side.lengthSq() < 1e-8) side.crossVectors(axis, pn);
    side.normalize();
    const flowLen = span * 2.15;

    for (let f = 0; f < 5; f++) this.buildFinger(f, p, span, boost[f], flowLen);
    this.buildPalm(p, span, flowLen);

    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  private flow(x: number, y: number, z: number, p0: THREE.Vector3, len: number) {
    const a = this.axis;
    return THREE.MathUtils.clamp(((x - p0.x) * a.x + (y - p0.y) * a.y + (z - p0.z) * a.z) / len, 0, 1);
  }

  private buildFinger(f: number, p: readonly THREE.Vector3[], span: number, boost: number, flowLen: number) {
    const ch = CHAINS[f];
    const c = this.ctrl;
    for (let k = 0; k < 4; k++) c[k + 1].copy(p[ch[k]]);
    c[0].copy(c[1]).multiplyScalar(2).sub(c[2]);
    c[5].copy(c[4]).multiplyScalar(2).sub(c[3]);

    // body ring centres + tangents (uniform Catmull-Rom)
    let n = 0;
    for (let s = 0; s < 3; s++) {
      const p0 = c[s], p1 = c[s + 1], p2 = c[s + 2], p3 = c[s + 3];
      const last = s === 2 ? SEG_SAMPLES : SEG_SAMPLES - 1;
      for (let i = 0; i <= last; i++) {
        const t = i / SEG_SAMPLES, t2 = t * t, t3 = t2 * t;
        const C = this.ringC[n], T = this.ringT[n];
        C.set(0, 0, 0)
          .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
          .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
          .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
          .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
        T.set(0, 0, 0)
          .addScaledVector(p0, -1.5 * t2 + 2 * t - 0.5)
          .addScaledVector(p1, 4.5 * t2 - 5 * t)
          .addScaledVector(p2, -4.5 * t2 + 4 * t + 0.5)
          .addScaledVector(p3, 1.5 * t2 - t);
        if (T.lengthSq() < 1e-10) T.subVectors(p2, p1);
        T.normalize();
        n++;
      }
    }

    const rb = R_BASE[f] * span * boost, rt = R_TIP[f] * span * boost;
    const base = f * FINGER_VERTS;
    // initial frame from the palm normal
    const Nf = this.Nf.copy(this.pn);
    let ring = 0;
    const P = this.P, N = this.N, I = this.I;

    const emit = (C: THREE.Vector3, T: THREE.Vector3, r: number, theta: number, tip: number) => {
      // parallel-transport-ish frame: project previous normal onto the plane ⟂ T
      Nf.addScaledVector(T, -Nf.dot(T));
      if (Nf.lengthSq() < 1e-8) { Nf.set(T.y, -T.x, 0); if (Nf.lengthSq() < 1e-8) Nf.set(0, T.z, -T.y); }
      Nf.normalize();
      const B = this.B.crossVectors(T, Nf);
      const ct = Math.cos(theta), st = Math.sin(theta);
      const cx = C.x + T.x * r * st, cy = C.y + T.y * r * st, cz = C.z + T.z * r * st;
      const rr = r * ct;
      const fl = this.flow(cx, cy, cz, p[0], flowLen);
      for (let j = 0; j < RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = Nf.x * ca + B.x * sa, dy = Nf.y * ca + B.y * sa, dz = Nf.z * ca + B.z * sa;
        const v = base + ring * RADIAL + j;
        P[v * 3] = cx + dx * rr; P[v * 3 + 1] = cy + dy * rr; P[v * 3 + 2] = cz + dz * rr;
        N[v * 3] = dx * ct + T.x * st; N[v * 3 + 1] = dy * ct + T.y * st; N[v * 3 + 2] = dz * ct + T.z * st;
        I[v * 4] = tip; I[v * 4 + 1] = f; I[v * 4 + 2] = fl; I[v * 4 + 3] = 1;
      }
      ring++;
    };

    const tipOf = (u: number) => THREE.MathUtils.smoothstep(u, 0.62, 1);
    for (const deg of BASE_CAP) emit(this.ringC[0], this.ringT[0], rb, (deg * Math.PI) / 180, 0);
    for (let i = 0; i < BODY_RINGS; i++) {
      const u = i / (BODY_RINGS - 1);
      // taper + a soft knuckle bulge at PIP / DIP
      const knuckle = 1 + 0.07 * Math.exp(-((u - 1 / 3) ** 2) / 0.004) + 0.05 * Math.exp(-((u - 2 / 3) ** 2) / 0.004);
      const r = (rb + (rt - rb) * u) * knuckle;
      emit(this.ringC[i], this.ringT[i], r, 0, tipOf(u));
    }
    const last = BODY_RINGS - 1;
    for (const deg of TIP_CAP) emit(this.ringC[last], this.ringT[last], rt, (deg * Math.PI) / 180, 1);
  }

  private buildPalm(p: readonly THREE.Vector3[], span: number, flowLen: number) {
    const axis = this.axis, side = this.side, pn = this.pn;
    // outline control points around the palm (closed): wrist(thumb side) → thumb → knuckles → pinky → wrist
    const o = this.oc;
    const ww = 0.34 * span;
    o[0].copy(p[0]).addScaledVector(side, -ww * 0.85).addScaledVector(axis, -0.1 * span);
    o[1].copy(p[1]).addScaledVector(side, -0.04 * span);
    o[2].copy(p[2]).lerp(p[3], 0.15);
    o[3].copy(p[5]).addScaledVector(axis, 0.06 * span).addScaledVector(side, -0.05 * span);
    o[4].copy(p[9]).addScaledVector(axis, 0.07 * span);
    o[5].copy(p[13]).addScaledVector(axis, 0.06 * span);
    o[6].copy(p[17]).addScaledVector(axis, 0.03 * span).addScaledVector(side, 0.06 * span);
    o[7].copy(p[0]).addScaledVector(side, ww).addScaledVector(axis, 0.05 * span);
    const ctr = this.ctr.set(0, 0, 0);
    for (let k = 0; k < OUT_CTRL; k++) ctr.add(o[k]);
    ctr.multiplyScalar(1 / OUT_CTRL);

    // closed Catmull-Rom outline
    for (let k = 0; k < OUT_CTRL; k++) {
      const p0 = o[(k + OUT_CTRL - 1) % OUT_CTRL], p1 = o[k], p2 = o[(k + 1) % OUT_CTRL], p3 = o[(k + 2) % OUT_CTRL];
      for (let i = 0; i < OUT_SAMPLES; i++) {
        const t = i / OUT_SAMPLES, t2 = t * t, t3 = t2 * t;
        this.outP[k * OUT_SAMPLES + i].set(0, 0, 0)
          .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
          .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
          .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
          .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
      }
    }
    // the static index buffer expects a clockwise outline (seen from +pn): flip if needed
    let area = 0;
    for (let j = 0; j < OUT_N; j++) {
      const a = this.tmp.subVectors(this.outP[j], ctr);
      const b = this.c.subVectors(this.outP[(j + 1) % OUT_N], ctr);
      area += a.cross(b).dot(pn);
    }
    if (area > 0) this.outP.reverse();
    // outward in-plane normals
    for (let j = 0; j < OUT_N; j++) {
      const a = this.outP[(j + OUT_N - 1) % OUT_N], b = this.outP[(j + 1) % OUT_N];
      const out = this.outO[j].subVectors(b, a).cross(pn);
      if (out.dot(this.tmp.subVectors(this.outP[j], ctr)) < 0) out.negate();
      out.normalize();
    }

    const th = 0.13 * span;
    const P = this.P, N = this.N, I = this.I;
    const vo = 5 * FINGER_VERTS;
    const put = (v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, fade: number) => {
      P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
      N[v * 3] = nx; N[v * 3 + 1] = ny; N[v * 3 + 2] = nz;
      I[v * 4] = 0; I[v * 4 + 1] = 5; I[v * 4 + 2] = this.flow(x, y, z, p[0], flowLen); I[v * 4 + 3] = fade;
    };
    // wrist fade: vertices behind the wrist dissolve into the air
    const fadeAt = (x: number, y: number, z: number) => {
      const d = ((x - p[0].x) * axis.x + (y - p[0].y) * axis.y + (z - p[0].z) * axis.z) / span;
      return 0.35 + 0.65 * THREE.MathUtils.smoothstep(d, -0.12, 0.3);
    };
    const c = this.c.copy(ctr).addScaledVector(pn, th * 1.05);
    put(vo, c.x, c.y, c.z, pn.x, pn.y, pn.z, fadeAt(c.x, c.y, c.z));
    c.copy(ctr).addScaledVector(pn, -th * 1.05);
    put(vo + 1, c.x, c.y, c.z, -pn.x, -pn.y, -pn.z, fadeAt(c.x, c.y, c.z));
    for (let k = 0; k < PALM_ROWS.length; k++) {
      const [rl, hf] = PALM_ROWS[k];
      const nIn = 1 - Math.abs(hf) * 0.75; // how much the normal leans outward
      for (let j = 0; j < OUT_N; j++) {
        const q = this.outP[j], out = this.outO[j];
        const x = ctr.x + (q.x - ctr.x) * rl + pn.x * th * hf;
        const y = ctr.y + (q.y - ctr.y) * rl + pn.y * th * hf;
        const z = ctr.z + (q.z - ctr.z) * rl + pn.z * th * hf;
        let nx = out.x * nIn + pn.x * hf, ny = out.y * nIn + pn.y * hf, nz = out.z * nIn + pn.z * hf;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        put(vo + 2 + k * OUT_N + j, x, y, z, nx, ny, nz, fadeAt(x, y, z));
      }
    }
  }
}
