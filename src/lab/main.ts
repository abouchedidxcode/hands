/**
 * GESTURE LAB — a workbench for the gesture engine.
 *  Live:    every pose's score, motion events and a log, over your webcam with the skeleton drawn.
 *  Test:    prompts gestures in random order, measures detection rate, time-to-detect and
 *           confusions, and asks how natural each one felt.
 *  Results: per-gesture table across all your test runs (stored locally), exportable.
 *  Tune:    every engine threshold as a slider, applied live, exportable as JSON for games.
 */
import { HandTracker } from '../input/handTracker';
import { screenHandLandmarks, type HandPose } from '../input/fakeHand';
import {
  DEFAULT_CONFIG, GestureEngine, MOTION_INFO, fromMediaPipe,
  type EngineConfig, type GestureEvent, type GestureFrame, type HandInput,
} from '../gesture';
import './lab.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('cam');
const canvas = $<HTMLCanvasElement>('overlay');
const ctx = canvas.getContext('2d')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ------------------------------------------------------------------ config persistence
const CFG_KEY = 'gesturelab.config.v1';
const TRIALS_KEY = 'gesturelab.trials.v1';
function loadConfig(): EngineConfig {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    if (c) return { pose: { ...DEFAULT_CONFIG.pose, ...c.pose }, motion: { ...DEFAULT_CONFIG.motion, ...c.motion }, smoothing: { ...DEFAULT_CONFIG.smoothing, ...c.smoothing } };
  } catch { /* storage blocked */ }
  return structuredClone(DEFAULT_CONFIG);
}
function saveConfig() { try { localStorage.setItem(CFG_KEY, JSON.stringify(engine.config)); } catch { /* ignore */ } }

const engine = new GestureEngine(loadConfig());

// ------------------------------------------------------------------ catalogue
interface Item { id: string; name: string; emoji: string; hint: string; kind: 'pose' | 'motion' | 'two-hand'; experimental?: boolean }
const cat = engine.catalog;
const ITEMS: Item[] = [
  ...cat.poses.map((p) => ({ ...p, kind: 'pose' as const })),
  ...[...cat.motions, ...cat.twoHand].filter((n) => n !== 'hold').map((n) => ({
    id: n, kind: (MOTION_INFO[n]?.hands === 2 ? 'two-hand' : 'motion') as Item['kind'],
    name: MOTION_INFO[n]?.name ?? n, emoji: MOTION_INFO[n]?.emoji ?? '✨', hint: MOTION_INFO[n]?.hint ?? '',
  })),
];
const byId = new Map(ITEMS.map((i) => [i.id, i]));

// ------------------------------------------------------------------ camera + loop
const tracker = new HandTracker(video);
let running = false;
let injected: HandInput[] | null = null;
let frame: GestureFrame = engine.update([], performance.now());
let aspect = 16 / 9;

$('b-start').onclick = async () => {
  const b = $<HTMLButtonElement>('b-start');
  b.disabled = true; b.textContent = 'Loading model…';
  try {
    await tracker.start();
    running = true;
    $('start').classList.add('hidden');
    $('st-dot').classList.add('on');
  } catch (e) {
    $('start-err').textContent = `Camera unavailable: ${(e as Error).message}`;
    b.disabled = false; b.textContent = 'Retry';
  }
};

const counts = new Map<string, number>();
const logLines: GestureEvent[] = [];
engine.on('*', (e) => {
  if (e.kind !== 'pose' || e.phase === 'start') counts.set(e.name, (counts.get(e.name) ?? 0) + (e.phase === 'end' ? 0 : 1));
  logLines.unshift(e);
  if (logLines.length > 60) logLines.pop();
  if (e.kind !== 'pose') flash(e);
  test.onEvent(e);
  liveDirty = true;
});

