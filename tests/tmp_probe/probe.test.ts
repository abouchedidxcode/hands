import { it } from 'vitest';
import { measureHand, nextGrab, classifyGesture, grabStrengthOf } from '../../src/input/gestures';
import { rawHandAt } from '../../src/input/fakeHand';
it('probe', () => {
  for (let c = 0; c <= 1.001; c += 0.05) for (const th of [0, 0.5, 1]) {
    const m = measureHand(rawHandAt(0.5,0.5,{curl:[th,c,c,c,c],pinch:0}).landmarks, 16/9);
    const g = nextGrab(false, m);
    console.log('C', c.toFixed(2), th, m.curl.map(x=>x.toFixed(2)).join(','), 'mean', (m.curl.reduce((x,y)=>x+y)/4).toFixed(3), 'ext', m.extended.map(Number).join(''), m.extendedCount, 'cc', m.curledCount, 'grab', g, 'held', nextGrab(true,m), classifyGesture(m,g), grabStrengthOf(m).toFixed(2));
  }
});
