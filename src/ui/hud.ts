import { factionColor, MANA } from '../config';

/** In-game DOM overlay: army share bar, level/timer, mana, toasts, coach hints. */
export class Hud {
  private power: HTMLDivElement;
  private segs: HTMLDivElement[] = [];
  private lv: HTMLDivElement;
  private tm: HTMLDivElement;
  private mana: HTMLDivElement;
  private manaFill: HTMLDivElement;
  private manaLabel: HTMLDivElement;
  private lastToast = new Map<string, number>();
  private coachKey = '';

  constructor(private root: HTMLElement, private toasts: HTMLElement, private coach: HTMLElement) {
    root.innerHTML = `
      <div class="level-tag"><div class="lv"></div><div class="tm"></div></div>
      <div class="topbar"><div class="power"></div></div>
      <div class="mana"><div class="bar"><div class="fill"></div></div><div class="label"></div></div>`;
    this.power = root.querySelector('.power')!;
    this.lv = root.querySelector('.lv')!;
    this.tm = root.querySelector('.tm')!;
    this.mana = root.querySelector('.mana')!;
    this.manaFill = root.querySelector('.fill')!;
    this.manaLabel = root.querySelector('.mana .label')!;
    const bar = root.querySelector('.mana .bar')!;
    for (let c = MANA.smiteCost; c < MANA.max; c += MANA.smiteCost) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.left = `${(c / MANA.max) * 100}%`;
      bar.appendChild(t);
    }
  }

  show(on: boolean) { this.root.classList.toggle('hidden', !on); }

  setup(factions: number, levelName: string) {
    this.power.innerHTML = '';
    this.segs = [];
    for (let f = 0; f < factions; f++) {
      const d = document.createElement('div');
      d.style.background = `linear-gradient(180deg, ${factionColor(f)}, color-mix(in srgb, ${factionColor(f)} 70%, #000))`;
      d.style.flexGrow = '1';
      this.power.appendChild(d);
      this.segs.push(d);
    }
    this.lv.textContent = levelName;
  }

  update(strength: number[], time: number, mana: number, showMana: boolean) {
    const total = strength.reduce((a, b) => a + b, 0) || 1;
    strength.forEach((s, f) => {
      const seg = this.segs[f];
      if (!seg) return;
      seg.style.flexGrow = String(Math.max(0.0001, s / total));
      seg.textContent = s / total > 0.07 ? String(Math.round(s)) : '';
    });
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.tm.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.mana.style.display = showMana ? '' : 'none';
    this.manaFill.style.width = `${(mana / MANA.max) * 100}%`;
    const ready = mana >= MANA.smiteCost;
    this.mana.classList.toggle('ready', ready);
    this.manaLabel.textContent = ready ? '✊ HOLD A FIST · 🖐 OPEN TO SMITE' : 'MANA · CHARGING';
  }

  toast(text: string, color = '#ffffff', small = false, key = text, minGap = 0.8) {
    const now = performance.now() / 1000;
    if ((this.lastToast.get(key) ?? -99) > now - minGap) return;
    this.lastToast.set(key, now);
    const el = document.createElement('div');
    el.className = `toast${small ? ' small' : ''}`;
    el.style.color = color;
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
    setTimeout(() => el.remove(), 1700);
  }

  countdown(text: string, color = '#ffffff') {
    const el = document.createElement('div');
    el.className = 'countdown';
    el.style.color = color;
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  setCoach(icon: string | null, title = '', sub = '') {
    const key = `${icon}|${title}|${sub}`;
    if (key === this.coachKey) return;
    this.coachKey = key;
    if (!icon) { this.coach.classList.add('hidden'); return; }
    this.coach.classList.remove('hidden');
    this.coach.innerHTML = `<div class="g">${icon}</div><div class="t"><b>${title}</b><span>${sub}</span></div>`;
    // restart entrance animation
    this.coach.style.animation = 'none';
    void this.coach.offsetWidth;
    this.coach.style.animation = '';
  }

  clearToasts() { this.toasts.innerHTML = ''; }
}
