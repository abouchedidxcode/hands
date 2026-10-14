import type { AiParams } from './ai';
import type { MapSpec } from './mapgen';

export interface Level {
  id: number;
  name: string;
  subtitle: string;
  map: MapSpec;
  ai: AiParams;
  par: number;          // seconds for 3 stars
  tutorial?: boolean;
}

/**
 * Hand-tuned difficulty table (see tests/balance.test.ts, `BALANCE=1 npx vitest run tests/balance.test.ts`).
 * Targets with the human-like bot: L1 novice ~100 %, L2-3 novice mostly wins, mid levels
 * average player 60-75 %, L11-12 skilled ~50-60 %. Matches typically 60-150 s.
 */
interface Row {
  name: string; subtitle: string;
  enemies: number; bases: number; neutralMul: number; playerStart: number; enemyStart: number;
  think: number; aggro: number; focusPlayer: number; cunning: number; rageAt?: number; wake?: number;
  par: number;
}

const ROWS: Row[] = [
  { name: 'First Light', subtitle: 'Learn the gestures', enemies: 1, bases: 11, neutralMul: 0.8, playerStart: 40, enemyStart: 14, think: 5.0, aggro: 0, focusPlayer: 0.8, cunning: 0.1, wake: 2, par: 120 },
  { name: 'The Crimson Coast', subtitle: 'One warlord. Take the island.', enemies: 1, bases: 11, neutralMul: 0.9, playerStart: 40, enemyStart: 22, think: 3.6, aggro: 0.05, focusPlayer: 0.9, cunning: 0.15, wake: 2, par: 90 },
  { name: 'Twin Banners', subtitle: 'Crimson & Amber want your crown', enemies: 2, bases: 14, neutralMul: 0.9, playerStart: 40, enemyStart: 24, think: 3.4, aggro: 0.1, focusPlayer: 0.9, cunning: 0.2, wake: 1.5, par: 110 },
  { name: 'Tower Hills', subtitle: 'Archers guard the valleys', enemies: 2, bases: 14, neutralMul: 1.0, playerStart: 40, enemyStart: 30, think: 2.6, aggro: 0.2, focusPlayer: 1.0, cunning: 0.3, par: 115 },
  { name: 'The Long March', subtitle: 'A wide island. Keep up.', enemies: 2, bases: 15, neutralMul: 1.0, playerStart: 40, enemyStart: 34, think: 2.2, aggro: 0.3, focusPlayer: 1.0, cunning: 0.4, par: 120 },
  { name: 'Three Kings', subtitle: 'Every warlord awakens', enemies: 3, bases: 17, neutralMul: 1.05, playerStart: 40, enemyStart: 36, think: 2.0, aggro: 0.35, focusPlayer: 1.05, cunning: 0.45, par: 130 },
  { name: 'Stormfront', subtitle: 'They think faster now', enemies: 3, bases: 18, neutralMul: 1.1, playerStart: 40, enemyStart: 38, think: 1.5, aggro: 0.45, focusPlayer: 1.1, cunning: 0.55, par: 130 },
  { name: 'Shattered Isles', subtitle: 'Many prizes, little time', enemies: 3, bases: 22, neutralMul: 1.1, playerStart: 40, enemyStart: 40, think: 1.35, aggro: 0.5, focusPlayer: 1.1, cunning: 0.6, par: 140 },
  { name: 'The Violet Pact', subtitle: 'They hunt you first', enemies: 3, bases: 19, neutralMul: 1.15, playerStart: 40, enemyStart: 42, think: 1.25, aggro: 0.55, focusPlayer: 2.0, cunning: 0.65, par: 140 },
  { name: 'Iron Rain', subtitle: 'Fortified neutrals', enemies: 3, bases: 19, neutralMul: 1.8, playerStart: 40, enemyStart: 44, think: 1.1, aggro: 0.65, focusPlayer: 1.2, cunning: 0.75, par: 150 },
  { name: 'Last Stand', subtitle: 'Outnumbered three to one', enemies: 3, bases: 20, neutralMul: 1.2, playerStart: 30, enemyStart: 50, think: 0.95, aggro: 0.8, focusPlayer: 1.3, cunning: 0.85, par: 150 },
  { name: 'Godhand', subtitle: 'Prove you are a god', enemies: 3, bases: 20, neutralMul: 1.25, playerStart: 40, enemyStart: 50, think: 0.8, aggro: 1, focusPlayer: 1.3, cunning: 1, par: 160 },
];

export const LEVELS: Level[] = ROWS.map((r, i) => {
  const id = i + 1;
  return {
    id, name: r.name, subtitle: r.subtitle,
    tutorial: id === 1,
    par: r.par,
    map: {
      seed: 1000 + id * 17,
      enemies: r.enemies,
      bases: r.bases,
      neutralMul: r.neutralMul,
      playerStart: r.playerStart,
      enemyStart: r.enemyStart,
    },
    ai: {
      think: r.think, aggro: r.aggro, focusPlayer: r.focusPlayer, cunning: r.cunning,
      ...(r.rageAt !== undefined ? { rageAt: r.rageAt } : {}),
      ...(r.wake !== undefined ? { wake: r.wake } : {}),
    },
  };
});

/** Random skirmish for endless play (mid difficulty). */
export function skirmish(seed: number): Level {
  const enemies = 1 + (seed % 3);
  return {
    id: 100 + (seed % 1000), name: 'Skirmish', subtitle: `Seed ${seed}`, par: 150,
    map: { seed, enemies, bases: 10 + enemies * 3, neutralMul: 1, playerStart: 40, enemyStart: 36 },
    ai: { think: 1.6, aggro: 0.45, focusPlayer: 1.05, cunning: 0.5 },
  };
}
