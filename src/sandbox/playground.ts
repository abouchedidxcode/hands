import * as THREE from 'three';
import type { GestureEvent } from '../gesture';
import { ACTIONS } from './actions';
import type { Ctx, Mode, SandboxHand } from './modes';
import { ARENA, Playground, type Item } from './world';

interface PgHand { held: Item | null; released: Item | null; releasedAt: number; pullUntil: number }
interface Tornado { pos: THREE.Vector3; until: number; dir: number; drift: THREE.Vector3 }
interface Rocket { p: THREE.Vector3; v: THREE.Vector3; burstAt: number; color: string }

const HAND_COLORS = ['#ff9f1c', '#2a9df4', '#ef476f', '#06d6a0'];

/** The toy playground: physics toys and 15 gesture powers. */
export class PlaygroundMode implements Mode {
  readonly id = 'playground' as const;
  readonly title = 'Playground';
  readonly legendTitle = '15 GESTURES';
  readonly actions = ACTIONS;
  readonly overlayHands = true;
  readonly aimHeight = 0;
  pg = new Playground();
  private ctx!: Ctx;
  private st = new Map<number, PgHand>();
  private tornados: Tornado[] = [];
  private rockets: Rocket[] = [];
  private meteorQueue: { at: number; target: THREE.Vector3 }[] = [];
  private cooldowns: Record<string, number> = {};
  /** Mode clock (ms), advanced by update. */
  private now = 0;

  constructor() {
    this.pg.onMeteorHit = (p) => {
      const { fx, cam } = this.ctx;
      this.pg.blast(p, 4.5, 12, 0.8);
      fx.burst(p.clone().setY(0.4), '#ff7b00', 50, 11, 0.9, 0.6);
      fx.burst(p.clone().setY(0.4), '#ffd166', 25, 7, 0.6, 0.4);
      fx.ring(p, '#ff9f1c', 4.5, 0.45);
      fx.scorch(p, 1.8);
      cam.shake = Math.min(1.5, cam.shake + 0.35);
    };
  }

  enter(ctx: Ctx) { this.ctx = ctx; ctx.scene.add(this.pg.group); }
  exit() {
    this.ctx.scene.remove(this.pg.group);
    this.st.clear();
    this.tornados = []; this.rockets = []; this.meteorQueue = [];
  }

  private hs(h: SandboxHand): PgHand {
    let s = this.st.get(h.id);
    if (!s) this.st.set(h.id, (s = { held: null, released: null, releasedAt: -1e9, pullUntil: 0 }));
    return s;
  }
  private cool(k: string, ms: number) {
    const now = performance.now();
    if ((this.cooldowns[k] ?? 0) > now) return false;
    this.cooldowns[k] = now + ms;
    return true;
  }

