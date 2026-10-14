/**
 * Procedural 21-point hand skeleton. Used by
 *  - the mouse fallback (so the 3D hand visual still has landmarks),
 *  - inject() when a synthetic hand has no landmarks,
 *  - unit tests (raw MediaPipe-space hands for open / fist / pinch / point).
 *
 * Local frame: palm facing the camera, as the user sees it on screen.
 * x → right, y → up, z → away from the camera (MediaPipe convention: smaller z
 * = closer to the camera), unit = wrist→middle-MCP length. Wrist at origin.
 */
import type { Landmark } from './types';
import { DEFAULT_MAPPING, fromScreen, LM, type MappingConfig, type RawHand, type RawLandmark } from './gestures';

export interface HandPose {
  /** Curl 0 (straight) .. 1 (fully curled) for thumb, index, middle, ring, pinky. */
  curl: [number, number, number, number, number];
  /** 0..1: thumb tip pulled onto the index tip. */
  pinch: number;
  /** In-plane rotation (radians, positive = counter-clockwise on screen). */
  roll?: number;
}

export const POSES = {
  open: { curl: [0, 0, 0, 0, 0], pinch: 0 } as HandPose,
  relaxed: { curl: [0.2, 0.25, 0.3, 0.35, 0.4], pinch: 0 } as HandPose,
  fist: { curl: [1, 1, 1, 1, 1], pinch: 0 } as HandPose,
  point: { curl: [1, 0, 1, 1, 1], pinch: 0 } as HandPose,
  pinch: { curl: [0, 0.5, 0.35, 0.4, 0.45], pinch: 1 } as HandPose,
};

type V3 = [number, number, number];

// Finger bases (MCP), in-plane direction (deg) and segment lengths.
const FINGERS: { mcp: V3; dir: number; seg: [number, number, number] }[] = [
  { mcp: [-0.24, 0.96, 0], dir: 97, seg: [0.48, 0.28, 0.22] }, // index
  { mcp: [0, 1, 0], dir: 90, seg: [0.52, 0.32, 0.24] },        // middle
  { mcp: [0.19, 0.95, 0], dir: 84, seg: [0.48, 0.3, 0.22] },   // ring
  { mcp: [0.36, 0.84, 0], dir: 76, seg: [0.38, 0.22, 0.2] },   // pinky
];
/** Max flexion per joint (deg) at curl = 1: MCP, PIP, DIP (cumulative). */
const FLEX = [75, 100, 70];

// Thumb: open (splayed) and tucked (across the curled fingers) key shapes.
const THUMB_OPEN: V3[] = [[-0.22, 0.18, 0], [-0.48, 0.36, -0.02], [-0.71, 0.52, -0.03], [-0.91, 0.66, -0.04]];
const THUMB_TUCK: V3[] = [[-0.2, 0.18, -0.02], [-0.38, 0.45, -0.12], [-0.3, 0.72, -0.3], [-0.08, 0.86, -0.42]];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Builds the 21 landmarks of a RIGHT hand in the local frame. */
export function handShape(pose: HandPose): V3[] {
  const out: V3[] = new Array(21);
  out[LM.WRIST] = [0, 0, 0];
  for (let f = 0; f < 4; f++) {
    const { mcp, dir, seg } = FINGERS[f];
    let c = pose.curl[f + 1];
    if (f === 0) c = Math.max(c, 0.5 * pose.pinch); // a pinching index bends a bit
    const base = LM.INDEX_MCP + f * 4;
    out[base] = mcp;
    const dx = Math.cos((dir * Math.PI) / 180), dy = Math.sin((dir * Math.PI) / 180);
    let p = mcp, phi = 0;
    for (let s = 0; s < 3; s++) {
      phi += (FLEX[s] * c * Math.PI) / 180;
      const cs = Math.cos(phi), sn = Math.sin(phi);
      // Bend toward the camera (−z).
      p = [p[0] + seg[s] * dx * cs, p[1] + seg[s] * dy * cs, p[2] - seg[s] * sn];
      out[base + 1 + s] = p;
    }
  }
  const tc = pose.curl[0];
  for (let i = 0; i < 4; i++) out[LM.THUMB_CMC + i] = lerp3(THUMB_OPEN[i], THUMB_TUCK[i], tc);
  if (pose.pinch > 0) {
    // Pull the thumb chain so its tip meets the index tip (slightly on the thumb side).
    const it = out[LM.INDEX_TIP];
    const target: V3 = [it[0] - 0.07, it[1] - 0.06, it[2] + 0.02];
    const tip = out[LM.THUMB_TIP];
    const delta: V3 = [target[0] - tip[0], target[1] - tip[1], target[2] - tip[2]];
    const w = [0.15, 0.4, 0.7, 1]; // CMC barely moves, tip moves fully
    for (let i = 0; i < 4; i++) {
      const k = w[i] * pose.pinch;
      const q = out[LM.THUMB_CMC + i];
      out[LM.THUMB_CMC + i] = [q[0] + delta[0] * k, q[1] + delta[1] * k, q[2] + delta[2] * k];
    }
  }
  if (pose.roll) {
    const c = Math.cos(pose.roll), s = Math.sin(pose.roll);
    for (let i = 0; i < 21; i++) { const [x, y, z] = out[i]; out[i] = [x * c - y * s, x * s + y * c, z]; }
  }
  return out;
}

