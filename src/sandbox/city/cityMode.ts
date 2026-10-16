import * as THREE from 'three';
import type { GestureEvent } from '../../gesture';
import type { ActionDef, Ctx, Mode, SandboxHand } from '../modes';
import { City, CITY, FH, type Piece } from './city';
import { GiantHand, HOVER } from './giantHand';

export const CITY_ACTIONS: readonly ActionDef[] = [
  { id: 'grab', emoji: '✊', gesture: 'Fist', effect: 'Rip a building out of the ground (or grab a car) and carry it' },
  { id: 'hurl', emoji: '🤾', gesture: 'Fling open', effect: 'Hurl it: it wrecks whatever it hits' },
  { id: 'bomb', emoji: '🤏', gesture: 'Pinch tap', effect: 'Drop a bomb' },
  { id: 'cluster', emoji: '🫰', gesture: 'Double pinch tap', effect: 'Cluster bombs' },
  { id: 'laser', emoji: '☝️', gesture: 'Point (hold)', effect: 'Finger laser: carve straight down through buildings' },
  { id: 'rockets', emoji: '👉', gesture: 'Finger gun (hold)', effect: 'Rocket barrage where you point' },
  { id: 'lightning', emoji: '🖕', gesture: 'Middle finger', effect: 'Lightning strikes and sets buildings on fire' },
  { id: 'slam', emoji: '🫷', gesture: 'Push', effect: 'Palm slam: flatten a whole block' },
  { id: 'blackhole', emoji: '🫳', gesture: 'Pull', effect: 'Black hole: swallows everything, then blows' },
  { id: 'tornado', emoji: '🌪️', gesture: 'Draw a circle', effect: 'Tornado rips through the streets' },
  { id: 'hurricane', emoji: '💨', gesture: 'Swipe left / right', effect: 'Hurricane: blows the tops off towers' },
  { id: 'boom', emoji: '👏', gesture: 'Clap', effect: 'Sonic boom: every window shatters, houses fold' },
  { id: 'meteors', emoji: '🤘', gesture: 'Rock on', effect: 'Meteor shower' },
  { id: 'ufo', emoji: '✌️', gesture: 'Peace sign', effect: 'UFO: beams the city up, then zaps it' },
  { id: 'airstrike', emoji: '👍', gesture: 'Thumbs up', effect: 'Airstrike: jets carpet-bomb a line' },
  { id: 'quake', emoji: '🫨', gesture: 'Shake hand up & down', effect: 'Earthquake: towers topple' },
  { id: 'newcity', emoji: '👎', gesture: 'Thumbs down (hold)', effect: 'Build a fresh city and start a new round' },
  { id: 'camera', emoji: '🤲', gesture: 'Two-hand pinch / wheel', effect: 'Spread or squeeze to zoom, turn a wheel to orbit' },
];

const HAND_COLORS = ['#f6c453', '#7cc7ff', '#ff8fa3', '#7ee0b0'];
const GLOW: Record<string, string> = {
  point: '#ff3030', gun: '#ff8a00', middle: '#9fd4ff', fist: '#ffffff', victory: '#3dff8b', rock: '#ff5a1f', 'thumbs-up': '#ffd166',
};
const ROUND = 90;
const BEST_KEY = 'citysmash.best.v1';
const RANKS: [number, string][] = [[0.9, 'APOCALYPSE'], [0.7, 'CATACLYSM'], [0.45, 'KAIJU'], [0.25, 'WRECKING BALL'], [0.1, 'MINOR NUISANCE'], [0, 'LIGHT DRIZZLE']];

interface HandState {
  giant: GiantHand;
  held: Piece | null;
  released: Piece | null;
  releasedAt: number;
  palm: THREE.Vector3;
  palmVel: THREE.Vector3;
  hasPalm: boolean;
  laserTick: number;
  rocketTick: number;
  lightningTick: number;
  beam: THREE.Group;
  ring: THREE.Mesh;
}
interface Ufo { g: THREE.Group; beam: THREE.Mesh; pos: THREE.Vector3; hand: number; t: number; life: number; tick: number; zapped: boolean }
interface Hole { g: THREE.Group; disk: THREE.Mesh; core: THREE.Mesh; pos: THREE.Vector3; t: number; life: number; tick: number; eaten: number }
interface Twister { pos: THREE.Vector3; vel: THREE.Vector3; t: number; life: number; dir: number; tick: number }
interface Jet { g: THREE.Group; pos: THREE.Vector3; dir: THREE.Vector3; target: THREE.Vector3; t: number; drop: number; side: number }

const fmtMoney = (m: number) => (m >= 1000 ? `$${(m / 1000).toFixed(m >= 10000 ? 1 : 2)}B` : `$${Math.round(m)}M`);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** City Smash: flatten a procedural city with 17 gesture powers in 90 seconds. */
export class CityMode implements Mode {
  readonly id = 'city' as const;
  readonly title = 'City Smash';
  readonly legendTitle = '17 DESTRUCTIVE POWERS';
  readonly actions = CITY_ACTIONS;
  readonly overlayHands = false;
  readonly aimHeight = HOVER;
  city!: City;
  private ctx!: Ctx;
  private st = new Map<number, HandState>();
  private ufos: Ufo[] = [];
  private holes: Hole[] = [];
  private twisters: Twister[] = [];
  private jets: Jet[] = [];
  private quakeLeft = 0;
  private quakeTick = 0;
  private later: { at: number; fn: () => void }[] = [];
  private cool: Record<string, number> = {};
  /** Mode clock (s). */
  private t = 0;
  // round
  private phase: 'ready' | 'running' | 'over' = 'ready';
  private timeLeft = ROUND;
  private damage = 0;
  private recent: { t: number; n: number }[] = [];
  private combo = 1;
  private bestCombo = 1;
  private used: Record<string, number> = {};
  private extraGroup = new THREE.Group();
  private hudEls: Record<string, HTMLElement> = {};
  private lastToast: Record<string, number> = {};

  enter(ctx: Ctx) {
    this.ctx = ctx;
    if (!this.city) {
      this.city = new City(ctx.fx);
      this.city.onDestroy = (n, value, at) => this.scored(n, value, at);
      this.city.onLeveled = () => { this.score(25); this.say('leveled', '🏚️ BUILDING LEVELED', 1.2); };
      this.city.onCarWrecked = () => this.score(1);
      this.newCity();
    }
    ctx.scene.add(this.city.group, this.extraGroup);
    this.buildHud();
  }

