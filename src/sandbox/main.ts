/**
 * GESTURE SANDBOX — an empty playground with physics toys, driven by the gesture engine.
 * Every one of the 15 actions in ./actions.ts is wired up in `handleEvent` below.
 */
import * as THREE from 'three';
import { HandTracker } from '../input/handTracker';
import { screenHandLandmarks, type HandPose } from '../input/fakeHand';
import { DEFAULT_POSE, GestureEngine, fromMediaPipe, type GestureEvent, type GestureFrame, type HandInput, type HandResult } from '../gesture';
import { ACTIONS, type ActionId } from './actions';
import { Fx } from './fx';
import { ARENA, Playground, type Item } from './world';
import './sandbox.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LOWRES = new URLSearchParams(location.search).has('lowres');

// ------------------------------------------------------------------ renderer / scene
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOWRES });
renderer.setPixelRatio(LOWRES ? 0.5 : Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = !LOWRES;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#bfe6ff');
scene.fog = new THREE.Fog('#bfe6ff', 70, 140);
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 300);
scene.add(new THREE.HemisphereLight('#eaf6ff', '#6d9a45', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
sun.position.set(-14, 30, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 24, bottom: -24, near: 1, far: 80 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
scene.add(sun);

const pg = new Playground();
const fx = new Fx();
scene.add(pg.group, fx.group);

// camera rig: orbits the field; two-hand gestures zoom and turn it
const cam = { yaw: 0, yawTo: 0, zoom: 1, zoomTo: 1, shake: 0, baseDist: 40 };
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // the legend covers the left edge on wide screens: centre the field in the space to its right
  const legendW = w > 760 ? 310 : 0;
  if (legendW) camera.setViewOffset(w, h, -legendW / 2, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  // fit the arena width into the visible part
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * ((w - legendW) / h));
  cam.baseDist = Math.max((ARENA.w * 0.62) / Math.tan(hfov / 2), 30);
  fx.setScale(h * (LOWRES ? 0.5 : 1));
  overlay.width = w; overlay.height = h;
}
function placeCamera(dt: number) {
  cam.yaw += (cam.yawTo - cam.yaw) * Math.min(1, dt * 4);
  cam.zoom += (cam.zoomTo - cam.zoom) * Math.min(1, dt * 4);
  const d = cam.baseDist * cam.zoom, pitch = THREE.MathUtils.degToRad(52);
  camera.position.set(Math.sin(cam.yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(cam.yaw) * Math.cos(pitch) * d);
  if (cam.shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * cam.shake;
    camera.position.y += (Math.random() - 0.5) * cam.shake;
    cam.shake *= Math.exp(-dt * 7);
  }
  camera.lookAt(0, 0, 1.5);
}

// ------------------------------------------------------------------ screen ↔ ground
const ray = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Camera-image coords (mirrored, 0..1) → view coords: the middle of the camera covers the whole screen. */
const REGION = { x0: 0.12, x1: 0.88, y0: 0.08, y1: 0.78 };
const toView = (p: { x: number; y: number }) => ({ x: (p.x - REGION.x0) / (REGION.x1 - REGION.x0), y: (p.y - REGION.y0) / (REGION.y1 - REGION.y0) });
function viewToGround(v: { x: number; y: number }, out = new THREE.Vector3()) {
  ray.setFromCamera(new THREE.Vector2(Math.max(-0.1, Math.min(1.1, v.x)) * 2 - 1, -(Math.max(-0.1, Math.min(1.1, v.y)) * 2 - 1)), camera);
  if (!ray.ray.intersectPlane(groundPlane, out)) out.set(0, 0, 0);
  out.x = THREE.MathUtils.clamp(out.x, -ARENA.w / 2, ARENA.w / 2);
  out.z = THREE.MathUtils.clamp(out.z, -ARENA.d / 2, ARENA.d / 2);
  out.y = 0;
  return out;
}
/** A screen direction (x right, y down) as a ground direction under the current camera. */
function screenDirToGround(dx: number, dy: number) {
  const right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
  const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  return right.multiplyScalar(dx).add(fwd.multiplyScalar(-dy)).normalize();
}

// ------------------------------------------------------------------ hands
const HAND_COLORS = ['#ff9f1c', '#2a9df4', '#ef476f', '#06d6a0'];
interface Hand {
  id: number;
  cursor: THREE.Vector3;
  vel: THREE.Vector3;
  held: Item | null;
  releasedAt: number;
  released: Item | null;
  pullUntil: number;
  reticle: THREE.Mesh;
  tag: THREE.Sprite;
  tagPose: string | null;
  result: HandResult | null;
}
const hands = new Map<number, Hand>();
const emojiTex = new Map<string, THREE.Texture>();
function emojiTexture(e: string) {
  let t = emojiTex.get(e);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.font = '96px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(e, 64, 72);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    emojiTex.set(e, t);
  }
  return t;
}
const POSE_EMOJI: Record<string, string> = {
  open: '✋', fist: '✊', point: '☝️', middle: '🖕', victory: '✌️', 'thumbs-up': '👍', 'thumbs-down': '👎',
  rock: '🤘', shaka: '🤙', gun: '👉', pinch: '🤏', ok: '👌', claw: '🦅', three: '🤟', four: '🖐️',
};
function getHand(id: number): Hand {
  let h = hands.get(id);
  if (!h) {
    const col = HAND_COLORS[id % HAND_COLORS.length];
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthWrite: false }));
    reticle.rotation.x = -Math.PI / 2;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture('✋'), depthTest: false, transparent: true }));
    tag.scale.setScalar(2.2);
    tag.renderOrder = 10;
    scene.add(reticle, tag);
    h = { id, cursor: new THREE.Vector3(), vel: new THREE.Vector3(), held: null, releasedAt: -1e9, released: null, pullUntil: 0, reticle, tag, tagPose: null, result: null };
    hands.set(id, h);
  }
  return h;
}
function dropHand(h: Hand) {
  release(h);
  scene.remove(h.reticle, h.tag);
  hands.delete(h.id);
}

