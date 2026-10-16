import * as THREE from 'three';

/**
 * Sandbox effects: two pooled particle systems (additive "glow" for sparks / fire / magic, normal
 * blended "smoke" for dust and smoke that grows as it rises) plus one-off effects (lightning,
 * shockwave rings, scorch marks).
 */

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
const FRAG_GLOW = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor * (0.6 + 0.8 * a), a * vAlpha);
}`;
const FRAG_SMOKE = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.1, r);
  gl_FragColor = vec4(vColor, a * vAlpha * 0.75);
}`;

/** One pool of point particles. */
class Pool {
  readonly points: THREE.Points;
  private pos: Float32Array; private vel: Float32Array; private col: Float32Array;
  private size: Float32Array; private alpha: Float32Array; private life: Float32Array; private maxLife: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private grow: Float32Array;
  private next = 0;
  private geo = new THREE.BufferGeometry();
  readonly mat: THREE.ShaderMaterial;
  private tmp = new THREE.Color();

  constructor(private max: number, frag: string, blending: THREE.Blending, private fadeIn = false) {
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max); this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.grow = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { uScale: { value: 300 } }, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.ColorRepresentation, life: number, size: number, gravity: number, drag: number, grow = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.tmp.set(color);
    this.col[i * 3] = this.tmp.r; this.col[i * 3 + 1] = this.tmp.g; this.col[i * 3 + 2] = this.tmp.b;
    this.size[i] = size; this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = gravity; this.drag[i] = drag; this.grow[i] = grow;
    this.alpha[i] = this.fadeIn ? 0 : 1;
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
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
      this.size[i] += this.grow[i] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      // smoke fades in quickly, then out
      this.alpha[i] = this.fadeIn ? Math.min(1, (1 - k) * 8) * k : k;
    }
    for (const name of ['position', 'aAlpha', 'aColor', 'aSize']) (this.geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() { this.life.fill(0); this.alpha.fill(0); }
}

interface Timed { obj: THREE.Object3D; t: number; life: number; update: (k: number) => void }

export class Fx {
  group = new THREE.Group();
  private glow = new Pool(5000, FRAG_GLOW, THREE.AdditiveBlending);
  private smokePool = new Pool(3000, FRAG_SMOKE, THREE.NormalBlending, true);
  private timed: Timed[] = [];
  /** One persistent flash light (adding/removing lights forces shader recompiles). */
  private flash = new THREE.PointLight('#cfe8ff', 0, 34, 2);
  private flashT = 1;
  private flashPeak = 600;

  constructor() {
    // smoke draws first so glowing sparks stay visible through it
    this.smokePool.points.renderOrder = 1;
    this.glow.points.renderOrder = 2;
    this.group.add(this.smokePool.points, this.glow.points, this.flash);
  }

  setScale(viewportHeight: number) {
    this.glow.mat.uniforms.uScale.value = viewportHeight * 0.5;
    this.smokePool.mat.uniforms.uScale.value = viewportHeight * 0.5;
  }

