import type { GameEvent } from '../game/types';
import type { Match, MatchSize } from './matchmaker';
import { decodeSnapshot, type Command, type RemoteHand, type Snapshot } from './protocol';
import { myId, type Channel } from './transport';

const PROTO = 2;

/**
 * One online match (1v1 or 1v1v1) over a P2P mesh. Factions follow the sorted peer ids, so the host
 * (smallest id) is faction 0 and simulates; guests send commands and render the host's snapshots.
 * Hands are broadcast to everyone.
 */
export class NetSession {
  readonly host: boolean;
  readonly me: number;
  readonly size: MatchSize;
  readonly channel: Channel;
  /** All players' peer ids in faction order. */
  readonly roster: string[];
  readonly hostId: string;
  seed: number;
  started = false;
  rtt = 0;
  /** Factions whose player is still connected (including me). */
  present: Set<number>;
  private lastHeard = new Map<string, number>();
  private ready = new Set<string>();

  onStart: ((seed: number) => void) | null = null;
  onCommand: ((c: Command, faction: number) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onEvents: ((e: GameEvent[]) => void) | null = null;
  onHand: ((h: RemoteHand[], faction: number) => void) | null = null;
  /** A player left; `hostLeft` means the match cannot go on. */
  onLeft: ((faction: number, hostLeft: boolean) => void) | null = null;
  onRematch: ((faction: number) => void) | null = null;

  private startTimer = 0;
  private pingTimer = 0;

  constructor(m: Match) {
    this.host = m.host;
    this.size = m.size;
    this.channel = m.channel;
    this.seed = m.seed;
    this.roster = [myId, ...m.peers].sort();
    this.hostId = this.roster[0];
    this.me = this.roster.indexOf(myId);
    this.present = new Set(this.roster.map((_, f) => f));
    const ch = this.channel;
    const now = performance.now();
    for (const p of m.peers) this.lastHeard.set(p, now);
    const heard = (p: string) => { if (this.lastHeard.has(p)) this.lastHeard.set(p, performance.now()); };
    const fromRoster = (p: string) => this.roster.includes(p) && p !== myId;

    ch.on('start', (d, p) => {
      heard(p);
      const s = d as { v: number; seed: number; roster: string[] };
      if (this.host || p !== this.hostId || s.v !== PROTO) return;
      if (!s.roster?.includes(myId)) return; // a latecomer to a full room
      // a new seed means the host started a rematch, even if our own bookkeeping hasn't caught up yet
      const fresh = !this.started || s.seed !== this.seed;
      this.seed = s.seed;
      ch.send('ready', { v: PROTO }, p);
      if (fresh) { this.started = true; this.onStart?.(this.seed); }
    });
    ch.on('ready', (_d, p) => {
      heard(p);
      if (!this.host || this.started || !fromRoster(p)) return;
      this.ready.add(p);
      if (this.guests().every((g) => this.ready.has(g))) {
        this.started = true;
        window.clearInterval(this.startTimer);
        this.onStart?.(this.seed);
      }
    });
    ch.on('cmd', (d, p) => { heard(p); if (this.host && fromRoster(p)) this.onCommand?.(d as Command, this.factionOf(p)); });
    ch.on('snap', (d, p) => {
      heard(p);
      if (this.host || p !== this.hostId) return;
      const u = d as Uint8Array;
      const s = decodeSnapshot(d instanceof ArrayBuffer ? d : u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer);
      if (s) this.onSnapshot?.(s);
    });
    ch.on('ev', (d, p) => { heard(p); if (!this.host && p === this.hostId) this.onEvents?.(d as GameEvent[]); });
    ch.on('hand', (d, p) => { heard(p); if (fromRoster(p)) this.onHand?.(d as RemoteHand[], this.factionOf(p)); });
    ch.on('rematch', (_d, p) => { heard(p); if (fromRoster(p)) this.onRematch?.(this.factionOf(p)); });
    ch.on('bye', (_d, p) => this.left(p));
    ch.onLeave = (p) => this.left(p);

    if (this.host) this.offerStart();
    this.pingTimer = window.setInterval(() => {
      for (const p of this.others()) {
        ch.ping(p).then((ms) => { if (p === this.hostId || this.host) this.rtt = ms; heard(p); }).catch(() => {});
        if (performance.now() - (this.lastHeard.get(p) ?? 0) > 12000) this.left(p);
      }
    }, 2000);
  }

  factionOf(peer: string) { return this.roster.indexOf(peer); }
  /** Connected players other than me. */
  others() { return this.roster.filter((p, f) => p !== myId && this.present.has(f)); }
  private guests() { return this.others().filter((p) => p !== this.hostId); }
  /** Still connected to anyone who matters: guests need the host, the host needs a guest. */
  get connected() { return this.host ? this.others().length > 0 : this.present.has(0); }

  private offerStart() {
    this.ready.clear();
    const offer = () => { for (const g of this.guests()) this.channel.send('start', { v: PROTO, seed: this.seed, roster: this.roster }, g); };
    window.clearInterval(this.startTimer);
    offer();
    this.startTimer = window.setInterval(offer, 700);
  }

  /** Tell everyone we'd like a rematch. */
  wantRematch() { for (const p of this.others()) this.channel.send('rematch', {}, p); }

  /** Everyone agreed: restart the start handshake (host picks a new seed, guests wait for it). */
  rematch(seed?: number) {
    this.started = false;
    if (!this.host) return;
    this.seed = seed ?? (Math.random() * 1e9) | 0;
    this.offerStart();
  }

  sendCommand(c: Command) { this.channel.send('cmd', c, this.hostId); }
  sendSnapshot(buf: ArrayBuffer) { for (const g of this.guests()) this.channel.send('snap', buf, g); }
  sendEvents(e: GameEvent[]) { if (e.length) for (const g of this.guests()) this.channel.send('ev', e, g); }
  sendHand(h: RemoteHand[]) { for (const p of this.others()) this.channel.send('hand', h, p); }
  /** Host → guests (e.g. final stats). */
  broadcast(name: string, data: unknown) { for (const g of this.guests()) this.channel.send(name, data, g); }

  private left(p: string) {
    const f = this.factionOf(p);
    if (f < 0 || p === myId || !this.present.has(f)) return;
    this.present.delete(f);
    this.lastHeard.delete(p);
    this.onLeft?.(f, p === this.hostId);
  }

  close() {
    window.clearInterval(this.startTimer);
    window.clearInterval(this.pingTimer);
    for (const p of this.others()) this.channel.send('bye', {}, p);
    this.present = new Set([this.me]);
    setTimeout(() => this.channel.leave(), 200);
  }
}