// ------------------------------------------------------------------ actions
const counts: Record<string, number> = {};
const cooldowns: Record<string, number> = {};
const cool = (k: string, ms: number) => { const now = performance.now(); if ((cooldowns[k] ?? 0) > now) return false; cooldowns[k] = now + ms; return true; };
function act(id: ActionId, text?: string) {
  counts[id] = (counts[id] ?? 0) + 1;
  const row = document.querySelector<HTMLElement>(`.act[data-a="${id}"]`);
  if (row) {
    row.classList.add('used', 'fire');
    (row.querySelector('.n') as HTMLElement).textContent = `×${counts[id]}`;
    setTimeout(() => row.classList.remove('fire'), 500);
  }
  const a = ACTIONS.find((x) => x.id === id)!;
  const t = $('toast');
  t.textContent = text ?? `${a.emoji} ${a.effect.split(/[.:]/)[0].toUpperCase()}`;
  t.classList.remove('go'); void t.offsetWidth; t.classList.add('go');
}

function grab(h: Hand) {
  const it = pg.nearest(h.cursor, 3.4);
  if (!it) return;
  h.held = it;
  it.body.wakeUp();
  fx.ring(it.mesh.position.clone(), HAND_COLORS[h.id % 4], 2, 0.35);
  act('grab', '✊ GRABBED!');
}
function release(h: Hand, t = performance.now()) {
  const it = h.held;
  if (!it) return;
  h.held = null;
  it.body.velocity.set(h.vel.x * 1.15, Math.max(2, h.vel.y + 3), h.vel.z * 1.15);
  h.released = it;
  h.releasedAt = t;
}

interface Tornado { pos: THREE.Vector3; until: number; dir: number; drift: THREE.Vector3 }
const tornados: Tornado[] = [];
interface Rocket { p: THREE.Vector3; v: THREE.Vector3; burstAt: number; color: string }
const rockets: Rocket[] = [];
const meteorQueue: { at: number; target: THREE.Vector3 }[] = [];

pg.onMeteorHit = (p) => {
  pg.blast(p, 4.5, 12, 0.8);
  fx.burst(p.clone().setY(0.4), '#ff7b00', 50, 11, 0.9, 0.6);
  fx.burst(p.clone().setY(0.4), '#ffd166', 25, 7, 0.6, 0.4);
  fx.ring(p, '#ff9f1c', 4.5, 0.45);
  fx.scorch(p, 1.8);
  cam.shake = Math.min(1.5, cam.shake + 0.35);
};

