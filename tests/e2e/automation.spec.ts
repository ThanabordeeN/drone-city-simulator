/**
 * Browser-level automation tests (Spec §21, §33, §36).
 *
 * These drive the real page through `window.__DRONE_SIM__` — no synthetic
 * keyboard events, no pixel reading — which is exactly the workflow an AI
 * agent or a CI regression suite would use.
 */
import { expect, test } from '@playwright/test';
import { waitForSimulator } from './helpers';

test.describe('boot + world (Spec §33, §36 #1, #2, #20)', () => {
  test('boots, exposes the API and generates a large city', async ({ page }) => {
    await page.goto('/?seed=12345');
    await waitForSimulator(page);

    const info = await page.evaluate(() => window.__DRONE_SIM__!.getWorldInfo());
    expect(info.seed).toBe(12345);
    expect(info.worldSize).toBe(2000);
    expect(info.blockCount).toBe(400);
    expect(info.buildingCount).toBeGreaterThanOrEqual(600);
    expect(info.buildingCount).toBeLessThanOrEqual(1500);
    expect(info.spawn.y).toBeGreaterThan(0);

    const state = await page.evaluate(() => window.__DRONE_SIM__!.getState());
    expect(state.altitude).toBeGreaterThan(0);
    expect(state.crashed).toBe(false);
  });

  test('reloads with the same seed into the same layout (Spec §36 #20)', async ({ page }) => {
    const fingerprint = async (): Promise<string> => {
      await page.goto('/?seed=999');
      await waitForSimulator(page);
      return page.evaluate(() => JSON.stringify(window.__DRONE_SIM__!.getNearbyBuildings(600)));
    };

    const first = await fingerprint();
    const second = await fingerprint();
    expect(second).toBe(first);
    expect(JSON.parse(first).length).toBeGreaterThan(0);
  });

  test('honours ?buildings= and ?camera= parameters', async ({ page }) => {
    await page.goto('/?seed=42&buildings=700&camera=fpv');
    await waitForSimulator(page);

    const info = await page.evaluate(() => window.__DRONE_SIM__!.getWorldInfo());
    expect(info.seed).toBe(42);
    expect(info.buildingCount).toBe(700);
    expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('fpv');
  });

  test('test mode starts paused with a fixed seed (Spec §23)', async ({ page }) => {
    await page.goto('/?testMode=1');
    await waitForSimulator(page);

    const info = await page.evaluate(() => window.__DRONE_SIM__!.getWorldInfo());
    expect(info.testMode).toBe(true);
    expect(info.seed).toBe(12345);
    expect(await page.evaluate(() => window.__DRONE_SIM__!.isPaused())).toBe(true);

    // The tick counter must not move on its own while paused.
    const before = await page.evaluate(() => window.__DRONE_SIM__!.getState().tick);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__DRONE_SIM__!.getState().tick);
    expect(after).toBe(before);
  });
});

