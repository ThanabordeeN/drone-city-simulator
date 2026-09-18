/**
 * AI Control Module e2e (Spec §3, §4, §5, §30-§35, §52).
 *
 * Proves the panel works in a real browser: tab navigation, API-key memory
 * handling, RUN/STOP wiring and that the Three.js world keeps rendering while
 * the AI Control tab is open.
 */
import { expect, test } from '@playwright/test';

const FORWARD_COMMAND = 'บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก';

async function openAiTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'AI CONTROL' }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
}

test('shows tab navigation and keeps the Three.js world rendering (Spec §3, criterion 2)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.agent-bar')).toBeVisible();

  await openAiTab(page);
  const canvas = page.locator('#viewport');
  await expect(canvas).toBeVisible();

  // The simulation must keep ticking while the AI tab is open.
  const tick1 = await page.evaluate(() => (window as any).__DRONE_SIM__?.getState().tick);
  await page.waitForTimeout(500);
  const tick2 = await page.evaluate(() => (window as any).__DRONE_SIM__?.getState().tick);
  expect(tick2).toBeGreaterThan(tick1);
});

test('API key stays in memory only and clears on demand (Spec §5, criterion 4, 5)', async ({ page }) => {
  await page.goto('/');
  await openAiTab(page);

  const keyInput = page.locator('.agent-panel input[data-role="key"]');
  await expect(keyInput).toHaveAttribute('type', 'password');

  await keyInput.fill('sk-or-v1-secret-value');
  await page.locator('[data-role="keyshow"]').click();
  await expect(keyInput).toHaveAttribute('type', 'text'); // show works
  await page.locator('[data-role="keyshow"]').click();
  await expect(keyInput).toHaveAttribute('type', 'password'); // hide works

  // Nothing may leak into persistent storage or the URL.
  const leaked = await page.evaluate(() => ({
    local: window.localStorage.getItem('sk-or-v1-secret-value'),
    session: window.sessionStorage.getItem('sk-or-v1-secret-value'),
    url: window.location.href,
    localKeys: Object.keys(window.localStorage),
    sessionKeys: Object.keys(window.sessionStorage),
  }));
  expect(leaked.local).toBeNull();
  expect(leaked.session).toBeNull();
  expect(leaked.url).not.toContain('sk-or-v1');
  expect(leaked.localKeys.join()).not.toContain('sk-or-v1');
  expect(leaked.sessionKeys.join()).not.toContain('sk-or-v1');

  await page.locator('[data-role="keyclear"]').click();
  await expect(keyInput).toHaveValue('');
});

test('RUN requires an API key for OpenRouter (Spec §34)', async ({ page }) => {
  await page.goto('/');
  await openAiTab(page);
  await page.locator('.agent-panel textarea[data-role="command"]').fill(FORWARD_COMMAND);
  await page.locator('[data-role="run"]').click();
  await expect(page.locator('[data-role="error"]')).toContainText('API key');
});

test('RUN starts the agent, STOP hands control back (Spec §34, §35, criteria 16-19)', async ({ page }) => {
  await page.goto('/');
  await openAiTab(page);

  // Use the local reflex provider so no real API key / network is needed.
  await page.locator('[data-role="provider-select"]').selectOption('reflex');
  await page.locator('.agent-panel textarea[data-role="command"]').fill(FORWARD_COMMAND);
  await page.locator('[data-role="run"]').click();

  await expect(page.locator('[data-role="status"]')).toHaveText('RUNNING', { timeout: 10_000 });
  await expect(page.locator('[data-role="mode"]')).toHaveText('automation');
  await expect(page.locator('[data-role="stop"]')).toBeEnabled();

  // Live telemetry updates while the agent flies.
  await page.waitForTimeout(1_500);
  await expect(page.locator('[data-role="step"]')).not.toHaveText('0');
  const action = await page.locator('[data-role="pitch"]').textContent();
  expect(action).toBeTruthy();
  expect(action).not.toBe('-');

  await page.locator('[data-role="stop"]').click();
  await expect(page.locator('[data-role="status"]')).toHaveText('IDLE', { timeout: 10_000 });

  // STOP must clear the drone input (criterion 18): within a couple of
  // simulation ticks every held axis resolves to neutral.
  await page.waitForFunction(() => {
    const input = (window as any).__DRONE_SIM__?.getInput();
    return input && input.pitch === 0 && input.vertical === 0 && input.brake === false;
  }, undefined, { timeout: 5_000 });
});

test('destination command parses into a simulator goal (Spec §22, criterion 20)', async ({ page }) => {
  await page.goto('/');
  await openAiTab(page);
  await page.locator('[data-role="provider-select"]').selectOption('reflex');
  await page.locator('.agent-panel textarea[data-role="command"]').fill('บินไปที่ x=60 y=40 z=-60');
  await page.locator('[data-role="run"]').click();

  await page.waitForFunction(() => {
    const goal = (window as any).__DRONE_SIM__?.getGoal();
    return !!goal && goal.x === 60 && goal.y === 40 && goal.z === -60;
  }, undefined, { timeout: 10_000 });

  await expect(page.locator('[data-role="goal"]')).toContainText('60 / 40 / -60');
  await page.locator('[data-role="stop"]').click();
  await expect(page.locator('[data-role="status"]')).toHaveText('IDLE', { timeout: 10_000 });
});

test('the AI tab never hijacks manual control after STOP (Spec §36, criterion 19)', async ({ page }) => {
  await page.goto('/');
  await openAiTab(page);
  await page.locator('[data-role="provider-select"]').selectOption('reflex');
  await page.locator('.agent-panel textarea[data-role="command"]').fill(FORWARD_COMMAND);
  await page.locator('[data-role="run"]').click();
  await expect(page.locator('[data-role="status"]')).toHaveText('RUNNING', { timeout: 10_000 });

  // Switching back to the SIMULATOR tab stops the agent and restores manual mode.
  await page.getByRole('button', { name: 'SIMULATOR' }).click();
  await expect(page.locator('.agent-panel')).toBeHidden();
  await page.waitForFunction(() => {
    const sim = (window as any).__DRONE_SIM__;
    return sim && sim.getControlMode() === 'manual';
  }, undefined, { timeout: 10_000 });
});
