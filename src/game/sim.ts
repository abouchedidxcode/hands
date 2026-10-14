import { BOARD, MANA, NEUTRAL, PLAYER, SIM, BASE_TYPES } from '../config';
import type { Arrow, Base, GameEvent, Launch, Stats, Unit } from './types';

const CELL = 0.8;

/**
 * Pure deterministic-ish battle simulation. No rendering, no DOM.
 * Coordinates are world units on the XZ ground plane.
 */
export class Sim {
  bases: Base[];
  units: Unit[] = [];
  launches: Launch[] = [];
  arrows: Arrow[] = [];
  events: GameEvent[] = [];
  time = 0;
  factions: number;
  alive: boolean[];
  over = false;
  winner = -99;
  /** Factions controlled by humans (have mana, powers and stats). Campaign: [PLAYER]; online 1v1: [0, 1]. */
  humans: number[] = [PLAYER];
  manaOf: number[];
  statsOf: Stats[];
  rallyUntilOf: number[];
  /** Per-faction growth multiplier (difficulty handicap; warlords set their own from AiParams.bonus). */
  growthMul: number[];
  // ---- single-player compatibility accessors (faction PLAYER)
  get mana() { return this.manaOf[PLAYER]; }
  set mana(v: number) { this.manaOf[PLAYER] = v; }
  get stats() { return this.statsOf[PLAYER]; }
  /** Sim time until which the player's RALLY is active (-1 = never). */
  get rallyUntil() { return this.rallyUntilOf[PLAYER]; }
  set rallyUntil(v: number) { this.rallyUntilOf[PLAYER] = v; }
  /** When false (attract mode), nobody is human: mana and stats are ignored. */
  get hasPlayer() { return this.humans.length > 0; }
  set hasPlayer(v: boolean) { this.humans = v ? [PLAYER] : []; }
  isHuman(f: number) { return this.humans.includes(f); }

  private nextUnitId = 1;
  private unitById = new Map<number, Unit>();
  // spatial hash
  private gw: number;
  private gh: number;
  private head: Int32Array;
  private next: Int32Array = new Int32Array(1024);

  constructor(bases: Base[], factions: number) {
    this.bases = bases;
    this.factions = factions;
    this.alive = Array.from({ length: factions }, () => true);
    this.growthMul = Array.from({ length: factions }, () => 1);
    this.manaOf = Array.from({ length: factions }, () => MANA.startMana);
    this.statsOf = Array.from({ length: factions }, () => ({ captures: 0, lost: 0, kills: 0, smites: 0, swats: 0, rallies: 0, sent: 0, peakArmy: 0 }));
    this.rallyUntilOf = Array.from({ length: factions }, () => -1);
    this.gw = Math.ceil((BOARD.width + 8) / CELL);
    this.gh = Math.ceil((BOARD.depth + 8) / CELL);
    this.head = new Int32Array(this.gw * this.gh);
  }

  // ---------------------------------------------------------------- commands

  /** Send half the garrison of each owned base in `from` to base `to`. Returns troops sent. */
  send(from: number[], to: number, faction: number): number {
    let total = 0;
    if (!this.bases[to]) return 0; // invalid target (e.g. a bad network command) would crash spawnUnit every frame
    for (const id of from) {
      const b = this.bases[id];
      if (!b || b.owner !== faction || id === to || b.troops < 2) continue;
      const n = Math.floor(b.troops * SIM.sendFraction);
      if (n < 1) continue;
      b.troops -= n;
      this.launches.push({ from: id, to, faction, remaining: n, timer: 0, row: 0 });
      this.events.push({ type: 'launch', from: id, to, faction, count: n });
      total += n;
    }
    if (this.isHuman(faction)) this.statsOf[faction].sent += total;
    return total;
  }

  canSmite(f = PLAYER): boolean { return this.manaOf[f] >= MANA.smiteCost && !this.over; }

