/**
 * CommandParser (Spec §9, §10, §22).
 *
 * Turns a natural-language command into a structured task before the agent
 * loop starts. When a destination is found the *controller* calls
 * `sim.setGoal()` — the agent itself never has to remember coordinates; every
 * cycle it just reads `goalDirection` / `goalDistance` from `observe()`.
 *
 * Pure string → data mapping: no DOM, no simulation access.
 */
import type { AgentTask, CommandConstraints } from './AgentProtocol';

export type CommandKind = 'destination' | 'altitude' | 'freeform';

export interface ParsedCommand {
  raw: string;
  kind: CommandKind;
  /** World-coordinate destination (Spec §42: X+ right, Y+ up, Z- forward). */
  goal?: { x: number; y: number; z: number };
  /** Metres above the ground for "บินขึ้นไปสูง 50 เมตร". */
  altitudeTarget?: number;
  /** Safety rules parsed from the command ("do not fly lower than 10 m"...). */
  constraints?: CommandConstraints;
  /** Loose intent hints used in the agent prompt (demo scenarios §49–§51). */
  hints: {
    circle: boolean;
    forward: boolean;
    avoidObstacles: boolean;
    maintainAltitude: boolean;
  };
}

const NUMBER = '(-?\\d+(?:\\.\\d+)?)';

function matchNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Extract survival constraints like "do not fly lower than 10 m". */
export function parseConstraints(text: string): CommandConstraints {
  const constraints: CommandConstraints = {};

  // "do not fly lower than 10 m" / "not below 10" / "ห้ามต่ำกว่า 10 เมตร"
  const minAlt = matchNumber(text, new RegExp(`(?:lower than|below|under|ต่ำกว่า|ต่ำลงกว่า)\\s*${NUMBER}\\s*(?:m\\b|เมตร|metres?|meters?)?`, 'i'));
  if (minAlt !== null) constraints.minAltitude = Math.max(0, minAlt);

  // "fly above 50 m" → min; "do not fly higher than 80 m" → max.
  // The negation before "higher than/above" flips the meaning.
  const above = text.match(new RegExp(`(?:higher than|above|สูงกว่า)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:m\\b|เมตร|metres?)?`, 'i'));
  if (above) {
    const prefix = text.slice(Math.max(0, (above.index ?? 0) - 20), above.index);
    const negated = /(?:not|never|don't|ห้าม|ไม่)\s*(?:fly|go|บิน)?\s*(?:higher than|above|สูงกว่า)?\s*$/i.test(prefix) || /(?:not|never|ห้าม|ไม่)[^\d.]*$/i.test(prefix);
    if (negated) constraints.maxAltitude = Number(above[1]);
    else if (minAlt === null) constraints.minAltitude = Number(above[1]);
  }

  // "do not come closer than 3 m to a building" / "not within 3 m" / "ห้ามเข้าใกล้ตึก 3 เมตร"
  const minObs =
    matchNumber(text, new RegExp(`(?:closer than|nearer than|within)\\s*[^\\d-]{0,12}(\\d+(?:\\.\\d+)?)\\s*(?:m\\b|เมตร)?`, 'i')) ??
    matchNumber(text, new RegExp(`(?:close to|เข้าใกล้|ใกล้กว่า|ใกล้กับ)[^\\d-]{0,24}?(\\d+(?:\\.\\d+)?)\\s*(?:m\\b|เมตร)?`, 'i'));
  if (minObs !== null && minObs > 0) constraints.minObstacleDistance = Math.min(50, minObs);

  return Object.keys(constraints).length > 0 ? constraints : {};
}

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  const constraints = parseConstraints(text);
  const hints = {
    circle: /วงกลม|ก้ำ|circle|orbit|loop/i.test(text),
    forward: /ข้างหน้า|เดินหน้า|ไปข้าง|forward|straight ahead/i.test(text),
    avoidObstacles: true,
    maintainAltitude: /รักษาความสูง|ความสูงคงที่|maintain (?:the )?altitude/i.test(text),
  };

  // --- Explicit axis syntax: x=400 y=50 z=-250 / x:400, y:50, z:-250 --------
  const x = matchNumber(text, new RegExp(`\\bx\\s*[=:]\\s*${NUMBER}`, 'i'));
  const y = matchNumber(text, new RegExp(`\\by\\s*[=:]\\s*${NUMBER}`, 'i'));
  const z = matchNumber(text, new RegExp(`\\bz\\s*[=:]\\s*${NUMBER}`, 'i'));
  if (x !== null && z !== null) {
    return {
      raw: text,
      kind: 'destination',
      goal: { x, y: y ?? 40, z },
      hints,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  }

  // --- Thai/plain triplet: "พิกัด 200 40 -500", "บินไปที่ 400 50 -250" -------
  const triplet = text.match(
    new RegExp(`(?:พิกัด|พิกัดที่|coordinate|coords?|ไปที่|ไปที่จุด|ที่ตำแหน่ง)\\s*[^\\d-]{0,12}${NUMBER}\\s*[,\\s]+${NUMBER}\\s*[,\\s]+${NUMBER}`, 'i'),
  );
  if (triplet) {
    return {
      raw: text,
      kind: 'destination',
      goal: { x: Number(triplet[1]), y: Number(triplet[2]), z: Number(triplet[3]) },
      hints,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  }

  // --- Bare triplet anywhere (e.g. "บินไป 400 50 -250") ----------------------
  const bare = text.match(new RegExp(`${NUMBER}\\s*[,\\s]+${NUMBER}\\s*[,\\s]+${NUMBER}`));
  if (bare) {
    return {
      raw: text,
      kind: 'destination',
      goal: { x: Number(bare[1]), y: Number(bare[2]), z: Number(bare[3]) },
      hints,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  }

  // --- Altitude-only command: "บินขึ้นไปสูง 50 เมตร" --------------------------
  const altitude =
    matchNumber(text, new RegExp(`(?:สูง|สูงขึ้น|height|altitude)\\s*(?:ที่\\s*)?${NUMBER}\\s*(?:เมตร|m\\b|เมตร)?`, 'i')) ??
    matchNumber(text, new RegExp(`(?:ขึ้นไป|ascend to|climb to)\\s*${NUMBER}`, 'i'));
  if (altitude !== null) {
    return {
      raw: text,
      kind: 'altitude',
      altitudeTarget: Math.max(2, altitude),
      hints,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  }

  return {
    raw: text,
    kind: 'freeform',
    hints,
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
  };
}

/** Build the immutable task object handed to the agent loop (Spec §10). */
export function createTask(parsed: ParsedCommand, startedAt: number): AgentTask {
  return {
    command: parsed.raw,
    startedAt,
    ...(parsed.goal ? { goal: parsed.goal } : {}),
    ...(parsed.constraints ? { constraints: parsed.constraints } : {}),
  };
}
