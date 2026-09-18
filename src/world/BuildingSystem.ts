/**
 * Building storage + spatial index (Spec §11, §14, §24).
 *
 * There can be >1000 buildings and collision runs at 60 Hz, so we never test
 * the drone against every building. Buildings are bucketed into a uniform
 * grid of 50 m cells and only the 3x3 neighbourhood of the drone is queried.
 */
import { clamp } from '../simulation/vec3';
import type { Vec3 } from '../simulation/vec3';

export type BuildingType = 'A' | 'B' | 'C';
export type RoofType = 'flat' | 'box' | 'antenna';
export type LotKind = 'building' | 'tower' | 'office' | 'parking' | 'plaza' | 'park';

/** A single procedural building. `position` is the AABB centre. */
export interface BuildingRecord {
  id: string;
  index: number;
  kind: LotKind;
  type: BuildingType;
  roofType: RoofType;
  position: Vec3;
  size: Vec3;
  /** Base colour, 0xRRGGBB. */
  color: number;
  /** Landmarks are kept when a building budget forces trimming. */
  landmark: boolean;
  label?: string;
}

/** Structured view of a building, safe to hand to an automation client (§24). */
export interface BuildingSnapshot {
  id: string;
  position: Vec3;
  size: Vec3;
  distance: number;
  kind: LotKind;
  type: BuildingType;
  roofType: RoofType;
  landmark: boolean;
  /** Centre-to-centre distance, kept alongside the surface distance. */
  centerDistance: number;
  /** Battery-style axis-aligned bounds, convenient for path planning. */
  min: Vec3;
  max: Vec3;
}

export const DEFAULT_CELL_SIZE = 50;

interface GridCell {
  buildings: BuildingRecord[];
}

export class BuildingSystem {
  readonly cellSize: number;
  readonly buildings: BuildingRecord[] = [];

  private readonly cells = new Map<number, GridCell>();
  private minX = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private minZ = Number.POSITIVE_INFINITY;
  private maxZ = Number.NEGATIVE_INFINITY;
  private maxHeight = 0;

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  get count(): number {
    return this.buildings.length;
  }

  get bounds(): { minX: number; maxX: number; minZ: number; maxZ: number; maxHeight: number } {
    return {
      minX: this.minX,
      maxX: this.maxX,
      minZ: this.minZ,
      maxZ: this.maxZ,
      maxHeight: this.maxHeight,
    };
  }

  add(record: BuildingRecord): void {
    this.buildings.push(record);

    const halfX = record.size.x / 2;
    const halfZ = record.size.z / 2;
    this.minX = Math.min(this.minX, record.position.x - halfX);
    this.maxX = Math.max(this.maxX, record.position.x + halfX);
    this.minZ = Math.min(this.minZ, record.position.z - halfZ);
    this.maxZ = Math.max(this.maxZ, record.position.z + halfZ);
    this.maxHeight = Math.max(this.maxHeight, record.size.y);

    // Insert into every cell the footprint touches (buildings are wider than
    // one cell in some layouts, so a single-cell insert would miss queries).
    const minCx = this.cellIndex(record.position.x - halfX);
    const maxCx = this.cellIndex(record.position.x + halfX);
    const minCz = this.cellIndex(record.position.z - halfZ);
    const maxCz = this.cellIndex(record.position.z + halfZ);

    for (let cz = minCz; cz <= maxCz; cz += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const key = this.cellKey(cx, cz);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { buildings: [] };
          this.cells.set(key, cell);
        }
        cell.buildings.push(record);
      }
    }
  }

  addAll(records: Iterable<BuildingRecord>): void {
    for (const record of records) this.add(record);
  }

  clear(): void {
    this.buildings.length = 0;
    this.cells.clear();
    this.minX = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.minZ = Number.POSITIVE_INFINITY;
    this.maxZ = Number.NEGATIVE_INFINITY;
    this.maxHeight = 0;
  }

  byId(id: string): BuildingRecord | undefined {
    return this.buildings.find((building) => building.id === id);
  }

  /**
   * All buildings whose footprint AABB is within `radius` of `center` on the
   * XZ plane, optionally limited vertically. Results are de-duplicated.
   */
  queryXZ(center: Vec3, radius: number, heightRange?: { min: number; max: number }): BuildingRecord[] {
    const out: BuildingRecord[] = [];
    const seen = new Set<number>();

    const minCx = this.cellIndex(center.x - radius);
    const maxCx = this.cellIndex(center.x + radius);
    const minCz = this.cellIndex(center.z - radius);
    const maxCz = this.cellIndex(center.z + radius);

    const r2 = radius * radius;

    for (let cz = minCz; cz <= maxCz; cz += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const cell = this.cells.get(this.cellKey(cx, cz));
        if (!cell) continue;
        for (const building of cell.buildings) {
          if (seen.has(building.index)) continue;
          seen.add(building.index);

          if (heightRange) {
            const top = building.position.y + building.size.y / 2;
            const bottom = building.position.y - building.size.y / 2;
            if (top < heightRange.min || bottom > heightRange.max) continue;
          }

          const dx = Math.abs(building.position.x - center.x);
          const dz = Math.abs(building.position.z - center.z);
          const clampedX = Math.max(dx - building.size.x / 2, 0);
          const clampedZ = Math.max(dz - building.size.z / 2, 0);
          if (clampedX * clampedX + clampedZ * clampedZ <= r2) {
            out.push(building);
          }
        }
      }
    }

    return out;
  }

  /** Snapshot list for the automation API, sorted by surface distance (§24). */
  getSnapshots(center: Vec3, radius = 50, limit = 64): BuildingSnapshot[] {
    const candidates = this.queryXZ(center, radius);
    const snapshots = candidates.map((building) => this.toSnapshot(building, center));
    snapshots.sort((a, b) => a.distance - b.distance);
    return limit > 0 ? snapshots.slice(0, limit) : snapshots;
  }

  toSnapshot(building: BuildingRecord, from: Vec3): BuildingSnapshot {
    const halfX = building.size.x / 2;
    const halfY = building.size.y / 2;
    const halfZ = building.size.z / 2;

    const dx = Math.abs(building.position.x - from.x) - halfX;
    const dy = Math.abs(building.position.y - from.y) - halfY;
    const dz = Math.abs(building.position.z - from.z) - halfZ;

    const outsideX = Math.max(dx, 0);
    const outsideY = Math.max(dy, 0);
    const outsideZ = Math.max(dz, 0);
    const surfaceDistance = Math.sqrt(
      outsideX * outsideX + outsideY * outsideY + outsideZ * outsideZ,
    );

    const cdx = building.position.x - from.x;
    const cdy = building.position.y - from.y;
    const cdz = building.position.z - from.z;

    return {
      id: building.id,
      position: { ...building.position },
      size: { ...building.size },
      distance: surfaceDistance,
      centerDistance: Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz),
      kind: building.kind,
      type: building.type,
      roofType: building.roofType,
      landmark: building.landmark,
      min: {
        x: building.position.x - halfX,
        y: building.position.y - halfY,
        z: building.position.z - halfZ,
      },
      max: {
        x: building.position.x + halfX,
        y: building.position.y + halfY,
        z: building.position.z + halfZ,
      },
    };
  }

  /**
   * True when a sphere at `center` does not intersect any building and stays
   * inside the world bounds. Used by the spawn system.
   */
  isClear(center: Vec3, radius: number, worldHalfSize?: number): boolean {
    if (worldHalfSize !== undefined) {
      const limit = worldHalfSize - radius;
      if (Math.abs(center.x) > limit || Math.abs(center.z) > limit) return false;
    }
    if (center.y - radius < 0) return false;
    return this.queryXZ(center, radius).length === 0;
  }

  private cellIndex(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private cellKey(cx: number, cz: number): number {
    // Pack two int16-ish coordinates into one number key.
    return (cx + 32768) * 65536 + (cz + 32768);
  }
}

