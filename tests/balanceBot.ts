/**
 * Human-like player bot + headless match runner for balance testing.
 * NOT shipped — only used by tests/balance*.test.ts.
 *
 * The bot drives faction 0 purely through the public Sim API (send / smite / swat) with
 * human constraints: two hands, each acting at most every `interval` seconds, a reaction
 * delay between seeing and doing, noisy target choice, occasional blunders, sweeps over
 * neighbouring bases for multi-source sends, and power use gated by mana.
 */
import { BASE_TYPES, MANA, NEUTRAL, PLAYER, SIM } from '../src/config';
import { Warlord } from '../src/game/ai';
import type { Level } from '../src/game/levels';
import { generateMap } from '../src/game/mapgen';
import { Rng } from '../src/game/rng';
import { Sim } from '../src/game/sim';
import type { Base, Unit } from '../src/game/types';

export interface Skill {
  name: string;
  hands: 1 | 2;
  /** seconds between actions of one hand */
  interval: [number, number];
  /** extra interval for the second hand (people use the off-hand less) */
  offhandSlow: number;
  /** seconds between deciding and the command landing (perception + drag time) */
  react: number;
  /** multiplicative noise on target scores (0 = perfect) */
  noise: number;
  /** probability of a careless decision (random affordable-looking target, ignores growth) */
  blunder: number;
  /** required (troops sent / troops needed) */
  margin: number;
  /** accounts for growth during travel / incoming armies */
  reads: boolean;
  /** probability of sweeping extra bases into a send */
  multiP: number;
  /** probability (per decision) to try a smite when mana allows */
  smiteP: number;
  smiteMin: number;
  aimErr: number;
  swatP: number;
  defendP: number;
  /** probability (per decision) to consider a RALLY clap when mana allows */
  rallyP: number;
  /** probability a decision tick is wasted (looking at the webcam, misdetected pinch, ...) */
  idleP: number;
}

export const SKILLS: Record<'novice' | 'average' | 'skilled', Skill> = {
  novice: {
    name: 'novice', hands: 1, interval: [1.5, 2.6], offhandSlow: 0, react: 0.75,
    noise: 0.6, blunder: 0.2, margin: 1.0, reads: false, multiP: 0.12,
    smiteP: 0.35, smiteMin: 6, aimErr: 1.4, swatP: 0.05, defendP: 0.25, rallyP: 0, idleP: 0.2,
  },
  average: {
    name: 'average', hands: 2, interval: [1.0, 1.8], offhandSlow: 1.2, react: 0.5,
    noise: 0.35, blunder: 0.08, margin: 1.1, reads: true, multiP: 0.35,
    smiteP: 0.5, smiteMin: 8, aimErr: 0.8, swatP: 0.15, defendP: 0.55, rallyP: 0.12, idleP: 0.1,
  },
  skilled: {
    name: 'skilled', hands: 2, interval: [0.6, 1.15], offhandSlow: 0.3, react: 0.32,
    noise: 0.15, blunder: 0.02, margin: 1.2, reads: true, multiP: 0.6,
    smiteP: 0.8, smiteMin: 10, aimErr: 0.4, swatP: 0.3, defendP: 0.85, rallyP: 0.5, idleP: 0.03,
  },
};

type Pending =
  | { kind: 'send'; at: number; from: number[]; to: number }
  | { kind: 'smite'; at: number; x: number; z: number }
  | { kind: 'swat'; at: number; key: string }
  | { kind: 'rally'; at: number };

interface Hand { next: number; pending: Pending | null }

export class PlayerBot {
  private rng: Rng;
  private hands: Hand[];
  constructor(public skill: Skill, seed: number) {
    this.rng = new Rng(seed * 977 + 5);
    this.hands = [
      { next: 0.8 + this.rng.range(0, 0.6), pending: null },
      { next: 1.4 + this.rng.range(0, 1.2), pending: null },
    ];
  }

  update(sim: Sim, dt: number) {
    if (sim.over) return;
    const t = sim.time;
    for (let h = 0; h < this.skill.hands; h++) {
      const hand = this.hands[h];
      if (hand.pending && t >= hand.pending.at) {
        this.execute(sim, hand.pending);
        hand.pending = null;
      }
      if (!hand.pending && t >= hand.next) {
        const [a, b] = this.skill.interval;
        hand.next = t + this.skill.react + this.rng.range(a, b) + (h === 1 ? this.skill.offhandSlow : 0);
        if (this.rng.chance(this.skill.idleP)) continue;
        const busy = new Set<number>();
        for (const o of this.hands) if (o.pending?.kind === 'send') o.pending.from.forEach((id) => busy.add(id));
        hand.pending = this.decide(sim, busy);
        if (hand.pending) hand.pending.at = t + this.skill.react + (hand.pending.kind === 'smite' ? MANA.smiteChargeTime : 0);
        // a clap needs both hands: the other hand is busy too
        if (hand.pending?.kind === 'rally') for (const o of this.hands) if (o !== hand) o.next = Math.max(o.next, hand.pending.at + 0.5);
      }
    }
  }

