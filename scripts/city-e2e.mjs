// City Smash: performs every gesture power with synthetic hands (through the real gesture engine)
// and checks that the power fires and, for destructive ones, that the city takes damage.
// Usage: node scripts/city-e2e.mjs http://localhost:4311/ [shotsDir]
import { chromium } from 'playwright';
const [url, shots] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url + 'sandbox.html?mode=city' + (shots ? '' : '&lowres'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__sandbox && window.__sandbox.frameCount > 2, null, { timeout: 90000 });
await page.click('#b-mouse');

await page.evaluate(() => {
  const S = window.__sandbox;
  const P = {
    open: { curl: [0, 0, 0, 0, 0], pinch: 0 }, fist: { curl: [1, 1, 1, 1, 1], pinch: 0 },
    pinch: { curl: [0, 0.5, 0.35, 0.4, 0.45], pinch: 1 }, middle: { curl: [1, 1, 0, 1, 1], pinch: 0 },
    victory: { curl: [1, 0, 0, 1, 1], pinch: 0, spread: 3 }, gun: { curl: [0, 0, 1, 1, 1], pinch: 0 },
    point: { curl: [1, 0, 1, 1, 1], pinch: 0 }, rock: { curl: [1, 0, 1, 1, 0], pinch: 0 },
    up: { curl: [0, 1, 1, 1, 1], pinch: 0, roll: -Math.PI / 2 }, down: { curl: [0, 1, 1, 1, 1], pinch: 0, roll: Math.PI / 2 },
  };
  const hand = (x, y, pose, o = {}) => {
    const h = S.fake(x, y, pose, o);
    const L = h.landmarks, c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + L[i].x / 5, y: a.y + L[i].y / 5 }), { x: 0, y: 0 });
    return S.fake(x + (x - c.x), y + (y - c.y), pose, o);
  };
  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i, n));
  // camera coords that put the giant palm over the tallest standing building
  const aimTall = () => {
    const live = S.city.buildings.filter((x) => x.alive);
    const bld = live.sort((a, z) => Math.max(...z.cols.map((c) => c.h)) - Math.max(...a.cols.map((c) => c.h)))[0];
    return S.aimAt(bld.x, bld.z);
  };
  window.__t = { S, P, hand, rep, aimTall, gap: () => S.feed(rep(12, () => [])) };
});

