// GODHAND audio engine — fully procedural WebAudio SFX + adaptive music. No audio files.
//
// Graph:  voices ─► sfxBus ─┐
//         music  ─► duck ───┼─► master ─► compressor ─► limiter ─► destination
//         sends  ─► reverb ─┘
//
// Every method is a safe no-op until unlock() has created the AudioContext.
import { type Kit, Voice, makeKit, makeImpulse, clamp, rand } from './core';
import { SFX, SFX_ORDER, variation } from './sfx';
import { Music } from './music';

export type Sfx = 'hover'|'tick'|'confirm'|'pinch'|'release'|'cancel'|'launch'|'clash'|'hit'|'capture'|'lost'
  |'smite'|'swat'|'arrow'|'denied'|'manaFull'|'countdown'|'go'|'victory'|'defeat';

export interface PlayOpts { volume?: number; pitch?: number; pan?: number }

const MAX_VOICES = 48;

/** Minimum seconds between two plays of the same sfx (duplicates inside the gap are dropped). */
const MIN_GAP: Partial<Record<Sfx, number>> = {
  hover: 0.045, tick: 0.03, confirm: 0.06, pinch: 0.03, release: 0.03, cancel: 0.06, launch: 0.04,
  capture: 0.07, lost: 0.1, smite: 0.08, swat: 0.07, denied: 0.15, manaFull: 0.6, countdown: 0.2,
  go: 0.4, victory: 1, defeat: 1,
};

/** Token buckets for the spammy sounds: `rate` plays/s sustained, `burst` instantaneous. */
const BUCKETS: Partial<Record<Sfx, { rate: number; burst: number }>> = {
  clash: { rate: 25, burst: 6 },
  hit: { rate: 18, burst: 5 },
  arrow: { rate: 12, burst: 4 },
};

interface Engine {
  ctx: AudioContext;
  kit: Kit;
  master: GainNode;
  sfxBus: GainNode;
  musicDuck: GainNode;
  reverb: ConvolverNode;
  music: Music;
}

let E: Engine | null = null;
let unlocking: Promise<void> | null = null;
let masterVol = 0.8;
let wantMusic = false;
let intensity = 0;

const active: Voice[] = [];
const lastPlay: Partial<Record<Sfx, number>> = {};
const tokens: Partial<Record<Sfx, { n: number; t: number; density: number }>> = {};

function build(ctx: AudioContext): Engine {
  const kit = makeKit(ctx);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  limiter.connect(ctx.destination);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  comp.connect(limiter);

  const master = ctx.createGain();
  master.gain.value = masterVol;
  master.connect(comp);

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(master);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const verbRet = ctx.createGain();
  verbRet.gain.value = 0.45;
  reverb.connect(verbRet);
  verbRet.connect(master);

  const musicDuck = ctx.createGain();
  musicDuck.gain.value = 0.5; // music sits under sfx
  musicDuck.connect(master);

  const music = new Music(ctx, musicDuck, reverb, kit);
  music.setIntensity(intensity);
  return { ctx, kit, master, sfxBus, musicDuck, reverb, music };
}

const MUSIC_LEVEL = 0.5;

function duckMusic(e: Engine, depth: number, hold: number, recover: number): void {
  const g = e.musicDuck.gain;
  const t = e.ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(MUSIC_LEVEL * depth, t + 0.04);
  g.setValueAtTime(MUSIC_LEVEL * depth, t + 0.04 + hold);
  g.linearRampToValueAtTime(MUSIC_LEVEL, t + 0.04 + hold + recover);
}

function ready(): Engine | null {
  if (!E) return null;
  if (E.ctx.state !== 'running') {
    // e.g. iOS interruption / tab policies — try to recover, but don't queue sounds meanwhile
    if (E.ctx.state === 'suspended') E.ctx.resume().catch(() => {});
    return null;
  }
  return E;
}

