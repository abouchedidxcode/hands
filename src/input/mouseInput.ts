/**
 * Mouse fallback → a HandState for slot 0.
 *   left button      = fist (grab / carry)
 *   right button     = middle finger (smite; context menu suppressed); releasing
 *                      it yields an 'open' hand for ≥1 update (and ≥100 ms)
 *   Shift held       = open palm
 * Fake landmarks are generated around the cursor so the 3D hand still renders.
 */
import type { Gesture, HandState } from './types';
import { emptyHand } from './types';
import { clamp01 } from './gestures';
import { POSES, screenHandLandmarks, type HandPose } from './fakeHand';

const OPEN_PULSE_MS = 100;
const VEL_TAU = 0.03;   // s, velocity EMA on mouse events
const VEL_DECAY = 0.05; // s, velocity decay when the mouse stops sending events
const POSE_TAU = 0.05;  // s, visual finger animation
export const MOUSE_PALM_SIZE = 0.14;

export class MouseInput {
  /** performance.now() of the last pointer move (−Infinity if never). */
  lastMove = -Infinity;
  private x = 0.5; private y = 0.5;
  private vx = 0; private vy = 0;
  private lastEvT = -Infinity;
  private hasPos = false;
  private inside = true;
  private left = false; private leftLatch = false;
  private right = false; private rightLatch = false;
  private shift = false;
  private openUntil = 0;
  private openFrames = 0;
  private lastSampleT = -Infinity;
  // Visual blend amounts 0..1.
  private aMid = 0; private aFist = 0; private aOpen = 0;
  private aspect = 16 / 9;
  private off: (() => void)[] = [];

  constructor(readonly el: HTMLElement) {
    const win = el.ownerDocument.defaultView ?? window;
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(win, 'pointermove', (e) => this.onMove(e));
    on(el, 'pointerdown', (e) => {
      this.onMove(e);
      if (e.button === 0) { this.left = true; this.leftLatch = true; }
      else if (e.button === 2) { this.right = true; this.rightLatch = true; e.preventDefault(); }
    });
    on(win, 'pointerup', (e) => {
      if (e.button === 0) this.left = false;
      else if (e.button === 2 && this.right) this.releaseRight(performance.now());
    });
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(win, 'keydown', (e) => { if (e.key === 'Shift') this.shift = true; });
    on(win, 'keyup', (e) => { if (e.key === 'Shift') this.shift = false; });
    on(win, 'blur', () => { this.left = false; this.right = false; this.shift = false; });
    on(el.ownerDocument.documentElement, 'pointerleave', () => { this.inside = false; });
    on(el.ownerDocument.documentElement, 'pointerenter', () => { this.inside = true; });
  }

  private releaseRight(now: number): void {
    this.right = false;
    this.openUntil = now + OPEN_PULSE_MS;
    this.openFrames = 1;
  }

  private onMove(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    this.aspect = r.width / r.height;
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const t = e.timeStamp || performance.now();
    if (this.hasPos && Number.isFinite(this.lastEvT)) {
      let dt = (t - this.lastEvT) / 1000;
      if (dt > 0.0005) {
        dt = Math.min(dt, 0.1);
        const k = 1 - Math.exp(-dt / VEL_TAU);
        this.vx += k * ((nx - this.x) / dt - this.vx);
        this.vy += k * ((ny - this.y) / dt - this.vy);
      }
    }
    this.x = nx; this.y = ny;
    this.lastEvT = t;
    this.hasPos = true;
    this.inside = true;
    this.shift = e.shiftKey;
    this.lastMove = performance.now();
  }

  /** Current mouse hand (edge flags are computed by the InputManager). */
  sample(now: number): HandState {
    const dt = Number.isFinite(this.lastSampleT) ? Math.min(Math.max((now - this.lastSampleT) / 1000, 0), 0.1) : 0;
    this.lastSampleT = now;
    const h = emptyHand(0);
    if (!this.hasPos || !this.inside) {
      this.leftLatch = this.rightLatch = false;
      return h;
    }
    // Velocity decays when the mouse stops producing events.
    if (now - this.lastEvT > 40 && dt > 0) {
      const k = Math.exp(-dt / VEL_DECAY);
      this.vx *= k; this.vy *= k;
    }

    // Latches make sub-frame clicks visible for one sample.
    const fist = this.left || this.leftLatch;
    const middle = !fist && (this.right || this.rightLatch);
    this.leftLatch = this.rightLatch = false;
    let open = false;
    if (fist) this.openFrames = 0;
    else if (!middle) {
      if (this.openFrames > 0 || now < this.openUntil) { open = true; this.openFrames = 0; }
      else if (this.shift) open = true;
    }
    const gesture: Gesture = fist ? 'fist' : middle ? 'middle' : open ? 'open' : 'none';

    const k = dt > 0 ? 1 - Math.exp(-dt / POSE_TAU) : 1;
    this.aMid += k * ((middle ? 1 : 0) - this.aMid);
    this.aFist += k * ((fist ? 1 : 0) - this.aFist);
    this.aOpen += k * ((open ? 1 : 0) - this.aOpen);

    const x = clamp01(this.x), y = clamp01(this.y);
    Object.assign(h, {
      present: true, handedness: 'Right',
      x, y, vx: this.vx, vy: this.vy,
      fist, middle, open, gesture,
      landmarks: screenHandLandmarks(x, y, this.pose(), { aspect: this.aspect, scale: MOUSE_PALM_SIZE }),
      palmSize: MOUSE_PALM_SIZE,
      lastSeen: now,
    } satisfies Partial<HandState>);
    return h;
  }

  private pose(): HandPose {
    const base = POSES.relaxed.curl;
    const curl = base.map((c, i) => {
      let v = c + (POSES.fist.curl[i] - c) * this.aFist;
      v += (POSES.middle.curl[i] - v) * this.aMid;
      v += (POSES.open.curl[i] - v) * this.aOpen;
      return v;
    }) as HandPose['curl'];
    return { curl, pinch: 0 };
  }

  dispose(): void { for (const f of this.off) f(); this.off = []; }
}
