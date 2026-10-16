import type * as THREE from 'three';
import type { GestureEvent, HandResult } from '../gesture';
import type { Fx } from './fx';

/** One legend row: the gesture and what it does in this mode. */
export interface ActionDef { id: string; emoji: string; gesture: string; effect: string }

/** A tracked hand as the shell sees it (modes keep their own per-hand state keyed by `id`). */
export interface SandboxHand {
  /** Gesture-engine hand id; −1 is the mouse. */
  id: number;
  /** Ground point under the hand along the camera ray through the palm. */
  cursor: THREE.Vector3;
  /** Smoothed ground velocity of `cursor` (world units / s). */
  vel: THREE.Vector3;
  /** Latest gesture-engine result (null for the mouse). */
  result: HandResult | null;
}

export interface CamRig { yaw: number; yawTo: number; zoom: number; zoomTo: number; shake: number }

/** What the shell offers a mode. */
export interface Ctx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  fx: Fx;
  cam: CamRig;
  hands: Map<number, SandboxHand>;
  /** Light up a legend row, count it and show a toast (default text: the row's effect). */
  act(id: string, text?: string): void;
  toast(text: string): void;
  /** Full-screen colour flash (explosions, sonic booms). */
  flash(color?: string, strength?: number): void;
  /** Camera-image coords (mirrored, 0..1) → view coords (0..1 of the screen). */
  toView(p: { x: number; y: number }): { x: number; y: number };
  viewToGround(v: { x: number; y: number }, out?: THREE.Vector3): THREE.Vector3;
  /** Ray from the camera through a view point. */
  viewRay(v: { x: number; y: number }, out: THREE.Ray): THREE.Ray;
  /** A screen direction (x right, y down) as a ground direction under the current camera. */
  screenDirToGround(dx: number, dy: number): THREE.Vector3;
  mouseView(): { x: number; y: number };
  /** Mode-owned DOM: a HUD strip under the top bar and a centred overlay (results cards). */
  hud: HTMLElement;
  overlay: HTMLElement;
}

export interface Mode {
  id: 'playground' | 'city';
  title: string;
  legendTitle: string;
  actions: readonly ActionDef[];
  /** Draw the 2D skeleton, ground ring and pose tag for each hand (the city draws giant 3D hands instead). */
  overlayHands: boolean;
  /** Height of the plane a hand is aimed in (tests aim synthetic hands at world points with it). */
  aimHeight: number;
  enter(ctx: Ctx): void;
  exit(): void;
  /** Pose / motion / two-hand events (camera zoom & orbit are handled by the shell). */
  onEvent(e: GestureEvent, h: SandboxHand | undefined, t: number): void;
  onHandGone(h: SandboxHand): void;
  /** Physics, continuous effects, held poses. `t` is the gesture clock (ms). */
  update(dt: number, t: number): void;
  mouseDown(h: SandboxHand): void;
  mouseUp(h: SandboxHand): void;
  keys: Record<string, () => void>;
  /** What a hand is carrying (tests / debug). */
  heldKind(handId: number): string | null;
  debug(): Record<string, unknown>;
}