function prune(now: number): void {
  // safety net: voices whose sources never reported `ended`
  for (let i = active.length - 1; i >= 0; i--) {
    const v = active[i];
    if (v.done) active.splice(i, 1);
    else if (v.endTime < now - 1) v.finish();
  }
}

function play(s: Sfx, o?: PlayOpts): void {
  try {
    const e = ready();
    if (!e) return;
    const def = SFX[s];
    if (!def) return;
    const now = e.ctx.currentTime;

    const gap = MIN_GAP[s];
    if (gap !== undefined) {
      const last = lastPlay[s];
      if (last !== undefined && now - last < gap) return;
    }

    let vol = def.vol * clamp(o?.volume ?? 1, 0, 2);
    const bucket = BUCKETS[s];
    if (bucket) {
      let st = tokens[s];
      if (!st) st = tokens[s] = { n: bucket.burst, t: now, density: 0 };
      const dt = Math.max(0, now - st.t);
      st.t = now;
      st.n = Math.min(bucket.burst, st.n + dt * bucket.rate);
      st.density = st.density * Math.exp(-dt / 0.5) + 1;
      if (st.n < 1) return;
      st.n -= 1;
      // the denser the battle, the quieter each individual clink
      vol *= Math.min(1, 1.6 / Math.sqrt(st.density));
    }
    if (vol <= 0.001) return;
    lastPlay[s] = now;

    prune(now);
    while (active.length >= MAX_VOICES) {
      const old = active.shift();
      if (old) { old.onDone = null; old.kill(); stealing.push(old); }
    }

    const pan = o?.pan !== undefined && Number.isFinite(o.pan)
      ? clamp(o.pan, -1, 1)
      : def.spread > 0 ? rand(-def.spread, def.spread) : 0;
    const pitch = clamp(o?.pitch ?? 1, 0.25, 4) * variation(def.vary);
    const v = new Voice(e.ctx, e.sfxBus, vol, pan, e.reverb, def.verb);
    v.onDone = (x) => {
      const i = active.indexOf(x);
      if (i >= 0) active.splice(i, 1);
    };
    active.push(v);
    def.build(v, now + 0.005, Number.isFinite(pitch) ? pitch : 1, e.kit);

    if (s === 'smite') duckMusic(e, 0.45, 0.25, 1.4);
    else if (s === 'victory' || s === 'defeat') duckMusic(e, 0.2, 2.4, 2.0);
  } catch (err) {
    console.warn('[audio] play failed', s, err);
  }
}

// stolen voices are fading; make sure they get disconnected
const stealing: Voice[] = [];
function reapStolen(now: number): void {
  for (let i = stealing.length - 1; i >= 0; i--) {
    const v = stealing[i];
    if (v.done) stealing.splice(i, 1);
    else if (now > v.endTime + 0.2) { v.finish(); stealing.splice(i, 1); }
  }
}

// ───────────────────────────── smite charge hum ─────────────────────────────

interface ChargeRig {
  out: GainNode;
  humFilter: BiquadFilterNode;
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  lfo: OscillatorNode;
  crackle: AudioBufferSourceNode;
  crackleGain: GainNode;
  nodes: AudioNode[];
}
let charge: ChargeRig | null = null;
let chargeLevel = 0;
let chargeKill: ReturnType<typeof setTimeout> | null = null;

