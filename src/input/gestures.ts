/**
 * Hand landmark → game-input mapping. No DOM access: everything here is a
 * deterministic function of the landmarks and the timestamps passed in, so it
 * can be unit-tested with synthetic hands.
 *
 * Spaces used below:
 *  - *raw*:    MediaPipe normalised image coords (x,y in 0..1 of the NON-mirrored
 *              camera frame, z = depth relative to the wrist, ~x scale).
 *  - *metric*: raw scaled to be isotropic: (x·aspect, y, z·aspect·zScale), i.e.
 *              units of image height. All distances/ratios are measured here.
 *  - *screen*: mirrored + remapped so the central region of the camera covers
 *              0..1 of the screen (what HandState exposes).
 */
import type { Gesture, HandState, Landmark } from './types';
import { OneEuroFilter, OneEuroFilter2D, CURSOR_FILTER, SHAPE_FILTER, type OneEuroParams } from './oneEuro';

// ---------------------------------------------------------------------------
// Landmark indices (MediaPipe hand model)
// ---------------------------------------------------------------------------
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

const FINGER_TIPS = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP] as const;
const FINGER_PIPS = [LM.INDEX_PIP, LM.MIDDLE_PIP, LM.RING_PIP, LM.PINKY_PIP] as const;

export interface RawLandmark { x: number; y: number; z: number }

/** One detection as it comes out of MediaPipe (un-mirrored). */
export interface RawHand {
  landmarks: RawLandmark[];
  /** MediaPipe's handedness label (it assumes a mirrored input image). */
  label: 'Left' | 'Right';
  /** Handedness/presence score 0..1. */
  score: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export interface MappingConfig {
  /** Mirror x (selfie view). */
  mirror: boolean;
  /**
   * Camera-frame region (in mirrored image coords, 0..1) that maps onto the
   * full screen. ~70% of the frame; biased upward because the cursor sits at
   * the fingertips and the rest of the hand hangs below it — keeping y1 well
   * above the bottom edge means the wrist stays in frame (MediaPipe loses
   * hands whose palm leaves the image).
   */
  x0: number; x1: number; y0: number; y1: number;
  /**
   * MediaPipe labels handedness assuming a mirrored image; we feed it the raw
   * camera frame, so its label is the opposite of the user's real hand.
   */
  flipHandedness: boolean;
}

export const DEFAULT_MAPPING: MappingConfig = {
  mirror: true,
  x0: 0.2, x1: 0.8,
  y0: 0.16, y1: 0.76,
  flipHandedness: true,
};

export interface GestureConfig {
  /** Weight of MediaPipe z in 3D distances (z is noisier than x/y). */
  zScale: number;
  /** Pinch hysteresis on thumbTip–indexTip distance / palm scale. */
  pinchOn: number;
  pinchOff: number;
  /** Ratio at which pinchStrength = 1 (tips touching) and = 0. */
  pinchTouch: number;
  pinchOpen: number;
  /**
   * Pinch onset guard: the thumb tip must be clearly closer to the index TIP
   * than to the index PIP joint. In a fist the thumb lies across the index's
   * middle phalanx, so tip–tip distance can be small without a pinch.
   */
  pinchTipVsPip: number;
  /** Pinch onset guard: index wrist→tip / wrist→PIP must exceed this (not fist-curled). */
  pinchMinIndexCurl: number;
  /** wrist→tip / wrist→PIP below this = finger curled. */
  curledRatio: number;
  /** wrist→tip / wrist→PIP above this = finger extended. */
  extendedRatio: number;
  /** Thumb tip → index MCP distance / palm above this = thumb extended. */
  thumbOutRatio: number;
  /** Grab (fist) hysteresis on the mean finger curl ratio (wrist→tip / wrist→PIP). */
  grabOnMean: number;
  grabOffMean: number;
  /** Middle-finger salute: middle ratio above this while the others are curled. */
  middleExt: number;
  /** Gesture debounce: a new gesture must persist this long AND this many frames. */
  debounceMs: number;
  debounceFrames: number;
  /** Falling back to 'none' is slower, so fist/open don't blink through 'none'. */
  noneDebounceMs: number;
  /** Keep the hand (and its pinch) alive this long after it drops out. */
  graceMs: number;
  /** After this long without data the hand is treated as new (filters reset). */
  reacquireMs: number;