  // ---------------------------------------------------------------- powers
  private grab(h: SandboxHand) {
    const it = this.pg.nearest(h.cursor, 3.4);
    if (!it) return;
    this.hs(h).held = it;
    it.body.wakeUp();
    this.ctx.fx.ring(it.mesh.position.clone(), HAND_COLORS[(h.id + 4) % 4], 2, 0.35);
    this.ctx.act('grab', '✊ GRABBED!');
  }
  private release(h: SandboxHand, t: number) {
    const s = this.hs(h);
    const it = s.held;
    if (!it) return;
    s.held = null;
    it.body.velocity.set(h.vel.x * 1.15, Math.max(2, h.vel.y + 3), h.vel.z * 1.15);
    s.released = it;
    s.releasedAt = t;
  }
  private lightning(p: THREE.Vector3) {
    const { fx, cam } = this.ctx;
    fx.bolt(p);
    this.pg.blast(p, 5, 15, 0.9);
    fx.burst(p.clone().setY(0.3), '#cfe8ff', 60, 12, 0.7, 0.5);
    fx.ring(p, '#9ad1ff', 5, 0.4);
    fx.scorch(p, 2.4);
    cam.shake = Math.min(1.5, cam.shake + 0.6);
  }
  private cannon(from: THREE.Vector3, dir: THREE.Vector3) {
    const start = from.clone().setY(1.6).addScaledVector(dir, -0.5);
    this.pg.spawnCannonball(start, dir.clone().multiplyScalar(34).add(new THREE.Vector3(0, 4, 0)));
    this.ctx.fx.burst(start, '#ffffff', 20, 5, 0.5, 0.6, 2);
  }
  private shockwave(p: THREE.Vector3) {
    const { fx, cam } = this.ctx;
    this.pg.blast(p, 11, 17, 0.35);
    fx.ring(p, '#ffffff', 11, 0.55);
    fx.ring(p, '#4cc9f0', 8, 0.45);
    cam.shake = Math.min(1.5, cam.shake + 0.3);
  }
  private wind(dir: number) {
    const d = this.ctx.screenDirToGround(dir, 0);
    this.pg.shove(new THREE.Vector3(d.x * 15, 3, d.z * 15), 0.25);
    for (let k = 0; k < 120; k++) {
      const p = new THREE.Vector3((Math.random() - 0.5) * ARENA.w, 0.5 + Math.random() * 5, (Math.random() - 0.5) * ARENA.d).addScaledVector(d, -ARENA.w * 0.4);
      this.ctx.fx.spawn(p, d.clone().multiplyScalar(30 + Math.random() * 15), '#ffffff', 0.9, 0.35, 0, 0.2);
    }
  }
  private thunderclap() {
    this.pg.shove(new THREE.Vector3(0, 13, 0), 0.4);
    this.ctx.fx.ring(new THREE.Vector3(0, 0, 0), '#fff3b0', 30, 0.7);
    this.ctx.cam.shake = Math.min(1.8, this.ctx.cam.shake + 0.9);
  }
  private meteors(center: THREE.Vector3) {
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 8;
      const t = new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
      t.x = THREE.MathUtils.clamp(t.x, -ARENA.w / 2 + 1, ARENA.w / 2 - 1);
      t.z = THREE.MathUtils.clamp(t.z, -ARENA.d / 2 + 1, ARENA.d / 2 - 1);
      this.meteorQueue.push({ at: this.now + k * 160 + Math.random() * 120, target: t });
    }
  }
  private fireworks(center: THREE.Vector3) {
    const cols = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff9f1c', '#f15bb5'];
    for (let k = 0; k < 6; k++) {
      const p = center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 0.3, (Math.random() - 0.5) * 8));
      this.rockets.push({ p, v: new THREE.Vector3((Math.random() - 0.5) * 3, 20 + Math.random() * 6, (Math.random() - 0.5) * 3), burstAt: this.now + 700 + k * 220 + Math.random() * 300, color: cols[k % cols.length] });
    }
  }
  private tornado(p: THREE.Vector3, dir: number) {
    this.tornados.push({ pos: p.clone(), until: this.now + 5000, dir, drift: new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2) });
  }
  private clear() { const r = this.pg.clear(); this.ctx.act('clear', r === 'reset' ? '🧸 TOYS RESTORED' : '👎 CLEARED'); }

  // ---------------------------------------------------------------- gestures
  onEvent(e: GestureEvent, h: SandboxHand | undefined, now: number) {
    const { act, fx } = this.ctx;
    if (e.kind === 'pose' && h) {
      const s = this.hs(h);
      if (e.phase === 'end') { if (e.name === 'fist') this.release(h, now); return; }
      switch (e.name) {
        case 'fist': this.grab(h); break;
        case 'victory': if (this.cool('tower', 900)) { this.pg.tower(h.cursor.clone(), 8); fx.ring(h.cursor, '#ffd166', 3, 0.4); act('tower'); } break;
        case 'middle': if (this.cool('lightning' + h.id, 500)) {
          const tip = h.result?.landmarks[12];
          this.lightning(tip ? this.ctx.viewToGround(this.ctx.toView(tip)) : h.cursor.clone());
          act('lightning');
        } break;
        case 'gun': if (this.cool('cannon' + h.id, 350) && h.result) {
          const d = h.result.features.pointDir;
          this.cannon(h.cursor, this.ctx.screenDirToGround(d.x, d.y));
          act('cannon');
        } break;
        case 'rock': if (this.cool('meteors', 2200)) { this.meteors(h.cursor.clone()); act('meteors'); } break;
        case 'thumbs-up': if (this.cool('fireworks', 1500)) { this.fireworks(h.cursor.clone()); act('fireworks'); } break;
      }
      void s;
      return;
    }
    if (e.kind === 'motion' && h) {
      const s = this.hs(h);
      switch (e.name) {
        case 'hold': if (e.data?.pose === 'thumbs-down' && this.cool('clear', 1200)) this.clear(); break;
        case 'tap': if (!s.held) { this.pg.spawnBall(h.cursor.clone().setY(9), 0.55 + Math.random() * 0.35); act('ball'); } break;
        case 'double-tap': if (!s.held) { this.pg.spawnBox(h.cursor.clone().setY(10), 1.3, 'crate'); act('crate'); } break;
        case 'push': if (!s.held) { this.shockwave(h.cursor.clone()); act('shockwave'); } break;
        case 'pull': s.pullUntil = this.now + 1700; act('vacuum'); break;
        case 'circle-cw': case 'circle-ccw':
          if (this.cool('tornado', 900)) { this.tornado(h.cursor, e.name === 'circle-cw' ? 1 : -1); act('tornado'); }
          break;
        case 'swipe-left': case 'swipe-right':
          if (!s.held && now - s.releasedAt > 600) { this.wind(e.name === 'swipe-left' ? -1 : 1); act('wind', e.name === 'swipe-left' ? '💨 ⬅ WIND' : '💨 WIND ➡'); }
          break;
        case 'throw': {
          // the throw can be recognised a moment before the fist officially ends: let go now
          if (s.held) this.release(h, now);
          const it = s.released;
          if (it && now - s.releasedAt < 450) {
            const v = h.vel.clone().setY(0);
            if (v.length() < 8) v.setLength(8);
            it.body.velocity.set(v.x * 1.7, 7, v.z * 1.7);
            fx.burst(it.mesh.position.clone(), '#ffffff', 18, 4, 0.4, 0.4, 0);
            s.released = null;
            act('throw', '🤾 YEET!');
          }
          break;
        }
      }
      return;
    }
    if (e.kind === 'two-hand' && e.name === 'clap') { this.thunderclap(); act('thunderclap'); }
  }

  onHandGone(h: SandboxHand) { this.release(h, this.now); this.st.delete(h.id); }

  mouseDown(h: SandboxHand) { this.grab(h); }
  mouseUp(h: SandboxHand) { this.release(h, this.now); }

  private mousePoint() { return this.ctx.viewToGround(this.ctx.mouseView()); }
  keys: Record<string, () => void> = {
    '1': () => { this.pg.spawnBall(this.mousePoint().setY(9)); this.ctx.act('ball'); },
    '2': () => { this.pg.spawnBox(this.mousePoint().setY(10), 1.3, 'crate'); this.ctx.act('crate'); },
    '3': () => { this.pg.tower(this.mousePoint(), 8); this.ctx.act('tower'); },
    '4': () => { this.lightning(this.mousePoint()); this.ctx.act('lightning'); },
    '5': () => { const p = this.mousePoint(); this.cannon(p.clone().add(new THREE.Vector3(0, 0, 8)), this.ctx.screenDirToGround(0, -1)); this.ctx.act('cannon'); },
    '6': () => { this.shockwave(this.mousePoint()); this.ctx.act('shockwave'); },
    '7': () => { const h = this.ctx.hands.get(-1); if (h) { this.hs(h).pullUntil = this.now + 1700; this.ctx.act('vacuum'); } },
    '8': () => { this.tornado(this.mousePoint(), 1); this.ctx.act('tornado'); },
    '9': () => { this.wind(1); this.ctx.act('wind'); },
    '0': () => { this.thunderclap(); this.ctx.act('thunderclap'); },
    m: () => { this.meteors(this.mousePoint()); this.ctx.act('meteors'); },
    f: () => { this.fireworks(this.mousePoint()); this.ctx.act('fireworks'); },
    x: () => this.clear(),
  };

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    const { fx } = this.ctx;
    this.now += dt * 1000;
    const now = this.now;
    for (const [id, s] of this.st) {
      const h = this.ctx.hands.get(id);
      if (!h) continue;
      // carried toy follows the hand, floating above it
      if (s.held) {
        const b = s.held.body;
        if (s.held.dying !== undefined) s.held = null;
        else {
          const lift = s.held.kind === 'beach' ? 4.2 : 3.2;
          const tx = h.cursor.x - b.position.x, ty = lift - b.position.y, tz = h.cursor.z - b.position.z;
          b.wakeUp();
          b.velocity.set(THREE.MathUtils.clamp(tx * 12, -40, 40), THREE.MathUtils.clamp(ty * 12, -40, 40), THREE.MathUtils.clamp(tz * 12, -40, 40));
          b.angularVelocity.scale(0.9, b.angularVelocity);
        }
      }
      if (now < s.pullUntil) {
        this.pg.pullToward(h.cursor, 15, 55, 0, 10);
        if (Math.random() < 0.8) {
          const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 8;
          const p = h.cursor.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.4 + Math.random() * 2, Math.sin(a) * r));
          fx.spawn(p, h.cursor.clone().sub(p).multiplyScalar(2.2), '#9ad1ff', 0.5, 0.35, 0, 0);
        }
      }
    }
    for (const tn of this.tornados) {
      tn.pos.addScaledVector(tn.drift, dt);
      tn.pos.x = THREE.MathUtils.clamp(tn.pos.x, -ARENA.w / 2 + 2, ARENA.w / 2 - 2);
      tn.pos.z = THREE.MathUtils.clamp(tn.pos.z, -ARENA.d / 2 + 2, ARENA.d / 2 - 2);
      this.pg.pullToward(tn.pos, 7, 22, 70 * tn.dir, 34);
      for (let k = 0; k < 10; k++) {
        const hgt = Math.random() * 12, rad = 0.6 + hgt * 0.32, a = Math.random() * Math.PI * 2;
        const p = tn.pos.clone().add(new THREE.Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad));
        const v = new THREE.Vector3(-Math.sin(a) * tn.dir, 0.3, Math.cos(a) * tn.dir).multiplyScalar(9);
        fx.spawn(p, v.add(new THREE.Vector3(0, 4, 0)), hgt > 6 ? '#e5ecf2' : '#c2b49b', 0.45, 0.6, 0, 0.5);
      }
    }
    this.tornados = this.tornados.filter((tn) => now <= tn.until);
    for (let i = this.meteorQueue.length - 1; i >= 0; i--) {
      const m = this.meteorQueue[i];
      if (now < m.at) continue;
      this.meteorQueue.splice(i, 1);
      const start = m.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 34, -14));
      const T = 1.1, g = 22;
      const vel = m.target.clone().sub(start).divideScalar(T);
      vel.y += 0.5 * g * T;
      this.pg.spawnMeteor(start, vel);
    }
    for (const it of this.pg.items) if (it.kind === 'meteor' && it.dying === undefined) fx.spawn(it.mesh.position, new THREE.Vector3((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2), Math.random() < 0.5 ? '#ff7b00' : '#ffd166', 0.5, 1.1, 0, 0.5);
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.p.addScaledVector(r.v, dt);
      r.v.y -= 6 * dt;
      fx.spawn(r.p, new THREE.Vector3((Math.random() - 0.5) * 1.5, -3, (Math.random() - 0.5) * 1.5), '#ffe8a3', 0.35, 0.35, 0, 0.5);
      if (now >= r.burstAt) {
        this.rockets.splice(i, 1);
        const v = new THREE.Vector3();
        for (let k = 0; k < 110; k++) {
          v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(9 + Math.random() * 3);
          fx.spawn(r.p, v, k % 5 === 0 ? '#ffffff' : r.color, 1.4 + Math.random() * 0.6, 0.55, -4, 1.1);
        }
      }
    }
    this.pg.step(dt);
  }

  heldKind(id: number) { return this.st.get(id)?.held?.kind ?? null; }
  debug() { return { items: this.pg.items.length }; }
}
