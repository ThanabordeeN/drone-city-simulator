/**
 * Shared helpers for the Playwright suite.
 *
 * Only *types* are imported from `src/` — they are erased at compile time, so
 * these tests always drive the bundle the browser actually loaded.
 */
import type { Page } from '@playwright/test';
import type { AutomationAPI } from '../../src/automation/AutomationAPI';
import type {
  BuildingSnapshot,
  DroneState,
  EpisodeStats,
  Observation,
  SensorReadout,
  SimulationMetrics,
  WorldInfo,
} from '../../src/automation/SimulationSnapshot';

export type {
  AutomationAPI,
  BuildingSnapshot,
  DroneState,
  EpisodeStats,
  Observation,
  SensorReadout,
  SimulationMetrics,
  WorldInfo,
};

/** The automation handle, typed, after `waitForSimulator` has resolved. */
export type SimHandle = AutomationAPI;

/** Wait for the simulator to finish booting and expose its API. */
export async function waitForSimulator(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __DRONE_SIM_READY__?: boolean; __DRONE_SIM__?: unknown };
      return w.__DRONE_SIM_READY__ === true && typeof w.__DRONE_SIM__ === 'object';
    },
    undefined,
    { timeout: 45_000 },
  );
  await page.evaluate(() => window.__DRONE_SIM__!.ready());
}

/**
 * Block until the simulation has advanced `ticks` fixed steps.
 *
 * Keyboard tests must not depend on wall-clock time: under a software
 * rasterizer the frame rate swings wildly, but the fixed-step tick counter is
 * exactly what the physics is pinned to.
 */
export async function waitTicks(page: Page, ticks: number, timeout = 45_000): Promise<void> {
  const start = await page.evaluate(() => window.__DRONE_SIM__!.getState().tick);
  await page.waitForFunction(
    (target) => window.__DRONE_SIM__!.getState().tick >= target,
    start + ticks,
    { timeout },
  );
}

/** Convenience: read the drone state in one round trip. */
export function getState(page: Page): Promise<DroneState> {
  return page.evaluate(() => window.__DRONE_SIM__!.getState());
}

/** Convenience: read the world info in one round trip. */
export function getWorldInfo(page: Page): Promise<WorldInfo> {
  return page.evaluate(() => window.__DRONE_SIM__!.getWorldInfo());
}
