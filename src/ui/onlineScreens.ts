import type { Stats } from '../game/types';

const orb = (id: string, icon: string, label: string, cls = '', sub = '') =>
  `<div class="hb ${cls}" data-hb id="${id}"><div class="icon">${icon}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

export interface PlayerResult { name: string; color: string; me: boolean; stats: Stats | null; won: boolean }

export const onlineScreens = {
  lobby: () => `
    <div class="panel online">
      <h3>Battles between gods</h3>
      <h2>ONLINE</h2>
      <p class="tagline">One island, two or three pairs of hands. Free &amp; peer-to-peer.</p>
      <div class="orbs">
        ${orb('b-quick', '⚔️', 'DUEL', 'primary', 'quick 1v1')}
        ${orb('b-quick3', '🔱', 'BRAWL', 'primary', 'quick 1v1v1')}
      </div>
      <div class="orbs">
        ${orb('b-back', '↩', 'BACK', 'small')}
        ${orb('b-room', '🔗', 'PRIVATE 1v1', 'small gold', 'invite a friend')}
        ${orb('b-room3', '🔗', 'PRIVATE 1v1v1', 'small gold', 'two friends')}
      </div>
    </div>`,

  searching: (msg: string, sub = 'Searching the known world for another god…') => `
    <div class="panel raise">
      <div class="g net-spin">🌍</div>
      <h2>${msg}</h2>
      <p class="tagline">${sub}</p>
      <div class="lbar"><i></i></div>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  room: (code: string, link: string, size: number) => `
    <div class="panel online">
      <h2>${size === 3 ? 'PRIVATE BRAWL' : 'PRIVATE DUEL'}</h2>
      <p class="tagline">${size === 3 ? 'Send this link to two friends. The battle begins when all three gods are here.' : 'Send this link to a friend. The battle begins when they open it.'}</p>
      <div class="room-code">${code}</div>
      <div class="room-link interactive"><input id="room-link" readonly value="${link}"/><button id="b-copy" class="interactive">COPY LINK</button></div>
      <p class="tagline" id="room-count">1 / ${size} gods here</p>
      <div class="orbs">${orb('b-cancel', '✕', 'CANCEL', 'small danger')}</div>
    </div>`,

  /** `players[0]` is me; heading is VICTORY / DEFEAT, or MATCH OVER when nobody won. */
  results: (players: PlayerResult[], time: number, title: string, reason = '', ended = false) => {
    const me = players[0];
    const head = ended ? 'MATCH OVER' : me.won ? 'VICTORY' : 'DEFEAT';
    const cls = ended ? 'lose' : me.won ? 'win' : 'lose';
    const row = (label: string, get: (s: Stats) => number) => {
      const vals = players.map((p) => (p.stats ? get(p.stats) : '–'));
      return `<div class="stat"><b>${vals[0]}${vals.length > 1 ? `<small> : ${vals.slice(1).join(' : ')}</small>` : ''}</b><span>${label}</span></div>`;
    };
    const names = players.length > 1
      ? `<p class="tagline">${players.map((p) => `<b style="color:${p.color}">${p.me ? 'YOU' : p.name}${p.won ? ' 👑' : ''}</b>`).join(' : ')}</p>` : '';
    return `
    <div class="panel results ${cls}">
      <div class="res-head">
        <h2 class="${cls === 'win' ? 'victory' : 'defeat'}">${head}</h2>
        <h3>${title}${reason ? ' · ' + reason : ''}</h3>
      </div>
      ${names}
      <div class="stats duel">
        <div class="stat hi"><b>${fmt(time)}</b><span>Time</span></div>
        ${row('Captured', (s) => s.captures)}
        ${row('Kills', (s) => s.kills)}
        ${row('Smites', (s) => s.smites)}
        ${row('Peak army', (s) => s.peakArmy)}
      </div>
      <div class="orbs">
        ${orb('b-menu', '🏠', 'MENU', 'small')}
        ${orb('b-rematch', '↻', 'REMATCH', 'primary', players.length > 2 ? 'all must agree' : 'both must agree')}
      </div>
    </div>`;
  },
};

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
