import * as THREE from 'three';

const CW = 256, CH = 128;

/** Garrison count pill drawn into a canvas sprite. Redraws only when its content changes. */
export class Label {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  sprite: THREE.Sprite;
  /** world size of the full canvas */
  static W = 2.9;
  private key = '';
  /** last integer shown (for tick detection) */
  shown = -1;

  constructor() {
    this.canvas.width = CW; this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    mat.color.setScalar(0.8); // keep under the bloom threshold so the pill stays crisp
    this.sprite = new THREE.Sprite(mat);
    this.sprite.center.set(0.5, 0.0);
    this.sprite.scale.set(Label.W, Label.W * CH / CW, 1);
    this.sprite.renderOrder = 50;
  }

  /** mode: 0 owned, 1 neutral, 2 hit flash */
  set(n: number, color: string, dark: string, mode: 0 | 1 | 2) {
    const key = `${n}|${color}|${mode}`;
    if (key === this.key) return;
    this.key = key;
    const c = this.ctx;
    c.clearRect(0, 0, CW, CH);
    const txt = String(n);
    c.font = '900 80px "Rubik", "Segoe UI", system-ui, sans-serif';
    const tw = c.measureText(txt).width;
    const h = 84, w = Math.max(h + 6, tw + 52);
    const x = (CW - w) / 2, y = 28;
    // drop shadow
    c.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(c, x + 2, y + 7, w, h, h / 2); c.fill();
    // outer dark outline
    c.lineJoin = 'round';
    roundRect(c, x, y, w, h, h / 2);
    c.lineWidth = 9;
    c.strokeStyle = mode === 1 ? 'rgba(28,24,20,0.95)' : 'rgba(10,14,22,0.92)';
    c.stroke();
    // fill
    if (mode === 2) c.fillStyle = '#ff2b3d';
    else if (mode === 1) c.fillStyle = '#4a443c';
    else {
      const gr = c.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, color); gr.addColorStop(1, dark);
      c.fillStyle = gr;
    }
    c.fill();
    // inner highlight
    if (mode !== 1) {
      roundRect(c, x + 6, y + 5, w - 12, h * 0.42, h * 0.21);
      c.fillStyle = 'rgba(255,255,255,0.14)';
      c.fill();
    } else {
      roundRect(c, x + 5, y + 5, w - 10, h - 10, (h - 10) / 2);
      c.setLineDash([10, 8]);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(220,210,190,0.55)';
      c.stroke();
      c.setLineDash([]);
    }
    // number: heavy dark stroke then white fill
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const ty = y + h / 2 + 4;
    c.lineWidth = 11;
    c.strokeStyle = mode === 1 ? 'rgba(20,17,14,0.9)' : 'rgba(8,12,24,0.85)';
    c.strokeText(txt, CW / 2, ty);
    c.fillStyle = mode === 1 ? '#e9e1d2' : '#ffffff';
    c.fillText(txt, CW / 2, ty);
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
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
