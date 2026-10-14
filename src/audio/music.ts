// Procedural adaptive war-table music (D minor, ~128–136 BPM).
// Lookahead scheduler: a setInterval wakes every 25 ms and schedules every 16th-note step that
// falls within the lookahead window against AudioContext time.
//
// Layers (levels derived from smoothed intensity, applied per note → crossfades with no automation):
//   pad (always) · heartbeat taiko (menu) · war drums · bass ostinato · hats/shakers · brass lead
import { type Kit, Voice, mtof, rand, smoothstep, clamp, perc } from './core';
import { drum, noiseHit, brass } from './synth';

type Quality = 'm' | 'M';
interface Chord { pc: number; q: Quality }
const C = (pc: number, q: Quality): Chord => ({ pc, q });
// pitch classes: D=2 E=4 F=5 G=7 A=9 Bb=10 C=0
const Dm = C(2, 'm'), Gm = C(7, 'm'), Bb = C(10, 'M'), F = C(5, 'M'), Cmaj = C(0, 'M'), A = C(9, 'M');

const PROGRESSIONS: Chord[][] = [
  [Dm, Bb, F, Cmaj],
  [Dm, Gm, Bb, A],
  [Dm, Cmaj, Bb, Cmaj],
  [Dm, Bb, Gm, A],
  [Dm, F, Cmaj, Bb],
];

const tonesOf = (c: Chord): number[] => [0, c.q === 'm' ? 3 : 4, 7, 12];
/** semitones of chord root above D (0..11) */
const rel = (c: Chord): number => (c.pc - 2 + 12) % 12;

// 16-step patterns. Drums: 'X' accent, 'x' normal, 'o' ghost, '.' rest.
const HEART = ['X.....x.X.......', 'X.....x.X...x...', 'X.......X.....x.'];
const KICK = ['X..x..x.X..x....', 'X..x....X.xx....', 'X.....x.X..x..x.', 'X..x..x.X.....x.'];
const TOM_LO = ['......x.......x.', '..x.......x...x.', '......x...x.....', '....x.x.......x.'];
const TOM_HI = ['....x.......x...', '....x..x....x...', '....X.......X..x', '....x.......x.x.'];
const FILL = '....x.x.xxXxXXXX';
const HATS = ['x.x.x.x.x.x.x.x.', 'x.xox.x.x.xox.xo', 'x.x.xxx.x.x.xxx.'];
const SHAKER = 'oxoxoxoxoxoxoxox';
// bass: chord-tone index per step (0 root, 1 third, 2 fifth, 3 octave), -1 rest
const BASS = [
  [0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 2, -1, 3, -1],
  [0, -1, 3, -1, 0, -1, 3, -1, 0, -1, 3, -1, 2, -1, 1, -1],
  [0, 0, -1, 0, 0, -1, 2, -1, 0, 0, -1, 0, 3, -1, 2, -1],
  [0, -1, 0, 2, 3, -1, 2, 0, 0, -1, 0, 2, 3, 2, 1, -1],
];
// lead motifs: [step, chord-tone index, length in steps]
const MOTIFS: [number, number, number][][] = [
  [[0, 2, 2], [3, 2, 1], [6, 3, 4]],
  [[0, 3, 1], [2, 3, 1], [4, 2, 2], [8, 1, 5]],
  [[0, 0, 2], [3, 1, 2], [6, 2, 2], [10, 3, 4]],
  [[2, 2, 1], [3, 3, 3], [10, 2, 1], [12, 1, 3]],
];

const vel = (ch: string): number => (ch === 'X' ? 1 : ch === 'x' ? 0.72 : ch === 'o' ? 0.35 : 0);

export class Music {
  private ctx: BaseAudioContext;
  private kit: Kit;
  private bus: GainNode;      // fade in/out
  private reverb: AudioNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  running = false;

  private target = 0;      // requested intensity
  private smooth = 0;      // smoothed intensity used for decisions
  private bpm = 130;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private prog = PROGRESSIONS[0];
  private progIdx = 0;
  private v = { heart: 0, kick: 0, tomLo: 0, tomHi: 0, hats: 0, bass: 0, motif: 0 };

  constructor(ctx: BaseAudioContext, out: AudioNode, reverb: AudioNode, kit: Kit) {
    this.ctx = ctx;
    this.kit = kit;
    this.reverb = reverb;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(out);
  }

  setIntensity(x: number): void {
    this.target = clamp(Number.isFinite(x) ? x : 0, 0, 1);
  }

  start(): void {
    const t = this.ctx.currentTime;
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(1, t + 1.8);
    if (this.running) return;
    this.running = true;
    this.step = 0;
    this.bar = 0;
    this.smooth = this.target;
    this.progIdx = 0;
    this.prog = PROGRESSIONS[0];
    this.nextTime = t + 0.08;
    if (typeof setInterval === 'function') this.timer = setInterval(() => this.pump(), 25);
  }

