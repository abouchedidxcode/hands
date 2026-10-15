import * as THREE from 'three';

/** Pooled additive particles + a few one-off effects (lightning, rings, scorch marks). */
const MAX = 4000;

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  vAlpha = aAlpha;
  vColor = aColor;
}`;
const FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor * (0.6 + 0.8 * a), a * vAlpha);
}`;

interface Timed { obj: THREE.Object3D; t: number; life: number; update: (k: number) => void }

export class Fx {
  group = new THREE.Group();
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private next = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private timed: Timed[] = [];
  private tmpC = new THREE.Color();
  /** One persistent flash light (adding/removing lights forces shader recompiles). */
  private flash = new THREE.PointLight('#cfe8ff', 0, 34, 2);
  private flashT = 1;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 300 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(this.geo, this.mat);
    pts.frustumCulled = false;
    this.group.add(pts, this.flash);
  }

  setScale(viewportHeight: number) { this.mat.uniforms.uScale.value = viewportHeight * 0.5; }

  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.ColorRepresentation, life = 1, size = 0.5, gravity = -9, drag = 0.5) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.tmpC.set(color);
    this.col.set([this.tmpC.r, this.tmpC.g, this.tmpC.b], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  burst(p: THREE.Vector3, color: THREE.ColorRepresentation, n = 40, speed = 8, life = 0.9, size = 0.5, gravity = -12) {
    const v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      v.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      this.spawn(p, v, color, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), gravity, 1.2);
    }
  }

  /** Expanding flat ring on the ground. */
  ring(p: THREE.Vector3, color: THREE.ColorRepresentation, maxR = 8, dur = 0.6) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(0.08);
    this.add(m, dur, (k) => { m.scale.setScalar(0.3 + maxR * k); (m.material as THREE.MeshBasicMaterial).opacity = 1 - k; });
  }

  /** Dark scorch decal that fades over a few seconds. */
  scorch(p: THREE.Vector3, r = 2.2) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ color: '#1a1410', transparent: true, opacity: 0.55, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(0.03);
    this.add(m, 6, (k) => { (m.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k * k); });
  }

  /** Jagged lightning bolt from the sky to `to`, with a flash light. */
  bolt(to: THREE.Vector3, color = '#cfe8ff') {
    const pts: THREE.Vector3[] = [];
    const top = to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 30, (Math.random() - 0.5) * 6));
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const p = top.clone().lerp(to, k);
      if (i > 0 && i < N) p.add(new THREE.Vector3((Math.random() - 0.5) * 2.2, 0, (Math.random() - 0.5) * 2.2));
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.12, 6), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.5, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    const g = new THREE.Group();
    g.add(core, glow);
    this.flash.color.set(color);
    this.flash.position.copy(to).setY(3);
    this.flashT = 0;
    this.add(g, 0.35, (k) => {
      const f = Math.random() < 0.3 ? 0.3 : 1;
      (core.material as THREE.MeshBasicMaterial).opacity = (1 - k) * f;
      (glow.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - k) * f;
    });
  }

  private add(obj: THREE.Object3D, life: number, update: (k: number) => void) {
    this.group.add(obj);
    update(0);
    this.timed.push({ obj, t: 0, life, update });
  }

  update(dt: number) {
    this.flashT = Math.min(1, this.flashT + dt / 0.35);
    this.flash.intensity = this.flashT < 1 ? 600 * (1 - this.flashT) * (Math.random() < 0.3 ? 0.3 : 1) : 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const o = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[o] *= d; this.vel[o + 2] *= d;
      this.vel[o + 1] = this.vel[o + 1] * d + this.grav[i] * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < 0.05) { this.pos[o + 1] = 0.05; this.vel[o + 1] *= -0.3; }
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i]);
    }
    for (const name of ['position', 'aAlpha', 'aColor', 'aSize']) (this.geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
    for (const t of this.timed) {
      t.t += dt;
      t.update(Math.min(1, t.t / t.life));
    }
    for (const t of this.timed.filter((x) => x.t >= x.life)) {
      this.group.remove(t.obj);
      t.obj.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    }
    this.timed = this.timed.filter((x) => x.t < x.life);
  }
}
