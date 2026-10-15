import { describe, expect, it } from 'vitest';
import { screenHandLandmarks, type HandPose } from '../src/input/fakeHand';
import { computeFeatures, GestureEngine, POSES, scorePose, type GestureEvent, type HandInput } from '../src/gesture';

const P: Record<string, HandPose> = {
  open: { curl: [0, 0, 0, 0, 0], pinch: 0 },
  fist: { curl: [1, 1, 1, 1, 1], pinch: 0 },
  point: { curl: [1, 0, 1, 1, 1], pinch: 0 },
  middle: { curl: [1, 1, 0, 1, 1], pinch: 0 },
  victory: { curl: [1, 0, 0, 1, 1], pinch: 0, spread: 3 },
  three: { curl: [1, 0, 0, 0, 1], pinch: 0 },
  four: { curl: [1, 0, 0, 0, 0], pinch: 0 },
  rock: { curl: [1, 0, 1, 1, 0], pinch: 0 },
  shaka: { curl: [0, 1, 1, 1, 0], pinch: 0 },
  gun: { curl: [0, 0, 1, 1, 1], pinch: 0 },
  'thumbs-up': { curl: [0, 1, 1, 1, 1], pinch: 0, roll: -Math.PI / 2 },
  'thumbs-down': { curl: [0, 1, 1, 1, 1], pinch: 0, roll: Math.PI / 2 },
  pinch: { curl: [0, 0.5, 0.35, 0.4, 0.45], pinch: 1 },
  ok: { curl: [0, 0.5, 0, 0, 0], pinch: 1 },
  claw: { curl: [0.4, 0.45, 0.45, 0.45, 0.45], pinch: 0 },
};

const hand = (x: number, y: number, pose: HandPose, o: { hd?: 'Left' | 'Right'; scale?: number; roll?: number } = {}): HandInput => ({
  landmarks: screenHandLandmarks(x, y, o.roll !== undefined ? { ...pose, roll: o.roll } : pose, { handedness: o.hd ?? 'Right', scale: o.scale ?? 0.2 }),
  handedness: o.hd ?? 'Right',
  aspect: 16 / 9,
});

function best(h: HandInput) {
  const f = computeFeatures(h);
  return POSES.map((p) => [p.id, scorePose(p, f)] as const).sort((a, b) => b[1] - a[1])[0];
}

/** Runs the engine over a scripted clip at 30 fps and returns every event. */
function run(script: (t: number) => HandInput[], ms: number, engine = new GestureEngine()) {
  const events: GestureEvent[] = [];
  for (let t = 0; t <= ms; t += 1000 / 30) events.push(...engine.update(script(t), t).events);
  return events;
}
const names = (ev: GestureEvent[], kind?: string) => ev.filter((e) => !kind || e.kind === kind).map((e) => e.name);

describe('gesture engine: poses', () => {
  for (const [id, pose] of Object.entries(P)) {
    for (const hd of ['Right', 'Left'] as const) {
      it(`recognises ${id} (${hd} hand)`, () => {
        const [top, s] = best(hand(0.5, 0.5, pose, { hd }));
        expect(top).toBe(id);
        expect(s).toBeGreaterThan(0.75);
      });
    }
  }

  it('is unaffected by where the hand is or how big it looks', () => {
    for (const [x, y, sc] of [[0.2, 0.3, 0.12], [0.8, 0.7, 0.3]] as const) {
      expect(best(hand(x, y, P.rock, { scale: sc }))[0]).toBe('rock');
      expect(best(hand(x, y, P.fist, { scale: sc }))[0]).toBe('fist');
    }
  });

  it('emits pose start after the debounce and end when the hand leaves', () => {
    const ev = run((t) => (t < 500 ? [hand(0.5, 0.5, P.fist)] : []), 900);
    const pose = ev.filter((e) => e.kind === 'pose');
    expect(pose.map((e) => `${e.name}:${e.phase}`)).toEqual(['fist:start', 'fist:end']);
    expect(pose[0].t).toBeGreaterThanOrEqual(60);
  });

  it('does not flicker on a single bad frame', () => {
    const ev = run((t) => [hand(0.5, 0.5, Math.abs(t - 300) < 20 ? P.open : P.fist)], 700);
    expect(names(ev, 'pose')).toEqual(['fist']);
  });

  it('switches pose cleanly', () => {
    const ev = run((t) => [hand(0.5, 0.5, t < 400 ? P.fist : P.point)], 800);
    expect(ev.filter((e) => e.kind === 'pose').map((e) => `${e.name}:${e.phase}`)).toEqual(['fist:start', 'fist:end', 'point:start']);
  });

  it('accepts custom poses', () => {
    const engine = new GestureEngine();
    engine.registerPose({ id: 'pinky-up', name: 'Pinky up', emoji: '🫖', hint: '', fingers: ['curl', 'curl', 'curl', 'curl', 'ext'] });
    const ev = run(() => [hand(0.5, 0.5, { curl: [1, 1, 1, 1, 0], pinch: 0 })], 400, engine);
    expect(names(ev, 'pose')).toContain('pinky-up');
  });
});

