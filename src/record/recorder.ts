import { DEFAULT_MAPPING } from '../input/gestures';
import type { InputFrame } from '../input/types';

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17],
];
const HAND_COLORS = ['#ffd27a', '#ffb070'];
const FPS = 30;

interface Banner { text: string; color: string; until: number; big: boolean }

/**
 * Records the match as a shareable clip: the WebGL frame + the player's webcam (with neon
 * skeleton) + a minimal overlay are composited into a 2D canvas that is fed to MediaRecorder.
 */
export class ClipRecorder {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private lastDraw = 0;
  private banners: Banner[] = [];
  private bars: { colors: string[]; values: number[] } = { colors: [], values: [] };
  private title = '';
  private mime = '';
  blob: Blob | null = null;
  supported = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

  get recording() { return !!this.rec && this.rec.state === 'recording'; }

  start(title: string, audio: MediaStream | null) {
    if (!this.supported) return;
    this.stop(true);
    this.title = title;
    this.blob = null;
    this.chunks = [];
    this.banners = [];
    const w = 1280, h = Math.round(1280 * (window.innerHeight / window.innerWidth) / 2) * 2;
    this.canvas.width = w;
    this.canvas.height = Math.min(h, 960);
    const stream = this.canvas.captureStream(FPS);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    this.mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    try {
      this.rec = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 6_000_000 });
    } catch {
      this.rec = null;
      return;
    }
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => { this.blob = new Blob(this.chunks, { type: this.mime || 'video/webm' }); };
    this.rec.start(1000);
  }

  stop(discard = false) {
    if (!this.rec) return;
    if (discard) this.rec.onstop = null;
    if (this.rec.state !== 'inactive') this.rec.stop();
    this.rec = null;
  }

  banner(text: string, color = '#ffffff', big = false) {
    if (!this.recording) return;
    this.banners.push({ text, color, until: performance.now() + (big ? 2200 : 1300), big });
    if (this.banners.length > 3) this.banners.shift();
  }

  setBars(colors: string[], values: number[]) { this.bars.colors = colors; this.bars.values = values; }

  /** Call right after the WebGL frame was rendered (same task) so the drawing buffer is valid. */
  capture(gl: HTMLCanvasElement, video: HTMLVideoElement | null, frame: InputFrame) {
    if (!this.recording) return;
    const now = performance.now();
    if (now - this.lastDraw < 1000 / FPS - 2) return;
    this.lastDraw = now;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    // game, cover-fit
    const s = Math.max(W / gl.width, H / gl.height);
    c.drawImage(gl, (W - gl.width * s) / 2, (H - gl.height * s) / 2, gl.width * s, gl.height * s);

    // webcam picture-in-picture
    if (video && video.videoWidth) {
      const pw = Math.round(W * 0.24), ph = Math.round(pw * 0.75);
      const px = W - pw - 18, py = H - ph - 18;
      c.save();
      roundRect(c, px, py, pw, ph, 16);
      c.clip();
      const vs = Math.max(pw / video.videoWidth, ph / video.videoHeight);
      const dw = video.videoWidth * vs, dh = video.videoHeight * vs;
      const ox = px + (pw - dw) / 2, oy = py + (ph - dh) / 2;
      c.translate(ox + dw, oy);
      c.scale(-1, 1);
      c.drawImage(video, 0, 0, dw, dh);
      c.setTransform(1, 0, 0, 1, 0, 0);
      const m = DEFAULT_MAPPING;
      const mx = (sx: number) => ox + (m.x0 + sx * (m.x1 - m.x0)) * dw;
      const my = (sy: number) => oy + (m.y0 + sy * (m.y1 - m.y0)) * dh;
      frame.hands.forEach((hd, i) => {
        if (!hd.present || hd.landmarks.length !== 21) return;
        const L = hd.landmarks;
        c.strokeStyle = HAND_COLORS[i];
        c.lineWidth = 3;
        c.shadowColor = HAND_COLORS[i];
        c.shadowBlur = 10;
        c.beginPath();
        for (const [a, b] of BONES) { c.moveTo(mx(L[a].x), my(L[a].y)); c.lineTo(mx(L[b].x), my(L[b].y)); }
        c.stroke();
        c.shadowBlur = 0;
      });
      c.restore();
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(214,170,90,0.95)';
      roundRect(c, px, py, pw, ph, 16);
      c.stroke();
    }

    // watermark + title
    c.font = '900 30px "Cinzel Decorative", Cinzel, Georgia, serif';
    c.textBaseline = 'top';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(40,22,6,0.75)';
    c.strokeText('✋ GODHAND', 22, 18);
    c.fillStyle = '#f2c35a';
    c.fillText('✋ GODHAND', 22, 18);
    c.font = 'italic 19px "IM Fell English", Georgia, serif';
    c.fillStyle = 'rgba(255,244,220,0.95)';
    c.fillText(this.title, 24, 56);

    // army bar
    const total = this.bars.values.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const bw = W * 0.4, bx = (W - bw) / 2, by = 22, bh = 18;
      let x = bx;
      this.bars.values.forEach((v, i) => {
        const w = (v / total) * bw;
        c.fillStyle = this.bars.colors[i];
        c.fillRect(x, by, w, bh);
        x += w;
      });
      c.strokeStyle = 'rgba(60,36,12,0.85)';
      c.lineWidth = 2;
      c.strokeRect(bx, by, bw, bh);
    }

    // banners
    this.banners = this.banners.filter((b) => b.until > now);
    this.banners.forEach((b, i) => {
      const life = (b.until - now) / (b.big ? 2200 : 1300);
      c.globalAlpha = Math.min(1, life * 4);
      c.font = `900 ${b.big ? 84 : 42}px Cinzel, Georgia, serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const y = H * 0.24 + i * 56;
      c.lineWidth = 8;
      c.strokeStyle = 'rgba(40,22,6,0.7)';
      c.strokeText(b.text, W / 2, y);
      c.fillStyle = b.color;
      c.fillText(b.text, W / 2, y);
      c.textAlign = 'left';
      c.globalAlpha = 1;
    });
  }

  /** Trigger a download of the finished clip. */
  download(name: string) {
    if (!this.blob) return false;
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(this.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
