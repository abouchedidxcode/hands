# GODHAND — design doc

> You are a god. Your hand hovers over a living war table. **Pinch** your castles,
> **drag** to a target, **let go** and your army marches. **Clench a fist** to charge
> lightning, **open your hand** to smite. **Swipe** your palm to swat enemy armies off
> the map. Two hands = two fronts at once.

One webcam. Two hands. No keyboard, no mouse (mouse only as an automatic fallback
when there is no camera, and for automated tests).

## Pillars

1. **Hands are the only controller.** Every screen, menu and option is reachable with
   pinch / hover / dwell. One click is required (browser rule: camera + audio unlock).
2. **Always moving.** Rounds are 60–180 s. Armies regenerate constantly; there is always
   a decision to make. Two hands means you can attack on two fronts.
3. **Physical & juicy.** Your giant translucent hand casts a shadow on the battlefield.
   Smites shake the screen. Swatted soldiers fly off the table.
4. **Shareable.** Webcam picture-in-picture (with neon skeleton) is rendered *into* the
   game canvas, so screen recordings / the built-in clip recorder show you + the game.

## Core rules (Galcon / State.io family)

- Map: procedural island, 10–22 **bases** placed by Poisson-disc sampling.
- Base types:
  - `village` — cap 40, growth 1.0/s
  - `castle`  — cap 80, growth 1.6/s, bigger
  - `tower`   — cap 30, growth 0.6/s, shoots arrows at enemy units within range
- Each base has a `faction`: 0 = player (cyan), 1..3 = AI warlords, -1 = neutral (no growth).
- **Send**: pinch on one of your bases → drag (glowing arrow) → (optionally sweep over more of
  your bases to add them) → release over any other base. Each selected base sends **50%** of
  its garrison as individual soldiers that stream out in formation and march in a straight line.
- Units of hostile factions that touch in the field annihilate 1:1 (sparks).
- Arriving units: same faction → reinforce (cap does not limit reinforcement but growth stops
  above cap); else garrison -= 1 per unit; when garrison < 0 the base flips to the attacker.
- Win: no enemy bases and no enemy units. Lose: you have no bases and no units.

### God powers (player only), fuelled by **Mana** (0–100, +3/s, +12 per capture)

| Power | Gesture | Cost | Effect |
|---|---|---|---|
| **Smite** | make a fist and hold ≥0.35 s (charges), then open the hand | 35 | lightning at the hand position, radius 3.2: kills every enemy unit inside, −12 garrison on enemy/neutral base inside, big shake |
| **Swat** | open palm moving fast (> 1.6 screen-widths/s) | 1 per unit hit | enemy units under the palm get flung off the table (die) |

## Hand → game mapping

- Webcam image is **mirrored** (selfie view). Normalized hand coords are remapped so the
  central ~70% of the camera frame covers the whole screen (no reaching for edges).
- **Cursor point** = midpoint of thumb tip (4) and index tip (8) — what you see is where you pinch.
- **Pinch** uses hysteresis on (thumb–index tip distance / palm size): on < 0.28, off > 0.42.
- **Fist** = all four fingertips closer to the wrist than their PIP joints.
- **Open** = ≥ 4 fingers extended.
- A short grace period (~120 ms) keeps a pinch alive through single dropped frames.
- Each detected hand gets a stable slot (0 or 1) by nearest-position matching.

## Menus with hands

All UI buttons are **HandButtons**: hover with the cursor → a ring fills over 0.9 s (dwell),
or pinch while hovering → instant. Big, round, spaced ≥ 120 px apart.
Hiding both hands for 1.5 s during a match → pause overlay ("show your hand to resume",
plus a big "Quit" HandButton).

## Module map & interfaces (contract between modules)

```
src/main.ts               bootstrap, main loop, screen state machine
src/config.ts             tunables + palette
src/input/types.ts        HandState / InputFrame (SHARED CONTRACT, see below)
src/input/*               webcam + MediaPipe + gestures + mouse fallback + synthetic injection
src/game/*                pure simulation (no three.js imports!), mapgen, AI, levels
src/render/*              three.js scene, terrain, bases, units, fx, hand visual
src/ui/*                  DOM overlay HUD + hand buttons + screens
src/audio/*               procedural WebAudio sfx + adaptive music (no audio files)
```

### Input contract (`src/input/types.ts`)