  // ------------------------------------------------------------------ execution
  private execute(sim: Sim, p: Pending) {
    if (p.kind === 'send') {
      sim.send(p.from, p.to, PLAYER);
    } else if (p.kind === 'smite') {
      // humans track the army they are aiming at with the fist
      let { x, z } = p;
      if (this.skill.reads) {
        const c = clusterNear(sim, x, z, 4);
        if (c) { x = c.x; z = c.z; }
      }
      x += this.rng.range(-1, 1) * this.skill.aimErr;
      z += this.rng.range(-1, 1) * this.skill.aimErr;
      sim.smite(x, z);
    } else if (p.kind === 'rally') {
      sim.rally();
    } else if (p.kind === 'swat') {
      const col = columns(sim).find((c) => c.key === p.key);
      if (!col) return;
      // swipe through the column: aligned for good players, random-ish for others
      const along = Math.atan2(col.dz, col.dx);
      const spread = this.skill.reads ? 0.6 : Math.PI;
      const ang = along + this.rng.range(-spread, spread);
      const len = 6;
      const ex = col.hx + this.rng.range(-1, 1) * this.skill.aimErr * 0.6;
      const ez = col.hz + this.rng.range(-1, 1) * this.skill.aimErr * 0.6;
      const vx = Math.cos(ang) * 40, vz = Math.sin(ang) * 40;
      for (let s = 0; s <= 10; s++) {
        const k = s / 10 - 0.5;
        sim.swat(ex + Math.cos(ang) * len * k, ez + Math.sin(ang) * len * k, MANA.swatRadius, vx, vz);
      }
    }
  }

