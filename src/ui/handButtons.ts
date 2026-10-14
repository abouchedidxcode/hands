import type { InputFrame } from '../input/types';

const DWELL = 1.0;     // seconds of hover to activate
const PAD = 26;        // px of forgiveness around buttons
const COOLDOWN = 0.6;  // s after any activation (screens change underneath the hand)
const MAGNET = 0.28;   // how far (0..1) the drawn cursor is pulled toward a hovered button's centre
const MAGNET_DWELL = 0.3; // extra pull as the dwell ring fills

interface BState { p: number; hovered: boolean }
interface CState { x: number; y: number; vis: boolean }

/**
 * Hand-operated buttons: any element with [data-hb] can be activated by hovering a hand cursor
 * over it (a ring fills) or by pinching while hovering. Mouse clicks work too.
 *
 * Each hand targets at most one button (the nearest one it is inside of), so padded hit areas of
 * neighbouring buttons never fill together. The drawn cursor is gently pulled ("magnetic") toward
 * the hovered button and shows its own dwell ring.
 */
export class HandButtons {
  private state = new WeakMap<Element, BState>();
  private cursors: HTMLDivElement[] = [];
  private cur: CState[] = [];
  private cooldown = 0;
  showCursors = true;
  onHover: (() => void) | null = null;
  onFire: (() => void) | null = null;

  constructor(private root: HTMLElement, cursorLayer: HTMLElement) {
    for (let i = 0; i < 2; i++) {
      const c = document.createElement('div');
      c.className = `cursor s${i}`;
      c.style.display = 'none';
      c.innerHTML = `<svg viewBox="0 0 72 72" aria-hidden="true">
          <circle class="trk" cx="36" cy="36" r="31"/>
          <circle class="prog" cx="36" cy="36" r="31" pathLength="100"/>
        </svg><div class="halo"></div><div class="dot"></div>`;
      cursorLayer.appendChild(c);
      this.cursors.push(c);
      this.cur.push({ x: 0, y: 0, vis: false });
    }
  }

  /** Block activations for a moment (e.g. right after a screen appears). */
  hold(seconds = COOLDOWN) { this.cooldown = Math.max(this.cooldown, seconds); }

  update(frame: InputFrame, dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const W = window.innerWidth, H = window.innerHeight;
    const els = Array.from(this.root.querySelectorAll<HTMLElement>('[data-hb]'));
    const rects = els.map((e) => e.getBoundingClientRect());

    // each hand → the single nearest button it is inside of
    const target: number[] = [-1, -1];
    frame.hands.forEach((h, i) => {
      if (!h.present) return;
      const x = h.x * W, y = h.y * H;
      let best = Infinity;
      els.forEach((el, k) => {
        const r = rects[k];
        if (r.width <= 0) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let d: number;
        if (el.classList.contains('hb')) {
          // circular hit test for round buttons
          const dist = Math.hypot(x - cx, y - cy);
          if (dist >= r.width / 2 + PAD) return;
          d = dist / (r.width / 2);
        } else {
          if (!(x > r.left - PAD && x < r.right + PAD && y > r.top - PAD && y < r.bottom + PAD)) return;
          d = Math.max(Math.abs(x - cx) / (r.width / 2), Math.abs(y - cy) / (r.height / 2));
        }
        if (d < best) { best = d; target[i] = k; }
      });
    });

    els.forEach((el, k) => {
      let st = this.state.get(el);
      if (!st) { st = { p: 0, hovered: false }; this.state.set(el, st); }
      let hovered = false, pinched = false;
      frame.hands.forEach((h, i) => {
        if (target[i] !== k) return;
        hovered = true;
        // with a real mouse the DOM click already fires; don't double-trigger from the fake pinch
        if (h.pinchStart && frame.source !== 'mouse') pinched = true;
      });
      const locked = el.classList.contains('locked');
      if (hovered && !st.hovered && !locked) this.onHover?.();
      st.hovered = hovered;
      el.classList.toggle('hover', hovered && !locked);
      el.classList.toggle('hover-locked', hovered && locked);
      if (hovered && !locked && this.cooldown <= 0) st.p += dt / DWELL;
      else st.p = Math.max(0, st.p - dt * 2.5);
      if (!locked && this.cooldown <= 0 && (st.p >= 1 || pinched)) {
        st.p = 0;
        this.fire(el);
      }
      el.style.setProperty('--p', String(Math.min(1, st.p)));
    });

    // cursors: magnetic pull toward the hovered button + their own dwell ring
    const ease = 1 - Math.exp(-dt * 22);
    frame.hands.forEach((h, i) => {
      const c = this.cursors[i];
      const cs = this.cur[i];
      const vis = this.showCursors && h.present;
      if (!vis) {
        if (cs.vis) { c.style.display = 'none'; cs.vis = false; }
        return;
      }
      let tx = h.x * W, ty = h.y * H, p = 0, over = false, locked = false;
      const k = target[i];
      if (k >= 0) {
        const el = els[k], r = rects[k];
        locked = el.classList.contains('locked');
        p = locked ? 0 : Math.min(1, this.state.get(el)?.p ?? 0);
        over = !locked;
        const pull = locked ? 0.1 : MAGNET + MAGNET_DWELL * p;
        tx += (r.left + r.width / 2 - tx) * pull;
        ty += (r.top + r.height / 2 - ty) * pull;
      }
      if (!cs.vis) { cs.x = tx; cs.y = ty; cs.vis = true; c.style.display = 'block'; }
      else { cs.x += (tx - cs.x) * ease; cs.y += (ty - cs.y) * ease; }
      c.style.transform = `translate(${cs.x.toFixed(1)}px, ${cs.y.toFixed(1)}px)`;
      c.style.setProperty('--p', p.toFixed(3));
      c.classList.toggle('pinch', h.pinch);
      c.classList.toggle('over', over);
      c.classList.toggle('nope', locked);
    });
  }

  private fire(el: HTMLElement) {
    this.cooldown = COOLDOWN;
    el.classList.remove('fire');
    void el.offsetWidth;
    el.classList.add('fire');
    for (const c of this.cursors) {
      if (!c.classList.contains('over')) continue;
      c.classList.remove('fire');
      void c.offsetWidth;
      c.classList.add('fire');
    }
    this.onFire?.();
    el.click();
  }
}
