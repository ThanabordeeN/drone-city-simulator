/**
 * AgentProtocol (Spec §8, §11, §13, §14, §20, §21).
 *
 * The typed contract between the AI Control Module and the rest of the app.
 * Everything here is plain data — no DOM, no Three.js, no fetch — so the
 * protocol can be unit-tested in plain Node (tests/unit/agent*.test.ts).
 *
 * The AI agent is just another consumer of `window.__DRONE_SIM__`: it reads
 * `observe()` and writes `act()`. It never touches simulation state directly.
 */

/** Lifecycle of an agent session (Spec §8). */
export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed';

/** Structured control command — the *only* thing an agent may emit (Spec §13). */
export interface DroneAction {
  /** Positive = nose down / move forward (Z-). Range -1..+1. */
  pitch: number;
  /** Positive = strafe right (X+). Range -1..+1. */
  roll: number;
  /** Positive = yaw left (CCW from above). Range -1..+1. */
  yaw: number;
  /** Positive = ascend. Range -1..+1. */
  vertical: number;
  /** True = active brake / hover. */
  brake: boolean;
}

/**
 * Mirror of `Observation` from `window.__DRONE_SIM__.observe()` (Spec §11).
 * Declared structurally so the agent module never imports the simulation.
 */
export interface DroneObservation {
  tick: number;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number];
  altitude: number;
  speed: number;
  heading: number;
  sensors: {
    front: number | null;
    back: number | null;
    left: number | null;
    right: number | null;
    down: number | null;
  };
  collision: boolean;
  crashed: boolean;
  grounded: boolean;
  goalDistance: number | null;
  goalDirection: [number, number, number] | null;
  goalReached: boolean;
}

/** Safety constraints parsed from the human command (min altitude etc.). */
export interface CommandConstraints {
  /** Never fly below this altitude, in metres. */
  minAltitude?: number;
  /** Never fly above this altitude, in metres. */
  maxAltitude?: number;
  /** Keep at least this many metres from any obstacle. */
  minObstacleDistance?: number;
}

/** Human command kept alive for the whole agent session (Spec §10). */
export interface AgentTask {
  command: string;
  startedAt: number;
  goal?: { x: number; y: number; z: number; radius?: number };
  constraints?: CommandConstraints;
}

/** Optional world context attached to a decision request (Spec §44). */
export interface NearbyBuildingContext {
  id: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

/** What the panel sends to a provider every decision cycle (Spec §12, §21). */
export interface AgentDecisionRequest {
  task: { command: string };
  state: DroneObservation;
  nearbyBuildings?: NearbyBuildingContext[];
  /** Safety constraints parsed from the command (survival rules). */
  constraints?: CommandConstraints;
  sessionId: string;
}

export interface AgentDecisionResponse {
  action: DroneAction;
}

/** Transport-agnostic decision provider (Spec §19). */
export interface AIProvider {
  decide(
    request: AgentDecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DroneAction>;
}

/** JEV-specific request/response mapping, split from the transport (Spec §20). */
export interface JevAdapter {
  createRequest(task: AgentTask, observation: DroneObservation, context?: NearbyBuildingContext[]): unknown;
  parseResponse(response: unknown): DroneAction;
}

export const NEUTRAL_ACTION: DroneAction = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  vertical: 0,
  brake: false,
};

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Action validation (Spec §14): clamp every axis to [-1, +1] and replace any
 * invalid value (NaN / Infinity / undefined / string) with the neutral one.
 */
export function validateAction(action: unknown): DroneAction {
  const source = (typeof action === 'object' && action !== null ? action : {}) as Record<string, unknown>;
  const axis = (key: string): number => {
    const raw = source[key];
    const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    return Number.isFinite(value) ? clampUnit(value) : 0;
  };
  return {
    pitch: axis('pitch'),
    roll: axis('roll'),
    yaw: axis('yaw'),
    vertical: axis('vertical'),
    brake: source.brake === true,
  };
}

export function isNeutral(action: DroneAction): boolean {
  return (
    action.pitch === 0 &&
    action.roll === 0 &&
    action.yaw === 0 &&
    action.vertical === 0 &&
    action.brake === false
  );
}
