# ✋ GODHAND

**Command armies with your bare hands.** A webcam hand-tracked, real-time war game built with
three.js and MediaPipe. No mouse. No keyboard. Just your hands.

- 🤏 **Pinch** one of your castles, **drag** to a target, **let go** — half its army marches.
- 〰️ **Sweep** over several of your castles while pinching to launch a combined assault.
- ✊ ➜ 🖐️ **Hold a fist** to charge lightning, **open your hand** to SMITE everything below.
- 🖐️💨 **Swipe** an open palm fast across enemy soldiers to swat them off the island.
- 🙌 Both hands work independently — fight on two fronts at once.

Everything is procedural: islands, castles, soldiers, effects, music and sound effects are all
generated in code. The only downloaded assets are the MediaPipe hand-tracking model + wasm runtime
(bundled in `public/`).

## Play

```bash
npm install
npm run dev        # open the printed URL (https or localhost needed for the webcam)
```

Click **SUMMON YOUR HANDS** once (browsers require one click to allow the camera and audio).
After that everything — menus included — is driven by your hands: hover a round button until its
ring fills, or pinch it.

Tips: good lighting, sit back ~60 cm, keep your whole hand in view. Drop both hands out of view
to pause.

No webcam? The game falls back to the mouse: left-drag = pinch, hold right button = fist
(release to smite), shift + flick = swat.

## Gesture Lab & gesture engine

`src/gesture/` is a standalone gesture engine for hand-controlled games: 20 poses, 16 one-hand motions
and 5 two-hand gestures, with events, continuous values and tunable thresholds. It doesn't depend on
the game. **Gesture Lab** (`lab.html`, live at https://abouchedidxcode.github.io/hands/lab.html) shows
every gesture live, runs reliability/intuitiveness tests and tunes the engine. See
[`src/gesture/README.md`](src/gesture/README.md).

## Build / deploy

```bash
npm run build      # static site in dist/ (relative paths, host anywhere)
npm test           # simulation + gesture unit tests
```

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on push (enable Pages →
"GitHub Actions" in the repo settings if it isn't already).

## Code map

See [DESIGN.md](DESIGN.md) for the full design and module contracts.

| folder | what |
|---|---|
| `src/input` | webcam + MediaPipe Hand Landmarker, gesture recognition (pinch hysteresis, fist, open, One-Euro smoothing), mouse fallback, synthetic hands for tests |
| `src/game` | pure simulation: procedural maps, units, combat, towers, god powers, AI warlords, levels |
| `src/play` | hand gestures → commands (pinch-drag-release, sweep, smite, swat), tutorial |
| `src/render` | three.js stage + bloom, procedural island & water, castles, instanced soldiers, VFX, the floating god-hand |
| `src/ui` | hand-operated buttons, HUD, screens, webcam picture-in-picture |
| `src/audio` | procedural WebAudio SFX and adaptive war-drum music |