const tipMid = (s: V3[]): [number, number] =>
  [(s[LM.THUMB_TIP][0] + s[LM.INDEX_TIP][0]) / 2, (s[LM.THUMB_TIP][1] + s[LM.INDEX_TIP][1]) / 2];

export interface FakeHandOpts {
  handedness?: 'Left' | 'Right';
  /** Palm length in screen-height units. */
  scale?: number;
  /** Screen (or camera) width / height. */
  aspect?: number;
}

/**
 * Screen-space landmarks (HandState.landmarks) with the thumb/index tip
 * midpoint exactly on (x, y).
 */
export function screenHandLandmarks(x: number, y: number, pose: HandPose, o: FakeHandOpts = {}): Landmark[] {
  const scale = o.scale ?? 0.14, aspect = o.aspect ?? 16 / 9;
  const sx = o.handedness === 'Left' ? -1 : 1;
  const s = handShape(pose);
  const [mx, my] = tipMid(s);
  return s.map(([lx, ly, lz]) => ({
    x: x + (sx * (lx - mx) * scale) / aspect,
    y: y - (ly - my) * scale,
    z: lz * scale,
  }));
}

/**
 * A raw (un-mirrored, MediaPipe-space) detection whose mapped cursor lands on
 * screen point (sx, sy). `scale` is the palm length in camera-height units.
 */
export function rawHandAt(
  sx: number, sy: number, pose: HandPose,
  o: FakeHandOpts & { mapping?: MappingConfig; score?: number } = {},
): RawHand {
  const m = o.mapping ?? DEFAULT_MAPPING;
  const scale = o.scale ?? 0.18, aspect = o.aspect ?? 16 / 9;
  const user = o.handedness ?? 'Right';
  const s = handShape(pose);
  const [mx, my] = tipMid(s);
  const anchor = fromScreen(sx, sy, m);
  // User-perceived x → raw image x flips when the view is mirrored; a left hand
  // is the mirror image of the right-hand template.
  const fx = (m.mirror ? -1 : 1) * (user === 'Left' ? -1 : 1);
  const landmarks: RawLandmark[] = s.map(([lx, ly, lz]) => ({
    x: anchor.x + (fx * (lx - mx) * scale) / aspect,
    y: anchor.y - (ly - my) * scale,
    z: (lz * scale) / aspect,
  }));
  // MediaPipe labels assume a mirrored image → it reports the opposite hand for raw frames.
  const label: 'Left' | 'Right' = m.flipHandedness ? (user === 'Left' ? 'Right' : 'Left') : user;
  return { landmarks, label, score: o.score ?? 0.95 };
}
