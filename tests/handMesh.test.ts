import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HandSurface } from '../src/render/handVizMesh';

/** Zero-length normals turn into NaN on some GPUs (Apple), which bloom smears into a blank box. */
function badNormals(pts: THREE.Vector3[]) {
  const s = new HandSurface();
  s.build(pts, [1, 1, 1, 1, 1]);
  const N = s.normal.array as Float32Array, P = s.position.array as Float32Array;
  let bad = 0;
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (!(l > 1e-4) || !Number.isFinite(P[i] + P[i + 1] + P[i + 2])) bad++;
  }
  return bad;
}

describe('hand mesh', () => {
  const hand = () => Array.from({ length: 21 }, (_, i) => new THREE.Vector3(Math.cos(i) * 2, 3.6, Math.sin(i * 1.3) * 2));

  it('has no zero normals when finger joints coincide (tight fist)', () => {
    const p = hand();
    for (const [a, b, c] of [[2, 3, 4], [6, 7, 8], [10, 11, 12], [14, 15, 16], [18, 19, 20]]) { p[b].copy(p[a]); p[c].copy(p[a]); }
    expect(badNormals(p)).toBe(0);
  });

  it('has no zero normals for whole fingers collapsed onto their knuckle', () => {
    const p = hand();
    for (const f of [1, 5, 9, 13, 17]) for (let k = 1; k <= 3; k++) p[f + k].copy(p[f]);
    expect(badNormals(p)).toBe(0);
  });

  it('has no zero normals for random jittery real-ish hands', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 200; n++) {
      const p = hand();
      for (let i = 1; i < 21; i++) if (rnd() < 0.3) p[i].copy(p[i - 1]).addScalar((rnd() - 0.5) * 1e-6);
      expect(badNormals(p)).toBe(0);
    }
  });
});