function lightning(p: THREE.Vector3) {
  fx.bolt(p);
  pg.blast(p, 5, 15, 0.9);
  fx.burst(p.clone().setY(0.3), '#cfe8ff', 60, 12, 0.7, 0.5);
  fx.ring(p, '#9ad1ff', 5, 0.4);
  fx.scorch(p, 2.4);
  cam.shake = Math.min(1.5, cam.shake + 0.6);
}
function cannon(from: THREE.Vector3, dir: THREE.Vector3) {
  const start = from.clone().setY(1.6).addScaledVector(dir, -0.5);
  pg.spawnCannonball(start, dir.clone().multiplyScalar(34).add(new THREE.Vector3(0, 4, 0)));
  fx.burst(start, '#ffffff', 20, 5, 0.5, 0.6, 2);
}
function shockwave(p: THREE.Vector3) {
  pg.blast(p, 11, 17, 0.35);
  fx.ring(p, '#ffffff', 11, 0.55);
  fx.ring(p, '#4cc9f0', 8, 0.45);
  cam.shake = Math.min(1.5, cam.shake + 0.3);
}
function wind(dir: number) {
  const d = screenDirToGround(dir, 0);
  pg.shove(new THREE.Vector3(d.x * 15, 3, d.z * 15), 0.25);
  // streaks across the field
  for (let k = 0; k < 120; k++) {
    const p = new THREE.Vector3((Math.random() - 0.5) * ARENA.w, 0.5 + Math.random() * 5, (Math.random() - 0.5) * ARENA.d).addScaledVector(d, -ARENA.w * 0.4);
    fx.spawn(p, d.clone().multiplyScalar(30 + Math.random() * 15), '#ffffff', 0.9, 0.35, 0, 0.2);
  }
}
function thunderclap() {
  pg.shove(new THREE.Vector3(0, 13, 0), 0.4);
  fx.ring(new THREE.Vector3(0, 0, 0), '#fff3b0', 30, 0.7);
  cam.shake = Math.min(1.8, cam.shake + 0.9);
}
function meteors(center: THREE.Vector3) {
  const now = performance.now();
  for (let k = 0; k < 12; k++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 8;
    const t = new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
    t.x = THREE.MathUtils.clamp(t.x, -ARENA.w / 2 + 1, ARENA.w / 2 - 1);
    t.z = THREE.MathUtils.clamp(t.z, -ARENA.d / 2 + 1, ARENA.d / 2 - 1);
    meteorQueue.push({ at: now + k * 160 + Math.random() * 120, target: t });
  }
}
function fireworks(center: THREE.Vector3) {
  const now = performance.now();
  const cols = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff9f1c', '#f15bb5'];
  for (let k = 0; k < 6; k++) {
    const p = center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 0.3, (Math.random() - 0.5) * 8));
    rockets.push({ p, v: new THREE.Vector3((Math.random() - 0.5) * 3, 20 + Math.random() * 6, (Math.random() - 0.5) * 3), burstAt: now + 700 + k * 220 + Math.random() * 300, color: cols[k % cols.length] });
  }
}

