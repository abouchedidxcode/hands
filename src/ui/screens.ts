import { LEVELS, type Level } from '../game/levels';
import type { Stats } from '../game/types';
import type { Progress } from './progress';

const orb = (id: string, icon: string, label: string, cls = '', sub = '') =>
  `<div class="hb ${cls}" data-hb id="${id}"><div class="icon">${icon}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

/** Animated gesture illustrations for the How-To screen (pure CSS, see .demo in style.css). */
const dots = (cls: string, n: number) => Array.from({ length: n }, (_, i) => `<i class="${cls}" style="--i:${i}"></i>`).join('');
const DEMOS = {
  pinch: `<div class="demo d-pinch">
      <div class="base me"></div><div class="base tgt"></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path class="tr" d="M16 62 L80 36" pathLength="100"/></svg>${dots('sol', 5)}
      <div class="hand">🤏</div></div>`,
  sweep: `<div class="demo d-sweep">
      <div class="base me a"></div><div class="base me b"></div><div class="base tgt"></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path class="tr" d="M14 70 L42 34 L84 58" pathLength="100"/></svg>
      <div class="hand">🤏</div></div>`,
  smite: `<div class="demo d-smite">
      ${dots('foe', 6)}
      <div class="glow"></div><div class="ring"></div><div class="bolt">⚡</div>
      <div class="hand fist">✊</div><div class="hand open">🖐️</div></div>`,
  swat: `<div class="demo d-swat">
      ${dots('foe', 5)}
      <div class="streak"></div><div class="hand">🖐️</div></div>`,
  rally: `<div class="demo d-rally">
      <div class="hand l">🫱</div><div class="hand r">🫲</div>
      <div class="clap">👏</div><div class="ring"></div>
      ${dots('sol', 4)}</div>`,
  two: `<div class="demo d-two">
      <div class="hand l">🤏</div><div class="hand r">🤏</div></div>`,
};

const hint = (demo: string, title: string, text: string, cls = '') =>
  `<div class="hint ${cls}">${demo}<b>${title}</b><span>${text}</span></div>`;

function levelLabel(level: Level) {
  if (level.tutorial) return 'Training · First Light';
  return level.id < 100 ? `Level ${level.id} · ${level.name}` : `Skirmish · seed ${level.map.seed}`;
}

function shareLine(win: boolean, level: Level, time: number, stats: Stats) {
  const place = level.id >= 100 ? 'a random island' : level.name;
  if (win) {
    const extra = stats.smites >= 3 ? ` and ${stats.smites} lightning bolts` : stats.kills >= 100 ? `, ${stats.kills} soldiers fell` : '';
    return `I conquered <b>${place}</b> in <b>${fmt(time)}</b> with my bare hands${extra}.`;
  }
  return `<b>${place}</b> crushed me after <b>${fmt(time)}</b>. My hands want revenge.`;
}

/** Deterministic little confetti burst behind the victory stars. */
function confetti() {
  const cols = ['#ffd166', '#33e1ff', '#ffffff', '#ffb22e', '#9ff3ff'];
  let out = '';
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.21;
    const d = 140 + ((i * 53) % 90);
    out += `<i style="--x:${(Math.cos(a) * d * 1.6).toFixed(0)}px;--y:${(Math.sin(a) * d * 0.8 - 30).toFixed(0)}px;--c:${cols[i % cols.length]};--d:${(0.9 + (i % 4) * 0.35).toFixed(2)}s;--r:${(i * 47) % 360}deg"></i>`;
  }
  return `<div class="confetti">${out}</div>`;
}

export const screens = {
  boot: () => `
    <div class="panel clear boot">
      <h1 class="title"><span class="hand">✋</span><br/>GODHAND</h1>
      <p class="tagline pill">Command armies with your <b>bare hands</b>. Pinch. Drag. <b>Smite.</b></p>
      <div class="gesture-strip">
        <span><i>🤏</i>PINCH &amp; DRAG</span><span><i>✊</i>SMITE</span><span><i>🖐️</i>SWAT</span><span><i>👏</i>RALLY</span>
      </div>
      <button class="big-start interactive" id="b-start">✋ SUMMON YOUR HANDS</button>
      <p class="fineprint card">🔒 Uses your webcam for hand tracking. Video is processed <b>on your device</b> and never uploaded.<br/>
      Tip: good light, sit back ~60 cm, keep your hands in view.</p>
    </div>`,

  loading: (msg: string) => `
    <div class="panel loading">
      <div class="spinner"><div class="arc"></div><div class="g">✋</div></div>
      <h2>${msg}</h2>
      <p class="tagline">Waking the hand-tracking model…</p>
      <div class="lbar"><i></i></div>
    </div>`,

  raise: () => `
    <div class="raise-screen">
      <div class="raise-top">
        <div class="step">STEP 1 · CALIBRATE</div>
        <h2>RAISE YOUR HAND</h2>
        <p class="tagline">Palm toward the camera · fingers spread</p>
      </div>
      <div class="raise-tips">
        <span><i>💡</i>Face a light</span><span><i>📏</i>Sit back ~60 cm</span><span><i>🙌</i>One or both hands</span>
      </div>
    </div>`,

  noCamera: (reason: string) => `
    <div class="panel nocam">
      <div class="big-ico">📷</div>
      <h2>NO CAMERA</h2>
      <p class="tagline">${reason}</p>
      <p class="fineprint">GODHAND is made for your hands — allow camera access in the address bar and retry.<br/>
      Meanwhile you can play with a mouse: <b>left-drag</b> = pinch, <b>hold right button</b> = fist (release to smite), <b>shift + flick</b> = swat.</p>
      <div class="orbs">${orb('b-retrycam', '📷', 'RETRY', 'small')}${orb('b-mouse', '🖱️', 'MOUSE', 'small gold')}</div>
    </div>`,

  menu: (p: Progress) => {
    const next = LEVELS[Math.min(p.unlocked, LEVELS.length) - 1];
    return `
    <div class="panel clear menu">
      <h1 class="title small">GODHAND</h1>
      <div class="orbs">
        ${orb('b-levels', '🗺️', 'LEVELS')}
        ${orb('b-play', '⚔️', 'PLAY', 'primary', next.tutorial ? 'Training' : `Lv ${next.id} · ${next.name}`)}
        ${orb('b-howto', '✋', 'HOW TO')}
      </div>
      <p class="tagline pill">Hover a button until its ring fills — or <b>pinch</b> it</p>
    </div>`;
  },

  levels: (p: Progress) => `
    <div class="panel levels-panel">
      <h2>CHOOSE YOUR WAR</h2>
      <div class="levels">
        ${LEVELS.map((l) => {
          const locked = l.id > p.unlocked;
          const s = p.stars[l.id] ?? 0;
          return `<div class="hb ${locked ? 'locked' : ''}${l.id === p.unlocked ? ' next' : ''}" data-hb data-level="${l.id}"><div class="num">${locked ? '🔒' : l.id}</div>
            <div class="name">${l.name}</div><div class="stars">${'★'.repeat(s)}<span>${'★'.repeat(3 - s)}</span></div></div>`;
        }).join('')}
      </div>
      <div class="orbs">${orb('b-back', '↩', 'BACK', 'small')}${orb('b-skirmish', '🎲', 'SKIRMISH', 'small gold', 'random island')}</div>
    </div>`,

  howto: () => `
    <div class="panel howto">
      <h2>YOUR HANDS ARE THE CONTROLLER</h2>
      <div class="hint-row">
        ${hint(DEMOS.pinch, 'PINCH &amp; DRAG', 'Pinch your castle, drag to a target, let go. Half its army marches.')}
        ${hint(DEMOS.sweep, 'SWEEP', 'While pinching, glide over more of your castles to send them all.')}
        ${hint(DEMOS.smite, 'SMITE', 'Hold a <b>fist</b> to charge, <b>open</b> your hand to strike. 35 mana.', 'gold')}
        ${hint(DEMOS.swat, 'SWAT', 'Swipe an open palm fast across enemy soldiers to fling them.')}
        ${hint(DEMOS.rally, 'RALLY', '<b>Clap</b> both hands: 6 s of faster marching &amp; growth. 50 mana.', 'gold')}
        ${hint(DEMOS.two, 'TWO HANDS', 'Both hands work at once. Fight on two fronts.')}
      </div>
      <div class="orbs">${orb('b-back', '↩', 'BACK', 'small')}${orb('b-tutorial', '🎓', 'TRAINING', 'small gold')}</div>
    </div>`,

  pause: () => `
    <div class="panel pause">
      <h2>PAUSED</h2>
      <p class="tagline">Your hands left the battlefield</p>
      <div class="orbs">${orb('b-quit', '🏳️', 'QUIT', 'small danger')}${orb('b-resume', '▶', 'RESUME', 'primary', 'back to war')}</div>
    </div>`,

  results: (win: boolean, level: Level, time: number, stats: Stats, stars: number, hasNext: boolean) => `
    <div class="panel results ${win ? 'win' : 'lose'}">
      <div class="res-head">
        <h2 class="${win ? 'victory' : 'defeat'}">${win ? 'VICTORY' : 'DEFEAT'}</h2>
        <h3>${levelLabel(level)}</h3>
      </div>
      ${win ? `<div class="bigstars">${confetti()}${[1, 2, 3].map((i) => `<span class="${i <= stars ? 'on' : 'off'}" style="--i:${i - 1}">★</span>`).join('')}</div>` : ''}
      <div class="stats">
        <div class="stat hi"><b>${fmt(time)}</b><span>Time</span></div>
        <div class="stat"><b>${stats.captures}</b><span>Captured</span></div>
        <div class="stat"><b>${stats.kills}</b><span>Kills</span></div>
        <div class="stat"><b>${stats.smites}</b><span>Smites</span></div>
        <div class="stat"><b>${stats.swats}</b><span>Swats</span></div>
        <div class="stat"><b>${stats.rallies ?? 0}</b><span>Rallies</span></div>
        <div class="stat"><b>${stats.peakArmy}</b><span>Peak army</span></div>
      </div>
      <p class="share"><span class="q">“</span>${shareLine(win, level, time, stats)}<span class="tag">✋ GODHAND</span></p>
      <div class="orbs">
        ${orb('b-menu', '🏠', 'MENU', 'small')}
        ${orb('b-retry', '↻', 'RETRY', win && hasNext ? 'small' : 'primary')}
        ${win && hasNext ? orb('b-next', '⚔️', 'NEXT', 'primary', 'next level') : ''}
      </div>
    </div>`,
};

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
