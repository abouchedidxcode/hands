// Reusable instrument "recipes" that build into a Voice. Shared by sfx and music.
import { type Kit, type Voice, perc, ahr, sweep, rand } from './core';

/** Oscillator through a percussive gain envelope, optional pitch sweep. */
export function tone(
  v: Voice, type: OscillatorType, f: number, t: number, a: number, d: number, vol: number,
  f1?: number, dest: AudioNode = v.out,
): OscillatorNode {
  const g = v.gain(0, dest);
  perc(g.gain, t, a, vol, d);
  const o = v.osc(type, f, t, t + a + d + 0.02, g);
  if (f1 !== undefined) sweep(o.frequency, t, f, f1, a + d);
  return o;
}

/** Filtered noise burst. If f1 is given the filter sweeps f → f1 over the burst. */
export function noiseHit(
  v: Voice, buf: AudioBuffer, t: number, a: number, d: number, vol: number,
  type: BiquadFilterType, f: number, q = 0.8, f1?: number, rate = 1, dest: AudioNode = v.out,
): BiquadFilterNode {
  const g = v.gain(0, dest);
  perc(g.gain, t, a, vol, d);
  const flt = v.filter(type, f, q, g);
  if (f1 !== undefined) sweep(flt.frequency, t, f, f1, a + d);
  v.noise(buf, t, t + a + d + 0.02, flt, rate);
  return flt;
}

/** Drum / taiko / kick: sine with pitch drop + a short filtered noise "skin". */
export function drum(
  v: Voice, k: Kit, t: number, f0: number, f1: number, d: number, vol: number,
  skin = 0.35, skinF = 900, dest: AudioNode = v.out,
): void {
  const g = v.gain(0, dest);
  perc(g.gain, t, 0.002, vol, d);
  const o = v.osc('sine', f0, t, t + d + 0.03, g);
  sweep(o.frequency, t, f0, f1, d * 0.6);
  if (skin > 0) noiseHit(v, k.pink, t, 0.001, Math.min(0.08, d * 0.4), vol * skin, 'lowpass', skinF, 0.7, undefined, 1, dest);
}

/**
 * Brass-ish synth: two detuned saws + sub square through a lowpass whose cutoff
 * "blares" open on attack. `bright` 0..1 shapes the filter.
 */
export function brass(
  v: Voice, f: number, t: number, dur: number, vol: number, bright = 0.7, dest: AudioNode = v.out,
): void {
  const g = v.gain(0, dest);
  const a = 0.03;
  const rel = 0.09;
  ahr(g.gain, t, a, vol, Math.max(0.01, dur - a), rel);
  const lp = v.filter('lowpass', f, 1.6, g);
  const peakF = Math.min(16000, f * (3 + 6 * bright));
  const susF = Math.min(12000, f * (1.6 + 2.5 * bright));
  lp.frequency.setValueAtTime(f * 0.9, t);
  lp.frequency.linearRampToValueAtTime(peakF, t + a + 0.02);
  lp.frequency.setTargetAtTime(susF, t + a + 0.02, 0.08);
  const end = t + dur + rel + 0.03;
  v.osc('sawtooth', f, t, end, lp, -7);
  v.osc('sawtooth', f, t, end, lp, 7);
  const sub = v.gain(0.35, lp);
  v.osc('square', f / 2, t, end, sub);
}

/** Bell / chime: inharmonic sine partials. */
export function bell(v: Voice, f: number, t: number, d: number, vol: number, dest: AudioNode = v.out): void {
  tone(v, 'sine', f, t, 0.002, d, vol, undefined, dest);
  tone(v, 'sine', f * 2.756, t, 0.001, d * 0.45, vol * 0.35, undefined, dest);
}

/** Plucked string: bright saw with closing lowpass. */
export function pluck(v: Voice, f: number, t: number, d: number, vol: number, dest: AudioNode = v.out): void {
  const g = v.gain(0, dest);
  perc(g.gain, t, 0.002, vol, d);
  const lp = v.filter('lowpass', 6000, 2.5, g);
  sweep(lp.frequency, t, Math.min(9000, f * 14), f * 1.2, d * 0.7);
  v.osc('sawtooth', f, t, t + d + 0.03, lp);
  v.osc('triangle', f * 0.5, t, t + d + 0.03, lp);
}

/** Metallic clink: two inharmonic partials into one envelope (cheap: 2 osc + 1 gain). */
export function clink(v: Voice, f: number, t: number, d: number, vol: number): void {
  const g = v.gain(0);
  perc(g.gain, t, 0.0008, vol, d);
  v.osc('sine', f, t, t + d + 0.01, g);
  v.osc('triangle', f * rand(2.6, 2.9), t, t + d + 0.01, g);
}

/** Cymbal-ish wash. */
export function cymbal(v: Voice, k: Kit, t: number, d: number, vol: number): void {
  noiseHit(v, k.white, t, 0.004, d, vol, 'highpass', 5200, 0.6);
  noiseHit(v, k.white, t, 0.002, d * 0.35, vol * 0.6, 'bandpass', 8500, 1.2);
}
