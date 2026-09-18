/**
 * Keyboard-level integration tests (Spec §22).
 *
 * These exercise the *whole* browser stack:
 *
 *   KeyboardEvent -> KeyboardInput -> InputManager -> Simulation -> Drone movement
 *
 * Waits are expressed in fixed simulation ticks rather than wall-clock time, so
 * the assertions hold no matter how fast the renderer happens to be running.
 */
import { expect, test } from '@playwright/test';
import { waitForSimulator, waitTicks } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?seed=12345');
  await waitForSimulator(page);
  await page.evaluate(() => window.__DRONE_SIM__!.resume());
});

test('W flies the drone forward along -Z (Spec §7, §36 #3)', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 60, z: 0 }));
  const before = await page.evaluate(() => window.__DRONE_SIM__!.getState());

  await page.keyboard.down('KeyW');
  await waitTicks(page, 90);
  await page.keyboard.up('KeyW');

  const after = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(after.tick).toBeGreaterThanOrEqual(before.tick + 90);
  expect(after.position.z).toBeLessThan(before.position.z - 2);
  expect(after.position.x).toBeCloseTo(before.position.x, 3);
});

test('Shift ascends and Control descends (Spec §36 #4, #5)', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 60, z: 0 }));

  await page.keyboard.down('Shift');
  await waitTicks(page, 90);
  await page.keyboard.up('Shift');
  const climbed = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(climbed.altitude).toBeGreaterThan(62);

  // Hold descend long enough to cancel the climb inertia and drop below it.
  await page.keyboard.down('Control');
  await waitTicks(page, 180);
  await page.keyboard.up('Control');
  const descended = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(descended.altitude).toBeLessThan(climbed.altitude);
});

test('A and D strafe left and right (Spec §36 #3)', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 80, z: 0 }));

  await page.keyboard.down('KeyD');
  await waitTicks(page, 90);
  await page.keyboard.up('KeyD');
  const right = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(right.position.x).toBeGreaterThan(1);

  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 80, z: 0 }));
  await page.keyboard.down('KeyA');
  await waitTicks(page, 90);
  await page.keyboard.up('KeyA');
  const left = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(left.position.x).toBeLessThan(-1);
});

test('Q and E yaw the drone (Spec §36 #6)', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 90, z: 0 }));

  await page.keyboard.down('KeyQ');
  await waitTicks(page, 60);
  await page.keyboard.up('KeyQ');
  const left = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(left.rotation.yaw).toBeGreaterThan(0.5);

  await page.evaluate(() => window.__DRONE_SIM__!.setRotation({ yaw: 0 }));
  await page.keyboard.down('KeyE');
  await waitTicks(page, 60);
  await page.keyboard.up('KeyE');
  const right = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(right.rotation.yaw).toBeLessThan(-0.5);
});

test('simultaneous keys combine (W + D + Shift)', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 60, z: 0 }));

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.keyboard.down('Shift');
  await waitTicks(page, 5);

  const input = await page.evaluate(() => window.__DRONE_SIM__!.getInput());
  expect(input.pitch).toBe(1);
  expect(input.roll).toBe(1);
  expect(input.vertical).toBe(1);

  await waitTicks(page, 85);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyD');
  await page.keyboard.up('Shift');

  const state = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(state.position.x).toBeGreaterThan(1);
  expect(state.position.z).toBeLessThan(-1);
  expect(state.altitude).toBeGreaterThan(62);
});

test('Space brakes the drone toward a hover', async ({ page }) => {
  await page.evaluate(() => window.__DRONE_SIM__!.teleport({ x: 0, y: 90, z: 0 }));

  await page.keyboard.down('KeyW');
  await waitTicks(page, 180);
  await page.keyboard.up('KeyW');
  const moving = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(moving.speed).toBeGreaterThan(5);

  await page.keyboard.down('Space');
  await waitTicks(page, 5);
  const braking = await page.evaluate(() => window.__DRONE_SIM__!.getInput());
  expect(braking.brake).toBe(true);

  await waitTicks(page, 115);
  await page.keyboard.up('Space');
  const stopped = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(stopped.speed).toBeLessThan(moving.speed * 0.5);
});

test('C cycles the camera (Spec §15, §36 #8, #9)', async ({ page }) => {
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('chase');

  await page.keyboard.press('KeyC');
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('fpv');

  await page.keyboard.press('KeyC');
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('free');

  await page.keyboard.press('KeyC');
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getCameraMode())).toBe('chase');
});

test('P pauses and resumes the simulation (Spec §36 #13)', async ({ page }) => {
  await page.keyboard.press('KeyP');
  expect(await page.evaluate(() => window.__DRONE_SIM__!.isPaused())).toBe(true);

  const frozen = await page.evaluate(() => window.__DRONE_SIM__!.getState().tick);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getState().tick)).toBe(frozen);

  await page.keyboard.press('KeyP');
  expect(await page.evaluate(() => window.__DRONE_SIM__!.isPaused())).toBe(false);

  await waitTicks(page, 30);
  expect(await page.evaluate(() => window.__DRONE_SIM__!.getState().tick)).toBeGreaterThan(frozen);
});

test('R resets the drone without reloading the page (Spec §34, §36 #18)', async ({ page }) => {
  await page.evaluate(() => {
    const sim = window.__DRONE_SIM__!;
    sim.teleport({ x: 120, y: 80, z: -60 });
    sim.pause();
    sim.setInput({ pitch: 1 });
    sim.step(120);
    sim.clearInput();
  });

  const flown = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(flown.position.z).not.toBe(-60);
  // The page had already been running; only the reset must zero the tick.
  expect(flown.tick).toBeGreaterThanOrEqual(120);

  await page.keyboard.press('KeyR');

  const reset = await page.evaluate(() => window.__DRONE_SIM__!.getState());
  expect(reset.tick).toBe(0);
  expect(reset.velocity.x).toBe(0);
  expect(reset.velocity.z).toBe(0);
  expect(reset.position.x).not.toBe(120);
  expect(reset.altitude).toBeGreaterThan(0);
  expect(reset.crashed).toBe(false);

  // The world itself is untouched by a reset.
  const info = await page.evaluate(() => window.__DRONE_SIM__!.getWorldInfo());
  expect(info.seed).toBe(12345);
  expect(info.buildingCount).toBeGreaterThanOrEqual(600);
});

test('H toggles the help panel', async ({ page }) => {
  const helpBody = page.locator('[data-role="help-body"]');
  await expect(helpBody).toBeHidden();
  await page.keyboard.press('KeyH');
  await expect(helpBody).toBeVisible();
  await expect(helpBody).toContainText('Brake / hover');
});
