// Headless browsers play an online match: a duel (2) or a brawl (3), via a private room or quick match.
// Usage: node scripts/net-e2e.mjs http://localhost:4190/ outdir [private|quick] [2|3]
import { chromium } from 'playwright';
import fs from 'node:fs';
const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'shots';
const quick = process.argv[4] === 'quick';
const N = Number(process.argv[5] || 2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const code = 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`[${i}] pageerror`, e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${i}] err`, m.text().slice(0, 200)); });
  await p.goto(url + (process.env.RENDER ? '?lowres&nettest' : '?lowres&nettest&norender'), { waitUntil: 'domcontentloaded' });
  pages.push(p);
}
await pages[0].waitForTimeout(1500);
for (const p of pages) await p.click('#b-start');
await pages[0].waitForTimeout(2500);
for (const [i, p] of pages.entries()) {
  await p.evaluate(([c, q, n]) => { const g = window.__godhand; g.unlockAll(); g.setState('menu'); if (q) g.quickMatch(n); else g.joinRoom(c, n); }, [code, quick, N]);
  if (i < N - 1) await p.waitForTimeout(1500); // staggered arrivals, like real friends opening a link
}
const t0 = Date.now();
const all = (fn, arg) => Promise.all(pages.map((p) => p.evaluate(fn, arg)));
for (let k = 0; k < 60; k++) {
  await pages[0].waitForTimeout(2000);
  const st = await all(() => { const g = window.__godhand; return { s: g.state, started: g.net?.started, host: g.net?.host, me: g.net?.me, peers: g.net?.channel.peers().length }; });
  console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(st));
  if (st.every((x) => x.s === 'countdown' || x.s === 'play')) {
    // software GL runs at <1 fps here, so skip the 3-2-1 countdown
    await all(() => { if (window.__godhand.state === 'countdown') window.__godhand.skipCountdown(); });
    break;
  }
}
await Promise.all(pages.map((p) => p.waitForFunction(() => window.__godhand.state === 'play', null, { timeout: 240000 })));
console.log('all playing after', ((Date.now() - t0) / 1000).toFixed(1), 's');
const info = await all(() => { const g = window.__godhand; return { role: g.online, me: g.net.me, factions: g.world.sim.factions, bases: g.world.sim.bases.length }; });
console.log('players', JSON.stringify(info));
const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };
const mes = info.map((x) => x.me).sort();
if (JSON.stringify(mes) !== JSON.stringify([...Array(N).keys()])) fail('factions not 0..N-1: ' + mes);
if (!info.every((x) => x.factions === N && x.bases === info[0].bases)) fail('worlds differ');
const host = pages[info.findIndex((x) => x.role === 'host')];
const guests = pages.filter((_, i) => info[i].role === 'guest');

// every guest sends troops from its capital to its nearest neutral
for (const g of guests) {
  const sent = await g.evaluate(() => {
    const gh = window.__godhand, sim = gh.world.sim, f = gh.net.me, cap = sim.bases[f];
    const t = sim.bases.filter((b) => b.owner === -1).sort((a, b) => Math.hypot(a.x - cap.x, a.z - cap.z) - Math.hypot(b.x - cap.x, b.z - cap.z))[0];
    return { f, n: sim.send([f], t.id, f), to: t.id };
  });
  console.log('guest send', JSON.stringify(sent));
}
await host.waitForTimeout(6000);
const views = await all(() => { const s = window.__godhand.world.sim; return { t: s.time.toFixed(1), units: [0, 1, 2].map((f) => s.units.filter((u) => u.faction === f).length), caps: [0, 1, 2].map((f) => s.bases[f]?.troops.toFixed(0)) }; });
console.log('views', JSON.stringify(views));
const hostView = views[info.findIndex((x) => x.role === 'host')];
for (let f = 1; f < N; f++) if (hostView.units[f] === 0 && Number(hostView.caps[f]) > 40) fail(`host never applied faction ${f}'s send`);

