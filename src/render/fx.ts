import * as THREE from 'three';

/*
 * GODHAND visual effects.
 *
 * Everything is pooled and allocation-free in update():
 *  - Particles   : THREE.Points ring buffers (additive "glow" + alpha-blended "smoke").
 *  - Streaks     : velocity-stretched spark particles rendered through the LineBatch.
 *  - LineBatch   : one immediate-mode ribbon mesh (camera-facing thick lines) used for
 *                  lightning, charge arcs, orbiting motes, arrows, capture pillars, streaks.
 *  - Rings       : one instanced quad mesh for ground rings / discs / shockwaves.
 *  - Bodies      : InstancedMesh pools for debris chunks and flung soldiers.
 *  - Scorches    : a few decal meshes.
 *  - Lights      : two always-present PointLights (smite flash + charge glow) whose
 *                  intensity is animated (never toggled, so no shader recompiles).
 */

const TAU = Math.PI * 2;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const MAX_DT = 0.1;

// ---------------------------------------------------------------- textures

function dataTex(size: number, fn: (u: number, v: number, out: Float32Array) => void, srgb = false): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const px = new Float32Array(4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1, px);
      const o = (y * size + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = Math.max(0, Math.min(255, Math.round(px[k] * 255)));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Cheap deterministic value noise (only used for texture generation). */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

function makeGlowTex() {
  return dataTex(64, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const a = r >= 1 ? 0 : Math.exp(-r * r * 5.5) * (1 - r) + Math.max(0, 1 - r * 4) * 0.6;
    o[0] = o[1] = o[2] = 1; o[3] = Math.min(1, a);
  });
}
function makeSmokeTex() {
  return dataTex(64, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const n = fbm(u * 2.5 + 7, v * 2.5 + 3);
    const edge = 1 - Math.min(1, r * (0.85 + n * 0.5));
    const a = Math.max(0, edge) ** 1.4 * (0.55 + n * 0.6);
    const shade = 0.75 + n * 0.25;
    o[0] = o[1] = o[2] = shade; o[3] = Math.min(1, a);
  });
}
function makeScorchTex() {
  return dataTex(256, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const ang = Math.atan2(v, u);
    const n = fbm(u * 3.2 + 11, v * 3.2 + 5);
    // ragged outline + radial streaks (blast rays)
    const rays = 0.5 + 0.5 * Math.sin(ang * 9 + n * 6) * Math.sin(ang * 23 - n * 4);
    const rr = r / (0.8 + n * 0.22 + rays * 0.1);
    let a = rr >= 1 ? 0 : Math.min(1, (1 - rr * rr) * 2.2) ** 0.8;
    a *= 0.8 + 0.2 * fbm(u * 9, v * 9);
    const center = Math.max(0, 1 - r * 2.2);
    o[0] = 0.07 + n * 0.05 - center * 0.04;
    o[1] = 0.05 + n * 0.035 - center * 0.03;
    o[2] = 0.035 + n * 0.02 - center * 0.02;
    o[3] = Math.min(1, a * 1.15);
  }, true);
}

// ---------------------------------------------------------------- particles (THREE.Points)

const PS = 18; // stride: px py pz vx vy vz age life s0 s1 r g b a grav drag flicker floorY

const POINT_VS = /* glsl */`
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.05, -mv.z);
  if (aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
  vColor = aColor;
}`;
const POINT_FS = /* glsl */`
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  #include <colorspace_fragment>
}`;

const _v2 = new THREE.Vector2();

class Particles {
  readonly obj: THREE.Points;
  private readonly d: Float32Array;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly siz: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private head = 0;
  private wasAlive = false;

