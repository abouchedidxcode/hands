import { BASE_TYPES, NEUTRAL, PLAYER, SIM } from '../config';
import { Rng } from './rng';
import type { Sim } from './sim';
import type { Base } from './types';

export interface AiParams {
  think: number;        // seconds between decisions
  aggro: number;        // 0..1 — willingness to attack with thin margins / target the player
  focusPlayer: number;  // multiplier on player-owned targets' desirability
  /** 0..1 — defends threatened bases, reads incoming armies, punishes over-extension (default 0.5). */
  cunning?: number;
  /** Seconds before the warlord makes its first move (default ~1). */
  wake?: number;
  /** Faction flavours: Crimson aggressive, Amber expansionist, Violet opportunist (default true). */
  personality?: boolean;
  /** Seconds after which warlords grow impatient and press attacks harder (anti-stall, default 80). */
  rageAt?: number;
}

/** Per-faction flavour. Multipliers on the shared level parameters. */
interface Persona {
  think: number;     // × think interval
  aggro: number;     // + aggro
  neutral: number;   // × desirability of neutral targets
  hostile: number;   // × desirability of warlord/player targets
  weak: number;      // bonus for weakened / freshly captured / emptied bases
  snipe: number;     // bonus for neutrals another faction is about to take (steal after the fight)
  castle: number;    // × castle desirability
  reserve: number;   // troops a base keeps before it is used as a source
  sources: number;   // max bases pooled into one attack
}

const PLAIN: Persona = { think: 1, aggro: 0, neutral: 1.1, hostile: 1, weak: 0.6, snipe: 0.3, castle: 1, reserve: 7, sources: 3 };
const PERSONAS: Record<number, Persona> = {
  // Crimson — aggressive: fast, thin margins, loves hitting armies and bases of rivals.
  1: { think: 0.9, aggro: 0.12, neutral: 0.95, hostile: 1.3, weak: 0.8, snipe: 0.2, castle: 1, reserve: 6, sources: 3 },
  // Amber — expansionist: grabs neutrals and castles, consolidates, only fights when fat.
  2: { think: 1, aggro: -0.06, neutral: 1.45, hostile: 0.85, weak: 0.5, snipe: 0.3, castle: 1.35, reserve: 8, sources: 3 },
  // Violet — opportunist / sniper: waits, then steals contested neutrals and emptied bases.
  3: { think: 0.85, aggro: 0, neutral: 1.0, hostile: 1.05, weak: 1.6, snipe: 1.2, castle: 1, reserve: 10, sources: 4 },
};

/** A warlord. Greedy, opportunistic, with coordination, defence and a personality. */
export class Warlord {
  private timer: number;
  private rng: Rng;
  private persona: Persona;
  /** Last seen garrison per base, to notice bases that just emptied themselves. */
  private seen: number[] = [];
  private drained: number[] = [];

  constructor(public faction: number, public p: AiParams, seed: number) {
    this.rng = new Rng(seed * 31 + faction);
    this.persona = p.personality === false ? PLAIN : PERSONAS[faction] ?? PLAIN;
    this.timer = (p.wake ?? 0.6) + this.rng.range(0, Math.min(1.2, p.think * 0.5));
  }

  update(sim: Sim, dt: number) {
    if (!sim.alive[this.faction] || sim.over) return;
    this.watch(sim);
    this.timer -= dt;
    if (this.timer > 0) return;
    // Expand fast in the opening, speed up when impatient.
    const early = sim.time < 20 ? 0.65 : 1;
    const rage = this.rage(sim);
    this.timer = this.p.think * this.persona.think * early * (1 - 0.3 * rage) * this.rng.range(0.75, 1.25);
    this.think(sim);
  }

  private rage(sim: Sim) {
    const at = this.p.rageAt ?? 80;
    return clamp01((sim.time - at) / 70);
  }

  /** Remember bases that suddenly lost many troops (they just launched an attack → counter-attack window). */
  private watch(sim: Sim) {
    for (const b of sim.bases) {
      const prev = this.seen[b.id] ?? b.troops;
      if (b.owner !== this.faction && b.owner !== NEUTRAL && prev - b.troops >= 6) this.drained[b.id] = sim.time;
      this.seen[b.id] = b.troops;
    }
  }

