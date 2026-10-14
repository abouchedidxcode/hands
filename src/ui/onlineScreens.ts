import type { Stats } from '../game/types';

const orb = (id: string, icon: string, label: string, cls = '', sub = '') =>
  `<div class="hb ${cls}" data-hb id="${id}"><div class="icon">${icon}</div>${label}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

export const onlineScreens = {
  lobby: () => `
    <div class="panel">
      <h2>ONLINE DUEL</h2>
      <p class="tagline">1v1 against another god, hand to hand. Free, peer-to-peer.</p>
      <div class="orbs">
        ${orb('b-back', '↩', 'BACK', 'small')}
        ${orb('b-quick', '⚔️', 'QUICK MATCH', 'primary', 'Find a random opponent')}
        ${orb('b-room', '🔗', 'PRIVATE', 'small gold', 'Invite a friend')}
      </div>
    </div>`,

  searching: (msg: string) => `
    <div class="panel raise">
      <div class="g net-spin">🌍</div>
      <h2>${msg}</h2>
      <p class="tagline">Looking for another god somewhere in the world…</p>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  room: (code: string, link: string) => `
    <div class="panel">
      <h2>PRIVATE DUEL</h2>
      <p class="tagline">Send this link to a friend. The battle starts when they open it.</p>
      <div class="room-code">${code}</div>
      <div class="room-link interactive"><input id="room-link" readonly value="${link}"/><button id="b-copy" class="interactive">Copy link</button></div>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  results: (win: boolean, time: number, me: Stats, opp: Stats | null, reason = '') => `
    <div class="panel">
      <h2 class="${win ? 'victory' : 'defeat'}" style="font-size:clamp(48px,8vw,96px)">${win ? 'VICTORY' : 'DEFEAT'}</h2>
      <h3>Online duel${reason ? ' · ' + reason : ''}</h3>
      <div class="stats">
        <div class="stat"><b>${fmt(time)}</b><span>Time</span></div>
        <div class="stat"><b>${me.captures}${opp ? ' : ' + opp.captures : ''}</b><span>Captured</span></div>
        <div class="stat"><b>${me.kills}${opp ? ' : ' + opp.kills : ''}</b><span>Kills</span></div>
        <div class="stat"><b>${me.smites}${opp ? ' : ' + opp.smites : ''}</b><span>Smites</span></div>
        <div class="stat"><b>${me.peakArmy}${opp ? ' : ' + opp.peakArmy : ''}</b><span>Peak army</span></div>
      </div>
      <div class="orbs">
        ${orb('b-menu', '🏠', 'MENU', 'small')}
        ${orb('b-rematch', '↻', 'REMATCH', 'primary', 'Both must agree')}
      </div>
    </div>`,
};

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
