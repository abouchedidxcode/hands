import './style.css';
import * as THREE from 'three';
import { BOARD, FACTION_NAMES, factionColor, MANA, PLAYER } from './config';
import { audio, audioStream } from './audio/audio';
import { ClipRecorder } from './record/recorder';
import { Warlord } from './game/ai';
import { LEVELS, skirmish, versus, type Level } from './game/levels';
import { generateMap, generateTriMap, generateVersusMap } from './game/mapgen';
import { Sim } from './game/sim';
import type { GameEvent, Stats } from './game/types';
import { GuestSim } from './net/guestSim';
import { Matchmaker, makeCode, type Match, type MatchSize } from './net/matchmaker';
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
import { HandViz, opponentPalettes } from './render/handViz';
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
/** Online opponents' hands (indexed by their faction), re-projected from their world positions. */
const oppViz = [0, 1, 2].map((f) => new HandViz(opponentPalettes(f)));
stage.scene.add(arrows.group, handViz.group, ...oppViz.map((v) => v.group));
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
/** Online: players in the match (2 = duel, 3 = brawl). */
let players: MatchSize = 2;
/** Size of the match being searched for / the private room being waited in. */
let searchSize: MatchSize = 2;
/** Latest hands from each opponent, by faction. */
const remoteHands: { h: RemoteHand[]; at: number }[] = [];
let endReason = '';
const rematch = { me: false, votes: new Set<number>() };
const matchmaker = new Matchmaker((m) => onMatchFound(m));
const remoteHandStates: [HandState, HandState][] = [0, 1, 2].map(() => [emptyHand(0), emptyHand(1)]);
const NO_HANDS: [HandState, HandState] = [{ ...emptyHand(0) }, { ...emptyHand(1) }];
/** Colour names for online players (factions 0..2). */
const COLOR_NAMES = ['Blue', 'Red', 'Amber'];
const colorName = (f: number) => COLOR_NAMES[f] ?? FACTION_NAMES[f] ?? '?';
const onlineTitle = () => (players === 3 ? 'Online brawl' : 'Online duel');

function pan(x: number) { return Math.max(-1, Math.min(1, x / (BOARD.width / 2))); }