  private think(sim: Sim) {
    const me = this.faction;
    const P = this.persona;
    const cunning = this.p.cunning ?? 0.5;
    const mine = sim.bases.filter((b) => b.owner === me);
    if (!mine.length) return;
    const inc = sim.incoming();
    const rage = this.rage(sim);
    const aggro = clamp01(this.p.aggro + P.aggro + rage * 0.35);

    const hostileTo = (b: Base) => {
      let h = 0;
      for (let f = 0; f < sim.factions; f++) if (f !== me) h = Math.max(h, inc[b.id][f]);
      return h;
    };
    const threatened = new Set<number>();
    for (const b of mine) if (hostileTo(b) > b.troops * 0.6 + inc[b.id][me]) threatened.add(b.id);

    // 1) Defence: a base about to fall pulls help from close neighbours (if it can be saved).
    if (this.rng.chance(0.25 + 0.75 * cunning)) {
      const order = mine.slice().sort((a, b) => BASE_TYPES[b.type].value - BASE_TYPES[a.type].value);
      for (const b of order) {
        const deficit = hostileTo(b) - (b.troops + inc[b.id][me]);
        if (deficit <= 1) continue;
        const helpers = mine
          .filter((h) => h.id !== b.id && h.troops > 8 && !threatened.has(h.id) && dist(h, b) < 16)
          .sort((a, c) => dist(a, b) - dist(c, b))
          .slice(0, 2);
        const help = helpers.reduce((s, h) => s + Math.floor(h.troops * SIM.sendFraction), 0);
        if (help >= deficit * 0.8 && help >= 4) { sim.send(helpers.map((h) => h.id), b.id, me); return; }
      }
    }

    // Faction strengths: finish weak factions, don't poke a giant without reason.
    const strength = sim.strength();
    const basesOf = new Array(sim.factions).fill(0);
    for (const b of sim.bases) if (b.owner >= 0) basesOf[b.owner]++;

    // 2) Attack: pick best (target, sources) combo.
    let best: { target: Base; sources: Base[]; value: number } | null = null;
    const ready = mine.filter((b) => b.troops >= P.reserve && !threatened.has(b.id));
    if (ready.length) {
      const maxSrc = P.sources + (rage > 0.5 ? 1 : 0);
      const margin = 1.25 - aggro * 0.35;
      for (const t of sim.bases) {
        if (t.owner === me) continue;
        const near = ready
          .map((s) => ({ s, d: dist(s, t) }))
          .filter((x) => x.d < 22 + rage * 20)
          .sort((a, b) => a.d - b.d)
          .slice(0, maxSrc);
        let sent = 0;
        const srcs: Base[] = [];
        let maxD = 0;
        let need = 0;
        let ok = false;
        for (const { s, d } of near) {
          srcs.push(s);
          sent += Math.floor(s.troops * SIM.sendFraction);
          maxD = Math.max(maxD, d);
          need = this.need(sim, inc, t, maxD / SIM.unitSpeed, sent, cunning);
          if (sent >= 4 && sent > need * margin + 2) { ok = true; break; }
        }
        if (!ok) continue;
        let v = BASE_TYPES[t.type].value * (t.type === 'castle' ? P.castle : 1);
        if (t.owner === NEUTRAL) {
          v *= P.neutral * (sim.time < 30 ? 1.3 : 1);
          let contested = 0;
          for (let f = 0; f < sim.factions; f++) if (f !== me) contested = Math.max(contested, inc[t.id][f]);
          if (contested > 0) v *= 1 + P.snipe * 0.6;
        } else {
          v *= P.hostile;
          if (t.owner === PLAYER) v *= this.p.focusPlayer;
          // weakened / just emptied / freshly captured bases are juicy (counter-attacks)
          const emptied = sim.time - (this.drained[t.id] ?? -99) < 6 ? 1 : 0;
          const fresh = sim.time - t.captureTime < 5 ? 1 : 0;
          const thin = clamp01(1 - t.troops / (t.cap * 0.5));
          v *= 1 + P.weak * (0.5 * thin + 0.5 * Math.max(emptied, fresh)) * (0.4 + cunning);
          // finish off a dying faction (anti-stall)
          if (basesOf[t.owner] <= 2) v *= 1.25 + rage * 0.5;
          // late game: pressure the strongest rival so somebody wins
          if (rage > 0 && strength[t.owner] >= Math.max(...strength.filter((_, f) => f !== me))) v *= 1 + rage * 0.3;
        }
        v /= Math.pow(Math.max(0, need) + 4, 0.85) * Math.pow(maxD + 4, 0.8);
        v *= this.rng.range(0.85, 1.15);
        if (!best || v > best.value) best = { target: t, sources: srcs, value: v };
      }
    }
    if (best) {
      sim.send(best.sources.map((s) => s.id), best.target.id, me);
      return;
    }

    // 3) Siege (impatient): pool everything at the nearest hostile base even without a clean margin.
    if (rage > 0.4) {
      const hostiles = sim.bases.filter((b) => b.owner !== me && b.owner !== NEUTRAL);
      const big = mine.filter((b) => b.troops > b.cap * 0.6 && !threatened.has(b.id));
      if (hostiles.length && big.length) {
        const t = hostiles.sort((a, b) => nearest(big, a) - nearest(big, b))[0];
        const srcs = big.sort((a, b) => dist(a, t) - dist(b, t)).slice(0, 4);
        const sent = srcs.reduce((s, b) => s + Math.floor(b.troops * SIM.sendFraction), 0);
        if (sent > t.troops * 0.55) { sim.send(srcs.map((s) => s.id), t.id, me); return; }
      }
    }

    // 4) Consolidate: move troops from full rear bases toward the front.
    const full = mine.filter((b) => b.troops > b.cap * 0.85);
    if (full.length && mine.length > 1) {
      const src = full.sort((a, b) => frontness(sim, b, me) - frontness(sim, a, me))[0];
      const front = mine
        .filter((b) => b.id !== src.id && b.troops < b.cap * 1.2)
        .sort((a, b) => frontness(sim, a, me) - frontness(sim, b, me))[0];
      if (front && frontness(sim, front, me) < frontness(sim, src, me) - 1) sim.send([src.id], front.id, me);
    }
  }

