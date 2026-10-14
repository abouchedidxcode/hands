import { FACTION_NAMES, factionColor, MANA } from '../config';

const CHARGES = Math.floor(MANA.max / MANA.smiteCost);

/** In-game DOM overlay: army share bar, level/timer, mana, toasts, coach hints. */
export class Hud {
  private power: HTMLDivElement;
  private segs: { el: HTMLDivElement; name: HTMLElement; num: HTMLElement }[] = [];
  private lv: HTMLDivElement;
  private tm: HTMLDivElement;
  private mana: HTMLDivElement;
  private manaFill: HTMLDivElement;
  private manaLabel: HTMLDivElement;
  private smiteEl: HTMLElement;
  private smiteCnt: HTMLElement;
  private rallyEl: HTMLElement;
  private rallyChip: HTMLElement;
  private rallySecs: HTMLElement;
  private lastKey = '';
  private lastToast = new Map<string, number>();
  private coachKey = '';

  constructor(private root: HTMLElement, private toasts: HTMLElement, private coach: HTMLElement) {
    root.innerHTML = `
      <div class="hud-top">
        <div class="level-tag"><div class="lv"></div><div class="tm"></div></div>
        <div class="power"></div>
      </div>
      <div class="rally-chip"><span class="g">👏</span><b>RALLY</b><span class="secs"></span></div>
      <div class="mana">
        <div class="pw smite"><div class="ring"><span>✊</span></div><div class="pl"><b>SMITE</b><i>${MANA.smiteCost}</i></div><div class="cnt"></div></div>
        <div class="mcol">
          <div class="bar"><div class="fill"></div></div>
          <div class="label"></div>
        </div>
        <div class="pw rally"><div class="ring"><span>👏</span></div><div class="pl"><b>RALLY</b><i>${MANA.rallyCost}</i></div></div>
      </div>`;
    this.power = root.querySelector('.power')!;
    this.lv = root.querySelector('.lv')!;
    this.tm = root.querySelector('.tm')!;
    this.mana = root.querySelector('.mana')!;
    this.manaFill = root.querySelector('.fill')!;
    this.manaLabel = root.querySelector('.mana .label')!;
    const bar = root.querySelector('.mana .bar')!;
    // cost markers: every smite charge (white) + the rally cost (gold)
    const ticks: [number, string, string][] = [];
    for (let c = MANA.smiteCost; c < MANA.max; c += MANA.smiteCost) ticks.push([c, 'tick', '✊']);
    ticks.push([MANA.rallyCost, 'tick rally', '👏']);
    for (const [c, cls, icon] of ticks) {
      const t = document.createElement('div');
      t.className = cls;
      t.style.left = `${(c / MANA.max) * 100}%`;
      t.dataset.icon = icon;
      bar.appendChild(t);
    }
    this.smiteEl = root.querySelector('.pw.smite')!;
    this.smiteCnt = root.querySelector('.pw.smite .cnt')!;
    this.rallyEl = root.querySelector('.pw.rally')!;
    this.rallyChip = root.querySelector('.rally-chip')!;
    this.rallySecs = root.querySelector('.rally-chip .secs')!;
  }

  show(on: boolean) { this.root.classList.toggle('hidden', !on); }

  setup(factions: number, levelName: string) {
    this.power.innerHTML = '';
    this.segs = [];
    for (let f = 0; f < factions; f++) {
      const d = document.createElement('div');
      d.className = `seg${f === 0 ? ' me' : ''}`;
      d.style.setProperty('--fc', factionColor(f));
      d.innerHTML = `<b>${f === 0 ? 'YOU' : FACTION_NAMES[f].toUpperCase()}</b><span></span>`;
      d.style.flexGrow = '1';
      this.power.appendChild(d);
      this.segs.push({ el: d, name: d.querySelector('b')!, num: d.querySelector('span')! });
    }
    this.lv.textContent = levelName;
  }

  update(strength: number[], time: number, mana: number, showMana: boolean, rallyLeft = 0) {
    const total = strength.reduce((a, b) => a + b, 0) || 1;
    strength.forEach((s, f) => {
      const seg = this.segs[f];
      if (!seg) return;
      const share = s / total;
      seg.el.style.flexGrow = String(Math.max(0.0001, share));
      seg.el.classList.toggle('dead', s <= 0);
      seg.el.classList.toggle('narrow', share < 0.2);
      seg.el.classList.toggle('tiny', share < 0.075);
      seg.num.textContent = String(Math.round(s));
    });
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.tm.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.mana.style.display = showMana ? '' : 'none';
    this.manaFill.style.width = `${(mana / MANA.max) * 100}%`;
    const ready = Math.min(CHARGES, Math.floor(mana / MANA.smiteCost));
    const canRally = mana >= MANA.rallyCost;
    const rallying = rallyLeft > 0;
    this.smiteEl.style.setProperty('--f', Math.min(1, mana / MANA.smiteCost).toFixed(3));
    this.rallyEl.style.setProperty('--f', Math.min(1, mana / MANA.rallyCost).toFixed(3));
    this.smiteEl.classList.toggle('on', ready > 0);
    this.rallyEl.classList.toggle('on', canRally);
    this.rallyEl.classList.toggle('active', rallying);
    this.smiteCnt.textContent = ready > 1 ? `×${ready}` : '';
    this.mana.classList.toggle('ready', ready > 0);
    this.rallyChip.classList.toggle('on', rallying);
    if (rallying) this.rallySecs.textContent = `${rallyLeft.toFixed(1)}s`;
    this.root.classList.toggle('rallying', rallying);
    const key = `${ready}|${canRally}`;
    if (key !== this.lastKey) {
      const gained = this.lastKey !== '' && (ready > Number(this.lastKey.split('|')[0]) || (canRally && this.lastKey.endsWith('false')));
      this.lastKey = key;
      this.manaLabel.innerHTML = ready === 0
        ? `MANA CHARGING · <b>✊</b> ${MANA.smiteCost} · <b>👏</b> ${MANA.rallyCost}`
        : `<b>✊ fist → 🖐 open</b> to SMITE${canRally ? ' · <b class="gold">👏 clap</b> to RALLY' : ''}`;
      if (gained) { this.mana.classList.remove('gain'); void this.mana.offsetWidth; this.mana.classList.add('gain'); }
    }
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
    setTimeout(() => el.remove(), small ? 1250 : 1650);
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
    this.coach.innerHTML = `<div class="g"><span>${icon}</span></div><div class="t"><em>TRAINING</em><b>${title}</b><span>${sub}</span></div>`;
    // restart entrance animation
    this.coach.style.animation = 'none';
    void this.coach.offsetWidth;
    this.coach.style.animation = '';
  }

  clearToasts() { this.toasts.innerHTML = ''; }
}
