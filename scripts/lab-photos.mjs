// Feeds still hand photos (as fake webcams) through MediaPipe + the gesture engine in the Gesture Lab.
// Usage: node scripts/lab-photos.mjs http://localhost:4311/ dir-of-y4m [shotsDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [url, dir, shots] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.y4m'));
for (const f of files) {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(dir, f)}`],
  });
  const page = await b.newPage({ viewport: { width: 1200, height: 700 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(url + 'lab.html', { waitUntil: 'domcontentloaded' });
  await page.click('#b-start');
  let res = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    res = await page.evaluate(() => window.__lab.frame.hands.map((h) => ({
      hand: h.handedness, pose: h.pose, conf: +h.confidence.toFixed(2),
      top: Object.entries(h.scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' '),
      curl: h.features.curl.map((c) => c.toFixed(2)).join(' '), tOut: h.features.thumbOut.toFixed(2), facing: h.features.facing.toFixed(2),
    })));
    if (res.length && res.every((h) => h.pose)) { await page.waitForTimeout(1500); break; }
  }
  res = await page.evaluate(() => window.__lab.frame.hands.map((h) => ({
    hand: h.handedness, pose: h.pose, conf: +h.confidence.toFixed(2),
    top: Object.entries(h.scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' '),
    curl: h.features.curl.map((c) => c.toFixed(2)).join(' '), tOut: h.features.thumbOut.toFixed(2), facing: h.features.facing.toFixed(2),
  })));
  console.log(f.replace('.y4m', '').padEnd(12), JSON.stringify(res));
  if (shots) await page.screenshot({ path: path.join(shots, f.replace('.y4m', '.png')) });
  await b.close();
}
