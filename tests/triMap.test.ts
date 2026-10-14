import { describe, expect, it } from 'vitest';
import { BOARD } from '../src/config';
import { generateTriMap } from '../src/game/mapgen';

describe('3-way online map', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`is fair and well formed (seed ${seed})`, () => {
      const bases = generateTriMap(seed);
      // three capitals, one per player
      expect(bases.slice(0, 3).map((b) => b.owner)).toEqual([0, 1, 2]);
      expect(bases.filter((b) => b.owner >= 0)).toHaveLength(3);
      expect(bases.length).toBeGreaterThanOrEqual(3 + 4 * 3);
      // ids are indices
      bases.forEach((b, i) => expect(b.id).toBe(i));
      // on the board, not overlapping
      for (const b of bases) {
        expect(Math.abs(b.x)).toBeLessThanOrEqual(BOARD.width / 2);
        expect(Math.abs(b.z)).toBeLessThanOrEqual(BOARD.depth / 2);
      }
      for (let i = 0; i < bases.length; i++) for (let j = i + 1; j < bases.length; j++) {
        expect(Math.hypot(bases[i].x - bases[j].x, bases[i].z - bases[j].z)).toBeGreaterThan(4.4);
      }
      // fairness: each capital sees the same sorted list of (distance, type, garrison) to the neutrals
      const view = (c: number) => bases.filter((b) => b.owner < 0)
        .map((b) => `${Math.hypot(b.x - bases[c].x, b.z - bases[c].z).toFixed(2)}|${b.type}|${b.troops}`).sort();
      expect(view(1)).toEqual(view(0));
      expect(view(2)).toEqual(view(0));
      // capitals are equidistant
      const d = (a: number, b: number) => Math.hypot(bases[a].x - bases[b].x, bases[a].z - bases[b].z);
      expect(d(0, 1)).toBeCloseTo(d(1, 2), 3);
      expect(d(0, 1)).toBeCloseTo(d(0, 2), 3);
    });
  }
});
