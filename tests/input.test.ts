import { describe, expect, it } from 'vitest';
import { OneEuroFilter, OneEuroFilter2D } from '../src/input/oneEuro';
import {
  assignSlots, classifyGesture, DEFAULT_GESTURE, DEFAULT_MAPPING, fromScreen, GestureDebouncer, HandProcessor,
  mapLandmarks, measureHand, nextPinch, pinchStrengthOf, rawCursor, toScreen, userHandedness,
  type HandMetrics, type RawHand,
} from '../src/input/gestures';
import { POSES, rawHandAt, screenHandLandmarks, type HandPose } from '../src/input/fakeHand';
import { InputManager } from '../src/input/inputManager';
import type { HandState, InputFrame } from '../src/input/types';

const ASPECT = 16 / 9;
const classify = (h: RawHand, pinchActive = false, aspect = ASPECT) => {
  const m = measureHand(h.landmarks, aspect);
  return classifyGesture(m, nextPinch(pinchActive, m));
};

/** Pose with fingers closing toward a pinch (0 = open, 1 = pinched). */
const pinchPose = (p: number): HandPose => ({ curl: [0, 0.5 * p, 0.35 * p, 0.4 * p, 0.45 * p], pinch: p });

/** A hand whose WRIST stays fixed at the position of an open hand at (sx, sy) while the pose changes. */
function anchoredHand(sx: number, sy: number, pose: HandPose): RawHand {
  const ref = rawHandAt(sx, sy, POSES.open).landmarks[0];
  const h = rawHandAt(sx, sy, pose);
  const w = h.landmarks[0];
  h.landmarks = h.landmarks.map((l) => ({ x: l.x - w.x + ref.x, y: l.y - w.y + ref.y, z: l.z }));
  return h;
}

const fakeVideo = {} as HTMLVideoElement;

