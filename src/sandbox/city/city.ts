import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { Rng } from '../../game/rng';
import type { Fx } from '../fx';
import { BROKEN, facadeMaterial } from './facade';

/**
 * The destructible city. Buildings are grids of columns; each column is a stack of floor-height
 * chunks, drawn as ONE instance of a shared InstancedMesh and collided as one box of the building's
 * static compound body. Damage truncates columns: chunks inside a blast fly off as debris, and the
 * part of the column above the gap falls as a slab that shatters when it lands. Debris is capped;
 * settled debris becomes static rubble.
 */

export const CITY = { w: 46, d: 30 };
export const FH = 1.3;                 // chunk (floor) height
const MAX_INST = 6000;
const MAX_ACTIVE = 170;                // dynamic debris bodies alive at once (physics cost scales with it)
const MAX_RUBBLE = 1600;               // static rubble instances kept
const MAX_WRECKS = 40;                 // wrecked cars kept
const SHATTER_SPEED = 7.5;
const ROAD = 2.4;
const NB = { x: 5, z: 3 };

export type Style = 0 | 1 | 2 | 3;
/** $ millions per destroyed chunk, by style (glass tower, office, brick, house). */
const VALUE: Record<Style, number> = { 0: 16, 1: 9, 2: 6, 3: 3 };
const PALETTE: Record<Style, string[]> = {
  0: ['#8fb3c9', '#9fbfd6', '#7ea6c0', '#b5c9d6', '#6f97b3', '#a6b8c8'],
  1: ['#e2dccd', '#cfc5b0', '#d9d3c7', '#bfc7cf', '#e8e0cf', '#c9b79c'],
  2: ['#b8654a', '#c47a58', '#a35a45', '#c9876a', '#9c6b54'],
  3: ['#f2e8cf', '#f4d6a0', '#e6b8a2', '#a7c4bc', '#f1c6c6', '#cfe0f0'],
};
const CAR_COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#f78c6b', '#ffffff', '#3d405b', '#e63946', '#8338ec'];
const DUST = '#b9ad98';

export interface Column { x: number; z: number; w: number; d: number; h: number; inst: number }
export interface Building {
  id: number; x: number; z: number; w: number; d: number; style: Style; color: THREE.Color;
  cols: Column[]; body: CANNON.Body | null; total: number; alive: boolean;
  burning: number; burnTick: number; broken: boolean;
}
interface Part { inst: number; off: THREE.Vector3; size: THREE.Vector3; chunks: number; origin: THREE.Vector3 }
export interface Projectile { fuse: number; keepVel: THREE.Vector3 | null; trail: string | null; onBoom: (at: THREE.Vector3) => void }
interface Lane { axis: 'x' | 'z'; c: number; dir: 1 | -1; min: number; max: number }
export interface Car { mesh: THREE.Group; body: CANNON.Body; lane: Lane | null; s: number; speed: number; piece: Piece | null; wrecked: boolean; explodeAt: number }
export interface Piece {
  body: CANNON.Body;
  parts: Part[];
  mesh?: THREE.Object3D;
  kind: 'chunk' | 'mass' | 'car' | 'proj';
  style: Style;
  color: THREE.Color;
  born: number;
  still: number;
  /** Seconds this piece counts as "thrown" (it wrecks buildings it hits). */
  thrown: number;
  held: boolean;
  hit: { speed: number; building: Building | null; car: Car | null; point: THREE.Vector3 } | null;
  car?: Car;
  proj?: Projectile;
  dead?: boolean;
  /** Building it came from (falling slabs shouldn't count as hitting their own building twice). */
  from?: Building;
}
interface Tree { mesh: THREE.Object3D; x: number; z: number; alive: boolean }

export interface DamageOpts {
  /** Velocity for the blasted chunks instead of radial (wind, tornado). */
  vel?: THREE.Vector3;
  ignite?: boolean;
  /** Fraction of blasted chunks that become physics debris (the rest is dust). */
  debris?: number;
  /** Don't knock cars / push pieces (internal: fire, slow burns). */
  quiet?: boolean;
}

const v3 = (x: number, y: number, z: number) => new CANNON.Vec3(x, y, z);
const tv = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3(), tm = new THREE.Matrix4();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

export class City {
  world = new CANNON.World({ gravity: v3(0, -22, 0) });
  group = new THREE.Group();
  buildings: Building[] = [];
  pieces: Piece[] = [];
  cars: Car[] = [];
  trees: Tree[] = [];
  seed = 1;
  /** Simulation time (s). */
  t = 0;
  totalChunks = 0;
  destroyedChunks = 0;
  leveled = 0;
  carsWrecked = 0;
  onDestroy: ((chunks: number, value: number, at: THREE.Vector3) => void) | null = null;
  onLeveled: ((b: Building) => void) | null = null;
  onCarWrecked: ((at: THREE.Vector3) => void) | null = null;

