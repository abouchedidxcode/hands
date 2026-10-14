import type { InputFrame } from '../input/types';

const DWELL = 1.0;     // seconds of hover to activate
const PAD = 26;        // px of forgiveness around buttons
const COOLDOWN = 0.6;  // s after any activation (screens change underneath the hand)

interface BState { p: number; hovered: boolean }

/**
 * Hand-operated buttons: any element with [data-hb] can be activated by hovering a hand cursor
 * over it (a ring fills) or by pinching while hovering. Mouse clicks work too.
 */
export class HandButtons {
  private state = new WeakMap<Element, BState>();
  private cursors: HTMLDivElement[] = [];
  private cooldown = 0;
  showCursors = true;
  onHover: (() => void) | null = null;
  onFire: (() => void) | null = null;

  constructor(private root: HTMLElement, cursorLayer: HTMLElement) {
    for (let i = 0; i < 2; i++) {
      const c = document.createElement('div');
      c.className = `cursor s${i}`;
      c.style.display = 'none';
      cursorLayer.appendChild(c);
      this.cursors.push(c);
    }
  }

  /** Block activations for a moment (e.g. right after a screen appears). */
  hold(seconds = COOLDOWN) { this.cooldown = Math.max(this.cooldown, seconds); }

  update(frame: InputFrame, dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const W = window.innerWidth, H = window.innerHeight;
    const els = Array.from(this.root.querySelectorAll<HTMLElement>('[data-hb]'));
    const rects = els.map((e) => e.getBoundingClientRect());

    frame.hands.forEach((h, i) => {
      const c = this.cursors[i];
      const vis = this.showCursors && h.present;
      c.style.display = vis ? 'block' : 'none';
      if (vis) {
        c.style.transform = `translate(${h.x * W}px, ${h.y * H}px)`;
        c.classList.toggle('pinch', h.pinch);
      }
    });

    els.forEach((el, k) => {
      const r = rects[k];
      let st = this.state.get(el);
      if (!st) { st = { p: 0, hovered: false }; this.state.set(el, st); }
      let hovered = false, pinched = false;
      if (r.width > 0) {
        for (const h of frame.hands) {
          if (!h.present) continue;
          const x = h.x * W, y = h.y * H;
          // circular hit test for round buttons, padded rect otherwise
          const round = el.classList.contains('hb');
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const inside = round
            ? Math.hypot(x - cx, y - cy) < r.width / 2 + PAD
            : x > r.left - PAD && x < r.right + PAD && y > r.top - PAD && y < r.bottom + PAD;
          // with a real mouse the DOM click already fires; don't double-trigger from the fake pinch
          if (inside) { hovered = true; if (h.pinchStart && frame.source !== 'mouse') pinched = true; }
        }
      }
      const locked = el.classList.contains('locked');
      if (hovered && !st.hovered && !locked) this.onHover?.();
      st.hovered = hovered;
      el.classList.toggle('hover', hovered && !locked);
      if (hovered && !locked && this.cooldown <= 0) st.p += dt / DWELL;
      else st.p = Math.max(0, st.p - dt * 2.5);
      if (!locked && this.cooldown <= 0 && (st.p >= 1 || pinched)) {
        st.p = 0;
        this.fire(el);
      }
      el.style.setProperty('--p', String(Math.min(1, st.p)));
    });
  }

  private fire(el: HTMLElement) {
    this.cooldown = COOLDOWN;
    el.classList.remove('fire');
    void el.offsetWidth;
    el.classList.add('fire');
    this.onFire?.();
    el.click();
  }
}