// ---------------------------------------------------------------------------
describe('OneEuroFilter', () => {
  it('passes the first sample and converges on a constant', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.3, 0)).toBe(0.3);
    let v = 0;
    for (let i = 1; i < 60; i++) v = f.filter(0.6, i / 30);
    expect(v).toBeCloseTo(0.6, 3);
  });

  it('removes jitter at rest but follows fast motion with little lag', () => {
    const f = new OneEuroFilter2D();
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.01;
    let inVar = 0, outVar = 0;
    for (let i = 0; i < 120; i++) {
      const n = rnd();
      const o = f.filter(0.5 + n, 0.5, i / 30);
      if (i > 30) { inVar += n * n; outVar += (o.x - 0.5) ** 2; }
    }
    expect(Math.sqrt(outVar / inVar)).toBeLessThan(0.45);
    // 2 screens/s swipe: lag should stay under ~0.1 screen.
    let o = { x: 0, y: 0 };
    let x = 0.5;
    for (let i = 0; i < 10; i++) { x += 2 / 30; o = f.filter(x, 0.5, (120 + i) / 30); }
    expect(x - o.x).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
describe('mirroring / remap', () => {
  it('mirrors x and maps the central region onto 0..1', () => {
    const m = DEFAULT_MAPPING;
    const c = toScreen(0.5, (m.y0 + m.y1) / 2);
    expect(c.x).toBeCloseTo(0.5);
    expect(c.y).toBeCloseTo(0.5);
    // Right edge of the raw image = left of the screen (selfie view).
    expect(toScreen(1 - m.x0, m.y0).x).toBeCloseTo(0);
    expect(toScreen(m.x0, m.y0).x).toBeCloseTo(1);
    expect(toScreen(0.5, m.y1).y).toBeCloseTo(1);
    // Outside the region is NOT clamped by toScreen (the cursor clamps).
    expect(toScreen(0.99, 0.5).x).toBeLessThan(0);
    const back = fromScreen(0.3, 0.7);
    const again = toScreen(back.x, back.y);
    expect(again.x).toBeCloseTo(0.3);
    expect(again.y).toBeCloseTo(0.7);
  });

  it('flips MediaPipe handedness for un-mirrored input', () => {
    expect(userHandedness('Left')).toBe('Right');
    expect(userHandedness('Right')).toBe('Left');
    expect(userHandedness('Left', { ...DEFAULT_MAPPING, flipHandedness: false })).toBe('Left');
  });

  it('places the raw cursor at the thumb/index midpoint in screen space', () => {
    const h = rawHandAt(0.25, 0.6, POSES.open);
    const c = rawCursor(h.landmarks);
    expect(c.x).toBeCloseTo(0.25, 5);
    expect(c.y).toBeCloseTo(0.6, 5);
    const sl = mapLandmarks(h.landmarks);
    expect(sl).toHaveLength(21);
    expect((sl[4].x + sl[8].x) / 2).toBeCloseTo(0.25, 5);
  });

  it('a right hand appears with its thumb toward screen-left', () => {
    const sl = mapLandmarks(rawHandAt(0.5, 0.5, POSES.open, { handedness: 'Right' }).landmarks);
    expect(sl[4].x).toBeLessThan(sl[20].x);
    const sl2 = mapLandmarks(rawHandAt(0.5, 0.5, POSES.open, { handedness: 'Left' }).landmarks);
    expect(sl2[4].x).toBeGreaterThan(sl2[20].x);
  });
});

// ---------------------------------------------------------------------------
describe('gesture classification', () => {
  const variants = [
    { name: 'right', o: {} },
    { name: 'left', o: { handedness: 'Left' as const } },
    { name: 'small/far', o: { scale: 0.09 } },
    { name: '4:3 camera', o: { aspect: 4 / 3 }, aspect: 4 / 3 },
  ];
  for (const v of variants) {
    it(`classifies open / fist / point / pinch / middle (${v.name})`, () => {
      const a = v.aspect ?? ASPECT;
      expect(classify(rawHandAt(0.5, 0.5, POSES.open, v.o), false, a)).toBe('open');
      expect(classify(rawHandAt(0.5, 0.5, POSES.fist, v.o), false, a)).toBe('fist');
      expect(classify(rawHandAt(0.5, 0.5, POSES.point, v.o), false, a)).toBe('point');
      expect(classify(rawHandAt(0.5, 0.5, POSES.pinch, v.o), false, a)).toBe('pinch');
      expect(classify(rawHandAt(0.5, 0.5, POSES.middle, v.o), false, a)).toBe('middle');
    });
  }

  it('is rotation tolerant', () => {
    for (const roll of [-0.6, 0.5]) {
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.open, roll }))).toBe('open');
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.fist, roll }))).toBe('fist');
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.pinch, roll }))).toBe('pinch');
    }
  });

  it('a fist is never a pinch even though thumb and index tips are close', () => {
    const m = measureHand(rawHandAt(0.5, 0.5, POSES.fist).landmarks, ASPECT);
    expect(m.pinchRatio).toBeLessThan(DEFAULT_GESTURE.pinchOn); // the trap
    expect(nextPinch(false, m)).toBe(false);
    expect(classifyGesture(m, false)).toBe('fist');
  });

  it('pinch strength goes 0 → 1 as fingers close', () => {
    const s = [0, 0.5, 1].map((p) => pinchStrengthOf(measureHand(rawHandAt(0.5, 0.5, pinchPose(p)).landmarks, ASPECT).pinchRatio));
    expect(s[0]).toBeLessThan(0.05);
    expect(s[1]).toBeGreaterThan(s[0]);
    expect(s[2]).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
describe('pinch hysteresis', () => {
  const metrics = (pinchRatio: number): HandMetrics => ({
    palmScale: 1, pinchRatio, curl: [1, 1.2, 1.2, 1.2], extended: [true, false, false, false, false],
    extendedCount: 1, curledCount: 0, tipContact: true,
  });

  it('turns on below pinchOn and off only above pinchOff', () => {
    let on = false;
    const seq: [number, boolean][] = [
      [0.8, false], [0.35, false], [0.27, true], [0.35, true], [0.41, true], [0.30, true], [0.43, false], [0.35, false], [0.2, true],
    ];
    for (const [r, want] of seq) {
      on = nextPinch(on, metrics(r));
      expect(on, `ratio ${r}`).toBe(want);
    }
  });

  it('does not chatter when the ratio hovers around the on-threshold (processor)', () => {
    const p = new HandProcessor();
    let t = 0, toggles = 0, last = false;
    const amounts = [0, 0, 0.5, 0.8, 0.9, 0.95, 0.85, 0.9, 0.8, 0.9, 0.85, 0.9, 0.8, 0.88];
    for (const a of amounts) {
      t += 33;
      p.update(anchoredHand(0.5, 0.5, pinchPose(a)), t);
      if (p.pinch !== last) { toggles++; last = p.pinch; }
    }
    expect(toggles).toBe(1);
    expect(p.pinch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('gesture debounce', () => {
  it('ignores single-frame flicker but follows real changes within ~2 frames', () => {
    const d = new GestureDebouncer();
    let t = 0;
    const push = (g: Parameters<GestureDebouncer['push']>[0]) => d.push(g, (t += 33));
    push('fist'); push('fist'); push('fist');
    expect(d.stable).toBe('fist');
    push('open'); // single bad frame
    push('fist');
    expect(d.stable).toBe('fist');
    push('none'); push('none'); // brief transitional frames
    expect(d.stable).toBe('fist');
    push('open');
    expect(d.stable).toBe('fist');
    push('open');
    expect(d.stable).toBe('open'); // fist → open in 2 frames (smite)
  });

  it('pinch bypasses the debounce', () => {
    const d = new GestureDebouncer();
    d.push('open', 0); d.push('open', 40);
    expect(d.push('pinch', 80)).toBe('pinch');
    expect(d.push('open', 120)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
describe('HandProcessor', () => {
  it('suppresses the cursor jump while the pinch closes and opens', () => {
    const p = new HandProcessor();
    let t = 0;
    let naiveMax = 0, cursorMax = 0;
    const ref = { x: 0, y: 0 };
    const seq = [...Array(10).fill(0), 0.3, 0.6, 0.85, 1, 1, 1, 1, 1, 0.6, 0.3, 0, ...Array(10).fill(0)];
    seq.forEach((a, i) => {
      t += 33;
      const h = anchoredHand(0.5, 0.5, pinchPose(a));
      p.update(h, t);
      if (i === 9) { ref.x = p.x; ref.y = p.y; }
      if (i >= 10) {
        const rc = rawCursor(h.landmarks);
        naiveMax = Math.max(naiveMax, Math.hypot(rc.x - 0.5, rc.y - 0.5));
        cursorMax = Math.max(cursorMax, Math.hypot(p.x - ref.x, p.y - ref.y));
      }
    });
    expect(naiveMax).toBeGreaterThan(0.02); // the synthetic hand really does "jump"
    expect(cursorMax).toBeLessThan(naiveMax * 0.2);
  });

  it('follows the hand while pinched (rigid to the palm)', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 5; i++) p.update(rawHandAt(0.3, 0.5, POSES.pinch), (t += 33));
    expect(p.pinch).toBe(true);
    for (let i = 0; i <= 30; i++) p.update(rawHandAt(0.3 + i * 0.01, 0.5, POSES.pinch), (t += 33));
    expect(p.pinch).toBe(true);
    expect(p.x).toBeGreaterThan(0.55);
    expect(p.x).toBeLessThan(0.61);
    expect(p.vx).toBeGreaterThan(0.2); // ≈ 0.3 screen/s
    expect(p.vx).toBeLessThan(0.4);
  });

  it('measures velocity in screen units/s and resists frame-time spikes', () => {
    const p = new HandProcessor();
    let t = 0, x = 0.2;
    for (let i = 0; i < 20; i++) { p.update(rawHandAt(x, 0.5, POSES.open), (t += 1000 / 30)); x += 2 / 30; }
    expect(p.vx).toBeGreaterThan(1.6);
    expect(p.vx).toBeLessThan(2.3);
    expect(Math.abs(p.vy)).toBeLessThan(0.1);
    // Duplicate timestamp must not explode the velocity.
    p.update(rawHandAt(x, 0.5, POSES.open), t);
    expect(Math.abs(p.vx)).toBeLessThan(20);
  });

  it('clamps the cursor to the screen but keeps the hand', () => {
    const p = new HandProcessor();
    p.update(rawHandAt(1.3, -0.2, POSES.open), 0);
    expect(p.x).toBe(1);
    expect(p.y).toBe(0);
    expect(p.landmarks).toHaveLength(21);
    // Visual landmarks are anchored on the cursor.
    expect((p.landmarks[4].x + p.landmarks[8].x) / 2).toBeCloseTo(1, 5);
  });

  it('keeps a pinch alive through a short dropout (grace) and drops it after', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 4; i++) p.update(rawHandAt(0.5, 0.5, POSES.pinch), (t += 33));
    expect(p.pinch).toBe(true);
    expect(p.miss(t + 40)).toBe(true);
    expect(p.miss(t + 100)).toBe(true);
    expect(p.pinch).toBe(true);
    p.update(rawHandAt(0.5, 0.5, POSES.pinch), t + 110);
    expect(p.pinch).toBe(true);
    t += 110;
    expect(p.miss(t + 100)).toBe(true);
    expect(p.miss(t + 200)).toBe(false);
    expect(p.present).toBe(false);
    expect(p.pinch).toBe(false);
  });

  it('reports user-facing handedness with a stable vote', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 5; i++) p.update(rawHandAt(0.5, 0.5, POSES.open, { handedness: 'Left' }), (t += 33));
    expect(p.handedness).toBe('Left');
    const flicker = rawHandAt(0.5, 0.5, POSES.open, { handedness: 'Left' });
    flicker.label = flicker.label === 'Left' ? 'Right' : 'Left';
    p.update(flicker, (t += 33));
    expect(p.handedness).toBe('Left');
  });
});

// ---------------------------------------------------------------------------
describe('assignSlots', () => {
  const P = (x: number, y = 0.5) => ({ x, y });
  it('keeps slots by nearest position', () => {
    expect(assignSlots([P(0.2), P(0.8)], [P(0.78), P(0.22)])).toEqual([1, 0]);
    expect(assignSlots([P(0.2), P(0.8)], [P(0.22), P(0.78)])).toEqual([0, 1]);
    expect(assignSlots([P(0.2), P(0.8)], [P(0.75)])).toEqual([1]);
  });
  it('new hands take the free slot', () => {
    expect(assignSlots([null, null], [P(0.4)])).toEqual([0]);
    expect(assignSlots([null, P(0.6)], [P(0.62), P(0.1)])).toEqual([1, 0]);
    expect(assignSlots([P(0.3), null], [P(0.9), P(0.31)])).toEqual([1, 0]);
  });
  it('a far-away single detection is a different hand', () => {
    expect(assignSlots([P(0.1), null], [P(0.9)])).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
describe('InputManager (camera pipeline via ingestDetections)', () => {
  it('keeps slots stable when MediaPipe swaps hand order', () => {
    const im = new InputManager({ video: fakeVideo, renderSmoothingMs: 0 });
    let t = 1000;
    let f: InputFrame | null = null;
    let openSlot = -1;
    for (let i = 0; i < 20; i++) {
      t += 33;
      const a = rawHandAt(0.25 + i * 0.005, 0.5, POSES.open, { handedness: 'Left' });
      const b = rawHandAt(0.75 - i * 0.005, 0.5, POSES.fist, { handedness: 'Right' });
      im.ingestDetections(i % 3 === 0 ? [b, a] : [a, b], t);
      f = im.update(t);
      // Two brand-new hands: the one further right on screen gets slot 0.
      if (i === 0) openSlot = f.hands[0].x < 0.5 ? 0 : 1;
      expect(openSlot).toBe(1);
      expect(f.hands[1].x).toBeLessThan(0.5);
      expect(f.hands[0].x).toBeGreaterThan(0.5);
    }
    expect(f!.source).toBe('camera');
    expect(f!.hands[1].gesture).toBe('open');
    expect(f!.hands[0].gesture).toBe('fist');
    expect(f!.hands[1].handedness).toBe('Left');
    expect(f!.hands[0].handedness).toBe('Right');
  });

  it('a single hand keeps its slot when the other leaves; a newcomer takes the free slot', () => {
    const im = new InputManager({ video: fakeVideo, renderSmoothingMs: 0 });
    let t = 0;
    const step = (hands: RawHand[]) => { t += 33; im.ingestDetections(hands, t); return im.update(t); };
    let f = step([rawHandAt(0.3, 0.5, POSES.open)]);
    expect(f.hands[0].present).toBe(true);
    f = step([rawHandAt(0.3, 0.5, POSES.open), rawHandAt(0.7, 0.5, POSES.open)]);
    expect(f.hands[1].present).toBe(true);
    expect(f.hands[1].x).toBeGreaterThan(0.6);
    for (let i = 0; i < 8; i++) f = step([rawHandAt(0.7, 0.5, POSES.open)]); // slot 0 leaves (> grace)
    expect(f.hands[0].present).toBe(false);
    expect(f.hands[1].present).toBe(true);
    f = step([rawHandAt(0.7, 0.5, POSES.open), rawHandAt(0.2, 0.4, POSES.open)]);
    expect(f.hands[1].x).toBeGreaterThan(0.6);
    expect(f.hands[0].present).toBe(true);
    expect(f.hands[0].x).toBeLessThan(0.3);
  });

  it('pinch edges are true for exactly one update(), even at render rate > camera rate', () => {
    const im = new InputManager({ video: fakeVideo });
    let t = 0;
    const starts: number[] = [], ends: number[] = [];
    const amounts = [0, 0, 0, 0.5, 1, 1, 1, 1, 0.5, 0, 0, 0];
    let frame = 0;
    for (const a of amounts) {
      t += 33;
      im.ingestDetections([anchoredHand(0.5, 0.5, pinchPose(a))], t);
      for (let k = 0; k < 4; k++) { // 4 render frames per camera frame
        const f = im.update(t + k * 8);
        if (f.hands[0].pinchStart) starts.push(frame);
        if (f.hands[0].pinchEnd) ends.push(frame);
        frame++;
      }
    }
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toBeGreaterThan(starts[0]);
  });

  it('a hand lost mid-pinch emits a present frame with pinchEnd, then disappears', () => {
    const im = new InputManager({ video: fakeVideo });
    let t = 0;
    for (let i = 0; i < 4; i++) { t += 33; im.ingestDetections([rawHandAt(0.5, 0.5, POSES.pinch)], t); im.update(t); }
    const frames: HandState[] = [];
    for (let i = 0; i < 10; i++) { t += 33; im.ingestDetections([], t); frames.push(im.update(t).hands[0]); }
    // Within grace (~120 ms) still pinching.
    expect(frames[0].pinch).toBe(true);
    expect(frames[2].pinch).toBe(true);
    const endIdx = frames.findIndex((h) => h.pinchEnd);
    expect(endIdx).toBeGreaterThan(2);
    expect(frames[endIdx].present).toBe(true);
    expect(frames.filter((h) => h.pinchEnd)).toHaveLength(1);
    expect(frames[endIdx + 1].present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('InputManager.inject', () => {
  it('merges partial hands onto defaults', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.3, y: 0.4, fist: true }]);
    const f = im.update(0);
    expect(f.source).toBe('synthetic');
    const h = f.hands[0];
    expect(h.present).toBe(true);
    expect(h.slot).toBe(0);
    expect(h.gesture).toBe('fist');
    expect(h.landmarks).toHaveLength(21);
    expect(f.hands[1].present).toBe(false);
    im.inject([{ x: 0.3, y: 0.4, gesture: 'open' }]);
    expect(im.update(16).hands[0].open).toBe(true);
  });

  it('derives pinchStart / pinchEnd from consecutive pinch values, once each', () => {
    const im = new InputManager({ video: fakeVideo });
    const seq = [false, false, true, true, true, false, false];
    const log: [boolean, boolean][] = [];
    let t = 0;
    for (const pinch of seq) {
      im.inject([{ x: 0.5, y: 0.5, pinch }]);
      // Several update() calls per injected frame: edges still fire once.
      for (let k = 0; k < 3; k++) { const h = im.update((t += 16)).hands[0]; log.push([h.pinchStart, h.pinchEnd]); }
    }
    expect(log.filter(([s]) => s)).toHaveLength(1);
    expect(log.filter(([, e]) => e)).toHaveLength(1);
    expect(log.findIndex(([s]) => s)).toBe(6);
    expect(log.findIndex(([, e]) => e)).toBe(15);
  });

  it('honours explicit edge flags only on the first update after inject()', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.5, y: 0.5, pinch: true, pinchStart: false }]);
    expect(im.update(0).hands[0].pinchStart).toBe(false);
    im.inject([{ x: 0.5, y: 0.5, pinch: true, pinchStart: true }]);
    expect(im.update(16).hands[0].pinchStart).toBe(true);
    expect(im.update(32).hands[0].pinchStart).toBe(false);
  });

  it('keeps slots by position when injected order changes, and derives velocity', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]);
    let f = im.update(0);
    expect(f.hands[0].x).toBe(0.2);
    expect(f.hands[1].x).toBe(0.8);
    im.inject([{ x: 0.78, y: 0.5 }, { x: 0.25, y: 0.5 }]);
    f = im.update(100);
    expect(f.hands[0].x).toBe(0.25);
    expect(f.hands[1].x).toBe(0.78);
    expect(f.hands[0].vx).toBeCloseTo(0.5, 5);
    expect(f.hands[1].vx).toBeCloseTo(-0.2, 5);
    im.inject([{ slot: 1, x: 0.5, y: 0.5 }]);
    f = im.update(116);
    expect(f.hands[1].present).toBe(true);
    expect(f.hands[0].present).toBe(false);
  });

  it('inject(null) returns to the normal sources', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.5, y: 0.5, pinch: true }]);
    im.update(0);
    im.inject(null);
    const f = im.update(16);
    expect(f.source).not.toBe('synthetic');
    // The synthetic pinch is released cleanly.
    expect(f.hands[0].pinchEnd).toBe(true);
    expect(im.update(32).hands[0].present).toBe(false);
  });
});

describe('fake hand landmarks', () => {
  it('screen landmarks put the tip midpoint on the cursor', () => {
    const l = screenHandLandmarks(0.4, 0.6, POSES.pinch);
    expect(l).toHaveLength(21);
    expect((l[4].x + l[8].x) / 2).toBeCloseTo(0.4, 6);
    expect((l[4].y + l[8].y) / 2).toBeCloseTo(0.6, 6);
    expect(l[0].y).toBeGreaterThan(0.6); // wrist below the fingers
  });
});