function buildCharge(e: Engine): ChargeRig {
  const ctx = e.ctx;
  const nodes: AudioNode[] = [];
  const n = <T extends AudioNode>(x: T): T => { nodes.push(x); return x; };
  const out = n(ctx.createGain());
  out.gain.value = 0;
  out.connect(e.sfxBus);
  const send = n(ctx.createGain());
  send.gain.value = 0.25;
  out.connect(send);
  send.connect(e.reverb);

  // hum: saw + square through a resonant lowpass, with tremolo
  const hum = n(ctx.createGain());
  hum.gain.value = 0.5;
  const humFilter = n(ctx.createBiquadFilter());
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 400;
  humFilter.Q.value = 6;
  humFilter.connect(hum);
  hum.connect(out);
  const osc1 = n(ctx.createOscillator());
  osc1.type = 'sawtooth';
  osc1.frequency.value = 55;
  osc1.connect(humFilter);
  const osc2 = n(ctx.createOscillator());
  osc2.type = 'square';
  osc2.frequency.value = 110.6;
  const o2g = n(ctx.createGain());
  o2g.gain.value = 0.4;
  osc2.connect(o2g);
  o2g.connect(humFilter);
  const lfo = n(ctx.createOscillator());
  lfo.frequency.value = 9;
  const lfoGain = n(ctx.createGain());
  lfoGain.gain.value = 0.3;
  lfo.connect(lfoGain);
  lfoGain.connect(hum.gain);

  // rising whine
  const whine = n(ctx.createOscillator());
  whine.type = 'sine';
  whine.frequency.value = 400;
  const whineGain = n(ctx.createGain());
  whineGain.gain.value = 0;
  whine.connect(whineGain);
  whineGain.connect(out);

  // crackle
  const crackle = n(ctx.createBufferSource());
  crackle.buffer = e.kit.crackle;
  crackle.loop = true;
  const hp = n(ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const crackleGain = n(ctx.createGain());
  crackleGain.gain.value = 0;
  crackle.connect(hp);
  hp.connect(crackleGain);
  crackleGain.connect(out);

  const t = ctx.currentTime;
  for (const s of [osc1, osc2, lfo, whine]) s.start(t);
  crackle.start(t, Math.random() * 1.5);
  return { out, humFilter, osc1, osc2, whine, whineGain, lfo, crackle, crackleGain, nodes };
}

function destroyCharge(): void {
  if (!charge) return;
  const c = charge;
  charge = null;
  for (const s of [c.osc1, c.osc2, c.lfo, c.whine, c.crackle]) {
    try { s.stop(); } catch { /* ignore */ }
  }
  for (const nd of c.nodes) {
    try { nd.disconnect(); } catch { /* ignore */ }
  }
}

function setCharge(level: number): void {
  try {
    const L = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    const e = ready();
    if (!e) { chargeLevel = 0; return; }
    if (L <= 0.001) {
      if (!charge || chargeLevel === 0) return;
      chargeLevel = 0;
      const t = e.ctx.currentTime;
      charge.out.gain.setTargetAtTime(0, t, 0.05);
      if (chargeKill) clearTimeout(chargeKill);
      chargeKill = setTimeout(() => { chargeKill = null; if (chargeLevel === 0) destroyCharge(); }, 600);
      return;
    }
    if (chargeKill) { clearTimeout(chargeKill); chargeKill = null; }
    if (!charge) charge = buildCharge(e);
    if (Math.abs(L - chargeLevel) < 0.004) return;
    chargeLevel = L;
    const t = e.ctx.currentTime;
    const tc = 0.04;
    const f = 55 * Math.pow(2, L * 2); // 55 → 220 Hz
    charge.out.gain.setTargetAtTime(0.12 + 0.38 * L, t, tc);
    charge.osc1.frequency.setTargetAtTime(f, t, tc);
    charge.osc2.frequency.setTargetAtTime(f * 2.01, t, tc);
    charge.humFilter.frequency.setTargetAtTime(300 + 3200 * L * L, t, tc);
    charge.lfo.frequency.setTargetAtTime(7 + 18 * L, t, tc);
    charge.whine.frequency.setTargetAtTime(500 + 2200 * L, t, tc);
    charge.whineGain.gain.setTargetAtTime(0.06 * L * L, t, tc);
    charge.crackle.playbackRate.setTargetAtTime(0.7 + 0.9 * L, t, tc);
    charge.crackleGain.gain.setTargetAtTime(0.1 + 0.8 * Math.pow(L, 1.5), t, tc);
  } catch (err) {
    console.warn('[audio] setCharge failed', err);
  }
}

// ───────────────────────────── public API ─────────────────────────────

let gestureHooked = false;
function hookGestureResume(ctx: AudioContext): void {
  if (gestureHooked || typeof document === 'undefined') return;
  gestureHooked = true;
  const kick = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, kick, { capture: true, passive: true });
}

