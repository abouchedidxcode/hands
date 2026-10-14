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

const NAMES: [string, string][] = [
  ['First Light', 'Learn the gestures'],
  ['The Crimson Coast', 'One warlord. Take the island.'],
  ['Twin Banners', 'Crimson & Amber want your crown'],
  ['Tower Hills', 'Archers guard the valleys'],
  ['The Long March', 'A wide island. Keep up.'],
  ['Three Kings', 'Every warlord awakens'],
  ['Stormfront', 'They think faster now'],
  ['Shattered Isles', 'Many prizes, little time'],
  ['The Violet Pact', 'They hunt you first'],
  ['Iron Rain', 'Fortified neutrals'],
  ['Last Stand', 'Outnumbered three to one'],
  ['Godhand', 'Prove you are a god'],
];

export const LEVELS: Level[] = NAMES.map(([name, subtitle], i) => {
  const id = i + 1;
  const enemies = id === 1 ? 1 : id === 2 ? 1 : id <= 4 ? 2 : id === 5 ? 2 : 3;
  const think = id === 1 ? 4.2 : Math.max(0.75, 2.6 - i * 0.17);
  return {
    id, name, subtitle,
    tutorial: id === 1,
    par: 70 + enemies * 25 + i * 4,
    map: {
      seed: 1000 + id * 17,
      enemies,
      bases: Math.min(22, 9 + enemies * 2 + Math.floor(i / 2) + (id === 8 ? 4 : 0)),
      neutralMul: id === 10 ? 1.8 : 0.85 + i * 0.05,
      playerStart: id === 11 ? 30 : 40,
      enemyStart: id === 1 ? 14 : id === 11 ? 45 : 30 + i * 1.5,
    },
    ai: {
      think,
      aggro: Math.min(1, 0.1 + i * 0.08),
      focusPlayer: id === 9 ? 2.4 : 1 + i * 0.05,
    },
  };
});

/** Random skirmish for endless play. */
export function skirmish(seed: number): Level {
  const enemies = 1 + (seed % 3);
  return {
    id: 100 + (seed % 1000), name: 'Skirmish', subtitle: `Seed ${seed}`, par: 150,
    map: { seed, enemies, bases: 10 + enemies * 3, neutralMul: 1, playerStart: 40, enemyStart: 36 },
    ai: { think: 1.4, aggro: 0.6, focusPlayer: 1.2 },
  };
}
