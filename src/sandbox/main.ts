/**
 * GESTURE SANDBOX shell: renderer, camera rig, hand tracking → gesture engine → the active mode.
 * Modes (./playground.ts, ./city/cityMode.ts) own their world, their gesture powers and their HUD.
 */
import * as THREE from 'three';
import { HandTracker } from '../input/handTracker';
import { screenHandLandmarks, type HandPose } from '../input/fakeHand';
import { DEFAULT_POSE, GestureEngine, fromMediaPipe, type GestureFrame, type HandInput } from '../gesture';
import { CityMode } from './city/cityMode';
import { Fx } from './fx';
import type { Ctx, Mode, SandboxHand } from './modes';
import { PlaygroundMode } from './playground';
import { ARENA } from './world';
import './sandbox.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const LOWRES = params.has('lowres');

// ------------------------------------------------------------------ renderer / scene
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOWRES });
renderer.setPixelRatio(LOWRES ? 0.5 : Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = !LOWRES;
renderer.shadowMap.type = THREE.PCFShadowMap;
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
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 24, bottom: -24, near: 1, far: 90 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
scene.add(sun);
const fx = new Fx();
scene.add(fx.group);

// camera rig: orbits the field; two-hand gestures zoom and turn it
const cam = { yaw: 0, yawTo: 0, zoom: 1, zoomTo: 1, shake: 0, baseDist: 40 };
const overlay = $<HTMLCanvasElement>('hands2d');
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // the legend covers the left edge on wide screens: centre the field in the space to its right
  const legendW = w > 760 ? 310 : 0;
  if (legendW) camera.setViewOffset(w, h, -legendW / 2, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
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

// ------------------------------------------------------------------ screen ↔ world
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Camera-image coords (mirrored, 0..1) → view coords: the middle of the camera covers the whole screen. */
const REGION = { x0: 0.12, x1: 0.88, y0: 0.08, y1: 0.78 };
const toView = (p: { x: number; y: number }) => ({ x: (p.x - REGION.x0) / (REGION.x1 - REGION.x0), y: (p.y - REGION.y0) / (REGION.y1 - REGION.y0) });
const ndc = new THREE.Vector2();
function viewRay(v: { x: number; y: number }, out: THREE.Ray) {
  ndc.set(Math.max(-0.1, Math.min(1.1, v.x)) * 2 - 1, -(Math.max(-0.1, Math.min(1.1, v.y)) * 2 - 1));
  raycaster.setFromCamera(ndc, camera);
  return out.copy(raycaster.ray);
}
const tmpRay = new THREE.Ray();
function viewToGround(v: { x: number; y: number }, out = new THREE.Vector3()) {
  if (!viewRay(v, tmpRay).intersectPlane(groundPlane, out)) out.set(0, 0, 0);
  out.x = THREE.MathUtils.clamp(out.x, -ARENA.w / 2, ARENA.w / 2);
  out.z = THREE.MathUtils.clamp(out.z, -ARENA.d / 2, ARENA.d / 2);
  out.y = 0;
  return out;
}
function screenDirToGround(dx: number, dy: number) {
  const right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
  const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  return right.multiplyScalar(dx).add(fwd.multiplyScalar(-dy)).normalize();
}

// ------------------------------------------------------------------ hands
const HAND_COLORS = ['#ff9f1c', '#2a9df4', '#ef476f', '#06d6a0'];
interface ShellHand extends SandboxHand { reticle: THREE.Mesh; tag: THREE.Sprite; tagPose: string | null }
const hands = new Map<number, ShellHand>();
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
function getHand(id: number): ShellHand {
  let h = hands.get(id);
  if (!h) {
    const col = HAND_COLORS[(id + 4) % HAND_COLORS.length];
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthWrite: false }));
    reticle.rotation.x = -Math.PI / 2;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture('✋'), depthTest: false, transparent: true }));
    tag.scale.setScalar(2.2);
    tag.renderOrder = 10;
    scene.add(reticle, tag);
    h = { id, cursor: new THREE.Vector3(), vel: new THREE.Vector3(), result: null, reticle, tag, tagPose: null };
    hands.set(id, h);
  }
  return h;
}
function dropHand(h: ShellHand) {
  mode.onHandGone(h);
  scene.remove(h.reticle, h.tag);
  hands.delete(h.id);
}

