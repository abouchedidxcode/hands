import * as THREE from 'three';

const CW = 256, CH = 160;
const FONT = '"Cinzel", "Trajan Pro", Georgia, "DejaVu Serif", "Times New Roman", serif';

// Redraw every label once web fonts arrive (canvas text otherwise keeps the fallback face).
let fontGen = 0;
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener?.('loadingdone', () => { fontGen++; });
  document.fonts.load(`900 80px ${FONT}`).then(() => { fontGen++; }).catch(() => {});
}

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex);
  if (k < 0) c.lerp(new THREE.Color('#1a0d06'), -k); else c.lerp(new THREE.Color('#fff4dc'), k);
  return '#' + c.getHexString();
}

/**
 * Garrison count as a wax seal (owned) or an inked paper tag (neutral), drawn into a canvas
 * sprite. Redraws only when its content changes.
 */
export class Label {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  sprite: THREE.Sprite;
  /** world size of the full canvas */
  static W = 3.0;
  private key = '';
  /** last integer shown (for tick detection) */
  shown = -1;
  private seed = Math.random() * 1000;

  constructor() {
    this.canvas.width = CW; this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    mat.color.setScalar(0.92);
    this.sprite = new THREE.Sprite(mat);
    this.sprite.center.set(0.5, 0.0);
    this.sprite.scale.set(Label.W, Label.W * CH / CW, 1);
    this.sprite.renderOrder = 50;
  }

  /** mode: 0 owned, 1 neutral, 2 hit flash */
  set(n: number, color: string, _dark: string, mode: 0 | 1 | 2) {
    const key = `${n}|${color}|${mode}|${fontGen}`;
    if (key === this.key) return;
    this.key = key;
    const c = this.ctx;
    c.clearRect(0, 0, CW, CH);
    const txt = String(n);
    const fs = txt.length >= 3 ? 58 : 70;
    c.font = `900 ${fs}px ${FONT}`;
    const tw = c.measureText(txt).width;
    const cx = CW / 2, cy = CH / 2 + 4;
    const rx = Math.max(52, tw / 2 + 30), ry = 52;
    const blob = (grow: number, wob: number) => {
      c.beginPath();
      const K = 40;
      for (let i = 0; i <= K; i++) {
        const a = (i / K) * Math.PI * 2;
        const w = 1 + wob * (Math.sin(a * 5 + this.seed) * 0.5 + Math.sin(a * 9 + this.seed * 1.7) * 0.3 + Math.sin(a * 14 + this.seed * 2.3) * 0.2);
        const x = cx + Math.cos(a) * (rx + grow) * w, y = cy + Math.sin(a) * (ry + grow) * w;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    };
    if (mode === 1) {
      // neutral: an inked parchment tag with a dashed border
      blob(0, 0.035);
      c.fillStyle = 'rgba(40,24,12,0.45)';
      c.save(); c.translate(3, 5); c.fill(); c.restore();
      blob(0, 0.035);
      c.fillStyle = '#efe2c4';
      c.fill();
      c.lineWidth = 5; c.strokeStyle = '#3a2716'; c.stroke();
      blob(-9, 0.03);
      c.setLineDash([7, 6]); c.lineWidth = 2.5; c.strokeStyle = 'rgba(58,39,22,0.75)'; c.stroke(); c.setLineDash([]);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#2a1a0e';
      c.fillText(txt, cx, cy + 4);
    } else {
      const base = mode === 2 ? '#ff4a3a' : color;
      // drop shadow
      blob(4, 0.06);
      c.fillStyle = 'rgba(30,16,6,0.5)';
      c.save(); c.translate(3, 7); c.fill(); c.restore();
      // wax body: squashed outer drip ring + raised disc
      blob(4, 0.06);
      const g = c.createRadialGradient(cx - rx * 0.35, cy - ry * 0.45, 4, cx, cy, rx + 10);
      g.addColorStop(0, shade(base, 0.35));
      g.addColorStop(0.55, base);
      g.addColorStop(1, shade(base, -0.45));
      c.fillStyle = g;
      c.fill();
      c.lineWidth = 3.5; c.strokeStyle = shade(base, -0.6); c.stroke();
      // embossed inner rim
      blob(-12, 0.015);
      c.lineWidth = 5; c.strokeStyle = shade(base, -0.4); c.stroke();
      c.save(); c.translate(-1.5, -2); blob(-12, 0.015); c.lineWidth = 2; c.strokeStyle = shade(base, 0.45); c.stroke(); c.restore();
      // specular glint
      c.beginPath(); c.ellipse(cx - rx * 0.45, cy - ry * 0.55, rx * 0.22, ry * 0.12, -0.5, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,250,235,0.35)'; c.fill();
      // numeral: pressed into the wax (dark inset + light lower edge) then cream fill
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const ty = cy + 5;
      c.lineJoin = 'round';
      c.lineWidth = 9; c.strokeStyle = shade(base, -0.7); c.strokeText(txt, cx, ty);
      c.fillStyle = 'rgba(255,240,210,0.5)'; c.fillText(txt, cx + 1.5, ty + 2.5);
      c.fillStyle = '#fff6e2'; c.fillText(txt, cx, ty);
    }
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}
