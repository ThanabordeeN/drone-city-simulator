/**
 * Drone state + configuration types (Spec §5, §6).
 *
 * `DroneState` is the source of truth of the whole simulator. The renderer
 * only ever *reads* it.
 */
import { clamp, horizontalLength3, length3, vec3, type Vec3 } from './vec3';

export type { Vec3 };

/** Attitude in radians. Y+ = up, X+ = right, Z- = forward. */
export interface DroneRotation {
  /** Positive = nose up. */
  pitch: number;
  /** Positive = turn left (counter-clockwise seen from above). */
  yaw: number;
  /** Positive = right side down. */
  roll: number;
}

export interface DroneAngularVelocity {
  pitch: number;
  yaw: number;
  roll: number;
}

export interface DroneState {
  position: Vec3;
  velocity: Vec3;
  rotation: DroneRotation;
  angularVelocity: DroneAngularVelocity;

  /** Height of the drone centre above the ground plane, in metres. */
  altitude: number;

  grounded: boolean;
  collided: boolean;
  crashed: boolean;

  /** Horizontal + vertical speed magnitude in m/s. */
  speed: number;

  /** Monotonic simulation tick counter (fixed-rate, never wall-clock). */
  tick: number;
}

/** Normalized control input, every axis in `[-1, +1]`. */
export interface DroneControlInput {
  pitch: number;
  roll: number;
  yaw: number;
  vertical: number;
  brake?: boolean;
}

export interface DroneConfig {
  maxHorizontalSpeed: number;
  maxVerticalSpeed: number;

  horizontalAcceleration: number;
  verticalAcceleration: number;

  yawSpeed: number;

  /** Fraction of velocity kept per second (air drag). 0.92 ≈ arcade feel. */
  drag: number;

  /** Vertical drag is usually stronger than horizontal drag. */
  verticalDrag: number;

  maxPitch: number;
  maxRoll: number;

  autoLevel: boolean;
  /** How fast attitude returns to level when the sticks are centred (rad/s). */
  autoLevelRate: number;
  /** How fast attitude tracks the commanded tilt (rad/s). */
  attitudeRate: number;

  /** Active braking deceleration when `input.brake` is true (m/s²). */
  brakeAcceleration: number;
  /** Velocity kept per second while braking. */
  brakeDrag: number;

  /** Collision sphere radius of the drone, in metres (spec: 0.6 – 1.0). */
  radius: number;

  /** Impact speed above which a collision counts as a crash (m/s). */
  crashSpeedThreshold: number;

  /** Restitution applied to the velocity component hitting a surface. */
  collisionBounce: number;
  /** Velocity kept per second after a collision impact. */
  collisionDamping: number;

  /** Default spawn height above ground, in metres. */
  spawnAltitude: number;
}

export const DEFAULT_DRONE_CONFIG: DroneConfig = {
  maxHorizontalSpeed: 20,
  maxVerticalSpeed: 10,

  horizontalAcceleration: 14,
  verticalAcceleration: 10,

  yawSpeed: 1.8,

  drag: 0.92,
  verticalDrag: 0.86,

  maxPitch: 0.45,
  maxRoll: 0.45,

  autoLevel: true,
  autoLevelRate: 3.2,
  attitudeRate: 6.0,

  brakeAcceleration: 26,
  brakeDrag: 0.02,

  radius: 0.8,
  crashSpeedThreshold: 8,

  collisionBounce: 0.12,
  collisionDamping: 0.25,

  spawnAltitude: 0.8,
};

export const NEUTRAL_INPUT: DroneControlInput = Object.freeze({
  pitch: 0,
  roll: 0,
  yaw: 0,
  vertical: 0,
  brake: false,
});

export function createControlInput(partial: Partial<DroneControlInput> = {}): DroneControlInput {
  return {
    pitch: clamp(partial.pitch ?? 0, -1, 1),
    roll: clamp(partial.roll ?? 0, -1, 1),
    yaw: clamp(partial.yaw ?? 0, -1, 1),
    vertical: clamp(partial.vertical ?? 0, -1, 1),
    brake: partial.brake ?? false,
  };
}

export function createDroneState(overrides: Partial<DroneState> = {}): DroneState {
  return {
    position: overrides.position ? { ...overrides.position } : vec3(0, 0, 0),
    velocity: overrides.velocity ? { ...overrides.velocity } : vec3(0, 0, 0),
    rotation: overrides.rotation ? { ...overrides.rotation } : { pitch: 0, yaw: 0, roll: 0 },
    angularVelocity: overrides.angularVelocity
      ? { ...overrides.angularVelocity }
      : { pitch: 0, yaw: 0, roll: 0 },
    altitude: overrides.altitude ?? 0,
    grounded: overrides.grounded ?? false,
    collided: overrides.collided ?? false,
    crashed: overrides.crashed ?? false,
    speed: overrides.speed ?? 0,
    tick: overrides.tick ?? 0,
  };
}

/** Deep clone so automation consumers can never mutate the live state. */
export function cloneDroneState(state: DroneState): DroneState {
  return {
    position: { ...state.position },
    velocity: { ...state.velocity },
    rotation: { ...state.rotation },
    angularVelocity: { ...state.angularVelocity },
    altitude: state.altitude,
    grounded: state.grounded,
    collided: state.collided,
    crashed: state.crashed,
    speed: state.speed,
    tick: state.tick,
  };
}

/** Recompute derived fields (`speed`) from the raw integrator output. */
export function refreshDerivedState(state: DroneState): DroneState {
  state.speed = length3(state.velocity);
  return state;
}

export function horizontalSpeedOf(state: DroneState): number {
  return horizontalLength3(state.velocity);
}

export function mergeDroneConfig(
  base: DroneConfig,
  overrides: Partial<DroneConfig> = {},
): DroneConfig {
  return { ...base, ...overrides };
}