const results = [];
async function check(id, fn, opts = {}) {
  const before = await page.evaluate((id) => ({ n: window.__sandbox.counts[id] ?? 0, d: window.__sandbox.debug().destroyed }), id);
  await page.evaluate(fn);
  if (opts.advance) await page.evaluate((s) => window.__sandbox.advance(s), opts.advance);
  const after = await page.evaluate((id) => ({ n: window.__sandbox.counts[id] ?? 0, d: window.__sandbox.debug().destroyed, dbg: window.__sandbox.debug() }), id);
  const fired = after.n > before.n;
  const damaged = after.d > before.d;
  const ok = fired && (!opts.destroys || damaged);
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(10)} fired=${fired} destroyed +${after.d - before.d}${opts.destroys && !damaged ? '  (expected damage!)' : ''}`);
  return after.dbg;
}

// grab: rip the tallest building out of the ground
const g = await check('grab', () => {
  const { S, P, hand, rep, gap, aimTall } = window.__t;
  gap();
  const a = aimTall();
  window.__aim = a;
  S.feed(rep(8, () => [hand(a.x, a.y, P.open)]));
  S.feed(rep(8, () => [hand(a.x, a.y, P.fist)]));
  S.advance(0.5);
}, { destroys: true });
console.log('   holding:', JSON.stringify(g.hands.map((h) => h.held)));
await check('hurl', () => {
  const { P, hand, rep, S } = window.__t;
  const a = window.__aim;
  S.feed(rep(6, (i) => [hand(a.x + i * 0.02, a.y, P.fist)]));
  S.feed(rep(6, (i) => [hand(a.x + 0.12 + i * 0.05, a.y, i < 2 ? P.fist : P.open)]));
}, { advance: 2.5 });
await check('bomb', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed([...rep(8, () => [hand(a.x, a.y, P.open)]), ...rep(4, () => [hand(a.x, a.y, P.pinch)]), ...rep(8, () => [hand(a.x, a.y, P.open)])]); }, { advance: 2.5, destroys: true });
await check('cluster', () => {
  const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall();
  S.feed([...rep(8, () => [hand(a.x, a.y, P.open)]), ...rep(4, () => [hand(a.x, a.y, P.pinch)]), ...rep(5, () => [hand(a.x, a.y, P.open)]), ...rep(4, () => [hand(a.x, a.y, P.pinch)]), ...rep(8, () => [hand(a.x, a.y, P.open)])]);
}, { advance: 2.5 });
await check('laser', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(10, () => [hand(a.x, a.y + 0.06, P.point)])); }, { advance: 2, destroys: true });
await check('rockets', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(10, () => [hand(0.5, 0.62, P.gun)])); }, { advance: 2, destroys: true });
await check('lightning', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(10, () => [hand(a.x, a.y + 0.06, P.middle)])); }, { advance: 0.5 });
await check('slam', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(24, (i) => [hand(a.x, a.y, P.open, { scale: 0.15 + Math.min(1, Math.max(0, (i - 6) / 9)) * 0.09 })])); }, { advance: 0.6, destroys: true });
await check('blackhole', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(24, (i) => [hand(a.x, a.y, P.open, { scale: 0.24 - Math.min(1, Math.max(0, (i - 6) / 9)) * 0.09 })])); }, { advance: 5, destroys: true });
await check('tornado', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(45, (i) => { const a = (i / 30) * 2 * Math.PI; return [hand(0.5 + 0.1 * Math.cos(a), 0.45 + 0.1 * Math.sin(a), P.point)]; })); }, { advance: 3, destroys: true });
await check('hurricane', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(20, (i) => [hand(0.75 - Math.min(1, Math.max(0, (i - 6) / 8)) * 0.5, 0.5, P.open)])); }, { advance: 0.5 });
await check('boom', () => {
  const { P, hand, rep, S, gap } = window.__t; gap();
  S.feed(rep(18, (i) => { const d = 0.25 - Math.min(1, Math.max(0, (i - 6) / 6)) * 0.25; return [hand(0.5 - d, 0.5, P.open, { hd: 'Left' }), hand(0.5 + d, 0.5, P.open, { hd: 'Right' })]; }));
}, { advance: 0.5 });
await check('meteors', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(12, () => [hand(a.x, a.y, P.rock)])); }, { advance: 4, destroys: true });
await check('ufo', () => { const { P, hand, rep, S, gap, aimTall } = window.__t; gap(); const a = aimTall(); S.feed(rep(12, () => [hand(a.x, a.y, P.victory)])); }, { advance: 9, destroys: true });
await check('airstrike', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.5, 0.45, P.up)])); }, { advance: 3, destroys: true });
await check('quake', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(45, (i) => [hand(0.5, 0.5 + 0.08 * Math.sin((i / 30) * 2 * Math.PI * 2.5), P.open)])); }, { advance: 4, destroys: true });
await check('camera', () => {
  const { P, hand, rep, S, gap } = window.__t; gap();
  S.feed(rep(30, (i) => { const d = 0.08 + Math.min(1, Math.max(0, (i - 8) / 12)) * 0.17; return [hand(0.5 - d, 0.5, P.pinch, { hd: 'Left' }), hand(0.5 + d, 0.5, P.pinch, { hd: 'Right' })]; }));
});
const dbg = await page.evaluate(() => window.__sandbox.debug());
console.log('round:', JSON.stringify({ phase: dbg.phase, damage: Math.round(dbg.damage), destroyed: dbg.destroyed, total: dbg.total, leveled: dbg.leveled, cars: dbg.cars, pieces: dbg.pieces }));
if (shots) {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/city-after.png` });
}
await check('newcity', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(36, () => [hand(0.5, 0.5, P.down)])); });
const fresh = await page.evaluate(() => window.__sandbox.debug());
console.log('after new city:', JSON.stringify({ phase: fresh.phase, destroyed: fresh.destroyed, total: fresh.total, pieces: fresh.pieces }));
if (fresh.destroyed !== 0) { results.push({ id: 'newcity-reset', ok: false }); console.log('FAIL  new city did not reset'); }

const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} powers worked`);
if (pass !== results.length) process.exitCode = 1;
await b.close();
