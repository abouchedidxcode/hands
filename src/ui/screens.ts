import { LEVELS, type Level } from '../game/levels';
import type { Stats } from '../game/types';
import type { Progress } from './progress';

const orb = (id: string, icon: string, label: string, cls = '', sub = '') =>
  `<div class="hb ${cls}" data-hb id="${id}"><div class="icon">${icon}</div>${label}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

export const screens = {
  boot: () => `
    <div class="panel clear">
      <h1 class="title"><span class="hand">✋</span><br/>GODHAND</h1>
      <p class="tagline">Command armies with your <b>bare hands</b>. Pinch. Drag. <b>Smite.</b></p>
      <button class="big-start interactive" id="b-start">✋ SUMMON YOUR HANDS</button>
      <p class="fineprint">Uses your webcam for hand tracking. Video is processed on your device and never uploaded.<br/>
      Tip: good light, sit back ~60 cm, keep your hands in view.</p>
    </div>`,

  loading: (msg: string) => `
    <div class="panel clear raise">
      <div class="g">🪄</div>
      <h2>${msg}</h2>
      <p class="tagline">Loading the hand-tracking model…</p>
    </div>`,

  raise: () => `
    <div class="panel clear raise">
      <div class="g">✋</div>
      <h2>RAISE YOUR HAND</h2>
      <p class="tagline">Hold it up, palm facing the camera</p>
    </div>`,

  noCamera: (reason: string) => `
    <div class="panel">
      <h2>NO CAMERA</h2>
      <p class="tagline">${reason}</p>
      <p class="fineprint">GODHAND is made for your hands — allow camera access in the address bar and reload.<br/>
      Meanwhile you can play with a mouse: <b>left-drag</b> = pinch, <b>hold right button</b> = fist (release to smite), <b>shift + flick</b> = swat.</p>
      <div class="orbs">${orb('b-retrycam', '📷', 'RETRY', 'small')}${orb('b-mouse', '🖱️', 'MOUSE', 'small')}</div>
    </div>`,

  menu: (p: Progress) => {
    const next = LEVELS[Math.min(p.unlocked, LEVELS.length) - 1];
    return `
    <div class="panel clear">
      <h1 class="title" style="font-size:clamp(48px,8vw,110px)">GODHAND</h1>
      <div class="orbs">
        ${orb('b-levels', '🗺️', 'LEVELS')}
        ${orb('b-play', '⚔️', 'PLAY', 'primary', `Level ${next.id} · ${next.name}`)}
        ${orb('b-howto', '✋', 'HOW TO')}
      </div>
      <p class="tagline">Hover &amp; hold a button — or <b>pinch</b> it</p>
    </div>`;
  },

  levels: (p: Progress) => `
    <div class="panel">
      <h2>CHOOSE YOUR WAR</h2>
      <div class="levels">
        ${LEVELS.map((l) => {
          const locked = l.id > p.unlocked;
          const s = p.stars[l.id] ?? 0;
          return `<div class="hb ${locked ? 'locked' : ''}" data-hb data-level="${l.id}">${locked ? '🔒' : l.id}
            <div class="name">${l.name}</div><div class="stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</div></div>`;
        }).join('')}
      </div>
      <div class="orbs">${orb('b-back', '↩', 'BACK', 'small')}${orb('b-skirmish', '🎲', 'SKIRMISH', 'small gold')}</div>
    </div>`,

  howto: () => `
    <div class="panel">
      <h2>YOUR HANDS ARE THE CONTROLLER</h2>
      <div class="hint-row">
        <div class="hint"><div class="g">🤏</div><b>PINCH &amp; DRAG</b><span>Pinch your castle, drag to a target, let go. Half its army marches.</span></div>
        <div class="hint"><div class="g">〰️</div><b>SWEEP</b><span>While pinching, pass over more of your castles to send them all.</span></div>
        <div class="hint"><div class="g">✊➜🖐️</div><b>SMITE</b><span>Hold a fist to charge, open your hand to strike lightning.</span></div>
        <div class="hint"><div class="g">🖐️💨</div><b>SWAT</b><span>Swipe an open palm fast across enemy soldiers to fling them away.</span></div>
        <div class="hint"><div class="g">🙌</div><b>TWO HANDS</b><span>Both hands work at once. Fight on two fronts.</span></div>
      </div>
      <div class="orbs">${orb('b-back', '↩', 'BACK', 'small')}${orb('b-tutorial', '🎓', 'TRAINING', 'small gold')}</div>
    </div>`,

  pause: () => `
    <div class="panel">
      <h2>PAUSED</h2>
      <p class="tagline">Your hands left the battlefield</p>
      <div class="orbs">${orb('b-quit', '🏳️', 'QUIT', 'small danger')}${orb('b-resume', '▶', 'RESUME', 'primary')}</div>
    </div>`,

  results: (win: boolean, level: Level, time: number, stats: Stats, stars: number, hasNext: boolean) => `
    <div class="panel">
      <h2 class="${win ? 'victory' : 'defeat'}" style="font-size:clamp(48px,8vw,96px)">${win ? 'VICTORY' : 'DEFEAT'}</h2>
      <h3>${level.name}</h3>
      ${win ? `<div class="bigstars">${[1, 2, 3].map((i) => `<span class="${i <= stars ? '' : 'off'}">★</span>`).join('')}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${fmt(time)}</b><span>Time</span></div>
        <div class="stat"><b>${stats.captures}</b><span>Captured</span></div>
        <div class="stat"><b>${stats.kills}</b><span>Kills</span></div>
        <div class="stat"><b>${stats.smites}</b><span>Smites</span></div>
        <div class="stat"><b>${stats.swats}</b><span>Swats</span></div>
        <div class="stat"><b>${stats.peakArmy}</b><span>Peak army</span></div>
      </div>
      <div class="orbs">
        ${orb('b-menu', '🏠', 'MENU', 'small')}
        ${orb('b-retry', '↻', 'RETRY', win && hasNext ? 'small' : 'primary')}
        ${win && hasNext ? orb('b-next', '⚔️', 'NEXT', 'primary', 'Next level') : ''}
      </div>
    </div>`,
};

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