/** Gesture events → actions. */
function handleEvent(e: GestureEvent, now: number) {
  const h = e.hand !== undefined ? hands.get(e.hand) : undefined;
  if (e.kind === 'pose' && h) {
    if (e.phase === 'end') { if (e.name === 'fist') release(h, now); return; }
    switch (e.name) {
      case 'fist': grab(h); break;
      case 'victory': if (cool('tower', 900)) { pg.tower(h.cursor.clone(), 8); fx.ring(h.cursor, '#ffd166', 3, 0.4); act('tower'); } break;
      case 'middle': if (cool('lightning' + h.id, 500)) {
        const tip = h.result?.landmarks[12];
        lightning(tip ? viewToGround(toView(tip)) : h.cursor.clone());
        act('lightning');
      } break;
      case 'gun': if (cool('cannon' + h.id, 350) && h.result) {
        const d = h.result.features.pointDir;
        cannon(h.cursor, screenDirToGround(d.x, d.y));
        act('cannon');
      } break;
      case 'rock': if (cool('meteors', 2200)) { meteors(h.cursor.clone()); act('meteors'); } break;
      case 'thumbs-up': if (cool('fireworks', 1500)) { fireworks(h.cursor.clone()); act('fireworks'); } break;
    }
    return;
  }
  if (e.kind === 'motion' && h) {
    switch (e.name) {
      case 'hold': if (e.data?.pose === 'thumbs-down' && cool('clear', 1200)) { const r = pg.clear(); act('clear', r === 'reset' ? '🧸 TOYS RESTORED' : '👎 CLEARED'); } break;
      case 'tap': if (!h.held) { pg.spawnBall(h.cursor.clone().setY(9), 0.55 + Math.random() * 0.35); act('ball'); } break;
      case 'double-tap': if (!h.held) { pg.spawnBox(h.cursor.clone().setY(10), 1.3, 'crate'); act('crate'); } break;
      case 'push': if (!h.held) { shockwave(h.cursor.clone()); act('shockwave'); } break;
      case 'pull': h.pullUntil = now + 1700; act('vacuum'); break;
      case 'circle-cw': case 'circle-ccw':
        if (cool('tornado', 900)) {
          tornados.push({ pos: h.cursor.clone(), until: now + 5000, dir: e.name === 'circle-cw' ? 1 : -1, drift: new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2) });
          act('tornado');
        }
        break;
      case 'swipe-left': case 'swipe-right': if (!h.held && now - h.releasedAt > 600) { wind(e.name === 'swipe-left' ? -1 : 1); act('wind', e.name === 'swipe-left' ? '💨 ⬅ WIND' : '💨 WIND ➡'); } break;
      case 'throw': {
        // the throw can be recognised a moment before the fist officially ends: let go now
        if (h.held) release(h, now);
        const it = h.released;
        if (it && now - h.releasedAt < 450) {
          const v = h.vel.clone().setY(0);
          if (v.length() < 8) v.setLength(8);
          it.body.velocity.set(v.x * 1.7, 7, v.z * 1.7);
          fx.burst(it.mesh.position.clone(), '#ffffff', 18, 4, 0.4, 0.4, 0);
          h.released = null;
          act('throw', '🤾 YEET!');
        }
        break;
      }
    }
    return;
  }
  if (e.kind === 'two-hand') {
    switch (e.name) {
      case 'clap': thunderclap(); act('thunderclap'); break;
      case 'zoom-in': cam.zoomTo = Math.max(0.5, cam.zoomTo * 0.78); act('camera', '🔍 ZOOM IN'); break;
      case 'zoom-out': cam.zoomTo = Math.min(1.5, cam.zoomTo * 1.28); act('camera', '🔭 ZOOM OUT'); break;
      case 'steer-left': cam.yawTo -= Math.PI / 5; act('camera', '🛞 ORBIT LEFT'); break;
      case 'steer-right': cam.yawTo += Math.PI / 5; act('camera', '🛞 ORBIT RIGHT'); break;
    }
  }
}

// ------------------------------------------------------------------ input: camera, injected (tests) or mouse
const video = $<HTMLVideoElement>('cam');
const tracker = new HandTracker(video);
// experimental poses off: e.g. "two fingers together" could steal a sloppy peace sign from the tower
const engine = new GestureEngine({ pose: { ...DEFAULT_POSE, experimental: false } });
let running = false;
let injected: HandInput[] | null = null;
let frame: GestureFrame = engine.update([], performance.now());

$('b-cam').onclick = async () => {
  const b = $<HTMLButtonElement>('b-cam');
  b.disabled = true; b.textContent = 'Loading hand tracking…';
  try {
    await tracker.start();
    running = true;
    $('start').classList.add('hidden');
    $('pip-label').textContent = 'show your hands';
  } catch (err) {
    $('err').textContent = `Camera unavailable (${(err as Error).message}). You can still play with the mouse.`;
    b.disabled = false; b.textContent = '✋ Retry camera';
  }
};
$('b-mouse').onclick = () => $('start').classList.add('hidden');

