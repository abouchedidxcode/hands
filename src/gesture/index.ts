/**
 * GESTURE ENGINE — public API. See src/gesture/README.md.
 */
export { GestureEngine, DEFAULT_CONFIG, DEFAULT_POSE, type EngineConfig, type PoseConfig } from './engine';
export { computeFeatures, smooth, clamp01, L as LANDMARK } from './features';
export { POSES, scorePose, ruleScore } from './poses';
export { MOTIONS, MOTION_INFO, DEFAULT_MOTION, type MotionConfig, type MotionDetector, type MotionContext, type MotionHit, type Sample } from './motions';
export { fromMediaPipe } from './mediapipe';
export type * from './types';
