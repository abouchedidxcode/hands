// Plays the whole tutorial with synthetic hands and checks every coach step advances.
// Usage: node scripts/tutorial-e2e.mjs http://localhost:4191/
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url + '?lowres&norender', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { localStorage.clear(); window.__godhand.resetProgress(); });
await page.click('#b-start');
const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__godhand.frameCount);
  await page.waitForFunction((t) => window.__godhand.frameCount >= t, s + n, { timeout: 60000 });
};
const inject = async (h, n = 2) => { await page.evaluate((x) => window.__godhand.input.inject(x), h); await frames(n); };
const coach = () => page.evaluate(() => document.querySelector('#coach b')?.textContent ?? '(none)');
const scr = (id) => page.evaluate((id) => {
  const g = window.__godhand, b = g.world.sim.bases[id], V = g.stage.camera.position.constructor;
  const p = g.stage.worldToScreen(new V(b.x, 0.3, b.z)); return { x: p.x, y: p.y };
}, id);
const H = (x, y, o = {}) => ({ present: true, x, y, ...o });

await page.waitForFunction(() => window.__godhand.state === 'raise', null, { timeout: 60000 });
for (let i = 0; i < 30 && (await page.evaluate(() => window.__godhand.state)) === 'raise'; i++) await inject([H(0.5, 0.5, { open: true, gesture: 'open' })]);
console.log('state', await page.evaluate(() => window.__godhand.state), '| level', await page.evaluate(() => window.__godhand.world.level.name));
await page.evaluate(() => window.__godhand.skipCountdown());
await inject([H(0.5, 0.5, { open: true, gesture: 'open' })], 3);
console.log('1', await coach());

const cap = await scr(0);
await inject([H(cap.x, cap.y)]);
await inject([H(cap.x, cap.y, { fist: true, gesture: 'fist' })]);
console.log('2', await coach());
const target = await page.evaluate(() => {
  const s = window.__godhand.world.sim, me = s.bases[0];
  return s.bases.filter((b) => b.owner === -1).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0].id;
});
const t = await scr(target);
for (let k = 1; k <= 6; k++) await inject([H(cap.x + (t.x - cap.x) * k / 6, cap.y + (t.y - cap.y) * k / 6, { fist: true, gesture: 'fist' })], 1);
await inject([H(t.x, t.y, { open: true, gesture: 'open' })]);
console.log('3', await coach());
for (let i = 0; i < 20 && (await coach()).includes('CONQUER'); i++) { await page.evaluate(() => window.__godhand.fastForward(1)); await frames(1); }
console.log('4', await coach());

// sweep: own capital -> captured village -> next neutral
const t2 = await page.evaluate((v) => {
  const s = window.__godhand.world.sim, me = s.bases[v];
  return s.bases.filter((b) => b.owner === -1).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0].id;
}, target);
const v = await scr(target), w = await scr(t2);
Object.assign(cap, await scr(0)); // camera zoom has settled since the start
await inject([H(cap.x, cap.y)], 8);
console.log('  pre', await page.evaluate(() => { const c = window.__godhand.commander.ctl[0]; return JSON.stringify({ hover: c.hover?.id, g: [c.g.x.toFixed(1), c.g.z.toFixed(1)], mode: c.mode }); }), JSON.stringify(cap));
await inject([H(cap.x, cap.y, { fist: true, gesture: 'fist' })]);
console.log('  post', await page.evaluate(() => { const c = window.__godhand.commander.ctl[0]; return JSON.stringify({ hover: c.hover?.id, sel: c.sel, mode: c.mode }); }));
for (let k = 1; k <= 5; k++) await inject([H(cap.x + (v.x - cap.x) * k / 5, cap.y + (v.y - cap.y) * k / 5, { fist: true, gesture: 'fist' })], 1);
const dbg = () => page.evaluate(() => { const c = window.__godhand.commander.ctl[0], s = window.__godhand.world.sim; return JSON.stringify({ sel: c.sel, hover: c.hover?.id, drag: c.dragging, own: s.bases.filter((b) => b.owner === 0).map((b) => [b.id, Math.floor(b.troops)]) }); });
console.log('  at v', await dbg());
for (let k = 1; k <= 5; k++) await inject([H(v.x + (w.x - v.x) * k / 5, v.y + (w.y - v.y) * k / 5, { fist: true, gesture: 'fist' })], 1);
console.log('  at w', await dbg());
await inject([H(w.x, w.y, { open: true, gesture: 'open' })]);
console.log('5', await coach());

// smite on the enemy capital: raise the middle finger and hold it briefly
const e = await scr(1); // enemy capital
for (let k = 0; k < 10; k++) await inject([H(e.x, e.y, { middle: true, gesture: 'middle' })], 1);
await inject([H(e.x, e.y, { open: true, gesture: 'open' })]);
console.log('6', await coach());

// clap: two open hands rush together
for (let tries = 0; tries < 5 && (await coach()).includes('CLAP'); tries++) {
  await inject([H(0.3, 0.5, { open: true, gesture: 'open' }), H(0.7, 0.5, { open: true, gesture: 'open' })], 2);
  await inject([H(0.4, 0.5, { open: true, gesture: 'open' }), H(0.6, 0.5, { open: true, gesture: 'open' })], 1);
  await inject([H(0.47, 0.5, { open: true, gesture: 'open' }), H(0.53, 0.5, { open: true, gesture: 'open' })], 2);
}
console.log('8', await coach());
console.log('counters', JSON.stringify(await page.evaluate(() => window.__godhand.tutorialCounters?.() ?? null)));
await browser.close();
