import './style.css';
import * as THREE from 'three';
import { BOARD, FACTION_NAMES, factionColor, MANA, PLAYER } from './config';
import { audio, audioStream } from './audio/audio';
import { ClipRecorder } from './record/recorder';
import { Warlord } from './game/ai';
import { LEVELS, skirmish, type Level } from './game/levels';
import { generateMap } from './game/mapgen';
import { Sim } from './game/sim';
import type { GameEvent } from './game/types';
import { InputManager } from './input/inputManager';
import type { InputFrame } from './input/types';
import { Commander } from './play/commander';
import { Tutorial } from './play/tutorial';
import { DragArrows } from './render/arrows';
import { BaseViews } from './render/bases';
import { Fx } from './render/fx';
import { HandViz } from './render/handViz';
import { Stage } from './render/scene';
import { buildTerrain, type Terrain } from './render/terrain';
import { UnitViews } from './render/units';
import { HandButtons } from './ui/handButtons';
import { Hud } from './ui/hud';
import { loadProgress, saveProgress } from './ui/progress';
import { screens } from './ui/screens';
import { drawPip } from './ui/pip';

type State = 'boot' | 'loading' | 'raise' | 'nocam' | 'menu' | 'levels' | 'howto' | 'countdown' | 'play' | 'pause' | 'results';

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $('game') as HTMLCanvasElement;
const screenEl = $('screen');
const pipEl = $('pip');
const pipCanvas = $('pipSkel') as HTMLCanvasElement;
const pipStatus = $('pipStatus');
const video = $('cam') as HTMLVideoElement;

// ------------------------------------------------------------------ systems
const stage = new Stage(canvas);
const input = new InputManager({ video });
const buttons = new HandButtons(screenEl, $('cursors'));
const hud = new Hud($('hud'), $('toasts'), $('coach'));
const fx = new Fx(stage.scene);
const arrows = new DragArrows();
const handViz = new HandViz();
stage.scene.add(arrows.group, handViz.group);
buttons.onHover = () => audio.play('hover', { volume: 0.6 });
buttons.onFire = () => audio.play('confirm');

let progress = loadProgress();
let terrain: Terrain | null = null;
let heightAt = (_x: number, _z: number) => 0.25;
const ground = (x: number, z: number) => heightAt(x, z);
const baseViews = new BaseViews(ground);
const unitViews = new UnitViews(ground);
stage.scene.add(baseViews.group, unitViews.group);

const tutorial = new Tutorial();
const recorder = new ClipRecorder();
const commander = new Commander(stage, ground, {
  pinch: () => audio.play('pinch'),
  select: (_i, b) => {
    audio.play('tick', { pitch: 1 + commander.ctl.reduce((n, c) => n + c.sel.length, 0) * 0.08 });
    if (b.owner === PLAYER) tutorial.counters.pinchedOwn++;
  },
  send: (_i, sources, target, n) => {
    audio.play('release', { pan: pan(target.x) });
    tutorial.counters.sent++;
    if (sources.length >= 2) {
      tutorial.counters.multiSent++;
      hud.toast(`×${sources.length} COMBINED`, factionColor(PLAYER), true, 'combo', 0.3);
    }
    void n;
  },
  cancel: () => audio.play('cancel', { volume: 0.6 }),
  armed: () => audio.play('manaFull', { volume: 0.7 }),
  smite: (_i, x, z, kills) => {
    tutorial.counters.smites++;
    const p = new THREE.Vector3(x, heightAt(x, z), z);
    fx.smite(p, MANA.smiteRadius);
    audio.play('smite', { pan: pan(x) });
    audio.setCharge(0);
    stage.shake(1.0);
    stage.flash(0.16);
    recorder.banner(kills > 0 ? `SMITE ×${kills}` : 'SMITE', '#fff3a8');
    if (kills >= 12) hud.toast(`SMITE ×${kills}`, '#fff3a8', false, 'smite', 0.2);
    else if (kills > 0) hud.toast(`×${kills}`, '#fff3a8', true, 'smite', 0.2);
  },
  denied: () => { audio.play('denied'); hud.toast('NOT ENOUGH MANA', '#9fb4ff', true, 'mana', 2); },
  swat: (_i, x, _z, kills) => {
    tutorial.counters.swatKills += kills;
    audio.play('swat', { pan: pan(x) });
    stage.shake(0.25);
    if (kills >= 3) recorder.banner(`SWAT ×${kills}`, '#ffffff');
    if (kills >= 6) hud.toast(`SWAT ×${kills}`, '#ffffff', true, 'swat', 0.4);
  },
});

