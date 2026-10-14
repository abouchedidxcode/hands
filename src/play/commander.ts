import * as THREE from 'three';
import { FACTION_COLORS, PLAYER } from '../config';
import type { Sim } from '../game/sim';
import type { Base } from '../game/types';
import type { HandState, InputFrame } from '../input/types';
import type { DragArrows } from '../render/arrows';
import type { Highlight } from '../render/bases';
import type { HandMode } from '../render/handViz';
import type { Stage } from '../render/scene';

/** How forgiving the targeting is (world units beyond a base's radius). */
const GRAB_PAD = 2.6;     // closing the fist picks up the nearest own base this close
const SWEEP_PAD = 1.5;    // while carrying, passing this close adds another own base
const DROP_PAD = 2.4;     // opening the hand drops on the nearest base this close
const HOVER_PAD = 1.8;
/** Hold the middle finger this long before the bolt falls (filters passing poses). */
const MIDDLE_HOLD = 0.16;

interface Ctl {
  dragging: boolean;
  sel: number[];
  hover: Base | null;
  target: Base | null;
  midT: number;
  fired: boolean;
  denied: boolean;
  mode: HandMode;
  /** Fist state last frame (grab edges). */
  fist: boolean;
  g: THREE.Vector3;
  hasG: boolean;
}

export interface CommanderEvents {
  grab(hand: number): void;
  select(hand: number, base: Base): void;
  send(hand: number, sources: number[], target: Base, count: number): void;
  cancel(hand: number): void;
  smite(hand: number, x: number, z: number, kills: number): void;
  denied(hand: number, reason: string): void;
  rally(ok: boolean): void;
}

const newCtl = (): Ctl => ({
  dragging: false, sel: [], hover: null, target: null, midT: 0, fired: false, denied: false,
  mode: 'idle', fist: false, g: new THREE.Vector3(), hasG: false,
});

/**
 * Turns hand gestures into battlefield commands:
 *  - close your fist near one of your bases to grab its army, sweep over more of your bases
 *    to add them, open your hand over a target to send them all;
 *  - raise your middle finger anywhere: lightning strikes under the fingertip;
 *  - clap both hands: rally.
 */
export class Commander {
  ctl: Ctl[] = [newCtl(), newCtl()];
  highlight: Highlight = { hover: new Set(), selected: new Set(), target: new Set() };
  /** Disable powers (tutorial gating). */
  allowSmite = true;
  allowSend = true;
  allowRally = true;
  /** Which faction these hands command (online guest = 1). */
  faction = PLAYER;
  private clapPrevD = -1;
  private clapSpeed = 0;
  private clapCooldown = 0;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private tip = new THREE.Vector3();

  constructor(private stage: Stage, private heightAt: (x: number, z: number) => number, private ev: CommanderEvents) {}

  get modes(): HandMode[] { return this.ctl.map((c) => c.mode); }
  /** 0..1 smite aim progress per hand (for the charge glow). */
  get charges(): number[] { return this.ctl.map((c) => (c.fired ? 1 : Math.min(1, c.midT / MIDDLE_HOLD))); }

  reset() {
    this.ctl = [newCtl(), newCtl()];
    this.highlight.hover.clear(); this.highlight.selected.clear(); this.highlight.target.clear();
  }

  update(frame: InputFrame, sim: Sim, dt: number, t: number, arrows: DragArrows) {
    this.highlight.hover.clear(); this.highlight.selected.clear(); this.highlight.target.clear();
    arrows.begin();
    frame.hands.forEach((h, i) => this.updateHand(i, h, sim, dt, t, arrows));
    arrows.end();
    this.detectClap(frame, sim, dt);
  }

