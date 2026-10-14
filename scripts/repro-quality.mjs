// Retina-like screen (DPR 2): screenshot a level before and after the adaptive-quality drop.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4311/';
const out = process.argv[3] || '.';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__godhand.frameCount);
  await page.waitForFunction((t) => window.__godhand.frameCount >= t, s + n, { timeout: 180000 });
};
await page.evaluate(() => { window.__godhand.unlockAll(); window.__godhand.startLevel(3); window.__godhand.skipCountdown(); });
await frames(3);
await page.screenshot({ path: `${out}/q0.png` });
for (const lv of [1, 2]) {
  await page.evaluate((l) => window.__godhand.stage.setQuality(l), lv);
  await frames(3);
  await page.screenshot({ path: `${out}/q${lv}.png` });
}
console.log(await page.evaluate(() => { const s = window.__godhand.stage; return { pr: s.renderer.getPixelRatio(), cw: s.renderer.domElement.width, comp: s.composer._pixelRatio, rt: s.composer.renderTarget1.width }; }));
await browser.close();
