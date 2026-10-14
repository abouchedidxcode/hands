import type { Stats } from '../game/types';

const orb = (id: string, icon: string, label: string, cls = '', sub = '') =>
  `<div class="hb ${cls}" data-hb id="${id}"><div class="icon">${icon}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

const vs = (a: string | number, b: string | number) => `${a}<small> : ${b}</small>`;

export const onlineScreens = {
  lobby: () => `
    <div class="panel online">
      <h3>A duel between gods</h3>
      <h2>ONLINE DUEL</h2>
      <div class="duel-vs"><span class="me">✋ YOU</span><i>versus</i><span class="them">ANOTHER GOD ✋</span></div>
      <p class="tagline">One island, two pairs of hands. Free &amp; peer-to-peer.</p>
      <div class="orbs">
        ${orb('b-back', '↩', 'BACK', 'small')}
        ${orb('b-quick', '⚔️', 'QUICK MATCH', 'primary', 'random opponent')}
        ${orb('b-room', '🔗', 'PRIVATE', 'small gold', 'invite a friend')}
      </div>
    </div>`,

  searching: (msg: string) => `
    <div class="panel raise">
      <div class="g net-spin">🌍</div>
      <h2>${msg}</h2>
      <p class="tagline">Searching the known world for another god…</p>
      <div class="lbar"><i></i></div>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  room: (code: string, link: string) => `
    <div class="panel online">
      <h2>PRIVATE DUEL</h2>
      <p class="tagline">Send this link to a friend — the battle begins when they open it.</p>
      <div class="room-code">${code}</div>
      <div class="room-link interactive"><input id="room-link" readonly value="${link}"/><button id="b-copy" class="interactive">COPY LINK</button></div>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  results: (win: boolean, time: number, me: Stats, opp: Stats | null, reason = '') => `
    <div class="panel results ${win ? 'win' : 'lose'}">
      <div class="res-head">
        <h2 class="${win ? 'victory' : 'defeat'}">${win ? 'VICTORY' : 'DEFEAT'}</h2>
        <h3>Online duel${reason ? ' · ' + reason : ''}</h3>
      </div>
      <div class="stats duel">
        <div class="stat hi"><b>${fmt(time)}</b><span>Time</span></div>
        <div class="stat"><b>${opp ? vs(me.captures, opp.captures) : me.captures}</b><span>Captured</span></div>
        <div class="stat"><b>${opp ? vs(me.kills, opp.kills) : me.kills}</b><span>Kills</span></div>
        <div class="stat"><b>${opp ? vs(me.smites, opp.smites) : me.smites}</b><span>Smites</span></div>
        <div class="stat"><b>${opp ? vs(me.peakArmy, opp.peakArmy) : me.peakArmy}</b><span>Peak army</span></div>
      </div>
      <div class="orbs">
        ${orb('b-menu', '🏠', 'MENU', 'small')}
        ${orb('b-rematch', '↻', 'REMATCH', 'primary', 'both must agree')}
      </div>
    </div>`,
};

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