// mouse: drag toys around and fling them; keys trigger the powers at the cursor
const mouse = { v: { x: 0.5, y: 0.5 }, down: false, hand: null as Hand | null };
canvas.addEventListener('pointermove', (e) => { mouse.v = { x: e.clientX / innerWidth, y: e.clientY / innerHeight }; });
canvas.addEventListener('pointerdown', (e) => {
  mouse.v = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
  mouse.down = true;
  const h = getHand(-1);
  viewToGround(mouse.v, h.cursor);
  grab(h);
});
addEventListener('pointerup', () => { mouse.down = false; const h = hands.get(-1); if (h) release(h); });
const KEYS: Record<string, () => void> = {};
addEventListener('keydown', (e) => KEYS[e.key.toLowerCase()]?.());
function mousePoint() { return viewToGround(mouse.v); }
Object.assign(KEYS, {
  '1': () => { pg.spawnBall(mousePoint().setY(9)); act('ball'); },
  '2': () => { pg.spawnBox(mousePoint().setY(10), 1.3, 'crate'); act('crate'); },
  '3': () => { pg.tower(mousePoint(), 8); act('tower'); },
  '4': () => { lightning(mousePoint()); act('lightning'); },
  '5': () => { const p = mousePoint(); cannon(p.clone().add(new THREE.Vector3(0, 0, 8)), screenDirToGround(0, -1)); act('cannon'); },
  '6': () => { shockwave(mousePoint()); act('shockwave'); },
  '7': () => { const h = getHand(-1); viewToGround(mouse.v, h.cursor); h.pullUntil = performance.now() + 1700; act('vacuum'); },
  '8': () => { tornados.push({ pos: mousePoint(), until: performance.now() + 5000, dir: 1, drift: new THREE.Vector3(1, 0, 0.5) }); act('tornado'); },
  '9': () => { wind(1); act('wind'); },
  '0': () => { thunderclap(); act('thunderclap'); },
  m: () => { meteors(mousePoint()); act('meteors'); },
  f: () => { fireworks(mousePoint()); act('fireworks'); },
  x: () => { const r = pg.clear(); act('clear', r === 'reset' ? '🧸 TOYS RESTORED' : '👎 CLEARED'); },
});

// ------------------------------------------------------------------ legend
$('legend').innerHTML = `<h2>15 GESTURES</h2>${ACTIONS.map((a) => `
  <div class="act" data-a="${a.id}"><span class="e">${a.emoji}</span><span class="g">${a.gesture}</span><span class="n"></span><span class="d">${a.effect}</span></div>`).join('')}`;

// ------------------------------------------------------------------ 2D hand skeletons over the scene
const overlay = $<HTMLCanvasElement>('hands2d');
const octx = overlay.getContext('2d')!;
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
function drawHands() {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  for (const r of frame.hands) {
    const col = HAND_COLORS[r.id % 4];
    // draw at a steady size around the palm (a close hand would otherwise cover the screen)
    const c = toView(r.features.center);
    const w0 = toView(r.landmarks[0]), m9 = toView(r.landmarks[9]);
    const palm = Math.hypot((m9.x - w0.x) * W, (m9.y - w0.y) * H) || 1;
    const k = THREE.MathUtils.clamp((H * 0.085) / palm, 0.2, 1.2);
    const P = r.landmarks.map((p) => { const v = toView(p); return [(c.x + (v.x - c.x) * k) * W, (c.y + (v.y - c.y) * k) * H] as const; });
    octx.lineWidth = 4; octx.lineCap = 'round'; octx.strokeStyle = 'rgba(255,255,255,0.75)';
    octx.beginPath();
    for (const [a, b] of BONES) { octx.moveTo(...P[a]); octx.lineTo(...P[b]); }
    octx.stroke();
    octx.fillStyle = col;
    for (const i of [4, 8, 12, 16, 20]) { octx.beginPath(); octx.arc(...P[i], 6, 0, Math.PI * 2); octx.fill(); }
  }
}

