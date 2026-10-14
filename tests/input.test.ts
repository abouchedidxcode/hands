import { describe, expect, it } from 'vitest';
import { OneEuroFilter, OneEuroFilter2D } from '../src/input/oneEuro';
import {
  assignSlots, classifyGesture, DEFAULT_GESTURE, DEFAULT_MAPPING, fromScreen, GestureDebouncer, grabStrengthOf,
  HandProcessor, isMiddle, LM, mapLandmarks, measureHand, nextGrab, rawCursor, toScreen, userHandedness,
  type RawHand,
} from '../src/input/gestures';
import { POSES, rawHandAt, screenHandLandmarks, type FakeHandOpts, type HandPose } from '../src/input/fakeHand';
import { InputManager } from '../src/input/inputManager';
import type { Gesture, HandState, InputFrame, Landmark } from '../src/input/types';

const ASPECT = 16 / 9;
const KNUCKLES = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];

const metricsOf = (h: RawHand, aspect = ASPECT) => measureHand(h.landmarks, aspect);
/** Instantaneous classification of one detection (grab hysteresis state given). */
const classify = (h: RawHand, grabActive = false, aspect = ASPECT): Gesture => {
  const m = metricsOf(h, aspect);
  return classifyGesture(m, nextGrab(grabActive, m));
};
const grabs = (pose: HandPose, o: FakeHandOpts = {}, active = false) =>
  nextGrab(active, metricsOf(rawHandAt(0.5, 0.5, pose, o), o.aspect ?? ASPECT));

/** All four fingers curled by `c` (0 = straight, 1 = fist); thumb curl `thumb`. */
const curlPose = (c: number, thumb = c): HandPose => ({ curl: [thumb, c, c, c, c], pinch: 0 });

/** A hand whose WRIST stays fixed at the position of an open hand at (sx, sy) while the pose changes. */
function anchoredHand(sx: number, sy: number, pose: HandPose): RawHand {
  const ref = rawHandAt(sx, sy, POSES.open).landmarks[0];
  const h = rawHandAt(sx, sy, pose);
  const w = h.landmarks[0];
  h.landmarks = h.landmarks.map((l) => ({ x: l.x - w.x + ref.x, y: l.y - w.y + ref.y, z: l.z }));
  return h;
}

