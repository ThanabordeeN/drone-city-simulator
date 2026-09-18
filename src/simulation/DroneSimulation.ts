/**
 * DroneSimulation — the source of truth (Spec §3, §4, §34, §39).
 *
 * Owns the drone state, the world, the fixed timestep and the derived
 * observation/sensor APIs. It has **no** dependency on Three.js, the DOM or
 * wall-clock time, so the exact same core drives:
 *
 *   - rendered mode      (main.ts feeds it real frame deltas)
 *   - headless test mode (Vitest, no browser at all)
 *   - manual stepping    (`pause()` + `step(n)`)
 *   - replay / RL loops  (`observe()` -> `act()` -> `step(1)`)
 */
import { AutomationInput } from '../input/AutomationInput';
import type { CityLayout } from '../world/CityGenerator';
import { createBuildingSystem, generateCity } from '../world/CityGenerator';
import { BuildingSystem, type BuildingSnapshot } from '../world/BuildingSystem';
import { RoadSystem } from '../world/RoadSystem';
import { SpawnSystem, type SpawnMode } from '../world/SpawnSystem';
import { CollisionSystem, type CollisionEvent } from './CollisionSystem';
import { DroneController } from './DroneController';
import {
  DEFAULT_DRONE_CONFIG,
  NEUTRAL_INPUT,
  cloneDroneState,
  createDroneState,
  mergeDroneConfig,
  type DroneConfig,
  type DroneControlInput,
  type DroneState,
} from './DroneState';
import { FIXED_DT, FIXED_HZ, FixedTimestep } from './FixedTimestep';
import { clamp, horizontalLength3, vec3, type Vec3 } from './vec3';

export type ControlMode = 'manual' | 'automation';

/** Anything that can supply resolved control input (InputManager, tests...). */
export interface SimulationInputSource {
  getInput(): DroneControlInput;
}

export interface SimulationOptions {
  layout?: CityLayout;
  seed?: number;
  buildingTarget?: number;
  testMode?: boolean;
  config?: Partial<DroneConfig>;
  inputSource?: SimulationInputSource | null;
  automationInput?: AutomationInput | null;
  fixedHz?: number;
  /** Start paused (test mode does this by default). */
  startPaused?: boolean;
}

export interface SensorReadout {
  altitude: number;
  velocity: Vec3;
  /** Yaw in radians. */
  heading: number;
  frontDistance: number | null;
  backDistance: number | null;
  leftDistance: number | null;
  rightDistance: number | null;
  downDistance: number | null;
}

export interface CompactSensors {
  front: number | null;
  back: number | null;
  left: number | null;
  right: number | null;
  down: number | null;
}

export interface Observation {
  tick: number;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number];
  altitude: number;
  speed: number;
  heading: number;
  sensors: CompactSensors;
  collision: boolean;
  crashed: boolean;
  grounded: boolean;
  goalDistance: number | null;
  goalDirection: [number, number, number] | null;
  goalReached: boolean;
}

export interface Goal {
  x: number;
  y: number;
  z: number;
  /** Arrival radius in metres (Spec: 5 m). */
  radius: number;
}

export interface EpisodeStats {
  ticks: number;
  duration: number;
  distanceTravelled: number;
  collisions: number;
  crashed: boolean;
}

/** Per-type tally of collision events, kept for diagnostics and tests. */
export interface CollisionCounts {
  building: number;
  ground: number;
  boundary: number;
  total: number;
}

export interface RenderMetrics {
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
}

export interface SimulationMetrics extends RenderMetrics {
  tick: number;
  simulationHz: number;
  fixedDtMs: number;
  paused: boolean;
  buildingCount: number;
  droneSpeed: number;
  altitude: number;
  collisionChecks: number;
  activeBuildings: number;
}

export interface WorldInfo {
  seed: number;
  worldSize: number;
  blockCountX: number;
  blockCountZ: number;
  blockCount: number;
  buildingCount: number;
  landmarkCount: number;
  roadWidth: number;
  sidewalkWidth: number;
  spatialCellSize: number;
  worldHalf: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; maxHeight: number };
  spawn: Vec3;
  testMode: boolean;
  goal: Goal | null;
}

