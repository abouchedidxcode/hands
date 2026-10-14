import { Channel, myId } from './transport';

export interface Match {
  channel: Channel;
  peer: string;
  host: boolean;
  seed: number;
}

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
  return s;
}

/**
 * Quick match: everyone searching joins a small public lobby room; the peer with the smaller id
 * invites, the other accepts, both move to a private match room. Private match: both join a room
 * named by a shareable code.
 */
export class Matchmaker {
  status: 'idle' | 'searching' | 'connecting' | 'found' = 'idle';
  private lobby: Channel | null = null;
  private matchCh: Channel | null = null;
  private pending: string | null = null;
  private pendingTimer = 0;
  private cancelled = false;

  constructor(private onFound: (m: Match) => void) {}

  quick() {
    this.reset();
    this.cancelled = false;
    this.status = 'searching';
    const lobby = (this.lobby = new Channel('lobby-v1'));
    const seekAll = () => { if (this.status === 'searching') lobby.send('seek', { v: 1 }); };
    lobby.onJoin = (p) => { if (this.status === 'searching') lobby.send('seek', { v: 1 }, p); };
    lobby.on('seek', (_d, p) => {
      if (this.status !== 'searching' || this.pending) return;
      if (myId < p) {
        // I invite
        this.pending = p;
        const room = makeCode(8), seed = (Math.random() * 1e9) | 0;
        lobby.send('invite', { room, seed }, p);
        this.pendingTimer = window.setTimeout(() => { this.pending = null; seekAll(); }, 4000);
        lobby.on('accept', (d, from) => {
          if (from !== this.pending || this.status !== 'searching') return;
          const a = d as { room: string };
          if (a.room !== room) return;
          window.clearTimeout(this.pendingTimer);
          this.enterMatch(room, true, seed);
        });
      }
    });
    lobby.on('invite', (d, p) => {
      if (this.status !== 'searching') return;
      if (this.pending && this.pending !== p) return;
      const inv = d as { room: string; seed: number };
      lobby.send('accept', { room: inv.room }, p);
      this.enterMatch(inv.room, false, inv.seed);
    });
    // nudge periodically in case a join was missed
    const iv = window.setInterval(() => { if (this.status !== 'searching') window.clearInterval(iv); else seekAll(); }, 3000);
  }

  /** Join (or create) a private room by code. Smaller peer id hosts. */
  privateRoom(code: string) {
    this.reset();
    this.cancelled = false;
    this.status = 'searching';
    const ch = (this.matchCh = new Channel('priv-' + code.toUpperCase()));
    ch.onJoin = (p) => {
      if (this.status !== 'searching') return;
      this.status = 'connecting';
      const host = myId < p;
      // host picks the seed and tells the guest in the game handshake
      this.finish({ channel: ch, peer: p, host, seed: (Math.random() * 1e9) | 0 });
    };
  }

  private enterMatch(room: string, host: boolean, seed: number) {
    this.status = 'connecting';
    this.lobby?.leave();
    this.lobby = null;
    const ch = (this.matchCh = new Channel('m-' + room));
    const timeout = window.setTimeout(() => {
      if (this.status === 'connecting' && !this.cancelled) { ch.leave(); this.matchCh = null; this.quick(); }
    }, 15000);
    ch.onJoin = (p) => {
      if (this.status !== 'connecting') return;
      window.clearTimeout(timeout);
      this.finish({ channel: ch, peer: p, host, seed });
    };
  }

  private finish(m: Match) {
    if (this.cancelled) return;
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
    window.clearTimeout(this.pendingTimer);
    this.pending = null;
    this.lobby?.leave();
    this.lobby = null;
    this.matchCh?.leave();
    this.matchCh = null;
  }
}