async function unlock(): Promise<void> {
  if (unlocking) return unlocking;
  unlocking = (async () => {
    try {
      if (!E) {
        if (typeof window === 'undefined') return;
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor({ latencyHint: 'interactive' });
        E = build(ctx);
        hookGestureResume(ctx);
        // housekeeping for stolen voices
        setInterval(() => { if (E) reapStolen(E.ctx.currentTime); }, 1000);
      }
      if (E.ctx.state !== 'running') {
        // resume() can stay pending without a user gesture: never let unlock() hang
        await Promise.race([E.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      }
      if (wantMusic && !E.music.running) E.music.start();
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    } finally {
      unlocking = null;
    }
  })();
  return unlocking;
}

export const audio: {
  unlock(): Promise<void>;
  play(s: Sfx, o?: PlayOpts): void;
  setCharge(level: number): void;
  startMusic(): void;
  stopMusic(): void;
  setIntensity(x: number): void;
  setMasterVolume(v: number): void;
} = {
  unlock,
  play,
  setCharge,
  startMusic(): void {
    wantMusic = true; // remembered: if called before unlock, music starts on unlock
    try { if (E) E.music.start(); } catch (err) { console.warn('[audio] startMusic failed', err); }
  },
  stopMusic(): void {
    wantMusic = false;
    try { if (E) E.music.stop(); } catch (err) { console.warn('[audio] stopMusic failed', err); }
  },
  setIntensity(x: number): void {
    intensity = clamp(Number.isFinite(x) ? x : 0, 0, 1);
    if (E) E.music.setIntensity(intensity);
  },
  setMasterVolume(v: number): void {
    masterVol = clamp(Number.isFinite(v) ? v : 0.8, 0, 1);
    try {
      if (E) E.master.gain.setTargetAtTime(masterVol, E.ctx.currentTime, 0.03);
    } catch { /* ignore */ }
  },
};

/** Debug info (voices in flight, context state). */
export function audioStats(): { state: string; voices: number; music: boolean; charge: number } {
  return {
    state: E ? E.ctx.state : 'locked',
    voices: active.length,
    music: E ? E.music.running : false,
    charge: chargeLevel,
  };
}

/**
 * Dev helper: plays every SFX in sequence, then a charge ramp, a clash storm and a short
 * music intensity sweep. Call from a click handler (it unlocks the context).
 */
export async function audioSelfTest(opts: { music?: boolean } = {}): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await audio.unlock();
  for (const s of SFX_ORDER) {
    console.info('[audio self-test]', s);
    audio.play(s);
    await sleep(s === 'victory' || s === 'defeat' ? 3000 : s === 'smite' ? 2200 : 650);
  }
  console.info('[audio self-test] charge ramp');
  for (let i = 0; i <= 40; i++) { audio.setCharge(i / 40); await sleep(40); }
  audio.setCharge(0);
  audio.play('smite');
  await sleep(1500);
  console.info('[audio self-test] clash storm (rate-limited)');
  for (let i = 0; i < 120; i++) { audio.play('clash', { pan: Math.random() * 2 - 1 }); if (i % 4 === 0) audio.play('arrow'); await sleep(12); }
  if (opts.music !== false) {
    console.info('[audio self-test] music 0 → 1');
    audio.setIntensity(0);
    audio.startMusic();
    for (let i = 0; i <= 20; i++) { audio.setIntensity(i / 20); await sleep(600); }
    await sleep(4000);
    audio.stopMusic();
  }
}