function tick(now: number) {
  requestAnimationFrame(tick);
  let inputs: HandInput[] | null = null;
  let t = now;
  if (injected) inputs = injected;
  else if (running) {
    const det = tracker.detect(now);
    if (det) { inputs = fromMediaPipe(det.hands, det.aspect); t = det.frameTime; aspect = det.aspect; }
  }
  if (inputs) frame = engine.update(inputs, t);
  draw();
  renderLive();
  test.tick(now);
  if (running) $('st-text').textContent = `${Math.round(tracker.fps)} fps · ${tracker.delegate ?? ''} · ${frame.hands.length} hand${frame.hands.length === 1 ? '' : 's'}`;
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ overlay
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const HAND_COL = ['#f0c54c', '#4aa8ff', '#e85a4f', '#4fc27a'];
const trails = new Map<number, { x: number; y: number; t: number }[]>();
function contentRect() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const va = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : aspect;
  let w = W, h = W / va;
  if (h > H) { h = H; w = H * va; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function draw() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const r = contentRect();
  const P = (p: { x: number; y: number }) => [r.x + p.x * r.w, r.y + p.y * r.h] as const;
  const now = frame.t;
  for (const h of frame.hands) {
    const col = HAND_COL[h.id % HAND_COL.length];
    // trail of the palm centre (motion gestures)
    const tr = trails.get(h.id) ?? [];
    tr.push({ ...h.features.center, t: now });
    while (tr.length && now - tr[0].t > 900) tr.shift();
    trails.set(h.id, tr);
    ctx.lineWidth = 3;
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = col + Math.round((i / tr.length) * 180).toString(16).padStart(2, '0');
      ctx.beginPath(); ctx.moveTo(...P(tr[i - 1])); ctx.lineTo(...P(tr[i])); ctx.stroke();
    }
    const L = h.landmarks;
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of BONES) { ctx.moveTo(...P(L[a])); ctx.lineTo(...P(L[b])); }
    ctx.stroke();
    // fingertips coloured by curl: green straight → red curled
    [4, 8, 12, 16, 20].forEach((ti, f) => {
      const c = h.features.curl[f];
      ctx.fillStyle = `hsl(${120 - c * 120} 80% 55%)`;
      ctx.beginPath(); ctx.arc(...P(L[ti]), 6, 0, Math.PI * 2); ctx.fill();
    });
    for (const p of L) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(...P(p), 2.2, 0, Math.PI * 2); ctx.fill(); }
    // label
    const it = h.pose ? byId.get(h.pose) : null;
    const label = `${h.handedness[0]} · ${it ? `${it.emoji} ${it.name} ${(h.confidence * 100).toFixed(0)}%` : '—'}`;
    const [lx, ly] = P({ x: L[0].x, y: L[0].y + 0.06 });
    ctx.font = '700 15px Inter, sans-serif';
    const tw = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.roundRect(lx - tw / 2, ly - 13, tw, 26, 8); ctx.fill();
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(label, lx, ly + 5);
    // velocity arrow
    const c = P(h.features.center);
    ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...c); ctx.lineTo(c[0] + h.velocity.x * r.w * 0.15, c[1] + h.velocity.y * r.h * 0.15); ctx.stroke();
  }
  for (const id of [...trails.keys()]) if (!frame.hands.some((h) => h.id === id)) trails.delete(id);
  if (frame.twoHand.present && frame.hands.length >= 2) {
    const [a, b] = [...frame.hands].sort((p, q) => p.features.center.x - q.features.center.x);
    ctx.setLineDash([6, 6]); ctx.strokeStyle = '#4aa8ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...P(a.features.center)); ctx.lineTo(...P(b.features.center)); ctx.stroke(); ctx.setLineDash([]);
  }
  const ro = frame.hands.map((h) => `<span>hand ${h.id} (${h.handedness}) · curl <b>${h.features.curl.map((c) => c.toFixed(2)).join(' ')}</b> · thumb out <b>${h.features.thumbOut.toFixed(2)}</b> · pinch <b>${h.pinch.toFixed(2)}</b> · facing <b>${h.features.facing.toFixed(2)}</b> · roll <b>${Math.round((h.features.roll * 180) / Math.PI)}°</b></span>`);
  if (frame.twoHand.present) ro.push(`<span>two hands · dist <b>${frame.twoHand.distance.toFixed(2)}</b> · zoom <b>${frame.twoHand.zoom.toFixed(2)}</b> · angle <b>${Math.round((frame.twoHand.angle * 180) / Math.PI)}°</b></span>`);
  const html = ro.join('') || '<span>no hands</span>';
  if (readout.innerHTML !== html) readout.innerHTML = html;
}
const readout = $('readout');

const flashEl = $('flash');
function flash(e: GestureEvent) {
  const it = byId.get(e.name);
  flashEl.textContent = `${it?.emoji ?? '✨'} ${(it?.name ?? e.name).toUpperCase()}${e.name === 'hold' && e.data?.pose ? ` · ${e.data.pose}` : ''}`;
  flashEl.style.color = e.kind === 'two-hand' ? '#4aa8ff' : '#f0c54c';
  flashEl.classList.remove('go'); void flashEl.offsetWidth; flashEl.classList.add('go');
}