  // --- cursor stabilisation (pinch-jump mitigation), see HandProcessor ---
  /** Follow time constant (s) of the cursor's offset within the palm frame. */
  offsetFollowTau: number;
  /** Below this pinch ratio the offset starts freezing (fully frozen at pinchOn). */
  freezeBand: number;
  /** |d(ratio)/dt| (palm/s) range over which the offset goes from free to frozen. */
  freezeRateLo: number;
  freezeRateHi: number;

  /** Velocity EMA time constant (s). */
  velocityTau: number;
  cursorFilter: OneEuroParams;
  shapeFilter: OneEuroParams;
}

export const DEFAULT_GESTURE: GestureConfig = {
  zScale: 0.6,
  pinchOn: 0.28,
  pinchOff: 0.42,
  pinchTouch: 0.18,
  pinchOpen: 0.9,
  pinchTipVsPip: 0.8,
  pinchMinIndexCurl: 0.78,
  curledRatio: 1.0,
  extendedRatio: 1.2,
  grabOnMean: 0.95,
  grabOffMean: 1.16,
  middleExt: 1.15,
  thumbOutRatio: 0.5,
  debounceMs: 25,
  debounceFrames: 2,
  noneDebounceMs: 70,
  graceMs: 120,
  reacquireMs: 300,
  offsetFollowTau: 0.09,
  freezeBand: 0.75,
  freezeRateLo: 0.8,
  freezeRateHi: 2.5,
  velocityTau: 0.035,
  cursorFilter: CURSOR_FILTER,
  shapeFilter: SHAPE_FILTER,
};

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 3D distance in metric space (see header). */
export function metricDist(a: RawLandmark, b: RawLandmark, aspect: number, zScale: number): number {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  const dz = (a.z - b.z) * aspect * zScale;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Mirroring / remapping
// ---------------------------------------------------------------------------

/** Raw image point → screen space (NOT clamped; callers clamp the cursor). */
export function toScreen(x: number, y: number, m: MappingConfig = DEFAULT_MAPPING): { x: number; y: number } {
  const mx = m.mirror ? 1 - x : x;
  return { x: (mx - m.x0) / (m.x1 - m.x0), y: (y - m.y0) / (m.y1 - m.y0) };
}

/** Screen point → raw image point (inverse of toScreen). Handy for tests/fakes. */
export function fromScreen(sx: number, sy: number, m: MappingConfig = DEFAULT_MAPPING): { x: number; y: number } {
  const mx = m.x0 + sx * (m.x1 - m.x0);
  return { x: m.mirror ? 1 - mx : mx, y: m.y0 + sy * (m.y1 - m.y0) };
}

/** Maps all landmarks to screen space (unclamped). z is scaled like x. */
export function mapLandmarks(raw: RawLandmark[], m: MappingConfig = DEFAULT_MAPPING): Landmark[] {
  const zs = 1 / (m.x1 - m.x0);
  return raw.map((p) => { const s = toScreen(p.x, p.y, m); return { x: s.x, y: s.y, z: p.z * zs }; });
}

/** Handedness as the user perceives it. */
export function userHandedness(label: 'Left' | 'Right', m: MappingConfig = DEFAULT_MAPPING): 'Left' | 'Right' {
  if (!m.flipHandedness) return label;
  return label === 'Left' ? 'Right' : 'Left';
}

/**
 * Raw cursor (knuckle centroid, same anchor as HandProcessor) in screen space, unclamped —
 * used for slot matching against the processors' filtered cursors.
 */
export function rawCursor(raw: RawLandmark[], m: MappingConfig = DEFAULT_MAPPING): { x: number; y: number } {
  const a = raw[LM.INDEX_MCP], b = raw[LM.MIDDLE_MCP], c = raw[LM.RING_MCP], d = raw[LM.PINKY_MCP];
  return toScreen((a.x + b.x + c.x + d.x) / 4, (a.y + b.y + c.y + d.y) / 4, m);
}

// ---------------------------------------------------------------------------
// Per-frame measurements
// ---------------------------------------------------------------------------
export interface HandMetrics {
  /** Palm scale in metric units (robust to foreshortening). */
  palmScale: number;
  /** thumbTip–indexTip distance / palmScale. */
  pinchRatio: number;
  /** wrist→tip / wrist→PIP for index, middle, ring, pinky. */
  curl: [number, number, number, number];
  /** thumb, index, middle, ring, pinky. */
  extended: [boolean, boolean, boolean, boolean, boolean];
  extendedCount: number;
  /** Number of index..pinky fingers curled. */
  curledCount: number;
  /** Thumb tip is touching the index *tip* rather than the side of the finger. */
  tipContact: boolean;
}

export function measureHand(raw: RawLandmark[], aspect: number, cfg: GestureConfig = DEFAULT_GESTURE): HandMetrics {
  const d = (i: number, j: number) => metricDist(raw[i], raw[j], aspect, cfg.zScale);

  // Palm length (wrist→middle MCP) collapses when the hand pitches toward the
  // camera; palm width (index MCP→pinky MCP, ≈0.65 of the length) collapses
  // when it yaws. Taking the max of both keeps the scale stable either way.
  const palmScale = Math.max(d(LM.WRIST, LM.MIDDLE_MCP), d(LM.INDEX_MCP, LM.PINKY_MCP) / 0.65, 1e-6);

  const tipTip = d(LM.THUMB_TIP, LM.INDEX_TIP);
  const pinchRatio = tipTip / palmScale;

  const curl = [0, 0, 0, 0] as [number, number, number, number];
  let curledCount = 0;
  let extFingers = 0;
  const extended = [false, false, false, false, false] as [boolean, boolean, boolean, boolean, boolean];
  for (let f = 0; f < 4; f++) {
    const r = d(LM.WRIST, FINGER_TIPS[f]) / Math.max(d(LM.WRIST, FINGER_PIPS[f]), 1e-6);
    curl[f] = r;
    if (r < cfg.curledRatio) curledCount++;
    if (r > cfg.extendedRatio) { extended[f + 1] = true; extFingers++; }
  }
  // Thumb: tip further from the pinky base than its IP joint, and splayed away from the index base.
  const thumbOut = d(LM.THUMB_TIP, LM.PINKY_MCP) > d(LM.THUMB_IP, LM.PINKY_MCP) * 1.05
    && d(LM.THUMB_TIP, LM.INDEX_MCP) / palmScale > cfg.thumbOutRatio;
  extended[0] = thumbOut;

  const tipContact = tipTip < cfg.pinchTipVsPip * d(LM.THUMB_TIP, LM.INDEX_PIP);

  return {
    palmScale, pinchRatio, curl, extended,
    extendedCount: extFingers + (thumbOut ? 1 : 0),
    curledCount, tipContact,
  };
}

/** Pinch hysteresis. Onset additionally requires real tip contact (see pinchTipVsPip). */
export function nextPinch(active: boolean, m: HandMetrics, cfg: GestureConfig = DEFAULT_GESTURE): boolean {
  if (active) return m.pinchRatio <= cfg.pinchOff;
  // Onset guards against fists: in a fist the thumb lies on the curled index,
  // so tip–tip can read small. A pinching index is only mildly curled
  // (wrist→tip / wrist→PIP ≈ 0.85–1.05) while a fist's is ≈ 0.6–0.7.
  return m.pinchRatio < cfg.pinchOn && m.tipContact && m.curl[0] > cfg.pinchMinIndexCurl;
}

export function pinchStrengthOf(ratio: number, cfg: GestureConfig = DEFAULT_GESTURE): number {
  return clamp01((cfg.pinchOpen - ratio) / (cfg.pinchOpen - cfg.pinchTouch));
}

/** Middle finger up, index / ring / pinky curled (the smite salute). */
export function isMiddle(m: HandMetrics, cfg: GestureConfig = DEFAULT_GESTURE): boolean {
  return m.curl[1] > cfg.middleExt && m.curl[0] < cfg.curledRatio + 0.05 && m.curl[2] < cfg.curledRatio + 0.05 && m.curl[3] < cfg.curledRatio + 0.1;
}

/**
 * Grab = closed fist, with hysteresis on the mean curl so a fist held loosely while moving
 * doesn't flicker open. Never while giving the middle finger.
 */
export function nextGrab(active: boolean, m: HandMetrics, cfg: GestureConfig = DEFAULT_GESTURE): boolean {
  if (isMiddle(m, cfg)) return false;
  const mean = (m.curl[0] + m.curl[1] + m.curl[2] + m.curl[3]) / 4;
  // A clearly straightened finger (e.g. pointing) ends / prevents a grab even though the
  // other three curled fingers keep the mean low.
  const maxCurl = Math.max(m.curl[0], m.curl[1], m.curl[2], m.curl[3]);
  if (active) return mean < cfg.grabOffMean && m.extendedCount < 3 && maxCurl < cfg.extendedRatio + 0.05;
  return mean < cfg.grabOnMean && m.curledCount >= 3 && maxCurl <= cfg.extendedRatio;
}

/** 0..1 how closed the hand is. */
export function grabStrengthOf(m: HandMetrics, cfg: GestureConfig = DEFAULT_GESTURE): number {
  const mean = (m.curl[0] + m.curl[1] + m.curl[2] + m.curl[3]) / 4;
  return clamp01((1.45 - mean) / (1.45 - cfg.grabOnMean + 0.08));
}

/** Kept for tests / tools: legacy fist test (grab without hysteresis). */
export const isFist = (m: HandMetrics, grab: boolean): boolean =>
  grab || (m.curledCount >= 3 && !m.extended[1] && !m.extended[2]);
export const isOpen = (m: HandMetrics): boolean => m.extendedCount >= 4;
export function isPoint(m: HandMetrics, cfg: GestureConfig = DEFAULT_GESTURE): boolean {
  const othersDown = m.curl[1] < cfg.extendedRatio * 0.92 && m.curl[2] < cfg.extendedRatio * 0.92
    && m.curl[3] < cfg.extendedRatio * 0.92;
  return m.extended[1] && othersDown;
}

/** Instantaneous (un-debounced) classification. Precedence: grab > middle > open > point. */
export function classifyGesture(m: HandMetrics, grab: boolean, cfg: GestureConfig = DEFAULT_GESTURE): Gesture {
  if (grab) return 'grab';
  if (isMiddle(m, cfg)) return 'middle';
  if (isOpen(m)) return 'open';
  if (isPoint(m, cfg)) return 'point';
  return 'none';
}

/**
 * Debounces gesture changes so fist/open/point don't flicker on single-frame
 * misclassifications. Pinch bypasses the debounce (it has its own hysteresis
 * and its latency matters most).
 */
export class GestureDebouncer {
  stable: Gesture = 'none';
  private cand: Gesture = 'none';
  private candSince = 0;
  private candFrames = 0;

  constructor(private cfg: GestureConfig = DEFAULT_GESTURE) {}

  push(g: Gesture, tMs: number): Gesture {
    if (g === 'grab') { this.stable = 'grab'; this.cand = 'grab'; this.candFrames = 0; return this.stable; }
    if (this.stable === 'grab') {
      // Leaving a grab: drop to 'none' immediately, then debounce toward g.
      this.stable = 'none';
      this.cand = g; this.candSince = tMs; this.candFrames = 1;
      return this.stable;
    }
    if (g === this.stable) { this.cand = g; this.candFrames = 0; return this.stable; }
    if (g !== this.cand) { this.cand = g; this.candSince = tMs; this.candFrames = 1; }
    else this.candFrames++;
    const need = g === 'none' ? this.cfg.noneDebounceMs : this.cfg.debounceMs;
    if (this.candFrames >= this.cfg.debounceFrames && tMs - this.candSince >= need) this.stable = g;
    return this.stable;
  }

  reset(): void { this.stable = 'none'; this.cand = 'none'; this.candFrames = 0; }
}

// ---------------------------------------------------------------------------
// Per-hand stateful processor
// ---------------------------------------------------------------------------

/** HandState minus slot & edge flags (the InputManager owns those). */
export type ProcessedHand = Omit<HandState, 'slot' | 'grabStart' | 'grabEnd'>;

/** Knuckle centroid (index/middle/ring/pinky MCPs): barely moves when the hand opens or clenches. */
const KNUCKLES = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const;

/**
 * Turns a stream of detections of ONE physical hand into a smoothed HandState.
 *
 * The cursor is the palm centre (knuckle centroid) rather than a fingertip: closing a fist to
 * grab, or flipping the middle finger to smite, then never drags the cursor off the target.
 */
export class HandProcessor {
  present = false;
  handedness: 'Left' | 'Right' = 'Right';
  /** Clamped, filtered cursor. */
  x = 0.5; y = 0.5;
  /** Unclamped filtered cursor (velocity is measured on this). */
  ux = 0.5; uy = 0.5;
  vx = 0; vy = 0;
  grab = false;
  grabStrength = 0;
  gesture: Gesture = 'none';
  palmSize = 0;
  lastSeen = -Infinity;
  landmarks: Landmark[] = [];
  /** Last raw metrics (debug / tests). */
  metrics: HandMetrics | null = null;

  private cursorFilter: OneEuroFilter2D;
  private shapeFilters: OneEuroFilter[] = [];
  private palmFilter: OneEuroFilter;
  private debouncer: GestureDebouncer;
  private lastFrameT = 0;
  private handVote = 0;
  private lastMiss = -Infinity;

  constructor(
    public cfg: GestureConfig = DEFAULT_GESTURE,
    public mapping: MappingConfig = DEFAULT_MAPPING,
  ) {
    this.cursorFilter = new OneEuroFilter2D(cfg.cursorFilter);
    this.palmFilter = new OneEuroFilter(cfg.shapeFilter);
    for (let i = 0; i < 63; i++) this.shapeFilters.push(new OneEuroFilter(cfg.shapeFilter));
    this.debouncer = new GestureDebouncer(cfg);
  }

  /**
   * Feed one detection.
   * @param nowMs     wall clock (performance.now) — drives grace / lastSeen.
   * @param frameMs   capture time of the video frame (ms). Filters and velocity
   *                  use it because rAF-sampled times jitter vs. camera frames.
   * @param aspect    video width / height.
   */
  update(raw: RawHand, nowMs: number, frameMs: number = nowMs, aspect = 16 / 9): void {
    const cfg = this.cfg, m = this.mapping;
    const lms = raw.landmarks;
    const t = frameMs / 1000;
    const fresh = !this.present || nowMs - this.lastSeen > cfg.reacquireMs;
    if (fresh) this.resetFilters();
    let dt = fresh ? 0 : t - this.lastFrameT;
    if (!(dt > 0.004)) dt = fresh ? 0 : 0.004; // duplicate/backwards timestamps
    if (dt > 0.1) dt = 0.1;
    this.lastFrameT = t;

    // --- gestures ---------------------------------------------------------
    const mt = measureHand(lms, aspect, cfg);
    this.metrics = mt;
    this.grab = nextGrab(this.grab && !fresh, mt, cfg);
    this.grabStrength = grabStrengthOf(mt, cfg);
    this.gesture = this.debouncer.push(classifyGesture(mt, this.grab, cfg), frameMs);

    // Handedness: MediaPipe's label flickers; keep a decaying score-weighted vote.
    const vote = (userHandedness(raw.label, m) === 'Right' ? 1 : -1) * Math.max(0.1, raw.score);
    this.handVote = fresh ? vote : this.handVote * 0.85 + vote * 0.15;
    this.handedness = this.handVote >= 0 ? 'Right' : 'Left';

    // --- cursor: knuckle centroid ----------------------------------------
    let kx = 0, ky = 0;
    for (const i of KNUCKLES) { kx += lms[i].x; ky += lms[i].y; }
    const target = toScreen(kx / 4, ky / 4, m);

    // --- filter + velocity -------------------------------------------------
    const prevUx = this.ux, prevUy = this.uy;
    const f = this.cursorFilter.filter(target.x, target.y, t);
    this.ux = f.x; this.uy = f.y;
    this.x = clamp01(f.x); this.y = clamp01(f.y);
    if (fresh || dt <= 0) { this.vx = 0; this.vy = 0; }
    else {
      const k = 1 - Math.exp(-dt / cfg.velocityTau);
      this.vx += k * ((this.ux - prevUx) / dt - this.vx);
      this.vy += k * ((this.uy - prevUy) / dt - this.vy);
    }

    // --- landmark shape, re-anchored on the cursor ------------------------
    // Shape = landmarks relative to the knuckle centroid, filtered separately, so
    // translation only goes through the (tuned) cursor filter.
    const sl = mapLandmarks(lms, m);
    let cx = 0, cy = 0;
    for (const i of KNUCKLES) { cx += sl[i].x; cy += sl[i].y; }
    cx /= 4; cy /= 4;
    const out: Landmark[] = new Array(sl.length);
    for (let i = 0; i < sl.length; i++) {
      const fx = this.shapeFilters[i * 3].filter(sl[i].x - cx, t);
      const fy = this.shapeFilters[i * 3 + 1].filter(sl[i].y - cy, t);
      const fz = this.shapeFilters[i * 3 + 2].filter(sl[i].z, t);
      out[i] = { x: this.x + fx, y: this.y + fy, z: fz };
    }
    this.landmarks = out;
    const pw = out[LM.WRIST], pm = out[LM.MIDDLE_MCP];
    this.palmSize = this.palmFilter.filter(Math.hypot(pw.x - pm.x, pw.y - pm.y), t);

    this.present = true;
    this.lastSeen = nowMs;
  }

  /**
   * No detection matched this hand this frame. Within the grace period the
   * hand (and its grab) stays alive at its last position; afterwards it is
   * dropped. Returns true while still present.
   */
  miss(nowMs: number): boolean {
    if (!this.present) return false;
    if (nowMs - this.lastSeen <= this.cfg.graceMs) {
      const dt = Math.max(0, nowMs - Math.max(this.lastSeen, this.lastMiss));
      this.lastMiss = nowMs;
      const k = Math.exp(-dt / 60);
      this.vx *= k; this.vy *= k;
      return true;
    }
    this.reset();
    return false;
  }

  reset(): void {
    this.present = false;
    this.grab = false;
    this.grabStrength = 0;
    this.gesture = 'none';
    this.vx = 0; this.vy = 0;
    this.landmarks = [];
    this.palmSize = 0;
    this.metrics = null;
    this.resetFilters();
  }

  private resetFilters(): void {
    this.cursorFilter.reset();
    this.palmFilter.reset();
    for (const f of this.shapeFilters) f.reset();
    this.debouncer.reset();
    this.grab = false;
  }

  /** Snapshot (edge flags are added by the InputManager). */
  snapshot(): ProcessedHand {
    return {
      present: this.present,
      handedness: this.handedness,
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      grab: this.grab, grabStrength: this.present ? this.grabStrength : 0,
      middle: this.gesture === 'middle', open: this.gesture === 'open',
      gesture: this.present ? this.gesture : 'none',
      landmarks: this.landmarks,
      palmSize: this.palmSize,
      lastSeen: Number.isFinite(this.lastSeen) ? this.lastSeen : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Slot assignment
// ---------------------------------------------------------------------------

/**
 * Assigns detections to slots 0/1 by nearest position. `slots[i]` is the last
 * cursor of slot i, or null if the slot is free. Returns the slot for each
 * detection (max 2 detections).
 *  - Active slots keep their hand (minimum total squared distance).
 *  - A detection further than `maxJump` from the only active slot is treated
 *    as a different hand and takes the free slot instead.
 *  - New hands take free slots; two brand-new hands: the one further right on
 *    screen (usually the user's right hand) gets slot 0.
 */
export function assignSlots(
  slots: [{ x: number; y: number } | null, { x: number; y: number } | null],
  dets: { x: number; y: number }[],
  maxJump = 0.45,
): (0 | 1)[] {
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const [s0, s1] = slots;
  if (dets.length === 0) return [];
  if (dets.length === 1) {
    const p = dets[0];
    if (s0 && s1) return [d2(p, s0) <= d2(p, s1) ? 0 : 1];
    const active: 0 | 1 | -1 = s0 ? 0 : s1 ? 1 : -1;
    if (active === -1) return [0];
    const s = (active === 0 ? s0 : s1)!;
    if (d2(p, s) > maxJump * maxJump) return [active === 0 ? 1 : 0];
    return [active];
  }
  const [a, b] = dets;
  if (s0 && s1) {
    const keep = d2(a, s0) + d2(b, s1);
    const swap = d2(a, s1) + d2(b, s0);
    return keep <= swap ? [0, 1] : [1, 0];
  }
  if (s0 || s1) {
    const active: 0 | 1 = s0 ? 0 : 1;
    const free: 0 | 1 = active === 0 ? 1 : 0;
    const s = (s0 ?? s1)!;
    return d2(a, s) <= d2(b, s) ? [active, free] : [free, active];
  }
  return a.x >= b.x ? [0, 1] : [1, 0];
}

/** Clamp helper re-exported for other input modules. */
export { clamp };
