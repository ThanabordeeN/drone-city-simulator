/**
 * AgentController (Spec §34, §35, §36, §37, §40, §22, §29).
 *
 * Orchestrates one agent session: validates inputs, switches the simulator to
 * automation mode, parses the human command (destination → `setGoal()`), then
 * runs the real-time loop. Every drone interaction goes through the public
 * `window.__DRONE_SIM__` surface — never direct simulation state.
 */
import type { AgentStatus, DroneObservation } from './AgentProtocol';
import type { AgentActivity } from './AgentState';
import { AgentStateStore, type AgentRuntimeState } from './AgentState';
import { createTask, parseCommand } from './CommandParser';
import { DefaultJevAdapter } from './JevAdapter';
import { OpenRouterClient, ProviderError } from './OpenRouterClient';
import { ReflexPolicy } from './ReflexPolicy';
import {
  DEFAULT_LOOP_CONFIG,
  runAgentLoop,
  type AgentLoopConfig,
  type DroneSimSurface,
} from './AgentLoop';

export type ProviderKind = 'openrouter' | 'reflex';

export interface AgentStartOptions {
  command: string;
  apiKey?: string | null;
  model: string;
  provider: ProviderKind;
}

/** Minimal slice of the public automation API used by the controller. */
export interface ControllerSimSurface extends DroneSimSurface {
  ready(): Promise<void>;
  setControlMode(mode: 'manual' | 'automation'): void;
  setGoal(goal: { x: number; y: number; z: number; radius?: number }): unknown;
  getGoalDistance(): number | null;
  isGoalReached(): boolean;
  getState(): { position: { x: number; y: number; z: number } };
  getNearbyBuildings?(radius?: number): { id: string; position: { x: number; y: number; z: number }; distance: number }[];
}

export interface AgentControllerOptions {
  sim: ControllerSimSurface;
  loopConfig?: Partial<AgentLoopConfig>;
  jevAdapter?: DefaultJevAdapter;
  /** Debug hook (Spec §45): receives the raw provider response. */
  onRawResponse?: (response: unknown) => void;
}

export class AgentController {
  readonly store = new AgentStateStore();
  private readonly sim: ControllerSimSurface;
  private readonly loopConfig: AgentLoopConfig;
  private readonly adapter: DefaultJevAdapter;
  private onRawResponse: ((response: unknown) => void) | undefined;

  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private status: AgentStatus = 'idle';
  private running = false;

  constructor(options: AgentControllerOptions) {
    this.sim = options.sim;
    this.adapter = options.jevAdapter ?? new DefaultJevAdapter();
    this.onRawResponse = options.onRawResponse;
    this.loopConfig = { ...DEFAULT_LOOP_CONFIG, ...(options.loopConfig ?? {}) };
  }

  getRuntime(): AgentRuntimeState {
    return this.store.getRuntime();
  }

