/**
 * AutomationAPI (Spec §17 - §35).
 *
 * The contract exposed as `window.__DRONE_SIM__`. It is a *thin* façade: every
 * method delegates straight to the simulation core, so headless Vitest runs
 * and in-browser Playwright runs execute the exact same code path.
 *
 * Nothing here touches keyboard or pointer events, which is what lets an agent
 * drive the simulator without synthesizing human input (Spec §21).
 */
import type { CameraMode, CameraController } from '../rendering/CameraController';
import type { SceneRenderer } from '../rendering/SceneRenderer';
import type { InputManager } from '../input/InputManager';
import type { DroneControlInput } from '../simulation/DroneState';
import { DroneSimulation, type ControlMode } from '../simulation/DroneSimulation';
import type { SpawnMode } from '../world/SpawnSystem';
import type { Vec3 } from '../simulation/vec3';
import type {
  BuildingSnapshot,
  DroneState,
  EpisodeStats,
  FullSnapshot,
  GoalSnapshot,
  Observation,
  SensorReadout,
  SimulationMetrics,
  WorldInfo,
} from './SimulationSnapshot';
import {
  toBuildingSnapshots,
  toEpisodeStats,
  toFullSnapshot,
  toInput,
  toMetrics,
  toObservation,
  toSensors,
  toState,
  toWorldInfo,
} from './SimulationSnapshot';

export interface ResetOptions {
  seed?: number;
  position?: Vec3;
  spawn?: SpawnMode;
}

export interface StartEpisodeOptions {
  seed?: number;
  spawn?: SpawnMode | Vec3;
  buildingTarget?: number;
}

export interface AutomationAPIOptions {
  simulation: DroneSimulation;
  camera?: CameraController;
  sceneRenderer?: SceneRenderer;
  inputManager?: InputManager;
  /** Resolves once the first frame has been rendered. */
  ready?: Promise<void>;
  version?: string;
}

export const AUTOMATION_API_VERSION = '1.0.0';

/**
 * Public interface of `window.__DRONE_SIM__`.
 *
 * Section references point at the specification that defines each method.
 */
export interface DroneAutomationAPI {
  // §17 lifecycle
  ready(): Promise<void>;
  readonly version: string;

  // §18 core state + input
  getState(): DroneState;
  getInput(): DroneControlInput;
  setInput(input: Partial<DroneControlInput>): void;
  clearInput(): void;
  reset(options?: ResetOptions): void;
  pause(): void;
  resume(): void;
  step(frames?: number): void;
  teleport(position: Vec3): void;
  setRotation(rotation: { pitch?: number; yaw?: number; roll?: number }): void;
  setCameraMode(mode: CameraMode): void;
  getNearbyBuildings(radius?: number): BuildingSnapshot[];
  getWorldInfo(): WorldInfo;
  getMetrics(): SimulationMetrics;

  // §25 – §29 experiment surface
  getSensors(): SensorReadout;
  observe(): Observation;
  act(action: Partial<DroneControlInput>): void;
  startEpisode(options?: StartEpisodeOptions): EpisodeStats;
  endEpisode(): EpisodeStats;
  getEpisodeStats(): EpisodeStats;
  setGoal(goal: { x: number; y: number; z: number; radius?: number }): GoalSnapshot;
  getGoal(): GoalSnapshot | null;
  clearGoal(): void;
  isGoalReached(): boolean;
  getGoalDistance(): number | null;

  // §32 control priority
  setControlMode(mode: ControlMode): void;
  getControlMode(): ControlMode;

  // Extras that make agent loops pleasant
  isPaused(): boolean;
  togglePause(): boolean;
  getCameraMode(): CameraMode;
  getConfig(): Record<string, number | boolean>;
  setConfig(overrides: Record<string, number | boolean>): void;
  getSnapshot(): FullSnapshot;
  getSpawnPosition(): Vec3;
  /** Throw away per-tick diagnostics accumulated since the last call. */
  resetMetricsCounters(): void;
}

export class AutomationAPI implements DroneAutomationAPI {
  readonly version: string;
  private readonly simulation: DroneSimulation;
  private camera: CameraController | undefined;
  private readonly sceneRenderer: SceneRenderer | undefined;
  private readonly inputManager: InputManager | undefined;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private readyResolved = false;

  constructor(options: AutomationAPIOptions) {
    this.simulation = options.simulation;
    this.camera = options.camera;
    this.sceneRenderer = options.sceneRenderer;
    this.inputManager = options.inputManager;
    this.version = options.version ?? AUTOMATION_API_VERSION;

    this.readyPromise =
      options.ready ??
      new Promise<void>((resolve) => {
        this.resolveReady = resolve;
      });
  }