export interface ResetOptions {
  seed?: number;
  position?: Vec3;
  /** Spawn placement mode when `position` is omitted. */
  spawn?: SpawnMode;
  /** Keep the current pause state instead of forcing a resume. */
  keepPaused?: boolean;
}

export interface StartEpisodeOptions {
  seed?: number;
  spawn?: SpawnMode | Vec3;
  buildingTarget?: number;
}

const SENSOR_RANGE = 200;

export class DroneSimulation {
  state: DroneState;
  readonly controller: DroneController;

  layout: CityLayout;
  roads: RoadSystem;
  buildings: BuildingSystem;
  spawn: SpawnSystem;
  collision: CollisionSystem;

  readonly automationInput: AutomationInput;
  readonly testMode: boolean;

  private inputSource: SimulationInputSource | null;
  private timestep: FixedTimestep;
  private controlMode: ControlMode = 'manual';
  private paused = false;
  private lastInput: DroneControlInput = { ...NEUTRAL_INPUT };
  private renderMetrics: RenderMetrics = { fps: 0, frameTimeMs: 0, drawCalls: 0, triangles: 0 };
  private goal: Goal | null = null;
  private goalReached = false;
  private collisionChecks = 0;
  private episodeActive = false;
  private episode: EpisodeStats = { ticks: 0, duration: 0, distanceTravelled: 0, collisions: 0, crashed: false };
  private collisionCounts: CollisionCounts = { building: 0, ground: 0, boundary: 0, total: 0 };
  private lastCollisionEvents: CollisionEvent[] = [];
  private spawnPosition: Vec3;
  private worldListeners = new Set<(layout: CityLayout, roads: RoadSystem) => void>();

  constructor(options: SimulationOptions = {}) {
    this.testMode = options.testMode ?? false;

    const layout =
      options.layout ??
      generateCity({
        seed: options.seed ?? 12345,
        ...(options.buildingTarget !== undefined ? { buildingTarget: options.buildingTarget } : {}),
      });

    this.layout = layout;
    this.roads = new RoadSystem(layout);
    this.buildings = createBuildingSystem(layout);
    this.spawn = new SpawnSystem(this.roads, this.buildings);

    this.automationInput = options.automationInput ?? new AutomationInput();
    this.inputSource = options.inputSource ?? null;

    this.controller = new DroneController(options.config ?? {});
    this.collision = new CollisionSystem(this.buildings, this.roads, {
      radius: this.controller.config.radius,
      crashSpeedThreshold: this.controller.config.crashSpeedThreshold,
      bounce: this.controller.config.collisionBounce,
      damping: this.controller.config.collisionDamping,
    });

    this.timestep = new FixedTimestep({ hz: options.fixedHz ?? FIXED_HZ });

    this.spawnPosition = this.spawn.findSpawn({
      mode: 'default',
      altitude: this.controller.config.spawnAltitude,
    });
    this.state = createDroneState();
    this.placeAtSpawn();

    this.paused = options.startPaused ?? this.testMode;
  }

  // ---------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------

  onWorldChanged(listener: (layout: CityLayout, roads: RoadSystem) => void): () => void {
    this.worldListeners.add(listener);
    return () => this.worldListeners.delete(listener);
  }

  /** Swap in a freshly generated city (used by `reset({seed})` and episodes). */
  setWorld(layout: CityLayout): void {
    this.layout = layout;
    this.roads = new RoadSystem(layout);
    this.buildings = createBuildingSystem(layout);
    this.spawn = new SpawnSystem(this.roads, this.buildings);
    this.collision = new CollisionSystem(this.buildings, this.roads, {
      radius: this.controller.config.radius,
      crashSpeedThreshold: this.controller.config.crashSpeedThreshold,
      bounce: this.controller.config.collisionBounce,
      damping: this.controller.config.collisionDamping,
    });
    this.spawnPosition = this.spawn.findSpawn({
      mode: 'default',
      altitude: this.controller.config.spawnAltitude,
    });
    for (const listener of this.worldListeners) listener(this.layout, this.roads);
  }

  regenerateWorld(seed: number, buildingTarget?: number): CityLayout {
    const layout = generateCity({
      seed,
      ...(buildingTarget !== undefined ? { buildingTarget } : {}),
    });
    this.setWorld(layout);
    return layout;
  }

  // ---------------------------------------------------------------------
  // Timing (Spec §4)
  // ---------------------------------------------------------------------

