export type Gesture = 'none' | 'open' | 'pinch' | 'fist' | 'middle' | 'point';

/** x,y in 0..1 screen space (already mirrored + remapped), z = relative depth from MediaPipe. */
export interface Landmark { x: number; y: number; z: number }

export interface HandState {
  slot: 0 | 1;
  present: boolean;
  /** As the user sees it (mirrored selfie view). */
  handedness: 'Left' | 'Right';
  /** Cursor (thumb/index midpoint) in 0..1 screen space, smoothed. */
  x: number; y: number;
  /** Cursor velocity, screen units per second. */
  vx: number; vy: number;
  pinch: boolean;
  /** True only on the frame the pinch began / ended. */
  pinchStart: boolean; pinchEnd: boolean;
  /** 0..1, 1 = fingertips touching. */
  pinchStrength: number;
  /** Closed fist = grab. */
  fist: boolean;
  /** Middle finger raised, others curled = smite. */
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
    pinch: false, pinchStart: false, pinchEnd: false, pinchStrength: 0,
    fist: false, middle: false, open: false, gesture: 'none',
    landmarks: [], palmSize: 0, lastSeen: 0,
  };
}