  /** Troops needed to take `t` if our army arrives in `travel` seconds. */
  private need(sim: Sim, inc: number[][], t: Base, travel: number, sent: number, cunning: number): number {
    const me = this.faction;
    let need: number;
    if (t.owner === NEUTRAL) {
      // Another faction already marching on it: after their fight the remainder is what we face.
      let other = 0;
      for (let f = 0; f < sim.factions; f++) if (f !== me) other = Math.max(other, inc[t.id][f]);
      const rem = t.troops - other * cunning;
      need = rem >= 0 ? rem : -rem + 2;
    } else {
      const grow = Math.min(t.growth * travel, Math.max(0, t.cap - t.troops));
      need = t.troops + grow + inc[t.id][t.owner];
      if (t.type === 'tower') need += 3 + sent * 0.06;
    }
    // towers of other factions near the target shoot our column on approach
    for (const b of sim.bases) {
      if (b.type !== 'tower' || b.owner === me || b.owner === NEUTRAL || b.id === t.id) continue;
      if (dist(b, t) < BASE_TYPES.tower.range! + 1) need += 2 + sent * 0.04;
    }
    return need - inc[t.id][me];
  }
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }) { return Math.hypot(a.x - b.x, a.z - b.z); }
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function nearest(from: Base[], b: Base) { let d = Infinity; for (const f of from) d = Math.min(d, dist(f, b)); return d; }

/** Smaller = closer to enemies. */
function frontness(sim: Sim, b: Base, me: number) {
  let d = Infinity;
  for (const o of sim.bases) if (o.owner !== me && o.owner !== NEUTRAL) d = Math.min(d, Math.hypot(o.x - b.x, o.z - b.z));
  return d;
}