  /** Called by `main.ts` once the first frame is on screen. */
  markReady(): void {
    if (this.readyResolved) return;
    this.readyResolved = true;
    this.resolveReady?.();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  getState(): DroneState {
    return toState(this.simulation);
  }

  getInput(): DroneControlInput {
    return toInput(this.simulation);
  }

  setInput(input: Partial<DroneControlInput>): void {
    // Automation actions are meaningful even while paused: the next `step()`
    // consumes them without ever reading a device.
    this.simulation.setInput(input);
  }

  clearInput(): void {
    this.simulation.clearInput();
  }

  reset(options: ResetOptions = {}): void {
    this.simulation.reset(options);
    this.simulation.clearInput();
    this.camera?.snap(this.simulation.state);
  }

  pause(): void {
    this.simulation.pause();
  }

  resume(): void {
    this.simulation.resume();
  }

  isPaused(): boolean {
    return this.simulation.isPaused;
  }

  togglePause(): boolean {
    return this.simulation.togglePause();
  }

  step(frames = 1): void {
    this.simulation.step(frames);
  }

  teleport(position: Vec3): void {
    this.simulation.teleport(position);
    this.camera?.snap(this.simulation.state);
  }

  setRotation(rotation: { pitch?: number; yaw?: number; roll?: number }): void {
    this.simulation.setRotation(rotation);
  }

  // -----------------------------------------------------------------------
  // Cameras
  // -----------------------------------------------------------------------

  setCameraMode(mode: CameraMode): void {
    this.camera?.setMode(mode);
  }

  getCameraMode(): CameraMode {
    return this.camera?.mode ?? 'chase';
  }

  // -----------------------------------------------------------------------
  // World queries
  // -----------------------------------------------------------------------

  getNearbyBuildings(radius = 50): BuildingSnapshot[] {
    return toBuildingSnapshots(this.simulation, radius);
  }

  getWorldInfo(): WorldInfo {
    return toWorldInfo(this.simulation);
  }

  getMetrics(): SimulationMetrics {
    return toMetrics(this.simulation);
  }

  resetMetricsCounters(): void {
    this.simulation.resetMetricsCounters();
  }

  getSpawnPosition(): Vec3 {
    return this.simulation.getSpawnPosition();
  }

  // -----------------------------------------------------------------------
  // Sensors / observation / action
  // -----------------------------------------------------------------------

  getSensors(): SensorReadout {
    return toSensors(this.simulation);
  }

  observe(): Observation {
    return toObservation(this.simulation);
  }

  act(action: Partial<DroneControlInput>): void {
    this.simulation.act(action);
  }

  // -----------------------------------------------------------------------
  // Episodes
  // -----------------------------------------------------------------------

  startEpisode(options: StartEpisodeOptions = {}): EpisodeStats {
    const stats = this.simulation.startEpisode(options);
    this.simulation.clearInput();
    this.camera?.snap(this.simulation.state);
    return stats;
  }

  endEpisode(): EpisodeStats {
    return this.simulation.endEpisode();
  }

  getEpisodeStats(): EpisodeStats {
    return toEpisodeStats(this.simulation);
  }

  // -----------------------------------------------------------------------
  // Goals
  // -----------------------------------------------------------------------

  setGoal(goal: { x: number; y: number; z: number; radius?: number }): GoalSnapshot {
    return this.simulation.setGoal(goal);
  }

  getGoal(): GoalSnapshot | null {
    return this.simulation.getGoal();
  }

  clearGoal(): void {
    this.simulation.clearGoal();
  }

  isGoalReached(): boolean {
    return this.simulation.goalIsReached;
  }

  getGoalDistance(): number | null {
    return this.simulation.getGoalDistance();
  }

  // -----------------------------------------------------------------------
  // Control priority (Spec §32)
  // -----------------------------------------------------------------------

  setControlMode(mode: ControlMode): void {
    this.simulation.setControlMode(mode);
    this.inputManager?.setControlMode(mode);
  }

  getControlMode(): ControlMode {
    return this.inputManager?.getControlMode() ?? this.simulation.getControlMode();
  }

  // -----------------------------------------------------------------------
  // Configuration + full snapshot
  // -----------------------------------------------------------------------

  getConfig(): Record<string, number | boolean> {
    return this.simulation.getConfig() as unknown as Record<string, number | boolean>;
  }

  setConfig(overrides: Record<string, number | boolean>): void {
    this.simulation.setConfig(overrides);
  }

  getSnapshot(): FullSnapshot {
    return toFullSnapshot(this.simulation);
  }

  /** Internal hook used by `main.ts` when the camera is created later. */
  attachCamera(camera: CameraController): void {
    this.camera = camera;
  }

  get renderer(): SceneRenderer | undefined {
    return this.sceneRenderer;
  }
}

declare global {
  interface Window {
    __DRONE_SIM__?: DroneAutomationAPI;
    /** Signals to automation clients that the bootstrap ran. */
    __DRONE_SIM_READY__?: boolean;
  }
}

/**
 * Publish the API on `window` (Spec §17).
 * Returns the installed API so callers can hold a direct reference.
 */
export function installAutomationAPI(
  api: DroneAutomationAPI,
  target: Window | (Window & typeof globalThis) = window,
): DroneAutomationAPI {
  target.__DRONE_SIM__ = api;
  target.__DRONE_SIM_READY__ = true;
  return api;
}
