import * as CANNON from 'cannon-es';
import * as THREE from 'three';

/** Playable area (world units), centred on the origin. */
export const ARENA = { w: 46, d: 30 };
const MAX_ITEMS = 180;
const COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#ef476f', '#9b5de5', '#ff9f1c', '#f15bb5'];

export interface Item {
  body: CANNON.Body;
  mesh: THREE.Object3D;
  kind: 'ball' | 'crate' | 'block' | 'pin' | 'beach' | 'cannonball' | 'meteor';
  starter: boolean;
  /** Seconds left of a shrink-and-vanish animation. */
  dying?: number;
  /** Meteors explode on their first hit. */
  hit?: boolean;
}

const v3 = (x: number, y: number, z: number) => new CANNON.Vec3(x, y, z);

function crateTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c98b4a'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#b0743a';
  for (let y = 0; y < 128; y += 32) g.fillRect(0, y + 28, 128, 4);
  g.strokeStyle = '#7a4a22'; g.lineWidth = 10; g.strokeRect(5, 5, 118, 118);
  g.lineWidth = 8; g.beginPath(); g.moveTo(8, 8); g.lineTo(120, 120); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9ccc65'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(80,140,50,0.25)' : 'rgba(190,230,120,0.25)';
    g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2;
  for (let k = 0; k <= 512; k += 64) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 512); g.moveTo(0, k); g.lineTo(512, k); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ARENA.w / 8, ARENA.d / 8);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Physics world + the meshes that mirror it. */
