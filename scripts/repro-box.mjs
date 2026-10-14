// Screenshots level 3 with a big (close-to-camera) synthetic hand in several poses.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4311/';
const out = process.argv[3] || '.';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url + '?lowres', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__godhand.unlockAll?.(); });
const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__godhand.frameCount);
  await page.waitForFunction((t) => window.__godhand.frameCount >= t, s + n, { timeout: 120000 });
};
await page.evaluate(() => window.__godhand.startLevel(3));
await frames(3);
await page.evaluate(() => window.__godhand.skipCountdown());
await frames(3);
const inject = async (h, n = 4) => { await page.evaluate((x) => window.__godhand.input.inject(x), h); await frames(n); };
for (const [name, o] of [
  ['open-small', { open: true, gesture: 'open', palmSize: 0.14 }],
  ['open-big', { open: true, gesture: 'open', palmSize: 0.35 }],
  ['fist-big', { fist: true, gesture: 'fist', palmSize: 0.35 }],
  ['middle-big', { middle: true, gesture: 'middle', palmSize: 0.35 }],
]) {
  await inject([{ present: true, x: 0.3, y: 0.55, ...o }], 6);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, JSON.stringify(await page.evaluate(() => window.__godhand.commander?.modes ?? null)));
}
await browser.close();
