import { it } from 'vitest';
import { LEVELS } from '../src/game/levels';
import { SKILLS, runMatch } from './balanceBot';

it('trace', () => {
  const lvl = LEVELS[Number(process.env.L ?? 2) - 1];
  const sk = SKILLS[(process.env.SK ?? 'novice') as 'novice'];
  const out: string[] = [];
  let next = 0;
  const r = runMatch(lvl, sk, Number(process.env.SEED ?? 1), {
    trace: (sim) => {
      for (const e of sim.events) {
        if (e.type === 'launch' && (process.env.V || e.faction === 0)) out.push(`  ${sim.time.toFixed(1)} f${e.faction} send ${e.count} ${e.from}->${e.to}(${sim.bases[e.to].type[0]} o${sim.bases[e.to].owner} t${sim.bases[e.to].troops.toFixed(0)})`);
        if (e.type === 'capture') out.push(`  ${sim.time.toFixed(1)} CAPTURE ${e.base} ${e.from}->${e.to}`);
        if (e.type === 'smite') out.push(`  ${sim.time.toFixed(1)} SMITE kills=${e.kills}`);
      }
      if (sim.time >= next) {
        next += 10;
        const s = sim.strength().map((x) => x.toFixed(0));
        const nb = new Array(sim.factions).fill(0); for (const b of sim.bases) if (b.owner >= 0) nb[b.owner]++;
        out.push(`t=${sim.time.toFixed(0)} str=${s.join('/')} bases=${nb.join('/')} mana=${sim.mana.toFixed(0)}`);
      }
    },
  });
  console.log(out.join('\n') + `\nRESULT win=${r.win} t=${r.time.toFixed(0)}`);
});
