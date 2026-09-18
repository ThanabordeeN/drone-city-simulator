/**
 * Collision detection + response (Spec §13, §14).
 *
 * Drone ↔ Building and Drone ↔ Ground. The spatial grid in `BuildingSystem`
 * keeps this O(neighbourhood) instead of O(buildings).
 */
import { sphereAabbResolution, type BuildingRecord, type BuildingSystem } from '../world/BuildingSystem';
import type { RoadSystem } from '../world/RoadSystem';
import type { Vec3 } from './vec3';

export interface CollisionEvent {
  type: 'building' | 'ground' | 'boundary';
  /** Speed along the surface normal at the moment of impact (m/s). */
  impactSpeed: number;
  normal: Vec3;
  buildingId?: string;
  label?: string;
}

export interface CollisionResolution {
  collided: boolean;
  crashed: boolean;
  grounded: boolean;
  impactSpeed: number;
  events: CollisionEvent[];
}

export interface CollisionOptions {
  radius: number;
  crashSpeedThreshold: number;
  bounce: number;
  damping: number;
  /** Ground contact below this speed is a landing, not a collision. */
  groundContactSpeedThreshold: number;
  /** Optional surface friction applied to the tangential velocity. */
  friction: number;
}

export const DEFAULT_COLLISION_OPTIONS: CollisionOptions = {
  radius: 0.8,
  crashSpeedThreshold: 8,
  bounce: 0.12,
  damping: 0.25,
  groundContactSpeedThreshold: 1.0,
  friction: 1,
};

export interface CollisionTarget {
  position: Vec3;
  velocity: Vec3;
  crashed: boolean;
}

export class CollisionSystem {
  private options: CollisionOptions;

  constructor(
    private readonly buildings: BuildingSystem,
    private readonly roads: RoadSystem,
    options: Partial<CollisionOptions> = {},
  ) {
    this.options = { ...DEFAULT_COLLISION_OPTIONS, ...options };
  }

  setOptions(overrides: Partial<CollisionOptions>): void {
    this.options = { ...this.options, ...overrides };
  }

  get radius(): number {
    return this.options.radius;
  }

  /**
   * Resolve every overlap for one fixed tick. Mutates `target.position` and
   * `target.velocity` and reports what happened.
   */
  resolve(target: CollisionTarget): CollisionResolution {
    const events: CollisionEvent[] = [];
    let collided = false;
    let crashed = target.crashed;
    let grounded = false;
    let maxImpact = 0;

    const { radius, crashSpeedThreshold, bounce, groundContactSpeedThreshold } = this.options;

    // ---- Ground -----------------------------------------------------------
    if (target.position.y - radius <= 0) {
      const impact = Math.max(0, -target.velocity.y);
      target.position.y = radius;
      if (target.velocity.y < 0) target.velocity.y = 0;
      grounded = true;

      if (impact > groundContactSpeedThreshold) {
        collided = true;
        maxImpact = Math.max(maxImpact, impact);
        events.push({ type: 'ground', impactSpeed: impact, normal: { x: 0, y: 1, z: 0 } });
        if (impact > crashSpeedThreshold) crashed = true;
      }
    }

    // ---- Buildings --------------------------------------------------------
    const candidates = this.buildings.queryXZ(target.position, radius + 0.05);
    const handled = new Set<number>();

    for (const building of candidates) {
      if (handled.has(building.index)) continue;
      const half = {
        x: building.size.x / 2,
        y: building.size.y / 2,
        z: building.size.z / 2,
      };
      const min: Vec3 = {
        x: building.position.x - half.x,
        y: building.position.y - half.y,
        z: building.position.z - half.z,
      };
      const max: Vec3 = {
        x: building.position.x + half.x,
        y: building.position.y + half.y,
        z: building.position.z + half.z,
      };

      const hit = sphereAabbResolution(target.position, radius, min, max);
      if (!hit) continue;

      handled.add(building.index);
      collided = true;

      // Push the drone out of the wall.
      target.position.x += hit.normal.x * (hit.depth + 1e-4);
      target.position.y += hit.normal.y * (hit.depth + 1e-4);
      target.position.z += hit.normal.z * (hit.depth + 1e-4);

      const vn =
        target.velocity.x * hit.normal.x +
        target.velocity.y * hit.normal.y +
        target.velocity.z * hit.normal.z;

      const impact = Math.max(0, -vn);
      maxImpact = Math.max(maxImpact, impact);

      if (vn < 0) {
        // Remove the normal component, add a small bounce back out.
        const j = (1 + bounce) * vn;
        target.velocity.x -= j * hit.normal.x;
        target.velocity.y -= j * hit.normal.y;
        target.velocity.z -= j * hit.normal.z;
      }

      // Bleed off a little of the sliding velocity so walls feel solid.
      const damp = this.options.damping;
      if (damp < 1) {
        target.velocity.x *= damp;
        target.velocity.y *= damp;
        target.velocity.z *= damp;
      }

      events.push({
        type: 'building',
        impactSpeed: impact,
        normal: hit.normal,
        buildingId: building.id,
        ...(building.label !== undefined ? { label: building.label } : {}),
      });

      if (impact > crashSpeedThreshold) crashed = true;
    }

    // ---- World boundary (invisible wall at the city edge) -----------------
    const limit = this.roads.worldHalf - radius;
    if (Math.abs(target.position.x) > limit) {
      const sign = Math.sign(target.position.x);
      target.position.x = sign * limit;
      if (Math.sign(target.velocity.x) === sign) target.velocity.x = 0;
      collided = true;
      events.push({
        type: 'boundary',
        impactSpeed: Math.abs(target.velocity.x),
        normal: { x: -sign, y: 0, z: 0 },
      });
    }
    if (Math.abs(target.position.z) > limit) {
      const sign = Math.sign(target.position.z);
      target.position.z = sign * limit;
      if (Math.sign(target.velocity.z) === sign) target.velocity.z = 0;
      collided = true;
      events.push({
        type: 'boundary',
        impactSpeed: Math.abs(target.velocity.z),
        normal: { x: 0, y: 0, z: -sign },
      });
    }

    return { collided, crashed, grounded, impactSpeed: maxImpact, events };
  }

  /** Convenience used by the raycast sensors. */
  firstBuildingAlong(origin: Vec3, direction: Vec3, maxDistance: number, step = 2): BuildingRecord | null {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-9) return null;
    const nx = direction.x / length;
    const ny = direction.y / length;
    const nz = direction.z / length;

    // March the ray and test one probe per step: cheap and stable enough for
    // a 200 m sensor range on a 50 m grid.
    for (let travelled = step; travelled <= maxDistance; travelled += step) {
      const probe: Vec3 = {
        x: origin.x + nx * travelled,
        y: origin.y + ny * travelled,
        z: origin.z + nz * travelled,
      };
      if (probe.y < 0) return null;

      const nearby = this.buildings.queryXZ(probe, step * 0.75);
      for (const building of nearby) {
        const half = { x: building.size.x / 2, y: building.size.y / 2, z: building.size.z / 2 };
        if (
          Math.abs(probe.x - building.position.x) <= half.x &&
          Math.abs(probe.y - building.position.y) <= half.y &&
          Math.abs(probe.z - building.position.z) <= half.z
        ) {
          return building;
        }
      }
    }
    return null;
  }
}
