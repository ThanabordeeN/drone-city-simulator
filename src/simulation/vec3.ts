/**
 * Minimal allocation-conscious vector math used by the simulation core.
 *
 * The simulation core must never depend on `three` so that it can run
 * headless (Vitest / Node) without a WebGL context.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copyVec3(target: Vec3, source: Vec3): Vec3 {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  return target;
}

export function setVec3(target: Vec3, x: number, y: number, z: number): Vec3 {
  target.x = x;
  target.y = y;
  target.z = z;
  return target;
}

export function length3(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function horizontalLength3(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp a value to `[-limit, limit]` in place-free form. */
export function clampSymmetric(value: number, limit: number): number {
  return clamp(value, -limit, limit);
}

/**
 * Normalize an angle into `[-PI, PI]`.
 */
export function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Round to `digits` decimals; used to keep automation payloads tidy. */
export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundVec3(v: Vec3, digits = 4): Vec3 {
  return { x: round(v.x, digits), y: round(v.y, digits), z: round(v.z, digits) };
}
