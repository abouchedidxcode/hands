import * as THREE from 'three';
import { FACTION_COLORS, MANA, PLAYER } from '../config';
import type { Sim } from '../game/sim';
import type { Base } from '../game/types';
import type { HandState, InputFrame } from '../input/types';
import type { DragArrows } from '../render/arrows';
import type { Highlight } from '../render/bases';
import type { HandMode } from '../render/handViz';
import type { Stage } from '../render/scene';

interface Ctl {
  dragging: boolean;
  sel: number[];
  hover: Base | null;
  target: Base | null;
  chargeT: number;
  armed: boolean;
  denied: boolean;
  swatT: number;
  mode: HandMode;
  g: THREE.Vector3;
  gPrev: THREE.Vector3;
  hasG: boolean;
  hadG: boolean;
}

export interface CommanderEvents {
  pinch(hand: number): void;
  select(hand: number, base: Base): void;
  send(hand: number, sources: number[], target: Base, count: number): void;
  cancel(hand: number): void;
  armed(hand: number): void;
  smite(hand: number, x: number, z: number, kills: number): void;
  denied(hand: number, reason: string): void;
  swat(hand: number, x: number, z: number, kills: number): void;
  rally(ok: boolean): void;
}

const newCtl = (): Ctl => ({
  dragging: false, sel: [], hover: null, target: null, chargeT: 0, armed: false, denied: false,
  swatT: 0, mode: 'idle', g: new THREE.Vector3(), gPrev: new THREE.Vector3(), hasG: false, hadG: false,
});

/** Turns hand gestures into battlefield commands for the player. */
export class Commander {
  ctl: Ctl[] = [newCtl(), newCtl()];
  highlight: Highlight = { hover: new Set(), selected: new Set(), target: new Set() };
  /** Disable powers (tutorial gating). */
  allowSmite = true;
  allowSwat = true;
  allowSend = true;
  allowRally = true;
  private clapPrevD = -1;
  private clapSpeed = 0;
  private clapCooldown = 0;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();

  constructor(private stage: Stage, private heightAt: (x: number, z: number) => number, private ev: CommanderEvents) {}

  get modes(): HandMode[] { return this.ctl.map((c) => c.mode); }
  get charges(): number[] { return this.ctl.map((c) => Math.min(1, c.chargeT / MANA.smiteChargeTime)); }

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
    const busy = a.pinch || b.pinch || a.fist || b.fist || this.ctl.some((c) => c.dragging);
    if (!busy && this.allowRally && this.clapCooldown <= 0 && d < 0.17 && this.clapSpeed > 0.9) {
      this.clapCooldown = 1.2;
      this.clapSpeed = 0;
      this.ev.rally(sim.rally());
    }
  }

  private updateHand(i: number, h: HandState, sim: Sim, dt: number, t: number, arrows: DragArrows) {
    const c = this.ctl[i];
    c.hadG = c.hasG;
    c.gPrev.copy(c.g);
    c.hasG = h.present && !!this.stage.screenToGround(h.x, h.y, 0.25, c.g);
    if (!h.present || !c.hasG) {
      if (c.dragging && c.sel.length) this.ev.cancel(i);
      c.dragging = false; c.sel = []; c.chargeT = 0; c.armed = false; c.denied = false; c.mode = 'idle';
      c.hover = null; c.target = null;
      return;
    }
    if (sim.over) { c.mode = 'hover'; c.dragging = false; c.sel = []; return; }

    c.hover = sim.baseAt(c.g.x, c.g.z, 0.95);
    if (c.hover) this.highlight.hover.add(c.hover.id);

    // ---------------------------------------------------------------- smite (fist → open)
    if (h.fist && this.allowSmite) {
      if (c.dragging) { if (c.sel.length) this.ev.cancel(i); c.dragging = false; c.sel = []; }
      if (!sim.canSmite()) {
        if (!c.denied) { c.denied = true; this.ev.denied(i, 'mana'); }
        c.chargeT = 0;
        c.mode = 'hover';
      } else {
        c.chargeT += dt;
        if (!c.armed && c.chargeT >= MANA.smiteChargeTime) { c.armed = true; this.ev.armed(i); }
        c.mode = c.armed ? 'armed' : 'charge';
      }
      return;
    }
    c.denied = false;
    if (c.armed) {
      // hand opened → unleash
      const kills = sim.smite(c.g.x, c.g.z);
      if (kills >= 0) this.ev.smite(i, c.g.x, c.g.z, kills);
      c.armed = false;
      c.chargeT = 0;
      c.mode = 'idle';
    }
    c.chargeT = 0;

    // ---------------------------------------------------------------- swat (fast open palm)
    c.swatT = Math.max(0, c.swatT - dt);
    const speed = Math.hypot(h.vx, h.vy * 0.6);
    if (this.allowSwat && h.open && !h.pinch && !c.dragging && speed > MANA.swatSpeed && c.hadG) {
      let kills = 0;
      const wv = this.to.subVectors(c.g, c.gPrev).multiplyScalar(1 / Math.max(dt, 1 / 120));
      for (let s = 0; s <= 3; s++) {
        this.from.lerpVectors(c.gPrev, c.g, s / 3);
        kills += sim.swat(this.from.x, this.from.z, MANA.swatRadius, wv.x, wv.z);
      }
      c.swatT = 0.25;
      if (kills > 0) this.ev.swat(i, c.g.x, c.g.z, kills);
    }

    // ---------------------------------------------------------------- pinch-drag-release
    if (h.pinchStart && this.allowSend) {
      c.dragging = true;
      c.sel = [];
      this.ev.pinch(i);
      if (c.hover && c.hover.owner === PLAYER) { c.sel.push(c.hover.id); this.ev.select(i, c.hover); }
    }
    if (c.dragging && h.pinch) {
      if (c.hover && c.hover.owner === PLAYER && !c.sel.includes(c.hover.id)) {
        c.sel.push(c.hover.id);
        this.ev.select(i, c.hover);
      }
      const sources = c.sel.filter((id) => id !== c.hover?.id);
      c.target = c.hover && sources.length ? c.hover : null;
      for (const id of c.sel) this.highlight.selected.add(id);
      if (c.target) this.highlight.target.add(c.target.id);
      // arcs
      const col = FACTION_COLORS[PLAYER];
      for (const id of sources) {
        const b = sim.bases[id];
        this.from.set(b.x, this.heightAt(b.x, b.z) + 0.6, b.z);
        if (c.target) this.to.set(c.target.x, this.heightAt(c.target.x, c.target.z) + 0.5, c.target.z);
        else this.to.set(c.g.x, this.heightAt(c.g.x, c.g.z) + 0.3, c.g.z);
        arrows.arc(this.from, this.to, col, t, !!c.target);
      }
      c.mode = 'pinch';
    } else if (c.dragging && (h.pinchEnd || !h.pinch)) {
      const sources = c.sel.filter((id) => id !== c.hover?.id);
      if (c.hover && sources.length) {
        const n = sim.send(sources, c.hover.id, PLAYER);
        if (n > 0) this.ev.send(i, sources, c.hover, n);
        else this.ev.cancel(i);
      } else if (c.sel.length) this.ev.cancel(i);
      c.dragging = false;
      c.sel = [];
      c.target = null;
      c.mode = 'hover';
    } else {
      c.mode = c.swatT > 0 ? 'swat' : 'hover';
    }
  }
}

function palmCentre(h: HandState) {
  const L = h.landmarks;
  return { x: (L[0].x + L[5].x + L[9].x + L[17].x) / 4, y: (L[0].y + L[5].y + L[9].y + L[17].y) / 4 };
}
