// Two headless browsers play an online duel through a private room.
// Usage: node scripts/net-e2e.mjs http://localhost:4190/ outdir
import { chromium } from 'playwright';
import fs from 'node:fs';
const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'shots';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const code = 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
const pages = [];
for (let i = 0; i < 2; i++) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`[${i}] pageerror`, e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${i}] err`, m.text().slice(0, 200)); });
  await p.goto(url + '?lowres&nettest&norender', { waitUntil: 'domcontentloaded' });
  pages.push(p);
}
await pages[0].waitForTimeout(1500);
for (const p of pages) await p.click('#b-start');
await pages[0].waitForTimeout(2500);
const quick = process.argv[4] === 'quick';
for (const p of pages) await p.evaluate(([c, q]) => { const g = window.__godhand; g.unlockAll(); g.setState('menu'); if (q) g.quickMatch(); else g.joinRoom(c); }, [code, quick]);
const t0 = Date.now();
for (let k = 0; k < 40; k++) {
  await pages[0].waitForTimeout(2000);
  const st = await Promise.all(pages.map((p) => p.evaluate(() => { const g = window.__godhand; return { s: g.state, net: !!g.net, started: g.net?.started, host: g.net?.host, peers: g.net?.channel.peers().length }; })));
  console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(st));
  if (st.every((x) => x.s === 'countdown' || x.s === 'play')) {
    // software GL runs at <1 fps here, so skip the 3-2-1 countdown
    for (const p of pages) await p.evaluate(() => { if (window.__godhand.state === 'countdown') window.__godhand.skipCountdown(); });
    break;
  }
}
await Promise.all(pages.map((p) => p.waitForFunction(() => window.__godhand.state === 'play', null, { timeout: 240000 })));
console.log('both playing after', ((Date.now() - t0) / 1000).toFixed(1), 's');
const roles = await Promise.all(pages.map((p) => p.evaluate(() => window.__godhand.online)));
console.log('roles', roles);
const guest = pages[roles.indexOf('guest')], host = pages[roles.indexOf('host')];
// guest sends troops from its capital (base 1) to the nearest neutral via the sim API
const sent = await guest.evaluate(() => {
  const g = window.__godhand, sim = g.world.sim, me = sim.bases[1];
  const t = sim.bases.filter((b) => b.owner === -1).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  return { n: sim.send([1], t.id, 1), to: t.id };
});
console.log('guest send', sent);
await host.waitForTimeout(8000);
const hostView = await host.evaluate(() => { const s = window.__godhand.world.sim; return { units1: s.units.filter((u) => u.faction === 1).length, t: s.time.toFixed(1), cap1: s.bases[1].troops.toFixed(1) }; });
const guestView = await guest.evaluate(() => { const s = window.__godhand.world.sim; return { units1: s.units.filter((u) => u.faction === 1).length, t: s.time.toFixed(1), cap1: s.bases[1].troops.toFixed(1) }; });
console.log('host view', hostView, 'guest view', guestView);
// host smites guest's capital
await host.evaluate(() => { const s = window.__godhand.world.sim; s.manaOf[0] = 100; s.smite(s.bases[1].x, s.bases[1].z, 0); });
await host.waitForTimeout(1500);

// end: host captures everything
await host.evaluate(() => { const s = window.__godhand.world.sim; for (const b of s.bases) b.owner = 0; s.units.length = 0; s.launches.length = 0; });
await Promise.all(pages.map((p) => p.waitForFunction(() => window.__godhand.state === 'results', null, { timeout: 240000 })));
console.log('results:', await Promise.all(pages.map((p) => p.evaluate(() => window.__godhand.world.sim.winner))));

// rematch
for (const p of pages) await p.evaluate(() => document.getElementById('b-rematch').click());
await Promise.all(pages.map((p) => p.waitForFunction(() => ['countdown', 'play'].includes(window.__godhand.state), null, { timeout: 60000 })));
console.log('rematch started OK');
await browser.close();