if (process.env.LEAVE && N === 3) {
  // a player closes their tab mid-brawl: a guest leaving lets the other two fight on; the host leaving ends it
  const who = process.env.LEAVE === 'host' ? info.findIndex((x) => x.role === 'host') : info.findIndex((x) => x.role === 'guest');
  const rest = pages.filter((_, i) => i !== who);
  await pages[who].evaluate(() => window.__godhand.net.close());
  await pages[who].close();
  await rest[0].waitForTimeout(5000);
  if (process.env.LEAVE === 'host') await Promise.all(rest.map((p) => p.waitForFunction(() => window.__godhand.state === 'results', null, { timeout: 120000 }).catch(() => {})));
  const after = await Promise.all(rest.map((p) => p.evaluate(() => ({ s: window.__godhand.state, over: window.__godhand.world.sim.over, head: document.querySelector('.res-head h2')?.textContent ?? null, sub: document.querySelector('.res-head h3')?.textContent ?? null }))));
  console.log(`after ${process.env.LEAVE} left`, JSON.stringify(after));
  if (process.env.LEAVE === 'host' && !after.every((x) => x.over && x.head === 'MATCH OVER')) fail('host leaving should end the brawl for everyone');
  if (process.env.LEAVE !== 'host' && after.some((x) => x.over)) fail('a guest leaving should not end the brawl');
  console.log(process.exitCode ? 'NET E2E FAILED' : 'NET E2E PASSED');
  await browser.close();
  process.exit();
}

if (process.env.RENDER) {
  // each player shows a hand; screenshots should show the others' ghost hands in their colours
  for (const [i, p] of pages.entries()) await p.evaluate((i) => window.__godhand.input.inject([{ present: true, x: 0.3 + i * 0.2, y: 0.5, open: true, gesture: 'open' }]), i);
  await host.waitForTimeout(5000);
  for (const [i, p] of pages.entries()) await p.screenshot({ path: `${out}/net${N}-p${info[i].me}.png` });
}

if (N === 3) {
  // knock out the last guest: the other two must keep fighting
  const victim = info.length - 1 - [...info].reverse().findIndex((x) => x.role === 'guest');
  const vf = info[victim].me;
  await host.evaluate((vf) => { const s = window.__godhand.world.sim; for (const b of s.bases) if (b.owner === vf) b.owner = 0; for (const u of s.units) if (u.faction === vf) u.alive = false; s.launches.length = 0; }, vf);
  await pages[victim].waitForFunction(() => window.__godhand.state === 'results', null, { timeout: 120000 });
  const mid = await all(() => ({ s: window.__godhand.state, over: window.__godhand.world.sim.over }));
  console.log('after elimination of faction', vf, JSON.stringify(mid));
  if (mid.some((x) => x.over)) fail('brawl ended when only one player was out');
}

// end: the host captures everything
await host.evaluate(() => { const s = window.__godhand.world.sim; for (const b of s.bases) b.owner = 0; s.units.length = 0; s.launches.length = 0; });
await Promise.all(pages.map((p) => p.waitForFunction(() => window.__godhand.state === 'results' && window.__godhand.world.sim.over, null, { timeout: 240000 })));
const winners = await all(() => window.__godhand.world.sim.winner);
console.log('results winners:', winners);
if (!winners.every((w) => w === 0)) fail('winner mismatch');
const heads = await all(() => document.querySelector('.res-head h2')?.textContent);
console.log('headings', heads);

// rematch: everyone must agree
for (const p of pages) await p.evaluate(() => document.getElementById('b-rematch').click());
await Promise.all(pages.map((p) => p.waitForFunction(() => ['countdown', 'play'].includes(window.__godhand.state), null, { timeout: 60000 })));
const re = await all(() => ({ f: window.__godhand.world.sim.factions, seed: window.__godhand.world.level.map.seed }));
console.log('rematch started OK', JSON.stringify(re));
if (new Set(re.map((r) => r.seed)).size !== 1) fail('rematch seeds differ');
console.log(process.exitCode ? 'NET E2E FAILED' : 'NET E2E PASSED');
await browser.close();
