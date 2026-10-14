// Procedural SFX recipes. Each builds a small graph into a Voice starting at time t.
// `p` is the pitch multiplier (user pitch × random variation).
import type { Sfx } from './audio';
import { type Kit, type Voice, perc, sweep, rand, pick, mtof, semis } from './core';
import { tone, noiseHit, drum, brass, bell, pluck, clink, cymbal } from './synth';

export interface SfxDef {
  /** base gain */
  vol: number;
  /** reverb send amount */
  verb: number;
  /** ± random pitch variation in semitones */
  vary: number;
  /** random pan spread when caller gives no pan */
  spread: number;
  build: (v: Voice, t: number, p: number, k: Kit) => void;
}

const D4 = 62;

export const SFX: Record<Sfx, SfxDef> = {
  hover: {
    vol: 0.5, verb: 0.05, vary: 0.4, spread: 0,
    build(v, t, p) {
      tone(v, 'sine', 1500 * p, t, 0.003, 0.045, 0.16, 1750 * p);
    },
  },

  tick: {
    vol: 0.6, verb: 0.04, vary: 0.3, spread: 0,
    build(v, t, p, k) {
      tone(v, 'triangle', 3100 * p, t, 0.001, 0.02, 0.22, 2600 * p);
      noiseHit(v, k.white, t, 0.0005, 0.012, 0.16, 'highpass', 6000, 0.7);
    },
  },

  confirm: {
    vol: 0.6, verb: 0.12, vary: 0.2, spread: 0,
    build(v, t, p) {
      tone(v, 'triangle', mtof(81) * p, t, 0.004, 0.09, 0.3);
      tone(v, 'triangle', mtof(88) * p, t + 0.07, 0.004, 0.2, 0.3);
      tone(v, 'sine', mtof(100) * p, t + 0.07, 0.002, 0.14, 0.06);
    },
  },

  pinch: {
    vol: 0.55, verb: 0.03, vary: 0.6, spread: 0,
    build(v, t, p, k) {
      tone(v, 'sine', 1150 * p, t, 0.002, 0.05, 0.32, 620 * p);
      noiseHit(v, k.white, t, 0.001, 0.018, 0.12, 'bandpass', 3200, 2);
    },
  },

  release: {
    vol: 0.5, verb: 0.15, vary: 0.1, spread: 0,
    build(v, t, p) {
      // pluck on a D-minor-pentatonic degree → repeated releases sound melodic
      const f = mtof(D4 + pick([0, 3, 5, 7, 10, 12])) * p;
      pluck(v, f, t, 0.32, 0.32);
      tone(v, 'sine', f * 2, t, 0.002, 0.08, 0.06);
    },
  },

  cancel: {
    vol: 0.8, verb: 0.08, vary: 0.3, spread: 0,
    build(v, t, p) {
      const lp = v.filter('lowpass', 1900, 0.8);
      tone(v, 'square', 540 * p, t, 0.004, 0.09, 0.14, 420 * p, lp);
      tone(v, 'square', 400 * p, t + 0.07, 0.004, 0.14, 0.14, 270 * p, lp);
    },
  },

  launch: {
    vol: 0.6, verb: 0.18, vary: 0.8, spread: 0.3,
    build(v, t, p, k) {
      // horn blip (root + fifth) …
      brass(v, mtof(57) * p, t, 0.13, 0.22, 0.75);
      brass(v, mtof(64) * p, t + 0.012, 0.11, 0.13, 0.75);
      drum(v, k, t, 140 * p, 65 * p, 0.14, 0.3, 0.2);
      // … then the whoosh of marching off
      const g = v.gain(0);
      g.gain.setValueAtTime(0, t + 0.04);
      g.gain.linearRampToValueAtTime(0.32, t + 0.17);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
      const bp = v.filter('bandpass', 500, 1.3, g);
      bp.frequency.setValueAtTime(450, t + 0.04);
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
      bp.frequency.exponentialRampToValueAtTime(900, t + 0.5);
      v.noise(k.pink, t + 0.04, t + 0.55, bp);
    },
  },

  clash: {
    vol: 0.5, verb: 0.06, vary: 2.5, spread: 0.6,
    build(v, t, p) {
      clink(v, rand(1900, 3300) * p, t, rand(0.045, 0.1), 0.2);
    },
  },

  hit: {
    vol: 0.5, verb: 0.05, vary: 1.5, spread: 0.4,
    build(v, t, p, k) {
      drum(v, k, t, 230 * p, 105 * p, 0.08, 0.3, 0);
      noiseHit(v, k.pink, t, 0.001, 0.035, 0.28, 'bandpass', 1300 * p, 3);
    },
  },

  capture: {
    vol: 0.6, verb: 0.35, vary: 0.15, spread: 0,
    build(v, t, p, k) {
      // rising major arpeggio stinger (D major) with timpani + shimmer
      const notes = [D4, D4 + 4, D4 + 7, D4 + 12];
      notes.forEach((m, i) => {
        const st = t + i * 0.055;
        brass(v, mtof(m) * p, st, 0.62 - i * 0.04, 0.12, 0.85);
      });
      brass(v, mtof(D4 - 12) * p, t, 0.6, 0.1, 0.4);
      drum(v, k, t, 120, 78, 0.5, 0.42, 0.3, 700);
      bell(v, mtof(D4 + 24) * p, t + 0.17, 0.9, 0.08);
      bell(v, mtof(D4 + 31) * p, t + 0.22, 0.7, 0.05);
      noiseHit(v, k.white, t + 0.1, 0.25, 0.4, 0.06, 'highpass', 6000, 0.5);
    },
  },

  lost: {
    vol: 0.6, verb: 0.3, vary: 0.1, spread: 0,
    build(v, t, p, k) {
      // descending minor: A4 → F4 → D4 (dark brass) + low drum
      brass(v, mtof(69) * p, t, 0.13, 0.13, 0.35);
      brass(v, mtof(65) * p, t + 0.15, 0.13, 0.13, 0.3);
      brass(v, mtof(62) * p, t + 0.3, 0.5, 0.14, 0.25);
      brass(v, mtof(50) * p, t + 0.3, 0.5, 0.1, 0.2);
      drum(v, k, t + 0.3, 85, 42, 0.6, 0.45, 0.3, 500);
    },
  },

  smite: {
    vol: 0.95, verb: 0.55, vary: 1.0, spread: 0,
    build(v, t, p, k) {
      // 1) crack: broadband + highpassed snap
      noiseHit(v, k.white, t, 0.0005, 0.035, 0.9, 'highpass', 900, 0.5);
      noiseHit(v, k.white, t, 0.001, 0.12, 0.7, 'highpass', 2500 * p, 0.7, 1500);
      // 2) crackle burst (electric)
      {
        const g = v.gain(0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.9, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        const bp = v.filter('bandpass', 2600 * p, 0.6, g);
        v.noise(k.crackle, t, t + 0.72, bp, rand(0.8, 1.3));
      }
      // 3) sub boom
      {
        const g = v.gain(0);
        perc(g.gain, t + 0.008, 0.006, 0.95, 1.3);
        const o = v.osc('sine', 95 * p, t + 0.008, t + 1.4, g);
        sweep(o.frequency, t + 0.008, 95 * p, 27, 0.9);
      }
      drum(v, k, t + 0.005, 190 * p, 48, 0.3, 0.5, 0.5, 1200);
      // 4) rumbling tail: brown noise, lowpass sweeping down, slow AM wobble
      {
        const g = v.gain(0);
        g.gain.setValueAtTime(0, t + 0.03);
        g.gain.linearRampToValueAtTime(0.8, t + 0.18);
        g.gain.setTargetAtTime(0, t + 0.35, 0.7);
        const lp = v.filter('lowpass', 700, 0.9, g);
        sweep(lp.frequency, t + 0.03, 700, 110, 2.6);
        v.noise(k.brown, t + 0.03, t + 3.2, lp, rand(0.85, 1.1));
        // rolling thunder echo
        noiseHit(v, k.brown, t + rand(0.5, 0.8), 0.15, 1.1, 0.45, 'lowpass', 380, 0.8, 140);
      }
    },
  },

  swat: {
    vol: 0.7, verb: 0.12, vary: 0.8, spread: 0.3,
    build(v, t, p, k) {
      const g = v.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.55, t + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      const bp = v.filter('bandpass', 300, 1.1, g);
      bp.frequency.setValueAtTime(320 * p, t);
      bp.frequency.exponentialRampToValueAtTime(2000 * p, t + 0.1);
      bp.frequency.exponentialRampToValueAtTime(500 * p, t + 0.3);
      v.noise(k.pink, t, t + 0.32, bp);
      drum(v, k, t + 0.09, 150 * p, 48, 0.24, 0.6, 0.45, 700);
    },
  },

  arrow: {
    vol: 0.7, verb: 0.08, vary: 1.5, spread: 0.5,
    build(v, t, p, k) {
      noiseHit(v, k.white, t, 0.004, 0.1, 0.32, 'bandpass', 5200 * p, 4, 1200 * p);
      tone(v, 'sine', 2600 * p, t, 0.004, 0.07, 0.05, 1500 * p);
    },
  },

  denied: {
    vol: 0.5, verb: 0.05, vary: 0.2, spread: 0,
    build(v, t, p) {
      const lp = v.filter('lowpass', 1300, 1);
      for (const st of [0, 0.13]) {
        const g = v.gain(0, lp);
        g.gain.setValueAtTime(0, t + st);
        g.gain.linearRampToValueAtTime(0.18, t + st + 0.008);
        g.gain.setValueAtTime(0.18, t + st + 0.08);
        g.gain.linearRampToValueAtTime(0, t + st + 0.1);
        v.osc('square', 150 * p, t + st, t + st + 0.11, g);
        v.osc('sawtooth', 157 * p, t + st, t + st + 0.11, g);
      }
    },
  },

  manaFull: {
    vol: 0.55, verb: 0.5, vary: 0.1, spread: 0,
    build(v, t, p, k) {
      const notes = [86, 90, 93, 98, 102];
      notes.forEach((m, i) => bell(v, mtof(m) * p, t + i * 0.045, 1.1, 0.06));
      tone(v, 'triangle', mtof(74) * p, t, 0.08, 0.9, 0.08);
      noiseHit(v, k.white, t, 0.3, 0.35, 0.05, 'highpass', 4000, 0.8, 9000);
    },
  },

  countdown: {
    vol: 0.65, verb: 0.15, vary: 0.05, spread: 0,
    build(v, t, p, k) {
      tone(v, 'sine', 1050 * p, t, 0.001, 0.09, 0.28, 820 * p);
      tone(v, 'triangle', 525 * p, t, 0.001, 0.11, 0.14);
      drum(v, k, t, 125, 72, 0.3, 0.45, 0.35, 800);
    },
  },

  go: {
    vol: 0.7, verb: 0.3, vary: 0, spread: 0,
    build(v, t, p, k) {
      for (const m of [D4, D4 + 4, D4 + 7, D4 + 12]) brass(v, mtof(m) * p, t, 0.45, 0.11, 1);
      brass(v, mtof(D4 - 12) * p, t, 0.45, 0.12, 0.6);
      drum(v, k, t, 105, 40, 0.55, 0.65, 0.5, 900);
      cymbal(v, k, t, 0.9, 0.16);
    },
  },

  victory: {
    vol: 0.7, verb: 0.35, vary: 0, spread: 0,
    build(v, t, p, k) {
      const n = (m: number) => mtof(m) * p;
      // da-da-da DAAA … da-da … DAAAAA (D major)
      const tri = 0.12;
      for (let i = 0; i < 3; i++) brass(v, n(69), t + i * tri, 0.08, 0.15, 0.8);
      brass(v, n(74), t + 0.36, 0.48, 0.17, 0.9);
      brass(v, n(62), t + 0.36, 0.48, 0.1, 0.6);
      brass(v, n(78), t + 0.9, 0.16, 0.15, 0.8);
      brass(v, n(76), t + 1.08, 0.16, 0.15, 0.8);
      const fin = t + 1.3;
      for (const m of [74, 78, 81]) brass(v, n(m), fin, 1.2, 0.12, 1);
      brass(v, n(62), fin, 1.2, 0.12, 0.6);
      brass(v, n(50), fin, 1.2, 0.12, 0.4);
      // timpani + roll + cymbal
      drum(v, k, t + 0.36, 98, 70, 0.45, 0.5, 0.3, 700);
      drum(v, k, t + 0.9, 110, 78, 0.3, 0.35, 0.3, 700);
      for (let i = 0; i < 6; i++) drum(v, k, t + 1.04 + i * 0.04, 98, 74, 0.12, 0.12 + i * 0.04, 0.2, 700);
      drum(v, k, fin, 75, 38, 0.9, 0.7, 0.4, 900);
      cymbal(v, k, fin, 1.4, 0.18);
      bell(v, n(98), fin + 0.15, 1.2, 0.06);
      bell(v, n(102), fin + 0.25, 1.1, 0.05);
      bell(v, n(105), fin + 0.35, 1.0, 0.05);
    },
  },

  defeat: {
    vol: 0.65, verb: 0.45, vary: 0, spread: 0,
    build(v, t, p, k) {
      const n = (m: number) => mtof(m) * p;
      // slow descending phrase into a dark D minor chord
      brass(v, n(69), t, 0.36, 0.13, 0.3);
      brass(v, n(65), t + 0.42, 0.36, 0.13, 0.28);
      brass(v, n(64), t + 0.84, 0.36, 0.13, 0.26);
      const end = t + 1.26;
      brass(v, n(62), end, 1.3, 0.14, 0.22);
      // low string-ish pad: D3 F3 A3 + D2
      const g = v.gain(0);
      g.gain.setValueAtTime(0, end - 0.1);
      g.gain.linearRampToValueAtTime(0.09, end + 0.3);
      g.gain.setValueAtTime(0.09, end + 1.1);
      g.gain.linearRampToValueAtTime(0, end + 1.6);
      const lp = v.filter('lowpass', 800, 0.7, g);
      for (const m of [38, 50, 53, 57]) {
        v.osc('sawtooth', n(m), end - 0.1, end + 1.65, lp, -6);
        v.osc('sawtooth', n(m), end - 0.1, end + 1.65, lp, 6);
      }
      drum(v, k, t, 70, 45, 0.7, 0.35, 0.25, 400);
      drum(v, k, end, 62, 36, 1.0, 0.45, 0.3, 400);
    },
  },
};

/** Everything, in a sensible order for the self-test. */
export const SFX_ORDER: Sfx[] = [
  'hover', 'tick', 'confirm', 'pinch', 'release', 'cancel', 'denied', 'launch', 'arrow', 'clash',
  'hit', 'swat', 'capture', 'lost', 'manaFull', 'smite', 'countdown', 'go', 'victory', 'defeat',
];

export const variation = (semi: number): number => (semi > 0 ? semis(rand(-semi, semi)) : 1);
