/**
 * Drone flight dynamics (Spec §6).
 *
 * Simplified arcade/semi-realistic model: the sticks command an attitude, the
 * attitude produces thrust, and inertial velocity decays through drag.
 * Deliberately simple (no motor mixing, no aerodynamic moments) but it has
 * acceleration, inertia, drag, braking and auto-level, which is what the
 * navigation/automation experiments need.
 *
 * The controller is pure: given `(state, input, dt)` it advances the state.
 * It never touches the renderer, the DOM, or wall-clock time.
 */
import {
  DEFAULT_DRONE_CONFIG,
  mergeDroneConfig,
  type DroneConfig,
  type DroneControlInput,
  type DroneState,
} from './DroneState';
import { clamp, clampSymmetric, horizontalLength3, wrapAngle } from './vec3';

function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export class DroneController {
  config: DroneConfig;

  constructor(config: Partial<DroneConfig> = {}) {
    this.config = mergeDroneConfig(DEFAULT_DRONE_CONFIG, config);
  }

  setConfig(overrides: Partial<DroneConfig>): void {
    this.config = mergeDroneConfig(this.config, overrides);
  }

  /** Restore the spec defaults (used by `reset()`). */
  resetConfig(): void {
    this.config = { ...DEFAULT_DRONE_CONFIG };
  }

  /**
   * Advance the drone by exactly `dt` seconds.
   *
   * Order of operations matters for determinism:
   *   1. attitude + yaw
   *   2. thrust from attitude
   *   3. drag / braking
   *   4. speed limits
   *   5. position integration
   */
  update(state: DroneState, input: DroneControlInput, dt: number): void {
    const cfg = this.config;
    const brake = input.brake === true;
    const pitchInput = clamp(input.pitch, -1, 1);
    const rollInput = clamp(input.roll, -1, 1);
    const yawInput = clamp(input.yaw, -1, 1);
    const verticalInput = clamp(input.vertical, -1, 1);

    // ---- 1. Attitude ------------------------------------------------------
    const targetPitch = pitchInput * cfg.maxPitch;
    const targetRoll = rollInput * cfg.maxRoll;

    const prevPitch = state.rotation.pitch;
    const prevRoll = state.rotation.roll;
    const prevYaw = state.rotation.yaw;

    const attitudeStep = cfg.attitudeRate * dt;
    if (pitchInput !== 0) {
      state.rotation.pitch = moveTowards(state.rotation.pitch, targetPitch, attitudeStep);
    } else if (cfg.autoLevel) {
      state.rotation.pitch = moveTowards(state.rotation.pitch, 0, cfg.autoLevelRate * dt);
    }

    if (rollInput !== 0) {
      state.rotation.roll = moveTowards(state.rotation.roll, targetRoll, attitudeStep);
    } else if (cfg.autoLevel) {
      state.rotation.roll = moveTowards(state.rotation.roll, 0, cfg.autoLevelRate * dt);
    }

    // Positive yaw = turn left (Three.js +Y rotation).
    const yawRate = yawInput * cfg.yawSpeed;
    state.rotation.yaw = wrapAngle(state.rotation.yaw + yawRate * dt);

    state.angularVelocity.pitch = (state.rotation.pitch - prevPitch) / dt;
    state.angularVelocity.roll = (state.rotation.roll - prevRoll) / dt;
    state.angularVelocity.yaw = wrapAngle(state.rotation.yaw - prevYaw) / dt;

    // ---- 2. Thrust --------------------------------------------------------
    const alive = !state.crashed;

    const pitchRatio = cfg.maxPitch > 0 ? clampSymmetric(state.rotation.pitch / cfg.maxPitch, 1) : 0;
    const rollRatio = cfg.maxRoll > 0 ? clampSymmetric(state.rotation.roll / cfg.maxRoll, 1) : 0;

    const sinYaw = Math.sin(state.rotation.yaw);
    const cosYaw = Math.cos(state.rotation.yaw);
    // Y+ up, X+ right, Z- forward.
    const forwardX = -sinYaw;
    const forwardZ = -cosYaw;
    const rightX = cosYaw;
    const rightZ = -sinYaw;

    if (alive && !brake) {
      const accel = cfg.horizontalAcceleration;
      state.velocity.x += (forwardX * pitchRatio + rightX * rollRatio) * accel * dt;
      state.velocity.z += (forwardZ * pitchRatio + rightZ * rollRatio) * accel * dt;

      state.velocity.y += verticalInput * cfg.verticalAcceleration * dt;
    }

    if (alive && brake) {
      // Explicit braking: strong, linear deceleration toward hover.
      const horizontalSpeed = horizontalLength3(state.velocity);
      if (horizontalSpeed > 0) {
        const drop = Math.min(cfg.brakeAcceleration * dt, horizontalSpeed);
        const scale = (horizontalSpeed - drop) / horizontalSpeed;
        state.velocity.x *= scale;
        state.velocity.z *= scale;
      }
      const verticalDrop = Math.min(cfg.brakeAcceleration * dt, Math.abs(state.velocity.y));
      state.velocity.y -= Math.sign(state.velocity.y) * verticalDrop;
    }

    // ---- 3. Drag ----------------------------------------------------------
    const horizontalDrag = Math.pow(cfg.drag, dt);
    const verticalDrag = Math.pow(cfg.verticalDrag, dt);

    if (brake) {
      const brakeDrag = Math.pow(cfg.brakeDrag, dt);
      state.velocity.x *= Math.min(horizontalDrag, brakeDrag);
      state.velocity.z *= Math.min(horizontalDrag, brakeDrag);
      state.velocity.y *= Math.min(verticalDrag, brakeDrag);
    } else {
      state.velocity.x *= horizontalDrag;
      state.velocity.z *= horizontalDrag;
      state.velocity.y *= verticalDrag;
    }

    if (state.crashed) {
      // A crashed drone is dead weight: it bleeds off energy and stops.
      const deadDrag = Math.pow(0.02, dt);
      state.velocity.x *= deadDrag;
      state.velocity.y *= deadDrag;
      state.velocity.z *= deadDrag;
    }

    // ---- 4. Speed limits --------------------------------------------------
    const horizontalSpeed = horizontalLength3(state.velocity);
    if (horizontalSpeed > cfg.maxHorizontalSpeed) {
      const scale = cfg.maxHorizontalSpeed / horizontalSpeed;
      state.velocity.x *= scale;
      state.velocity.z *= scale;
    }
    state.velocity.y = clampSymmetric(state.velocity.y, cfg.maxVerticalSpeed);

    // ---- 5. Integrate -----------------------------------------------------
    state.position.x += state.velocity.x * dt;
    state.position.y += state.velocity.y * dt;
    state.position.z += state.velocity.z * dt;
  }
}
