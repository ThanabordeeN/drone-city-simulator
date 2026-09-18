/**
 * JEV Decisions adapter (Spec §20) + chat fallback adapter for generic
 * OpenRouter chat models.
 *
 * JEV (typesafe/jev-1.13) does NOT generate text. It answers typed questions
 * about a state through OpenRouter's Decisions API and returns calibrated
 * probabilities: a yes/no probability (noul), a pick from options (choice) or
 * a position on an ordered rubric (score). Our code owns the workflow and
 * turns those answers into stick inputs.
 *
 * This file maps the drone state into JEV questions and maps the answers back
 * into a validated `DroneAction`. It is deliberately separate from
 * `OpenRouterClient`: the transport (HTTP) and the decision schema (JEV) must
 * not be coupled, and neither may know anything about the simulation core.
 */
import type {
  AgentTask,
  DroneAction,
  DroneObservation,
  JevAdapter,
  NearbyBuildingContext,
} from './AgentProtocol';
import { validateAction } from './AgentProtocol';

/** Round-trip friendly numbers (no 12-digit floats in the payload). */
function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sensorLine(value: number | null): number | null {
  return value === null ? null : round(value);
}

/**
 * Ordered rubric for the continuous axes. Index 0 → -1, middle → 0,
 * last index → +1. yaw + = turn LEFT (Three.js +Y), roll + = strafe RIGHT,
 * pitch + = forward (Z-), vertical + = ascend.
 */
export const JEV_RUBRIC_LENGTH = 5;

export const JEV_QUESTIONS = {
  pitch: {
    type: 'score' as const,
    instructions:
      'Should the drone pitch forward (move toward its nose direction, world -Z) or backward this cycle, given its speed, the goal and the obstacle sensors?',
    criteria: ['pitch backward hard', 'pitch backward', 'hold pitch', 'pitch forward', 'pitch forward hard'],
  },
  strafe: {
    type: 'score' as const,
    instructions:
      'Should the drone strafe right (X+) or left (X-) this cycle, considering obstacle sensors on each side?',
    criteria: ['strafe left hard', 'strafe left', 'hold strafe', 'strafe right', 'strafe right hard'],
  },
  yaw: {
    type: 'score' as const,
    instructions:
      'Should the drone turn left (+yaw) or right (-yaw) this cycle? Pick the turn that best aligns with the goal direction while avoiding obstacles.',
    criteria: ['turn right hard', 'turn right', 'hold heading', 'turn left', 'turn left hard'],
  },
  vertical: {
    type: 'score' as const,
    instructions:
      'Should the drone ascend or descend this cycle? Keep above the ground sensor and steer toward the goal altitude.',
    criteria: ['descend hard', 'descend', 'hold altitude', 'ascend', 'ascend hard'],
  },
  brake: {
    type: 'noul' as const,
    instructions:
      'Should the drone brake to a hover now? Answer yes when the goal is reached or a crash is imminent.',
    criteria: {
      true: 'Brake now: goal reached, obstacle extremely close, or survival demands a stop',
      false: 'Keep flying under control',
    },
  },
};

/**
 * The Decisions API request body: the drone state (object) plus typed
 * questions. Your code owns the workflow — we ask narrow questions and act on
 * the calibrated answers.
 */
export interface JevDecisionRequest {
  state: {
    task: string;
    drone: {
      position: number[];
      velocity: number[];
      altitude: number;
      speed: number;
      heading: number;
    };
    goal: {
      distance: number | null;
      direction: number[] | null;
      reached: boolean;
    };
    sensors: {
      front: number | null;
      back: number | null;
      left: number | null;
      right: number | null;
      down: number | null;
    };
    status: {
      collision: boolean;
      crashed: boolean;
      grounded: boolean;
    };
    nearbyBuildings?: { id: string; position: { x: number; y: number; z: number }; distance: number }[];
  };
  questions: typeof JEV_QUESTIONS;
}

/** The Decisions API response: answers keyed by question name. */
export interface JevDecisionResponse {
  answers?: Record<string, unknown>;
}