export class Playground {
  world = new CANNON.World({ gravity: v3(0, -22, 0) });
  group = new THREE.Group();
  items: Item[] = [];
  /** Called when a meteor hits something (explosion handled by the caller). */
  onMeteorHit: ((p: THREE.Vector3) => void) | null = null;
  private matCache = new Map<string, THREE.MeshStandardMaterial>();
  private crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.8 });
  private sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private pinGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 14);
  private ballMat = new CANNON.Material('ball');
  private pending: Item[] = [];
  private meteorMat = new THREE.MeshStandardMaterial({ color: '#ff7b00', emissive: '#ff4d00', emissiveIntensity: 2.5, roughness: 0.6 });

  constructor() {
    const w = this.world;
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    w.defaultContactMaterial.friction = 0.35;
    w.defaultContactMaterial.restitution = 0.25;
    w.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, w.defaultMaterial, { friction: 0.3, restitution: 0.65 }));

    // ground
    const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    w.addBody(ground);
    const gm = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.w + 30, ARENA.d + 30), new THREE.MeshStandardMaterial({ color: '#7fb04f', roughness: 1 }));
    gm.rotation.x = -Math.PI / 2;
    gm.position.y = -0.02;
    gm.receiveShadow = true;
    const field = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.w, ARENA.d), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
    field.rotation.x = -Math.PI / 2;
    field.receiveShadow = true;
    this.group.add(gm, field);

    // low fence so toys stay in the playground
    const fenceMat = new THREE.MeshStandardMaterial({ color: '#f4e1c1', roughness: 0.7 });
    const wall = (x: number, z: number, sx: number, sz: number) => {
      const b = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Box(v3(sx / 2, 1.5, sz / 2)), position: v3(x, 1.5, z) });
      w.addBody(b);
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.9, sz), fenceMat);
      m.position.set(x, 0.45, z);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    };
    wall(0, -ARENA.d / 2 - 0.3, ARENA.w + 1.2, 0.6);
    wall(0, ARENA.d / 2 + 0.3, ARENA.w + 1.2, 0.6);
    wall(-ARENA.w / 2 - 0.3, 0, 0.6, ARENA.d);
    wall(ARENA.w / 2 + 0.3, 0, 0.6, ARENA.d);

    // a ramp to launch things off
    const ramp = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Box(v3(3.5, 0.25, 2.5)), position: v3(15, 1.3, -7) });
    ramp.quaternion.setFromEuler(0, 0, 0.36);
    w.addBody(ramp);
    const rm = new THREE.Mesh(new THREE.BoxGeometry(7, 0.5, 5), new THREE.MeshStandardMaterial({ color: '#e9c46a', roughness: 0.6 }));
    rm.position.set(15, 1.3, -7);
    rm.rotation.z = 0.36;
    rm.castShadow = rm.receiveShadow = true;
    this.group.add(rm);

    this.starters();
  }

  private mat(color: string) {
    let m = this.matCache.get(color);
    if (!m) this.matCache.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 })));
    return m;
  }

  /** The toys the playground starts with. */
  starters() {
    this.tower(new THREE.Vector3(-12, 0, -4), 10, true);
    // bowling pins in a triangle, facing a beach ball
    for (let row = 0; row < 4; row++) for (let k = 0; k <= row; k++) {
      this.spawnPin(new THREE.Vector3(2 + row * 1.1, 0, -6 + (k - row / 2) * 1.1), true);
    }
    this.spawnBall(new THREE.Vector3(-3, 1.4, -6), 1.4, '#ff6b6b', 'beach', true);
    // crate pyramid
    for (let row = 0; row < 3; row++) for (let k = 0; k < 3 - row; k++) {
      this.spawnBox(new THREE.Vector3(-4 + k * 1.6 + row * 0.8, 0.75 + row * 1.5, 7), 1.5, 'crate', undefined, true);
    }
    for (let k = 0; k < 6; k++) this.spawnBall(new THREE.Vector3(9 + (k % 3) * 1.6, 0.6 + Math.floor(k / 3) * 1.2, 6), 0.6, COLORS[k % COLORS.length], 'ball', true);
  }

  private add(body: CANNON.Body, mesh: THREE.Object3D, kind: Item['kind'], starter = false): Item {
    body.sleepSpeedLimit = 0.15;
    body.sleepTimeLimit = 0.6;
    body.linearDamping = 0.05;
    body.angularDamping = 0.15;
    this.world.addBody(body);
    mesh.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    mesh.position.copy(body.position as unknown as THREE.Vector3);
    this.group.add(mesh);
    const it: Item = { body, mesh, kind, starter };
    this.items.push(it);
    // keep the toy count sane: retire the oldest spawned ones
    const extra = this.items.filter((i) => !i.dying).length - MAX_ITEMS;
    if (extra > 0) for (const old of this.items.filter((i) => !i.dying && !i.starter).slice(0, extra)) old.dying = 0.4;
    return it;
  }

  spawnBall(p: THREE.Vector3, r = 0.6, color = COLORS[(Math.random() * COLORS.length) | 0], kind: Item['kind'] = 'ball', starter = false) {
    const body = new CANNON.Body({ mass: kind === 'beach' ? 0.6 : r * r * 2.5, shape: new CANNON.Sphere(r), position: v3(p.x, Math.max(p.y, r), p.z), material: this.ballMat });
    const m = new THREE.Mesh(this.sphereGeo, this.mat(color));
    m.scale.setScalar(r);
    if (kind === 'beach') {
      // striped beach ball
      const stripes = new THREE.Mesh(this.sphereGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, transparent: true, opacity: 0.95, alphaMap: stripeTexture() }));
      stripes.scale.setScalar(1.003);
      m.add(stripes);
    }
    return this.add(body, m, kind, starter);
  }

  spawnBox(p: THREE.Vector3, s = 1.2, kind: Item['kind'] = 'crate', color?: string, starter = false) {
    const body = new CANNON.Body({ mass: s * s * s * 0.8, shape: new CANNON.Box(v3(s / 2, s / 2, s / 2)), position: v3(p.x, Math.max(p.y, s / 2), p.z) });
    body.quaternion.setFromEuler(0, Math.random() * 0.3, 0);
    const m = new THREE.Mesh(this.boxGeo, kind === 'crate' ? this.crateMat : this.mat(color ?? COLORS[(Math.random() * COLORS.length) | 0]));
    m.scale.setScalar(s);
    return this.add(body, m, kind, starter);
  }

  spawnPin(p: THREE.Vector3, starter = false) {
    const body = new CANNON.Body({ mass: 0.5, shape: new CANNON.Cylinder(0.22, 0.32, 1.5, 10), position: v3(p.x, 0.76, p.z) });
    const m = new THREE.Mesh(this.pinGeo, this.mat('#fbfbf7'));
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.25, 0.14, 14), this.mat('#e63946'));
    stripe.position.y = 0.38;
    m.add(stripe);
    return this.add(body, m, 'pin', starter);
  }

  /** Stack of alternating blocks. */
  tower(p: THREE.Vector3, n = 8, starter = false) {
    const s = 1.1;
    for (let i = 0; i < n; i++) {
      const it = this.spawnBox(new THREE.Vector3(p.x, s / 2 + i * s * 1.0, p.z), s, 'block', COLORS[i % COLORS.length], starter);
      it.body.quaternion.setFromEuler(0, (i % 2) * 0.12, 0);
    }
  }

  spawnCannonball(p: THREE.Vector3, vel: THREE.Vector3) {
    const it = this.spawnBall(p, 0.45, '#2b2d42', 'cannonball');
    it.body.mass = 8;
    it.body.updateMassProperties();
    it.body.velocity.set(vel.x, vel.y, vel.z);
    return it;
  }

  spawnMeteor(p: THREE.Vector3, vel: THREE.Vector3) {
    const body = new CANNON.Body({ mass: 4, shape: new CANNON.Sphere(0.6), position: v3(p.x, p.y, p.z) });
    body.velocity.set(vel.x, vel.y, vel.z);
    const m = new THREE.Mesh(this.sphereGeo, this.meteorMat);
    m.scale.setScalar(0.6);
    const it = this.add(body, m, 'meteor');
    body.addEventListener('collide', () => { if (!it.hit) { it.hit = true; this.pending.push(it); } });
    return it;
  }

  /** Nearest live item to a ground point (horizontal distance), within `maxD`. */
  nearest(p: THREE.Vector3, maxD: number): Item | null {
    let best: Item | null = null, bd = maxD;
    for (const it of this.items) {
      if (it.dying !== undefined || it.kind === 'meteor') continue;
      const b = it.body.position;
      const d = Math.hypot(b.x - p.x, b.z - p.z) - (it.kind === 'beach' ? 1 : 0);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  /** Radial blast: horizontal push away from `c` plus some lift, falling off to 0 at `radius`. */
  blast(c: THREE.Vector3, radius: number, strength: number, lift = 0.5) {
    for (const it of this.items) {
      const b = it.body;
      const dx = b.position.x - c.x, dz = b.position.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const k = (1 - d / radius) * strength * b.mass;
      const n = d > 1e-3 ? 1 / d : 0;
      b.wakeUp();
      b.applyImpulse(v3(dx * n * k, k * lift, dz * n * k));
      b.angularVelocity.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    }
  }

  /** Same impulse (per unit mass) to everything. */
  shove(dir: THREE.Vector3, jitter = 0.3) {
    for (const it of this.items) {
      const b = it.body, m = b.mass;
      b.wakeUp();
      b.applyImpulse(v3((dir.x + (Math.random() - 0.5) * jitter * 4) * m, (dir.y + Math.random() * jitter * 4) * m, (dir.z + (Math.random() - 0.5) * jitter * 4) * m));
    }
  }

  /** Continuous force toward / around a point (vacuum, tornado), call every step. */
  pullToward(c: THREE.Vector3, radius: number, strength: number, swirl = 0, lift = 0) {
    for (const it of this.items) {
      const b = it.body;
      const dx = c.x - b.position.x, dz = c.z - b.position.z;
      const d = Math.hypot(dx, dz);
      if (d > radius || d < 1e-3) continue;
      const k = (1 - d / radius) * b.mass;
      b.wakeUp();
      b.applyForce(v3((dx / d) * strength * k + (-dz / d) * swirl * k, lift * k, (dz / d) * strength * k + (dx / d) * swirl * k));
    }
  }

  /** Everything spawned shrinks away; with an empty field, the starter toys come back. */
  clear() {
    const live = this.items.filter((i) => i.dying === undefined);
    if (!live.length) { this.starters(); return 'reset'; }
    for (const it of live) it.dying = 0.45;
    return 'cleared';
  }

  step(dt: number) {
    this.world.step(1 / 60, dt, 4);
    for (const it of this.pending) {
      if (it.dying !== undefined) continue;
      const p = it.body.position;
      this.onMeteorHit?.(new THREE.Vector3(p.x, p.y, p.z));
      it.dying = 0.01;
    }
    this.pending = [];
    for (const it of this.items) {
      it.mesh.position.copy(it.body.position as unknown as THREE.Vector3);
      it.mesh.quaternion.copy(it.body.quaternion as unknown as THREE.Quaternion);
      if (it.dying !== undefined) {
        it.dying -= dt;
        const base = it.kind === 'ball' || it.kind === 'beach' || it.kind === 'cannonball' || it.kind === 'meteor'
          ? (it.body.shapes[0] as CANNON.Sphere).radius : it.kind === 'pin' ? 1 : (it.body.shapes[0] as CANNON.Box).halfExtents.x * 2;
        it.mesh.scale.setScalar(Math.max(0.001, base * Math.max(0, it.dying / 0.45)));
      }
      // fell out of the world
      if (it.body.position.y < -20) it.dying = Math.min(it.dying ?? 0, 0);
    }
    for (const it of this.items.filter((i) => i.dying !== undefined && i.dying <= 0)) {
      this.world.removeBody(it.body);
      this.group.remove(it.mesh);
    }
    this.items = this.items.filter((i) => !(i.dying !== undefined && i.dying <= 0));
  }
}

let stripeTex: THREE.Texture | null = null;
function stripeTexture() {
  if (stripeTex) return stripeTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 8;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 8);
  g.fillStyle = '#fff';
  for (let k = 0; k < 6; k += 2) g.fillRect((k * 256) / 6, 0, 256 / 6, 8);
  stripeTex = new THREE.CanvasTexture(c);
  return stripeTex;
}
