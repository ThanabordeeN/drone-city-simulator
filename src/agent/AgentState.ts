/**
 * AgentState (Spec §8, §33).
 *
 * Observable runtime state of the agent session. DOM-free so it can be
 * asserted from unit tests; the AI Control Panel subscribes to it.
 */
import type { AgentStatus, DroneAction, DroneObservation } from './AgentProtocol';

export interface AgentRuntimeState {
  status: AgentStatus;
  command: string;
  startedAt: number | null;
  step: number;
  lastObservation: DroneObservation | null;
  lastAction: DroneAction | null;
  goalDistance: number | null;
  error: string | null;
  /** Crash auto-recoveries used this session. */
  recoveries: number;
}

export interface AgentActivity {
  sessionId: string | null;
  provider: string;
  model: string;
  requests: number;
  lastLatencyMs: number | null;
  lastUpdateAt: number | null;
}

export const INITIAL_RUNTIME_STATE: AgentRuntimeState = {
  status: 'idle',
  command: '',
  startedAt: null,
  step: 0,
  lastObservation: null,
  lastAction: null,
  goalDistance: null,
  error: null,
  recoveries: 0,
};

export const INITIAL_ACTIVITY: AgentActivity = {
  sessionId: null,
  provider: 'OpenRouter',
  model: '',
  requests: 0,
  lastLatencyMs: null,
  lastUpdateAt: null,
};

export type AgentStateListener = () => void;

export class AgentStateStore {
  private runtime: AgentRuntimeState = { ...INITIAL_RUNTIME_STATE, lastObservation: null, lastAction: null };
  private activity: AgentActivity = { ...INITIAL_ACTIVITY };
  private readonly listeners = new Set<AgentStateListener>();

  getRuntime(): AgentRuntimeState {
    return this.runtime;
  }

  getActivity(): AgentActivity {
    return this.activity;
  }

  patchRuntime(patch: Partial<AgentRuntimeState>): void {
    this.runtime = { ...this.runtime, ...patch };
    this.emit();
  }

  patchActivity(patch: Partial<AgentActivity>): void {
    this.activity = { ...this.activity, ...patch };
    this.emit();
  }

  reset(): void {
    this.runtime = { ...INITIAL_RUNTIME_STATE };
    this.activity = { ...INITIAL_ACTIVITY };
    this.emit();
  }

  subscribe(listener: AgentStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
