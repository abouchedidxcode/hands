/**
 * Webcam + MediaPipe HandLandmarker (VIDEO mode).
 *
 * - WASM fileset from `<base>/wasm/`, model from `<base>/models/hand_landmarker.task`
 *   (both resolved against document.baseURI, so it works under any deploy path).
 * - GPU delegate with automatic CPU fallback (at creation, and if the GPU
 *   graph keeps throwing at runtime).
 * - Detection runs at most once per *new* video frame (video.currentTime changed),
 *   so a 120 Hz render loop doesn't re-run the model on the same 30 Hz frame.
 * - The MediaPipe module is imported lazily so mouse-only / test builds never load it.
 */
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import type { RawHand } from './gestures';

export interface DetectionFrame {
  hands: RawHand[];
  /** Capture time of the processed frame (performance.now() base, ms). */
  frameTime: number;
  /** Video width / height. */
  aspect: number;
}

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60 },
  },
};

const LANDMARKER_OPTIONS = {
  runningMode: 'VIDEO' as const,
  numHands: 2,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
};

/** Consecutive detectForVideo failures on GPU before rebuilding on CPU. */
const GPU_FAILURES_BEFORE_FALLBACK = 3;

function assetUrl(path: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href ?? '/';
  return new URL(path, base).href.replace(/\/$/, '');
}

type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export class HandTracker {
  delegate: 'GPU' | 'CPU' | null = null;
  /** Detections per second (measured over ~0.5 s windows). */
  fps = 0;
  /** Called if the camera track ends (unplugged, permission revoked…). */
  onEnded: (() => void) | null = null;

  private landmarker: HandLandmarker | null = null;
  private fileset: unknown = null;
  private stream: MediaStream | null = null;
  private lastVideoTime = -1;
  private lastTs = 0;
  private lastFrameTime = 0;
  private failures = 0;
  private rebuilding = false;
  private fpsCount = 0;
  private fpsWindowStart = 0;
  private rvfcHandle = 0;
  private rvfcTime = NaN;
  private lastRvfcUsed = NaN;
  private lastDetectNow = 0;
  private stopped = false;

  constructor(readonly video: HTMLVideoElement) {}

  /** Opens the camera and loads the model in parallel. Throws on failure. */
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Camera API unavailable (insecure context or unsupported browser)'), { name: 'NotSupportedError' });
    }
    const camera = this.openCamera();
    const model = this.createLandmarker();
    // Don't leave a dangling rejection if one side fails first.
    const [camRes, modelRes] = await Promise.allSettled([camera, model]);
    if (camRes.status === 'rejected' || modelRes.status === 'rejected') {
      this.stop();
      if (modelRes.status === 'fulfilled') modelRes.value.close();
      throw camRes.status === 'rejected' ? camRes.reason : (modelRes as PromiseRejectedResult).reason;
    }
    this.landmarker = modelRes.value;
    this.watchFrames();
  }

  private async openCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    this.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => { if (!this.stopped) this.onEnded?.(); });
    }
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;
    if (v.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('Video element failed to load the camera stream')); };
        const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); };
        v.addEventListener('loadeddata', ok);
        v.addEventListener('error', bad);
      });
    }
    await v.play().catch(() => { /* autoplay of a muted stream normally succeeds; detection still works on a paused-but-loaded frame */ });
  }

  private async createLandmarker(cpuOnly = false): Promise<HandLandmarker> {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(assetUrl('wasm'));
    const fileset = this.fileset as Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
    const make = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
      ...LANDMARKER_OPTIONS,
      baseOptions: { modelAssetPath: assetUrl('models/hand_landmarker.task'), delegate },
    });
    if (!cpuOnly) {
      try {
        const lm = await make('GPU');
        this.delegate = 'GPU';
        return lm;
      } catch (err) {
        console.warn('[input] GPU delegate unavailable, falling back to CPU:', err);
      }
    }
    const lm = await make('CPU');
    this.delegate = 'CPU';
    return lm;
  }

  /** Records the capture time of each presented frame (more accurate than rAF time). */
  private watchFrames(): void {
    const v = this.video as RVFCVideo;
    if (!v.requestVideoFrameCallback) return;
    const cb = (now: number, meta: VideoFrameMeta) => {
      if (this.stopped) return;
      const t = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      this.rvfcTime = Number.isFinite(t) ? t : now;
      this.rvfcHandle = v.requestVideoFrameCallback!(cb);
    };
    this.rvfcHandle = v.requestVideoFrameCallback(cb);
  }

  get running(): boolean { return !!this.landmarker && !this.stopped; }

  /** Runs the model if a new video frame is available; null otherwise. */
  detect(now: number): DetectionFrame | null {
    const v = this.video, lm = this.landmarker;
    if (!lm || this.rebuilding || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const ct = v.currentTime;
    if (ct === this.lastVideoTime) return null;
    this.lastVideoTime = ct;

    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    let res;
    try {
      res = lm.detectForVideo(v, ts);
      this.failures = 0;
    } catch (err) {
      this.onDetectError(err);
      return null;
    }

    // FPS over ~0.5 s windows.
    this.fpsCount++;
    if (!this.fpsWindowStart) this.fpsWindowStart = now;
    const span = now - this.fpsWindowStart;
    if (span >= 500) {
      const inst = (this.fpsCount * 1000) / span;
      this.fps = this.fps ? this.fps * 0.5 + inst * 0.5 : inst;
      this.fpsCount = 0;
      this.fpsWindowStart = now;
    }

    const hands: RawHand[] = [];
    for (let i = 0; i < res.landmarks.length; i++) {
      const lms = res.landmarks[i];
      if (!lms || lms.length < 21) continue;
      const cat = res.handedness[i]?.[0];
      hands.push({
        landmarks: lms.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        label: cat?.categoryName === 'Left' ? 'Left' : 'Right',
        score: cat?.score ?? 0.5,
      });
    }

    // Prefer the frame's capture time; if the frame callback hasn't reported
    // this frame (or isn't supported), advance by wall-clock delta so the time
    // base never mixes.
    let frameTime: number;
    if (Number.isFinite(this.rvfcTime) && this.rvfcTime !== this.lastRvfcUsed) {
      frameTime = this.rvfcTime;
      this.lastRvfcUsed = this.rvfcTime;
    } else {
      frameTime = this.lastFrameTime ? this.lastFrameTime + (now - this.lastDetectNow) : now;
    }
    if (frameTime <= this.lastFrameTime) frameTime = this.lastFrameTime + 1;
    this.lastFrameTime = frameTime;
    this.lastDetectNow = now;
    return { hands, frameTime, aspect: v.videoWidth / v.videoHeight };
  }

  private onDetectError(err: unknown): void {
    this.failures++;
    if (this.failures === 1) console.warn('[input] hand detection failed:', err);
    if (this.delegate === 'GPU' && this.failures >= GPU_FAILURES_BEFORE_FALLBACK && !this.rebuilding) {
      this.rebuilding = true;
      const old = this.landmarker;
      this.createLandmarker(true)
        .then((lm) => { if (this.stopped) lm.close(); else { this.landmarker = lm; old?.close(); } })
        .catch((e) => console.error('[input] CPU fallback failed:', e))
        .finally(() => { this.rebuilding = false; this.failures = 0; });
    }
  }

  stop(): void {
    this.stopped = true;
    const v = this.video as RVFCVideo;
    if (this.rvfcHandle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfcHandle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