describe('gesture engine: motions', () => {
  const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));

  for (const [name, x0, y0, x1, y1] of [
    ['swipe-left', 0.75, 0.5, 0.25, 0.5], ['swipe-right', 0.25, 0.5, 0.75, 0.5],
    ['swipe-up', 0.5, 0.75, 0.5, 0.3], ['swipe-down', 0.5, 0.3, 0.5, 0.75],
  ] as const) {
    it(name, () => {
      const ev = run((t) => [hand(lerp(x0, x1, (t - 200) / 250), lerp(y0, y1, (t - 200) / 250), P.open)], 900);
      expect(names(ev, 'motion').filter((n) => n.startsWith('swipe'))).toEqual([name]);
    });
  }

  it('slow drifting is not a swipe', () => {
    const ev = run((t) => [hand(lerp(0.3, 0.7, t / 3000), 0.5, P.open)], 3000);
    expect(names(ev, 'motion').filter((n) => n.startsWith('swipe'))).toEqual([]);
  });

  it('push and pull', () => {
    const push = run((t) => [hand(0.5, 0.5, P.open, { scale: lerp(0.15, 0.24, (t - 200) / 300) })], 900);
    expect(names(push, 'motion')).toContain('push');
    const pull = run((t) => [hand(0.5, 0.5, P.open, { scale: lerp(0.24, 0.15, (t - 200) / 300) })], 900);
    expect(names(pull, 'motion')).toContain('pull');
  });

  it('circles, both ways (clockwise as seen on screen)', () => {
    const circ = (dir: number) => (t: number) => {
      const a = dir * (t / 1000) * 2 * Math.PI;
      return [hand(0.5 + 0.1 * Math.cos(a), 0.5 + 0.1 * Math.sin(a), P.point)];
    };
    expect(names(run(circ(1), 1400), 'motion')).toContain('circle-cw');
    expect(names(run(circ(-1), 1400), 'motion')).toContain('circle-ccw');
  });

  it('wave and shake', () => {
    const wave = run((t) => [hand(0.5 + 0.08 * Math.sin((t / 1000) * 2 * Math.PI * 2.5), 0.5, P.open)], 1400);
    expect(names(wave, 'motion')).toContain('wave');
    const shake = run((t) => [hand(0.5, 0.5 + 0.08 * Math.sin((t / 1000) * 2 * Math.PI * 2.5), P.fist)], 1400);
    expect(names(shake, 'motion')).toContain('shake');
  });

  it('twist (roll) both ways', () => {
    const tw = (dir: number) => run((t) => [hand(0.5, 0.5, P.fist, { roll: dir * lerp(0, 1.2, (t - 200) / 350) })], 900);
    const cw = names(tw(1), 'motion').filter((n) => n.startsWith('twist'));
    const ccw = names(tw(-1), 'motion').filter((n) => n.startsWith('twist'));
    expect(cw).toHaveLength(1);
    expect(ccw).toHaveLength(1);
    expect(cw[0]).not.toBe(ccw[0]);
  });

  it('tap and double tap', () => {
    const tapAt = (starts: number[]) => (t: number) => [hand(0.5, 0.5, starts.some((s) => t >= s && t < s + 150) ? P.pinch : P.open)];
    const taps = (ev: GestureEvent[]) => names(ev, 'motion').filter((n) => n !== 'hold');
    expect(taps(run(tapAt([300]), 900))).toEqual(['tap']);
    expect(taps(run(tapAt([300, 600]), 1200))).toEqual(['tap', 'double-tap']);
    // a long pinch is a hold, not a tap
    expect(names(run((t) => [hand(0.5, 0.5, t > 200 && t < 1400 ? P.pinch : P.open)], 1800), 'motion')).not.toContain('tap');
  });

  it('throw: fist that flings open while moving', () => {
    const ev = run((t) => [hand(lerp(0.3, 0.75, (t - 400) / 250), 0.5, t < 520 ? P.fist : P.open)], 1000);
    expect(names(ev, 'motion')).toContain('throw');
  });

  it('a still hand with tracking jitter triggers nothing', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (const pose of [P.open, P.fist, P.point, P.pinch]) {
      const ev = run(() => [hand(0.5 + rnd() * 0.012, 0.5 + rnd() * 0.012, pose, { scale: 0.2 * (1 + rnd() * 0.04), roll: rnd() * 0.06 })], 4000);
      expect(names(ev, 'motion').filter((n) => n !== 'hold')).toEqual([]);
    }
  });

  it('a throw is not also a swipe', () => {
    const ev = run((t) => [hand(lerp(0.3, 0.75, (t - 400) / 250), 0.5, t < 520 ? P.fist : P.open)], 1000);
    expect(names(ev, 'motion').filter((n) => n !== 'hold')).toEqual(['throw']);
  });

  it('hold fires once per pose', () => {
    const ev = run(() => [hand(0.5, 0.5, P.rock)], 2500);
    expect(ev.filter((e) => e.name === 'hold')).toHaveLength(1);
    expect(ev.find((e) => e.name === 'hold')?.data?.pose).toBe('rock');
  });
});

