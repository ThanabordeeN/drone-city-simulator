/**
 * Procedural city generator (Spec §10, §11, §12).
 *
 * Fully deterministic: the same seed always produces the exact same layout,
 * so `?seed=123` reloads to the identical city (acceptance criterion #20).
 */
import type { Vec3 } from '../simulation/vec3';
import { clamp } from '../simulation/vec3';
import {
  BuildingSystem,
  type BuildingRecord,
  type BuildingType,
  type LotKind,
  type RoofType,
} from './BuildingSystem';
import { RoadSystem, type RoadGridOptions } from './RoadSystem';

export interface CityBlock {
  gx: number;
  gz: number;
  center: Vec3;
  half: number;
  kind: LotKind;
  /** Optional floor label, e.g. "Tower", "Parking". */
  label?: string;
}

export interface CityLayout {
  seed: number;
  worldSize: number;
  blockCountX: number;
  blockCountZ: number;
  blockPitch: number;
  roadWidth: number;
  sidewalkWidth: number;
  blocks: CityBlock[];
  buildings: BuildingRecord[];
  buildingCount: number;
  landmarks: BuildingRecord[];
}

export interface GenerateCityOptions extends RoadGridOptions {
  /** Seed for the deterministic PRNG. */
  seed?: number;
  /**
   * Desired building count (Spec: 600–1500). Landmarks are never trimmed.
   * When omitted the natural density of the generator is used.
   */
  buildingTarget?: number;
  /** How many landmark blocks to scatter (towers, parks, plazas, ...). */
  landmarkCount?: number;
}

/** Default seed used by `?testMode=1` (Spec §23). */
export const TEST_MODE_SEED = 12345;

/** Deterministic 32-bit PRNG (mulberry32). No `Math.random` anywhere. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable, well-distributed integer hash of a string (for seeds from URLs). */
export function hashSeed(value: string | number | null | undefined, fallback = TEST_MODE_SEED): number {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value);
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && text.trim() !== '') return Math.floor(asNumber) >>> 0;

  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const PALETTE: Record<BuildingType, number[]> = {
  // Low concrete / brick blocks.
  A: [0xb9b2a6, 0xa89f92, 0xc7bfb0, 0x9c8f80, 0xb0a291],
  // Mid-rise steel and glass.
  B: [0x8fa0ad, 0x7d8f9e, 0xa4b3bd, 0x6f8091, 0x93a7b5],
  // High-rise towers: darker, bluer glass.
  C: [0x54646f, 0x46555f, 0x62737f, 0x3d4a54, 0x5b6d7a],
};

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function typeForHeight(height: number): BuildingType {
  if (height < 35) return 'A';
  if (height < 85) return 'B';
  return 'C';
}

function roofForHeight(height: number, random: () => number): RoofType {
  const roll = random();
  if (height >= 90) {
    if (roll < 0.5) return 'antenna';
    if (roll < 0.85) return 'box';
    return 'flat';
  }
  if (roll < 0.55) return 'flat';
  if (roll < 0.9) return 'box';
  return 'antenna';
}

interface DraftBuilding {
  position: Vec3;
  size: Vec3;
  kind: LotKind;
  roofType: RoofType;
  color: number;
  landmark: boolean;
  label?: string;
}

/**
 * Build the whole city layout. Pure function of the options — no global state,
 * no randomness leaking in from outside.
 */