  stop(fade = 1.4): void {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0, t + fade);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.halt(), (fade + 0.25) * 1000);
  }

  /** Immediately stop scheduling (already scheduled notes ring out under the faded bus). */
  halt(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.timer = null;
    this.stopTimer = null;
    this.running = false;
  }

  private pump(): void {
    try {
      const hidden = typeof document !== 'undefined' && document.hidden;
      this.scheduleUntil(this.ctx.currentTime + (hidden ? 1.2 : 0.14));
    } catch (e) {
      // never let the scheduler throw repeatedly
      console.warn('[audio] music scheduler error', e);
      this.halt();
    }
  }

  /** Schedule all steps up to time `until` (exposed for offline rendering tests). */
  scheduleUntil(until: number): void {
    const now = this.ctx.currentTime;
    // resync after the timer was throttled / context was suspended
    if (this.nextTime < now - 0.05) this.nextTime = now + 0.03;
    while (this.nextTime < until) {
      const sd = 60 / this.bpm / 4;
      this.doStep(this.step, this.nextTime, sd);
      this.nextTime += sd;
      this.step++;
      if (this.step >= 16) { this.step = 0; this.bar++; }
    }
  }

  private doStep(s: number, t: number, sd: number): void {
    // smooth intensity (time constant ~1.2 s)
    this.smooth += (this.target - this.smooth) * (1 - Math.exp(-sd / 1.2));
    const I = this.smooth;
    const bar = this.bar;
    const phraseBar = bar % 8;

    if (s === 0) this.onBar(bar);
    const chord = this.prog[bar % 4];
    const swing = s % 2 === 1 ? sd * 0.08 : 0;
    const tt = t + swing;

    // ---- layer levels
    const lPad = 0.95 - 0.35 * I;
    const lHeart = 1 - smoothstep(0.3, 0.65, I);
    const lDrums = smoothstep(0.15, 0.6, I);
    const lBass = smoothstep(0.1, 0.45, I);
    const lHats = smoothstep(0.35, 0.7, I);
    const lShaker = smoothstep(0.6, 0.95, I);
    const lLead = smoothstep(0.55, 0.9, I);
    const fillBar = phraseBar === 7 && I > 0.3;

    // ---- pad (once per bar)
    if (s === 0 && lPad > 0.02) this.pad(chord, t, sd * 16, lPad, I);

    // ---- heartbeat taiko (menu)
    if (lHeart > 0.02) {
      const c = HEART[this.v.heart][s];
      const vv = vel(c);
      if (vv) this.hit((v) => drum(v, this.kit, tt, 78, 46, 0.55, 0.55 * vv, 0.35, 450), lHeart * 0.9, 0, 0.12);
    }

    // ---- war drums
    if (lDrums > 0.02) {
      if (fillBar && s >= 4) {
        const vv = vel(FILL[s]);
        if (vv) {
          const f = 150 + (s - 4) * -6;
          this.hit((v) => drum(v, this.kit, tt, f, f * 0.6, 0.22, 0.5 * vv, 0.5, 1100), lDrums, rand(-0.3, 0.3), 0.15);
        }
      } else {
        const k = vel(KICK[this.v.kick][s]);
        if (k) this.hit((v) => drum(v, this.kit, tt, 92, 44, 0.42, 0.7 * k, 0.3, 500), lDrums, 0, 0.08);
        const lo = vel(TOM_LO[this.v.tomLo][s]);
        if (lo) this.hit((v) => drum(v, this.kit, tt, 120, 82, 0.32, 0.42 * lo, 0.45, 900), lDrums, -0.25, 0.14);
        const hi = vel(TOM_HI[this.v.tomHi][s]);
        if (hi) {
          this.hit((v) => {
            drum(v, this.kit, tt, 175, 125, 0.24, 0.36 * hi, 0.5, 1400);
            // rim/clap layer at high intensity
            if (I > 0.6) noiseHit(v, this.kit.white, tt, 0.001, 0.09, 0.2 * hi, 'bandpass', 1800, 1.4);
          }, lDrums, 0.25, 0.14);
        }
      }
      if (phraseBar === 0 && s === 0 && bar > 0 && I > 0.55) {
        this.hit((v) => noiseHit(v, this.kit.white, t, 0.004, 1.1, 0.12, 'highpass', 5500, 0.6), lDrums, 0.2, 0.25);
      }
    }

    // ---- bass ostinato
    if (lBass > 0.02) {
      const idx = BASS[this.v.bass][s];
      const calm = I < 0.45;
      if (idx >= 0 && !(calm && s % 2 === 1)) {
        let m = 38 + rel(chord);
        if (m > 45) m -= 12;
        m += tonesOf(chord)[idx];
        const acc = s % 4 === 0 ? 1 : 0.75;
        this.hit((v) => this.bassNote(v, mtof(m), tt, sd * (calm ? 1.7 : 0.9), 0.32 * acc, I), lBass, 0, 0);
      }
    }

    // ---- hats + shaker
    if (lHats > 0.02) {
      const h = vel(HATS[this.v.hats][s]);
      if (h) {
        const open = s % 8 === 6 && I > 0.75;
        this.hit((v) => noiseHit(v, this.kit.white, tt, 0.001, open ? 0.16 : 0.035, 0.22 * h, 'highpass', 7500, 0.7), lHats, 0.35, 0.05);
      }
      if (lShaker > 0.02) {
        const sh = vel(SHAKER[s]);
        if (sh) this.hit((v) => noiseHit(v, this.kit.white, tt, 0.012, 0.04, 0.12 * sh, 'bandpass', 6000, 1.5), lShaker * lHats, -0.4, 0.03);
      }
    }

    // ---- brass lead motif: call on bars 2 & 4 of every 4 (or every bar near max intensity)
    if (lLead > 0.02) {
      const b4 = bar % 4;
      const playBar = b4 === 1 || b4 === 3 || (I > 0.9 && b4 === 2);
      if (playBar && !fillBar) {
        const motif = MOTIFS[(this.v.motif + (b4 === 3 ? 1 : 0)) % MOTIFS.length];
        for (const [st, ti, len] of motif) {
          if (st !== s) continue;
          let m = 62 + rel(chord) + tonesOf(chord)[ti];
          while (m > 76) m -= 12;
          const dur = len * sd * 0.9;
          this.hit((v) => {
            brass(v, mtof(m), t, dur, 0.13, 0.55 + 0.4 * I);
            if (I > 0.8) brass(v, mtof(m - 12), t, dur, 0.08, 0.5);
          }, lLead, rand(-0.15, 0.15), 0.25);
        }
      }
    }
  }

  private onBar(bar: number): void {
    const I = this.smooth;
    // tempo drifts with intensity, applied on bar lines only
    this.bpm = 128 + 8 * I;
    if (bar % 8 === 0 && bar > 0) {
      // new chord progression every 8 bars (sometimes keep it)
      if (Math.random() < 0.65) {
        let n = this.progIdx;
        while (n === this.progIdx) n = (Math.random() * PROGRESSIONS.length) | 0;
        this.progIdx = n;
        this.prog = PROGRESSIONS[n];
      }
    }
    if (bar % 4 === 0) {
      const r = () => (Math.random() * 4) | 0;
      this.v.kick = r() % KICK.length;
      this.v.tomLo = r() % TOM_LO.length;
      this.v.tomHi = r() % TOM_HI.length;
      this.v.bass = r() % BASS.length;
      this.v.hats = r() % HATS.length;
      this.v.heart = r() % HEART.length;
    }
    if (bar % 8 === 0) this.v.motif = (Math.random() * MOTIFS.length) | 0;
  }

  /** Create a one-shot voice on the music bus and build into it. */
  private hit(build: (v: Voice) => void, level: number, pan: number, verb: number): void {
    const v = new Voice(this.ctx, this.bus, level, pan, this.reverb, verb);
    build(v);
  }

  private bassNote(v: Voice, f: number, t: number, d: number, vol: number, I: number): void {
    const g = v.gain(0);
    perc(g.gain, t, 0.004, vol, d);
    const lp = v.filter('lowpass', 300, 4, g);
    const top = 380 + 1100 * I;
    lp.frequency.setValueAtTime(top, t);
    lp.frequency.exponentialRampToValueAtTime(top * 0.35, t + d);
    v.osc('sawtooth', f, t, t + d + 0.02, lp);
    v.osc('square', f * 0.5, t, t + d + 0.02, lp, 4);
  }

  private pad(ch: Chord, t: number, dur: number, level: number, I: number): void {
    const v = new Voice(this.ctx, this.bus, level, 0, this.reverb, 0.55);
    const g = v.gain(0);
    const a = 0.45, r = 0.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.042, t + a);
    g.gain.setValueAtTime(0.042, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur + r);
    const lp = v.filter('lowpass', 600 + 1400 * I, 0.6, g);
    let root = 50 + rel(ch);
    if (root > 57) root -= 12;
    const tones = tonesOf(ch);
    const notes = [root, root + tones[1] + 12, root + tones[2], root + 12 + 7];
    const end = t + dur + r + 0.05;
    for (const m of notes) {
      v.osc('sawtooth', mtof(m), t, end, lp, rand(-9, -4));
      v.osc('triangle', mtof(m), t, end, lp, rand(4, 9));
    }
    // airy top sine
    const air = v.gain(0.25, g);
    v.osc('sine', mtof(root + 24 + tones[2]), t, end, air);
  }
}