  private inst: THREE.InstancedMesh;
  private aSize: THREE.InstancedBufferAttribute;
  private aOrigin: THREE.InstancedBufferAttribute;
  private aStyle: THREE.InstancedBufferAttribute;
  private free: number[] = [];
  private rubble: number[][] = [];
  private rubbleCount = 0;
  private wrecks: THREE.Object3D[] = [];
  private bodyBuilding = new Map<number, Building>();
  private bodyCar = new Map<number, Car>();
  private dirty = { matrix: false, attrs: false, color: false };
  private dynamic = new THREE.Group();
  private ground: THREE.Mesh | null = null;
  private treeGeo = { trunk: new THREE.CylinderGeometry(0.12, 0.16, 0.7, 6), cone: new THREE.ConeGeometry(0.75, 1.5, 7) };
  private treeMat = { trunk: new THREE.MeshStandardMaterial({ color: '#7a5233', roughness: 1 }), leaf: new THREE.MeshStandardMaterial({ color: '#4e9a3c', roughness: 0.9 }) };
  private carGeo = { body: new THREE.BoxGeometry(1.3, 0.42, 0.68), cabin: new THREE.BoxGeometry(0.7, 0.32, 0.6), wheel: new THREE.CylinderGeometry(0.17, 0.17, 0.12, 10) };
  private carMat = { glass: new THREE.MeshStandardMaterial({ color: '#cfe3f2', roughness: 0.2 }), wheel: new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.9 }), burnt: new THREE.MeshStandardMaterial({ color: '#2a2522', roughness: 1 }) };
  private projGeo = new THREE.SphereGeometry(1, 14, 10);
  private rng = new Rng(1);

  constructor(private fx: Fx) {
    const w = this.world;
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    (w.solver as CANNON.GSSolver).iterations = 7;
    w.defaultContactMaterial.friction = 0.55;
    w.defaultContactMaterial.restitution = 0.06;
    const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    w.addBody(ground);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aStyle = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aStyle', this.aStyle);
    this.inst = new THREE.InstancedMesh(geo, facadeMaterial(), MAX_INST);
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.inst.castShadow = this.inst.receiveShadow = true;
    this.inst.frustumCulled = false;
    this.group.add(this.inst, this.dynamic);
  }

  // ================================================================== generation
  generate(seed: number) {
    this.reset();
    this.seed = seed;
    const rng = (this.rng = new Rng(seed * 7717 + 3));
    const bw = (CITY.w - (NB.x + 1) * ROAD) / NB.x, bd = (CITY.d - (NB.z + 1) * ROAD) / NB.z;
    const blocks: { x0: number; z0: number; cx: number; cz: number; kind: 'down' | 'mid' | 'out' | 'park' }[] = [];
    for (let i = 0; i < NB.x; i++) for (let j = 0; j < NB.z; j++) {
      const x0 = -CITY.w / 2 + ROAD + i * (bw + ROAD), z0 = -CITY.d / 2 + ROAD + j * (bd + ROAD);
      const cx = x0 + bw / 2, cz = z0 + bd / 2;
      const dc = Math.hypot(cx / (CITY.w / 2), cz / (CITY.d / 2));
      let kind: 'down' | 'mid' | 'out' | 'park' = dc < 0.45 ? 'down' : dc < 0.82 ? 'mid' : 'out';
      if (kind === 'out' && rng.chance(0.45)) kind = 'park';
      if (kind === 'mid' && rng.chance(0.1)) kind = 'park';
      blocks.push({ x0, z0, cx, cz, kind });
    }
    const IN = 0.4; // sidewalk inset
    for (const bl of blocks) {
      const ix0 = bl.x0 + IN, iz0 = bl.z0 + IN, iw = bw - 2 * IN, id = bd - 2 * IN;
      if (bl.kind === 'park') { this.park(ix0, iz0, iw, id, rng); continue; }
      if (bl.kind === 'down') {
        if (rng.chance(0.5)) this.addBuilding(bl.cx, bl.cz, iw - 0.2, id - 0.2, rng.int(10, 14), rng.chance(0.75) ? 0 : 1, rng);
        else for (const s of [-1, 1]) this.addBuilding(bl.cx + s * iw / 4, bl.cz, iw / 2 - 0.35, id - 0.2, rng.int(8, 13), rng.chance(0.6) ? 0 : 1, rng);
        continue;
      }
      // mid: 2×2 lots; out: 2×3 small lots of houses
      const nx = 2, nz = bl.kind === 'mid' ? 2 : 3;
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        const lw = iw / nx, ld = id / nz;
        const cx = ix0 + lw * (a + 0.5), cz = iz0 + ld * (b + 0.5);
        if (bl.kind === 'mid') {
          if (rng.chance(0.12)) continue; // a little plaza
          const style: Style = rng.chance(0.55) ? 1 : 2;
          this.addBuilding(cx, cz, lw - rng.range(0.35, 0.8), ld - rng.range(0.35, 0.8), rng.int(4, 8), style, rng);
        } else {
          if (rng.chance(0.15)) { this.tree(cx, cz, rng); continue; }
          this.addBuilding(cx, cz, lw - rng.range(0.6, 0.9), ld - rng.range(0.5, 0.8), rng.int(1, 2), rng.chance(0.85) ? 3 : 2, rng);
        }
      }
    }
    this.totalChunks = this.buildings.reduce((n, b) => n + b.total, 0);
    this.buildGround(blocks.map((b) => ({ x0: b.x0, z0: b.z0, w: bw, d: bd, park: b.kind === 'park' })));
    this.spawnTraffic(rng, bw, bd);
  }

  private addBuilding(x: number, z: number, w: number, d: number, floors: number, style: Style, rng: Rng) {
    const nx = Math.max(1, Math.round(w / 1.55)), nz = Math.max(1, Math.round(d / 1.55));
    const cw = w / nx, cd = d / nz;
    const color = new THREE.Color(rng.pick(PALETTE[style]));
    const b: Building = { id: this.buildings.length, x, z, w, d, style, color, cols: [], body: null, total: 0, alive: true, burning: 0, burnTick: 0, broken: false };
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      // towers get a stepped crown: inner columns a floor or two taller
      const edge = i === 0 || k === 0 || i === nx - 1 || k === nz - 1;
      const h = Math.max(1, floors + (style === 0 && !edge ? rng.int(0, 2) : 0) - (edge && nx * nz > 4 && rng.chance(0.3) ? 1 : 0));
      const col: Column = { x: x - w / 2 + cw * (i + 0.5), z: z - d / 2 + cd * (k + 0.5), w: cw, d: cd, h, inst: this.alloc() };
      b.cols.push(col);
      b.total += h;
      this.drawColumn(b, col);
    }
    this.rebuildBody(b);
    this.buildings.push(b);
  }

  private park(x0: number, z0: number, w: number, d: number, rng: Rng) {
    const n = rng.int(6, 10);
    for (let k = 0; k < n; k++) this.tree(x0 + rng.range(0.6, w - 0.6), z0 + rng.range(0.6, d - 0.6), rng);
  }

  private tree(x: number, z: number, rng: Rng) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(this.treeGeo.trunk, this.treeMat.trunk);
    trunk.position.y = 0.35;
    const c1 = new THREE.Mesh(this.treeGeo.cone, this.treeMat.leaf);
    c1.position.y = 1.2;
    const c2 = new THREE.Mesh(this.treeGeo.cone, this.treeMat.leaf);
    c2.position.y = 1.8; c2.scale.setScalar(0.75);
    g.add(trunk, c1, c2);
    g.position.set(x, 0, z);
    g.scale.setScalar(rng.range(0.8, 1.25));
    g.traverse((o) => { o.castShadow = true; });
    this.group.add(g);
    this.trees.push({ mesh: g, x, z, alive: true });
  }

  private buildGround(blocks: { x0: number; z0: number; w: number; d: number; park: boolean }[]) {
    if (typeof document === 'undefined') return; // unit tests: no canvas
    const S = 32, W = CITY.w * S, H = CITY.d * S;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const X = (x: number) => (x + CITY.w / 2) * S, Z = (z: number) => (z + CITY.d / 2) * S;
    g.fillStyle = '#4a4e55'; g.fillRect(0, 0, W, H); // asphalt everywhere, blocks on top
    // lane markings
    const bw = blocks[0].w, bd = blocks[0].d;
    g.strokeStyle = '#f2d16b'; g.lineWidth = 2; g.setLineDash([14, 12]);
    for (let j = 0; j <= NB.z; j++) { const z = -CITY.d / 2 + ROAD / 2 + j * (bd + ROAD); g.beginPath(); g.moveTo(0, Z(z)); g.lineTo(W, Z(z)); g.stroke(); }
    for (let i = 0; i <= NB.x; i++) { const x = -CITY.w / 2 + ROAD / 2 + i * (bw + ROAD); g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
    g.setLineDash([]);
    for (const b of blocks) {
      // sidewalk, then lot / park
      g.fillStyle = '#cfcabe';
      g.fillRect(X(b.x0), Z(b.z0), b.w * S, b.d * S);
      g.fillStyle = b.park ? '#78b956' : '#bdb6a8';
      g.fillRect(X(b.x0 + 0.4), Z(b.z0 + 0.4), (b.w - 0.8) * S, (b.d - 0.8) * S);
      if (b.park) {
        g.strokeStyle = '#d9cfae'; g.lineWidth = 6;
        g.beginPath(); g.moveTo(X(b.x0 + 0.4), Z(b.z0 + b.d / 2)); g.lineTo(X(b.x0 + b.w - 0.4), Z(b.z0 + b.d / 2)); g.stroke();
      }
      // crosswalks at the block corners
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let k = 0; k < 5; k++) g.fillRect(X(b.x0) + k * 9, Z(b.z0 - ROAD) + 6, 5, ROAD * S - 12);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const city = new THREE.Mesh(new THREE.PlaneGeometry(CITY.w, CITY.d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    city.rotation.x = -Math.PI / 2;
    city.receiveShadow = true;
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(CITY.w + 60, CITY.d + 60), new THREE.MeshStandardMaterial({ color: '#86b55a', roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.ground = new THREE.Mesh();
    this.ground.add(outer, city);
    this.group.add(this.ground);
  }

  private spawnTraffic(rng: Rng, bw: number, bd: number) {
    const lanes: Lane[] = [];
    for (let j = 0; j <= NB.z; j++) {
      const z = -CITY.d / 2 + ROAD / 2 + j * (bd + ROAD);
      lanes.push({ axis: 'x', c: z + 0.55, dir: 1, min: -CITY.w / 2, max: CITY.w / 2 }, { axis: 'x', c: z - 0.55, dir: -1, min: -CITY.w / 2, max: CITY.w / 2 });
    }
    for (let i = 0; i <= NB.x; i += 2) {
      const x = -CITY.w / 2 + ROAD / 2 + i * (bw + ROAD);
      lanes.push({ axis: 'z', c: x - 0.55, dir: 1, min: -CITY.d / 2, max: CITY.d / 2 }, { axis: 'z', c: x + 0.55, dir: -1, min: -CITY.d / 2, max: CITY.d / 2 });
    }
    for (let k = 0; k < 22; k++) {
      const lane = lanes[k % lanes.length];
      this.addCar(lane, rng.range(lane.min, lane.max), rng.range(3, 6), rng.pick(CAR_COLORS));
    }
  }

  private addCar(lane: Lane, s: number, speed: number, color: string) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.carGeo.body, new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 }));
    body.position.y = 0.05;
    const cabin = new THREE.Mesh(this.carGeo.cabin, this.carMat.glass);
    cabin.position.set(-0.08, 0.37, 0);
    g.add(body, cabin);
    for (const [wx, wz] of [[0.42, 0.34], [-0.42, 0.34], [0.42, -0.34], [-0.42, -0.34]]) {
      const w = new THREE.Mesh(this.carGeo.wheel, this.carMat.wheel);
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, -0.16, wz);
      g.add(w);
    }
    g.traverse((o) => { o.castShadow = true; });
    const b = new CANNON.Body({ type: CANNON.Body.KINEMATIC, shape: new CANNON.Box(v3(0.65, 0.3, 0.36)) });
    this.world.addBody(b);
    this.dynamic.add(g);
    const car: Car = { mesh: g, body: b, lane, s, speed, piece: null, wrecked: false, explodeAt: 0 };
    this.bodyCar.set(b.id, car);
    this.placeCar(car);
    this.cars.push(car);
  }

  private placeCar(c: Car) {
    const l = c.lane!;
    const x = l.axis === 'x' ? c.s : l.c, z = l.axis === 'x' ? l.c : c.s;
    const yaw = l.axis === 'x' ? (l.dir > 0 ? 0 : Math.PI) : (l.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    c.body.position.set(x, 0.33, z);
    c.body.quaternion.setFromEuler(0, yaw, 0);
    c.body.velocity.set(l.axis === 'x' ? l.dir * c.speed : 0, 0, l.axis === 'z' ? l.dir * c.speed : 0);
    c.mesh.position.set(x, 0.33, z);
    c.mesh.rotation.set(0, yaw, 0);
  }

  reset() {
    for (const p of this.pieces) this.world.removeBody(p.body);
    for (const b of this.buildings) if (b.body) this.world.removeBody(b.body);
    for (const c of this.cars) if (!c.piece) this.world.removeBody(c.body);
    this.pieces = []; this.buildings = []; this.cars = [];
    for (const t of this.trees) this.group.remove(t.mesh);
    this.trees = [];
    this.dynamic.clear();
    for (const w of this.wrecks) this.dynamic.remove(w);
    this.wrecks = [];
    if (this.ground) { this.group.remove(this.ground); this.ground.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.MeshStandardMaterial | undefined; mat?.map?.dispose(); mat?.dispose?.(); }); this.ground = null; }
    this.bodyBuilding.clear();
    this.bodyCar.clear();
    this.free = [];
    for (let i = MAX_INST - 1; i >= 0; i--) { this.free.push(i); this.inst.setMatrixAt(i, HIDE); }
    this.rubble = []; this.rubbleCount = 0;
    this.dirty.matrix = this.dirty.attrs = this.dirty.color = true;
    this.totalChunks = this.destroyedChunks = this.leveled = this.carsWrecked = 0;
  }

  // ================================================================== instances
  private alloc(): number {
    if (!this.free.length) this.freeOldestRubble(64);
    return this.free.pop() ?? 0;
  }
  private release(i: number) { this.inst.setMatrixAt(i, HIDE); this.free.push(i); this.dirty.matrix = true; }
  private setInst(i: number, pos: THREE.Vector3, quat: THREE.Quaternion, size: THREE.Vector3, origin: THREE.Vector3, style: number, color: THREE.Color) {
    tm.compose(pos, quat, size);
    this.inst.setMatrixAt(i, tm);
    this.aSize.setXYZ(i, size.x, size.y, size.z);
    this.aOrigin.setXYZ(i, origin.x, origin.y, origin.z);
    this.aStyle.setX(i, style);
    this.inst.setColorAt(i, color);
    this.dirty.matrix = this.dirty.attrs = this.dirty.color = true;
  }
  private styleOf(b: { style: Style; broken?: boolean }) { return b.style + (b.broken ? BROKEN : 0); }
  private drawColumn(b: Building, col: Column) {
    if (col.h <= 0) { if (col.inst >= 0) { this.release(col.inst); col.inst = -1; } return; }
    const size = ts.set(col.w, col.h * FH, col.d);
    const pos = tv.set(col.x, (col.h * FH) / 2, col.z);
    this.setInst(col.inst, pos, tq.identity(), size, pos, this.styleOf(b), b.color);
  }
  private freeOldestRubble(n: number) {
    while (n > 0 && this.rubble.length) {
      const grp = this.rubble.shift()!;
      for (const i of grp) this.release(i);
      this.rubbleCount -= grp.length;
      n -= grp.length;
    }
  }

  // ================================================================== physics bodies
  private rebuildBody(b: Building) {
    if (b.body) { this.bodyBuilding.delete(b.body.id); this.world.removeBody(b.body); b.body = null; }
    const live = b.cols.filter((c) => c.h > 0);
    if (!live.length) return;
    const body = new CANNON.Body({ type: CANNON.Body.STATIC, position: v3(b.x, 0, b.z) });
    for (const c of live) body.addShape(new CANNON.Box(v3(c.w / 2, (c.h * FH) / 2, c.d / 2)), v3(c.x - b.x, (c.h * FH) / 2, c.z - b.z));
    this.world.addBody(body);
    this.bodyBuilding.set(body.id, b);
    b.body = body;
  }

  get activeCount() { return this.pieces.length; }

  /**
   * New debris piece from parts given in world space. Parts reuse `inst` when given (ripped columns),
   * otherwise get a fresh instance.
   */
  private spawnPiece(parts: { center: THREE.Vector3; size: THREE.Vector3; chunks: number; inst?: number; origin?: THREE.Vector3 }[], vel: THREE.Vector3, spin: number, style: Style, color: THREE.Color, kind: Piece['kind'], from?: Building): Piece {
    let mass = 0;
    const com = new THREE.Vector3();
    for (const p of parts) { com.addScaledVector(p.center, p.chunks); mass += p.chunks; }
    com.divideScalar(mass);
    const body = new CANNON.Body({ mass, position: v3(com.x, com.y, com.z) });
    const ps: Part[] = [];
    for (const p of parts) {
      const off = p.center.clone().sub(com);
      // a hair smaller than the hole they left, so neighbours don't start interpenetrating
      body.addShape(new CANNON.Box(v3(p.size.x * 0.48, p.size.y * 0.49, p.size.z * 0.48)), v3(off.x, off.y, off.z));
      const inst = p.inst ?? this.alloc();
      ps.push({ inst, off, size: p.size.clone(), chunks: p.chunks, origin: (p.origin ?? p.center).clone() });
    }
    body.velocity.set(vel.x, vel.y, vel.z);
    body.angularVelocity.set((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    body.linearDamping = 0.02;
    body.angularDamping = 0.08;
    body.sleepSpeedLimit = 0.25;
    body.sleepTimeLimit = 0.5;
    body.allowSleep = true;
    const piece: Piece = { body, parts: ps, kind, style, color, born: this.t, still: 0, thrown: 0, held: false, hit: null, from };
    body.addEventListener('collide', (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => this.onCollide(piece, e));
    this.world.addBody(body);
    this.pieces.push(piece);
    this.syncPiece(piece, this.styleOf({ style, broken: from?.broken }));
    return piece;
  }

  private onCollide(p: Piece, e: { body: CANNON.Body; contact: CANNON.ContactEquation }) {
    if (p.dead) return;
    const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (p.hit && p.hit.speed >= speed) return;
    const c = e.contact;
    const mine = c.bi === p.body;
    const ref = mine ? c.bi : c.bj, r = mine ? c.ri : c.rj;
    p.hit = { speed, building: this.bodyBuilding.get(e.body.id) ?? null, car: this.bodyCar.get(e.body.id) ?? null, point: new THREE.Vector3(ref.position.x + r.x, ref.position.y + r.y, ref.position.z + r.z) };
  }

  private syncPiece(p: Piece, style?: number) {
    const bp = p.body.position, bq = p.body.quaternion;
    if (p.mesh) {
      p.mesh.position.set(bp.x, bp.y, bp.z);
      p.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);
      return;
    }
    tq.set(bq.x, bq.y, bq.z, bq.w);
    for (const part of p.parts) {
      tv.copy(part.off).applyQuaternion(tq).add(bp as unknown as THREE.Vector3);
      if (style !== undefined) this.setInst(part.inst, tv, tq, part.size, part.origin, style, p.color);
      else { tm.compose(tv, tq, part.size); this.inst.setMatrixAt(part.inst, tm); this.dirty.matrix = true; }
    }
  }

  private removePiece(p: Piece, keepInstances = false) {
    if (p.dead) return;
    p.dead = true;
    this.world.removeBody(p.body);
    if (!keepInstances) for (const part of p.parts) this.release(part.inst);
    if (p.mesh && p.kind !== 'car') this.dynamic.remove(p.mesh);
    if (p.kind === 'proj' && p.mesh) ((p.mesh as THREE.Mesh).material as THREE.Material).dispose();
  }

  private toRubble(p: Piece) {
    if (p.kind === 'car' && p.mesh) {
      this.removePiece(p, true);
      this.wrecks.push(p.mesh);
      while (this.wrecks.length > MAX_WRECKS) this.dynamic.remove(this.wrecks.shift()!);
      return;
    }
    this.removePiece(p, true);
    const grp = p.parts.map((x) => x.inst);
    this.rubble.push(grp);
    this.rubbleCount += grp.length;
    if (this.rubbleCount > MAX_RUBBLE) this.freeOldestRubble(this.rubbleCount - MAX_RUBBLE);
  }

  // ================================================================== destruction
  private chunkValue(b: Building, n: number) { return VALUE[b.style] * n; }

  private credit(b: Building, chunks: number, at: THREE.Vector3) {
    if (chunks <= 0) return;
    this.destroyedChunks += chunks;
    this.onDestroy?.(chunks, this.chunkValue(b, chunks), at);
    if (b.alive && !b.cols.some((c) => c.h > 0)) {
      b.alive = false;
      b.burning = 0;
      this.leveled++;
      this.onLeveled?.(b);
    }
  }

  /**
   * Removes the chunks [kLo..kHi] of a column (they fly as debris with `vel` or radially from `c`),
   * and drops everything above as one falling slab (merged per building by the caller).
   * Returns the slab part (if any) so the caller can merge slabs into one falling mass.
   */
  private breakColumn(b: Building, col: Column, kLo: number, kHi: number, c: THREE.Vector3, power: number, o: DamageOpts):
    { removed: number; slab: { center: THREE.Vector3; size: THREE.Vector3; chunks: number } | null } {
    const h0 = col.h;
    if (kLo >= h0 || kLo < 0) return { removed: 0, slab: null };
    kHi = Math.min(kHi, h0 - 1);
    const debrisFrac = o.debris ?? 1;
    for (let k = kLo; k <= kHi; k++) {
      const center = new THREE.Vector3(col.x, (k + 0.5) * FH, col.z);
      if (this.pieces.length < MAX_ACTIVE && Math.random() < debrisFrac) {
        let v: THREE.Vector3;
        if (o.vel) v = o.vel.clone().multiplyScalar(0.7 + Math.random() * 0.6).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3));
        else {
          v = center.clone().sub(c);
          v.y = Math.max(v.y, 0) + 0.6;
          v.normalize().multiplyScalar(power * (0.5 + Math.random() * 0.8));
          v.y += power * 0.3 * Math.random();
        }
        this.spawnPiece([{ center, size: new THREE.Vector3(col.w, FH, col.d) }].map((p) => ({ ...p, chunks: 1 })), v, 6, b.style, b.color, 'chunk', b);
      } else if (Math.random() < 0.5) this.fx.dust(center, 2, 0.6, DUST, 2);
    }
    const above = h0 - 1 - kHi;
    let slab = null;
    if (above > 0) slab = { center: new THREE.Vector3(col.x, (kHi + 1 + above / 2) * FH, col.z), size: new THREE.Vector3(col.w, above * FH, col.d), chunks: above };
    col.h = kLo;
    this.drawColumn(b, col);
    return { removed: h0 - kLo, slab };
  }

  /** Drops slabs (the parts of columns above a blast) as one falling mass. */
  private dropSlabs(b: Building, slabs: { center: THREE.Vector3; size: THREE.Vector3; chunks: number }[], push: THREE.Vector3) {
    if (!slabs.length) return;
    if (this.pieces.length >= MAX_ACTIVE) {
      // too much debris already: the upper floors crumble to dust instead
      for (const s of slabs) this.fx.dust(s.center, 4, 1, DUST, 2);
      return;
    }
    const p = this.spawnPiece(slabs, push, 0.6, b.style, b.color, 'mass', b);
    p.body.position.y += 0.02;
  }

  /**
   * Spherical damage at `c` (radius `r`, push `power`). Returns chunks destroyed.
   */
  damage(c: THREE.Vector3, r: number, power: number, o: DamageOpts = {}): number {
    let destroyed = 0;
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const dx = Math.max(Math.abs(c.x - b.x) - b.w / 2, 0), dz = Math.max(Math.abs(c.z - b.z) - b.d / 2, 0);
      if (dx * dx + dz * dz > r * r) continue;
      const slabs: { center: THREE.Vector3; size: THREE.Vector3; chunks: number }[] = [];
      let removed = 0;
      for (const col of b.cols) {
        if (col.h <= 0) continue;
        const ddx = Math.max(Math.abs(c.x - col.x) - col.w / 2, 0), ddz = Math.max(Math.abs(c.z - col.z) - col.d / 2, 0);
        const hor2 = ddx * ddx + ddz * ddz;
        if (hor2 > r * r) continue;
        const reach = Math.sqrt(r * r - hor2);
        const kLo = Math.max(0, Math.floor((c.y - reach) / FH));
        const kHi = Math.floor((c.y + reach) / FH);
        if (kLo >= col.h || kHi < kLo) continue;
        const res = this.breakColumn(b, col, kLo, kHi, c, power, o);
        removed += res.removed;
        if (res.slab) slabs.push(res.slab);
      }
      if (!removed) continue;
      const push = new THREE.Vector3(b.x - c.x, 0, b.z - c.z);
      if (push.lengthSq() > 1e-4) push.normalize().multiplyScalar(Math.min(4, power * 0.15));
      this.dropSlabs(b, slabs, o.vel ? o.vel.clone().multiplyScalar(0.3) : push);
      this.rebuildBody(b);
      this.fx.dust(new THREE.Vector3(c.x, Math.max(0.5, c.y), c.z), Math.min(10, 2 + removed), Math.min(2.5, r), DUST, 2.5);
      if (o.ignite && b.alive) this.ignite(b);
      destroyed += removed;
      this.credit(b, removed, c);
    }
    if (!o.quiet) {
      this.knockCars(c, r + 1, power);
      this.push(c, r * 1.7, power * 0.6, 0.45);
      this.flattenTrees(c, r + 0.4);
    }
    return destroyed;
  }

  /** Flatten everything under a radius (palm slam): mostly dust, some debris. */
  crush(c: THREE.Vector3, r: number): number {
    let destroyed = 0;
    for (const b of this.buildings) {
      if (!b.alive) continue;
      let removed = 0;
      for (const col of b.cols) {
        if (col.h <= 0) continue;
        const ddx = Math.max(Math.abs(c.x - col.x) - col.w / 2, 0), ddz = Math.max(Math.abs(c.z - col.z) - col.d / 2, 0);
        if (ddx * ddx + ddz * ddz > r * r) continue;
        const res = this.breakColumn(b, col, 0, 0, c, 9, { debris: 0.8 });
        // the rest of the column is crushed flat, not dropped
        if (res.slab) {
          const n = res.slab.chunks;
          for (let k = 0; k < Math.min(2, n) && this.pieces.length < MAX_ACTIVE; k++) {
            const center = new THREE.Vector3(col.x, FH * (k + 1.5), col.z);
            const v = center.clone().sub(c).setY(0).normalize().multiplyScalar(8 + Math.random() * 6).setY(4 + Math.random() * 6);
            this.spawnPiece([{ center, size: new THREE.Vector3(col.w, FH, col.d), chunks: 1 }], v, 8, b.style, b.color, 'chunk', b);
          }
          this.fx.dust(res.slab.center.clone().setY(1), 3, 1.2, DUST, 3);
        }
        removed += res.removed;
      }
      if (!removed) continue;
      this.rebuildBody(b);
      destroyed += removed;
      this.credit(b, removed, c);
    }
    for (const car of this.cars) {
      const p = car.piece ? car.piece.body.position : car.body.position;
      if (Math.hypot(p.x - c.x, p.z - c.z) > r + 0.6) continue;
      // pancaked
      car.mesh.scale.y = 0.35;
      this.wreckCar(car, new THREE.Vector3(0, 1, 0), true);
    }
    this.flattenTrees(c, r + 0.6);
    this.push(c, r * 3.2, 16, 0.5);
    return destroyed;
  }

  /** Tear a whole building out of the ground as one carried / thrown mass. */
  rip(b: Building): Piece | null {
    if (!b.alive) return null;
    const live = b.cols.filter((c) => c.h > 0);
    if (!live.length) return null;
    const parts = live.map((c) => ({ center: new THREE.Vector3(c.x, (c.h * FH) / 2, c.z), size: new THREE.Vector3(c.w, c.h * FH, c.d), chunks: c.h, inst: c.inst }));
    const chunks = live.reduce((n, c) => n + c.h, 0);
    for (const c of live) { c.h = 0; c.inst = -1; }
    this.rebuildBody(b);
    const p = this.spawnPiece(parts, new THREE.Vector3(0, 2, 0), 0, b.style, b.color, 'mass', b);
    // ripped columns keep their facade alignment
    for (const part of p.parts) part.origin.copy(part.off).add(p.body.position as unknown as THREE.Vector3);
    this.syncPiece(p, this.styleOf(b));
    this.fx.dust(new THREE.Vector3(b.x, 0.3, b.z), 14, Math.max(b.w, b.d) * 0.7, DUST, 4);
    this.credit(b, chunks, new THREE.Vector3(b.x, 0, b.z));
    return p;
  }

  /** Make a building topple over in direction `dir` (earthquakes). */
  topple(b: Building, dir: THREE.Vector3) {
    const p = this.rip(b);
    if (!p) return null;
    const axis = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
    p.body.angularVelocity.set(axis.x * 0.9, 0, axis.z * 0.9);
    p.body.velocity.set(dir.x * 1.5, 0.5, dir.z * 1.5);
    p.thrown = 6;
    return p;
  }

  /** Break a piece into single chunks (it landed hard). */
  private shatter(p: Piece) {
    if (p.dead || p.kind === 'car' || p.kind === 'proj') return;
    const total = p.parts.reduce((n, x) => n + x.chunks, 0);
    if (total <= 1) return;
    const bp = p.body.position, bq = new THREE.Quaternion(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w);
    const vel = new THREE.Vector3(p.body.velocity.x, p.body.velocity.y, p.body.velocity.z);
    this.removePiece(p);
    const style = p.style + (p.from?.broken ? BROKEN : 0);
    for (const part of p.parts) {
      for (let k = 0; k < part.chunks; k++) {
        const ly = (k - (part.chunks - 1) / 2) * FH;
        const center = new THREE.Vector3(0, ly, 0).add(part.off).applyQuaternion(bq).add(bp as unknown as THREE.Vector3);
        if (this.pieces.length >= MAX_ACTIVE) { if (k % 2 === 0) this.fx.dust(center, 2, 0.8, DUST, 2); continue; }
        const v = vel.clone().multiplyScalar(0.35).add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6));
        const np = this.spawnPiece([{ center, size: new THREE.Vector3(part.size.x, FH, part.size.z), chunks: 1, origin: part.origin.clone().add(new THREE.Vector3(0, ly, 0)) }], v, 5, p.style, p.color, 'chunk', p.from);
        np.body.quaternion.set(bq.x, bq.y, bq.z, bq.w);
        this.syncPiece(np, style);
      }
    }
    this.fx.dust(bp as unknown as THREE.Vector3, Math.min(14, total), 1.5, DUST, 3);
  }

  // ================================================================== forces
  /** Radial impulse on loose pieces near `c`. */
  push(c: THREE.Vector3, radius: number, strength: number, lift = 0.5) {
    for (const p of this.pieces) {
      if (p.held || p.dead) continue;
      const b = p.body;
      const dx = b.position.x - c.x, dz = b.position.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const k = (1 - d / radius) * strength * b.mass;
      const n = d > 1e-3 ? 1 / d : 0;
      b.wakeUp();
      b.applyImpulse(v3(dx * n * k, k * lift, dz * n * k));
    }
  }

  /** Same impulse per unit mass on every loose piece (wind, quakes, booms). */
  shove(dir: THREE.Vector3, jitter = 0.3) {
    for (const p of this.pieces) {
      if (p.held || p.dead) continue;
      const b = p.body, m = b.mass;
      b.wakeUp();
      b.applyImpulse(v3((dir.x + (Math.random() - 0.5) * jitter * 4) * m, (dir.y + Math.random() * jitter * 4) * m, (dir.z + (Math.random() - 0.5) * jitter * 4) * m));
    }
  }

  /** Continuous force toward / around a point; call every step. */
  pullToward(c: THREE.Vector3, radius: number, strength: number, swirl = 0, lift = 0) {
    for (const p of this.pieces) {
      if (p.held || p.dead || p.kind === 'proj') continue;
      const b = p.body;
      const dx = c.x - b.position.x, dz = c.z - b.position.z, dy = c.y - b.position.y;
      const d = Math.hypot(dx, dz);
      if (d > radius || d < 1e-3) continue;
      const k = (1 - d / radius) * b.mass;
      b.wakeUp();
      b.applyForce(v3((dx / d) * strength * k + (-dz / d) * swirl * k, lift * k + dy * 0.5 * k, (dz / d) * strength * k + (dx / d) * swirl * k));
    }
  }

  knockCars(c: THREE.Vector3, radius: number, power: number) {
    for (const car of this.cars) {
      if (car.piece) continue;
      const p = car.body.position;
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d > radius) continue;
      const dir = new THREE.Vector3(p.x - c.x, 0, p.z - c.z).normalize();
      this.wreckCar(car, dir.multiplyScalar(power * 0.8).setY(power * 0.55 + 3));
    }
  }

  /** Cars stop being traffic and become loose (possibly burning) wrecks. */
  wreckCar(car: Car, vel: THREE.Vector3, crushed = false): Piece {
    if (car.piece) return car.piece;
    car.lane = null;
    const b = car.body;
    b.type = CANNON.Body.DYNAMIC;
    b.mass = 1.4;
    b.updateMassProperties();
    b.velocity.set(vel.x, vel.y, vel.z);
    b.angularVelocity.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    b.allowSleep = true;
    b.sleepSpeedLimit = 0.3;
    const piece: Piece = { body: b, parts: [], mesh: car.mesh, kind: 'car', style: 3, color: new THREE.Color('#888'), born: this.t, still: 0, thrown: 0, held: false, hit: null, car };
    b.addEventListener('collide', (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => this.onCollide(piece, e));
    this.pieces.push(piece);
    car.piece = piece;
    car.wrecked = true;
    if (crushed || Math.random() < 0.4) car.explodeAt = this.t + (crushed ? 0.05 : 0.8 + Math.random() * 1.6);
    this.carsWrecked++;
    this.onCarWrecked?.(new THREE.Vector3(b.position.x, b.position.y, b.position.z));
    return piece;
  }

  private burnCar(car: Car) {
    car.mesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = this.carMat.burnt; });
  }

  private flattenTrees(c: THREE.Vector3, r: number) {
    for (const t of this.trees) {
      if (!t.alive || Math.hypot(t.x - c.x, t.z - c.z) > r || c.y > 6) continue;
      t.alive = false;
      this.group.remove(t.mesh);
      this.fx.burst(new THREE.Vector3(t.x, 1.2, t.z), '#5aa845', 14, 5, 0.8, 0.5, -10);
    }
  }

  // ================================================================== fire
  ignite(b: Building, dur = 9) {
    if (!b.alive) return;
    if (b.burning <= 0) b.burnTick = 1;
    b.burning = Math.max(b.burning, dur);
  }

  get burningCount() { return this.buildings.filter((b) => b.burning > 0).length; }

  private updateFires(dt: number) {
    for (const b of this.buildings) {
      if (b.burning <= 0) continue;
      if (!b.alive) { b.burning = 0; continue; }
      b.burning -= dt;
      const live = b.cols.filter((c) => c.h > 0);
      if (!live.length) continue;
      for (let k = 0; k < 2; k++) {
        const c = live[(Math.random() * live.length) | 0];
        const p = new THREE.Vector3(c.x + (Math.random() - 0.5) * c.w, c.h * FH, c.z + (Math.random() - 0.5) * c.d);
        this.fx.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 1.2, 2.5 + Math.random() * 2.5, (Math.random() - 0.5) * 1.2), Math.random() < 0.5 ? '#ff7b00' : '#ffd166', 0.6 + Math.random() * 0.4, 0.9 + Math.random() * 0.7, 2, 0.6);
        if (Math.random() < 0.35) this.fx.smoke(p.clone().setY(p.y + 0.8), new THREE.Vector3((Math.random() - 0.5) * 0.6 + 0.6, 2.2, (Math.random() - 0.5) * 0.6), '#4a4440', 3.2, 1.2, 1.4, 0.4);
      }
      b.burnTick -= dt;
      if (b.burnTick <= 0) {
        b.burnTick = 1.1 + Math.random() * 0.6;
        // the fire eats the top floor of the tallest column
        const top = live.reduce((a, c) => (c.h > a.h ? c : a), live[0]);
        const at = new THREE.Vector3(top.x, (top.h - 0.5) * FH, top.z);
        const res = this.breakColumn(b, top, top.h - 1, top.h - 1, at, 2, { debris: 0.5 });
        this.rebuildBody(b);
        this.fx.burst(at, '#ffb347', 10, 3, 0.6, 0.6, -2);
        this.credit(b, res.removed, at);
        // spread to neighbours
        for (const o of this.buildings) {
          if (o === b || !o.alive || o.burning > 0) continue;
          const d = Math.max(Math.abs(o.x - b.x) - (o.w + b.w) / 2, 0) + Math.max(Math.abs(o.z - b.z) - (o.d + b.d) / 2, 0);
          if (d < 1.2 && Math.random() < 0.12) this.ignite(o, 7);
        }
      }
    }
  }

  // ================================================================== projectiles
  /** Bomb, rocket, meteor…: a body that explodes on contact or when its fuse runs out. */
  launch(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, color: string, proj: Projectile, emissive = '#000000'): Piece {
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Sphere(radius), position: v3(pos.x, pos.y, pos.z) });
    body.velocity.set(vel.x, vel.y, vel.z);
    body.allowSleep = false;
    // projectiles hit the city, never each other (bomblets start in one spot)
    body.collisionFilterGroup = 2;
    body.collisionFilterMask = 1;
    const mesh = new THREE.Mesh(this.projGeo, new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: emissive === '#000000' ? 0 : 2.2, roughness: 0.5 }));
    mesh.scale.setScalar(radius);
    mesh.castShadow = true;
    this.dynamic.add(mesh);
    const piece: Piece = { body, parts: [], mesh, kind: 'proj', style: 0, color: new THREE.Color(color), born: this.t, still: 0, thrown: 0, held: false, hit: null, proj };
    body.addEventListener('collide', (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => this.onCollide(piece, e));
    this.world.addBody(body);
    this.pieces.push(piece);
    return piece;
  }

  /** First thing straight below (x, z): roof, debris or ground. */
  surfaceBelow(x: number, z: number, out = new THREE.Vector3()) {
    const res = new CANNON.RaycastResult();
    this.world.raycastClosest(v3(x, 60, z), v3(x, -1, z), { skipBackfaces: true }, res);
    if (res.hasHit) out.set(res.hitPointWorld.x, res.hitPointWorld.y, res.hitPointWorld.z);
    else out.set(x, 0, z);
    return out;
  }

  /** Nearest grabbable thing to a ground point: a loose piece or car, else a standing building. */
  grabbable(p: THREE.Vector3, maxD: number): { piece?: Piece; building?: Building; car?: Car } | null {
    let best: { piece?: Piece; building?: Building; car?: Car } | null = null, bd = maxD;
    for (const pc of this.pieces) {
      if (pc.dead || pc.held || pc.kind === 'proj') continue;
      const d = Math.hypot(pc.body.position.x - p.x, pc.body.position.z - p.z);
      if (d < bd) { bd = d; best = { piece: pc }; }
    }
    for (const car of this.cars) {
      if (car.piece) continue;
      const d = Math.hypot(car.body.position.x - p.x, car.body.position.z - p.z);
      if (d < bd) { bd = d; best = { car }; }
    }
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const d = Math.hypot(Math.max(Math.abs(p.x - b.x) - b.w / 2, 0), Math.max(Math.abs(p.z - b.z) - b.d / 2, 0));
      if (d < bd) { bd = d; best = { building: b }; }
    }
    return best;
  }

  // ================================================================== frame
  step(dt: number) {
    this.t += dt;
    // traffic
    for (const c of this.cars) {
      if (c.piece || !c.lane) continue;
      c.s += c.lane.dir * c.speed * dt;
      if (c.s > c.lane.max) c.s = c.lane.min;
      if (c.s < c.lane.min) c.s = c.lane.max;
      this.placeCar(c);
    }
    for (const p of this.pieces) {
      if (p.proj?.keepVel && !p.dead) p.body.velocity.set(p.proj.keepVel.x, p.proj.keepVel.y, p.proj.keepVel.z);
    }
    this.world.step(1 / 60, dt, 3);

    // impacts (queued during the step)
    for (const p of [...this.pieces]) {
      if (p.dead) continue;
      if (p.proj) {
        p.proj.fuse -= dt;
        if (p.proj.trail && Math.random() < 0.9) this.fx.smoke(p.mesh!.position.clone(), new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4), p.proj.trail, 0.9, 0.5, 1.2, 0.2);
        if (p.hit || p.proj.fuse <= 0) {
          const at = new THREE.Vector3(p.body.position.x, p.body.position.y, p.body.position.z);
          this.removePiece(p);
          p.proj.onBoom(at);
        }
        continue;
      }
      if (!p.hit) continue;
      const { speed, building, car, point } = p.hit;
      p.hit = null;
      // loose debris slamming into traffic wrecks the car
      if (car && !car.piece && speed > 3) this.wreckCar(car, new THREE.Vector3(p.body.velocity.x * 0.5, 4, p.body.velocity.z * 0.5));
      const chunks = p.parts.reduce((n, x) => n + x.chunks, 0) || 1;
      if (building && speed > 6 && (p.thrown > 0 || chunks >= 3 || p.kind === 'car')) {
        const r = Math.min(3.4, 0.9 + Math.cbrt(chunks) * 0.55 + speed * 0.04);
        this.damage(point, r, Math.min(14, speed * 0.6), { debris: 0.8 });
      }
      if (speed > SHATTER_SPEED && chunks > 1 && !p.held) this.shatter(p);
      if (p.kind === 'car' && p.car && speed > 10 && p.car.explodeAt <= 0) p.car.explodeAt = this.t + 0.3;
    }

    // cars that are about to blow
    for (const c of this.cars) {
      if (c.explodeAt <= 0 || this.t < c.explodeAt || !c.piece) continue;
      c.explodeAt = -1;
      const at = new THREE.Vector3(c.piece.body.position.x, c.piece.body.position.y, c.piece.body.position.z);
      this.burnCar(c);
      this.fx.explosion(at, 0.8);
      c.piece.body.applyImpulse(v3((Math.random() - 0.5) * 6, 9, (Math.random() - 0.5) * 6));
      this.damage(at, 1.6, 6, { debris: 0.7 });
    }

    // settle / cleanup
    for (const p of this.pieces) {
      if (p.dead) continue;
      p.thrown = Math.max(0, p.thrown - dt);
      if (p.held || p.proj) { this.syncPiece(p); continue; }
      const b = p.body;
      const v2 = b.velocity.lengthSquared(), w2 = b.angularVelocity.lengthSquared();
      if (b.sleepState === CANNON.Body.SLEEPING || (v2 < 0.2 && w2 < 0.4)) p.still += dt; else p.still = 0;
      const age = this.t - p.born;
      // flung off the map: gone (keeps the foreground clear)
      if (b.position.y < -12 || Math.abs(b.position.x) > CITY.w / 2 + 7 || Math.abs(b.position.z) > CITY.d / 2 + 7) { this.removePiece(p); if (p.kind === 'car' && p.mesh) this.dynamic.remove(p.mesh); continue; }
      if ((p.still > 1.8 && (b.position.y < 2 || age > 20)) || age > 35) { this.toRubble(p); continue; }
      if (b.sleepState !== CANNON.Body.SLEEPING) this.syncPiece(p);
    }
    this.pieces = this.pieces.filter((p) => !p.dead);
    this.updateFires(dt);

    if (this.dirty.matrix) { this.inst.instanceMatrix.needsUpdate = true; this.dirty.matrix = false; }
    if (this.dirty.attrs) { this.aSize.needsUpdate = this.aOrigin.needsUpdate = this.aStyle.needsUpdate = true; this.dirty.attrs = false; }
    if (this.dirty.color && this.inst.instanceColor) { this.inst.instanceColor.needsUpdate = true; this.dirty.color = false; }
  }

  /** Smash every window in the city (sonic boom). Returns the buildings that still stand. */
  shatterWindows(): Building[] {
    const live = this.buildings.filter((b) => b.alive);
    for (const b of live) {
      if (b.broken) continue;
      b.broken = true;
      for (const c of b.cols) if (c.h > 0) this.drawColumn(b, c);
    }
    return live;
  }

  /** Destroy the whole of a building in one go (weak houses in a sonic boom). */
  collapse(b: Building) {
    if (!b.alive) return 0;
    let removed = 0;
    for (const col of b.cols) {
      if (col.h <= 0) continue;
      const res = this.breakColumn(b, col, 0, col.h - 1, new THREE.Vector3(col.x, 0, col.z), 3, { debris: 0.5 });
      removed += res.removed;
    }
    this.rebuildBody(b);
    this.fx.dust(new THREE.Vector3(b.x, 0.5, b.z), 8, Math.max(b.w, b.d) * 0.6, DUST, 3);
    this.credit(b, removed, new THREE.Vector3(b.x, 0, b.z));
    return removed;
  }

  /** Remove a loose piece entirely (abducted by a UFO, swallowed by a black hole). */
  consume(p: Piece) {
    if (p.dead) return;
    this.removePiece(p);
    if (p.kind === 'car' && p.mesh) this.dynamic.remove(p.mesh);
  }

  /** Break floors [kLo..kHi] of one column, flinging them with `vel` (the rest above falls). */
  chip(b: Building, col: Column, kLo: number, kHi: number, vel: THREE.Vector3) {
    if (!b.alive || col.h <= 0) return 0;
    const at = new THREE.Vector3(col.x, (kLo + 0.5) * FH, col.z);
    const res = this.breakColumn(b, col, kLo, kHi, at, 2, { vel });
    if (res.slab) this.dropSlabs(b, [res.slab], vel.clone().multiplyScalar(0.2));
    this.rebuildBody(b);
    this.credit(b, res.removed, at);
    return res.removed;
  }

  /** Tear the top `n` floors off every column at least `minH` tall (hurricanes). */
  stripTops(minH: number, n: number, vel: THREE.Vector3) {
    let removed = 0;
    for (const b of this.buildings) {
      if (!b.alive) continue;
      let r = 0;
      for (const col of b.cols) {
        if (col.h < minH) continue;
        const at = new THREE.Vector3(col.x, (col.h - 0.5) * FH, col.z);
        r += this.breakColumn(b, col, col.h - n, col.h - 1, at, 2, { vel, debris: 0.7 }).removed;
      }
      if (!r) continue;
      this.rebuildBody(b);
      this.credit(b, r, new THREE.Vector3(b.x, 0, b.z));
      removed += r;
    }
    return removed;
  }

  /** Nearest standing column (horizontal distance) within `maxD`. */
  nearestColumn(p: THREE.Vector3, maxD: number): { b: Building; col: Column } | null {
    let best: { b: Building; col: Column } | null = null, bd = maxD;
    for (const b of this.buildings) {
      if (!b.alive) continue;
      for (const col of b.cols) {
        if (col.h <= 0) continue;
        const d = Math.hypot(col.x - p.x, col.z - p.z);
        if (d < bd) { bd = d; best = { b, col }; }
      }
    }
    return best;
  }

  /** Highest standing roof within r of a ground point (0 = open ground). */
  skyline(x: number, z: number, r: number) {
    let top = 0;
    for (const b of this.buildings) {
      if (!b.alive || Math.abs(b.x - x) > b.w / 2 + r || Math.abs(b.z - z) > b.d / 2 + r) continue;
      for (const c of b.cols) if (c.h > 0 && Math.abs(c.x - x) <= c.w / 2 + r && Math.abs(c.z - z) <= c.d / 2 + r) top = Math.max(top, c.h * FH);
    }
    return top;
  }

  get destruction() { return this.totalChunks ? this.destroyedChunks / this.totalChunks : 0; }
}