  constructor(readonly cap: number, map: THREE.Texture, additive: boolean, private readonly fadeIn: boolean) {
    this.d = new Float32Array(cap * PS);
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.siz = new Float32Array(cap);
    this.geo = new THREE.BufferGeometry();
    const mk = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute('position', mk(this.pos, 3));
    this.geo.setAttribute('aColor', mk(this.col, 4));
    this.geo.setAttribute('aSize', mk(this.siz, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 800 } },
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
    this.obj.visible = false;
    const uScale = this.mat.uniforms.uScale;
    this.obj.onBeforeRender = (renderer, _scene, camera) => {
      const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(_v2).y;
      const cam = camera as THREE.PerspectiveCamera;
      const f = cam.isPerspectiveCamera ? Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1) : 0.5;
      uScale.value = h / (2 * f);
    };
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, r: number, g: number, b: number, a: number,
    grav = 0, drag = 0, flicker = 0, floorY = -1e9, delay = 0): void {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const d = this.d, o = i * PS;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = -delay; d[o + 7] = life;
    d[o + 8] = s0; d[o + 9] = s1;
    d[o + 10] = r; d[o + 11] = g; d[o + 12] = b; d[o + 13] = a;
    d[o + 14] = grav; d[o + 15] = drag; d[o + 16] = flicker; d[o + 17] = floorY;
    this.siz[i] = 0; // shown from the next update
    this.obj.visible = true;
  }

  update(dt: number): void {
    const d = this.d, pos = this.pos, col = this.col, siz = this.siz, fadeIn = this.fadeIn;
    let alive = false;
    for (let i = 0; i < this.cap; i++) {
      const o = i * PS;
      const life = d[o + 7];
      if (life <= 0) continue;
      const age = d[o + 6] + dt;
      d[o + 6] = age;
      if (age >= life) { d[o + 7] = 0; siz[i] = 0; col[i * 4 + 3] = 0; continue; }
      alive = true;
      if (age < 0) { siz[i] = 0; continue; }
      const step = age < dt ? age : dt; // first frame after a delay only integrates the elapsed part
      const drag = d[o + 15];
      const k = drag > 0 ? Math.exp(-drag * step) : 1;
      let vx = d[o + 3] * k, vy = d[o + 4] * k - d[o + 14] * step, vz = d[o + 5] * k;
      let x = d[o] + vx * step, y = d[o + 1] + vy * step, z = d[o + 2] + vz * step;
      const fy = d[o + 17];
      if (y < fy) { y = fy; vy = -vy * 0.3; vx *= 0.6; vz *= 0.6; }
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
      const t = age / life;
      let a = d[o + 13] * (1 - t);
      if (fadeIn) a *= Math.min(1, t * 7);
      const fl = d[o + 16];
      if (fl > 0) a *= 1 - fl * Math.random();
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      col[i * 4] = d[o + 10]; col[i * 4 + 1] = d[o + 11]; col[i * 4 + 2] = d[o + 12]; col[i * 4 + 3] = a;
      siz[i] = d[o + 8] + (d[o + 9] - d[o + 8]) * t;
    }
    if (alive || this.wasAlive) {
      const at = this.geo.attributes;
      at.position.needsUpdate = true;
      at.aColor.needsUpdate = true;
      at.aSize.needsUpdate = true;
    }
    this.obj.visible = alive;
    this.wasAlive = alive;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------- line batch (camera-facing ribbons)

const LINE_VS = /* glsl */`
attribute vec3 aOther;
attribute vec2 aWA;     // x: signed offset (world units), y: across coordinate (-1..1)
attribute vec4 aColor;
varying vec4 vColor;
varying float vAcross;
void main() {
  vec4 mvA = modelViewMatrix * vec4(position, 1.0);
  vec4 mvB = modelViewMatrix * vec4(aOther, 1.0);
  vec3 d = mvB.xyz - mvA.xyz;
  vec3 side = cross(d, mvA.xyz);
  float l = length(side);
  side = l > 1e-8 ? side / l : vec3(1.0, 0.0, 0.0);
  mvA.xyz += side * aWA.x;
  gl_Position = projectionMatrix * mvA;
  vColor = aColor;
  vAcross = aWA.y;
}`;
const LINE_FS = /* glsl */`
varying vec4 vColor;
varying float vAcross;
void main() {
  float x = 1.0 - abs(vAcross);
  float a = x * x * (3.0 - 2.0 * x);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  #include <colorspace_fragment>
}`;

class LineBatch {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly oth: Float32Array;
  private readonly wa: Float32Array;
  private readonly col: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private n = 0;

  constructor(readonly cap: number) {
    const nv = cap * 4;
    this.pos = new Float32Array(nv * 3);
    this.oth = new Float32Array(nv * 3);
    this.wa = new Float32Array(nv * 2);
    this.col = new Float32Array(nv * 4);
    const idx = new Uint32Array(cap * 6);
    for (let s = 0; s < cap; s++) {
      const v = s * 4, o = s * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mk = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute('position', mk(this.pos, 3));
    this.geo.setAttribute('aOther', mk(this.oth, 3));
    this.geo.setAttribute('aWA', mk(this.wa, 2));
    this.geo.setAttribute('aColor', mk(this.col, 4));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  begin() { this.n = 0; }

  /** Push one tapered ribbon segment A→B. Colours are linear HDR (may exceed 1). */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    wa: number, wb: number, r: number, g: number, b: number, aa: number, ab: number): void {
    if (this.n >= this.cap) return;
    const v = this.n++ * 4;
    const P = this.pos, O = this.oth, W = this.wa, C = this.col;
    let p = v * 3;
    P[p] = ax; P[p + 1] = ay; P[p + 2] = az; O[p] = bx; O[p + 1] = by; O[p + 2] = bz; p += 3;
    P[p] = ax; P[p + 1] = ay; P[p + 2] = az; O[p] = bx; O[p + 1] = by; O[p + 2] = bz; p += 3;
    P[p] = bx; P[p + 1] = by; P[p + 2] = bz; O[p] = ax; O[p + 1] = ay; O[p + 2] = az; p += 3;
    P[p] = bx; P[p + 1] = by; P[p + 2] = bz; O[p] = ax; O[p + 1] = ay; O[p + 2] = az;
    const w = v * 2;
    // at B the direction is reversed, so the offset sign flips to stay on the same physical side
    W[w] = wa; W[w + 1] = 1; W[w + 2] = -wa; W[w + 3] = -1;
    W[w + 4] = -wb; W[w + 5] = 1; W[w + 6] = wb; W[w + 7] = -1;
    let c = v * 4;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = aa; c += 4;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = aa; c += 4;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = ab; c += 4;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = ab;
  }

  end() {
    const n = this.n;
    this.geo.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    if (n === 0) return;
    const at = this.geo.attributes;
    const upd = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number) => {
      const ba = a as THREE.BufferAttribute;
      ba.clearUpdateRanges();
      ba.addUpdateRange(0, n * 4 * size);
      ba.needsUpdate = true;
    };
    upd(at.position, 3); upd(at.aOther, 3); upd(at.aWA, 2); upd(at.aColor, 4);
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------- streak particles (rendered by LineBatch)

const SS = 17; // px py pz vx vy vz age life r g b a width len grav drag floorY

class Streaks {
  private readonly d: Float32Array;
  private head = 0;
  constructor(readonly cap: number) { this.d = new Float32Array(cap * SS); }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number,
    r: number, g: number, b: number, a: number, width: number, len: number, grav: number, drag = 0, floorY = -1e9, delay = 0) {
    const o = this.head * SS;
    this.head = (this.head + 1) % this.cap;
    const d = this.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = -delay; d[o + 7] = life; d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = a;
    d[o + 12] = width; d[o + 13] = len; d[o + 14] = grav; d[o + 15] = drag; d[o + 16] = floorY;
  }

  update(dt: number, lines: LineBatch) {
    const d = this.d;
    for (let i = 0; i < this.cap; i++) {
      const o = i * SS;
      const life = d[o + 7];
      if (life <= 0) continue;
      const age = d[o + 6] + dt;
      d[o + 6] = age;
      if (age >= life) { d[o + 7] = 0; continue; }
      if (age < 0) continue;
      const step = age < dt ? age : dt;
      const drag = d[o + 15];
      const k = drag > 0 ? Math.exp(-drag * step) : 1;
      let vx = d[o + 3] * k, vy = d[o + 4] * k - d[o + 14] * step, vz = d[o + 5] * k;
      let x = d[o] + vx * step, y = d[o + 1] + vy * step, z = d[o + 2] + vz * step;
      const fy = d[o + 16];
      if (y < fy) { y = fy; vy = -vy * 0.35; vx *= 0.5; vz *= 0.5; }
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
      const t = age / life;
      const a = d[o + 11] * (1 - t * t);
      let len = d[o + 13];
      const sp2 = vx * vx + vy * vy + vz * vz;
      const maxL = 0.9;
      if (sp2 * len * len > maxL * maxL) len = maxL / Math.sqrt(sp2);
      const w = d[o + 12] * (1 - 0.5 * t);
      lines.seg(x - vx * len, y - vy * len, z - vz * len, x, y, z, w * 0.4, w,
        d[o + 8], d[o + 9], d[o + 10], 0, a);
    }
  }
}

// ---------------------------------------------------------------- ground rings (instanced quads)

const RING_VS = /* glsl */`
attribute vec4 aPR;    // centre xyz, radius
attribute vec4 aCol;   // rgb, alpha
attribute vec4 aShape; // thickness, mode, seed, -
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vShape;
void main() {
  vUv = position.xy;
  vCol = aCol;
  vShape = aShape;
  vec3 wp = aPR.xyz + vec3(position.x * aPR.w, 0.0, position.y * aPR.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RING_FS = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vShape;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float aa = max(fwidth(r) * 1.5, 0.002);
  float outer = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float a;
  if (vShape.y < 0.5) {
    float t = max(vShape.x, 0.001);
    float x = clamp((r - (1.0 - t)) / t, 0.0, 1.0);
    a = x * x * outer;
  } else if (vShape.y < 1.5) {
    a = pow(1.0 - r, 1.7);
  } else {
    float t = max(vShape.x, 0.001);
    float x = clamp((r - (1.0 - t)) / t, 0.0, 1.0);
    float ang = atan(vUv.y, vUv.x);
    float n = 0.55 + 0.45 * sin(ang * 7.0 + vShape.z) * sin(ang * 17.0 - vShape.z * 1.7);
    a = x * x * (0.35 + 0.65 * n) * outer + 0.12 * x * (1.0 - x) * 4.0 * outer;
  }
  gl_FragColor = vec4(vCol.rgb, vCol.a * a);
  #include <colorspace_fragment>
}`;

const RS = 16; // x y z r0 r1 age life r g b a thick0 thick1 mode seed -

class Rings {
  readonly mesh: THREE.Mesh;
  private readonly d: Float32Array;
  private readonly pr: Float32Array;
  private readonly cl: Float32Array;
  private readonly sh: Float32Array;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private head = 0;

  constructor(readonly cap: number) {
    this.d = new Float32Array(cap * RS);
    this.pr = new Float32Array(cap * 4);
    this.cl = new Float32Array(cap * 4);
    this.sh = new Float32Array(cap * 4);
    const plane = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setIndex(plane.index);
    this.geo.setAttribute('position', plane.attributes.position);
    const mk = (arr: Float32Array) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute('aPR', mk(this.pr));
    this.geo.setAttribute('aCol', mk(this.cl));
    this.geo.setAttribute('aShape', mk(this.sh));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** mode 0 = ring with bright leading edge, 1 = soft disc, 2 = ragged shock ring */
  spawn(x: number, y: number, z: number, r0: number, r1: number, life: number,
    r: number, g: number, b: number, a: number, thick0: number, thick1: number, mode: number, delay = 0) {
    const o = this.head * RS;
    this.head = (this.head + 1) % this.cap;
    const d = this.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = r0; d[o + 4] = r1; d[o + 5] = -delay; d[o + 6] = life;
    d[o + 7] = r; d[o + 8] = g; d[o + 9] = b; d[o + 10] = a; d[o + 11] = thick0; d[o + 12] = thick1;
    d[o + 13] = mode; d[o + 14] = Math.random() * 100;
  }

  update(dt: number) {
    const d = this.d, pr = this.pr, cl = this.cl, sh = this.sh;
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      const o = i * RS;
      const life = d[o + 6];
      if (life <= 0) continue;
      const age = d[o + 5] + dt;
      d[o + 5] = age;
      if (age >= life) { d[o + 6] = 0; continue; }
      if (age < 0) continue;
      const t = age / life;
      const e = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
      const mode = d[o + 13];
      const rad = d[o + 3] + (d[o + 4] - d[o + 3]) * e;
      const a = mode === 1 ? d[o + 10] * (1 - t) * (1 - t) : d[o + 10] * Math.pow(1 - t, 1.4);
      const k = n * 4;
      pr[k] = d[o]; pr[k + 1] = d[o + 1] + 0.03 + n * 0.0005; pr[k + 2] = d[o + 2]; pr[k + 3] = Math.max(rad, 0.001);
      cl[k] = d[o + 7]; cl[k + 1] = d[o + 8]; cl[k + 2] = d[o + 9]; cl[k + 3] = a;
      sh[k] = d[o + 11] + (d[o + 12] - d[o + 11]) * t; sh[k + 1] = mode; sh[k + 2] = d[o + 14]; sh[k + 3] = 0;
      n++;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      const at = this.geo.attributes;
      for (let j = 0; j < RING_ATTRS.length; j++) {
        const ba = at[RING_ATTRS[j]] as THREE.InstancedBufferAttribute;
        ba.clearUpdateRanges();
        ba.addUpdateRange(0, n * 4);
        ba.needsUpdate = true;
      }
    }
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}
const RING_ATTRS = ['aPR', 'aCol', 'aShape'] as const;

// ---------------------------------------------------------------- instanced rigid bodies (debris / flung soldiers)

const BS = 22; // px py pz vx vy vz rx ry rz wx wy wz age life scale grav floorY r g b trailAcc alive
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO_M4 = new THREE.Matrix4().makeScale(0, 0, 0);

function glowLambert(glow: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
        totalEmissiveRadiance += vColor.rgb * ${glow.toFixed(3)};
      #endif`);
  };
  m.customProgramCacheKey = () => 'fxglow' + glow;
  return m;
}

class Bodies {
  readonly mesh: THREE.InstancedMesh;
  private readonly d: Float32Array;
  private head = 0;
  private wasAlive = false;

  constructor(readonly cap: number, geo: THREE.BufferGeometry, mat: THREE.Material,
    private readonly fling: boolean, private readonly glow: Particles) {
    this.d = new Float32Array(cap * BS);
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < cap; i++) {
      this.mesh.setMatrixAt(i, ZERO_M4);
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.visible = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, spin: number,
    life: number, scale: number, grav: number, floorY: number, r: number, g: number, b: number) {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const d = this.d, o = i * BS;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = Math.random() * TAU; d[o + 7] = Math.random() * TAU; d[o + 8] = Math.random() * TAU;
    d[o + 9] = rnd(-1, 1) * spin; d[o + 10] = rnd(-1, 1) * spin; d[o + 11] = rnd(-1, 1) * spin;
    d[o + 12] = 0; d[o + 13] = life; d[o + 14] = scale; d[o + 15] = grav; d[o + 16] = floorY;
    d[o + 17] = r; d[o + 18] = g; d[o + 19] = b; d[o + 20] = 0; d[o + 21] = 1;
    this.mesh.setColorAt(i, _c.setRGB(r, g, b));
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.visible = true;
  }

  update(dt: number) {
    const d = this.d;
    let alive = false;
    for (let i = 0; i < this.cap; i++) {
      const o = i * BS;
      if (d[o + 21] === 0) continue;
      const age = d[o + 12] + dt;
      d[o + 12] = age;
      let life = d[o + 13];
      if (age >= life) { d[o + 21] = 0; this.mesh.setMatrixAt(i, ZERO_M4); continue; }
      alive = true;
      let vx = d[o + 3], vy = d[o + 4] - d[o + 15] * dt, vz = d[o + 5];
      let x = d[o] + vx * dt, y = d[o + 1] + vy * dt, z = d[o + 2] + vz * dt;
      if (this.fling) {
        vx *= Math.exp(-0.4 * dt); vz *= Math.exp(-0.4 * dt);
        if (y < -2 && life > age + 0.35) { life = age + 0.35; d[o + 13] = life; }
        // trail
        let acc = d[o + 20] + dt;
        while (acc >= 0.022) {
          acc -= 0.022;
          this.glow.spawn(x - vx * acc, y - vy * acc, z - vz * acc, 0, 0, 0, 0.32, 0.16, 0.03,
            d[o + 17] * 2.2, d[o + 18] * 2.2, d[o + 19] * 2.2, 0.7);
        }
        d[o + 20] = acc;
      } else {
        const fy = d[o + 16];
        if (y < fy) {
          y = fy;
          if (vy < -1.5) { vy = -vy * 0.32; vx *= 0.55; vz *= 0.55; d[o + 9] *= 0.5; d[o + 10] *= 0.5; d[o + 11] *= 0.5; }
          else { vy = 0; vx *= Math.exp(-8 * dt); vz *= Math.exp(-8 * dt); d[o + 9] *= Math.exp(-8 * dt); d[o + 10] *= Math.exp(-8 * dt); d[o + 11] *= Math.exp(-8 * dt); }
        }
      }
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
      const rx = d[o + 6] + d[o + 9] * dt, ry = d[o + 7] + d[o + 10] * dt, rz = d[o + 8] + d[o + 11] * dt;
      d[o + 6] = rx; d[o + 7] = ry; d[o + 8] = rz;
      const rem = life - age;
      const fade = this.fling ? Math.min(1, rem / 0.35) : Math.min(1, rem / 0.5);
      const sc = d[o + 14] * fade;
      _q.setFromEuler(_e.set(rx, ry, rz));
      _m4.compose(_p.set(x, y, z), _q, _s.set(sc, sc, sc));
      this.mesh.setMatrixAt(i, _m4);
    }
    if (alive || this.wasAlive) this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = alive;
    this.wasAlive = alive;
  }
}

// ---------------------------------------------------------------- lightning bolt records

const BOLT_SEGS = 220;
interface Bolt {
  active: boolean;
  kind: number;        // 0 main, 1 secondary
  x: number; y: number; z: number;
  ox: number; oz: number; // top offset
  radius: number;
  age: number; life: number;
  lastRegen: number; nextRegen: number;
  n: number;
  segs: Float32Array;  // ax ay az bx by bz w bright
}

// arrows: fx fy fz tx ty tz age dur h alive
const AS = 10;
// beams (capture pillars): x y z h w age life r g b alive
const BMS = 11;

// ---------------------------------------------------------------- Fx

export class Fx {
  readonly group = new THREE.Group();
  /** 0..1 current lightning flash level (use for screen flash / shake). */
  flash = 0;

  private readonly glowTex = makeGlowTex();
  private readonly smokeTex = makeSmokeTex();
  private readonly scorchTex = makeScorchTex();

  private readonly glow: Particles;
  private readonly smoke: Particles;
  private readonly lines: LineBatch;
  private readonly streaks: Streaks;
  private readonly rings: Rings;
  private readonly debris: Bodies;
  private readonly flung: Bodies;

  private readonly bolts: Bolt[] = [];
  private readonly arrows: Float32Array;
  private readonly beams: Float32Array;
  private arrowHead = 0;
  private beamHead = 0;

  private readonly scorches: THREE.Mesh[] = [];
  private readonly scorchState: Float32Array; // age life hold a0
  private scorchHead = 0;

  private readonly flashLight: THREE.PointLight;
  private readonly chargeLight: THREE.PointLight;
  private flashI = 0;

  // charge orb
  private readonly chargeCore: THREE.Sprite;
  private readonly chargeHalo: THREE.Sprite;
  private readonly chargeP = new THREE.Vector3();
  private chargeLevel = 0;
  private chargeOn = false;
  private chargeShown = 0; // smoothed visibility 0..1
  private chargeSince = 0;
  private chargeT = 0;
  private chargeArcT = 0;
  private chargeEmit = 0;
  private readonly arcPts: Float32Array;   // up to 8 arcs x 9 pts x 3
  private readonly arcN: Int32Array;
  private arcCount = 0;
  private readonly moteAxes: Float32Array; // 12 motes x (ux uy uz vx vy vz speed phase rmul)

  // scratch for path generation
  private readonly tmpA = new Float32Array(260 * 3);
  private readonly tmpB = new Float32Array(260 * 3);
  private readonly mainPts = new Float32Array(260 * 3);
  private readonly brPts = new Float32Array(260 * 3);
  private readonly col = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.group.name = 'fx';
    scene.add(this.group);

    this.smoke = new Particles(1500, this.smokeTex, false, true);
    this.smoke.obj.renderOrder = 3;
    this.glow = new Particles(6000, this.glowTex, true, false);
    this.glow.obj.renderOrder = 6;
    this.lines = new LineBatch(8192);
    this.lines.mesh.renderOrder = 5;
    this.streaks = new Streaks(2500);
    this.rings = new Rings(96);
    this.rings.mesh.renderOrder = 4;

    const debrisGeo = new THREE.BoxGeometry(0.16, 0.11, 0.13);
    this.debris = new Bodies(256, debrisGeo, glowLambert(0.0), false, this.glow);
    const flingGeo = new THREE.CapsuleGeometry(0.075, 0.12, 2, 8);
    this.flung = new Bodies(256, flingGeo, glowLambert(0.55), true, this.glow);

    for (let i = 0; i < 8; i++) {
      this.bolts.push({
        active: false, kind: 0, x: 0, y: 0, z: 0, ox: 0, oz: 0, radius: 1, age: 0, life: 0,
        lastRegen: 0, nextRegen: 0, n: 0, segs: new Float32Array(BOLT_SEGS * 8),
      });
    }
    this.arrows = new Float32Array(160 * AS);
    this.beams = new Float32Array(48 * BMS);

    const scorchGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.scorchState = new Float32Array(10 * 4);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({
        map: this.scorchTex, transparent: true, depthWrite: false, opacity: 0,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      m.renderOrder = 1;
      m.visible = false;
      this.scorches.push(m);
      this.group.add(m);
    }

    this.flashLight = new THREE.PointLight(0xbfd8ff, 0, 40, 1.6);
    this.chargeLight = new THREE.PointLight(0x7fd4ff, 0, 9, 1.6);
    this.group.add(this.flashLight, this.chargeLight);

    const spriteMat = (c: number) => new THREE.SpriteMaterial({
      map: this.glowTex, color: c, blending: THREE.AdditiveBlending, depthWrite: false,
      depthTest: false, transparent: true, toneMapped: false,
    });
    this.chargeHalo = new THREE.Sprite(spriteMat(0x66ccff));
    this.chargeCore = new THREE.Sprite(spriteMat(0xffffff));
    this.chargeHalo.renderOrder = 7;
    this.chargeCore.renderOrder = 8;
    this.chargeHalo.visible = this.chargeCore.visible = false;

    this.arcPts = new Float32Array(10 * 9 * 3);
    this.arcN = new Int32Array(10);
    this.moteAxes = new Float32Array(12 * 9);
    const u = new THREE.Vector3(), v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < 12; i++) {
      n.set(rnd(-1, 1), rnd(-0.4, 1), rnd(-1, 1)).normalize();
      u.set(1, 0, 0);
      if (Math.abs(n.x) > 0.9) u.set(0, 0, 1);
      u.cross(n).normalize();
      v.copy(n).cross(u).normalize();
      const o = i * 9;
      this.moteAxes[o] = u.x; this.moteAxes[o + 1] = u.y; this.moteAxes[o + 2] = u.z;
      this.moteAxes[o + 3] = v.x; this.moteAxes[o + 4] = v.y; this.moteAxes[o + 5] = v.z;
      this.moteAxes[o + 6] = rnd(4, 9) * (Math.random() < 0.5 ? -1 : 1);
      this.moteAxes[o + 7] = Math.random() * TAU;
      this.moteAxes[o + 8] = rnd(1.2, 1.9);
    }

    this.group.add(this.debris.mesh, this.flung.mesh, this.smoke.obj, this.rings.mesh,
      this.lines.mesh, this.glow.obj, this.chargeHalo, this.chargeCore);
  }

  // ============================================================ public API

  /** Clash sparks. Cheap: n streaks + 1 glow. */
  sparks(p: THREE.Vector3, color: THREE.ColorRepresentation, n = 6): void {
    const c = this.col.set(color);
    const cr = c.r, cg = c.g, cb = c.b;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const up = rnd(0.15, 1);
      const sp = rnd(2, 5.5);
      const h = Math.sqrt(1 - up * up * 0.6);
      const hot = (i & 1) === 0;
      this.streaks.spawn(p.x, p.y + 0.08, p.z, Math.cos(a) * h * sp, up * sp, Math.sin(a) * h * sp, rnd(0.14, 0.3),
        hot ? 3.2 : cr * 3, hot ? 2.6 : cg * 3, hot ? 1.5 : cb * 3, 1, 0.035, 0.035, 14, 0, p.y);
    }
    this.glow.spawn(p.x, p.y + 0.1, p.z, 0, 0, 0, 0.12, 0.7, 0.3, 1.6 + cr, 1.4 + cg, 1 + cb, 0.9);
  }

  /** Capture celebration in faction colour. */
  burst(p: THREE.Vector3, color: THREE.ColorRepresentation, scale = 1): void {
    const c = this.col.set(color);
    const cr = c.r, cg = c.g, cb = c.b;
    const s = scale;
    // radial ring of particles
    const N = Math.round(32 * Math.min(2, s));
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + rnd(-0.05, 0.05);
      const sp = rnd(5, 7) * s;
      this.glow.spawn(p.x + Math.cos(a) * 0.3, p.y + 0.25, p.z + Math.sin(a) * 0.3,
        Math.cos(a) * sp, rnd(0, 0.6), Math.sin(a) * sp, rnd(0.55, 0.8), 0.32 * s, 0.06 * s,
        cr * 3, cg * 3, cb * 3, 1, 0, 3.2);
    }
    // confetti fountain
    for (let i = 0; i < 34 * s; i++) {
      const a = Math.random() * TAU, h = rnd(0, 2.2) * s;
      const white = Math.random() < 0.35;
      const vy = rnd(6, 12) * s;
      this.streaks.spawn(p.x, p.y + 0.4, p.z, Math.cos(a) * h, vy, Math.sin(a) * h, rnd(0.8, 1.4),
        white ? 3 : cr * 3.2, white ? 3 : cg * 3.2, white ? 3 : cb * 3.2, 1, 0.05 * s, 0.03, 10, 0.9, p.y);
      this.glow.spawn(p.x, p.y + 0.4, p.z, Math.cos(a) * h * 0.8, vy * 0.9, Math.sin(a) * h * 0.8, rnd(0.9, 1.6),
        0.14 * s, 0.06 * s, cr * 2 + 0.6, cg * 2 + 0.6, cb * 2 + 0.6, 1, 9, 1.0, 0.8);
    }
    // pillar of light
    this.beam(p.x, p.y, p.z, 7 * s, 0.55 * s, 0.85, cr * 3, cg * 3, cb * 3);
    // ground rings + flash
    this.rings.spawn(p.x, p.y, p.z, 0.4 * s, 2.8 * s, 0.6, cr * 2.6, cg * 2.6, cb * 2.6, 1, 0.35, 0.12, 0);
    this.rings.spawn(p.x, p.y, p.z, 0.2 * s, 1.6 * s, 0.9, cr * 2, cg * 2, cb * 2, 0.8, 0.5, 0.15, 0, 0.12);
    this.rings.spawn(p.x, p.y, p.z, 2.2 * s, 2.2 * s, 0.35, cr * 1.6 + 0.4, cg * 1.6 + 0.4, cb * 1.6 + 0.4, 0.9, 1, 1, 1);
    this.glow.spawn(p.x, p.y + 0.6, p.z, 0, 0, 0, 0.3, 3 * s, 4.5 * s, cr * 2 + 1, cg * 2 + 1, cb * 2 + 1, 1);
  }

  /** The hero effect: lightning strike + flash + shockwave + debris + embers + smoke + scorch. */
  smite(p: THREE.Vector3, radius: number): void {
    const R = Math.max(0.5, radius);
    const x = p.x, y = p.y, z = p.z;
    // bolts
    this.startBolt(0, x, y, z, R, 0.42, 0);
    this.startBolt(1, x + rnd(-0.5, 0.5) * R, y, z + rnd(-0.5, 0.5) * R, R, 0.22, rnd(0.04, 0.1));
    if (Math.random() < 0.7) this.startBolt(1, x + rnd(-0.6, 0.6) * R, y, z + rnd(-0.6, 0.6) * R, R, 0.2, rnd(0.14, 0.22));
    this.flashI = Math.max(this.flashI, 1);
    this.flashLight.position.set(x, y + 3, z);

    // impact glows
    this.glow.spawn(x, y + 0.4, z, 0, 0, 0, 0.2, 2.6 * R / 3.2, 4 * R / 3.2, 2.2, 2.5, 3.6, 0.9);
    this.glow.spawn(x, y + 0.3, z, 0, 0, 0, 0.7, 1.8, 2.6, 3.5, 2.0, 0.8, 1);
    // ground flash + glowing crater
    this.rings.spawn(x, y, z, R * 1.1, R * 1.3, 0.25, 0.7, 1.0, 2.0, 0.8, 1, 1, 1);
    this.rings.spawn(x, y, z, R * 0.65, R * 0.55, 1.8, 3.2, 1.1, 0.25, 0.9, 1, 1, 1, 0.05);
    // shockwaves
    this.rings.spawn(x, y, z, 0.3, R * 1.12, 0.55, 3.4, 2.4, 1.3, 1, 0.5, 0.15, 2);
    this.rings.spawn(x, y, z, 0.5, R * 1.9, 0.85, 1.0, 1.5, 3.2, 0.8, 0.25, 0.08, 0, 0.06);
    this.rings.spawn(x, y, z, R * 0.98, R * 1.02, 0.9, 1.6, 1.8, 3, 0.5, 0.08, 0.04, 0, 0.3);

    // dust shock ring along the ground
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU + rnd(-0.1, 0.1);
      const sp = R * rnd(2.6, 3.4);
      this.smoke.spawn(x + Math.cos(a) * R * 0.25, y + 0.2, z + Math.sin(a) * R * 0.25,
        Math.cos(a) * sp, rnd(0.2, 0.8), Math.sin(a) * sp, rnd(0.9, 1.4), 0.7, 2.0,
        0.42, 0.36, 0.28, 0.55, 0, 2.6);
    }
    // dirt spray
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * TAU, sp = rnd(3, 8);
      this.smoke.spawn(x + Math.cos(a) * 0.3, y + 0.2, z + Math.sin(a) * 0.3,
        Math.cos(a) * sp, rnd(3, 8), Math.sin(a) * sp, rnd(0.6, 1.1), 0.25, 0.7,
        0.24, 0.17, 0.1, 0.9, 14, 0.4, 0, y);
    }
    // sparks
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * TAU, up = rnd(0.2, 1), sp = rnd(6, 17);
      const h = Math.sqrt(1 - up * up * 0.7);
      const blue = Math.random() < 0.4;
      this.streaks.spawn(x, y + 0.2, z, Math.cos(a) * h * sp, up * sp, Math.sin(a) * h * sp, rnd(0.35, 0.9),
        blue ? 2.4 : 4, blue ? 3 : 2.8, blue ? 4.6 : 1.4, 1, 0.09, 0.03, 20, 0.6, y);
    }
    // debris chunks
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * TAU, hs = rnd(2.5, 9), rr = rnd(0, R * 0.35);
      const k = Math.random();
      let r = 0.22, g = 0.15, b = 0.09;               // earth
      if (k < 0.25) { r = 0.09; g = 0.08; b = 0.07; }   // charred
      else if (k < 0.45) { r = 0.42; g = 0.4; b = 0.37; } // rock
      else if (k < 0.6) { r = 0.22; g = 0.4; b = 0.13; }  // turf
      this.debris.spawn(x + Math.cos(a) * rr, y + 0.15, z + Math.sin(a) * rr,
        Math.cos(a) * hs, rnd(5, 13), Math.sin(a) * hs, rnd(6, 16), rnd(1.8, 2.8), rnd(0.6, 1.7), 24, y + 0.04, r, g, b);
    }
    // embers
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * R * 0.9;
      this.glow.spawn(x + Math.cos(a) * rr, y + rnd(0.1, 0.6), z + Math.sin(a) * rr,
        rnd(-0.6, 0.6), rnd(0.5, 2.6), rnd(-0.6, 0.6), rnd(1.4, 3.2), 0.17, 0.05,
        3.6, 1.7, 0.4, 1, -0.4, 0.7, 0.7, -1e9, rnd(0, 0.5));
    }
    // smoke columns
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * R * 0.75;
      const g = rnd(0.06, 0.13);
      this.smoke.spawn(x + Math.cos(a) * rr, y + rnd(0.3, 1), z + Math.sin(a) * rr,
        Math.cos(a) * 0.4, rnd(0.6, 1.5), Math.sin(a) * 0.4, rnd(2.4, 3.8), rnd(1, 1.6), rnd(3, 4.2),
        g, g * 0.95, g * 0.9, 0.62, -0.1, 0.5, 0, -1e9, rnd(0.08, 0.5));
    }
    // scorch decal
    this.scorch(x, y, z, R * 1.25, 4.5, 1.8, 0.95);
  }

  /** Expanding + fading ground ring with a short inner flash. */
  shockwave(p: THREE.Vector3, color: THREE.ColorRepresentation, radius: number): void {
    const c = this.col.set(color);
    this.rings.spawn(p.x, p.y, p.z, 0.1, radius, 0.5, c.r * 2.4, c.g * 2.4, c.b * 2.4, 1, 0.35, 0.1, 0);
    this.rings.spawn(p.x, p.y, p.z, radius * 0.6, radius * 0.75, 0.28, c.r * 1.2, c.g * 1.2, c.b * 1.2, 0.8, 1, 1, 1);
  }

  /** Generic ground ring. */
  ring(p: THREE.Vector3, color: THREE.ColorRepresentation, radius: number, duration = 0.5): void {
    const c = this.col.set(color);
    this.rings.spawn(p.x, p.y, p.z, 0, radius, Math.max(0.05, duration), c.r * 2, c.g * 2, c.b * 2, 1, 0.25, 0.1, 0);
  }

  /** Small dust puff (units leaving a castle). */
  dust(p: THREE.Vector3): void {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU, sp = rnd(0.6, 1.6);
      this.smoke.spawn(p.x + Math.cos(a) * 0.15, p.y + 0.1, p.z + Math.sin(a) * 0.15,
        Math.cos(a) * sp, rnd(0.3, 0.9), Math.sin(a) * sp, rnd(0.45, 0.8), 0.22, rnd(0.6, 0.9),
        0.78, 0.7, 0.55, 0.55, 0, 3);
    }
  }

  /** Tower arrow tracer travelling on a parabola. */
  arrow(from: THREE.Vector3, to: THREE.Vector3): void {
    const o = this.arrowHead * AS;
    this.arrowHead = (this.arrowHead + 1) % (this.arrows.length / AS);
    const A = this.arrows;
    const dx = to.x - from.x, dz = to.z - from.z;
    A[o] = from.x; A[o + 1] = from.y; A[o + 2] = from.z;
    A[o + 3] = to.x; A[o + 4] = to.y; A[o + 5] = to.z;
    A[o + 6] = 0; A[o + 7] = 0.35; A[o + 8] = 0.5 + Math.sqrt(dx * dx + dz * dz) * 0.2; A[o + 9] = 1;
  }

  /** Swatted soldier tumbling away with a trail. */
  fling(p: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation): void {
    const c = this.col.set(color);
    const sp = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    this.flung.spawn(p.x, p.y + 0.12, p.z, vel.x, vel.y, vel.z, 6 + sp * 1.5, 2.5, 1, 14, -1e9, c.r, c.g, c.b);
    this.glow.spawn(p.x, p.y + 0.15, p.z, 0, 0, 0, 0.15, 0.6, 0.2, 2, 2, 2, 0.8);
  }

  /** Crackling orb around the fist while charging. Call every frame; null hides. */
  charge(p: THREE.Vector3 | null, level: number): void {
    if (!p) { this.chargeOn = false; return; }
    if (!this.chargeOn && this.chargeShown <= 0) this.chargeP.copy(p);
    this.chargeOn = true;
    this.chargeSince = 0;
    this.chargeP.copy(p);
    this.chargeLevel = Math.max(0, Math.min(1, level));
  }

  update(dtIn: number): void {
    const dt = Math.min(Math.max(dtIn, 0), MAX_DT);
    this.lines.begin();

    this.updateBolts(dt);
    this.updateArrows(dt);
    this.updateBeams(dt);
    this.updateCharge(dt);
    this.streaks.update(dt, this.lines);

    this.glow.update(dt);
    this.smoke.update(dt);
    this.rings.update(dt);
    this.debris.update(dt);
    this.flung.update(dt);
    this.updateScorches(dt);
    this.lines.end();

    this.flashI *= Math.exp(-dt * 9);
    if (this.flashI < 0.002) this.flashI = 0;
    this.flash = Math.min(1, this.flashI);
    this.flashLight.intensity = this.flashI * 110;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.glow.dispose(); this.smoke.dispose(); this.lines.dispose(); this.rings.dispose();
    this.debris.mesh.dispose(); this.flung.mesh.dispose();
    this.glowTex.dispose(); this.smokeTex.dispose(); this.scorchTex.dispose();
    for (const m of this.scorches) (m.material as THREE.Material).dispose();
  }

  // ============================================================ internals

  private beam(x: number, y: number, z: number, h: number, w: number, life: number, r: number, g: number, b: number) {
    const B = this.beams, o = this.beamHead * BMS;
    this.beamHead = (this.beamHead + 1) % (B.length / BMS);
    B[o] = x; B[o + 1] = y; B[o + 2] = z; B[o + 3] = h; B[o + 4] = w; B[o + 5] = 0; B[o + 6] = life;
    B[o + 7] = r; B[o + 8] = g; B[o + 9] = b; B[o + 10] = 1;
  }

  private updateBeams(dt: number) {
    const B = this.beams, L = this.lines;
    for (let o = 0; o < B.length; o += BMS) {
      if (B[o + 10] === 0) continue;
      const age = B[o + 5] + dt;
      B[o + 5] = age;
      const life = B[o + 6];
      if (age >= life) { B[o + 10] = 0; continue; }
      const t = age / life;
      const grow = 1 - Math.pow(1 - Math.min(1, t / 0.25), 3);
      const h = B[o + 3] * grow;
      const w = B[o + 4] * (1 - t * 0.7);
      const a = (1 - t) * (1 - t);
      const x = B[o], y = B[o + 1], z = B[o + 2];
      L.seg(x, y, z, x, y + h, z, w * 2.4, w * 1.2, B[o + 7] * 0.35, B[o + 8] * 0.35, B[o + 9] * 0.35, a * 0.7, 0);
      L.seg(x, y, z, x, y + h * 0.85, z, w, w * 0.3, B[o + 7], B[o + 8], B[o + 9], a, 0);
      L.seg(x, y, z, x, y + h * 0.6, z, w * 0.3, w * 0.1, 3, 3, 3, a, 0);
    }
  }

  private updateArrows(dt: number) {
    const A = this.arrows, L = this.lines;
    for (let o = 0; o < A.length; o += AS) {
      if (A[o + 9] === 0) continue;
      const age = A[o + 6] + dt;
      A[o + 6] = age;
      const dur = A[o + 7];
      const t = age / dur;
      if (t >= 1) {
        A[o + 9] = 0;
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * TAU;
          this.streaks.spawn(A[o + 3], A[o + 4] + 0.05, A[o + 5], Math.cos(a) * 2, rnd(1, 3), Math.sin(a) * 2,
            0.18, 3, 2.4, 1.4, 1, 0.03, 0.03, 12, 0, A[o + 4]);
        }
        continue;
      }
      const h = A[o + 8];
      // head + two trailing points along the arc
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < 3; k++) {
        const tt = Math.max(0, t - k * 0.09);
        const x = A[o] + (A[o + 3] - A[o]) * tt;
        const y = A[o + 1] + (A[o + 4] - A[o + 1]) * tt + h * 4 * tt * (1 - tt);
        const z = A[o + 2] + (A[o + 5] - A[o + 2]) * tt;
        if (k > 0) {
          const wa = k === 1 ? 0.07 : 0.035, wb = k === 1 ? 0.035 : 0.0;
          const aa = k === 1 ? 1 : 0.5, ab = k === 1 ? 0.5 : 0;
          L.seg(px, py, pz, x, y, z, wa, wb, 3.4, 2.9, 1.9, aa, ab);
          L.seg(px, py, pz, x, y, z, wa * 3, wb * 3, 1.2, 0.8, 0.4, aa * 0.35, ab * 0.35);
        }
        px = x; py = y; pz = z;
      }
    }
  }

  private scorch(x: number, y: number, z: number, r: number, life: number, hold: number, a0: number) {
    const i = this.scorchHead;
    this.scorchHead = (i + 1) % this.scorches.length;
    const m = this.scorches[i];
    m.position.set(x, y + 0.02 + i * 0.002, z);
    m.rotation.y = Math.random() * TAU;
    m.scale.set(r, 1, r);
    m.visible = true;
    const s = this.scorchState, o = i * 4;
    s[o] = 0; s[o + 1] = life; s[o + 2] = hold; s[o + 3] = a0;
  }

  private updateScorches(dt: number) {
    const s = this.scorchState;
    for (let i = 0; i < this.scorches.length; i++) {
      const m = this.scorches[i];
      if (!m.visible) continue;
      const o = i * 4;
      const age = s[o] + dt;
      s[o] = age;
      const life = s[o + 1], hold = s[o + 2];
      if (age >= life) { m.visible = false; continue; }
      const fadeIn = Math.min(1, age / 0.08);
      const k = age < hold ? 0 : (age - hold) / (life - hold);
      const f = 1 - k * k;
      (m.material as THREE.MeshBasicMaterial).opacity = s[o + 3] * fadeIn * f;
    }
  }

  // ------------------------------------------------------------ lightning

  private startBolt(kind: number, x: number, y: number, z: number, R: number, life: number, delay: number) {
    let b = this.bolts[0];
    for (const c of this.bolts) { if (!c.active) { b = c; break; } if (c.age > b.age) b = c; }
    b.active = true; b.kind = kind;
    b.x = x; b.y = y; b.z = z; b.radius = R;
    b.ox = rnd(-3, 3); b.oz = rnd(-4, -1);
    b.age = -delay; b.life = life; b.lastRegen = -1; b.nextRegen = 0; b.n = 0;
  }

  /** Midpoint-displacement path from A to B into `out`; returns point count (2^levels + 1). */
  private genPath(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    levels: number, disp: number, out: Float32Array): number {
    let src = this.tmpA, dst = this.tmpB;
    src[0] = ax; src[1] = ay; src[2] = az; src[3] = bx; src[4] = by; src[5] = bz;
    let n = 2;
    let amp = disp;
    for (let l = 0; l < levels; l++) {
      let k = 0;
      for (let i = 0; i < n - 1; i++) {
        const o = i * 3;
        const x0 = src[o], y0 = src[o + 1], z0 = src[o + 2], x1 = src[o + 3], y1 = src[o + 4], z1 = src[o + 5];
        dst[k++] = x0; dst[k++] = y0; dst[k++] = z0;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len2 = dx * dx + dy * dy + dz * dz + 1e-9;
        let rx = Math.random() * 2 - 1, ry = Math.random() * 2 - 1, rz = Math.random() * 2 - 1;
        const dot = (rx * dx + ry * dy + rz * dz) / len2;
        rx -= dx * dot; ry -= dy * dot; rz -= dz * dot;
        const m = Math.sqrt(len2) * amp;
        dst[k++] = (x0 + x1) * 0.5 + rx * m;
        dst[k++] = (y0 + y1) * 0.5 + ry * m;
        dst[k++] = (z0 + z1) * 0.5 + rz * m;
      }
      const o = (n - 1) * 3;
      dst[k++] = src[o]; dst[k++] = src[o + 1]; dst[k++] = src[o + 2];
      n = n * 2 - 1;
      const t = src; src = dst; dst = t;
      amp *= 0.9;
    }
    for (let i = 0; i < n * 3; i++) out[i] = src[i];
    return n;
  }

  private addSeg(b: Bolt, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, br: number) {
    if (b.n >= BOLT_SEGS) return;
    const s = b.segs, o = b.n++ * 8;
    s[o] = ax; s[o + 1] = ay; s[o + 2] = az; s[o + 3] = bx; s[o + 4] = by; s[o + 5] = bz; s[o + 6] = w; s[o + 7] = br;
  }

  private regenBolt(b: Bolt) {
    b.n = 0;
    const main = b.kind === 0;
    const ks = main ? 1 : 0.6;
    const topY = b.y + (main ? 18 : 16);
    const tx = b.x + b.ox + rnd(-0.5, 0.5), tz = b.z + b.oz + rnd(-0.5, 0.5);
    const P = this.mainPts;
    const np = this.genPath(tx, topY, tz, b.x, b.y, b.z, main ? 6 : 5, 0.22, P);
    for (let i = 0; i < np - 1; i++) {
      const f = i / (np - 1);
      const o = i * 3;
      this.addSeg(b, P[o], P[o + 1], P[o + 2], P[o + 3], P[o + 4], P[o + 5], (0.08 + 0.07 * f) * ks, 1);
    }
    // branches
    const nb = main ? 5 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 3);
    const Q = this.brPts;
    for (let k = 0; k < nb; k++) {
      const j = Math.floor(rnd(0.08, 0.85) * (np - 2));
      const o = j * 3;
      const sx = P[o], sy = P[o + 1], sz = P[o + 2];
      let dx = P[o + 3] - sx, dy = P[o + 4] - sy, dz = P[o + 5] - sz;
      let l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx = dx / l + rnd(-1, 1) * 0.9; dy = dy / l - 0.1; dz = dz / l + rnd(-1, 1) * 0.9;
      l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const len = rnd(1.5, 5) * (1 - 0.5 * j / np) * ks;
      let ex = sx + dx / l * len, ey = sy + dy / l * len, ez = sz + dz / l * len;
      if (ey < b.y + 0.3) ey = b.y + 0.3 + Math.random();
      const bn = this.genPath(sx, sy, sz, ex, ey, ez, 3, 0.3, Q);
      for (let i = 0; i < bn - 1; i++) {
        const f = i / (bn - 1);
        const q = i * 3;
        this.addSeg(b, Q[q], Q[q + 1], Q[q + 2], Q[q + 3], Q[q + 4], Q[q + 5], 0.05 * (1 - 0.7 * f) * ks, 0.75 * (1 - 0.75 * f));
      }
      // sub-branch
      if (main && Math.random() < 0.5) {
        const m = Math.floor(rnd(0.2, 0.7) * (bn - 1)) * 3;
        const s2x = Q[m], s2y = Q[m + 1], s2z = Q[m + 2];
        ex = s2x + rnd(-1.5, 1.5); ey = Math.max(b.y + 0.3, s2y - rnd(0.5, 2)); ez = s2z + rnd(-1.5, 1.5);
        const cn = this.genPath(s2x, s2y, s2z, ex, ey, ez, 2, 0.35, Q);
        for (let i = 0; i < cn - 1; i++) {
          const q = i * 3;
          this.addSeg(b, Q[q], Q[q + 1], Q[q + 2], Q[q + 3], Q[q + 4], Q[q + 5], 0.025, 0.4);
        }
      }
    }
    // ground crawlers (electric tendrils racing over the ground)
    const nc = main ? 6 + Math.floor(Math.random() * 3) : 2;
    for (let k = 0; k < nc; k++) {
      const a = Math.random() * TAU;
      const L = rnd(0.45, 1.05) * b.radius * (main ? 1 : 0.5);
      const cn = this.genPath(b.x, b.y + 0.05, b.z, b.x + Math.cos(a) * L, b.y + 0.05, b.z + Math.sin(a) * L, 4, 0.3, Q);
      for (let i = 0; i < cn - 1; i++) {
        const q = i * 3;
        const f = i / (cn - 1);
        const y0 = Math.max(Q[q + 1], b.y + 0.04), y1 = Math.max(Q[q + 4], b.y + 0.04);
        this.addSeg(b, Q[q], y0 * 0.5 + (b.y + 0.05) * 0.5, Q[q + 2], Q[q + 3], y1 * 0.5 + (b.y + 0.05) * 0.5, Q[q + 5],
          0.045 * (1 - 0.6 * f), 0.85 * (1 - 0.7 * f));
      }
    }
    // flash for this stroke
    this.flashI = Math.max(this.flashI, main ? 1.1 : 0.6);
    this.flashLight.position.set(b.x, b.y + 3, b.z);
    this.glow.spawn(b.x, b.y + 0.3, b.z, 0, 0, 0, 0.1, 1.4 * ks, 2.2 * ks, 2.2, 2.6, 4, 0.8);
    this.glow.spawn(tx, topY, tz, 0, 0, 0, 0.18, 3.5 * ks, 5 * ks, 1, 1.3, 2.4, 0.8);
  }

  private updateBolts(dt: number) {
    const L = this.lines;
    for (let bi = 0; bi < this.bolts.length; bi++) {
      const b = this.bolts[bi];
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.life) { b.active = false; continue; }
      if (b.age < 0) continue;
      if (b.age >= b.nextRegen) {
        this.regenBolt(b);
        b.lastRegen = b.age;
        b.nextRegen = b.age + rnd(0.06, 0.11);
      }
      const since = b.age - b.lastRegen;
      let env = 0.35 + 0.65 * Math.exp(-since * 16);
      env *= 0.8 + 0.2 * Math.random();
      const rem = b.life - b.age;
      if (rem < 0.1) env *= rem / 0.1;
      const s = b.segs;
      for (let i = 0; i < b.n; i++) {
        const o = i * 8;
        const w = s[o + 6], br = s[o + 7] * env;
        // wide blue halo
        L.seg(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], w * 5, w * 5, 0.5, 0.75, 2.2, 0.35 * br, 0.35 * br);
        // hot white core
        L.seg(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], w, w, 3.4, 3.6, 4.6, br, br);
      }
    }
  }

  // ------------------------------------------------------------ charge orb

  private updateCharge(dt: number) {
    this.chargeSince += dt;
    if (this.chargeSince > 0.3) this.chargeOn = false; // safety: caller stopped calling
    const target = this.chargeOn ? 1 : 0;
    this.chargeShown += (target - this.chargeShown) * Math.min(1, dt * (this.chargeOn ? 18 : 10));
    if (!this.chargeOn && this.chargeShown < 0.02) this.chargeShown = 0;
    const vis = this.chargeShown;
    const on = vis > 0;
    this.chargeHalo.visible = this.chargeCore.visible = on;
    if (!on) { this.chargeLight.intensity = 0; return; }

    this.chargeT += dt;
    const t = this.chargeT, lv = this.chargeLevel;
    const P = this.chargeP;
    const R = (0.28 + 0.55 * lv) * (0.4 + 0.6 * vis);
    const pulse = 1 + 0.12 * Math.sin(t * (14 + lv * 22)) + 0.06 * (Math.random() - 0.5);

    this.chargeHalo.position.copy(P);
    this.chargeCore.position.copy(P);
    const hs = R * 5 * pulse, cs = R * 1.9 * pulse;
    this.chargeHalo.scale.set(hs, hs, 1);
    this.chargeCore.scale.set(cs, cs, 1);
    const hi = (0.5 + 1.6 * lv) * vis;
    (this.chargeHalo.material as THREE.SpriteMaterial).color.setRGB(0.25 * hi, 0.65 * hi, 1.5 * hi);
    const ci = (1.2 + 3.5 * lv) * vis;
    (this.chargeCore.material as THREE.SpriteMaterial).color.setRGB(0.85 * ci, 0.95 * ci, 1.1 * ci);

    this.chargeLight.position.copy(P);
    this.chargeLight.intensity = (4 + 60 * lv * lv) * vis * (0.8 + 0.4 * Math.random());

    // arcs: regenerate every ~50 ms
    this.chargeArcT -= dt;
    if (this.chargeArcT <= 0) {
      this.chargeArcT = rnd(0.035, 0.07);
      const na = Math.min(10, 1 + Math.floor(lv * 6 + Math.random() * 2));
      this.arcCount = na;
      for (let k = 0; k < na; k++) {
        let ax = rnd(-1, 1), ay = rnd(-1, 1), az = rnd(-1, 1);
        let l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        ax /= l; ay /= l; az /= l;
        let bx = ax + rnd(-0.8, 0.8), by = ay + rnd(-0.8, 0.8), bz = az + rnd(-0.8, 0.8);
        l = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        const r0 = R * 0.45, r1 = R * rnd(1.3, 2.3);
        const n = this.genPath(P.x + ax * r0, P.y + ay * r0, P.z + az * r0,
          P.x + bx / l * r1, P.y + by / l * r1, P.z + bz / l * r1, 3, 0.35, this.brPts);
        const base = k * 27;
        for (let i = 0; i < n * 3; i++) this.arcPts[base + i] = this.brPts[i];
        this.arcN[k] = n;
      }
    }
    const L = this.lines;
    const ab = (0.6 + 0.6 * lv) * vis;
    for (let k = 0; k < this.arcCount; k++) {
      const base = k * 27, n = this.arcN[k];
      const flick = Math.random() < 0.15 ? 0.2 : 1;
      for (let i = 0; i < n - 1; i++) {
        const o = base + i * 3;
        const f = i / (n - 1);
        const w = 0.03 * (1 - 0.6 * f);
        const a = ab * flick * (1 - 0.6 * f);
        const A = this.arcPts;
        L.seg(A[o], A[o + 1], A[o + 2], A[o + 3], A[o + 4], A[o + 5], w * 4, w * 4, 0.4, 0.75, 2, a * 0.4, a * 0.4);
        L.seg(A[o], A[o + 1], A[o + 2], A[o + 3], A[o + 4], A[o + 5], w, w, 2.6, 3.2, 4.4, a, a);
      }
    }
    // orbiting motes (short curved trails)
    const M = this.moteAxes;
    const nm = 4 + Math.floor(lv * 8);
    for (let i = 0; i < nm; i++) {
      const o = i * 9;
      const rr = R * M[o + 8];
      const ang = t * M[o + 6] + M[o + 7];
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < 3; k++) {
        const a2 = ang - k * 0.22 * Math.sign(M[o + 6]);
        const c = Math.cos(a2) * rr, s = Math.sin(a2) * rr;
        const x = P.x + M[o] * c + M[o + 3] * s, y = P.y + M[o + 1] * c + M[o + 4] * s, z = P.z + M[o + 2] * c + M[o + 5] * s;
        if (k > 0) L.seg(px, py, pz, x, y, z, k === 1 ? 0.04 : 0.025, k === 1 ? 0.025 : 0, 1.4, 2.4, 3.6,
          vis * (k === 1 ? 1 : 0.5), vis * (k === 1 ? 0.5 : 0));
        px = x; py = y; pz = z;
      }
    }
    // energy being sucked in
    this.chargeEmit += dt * (15 + 70 * lv) * vis;
    while (this.chargeEmit >= 1) {
      this.chargeEmit -= 1;
      let dx = rnd(-1, 1), dy = rnd(-1, 1), dz = rnd(-1, 1);
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const r0 = R * rnd(2.5, 4.5);
      dx = dx / l * r0; dy = dy / l * r0; dz = dz / l * r0;
      const life = rnd(0.22, 0.38);
      this.streaks.spawn(P.x + dx, P.y + dy, P.z + dz, -dx / life, -dy / life, -dz / life, life * 0.92,
        1.2, 2.2, 3.6, 0.9, 0.035, 0.03, 0);
    }
  }
}