const centroid = (l: Landmark[] | { x: number; y: number }[], idx = KNUCKLES) => ({
  x: idx.reduce((a, i) => a + l[i].x, 0) / idx.length,
  y: idx.reduce((a, i) => a + l[i].y, 0) / idx.length,
});

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
    expect(m).toMatchObject({ x0: 0.2, x1: 0.8, y0: 0.16, y1: 0.76 });
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

  it('places the raw cursor at the knuckle centroid in screen space, for any pose', () => {
    for (const pose of [POSES.open, POSES.fist, POSES.middle, POSES.point]) {
      const h = rawHandAt(0.25, 0.6, pose);
      const c = rawCursor(h.landmarks);
      expect(c.x).toBeCloseTo(0.25, 5);
      expect(c.y).toBeCloseTo(0.6, 5);
      const sl = mapLandmarks(h.landmarks);
      expect(sl).toHaveLength(21);
      const k = centroid(sl);
      expect(k.x).toBeCloseTo(0.25, 5);
      expect(k.y).toBeCloseTo(0.6, 5);
    }
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
  const variants: { name: string; o: FakeHandOpts }[] = [
    { name: 'right', o: {} },
    { name: 'left', o: { handedness: 'Left' } },
    { name: 'small/far', o: { scale: 0.09 } },
    { name: '4:3 camera', o: { aspect: 4 / 3 } },
    { name: 'rotated ccw', o: {} },
  ];
  for (const v of variants) {
    const roll = v.name === 'rotated ccw' ? 0.5 : undefined;
    const at = (pose: HandPose) => rawHandAt(0.5, 0.5, roll ? { ...pose, roll } : pose, v.o);
    const a = v.o.aspect ?? ASPECT;
    it(`classifies open / grab / middle / point (${v.name})`, () => {
      expect(classify(at(POSES.open), false, a)).toBe('open');
      expect(classify(at(POSES.fist), false, a)).toBe('grab');
      expect(classify(at(POSES.middle), false, a)).toBe('middle');
      expect(classify(at(POSES.point), false, a)).toBe('point');
      expect(nextGrab(false, metricsOf(at(POSES.open), a))).toBe(false);
      expect(nextGrab(false, metricsOf(at(POSES.fist), a))).toBe(true);
    });
  }

  it('is rotation tolerant', () => {
    for (const roll of [-0.6, 0.5, 1.2]) {
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.open, roll }))).toBe('open');
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.fist, roll }))).toBe('grab');
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.middle, roll }))).toBe('middle');
      expect(classify(rawHandAt(0.5, 0.5, { ...POSES.point, roll }))).toBe('point');
    }
  });

  it('a fist grabs whatever the thumb does', () => {
    for (const thumb of [0, 0.5, 1]) {
      expect(grabs(curlPose(1, thumb)), `thumb ${thumb}`).toBe(true);
      expect(grabs(curlPose(0.7, thumb)), `loose fist, thumb ${thumb}`).toBe(true);
    }
  });

  it('the middle-finger salute is "middle" and never a grab (thumb tucked, half-raised or out)', () => {
    const poses: HandPose[] = [
      POSES.middle,
      { curl: [0.4, 1, 0, 1, 1], pinch: 0 },      // thumb half raised
      { curl: [0, 1, 0, 1, 1], pinch: 0 },        // thumb out
      { curl: [0.7, 0.75, 0.1, 0.8, 0.8], pinch: 0 }, // sloppy: others loosely curled, middle slightly bent
    ];
    for (const pose of poses) {
      for (const o of [{}, { handedness: 'Left' as const }, { scale: 0.09 }]) {
        const m = metricsOf(rawHandAt(0.5, 0.5, pose, o));
        expect(isMiddle(m), JSON.stringify(pose.curl)).toBe(true);
        expect(nextGrab(false, m)).toBe(false);
        // Even from a held grab: raising the middle finger releases it.
        expect(nextGrab(true, m)).toBe(false);
        expect(classifyGesture(m, nextGrab(false, m))).toBe('middle');
      }
    }
  });

  it('pointing is not a grab, even though three fingers are curled', () => {
    const m = metricsOf(rawHandAt(0.5, 0.5, POSES.point));
    expect(m.curledCount).toBeGreaterThanOrEqual(3); // the trap
    expect(nextGrab(false, m)).toBe(false);
    expect(nextGrab(true, m)).toBe(false); // extending the index releases a held grab
    expect(classifyGesture(m, false)).toBe('point');
  });

  it('a relaxed / half-curled hand does not grab', () => {
    expect(grabs(POSES.relaxed)).toBe(false);
    expect(classify(rawHandAt(0.5, 0.5, POSES.relaxed))).not.toBe('grab');
    for (const c of [0.3, 0.4, 0.5]) {
      for (const thumb of [0, 0.5]) expect(grabs(curlPose(c, thumb)), `curl ${c}`).toBe(false);
    }
    expect(grabs(POSES.pinch)).toBe(false);
  });

  it('grab strength rises from ~0 (open) to 1 (fist) as the hand closes', () => {
    const s = [0, 0.25, 0.5, 0.75, 1].map((c) => grabStrengthOf(metricsOf(rawHandAt(0.5, 0.5, curlPose(c)))));
    expect(s[0]).toBeLessThan(0.25);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1]);
    expect(s[4]).toBe(1);
    for (const v of s) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
});

