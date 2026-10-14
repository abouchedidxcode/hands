// Low-level WebAudio building blocks shared by sfx + music.
// Everything here works on a BaseAudioContext so it can also render offline (tests).

export interface Kit {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** sparse random impulses — electric crackle */
  crackle: AudioBuffer;
}

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0];
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const semis = (s: number): number => Math.pow(2, s / 12);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const EPS = 0.0001;

/** Precompute all noise buffers once per context. */
export function makeKit(ctx: BaseAudioContext): Kit {
  const sr = ctx.sampleRate;
  const mk = (sec: number, fill: (d: Float32Array) => void): AudioBuffer => {
    const b = ctx.createBuffer(1, Math.floor(sr * sec), sr);
    fill(b.getChannelData(0));
    return b;
  };
  const white = mk(2, (d) => {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  });
  const pink = mk(2, (d) => {
    // Paul Kellet's economy pink filter
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  });
  const brown = mk(3, (d) => {
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  });
  const crackle = mk(2, (d) => {
    let i = 0;
    while (i < d.length) {
      i += Math.floor(rand(0.002, 0.03) * sr);
      const len = Math.floor(rand(0.0003, 0.004) * sr);
      const amp = rand(0.3, 1) * (Math.random() < 0.5 ? -1 : 1);
      for (let j = 0; j < len && i + j < d.length; j++) {
        d[i + j] = amp * (1 - j / len) * (Math.random() * 0.6 + 0.4);
      }
      i += len;
    }
  });
  return { white, pink, brown, crackle };
}

/** Stereo reverb impulse: decaying noise that darkens over time. */
export function makeImpulse(ctx: BaseAudioContext, sec = 2.6, decay = 2.8): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * sec);
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor(sr * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = (i - pre) / (n - pre);
      const k = 0.65 - 0.5 * x; // one-pole coefficient: brighter early, darker late
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - x, decay);
    }
    // a few discrete early reflections
    for (let r = 0; r < 6; r++) {
      const at = pre + Math.floor(sr * rand(0.005, 0.06));
      if (at < n) d[at] += rand(-0.6, 0.6);
    }
  }
  return buf;
}

/** Exponential-ish percussive envelope: 0 → peak (attack) → ~0 (decay). */
export function perc(p: AudioParam, t: number, a: number, peak: number, d: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, EPS), t + a);
  p.exponentialRampToValueAtTime(EPS, t + a + d);
}

/** Attack / hold / release envelope (for sustained notes). */
export function ahr(p: AudioParam, t: number, a: number, peak: number, hold: number, r: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setValueAtTime(peak, t + a + hold);
  p.linearRampToValueAtTime(0, t + a + hold + r);
}

export function sweep(p: AudioParam, t: number, from: number, to: number, d: number): void {
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(Math.max(to, EPS), t + d);
}

/**
 * One transient sound: a small sub-graph feeding `out` (gain) → [panner] → destination
 * (+ optional reverb send). Tracks its sources and disconnects everything once all ended.
 */
export class Voice {
  readonly ctx: BaseAudioContext;
  readonly out: GainNode;
  readonly startTime: number;
  endTime = 0;
  done = false;
  onDone: ((v: Voice) => void) | null = null;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private live = 0;
  private level: number;

  constructor(ctx: BaseAudioContext, dest: AudioNode, volume: number, pan = 0, send?: AudioNode, sendAmt = 0) {
    this.ctx = ctx;
    this.startTime = ctx.currentTime;
    this.level = volume;
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.nodes.push(this.out);
    let tail: AudioNode = this.out;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      this.out.connect(p);
      this.nodes.push(p);
      tail = p;
    }
    tail.connect(dest);
    if (send && sendAmt > 0) {
      const s = ctx.createGain();
      s.gain.value = sendAmt;
      tail.connect(s);
      s.connect(send);
      this.nodes.push(s);
    }
  }

  gain(value = 1, dest: AudioNode = this.out): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    g.connect(dest);
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7, dest: AudioNode = this.out): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number, dest: AudioNode, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    o.connect(dest);
    this.addSource(o, t0, t1);
    return o;
  }

  noise(buf: AudioBuffer, t0: number, t1: number, dest: AudioNode, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(dest);
    // random offset so repeated noise hits aren't identical
    this.addSource(s, t0, t1, Math.random() * buf.duration * 0.8);
    return s;
  }

  private addSource(s: AudioScheduledSourceNode, t0: number, t1: number, offset?: number): void {
    this.nodes.push(s);
    this.sources.push(s);
    this.live++;
    s.onended = () => {
      this.live--;
      if (this.live <= 0) this.finish();
    };
    if (offset !== undefined && s instanceof AudioBufferSourceNode) s.start(t0, offset);
    else s.start(t0);
    s.stop(t1);
    if (t1 > this.endTime) this.endTime = t1;
  }

  /** Quick fade + stop (voice stealing). */
  kill(): void {
    if (this.done) return;
    const t = this.ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(this.level, t);
      this.out.gain.linearRampToValueAtTime(0, t + 0.025);
    } catch { /* ignore */ }
    for (const s of this.sources) {
      try { s.stop(t + 0.03); } catch { /* already stopped */ }
    }
    this.endTime = t + 0.03;
  }

  /** Disconnect everything (idempotent). */
  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const s of this.sources) s.onended = null;
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb(this);
  }
}