export class DefaultJevAdapter implements JevAdapter {
  createRequest(
    task: AgentTask,
    observation: DroneObservation,
    context?: NearbyBuildingContext[],
  ): JevDecisionRequest {
    return {
      state: {
        task: task.command,
        drone: {
          position: observation.position.map((v) => round(v)),
          velocity: observation.velocity.map((v) => round(v)),
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
          front: observation.sensors.front === null ? null : round(observation.sensors.front),
          back: observation.sensors.back === null ? null : round(observation.sensors.back),
          left: observation.sensors.left === null ? null : round(observation.sensors.left),
          right: observation.sensors.right === null ? null : round(observation.sensors.right),
          down: observation.sensors.down === null ? null : round(observation.sensors.down),
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
      },
      questions: JEV_QUESTIONS,
    };
  }

  /**
   * Map the Decisions API answers into a `DroneAction`:
   *   score  (position on the ordered rubric, 0..4)  → axis in [-1, +1]
   *   noul   (probability 0..1)                      → brake true/false
   * Uses the full distribution when present (expected position) for smoother
   * control, falls back to the point answer otherwise.
   */
  parseResponse(response: unknown): DroneAction {
    const answers = (response as JevDecisionResponse)?.answers;
    if (typeof answers !== 'object' || answers === null) {
      throw new Error('JEV response did not contain answers');
    }
    const axes: [keyof typeof JEV_QUESTIONS, 'pitch' | 'roll' | 'yaw' | 'vertical'][] = [
      ['pitch', 'pitch'],
      ['strafe', 'roll'],
      ['yaw', 'yaw'],
      ['vertical', 'vertical'],
    ];
    const action: Partial<DroneAction> = {};
    for (const [question, axis] of axes) {
      action[axis] = answerToUnit(answers[question], JEV_RUBRIC_LENGTH);
    }
    action.brake = toNoul(answers.brake) > 0.7;
    return validateAction(action);
  }
}

/**
 * Convert a score answer (position on the ordered rubric) into [-1, +1].
 * Accepts the point answer (`score`), a `choice` label matched against the
 * rubric, or a full distribution (`probabilities`) — in which case the
 * expected position is used.
 */
export function answerToUnit(answer: unknown, rubricLength: number): number {
  const last = rubricLength - 1;
  const normalize = (position: number): number => {
    const clamped = Math.max(0, Math.min(rubricLength - 1, position));
    return (clamped / last) * 2 - 1;
  };

  if (typeof answer === 'number') return normalize(answer);
  if (typeof answer !== 'object' || answer === null) return 0;

  const record = answer as { score?: unknown; choice?: unknown; probabilities?: unknown };

  // Full distribution: expected position gives smoother continuous control.
  if (Array.isArray(record.probabilities)) {
    const probs = record.probabilities as unknown[];
    if (probs.length === rubricLength && probs.every((p) => typeof p === 'number')) {
      let expected = 0;
      let total = 0;
      for (let i = 0; i < probs.length; i += 1) {
        expected += i * (probs[i] as number);
        total += probs[i] as number;
      }
      if (total > 0) return normalize(expected / total);
    }
  }

  if (typeof record.score === 'number') return normalize(record.score);

  if (typeof record.choice === 'string') {
    return 0; // unknown label: neutral
  }

  return 0;
}

// noul: probability from 0 (no) to 1 (yes).
function toNoul(answer: unknown): number {
  if (typeof answer === 'number') return answer;
  if (typeof answer === 'object' && answer !== null) {
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul === 'number') return noul;
  }
  return 0;
}

/**
 * ChatActionAdapter — for generic OpenRouter *chat* models (Spec §19):
 * asks for a single strict-JSON action and parses it defensively.
 */
const SYSTEM_PROMPT = `You are the flight controller of a drone inside a city simulator.

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

export class ChatActionAdapter implements JevAdapter {
  createRequest(
    task: AgentTask,
    observation: DroneObservation,
    context?: NearbyBuildingContext[],
  ): unknown {
    return {
      temperature: 0.1,
      max_tokens: 120,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(describeState(task, observation, context)) },
      ],
    };
  }

  parseResponse(response: unknown): DroneAction {
    const candidate = (response as { choices?: { message?: { content?: unknown } }[] })
      ?.choices?.[0]?.message?.content;
    if (typeof candidate !== 'string') {
      throw new Error('chat response has no message content');
    }
    const parsed = findActionObject(candidate);
    if (!parsed) throw new Error('chat response did not contain a parsable action JSON');
    return validateAction(parsed);
  }
}

function describeState(
  task: AgentTask,
  observation: DroneObservation,
  context?: NearbyBuildingContext[],
): Record<string, unknown> {
  return {
    task: task.command,
    drone: {
      position: observation.position.map((v) => round(v)),
      velocity: observation.velocity.map((v) => round(v)),
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
}

function findActionObject(content: string): DroneAction | null {
  const cleaned = content.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    const candidate = sliceBalanced(cleaned, start);
    if (candidate === null) break;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const action = typeof parsed.action === 'object' && parsed.action !== null
        ? parsed.action
        : ['pitch', 'roll', 'yaw', 'vertical'].some((key) => key in parsed)
          ? parsed
          : null;
      if (action) {
        // Validate now so JSON-string numbers etc. are normalized.
        const validated = validateAction(action);
        if (validated.pitch !== 0 || validated.roll !== 0 || validated.yaw !== 0 || validated.vertical !== 0) {
          return validated;
        }
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
