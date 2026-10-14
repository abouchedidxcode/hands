// Global tunables + palette. Pure data, safe to import anywhere (incl. the sim).

export const PLAYER = 0;
export const NEUTRAL = -1;

// LIVING ATLAS inks: cerulean (you), vermilion, ochre, imperial purple
export const FACTION_COLORS = ['#1f9be8', '#d8352a', '#e8a317', '#8e3fc8'];
export const FACTION_NAMES = ['You', 'Crimson', 'Amber', 'Violet'];
export const NEUTRAL_COLOR = '#9a8c74';

export function factionColor(f: number): string {
  return f < 0 ? NEUTRAL_COLOR : FACTION_COLORS[f % FACTION_COLORS.length];
}

export type BaseType = 'village' | 'castle' | 'tower';

export interface BaseTypeDef {
  cap: number;
  growth: number;     // troops / second while below cap (owned only)
  radius: number;     // world units (footprint + arrival radius)
  value: number;      // AI desirability
  range?: number;     // towers only
  fireInterval?: number;
}

export const BASE_TYPES: Record<BaseType, BaseTypeDef> = {
  village: { cap: 40, growth: 1.0, radius: 0.95, value: 1.0 },
  castle: { cap: 80, growth: 1.6, radius: 1.3, value: 1.7 },
  tower: { cap: 30, growth: 0.6, radius: 0.85, value: 1.0, range: 4.6, fireInterval: 0.42 },
};

export const SIM = {
  unitSpeed: 3.3,          // world units / s
  sendFraction: 0.5,
  spawnRowInterval: 0.075, // s between formation rows
  rowWidth: 3,             // soldiers per row
  rowSpacing: 0.24,        // lateral spacing
  clashRadius: 0.34,       // units of hostile factions closer than this annihilate
  overflowDecay: 1.0,      // troops/s lost when above cap
  arrowFlight: 0.32,
};

export const MANA = {
  max: 100,
  regen: 3.2,
  perCapture: 12,
  perKill: 0.08,
  startMana: 25,           // enough to feel the bar, not enough for an opening smite
  smiteCost: 35,
  smiteRadius: 3.2,
  smiteBaseDamage: 12,
  smiteChargeTime: 0.35,
  swatCostPerUnit: 1,
  swatRadius: 1.25,
  swatSpeed: 1.6,          // screen widths / s
  rallyCost: 50,           // RALLY (clap both hands)
  rallyDuration: 6,        // seconds
  rallySpeed: 1.6,         // player unit speed multiplier while active
  rallyGrowth: 2.5,        // player base growth multiplier while active (still capped)
};

export const BOARD = { width: 44, depth: 26 };