// ------------------------------------------------------------------ world
interface World { level: Level; sim: Sim; ais: Warlord[]; attract: boolean }
let world: World | null = null;
let state: State = 'boot';
let stateT = 0;
let timeScale = 1;
let endTimer = -1;
let noHandT = 0;
let countdownStep = 0;
let currentLevel: Level = LEVELS[0];

function pan(x: number) { return Math.max(-1, Math.min(1, x / (BOARD.width / 2))); }

function loadWorld(level: Level, attract: boolean) {
  const bases = generateMap(level.map);
  terrain?.dispose();
  if (terrain) stage.scene.remove(terrain.group);
  terrain = buildTerrain({ seed: level.map.seed, width: BOARD.width, depth: BOARD.depth, bases: bases.map((b) => ({ x: b.x, z: b.z, r: b.radius })) });
  stage.scene.add(terrain.group);
  heightAt = terrain.heightAt;
  baseViews.build(bases);
  const factions = level.map.enemies + 1;
  const sim = new Sim(bases, factions);
  sim.hasPlayer = !attract;
  const ais: Warlord[] = [];
  for (let f = attract ? 0 : 1; f < factions; f++) ais.push(new Warlord(f, attract ? { think: 1.1, aggro: 0.6, focusPlayer: 1 } : level.ai, level.map.seed));
  world = { level, sim, ais, attract };
  commander.reset();
  hud.setup(factions, level.tutorial ? 'TRAINING' : `${level.id < 100 ? 'LEVEL ' + level.id : 'SKIRMISH'} · ${level.name.toUpperCase()}`);
}

function attract() {
  if (world?.attract && !world.sim.over) return;
  loadWorld(skirmish(Math.floor(Math.random() * 100000)), true);
}

