/**
 * Balance harness. Quick smoke always runs; the full table (12 levels × 3 skills × N seeds) runs with
 *   BALANCE=1 [N=12] npx vitest run tests/balance.test.ts --silent=false
 */
import { describe, expect, it } from 'vitest';
import { LEVELS, skirmish } from '../src/game/levels';
import { generateMap } from '../src/game/mapgen';
import { SKILLS, evaluate, runMatch } from './balanceBot';

describe('balance smoke', () => {
  it('novice beats the tutorial, matches end, skilled beats L2', () => {
    for (const s of [1, 2, 3]) {
      const r = runMatch(LEVELS[0], SKILLS.novice, s);
      expect(r.win).toBe(true);
      expect(r.time).toBeLessThan(240);
    }
    expect(runMatch(LEVELS[1], SKILLS.skilled, 1).win).toBe(true);
  });

  it('player start is never trapped: >= 2 neutrals within 10 units of the capital', () => {
    const maps = [...LEVELS.map((l) => l.map), ...[1, 2, 3, 77, 1234, 9999].map((s) => skirmish(s).map)];
    for (const m of maps) {
      const bases = generateMap(m);
      const cap = bases[0];
      const near = bases.filter((b) => b.owner === -1 && Math.hypot(b.x - cap.x, b.z - cap.z) < 10);
      expect(near.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe.skipIf(!process.env.BALANCE)('balance table (BALANCE=1)', () => {
  it('win rates & durations per level and skill', () => {
    const N = Number(process.env.N ?? 10);
    const seeds = Array.from({ length: N }, (_, i) => i + 1);
    const rows: string[] = [];
    for (const lvl of LEVELS) {
      const cells = (['novice', 'average', 'skilled'] as const).map((k) => {
        const s = evaluate(lvl, SKILLS[k], seeds);
        return `${k}: ${(s.win * 100).toFixed(0).padStart(3)}% ${s.avgT.toFixed(0).padStart(3)}s stall ${(s.stall * 100).toFixed(0)}%`;
      });
      rows.push(`L${String(lvl.id).padStart(2)} ${cells.join(' | ')}`);
    }
    console.log(rows.join('\n'));
  }, 600000);
});