  /** God lightning. Kills enemy units in radius and damages a hostile base inside. */
  smite(x: number, z: number, f = PLAYER): number {
    if (!this.canSmite(f)) return -1;
    this.manaOf[f] -= MANA.smiteCost;
    const r = MANA.smiteRadius;
    let kills = 0;
    for (const u of this.units) {
      if (!u.alive || u.faction === f) continue;
      const dx = u.x - x, dz = u.z - z;
      if (dx * dx + dz * dz < r * r) {
        this.kill(u);
        kills++;
        const d = Math.hypot(dx, dz) + 0.01;
        this.events.push({ type: 'fling', x: u.x, z: u.z, vx: (dx / d) * 6, vz: (dz / d) * 6, faction: u.faction });
      }
    }
    for (const b of this.bases) {
      if (b.owner === f) continue;
      if (Math.hypot(b.x - x, b.z - z) < r + b.radius * 0.5) {
        b.troops = Math.max(0, b.troops - MANA.smiteBaseDamage);
        b.lastHit = this.time;
      }
    }
    this.statsOf[f].kills += kills;
    this.statsOf[f].smites++;
    this.events.push({ type: 'smite', x, z, kills, radius: r, faction: f });
    return kills;
  }

  rallyActive(f = PLAYER): boolean { return this.time < (this.rallyUntilOf[f] ?? -1); }
  canRally(f = PLAYER): boolean { return this.manaOf[f] >= MANA.rallyCost && !this.over; }

  /** RALLY (clap): for a few seconds the faction's units march faster and its bases grow faster. */
  rally(f = PLAYER): boolean {
    if (!this.canRally(f)) return false;
    this.manaOf[f] -= MANA.rallyCost;
    this.rallyUntilOf[f] = this.time + MANA.rallyDuration;
    this.statsOf[f].rallies++;
    this.events.push({ type: 'rally', until: this.rallyUntilOf[f], faction: f });
    return true;
  }

  /** Palm swat: flings enemy units under the palm. Costs mana per unit. */
  swat(x: number, z: number, radius: number, vx: number, vz: number, f = PLAYER): number {
    let kills = 0;
    const sp = Math.hypot(vx, vz) + 0.001;
    for (const u of this.units) {
      if (!u.alive || u.faction === f) continue;
      if (this.manaOf[f] < MANA.swatCostPerUnit) break;
      const dx = u.x - x, dz = u.z - z;
      if (dx * dx + dz * dz < radius * radius) {
        this.kill(u);
        this.manaOf[f] -= MANA.swatCostPerUnit;
        kills++;
        const k = 7 + Math.random() * 5;
        this.events.push({ type: 'fling', x: u.x, z: u.z, vx: (vx / sp) * k + dx * 2, vz: (vz / sp) * k + dz * 2, faction: u.faction });
      }
    }
    if (kills) { this.statsOf[f].kills += kills; this.statsOf[f].swats++; }
    return kills;
  }

  // ---------------------------------------------------------------- queries