// ------------------------------------------------------------------ tabs
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'results') renderResults();
  };
});

// ------------------------------------------------------------------ LIVE
let liveDirty = true;
const liveEl = $('tab-live');
liveEl.innerHTML = `
  <h3>Poses <span class="r note">bar = best score across hands</span></h3>
  <div class="poses">${ITEMS.filter((i) => i.kind === 'pose').map((i) => `
    <div class="pose" data-pose="${i.id}" title="${esc(i.hint)}"><span class="e">${i.emoji}</span><span class="n">${esc(i.name)}</span>${i.experimental ? '<span class="x">EXP</span>' : ''}<span class="v">0</span><i class="bar"></i></div>`).join('')}
  </div>
  <h3>Motions</h3>
  <div class="chips">${ITEMS.filter((i) => i.kind === 'motion').map((i) => `<span class="chip" data-m="${i.id}" title="${esc(i.hint)}">${i.emoji} ${esc(i.name)} <span class="c">0</span></span>`).join('')}</div>
  <h3>Two hands</h3>
  <div class="chips">${ITEMS.filter((i) => i.kind === 'two-hand').map((i) => `<span class="chip" data-m="${i.id}" title="${esc(i.hint)}">${i.emoji} ${esc(i.name)} <span class="c">0</span></span>`).join('')}</div>
  <h3>Event log <span class="r"><button class="ghost" id="b-clearlog">clear</button></span></h3>
  <div class="log" id="log"></div>`;
const poseEls = new Map([...liveEl.querySelectorAll<HTMLElement>('[data-pose]')].map((el) => [el.dataset.pose!, el]));
const chipEls = new Map([...liveEl.querySelectorAll<HTMLElement>('[data-m]')].map((el) => [el.dataset.m!, el]));
$('b-clearlog').onclick = () => { logLines.length = 0; counts.clear(); liveDirty = true; };
let lastLogHtml = '';
function renderLive() {
  for (const [id, el] of poseEls) {
    let s = 0, on = false;
    for (const h of frame.hands) { s = Math.max(s, h.scores[id] ?? 0); if (h.pose === id) on = true; }
    el.style.setProperty('--s', s.toFixed(3));
    el.classList.toggle('on', on);
    el.classList.toggle('hot', s >= engine.config.pose.enter);
    (el.querySelector('.v') as HTMLElement).textContent = (s * 100).toFixed(0);
  }
  if (!liveDirty) return;
  liveDirty = false;
  for (const [id, el] of chipEls) (el.querySelector('.c') as HTMLElement).textContent = String(counts.get(id) ?? 0);
  const t0 = performance.now();
  const html = logLines.slice(0, 40).map((e) => {
    const it = byId.get(e.name);
    const extra = e.data ? Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    return `<div class="k-${e.kind}">${((e.t - t0) / 1000).toFixed(1)}s · ${e.hand !== undefined ? `h${e.hand} ` : ''}<b>${it?.emoji ?? ''} ${e.name}</b>${e.phase ? ' ' + e.phase : ''} ${extra}</div>`;
  }).join('');
  if (html !== lastLogHtml) { $('log').innerHTML = html; lastLogHtml = html; }
}
engine.on('motion', (e) => { const el = chipEls.get(e.name); if (el) { el.classList.add('fire'); setTimeout(() => el.classList.remove('fire'), 450); } });
engine.on('two-hand', (e) => { const el = chipEls.get(e.name); if (el) { el.classList.add('fire'); setTimeout(() => el.classList.remove('fire'), 450); } });

// ------------------------------------------------------------------ TEST
interface Trial { session: string; at: number; gesture: string; kind: Item['kind']; hit: boolean; ms: number | null; confusions: string[]; rating: number | null }
function loadTrials(): Trial[] { try { return JSON.parse(localStorage.getItem(TRIALS_KEY) || '[]'); } catch { return []; } }
function saveTrials(t: Trial[]) { try { localStorage.setItem(TRIALS_KEY, JSON.stringify(t)); } catch { /* ignore */ } }

