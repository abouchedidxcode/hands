import { joinRoom, selfId, type Room } from 'trystero';

/**
 * Serverless peer-to-peer transport (WebRTC data channels, signalling over public Nostr relays
 * via Trystero). Free to run: no game server exists.
 */
export const APP_ID = 'godhand-war-v1';
export const myId = selfId;

const TEST_LOOPBACK = new URLSearchParams(location.search).has('nettest');

const ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // free public TURN fallback (Open Relay Project) for players behind strict NATs
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
];

export type Handler = (data: unknown, peer: string) => void;

export class Channel {
  room: Room;
  private actions = new Map<string, { send: (d: never, o?: { target?: string | null }) => Promise<void> }>();
  private handlers = new Map<string, Handler>();
  onJoin: ((peer: string) => void) | null = null;
  onLeave: ((peer: string) => void) | null = null;

  constructor(roomId: string) {
    this.room = joinRoom(
      { appId: APP_ID, rtcConfig: { iceServers: ICE }, ...(TEST_LOOPBACK ? { _test_only_mdnsHostFallbackToLoopback: true } : {}) },
      roomId,
    );
    this.room.onPeerJoin = (p) => this.onJoin?.(p);
    this.room.onPeerLeave = (p) => this.onLeave?.(p);
  }

  private action(name: string) {
    let a = this.actions.get(name);
    if (!a) {
      const act = this.room.makeAction(name);
      act.onMessage = (d, ctx) => this.handlers.get(name)?.(d, ctx.peerId);
      a = act as unknown as { send: (d: never, o?: { target?: string | null }) => Promise<void> };
      this.actions.set(name, a);
    }
    return a;
  }

  on(name: string, h: Handler) { this.handlers.set(name, h); this.action(name); }

  send(name: string, data: unknown, target?: string) {
    this.action(name).send(data as never, target ? { target } : undefined).catch(() => { /* peer gone */ });
  }

  peers(): string[] { return Object.keys(this.room.getPeers()); }

  ping(peer: string): Promise<number> { return this.room.ping(peer); }

  leave() { this.room.leave().catch(() => {}); }
}
