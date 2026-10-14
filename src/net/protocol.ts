import { MANA } from '../config';
import type { Sim } from '../game/sim';
import type { GameEvent } from '../game/types';

/**
 * Host-authoritative state sync. The host runs the real Sim; the guest receives compact binary
 * snapshots (~12 Hz) and dead-reckons units between them. Events (for FX/SFX) ride along as JSON.
 */
export interface Snapshot {
  time: number;
  over: boolean;
  winner: number;
  mana: [number, number];
  rallyUntil: [number, number];
  bases: { owner: number; troops: number; lastHit: number }[];
  units: { id: number; x: number; z: number; dx: number; dz: number; faction: number; to: number; speed: number }[];
}

const HEADER = 1 + 4 + 1 + 1 + 4 * 4 + 1 + 2;
const PER_BASE = 1 + 2 + 2;
const PER_UNIT = 4 + 2 + 2 + 1 + 1 + 1 + 1 + 1;

export function encodeSnapshot(sim: Sim): ArrayBuffer {
  const { time, over, winner, bases } = sim;
  const mana = sim.manaOf, rallyUntil = sim.rallyUntilOf;
  const boost = rallyUntil.map((_, f) => (sim.rallyActive(f) ? MANA.rallySpeed : 1));
  const alive = sim.units.filter((u) => u.alive);
  const n = Math.min(alive.length, 65535);
  const buf = new ArrayBuffer(HEADER + bases.length * PER_BASE + n * PER_UNIT);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, 1); o += 1;
  v.setFloat32(o, time, true); o += 4;
  v.setUint8(o, over ? 1 : 0); o += 1;
  v.setInt8(o, Math.max(-128, Math.min(127, winner))); o += 1;
  v.setFloat32(o, mana[0] ?? 0, true); o += 4;
  v.setFloat32(o, mana[1] ?? 0, true); o += 4;
  v.setFloat32(o, rallyUntil[0] ?? -1, true); o += 4;
  v.setFloat32(o, rallyUntil[1] ?? -1, true); o += 4;
  v.setUint8(o, bases.length); o += 1;
  v.setUint16(o, n, true); o += 2;
  for (const b of bases) {
    v.setInt8(o, b.owner); o += 1;
    v.setUint16(o, Math.max(0, Math.min(65535, Math.round(b.troops * 10))), true); o += 2;
    // seconds since last hit, in centiseconds (for hit flashes)
    v.setUint16(o, Math.max(0, Math.min(65535, Math.round((time - b.lastHit) * 100))), true); o += 2;
  }
  for (let i = 0; i < n; i++) {
    const u = alive[i];
    v.setUint32(o, u.id, true); o += 4;
    v.setInt16(o, Math.round(u.x * 100), true); o += 2;
    v.setInt16(o, Math.round(u.z * 100), true); o += 2;
    v.setInt8(o, Math.round(u.dx * 127)); o += 1;
    v.setInt8(o, Math.round(u.dz * 127)); o += 1;
    v.setUint8(o, u.faction); o += 1;
    v.setUint8(o, u.to); o += 1;
    v.setUint8(o, Math.min(255, Math.round(u.speed * (boost[u.faction] ?? 1) * 40))); o += 1;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot | null {
  const v = new DataView(buf);
  if (v.byteLength < HEADER || v.getUint8(0) !== 1) return null;
  let o = 1;
  const time = v.getFloat32(o, true); o += 4;
  const over = v.getUint8(o) === 1; o += 1;
  const winner = v.getInt8(o); o += 1;
  const mana: [number, number] = [v.getFloat32(o, true), v.getFloat32(o + 4, true)]; o += 8;
  const rallyUntil: [number, number] = [v.getFloat32(o, true), v.getFloat32(o + 4, true)]; o += 8;
  const nb = v.getUint8(o); o += 1;
  const nu = v.getUint16(o, true); o += 2;
  if (v.byteLength < HEADER + nb * PER_BASE + nu * PER_UNIT) return null; // truncated / corrupt
  const bases: Snapshot['bases'] = [];
  for (let i = 0; i < nb; i++) {
    const owner = v.getInt8(o); o += 1;
    const troops = v.getUint16(o, true) / 10; o += 2;
    const since = v.getUint16(o, true) / 100; o += 2;
    bases.push({ owner, troops, lastHit: time - since });
  }
  const units: Snapshot['units'] = [];
  for (let i = 0; i < nu; i++) {
    const id = v.getUint32(o, true); o += 4;
    const x = v.getInt16(o, true) / 100; o += 2;
    const z = v.getInt16(o, true) / 100; o += 2;
    let dx = v.getInt8(o) / 127; o += 1;
    let dz = v.getInt8(o) / 127; o += 1;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const faction = v.getUint8(o); o += 1;
    const to = v.getUint8(o); o += 1;
    const speed = v.getUint8(o) / 40; o += 1;
    units.push({ id, x, z, dx, dz, faction, to, speed });
  }
  return { time, over, winner, mana, rallyUntil, bases, units };
}

/** Commands a guest sends to the host. */
export type Command =
  | { k: 'send'; from: number[]; to: number }
  | { k: 'smite'; x: number; z: number }
  | { k: 'swat'; x: number; z: number; r: number; vx: number; vz: number }
  | { k: 'rally' };

/** Events worth replaying on the guest for FX/SFX (unit-level noise is thinned). */
export function filterEvents(events: GameEvent[]): GameEvent[] {
  const out: GameEvent[] = [];
  let clashes = 0, hits = 0;
  for (const e of events) {
    if (e.type === 'clash') { if (clashes++ < 12) out.push(e); continue; }
    if (e.type === 'hit') { if (hits++ < 12) out.push(e); continue; }
    if (e.type === 'reinforce') continue;
    out.push(e);
  }
  return out;
}

/** Hand pose for the opponent's ghost hand: world-space points (x, z, height). */
export interface RemoteHand { p: boolean; g: number; pts: number[] }   // g: 0 none 1 fist 2 middle 3 open
