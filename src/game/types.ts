import type { BaseType } from '../config';

export interface Base {
  id: number;
  type: BaseType;
  x: number;
  z: number;
  radius: number;
  owner: number;        // -1 neutral, 0 player, 1..3 AI
  troops: number;       // fractional garrison
  cap: number;
  growth: number;
  fireTimer: number;    // towers
  lastHit: number;      // sim time of last enemy arrival (for flashes)
  captureTime: number;  // sim time of last capture
}

export interface Unit {
  id: number;
  faction: number;
  from: number;         // base id
  to: number;           // base id
  x: number; z: number;
  dx: number; dz: number;   // normalized direction
  offset: number;       // lateral formation offset
  speed: number;
  alive: boolean;
  born: number;         // sim time
  doomed: boolean;      // targeted by an arrow in flight
}

export interface Launch {
  from: number;
  to: number;
  faction: number;
  remaining: number;
  timer: number;
  row: number;
}

export interface Arrow {
  base: number;
  unit: number;
  t: number;
  fx: number; fz: number;
}

export type GameEvent =
  | { type: 'launch'; from: number; to: number; faction: number; count: number }
  | { type: 'clash'; x: number; z: number; a: number; b: number }
  | { type: 'hit'; base: number; faction: number; x: number; z: number }
  | { type: 'reinforce'; base: number }
  | { type: 'capture'; base: number; from: number; to: number }
  | { type: 'arrow'; base: number; x: number; z: number; tx: number; tz: number }
  | { type: 'arrowKill'; x: number; z: number; faction: number }
  | { type: 'smite'; x: number; z: number; kills: number; radius: number }
  | { type: 'fling'; x: number; z: number; vx: number; vz: number; faction: number }
  | { type: 'rally'; until: number }
  | { type: 'eliminated'; faction: number }
  | { type: 'end'; winner: number };

export interface Stats {
  captures: number;
  lost: number;
  kills: number;
  smites: number;
  swats: number;
  rallies: number;
  sent: number;
  peakArmy: number;
}