  /**
   * Advance the simulation by a real elapsed time. Returns the number of fixed
   * steps actually executed.
   */
  advance(realDeltaSeconds: number): number {
    if (this.paused) {
      // Still drain the accumulator so resuming does not cause a burst.
      this.timestep.reset();
      return 0;
    }
    const steps = this.timestep.consume(realDeltaSeconds);
    for (let i = 0; i < steps; i += 1) this.tick();
    return steps;
  }

  /** Run exactly `frames` fixed ticks regardless of pause state (Spec §4). */
  step(frames = 1): void {
    const count = Math.max(0, Math.floor(frames));
    for (let i = 0; i < count; i += 1) this.tick();
  }

  /** One fixed physics tick. The only place `state.tick` advances. */
  tick(): void {
    const dt = this.timestep.dt;
    const input = this.resolveInput();
    this.lastInput = input;

    const before: Vec3 = { ...this.state.position };

    this.controller.update(this.state, input, dt);
    const resolution = this.collision.resolve({
      position: this.state.position,
      velocity: this.state.velocity,
      crashed: this.state.crashed,
    });

    // `collided` latches until the next reset (Spec §34 treats collision
    // state as reset-scoped, not per-tick), `grounded` is live contact state.
    this.state.collided = this.state.collided || resolution.collided;
    this.state.crashed = this.state.crashed || resolution.crashed;
    this.state.grounded = resolution.grounded;
    this.state.altitude = this.state.position.y;
    this.state.speed = Math.hypot(
      this.state.velocity.x,
      this.state.velocity.y,
      this.state.velocity.z,
    );
    this.state.tick += 1;

    this.lastCollisionEvents = resolution.events;
    for (const event of resolution.events) {
      this.collisionCounts[event.type] += 1;
      this.collisionCounts.total += 1;
    }

    // Episode bookkeeping.
    const dx = this.state.position.x - before.x;
    const dy = this.state.position.y - before.y;
    const dz = this.state.position.z - before.z;
    this.episode.distanceTravelled += Math.hypot(dx, dy, dz);
    if (resolution.collided) this.episode.collisions += 1;
    this.episode.ticks += 1;
    this.episode.duration = this.episode.ticks * dt;
    if (this.state.crashed) this.episode.crashed = true;

    if (this.goal) {
      const g = this.goal;
      const distance = Math.hypot(
        g.x - this.state.position.x,
        g.y - this.state.position.y,
        g.z - this.state.position.z,
      );
      if (distance <= g.radius) this.goalReached = true;
    }
  }

  // ---------------------------------------------------------------------
  // Input (Spec §32)
  // ---------------------------------------------------------------------

  setInputSource(source: SimulationInputSource | null): void {
    this.inputSource = source;
  }

  getControlMode(): ControlMode {
    return this.controlMode;
  }

  setControlMode(mode: ControlMode): void {
    this.controlMode = mode;
  }

  setInput(input: Partial<DroneControlInput>): void {
    this.automationInput.set(input);
  }

  clearInput(): void {
    this.automationInput.clear();
  }

  /** Normalized agent action (Spec §27). Identical to `setInput`. */
  act(action: Partial<DroneControlInput>): void {
    this.automationInput.set(action);
  }

  getInput(): DroneControlInput {
    return { ...this.lastInput };
  }

  private resolveInput(): DroneControlInput {
    if (this.controlMode === 'automation') {
      return this.automationInput.isActive()
        ? this.automationInput.getInput()
        : { ...NEUTRAL_INPUT };
    }

    if (!this.inputSource) {
      return this.automationInput.isActive()
        ? this.automationInput.getInput()
        : { ...NEUTRAL_INPUT };
    }

    const base = this.inputSource.getInput();
    if (!this.automationInput.isActive()) return base;

    // Automation overrides human input per-axis (Spec §32).
    const auto = this.automationInput.getInput();
    return {
      pitch: auto.pitch !== 0 ? auto.pitch : base.pitch,
      roll: auto.roll !== 0 ? auto.roll : base.roll,
      yaw: auto.yaw !== 0 ? auto.yaw : base.yaw,
      vertical: auto.vertical !== 0 ? auto.vertical : base.vertical,
      brake: auto.brake || base.brake,
    };
  }

