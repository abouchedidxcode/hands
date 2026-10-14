import { DEFAULT_MAPPING } from '../input/gestures';
import type { InputFrame } from '../input/types';

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17],
];
const COLORS = ['#ffd36a', '#7fd0ff']; // gold leaf (hand 1), cerulean (hand 2)

/** Draws neon skeletons + the active tracking zone over the mirrored webcam picture-in-picture. */
export function drawPip(canvas: HTMLCanvasElement, frame: InputFrame, input: { video: HTMLVideoElement }) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  // object-fit: cover mapping from (mirrored) image coords to canvas px
  const vw = input.video.videoWidth || 16, vh = input.video.videoHeight || 9;
  const s = Math.max(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;
  const m = DEFAULT_MAPPING;
  const px = (sx: number) => ox + (m.x0 + sx * (m.x1 - m.x0)) * dw;
  const py = (sy: number) => oy + (m.y0 + sy * (m.y1 - m.y0)) * dh;

  // tracking status for the CSS frame (status dot, raise-screen overlay)
  const n = frame.hands.filter((hh) => hh.present).length;
  const host = canvas.parentElement;
  if (host && host.dataset.hands !== String(n)) host.dataset.hands = String(n);
  const big = w > 320;
  const k = big ? 1.6 : 1;

  // active zone: corner brackets (where your hand maps onto the whole screen)
  const zx0 = px(0), zy0 = py(0), zx1 = px(1), zy1 = py(1);
  const L0 = Math.min(zx1 - zx0, zy1 - zy0) * 0.14;
  c.strokeStyle = n ? 'rgba(255,225,150,0.7)' : 'rgba(241,227,194,0.45)';
  c.lineWidth = 2 * k;
  c.lineCap = 'round';
  c.beginPath();
  for (const [x, y, sx, sy] of [[zx0, zy0, 1, 1], [zx1, zy0, -1, 1], [zx0, zy1, 1, -1], [zx1, zy1, -1, -1]]) {
    c.moveTo(x + sx * L0, y); c.lineTo(x, y); c.lineTo(x, y + sy * L0);
  }
  c.stroke();

  frame.hands.forEach((hand, i) => {
    if (!hand.present || hand.landmarks.length !== 21) return;
    const L = hand.landmarks;
    c.strokeStyle = COLORS[i];
    c.shadowColor = COLORS[i];
    c.shadowBlur = 8 * k;
    c.lineWidth = 2.5 * k;
    c.beginPath();
    for (const [a, b] of BONES) { c.moveTo(px(L[a].x), py(L[a].y)); c.lineTo(px(L[b].x), py(L[b].y)); }
    c.stroke();
    c.fillStyle = '#ffffff';
    for (const p of L) { c.beginPath(); c.arc(px(p.x), py(p.y), 2.2 * k, 0, Math.PI * 2); c.fill(); }
    c.shadowBlur = 0;
    // gesture label
    const label = hand.grab ? 'GRAB' : hand.middle ? 'SMITE' : hand.open ? 'OPEN' : hand.gesture.toUpperCase();
    c.font = `900 ${Math.round(11 * k)}px Cinzel, Georgia, serif`;
    c.textAlign = 'center';
    const lx = px(L[0].x), ly = py(L[0].y) + 18 * k;
    const tw = c.measureText(label).width + 12 * k;
    c.fillStyle = 'rgba(42,26,14,0.8)';
    c.beginPath();
    c.roundRect(lx - tw / 2, ly - 12 * k, tw, 17 * k, 8 * k);
    c.fill();
    c.fillStyle = COLORS[i];
    c.fillText(label, lx, ly);
    c.textAlign = 'start';
  });
}