// ------------------------------------------------------------------ screens
function setState(s: State) {
  state = s;
  stateT = 0;
  buttons.hold(0.5);
  hud.clearToasts();
  const inGame = s === 'play' || s === 'countdown';
  hud.show(inGame || s === 'pause');
  buttons.showCursors = !inGame;
  pipEl.classList.toggle('hidden', s === 'boot' || s === 'loading' || s === 'nocam' || input.status !== 'running');
  pipEl.classList.toggle('big', s === 'raise');
  stage.zoom = s === 'menu' || s === 'levels' || s === 'howto' || s === 'boot' || s === 'raise' ? 1.04 : 1;
  if (s !== 'play') audio.setCharge(0);
  if (!inGame && s !== 'pause' && s !== 'results') hud.setCoach(null);
  audio.setIntensity(inGame ? 0.6 : s === 'pause' ? 0.2 : 0.05);

  switch (s) {
    case 'boot':
      screenEl.innerHTML = screens.boot();
      $('b-start').onclick = () => start();
      break;
    case 'loading': screenEl.innerHTML = screens.loading('SUMMONING…'); break;
    case 'raise': screenEl.innerHTML = screens.raise(); break;
    case 'nocam':
      screenEl.innerHTML = screens.noCamera(input.status === 'denied' ? 'Camera permission was denied.' : 'No camera could be started.');
      $('b-retrycam').onclick = () => start();
      $('b-mouse').onclick = () => { input.enableMouse(canvas); setState('menu'); };
      break;
    case 'menu':
      attract();
      screenEl.innerHTML = screens.menu(progress);
      $('b-play').onclick = () => startLevel(LEVELS[Math.min(progress.unlocked, LEVELS.length) - 1]);
      $('b-levels').onclick = () => setState('levels');
      $('b-howto').onclick = () => setState('howto');
      break;
    case 'levels':
      attract();
      screenEl.innerHTML = screens.levels(progress);
      screenEl.querySelectorAll<HTMLElement>('[data-level]').forEach((el) => {
        el.onclick = () => {
          const id = Number(el.dataset.level);
          if (id <= progress.unlocked) startLevel(LEVELS[id - 1]);
          else audio.play('denied');
        };
      });
      $('b-back').onclick = () => setState('menu');
      $('b-skirmish').onclick = () => startLevel(skirmish(Math.floor(Math.random() * 100000)));
      break;
    case 'howto':
      attract();
      screenEl.innerHTML = screens.howto();
      $('b-back').onclick = () => setState('menu');
      $('b-tutorial').onclick = () => startLevel(LEVELS[0]);
      break;
    case 'countdown':
      screenEl.innerHTML = '';
      countdownStep = 0;
      break;
    case 'play':
      screenEl.innerHTML = '';
      break;
    case 'pause':
      screenEl.innerHTML = screens.pause();
      buttons.hold(1.0);
      $('b-resume').onclick = () => setState('play');
      $('b-quit').onclick = () => { tutorial.stop(hud); recorder.stop(true); setState('menu'); };
      break;
    case 'results': {
      const sim = world!.sim;
      const win = sim.winner === PLAYER;
      const lvl = currentLevel;
      let stars = 0;
      if (win) {
        stars = sim.time <= lvl.par * 0.7 ? 3 : sim.time <= lvl.par ? 2 : 1;
        if (lvl.id < 100) {
          progress.stars[lvl.id] = Math.max(progress.stars[lvl.id] ?? 0, stars);
          progress.unlocked = Math.max(progress.unlocked, Math.min(LEVELS.length, lvl.id + 1));
          if (lvl.tutorial) progress.tutorialDone = true;
          saveProgress(progress);
        }
      }
      const hasNext = lvl.id < LEVELS.length || lvl.id >= 100;
      screenEl.innerHTML = screens.results(win, lvl, sim.time, sim.stats, stars, hasNext);
      buttons.hold(1.2);
      $('b-menu').onclick = () => setState('menu');
      $('b-retry').onclick = () => startLevel(lvl.id >= 100 ? skirmish(lvl.map.seed) : lvl);
      const next = document.getElementById('b-next');
      if (next) next.onclick = () => startLevel(lvl.id >= 100 ? skirmish(Math.floor(Math.random() * 100000)) : LEVELS[lvl.id]);
      tutorial.stop(hud);
      recorder.stop();
      if (recorder.supported) {
        const row = screenEl.querySelector('.orbs');
        if (row) {
          row.insertAdjacentHTML('afterbegin', '<div class="hb small gold" data-hb id="b-clip"><div class="icon">🎬</div>CLIP<div class="sub">save video</div></div>');
          $('b-clip').onclick = () => {
            const name = `godhand-${lvl.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            const go = (tries: number) => {
              if (recorder.download(name)) hud.toast('CLIP SAVED', '#ffd166', true, 'clip', 0);
              else if (tries > 0) setTimeout(() => go(tries - 1), 300);
            };
            go(10);
          };
        }
      }
      break;
    }
  }
}

function startLevel(level: Level) {
  currentLevel = level;
  loadWorld(level, false);
  endTimer = -1;
  timeScale = 1;
  recorder.start(level.tutorial ? 'Training' : level.id >= 100 ? 'Skirmish' : `Level ${level.id} · ${level.name}`, audioStream());
  if (level.tutorial) tutorial.start(world!.sim, commander);
  else { commander.allowSmite = commander.allowSwat = commander.allowSend = true; }
  setState('countdown');
}

async function start() {
  await audio.unlock();
  audio.startMusic();
  audio.setIntensity(0.05);
  setState('loading');
  const ok = await input.startCamera();
  if (!ok) { setState('nocam'); return; }
  setState('raise');
}

// ------------------------------------------------------------------ events → fx/audio/hud
const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
function at(x: number, z: number, lift = 0.3) { return v3.set(x, heightAt(x, z) + lift, z); }

function processEvents(events: GameEvent[], sim: Sim, isAttract: boolean) {
  const vol = isAttract ? 0.25 : 1;
  for (const e of events) {
    switch (e.type) {
      case 'launch': {
        const b = sim.bases[e.from];
        fx.dust(at(b.x, b.z, 0.1));
        if (e.faction === PLAYER && !isAttract) audio.play('launch', { pan: pan(b.x) });
        else audio.play('launch', { volume: 0.35 * vol, pan: pan(b.x) });
        break;
      }
      case 'clash':
        fx.sparks(at(e.x, e.z), mixColor(e.a, e.b), 6);
        audio.play('clash', { volume: 0.5 * vol, pan: pan(e.x) });
        break;
      case 'hit': {
        const b = sim.bases[e.base];
        fx.sparks(at(e.x, e.z, 0.4), factionColor(e.faction), 4);
        audio.play('hit', { volume: 0.5 * vol, pan: pan(b.x) });
        break;
      }
      case 'capture': {
        const b = sim.bases[e.base];
        fx.burst(at(b.x, b.z, 0.2), factionColor(e.to), b.type === 'castle' ? 1.4 : 1);
        baseViews.pop(b.id);
        if (isAttract) { audio.play('capture', { volume: 0.25 }); break; }
        if (e.to === PLAYER) {
          tutorial.counters.captured++;
          audio.play('capture', { pan: pan(b.x) });
          stage.shake(0.18);
          recorder.banner(e.from === -1 ? 'CAPTURED!' : 'STOLEN!', factionColor(PLAYER));
          hud.toast(e.from === -1 ? 'CAPTURED!' : `STOLEN FROM ${FACTION_NAMES[e.from].toUpperCase()}!`, factionColor(PLAYER), e.from === -1, 'cap', 0.5);
        } else if (e.from === PLAYER) {
          audio.play('lost', { pan: pan(b.x) });
          hud.toast(`${b.type.toUpperCase()} LOST`, factionColor(e.to), true, 'lost', 0.5);
        }
        break;
      }
      case 'arrow': {
        const b = sim.bases[e.base];
        v3b.set(b.x, heightAt(b.x, b.z) + 2.3, b.z);
        fx.arrow(v3b, at(e.tx, e.tz, 0.2).clone());
        audio.play('arrow', { volume: 0.5 * vol, pan: pan(b.x) });
        break;
      }
      case 'arrowKill':
        fx.sparks(at(e.x, e.z, 0.2), factionColor(e.faction), 3);
        break;
      case 'fling':
        fx.fling(at(e.x, e.z, 0.2), v3b.set(e.vx, 5 + Math.random() * 4, e.vz), factionColor(e.faction));
        break;
      case 'eliminated':
        if (!isAttract && e.faction !== PLAYER) {
          hud.toast(`${FACTION_NAMES[e.faction].toUpperCase()} ELIMINATED`, factionColor(e.faction), false, 'elim' + e.faction, 0);
          stage.shake(0.4);
        }
        break;
      case 'end':
        if (!isAttract) {
          endTimer = 2.2;
          timeScale = 0.35;
          audio.play(e.winner === PLAYER ? 'victory' : 'defeat');
          recorder.banner(e.winner === PLAYER ? 'VICTORY' : 'DEFEAT', e.winner === PLAYER ? '#ffe08a' : '#ff8095', true);
          hud.toast(e.winner === PLAYER ? 'VICTORY' : 'DEFEAT', e.winner === PLAYER ? '#ffe08a' : '#ff8095', false, 'end', 0);
        }
        break;
      default:
        break;
    }
  }
  events.length = 0;
}

function mixColor(a: number, b: number) {
  return new THREE.Color(factionColor(a)).lerp(new THREE.Color(factionColor(b)), 0.5).lerp(new THREE.Color('#ffffff'), 0.4);
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
let frame: InputFrame;
let frameCount = 0;

/** Advance the battle without rendering (debug / automated tests). */
function fastForward(seconds: number) {
  if (!world) return;
  const step = 1 / 30;
  for (let t = 0; t < seconds && !world.sim.over; t += step) {
    for (const a of world.ais) a.update(world.sim, step);
    world.sim.step(step);
    processEvents(world.sim.events, world.sim, world.attract);
  }
}

function tick(now: number) {
  requestAnimationFrame(tick);
  frameCount++;
  const rawDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stateT += rawDt;
  frame = input.update(now);
  const anyHand = frame.hands[0].present || frame.hands[1].present;

  // UI buttons are live on every non-game screen
  if (state !== 'play' && state !== 'countdown') buttons.update(frame, rawDt);
  else buttons.update({ ...frame, hands: [{ ...frame.hands[0], present: false }, { ...frame.hands[1], present: false }] as InputFrame['hands'] }, rawDt);

  switch (state) {
    case 'raise':
      if (anyHand) noHandT += rawDt; else noHandT = 0;
      if (noHandT > 0.6) {
        noHandT = 0;
        if (!progress.tutorialDone) startLevel(LEVELS[0]);
        else setState('menu');
      }
      break;
    case 'countdown': {
      const steps = ['3', '2', '1', 'GO!'];
      if (stateT > countdownStep * 0.7 && countdownStep < steps.length) {
        if (countdownStep === 0) hud.toast(currentLevel.name.toUpperCase(), '#ffffff', false, 'lvl', 0);
        hud.countdown(steps[countdownStep], countdownStep === 3 ? factionColor(PLAYER) : '#ffffff');
        audio.play(countdownStep === 3 ? 'go' : 'countdown');
        countdownStep++;
      }
      if (stateT > 2.6) setState('play');
      break;
    }
    case 'play':
      if (frame.source === 'camera' && !anyHand && endTimer < 0) {
        noHandT += rawDt;
        if (noHandT > 1.6) { noHandT = 0; setState('pause'); }
      } else noHandT = 0;
      break;
    case 'results':
    case 'menu':
    case 'levels':
    case 'howto':
      break;
  }

  // simulation
  const dt = rawDt * timeScale;
  if (world) {
    const { sim, ais } = world;
    const running = world.attract ? state !== 'play' : state === 'play';
    if (running) {
      if (state === 'play') {
        commander.update(frame, sim, rawDt, stage.t, arrows);
        if (currentLevel.tutorial && !sim.over) tutorial.update(rawDt, sim, commander, hud, anyHand);
      } else {
        arrows.begin(); arrows.end();
      }
      const aiOn = !world.attract && currentLevel.tutorial ? tutorial.aiEnabled : true;
      if (aiOn) for (const a of ais) a.update(sim, dt);
      sim.step(dt);
      processEvents(sim.events, sim, world.attract);
      if (world.attract && sim.over) attract();
    } else {
      arrows.begin(); arrows.end();
    }
    if (state === 'play' || state === 'pause' || state === 'countdown') {
      hud.update(sim.strength(), sim.time, sim.mana, true);
      // music intensity follows the battle
      const s = sim.strength();
      const total = s.reduce((a, b) => a + b, 0) || 1;
      audio.setIntensity(state === 'play' ? 0.55 + Math.min(0.45, sim.units.length / 300) : 0.3);
      void total;
    }
    if (state === 'play') {
      const ch = commander.charges;
      const charge = Math.max(ch[0], ch[1]);
      audio.setCharge(charge > 0 ? charge : 0);
      for (let i = 0; i < 2; i++) {
        const m = commander.modes[i];
        if (m === 'charge' || m === 'armed') fx.charge(handViz.palm(i, v3), ch[i]);
      }
      if (!commander.modes.some((m) => m === 'charge' || m === 'armed')) fx.charge(null, 0);
    } else fx.charge(null, 0);

    if (endTimer > 0) {
      endTimer -= rawDt;
      timeScale = Math.min(1, timeScale + rawDt * 0.2);
      if (endTimer <= 0) { endTimer = -1; timeScale = 1; setState('results'); }
    }
    baseViews.update(rawDt, stage.t, sim.time, state === 'play' ? commander.highlight : { hover: new Set(), selected: new Set(), target: new Set() });
    unitViews.update(sim.units, stage.t);
  }

  terrain?.update(rawDt, stage.t);
  fx.update(dt);
  const showHands = state !== 'boot' && state !== 'loading' && state !== 'nocam';
  handViz.update(
    showHands ? frame.hands : frame.hands.map((h) => ({ ...h, present: false })),
    stage, rawDt, stage.t,
    state === 'play' ? commander.modes : ['hover', 'hover'],
    state === 'play' ? commander.charges : [0, 0],
    ground,
  );
  stage.render(rawDt);
  if (recorder.recording && world) {
    recorder.setBars(world.sim.strength().map((_, f) => factionColor(f)), world.sim.strength());
    recorder.capture(canvas, input.status === 'running' ? video : null, frame);
  }

  if (!pipEl.classList.contains('hidden')) {
    drawPip(pipCanvas, frame, input);
    pipStatus.textContent = frame.source === 'camera' ? `TRACKING ${Math.round(frame.trackingFps)} FPS` : frame.source.toUpperCase();
  }
}

// ------------------------------------------------------------------ boot
attract();
setState('boot');
requestAnimationFrame(tick);

// Debug / test hooks
declare global { interface Window { __godhand: unknown } }
window.__godhand = {
  input, stage, audio, recorder,
  get state() { return state; },
  get world() { return world; },
  get commander() { return commander; },
  setState: (s: State) => setState(s),
  startLevel: (id: number) => startLevel(id >= 100 ? skirmish(id) : LEVELS[id - 1]),
  skipCountdown: () => setState('play'),
  fastForward,
  get frameCount() { return frameCount; },
  progress: () => progress,
  resetProgress: () => { progress = { unlocked: 1, stars: {}, tutorialDone: false }; saveProgress(progress); },
  unlockAll: () => { progress.unlocked = LEVELS.length; progress.tutorialDone = true; saveProgress(progress); },
};
