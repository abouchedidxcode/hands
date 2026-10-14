// Automated play-test + screenshots in headless Chromium with synthetic hands.
// Usage: node scripts/shoot.mjs [url] [outdir]
// Needs a running dev server (npx vite --port 5173).
import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || 'shots';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const wait = (ms) => page.waitForTimeout(ms);
// wait until the game has rendered n more frames (software GL is slow)
const frames = async (n = 2) => {
  const start = await page.evaluate(() => window.__godhand?.frameCount ?? 0);
  await page.waitForFunction((t) => (window.__godhand?.frameCount ?? 0) >= t, start + n, { timeout: 60000 });
};
const ff = (sec) => page.evaluate((s) => window.__godhand.fastForward(s), sec);
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

await page.goto(url);
await wait(2500);
await shot('01-boot');
await page.click('#b-start');
await wait(4000);
await shot('02-after-start');
const st = await page.evaluate(() => window.__godhand.state);
console.log('state after start:', st);

// hand helpers (screen space 0..1)
const hand = (x, y, extra = {}) => ({ present: true, x, y, ...extra });
const inject = async (hands, n = 2) => { await page.evaluate((h) => window.__godhand.input.inject(h), hands); await frames(n); };
const screenOf = (id) => page.evaluate((id) => {
  const g = window.__godhand; const b = g.world.sim.bases[id];
  const v = g.stage.worldToScreen({ x: b.x, y: 0.3, z: b.z, clone() { return this; } , project(){} });
  return v;
}, id);

await inject([hand(0.5, 0.5, { open: true, gesture: 'open' })]);
await wait(1500);
await shot('03-hand-raised');
console.log('state:', await page.evaluate(() => window.__godhand.state));

// jump to level 3 directly
await page.evaluate(() => { const g = window.__godhand; g.unlockAll(); g.startLevel(3); g.skipCountdown(); });
await frames(3);
await ff(4);
await frames(2);
await shot('04-level3-start');

// pinch-drag from player castle (base 0) to nearest neutral
const plan = await page.evaluate(() => {
  const g = window.__godhand; const sim = g.world.sim; const THREE_V = g.stage.camera.position.constructor;
  const s = (b) => { const v = new THREE_V(b.x, 0.3, b.z); const p = g.stage.worldToScreen(v); return { x: p.x, y: p.y }; };
  const me = sim.bases[0];
  const tgt = sim.bases.filter((b) => b.owner === -1).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  return { from: s(me), to: s(tgt), tid: tgt.id };
});
console.log('plan', JSON.stringify(plan));
await inject([hand(plan.from.x, plan.from.y)]);
await wait(300);
await inject([hand(plan.from.x, plan.from.y, { pinch: true })]);
await wait(200);
for (let k = 1; k <= 10; k++) {
  const t = k / 10;
  await inject([hand(plan.from.x + (plan.to.x - plan.from.x) * t, plan.from.y + (plan.to.y - plan.from.y) * t, { pinch: true })]);
  await wait(60);
}
await shot('05-dragging');
await inject([hand(plan.to.x, plan.to.y, { pinch: false })]);
await ff(1.2); await frames(2);
await shot('06-marching');
await ff(8); await frames(2);
await shot('07-later');
// smite on an enemy base
const enemy = await page.evaluate(() => {
  const g = window.__godhand; const sim = g.world.sim; const V = g.stage.camera.position.constructor;
  const b = sim.bases.find((b) => b.owner === 1); const p = g.stage.worldToScreen(new V(b.x, 0.3, b.z)); return { x: p.x, y: p.y };
});
await inject([hand(enemy.x, enemy.y, { fist: true, gesture: 'fist' })]);
await inject([hand(enemy.x, enemy.y, { fist: true, gesture: 'fist' })], 3);
await page.evaluate(() => { const c = window.__godhand.commander.ctl[0]; c.chargeT = 1; });
await inject([hand(enemy.x, enemy.y, { fist: true, gesture: 'fist' })], 2);
await shot('08-charging');
await inject([hand(enemy.x, enemy.y, { open: true, gesture: 'open' })]);
await frames(1);
await shot('09-smite');
await frames(3);
await shot('10-smite-after');
await inject([]);
await ff(25); await frames(3);
await shot('11-battle-15s');
console.log('state:', await page.evaluate(() => window.__godhand.state));
console.log('ERRORS:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
