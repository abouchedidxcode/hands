/**
 * InputManager — the single entry point the game uses for hand input.
 *
 * Sources, in priority order:
 *   1. synthetic frames from inject() (tests / window.__godhand)
 *   2. camera (MediaPipe), once startCamera() succeeded
 *   3. mouse fallback (always if the camera is unavailable; while the camera
 *      runs only after 3 s without any hand AND a mouse move since then)
 *
 * Edge flags (grabStart / grabEnd) are derived here from consecutive
 * *outputs*, so they are true for exactly one update() call regardless of the
 * source, of source switches, or of hands disappearing mid-grab.
 */
import type { Gesture, HandState, InputFrame } from './types';
import { emptyHand } from './types';
import {
  assignSlots, DEFAULT_GESTURE, DEFAULT_MAPPING, HandProcessor, LM, rawCursor,
  type GestureConfig, type MappingConfig, type RawHand,
} from './gestures';
import { HandTracker } from './handTracker';
import { MouseInput } from './mouseInput';
import { POSES, screenHandLandmarks, type HandPose } from './fakeHand';

export type InputStatus = 'idle' | 'loading' | 'running' | 'denied' | 'error';

export interface InputManagerOptions {
  video: HTMLVideoElement;
  mapping?: Partial<MappingConfig>;
  gesture?: Partial<GestureConfig>;
  /**
   * Time constant (ms) of the per-render-frame interpolation of camera hands.
   * Detection runs at camera rate (~30 Hz); this upsamples smoothly to the
   * display rate at the cost of ~this much extra latency. 0 disables.
   */
  renderSmoothingMs?: number;
}

/** No hand for this long (and a mouse move) → mouse takes over while the camera runs. */
export const MOUSE_TAKEOVER_MS = 3000;
const SYNTHETIC_PALM = 0.14;

type Slot = 0 | 1;
type EdgeGiven = { start: boolean; end: boolean };
const NO_EDGES: EdgeGiven = { start: false, end: false };
const SLOTS: readonly Slot[] = [0, 1];

function poseFor(g: Gesture): HandPose {
  switch (g) {
    case 'grab': return POSES.fist;
    case 'middle': return POSES.middle;
    case 'open': return POSES.open;
    case 'point': return POSES.point;
    default: return POSES.relaxed;
  }
}

function isDenied(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
}

export class InputManager {
  private _status: InputStatus = 'idle';
  /** Camera pipeline state. */
  get status(): InputStatus { return this._status; }
  /** Last camera / model error message (for the UI). */
  error: string | null = null;

  private readonly _video: HTMLVideoElement;
  private tracker: HandTracker | null = null;
  private startPromise: Promise<boolean> | null = null;
  private readonly processors: [HandProcessor, HandProcessor];
  private mouse: MouseInput | null = null;
  private injected: Partial<HandState>[] | null = null;
  private injectFresh = false;
  private prevOut: [HandState, HandState] = [emptyHand(0), emptyHand(1)];
  /** Per-slot displayed (interpolated) camera cursor. */
  private display: [{ x: number; y: number } | null, { x: number; y: number } | null] = [null, null];
  private lastHandSeen = -Infinity;
  /** ingestDetections() was called without a tracker: treat it as the camera. */
  private externalFeed = false;
  /** Which edge flags the current injected frame set explicitly (per slot). */
  private edgeGiven: [EdgeGiven, EdgeGiven] = [NO_EDGES, NO_EDGES];
  private lastUpdate = NaN;
  private readonly renderTau: number;
  readonly mapping: MappingConfig;
  readonly gestureConfig: GestureConfig;

  constructor(opts: InputManagerOptions) {
    this._video = opts.video;
    this.mapping = { ...DEFAULT_MAPPING, ...opts.mapping };
    this.gestureConfig = { ...DEFAULT_GESTURE, ...opts.gesture };
    this.renderTau = opts.renderSmoothingMs ?? 12;
    this.processors = [
      new HandProcessor(this.gestureConfig, this.mapping),
      new HandProcessor(this.gestureConfig, this.mapping),
    ];
  }