// ------------------------------------------------------------------ gestures → hands → actions
let lastInputT = 0;
function processInputs(inputs: HandInput[], t: number) {
  const dt = lastInputT ? Math.min(0.1, Math.max(0, (t - lastInputT) / 1000)) : 0;
  lastInputT = t;
  frame = engine.update(inputs, t);
  const seen = new Set<number>();
  for (const r of frame.hands) {
    const h = getHand(r.id);
    seen.add(r.id);
    h.result = r;
    const prev = h.cursor.clone();
    viewToGround(toView(r.features.center), h.cursor);
    if (dt > 0) h.vel.lerp(h.cursor.clone().sub(prev).divideScalar(dt), 1 - Math.exp(-dt / 0.06));
  }
  for (const h of [...hands.values()]) if (h.id >= 0 && !seen.has(h.id)) dropHand(h);
  for (const e of frame.events) handleEvent(e, t);
  $('status').textContent = running ? `${Math.round(tracker.fps)} fps · ${frame.hands.length} hand${frame.hands.length === 1 ? '' : 's'}` : 'synthetic';
  $('pip-label').textContent = frame.hands.length ? frame.hands.map((r) => `${POSE_EMOJI[r.pose ?? ''] ?? '·'} ${r.pose ?? '—'}`).join('  ') : 'show your hands';
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
let frameCount = 0;
const hold = $('hold');
function tick(now: number) {
  requestAnimationFrame(tick);
  frameCount++;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  placeCamera(dt);

  // gestures (camera; tests feed processInputs directly with their own clock)
  if (!injected && running) {
    const det = tracker.detect(now);
    if (det) processInputs(fromMediaPipe(det.hands, det.aspect), det.frameTime);
  } else if (injected) processInputs(injected, now);
  // mouse hand
  const mh = hands.get(-1);
  if (mh) {
    const prev = mh.cursor.clone();
    viewToGround(mouse.v, mh.cursor);
    if (dt > 0) mh.vel.lerp(mh.cursor.clone().sub(prev).divideScalar(Math.max(dt, 1e-3)), 1 - Math.exp(-dt / 0.06));
  }

  // thumbs-down progress bar
  const td = frame.hands.find((r) => r.pose === 'thumbs-down');
  hold.classList.toggle('hidden', !td);
  if (td) hold.style.setProperty('--p', String(Math.min(1, td.heldMs / engine.config.motion.holdMs)));

  // continuous effects
  for (const h of hands.values()) {
    // carried toy follows the hand, floating above it
    if (h.held) {
      const b = h.held.body;
      if (h.held.dying !== undefined) { h.held = null; continue; }
      const lift = h.held.kind === 'beach' ? 4.2 : 3.2;
      const tx = h.cursor.x - b.position.x, ty = lift - b.position.y, tz = h.cursor.z - b.position.z;
      b.wakeUp();
      b.velocity.set(THREE.MathUtils.clamp(tx * 12, -40, 40), THREE.MathUtils.clamp(ty * 12, -40, 40), THREE.MathUtils.clamp(tz * 12, -40, 40));
      b.angularVelocity.scale(0.9, b.angularVelocity);
    }
    if (now < h.pullUntil) {
      pg.pullToward(h.cursor, 15, 55, 0, 10);
      if (Math.random() < 0.8) {
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 8;
        const p = h.cursor.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.4 + Math.random() * 2, Math.sin(a) * r));
        fx.spawn(p, h.cursor.clone().sub(p).multiplyScalar(2.2), '#9ad1ff', 0.5, 0.35, 0, 0);
      }
    }
    // cursor visuals
    const r = h.result;
    h.reticle.position.copy(h.cursor).setY(0.06);
    const pulse = 1 + 0.08 * Math.sin(now / 160);
    h.reticle.scale.setScalar((h.held ? 1.4 : 1) * pulse);
    const pose = h.id < 0 ? (mouse.down ? 'fist' : 'open') : r?.pose ?? null;
    if (pose !== h.tagPose) { h.tagPose = pose; (h.tag.material as THREE.SpriteMaterial).map = emojiTexture(POSE_EMOJI[pose ?? ''] ?? '✋'); (h.tag.material as THREE.SpriteMaterial).needsUpdate = true; }
    h.tag.position.copy(h.cursor).setY(h.held ? 6.2 : 4.2);
  }
  for (const tn of tornados) {
    tn.pos.addScaledVector(tn.drift, dt);
    tn.pos.x = THREE.MathUtils.clamp(tn.pos.x, -ARENA.w / 2 + 2, ARENA.w / 2 - 2);
    tn.pos.z = THREE.MathUtils.clamp(tn.pos.z, -ARENA.d / 2 + 2, ARENA.d / 2 - 2);
    pg.pullToward(tn.pos, 7, 22, 70 * tn.dir, 34);
    for (let k = 0; k < 10; k++) {
      const hgt = Math.random() * 12, rad = 0.6 + hgt * 0.32, a = Math.random() * Math.PI * 2;
      const p = tn.pos.clone().add(new THREE.Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad));
      const v = new THREE.Vector3(-Math.sin(a) * tn.dir, 0.3, Math.cos(a) * tn.dir).multiplyScalar(9);
      fx.spawn(p, v.add(new THREE.Vector3(0, 4, 0)), hgt > 6 ? '#e5ecf2' : '#c2b49b', 0.45, 0.6, 0, 0.5);
    }
  }
  for (let i = tornados.length - 1; i >= 0; i--) if (now > tornados[i].until) tornados.splice(i, 1);
  for (let i = meteorQueue.length - 1; i >= 0; i--) {
    const m = meteorQueue[i];
    if (now < m.at) continue;
    meteorQueue.splice(i, 1);
    const start = m.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 34, -14));
    const T = 1.1, g = 22;
    const vel = m.target.clone().sub(start).divideScalar(T);
    vel.y += 0.5 * g * T;
    pg.spawnMeteor(start, vel);
  }
  for (const it of pg.items) if (it.kind === 'meteor' && it.dying === undefined) fx.spawn(it.mesh.position, new THREE.Vector3((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2), Math.random() < 0.5 ? '#ff7b00' : '#ffd166', 0.5, 1.1, 0, 0.5);
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.p.addScaledVector(r.v, dt);
    r.v.y -= 6 * dt;
    fx.spawn(r.p, new THREE.Vector3((Math.random() - 0.5) * 1.5, -3, (Math.random() - 0.5) * 1.5), '#ffe8a3', 0.35, 0.35, 0, 0.5);
    if (now >= r.burstAt) {
      rockets.splice(i, 1);
      const v = new THREE.Vector3();
      for (let k = 0; k < 110; k++) {
        v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(9 + Math.random() * 3);
        fx.spawn(r.p, v, k % 5 === 0 ? '#ffffff' : r.color, 1.4 + Math.random() * 0.6, 0.55, -4, 1.1);
      }
    }
  }

  pg.step(dt);
  fx.update(dt);
  renderer.render(scene, camera);
  drawHands();
}
resize();
addEventListener('resize', resize);
requestAnimationFrame(tick);