  // ------------------------------------------------------------------ decisions
  private decide(sim: Sim, busy: Set<number>): Pending | null {
    const sk = this.skill;
    const rng = this.rng;
    const mine = sim.bases.filter((b) => b.owner === PLAYER && !busy.has(b.id));
    const inc = sim.incoming();

    // Powers ------------------------------------------------------------
    if (sim.canRally() && !sim.rallyActive() && rng.chance(sk.rallyP)) {
      // worth it when many bases are below cap (just emptied) and/or a big army is on the march
      let gain = 0;
      for (const b of sim.bases) if (b.owner === PLAYER) gain += Math.min(Math.max(0, b.cap - b.troops), b.growth * (MANA.rallyGrowth - 1) * MANA.rallyDuration);
      let marching = 0;
      for (const u of sim.units) if (u.alive && u.faction === PLAYER && sim.bases[u.to].owner !== PLAYER) marching++;
      if (gain + marching * 0.4 >= 45) return { kind: 'rally', at: 0 };
    }
    if (sim.mana >= MANA.smiteCost && rng.chance(sk.smiteP)) {
      const s = bestSmite(sim, inc);
      if (s && s.score >= sk.smiteMin) return { kind: 'smite', at: 0, x: s.x, z: s.z };
    }
    if (sim.mana >= (sk.reads ? 45 : 15) && rng.chance(sk.swatP)) {
      const cols = columns(sim).filter((c) => c.n >= 8);
      const threat = cols.filter((c) => sim.bases[c.to].owner === PLAYER);
      const pool = threat.length ? threat : cols;
      if (pool.length) {
        pool.sort((a, b) => b.n - a.n);
        return { kind: 'swat', at: 0, key: pool[0].key };
      }
    }
    if (!mine.length) return null;

    // Defence -----------------------------------------------------------
    if (rng.chance(sk.defendP)) {
      for (const b of mine) {
        let hostile = 0;
        for (let f = 0; f < sim.factions; f++) if (f !== PLAYER) hostile += inc[b.id][f];
        const own = b.troops + inc[b.id][PLAYER];
        if (hostile > own + 1) {
          const helper = mine
            .filter((h) => h.id !== b.id && h.troops >= 8)
            .sort((a, c) => dist(a, b) - dist(c, b))[0];
          if (helper) return { kind: 'send', at: 0, from: [helper.id], to: b.id };
        }
      }
    }

    // Attack / expand ---------------------------------------------------
    const ready = mine.filter((b) => b.troops >= 5);
    if (!ready.length) return null;
    const careless = rng.chance(sk.blunder);
    let best: { from: number[]; to: number; v: number } | null = null;
    const sweep = rng.chance(sk.multiP);
    for (const t of sim.bases) {
      if (t.owner === PLAYER) continue;
      const order = ready.slice().sort((a, b) => dist(a, t) - dist(b, t));
      // candidate source groups: every single base (a human looks at the big numbers) + one sweep
      const groups: Base[][] = order.slice(0, 4).map((b) => [b]);
      if (sweep && order.length > 1) {
        const primary = order[0];
        const g = [primary];
        const maxG = sk.reads ? 4 : 2;
        for (const o of order.slice(1)) {
          if (g.length >= maxG) break;
          // a sweep chains over own bases lying next to each other
          if (g.some((x) => dist(o, x) < 9) && dist(o, t) < dist(primary, t) + 8) g.push(o);
        }
        if (g.length > 1) groups.push(g);
      }
      for (const from of groups) {
        const sent = from.reduce((a, b) => a + Math.floor(b.troops * SIM.sendFraction), 0);
        if (sent < 3) continue;
        const d = Math.max(...from.map((s) => dist(s, t)));
        let need = t.troops;
        if (sk.reads && !careless) {
          if (t.owner !== NEUTRAL) need += Math.min(t.growth * d / SIM.unitSpeed, Math.max(0, t.cap - t.troops)) + inc[t.id][t.owner];
          if (t.type === 'tower' && t.owner !== NEUTRAL) need += 3 + sent * 0.06;
          need -= inc[t.id][PLAYER];
        } else if (inc[t.id][PLAYER] > t.troops) continue; // already dealt with
        const margin = careless ? 0.75 : sk.margin;
        if (sent <= need * margin + 1) continue;
        let v = BASE_TYPES[t.type].value / Math.pow(Math.max(0, need) + 4, 0.9) / Math.pow(d + 4, 0.8);
        if (t.owner === NEUTRAL) v *= 1.2;
        // prefer not to strip a base far more than needed
        v *= 1 / (1 + Math.max(0, sent - need * 1.6 - 6) * 0.01);
        v *= 1 + rng.range(-sk.noise, sk.noise);
        if (careless) v = rng.next();
        if (!best || v > best.v) best = { from: from.map((s) => s.id), to: t.id, v };
      }
    }
    if (best) return { kind: 'send', at: 0, from: best.from, to: best.to };

    // Consolidate: skilled players push full rear bases to the front.
    if (sk.reads || rng.chance(0.3)) {
      const full = mine.filter((b) => b.troops > b.cap * 0.9);
      if (full.length && mine.length > 1) {
        const enemies = sim.bases.filter((b) => b.owner > PLAYER);
        const front = (b: Base) => Math.min(...enemies.map((e) => dist(e, b)), 99);
        const src = full.sort((a, b) => front(b) - front(a))[0];
        const dst = mine.filter((b) => b.id !== src.id).sort((a, b) => front(a) - front(b))[0];
        if (dst && front(dst) < front(src) - 2) return { kind: 'send', at: 0, from: [src.id], to: dst.id };
      }
    }
    return null;
  }
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }) { return Math.hypot(a.x - b.x, a.z - b.z); }

/** Best smite location: dense enemy armies (threatening ones count more), or enemy bases we are about to hit. */
function bestSmite(sim: Sim, inc: number[][]): { x: number; z: number; score: number } | null {
  const r2 = MANA.smiteRadius * MANA.smiteRadius * 0.8;
  const enemy = sim.units.filter((u) => u.alive && u.faction !== PLAYER);
  let best: { x: number; z: number; score: number } | null = null;
  const stride = Math.max(1, Math.floor(enemy.length / 60));
  for (let i = 0; i < enemy.length; i += stride) {
    const u = enemy[i];
    let n = 0, sx = 0, sz = 0;
    for (const v of enemy) {
      const dx = v.x - u.x, dz = v.z - u.z;
      if (dx * dx + dz * dz < r2) { n += sim.bases[v.to].owner === PLAYER ? 1.3 : 1; sx += v.x; sz += v.z; }
    }
    if (!best || n > best.score) best = { x: sx / Math.max(1, n), z: sz / Math.max(1, n), score: n };
    // recompute exact centre
    if (best && best.score === n) {
      let c = 0; sx = 0; sz = 0;
      for (const v of enemy) { const dx = v.x - u.x, dz = v.z - u.z; if (dx * dx + dz * dz < r2) { c++; sx += v.x; sz += v.z; } }
      best.x = sx / c; best.z = sz / c;
    }
  }
  // enemy bases our armies are heading for (the -12 finishes the job)
  for (const b of sim.bases) {
    if (b.owner === PLAYER || b.owner === NEUTRAL) continue;
    const ours = inc[b.id][PLAYER];
    const s = Math.min(MANA.smiteBaseDamage, b.troops) * (ours > 0 && ours + 12 > b.troops ? 1.3 : 0.6);
    if (!best || s > best.score) best = { x: b.x, z: b.z, score: s };
  }
  return best;
}