  // ---------------------------------------------------------------------
  // State control (Spec §18, §34)
  // ---------------------------------------------------------------------

  getState(): DroneState {
    return cloneDroneState(this.state);
  }

  /**
   * Full reset: position, velocity, rotation, angular velocity, collision
   * state, automation input and episode statistics — without a page reload.
   */
  reset(options: ResetOptions = {}): void {
    if (options.seed !== undefined && options.seed !== this.layout.seed) {
      this.regenerateWorld(options.seed);
    }

    this.spawnPosition = options.position
      ? { ...options.position }
      : this.spawn.findSpawn({
          mode: options.spawn ?? 'default',
          altitude: this.controller.config.spawnAltitude,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        });

    this.placeAtSpawn();

    this.automationInput.clear();
    this.lastInput = { ...NEUTRAL_INPUT };
    this.timestep.reset();
    this.goal = null;
    this.goalReached = false;
    this.lastCollisionEvents = [];
    this.resetEpisodeStats();

    if (!options.keepPaused) {
      // Keep whatever pause state the caller already chose (tests pause after
      // reset; the demo stays running).
    }
  }

  private placeAtSpawn(): void {
    const spawn = this.spawnPosition;
    this.state = createDroneState({
      position: { ...spawn },
      rotation: { pitch: 0, yaw: 0, roll: 0 },
      altitude: spawn.y,
    });
  }

  teleport(position: Vec3): void {
    this.state.position.x = position.x;
    this.state.position.y = position.y;
    this.state.position.z = position.z;
    this.state.velocity.x = 0;
    this.state.velocity.y = 0;
    this.state.velocity.z = 0;
    this.state.altitude = position.y;
    this.state.speed = 0;
    this.state.collided = false;
    this.state.grounded = false;
    this.spawnPosition = { ...position };
  }

  setRotation(rotation: { pitch?: number; yaw?: number; roll?: number }): void {
    if (rotation.pitch !== undefined) this.state.rotation.pitch = rotation.pitch;
    if (rotation.yaw !== undefined) this.state.rotation.yaw = rotation.yaw;
    if (rotation.roll !== undefined) this.state.rotation.roll = rotation.roll;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.timestep.reset();
  }

  pause(): void {
    this.setPaused(true);
  }

  resume(): void {
    this.setPaused(false);
  }

