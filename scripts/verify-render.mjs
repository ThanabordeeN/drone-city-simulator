/**
 * Dev utility: verify the simulator is actually drawing a city.
 *
 * A screenshot is captured and then decoded *inside the browser* (2D canvas) so
 * we can assert on real pixel statistics without a PNG decoder dependency:
 *
 *   - the frame is not a single flat colour (i.e. not a blank canvas)
 *   - there is meaningful colour variety (sky + buildings + ground)
 *   - the top third differs from the bottom third (sky vs street)
 *
 * Usage:
 *   node scripts/verify-render.mjs [--url http://127.0.0.1:5173] [--out ./.screenshots]
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const baseUrl = args.get('--url') ?? process.env.DRONE_SIM_URL ?? 'http://127.0.0.1:5173';
const outDir = path.resolve(args.get('--out') ?? '.screenshots');

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

let failures = 0;

try {
  for (const shot of [
    { name: 'chase', query: '?seed=12345&camera=chase', settleMs: 3000 },
    { name: 'fpv', query: '?seed=12345&camera=fpv', settleMs: 1500, fly: true },
    { name: 'free', query: '?seed=12345&camera=free', settleMs: 2500 },
    { name: 'debug-panel', query: '?seed=12345&debug=1', settleMs: 2500 },
  ]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${baseUrl}/${shot.query}`);
    await page.evaluate(() => window.__DRONE_SIM__.ready());

    if (shot.fly) {
      await page.evaluate(() => {
        const sim = window.__DRONE_SIM__;
        sim.pause();
        sim.setInput({ vertical: 1, pitch: 1 });
        sim.step(300);
        sim.clearInput();
        sim.resume();
      });
    }

    await page.waitForTimeout(shot.settleMs);

    const buffer = await page.screenshot();
    const file = path.join(outDir, `${shot.name}.png`);
    await writeFile(file, buffer);

    // Decode the screenshot inside the browser and compute statistics.
    const stats = await page.evaluate(async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);

      const colors = new Set();
      let sum = 0;
      let sumSq = 0;
      let topSum = 0;
      let topCount = 0;
      let bottomSum = 0;
      let bottomCount = 0;
      const top = { r: 0, g: 0, b: 0, n: 0 };
      const bottom = { r: 0, g: 0, b: 0, n: 0 };
      const topBandEnd = image.height * 0.15;
      const bottomBandStart = image.height * 0.85;
      const half = image.height / 2;

      for (let y = 0; y < image.height; y += 2) {
        for (let x = 0; x < image.width; x += 2) {
          const i = (y * image.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
          sum += lum;
          sumSq += lum * lum;
          if (y < half) {
            topSum += lum;
            topCount += 1;
          } else {
            bottomSum += lum;
            bottomCount += 1;
          }
          if (y < topBandEnd) {
            top.r += r;
            top.g += g;
            top.b += b;
            top.n += 1;
          } else if (y >= bottomBandStart) {
            bottom.r += r;
            bottom.g += g;
            bottom.b += b;
            bottom.n += 1;
          }
        }
      }

      const count = topCount + bottomCount;
      const mean = sum / count;
      const variance = sumSq / count - mean * mean;
      return {
        distinctColors: colors.size,
        meanLuminance: mean,
        stdDevLuminance: Math.sqrt(Math.max(0, variance)),
        topMean: topSum / topCount,
        bottomMean: bottomSum / bottomCount,
        sky: { r: top.r / top.n, g: top.g / top.n, b: top.b / top.n },
        street: { r: bottom.r / bottom.n, g: bottom.g / bottom.n, b: bottom.b / bottom.n },
        metrics: window.__DRONE_SIM__.getMetrics(),
      };
    }, `data:image/png;base64,${buffer.toString('base64')}`);

    // The sky gradient is blue-dominant at the top of the frame; the street
    // below is desaturated grey/beige. That pair is a strong "we rendered a
    // city, not a blank canvas" signal.
    const skyIsBlue = stats.sky.b > stats.sky.r + 10;
    const streetIsNotBlue = stats.street.b <= stats.street.r + 30;

    const checks = [
      ['distinct colours > 150', stats.distinctColors > 150],
      ['luminance stddev > 8', stats.stdDevLuminance > 8],
      ['top band is sky-blue', skyIsBlue],
      ['bottom band is not sky', streetIsNotBlue],
      ['draw calls in 1..60', stats.metrics.drawCalls > 0 && stats.metrics.drawCalls < 60],
      ['triangles > 5000', stats.metrics.triangles > 5000],
      ['building count >= 600', stats.metrics.buildingCount >= 600],
    ];

    const failed = checks.filter(([, ok]) => !ok);
    failures += failed.length;

    console.log(
      `${failed.length === 0 ? 'PASS' : 'FAIL'} ${shot.name.padEnd(12)} ` +
        `colors=${stats.distinctColors} stddev=${stats.stdDevLuminance.toFixed(1)} ` +
        `skyRGB=${stats.sky.r.toFixed(0)},${stats.sky.g.toFixed(0)},${stats.sky.b.toFixed(0)} ` +
        `streetRGB=${stats.street.r.toFixed(0)},${stats.street.g.toFixed(0)},${stats.street.b.toFixed(0)} ` +
        `draws=${stats.metrics.drawCalls} tris=${stats.metrics.triangles} ` +
        `buildings=${stats.metrics.buildingCount}\n     -> ${file}`,
    );
    for (const [label] of failed) console.log(`     ✗ ${label}`);

    await page.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} render check(s) failed`);
  process.exit(1);
}
console.log('\nAll render checks passed.');