  getActivity(): AgentActivity {
    return this.store.getActivity();
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Debug hook (Spec §45): observe the raw provider response, if any. */
  setRawResponseListener(listener: (response: unknown) => void): void {
    this.onRawResponse = listener;
  }

  /** RUN (Spec §34). Resolves when the session ends (completed/failed/stopped). */
  async start(options: AgentStartOptions): Promise<void> {
    // Synchronous lock: a second RUN during the async boot must not spawn a
    // second decision loop.
    if (this.running) return;
    this.running = true;

    const command = options.command.trim();
    if (command === '') {
      this.running = false;
      this.fail('command is empty');
      return;
    }

    let provider;
    try {
      provider = this.createProvider(options);
    } catch (error) {
      this.running = false;
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }

    this.status = 'starting';
    this.store.patchRuntime({
      status: 'starting',
      command,
      startedAt: Date.now(),
      step: 0,
      lastObservation: null,
      lastAction: null,
      error: null,
    });
    this.store.patchActivity({
      sessionId: null,
      provider: options.provider === 'openrouter' ? 'OpenRouter' : 'Local',
      model: options.model,
      requests: 0,
      lastLatencyMs: null,
      lastUpdateAt: Date.now(),
    });

    await this.sim.ready();
    if (this.status !== 'starting') {
      this.running = false; // stopped while booting
      return;
    }

    // Take over the drone (Spec §15).
    this.sim.setControlMode('automation');
    this.sim.clearInput();

    // Destination command → setGoal(); the agent then just follows
    // goalDirection / goalDistance from observe() (Spec §22).
    const parsed = parseCommand(command);
    if (parsed.goal) {
      this.sim.setGoal(parsed.goal);
    } else if (parsed.altitudeTarget !== undefined) {
      const position = this.sim.getState().position;
      this.sim.setGoal({ x: position.x, y: parsed.altitudeTarget, z: position.z });
    }

    const task = createTask(parsed, Date.now());
    this.sessionId = `agent-${Date.now()}`;
    this.abortController = new AbortController();
    const sessionId = this.sessionId;
    const signal = this.abortController.signal;

    this.running = true;
    this.status = 'running';
    this.store.patchRuntime({ status: 'running' });
    this.store.patchActivity({ sessionId });

    const outcome = await runAgentLoop({
      sim: this.sim,
      provider,
      task,
      sessionId,
      config: this.loopConfig,
      signal,
      shouldRun: (): boolean => this.status === 'running' && this.sessionId === sessionId,
      hooks: {
        onObservation: (observation: DroneObservation): void => {
          this.store.patchRuntime({
            lastObservation: observation,
            goalDistance: observation.goalDistance,
            step: this.store.getRuntime().step + 1,
          });
        },
        onAction: (action, latencyMs): void => {
          this.store.patchRuntime({ lastAction: action });
          this.store.patchActivity({
            requests: this.store.getActivity().requests + 1,
            lastLatencyMs: latencyMs,
            lastUpdateAt: Date.now(),
          });
        },
        onStall: (): void => {
          // Input already cleared by the loop; surface it in the UI.
          this.store.patchActivity({ lastUpdateAt: Date.now() });
        },
        onError: (message): void => {
          this.store.patchRuntime({ error: message });
        },
      },
    });

    this.finishSession(outcome.reason === 'completed' ? 'completed' : outcome.reason === 'failed' ? 'failed' : 'idle', outcome.reason === 'failed' ? outcome.error : null);
  }

  /** STOP (Spec §35): immediate, cancels the pending request, clears input. */
  async stop(): Promise<void> {
    if (this.status === 'idle' || this.status === 'completed' || this.status === 'failed') return;
    this.status = 'stopping';
    this.store.patchRuntime({ status: 'stopping' });
    this.abortController?.abort();
    // The loop clears input on exit; do it here too so the drone stops even if
    // the loop is awaiting a long provider response.
    this.sim.clearInput();
    await this.waitForStop();
    this.finishSession('idle', null);
  }

  /**
   * Manual takeover (Spec §36): stop the agent and hand the drone back to
   * keyboard / gamepad control.
   */
  async stopAndReturnControl(): Promise<void> {
    await this.stop();
    this.sim.setControlMode('manual');
  }

  private finishSession(status: AgentStatus, error: string | null): void {
    this.running = false;
    this.status = status;
    this.abortController = null;
    this.store.patchRuntime({ status, ...(error !== null ? { error } : {}), ...(status === 'idle' ? {} : {}) });
    if (status !== 'failed') this.sim.clearInput();
  }

  private waitForStop(): Promise<void> {
    // The running loop exits within ~one interval once status leaves `running`.
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.running) resolve();
        else setTimeout(check, 25);
      };
      check();
    });
  }

  private fail(message: string): void {
    this.running = false;
    this.status = 'failed';
    this.sim.clearInput();
    this.store.patchRuntime({ status: 'failed', error: message });
  }

  private createProvider(options: AgentStartOptions) {
    if (options.provider === 'reflex') {
      return new ReflexPolicy();
    }
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new ProviderError('OpenRouter API key is required');
    }
    return new OpenRouterClient({
      apiKey: options.apiKey,
      model: options.model,
      adapter: this.adapter,
      ...(this.onRawResponse ? { onRawResponse: this.onRawResponse } : {}),
    });
  }
}
