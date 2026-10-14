import './style.css';
import * as THREE from 'three';
import { BOARD, FACTION_NAMES, factionColor, MANA, PLAYER } from './config';
import { audio, audioStream } from './audio/audio';
import { ClipRecorder } from './record/recorder';
import { Warlord } from './game/ai';
import { LEVELS, skirmish, versus, type Level } from './game/levels';
import { generateMap, generateVersusMap } from './game/mapgen';
import { Sim } from './game/sim';
import type { GameEvent, Stats } from './game/types';
import { GuestSim } from './net/guestSim';
import { Matchmaker, makeCode, type Match } from './net/matchmaker';
import { encodeSnapshot, filterEvents, type Command, type RemoteHand } from './net/protocol';
import { NetSession } from './net/session';
import { onlineScreens } from './ui/onlineScreens';
import type { HandState } from './input/types';
import { emptyHand } from './input/types';
import { InputManager } from './input/inputManager';
import type { InputFrame } from './input/types';
import { Commander } from './play/commander';
import { Tutorial } from './play/tutorial';
import { DragArrows } from './render/arrows';
import { atlas } from './render/atlas';
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

type State = 'boot' | 'loading' | 'raise' | 'nocam' | 'menu' | 'levels' | 'howto' | 'countdown' | 'play' | 'pause' | 'results'
  | 'online' | 'searching' | 'room';

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
/** The online opponent's hands, re-projected from their world positions. */
const oppViz = new HandViz([2, 3]);
stage.scene.add(arrows.group, handViz.group, oppViz.group);
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
  grab: () => audio.play('pinch'),
  select: (_i, b) => {
    audio.play('tick', { pitch: 1 + commander.ctl.reduce((n, c) => n + c.sel.length, 0) * 0.08 });
    if (b.owner === me) tutorial.counters.grabbedOwn++;
  },
  send: (_i, sources, target, n) => {
    audio.play('release', { pan: pan(target.x) });
    tutorial.counters.sent++;
    if (sources.length >= 2) {
      tutorial.counters.multiSent++;
      hud.toast(`×${sources.length} COMBINED`, factionColor(me), true, 'combo', 0.3);
    }
    void n;
  },
  cancel: () => audio.play('cancel', { volume: 0.6 }),
  smite: (_i, x, z, kills) => {
    tutorial.counters.smites++;
    const p = new THREE.Vector3(x, heightAt(x, z), z);
    fx.smite(p, MANA.smiteRadius);
    atlas.splat(x, z, MANA.smiteRadius * 0.9, 1.2, '#24160d', 16);
    audio.play('smite', { pan: pan(x) });
    audio.setCharge(0);
    stage.shake(1.0);
    stage.flash(0.09);
    recorder.banner(kills > 0 ? `SMITE ×${kills}` : 'SMITE', '#fff3a8');
    if (kills >= 12) hud.toast(`SMITE ×${kills}`, '#fff3a8', false, 'smite', 0.2);
    else if (kills > 0) hud.toast(`×${kills}`, '#fff3a8', true, 'smite', 0.2);
  },
  rally: (ok) => {
    if (!ok) { audio.play('denied'); hud.toast('RALLY NEEDS 50 MANA', '#9fb4ff', true, 'mana', 1.5); return; }
    tutorial.counters.rallies++;
    audio.play('go');
    audio.play('capture', { pitch: 0.75 });
    stage.shake(0.35);
    hud.toast('RALLY!', '#ffd166', false, 'rally', 0.5);
    recorder.banner('RALLY!', '#ffd166');
    if (world) for (const b of world.sim.bases) if (b.owner === me) fx.shockwave(at(b.x, b.z, 0.1).clone(), '#ffd166', 3.2);
  },
  denied: () => { audio.play('denied'); hud.toast('NOT ENOUGH MANA', '#9fb4ff', true, 'mana', 2); },
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
/** The faction the local hands command (online guest = 1). */
let me = PLAYER;
let net: NetSession | null = null;
let online: 'host' | 'guest' | null = null;
let snapTimer = 0;
let handTimer = 0;
let remoteHands: RemoteHand[] = [];
let remoteHandsAt = 0;
let endReason = '';
const rematch = { me: false, them: false };
const matchmaker = new Matchmaker((m) => onMatchFound(m));
const remoteHandStates: [HandState, HandState] = [emptyHand(0), emptyHand(1)];

function pan(x: number) { return Math.max(-1, Math.min(1, x / (BOARD.width / 2))); }