  togglePause(): boolean {
    this.setPaused(!this.paused);
    return this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  getSpawnPosition(): Vec3 {
    return { ...this.spawnPosition };
  }

  setConfig(overrides: Partial<DroneConfig>): void {
    this.controller.setConfig(overrides);
    this.collision.setOptions({
      radius: this.controller.config.radius,
      crashSpeedThreshold: this.controller.config.crashSpeedThreshold,
      bounce: this.controller.config.collisionBounce,
      damping: this.controller.config.collisionDamping,
    });
  }

  getConfig(): DroneConfig {
    return { ...this.controller.config };
  }

  resetConfig(): void {
    this.controller.resetConfig();
    this.setConfig({});
  }

  /** Distance the drone currently is from the ground (0 when resting). */
  getAltitude(): number {
    return this.state.position.y;
  }

  /** Collision events produced by the most recent tick only. */
  getLastCollisionEvents(): CollisionEvent[] {
    return this.lastCollisionEvents.map((event) => ({ ...event }));
  }

  /** Cumulative collision tally since the last reset/episode start. */
  getCollisionCounts(): CollisionCounts {
    return { ...this.collisionCounts };
  }

  // ---------------------------------------------------------------------
  // Sensors + observation (Spec §25, §26, §27, §29)
  // ---------------------------------------------------------------------

  getSensors(range = SENSOR_RANGE): SensorReadout {
    const { position, rotation } = this.state;
    const sinYaw = Math.sin(rotation.yaw);
    const cosYaw = Math.cos(rotation.yaw);

    const forward: Vec3 = { x: -sinYaw, y: 0, z: -cosYaw };
    const right: Vec3 = { x: cosYaw, y: 0, z: -sinYaw };

    return {
      altitude: position.y,
      velocity: { ...this.state.velocity },
      heading: rotation.yaw,
      frontDistance: this.rayDistance(position, forward, range),
      backDistance: this.rayDistance(position, { x: -forward.x, y: 0, z: -forward.z }, range),
      leftDistance: this.rayDistance(position, { x: -right.x, y: 0, z: -right.z }, range),
      rightDistance: this.rayDistance(position, right, range),
      downDistance: Math.min(position.y, this.rayDistance(position, { x: 0, y: -1, z: 0 }, range) ?? position.y),
    };
  }

  private rayDistance(origin: Vec3, direction: Vec3, range: number): number | null {
    this.collisionChecks += 1;
    const hit = this.collision.firstBuildingAlong(origin, direction, range, 2.5);
    if (!hit) return null;

    // Refine to a rough surface distance along the ray.
    let distance = 0;
    const step = 2.5;
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const nx = direction.x / length;
    const ny = direction.y / length;
    const nz = direction.z / length;
    while (distance <= range) {
      distance += step;
      const px = origin.x + nx * distance;
      const py = origin.y + ny * distance;
      const pz = origin.z + nz * distance;
      if (
        Math.abs(px - hit.position.x) <= hit.size.x / 2 &&
        Math.abs(py - hit.position.y) <= hit.size.y / 2 &&
        Math.abs(pz - hit.position.z) <= hit.size.z / 2
      ) {
        return Math.max(0, distance - step * 0.5);
      }
    }
    return distance;
  }

  observe(range = SENSOR_RANGE): Observation {
    const sensors = this.getSensors(range);
    const { position, velocity, rotation, tick } = this.state;

    let goalDistance: number | null = null;
    let goalDirection: [number, number, number] | null = null;
    if (this.goal) {
      const dx = this.goal.x - position.x;
      const dy = this.goal.y - position.y;
      const dz = this.goal.z - position.z;
      const dist = Math.hypot(dx, dy, dz);
      goalDistance = dist;
      goalDirection = dist > 1e-9 ? [dx / dist, dy / dist, dz / dist] : [0, 0, 0];
    }

    return {
      tick,
      position: [position.x, position.y, position.z],
      velocity: [velocity.x, velocity.y, velocity.z],
      rotation: [rotation.pitch, rotation.yaw, rotation.roll],
      altitude: position.y,
      speed: this.state.speed,
      heading: rotation.yaw,
      sensors: {
        front: sensors.frontDistance,
        back: sensors.backDistance,
        left: sensors.leftDistance,
        right: sensors.rightDistance,
        down: sensors.downDistance,
      },
      collision: this.state.collided,
      crashed: this.state.crashed,
      grounded: this.state.grounded,
      goalDistance,
      goalDirection,
      goalReached: this.goalReached,
    };
  }

  // ---------------------------------------------------------------------
  // Goals (Spec §29)
  // ---------------------------------------------------------------------

  setGoal(goal: { x: number; y: number; z: number; radius?: number }): Goal {
    this.goal = { x: goal.x, y: goal.y, z: goal.z, radius: goal.radius ?? 5 };
    this.goalReached = false;
    return { ...this.goal };
  }

  getGoal(): Goal | null {
    return this.goal ? { ...this.goal } : null;
  }

  clearGoal(): void {
    this.goal = null;
    this.goalReached = false;
  }

  get goalIsReached(): boolean {
    return this.goalReached;
  }

  getGoalDistance(): number | null {
    if (!this.goal) return null;
    return Math.hypot(
      this.goal.x - this.state.position.x,
      this.goal.y - this.state.position.y,
      this.goal.z - this.state.position.z,
    );
  }

  // ---------------------------------------------------------------------
  // Episodes (Spec §28)
  // ---------------------------------------------------------------------

  startEpisode(options: StartEpisodeOptions = {}): EpisodeStats {
    const seed = options.seed ?? this.layout.seed;

    if (seed !== this.layout.seed || options.buildingTarget !== undefined) {
      this.regenerateWorld(seed, options.buildingTarget);
    }

    const spawnOption = options.spawn ?? 'random';
    if (typeof spawnOption === 'string') {
      this.reset({ spawn: spawnOption, seed });
    } else {
      this.reset({ position: spawnOption });
    }

    this.resetEpisodeStats();
    this.episodeActive = true;
    return this.endEpisodeSnapshot();
  }

  endEpisode(): EpisodeStats {
    this.episodeActive = false;
    return this.endEpisodeSnapshot();
  }

  get isEpisodeActive(): boolean {
    return this.episodeActive;
  }

  getEpisodeStats(): EpisodeStats {
    return this.endEpisodeSnapshot();
  }

  private endEpisodeSnapshot(): EpisodeStats {
    return {
      ticks: this.episode.ticks,
      duration: Math.round(this.episode.duration * 1000) / 1000,
      distanceTravelled: Math.round(this.episode.distanceTravelled * 100) / 100,
      collisions: this.episode.collisions,
      crashed: this.episode.crashed,
    };
  }

  private resetEpisodeStats(): void {
    this.episode = {
      ticks: 0,
      duration: 0,
      distanceTravelled: 0,
      collisions: 0,
      crashed: false,
    };
    this.collisionCounts = { building: 0, ground: 0, boundary: 0, total: 0 };
  }

  // ---------------------------------------------------------------------
  // World queries (Spec §24, §35)
  // ---------------------------------------------------------------------

  getNearbyBuildings(radius = 50, limit = 64): BuildingSnapshot[] {
    return this.buildings.getSnapshots(this.state.position, radius, limit);
  }

  getWorldInfo(): WorldInfo {
    const bounds = this.buildings.bounds;
    return {
      seed: this.layout.seed,
      worldSize: this.layout.worldSize,
      blockCountX: this.layout.blockCountX,
      blockCountZ: this.layout.blockCountZ,
      blockCount: this.layout.blocks.length,
      buildingCount: this.buildings.count,
      landmarkCount: this.layout.landmarks.length,
      roadWidth: this.layout.roadWidth,
      sidewalkWidth: this.layout.sidewalkWidth,
      spatialCellSize: this.buildings.cellSize,
      worldHalf: this.roads.worldHalf,
      bounds,
      spawn: { ...this.spawnPosition },
      testMode: this.testMode,
      goal: this.goal ? { ...this.goal } : null,
    };
  }

  setRenderMetrics(metrics: Partial<RenderMetrics>): void {
    this.renderMetrics = { ...this.renderMetrics, ...metrics };
  }

  getMetrics(): SimulationMetrics {
    return {
      fps: Math.round(this.renderMetrics.fps * 10) / 10,
      frameTimeMs: Math.round(this.renderMetrics.frameTimeMs * 100) / 100,
      drawCalls: this.renderMetrics.drawCalls,
      triangles: this.renderMetrics.triangles,
      tick: this.state.tick,
      simulationHz: this.timestep.hz,
      fixedDtMs: Math.round(FIXED_DT * 1000 * 1000) / 1000,
      paused: this.paused,
      buildingCount: this.buildings.count,
      droneSpeed: Math.round(this.state.speed * 1000) / 1000,
      altitude: Math.round(this.state.position.y * 1000) / 1000,
      collisionChecks: this.collisionChecks,
      activeBuildings: this.buildings.queryXZ(this.state.position, 120).length,
    };
  }

  resetMetricsCounters(): void {
    this.collisionChecks = 0;
  }

  /** Horizontal distance to a point, ignoring altitude. */
  horizontalDistanceTo(point: Vec3): number {
    return Math.hypot(point.x - this.state.position.x, point.z - this.state.position.z);
  }

  /** Internal: keeps the collision radius in sync with the config. */
  syncCollisionOptions(): void {
    this.collision.setOptions({
      radius: this.controller.config.radius,
      crashSpeedThreshold: this.controller.config.crashSpeedThreshold,
      bounce: this.controller.config.collisionBounce,
      damping: this.controller.config.collisionDamping,
    });
  }

  /** Exposed for tests: total horizontal speed in m/s. */
  getHorizontalSpeed(): number {
    return horizontalLength3(this.state.velocity);
  }

  /** Exposed for tests/demo: clamp helper re-exported for convenience. */
  static clamp = clamp;

  static defaultConfig(): DroneConfig {
    return mergeDroneConfig(DEFAULT_DRONE_CONFIG);
  }

  get fixedDt(): number {
    return this.timestep.dt;
  }

  static readonly neutralInput: DroneControlInput = { ...NEUTRAL_INPUT };

  /** Position of the world origin, handy for tests. */
  get origin(): Vec3 {
    return vec3(0, 0, 0);
  }
}