/**
 * Sphere vs AABB overlap test returning the minimum translation vector.
 * Returns `null` when there is no overlap.
 */
export function sphereAabbResolution(
  center: Vec3,
  radius: number,
  min: Vec3,
  max: Vec3,
): { normal: Vec3; depth: number; point: Vec3 } | null {
  const closestX = clamp(center.x, min.x, max.x);
  const closestY = clamp(center.y, min.y, max.y);
  const closestZ = clamp(center.z, min.z, max.z);

  const dx = center.x - closestX;
  const dy = center.y - closestY;
  const dz = center.z - closestZ;
  const distSq = dx * dx + dy * dy + dz * dz;
  const r2 = radius * radius;

  if (distSq > r2) return null;

  if (distSq > 1e-12) {
    const dist = Math.sqrt(distSq);
    return {
      normal: { x: dx / dist, y: dy / dist, z: dz / dist },
      depth: radius - dist,
      point: { x: closestX, y: closestY, z: closestZ },
    };
  }

  // Centre is inside the box: push out along the shallowest axis.
  const toMinX = center.x - min.x;
  const toMaxX = max.x - center.x;
  const toMinY = center.y - min.y;
  const toMaxY = max.y - center.y;
  const toMinZ = center.z - min.z;
  const toMaxZ = max.z - center.z;

  const minPenX = Math.min(toMinX, toMaxX);
  const minPenY = Math.min(toMinY, toMaxY);
  const minPenZ = Math.min(toMinZ, toMaxZ);

  if (minPenX <= minPenY && minPenX <= minPenZ) {
    const sign = toMaxX < toMinX ? 1 : -1;
    return {
      normal: { x: sign, y: 0, z: 0 },
      depth: minPenX + radius,
      point: { x: sign > 0 ? max.x : min.x, y: center.y, z: center.z },
    };
  }
  if (minPenY <= minPenZ) {
    const sign = toMaxY < toMinY ? 1 : -1;
    return {
      normal: { x: 0, y: sign, z: 0 },
      depth: minPenY + radius,
      point: { x: center.x, y: sign > 0 ? max.y : min.y, z: center.z },
    };
  }
  const sign = toMaxZ < toMinZ ? 1 : -1;
  return {
    normal: { x: 0, y: 0, z: sign },
    depth: minPenZ + radius,
    point: { x: center.x, y: center.y, z: sign > 0 ? max.z : min.z },
  };
}
