/**
 * Spawn placement (Spec §10, §28).
 *
 * Guarantees the drone never spawns inside geometry, and keeps spawns
 * deterministic for a given seed so episodes are reproducible.
 */
import type { Vec3 } from '../simulation/vec3';
import { BuildingSystem, type BuildingRecord } from './BuildingSystem';
import { createRandom, hashSeed } from './CityGenerator';
import type { RoadSystem } from './RoadSystem';

export type SpawnMode = 'default' | 'road' | 'random' | 'air';

export interface SpawnOptions {
  mode?: SpawnMode;
  /** Spawn height above ground, in metres. */
  altitude?: number;
  /** Seed for `random` / `road` modes. */
  seed?: number;
  /** Extra clearance around the drone that must be free of buildings. */
  clearance?: number;
}

export interface BuildingApproach {
  /** Position to place the drone at. */
  position: Vec3;
  /** Yaw (radians) that points the drone at the building. */
  yaw: number;
  /** The building being approached. */
  building: BuildingRecord;
  /** Horizontal gap between the drone and the building wall. */
  distance: number;
}

export class SpawnSystem {
  constructor(
    private readonly roads: RoadSystem,
    private readonly buildings: BuildingSystem,
  ) {}

  /** Highest clear altitude near a position, used to validate "air" spawns. */
  isSpawnValid(position: Vec3, clearance = 1.5): boolean {
    if (position.y - clearance < 0) return false;
    return this.buildings.isClear(position, clearance, this.roads.worldHalf);
  }

  /**
   * Resolve a spawn position.
   *
   * - `default`: intersection nearest the origin (stable, matches the demo).
   * - `road`:     a seeded random intersection.
   * - `random`:   a seeded random clear point above the city.
   * - `air`:      like random but guaranteed well above the tallest rooftop.
   */
  findSpawn(options: SpawnOptions = {}): Vec3 {
    const mode = options.mode ?? 'default';
    const altitude = options.altitude ?? 0.8;
    const clearance = options.clearance ?? 2;
    const seed = hashSeed(options.seed ?? options.mode ?? 'spawn', 1);
    const random = createRandom(seed);

    if (mode === 'default') {
      const point = this.roads.nearestIntersection(0, 0);
      return { x: point.x, y: altitude, z: point.z };
    }

    if (mode === 'road') {
      const point = this.roads.intersections[Math.floor(random() * this.roads.intersectionCount)];
      return { x: point.x, y: altitude, z: point.z };
    }

    if (mode === 'air') {
      const y = Math.max(altitude, this.buildings.bounds.maxHeight + 40);
      const limit = this.roads.worldHalf - 60;
      return {
        x: (random() * 2 - 1) * limit,
        y,
        z: (random() * 2 - 1) * limit,
      };
    }

    // 'random': rejection-sample a clear spot, falling back to a road spawn.
    const limit = this.roads.worldHalf - 40;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate: Vec3 = {
        x: (random() * 2 - 1) * limit,
        y: altitude,
        z: (random() * 2 - 1) * limit,
      };
      if (this.isSpawnValid(candidate, clearance)) return candidate;
    }

    const fallback = this.roads.intersections[Math.floor(random() * this.roads.intersectionCount)];
    return { x: fallback.x, y: altitude, z: fallback.z };
  }

  /** Nearest building to a point on the ground plane. */
  nearestBuilding(position: Vec3): BuildingRecord | undefined {
    let best: BuildingRecord | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const building of this.buildings.buildings) {
      const dx = building.position.x - position.x;
      const dz = building.position.z - position.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = building;
      }
    }
    return best;
  }

  /**
   * Build a spawn that points at a building from `distance` metres away, on a
   * clear corridor. Used by the collision test (Spec §37 Test 6) and by agent
   * tutorials.
   */
  findApproach(options: { target?: BuildingRecord; distance?: number; altitude?: number } = {}): BuildingApproach {
    const distance = options.distance ?? 40;

    if (options.target) {
      return this.buildApproach(options.target, distance, options.altitude);
    }

    for (const candidate of this.approachCandidates()) {
      const approach = this.buildApproach(candidate, distance, options.altitude);
      if (this.isCorridorClear(approach)) return approach;
    }

    const fallback = this.buildings.buildings[0];
    return this.buildApproach(fallback, distance, options.altitude);
  }

  private buildApproach(building: BuildingRecord, distance: number, altitude?: number): BuildingApproach {
    const yaw = this.yawTowards({ x: 0, y: 0, z: 0 }, building.position);
    const height = altitude ?? Math.min(building.size.y * 0.5, 30);

    // Forward = (-sin yaw, 0, -cos yaw); place the drone behind the building
    // along that axis so flying forward flies straight into it.
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const position: Vec3 = {
      x: building.position.x + dirX * (distance + building.size.x / 2),
      y: height,
      z: building.position.z + dirZ * (distance + building.size.z / 2),
    };

    return { position, yaw, building, distance };
  }

  private isCorridorClear(approach: BuildingApproach): boolean {
    const { position, building } = approach;
    if (!this.buildings.isClear(position, 2.5, this.roads.worldHalf)) return false;

    // Sample the straight path to the target building: nothing may block it.
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const probe: Vec3 = {
        x: position.x + (building.position.x - position.x) * t,
        y: position.y,
        z: position.z + (building.position.z - position.z) * t,
      };
      const hits = this.buildings
        .queryXZ(probe, 1.5)
        .filter((candidate) => candidate !== building);
      if (hits.length > 0) return false;
    }
    return true;
  }

  private approachCandidates(): BuildingRecord[] {
    // Prefer big, isolated, tall buildings so a straight flight hits them.
    return this.buildings.buildings
      .filter((building) => building.size.y > 40 && building.size.x > 14)
      .sort((a, b) => {
        const scoreA = a.size.y * a.size.x - Math.hypot(a.position.x, a.position.z) * 0.5;
        const scoreB = b.size.y * b.size.x - Math.hypot(b.position.x, b.position.z) * 0.5;
        return scoreB - scoreA;
      })
      .slice(0, 40);
  }

  /** Yaw (radians) such that Z- forward points from `from` to `to`. */
  yawTowards(from: Vec3, to: Vec3): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    // Forward = (-sin(yaw), 0, -cos(yaw)); solve for yaw.
    return Math.atan2(-dx, -dz);
  }


}