describe('gesture engine: two hands', () => {
  const two = (xl: number, yl: number, xr: number, yr: number, pose: HandPose, pose2 = pose) =>
    [hand(xl, yl, pose, { hd: 'Left' }), hand(xr, yr, pose2, { hd: 'Right' })];
  const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));

  it('clap', () => {
    const ev = run((t) => { const d = lerp(0.25, 0, (t - 200) / 200); return two(0.5 - d, 0.5, 0.5 + d, 0.5, P.open); }, 700);
    expect(names(ev, 'two-hand')).toEqual(['clap']);
    // neither hand counts as swiping on its own
    expect(names(ev, 'motion').filter((n) => n.startsWith('swipe'))).toEqual([]);
  });

  it('zoom in and out with both hands pinching', () => {
    const zin = run((t) => { const d = lerp(0.08, 0.25, (t - 300) / 400); return two(0.5 - d, 0.5, 0.5 + d, 0.5, P.pinch); }, 1000);
    expect(names(zin, 'two-hand')).toContain('zoom-in');
    expect(names(zin, 'motion').filter((n) => n.startsWith('swipe'))).toEqual([]);
    const zout = run((t) => { const d = lerp(0.25, 0.08, (t - 300) / 400); return two(0.5 - d, 0.5, 0.5 + d, 0.5, P.pinch); }, 1000);
    expect(names(zout, 'two-hand')).toContain('zoom-out');
  });

  it('steering wheel with two fists', () => {
    const steer = (dir: number) => run((t) => {
      const a = dir * lerp(0, 0.9, (t - 300) / 400);
      return two(0.5 - 0.2 * Math.cos(a), 0.5 - 0.2 * Math.sin(a), 0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), P.fist);
    }, 1000);
    expect(names(steer(1), 'two-hand')).toContain('steer-right');
    expect(names(steer(-1), 'two-hand')).toContain('steer-left');
  });

  it('keeps two hands apart as separate ids', () => {
    const engine = new GestureEngine();
    let f = engine.update([], 0);
    for (let t = 0; t < 500; t += 33) f = engine.update(two(0.3, 0.5, 0.7, 0.5, P.fist, P.point), t);
    expect(f.hands).toHaveLength(2);
    const byX = [...f.hands].sort((a, b) => a.features.center.x - b.features.center.x);
    expect(byX.map((h) => h.pose)).toEqual(['fist', 'point']);
  });
});
