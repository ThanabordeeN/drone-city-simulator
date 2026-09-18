/**
 * ReflexPolicy — optional local AIProvider (no network, no API key).
 *
 * A small scripted policy implementing the navigation primitives from
 * Spec §24–§26 (steer to goal, obstacle avoidance, altitude control). It is
 * offered in the Model dropdown as "local reflex" so the three required demo
 * scenarios can run without spending OpenRouter tokens, and it keeps the
 * agent loop unit-testable in Node.
 *
 * This is a *decision policy*, not a simulation engine: it only ever reads
 * `DroneObservation` and emits `DroneAction`, exactly like the remote model.
 */
import type { AIProvider, AgentDecisionRequest, DroneAction } from './AgentProtocol';
import { clampUnit } from './AgentProtocol';

/** World forward at yaw 0 is -Z; forward(yaw) = (-sin, 0, -cos). */
function yawError(observation: AgentDecisionRequest['state'], dirX: number, dirZ: number): number {
  const yaw = observation.heading;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const cross = forwardZ * dirX - forwardX * dirZ; // y of forward × dir
  const dot = forwardX * dirX + forwardZ * dirZ;
  return Math.atan2(cross, dot); // >0 → goal is to the left → yaw +
}

const SAFE_FRONT = 28;
const SAFE_DOWN = 10;
const SAFE_SIDE = 12;
const CRUISE_ALTITUDE = 35;

export class ReflexPolicy implements AIProvider {
  readonly model = 'local-reflex';

  async decide(request: AgentDecisionRequest): Promise<DroneAction> {
    const obs = request.state;

    // 1) Survival: never touch the ground.
    const down = obs.sensors.down;
    let vertical = 0;
    let pitch = 0;
    let yaw = 0;
    let brake = false;

    // 2) Where to go?
    const dir = obs.goalDirection;
    let dirX = 0;
    let dirZ = -1;
    let hasDirection = false;
    if (dir && (dir[0] !== 0 || dir[2] !== 0)) {
      const len = Math.hypot(dir[0], dir[2]) || 1;
      dirX = dir[0] / len;
      dirZ = dir[2] / len;
      hasDirection = true;
    }

    const err = hasDirection ? yawError(obs, dirX, dirZ) : 0;
    yaw = clampUnit(err * 1.6);

    // 3) Forward drive, scaled down near the goal and by strong turns.
    const goalDistance = obs.goalDistance;
    let forwardDemand = hasDirection ? 0.8 : 0.6;
    if (goalDistance !== null && goalDistance < 30) {
      forwardDemand = Math.max(0.12, (goalDistance / 30) * 0.8);
    }
    if (goalDistance !== null && goalDistance < 3) forwardDemand = 0;
    pitch = clampUnit(forwardDemand * (1 - Math.min(1, Math.abs(err))));

    // 4) Altitude control (Spec §26): goal Y, else cruise band.
    if (dir && hasDirection) {
      vertical = clampUnit(dir[1] * 1.2);
    }
    if (!hasDirection) {
      const bandError = CRUISE_ALTITUDE - obs.altitude;
      vertical = clampUnit(bandError / 15);
    }

    // 5) Obstacle avoidance (Spec §25): front blocked → turn to clearer side.
    const front = obs.sensors.front;
    const left = obs.sensors.left ?? Infinity;
    const right = obs.sensors.right ?? Infinity;
    if (front !== null && front < SAFE_FRONT) {
      const urgency = 1 - front / SAFE_FRONT;
      if (left > right) yaw = clampUnit(yaw + urgency);
      else yaw = clampUnit(yaw - urgency);
      pitch = Math.min(pitch, Math.max(0, front - SAFE_FRONT / 2) / SAFE_FRONT);
      // Slide around the obstacle on the clearer side.
      pitch = Math.min(pitch, 0.25);
    }
    if (left < SAFE_SIDE && right > left + 4) yaw = clampUnit(yaw + 0.25);
    if (right < SAFE_SIDE && left > right + 4) yaw = clampUnit(yaw - 0.25);

    // 6) Ground protection wins over everything except goal stop.
    if (down !== null && down < SAFE_DOWN && vertical <= 0) {
      vertical = clampUnit((SAFE_DOWN - down) / 8);
    }
    if (obs.grounded) vertical = 1;

    // 7) Arrived: brake.
    if (obs.goalReached || (goalDistance !== null && goalDistance < 2.5)) {
      return { pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: true };
    }
    if (obs.crashed) return { pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: true };

    return { pitch, roll: 0, yaw, vertical, brake };
  }
}
