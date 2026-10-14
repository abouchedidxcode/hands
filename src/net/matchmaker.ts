import { Channel, myId } from './transport';

/** Players in a match: 2 = duel (1v1), 3 = brawl (1v1v1). */
export type MatchSize = 2 | 3;

export interface Match {
  channel: Channel;
  /** The other players' peer ids. */
  peers: string[];
  host: boolean;
  seed: number;
  size: MatchSize;
}

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
  return s;
}

const LOBBY: Record<MatchSize, string> = { 2: 'lobby-v2', 3: 'lobby3-v2' };
const PRIV: Record<MatchSize, string> = { 2: 'priv2-', 3: 'priv3-' };

/**
 * Quick match: everyone searching for the same match size joins a small public lobby room. The
 * smallest peer id among the seekers gathers the next size-1 seekers (invite → accept → go), and
 * the group moves to a fresh match room. Private match: everyone joins a room named by a shareable
 * code; the game starts once `size` players are in. In every match the smallest id hosts.
 */
export class Matchmaker {
  status: 'idle' | 'searching' | 'connecting' | 'found' = 'idle';
  /** Players currently in a private room (including me), for the waiting screen. */
  roomCount = 0;
  onRoomCount: ((n: number) => void) | null = null;
  private size: MatchSize = 2;
  private lobby: Channel | null = null;
  private matchCh: Channel | null = null;
  private seekers = new Map<string, number>();
  /** As inviter: the group I'm gathering. */
  private gathering: { room: string; seed: number; members: string[]; accepted: Set<string> } | null = null;
  /** As invitee: who invited me (I ignore everyone else until it resolves). */
  private invitedBy: string | null = null;
  private timers: number[] = [];
  private cancelled = false;

  constructor(private onFound: (m: Match) => void) {}

  private later(ms: number, fn: () => void) { this.timers.push(window.setTimeout(fn, ms)); }

  quick(size: MatchSize = 2) {
    this.reset();
    this.cancelled = false;
    this.size = size;
    this.status = 'searching';
    const lobby = (this.lobby = new Channel(LOBBY[size]));
    const free = () => this.status === 'searching' && !this.gathering && !this.invitedBy;
    const seekAll = () => { if (free()) lobby.send('seek', { n: size }); };
    lobby.onJoin = (p) => { if (free()) lobby.send('seek', { n: size }, p); };
    lobby.onLeave = (p) => this.seekers.delete(p);
    lobby.on('seek', (_d, p) => { this.seekers.set(p, performance.now()); this.tryGather(); });

    lobby.on('invite', (d, p) => {
      if (!free()) return;
      const inv = d as { room: string; seed: number; members: string[] };
      if (!inv.members?.includes(myId)) return;
      this.invitedBy = p;
      lobby.send('accept', { room: inv.room }, p);
      if (size === 2) { this.enterMatch(inv.room, inv.seed); return; }
      // brawl: wait for the inviter's 'go' (everyone accepted), or give up and keep searching
      this.later(6000, () => { if (this.invitedBy === p && this.status === 'searching') { this.invitedBy = null; seekAll(); } });
    });
    lobby.on('go', (d, p) => {
      const g = d as { room: string; seed: number };
      if (this.invitedBy !== p || this.status !== 'searching') return;
      this.enterMatch(g.room, g.seed);
    });
    lobby.on('accept', (d, p) => {
      const a = d as { room: string };
      const gt = this.gathering;
      if (!gt || a.room !== gt.room || !gt.members.includes(p)) return;
      gt.accepted.add(p);
      if (gt.accepted.size < gt.members.length) return;
      if (size === 3) for (const m of gt.members) lobby.send('go', { room: gt.room, seed: gt.seed }, m);
      this.enterMatch(gt.room, gt.seed);
    });
    // nudge periodically in case a join was missed
    const iv = window.setInterval(() => { if (this.status !== 'searching') window.clearInterval(iv); else seekAll(); }, 2500);
    this.timers.push(iv);
    seekAll();
  }

  /** Smallest id among the live seekers gathers a group. */
  private tryGather() {
    if (this.status !== 'searching' || this.gathering || this.invitedBy || !this.lobby) return;
    const now = performance.now();
    for (const [p, t] of this.seekers) if (now - t > 8000) this.seekers.delete(p);
    const others = [...this.seekers.keys()].sort();
    if (others.length < this.size - 1 || others[0] < myId) return;
    const members = others.slice(0, this.size - 1);
    const room = makeCode(8), seed = (Math.random() * 1e9) | 0;
    const gt = (this.gathering = { room, seed, members, accepted: new Set<string>() });
    for (const m of members) this.lobby.send('invite', { room, seed, members: [myId, ...members] }, m);
    this.later(4500, () => {
      if (this.gathering !== gt || this.status !== 'searching') return;
      // someone didn't answer: forget them and try again
      for (const m of members) if (!gt.accepted.has(m)) this.seekers.delete(m);
      this.gathering = null;
      this.tryGather();
    });
  }

  /** Join (or create) a private room by code. The game starts once `size` players are in. */
  privateRoom(code: string, size: MatchSize = 2) {
    this.reset();
    this.cancelled = false;
    this.size = size;
    this.status = 'searching';
    const ch = (this.matchCh = new Channel(PRIV[size] + code.toUpperCase()));
    const update = () => {
      if (this.status !== 'searching') return;
      const peers = ch.peers();
      this.roomCount = 1 + peers.length;
      this.onRoomCount?.(this.roomCount);
      if (peers.length < size - 1) return;
      this.status = 'connecting';
      // the earliest arrivals play; any extra joiner is ignored by the host's roster
      this.finish({ channel: ch, peers: peers.sort().slice(0, size - 1), host: [myId, ...peers].sort()[0] === myId, seed: (Math.random() * 1e9) | 0, size });
    };
    this.roomCount = 1;
    ch.onJoin = update;
    ch.onLeave = update;
  }

  private enterMatch(room: string, seed: number) {
    this.status = 'connecting';
    this.lobby?.leave();
    this.lobby = null;
    const size = this.size;
    const ch = (this.matchCh = new Channel('m-' + room));
    this.later(15000, () => {
      if (this.status === 'connecting' && !this.cancelled) { ch.leave(); this.matchCh = null; this.quick(size); }
    });
    ch.onJoin = () => {
      if (this.status !== 'connecting') return;
      const peers = ch.peers();
      if (peers.length < size - 1) return;
      this.finish({ channel: ch, peers: peers.sort(), host: [myId, ...peers].sort()[0] === myId, seed, size });
    };
  }

  private finish(m: Match) {
    if (this.cancelled) return;
    for (const t of this.timers) { window.clearTimeout(t); window.clearInterval(t); }
    this.timers = [];
    this.status = 'found';
    this.matchCh = null; // ownership passes to the match
    this.onFound(m);
  }

  cancel() {
    this.cancelled = true;
    this.reset();
    this.status = 'idle';
  }

  private reset() {
    // stale timers from an earlier search must not tear down (or re-seek on) a newer one
    for (const t of this.timers) { window.clearTimeout(t); window.clearInterval(t); }
    this.timers = [];
    this.seekers.clear();
    this.gathering = null;
    this.invitedBy = null;
    this.roomCount = 0;
    this.lobby?.leave();
    this.lobby = null;
    this.matchCh?.leave();
    this.matchCh = null;
  }
}