// ---------------------------------------------------------------------------
describe('grab hysteresis', () => {
  it('turns on only when clearly closed, and off only when clearly opened', () => {
    let on = false;
    const seq: [number, boolean][] = [
      [0, false], [0.4, false], [0.5, false], [1, true], [0.6, true], [0.4, true], [0.5, true],
      [0.2, false], [0.4, false], [0.5, false], [0.8, true], [0, false],
    ];
    for (const [c, want] of seq) {
      on = nextGrab(on, metricsOf(rawHandAt(0.5, 0.5, curlPose(c, 0.5))));
      expect(on, `curl ${c}`).toBe(want);
    }
  });

  it('loosening a held fist slightly keeps the grab', () => {
    for (const c of [0.8, 0.6, 0.45, 0.4]) expect(grabs(curlPose(c, 0.6), {}, true), `curl ${c}`).toBe(true);
    // ... but those loose poses would not START a grab.
    expect(grabs(curlPose(0.45, 0.6))).toBe(false);
    // Opening fully releases.
    expect(grabs(POSES.open, {}, true)).toBe(false);
    expect(grabs(POSES.relaxed, {}, true)).toBe(false);
  });

  it('does not chatter when the hand hovers around the on-threshold (processor)', () => {
    const p = new HandProcessor();
    let t = 0, toggles = 0, last = false;
    const curls = [0, 0, 0.3, 0.45, 0.5, 0.6, 0.5, 0.56, 0.47, 0.58, 0.5, 0.55, 0.45, 0.6, 0.42, 0.55];
    for (const c of curls) {
      t += 33;
      p.update(anchoredHand(0.5, 0.5, curlPose(c, 0.5)), t);
      if (p.grab !== last) { toggles++; last = p.grab; }
    }
    expect(toggles).toBe(1);
    expect(p.grab).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('gesture debounce', () => {
  it('ignores single-frame flicker but follows real changes within ~2 frames', () => {
    const d = new GestureDebouncer();
    let t = 0;
    const push = (g: Gesture) => d.push(g, (t += 33));
    push('open'); push('open'); push('open');
    expect(d.stable).toBe('open');
    push('point'); // single bad frame
    push('open');
    expect(d.stable).toBe('open');
    push('none'); push('none'); // brief transitional frames
    expect(d.stable).toBe('open');
    push('middle');
    expect(d.stable).toBe('open');
    push('middle');
    expect(d.stable).toBe('middle'); // open → middle in 2 frames (smite)
  });

  it('grab bypasses the debounce, and leaving it drops to none at once', () => {
    const d = new GestureDebouncer();
    d.push('open', 0); d.push('open', 40);
    expect(d.stable).toBe('open');
    expect(d.push('grab', 80)).toBe('grab');
    expect(d.push('open', 120)).toBe('none');
    expect(d.push('open', 160)).toBe('open');
  });

  it('a single grab frame inside an open stream still registers immediately', () => {
    const d = new GestureDebouncer();
    for (let i = 0; i < 4; i++) d.push('open', i * 33);
    expect(d.push('grab', 140)).toBe('grab');
  });
});

// ---------------------------------------------------------------------------
describe('HandProcessor', () => {
  it('cursor stays put when the hand closes into a fist in place (knuckle cursor)', () => {
    const p = new HandProcessor();
    let t = 0;
    let cursorMax = 0;
    const ref = { x: 0, y: 0 };
    const seq = [...Array(10).fill(0), 0.2, 0.45, 0.7, 0.9, 1, 1, 1, 1, 1, 0.6, 0.3, 0, ...Array(10).fill(0)];
    let grabbed = false;
    seq.forEach((c, i) => {
      t += 33;
      const h = anchoredHand(0.5, 0.5, curlPose(c));
      p.update(h, t);
      grabbed ||= p.grab;
      if (i === 9) { ref.x = p.x; ref.y = p.y; }
      if (i >= 10) cursorMax = Math.max(cursorMax, Math.hypot(p.x - ref.x, p.y - ref.y));
    });
    expect(grabbed).toBe(true);
    expect(p.grab).toBe(false);
    expect(cursorMax).toBeLessThan(0.02);
    // Sanity: a fingertip-based (thumb/index midpoint) cursor would have jumped a lot.
    const tl0 = anchoredHand(0.5, 0.5, POSES.open).landmarks, tl1 = anchoredHand(0.5, 0.5, POSES.fist).landmarks;
    const tipOf = (l: typeof tl0) => toScreen((l[LM.THUMB_TIP].x + l[LM.INDEX_TIP].x) / 2, (l[LM.THUMB_TIP].y + l[LM.INDEX_TIP].y) / 2);
    expect(Math.hypot(tipOf(tl0).x - tipOf(tl1).x, tipOf(tl0).y - tipOf(tl1).y)).toBeGreaterThan(0.1);
  });

  it('cursor stays put when flipping the middle finger in place', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 10; i++) p.update(anchoredHand(0.4, 0.6, POSES.open), (t += 33));
    const ref = { x: p.x, y: p.y };
    let max = 0;
    for (let i = 0; i < 10; i++) {
      p.update(anchoredHand(0.4, 0.6, POSES.middle), (t += 33));
      max = Math.max(max, Math.hypot(p.x - ref.x, p.y - ref.y));
      expect(p.grab).toBe(false);
    }
    expect(max).toBeLessThan(0.02);
    expect(p.snapshot().middle).toBe(true);
    expect(p.gesture).toBe('middle');
  });

  it('grab registers on the first fist frame; point / middle need the debounce', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 4; i++) p.update(rawHandAt(0.5, 0.5, POSES.open), (t += 33));
    expect(p.gesture).toBe('open');
    p.update(rawHandAt(0.5, 0.5, POSES.fist), (t += 33));
    expect(p.grab).toBe(true);
    expect(p.gesture).toBe('grab');
    // Fist → middle finger: grab ends at once, 'middle' follows within ~2 frames.
    p.update(rawHandAt(0.5, 0.5, POSES.middle), (t += 33));
    expect(p.grab).toBe(false);
    p.update(rawHandAt(0.5, 0.5, POSES.middle), (t += 33));
    p.update(rawHandAt(0.5, 0.5, POSES.middle), (t += 33));
    expect(p.gesture).toBe('middle');
    for (let i = 0; i < 3; i++) p.update(rawHandAt(0.5, 0.5, POSES.point), (t += 33));
    expect(p.gesture).toBe('point');
    expect(p.grab).toBe(false);
  });

  it('follows the hand while grabbing', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 5; i++) p.update(rawHandAt(0.3, 0.5, POSES.fist), (t += 33));
    expect(p.grab).toBe(true);
    for (let i = 0; i <= 30; i++) p.update(rawHandAt(0.3 + i * 0.01, 0.5, POSES.fist), (t += 33));
    expect(p.grab).toBe(true);
    expect(p.x).toBeGreaterThan(0.55);
    expect(p.x).toBeLessThan(0.61);
    expect(p.vx).toBeGreaterThan(0.2); // ≈ 0.3 screen/s
    expect(p.vx).toBeLessThan(0.4);
    expect(p.grabStrength).toBe(1);
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
    // Visual landmarks are anchored on the cursor (knuckle centroid).
    const k = centroid(p.landmarks);
    expect(k.x).toBeCloseTo(1, 5);
    expect(k.y).toBeCloseTo(0, 5);
  });

  it('keeps a grab alive through a short dropout (grace) and drops it after', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 4; i++) p.update(rawHandAt(0.5, 0.5, POSES.fist), (t += 33));
    expect(p.grab).toBe(true);
    expect(p.miss(t + 40)).toBe(true);
    expect(p.miss(t + 100)).toBe(true);
    expect(p.grab).toBe(true);
    p.update(rawHandAt(0.5, 0.5, POSES.fist), t + 110);
    expect(p.grab).toBe(true);
    t += 110;
    expect(p.miss(t + 100)).toBe(true);
    expect(p.miss(t + 200)).toBe(false);
    expect(p.present).toBe(false);
    expect(p.grab).toBe(false);
    expect(p.snapshot().grabStrength).toBe(0);
  });

  it('a hand re-acquired after a long gap does not inherit the old grab', () => {
    const p = new HandProcessor();
    let t = 0;
    for (let i = 0; i < 4; i++) p.update(rawHandAt(0.5, 0.5, POSES.fist), (t += 33));
    expect(p.grab).toBe(true);
    // Loosely closed (would keep a held grab, but cannot start one) after > reacquireMs.
    p.update(rawHandAt(0.5, 0.5, curlPose(0.45)), t + DEFAULT_GESTURE.reacquireMs + 50);
    expect(p.grab).toBe(false);
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
    expect(f!.hands[1].grab).toBe(false);
    expect(f!.hands[0].gesture).toBe('grab');
    expect(f!.hands[0].grab).toBe(true);
    expect(f!.hands[1].handedness).toBe('Left');
    expect(f!.hands[0].handedness).toBe('Right');
  });

  it('a hand that closes into a fist is matched to its own slot (raw cursor = processor cursor)', () => {
    const im = new InputManager({ video: fakeVideo, renderSmoothingMs: 0 });
    let t = 0;
    const step = (hands: RawHand[]) => { t += 33; im.ingestDetections(hands, t); return im.update(t); };
    let f = step([rawHandAt(0.35, 0.5, POSES.open), rawHandAt(0.65, 0.5, POSES.open, { handedness: 'Left' })]);
    const s0x = f.hands[0].x;
    for (let i = 0; i < 6; i++) {
      f = step([rawHandAt(0.35, 0.5, POSES.fist), rawHandAt(0.65, 0.5, POSES.middle, { handedness: 'Left' })]);
    }
    expect(f.hands[0].x).toBeCloseTo(s0x, 2);
    const fist = f.hands.find((h) => h.grab)!;
    const mid = f.hands.find((h) => h.middle)!;
    expect(fist.x).toBeCloseTo(0.35, 2);
    expect(mid.x).toBeCloseTo(0.65, 2);
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

  it('grab edges are true for exactly one update(), even at render rate > camera rate', () => {
    const im = new InputManager({ video: fakeVideo });
    let t = 0;
    const starts: number[] = [], ends: number[] = [];
    const curls = [0, 0, 0, 0.5, 1, 1, 1, 1, 0.5, 0, 0, 0];
    let frame = 0;
    for (const c of curls) {
      t += 33;
      im.ingestDetections([anchoredHand(0.5, 0.5, curlPose(c))], t);
      for (let k = 0; k < 4; k++) { // 4 render frames per camera frame
        const h = im.update(t + k * 8).hands[0];
        if (h.grabStart) { starts.push(frame); expect(h.grab).toBe(true); }
        if (h.grabEnd) { ends.push(frame); expect(h.grab).toBe(false); }
        frame++;
      }
    }
    expect(starts).toEqual([16]); // first fully-closed camera frame
    expect(ends).toHaveLength(1);
    expect(ends[0]).toBe(36); // held through the half-open frame, released when open
  });

  it('a hand lost mid-grab emits a present frame with grabEnd, then disappears', () => {
    const im = new InputManager({ video: fakeVideo });
    let t = 0;
    for (let i = 0; i < 4; i++) { t += 33; im.ingestDetections([rawHandAt(0.5, 0.5, POSES.fist)], t); im.update(t); }
    const frames: HandState[] = [];
    for (let i = 0; i < 10; i++) { t += 33; im.ingestDetections([], t); frames.push(im.update(t).hands[0]); }
    // Within grace (~120 ms) still grabbing.
    expect(frames[0].grab).toBe(true);
    expect(frames[2].grab).toBe(true);
    const endIdx = frames.findIndex((h) => h.grabEnd);
    expect(endIdx).toBeGreaterThan(2);
    expect(frames[endIdx].present).toBe(true);
    expect(frames[endIdx].grab).toBe(false);
    expect(frames.filter((h) => h.grabEnd)).toHaveLength(1);
    expect(frames.filter((h) => h.grabStart)).toHaveLength(0);
    expect(frames[endIdx + 1].present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('InputManager.inject', () => {
  it('merges partial hands onto defaults', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.3, y: 0.4, grab: true }]);
    const f = im.update(0);
    expect(f.source).toBe('synthetic');
    const h = f.hands[0];
    expect(h.present).toBe(true);
    expect(h.slot).toBe(0);
    expect(h.gesture).toBe('grab');
    expect(h.grabStrength).toBe(1);
    expect(h.grabStart).toBe(true);
    expect(h.landmarks).toHaveLength(21);
    expect(f.hands[1].present).toBe(false);
    im.inject([{ x: 0.3, y: 0.4, gesture: 'open' }]);
    const h2 = im.update(16).hands[0];
    expect(h2.open).toBe(true);
    expect(h2.grab).toBe(false);
    expect(h2.grabEnd).toBe(true);
    im.inject([{ x: 0.3, y: 0.4, gesture: 'middle' }]);
    const h3 = im.update(32).hands[0];
    expect(h3.middle).toBe(true);
    expect(h3.grab).toBe(false);
    im.inject([{ x: 0.3, y: 0.4, middle: true }]);
    expect(im.update(48).hands[0].gesture).toBe('middle');
  });

  it('generated landmarks match the injected gesture', () => {
    const im = new InputManager({ video: fakeVideo });
    for (const [g, want] of [['grab', 'grab'], ['middle', 'middle'], ['open', 'open'], ['point', 'point']] as const) {
      im.inject([{ x: 0.5, y: 0.5, gesture: g }]);
      const l = im.update(0).hands[0].landmarks;
      // Screen landmarks → metrics (aspect 1: screenHandLandmarks already divides x by the aspect).
      const m = measureHand(l.map((p) => ({ x: p.x * ASPECT, y: p.y, z: p.z })), 1);
      expect(classifyGesture(m, nextGrab(false, m)), g).toBe(want);
      const k = centroid(l);
      expect(k.x).toBeCloseTo(0.5, 6);
      expect(k.y).toBeCloseTo(0.5, 6);
    }
  });

  it('derives grabStart / grabEnd from consecutive grab values, once each', () => {
    const im = new InputManager({ video: fakeVideo });
    const seq = [false, false, true, true, true, false, false];
    const log: [boolean, boolean][] = [];
    let t = 0;
    for (const grab of seq) {
      im.inject([{ x: 0.5, y: 0.5, grab }]);
      // Several update() calls per injected frame: edges still fire once.
      for (let k = 0; k < 3; k++) { const h = im.update((t += 16)).hands[0]; log.push([h.grabStart, h.grabEnd]); }
    }
    expect(log.filter(([s]) => s)).toHaveLength(1);
    expect(log.filter(([, e]) => e)).toHaveLength(1);
    expect(log.findIndex(([s]) => s)).toBe(6);
    expect(log.findIndex(([, e]) => e)).toBe(15);
  });

  it('honours explicit edge flags only on the first update after inject()', () => {
    const im = new InputManager({ video: fakeVideo });
    im.inject([{ x: 0.5, y: 0.5, grab: true, grabStart: false }]);
    expect(im.update(0).hands[0].grabStart).toBe(false);
    im.inject([{ x: 0.5, y: 0.5, grab: true, grabStart: true }]);
    expect(im.update(16).hands[0].grabStart).toBe(true);
    expect(im.update(32).hands[0].grabStart).toBe(false);
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
    im.inject([{ x: 0.5, y: 0.5, grab: true }]);
    im.update(0);
    im.inject(null);
    const f = im.update(16);
    expect(f.source).not.toBe('synthetic');
    // The synthetic grab is released cleanly.
    expect(f.hands[0].grabEnd).toBe(true);
    expect(f.hands[0].grab).toBe(false);
    expect(im.update(32).hands[0].present).toBe(false);
  });
});

describe('fake hand landmarks', () => {
  it('screen landmarks put the knuckle centroid on the cursor', () => {
    for (const pose of Object.values(POSES)) {
      const l = screenHandLandmarks(0.4, 0.6, pose);
      expect(l).toHaveLength(21);
      const k = centroid(l);
      expect(k.x).toBeCloseTo(0.4, 6);
      expect(k.y).toBeCloseTo(0.6, 6);
      expect(l[0].y).toBeGreaterThan(0.6); // wrist below the knuckles
    }
  });

  it('the knuckles do not move when the fingers curl', () => {
    const a = rawHandAt(0.5, 0.5, POSES.open).landmarks, b = rawHandAt(0.5, 0.5, POSES.fist).landmarks;
    for (const i of [LM.WRIST, ...KNUCKLES]) {
      expect(b[i].x).toBeCloseTo(a[i].x, 9);
      expect(b[i].y).toBeCloseTo(a[i].y, 9);
    }
  });
});
