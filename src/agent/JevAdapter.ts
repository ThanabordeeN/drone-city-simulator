/**
 * JevAdapter (Spec §20).
 *
 * Maps the simulation observation into the JEV decision schema (a JSON-only
 * chat-completions request) and maps the model's reply back into a validated
 * `DroneAction`. This is deliberately separate from `OpenRouterClient`: the
 * transport (HTTP) and the decision schema (JEV) must not be coupled to each
 * other, and neither may know anything about the simulation core.
 */
import type {
  AgentTask,
  DroneAction,
  DroneObservation,
  JevAdapter,
  NearbyBuildingContext,
} from './AgentProtocol';
import { validateAction } from './AgentProtocol';

/** Round-trip friendly numbers for the prompt (no 12-digit floats). */
function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const SYSTEM_PROMPT = `You are JEV, the flight controller of a drone inside a city simulator.

You receive, every cycle:
- task: the human command (may be Thai or English)
- drone: position, velocity, altitude, speed, heading
- goal: distance, unit direction vector (world coords: X+ right, Y+ up, Z- forward), reached
- sensors: distance in metres to the nearest obstacle in each direction (null = nothing in range)
- status: collision / crashed / grounded flags

Rules:
1. Reply with ONE JSON object and nothing else. No markdown, no prose.
2. Schema: {"action":{"pitch":<number>,"roll":<number>,"yaw":<number>,"vertical":<number>,"brake":<boolean>}}
3. Every axis must be in [-1, +1]. pitch + = fly forward (Z-), roll + = strafe right (X+), yaw + = turn left, vertical + = ascend.
4. If a goal is present: steer toward goalDirection, keep altitude near the goal Y, slow down when goalDistance < 30, stop when reached.
5. Avoid buildings: if front < 25, turn toward the clearer side and reduce pitch.
6. Never fly into the ground: keep down > 10 or climb.
7. Survive first, obey the task second.`;

function sensorLine(value: number | null): string {
  return value === null ? 'null (clear)' : `${round(value)}m`;
}

export class DefaultJevAdapter implements JevAdapter {
  createRequest(
    task: AgentTask,
    observation: DroneObservation,
    context?: NearbyBuildingContext[],
  ): unknown {
    const payload = {
      task: task.command,
      drone: {
        position: observation.position.map((v) => round(v)) as number[],
        velocity: observation.velocity.map((v) => round(v)) as number[],
        altitude: round(observation.altitude),
        speed: round(observation.speed),
        heading: round(observation.heading, 2),
      },
      goal: {
        distance: observation.goalDistance === null ? null : round(observation.goalDistance),
        direction: observation.goalDirection === null ? null : observation.goalDirection.map((v) => round(v, 2)),
        reached: observation.goalReached,
      },
      sensors: {
        front: sensorLine(observation.sensors.front),
        back: sensorLine(observation.sensors.back),
        left: sensorLine(observation.sensors.left),
        right: sensorLine(observation.sensors.right),
        down: sensorLine(observation.sensors.down),
      },
      status: {
        collision: observation.collision,
        crashed: observation.crashed,
        grounded: observation.grounded,
      },
      ...(context && context.length > 0
        ? {
            nearbyBuildings: context.slice(0, 8).map((building) => ({
              id: building.id,
              position: {
                x: round(building.position.x),
                y: round(building.position.y),
                z: round(building.position.z),
              },
              distance: round(building.distance),
            })),
          }
        : {}),
    };

    return {
      temperature: 0.1,
      max_tokens: 120,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    };
  }

  /**
   * Extract `{"action": {...}}` from the model reply (Spec §13: structured
   * actions only — any JavaScript coming back is ignored).
   */
  parseResponse(response: unknown): DroneAction {
    const content = extractContent(response);
    const candidate = findActionObject(content);
    if (!candidate) {
      throw new Error('JEV response did not contain a parsable action JSON');
    }
    const action = unwrapAction(candidate);
    if (!action) {
      throw new Error('JEV response did not contain a parsable action JSON');
    }
    return validateAction(action);
  }
}

function extractContent(response: unknown): string {
  const candidate = response as { choices?: { message?: { content?: unknown } }[] };
  const raw = candidate?.choices?.[0]?.message?.content;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') return JSON.stringify(raw);
  throw new Error('JEV response has no message content');
}

function unwrapAction(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.action === 'object' && record.action !== null) return record.action;
  if (['pitch', 'roll', 'yaw', 'vertical'].some((key) => key in record)) return record;
  return null;
}

function findActionObject(content: string): unknown {
  // Strip markdown fences, then walk the text for balanced JSON objects and
  // keep the first one that contains an "action" key.
  const cleaned = content.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    const candidate = sliceBalanced(cleaned, start);
    if (candidate === null) break;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.action === 'object' && parsed.action !== null) return parsed;
      if (
        ['pitch', 'roll', 'yaw', 'vertical'].some((key) => key in parsed)
      ) {
        return { action: parsed };
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function sliceBalanced(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