// ------------------------------------------------------------------ legend, toasts, flash
let counts: Record<string, number> = {};
function act(id: string, text?: string) {
  counts[id] = (counts[id] ?? 0) + 1;
  const row = document.querySelector<HTMLElement>(`.act[data-a="${id}"]`);
  if (row) {
    row.classList.add('used', 'fire');
    (row.querySelector('.n') as HTMLElement).textContent = `×${counts[id]}`;
    setTimeout(() => row.classList.remove('fire'), 500);
  }
  const a = mode.actions.find((x) => x.id === id);
  toast(text ?? (a ? `${a.emoji} ${a.effect.split(/[.:]/)[0].toUpperCase()}` : id.toUpperCase()));
}
function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('go'); void t.offsetWidth; t.classList.add('go');
}
function flash(color = '#ffffff', strength = 0.8) {
  const f = $('flash');
  f.style.background = color;
  f.style.setProperty('--a', String(strength));
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}
function buildLegend() {
  $('legend').innerHTML = `<h2>${mode.legendTitle}</h2>${mode.actions.map((a) => `
    <div class="act" data-a="${a.id}"><span class="e">${a.emoji}</span><span class="g">${a.gesture}</span><span class="n"></span><span class="d">${a.effect}</span></div>`).join('')}`;
}

// ------------------------------------------------------------------ input
const video = $<HTMLVideoElement>('cam');
const tracker = new HandTracker(video);
// experimental poses off: e.g. "two fingers together" could steal a sloppy peace sign
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

const mouse = { v: { x: 0.5, y: 0.5 }, down: false };
canvas.addEventListener('pointermove', (e) => { mouse.v = { x: e.clientX / innerWidth, y: e.clientY / innerHeight }; });
canvas.addEventListener('pointerdown', (e) => {
  mouse.v = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
  mouse.down = true;
  const h = getHand(-1);
  viewToGround(mouse.v, h.cursor);
  mode.mouseDown(h);
});
addEventListener('pointerup', () => { mouse.down = false; const h = hands.get(-1); if (h) mode.mouseUp(h); });
addEventListener('keydown', (e) => mode.keys[e.key.toLowerCase()]?.());

// ------------------------------------------------------------------ modes
const ctx: Ctx = {
  scene, camera, fx, cam, hands, act, toast, flash, toView, viewToGround, viewRay, screenDirToGround,
  mouseView: () => mouse.v, hud: $('mode-hud'), overlay: $('mode-overlay'),
};
const modes: Record<Mode['id'], Mode> = { playground: new PlaygroundMode(), city: new CityMode() };
let mode: Mode = modes.playground;
function setMode(id: Mode['id'], first = false) {
  if (!first && mode.id === id) return;
  if (!first) mode.exit();
  for (const h of [...hands.values()]) { scene.remove(h.reticle, h.tag); hands.delete(h.id); }
  fx.clear();
  counts = {};
  ctx.hud.innerHTML = '';
  ctx.overlay.innerHTML = '';
  ctx.overlay.classList.add('hidden');
  cam.yawTo = 0; cam.zoomTo = 1;
  mode = modes[id];
  mode.enter(ctx);
  buildLegend();
  document.body.dataset.mode = id;
  $('hold').querySelector('span')!.textContent = id === 'city' ? 'Hold 👎 for a new city' : 'Hold 👎 to clear';
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === id));
  const u = new URL(location.href);
  if (id === 'playground') u.searchParams.delete('mode'); else u.searchParams.set('mode', id);
  history.replaceState(null, '', u);
}
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode as Mode['id']); });

