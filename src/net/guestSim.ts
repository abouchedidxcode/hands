import { Sim } from '../game/sim';
import type { Base, Unit } from '../game/types';
import type { Command, Snapshot } from './protocol';

/**
 * The guest's view of an online match. It never simulates combat: state comes from the host's
 * snapshots, units are dead-reckoned between them, and player actions become network commands.
 */
export class GuestSim extends Sim {
  latency = 0.05;   // one-way seconds, updated from RTT
  private byId = new Map<number, Unit>();
  private gotFirst = false;

  constructor(bases: Base[], factions: number, private sendCmd: (c: Command) => void) {
    super(bases, factions);
    this.humans = [0, 1];
  }

  // ---- commands go to the host (optimistic return values keep local feedback snappy)
  override send(from: number[], to: number, faction: number): number {
    const ok = from.filter((id) => this.bases[id]?.owner === faction && id !== to && this.bases[id].troops >= 2);
    if (!ok.length) return 0;
    this.sendCmd({ k: 'send', from: ok, to });
    let n = 0;
    for (const id of ok) n += Math.floor(this.bases[id].troops * 0.5);
    return n;
  }
  override smite(x: number, z: number, f = 1): number {
    if (!this.canSmite(f)) return -1;
    this.sendCmd({ k: 'smite', x, z });
    this.manaOf[f] -= 35; // until the next snapshot corrects it
    return 0;
  }
  override swat(x: number, z: number, r: number, vx: number, vz: number, f = 1): number {
    if (this.manaOf[f] < 1) return 0;
    let hit = 0;
    for (const u of this.units) if (u.alive && u.faction !== f && (u.x - x) ** 2 + (u.z - z) ** 2 < r * r) hit++;
    if (hit) this.sendCmd({ k: 'swat', x, z, r, vx, vz });
    return hit; // optimistic (for local feedback); the host decides the real kills
  }
  override rally(f = 1): boolean {
    if (!this.canRally(f)) return false;
    this.sendCmd({ k: 'rally' });
    this.manaOf[f] -= 50;
    return true;
  }

  /** Advance only the cosmetic state between snapshots. */
  /** performance.now() of the last snapshot; units freeze if the host goes quiet. */
  lastSnap = 0;
  get stalled() { return this.gotFirst && performance.now() - this.lastSnap > 1200; }

  override step(dt: number) {
    if (!this.gotFirst || this.stalled) return;
    this.time += dt;
    for (const u of this.units) {
      u.x += u.dx * u.speed * dt;
      u.z += u.dz * u.speed * dt;
    }
  }

  apply(s: Snapshot) {
    this.gotFirst = true;
    this.lastSnap = performance.now();
    this.time = s.time + this.latency;
    this.over = s.over;
    this.winner = s.winner;
    this.manaOf[0] = s.mana[0];
    this.manaOf[1] = s.mana[1];
    this.rallyUntilOf[0] = s.rallyUntil[0];
    this.rallyUntilOf[1] = s.rallyUntil[1];
    s.bases.forEach((sb, i) => {
      const b = this.bases[i];
      if (!b) return;
      b.owner = sb.owner;
      b.troops = sb.troops;
      if (sb.lastHit > b.lastHit) b.lastHit = sb.lastHit;
    });
    const seen = new Set<number>();
    const next: Unit[] = [];
    for (const su of s.units) {
      seen.add(su.id);
      let u = this.byId.get(su.id);
      const ax = su.x + su.dx * su.speed * this.latency, az = su.z + su.dz * su.speed * this.latency;
      if (!u) {
        u = { id: su.id, faction: su.faction, from: su.to, to: su.to, x: ax, z: az, dx: su.dx, dz: su.dz, offset: 0, speed: su.speed, alive: true, born: this.time, doomed: false };
        this.byId.set(su.id, u);
      } else {
        // ease toward the authoritative position instead of snapping
        const ex = ax - u.x, ez = az - u.z;
        if (ex * ex + ez * ez > 1) { u.x = ax; u.z = az; } else { u.x += ex * 0.5; u.z += ez * 0.5; }
        u.dx = su.dx; u.dz = su.dz; u.speed = su.speed; u.to = su.to;
      }
      next.push(u);
    }
    for (const id of this.byId.keys()) if (!seen.has(id)) this.byId.delete(id);
    this.units = next;
  }
}