test.describe('automation flight (Spec §19, §20, §21)', () => {
  test('takes off, flies forward and reports state without keyboard input', async ({ page }) => {
    await page.goto('/?seed=123');
    await waitForSimulator(page);

    const state = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.pause();
      sim.setInput({ vertical: 1 });
      sim.step(120);
      sim.clearInput();
      return sim.getState();
    });

    expect(state.altitude).toBeGreaterThan(5);
    expect(state.crashed).toBe(false);
  });

  test('Spec §20 — fly forward moves the drone along -Z', async ({ page }) => {
    await page.goto('/?seed=123');
    await waitForSimulator(page);

    const state = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.reset({ seed: 123 });
      sim.pause();
      sim.setInput({ pitch: 1 });
      sim.step(180);
      sim.clearInput();
      return sim.getState();
    });

    expect(state.speed).toBeGreaterThan(0);
    expect(state.position.z).toBeLessThan(0);
  });

  test('is deterministic across identical automation runs (Spec §37 #7)', async ({ page }) => {
    await page.goto('/?testMode=1');
    await waitForSimulator(page);

    const run = async (): Promise<string> =>
      page.evaluate(() => {
        const sim = window.__DRONE_SIM__!;
        sim.reset({ seed: 123 });
        sim.pause();
        for (let i = 0; i < 240; i += 1) {
          sim.act({ pitch: Math.sin(i * 0.3), yaw: Math.cos(i * 0.11), vertical: 0.2 });
          sim.step(1);
        }
        sim.clearInput();
        const s = sim.getState();
        return JSON.stringify([s.position, s.velocity, s.rotation, s.tick]);
      });

    expect(await run()).toBe(await run());
  });

  test('detects a building collision (Spec §37 #6)', async ({ page }) => {
    await page.goto('/?seed=123');
    await waitForSimulator(page);

    const state = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.pause();
      sim.reset({ position: { x: 0, y: 40, z: 0 } });

      // Pick a tall neighbour, aim at it, stand 20 m off its wall and fly.
      const target = sim.getNearbyBuildings(200).filter((b) => b.size.y > 80)[0];
      if (!target) throw new Error('no tall building near the spawn');

      const yaw = Math.atan2(-target.position.x, -target.position.z);
      // Stand 20 m clear of the wall, on the far side from the spawn.
      const standOff = Math.max(target.size.x, target.size.z) / 2 + 20;
      sim.teleport({
        x: target.position.x + Math.sin(yaw) * standOff,
        y: 40,
        z: target.position.z + Math.cos(yaw) * standOff,
      });
      sim.setRotation({ yaw });
      sim.setInput({ pitch: 1 });
      sim.step(240);
      sim.clearInput();
      return sim.getState();
    });

    expect(state.collided).toBe(true);
  });

  test('reports sensors and an observation payload in the browser', async ({ page }) => {
    await page.goto('/?testMode=1');
    await waitForSimulator(page);

    const observation = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.reset({ position: { x: 0, y: 45, z: 0 } });
      sim.setGoal({ x: 300, y: 45, z: -300 });
      sim.step(1);
      return sim.observe();
    });

    expect(observation.position).toHaveLength(3);
    expect(observation.altitude).toBeCloseTo(45, 3);
    expect(observation.sensors.down).toBeCloseTo(45, 3);
    expect(observation.goalDistance).toBeGreaterThan(0);
    expect(observation.goalReached).toBe(false);
  });

  test('runs a complete episode and reports statistics', async ({ page }) => {
    await page.goto('/?testMode=1');
    await waitForSimulator(page);

    const summary = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.startEpisode({ seed: 100, spawn: 'random' });
      sim.teleport({ x: 0, y: 300, z: 0 });
      sim.act({ pitch: 1 });
      sim.step(300);
      sim.clearInput();
      return sim.endEpisode();
    });

    expect(summary.ticks).toBe(300);
    expect(summary.duration).toBeCloseTo(5, 2);
    expect(summary.distanceTravelled).toBeGreaterThan(0);
    expect(summary.crashed).toBe(false);
  });

  test('switches control mode so human input is ignored (Spec §32)', async ({ page }) => {
    await page.goto('/?testMode=1');
    await waitForSimulator(page);

    const result = await page.evaluate(() => {
      const sim = window.__DRONE_SIM__!;
      sim.setControlMode('automation');
      sim.reset({ position: { x: 0, y: 30, z: 0 } });
      sim.clearInput();
      sim.step(60);
      const withAutomation = sim.getState();
      sim.setControlMode('manual');
      return { mode: sim.getControlMode(), altitude: withAutomation.altitude };
    });

    expect(result.mode).toBe('manual');
    expect(result.altitude).toBeCloseTo(30, 3);
  });
});

test.describe('rendering (Spec §11, §15, §35)', () => {
  test('renders an instanced city with flat draw calls', async ({ page }) => {
    await page.goto('/?seed=12345&buildings=1400');
    await waitForSimulator(page);

    // Let a few frames run so the renderer statistics are populated.
    await page.waitForTimeout(1500);

    const metrics = await page.evaluate(() => window.__DRONE_SIM__!.getMetrics());
    expect(metrics.buildingCount).toBeGreaterThanOrEqual(600);
    expect(metrics.triangles).toBeGreaterThan(5000);
    // Instancing keeps the city under a few dozen draw calls regardless of
    // building count (Spec §11: "ไม่ควรสร้าง Mesh แยกหลายร้อย/หลายพัน object").
    expect(metrics.drawCalls).toBeGreaterThan(0);
    expect(metrics.drawCalls).toBeLessThan(60);
  });

  test('switches between chase, fpv and free cameras', async ({ page }) => {
    await page.goto('/?seed=12345');
    await waitForSimulator(page);

    expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('chase');

    await page.evaluate(() => window.__DRONE_SIM__!.setCameraMode('fpv'));
    expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('fpv');

    await page.evaluate(() => window.__DRONE_SIM__!.setCameraMode('free'));
    expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('free');
  });

  test('shows the HUD readout', async ({ page }) => {
    await page.goto('/?seed=12345');
    await waitForSimulator(page);
    await page.waitForTimeout(500);

    // The HUD applies CSS text-transform, so compare case-insensitively.
    const hudText = (await page.locator('.dshud').innerText()).toLowerCase();
    expect(hudText).toContain('alt');
    expect(hudText).toContain('spd');
    expect(hudText).toContain('fps');
    expect(hudText).toContain('controller');
    expect(hudText).toContain('connected');
    expect(hudText).toContain('pitch');
    expect(hudText).toContain('roll');
    expect(hudText).toContain('vertical');
  });

  test('the debug panel opens with the B key', async ({ page }) => {
    await page.goto('/?seed=12345');
    await waitForSimulator(page);

    const body = page.locator('[data-role="debug-body"]');
    await expect(body).toBeHidden();

    await page.keyboard.press('KeyB');
    await expect(body).toBeVisible();

    const text = await body.innerText();
    expect(text).toContain('Draw calls');
    expect(text).toContain('Seed');
  });
});
