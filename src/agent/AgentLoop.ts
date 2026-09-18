/**
 * AgentLoop (Spec §16, §17, §18, §23, §38, §39, §40).
 *
 * Real-time decision loop: observe → decide → validate → act, at a fixed
 * frequency (default 5 Hz). The simulation is NEVER paused or stepped from
 * here — it keeps running at 60 Hz on its own frame loop, so the drone moves
 * live in front of the user.
 *
 * Safety rails baked in:
 *   - action watchdog: if no fresh action arrives within `actionTimeoutMs`,
 *     `sim.clearInput()` so the drone never holds a stale command forever
 *   - session guard: a decision from an older session is dropped
 *   - abort signal: STOP cancels the in-flight provider request
 */
import type { AIProvider, AgentTask, DroneAction, DroneObservation } from './AgentProtocol';
import { validateAction } from './AgentProtocol';

/** Minimal slice of `window.__DRONE_SIM__` the loop is allowed to touch. */
export interface BuildingContext {
  id: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface DroneSimSurface {
  observe(): DroneObservation;
  act(action: Partial<DroneAction>): void;
  clearInput(): void;
  /** Optional world context for the agent request (Spec §43–§44). */
  getNearbyBuildings?(radius?: number): BuildingContext[];
}

export interface AgentLoopConfig {
  /** Decision frequency period in ms (default 200 = 5 Hz). */
  intervalMs: number;
  /** No fresh action for this long → clear drone input (default 2000). */
  actionTimeoutMs: number;
  /** Give up the session after this long even without a goal (default 5 min). */
  maxDurationMs: number;
}

export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  intervalMs: 200,
  actionTimeoutMs: 2000,
  maxDurationMs: 300_000,
};

export interface AgentLoopHooks {
  onObservation(observation: DroneObservation): void;
  onAction(action: DroneAction, latencyMs: number): void;
  onStall(): void;
  onError(message: string): void;
}

export type LoopOutcome =
  | { reason: 'completed' }
  | { reason: 'stopped' }
  | { reason: 'failed'; error: string };

export interface AgentLoopDeps {
  sim: DroneSimSurface;
  provider: AIProvider;
  task: AgentTask;
  sessionId: string;
  config: AgentLoopConfig;
  signal: AbortSignal;
  shouldRun(): boolean;
  hooks: AgentLoopHooks;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runAgentLoop(deps: AgentLoopDeps): Promise<LoopOutcome> {
  const { sim, provider, task, config, signal, hooks } = deps;
  let lastActionAt = Date.now();
  let stalled = false;
  let requestCount = 0;

  const watchdog = setInterval(() => {
    if (Date.now() - lastActionAt > config.actionTimeoutMs) {
      if (!stalled) {
        stalled = true;
        // Don't let the drone hold its last stick position indefinitely.
        sim.clearInput();
        hooks.onStall();
      }
    }
  }, 250);

  try {
    while (deps.shouldRun()) {
      if (Date.now() - task.startedAt > config.maxDurationMs) {
        sim.clearInput();
        hooks.onError('agent exceeded max duration');
        return { reason: 'failed', error: 'agent exceeded max duration' };
      }

      const observation = sim.observe();
      hooks.onObservation(observation);

      // Hard survival stop: crashed drones get their input cleared.
      if (observation.crashed) {
        sim.clearInput();
        return { reason: 'failed', error: 'drone crashed' };
      }

      // Goal completion (Spec §23).
      if (observation.goalReached) {
        sim.clearInput();
        return { reason: 'completed' };
      }

      const startedAt = Date.now();
      let action: DroneAction;
      try {
        // Race the decision against STOP so a hung provider cannot block it.
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
        action = await Promise.race([
          provider.decide(
            {
              task: { command: task.command },
              state: observation,
              nearbyBuildings: sim.getNearbyBuildings?.(60),
              sessionId: deps.sessionId,
            },
            { signal },
          ),
          aborted,
        ]);
      } catch (error) {
        if (!deps.shouldRun() || signal.aborted) return { reason: 'stopped' };
        const message = error instanceof Error ? error.message : String(error);
        sim.clearInput(); // Provider failure must not leave a stale command (§37).
        hooks.onError(message);
        return { reason: 'failed', error: message };
      }
      requestCount += 1;
      const latencyMs = Date.now() - startedAt;

      // Session isolation (§40) + STOP during the await (§35).
      if (!deps.shouldRun() || signal.aborted) return { reason: 'stopped' };

      sim.act(validateAction(action));
      lastActionAt = Date.now();
      stalled = false;
      hooks.onAction(action, latencyMs);

      await sleep(config.intervalMs, signal);
      if (signal.aborted) return { reason: 'stopped' };
    }
    return { reason: 'stopped' };
  } finally {
    clearInterval(watchdog);
    void requestCount;
  }
}