```ts
export type Gesture = 'none' | 'open' | 'pinch' | 'fist' | 'point';
export interface Landmark { x: number; y: number; z: number } // x,y in 0..1 *screen space* (already mirrored + remapped), z relative depth
export interface HandState {
  slot: 0 | 1;
  present: boolean;
  handedness: 'Left' | 'Right';   // as the USER sees it (mirrored)
  x: number; y: number;           // cursor in 0..1 screen space (smoothed)
  vx: number; vy: number;         // cursor velocity, screen units / s
  pinch: boolean; pinchStart: boolean; pinchEnd: boolean;
  pinchStrength: number;          // 0..1 (1 = touching)
  fist: boolean; open: boolean;
  gesture: Gesture;
  landmarks: Landmark[];          // 21 points, same space as x,y; [] when not present
  palmSize: number;               // wrist→middle-MCP distance in screen units (≈ how close to camera)
  lastSeen: number;               // performance.now() ms
}
export interface InputFrame { hands: [HandState, HandState]; source: 'camera' | 'mouse' | 'synthetic'; trackingFps: number }
```

`InputManager` (src/input/inputManager.ts):
```ts
class InputManager {
  constructor(opts: { video: HTMLVideoElement })
  startCamera(): Promise<boolean>      // false if denied / unavailable → mouse fallback auto-enabled
  update(now: number): InputFrame      // call once per animation frame
  enableMouse(canvas: HTMLElement): void
  inject(frame: Partial<HandState>[] | null): void   // synthetic hands for tests (window.__godhand)
  readonly video: HTMLVideoElement; readonly status: 'idle'|'loading'|'running'|'denied'|'error'
}
```
Mouse fallback: left button = pinch, right button held = fist (release = smite), shift+move fast = swat.

### Audio contract (`src/audio/audio.ts`)
```ts
export type Sfx = 'hover'|'tick'|'confirm'|'pinch'|'release'|'cancel'|'launch'|'clash'|'hit'|'capture'|'lost'
  |'smite'|'swat'|'arrow'|'denied'|'manaFull'|'countdown'|'go'|'victory'|'defeat';
export const audio: {
  unlock(): Promise<void>;                                  // call inside a click handler
  play(s: Sfx, o?: { volume?: number; pitch?: number; pan?: number }): void; // pan -1..1
  setCharge(level: number): void;                           // 0..1 smite charge hum (0 = silent)
  startMusic(): void; stopMusic(): void;
  setIntensity(x: number): void;                            // 0..1 drives music layers
  setMasterVolume(v: number): void;
}
```

### Terrain contract (`src/render/terrain.ts`)
```ts
export interface TerrainSpec { seed: number; width: number; depth: number; bases: { x: number; z: number; r: number }[] }
export interface Terrain { group: THREE.Group; heightAt(x: number, z: number): number; update(dt: number, t: number): void; dispose(): void }
export function buildTerrain(spec: TerrainSpec): Terrain;
```
World: X right, Z toward the camera (down the screen), Y up. Playable rect is centred on the
origin: x ∈ [−width/2, width/2], z ∈ [−depth/2, depth/2]. Ground ≈ y 0 inside the rect.

### FX contract (`src/render/fx.ts`)
```ts
export class Fx {
  constructor(scene: THREE.Scene)
  update(dt: number): void
  sparks(p: THREE.Vector3, color: THREE.ColorRepresentation, n?: number): void
  burst(p: THREE.Vector3, color: THREE.ColorRepresentation, scale?: number): void // capture
  smite(p: THREE.Vector3, radius: number): void   // lightning + flash + ring + debris
  shockwave(p: THREE.Vector3, color: THREE.ColorRepresentation, radius: number): void
  arrow(from: THREE.Vector3, to: THREE.Vector3): void   // tower arrow tracer
  fling(p: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation): void // swatted soldier ragdoll
  charge(p: THREE.Vector3 | null, level: number): void  // crackling orb around fist; null hides
}
```

## Palette

| role | hex |
|---|---|
| player | `#33e1ff` |
| warlord 1 (Crimson) | `#ff3d5a` |
| warlord 2 (Amber) | `#ffb22e` |
| warlord 3 (Violet) | `#b46bff` |
| neutral | `#b8b0a2` |
| sea | `#0e3b52` → `#1d6f8a` shallows |
| sand / grass / rock | `#e6cf8e` / `#6fae4f`,`#4f8a3b` / `#8d8a83` |

Style: stylised low-poly, flat shading, warm key light + cool fill, soft shadows, bloom on
emissive things (unit glow, hand, lightning, UI rings). Camera: perspective, ~58° tilt,
looking at the board centre, slowly breathing.