const READY_MS = 900;
const POSE_HOLD_MS = 250;
const RATE_MS = 6000;
/** Poses people pass through on the way to almost anything: not counted as confusions. */
const NEUTRAL = new Set(['open', 'back', 'claw']);

const test = new (class TestRunner {
  queue: Item[] = [];
  i = 0;
  phase: 'idle' | 'ready' | 'go' | 'rate' = 'idle';
  phaseAt = 0;
  timeoutMs = 7000;
  session = '';
  cur: Trial | null = null;
  done: Trial[] = [];

  start(ids: string[], reps: number, timeoutS: number) {
    const list = ids.map((id) => byId.get(id)!).filter(Boolean);
    if (!list.length) return;
    this.queue = [];
    for (let r = 0; r < reps; r++) this.queue.push(...shuffle([...list]));
    // avoid the same gesture twice in a row
    for (let k = 1; k < this.queue.length; k++) if (this.queue[k].id === this.queue[k - 1].id) {
      const j = this.queue.findIndex((x, n) => n > k && x.id !== this.queue[k].id);
      if (j > 0) [this.queue[k], this.queue[j]] = [this.queue[j], this.queue[k]];
    }
    this.i = 0;
    this.timeoutMs = timeoutS * 1000;
    this.session = new Date().toISOString();
    this.done = [];
    this.next();
  }

  stop() {
    this.phase = 'idle';
    $('prompt').classList.add('hidden');
    renderTestSetup();
  }

  next() {
    if (this.i >= this.queue.length) { this.finish(); return; }
    const it = this.queue[this.i];
    this.cur = { session: this.session, at: Date.now(), gesture: it.id, kind: it.kind, hit: false, ms: null, confusions: [], rating: null };
    this.phase = 'ready';
    this.phaseAt = performance.now();
    this.renderPrompt();
    renderTestRun();
  }

  get item() { return this.queue[this.i]; }

  tick(now: number) {
    if (this.phase === 'idle' || !this.cur) return;
    const el = $('prompt');
    if (this.phase === 'ready' && now - this.phaseAt >= READY_MS) { this.phase = 'go'; this.phaseAt = now; this.renderPrompt(); }
    if (this.phase === 'go') {
      const it = this.item;
      if (it.kind === 'pose' && frame.hands.some((h) => h.pose === it.id && h.heldMs >= POSE_HOLD_MS)) this.resolve(true, now - this.phaseAt);
      else if (now - this.phaseAt >= this.timeoutMs) this.resolve(false, null);
      else el.style.setProperty('--p', String(1 - (now - this.phaseAt) / this.timeoutMs));
      const ring = el.querySelector('.ring i');
      if (ring && this.phase === 'go') ring.textContent = String(Math.ceil((this.timeoutMs - (now - this.phaseAt)) / 1000));
    }
    if (this.phase === 'rate') {
      // quick hand rating: thumbs up = 5, thumbs down = 1
      for (const h of frame.hands) {
        if (now - this.phaseAt < 700) break;
        if (h.pose === 'thumbs-up' && h.heldMs > 400) { this.rate(5); return; }
        if (h.pose === 'thumbs-down' && h.heldMs > 400) { this.rate(1); return; }
      }
      if (now - this.phaseAt >= RATE_MS) this.rate(null);
    }
  }

  onEvent(e: GestureEvent) {
    if (this.phase !== 'go' || !this.cur) return;
    const it = this.item;
    if (it.kind !== 'pose' && e.name === it.id) { this.resolve(true, performance.now() - this.phaseAt); return; }
    // confusions: something else of the same kind fired
    const same = it.kind === 'pose' ? e.kind === 'pose' && e.phase === 'start' : e.kind !== 'pose';
    if (same && e.name !== it.id && !NEUTRAL.has(e.name) && e.name !== 'hold') this.cur.confusions.push(e.name);
  }

  resolve(hit: boolean, ms: number | null) {
    if (!this.cur) return;
    this.cur.hit = hit;
    this.cur.ms = ms === null ? null : Math.round(ms);
    this.phase = 'rate';
    this.phaseAt = performance.now();
    this.renderPrompt();
  }

  rate(r: number | null) {
    if (this.phase !== 'rate' || !this.cur) return;
    this.cur.rating = r;
    this.done.push(this.cur);
    saveTrials([...loadTrials(), this.cur]);
    this.cur = null;
    this.i++;
    this.next();
  }

  finish() {
    this.phase = 'idle';
    $('prompt').classList.add('hidden');
    renderTestSetup(true);
    document.querySelector<HTMLButtonElement>('.tabs [data-tab=results]')?.click();
  }

  renderPrompt() {
    const el = $('prompt');
    const it = this.item;
    const c = this.cur!;
    el.classList.remove('hidden', 'hit', 'miss');
    const pos = `${this.i + 1} / ${this.queue.length}`;
    if (this.phase === 'ready') {
      el.innerHTML = `<div class="em">${it.emoji}</div><div class="tx"><b>Get ready: ${esc(it.name)}</b><span>${esc(it.hint)}</span><div class="meta">${pos}${it.kind === 'two-hand' ? ' · two hands' : ''}</div></div>`;
    } else if (this.phase === 'go') {
      el.innerHTML = `<div class="em">${it.emoji}</div><div class="tx"><b>${esc(it.name)}</b><span>${esc(it.hint)}</span><div class="meta">${pos} · GO</div></div><div class="ring"><i></i></div>`;
    } else {
      el.classList.add(c.hit ? 'hit' : 'miss');
      el.innerHTML = `<div class="em">${c.hit ? '✅' : '❌'}</div><div class="tx"><b>${c.hit ? `Detected in ${(c.ms! / 1000).toFixed(2)} s` : 'Not detected'}</b>
        <span>How natural did ${esc(it.name)} feel? Keys 1–5, or 👍 / 👎. Space skips.</span>${c.confusions.length ? `<div class="meta">also fired: ${c.confusions.map(esc).join(', ')}</div>` : ''}
        <div class="rate">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}">${n}</button>`).join('')}<button data-r="0">skip</button></div></div>`;
      el.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((b) => { b.onclick = () => this.rate(Number(b.dataset.r) || null); });
    }
  }
})();

window.addEventListener('keydown', (e) => {
  if (test.phase === 'rate') {
    if (e.key >= '1' && e.key <= '5') test.rate(Number(e.key));
    else if (e.key === ' ') { e.preventDefault(); test.rate(null); }
  }
  if (e.key === 'Escape' && test.phase !== 'idle') test.stop();
});

function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

const testEl = $('tab-test');
const PICK_KEY = 'gesturelab.pick.v1';
function renderTestSetup(justFinished = false) {
  let picked: string[];
  try { picked = JSON.parse(localStorage.getItem(PICK_KEY) || 'null') ?? ITEMS.filter((i) => !i.experimental).map((i) => i.id); } catch { picked = ITEMS.map((i) => i.id); }
  const group = (kind: Item['kind'], title: string) => `
    <h3>${title} <span class="r"><button class="ghost" data-all="${kind}">all</button> <button class="ghost" data-none="${kind}">none</button></span></h3>
    <div class="pick">${ITEMS.filter((i) => i.kind === kind).map((i) => `<label title="${esc(i.hint)}"><input type="checkbox" value="${i.id}" ${picked.includes(i.id) ? 'checked' : ''}/> ${i.emoji} ${esc(i.name)}</label>`).join('')}</div>`;
  testEl.innerHTML = `
    ${justFinished ? '<p class="note">✅ Run finished. Results are on the Results tab.</p>' : ''}
    <p class="note">The lab prompts each gesture in random order. Do it naturally, the way you'd want it to work in a game.
    It records whether and how fast the engine caught it, what else fired, and how natural it felt to you.</p>
    <div class="row"><label>Reps each</label><input type="number" id="t-reps" min="1" max="10" value="2" style="width:56px"/>
      <label>Time limit (s)</label><input type="number" id="t-timeout" min="2" max="20" value="7" style="width:56px"/>
      <button class="primary" id="b-run">Start test</button></div>
    <p class="note" id="t-count"></p>
    ${group('pose', 'Poses')}${group('motion', 'Motions')}${group('two-hand', 'Two hands')}`;
  const boxes = () => [...testEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const sync = () => {
    const ids = boxes().filter((b) => b.checked).map((b) => b.value);
    try { localStorage.setItem(PICK_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
    const reps = Number(($('t-reps') as HTMLInputElement).value) || 1;
    $('t-count').textContent = `${ids.length} gestures × ${reps} = ${ids.length * reps} prompts (~${Math.ceil((ids.length * reps * 9) / 60)} min)`;
  };
  boxes().forEach((b) => (b.onchange = sync));
  ($('t-reps') as HTMLInputElement).oninput = sync;
  testEl.querySelectorAll<HTMLButtonElement>('[data-all],[data-none]').forEach((b) => {
    b.onclick = () => { const k = b.dataset.all ?? b.dataset.none; boxes().forEach((x) => { if (byId.get(x.value)?.kind === k) x.checked = !!b.dataset.all; }); sync(); };
  });
  $('b-run').onclick = () => {
    if (!running && !injected) { document.querySelector<HTMLButtonElement>('#b-start')?.click(); }
    test.start(boxes().filter((b) => b.checked).map((b) => b.value), Number(($('t-reps') as HTMLInputElement).value) || 1, Number(($('t-timeout') as HTMLInputElement).value) || 7);
  };
  sync();
}
function renderTestRun() {
  const n = test.queue.length, k = test.i;
  const hits = test.done.filter((t) => t.hit).length;
  testEl.innerHTML = `
    <h3>Running <span class="r"><button class="ghost" id="b-stop">stop (Esc)</button></span></h3>
    <div class="progress"><i style="width:${(k / n) * 100}%"></i></div>
    <p class="note">${k} / ${n} done · ${hits} detected so far</p>
    <div class="log">${test.done.slice().reverse().map((t) => `<div>${t.hit ? '✅' : '❌'} <b>${byId.get(t.gesture)?.emoji} ${t.gesture}</b> ${t.ms !== null ? (t.ms / 1000).toFixed(2) + 's' : ''} ${t.rating ? '★' + t.rating : ''} ${t.confusions.length ? '· also ' + t.confusions.join(',') : ''}</div>`).join('')}</div>`;
  $('b-stop').onclick = () => test.stop();
}
renderTestSetup();

// ------------------------------------------------------------------ RESULTS
interface Agg { item: Item; n: number; hits: number; times: number[]; ratings: number[]; conf: Map<string, number> }
function aggregate(trials: Trial[]) {
  const m = new Map<string, Agg>();
  for (const t of trials) {
    const item = byId.get(t.gesture);
    if (!item) continue;
    let a = m.get(t.gesture);
    if (!a) m.set(t.gesture, (a = { item, n: 0, hits: 0, times: [], ratings: [], conf: new Map() }));
    a.n++;
    if (t.hit) { a.hits++; if (t.ms !== null) a.times.push(t.ms); }
    if (t.rating) a.ratings.push(t.rating);
    for (const c of t.confusions) a.conf.set(c, (a.conf.get(c) ?? 0) + 1);
  }
  return [...m.values()];
}
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function verdict(a: Agg) {
  const rate = a.hits / a.n, t = median(a.times), r = mean(a.ratings);
  const detect = a.n < 2 ? ['none', 'few tries'] : rate >= 0.9 && t < 1500 ? ['good', 'RELIABLE'] : rate >= 0.7 ? ['ok', 'OK'] : ['bad', 'UNRELIABLE'];
  const feel = Number.isNaN(r) ? ['none', 'unrated'] : r >= 4 ? ['good', 'INTUITIVE'] : r >= 2.75 ? ['ok', 'FINE'] : ['bad', 'AWKWARD'];
  // overall: detection matters most, then feel, then speed
  const score = rate * 70 + (Number.isNaN(r) ? 15 : ((r - 1) / 4) * 20) + (Number.isNaN(t) ? 0 : Math.max(0, 1 - t / 4000) * 10);
  return { detect, feel, score };
}
const resEl = $('tab-results');
function renderResults() {
  const trials = loadTrials();
  const rows = aggregate(trials).map((a) => ({ a, v: verdict(a) })).sort((x, y) => y.v.score - x.v.score);
  const sessions = new Set(trials.map((t) => t.session)).size;
  resEl.innerHTML = `
    <h3>Results <span class="r note">${trials.length} prompts · ${sessions} run${sessions === 1 ? '' : 's'}</span></h3>
    ${rows.length ? `<table>
      <thead><tr><th>Gesture</th><th>Hit</th><th>Median</th><th>Feel</th><th>Verdict</th></tr></thead>
      <tbody>${rows.map(({ a, v }) => {
        const top = [...a.conf.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, n]) => `${byId.get(k)?.emoji ?? ''}${k}×${n}`).join(' ');
        const t = median(a.times), r = mean(a.ratings);
        return `<tr><td>${a.item.emoji} <b>${esc(a.item.name)}</b>${top ? `<div class="conf">confused with ${esc(top)}</div>` : ''}</td>
          <td class="num">${Math.round((a.hits / a.n) * 100)}%<div class="conf">${a.hits}/${a.n}</div></td>
          <td class="num">${Number.isNaN(t) ? '–' : (t / 1000).toFixed(2) + 's'}</td>
          <td class="num">${Number.isNaN(r) ? '–' : '★' + r.toFixed(1)}</td>
          <td><span class="badge ${v.detect[0]}">${v.detect[1]}</span><br/><span class="badge ${v.feel[0]}">${v.feel[1]}</span></td></tr>`;
      }).join('')}</tbody></table>` : '<p class="note">No test runs yet. Start one on the Test tab.</p>'}
    <div class="row"><button class="ghost" id="b-json">Export JSON</button><button class="ghost" id="b-csv">Export CSV</button><button class="ghost" id="b-clear">Clear results</button></div>
    <p class="note">Ranked by detection (70%), how natural it felt (20%) and speed (10%). "Confused with" lists other gestures that fired while you were making this one.</p>`;
  $('b-json').onclick = () => download('gesture-results.json', JSON.stringify({ config: engine.config, trials }, null, 2), 'application/json');
  $('b-csv').onclick = () => download('gesture-results.csv', ['session,at,gesture,kind,hit,ms,rating,confusions', ...trials.map((t) => [t.session, new Date(t.at).toISOString(), t.gesture, t.kind, t.hit, t.ms ?? '', t.rating ?? '', t.confusions.join(' ')].join(','))].join('\n'), 'text/csv');
  $('b-clear').onclick = () => { if (confirm('Delete all stored test results?')) { saveTrials([]); renderResults(); } };
}
function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ TUNE
type Num = { group: 'pose' | 'motion' | 'smoothing'; key: string; label: string; min: number; max: number; step: number };
const SLIDERS: Num[] = [
  { group: 'pose', key: 'enter', label: 'Pose enter score', min: 0.3, max: 0.95, step: 0.01 },
  { group: 'pose', key: 'exit', label: 'Pose exit score', min: 0.1, max: 0.9, step: 0.01 },
  { group: 'pose', key: 'margin', label: 'Switch margin', min: 0, max: 0.4, step: 0.01 },
  { group: 'pose', key: 'debounceMs', label: 'Pose debounce (ms)', min: 0, max: 300, step: 5 },
  { group: 'smoothing', key: 'minCutoff', label: 'Smoothing min cutoff (Hz)', min: 0.3, max: 8, step: 0.1 },
  { group: 'smoothing', key: 'beta', label: 'Smoothing speed response', min: 0, max: 30, step: 0.5 },
  { group: 'motion', key: 'swipeDist', label: 'Swipe distance', min: 0.05, max: 0.5, step: 0.01 },
  { group: 'motion', key: 'swipeMs', label: 'Swipe window (ms)', min: 120, max: 800, step: 10 },
  { group: 'motion', key: 'swipeAxis', label: 'Swipe axis dominance', min: 1, max: 4, step: 0.1 },
  { group: 'motion', key: 'pushRatio', label: 'Push / pull size ratio', min: 1.05, max: 2, step: 0.01 },
  { group: 'motion', key: 'pushMs', label: 'Push window (ms)', min: 150, max: 900, step: 10 },
  { group: 'motion', key: 'pushDrift', label: 'Push max drift', min: 0.02, max: 0.3, step: 0.01 },
  { group: 'motion', key: 'circleTurns', label: 'Circle: turns needed', min: 0.4, max: 1.5, step: 0.05 },
  { group: 'motion', key: 'circleRadius', label: 'Circle: min radius', min: 0.01, max: 0.15, step: 0.005 },
  { group: 'motion', key: 'circleMs', label: 'Circle window (ms)', min: 500, max: 3000, step: 50 },
  { group: 'motion', key: 'waveReversals', label: 'Wave/shake reversals', min: 1, max: 6, step: 1 },
  { group: 'motion', key: 'waveAmp', label: 'Wave/shake amplitude', min: 0.01, max: 0.15, step: 0.005 },
  { group: 'motion', key: 'waveMs', label: 'Wave window (ms)', min: 400, max: 2500, step: 50 },
  { group: 'motion', key: 'twistDeg', label: 'Twist angle (°)', min: 15, max: 120, step: 1 },
  { group: 'motion', key: 'twistMs', label: 'Twist window (ms)', min: 150, max: 1200, step: 10 },
  { group: 'motion', key: 'tapMs', label: 'Tap max duration (ms)', min: 100, max: 800, step: 10 },
  { group: 'motion', key: 'doubleTapMs', label: 'Double-tap gap (ms)', min: 200, max: 1000, step: 10 },
  { group: 'motion', key: 'throwSpeed', label: 'Throw speed', min: 0.3, max: 3, step: 0.05 },
  { group: 'motion', key: 'holdMs', label: 'Hold time (ms)', min: 200, max: 2500, step: 50 },
  { group: 'motion', key: 'clapSpeed', label: 'Clap closing speed', min: 0.2, max: 3, step: 0.05 },
  { group: 'motion', key: 'clapDist', label: 'Clap distance', min: 0.05, max: 0.4, step: 0.01 },
  { group: 'motion', key: 'zoomIn', label: 'Zoom-in ratio', min: 1.1, max: 2.5, step: 0.05 },
  { group: 'motion', key: 'zoomOut', label: 'Zoom-out ratio', min: 0.3, max: 0.95, step: 0.05 },
  { group: 'motion', key: 'steerDeg', label: 'Steer angle (°)', min: 10, max: 90, step: 1 },
  { group: 'motion', key: 'cooldownMs', label: 'Motion cooldown (ms)', min: 0, max: 2000, step: 50 },
];
const tuneEl = $('tab-tune');
function renderTune() {
  const cfg = engine.config as unknown as Record<string, Record<string, number | boolean>>;
  const sl = (s: Num) => `<label class="slider"><span>${s.label}</span><input type="range" data-g="${s.group}" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${cfg[s.group][s.key]}"/><output>${cfg[s.group][s.key]}</output></label>`;
  tuneEl.innerHTML = `
    <p class="note">Changes apply live and are remembered on this device. Export the JSON to use the same settings in a game: <code>new GestureEngine(config)</code>.</p>
    <div class="row"><label><input type="checkbox" id="t-exp" ${engine.config.pose.experimental ? 'checked' : ''}/> include experimental poses</label></div>
    <h3>Poses</h3>${SLIDERS.filter((s) => s.group === 'pose').map(sl).join('')}
    <h3>Smoothing</h3>${SLIDERS.filter((s) => s.group === 'smoothing').map(sl).join('')}
    <h3>Motions</h3>${SLIDERS.filter((s) => s.group === 'motion').map(sl).join('')}
    <div class="row"><button class="ghost" id="b-export">Export config JSON</button><button class="ghost" id="b-reset">Reset to defaults</button></div>`;
  tuneEl.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((inp) => {
    inp.oninput = () => {
      cfg[inp.dataset.g!][inp.dataset.k!] = Number(inp.value);
      (inp.nextElementSibling as HTMLOutputElement).value = inp.value;
      if (inp.dataset.g === 'smoothing') engine.reset();
      saveConfig();
    };
  });
  ($('t-exp') as HTMLInputElement).onchange = (e) => { engine.config.pose.experimental = (e.target as HTMLInputElement).checked; saveConfig(); };
  $('b-export').onclick = () => download('gesture-config.json', JSON.stringify(engine.config, null, 2), 'application/json');
  $('b-reset').onclick = () => { engine.config = structuredClone(DEFAULT_CONFIG); engine.reset(); saveConfig(); renderTune(); };
}
renderTune();

// ------------------------------------------------------------------ test hooks (headless)
declare global { interface Window { __lab: unknown } }
window.__lab = {
  engine,
  get frame() { return frame; },
  get test() { return test; },
  inject(h: HandInput[] | null) { injected = h; },
  /** Synthetic hand for automated tests: curl per finger (thumb…pinky), pinch 0..1. */
  fake(x: number, y: number, pose: HandPose, o: { hd?: 'Left' | 'Right'; scale?: number } = {}): HandInput {
    return { landmarks: screenHandLandmarks(x, y, pose, { handedness: o.hd ?? 'Right', scale: o.scale ?? 0.2 }), handedness: o.hd ?? 'Right', aspect: 16 / 9 };
  },
  results: () => aggregate(loadTrials()).map((a) => ({ id: a.item.id, n: a.n, hits: a.hits })),
};