  exit() {
    for (const s of this.st.values()) this.dropHand(s);
    this.st.clear();
    this.ctx.scene.remove(this.city.group, this.extraGroup);
    this.clearEffects();
  }

  // ================================================================== round + score
  private newCity() {
    this.clearEffects();
    for (const s of this.st.values()) { s.held = null; s.released = null; }
    this.city.generate((Math.random() * 1e9) | 0);
    this.phase = 'ready';
    this.timeLeft = ROUND;
    this.damage = 0;
    this.recent = [];
    this.combo = 1;
    this.bestCombo = 1;
    this.used = {};
    if (this.ctx) { this.ctx.overlay.classList.add('hidden'); this.ctx.overlay.innerHTML = ''; }
  }

  private scored(chunks: number, value: number, at: THREE.Vector3) {
    void at;
    if (this.phase === 'ready') { this.phase = 'running'; this.say('go', '⏱️ 90 SECONDS. GO!', 0); }
    this.recent.push({ t: this.t, n: chunks });
    this.score(value);
  }
  private score(value: number) {
    if (this.phase !== 'running') return;
    this.damage += value * this.combo;
  }
  /** Combo grows with sustained destruction: chunks destroyed in the last 3 s. */
  private updateCombo() {
    this.recent = this.recent.filter((r) => this.t - r.t < 3);
    const n = this.recent.reduce((a, r) => a + r.n, 0);
    const c = Math.min(10, 1 + Math.floor(n / 30));
    if (c > this.combo) { const el = this.hudEls.combo; if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); } }
    this.combo = c;
    this.bestCombo = Math.max(this.bestCombo, c);
  }

  private say(key: string, text: string, gap: number) {
    if ((this.lastToast[key] ?? -99) > this.t - gap) return;
    this.lastToast[key] = this.t;
    this.ctx.toast(text);
  }

  private buildHud() {
    const h = this.ctx.hud;
    h.innerHTML = `<div class="pill" data-k="time"><small>TIME</small><span></span></div>
      <div class="pill" data-k="pct"><small>DESTROYED</small><span></span></div>
      <div class="pill money" data-k="money"><small>DAMAGE</small><span></span></div>
      <div class="pill combo" data-k="combo"><small>COMBO</small><span></span></div>`;
    for (const el of h.querySelectorAll<HTMLElement>('[data-k]')) this.hudEls[el.dataset.k!] = el;
  }

  private renderHud() {
    const e = this.hudEls;
    if (!e.time) return;
    const set = (k: string, v: string) => { const s = e[k].querySelector('span')!; if (s.textContent !== v) s.textContent = v; };
    set('time', this.phase === 'ready' ? 'smash to start' : this.phase === 'over' ? 'round over' : fmtTime(Math.ceil(this.timeLeft)));
    e.time.classList.toggle('hurry', this.phase === 'running' && this.timeLeft < 10);
    set('pct', `${Math.floor(this.city.destruction * 100)}%`);
    set('money', fmtMoney(this.damage));
    set('combo', `×${this.combo}`);
    e.combo.style.display = this.combo > 1 && this.phase === 'running' ? '' : 'none';
  }

  private endRound() {
    this.phase = 'over';
    // wiping the city out before the clock pays $1B per second left
    if (this.city.destruction > 0.985 && this.timeLeft > 0) this.damage += Math.round(this.timeLeft) * 1000;
    const pct = this.city.destruction;
    const rank = RANKS.find(([p]) => pct >= p)![1];
    let best = 0;
    try { best = Number(localStorage.getItem(BEST_KEY) || 0); } catch { /* storage blocked */ }
    const isBest = this.damage > best;
    if (isBest) try { localStorage.setItem(BEST_KEY, String(Math.round(this.damage))); } catch { /* ignore */ }
    const fav = Object.entries(this.used).sort((a, b) => b[1] - a[1])[0];
    const favA = fav ? CITY_ACTIONS.find((a) => a.id === fav[0]) : null;
    const o = this.ctx.overlay;
    o.innerHTML = `<div class="card results">
      <div class="big">${pct > 0.98 ? '🌋' : '🏙️'}</div>
      <h1>${pct > 0.98 ? 'CITY ERASED' : "TIME'S UP"}</h1>
      <div class="rank">${rank}</div>
      <div class="grid">
        <div><b>${fmtMoney(this.damage)}</b><span>DAMAGE</span></div>
        <div><b>${Math.floor(pct * 100)}%</b><span>DESTROYED</span></div>
        <div><b>${this.city.leveled}</b><span>LEVELED</span></div>
        <div><b>${this.city.carsWrecked}</b><span>CARS WRECKED</span></div>
        <div><b>×${this.bestCombo}</b><span>BEST COMBO</span></div>
        <div><b>${favA ? favA.emoji : '–'}</b><span>FAVOURITE</span></div>
      </div>
      <p class="best ${isBest ? 'new' : ''}">${isBest ? '🏆 New best!' : `Best: ${fmtMoney(best)}`}</p>
      <button class="primary" id="b-newcity">🏙️ New city</button>
      <button class="ghost" id="b-keep">Keep smashing</button>
      <p class="fine">or hold 👎 for a new city</p>
    </div>`;
    o.classList.remove('hidden');
    (o.querySelector('#b-newcity') as HTMLButtonElement).onclick = () => this.newCity();
    (o.querySelector('#b-keep') as HTMLButtonElement).onclick = () => { o.classList.add('hidden'); };
    this.ctx.flash('#ffffff', 0.4);
  }

  private use(id: string, text?: string) {
    this.used[id] = (this.used[id] ?? 0) + 1;
    this.ctx.act(id, text);
  }
  private cooled(k: string, s: number) {
    if ((this.cool[k] ?? -99) > this.t) return false;
    this.cool[k] = this.t + s;
    return true;
  }
  private after(s: number, fn: () => void) { this.later.push({ at: this.t + s, fn }); }

  // ================================================================== hands
  private hs(h: SandboxHand): HandState {
    let s = this.st.get(h.id);
    if (!s) {
      const giant = new GiantHand(HAND_COLORS[(h.id + 4) % 4]);
      const beam = new THREE.Group();
      // solid red so it reads on pale facades, a white-hot centre, and a soft additive halo
      const hot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: '#fff6e8', toneMapped: false }));
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color: '#ff2a1a', toneMapped: false }));
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1, 14, 1, true), new THREE.MeshBasicMaterial({ color: '#ff3a26', transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      beam.add(hot, core, glow);
      beam.visible = false;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.0, 40), new THREE.MeshBasicMaterial({ color: HAND_COLORS[(h.id + 4) % 4], transparent: true, opacity: 0.9, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      this.extraGroup.add(giant.group, beam, ring);
      s = { giant, held: null, released: null, releasedAt: -99, palm: new THREE.Vector3(), palmVel: new THREE.Vector3(), hasPalm: false, laserTick: 0, rocketTick: 0, lightningTick: 0, beam, ring };
      this.st.set(h.id, s);
    }
    return s;
  }
  private dropHand(s: HandState) {
    this.release(s);
    this.extraGroup.remove(s.giant.group, s.beam, s.ring);
    s.giant.dispose();
  }

  /** Ground point the powers of this hand land on: straight under the giant palm (mouse: cursor). */
  private target(h: SandboxHand, out = new THREE.Vector3()) {
    const s = this.st.get(h.id);
    if (s?.hasPalm && h.result) return out.set(s.palm.x, 0, s.palm.z);
    return out.copy(h.cursor).setY(0);
  }
  private tip(h: SandboxHand, i: number, out = new THREE.Vector3()) {
    const s = this.st.get(h.id);
    if (s?.giant.visible) return out.copy(s.giant.pts[i]);
    return out.copy(h.cursor).setY(HOVER);
  }

  private grab(h: SandboxHand) {
    const s = this.hs(h);
    const p = this.target(h);
    const g = this.city.grabbable(p, 3.4);
    if (!g) return;
    let piece: Piece | null = null;
    if (g.building) { piece = this.city.rip(g.building); if (piece) this.use('grab', '✊ RIPPED OUT!'); }
    else if (g.car) { piece = this.city.wreckCar(g.car, new THREE.Vector3(0, 4, 0)); this.use('grab', '✊ GOT ONE!'); }
    else if (g.piece) { piece = g.piece; this.use('grab', '✊ GRABBED!'); }
    if (!piece) return;
    piece.held = true;
    piece.body.wakeUp();
    s.held = piece;
    this.ctx.cam.shake = Math.min(1.5, this.ctx.cam.shake + 0.25);
  }
  private release(s: HandState) {
    const p = s.held;
    if (!p) return;
    s.held = null;
    p.held = false;
    p.thrown = 3;
    p.body.velocity.set(s.palmVel.x * 1.3, Math.max(1, s.palmVel.y) + 2, s.palmVel.z * 1.3);
    s.released = p;
    s.releasedAt = this.t;
    s.giant.carryLift = 0;
  }

  // ================================================================== powers
  private boom(at: THREE.Vector3, r: number, power: number, ignite: number, scale = 1) {
    this.city.damage(at, r, power, { ignite: Math.random() < ignite });
    this.ctx.fx.explosion(at, scale);
    this.ctx.fx.flashAt(at, '#ffb26b', 380 * scale);
    if (at.y < 0.6) this.ctx.fx.scorch(at, r * 0.8);
    this.ctx.cam.shake = Math.min(1.6, this.ctx.cam.shake + 0.22 * scale);
  }

  /** Height of the standing roofs at a point (the giant hands rise over them). */
  private roof = (x: number, z: number) => this.city.skyline(x, z, 0.5);
  /** Where things dropped by this hand start: just under the giant palm (mouse: high above the cursor). */
  private dropPoint(h: SandboxHand) {
    const s = this.st.get(h.id);
    return s?.hasPalm && h.result ? s.palm.clone().setY(s.giant.hover - 1) : this.target(h).setY(14);
  }
  private palmVel(h: SandboxHand) { return this.st.get(h.id)?.palmVel.clone() ?? h.vel.clone(); }
  private bomb(h: SandboxHand) {
    const v = this.palmVel(h);
    this.city.launch(this.dropPoint(h), new THREE.Vector3(v.x * 0.4, -3, v.z * 0.4), 0.38, '#222222', { fuse: 6, keepVel: null, trail: '#777777', onBoom: (at) => this.boom(at, 2.2, 11, 0.35, 1.1) });
  }
  private cluster(h: SandboxHand) {
    const from = this.dropPoint(h);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + Math.random() * 0.4;
      this.city.launch(from, new THREE.Vector3(Math.cos(a) * 6, 2 + Math.random() * 3, Math.sin(a) * 6), 0.24, '#3d3d3d', { fuse: 6, keepVel: null, trail: '#888888', onBoom: (at) => this.boom(at, 1.7, 8, 0.15, 0.7) });
    }
  }
  private lightning(h: SandboxHand) {
    const tip = this.tip(h, 12);
    const hit = this.city.surfaceBelow(tip.x, tip.z);
    this.ctx.fx.bolt(hit);
    this.city.damage(hit, 2.1, 9, { ignite: true });
    this.ctx.fx.burst(hit.clone().setY(hit.y + 0.3), '#cfe8ff', 50, 10, 0.6, 0.5);
    this.ctx.fx.ring(hit, '#9ad1ff', 4, 0.35);
    if (hit.y < 0.5) this.ctx.fx.scorch(hit, 1.8);
    this.ctx.flash('#dbeeff', 0.35);
    this.ctx.cam.shake = Math.min(1.5, this.ctx.cam.shake + 0.5);
  }
  private rocket(h: SandboxHand) {
    const s = this.st.get(h.id);
    const from = this.tip(h, 8);
    const dir = s?.giant.visible ? s.giant.pts[8].clone().sub(s.giant.pts[5]).setY(0) : this.ctx.screenDirToGround(0, -1);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize().multiplyScalar(26).setY(-7);
    this.city.launch(from, dir, 0.22, '#e8e8e8', { fuse: 2.4, keepVel: dir.clone(), trail: '#9a9a9a', onBoom: (at) => this.boom(at, 2.1, 9, 0.25, 0.9) }, '#ff6a00');
    this.ctx.fx.burst(from, '#ffd166', 8, 3, 0.25, 0.4, 0);
  }
  private slam(h: SandboxHand) {
    this.st.get(h.id)?.giant.slam();
    const at = this.target(h);
    this.after(0.13, () => {
      const n = this.city.crush(at, 2.8);
      this.ctx.fx.ring(at, '#ffffff', 12, 0.55);
      this.ctx.fx.dust(at.clone().setY(0.3), 26, 3.5, '#b9ad98', 7);
      this.ctx.fx.scorch(at, 3.6, 10);
      this.ctx.cam.shake = Math.min(2, this.ctx.cam.shake + 1.4);
      this.ctx.flash('#ffffff', 0.25);
      void n;
    });
  }
  private blackHole(h: SandboxHand) {
    const at = this.target(h).setY(4.5);
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#000000' }));
    const disk = new THREE.Mesh(new THREE.RingGeometry(1.4, 3.4, 48), new THREE.MeshBasicMaterial({ color: '#b46bff', transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
    disk.rotation.x = -Math.PI / 2 + 0.35;
    g.add(core, disk);
    g.position.copy(at);
    g.scale.setScalar(0.01);
    this.extraGroup.add(g);
    this.holes.push({ g, disk, core, pos: at, t: 0, life: 4.2, tick: 0, eaten: 0 });
  }
  private tornado(h: SandboxHand, dir: number) {
    const at = this.target(h);
    this.twisters.push({ pos: at, vel: new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3), t: 0, life: 7, dir, tick: 0 });
  }
  private hurricane(dir: number) {
    const d = this.ctx.screenDirToGround(dir, 0);
    const vel = d.clone().multiplyScalar(16).setY(5);
    const n = this.city.stripTops(6, 1, vel);
    this.city.shove(d.clone().multiplyScalar(14).setY(2), 0.3);
    for (const car of this.city.cars) if (!car.piece && Math.random() < 0.5) this.city.wreckCar(car, d.clone().multiplyScalar(12).setY(5));
    for (let k = 0; k < 160; k++) {
      const p = new THREE.Vector3((Math.random() - 0.5) * CITY.w, 0.5 + Math.random() * 12, (Math.random() - 0.5) * CITY.d).addScaledVector(d, -CITY.w * 0.4);
      this.ctx.fx.spawn(p, d.clone().multiplyScalar(30 + Math.random() * 15), '#ffffff', 0.9, 0.35, 0, 0.2);
    }
    this.ctx.cam.shake = Math.min(1.5, this.ctx.cam.shake + 0.4);
    return n;
  }
  private sonicBoom() {
    const live = this.city.shatterWindows();
    for (const b of live) {
      for (let k = 0; k < 6; k++) {
        const c = b.cols[(Math.random() * b.cols.length) | 0];
        if (!c || c.h <= 0) continue;
        const p = new THREE.Vector3(c.x + (Math.random() - 0.5) * c.w, Math.random() * c.h * FH, c.z + (Math.random() - 0.5) * c.d);
        this.ctx.fx.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6), '#cfefff', 1.2, 0.35, -14, 0.4);
      }
      if (b.style === 3 || Math.max(...b.cols.map((c) => c.h)) <= 2) this.city.collapse(b);
    }
    for (const car of this.city.cars) if (!car.piece && Math.random() < 0.6) this.city.wreckCar(car, new THREE.Vector3((Math.random() - 0.5) * 4, 7, (Math.random() - 0.5) * 4));
    this.city.shove(new THREE.Vector3(0, 11, 0), 0.4);
    this.ctx.fx.ring(new THREE.Vector3(0, 0.5, 0), '#ffffff', 40, 0.8);
    this.ctx.flash('#ffffff', 0.85);
    this.ctx.cam.shake = Math.min(2.2, this.ctx.cam.shake + 1.8);
  }
  private meteors(h: SandboxHand) {
    const c = this.target(h);
    for (let k = 0; k < 9; k++) {
      this.after(k * 0.24 + Math.random() * 0.15, () => {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 7;
        const tgt = new THREE.Vector3(THREE.MathUtils.clamp(c.x + Math.cos(a) * r, -CITY.w / 2 + 1, CITY.w / 2 - 1), 0, THREE.MathUtils.clamp(c.z + Math.sin(a) * r, -CITY.d / 2 + 1, CITY.d / 2 - 1));
        const start = tgt.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 36, -16));
        const T = 1.0;
        const vel = tgt.clone().sub(start).divideScalar(T);
        vel.y += 0.5 * 22 * T;
        this.city.launch(start, vel, 0.75, '#ff7b00', { fuse: 4, keepVel: null, trail: '#3a302a', onBoom: (at) => { this.boom(at, 2.4, 12, 0.5, 1.3); } }, '#ff4d00');
      });
    }
  }
  private ufo(h: SandboxHand) {
    const at = this.target(h);
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14), new THREE.MeshStandardMaterial({ color: '#c9d2dc', metalness: 0.6, roughness: 0.3 }));
    hull.scale.set(3.2, 0.62, 3.2);
    const belly = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), new THREE.MeshBasicMaterial({ color: '#7dffb5' }));
    belly.rotation.x = Math.PI / 2;
    belly.position.y = -0.5;
    g.add(belly);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#7fffd4', emissive: '#2fffb0', emissiveIntensity: 0.6, transparent: true, opacity: 0.8 }));
    dome.scale.set(1.1, 0.9, 1.1);
    dome.position.y = 0.3;
    g.add(hull, dome);
    for (let k = 0; k < 10; k++) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), new THREE.MeshBasicMaterial({ color: k % 2 ? '#ffe066' : '#66ffe0' }));
      l.position.set(Math.cos((k / 10) * Math.PI * 2) * 2.95, -0.05, Math.sin((k / 10) * Math.PI * 2) * 2.95);
      g.add(l);
    }
    g.traverse((o) => { o.castShadow = true; });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 3.2, 1, 28, 1, true), new THREE.MeshBasicMaterial({ color: '#4dff9a', transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
    const pos = at.clone().setY(32);
    g.position.copy(pos);
    this.extraGroup.add(g, beam);
    this.ufos.push({ g, beam, pos, hand: h.id, t: 0, life: 8, tick: 0, zapped: false });
  }
  private airstrike(h: SandboxHand) {
    const c = this.target(h);
    const dir = this.ctx.screenDirToGround(1, 0);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (const sgn of [-1, 1]) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: '#7d8a96', metalness: 0.5, roughness: 0.4 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.18, 3.2, 10), mat);
      body.rotation.z = Math.PI / 2;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.8, 10), mat);
      nose.rotation.z = -Math.PI / 2; nose.position.x = 2;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 3.2), mat);
      wing.position.x = 0.1;
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.08), mat);
      tail.position.set(-1.4, 0.4, 0);
      g.add(body, nose, wing, tail);
      g.traverse((o) => { o.castShadow = true; });
      g.rotation.y = Math.atan2(-dir.z, dir.x);
      const pos = c.clone().addScaledVector(dir, -42).addScaledVector(side, sgn * 2.4).setY(17);
      g.position.copy(pos);
      this.extraGroup.add(g);
      this.jets.push({ g, pos, dir: dir.clone(), target: c.clone().addScaledVector(side, sgn * 2.4), t: 0, drop: 0, side: sgn });
    }
  }
  private quake() {
    this.quakeLeft = 3.6;
    // the two tallest towers lose their footing
    const tall = this.city.buildings.filter((b) => b.alive && Math.max(...b.cols.map((c) => c.h)) >= 7)
      .sort((a, b) => Math.max(...b.cols.map((c) => c.h)) - Math.max(...a.cols.map((c) => c.h))).slice(0, 2);
    tall.forEach((b, k) => this.after(0.4 + k * 0.6, () => {
      const a = Math.random() * Math.PI * 2;
      this.city.topple(b, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      this.say('topple', '🏢 TIMBER!', 0.5);
    }));
  }
  private newCityAction() { this.newCity(); this.use('newcity', '🏙️ FRESH CITY'); }

  // ================================================================== gestures
  /** Pose the giant hand from the latest frame right now, so powers land where the hand is. */
  private sync(h: SandboxHand) {
    if (!h.result) return;
    const s = this.hs(h);
    s.giant.update(h.result, this.ctx, 0);
    const p = s.giant.palmCenter();
    if (!s.hasPalm) s.palmVel.set(0, 0, 0);
    s.palm.copy(p);
    s.hasPalm = true;
  }

  onEvent(e: GestureEvent, h: SandboxHand | undefined, now: number) {
    void now;
    if (h) this.sync(h);
    if (e.kind === 'pose' && h) {
      const s = this.hs(h);
      if (e.phase === 'end') { if (e.name === 'fist') this.release(s); return; }
      switch (e.name) {
        case 'fist': this.grab(h); break;
        case 'point': s.laserTick = 0; this.use('laser'); break;
        case 'gun': s.rocketTick = 0; this.use('rockets'); break;
        case 'middle': if (this.cooled('lightning' + h.id, 0.4)) { this.lightning(h); s.lightningTick = 0.9; this.use('lightning'); } break;
        case 'rock': if (this.cooled('meteors', 2.4)) { this.meteors(h); this.use('meteors'); } break;
        case 'victory': if (this.cooled('ufo', 3) && this.ufos.length < 2) { this.ufo(h); this.use('ufo'); } break;
        case 'thumbs-up': if (this.cooled('airstrike', 2.5)) { this.airstrike(h); this.use('airstrike'); } break;
      }
      return;
    }
    if (e.kind === 'motion' && h) {
      const s = this.hs(h);
      switch (e.name) {
        case 'hold': if (e.data?.pose === 'thumbs-down' && this.cooled('newcity', 1.5)) this.newCityAction(); break;
        case 'tap': if (!s.held) { this.bomb(h); this.use('bomb'); } break;
        case 'double-tap': if (!s.held) { this.cluster(h); this.use('cluster'); } break;
        case 'push': if (!s.held && this.cooled('slam' + h.id, 0.6)) { this.slam(h); this.use('slam'); } break;
        case 'pull': if (!s.held && this.cooled('hole', 1.5)) { this.blackHole(h); this.use('blackhole'); } break;
        case 'circle-cw': case 'circle-ccw': if (this.cooled('tornado', 1.2)) { this.tornado(h, e.name === 'circle-cw' ? 1 : -1); this.use('tornado'); } break;
        case 'swipe-left': case 'swipe-right':
          if (!s.held && this.t - s.releasedAt > 0.6 && this.cooled('hurricane', 0.8)) { this.hurricane(e.name === 'swipe-left' ? -1 : 1); this.use('hurricane', e.name === 'swipe-left' ? '💨 ⬅ HURRICANE' : '💨 HURRICANE ➡'); }
          break;
        case 'shake': if (!s.held && this.cooled('quake', 3)) { this.quake(); this.use('quake'); } break;
        case 'throw': {
          if (s.held) this.release(s);
          const p = s.released;
          if (p && !p.dead && this.t - s.releasedAt < 0.5) {
            const v = s.palmVel.clone().setY(0);
            if (v.length() < 18) v.setLength(18);
            p.body.velocity.set(v.x * 1.4, 7, v.z * 1.4);
            p.thrown = 4;
            s.released = null;
            this.ctx.fx.burst(new THREE.Vector3(p.body.position.x, p.body.position.y, p.body.position.z), '#ffffff', 24, 6, 0.4, 0.5, 0);
            this.use('hurl', '🤾 HURLED!');
          }
          break;
        }
      }
      return;
    }
    if (e.kind === 'two-hand' && e.name === 'clap' && this.cooled('boom', 1.5)) { this.sonicBoom(); this.use('boom'); }
  }

  onHandGone(h: SandboxHand) {
    const s = this.st.get(h.id);
    if (!s) return;
    this.dropHand(s);
    this.st.delete(h.id);
  }

  mouseDown(h: SandboxHand) { this.grab(h); }
  mouseUp(h: SandboxHand) { const s = this.st.get(h.id); if (s) this.release(s); }

  private mouseHand(): SandboxHand {
    const m = this.ctx.hands.get(-1);
    if (m) return m;
    return { id: -2, cursor: this.ctx.viewToGround(this.ctx.mouseView()), vel: new THREE.Vector3(), result: null };
  }
  keys: Record<string, () => void> = {
    '1': () => { this.bomb(this.mouseHand()); this.use('bomb'); },
    '2': () => { this.cluster(this.mouseHand()); this.use('cluster'); },
    '3': () => { this.ufo(this.mouseHand()); this.use('ufo'); },
    '4': () => { this.lightning(this.mouseHand()); this.use('lightning'); },
    '5': () => { for (let k = 0; k < 5; k++) this.after(k * 0.12, () => this.rocket(this.mouseHand())); this.use('rockets'); },
    '6': () => { this.slam(this.mouseHand()); this.use('slam'); },
    '7': () => { this.blackHole(this.mouseHand()); this.use('blackhole'); },
    '8': () => { this.tornado(this.mouseHand(), 1); this.use('tornado'); },
    '9': () => { this.hurricane(1); this.use('hurricane'); },
    '0': () => { this.sonicBoom(); this.use('boom'); },
    m: () => { this.meteors(this.mouseHand()); this.use('meteors'); },
    a: () => { this.airstrike(this.mouseHand()); this.use('airstrike'); },
    e: () => { this.quake(); this.use('quake'); },
    r: () => this.newCityAction(),
    x: () => this.newCityAction(),
  };

  // ================================================================== frame
  update(dt: number) {
    this.t += dt;
    const { fx, cam } = this.ctx;
    // scheduled bits (meteors, slams…)
    const due = this.later.filter((l) => l.at <= this.t);
    this.later = this.later.filter((l) => l.at > this.t);
    for (const l of due) l.fn();

    // hands: giant hands, held things, held-pose powers
    for (const [id, s] of this.st) {
      const h = this.ctx.hands.get(id);
      if (!h) continue;
      const r = h.result;
      s.giant.update(r, this.ctx, dt, this.roof);
      if (r) {
        const p = s.giant.palmCenter();
        if (s.hasPalm && dt > 0) s.palmVel.lerp(p.clone().sub(s.palm).divideScalar(dt), 1 - Math.exp(-dt / 0.06));
        s.palm.copy(p);
        s.hasPalm = true;
        s.giant.setGlow(GLOW[r.pose ?? ''] ?? null);
      } else {
        // mouse: carry at the cursor
        s.palmVel.copy(h.vel);
        s.palm.copy(h.cursor).setY(HOVER);
      }
      const tgt = this.target(h);
      const surf = this.city.surfaceBelow(tgt.x, tgt.z);
      s.ring.position.set(tgt.x, surf.y + 0.08, tgt.z);
      s.ring.scale.setScalar(s.held ? 1.6 : 1 + 0.08 * Math.sin(this.t * 6));
      // carried thing hangs under the palm, the hand rising to keep it clear of the roofs
      if (s.held) {
        const b = s.held.body;
        if (s.held.dead) { s.held = null; s.giant.carryLift = 0; }
        else {
          const height = s.held.parts.length ? Math.max(...s.held.parts.map((pt) => pt.off.y + pt.size.y / 2)) - Math.min(...s.held.parts.map((pt) => pt.off.y - pt.size.y / 2)) : 1;
          // small things hang under the palm; tall buildings are gripped round their upper part,
          // so the hand only has to rise a little to carry them clear of the street
          const grip = Math.max(0, height - 6) * 0.6;
          s.giant.carryLift = Math.max(0, height - grip + 3.3 - HOVER);
          const ty = s.palm.y - height / 2 - 0.8 + grip;
          b.wakeUp();
          b.velocity.set(THREE.MathUtils.clamp((s.palm.x - b.position.x) * 10, -45, 45), THREE.MathUtils.clamp((ty - b.position.y) * 10, -45, 45), THREE.MathUtils.clamp((s.palm.z - b.position.z) * 10, -45, 45));
          b.angularVelocity.scale(0.8, b.angularVelocity);
          // keep it roughly upright while carried
          const q = b.quaternion;
          const target = new THREE.Quaternion(q.x, q.y, q.z, q.w).slerp(new THREE.Quaternion(), Math.min(1, dt * 3));
          q.set(target.x, target.y, target.z, target.w);
        }
      }
      // finger laser
      const pose = r?.pose;
      const lasering = pose === 'point' && !s.held;
      s.beam.visible = lasering;
      if (lasering) {
        const from = s.giant.pts[8];
        const hit = this.city.surfaceBelow(from.x, from.z);
        // fingertip inside a tower: it burns through right there
        if (hit.y > from.y - 0.4) hit.y = Math.max(0, from.y - 0.4);
        const len = Math.max(0.1, from.y - hit.y);
        s.beam.position.set(from.x, hit.y + len / 2, from.z);
        s.beam.scale.set(1 + 0.3 * Math.random(), len, 1 + 0.3 * Math.random());
        for (let n = 0; n < 3; n++) fx.spawn(hit.clone().setY(hit.y + 0.2), new THREE.Vector3((Math.random() - 0.5) * 8, 3 + Math.random() * 5, (Math.random() - 0.5) * 8), Math.random() < 0.5 ? '#ff5a3c' : '#ffd166', 0.45, 0.55, -12, 0.5);
        fx.spawn(hit.clone().setY(hit.y + 0.3), new THREE.Vector3(0, 0.5, 0), '#ffb3a3', 0.12, 3.2, 0, 0);
        s.laserTick -= dt;
        if (s.laserTick <= 0) {
          s.laserTick = 0.09;
          this.city.damage(hit.clone().setY(Math.max(0.3, hit.y - 0.4)), 1.05, 4, { ignite: Math.random() < 0.08, debris: 0.6 });
          if (hit.y < 0.3 && Math.random() < 0.3) fx.scorch(hit, 0.7, 4);
        }
      }
      // rocket barrage
      if (pose === 'gun' && !s.held) {
        s.rocketTick -= dt;
        if (s.rocketTick <= 0) { s.rocketTick = 0.28; this.rocket(h); }
      }
      // keep the middle finger up for a storm
      if (pose === 'middle') {
        s.lightningTick -= dt;
        if (s.lightningTick <= 0) { s.lightningTick = 0.9; this.lightning(h); }
      }
    }

    this.updateUfos(dt);
    this.updateHoles(dt);
    this.updateTwisters(dt);
    this.updateJets(dt);
    if (this.quakeLeft > 0) {
      this.quakeLeft -= dt;
      cam.shake = Math.max(cam.shake, 0.55);
      this.quakeTick -= dt;
      if (this.quakeTick <= 0) {
        this.quakeTick = 0.18;
        const live = this.city.buildings.filter((b) => b.alive);
        for (let k = 0; k < 2 && live.length; k++) {
          const b = live[(Math.random() * live.length) | 0];
          const cols = b.cols.filter((c) => c.h >= 2);
          if (!cols.length) continue;
          const col = cols[(Math.random() * cols.length) | 0];
          const kk = (Math.random() * (col.h - 1)) | 0;
          this.city.chip(b, col, kk, kk, new THREE.Vector3((Math.random() - 0.5) * 6, 3, (Math.random() - 0.5) * 6));
        }
        this.city.shove(new THREE.Vector3(0, 2.5, 0), 0.5);
        for (const car of this.city.cars) if (!car.piece && Math.random() < 0.05) this.city.wreckCar(car, new THREE.Vector3((Math.random() - 0.5) * 3, 4, (Math.random() - 0.5) * 3));
        fx.dust(new THREE.Vector3((Math.random() - 0.5) * CITY.w, 0.2, (Math.random() - 0.5) * CITY.d), 4, 2, '#b9ad98', 2);
      }
    }

    this.city.step(dt);

    // round clock
    this.updateCombo();
    if (this.phase === 'running') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0 || this.city.destruction > 0.985) { this.timeLeft = Math.max(0, this.timeLeft); this.endRound(); }
    }
    this.renderHud();
  }

  private updateUfos(dt: number) {
    const { fx } = this.ctx;
    for (const u of this.ufos) {
      u.t += dt;
      const h = this.ctx.hands.get(u.hand);
      if (h && u.t < u.life - 1) { const tg = this.target(h); u.pos.x += (tg.x - u.pos.x) * Math.min(1, dt * 1.5); u.pos.z += (tg.z - u.pos.z) * Math.min(1, dt * 1.5); }
      const alt = u.t < 1.2 ? 32 - (32 - 13) * (u.t / 1.2) : u.t > u.life ? 13 + (u.t - u.life) * 40 : 13;
      u.pos.y = alt;
      u.g.position.copy(u.pos);
      u.g.rotation.y += dt * 2.5;
      const beaming = u.t > 1.2 && u.t < u.life - 0.6;
      const bm = u.beam.material as THREE.MeshBasicMaterial;
      bm.opacity = beaming ? 0.28 + 0.12 * Math.sin(u.t * 18) : Math.max(0, bm.opacity - dt * 2);
      u.beam.position.set(u.pos.x, (alt - 0.3) / 2, u.pos.z);
      u.beam.scale.set(1, Math.max(0.1, alt - 0.3), 1);
      if (beaming) {
        const c = new THREE.Vector3(u.pos.x, alt - 1, u.pos.z);
        this.city.pullToward(c, 3.6, 18, 10, 36);
        for (const car of this.city.cars) if (!car.piece && Math.hypot(car.body.position.x - u.pos.x, car.body.position.z - u.pos.z) < 3) this.city.wreckCar(car, new THREE.Vector3(0, 8, 0));
        u.tick -= dt;
        if (u.tick <= 0) {
          u.tick = 0.4;
          const hit = this.city.surfaceBelow(u.pos.x + (Math.random() - 0.5) * 3, u.pos.z + (Math.random() - 0.5) * 3);
          if (hit.y > 0.5) this.city.damage(hit.clone().setY(hit.y - 0.3), 1.1, 2, { vel: new THREE.Vector3(0, 14, 0), debris: 1 });
        }
        for (const p of this.city.pieces) {
          if (p.held || p.dead || p.kind === 'proj') continue;
          const bp = p.body.position;
          if (bp.y > alt - 2.6 && Math.hypot(bp.x - u.pos.x, bp.z - u.pos.z) < 2.4) {
            this.city.consume(p);
            fx.burst(new THREE.Vector3(bp.x, bp.y, bp.z), '#4dff9a', 10, 3, 0.5, 0.5, 0);
            this.say('abduct', '🛸 ABDUCTED!', 1.5);
          }
        }
        if (Math.random() < 0.6) fx.spawn(new THREE.Vector3(u.pos.x + (Math.random() - 0.5) * 4, Math.random() * alt, u.pos.z + (Math.random() - 0.5) * 4), new THREE.Vector3(0, 6, 0), '#7dffb5', 0.8, 0.4, 0, 0.3);
      }
      if (!u.zapped && u.t >= u.life - 0.6) {
        u.zapped = true;
        const at = new THREE.Vector3(u.pos.x, 0, u.pos.z);
        fx.bolt(at, '#ff4d6d', new THREE.Vector3(u.pos.x, alt - 0.5, u.pos.z));
        this.boom(at, 3.4, 13, 0.6, 1.4);
        this.say('zap', '🛸 ZAP!', 0);
      }
    }
    for (const u of this.ufos.filter((x) => x.t > x.life + 1.2)) this.disposeObj(u.g, u.beam);
    this.ufos = this.ufos.filter((x) => x.t <= x.life + 1.2);
  }

  private updateHoles(dt: number) {
    const { fx, cam } = this.ctx;
    for (const hl of this.holes) {
      hl.t += dt;
      const k = Math.min(1, hl.t / 0.6);
      hl.g.scale.setScalar(0.01 + k * (1.1 + 0.08 * Math.sin(hl.t * 20)));
      hl.disk.rotation.z += dt * 4;
      (hl.disk.material as THREE.MeshBasicMaterial).color.setHSL(0.78 - 0.1 * Math.sin(hl.t * 3), 1, 0.6);
      if (hl.t < hl.life) {
        this.city.pullToward(hl.pos, 18, 55, 35, 0);
        for (const car of this.city.cars) if (!car.piece && Math.hypot(car.body.position.x - hl.pos.x, car.body.position.z - hl.pos.z) < 9) this.city.wreckCar(car, hl.pos.clone().sub(new THREE.Vector3(car.body.position.x, 0, car.body.position.z)).setY(4));
        hl.tick -= dt;
        if (hl.tick <= 0) {
          hl.tick = 0.14;
          const nc = this.city.nearestColumn(hl.pos, 9);
          if (nc) {
            const top = new THREE.Vector3(nc.col.x, (nc.col.h - 0.5) * FH, nc.col.z);
            this.city.chip(nc.b, nc.col, nc.col.h - 1, nc.col.h - 1, hl.pos.clone().sub(top).normalize().multiplyScalar(14));
          }
        }
        for (const p of this.city.pieces) {
          if (p.held || p.dead || p.kind === 'proj') continue;
          const bp = p.body.position;
          if ((bp.x - hl.pos.x) ** 2 + (bp.y - hl.pos.y) ** 2 + (bp.z - hl.pos.z) ** 2 < 2.4 * 2.4) { this.city.consume(p); hl.eaten++; }
        }
        for (let n = 0; n < 6; n++) {
          const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6;
          const p = hl.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, (Math.random() - 0.5) * 2, Math.sin(a) * r));
          fx.spawn(p, hl.pos.clone().sub(p).multiplyScalar(2).add(new THREE.Vector3(-Math.sin(a) * 6, 0, Math.cos(a) * 6)), Math.random() < 0.5 ? '#b46bff' : '#ff9f1c', 0.5, 0.45, 0, 0);
        }
      } else if (hl.t >= hl.life && hl.eaten >= 0) {
        // collapse: everything it swallowed comes back out at once
        hl.eaten = -1;
        this.city.push(hl.pos, 18, 22, 0.6);
        this.city.damage(hl.pos.clone().setY(1), 3.2, 13, { ignite: true });
        fx.ring(hl.pos.clone().setY(0.3), '#d9b3ff', 16, 0.7);
        fx.explosion(hl.pos, 1.8);
        fx.flashAt(hl.pos, '#d9b3ff', 900);
        this.ctx.flash('#efe0ff', 0.5);
        cam.shake = Math.min(2, cam.shake + 1.2);
        this.say('hole', '🕳️ COLLAPSE!', 0);
      }
    }
    for (const hl of this.holes.filter((x) => x.t > x.life + 0.2)) this.disposeObj(hl.g);
    this.holes = this.holes.filter((x) => x.t <= x.life + 0.2);
  }

  private updateTwisters(dt: number) {
    const { fx } = this.ctx;
    for (const tw of this.twisters) {
      tw.t += dt;
      tw.vel.add(new THREE.Vector3((Math.random() - 0.5) * 6 * dt, 0, (Math.random() - 0.5) * 6 * dt));
      tw.vel.addScaledVector(tw.pos.clone().multiplyScalar(-0.05), dt); // drift back toward the middle
      tw.vel.clampLength(0, 3);
      tw.pos.addScaledVector(tw.vel, dt);
      tw.pos.x = THREE.MathUtils.clamp(tw.pos.x, -CITY.w / 2 + 2, CITY.w / 2 - 2);
      tw.pos.z = THREE.MathUtils.clamp(tw.pos.z, -CITY.d / 2 + 2, CITY.d / 2 - 2);
      const c = tw.pos.clone().setY(7);
      this.city.pullToward(c, 7, 22, 70 * tw.dir, 34);
      this.city.knockCars(tw.pos, 2.5, 6);
      tw.tick -= dt;
      if (tw.tick <= 0) {
        tw.tick = 0.12;
        const a = Math.random() * Math.PI * 2;
        const at = new THREE.Vector3(tw.pos.x + Math.cos(a) * 1.4, 0.6 + Math.random() * 8, tw.pos.z + Math.sin(a) * 1.4);
        const swirl = new THREE.Vector3(-Math.sin(a) * tw.dir, 0, Math.cos(a) * tw.dir).multiplyScalar(11).setY(10);
        this.city.damage(at, 1.35, 5, { vel: swirl, debris: 0.8 });
      }
      for (let k = 0; k < 12; k++) {
        const hgt = Math.random() * 14, rad = 0.6 + hgt * 0.3, a = Math.random() * Math.PI * 2;
        const p = tw.pos.clone().add(new THREE.Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad));
        const v = new THREE.Vector3(-Math.sin(a) * tw.dir, 0.3, Math.cos(a) * tw.dir).multiplyScalar(10).add(new THREE.Vector3(0, 4, 0));
        if (k % 3 === 0) fx.smoke(p, v.multiplyScalar(0.5), hgt > 7 ? '#c9c2b8' : '#a3927c', 0.7, 1.1, 0.8, 0, 0.5);
        else fx.spawn(p, v, hgt > 7 ? '#e5ecf2' : '#c2b49b', 0.45, 0.55, 0, 0.5);
      }
    }
    this.twisters = this.twisters.filter((x) => x.t < x.life);
  }

  private updateJets(dt: number) {
    const { fx } = this.ctx;
    for (const j of this.jets) {
      j.t += dt;
      j.pos.addScaledVector(j.dir, 34 * dt);
      j.g.position.copy(j.pos);
      fx.smoke(j.pos.clone().addScaledVector(j.dir, -1.8), new THREE.Vector3(0, 0, 0), '#f2f2f2', 1.4, 0.4, 0.8, 0, 0.2);
      const along = j.pos.clone().sub(j.target).dot(j.dir);
      j.drop -= dt;
      if (Math.abs(along) < 13 && j.drop <= 0) {
        j.drop = 0.12;
        this.city.launch(j.pos.clone().setY(j.pos.y - 0.6), j.dir.clone().multiplyScalar(14).setY(-4), 0.3, '#30343a', { fuse: 4, keepVel: null, trail: null, onBoom: (at) => this.boom(at, 2.4, 10, 0.3, 1) });
      }
    }
    for (const j of this.jets.filter((x) => x.t > 2.6)) this.disposeObj(j.g);
    this.jets = this.jets.filter((x) => x.t <= 2.6);
  }

  private disposeObj(...objs: THREE.Object3D[]) {
    for (const o of objs) {
      this.extraGroup.remove(o);
      o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    }
  }

  private clearEffects() {
    for (const u of this.ufos) this.disposeObj(u.g, u.beam);
    for (const hl of this.holes) this.disposeObj(hl.g);
    for (const j of this.jets) this.disposeObj(j.g);
    this.ufos = []; this.holes = []; this.jets = []; this.twisters = []; this.later = [];
    this.quakeLeft = 0;
  }

  heldKind(id: number) { const p = this.st.get(id)?.held; return p ? p.kind : null; }
  debug() {
    return {
      phase: this.phase, timeLeft: this.timeLeft, damage: this.damage, combo: this.combo,
      destroyed: this.city.destroyedChunks, total: this.city.totalChunks, leveled: this.city.leveled, cars: this.city.carsWrecked,
      pieces: this.city.pieces.length, burning: this.city.burningCount,
      effects: { ufos: this.ufos.length, holes: this.holes.length, twisters: this.twisters.length, jets: this.jets.length, quake: this.quakeLeft > 0 },
      hands: [...this.st.entries()].map(([id, s]) => ({ id, held: s.held?.kind ?? null, palm: s.palm.toArray().map((v) => +v.toFixed(2)), hover: +s.giant.hover.toFixed(2) })),
    };
  }
}
