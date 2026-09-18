/**
 * ReflexPolicy — optional local AIProvider (no network, no API key).
 *
 * A scripted policy implementing the survival/navigation primitives from
 * Spec §24–§26, driven by the safety constraints parsed from the human
 * command (min altitude, min obstacle distance). Offered in the Model
 * dropdown as "local reflex" so demos and tests run without an API key.
 *
 * This is a *decision policy*, not a simulation engine: it only ever reads
 * `DroneObservation` and emits `DroneAction`, exactly like the remote model.
 */
import type { AIProvider, AgentDecisionRequest, DroneAction } from './AgentProtocol';
import { clampUnit } from './AgentProtocol';

const CRUISE_ALTITUDE = 40;
/** Start evasive manoeuvres when the front sensor drops below this. */
const EVASIVE_FRONT = 45;
/** Turn away when a side sensor drops below this. */
const EVASIVE_SIDE = 16;

/** World forward at yaw 0 is -Z; forward(yaw) = (-sin, 0, -cos). */
function yawError(observation: AgentDecisionRequest['state'], dirX: number, dirZ: number): number {
  const yaw = observation.heading;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const cross = forwardZ * dirX - forwardX * dirZ; // y of forward × dir
  const dot = forwardX * dirX + forwardZ * dirZ;
  return Math.atan2(cross, dot); // >0 → target is to the left → yaw +
}

export class ReflexPolicy implements AIProvider {
  readonly model = 'local-reflex';

  async decide(request: AgentDecisionRequest): Promise<DroneAction> {
    const obs = request.state;
    const minAlt = Math.max(10, request.constraints?.minAltitude ?? 12);
    const minObs = Math.max(0.5, request.constraints?.minObstacleDistance ?? 3);

    let pitch = 0;
    let roll = 0;
    let yaw = 0;
    let vertical = 0;

    // --- Survival 1: never violate the minimum altitude ---------------------
    const altitudeMargin = obs.altitude - minAlt;
    if (altitudeMargin < 2) {
      // Hard floor: strong climb, overrides any descent.
      vertical = clampUnit(1 + (minAlt - obs.altitude) / 10);
    }

    // --- Survival 2: obstacles — where can I still go? ----------------------
    const front = obs.sensors.front;
    const left = obs.sensors.left ?? Infinity;
    const right = obs.sensors.right ?? Infinity;
    const closestLateral = Math.min(
      front ?? Infinity,
      left,
      right,
    );

    if (closestLateral - minObs < 1.5) {
      // Inside the danger margin: stop forward motion, brake hard, turn away.
      return { pitch: 0, roll: 0, yaw: left > right ? 1 : -1, vertical, brake: true };
    }

    // Evasive turn when something is ahead; pick the roomier side.
    if (front !== null && front < EVASIVE_FRONT) {
      const urgency = 1 - front / EVASIVE_FRONT;
      yaw = clampUnit((left > right ? urgency : -urgency) * 1.4);
      roll = left > right ? -urgency * 0.6 : urgency * 0.6; // slide to the roomy side
      // Throttle forward thrust down as the obstacle gets closer.
      pitch = clampUnit(((front - minObs * 2) / EVASIVE_FRONT) * 0.8);
    }

    // --- Task 1: destination steering --------------------------------------
    const dir = obs.goalDirection;
    let hasDirection = false;
    let dirX = 0;
    let dirZ = -1;
    if (dir && (dir[0] !== 0 || dir[2] !== 0)) {
      const len = Math.hypot(dir[0], dir[2]) || 1;
      dirX = dir[0] / len;
      dirZ = dir[2] / len;
      hasDirection = true;
    }

    if (hasDirection) {
      const err = yawError(obs, dirX, dirZ);
      // Blend task steering with the evasive turn (evasion wins when urgent).
      if (Math.abs(yaw) < 0.4) yaw = clampUnit(err * 1.6);
      const goalDistance = obs.goalDistance;
      let forwardDemand = 0.8;
      if (goalDistance !== null && goalDistance < 30) {
        forwardDemand = Math.max(0.12, (goalDistance / 30) * 0.8);
      }
      if (goalDistance !== null && goalDistance < 3) forwardDemand = 0;
      const taskDemand = clampUnit(forwardDemand * (1 - Math.min(1, Math.abs(err))));
      // When evasion throttled pitch down, take the weaker of the two.
      pitch = front !== null && front < EVASIVE_FRONT ? Math.min(taskDemand, Math.max(0, pitch)) : taskDemand;
      // Altitude: steer toward goal Y, but never below the floor.
      const targetAlt = Math.max(minAlt + 2, obs.altitude + (dir as [number, number, number])[1] * 20);
      vertical = clampUnit((targetAlt - obs.altitude) / 12);
    } else {
      // --- Task 2: survival cruise -----------------------------------------
      const cruise = Math.max(CRUISE_ALTITUDE, minAlt + 12);
      if (altitudeMargin >= 2) vertical = clampUnit((cruise - obs.altitude) / 20);
      pitch = Math.min(pitch <= 0 ? 0.55 : pitch, 0.55); // keep moving forward
    }

    // Gentle push away from close side walls.
    if (left < EVASIVE_SIDE && right > left + 4) yaw = clampUnit(yaw + 0.3);
    if (right < EVASIVE_SIDE && left > right + 4) yaw = clampUnit(yaw - 0.3);

    // Ground protection wins over everything except the goal stop.
    const down = obs.sensors.down;
    if (down !== null && down < Math.max(10, minAlt) && vertical <= 0) {
      vertical = clampUnit((Math.max(10, minAlt) - down) / 8);
    }
    if (obs.grounded) vertical = 1;

    // Arrived: brake.
    if (obs.goalReached || (obs.goalDistance !== null && obs.goalDistance < 2.5)) {
      return { pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: true };
    }
    if (obs.crashed) return { pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: true };

    return { pitch, roll, yaw, vertical, brake: false };
  }
}
