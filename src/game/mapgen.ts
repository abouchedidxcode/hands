import { BASE_TYPES, BOARD, NEUTRAL, type BaseType } from '../config';
import { Rng } from './rng';
import type { Base } from './types';

export interface MapSpec {
  seed: number;
  enemies: number;      // 1..3
  bases: number;        // total base count target
  neutralMul: number;   // neutral garrison multiplier
  playerStart: number;
  enemyStart: number;
}

const MARGIN_X = 3.2;
const MARGIN_Z = 2.6;

export function makeBase(id: number, type: BaseType, x: number, z: number, owner: number, troops: number): Base {
  const def = BASE_TYPES[type];
  return {
    id, type, x, z, owner, troops,
    radius: def.radius, cap: def.cap, growth: def.growth,
    fireTimer: 0, lastHit: -10, captureTime: -10,
  };
}

/** Procedurally lays out a fair-ish map: faction capitals around an ellipse, neutrals by Poisson-disc. */
export function generateMap(spec: MapSpec): Base[] {
  const rng = new Rng(spec.seed * 7919 + 13);
  const hw = BOARD.width / 2 - MARGIN_X;
  const hd = BOARD.depth / 2 - MARGIN_Z;
  const factions = spec.enemies + 1;
  const bases: Base[] = [];

  // Capitals: player on the left, warlords spread around an ellipse.
  const rot = rng.range(-0.25, 0.25);
  for (let f = 0; f < factions; f++) {
    const a = Math.PI + rot + (f * Math.PI * 2) / factions;
    const x = Math.cos(a) * hw * 0.92 + rng.range(-0.8, 0.8);
    const z = Math.sin(a) * hd * 0.85 + rng.range(-0.8, 0.8);
    bases.push(makeBase(bases.length, 'castle', clamp(x, -hw, hw), clamp(z, -hd, hd), f, f === 0 ? spec.playerStart : spec.enemyStart));
  }

  // Poisson-disc fill.
  const minD = spec.bases > 16 ? 4.6 : 5.3;
  let tries = 0;
  while (bases.length < spec.bases && tries < 4000) {
    tries++;
    const x = rng.range(-hw, hw);
    const z = rng.range(-hd, hd);
    let ok = true;
    for (const b of bases) {
      const d = Math.hypot(b.x - x, b.z - z);
      const need = b.owner >= 0 ? minD + 0.9 : minD;
      if (d < need) { ok = false; break; }
    }
    if (!ok) continue;
    const r = rng.next();
    const type: BaseType = r < 0.56 ? 'village' : r < 0.8 ? 'tower' : 'castle';
    bases.push(makeBase(bases.length, type, x, z, NEUTRAL, 0));
  }

  // Neutral garrisons; the two closest neutrals to each capital are cheap villages (fair openings).
  const cheap = new Set<number>();
  for (let f = 0; f < factions; f++) {
    const cap = bases[f];
    const near = bases
      .filter((b) => b.owner === NEUTRAL && !cheap.has(b.id))
      .sort((a, b) => dist(a, cap) - dist(b, cap))
      .slice(0, 2);
    for (const b of near) {
      cheap.add(b.id);
      Object.assign(b, makeBase(b.id, 'village', b.x, b.z, NEUTRAL, 0));
    }
  }
  for (const b of bases) {
    if (b.owner !== NEUTRAL) continue;
    let g: number;
    if (cheap.has(b.id)) g = rng.int(4, 8);
    else if (b.type === 'village') g = rng.int(8, 16);
    else if (b.type === 'tower') g = rng.int(10, 18);
    else g = rng.int(18, 30);
    b.troops = Math.round(g * (cheap.has(b.id) ? 1 : spec.neutralMul));
  }
  return bases;
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