function clusterNear(sim: Sim, x: number, z: number, r: number): { x: number; z: number } | null {
  let n = 0, sx = 0, sz = 0;
  for (const u of sim.units) {
    if (!u.alive || u.faction === PLAYER) continue;
    if ((u.x - x) ** 2 + (u.z - z) ** 2 < r * r) { n++; sx += u.x; sz += u.z; }
  }
  return n ? { x: sx / n, z: sz / n } : null;
}

interface Column { key: string; n: number; to: number; hx: number; hz: number; dx: number; dz: number }
function columns(sim: Sim): Column[] {
  const m = new Map<string, { us: Unit[] }>();
  for (const u of sim.units) {
    if (!u.alive || u.faction === PLAYER) continue;
    const k = `${u.faction}:${u.from}:${u.to}`;
    let e = m.get(k);
    if (!e) m.set(k, (e = { us: [] }));
    e.us.push(u);
  }
  const out: Column[] = [];
  for (const [key, { us }] of m) {
    let sx = 0, sz = 0;
    for (const u of us) { sx += u.x; sz += u.z; }
    out.push({ key, n: us.length, to: us[0].to, hx: sx / us.length, hz: sz / us.length, dx: us[0].dx, dz: us[0].dz });
  }
  return out;
}

// ------------------------------------------------------------------ match runner

export interface MatchResult { win: boolean; over: boolean; time: number; winner: number; smites: number; rallies: number; captures: number; aiCaptures: number }

/** Deterministic Math.random for the sim's cosmetic jitter. */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  const r = new Rng(seed * 4099 + 7);
  const orig = Math.random;
  Math.random = () => r.next();
  try { return fn(); } finally { Math.random = orig; }
}

export function runMatch(level: Level, skill: Skill | null, seed: number, opts: { maxTime?: number; dt?: number; tutorial?: boolean; trace?: (sim: Sim) => void } = {}): MatchResult {
  return withSeededRandom(seed, () => {
    const maxTime = opts.maxTime ?? 300;
    const dt = opts.dt ?? 1 / 30;
    const bases = generateMap(level.map);
    const factions = level.map.enemies + 1;
    const sim = new Sim(bases, factions);
    const ais: Warlord[] = [];
    for (let f = 1; f < factions; f++) ais.push(new Warlord(f, level.ai, level.map.seed + seed * 101));
    const bot = skill ? new PlayerBot(skill, seed) : null;
    // Tutorial (L1): the AI sleeps while the player learns to pinch/send/sweep; enemies kept small.
    const tutorial = opts.tutorial ?? !!level.tutorial;
    const aiWake = tutorial ? 30 : 0;
    let aiCaptures = 0;
    while (!sim.over && sim.time < maxTime) {
      bot?.update(sim, dt);
      if (sim.time >= aiWake) for (const a of ais) a.update(sim, dt);
      sim.step(dt);
      if (tutorial && sim.time < 22) for (const b of sim.bases) if (b.owner > PLAYER) b.troops = Math.min(b.troops, 14);
      if (tutorial && sim.time > 22 && sim.time < 23) sim.mana = MANA.max;
      for (const e of sim.events) if (e.type === 'capture' && e.to !== PLAYER) aiCaptures++;
      opts.trace?.(sim);
      sim.events.length = 0;
    }
    return { win: sim.over && sim.winner === PLAYER, over: sim.over, time: sim.time, winner: sim.winner, smites: sim.stats.smites, rallies: sim.stats.rallies, captures: sim.stats.captures, aiCaptures };
  });
}

export interface Summary { level: number; skill: string; n: number; win: number; avgT: number; medT: number; stall: number }

export function evaluate(level: Level, skill: Skill, seeds: number[], maxTime = 300): Summary {
  const rs = seeds.map((s) => runMatch(level, skill, s, { maxTime }));
  const times = rs.map((r) => r.time).sort((a, b) => a - b);
  return {
    level: level.id, skill: skill.name, n: rs.length,
    win: rs.filter((r) => r.win).length / rs.length,
    avgT: times.reduce((a, b) => a + b, 0) / times.length,
    medT: times[Math.floor(times.length / 2)],
    stall: rs.filter((r) => !r.over || r.time > 240).length / rs.length,
  };
}
