// Real MediaPipe + gesture engine in the sandbox: each hand photo is a fake webcam; reports the
// recognised pose and which sandbox actions fired. Usage: node scripts/sandbox-photos.mjs URL dir [shots]
// (MODE=city runs it in City Smash)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [url, dir, shots] = process.argv.slice(2);
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.y4m'))) {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(dir, f)}`],
  });
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  const q = [process.env.MODE && `mode=${process.env.MODE}`, !process.env.HI && 'lowres'].filter(Boolean).join('&');
  await page.goto(url + 'sandbox.html' + (q ? '?' + q : ''), { waitUntil: 'domcontentloaded' });
  await page.click('#b-cam');
  let r = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    r = await page.evaluate(() => ({ poses: window.__sandbox.frame.hands.map((h) => h.pose), counts: { ...window.__sandbox.counts } }));
    if (Object.keys(r.counts).length) { await page.waitForTimeout(2500); break; }
  }
  r = await page.evaluate(() => ({ poses: window.__sandbox.frame.hands.map((h) => h.pose), counts: { ...window.__sandbox.counts } }));
  console.log(f.replace('.y4m', '').padEnd(12), JSON.stringify(r));
  if (shots) await page.screenshot({ path: path.join(shots, 'sb-' + f.replace('.y4m', '.png')) });
  await b.close();
}
