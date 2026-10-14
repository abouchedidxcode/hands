import { it } from 'vitest';
import { LEVELS } from '../src/game/levels';
import { SKILLS, evaluate } from './balanceBot';

const N = Number(process.env.N ?? 8);
const LV = (process.env.LV ?? '').split(',').filter(Boolean).map(Number);
it('dev balance table', () => {
  const t0 = performance.now();
  const seeds = Array.from({ length: N }, (_, i) => i + 1);
  const rows: string[] = [];
  for (const lvl of LEVELS) {
    if (LV.length && !LV.includes(lvl.id)) continue;
    const cells = (['novice', 'average', 'skilled'] as const).map((k) => {
      const s = evaluate(lvl, SKILLS[k], seeds);
      return `${k[0]}:${(s.win * 100).toFixed(0).padStart(3)}% ${s.avgT.toFixed(0).padStart(3)}s st${(s.stall * 100).toFixed(0)}`;
    });
    rows.push(`L${String(lvl.id).padStart(2)} ${cells.join(' | ')}`);
  }
  console.log(rows.join('\n') + `\n${((performance.now() - t0) / 1000).toFixed(1)}s`);
}, 600000);