// ------------------------------------------------------------------ test hooks (headless)
declare global { interface Window { __sandbox: unknown } }
window.__sandbox = {
  engine, pg, counts,
  get frame() { return frame; },
  get frameCount() { return frameCount; },
  get hands() { return [...hands.values()].map((h) => ({ id: h.id, held: h.held?.kind ?? null, cursor: h.cursor.toArray() })); },
  inject(h: HandInput[] | null) { injected = h; },
  /** Feed frames on a synthetic clock (ms per frame), bypassing the render loop's frame rate. */
  feed(frames: HandInput[][], msPerFrame = 33) {
    let t = Math.max(lastInputT + msPerFrame, performance.now());
    for (const f of frames) { processInputs(f, t); t += msPerFrame; }
  },
  fake(x: number, y: number, pose: HandPose, o: { hd?: 'Left' | 'Right'; scale?: number; roll?: number } = {}): HandInput {
    const ps = o.roll !== undefined ? { ...pose, roll: o.roll } : pose;
    return { landmarks: screenHandLandmarks(x, y, ps, { handedness: o.hd ?? 'Right', scale: o.scale ?? 0.2 }), handedness: o.hd ?? 'Right', aspect: 16 / 9 };
  },
  /** Screen (view) position of a world point → camera-image coords to aim synthetic hands at it. */
  aimAt(x: number, z: number) {
    const v = new THREE.Vector3(x, 0, z).project(camera);
    const vx = (v.x + 1) / 2, vy = (1 - v.y) / 2;
    return { x: REGION.x0 + vx * (REGION.x1 - REGION.x0), y: REGION.y0 + vy * (REGION.y1 - REGION.y0) };
  },
  key: (k: string) => KEYS[k]?.(),
};
