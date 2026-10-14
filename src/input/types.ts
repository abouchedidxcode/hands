/** grab = closed fist (select / carry armies); middle = middle finger raised (smite). */
export type Gesture = 'none' | 'open' | 'grab' | 'middle' | 'point';

/** x,y in 0..1 screen space (already mirrored + remapped), z = relative depth from MediaPipe. */
export interface Landmark { x: number; y: number; z: number }

export interface HandState {
  slot: 0 | 1;
  present: boolean;
  /** As the user sees it (mirrored selfie view). */
  handedness: 'Left' | 'Right';
  /** Cursor (palm centre: knuckle centroid) in 0..1 screen space, smoothed. */
  x: number; y: number;
  /** Cursor velocity, screen units per second. */
  vx: number; vy: number;
  /** Closed fist (with hysteresis): the select / grab gesture. */
  grab: boolean;
  /** True only on the frame the grab began / ended. */
  grabStart: boolean; grabEnd: boolean;
  /** 0..1, how closed the hand is (1 = tight fist). */
  grabStrength: number;
  /** Middle finger raised, others curled: the smite gesture. */
  middle: boolean;
  open: boolean;
  gesture: Gesture;
  /** 21 MediaPipe landmarks in the same space as x,y; [] when not present. */
  landmarks: Landmark[];
  /** Wrist → middle MCP distance in screen units (bigger = closer to camera). */
  palmSize: number;
  /** performance.now() of last detection. */
  lastSeen: number;
}

export interface InputFrame {
  hands: [HandState, HandState];
  source: 'camera' | 'mouse' | 'synthetic';
  trackingFps: number;
}

export function emptyHand(slot: 0 | 1): HandState {
  return {
    slot, present: false, handedness: slot === 0 ? 'Right' : 'Left',
    x: 0.5, y: 0.5, vx: 0, vy: 0,
    grab: false, grabStart: false, grabEnd: false, grabStrength: 0,
    middle: false, open: false, gesture: 'none',
    landmarks: [], palmSize: 0, lastSeen: 0,
  };
}
