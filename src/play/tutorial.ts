import { MANA, PLAYER } from '../config';
import type { Sim } from '../game/sim';
import type { Hud } from '../ui/hud';
import type { Commander } from './commander';

export interface TutorialCounters {
  grabbedOwn: number;
  sent: number;
  multiSent: number;
  captured: number;
  smites: number;
  rallies: number;
}

interface Step {
  icon: string;
  title: string;
  sub: string;
  enter?(sim: Sim, c: Commander): void;
  done(c: TutorialCounters, sim: Sim, handPresent: boolean): boolean;
  ai?: boolean;
}

/** Learn-by-doing first level. Gates the AI and the powers until each gesture is performed. */
export class Tutorial {
  counters: TutorialCounters = { grabbedOwn: 0, sent: 0, multiSent: 0, captured: 0, smites: 0, rallies: 0 };
  private i = 0;
  private hold = 0;
  private steps: Step[] = [
    { icon: '✋', title: 'RAISE YOUR HAND', sub: 'Your hand becomes a giant god-hand over the island', done: (_c, _s, hp) => hp },
    {
      icon: '✊', title: 'GRAB YOUR CASTLE', sub: 'Hover your open hand over the blue castle, then close your fist',
      enter: (_s, c) => { c.allowSmite = false; c.allowRally = false; },
      done: (c) => c.grabbedOwn > 0,
    },
    { icon: '🖐️', title: 'CARRY IT · OPEN YOUR HAND', sub: 'Keep your fist closed, move over a grey village, then open your hand', done: (c) => c.sent > 0 },
    { icon: '⚔️', title: 'CONQUER!', sub: 'Your army captures it when it outnumbers the defenders', done: (c) => c.captured > 0 },
    {
      icon: '〰️', title: 'GRAB TWO AT ONCE', sub: 'Grab one of your bases, sweep your fist over another of yours, open over a target',
      done: (c) => c.multiSent > 0,
    },
    {
      icon: '🖕', title: 'MIDDLE FINGER = LIGHTNING', sub: 'Raise your middle finger over the red castle: lightning strikes under your fingertip',
      enter: (s, c) => { c.allowSmite = true; s.mana = Math.max(s.mana, MANA.max); },
      done: (c) => c.smites > 0, ai: true,
    },
    {
      icon: '👏', title: 'CLAP TO RALLY', sub: 'Clap both open hands together: your armies march faster and castles grow faster',
      enter: (s, c) => { c.allowRally = true; s.mana = Math.max(s.mana, 60); },
      done: (c) => c.rallies > 0, ai: true,
    },
    { icon: '👑', title: 'NOW TAKE THE ISLAND', sub: 'Capture every red castle. Use both hands!', done: () => false, ai: true },
  ];

  get aiEnabled() { return this.steps[this.i].ai ?? false; }

  start(sim: Sim, c: Commander) {
    this.i = 0;
    this.hold = 0;
    this.counters = { grabbedOwn: 0, sent: 0, multiSent: 0, captured: 0, smites: 0, rallies: 0 };
    this.steps[0].enter?.(sim, c);
  }

  update(dt: number, sim: Sim, c: Commander, hud: Hud, handPresent: boolean) {
    const s = this.steps[this.i];
    hud.setCoach(s.icon, s.title, s.sub);
    // optional steps (sweep / clap) auto-skip after a while so nobody gets stuck
    const skipAfter: Record<number, number> = { 4: 40, 6: 25 };
    let skip = false;
    if (skipAfter[this.i]) {
      this.hold += dt;
      skip = this.hold > skipAfter[this.i];
    }
    // at most one step per frame: advancing twice would skip the next step's enter() (e.g. never re-enable smite)
    if (skip || s.done(this.counters, sim, handPresent)) this.advance(sim, c, hud);
    // while the AI sleeps (guided part), keep the enemy capital out of reach but not overwhelming
    if (this.i <= 4) for (const b of sim.bases) if (b.owner !== PLAYER && b.owner !== -1) b.troops = Math.min(Math.max(b.troops, 22), 30);
  }

  private advance(sim: Sim, c: Commander, hud: Hud) {
    if (this.i >= this.steps.length - 1) return;
    this.i++;
    this.hold = 0;
    hud.toast('NICE!', '#9cf6ff', true, 'tut' + this.i, 0);
    this.steps[this.i].enter?.(sim, c);
  }

  stop(hud: Hud) { hud.setCoach(null); }
}
