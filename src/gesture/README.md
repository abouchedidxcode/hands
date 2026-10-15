# Gesture engine

A reusable, game-agnostic engine that turns webcam hand landmarks (MediaPipe HandLandmarker) into
stable poses, continuous values and discrete gesture events. Nothing in here knows about GODHAND, so
the folder can be copied into the next hand-controlled game as-is (it only borrows
`input/oneEuro.ts` for smoothing and `input/gestures.ts` for the `RawHand` type).

Try every gesture live, run reliability tests and tune thresholds in the **Gesture Lab**:
`/lab.html` (deployed at `https://abouchedidxcode.github.io/hands/lab.html`).

## Quick start

```ts
import { HandTracker } from '../input/handTracker';
import { GestureEngine, fromMediaPipe } from '../gesture';

const tracker = new HandTracker(videoEl);
await tracker.start();
const engine = new GestureEngine();          // or new GestureEngine(configExportedFromTheLab)

engine.on('swipe-left', () => prevPage());
engine.on('fist', (e) => e.phase === 'start' ? grab(e.hand) : release(e.hand));
engine.on('clap', () => jump());

function loop(now: number) {
  requestAnimationFrame(loop);
  const det = tracker.detect(now);           // null when the camera has no new frame
  if (!det) return;
  const frame = engine.update(fromMediaPipe(det.hands, det.aspect), det.frameTime);
  for (const h of frame.hands) {
    cursor(h.id, h.features.center);         // palm centre, mirrored screen space 0..1
    setThrottle(h.pinch);                    // continuous 0..1
  }
  if (frame.twoHand.present) zoomTo(frame.twoHand.zoom);
}
requestAnimationFrame(loop);
```

## What it gives you

`engine.update(hands, t)` returns a `GestureFrame`:

| field | meaning |
| --- | --- |
| `hands[i].pose` | stable (debounced, hysteresis) pose id or `null` |
| `hands[i].scores` | raw 0..1 score of every pose this frame |
| `hands[i].heldMs` | how long the current pose has been held |
| `hands[i].features` | curl per finger, thumb out, pinch gaps, finger spread, palm facing, roll, pointing direction, palm centre, size (depth), openness |
| `hands[i].pinch`, `velocity` | continuous controls |
| `twoHand` | distance, angle and zoom ratio between two hands |
| `events` | everything that fired this frame (also delivered to `engine.on` listeners) |

Listen by event name (`'rock'`, `'circle-cw'`), by kind (`'pose'`, `'motion'`, `'two-hand'`) or `'*'`.

### Built-in poses (20)

open ✋, back of hand 🤚\*, karate chop 🔪\*, fist ✊, claw 🦅, point ☝️, middle finger 🖕, peace/V ✌️,
two together 🫸\*, three, four, thumbs up 👍, thumbs down 👎, rock on 🤘, call-me/shaka 🤙,
finger gun/L 👉, pinch 🤏, OK 👌, middle pinch 🫰, Vulcan salute 🖖\*

\* experimental: hidden when `config.pose.experimental = false`. Palm-vs-back poses depend on
MediaPipe's left/right label, which back-of-hand views can fool.

### Motions and two-hand gestures (21)

swipe left/right/up/down, push, pull, circle clockwise/anticlockwise, wave, shake,
twist clockwise/anticlockwise (doorknob), pinch tap, double pinch tap, throw (fist flung open),
hold (any pose kept still), clap, zoom in/out (two-hand pinch spread/squeeze),
steer left/right (two fists on a wheel).

## Adding your own

```ts
// a pose is just data: a rule per finger (thumb, index, middle, ring, pinky) + optional extra 0..1
engine.registerPose({
  id: 'pinky-up', name: 'Pinky up', emoji: '🫖', hint: 'Only the pinky out',
  fingers: ['curl', 'curl', 'curl', 'curl', 'ext'],
});

// a motion is a function over the hand's recent history (positions, size, roll, pose, pinch)
engine.registerMotion({
  id: 'flick-up', names: ['flick-up'],
  detect: ({ h, now }) => {
    const a = h[0], b = h[h.length - 1];
    return b.y - a.y < -0.15 && now - a.t < 200 ? { name: 'flick-up', reset: true } : null;
  },
});
```

Finger rules: `ext`, `curl`, `half`, `notcurl`, `notext`, `any`. Scoring is
√(geometric mean × worst rule), so one clearly wrong finger sinks a pose.

## How it works

1. **Smoothing:** One Euro filter per landmark (`config.smoothing`).
2. **Features:** finger curl comes from joint *angles* measured on MediaPipe world landmarks
   (metres). That makes it independent of where the hand is, how far away it is and how it's
   rotated.
3. **Poses:** every pose is scored every frame. The active pose switches only when a candidate
   passes `enter`, beats the current one by `margin` and persists for `debounceMs`. It ends below
   `exit`.
4. **Motions:** detectors run over a 1.6 s per-hand history, with per-detector cooldowns.
5. **Two hands:** clap, zoom and steering, from the distance and angle between palm centres.

All thresholds live in `EngineConfig`. Tune them live in the lab and export the JSON.

## Testing

* `tests/gestureEngine.test.ts`: synthetic hands for every pose (both hands, any position and
  scale), debouncing, every motion and two-hand gesture, and a no-false-positives jitter test.
* `scripts/lab-photos.mjs`: real hand photos as fake webcams, run through real MediaPipe and the
  engine in the lab (headless Chromium).
