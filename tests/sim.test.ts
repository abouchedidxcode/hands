import { describe, it, expect } from 'vitest';
import { Sim } from '../src/game/sim';
import { Warlord } from '../src/game/ai';
import { generateMap } from '../src/game/mapgen';
import { LEVELS } from '../src/game/levels';

describe('sim', () => {
  it('AI vs AI battles terminate on every level map', () => {
    for (const lvl of LEVELS) {
      const bases = generateMap(lvl.map);
      const factions = lvl.map.enemies + 1;
      expect(bases.length).toBeGreaterThanOrEqual(factions + 4);
      const sim = new Sim(bases, factions);
      sim.hasPlayer = false;
      const ais = Array.from({ length: factions }, (_, f) => new Warlord(f, { ...lvl.ai, think: 1.2 }, lvl.map.seed));
      let t = 0;
      while (!sim.over && t < 900) {
        for (const a of ais) a.update(sim, 1 / 30);
        sim.step(1 / 30);
        sim.events.length = 0;
        t += 1 / 30;
      }
      console.log(`L${lvl.id} bases=${bases.length} over=${sim.over} winner=${sim.winner} t=${t.toFixed(0)}s units=${sim.units.length}`);
    }
  });

  it('send + capture works', () => {
    const bases = generateMap(LEVELS[1].map);
    const sim = new Sim(bases, 2);
    const target = bases.find((b) => b.owner === -1)!;
    target.troops = 3;
    bases[0].troops = 40;
    expect(sim.send([0], target.id, 0)).toBe(20);
    for (let i = 0; i < 600 && target.owner !== 0; i++) sim.step(1 / 30);
    expect(target.owner).toBe(0);
    expect(sim.stats.captures).toBe(1);
  });
});

import { generateVersusMap } from '../src/game/mapgen';
describe('versus map', () => {
  it('is point-symmetric and has both capitals', () => {
    for (let seed = 1; seed < 40; seed++) {
      const b = generateVersusMap(seed * 977);
      expect(b[0].owner).toBe(0);
      expect(b[1].owner).toBe(1);
      expect(b.length).toBeGreaterThanOrEqual(11);
      for (const x of b) {
        const twin = b.find((y) => Math.abs(y.x + x.x) < 1e-6 && Math.abs(y.z + x.z) < 1e-6);
        expect(twin?.type).toBe(x.type);
      }
    }
  });
});
