import type { GameEvent } from '../game/types';
import type { Match } from './matchmaker';
import { decodeSnapshot, type Command, type RemoteHand, type Snapshot } from './protocol';
import type { Channel } from './transport';

const PROTO = 1;

/**
 * One online 1v1 match over a P2P channel. The host (faction 0) simulates; the guest (faction 1)
 * sends commands and renders snapshots.
 */
export class NetSession {
  readonly host: boolean;
  readonly me: 0 | 1;
  readonly peer: string;
  readonly channel: Channel;
  seed: number;
  started = false;
  connected = true;
  rtt = 0;
  lastHeard = performance.now();

  onStart: ((seed: number) => void) | null = null;
  onCommand: ((c: Command) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onEvents: ((e: GameEvent[]) => void) | null = null;
  onHand: ((h: RemoteHand[]) => void) | null = null;
  onLeft: (() => void) | null = null;
  onRematch: (() => void) | null = null;

  private startTimer = 0;
  private pingTimer = 0;

  constructor(m: Match) {
    this.host = m.host;
    this.me = m.host ? 0 : 1;
    this.peer = m.peer;
    this.channel = m.channel;
    this.seed = m.seed;
    const ch = this.channel;
    const heard = () => { this.lastHeard = performance.now(); };

    ch.on('start', (d) => {
      heard();
      const s = d as { v: number; seed: number };
      if (this.host || s.v !== PROTO) return;
      this.seed = s.seed;
      ch.send('ready', { v: PROTO }, this.peer);
      if (!this.started) { this.started = true; this.onStart?.(this.seed); }
    });
    ch.on('ready', () => {
      heard();
      if (!this.host || this.started) return;
      this.started = true;
      window.clearInterval(this.startTimer);
      this.onStart?.(this.seed);
    });
    ch.on('cmd', (d) => { heard(); if (this.host) this.onCommand?.(d as Command); });
    ch.on('snap', (d) => {
      heard();
      if (this.host) return;
      const s = decodeSnapshot(d instanceof ArrayBuffer ? d : (d as Uint8Array).buffer as ArrayBuffer);
      if (s) this.onSnapshot?.(s);
    });
    ch.on('ev', (d) => { heard(); if (!this.host) this.onEvents?.(d as GameEvent[]); });
    ch.on('hand', (d) => { heard(); this.onHand?.(d as RemoteHand[]); });
    ch.on('rematch', () => { heard(); this.onRematch?.(); });
    ch.on('bye', () => this.left());
    ch.onLeave = (p) => { if (p === this.peer) this.left(); };

    if (this.host) {
      const offer = () => ch.send('start', { v: PROTO, seed: this.seed }, this.peer);
      offer();
      this.startTimer = window.setInterval(offer, 700);
    }
    this.pingTimer = window.setInterval(() => {
      ch.ping(this.peer).then((ms) => { this.rtt = ms; heard(); }).catch(() => {});
      if (performance.now() - this.lastHeard > 12000) this.left();
    }, 2000);
  }

  /** Tell the opponent we'd like a rematch. */
  wantRematch() { this.channel.send('rematch', {}, this.peer); }

  /** Both agreed: restart the start handshake (host picks a new seed, guest waits for it). */
  rematch(seed?: number) {
    this.started = false;
    if (!this.host) return;
    this.seed = seed ?? (Math.random() * 1e9) | 0;
    const offer = () => this.channel.send('start', { v: PROTO, seed: this.seed }, this.peer);
    window.clearInterval(this.startTimer);
    offer();
    this.startTimer = window.setInterval(offer, 700);
  }

  sendCommand(c: Command) { this.channel.send('cmd', c, this.peer); }
  sendSnapshot(buf: ArrayBuffer) { this.channel.send('snap', buf, this.peer); }
  sendEvents(e: GameEvent[]) { if (e.length) this.channel.send('ev', e, this.peer); }
  sendHand(h: RemoteHand[]) { this.channel.send('hand', h, this.peer); }

  private left() {
    if (!this.connected) return;
    this.connected = false;
    this.onLeft?.();
  }

  close() {
    window.clearInterval(this.startTimer);
    window.clearInterval(this.pingTimer);
    if (this.connected) this.channel.send('bye', {}, this.peer);
    this.connected = false;
    setTimeout(() => this.channel.leave(), 200);
  }
}
