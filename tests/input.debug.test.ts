import { test } from 'vitest';
import { measureHand, classifyGesture, nextPinch } from '../src/input/gestures';
import { rawHandAt, POSES } from '../src/input/fakeHand';
test('dbg', () => {
  for (const [k, p] of Object.entries(POSES)) {
    const r = rawHandAt(0.5, 0.5, p);
    const m = measureHand(r.landmarks, 16/9);
    console.log(k, JSON.stringify({ ...m, curl: m.curl.map(v=>v.toFixed(2)) }), classifyGesture(m, nextPinch(false, m)));
  }
  for (let p = 0; p <= 1.001; p += 0.1) {
    const m = measureHand(rawHandAt(0.5,0.5,{curl:[0,0.5,0.35,0.4,0.45],pinch:p}).landmarks, 16/9);
    console.log(p.toFixed(1), m.pinchRatio.toFixed(3), m.tipContact, m.curl[0].toFixed(2));
  }
});
