import { it } from 'vitest';
import { LEVELS } from '../src/game/levels';
import { SKILLS, runMatch } from './balanceBot';

it('per-seed', () => {
  const lvl = LEVELS[Number(process.env.L ?? 6) - 1];
  const sk = SKILLS[(process.env.SK ?? 'average') as 'average'];
  const N = Number(process.env.N ?? 8);
  const out: string[] = [];
  for (let s = 1; s <= N; s++) { const r = runMatch(lvl, sk, s); out.push(`seed ${s}: win=${r.win} winner=${r.winner} t=${r.time.toFixed(0)} smites=${r.smites} rallies=${r.rallies}`); }
  console.log(out.join('\n'));
});