  /** Nearest base (by edge distance) within `pad`, optionally only those passing `ok`. */
  private nearest(sim: Sim, x: number, z: number, pad: number, ok?: (b: Base) => boolean): Base | null {
    let best: Base | null = null, bd = Infinity;
    for (const b of sim.bases) {
      if (ok && !ok(b)) continue;
      const d = Math.hypot(b.x - x, b.z - z) - b.radius;
      if (d < pad && d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Two open hands slammed together → RALLY. */
  private detectClap(frame: InputFrame, sim: Sim, dt: number) {
    this.clapCooldown = Math.max(0, this.clapCooldown - dt);
    const [a, b] = frame.hands;
    if (!a.present || !b.present || a.landmarks.length !== 21 || b.landmarks.length !== 21 || sim.over) {
      this.clapPrevD = -1;
      this.clapSpeed = 0;
      return;
    }
    const pa = palmCentre(a), pb = palmCentre(b);
    const d = Math.hypot(pa.x - pb.x, (pa.y - pb.y) * 0.6);
    if (this.clapPrevD >= 0 && dt > 0) {
      const closing = (this.clapPrevD - d) / dt;
      // short memory of the fastest recent approach
      this.clapSpeed = Math.max(closing, this.clapSpeed - dt * 6);
    }
    this.clapPrevD = d;
    const busy = a.fist || b.fist || a.middle || b.middle || this.ctl.some((c) => c.dragging);
    if (!busy && this.allowRally && this.clapCooldown <= 0 && d < 0.17 && this.clapSpeed > 0.9) {
      this.clapCooldown = 1.2;
      this.clapSpeed = 0;
      this.ev.rally(sim.rally(this.faction));
    }
  }

  private updateHand(i: number, h: HandState, sim: Sim, dt: number, t: number, arrows: DragArrows) {
    const c = this.ctl[i];
    const me = this.faction;
    const grab = h.present && h.fist;
    const grabStart = grab && !c.fist;
    c.fist = grab;
    c.hasG = h.present && !!this.stage.screenToGround(h.x, h.y, 0.25, c.g);
    if (!h.present || !c.hasG) {
      if (c.dragging && c.sel.length) this.ev.cancel(i);
      c.dragging = false; c.sel = []; c.midT = 0; c.fired = false; c.denied = false; c.mode = 'idle';
      c.hover = null; c.target = null;
      return;
    }
    if (sim.over) { c.mode = 'hover'; c.dragging = false; c.sel = []; c.midT = 0; return; }

    // ---------------------------------------------------------------- smite: middle finger
    if (h.middle && this.allowSmite && !c.dragging) {
      c.midT += dt;
      c.mode = 'armed';
      // aim = the ground under the middle fingertip
      const L = h.landmarks;
      const aim = L.length === 21 ? this.stage.screenToGround(L[12].x, L[12].y, 0.25, this.tip) : null;
      const p = aim ?? c.g;
      if (!c.fired && c.midT >= MIDDLE_HOLD) {
        c.fired = true;
        if (!sim.canSmite(me)) {
          if (!c.denied) { c.denied = true; this.ev.denied(i, 'mana'); }
        } else {
          const kills = sim.smite(p.x, p.z, me);
          if (kills >= 0) this.ev.smite(i, p.x, p.z, kills);
        }
      }
      c.hover = null;
      return;
    }
    c.midT = 0; c.fired = false; c.denied = false;

    // ---------------------------------------------------------------- grab → carry → open to send
    if (grabStart && this.allowSend) {
      c.dragging = true;
      c.sel = [];
      this.ev.grab(i);
      const first = this.nearest(sim, c.g.x, c.g.z, GRAB_PAD, (b) => b.owner === me);
      if (first) { c.sel.push(first.id); this.ev.select(i, first); }
    }

    if (c.dragging && grab) {
      const pass = this.nearest(sim, c.g.x, c.g.z, SWEEP_PAD, (b) => b.owner === me);
      if (pass && !c.sel.includes(pass.id)) { c.sel.push(pass.id); this.ev.select(i, pass); }
      // where would the army go if the hand opened now?
      const drop = this.nearest(sim, c.g.x, c.g.z, DROP_PAD);
      const sources = c.sel.filter((id) => id !== drop?.id);
      c.target = drop && sources.length ? drop : null;
      c.hover = c.target;
      for (const id of c.sel) this.highlight.selected.add(id);
      if (c.target) this.highlight.target.add(c.target.id);
      const col = FACTION_COLORS[me];
      for (const id of sources) {
        const b = sim.bases[id];
        this.from.set(b.x, this.heightAt(b.x, b.z) + 0.6, b.z);
        if (c.target) this.to.set(c.target.x, this.heightAt(c.target.x, c.target.z) + 0.5, c.target.z);
        else this.to.set(c.g.x, this.heightAt(c.g.x, c.g.z) + 0.3, c.g.z);
        arrows.arc(this.from, this.to, col, t, !!c.target);
      }
      c.mode = 'pinch';
      return;
    }

    if (c.dragging) {
      // hand opened (or the grab was lost): release on the snapped target
      const drop = this.nearest(sim, c.g.x, c.g.z, DROP_PAD);
      const sources = c.sel.filter((id) => id !== drop?.id);
      if (drop && sources.length) {
        const n = sim.send(sources, drop.id, me);
        if (n > 0) this.ev.send(i, sources, drop, n);
        else this.ev.cancel(i);
      } else if (c.sel.length) this.ev.cancel(i);
      c.dragging = false;
      c.sel = [];
      c.target = null;
    }

    // ---------------------------------------------------------------- hover
    c.hover = this.nearest(sim, c.g.x, c.g.z, HOVER_PAD, (b) => b.owner === me);
    if (c.hover) this.highlight.hover.add(c.hover.id);
    c.mode = 'hover';
  }
}

function palmCentre(h: HandState) {
  const L = h.landmarks;
  return { x: (L[0].x + L[5].x + L[9].x + L[17].x) / 4, y: (L[0].y + L[5].y + L[9].y + L[17].y) / 4 };
}