  /** Glowing (additive) particle. */
  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.ColorRepresentation, life = 1, size = 0.5, gravity = -9, drag = 0.5) {
    this.glow.spawn(p, v, color, life, size, gravity, drag);
  }

  /** Soft, normal-blended puff (smoke, dust) that grows by `grow` units/s. */
  smoke(p: THREE.Vector3, v: THREE.Vector3, color: THREE.ColorRepresentation, life = 2, size = 1.5, grow = 1.5, gravity = 0.6, drag = 0.8) {
    this.smokePool.spawn(p, v, color, life, size, gravity, drag, grow);
  }

  burst(p: THREE.Vector3, color: THREE.ColorRepresentation, n = 40, speed = 8, life = 0.9, size = 0.5, gravity = -12) {
    const v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      v.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      this.spawn(p, v, color, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), gravity, 1.2);
    }
  }

  /** A billowing dust cloud (collapses, slams). */
  dust(p: THREE.Vector3, n = 14, radius = 1.5, color = '#b9ad98', speed = 3) {
    const v = new THREE.Vector3(), q = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
      q.set(p.x + Math.cos(a) * r, p.y + Math.random() * radius * 0.6, p.z + Math.sin(a) * r);
      v.set(Math.cos(a) * speed * (0.4 + Math.random()), 0.6 + Math.random() * speed * 0.5, Math.sin(a) * speed * (0.4 + Math.random()));
      this.smoke(q, v, color, 1.6 + Math.random() * 1.4, 1.2 + Math.random() * 1.2, 1.4 + Math.random(), 0.3, 1.6);
    }
  }

  /** Explosion: fireball sparks, embers and a smoke cloud. */
  explosion(p: THREE.Vector3, scale = 1) {
    this.burst(p, '#ffb347', Math.round(40 * scale), 10 * scale, 0.7, 0.9 * scale, -6);
    this.burst(p, '#ff5a1f', Math.round(25 * scale), 7 * scale, 0.5, 1.2 * scale, -2);
    this.burst(p, '#fff3c4', Math.round(12 * scale), 4 * scale, 0.35, 1.4 * scale, 0);
    this.dust(p, Math.round(10 * scale), 1.2 * scale, '#5a524c', 2.5 * scale);
  }

  /** Expanding flat ring on the ground. */
  ring(p: THREE.Vector3, color: THREE.ColorRepresentation, maxR = 8, dur = 0.6) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(Math.max(0.08, p.y));
    this.add(m, dur, (k) => { m.scale.setScalar(0.3 + maxR * k); (m.material as THREE.MeshBasicMaterial).opacity = 1 - k; });
  }

  /** Dark scorch decal that fades over a few seconds. */
  scorch(p: THREE.Vector3, r = 2.2, dur = 6) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ color: '#1a1410', transparent: true, opacity: 0.55, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(0.03);
    this.add(m, dur, (k) => { (m.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k * k); });
  }

  /** Jagged lightning bolt from the sky (or from `from`) to `to`, with a flash light. */
  bolt(to: THREE.Vector3, color = '#cfe8ff', from?: THREE.Vector3) {
    const pts: THREE.Vector3[] = [];
    const top = from?.clone() ?? to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 30, (Math.random() - 0.5) * 6));
    const N = 14;
    const jag = Math.min(2.2, top.distanceTo(to) * 0.08);
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const p = top.clone().lerp(to, k);
      if (i > 0 && i < N) p.add(new THREE.Vector3((Math.random() - 0.5) * jag, (Math.random() - 0.5) * jag * 0.3, (Math.random() - 0.5) * jag));
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.12, 6), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.5, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    const g = new THREE.Group();
    g.add(core, glow);
    this.flashAt(to, color);
    this.add(g, 0.35, (k) => {
      const f = Math.random() < 0.3 ? 0.3 : 1;
      (core.material as THREE.MeshBasicMaterial).opacity = (1 - k) * f;
      (glow.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - k) * f;
    });
  }

  /** Short bright light flash at a point (explosions, bolts). */
  flashAt(p: THREE.Vector3, color: THREE.ColorRepresentation = '#ffd9a0', peak = 600) {
    this.flash.color.set(color);
    this.flash.position.copy(p).setY(Math.max(3, p.y + 2));
    this.flashT = 0;
    this.flashPeak = peak;
  }

  /** Remove every particle and one-off effect (mode switches). */
  clear() {
    this.glow.clear();
    this.smokePool.clear();
    for (const t of this.timed) { t.t = t.life; }
  }

  private add(obj: THREE.Object3D, life: number, update: (k: number) => void) {
    this.group.add(obj);
    update(0);
    this.timed.push({ obj, t: 0, life, update });
  }

  update(dt: number) {
    this.flashT = Math.min(1, this.flashT + dt / 0.35);
    this.flash.intensity = this.flashT < 1 ? this.flashPeak * (1 - this.flashT) * (Math.random() < 0.3 ? 0.3 : 1) : 0;
    this.glow.update(dt);
    this.smokePool.update(dt);
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