  baseAt(x: number, z: number, pad = 0.6): Base | null {
    let best: Base | null = null;
    let bd = Infinity;
    for (const b of this.bases) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < b.radius + pad && d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Total troops (garrison + marching + queued) per faction. */
  strength(): number[] {
    const s = new Array(this.factions).fill(0);
    for (const b of this.bases) if (b.owner >= 0) s[b.owner] += b.troops;
    for (const u of this.units) if (u.alive) s[u.faction] += 1;
    for (const l of this.launches) s[l.faction] += l.remaining;
    return s;
  }

  /** incoming[baseId][faction] = troops en route. */
  incoming(): number[][] {
    const inc = this.bases.map(() => new Array(this.factions).fill(0));
    for (const u of this.units) if (u.alive) inc[u.to][u.faction] += 1;
    for (const l of this.launches) inc[l.to][l.faction] += l.remaining;
    return inc;
  }

  // ---------------------------------------------------------------- step

  step(dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;

    // Growth
    for (const b of this.bases) {
      if (b.owner === NEUTRAL) continue;
      const g = b.growth * (this.growthMul[b.owner] ?? 1) * (this.rallyActive(b.owner) ? MANA.rallyGrowth : 1);
      if (b.troops < b.cap) b.troops = Math.min(b.cap, b.troops + g * dt);
      else b.troops = Math.max(b.cap, b.troops - SIM.overflowDecay * dt);
    }

    if (!this.over) for (const f of this.humans) this.manaOf[f] = Math.min(MANA.max, this.manaOf[f] + MANA.regen * dt);

    this.spawnFromLaunches(dt);
    this.moveUnits(dt);
    this.resolveClashes();
    this.towers(dt);
    this.compact();
    this.checkEnd();

    if (this.humans.length) {
      const str = this.strength();
      for (const f of this.humans) if ((str[f] || 0) > this.statsOf[f].peakArmy) this.statsOf[f].peakArmy = Math.round(str[f]);
    }
  }

  private spawnFromLaunches(dt: number) {
    for (let i = this.launches.length - 1; i >= 0; i--) {
      const l = this.launches[i];
      l.timer -= dt;
      while (l.timer <= 0 && l.remaining > 0) {
        const n = Math.min(SIM.rowWidth, l.remaining);
        for (let k = 0; k < n; k++) {
          const off = (k - (n - 1) / 2) * SIM.rowSpacing;
          this.spawnUnit(l, off);
        }
        l.remaining -= n;
        l.row++;
        l.timer += SIM.spawnRowInterval;
      }
      if (l.remaining <= 0) this.launches.splice(i, 1);
    }
  }

  private spawnUnit(l: Launch, off: number) {
    const a = this.bases[l.from];
    const b = this.bases[l.to];
    let dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const px = -dz, pz = dx; // perpendicular
    const sx = a.x + dx * a.radius * 0.9 + px * off;
    const sz = a.z + dz * a.radius * 0.9 + pz * off;
    const tx = b.x + px * off * 0.4, tz = b.z + pz * off * 0.4;
    let ux = tx - sx, uz = tz - sz;
    const ud = Math.hypot(ux, uz) || 1;
    ux /= ud; uz /= ud;
    const u: Unit = {
      id: this.nextUnitId++, faction: l.faction, from: l.from, to: l.to,
      x: sx, z: sz, dx: ux, dz: uz, offset: off,
      speed: SIM.unitSpeed * (0.96 + Math.random() * 0.08),
      alive: true, born: this.time, doomed: false,
    };
    this.units.push(u);
    this.unitById.set(u.id, u);
  }

  private moveUnits(dt: number) {
    const boost = this.rallyUntilOf.map((_, f) => (this.rallyActive(f) ? MANA.rallySpeed : 1));
    for (const u of this.units) {
      if (!u.alive) continue;
      const sp = u.speed * boost[u.faction];
      u.x += u.dx * sp * dt;
      u.z += u.dz * sp * dt;
      const t = this.bases[u.to];
      const rx = t.x - u.x, rz = t.z - u.z;
      // arrived when inside the target footprint or we've passed it
      if (rx * rx + rz * rz < t.radius * t.radius * 0.6 || rx * u.dx + rz * u.dz < 0) {
        this.arrive(u, t);
      }
    }
  }

  private arrive(u: Unit, b: Base) {
    u.alive = false;
    this.unitById.delete(u.id);
    if (b.owner === u.faction) {
      b.troops += 1;
      this.events.push({ type: 'reinforce', base: b.id });
      return;
    }
    b.troops -= 1;
    b.lastHit = this.time;
    this.events.push({ type: 'hit', base: b.id, faction: u.faction, x: u.x, z: u.z });
    if (b.troops < 0) {
      const prev = b.owner;
      b.owner = u.faction;
      b.troops = Math.abs(b.troops);
      b.captureTime = this.time;
      b.fireTimer = 0.6;
      this.events.push({ type: 'capture', base: b.id, from: prev, to: u.faction });
      if (this.isHuman(u.faction)) {
        this.statsOf[u.faction].captures++;
        this.manaOf[u.faction] = Math.min(MANA.max, this.manaOf[u.faction] + MANA.perCapture);
      }
      if (prev >= 0 && this.isHuman(prev)) {
        this.statsOf[prev].lost++;
      }
    }
  }

  private resolveClashes() {
    const n = this.units.length;
    if (this.next.length < n) this.next = new Int32Array(n * 2);
    const head = this.head;
    head.fill(-1);
    const ox = BOARD.width / 2 + 4, oz = BOARD.depth / 2 + 4;
    const gw = this.gw, gh = this.gh;
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      if (!u.alive) continue;
      const cx = Math.floor((u.x + ox) / CELL), cz = Math.floor((u.z + oz) / CELL);
      if (cx < 0 || cz < 0 || cx >= gw || cz >= gh) continue;
      const c = cz * gw + cx;
      this.next[i] = head[c];
      head[c] = i;
    }
    const r2 = SIM.clashRadius * SIM.clashRadius;
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      if (!u.alive) continue;
      const cx = Math.floor((u.x + ox) / CELL), cz = Math.floor((u.z + oz) / CELL);
      let found = false;
      for (let gz = cz - 1; gz <= cz + 1 && !found; gz++) {
        if (gz < 0 || gz >= gh) continue;
        for (let gx = cx - 1; gx <= cx + 1 && !found; gx++) {
          if (gx < 0 || gx >= gw) continue;
          for (let j = head[gz * gw + gx]; j !== -1; j = this.next[j]) {
            if (j === i) continue;
            const v = this.units[j];
            if (!v.alive || v.faction === u.faction) continue;
            const dx = v.x - u.x, dz = v.z - u.z;
            if (dx * dx + dz * dz < r2) {
              this.kill(u); this.kill(v);
              for (const f of this.humans) {
                if (u.faction === f || v.faction === f) {
                  this.statsOf[f].kills++;
                  this.manaOf[f] = Math.min(MANA.max, this.manaOf[f] + MANA.perKill);
                }
              }
              this.events.push({ type: 'clash', x: (u.x + v.x) / 2, z: (u.z + v.z) / 2, a: u.faction, b: v.faction });
              found = true;
              break;
            }
          }
        }
      }
    }
  }

  private towers(dt: number) {
    for (const b of this.bases) {
      if (b.type !== 'tower' || b.owner === NEUTRAL) continue;
      b.fireTimer -= dt;
      if (b.fireTimer > 0) continue;
      const range = BASE_TYPES.tower.range!;
      let best: Unit | null = null;
      let bd = range * range;
      for (const u of this.units) {
        if (!u.alive || u.doomed || u.faction === b.owner) continue;
        const dx = u.x - b.x, dz = u.z - b.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = u; }
      }
      if (best) {
        best.doomed = true;
        const lead = SIM.arrowFlight * best.speed;
        const tx = best.x + best.dx * lead, tz = best.z + best.dz * lead;
        this.arrows.push({ base: b.id, unit: best.id, t: 0, fx: tx, fz: tz });
        this.events.push({ type: 'arrow', base: b.id, x: b.x, z: b.z, tx, tz });
        b.fireTimer = BASE_TYPES.tower.fireInterval!;
      } else b.fireTimer = 0.1;
    }
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.t += dt;
      if (a.t < SIM.arrowFlight) continue;
      const u = this.unitById.get(a.unit);
      if (u && u.alive) {
        this.kill(u);
        const shooter = this.bases[a.base].owner;
        if (shooter >= 0 && shooter !== u.faction && this.isHuman(shooter)) this.statsOf[shooter].kills++;
        this.events.push({ type: 'arrowKill', x: u.x, z: u.z, faction: u.faction });
      }
      this.arrows.splice(i, 1);
    }
  }

  private kill(u: Unit) {
    u.alive = false;
    this.unitById.delete(u.id);
  }

  private compact() {
    let w = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.alive) this.units[w++] = u;
    }
    this.units.length = w;
  }

  private checkEnd() {
    if (this.over) return;
    const has = new Array(this.factions).fill(false);
    for (const b of this.bases) if (b.owner >= 0) has[b.owner] = true;
    for (const u of this.units) has[u.faction] = true;
    for (const l of this.launches) has[l.faction] = true;
    for (let f = 0; f < this.factions; f++) {
      if (this.alive[f] && !has[f]) {
        this.alive[f] = false;
        this.events.push({ type: 'eliminated', faction: f });
      }
    }
    const living = this.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
    if (this.humans.length === 1) {
      const me = this.humans[0];
      if (!this.alive[me]) { this.over = true; this.winner = living[0] ?? -1; }
      else if (living.length === 1) { this.over = true; this.winner = me; }
    } else if (living.length <= 1) {
      this.over = true; this.winner = living[0] ?? -1;
    }
    if (this.over) this.events.push({ type: 'end', winner: this.winner });
  }
}
