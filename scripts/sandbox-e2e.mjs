// Performs every sandbox gesture with synthetic hands (through the real gesture engine) and checks
// that its action fires. Usage: node scripts/sandbox-e2e.mjs http://localhost:4311/ [shotsDir]
import { chromium } from 'playwright';
const [url, shots] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url + 'sandbox.html' + (shots ? '' : '?lowres'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__sandbox && window.__sandbox.frameCount > 2, null, { timeout: 60000 });
await page.click('#b-mouse');

// in-page helpers: poses, palm-centred placement, clip builders
await page.evaluate(() => {
  const S = window.__sandbox;
  const P = {
    open: { curl: [0, 0, 0, 0, 0], pinch: 0 }, fist: { curl: [1, 1, 1, 1, 1], pinch: 0 },
    pinch: { curl: [0, 0.5, 0.35, 0.4, 0.45], pinch: 1 }, middle: { curl: [1, 1, 0, 1, 1], pinch: 0 },
    victory: { curl: [1, 0, 0, 1, 1], pinch: 0, spread: 3 }, gun: { curl: [0, 0, 1, 1, 1], pinch: 0 },
    point: { curl: [1, 0, 1, 1, 1], pinch: 0 }, rock: { curl: [1, 0, 1, 1, 0], pinch: 0 },
    up: { curl: [0, 1, 1, 1, 1], pinch: 0, roll: -Math.PI / 2 }, down: { curl: [0, 1, 1, 1, 1], pinch: 0, roll: Math.PI / 2 },
  };
  // a hand whose PALM CENTRE (what the sandbox uses as the cursor) sits at camera coords (x, y)
  const hand = (x, y, pose, o = {}) => {
    let h = S.fake(x, y, pose, o);
    const L = h.landmarks, c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + L[i].x / 5, y: a.y + L[i].y / 5 }), { x: 0, y: 0 });
    return S.fake(x + (x - c.x), y + (y - c.y), pose, o);
  };
  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i, n));
  window.__t = { S, P, hand, rep, gap: () => S.feed(rep(12, () => [])) };
});

const results = [];
async function check(id, fn) {
  const before = await page.evaluate((id) => window.__sandbox.counts[id] ?? 0, id);
  await page.evaluate(fn);
  const after = await page.evaluate((id) => window.__sandbox.counts[id] ?? 0, id);
  const ok = after > before;
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}`);
  await page.waitForTimeout(300);
}

// 1-2 grab a crate, carry it, throw it
await check('grab', () => {
  const { S, P, hand, rep, gap } = window.__t;
  gap();
  const crate = S.pg.items.find((i) => i.kind === 'crate');
  const a = S.aimAt(crate.body.position.x, crate.body.position.z);
  window.__aim = a;
  S.feed(rep(8, () => [hand(a.x, a.y, P.open)]));
  S.feed(rep(8, () => [hand(a.x, a.y, P.fist)]));
});
console.log('   holding:', await page.evaluate(() => window.__sandbox.hands.map((h) => h.held)));
await check('throw', () => {
  const { P, hand, rep, S } = window.__t;
  const a = window.__aim;
  S.feed(rep(6, (i) => [hand(a.x + i * 0.02, a.y, P.fist)]));
  S.feed(rep(6, (i) => [hand(a.x + 0.12 + i * 0.05, a.y, i < 2 ? P.fist : P.open)]));
});
await check('ball', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed([...rep(8, () => [hand(0.5, 0.5, P.open)]), ...rep(4, () => [hand(0.5, 0.5, P.pinch)]), ...rep(10, () => [hand(0.5, 0.5, P.open)])]); });
await check('crate', () => {
  const { P, hand, rep, S, gap } = window.__t; gap();
  S.feed([...rep(8, () => [hand(0.55, 0.45, P.open)]), ...rep(4, () => [hand(0.55, 0.45, P.pinch)]), ...rep(5, () => [hand(0.55, 0.45, P.open)]),
    ...rep(4, () => [hand(0.55, 0.45, P.pinch)]), ...rep(10, () => [hand(0.55, 0.45, P.open)])]);
});
await check('tower', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.62, 0.4, P.victory)])); });
await check('lightning', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.4, 0.45, P.middle)])); });
await check('cannon', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.5, 0.7, P.gun)])); });
await check('shockwave', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(24, (i) => [hand(0.5, 0.5, P.open, { scale: 0.15 + Math.min(1, Math.max(0, (i - 6) / 9)) * 0.09 })])); });
await check('vacuum', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(24, (i) => [hand(0.5, 0.5, P.open, { scale: 0.24 - Math.min(1, Math.max(0, (i - 6) / 9)) * 0.09 })])); });
await check('tornado', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(45, (i) => { const a = (i / 30) * 2 * Math.PI; return [hand(0.5 + 0.1 * Math.cos(a), 0.5 + 0.1 * Math.sin(a), P.point)]; })); });
await check('wind', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(20, (i) => [hand(0.75 - Math.min(1, Math.max(0, (i - 6) / 8)) * 0.5, 0.5, P.open)])); });
await check('thunderclap', () => {
  const { P, hand, rep, S, gap } = window.__t; gap();
  S.feed(rep(18, (i) => { const d = 0.25 - Math.min(1, Math.max(0, (i - 6) / 6)) * 0.25; return [hand(0.5 - d, 0.5, P.open, { hd: 'Left' }), hand(0.5 + d, 0.5, P.open, { hd: 'Right' })]; }));
});
await check('meteors', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.45, 0.5, P.rock)])); });
await check('fireworks', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(12, () => [hand(0.5, 0.45, P.up)])); });
await check('camera', () => {
  const { P, hand, rep, S, gap } = window.__t; gap();
  S.feed(rep(30, (i) => { const d = 0.08 + Math.min(1, Math.max(0, (i - 8) / 12)) * 0.17; return [hand(0.5 - d, 0.5, P.pinch, { hd: 'Left' }), hand(0.5 + d, 0.5, P.pinch, { hd: 'Right' })]; }));
});
if (shots) {
  // let the physics play out for a bit in real time, then look
  await page.evaluate(() => window.__t.S.feed(window.__t.rep(10, () => [])));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/sandbox-action.png` });
}
await check('clear', () => { const { P, hand, rep, S, gap } = window.__t; gap(); S.feed(rep(36, () => [hand(0.5, 0.5, P.down)])); });

const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} gestures fired their action`);
console.log('counts', JSON.stringify(await page.evaluate(() => window.__sandbox.counts)));
if (pass !== results.length) process.exitCode = 1;
await b.close();
