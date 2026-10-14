import { it } from 'vitest';
import { generateMap } from '../src/game/mapgen';
import { LEVELS, skirmish } from '../src/game/levels';

it('map dump', () => {
  const specs = [...LEVELS.map((l) => ({ name: 'L' + l.id, map: l.map })), ...[1, 2, 3, 77, 1234].map((s) => ({ name: 'S' + s, map: skirmish(s).map }))];
  for (const { name, map } of specs) {
    const bases = generateMap(map);
    const F = map.enemies + 1;
    const lines: string[] = [];
    for (let f = 0; f < F; f++) {
      const c = bases[f];
      const near = bases.filter((b) => b.owner === -1).map((b) => ({ b, d: Math.hypot(b.x - c.x, b.z - c.z) })).sort((a, b) => a.d - b.d).slice(0, 4);
      // voronoi share
      let share = 0, val = 0;
      for (const b of bases) {
        if (b.owner !== -1) continue;
        let bf = -1, bd = 1e9;
        for (let g = 0; g < F; g++) { const d = Math.hypot(b.x - bases[g].x, b.z - bases[g].z); if (d < bd) { bd = d; bf = g; } }
        if (bf === f) { share++; val += b.cap; }
      }
      const enemyD = Math.min(...bases.slice(0, F).filter((_, g) => g !== f).map((o) => Math.hypot(o.x - c.x, o.z - c.z)));
      lines.push(`  f${f} (${c.x.toFixed(1)},${c.z.toFixed(1)}) t=${c.troops} vor=${share}/${val} nearestEnemy=${enemyD.toFixed(1)} near=` + near.map((n) => `${n.b.type[0]}${n.b.troops}@${n.d.toFixed(1)}`).join(' '));
    }
    console.log(`${name} bases=${bases.length} F=${F}\n` + lines.join('\n'));
  }
});