export function generateCity(options: GenerateCityOptions = {}): CityLayout {
  const seed = (options.seed ?? TEST_MODE_SEED) >>> 0;
  const random = createRandom(seed);
  const roads = new RoadSystem(options);

  const buildableHalf = roads.buildableHalf;
  const worldHalf = roads.worldHalf;
  const maxDistanceFromCentre = Math.hypot(worldHalf, worldHalf);

  const blocks: CityBlock[] = roads.blocks.map((block) => ({
    gx: block.gx,
    gz: block.gz,
    center: block.center,
    half: block.half,
    kind: 'building' as LotKind,
  }));

  const cityCentreBlock = (() => {
    const target = { x: 0, z: 0 };
    let best = blocks[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const block of blocks) {
      const d = Math.hypot(block.center.x - target.x, block.center.z - target.z);
      if (d < bestDist) {
        bestDist = d;
        best = block;
      }
    }
    return best;
  })();

  // ---- Landmark placement -------------------------------------------------
  const landmarkCount = options.landmarkCount ?? 14;
  const landmarkPlan: LotKind[] = ['tower', 'park', 'plaza', 'parking', 'office'];
  const chosen = new Set<CityBlock>();

  // The block nearest the origin is always a tower: a guaranteed, seed-stable
  // visual reference point for navigation tests.
  cityCentreBlock.kind = 'tower';
  cityCentreBlock.label = 'Central Tower';
  chosen.add(cityCentreBlock);

  let guard = 0;
  while (chosen.size < landmarkCount + 1 && guard < 4000) {
    guard += 1;
    const candidate = blocks[Math.floor(random() * blocks.length)];
    if (chosen.has(candidate)) continue;
    // Keep landmarks spread out so they read as distinct districts.
    let tooClose = false;
    for (const existing of chosen) {
      if (Math.hypot(existing.center.x - candidate.center.x, existing.center.z - candidate.center.z) < 220) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const kind = pick(landmarkPlan, random);
    candidate.kind = kind;
    candidate.label =
      kind === 'tower'
        ? 'Tower'
        : kind === 'park'
          ? 'Park'
          : kind === 'plaza'
            ? 'Open Plaza'
            : kind === 'parking'
              ? 'Parking Building'
              : 'Large Office';
    chosen.add(candidate);
  }

  // ---- Building generation ------------------------------------------------
  const drafts: DraftBuilding[] = [];

  const heightAt = (x: number, z: number): number => {
    const dist = Math.hypot(x, z);
    const core = clamp(1 - dist / (maxDistanceFromCentre * 0.62), 0, 1);
    const base = 10 + random() * 26;
    const boost = core * core * random() * 105;
    return clamp(base + boost, 10, 150);
  };

  const colourFor = (type: BuildingType): number => pick(PALETTE[type], random);

  const pushBuilding = (
    x: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    kind: LotKind,
    landmark: boolean,
    label?: string,
    roofOverride?: RoofType,
  ): void => {
    const type = typeForHeight(height);
    drafts.push({
      position: { x, y: height / 2, z },
      size: { x: width, y: height, z: depth },
      kind,
      roofType: roofOverride ?? roofForHeight(height, random),
      color: colourFor(type),
      landmark,
      label,
    });
  };

  for (const block of blocks) {
    const { x: cx, z: cz } = block.center;

    if (block.kind === 'park' || block.kind === 'plaza') {
      continue; // intentionally empty: open navigation space
    }

    if (block.kind === 'tower') {
      const height = 118 + random() * 32; // 118 – 150 m
      const footprint = buildableHalf * 1.15; // dominant, reads from far away
      pushBuilding(cx, cz, footprint, footprint, height, 'tower', true, block.label ?? 'Tower', 'antenna');
      continue;
    }

    if (block.kind === 'parking') {
      const width = buildableHalf * 1.5;
      const depth = buildableHalf * 1.05;
      const height = 12 + random() * 12;
      pushBuilding(cx, cz, width, depth, height, 'parking', true, block.label ?? 'Parking', 'flat');
      continue;
    }

    if (block.kind === 'office') {
      const heightA = 42 + random() * 46;
      const heightB = 36 + random() * 40;
      const offset = buildableHalf * 0.48;
      pushBuilding(cx - offset, cz, buildableHalf * 0.82, buildableHalf * 0.7, heightA, 'office', true, 'Large Office');
      pushBuilding(cx + offset, cz, buildableHalf * 0.82, buildableHalf * 0.7, heightB, 'office', true, 'Large Office');
      continue;
    }

    // Normal city block: 2x2 lots with jittered footprints.
    const lotHalf = buildableHalf / 2; // half size of one lot (~18.5 m)
    for (let lz = 0; lz < 2; lz += 1) {
      for (let lx = 0; lx < 2; lx += 1) {
        // 8% of lots stay empty (courtyards / small parking).
        if (random() < 0.08) continue;

        const lotCenterX = cx + (lx === 0 ? -lotHalf : lotHalf);
        const lotCenterZ = cz + (lz === 0 ? -lotHalf : lotHalf);

        const maxFootprint = lotHalf * 2 - 6;
        const width = 10 + random() * (maxFootprint - 10);
        const depth = 10 + random() * (maxFootprint - 10);
        const jitterX = (random() - 0.5) * (maxFootprint - width) * 0.6;
        const jitterZ = (random() - 0.5) * (maxFootprint - depth) * 0.6;

        const height = heightAt(lotCenterX, lotCenterZ);
        pushBuilding(
          lotCenterX + jitterX,
          lotCenterZ + jitterZ,
          width,
          depth,
          height,
          'building',
          false,
        );
      }
    }
  }

  // ---- Building budget (?buildings=N) ------------------------------------
  const target = options.buildingTarget;
  let final = drafts;
  if (target !== undefined && target > 0 && drafts.length > target) {
    const removable = drafts.filter((draft) => !draft.landmark);
    const removableCount = drafts.length - target;
    if (removableCount > 0 && removable.length > 0) {
      // Seeded shuffle then drop from the front: deterministic thinning.
      const shuffled = removable.slice();
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const doomed = new Set(shuffled.slice(0, Math.min(removableCount, shuffled.length)));
      final = drafts.filter((draft) => !doomed.has(draft));
    }
  }

  const buildings: BuildingRecord[] = final.map((draft, index) => ({
    id: `building-${index}`,
    index,
    kind: draft.kind,
    type: typeForHeight(draft.size.y),
    roofType: draft.roofType,
    position: { ...draft.position },
    size: { ...draft.size },
    color: draft.color,
    landmark: draft.landmark,
    ...(draft.label !== undefined ? { label: draft.label } : {}),
  }));

  return {
    seed,
    worldSize: roads.worldSize,
    blockCountX: roads.blockCountX,
    blockCountZ: roads.blockCountZ,
    blockPitch: roads.blockPitch,
    roadWidth: roads.roadWidth,
    sidewalkWidth: roads.sidewalkWidth,
    blocks,
    buildings,
    buildingCount: buildings.length,
    landmarks: buildings.filter((building) => building.landmark),
  };
}

/** Convenience: build the spatial index for a layout in one call. */
export function createBuildingSystem(layout: CityLayout, cellSize?: number): BuildingSystem {
  const system = new BuildingSystem(cellSize);
  system.addAll(layout.buildings);
  return system;
}
