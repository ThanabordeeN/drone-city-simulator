/**
 * Dev utility: capture screenshots of the simulator for visual verification.
 *
 * Usage (with the dev server running on 5173):
 *   node scripts/screenshot.mjs [--out ./.screenshots] [--url http://127.0.0.1:5173]
 *
 * It also prints the render metrics so a reviewer can confirm the instanced
 * city is actually being drawn.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const baseUrl = args.get('--url') ?? process.env.DRONE_SIM_URL ?? 'http://127.0.0.1:5173';
const outDir = path.resolve(args.get('--out') ?? '.screenshots');

const SHOTS = [
  { name: 'chase', query: '?seed=12345&camera=chase', settleMs: 3500 },
  { name: 'fpv', query: '?seed=12345&camera=fpv', settleMs: 1200 },
  { name: 'free', query: '?seed=12345&camera=free', settleMs: 2500 },
  { name: 'debug-panel', query: '?seed=12345&debug=1', settleMs: 2500 },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${baseUrl}/${shot.query}`);

    if (shot.name === 'fpv') {
      // Fly up so the FPV view is above the rooftops.
      await page.evaluate(async () => {
        await window.__DRONE_SIM__.ready();
        const sim = window.__DRONE_SIM__;
        sim.pause();
        sim.setInput({ vertical: 1, pitch: 1 });
        sim.step(240);
        sim.clearInput();
        sim.resume();
      });
    }

    await page.waitForTimeout(shot.settleMs);

    const metrics = await page.evaluate(() => window.__DRONE_SIM__.getMetrics());
    const target = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: target });
    console.log(
      `${shot.name.padEnd(12)} -> ${target}  drawCalls=${metrics.drawCalls} triangles=${metrics.triangles} buildings=${metrics.buildingCount} fps=${metrics.fps}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
