import { DEFAULT_MAPPING } from '../input/gestures';
import type { InputFrame } from '../input/types';

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17],
];
const COLORS = ['#8ff1ff', '#ffe3a0'];

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

  // active zone
  c.strokeStyle = 'rgba(160,240,255,0.35)';
  c.setLineDash([5, 5]);
  c.lineWidth = 1.5;
  c.strokeRect(px(0), py(0), px(1) - px(0), py(1) - py(0));
  c.setLineDash([]);

  frame.hands.forEach((hand, i) => {
    if (!hand.present || hand.landmarks.length !== 21) return;
    const L = hand.landmarks;
    c.strokeStyle = COLORS[i];
    c.shadowColor = COLORS[i];
    c.shadowBlur = 8;
    c.lineWidth = 2.5;
    c.beginPath();
    for (const [a, b] of BONES) { c.moveTo(px(L[a].x), py(L[a].y)); c.lineTo(px(L[b].x), py(L[b].y)); }
    c.stroke();
    c.fillStyle = '#ffffff';
    for (const p of L) { c.beginPath(); c.arc(px(p.x), py(p.y), 2.2, 0, Math.PI * 2); c.fill(); }
    c.shadowBlur = 0;
    // gesture label
    const label = hand.pinch ? 'PINCH' : hand.fist ? 'FIST' : hand.open ? 'OPEN' : hand.gesture.toUpperCase();
    c.font = '700 11px Rubik, system-ui, sans-serif';
    c.fillStyle = COLORS[i];
    c.fillText(label, px(L[0].x) - 14, py(L[0].y) + 16);
  });
}
