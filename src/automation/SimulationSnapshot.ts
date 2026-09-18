/**
 * SimulationSnapshot (Spec §24, §25, §26, §35).
 *
 * Serialization boundary between the live simulation objects and the plain
 * JSON structures that automation clients (Playwright, agents, external
 * tooling) receive. Everything returned here is a deep copy, so a client can
 * never mutate the simulation by holding on to a result.
 */
import type { BuildingSnapshot } from '../world/BuildingSystem';
import type { DroneControlInput, DroneState } from '../simulation/DroneState';
import type {
  EpisodeStats,
  Observation,
  RenderMetrics,
  SensorReadout,
  SimulationMetrics,
  WorldInfo,
} from '../simulation/DroneSimulation';
import type { DroneSimulation } from '../simulation/DroneSimulation';

export type {
  BuildingSnapshot,
  DroneControlInput,
  DroneState,
  EpisodeStats,
  Observation,
  RenderMetrics,
  SensorReadout,
  SimulationMetrics,
  WorldInfo,
};

/** Compact sensor payload used by `observe()` (Spec §26). */
export interface SensorSnapshot {
  front: number | null;
  back: number | null;
  left: number | null;
  right: number | null;
  down: number | null;
}

export interface GoalSnapshot {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export function toState(simulation: DroneSimulation): DroneState {
  return simulation.getState();
}

export function toInput(simulation: DroneSimulation): DroneControlInput {
  return simulation.getInput();
}

export function toSensors(simulation: DroneSimulation, range?: number): SensorReadout {
  return range === undefined ? simulation.getSensors() : simulation.getSensors(range);
}

export function toObservation(simulation: DroneSimulation, range?: number): Observation {
  return range === undefined ? simulation.observe() : simulation.observe(range);
}

export function toBuildingSnapshots(
  simulation: DroneSimulation,
  radius = 50,
  limit = 64,
): BuildingSnapshot[] {
  return simulation.getNearbyBuildings(radius, limit);
}

export function toWorldInfo(simulation: DroneSimulation): WorldInfo {
  return simulation.getWorldInfo();
}

export function toMetrics(simulation: DroneSimulation): SimulationMetrics {
  return simulation.getMetrics();
}

export function toEpisodeStats(simulation: DroneSimulation): EpisodeStats {
  return simulation.getEpisodeStats();
}

/** Everything an agent needs in one round trip, as a single JSON object. */
export interface FullSnapshot {
  state: DroneState;
  input: DroneControlInput;
  observation: Observation;
  sensors: SensorReadout;
  world: WorldInfo;
  metrics: SimulationMetrics;
  episode: EpisodeStats;
  goal: GoalSnapshot | null;
}

export function toFullSnapshot(simulation: DroneSimulation): FullSnapshot {
  return {
    state: toState(simulation),
    input: toInput(simulation),
    observation: toObservation(simulation),
    sensors: toSensors(simulation),
    world: toWorldInfo(simulation),
    metrics: toMetrics(simulation),
    episode: toEpisodeStats(simulation),
    goal: simulation.getGoal(),
  };
}
