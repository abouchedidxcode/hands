import { BASE_TYPES, NEUTRAL, PLAYER, SIM } from '../config';
import { Rng } from './rng';
import type { Sim } from './sim';
import type { Base } from './types';

export interface AiParams {
  think: number;        // seconds between decisions
  aggro: number;        // 0..1 — willingness to attack with thin margins / target the player
  focusPlayer: number;  // multiplier on player-owned targets' desirability
}

/** A warlord. Greedy, opportunistic, with a dash of coordination and defence. */
export class Warlord {
  private timer: number;
  private rng: Rng;
  constructor(public faction: number, public p: AiParams, seed: number) {
    this.rng = new Rng(seed * 31 + faction);
    this.timer = 1.2 + this.rng.range(0, p.think);
  }

  update(sim: Sim, dt: number) {
    if (!sim.alive[this.faction] || sim.over) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.p.think * this.rng.range(0.7, 1.3);
    this.think(sim);
  }

  private think(sim: Sim) {
    const me = this.faction;
    const mine = sim.bases.filter((b) => b.owner === me);
    if (!mine.length) return;
    const inc = sim.incoming();

    // 1) Defence: a base about to fall pulls help from its richest neighbour.
    for (const b of mine) {
      let hostile = 0;
      for (let f = 0; f < sim.factions; f++) if (f !== me) hostile += inc[b.id][f];
      const own = b.troops + inc[b.id][me];
      if (hostile > own + 2) {
        const helper = mine
          .filter((h) => h.id !== b.id && h.troops > 10)
          .sort((a, c) => score(c, b) - score(a, b))[0];
        if (helper) { sim.send([helper.id], b.id, me); return; }
      }
    }

    // 2) Attack: pick best (target, sources) combo.
    let best: { target: Base; sources: Base[]; value: number } | null = null;
    const ready = mine.filter((b) => b.troops >= 8);
    if (!ready.length) return;
    for (const t of sim.bases) {
      if (t.owner === me) continue;
      // sort my bases by distance to t
      const near = ready
        .map((s) => ({ s, d: Math.hypot(s.x - t.x, s.z - t.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      let sent = 0;
      const srcs: Base[] = [];
      let maxD = 0;
      let need = 0;
      for (const { s, d } of near) {
        srcs.push(s);
        sent += Math.floor(s.troops * SIM.sendFraction);
        maxD = Math.max(maxD, d);
        const travel = maxD / SIM.unitSpeed;
        const grow = t.owner === NEUTRAL ? 0 : Math.min(t.growth * travel, Math.max(0, t.cap - t.troops));
        let hostileInc = 0;
        for (let f = 0; f < sim.factions; f++) if (f !== me && f === t.owner) hostileInc += inc[t.id][f];
        need = t.troops + grow + hostileInc - inc[t.id][me];
        const margin = 1.15 - this.p.aggro * 0.25;
        if (sent > need * margin + 1) break;
      }
      const margin = 1.15 - this.p.aggro * 0.25;
      if (sent <= need * margin + 1) continue;
      let v = BASE_TYPES[t.type].value / (2 + Math.max(0, need)) / Math.pow(maxD + 3, 0.8);
      if (t.owner === PLAYER) v *= this.p.focusPlayer;
      if (t.owner === NEUTRAL) v *= 1.15;
      v *= this.rng.range(0.85, 1.15);
      if (!best || v > best.value) best = { target: t, sources: srcs, value: v };
    }
    if (best) {
      sim.send(best.sources.map((s) => s.id), best.target.id, me);
      return;
    }

    // 3) Consolidate: move troops from overflowing rear bases toward the front.
    const full = mine.filter((b) => b.troops > b.cap * 0.9);
    if (full.length && mine.length > 1) {
      const src = full[0];
      const front = mine
        .filter((b) => b.id !== src.id)
        .sort((a, b) => frontness(sim, a, me) - frontness(sim, b, me))[0];
      if (front) sim.send([src.id], front.id, me);
    }
  }
}

function score(helper: Base, target: Base) {
  return helper.troops / (1 + Math.hypot(helper.x - target.x, helper.z - target.z));
}

/** Smaller = closer to enemies. */
function frontness(sim: Sim, b: Base, me: number) {
  let d = Infinity;
  for (const o of sim.bases) if (o.owner !== me && o.owner !== NEUTRAL) d = Math.min(d, Math.hypot(o.x - b.x, o.z - b.z));
  return d;
}