function loadWorld(level: Level, attract: boolean, mode: 'host' | 'guest' | null = null) {
  const bases = mode ? generateVersusMap(level.map.seed) : generateMap(level.map);
  terrain?.dispose();
  if (terrain) stage.scene.remove(terrain.group);
  terrain = buildTerrain({ seed: level.map.seed, width: BOARD.width, depth: BOARD.depth, bases: bases.map((b) => ({ x: b.x, z: b.z, r: b.radius })) });
  stage.scene.add(terrain.group);
  heightAt = terrain.heightAt;
  baseViews.build(bases);
  atlas.build(bases, level.map.seed);
  const factions = level.map.enemies + 1;
  const sim = mode === 'guest' ? new GuestSim(bases, factions, (c) => net?.sendCommand(c)) : new Sim(bases, factions);
  sim.hasPlayer = !attract;
  if (mode) sim.humans = [0, 1];
  const ais: Warlord[] = [];
  if (!mode) for (let f = attract ? 0 : 1; f < factions; f++) ais.push(new Warlord(f, attract ? { think: 1.1, aggro: 0.6, focusPlayer: 1 } : level.ai, level.map.seed));
  world = { level, sim, ais, attract };
  commander.reset();
  commander.faction = me;
  hud.setup(factions, mode ? `ONLINE DUEL · YOU ARE ${me === 0 ? 'BLUE' : 'RED'}` : level.tutorial ? 'TRAINING' : `${level.id < 100 ? 'LEVEL ' + level.id : 'SKIRMISH'} · ${level.name.toUpperCase()}`, me, mode ? ['Rival', 'Rival'] : undefined);
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
  stage.zoom = s === 'menu' || s === 'levels' || s === 'howto' || s === 'boot' || s === 'raise' || s === 'online' || s === 'searching' || s === 'room' ? 0.9 : 0.93;
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
      {
        const row = screenEl.querySelector('.orbs');
        row?.insertAdjacentHTML('beforeend', '<div class="hb gold" data-hb id="b-online"><div class="icon">🌍</div>ONLINE<div class="sub">1v1 duel</div></div>');
        $('b-online').onclick = () => setState('online');
      }
      break;
    case 'online':
      attract();
      screenEl.innerHTML = onlineScreens.lobby();
      $('b-back').onclick = () => setState('menu');
      $('b-quick').onclick = () => { matchmaker.quick(); setState('searching'); };
      $('b-room').onclick = () => {
        const code = makeCode();
        matchmaker.privateRoom(code);
        roomCode = code;
        setState('room');
      };
      break;
    case 'searching':
      screenEl.innerHTML = onlineScreens.searching('FINDING AN OPPONENT');
      setTimeout(() => {
        const tag = screenEl.querySelector('.tagline');
        if (state === 'searching' && matchmaker.status === 'searching' && tag) tag.textContent = 'Few gods online right now. Keep waiting, or cancel and send a friend a private link.';
      }, 25000);
      $('b-cancel').onclick = () => { matchmaker.cancel(); setState('online'); };
      break;
    case 'room': {
      const link = `${location.origin}${location.pathname}?vs=${roomCode}`;
      screenEl.innerHTML = onlineScreens.room(roomCode, link);
      $('b-cancel').onclick = () => { matchmaker.cancel(); setState('online'); };
      $('b-copy').onclick = () => {
        navigator.clipboard?.writeText(link).then(() => hud.toast('LINK COPIED', '#ffd166', true, 'copy', 0)).catch(() => ($('room-link') as HTMLInputElement).select());
      };
      break;
    }
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
      $('b-quit').onclick = () => { tutorial.stop(hud); recorder.stop(true); if (online) leaveOnline(); else setState('menu'); };
      if (online) { const h = screenEl.querySelector('.tagline'); if (h) h.textContent = 'The duel goes on without you! Show your hand to fight, or forfeit.'; }
      break;
    case 'results': {
      if (online) { showOnlineResults(); break; }
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
  tutorial.stop(hud);
  currentLevel = level;
  loadWorld(level, false);
  endTimer = -1;
  timeScale = 1;
  recorder.start(level.tutorial ? 'Training' : level.id >= 100 ? 'Skirmish' : `Level ${level.id} · ${level.name}`, audioStream());
  if (level.tutorial) tutorial.start(world!.sim, commander);
  else { commander.allowSmite = commander.allowSend = commander.allowRally = true; }
  setState('countdown');
  stage.snapZoom(0.55);
}

let roomCode = '';

// ------------------------------------------------------------------ online duel
function onMatchFound(m: Match) {
  net?.close();
  net = new NetSession(m);
  online = m.host ? 'host' : 'guest';
  me = m.host ? 0 : 1;
  screenEl.innerHTML = onlineScreens.searching('OPPONENT FOUND · CONNECTING');
  $('b-cancel').onclick = () => leaveOnline();
  net.onStart = (seed) => startOnline(seed);
  net.onCommand = (c) => applyRemoteCommand(c);
  net.onSnapshot = (snap) => {
    if (world?.sim instanceof GuestSim) { world.sim.latency = Math.min(0.25, (net?.rtt ?? 100) / 2000); world.sim.apply(snap); }
  };
  net.onEvents = (evs) => { if (world && !world.attract) world.sim.events.push(...evs); };
  net.onHand = (h) => { remoteHands = h; remoteHandsAt = performance.now(); };
  net.onRematch = () => {
    rematch.them = true;
    if (!rematch.me) hud.toast('OPPONENT WANTS A REMATCH', '#ffd166', true, 'rmw', 0);
    maybeRematch();
  };
  net.channel.on('stats', (d) => {
    const st = d as { s: Stats[] };
    if (world && online === 'guest') { world.sim.statsOf[0] = st.s[0]; world.sim.statsOf[1] = st.s[1]; }
    if (state === 'results') setState('results');
  });
  net.onLeft = () => {
    hud.toast('OPPONENT LEFT', '#ff8095', false, 'left', 0);
    if (state === 'play' || state === 'countdown') {
      // don't overwrite a result that was already decided (e.g. the winner closed the tab at VICTORY)
      if (world && !world.sim.over) { world.sim.over = true; world.sim.winner = me; endReason = 'opponent left'; }
      if (endTimer < 0) endTimer = 0.8;
    } else if (state === 'results') {
      const b = document.getElementById('b-rematch');
      b?.classList.add('locked');
    } else leaveOnline();
  };
}

function startOnline(seed: number) {
  if (!net) return;
  rematch.me = rematch.them = false;
  endReason = '';
  currentLevel = versus(seed);
  loadWorld(currentLevel, false, online);
  endTimer = -1;
  timeScale = 1;
  commander.allowSmite = commander.allowSend = commander.allowRally = true;
  recorder.start('Online duel', audioStream());
  setState('countdown');
  stage.snapZoom(0.55);
}

function applyRemoteCommand(c: Command) {
  if (!world || online !== 'host' || state !== 'play') return;
  const sim = world.sim;
  const opp = 1;
  switch (c.k) {
    case 'send': sim.send(c.from, c.to, opp); break;
    case 'smite': sim.smite(c.x, c.z, opp); break;
    case 'rally': sim.rally(opp); break;
  }
}

function maybeRematch() {
  if (!net || !rematch.me || !rematch.them) return;
  net.rematch();
}

function leaveOnline() {
  matchmaker.cancel();
  net?.close();
  net = null;
  online = null;
  me = PLAYER;
  commander.faction = PLAYER;
  remoteHands = [];
  recorder.stop(true);
  setState('menu');
}

function showOnlineResults() {
  const sim = world!.sim;
  const win = sim.winner === me;
  screenEl.innerHTML = onlineScreens.results(win, sim.time, sim.statsOf[me], sim.statsOf[1 - me] ?? null, endReason);
  if (rematch.me) $('b-rematch').classList.add('locked');
  buttons.hold(1.2);
  recorder.stop();
  $('b-menu').onclick = () => leaveOnline();
  $('b-rematch').onclick = () => {
    if (!net?.connected) return;
    rematch.me = true;
    net.wantRematch();
    $('b-rematch').classList.add('locked');
    hud.toast(rematch.them ? 'REMATCH!' : 'WAITING FOR OPPONENT…', '#ffffff', true, 'rm', 0);
    maybeRematch();
  };
}

/** Convert local hands to world points for the opponent. */
function encodeHands(frame: InputFrame): RemoteHand[] {
  const out: RemoteHand[] = [];
  for (const h of frame.hands) {
    if (!h.present || h.landmarks.length !== 21) { out.push({ p: false, g: 0, pts: [] }); continue; }
    const pts: number[] = [];
    for (const l of h.landmarks) {
      // clamp like HandViz does, so rays always meet the ground (no stray far points)
      const g = stage.screenToGround(Math.min(1.15, Math.max(-0.15, l.x)), Math.min(1.15, Math.max(-0.15, l.y)), 0.25, v3);
      pts.push(g ? Math.round(g.x * 50) / 50 : 0, g ? Math.round(g.z * 50) / 50 : 0, Math.round(l.z * 1000) / 1000);
    }
    const c = stage.screenToGround(h.x, h.y, 0.25, v3);
    pts.push(c ? Math.round(c.x * 50) / 50 : 0, c ? Math.round(c.z * 50) / 50 : 0);
    out.push({ p: true, g: h.grab ? 1 : h.middle ? 2 : h.open ? 3 : 0, pts });
  }
  return out;
}

/** Re-project the opponent's world-space hands into our screen space for HandViz. */
function decodeHands(): [HandState, HandState] {
  const stale = performance.now() - remoteHandsAt > 600;
  for (let i = 0; i < 2; i++) {
    const r = remoteHands[i], h = remoteHandStates[i];
    if (stale || !r || !r.p || r.pts.length < 65) { h.present = false; h.landmarks = []; continue; }
    const lm = [];
    for (let k = 0; k < 21; k++) {
      const sp = stage.worldToScreen(v3.set(r.pts[k * 3], 0.25, r.pts[k * 3 + 1]));
      lm.push({ x: sp.x, y: sp.y, z: r.pts[k * 3 + 2] });
    }
    const c = stage.worldToScreen(v3.set(r.pts[63], 0.25, r.pts[64]));
    h.present = true;
    h.landmarks = lm;
    h.x = c.x; h.y = c.y;
    h.grab = r.g === 1; h.middle = r.g === 2; h.open = r.g === 3;
  }
  return remoteHandStates;
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
        if (e.faction === me && !isAttract) audio.play('launch', { pan: pan(b.x) });
        else audio.play('launch', { volume: 0.35 * vol, pan: pan(b.x) });
        break;
      }
      case 'clash':
        fx.sparks(at(e.x, e.z), mixColor(e.a, e.b), 6);
        if (Math.random() < 0.35) atlas.splat(e.x, e.z, 0.32, 0.5, '#3a2416', 2);
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
        atlas.splat(b.x, b.z, b.radius * 2.4, 0.55, factionColor(e.to), 14);
        if (isAttract) { audio.play('capture', { volume: 0.25 }); break; }
        if (e.to === me) {
          tutorial.counters.captured++;
          audio.play('capture', { pan: pan(b.x) });
          stage.shake(0.18);
          recorder.banner(e.from === -1 ? 'CAPTURED!' : 'STOLEN!', factionColor(me));
          hud.toast(e.from === -1 ? 'CAPTURED!' : `STOLEN FROM ${online ? 'THEM' : FACTION_NAMES[e.from].toUpperCase()}!`, factionColor(me), e.from === -1, 'cap', 0.5);
        } else if (e.from === me) {
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
      case 'smite':
        if ((e.faction ?? PLAYER) !== me && !isAttract) {
          fx.smite(at(e.x, e.z, 0).clone(), e.radius);
          audio.play('smite', { pan: pan(e.x), volume: 0.8 });
          stage.shake(0.6);
          hud.toast('ENEMY SMITE!', '#ff8095', true, 'esmite', 0.5);
        }
        break;
      case 'rally':
        if ((e.faction ?? PLAYER) !== me && !isAttract) {
          audio.play('go', { volume: 0.7 });
          hud.toast('ENEMY RALLY!', '#ff8095', true, 'erally', 0.5);
          for (const b of sim.bases) if (b.owner === e.faction) fx.shockwave(at(b.x, b.z, 0.1).clone(), factionColor(b.owner), 3);
        }
        break;
      case 'fling':
        fx.fling(at(e.x, e.z, 0.2), v3b.set(e.vx, 5 + Math.random() * 4, e.vz), factionColor(e.faction));
        break;
      case 'eliminated':
        if (!isAttract && e.faction !== me && !online) {
          hud.toast(`${FACTION_NAMES[e.faction].toUpperCase()} ELIMINATED`, factionColor(e.faction), false, 'elim' + e.faction, 0);
          stage.shake(0.4);
        }
        break;
      case 'end':
        if (!isAttract) {
          endTimer = 2.2;
          timeScale = 0.35;
          const won = e.winner === me;
          audio.play(won ? 'victory' : 'defeat');
          recorder.banner(won ? 'VICTORY' : 'DEFEAT', won ? '#ffe08a' : '#ff8095', true);
          hud.toast(won ? 'VICTORY' : 'DEFEAT', won ? '#ffe08a' : '#ff8095', false, 'end', 0);
          if (online === 'host') net?.channel.send('stats', { s: sim.statsOf }, net.peer);
          if (online === 'guest') { sim.over = true; sim.winner = e.winner; }
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
/** ?norender skips WebGL drawing (automated netcode tests on software GL). */
const NO_RENDER = new URLSearchParams(location.search).has('norender');
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
        const vs = new URLSearchParams(location.search).get('vs');
        if (vs) { roomCode = vs.toUpperCase(); matchmaker.privateRoom(roomCode); setState('room'); }
        else if (!progress.tutorialDone) startLevel(LEVELS[0]);
        else setState('menu');
      }
      break;
    case 'countdown': {
      const steps = ['3', '2', '1', 'GO!'];
      if (stateT > countdownStep * 0.7 && countdownStep < steps.length) {
        if (countdownStep === 0) hud.toast(online ? `YOU ARE ${me === 0 ? 'BLUE' : 'RED'}` : currentLevel.name.toUpperCase(), online ? factionColor(me) : '#ffffff', false, 'lvl', 0);
        hud.countdown(steps[countdownStep], countdownStep === 3 ? factionColor(me) : '#ffffff');
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
    // online duels never pause: the pause screen is just an overlay with a forfeit button
    const running = world.attract ? state !== 'play' : state === 'play' || (!!online && state === 'pause');
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
      if (online === 'host' && net) {
        const evs = filterEvents(sim.events);
        if (evs.length) net.sendEvents(evs);
        if (now >= snapTimer) { snapTimer = now + 1000 / 12; net.sendSnapshot(encodeSnapshot(sim)); }
      }
      processEvents(sim.events, sim, world.attract);
      if (world.attract && sim.over) attract();
    } else {
      arrows.begin(); arrows.end();
    }
    if (state === 'play' || state === 'pause' || state === 'countdown') {
      hud.update(sim.strength(), sim.time, sim.manaOf[me] ?? 0, true, sim.rallyActive(me) ? (sim.rallyUntilOf[me] - sim.time) : 0);
      // music intensity follows the battle
      const s = sim.strength();
      const total = s.reduce((a, b) => a + b, 0) || 1;
      audio.setIntensity(state === 'play' ? 0.55 + Math.min(0.45, sim.units.length / 300) : 0.3);
      void total;
    }
    if (state === 'play') {
      // golden sparks trail rallied armies
      for (const f of sim.humans) {
        if (!sim.rallyActive(f)) continue;
        for (let k = 0; k < 3 && sim.units.length; k++) {
          const u = sim.units[(Math.random() * sim.units.length) | 0];
          if (u.faction === f) fx.sparks(at(u.x, u.z, 0.25), '#ffd166', 2);
        }
      }
    }
    if (state === 'play' && sim instanceof GuestSim && sim.stalled) hud.toast('WAITING FOR OPPONENT…', '#ffd166', true, 'stall', 3);
    if (state === 'play') {
      const ch = commander.charges;
      const charge = Math.max(ch[0], ch[1]);
      audio.setCharge(charge > 0 ? charge : 0);
      for (let i = 0; i < 2; i++) {
        const m = commander.modes[i];
        // middle-finger smite: crackle on the raised fingertip
        if (m === 'charge' || m === 'armed') fx.charge(v3.copy(handViz.hands[i].pts[12]), ch[i]);
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
    atlas.update(rawDt, sim.bases, sim.units);
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
  // online: share our hands, show theirs
  if (net && online && (state === 'play' || state === 'countdown')) {
    if (now >= handTimer) { handTimer = now + 1000 / 20; net.sendHand(encodeHands(frame)); }
  }
  oppViz.update(online ? decodeHands() : [remoteHandStates[0], remoteHandStates[1]].map((h) => ({ ...h, present: false })), stage, rawDt, stage.t, ['hover', 'hover'], [0, 0], ground);
  stage.render(rawDt, !NO_RENDER);
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
  tutorialCounters: () => tutorial.counters,
  setState: (s: State) => setState(s),
  startLevel: (id: number) => startLevel(id >= 100 ? skirmish(id) : LEVELS[id - 1]),
  skipCountdown: () => setState('play'),
  fastForward,
  get frameCount() { return frameCount; },
  progress: () => progress,
  resetProgress: () => { progress = { unlocked: 1, stars: {}, tutorialDone: false }; saveProgress(progress); },
  get net() { return net; },
  get online() { return online; },
  quickMatch: () => { matchmaker.quick(); setState('searching'); },
  joinRoom: (code: string) => { matchmaker.privateRoom(code); roomCode = code; setState('room'); },
  unlockAll: () => { progress.unlocked = LEVELS.length; progress.tutorialDone = true; saveProgress(progress); },
};