// ------------------------------------------------------------------ 2D hand skeletons over the scene
const octx = overlay.getContext('2d')!;
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
function drawHands() {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  if (!mode.overlayHands) return;
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

// ------------------------------------------------------------------ gestures → hands → mode
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
  for (const e of frame.events) {
    // the camera works the same in every mode
    if (e.kind === 'two-hand' && e.name !== 'clap') {
      switch (e.name) {
        case 'zoom-in': cam.zoomTo = Math.max(0.5, cam.zoomTo * 0.78); act('camera', '🔍 ZOOM IN'); break;
        case 'zoom-out': cam.zoomTo = Math.min(1.5, cam.zoomTo * 1.28); act('camera', '🔭 ZOOM OUT'); break;
        case 'steer-left': cam.yawTo -= Math.PI / 5; act('camera', '🛞 ORBIT LEFT'); break;
        case 'steer-right': cam.yawTo += Math.PI / 5; act('camera', '🛞 ORBIT RIGHT'); break;
      }
      continue;
    }
    mode.onEvent(e, e.hand !== undefined ? hands.get(e.hand) : undefined, t);
  }
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
  const mh = hands.get(-1);
  if (mh) {
    const prev = mh.cursor.clone();
    viewToGround(mouse.v, mh.cursor);
    if (dt > 0) mh.vel.lerp(mh.cursor.clone().sub(prev).divideScalar(Math.max(dt, 1e-3)), 1 - Math.exp(-dt / 0.06));
  }

  // thumbs-down progress bar (clear / new city)
  const td = frame.hands.find((r) => r.pose === 'thumbs-down');
  hold.classList.toggle('hidden', !td);
  if (td) hold.style.setProperty('--p', String(Math.min(1, td.heldMs / engine.config.motion.holdMs)));

  // shell cursor visuals (modes that draw their own hands hide them)
  for (const h of hands.values()) {
    h.reticle.visible = h.tag.visible = mode.overlayHands;
    if (!mode.overlayHands) continue;
    h.reticle.position.copy(h.cursor).setY(0.06);
    const held = mode.heldKind(h.id) !== null;
    h.reticle.scale.setScalar((held ? 1.4 : 1) * (1 + 0.08 * Math.sin(now / 160)));
    const pose = h.id < 0 ? (mouse.down ? 'fist' : 'open') : h.result?.pose ?? null;
    if (pose !== h.tagPose) { h.tagPose = pose; (h.tag.material as THREE.SpriteMaterial).map = emojiTexture(POSE_EMOJI[pose ?? ''] ?? '✋'); (h.tag.material as THREE.SpriteMaterial).needsUpdate = true; }
    h.tag.position.copy(h.cursor).setY(held ? 6.2 : 4.2);
  }

  mode.update(dt, lastInputT);
  fx.update(dt);
  renderer.render(scene, camera);
  drawHands();
}
setMode(params.get('mode') === 'city' ? 'city' : 'playground', true);
resize();
addEventListener('resize', resize);
requestAnimationFrame(tick);

// ------------------------------------------------------------------ test hooks (headless)
declare global { interface Window { __sandbox: unknown } }
window.__sandbox = {
  engine,
  get counts() { return counts; },
  get mode() { return mode.id; },
  setMode: (id: Mode['id']) => setMode(id),
  /** Playground world (existing tests) and city world. */
  get pg() { return (modes.playground as PlaygroundMode).pg; },
  get city() { return (modes.city as CityMode).city; },
  get frame() { return frame; },
  get frameCount() { return frameCount; },
  get hands() { return [...hands.values()].map((h) => ({ id: h.id, held: mode.heldKind(h.id), cursor: h.cursor.toArray() })); },
  debug: () => mode.debug(),
  inject(h: HandInput[] | null) { injected = h; },
  /** Feed frames on a synthetic clock (ms per frame), bypassing the render loop's frame rate. */
  feed(frames: HandInput[][], msPerFrame = 33) {
    let t = Math.max(lastInputT + msPerFrame, performance.now());
    for (const f of frames) { processInputs(f, t); t += msPerFrame; }
  },
  /** Run the active mode's simulation forward without rendering (seconds, 30 Hz steps). */
  advance(seconds: number) {
    for (let s = 0; s < seconds; s += 1 / 30) { mode.update(1 / 30, lastInputT); fx.update(1 / 30); }
  },
  fake(x: number, y: number, pose: HandPose, o: { hd?: 'Left' | 'Right'; scale?: number; roll?: number } = {}): HandInput {
    const ps = o.roll !== undefined ? { ...pose, roll: o.roll } : pose;
    return { landmarks: screenHandLandmarks(x, y, ps, { handedness: o.hd ?? 'Right', scale: o.scale ?? 0.2 }), handedness: o.hd ?? 'Right', aspect: 16 / 9 };
  },
  /** Camera-image coords that put a hand's palm over world point (x, z) in this mode's hand plane. */
  aimAt(x: number, z: number) {
    const v = new THREE.Vector3(x, mode.aimHeight, z).project(camera);
    const vx = (v.x + 1) / 2, vy = (1 - v.y) / 2;
    return { x: REGION.x0 + vx * (REGION.x1 - REGION.x0), y: REGION.y0 + vy * (REGION.y1 - REGION.y0) };
  },
  key: (k: string) => mode.keys[k]?.(),
};
