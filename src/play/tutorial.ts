import { MANA, PLAYER } from '../config';
import type { Sim } from '../game/sim';
import type { Hud } from '../ui/hud';
import type { Commander } from './commander';

export interface TutorialCounters {
  pinchedOwn: number;
  sent: number;
  multiSent: number;
  captured: number;
  smites: number;
  swatKills: number;
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
  counters: TutorialCounters = { pinchedOwn: 0, sent: 0, multiSent: 0, captured: 0, smites: 0, swatKills: 0 };
  private i = 0;
  private hold = 0;
  private steps: Step[] = [
    { icon: '✋', title: 'RAISE YOUR HAND', sub: 'Your hand becomes a giant god-hand over the island', done: (_c, _s, hp) => hp },
    {
      icon: '🤏', title: 'PINCH YOUR CASTLE', sub: 'Touch thumb & index finger together over the blue castle',
      enter: (_s, c) => { c.allowSmite = false; c.allowSwat = false; },
      done: (c) => c.pinchedOwn > 0,
    },
    { icon: '👉', title: 'DRAG TO A VILLAGE · LET GO', sub: 'Keep pinching, move over a grey village, then open your fingers', done: (c) => c.sent > 0 },
    { icon: '⚔️', title: 'CONQUER!', sub: 'Your army captures it when it outnumbers the defenders', done: (c) => c.captured > 0 },
    {
      icon: '〰️', title: 'SWEEP · SEND FROM TWO', sub: 'Pinch one of your bases, slide over another of yours, release on a target', done: (c) => c.multiSent > 0,
    },
    {
      icon: '✊', title: 'MAKE A FIST… THEN OPEN', sub: 'Hold a fist over the red castle to charge lightning — open your hand to SMITE',
      enter: (s, c) => { c.allowSmite = true; s.mana = Math.max(s.mana, MANA.max); },
      done: (c) => c.smites > 0, ai: true,
    },
    {
      icon: '🖐️', title: 'SWAT THEIR ARMY', sub: 'When red soldiers march, swipe your open palm fast across them',
      enter: (s, c) => { c.allowSwat = true; s.mana = Math.max(s.mana, 60); },
      done: (c) => c.swatKills > 0, ai: true,
    },
    { icon: '👑', title: 'NOW TAKE THE ISLAND', sub: 'Capture every red castle. Use both hands!', done: () => false, ai: true },
  ];

  get aiEnabled() { return this.steps[this.i].ai ?? false; }

  start(sim: Sim, c: Commander) {
    this.i = 0;
    this.hold = 0;
    this.counters = { pinchedOwn: 0, sent: 0, multiSent: 0, captured: 0, smites: 0, swatKills: 0 };
    this.steps[0].enter?.(sim, c);
  }

  update(dt: number, sim: Sim, c: Commander, hud: Hud, handPresent: boolean) {
    const s = this.steps[this.i];
    hud.setCoach(s.icon, s.title, s.sub);
    // swat step: skip if enemy has had no troops in the field for a long time
    if (this.i === 6) {
      this.hold += dt;
      if (this.hold > 25) this.advance(sim, c, hud);
    }
    if (s.done(this.counters, sim, handPresent)) this.advance(sim, c, hud);
    // keep neutrals near the player cheap during the guided part
    if (this.i <= 3) for (const b of sim.bases) if (b.owner !== PLAYER && b.owner !== -1) b.troops = Math.min(b.troops, 14);
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