function loadWorld(level: Level, attract: boolean, mode: 'host' | 'guest' | null = null) {
  const bases = mode ? (players === 3 ? generateTriMap(level.map.seed) : generateVersusMap(level.map.seed)) : generateMap(level.map);
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
  if (mode) sim.humans = Array.from({ length: factions }, (_, f) => f);
  const ais: Warlord[] = [];
  if (!mode) for (let f = attract ? 0 : 1; f < factions; f++) ais.push(new Warlord(f, attract ? { think: 1.1, aggro: 0.6, focusPlayer: 1 } : level.ai, level.map.seed));
  world = { level, sim, ais, attract };
  commander.reset();
  commander.faction = me;
  hud.setup(factions, mode ? `${onlineTitle().toUpperCase()} · YOU ARE ${colorName(me).toUpperCase()}` : level.tutorial ? 'TRAINING' : `${level.id < 100 ? 'LEVEL ' + level.id : 'SKIRMISH'} · ${level.name.toUpperCase()}`, me, mode ? COLOR_NAMES.slice(0, factions) : undefined);
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
        row?.insertAdjacentHTML('beforeend', '<div class="hb gold" data-hb id="b-online"><div class="icon">🌍</div>ONLINE<div class="sub">1v1 · 1v1v1</div></div>');
        $('b-online').onclick = () => setState('online');
      }
      break;
    case 'online':
      attract();
      screenEl.innerHTML = onlineScreens.lobby();
      $('b-back').onclick = () => setState('menu');
      $('b-quick').onclick = () => quickMatch(2);
      $('b-quick3').onclick = () => quickMatch(3);
      $('b-room').onclick = () => joinRoom(makeCode(), 2);
      $('b-room3').onclick = () => joinRoom(makeCode(), 3);
      break;
    case 'searching':
      screenEl.innerHTML = searchSize === 3
        ? onlineScreens.searching('FINDING TWO RIVALS', 'Searching the known world for two more gods…')
        : onlineScreens.searching('FINDING AN OPPONENT');
      setTimeout(() => {
        const tag = screenEl.querySelector('.tagline');
        if (state === 'searching' && matchmaker.status === 'searching' && tag) tag.textContent = 'Few gods online right now. Keep waiting, or cancel and send a friend a private link.';
      }, 25000);
      $('b-cancel').onclick = () => { matchmaker.cancel(); setState('online'); };
      break;
    case 'room': {
      const link = `${location.origin}${location.pathname}?${searchSize === 3 ? 'vs3' : 'vs'}=${roomCode}`;
      screenEl.innerHTML = onlineScreens.room(roomCode, link, searchSize);
      matchmaker.onRoomCount = (n) => { const el = document.getElementById('room-count'); if (el) el.textContent = `${n} / ${searchSize} gods here`; };
      matchmaker.onRoomCount(Math.max(1, matchmaker.roomCount));
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
      if (online) { const h = screenEl.querySelector('.tagline'); if (h) h.textContent = `The ${players === 3 ? 'brawl' : 'duel'} goes on without you! Show your hand to fight, or forfeit.`; }
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

// ------------------------------------------------------------------ online (duel 1v1 / brawl 1v1v1)
function quickMatch(size: MatchSize) {
  searchSize = size;
  matchmaker.quick(size);
  setState('searching');
}

function joinRoom(code: string, size: MatchSize) {
  searchSize = size;
  roomCode = code.toUpperCase();
  matchmaker.privateRoom(roomCode, size);
  setState('room');
}

function onMatchFound(m: Match) {
  net?.close();
  const n = (net = new NetSession(m));
  online = m.host ? 'host' : 'guest';
  players = m.size;
  me = n.me;
  remoteHands.length = 0;
  screenEl.innerHTML = onlineScreens.searching(players === 3 ? 'RIVALS FOUND · CONNECTING' : 'OPPONENT FOUND · CONNECTING', 'Opening a channel between the gods…');
  $('b-cancel').onclick = () => leaveOnline();
  n.onStart = (seed) => startOnline(seed);
  n.onCommand = (c, f) => applyRemoteCommand(c, f);
  n.onSnapshot = (snap) => {
    if (world?.sim instanceof GuestSim) { world.sim.latency = Math.min(0.25, (net?.rtt ?? 100) / 2000); world.sim.apply(snap); }
  };
  n.onEvents = (evs) => { if (world && !world.attract) world.sim.events.push(...evs); };
  n.onHand = (h, f) => { remoteHands[f] = { h, at: performance.now() }; };
  n.onRematch = (f) => {
    rematch.votes.add(f);
    if (!rematch.me) hud.toast(players === 3 ? `${colorName(f).toUpperCase()} WANTS A REMATCH` : 'OPPONENT WANTS A REMATCH', '#ffd166', true, 'rmw' + f, 0);
    maybeRematch();
  };
  n.channel.on('stats', (d) => {
    const st = d as { s: Stats[] };
    if (world && online === 'guest') st.s.forEach((x, f) => { if (x) world!.sim.statsOf[f] = x; });
    if (state === 'results') setState('results');
  });
  n.onLeft = (f, hostLeft) => {
    if (net !== n) return;
    hud.toast(players === 3 ? `${colorName(f).toUpperCase()} LEFT` : 'OPPONENT LEFT', '#ff8095', false, 'left' + f, 0);
    remoteHands[f] = { h: [], at: 0 };
    rematch.votes.delete(f);
    const inGame = state === 'play' || state === 'countdown' || state === 'pause';
    const sim = world && !world.attract ? world.sim : null;
    if (!n.started && !inGame && state !== 'results') { leaveOnline(); return; }
    if (inGame || (state === 'results' && sim && !sim.over)) {
      // don't overwrite a result that was already decided (e.g. the winner closed the tab at VICTORY)
      if (sim && !sim.over) {
        if (hostLeft && players === 3) { sim.over = true; sim.winner = -1; endReason = 'host left'; }
        else if (!n.connected) { sim.over = true; sim.winner = me; endReason = players === 3 ? 'everyone left' : 'opponent left'; }
        // otherwise (a brawl guest left) their castles stay on the board, undefended by any god
      }
      if (sim?.over && endTimer < 0) endTimer = 0.8;
    }
    if (state === 'results') {
      if (!n.connected) document.getElementById('b-rematch')?.classList.add('locked');
      else maybeRematch();
    }
  };
}

function startOnline(seed: number) {
  if (!net) return;
  rematch.me = false;
  rematch.votes.clear();
  endReason = '';
  currentLevel = versus(seed, players);
  loadWorld(currentLevel, false, online);
  endTimer = -1;
  timeScale = 1;
  commander.allowSmite = commander.allowSend = commander.allowRally = true;
  recorder.start(onlineTitle(), audioStream());
  setState('countdown');
  stage.snapZoom(0.55);
}

function applyRemoteCommand(c: Command, f: number) {
  if (!world || online !== 'host' || world.attract || world.sim.over || f < 0 || f >= world.sim.factions) return;
  if (!(state === 'play' || state === 'pause' || state === 'results')) return;
  const sim = world.sim;
  switch (c.k) {
    case 'send': sim.send(c.from, c.to, f); break;
    case 'smite': sim.smite(c.x, c.z, f); break;
    case 'rally': sim.rally(f); break;
  }
}

/** The host restarts once the match is over and every connected player asked for a rematch. */
function maybeRematch() {
  if (!net || !net.host || !rematch.me || !world || !world.sim.over) return;
  for (const p of net.others()) if (!rematch.votes.has(net.factionOf(p))) return;
  if (!net.connected) return;
  net.rematch();
}

function leaveOnline() {
  matchmaker.cancel();
  net?.close();
  net = null;
  online = null;
  me = PLAYER;
  commander.faction = PLAYER;
  remoteHands.length = 0;
  recorder.stop(true);
  setState('menu');
}

function showOnlineResults() {
  const sim = world!.sim;
  const order = [me, ...Array.from({ length: sim.factions }, (_, f) => f).filter((f) => f !== me)];
  const rows = order.map((f) => ({ name: colorName(f).toUpperCase(), color: factionColor(f), me: f === me, stats: sim.statsOf[f] ?? null, won: sim.over && sim.winner === f }));
  const eliminated = !sim.over && !sim.alive[me];
  screenEl.innerHTML = onlineScreens.results(rows, sim.time, onlineTitle(), eliminated ? 'eliminated' : endReason, sim.over && sim.winner < 0);
  const rm = $('b-rematch');
  if (rematch.me || !net?.connected) rm.classList.add('locked');
  buttons.hold(1.2);
  if (sim.over) recorder.stop();
  $('b-menu').onclick = () => leaveOnline();
  rm.onclick = () => {
    if (!net?.connected || rematch.me) return;
    rematch.me = true;
    net.wantRematch();
    rm.classList.add('locked');
    const waiting = net.others().filter((p) => !rematch.votes.has(net!.factionOf(p))).length;
    hud.toast(waiting ? (players === 3 ? `WAITING FOR ${waiting} MORE…` : 'WAITING FOR OPPONENT…') : 'REMATCH!', '#ffffff', true, 'rm', 0);
    maybeRematch();
  };
}

/** Convert local hands to world points for the opponents. */
function encodeHands(frame: InputFrame): RemoteHand[] {
  const out: RemoteHand[] = [];
  for (const h of frame.hands) {
    if (!h.present || h.landmarks.length !== 21) { out.push({ p: false, g: 0, pts: [] }); continue; }
    const pts: number[] = [];
    for (const l of h.landmarks) {
      const g = stage.screenToGround(l.x, l.y, 0.25, v3);
      pts.push(g ? Math.round(g.x * 50) / 50 : 0, g ? Math.round(g.z * 50) / 50 : 0, Math.round(l.z * 1000) / 1000);
    }
    const c = stage.screenToGround(h.x, h.y, 0.25, v3);
    pts.push(c ? Math.round(c.x * 50) / 50 : 0, c ? Math.round(c.z * 50) / 50 : 0);
    out.push({ p: true, g: h.fist ? 1 : h.middle ? 2 : h.open ? 3 : 0, pts });
  }
  return out;
}

/** Re-project opponent `f`'s world-space hands into our screen space for HandViz. */
function decodeHands(f: number): [HandState, HandState] {
  const rh = remoteHands[f];
  const stale = !rh || performance.now() - rh.at > 600;
  const out = remoteHandStates[f];
  for (let i = 0; i < 2; i++) {
    const r = rh?.h[i], h = out[i];
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
    h.fist = r.g === 1; h.middle = r.g === 2; h.open = r.g === 3;
  }
  return out;
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
          hud.toast(e.from === -1 ? 'CAPTURED!' : `STOLEN FROM ${online ? (players === 3 ? colorName(e.from).toUpperCase() : 'THEM') : FACTION_NAMES[e.from].toUpperCase()}!`, factionColor(me), e.from === -1, 'cap', 0.5);
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
        if (isAttract) break;
        if (e.faction !== me && (!online || players === 3)) {
          hud.toast(`${(online ? colorName(e.faction) : FACTION_NAMES[e.faction]).toUpperCase()} ELIMINATED`, factionColor(e.faction), false, 'elim' + e.faction, 0);
          stage.shake(0.4);
        } else if (e.faction === me && online && players === 3 && !sim.over) {
          // knocked out of a brawl: the other two fight on; show our result (rematch waits for the end)
          audio.play('defeat');
          hud.toast('ELIMINATED', '#ff8095', false, 'end', 0);
          recorder.banner('ELIMINATED', '#ff8095', true);
          if (endTimer < 0) endTimer = 2.2;
        }
        break;
      case 'end':
        if (!isAttract && online && state === 'results') {
          // already watching our (eliminated) result: refresh it with the final winner
          if (online === 'guest') { sim.over = true; sim.winner = e.winner; }
          if (online === 'host') net?.broadcast('stats', { s: sim.statsOf });
          setState('results');
          maybeRematch();
        } else if (!isAttract) {
          endTimer = 2.2;
          timeScale = 0.35;
          const won = e.winner === me;
          audio.play(won ? 'victory' : 'defeat');
          recorder.banner(won ? 'VICTORY' : 'DEFEAT', won ? '#ffe08a' : '#ff8095', true);
          hud.toast(won ? 'VICTORY' : 'DEFEAT', won ? '#ffe08a' : '#ff8095', false, 'end', 0);
          if (online === 'host') net?.broadcast('stats', { s: sim.statsOf });
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
        const q = new URLSearchParams(location.search);
        const vs3 = q.get('vs3'), vs = q.get('vs');
        if (vs3) joinRoom(vs3, 3);
        else if (vs) joinRoom(vs, 2);
        else if (!progress.tutorialDone) startLevel(LEVELS[0]);
        else setState('menu');
      }
      break;
    case 'countdown': {
      const steps = ['3', '2', '1', 'GO!'];
      if (stateT > countdownStep * 0.7 && countdownStep < steps.length) {
        if (countdownStep === 0) hud.toast(online ? `YOU ARE ${colorName(me).toUpperCase()}` : currentLevel.name.toUpperCase(), online ? factionColor(me) : '#ffffff', false, 'lvl', 0);
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
    // online matches never pause: the pause screen is just an overlay with a forfeit button, and a
    // player knocked out of a brawl keeps the battle (and, as host, the simulation) going behind their result
    const running = world.attract ? state !== 'play' : state === 'play' || (!!online && (state === 'pause' || (state === 'results' && !sim.over)));
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
    if (state === 'play' && sim instanceof GuestSim && sim.stalled) hud.toast(players === 3 ? 'WAITING FOR THE HOST…' : 'WAITING FOR OPPONENT…', '#ffd166', true, 'stall', 3);
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
  oppViz.forEach((v, f) => v.update(online && net && f !== me && f < players ? decodeHands(f) : NO_HANDS, stage, rawDt, stage.t, ['hover', 'hover'], [0, 0], ground));
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
// ------------------------------------------------------------------ diagnostics (keyboard)
// D: overlay with sizes + what sits on top of the map; B: bloom; H: 3D hands; P: webcam preview
const diagEl = document.createElement('pre');
diagEl.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;margin:0;padding:8px 10px;max-width:46vw;'
  + 'font:12px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,0.82);border-radius:6px;pointer-events:none;white-space:pre-wrap;display:none';
document.body.appendChild(diagEl);
const diagOff = { bloom: false, hands: false, pip: false };
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'd') diagEl.style.display = diagEl.style.display === 'none' ? 'block' : 'none';
  else if (k === 'b') diagOff.bloom = !diagOff.bloom;
  else if (k === 'h') diagOff.hands = !diagOff.hands;
  else if (k === 'p') diagOff.pip = !diagOff.pip;
  else return;
  stage.bloom.enabled = !diagOff.bloom && stage.quality < 2;
  handViz.group.visible = !diagOff.hands;
  pipEl.style.visibility = diagOff.pip ? 'hidden' : '';
});
const describeEl = (el: Element | null) => el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''}` : '-';
setInterval(() => {
  if (diagEl.style.display === 'none') return;
  const cv = stage.renderer.domElement, r = cv.getBoundingClientRect();
  const comp = stage.composer as unknown as { _pixelRatio: number; renderTarget1: { width: number; height: number } };
  const probes = [[0.1, 0.5], [0.3, 0.5], [0.5, 0.5], [0.7, 0.5], [0.9, 0.5]].map(([x, y]) =>
    `  ${Math.round(x * 100)}%: ${document.elementsFromPoint(x * innerWidth, y * innerHeight).slice(0, 3).map(describeEl).join(' > ')}`);
  const f = frame;
  diagEl.textContent = [
    `window ${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`,
    `canvas css ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} buffer ${cv.width}x${cv.height}`,
    `pixelRatio renderer ${stage.renderer.getPixelRatio()} composer ${comp._pixelRatio} target ${comp.renderTarget1.width}x${comp.renderTarget1.height}`,
    `quality ${stage.quality}  bloom ${stage.bloom.enabled ? 'on' : 'OFF'}  hands3d ${handViz.group.visible ? 'on' : 'OFF'}  pip ${diagOff.pip ? 'OFF' : 'on'}  state ${state}`,
    `context lost ${stage.renderer.getContext().isContextLost()}`,
    ...f.hands.map((h, i) => `hand${i} ${h.present ? `${h.gesture} x ${h.x.toFixed(2)} y ${h.y.toFixed(2)} mode ${commander.modes[i]}` : '-'}`),
    'top elements at mid-height:', ...probes,
    'keys: D overlay · B bloom · H 3D hands · P webcam preview',
  ].join('\n');
}, 250);

requestAnimationFrame(tick);

// Debug / test hooks
declare global { interface Window { __godhand: unknown } }
window.__godhand = {
  input, stage, audio, recorder, handViz,
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
  quickMatch: (size: MatchSize = 2) => quickMatch(size),
  joinRoom: (code: string, size: MatchSize = 2) => joinRoom(code, size),
  unlockAll: () => { progress.unlocked = LEVELS.length; progress.tutorialDone = true; saveProgress(progress); },
};