  get video(): HTMLVideoElement { return this._video; }

  /** Delegate actually in use ('GPU' | 'CPU'), null before the camera starts. */
  get delegate(): 'GPU' | 'CPU' | null { return this.tracker?.delegate ?? null; }

  /**
   * Opens the webcam and loads the model. Resolves false if denied /
   * unavailable, in which case the mouse fallback is enabled automatically.
   */
  startCamera(): Promise<boolean> {
    if (this.status === 'running') return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    this._status = 'loading';
    this.error = null;
    const tracker = new HandTracker(this._video);
    this.startPromise = tracker.start().then(
      () => {
        this.tracker = tracker;
        this._status = 'running';
        this.lastHandSeen = performance.now();
        tracker.onEnded = () => {
          this._status = 'error';
          this.error = 'Camera stream ended';
          this.tracker?.stop();
          this.tracker = null;
          this.resetCamera();
          this.ensureMouse();
        };
        return true;
      },
      (err: unknown) => {
        this._status = isDenied(err) ? 'denied' : 'error';
        this.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.warn('[input] camera unavailable, using mouse fallback:', err);
        this.ensureMouse();
        return false;
      },
    ).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  /** Enables the mouse fallback on `el` (coordinates are relative to it). */
  enableMouse(el: HTMLElement): void {
    if (this.mouse?.el === el) return;
    this.mouse?.dispose();
    this.mouse = new MouseInput(el);
  }

  private ensureMouse(): void {
    if (!this.mouse && typeof document !== 'undefined') this.enableMouse(document.documentElement);
  }

  /**
   * Synthetic hands. Non-null frames override every other source until
   * inject(null). Entries are merged onto defaults (present: true unless
   * given). Slots: an explicit `slot` wins; otherwise hands that appear take
   * slots in array order, and hands already present keep their slot by
   * nearest-position matching (like camera hands), so order may change freely.
   * Missing landmarks are generated from the gesture; missing vx/vy are
   * derived from consecutive positions.
   * grabStart/grabEnd are derived from consecutive pinch values unless given
   * (given values apply to the first update() after this call only).
   */
  inject(frames: Partial<HandState>[] | null): void {
    this.injected = frames ? frames.slice(0, 2) : null;
    this.injectFresh = !!frames;
  }

  /** Stop the camera and listeners. */
  dispose(): void {
    this.tracker?.stop();
    this.tracker = null;
    this.mouse?.dispose();
    this.mouse = null;
    if (this.status === 'running') this._status = 'idle';
  }

  /** Call once per animation frame. */
  update(now: number): InputFrame {
    const dtMs = Number.isFinite(this.lastUpdate) ? Math.max(0, now - this.lastUpdate) : 0;
    this.lastUpdate = now;

    if (this.injected) {
      const hands = this.buildInjected(now, dtMs);
      return this.finalize(hands, 'synthetic', 0);
    }

    // --- camera -------------------------------------------------------------
    let camHands: [HandState, HandState] | null = null;
    if ((this.tracker && this.status === 'running') || this.externalFeed) {
      const det = this.tracker?.detect(now) ?? null;
      if (det) this.ingestDetections(det.hands, now, det.frameTime, det.aspect);
      else for (const p of this.processors) if (p.present && now - p.lastSeen > this.gestureConfig.graceMs) p.miss(now);
      camHands = this.cameraHands(now, dtMs);
      if (camHands[0].present || camHands[1].present) this.lastHandSeen = now;
    }
    const fps = this.tracker?.fps ?? 0;

    // --- source arbitration --------------------------------------------------
    if (camHands) {
      const handGone = now - this.lastHandSeen >= MOUSE_TAKEOVER_MS;
      if (this.mouse && handGone && this.mouse.lastMove > this.lastHandSeen) {
        return this.finalize([this.mouse.sample(now), emptyHand(1)], 'mouse', fps);
      }
      return this.finalize(camHands, 'camera', fps);
    }
    if (this.mouse) return this.finalize([this.mouse.sample(now), emptyHand(1)], 'mouse', 0);
    const src = this.status === 'loading' ? 'camera' : 'mouse';
    return this.finalize([emptyHand(0), emptyHand(1)], src, 0);
  }

  /**
   * Feeds one frame of raw detections (normally from MediaPipe). Public so
   * tests and alternative trackers can drive the camera pipeline directly.
   */
  ingestDetections(raw: RawHand[], nowMs: number, frameMs: number = nowMs, aspect = 16 / 9): void {
    if (!this.tracker) this.externalFeed = true;
    const dets = this.dedupe(raw.filter((h) => h.landmarks.length >= 21)).slice(0, 2);
    const cursors = dets.map((h) => rawCursor(h.landmarks, this.mapping));
    const slots = assignSlots(
      [this.slotPos(0), this.slotPos(1)],
      cursors,
    );
    const hit = [false, false];
    dets.forEach((h, i) => {
      const s = slots[i];
      hit[s] = true;
      this.processors[s].update(h, nowMs, frameMs, aspect);
    });
    for (const s of SLOTS) if (!hit[s]) this.processors[s].miss(nowMs);
  }

  private slotPos(s: Slot): { x: number; y: number } | null {
    const p = this.processors[s];
    return p.present ? { x: p.ux, y: p.uy } : null;
  }

  /**
   * MediaPipe occasionally reports the same hand twice. Two detections whose
   * wrists AND index MCPs nearly coincide (relative to hand size) are one hand.
   */
  private dedupe(hands: RawHand[]): RawHand[] {
    if (hands.length < 2) return hands;
    const [a, b] = hands;
    const d = (i: number) => Math.hypot(a.landmarks[i].x - b.landmarks[i].x, a.landmarks[i].y - b.landmarks[i].y);
    const size = Math.hypot(a.landmarks[LM.WRIST].x - a.landmarks[LM.MIDDLE_MCP].x, a.landmarks[LM.WRIST].y - a.landmarks[LM.MIDDLE_MCP].y);
    if (d(LM.WRIST) < size * 0.35 && d(LM.INDEX_MCP) < size * 0.35) return [a.score >= b.score ? a : b, ...hands.slice(2)];
    return hands;
  }

  /** Processor snapshots + render-rate interpolation. */
  private cameraHands(now: number, dtMs: number): [HandState, HandState] {
    const out = SLOTS.map((s) => {
      const snap = this.processors[s].snapshot();
      const h: HandState = { ...snap, slot: s, grabStart: false, grabEnd: false };
      if (!h.present) { this.display[s] = null; return h; }
      const d = this.display[s];
      if (!d || this.renderTau <= 0) {
        this.display[s] = { x: h.x, y: h.y };
        return h;
      }
      const k = 1 - Math.exp(-dtMs / this.renderTau);
      d.x += k * (h.x - d.x);
      d.y += k * (h.y - d.y);
      const ox = d.x - h.x, oy = d.y - h.y;
      if (ox !== 0 || oy !== 0) {
        h.x = d.x; h.y = d.y;
        h.landmarks = h.landmarks.map((p) => ({ x: p.x + ox, y: p.y + oy, z: p.z }));
      }
      return h;
    });
    return [out[0], out[1]];
  }

  private buildInjected(now: number, dtMs: number): [HandState, HandState] {
    const frames = this.injected!;
    const result: [HandState, HandState] = [emptyHand(0), emptyHand(1)];

    // Slots: explicit first, then position matching for the rest.
    const slotOf: (Slot | -1)[] = frames.map((f) => (f.slot === 0 || f.slot === 1 ? f.slot : -1));
    const taken = new Set(slotOf.filter((s) => s !== -1));
    const free = frames.map((_, i) => i).filter((i) => slotOf[i] === -1);
    if (free.length) {
      const prevPos = SLOTS.map((s) => (this.prevOut[s].present && !taken.has(s) ? { x: this.prevOut[s].x, y: this.prevOut[s].y } : null)) as
        [{ x: number; y: number } | null, { x: number; y: number } | null];
      // If one slot is explicitly taken, only the other is available.
      if (taken.size === 1) {
        const other: Slot = taken.has(0) ? 1 : 0;
        slotOf[free[0]] = other;
      } else if (taken.size === 0 && !prevPos[0] && !prevPos[1]) {
        // Nothing to match against: array order.
        free.forEach((i, k) => { slotOf[i] = k as Slot; });
      } else if (taken.size === 0) {
        const pos = free.map((i) => ({ x: frames[i].x ?? 0.5, y: frames[i].y ?? 0.5 }));
        const assigned = assignSlots(prevPos, pos, Infinity);
        free.forEach((i, k) => { slotOf[i] = assigned[k]; });
      }
    }

    frames.forEach((f, i) => {
      const s = slotOf[i];
      if (s === -1 || result[s].present) return;
      const prev = this.prevOut[s];
      const h: HandState = { ...emptyHand(s), present: true, palmSize: SYNTHETIC_PALM, lastSeen: now, ...f, slot: s };
      if (!h.present) { result[s] = { ...emptyHand(s), slot: s }; return; }
      if (f.handedness === undefined) h.handedness = prev.present ? prev.handedness : s === 0 ? 'Right' : 'Left';
      // Gesture ⇄ booleans.
      if (f.gesture === undefined) h.gesture = h.grab ? 'grab' : h.middle ? 'middle' : h.open ? 'open' : 'none';
      else {
        if (f.grab === undefined) h.grab = f.gesture === 'grab';
        if (f.middle === undefined) h.middle = f.gesture === 'middle';
        if (f.open === undefined) h.open = f.gesture === 'open';
      }
      if (f.grabStrength === undefined) h.grabStrength = h.grab ? 1 : 0;
      // Velocity from consecutive positions if not given.
      const dt = Math.min(Math.max(dtMs / 1000, 1 / 240), 0.1);
      const moved = prev.present && dtMs > 0;
      if (f.vx === undefined) h.vx = moved ? (h.x - prev.x) / dt : 0;
      if (f.vy === undefined) h.vy = moved ? (h.y - prev.y) / dt : 0;
      if (f.landmarks === undefined) {
        h.landmarks = screenHandLandmarks(h.x, h.y, poseFor(h.gesture), { handedness: h.handedness, scale: h.palmSize || SYNTHETIC_PALM });
      }
      // Edge flags: explicit values only count on the first update after inject().
      const fresh = this.injectFresh;
      this.edgeGiven[s] = { start: fresh && f.grabStart !== undefined, end: fresh && f.grabEnd !== undefined };
      h.grabStart = fresh && f.grabStart !== undefined ? f.grabStart : false;
      h.grabEnd = fresh && f.grabEnd !== undefined ? f.grabEnd : false;
      result[s] = h;
    });
    return result;
  }

  /** Computes edge flags against the previous output and stores this output. */
  private finalize(hands: [HandState, HandState], source: InputFrame['source'], trackingFps: number): InputFrame {
    for (const s of SLOTS) {
      let h = hands[s];
      const prev = this.prevOut[s];
      const given = source === 'synthetic' ? this.edgeGiven[s] : NO_EDGES;
      if (!h.present && prev.present && prev.grab) {
        // Hand vanished mid-grab: emit one last present frame carrying the
        // release so consumers that skip absent hands still see grabEnd.
        h = {
          ...prev, grab: false, grabStart: false, grabEnd: true, grabStrength: 0,
          gesture: 'none', middle: false, open: false, vx: 0, vy: 0,
        };
      } else {
        if (!given.start) h.grabStart = h.grab && !(prev.present && prev.grab);
        if (!given.end) h.grabEnd = !h.grab && prev.present && prev.grab;
        if (!h.present) { h.grab = false; h.grabStart = false; }
      }
      hands[s] = h;
      this.prevOut[s] = h;
    }
    this.injectFresh = false;
    this.edgeGiven = [NO_EDGES, NO_EDGES];
    return { hands, source, trackingFps };
  }

  /** Drop all camera hand state (e.g. camera lost). */
  private resetCamera(): void {
    for (const p of this.processors) p.reset();
    this.display = [null, null];
  }
}
