/**
 * World generation tests (Spec §10, §11, §12, §14, §24, §33).
 */
import { describe, expect, it } from 'vitest';
import { createRandom, generateCity, hashSeed, TEST_MODE_SEED } from '../../src/world/CityGenerator';
import { BuildingSystem, sphereAabbResolution } from '../../src/world/BuildingSystem';
import { RoadSystem } from '../../src/world/RoadSystem';
import { SpawnSystem } from '../../src/world/SpawnSystem';
import { generateCity as gen } from '../../src/world/CityGenerator';
import { createBuildingSystem } from '../../src/world/CityGenerator';

describe('city reproducibility (Spec §10, §36 #20)', () => {
  it('produces an identical layout for the same seed', () => {
    const a = generateCity({ seed: 12345 });
    const b = generateCity({ seed: 12345 });
    expect(a.buildingCount).toBe(b.buildingCount);
    expect(a.blocks.map((block) => block.kind)).toEqual(b.blocks.map((block) => block.kind));
    expect(a.buildings).toEqual(b.buildings);
  });

  it('produces different layouts for different seeds', () => {
    const a = generateCity({ seed: 1 });
    const b = generateCity({ seed: 2 });
    expect(a.buildings).not.toEqual(b.buildings);
  });

  it('hashes string seeds stably and numerically for numeric seeds', () => {
    expect(hashSeed('12345')).toBe(12345);
    expect(hashSeed('12345')).toBe(hashSeed(12345));
    expect(hashSeed('city-a')).toBe(hashSeed('city-a'));
    expect(hashSeed('city-a')).not.toBe(hashSeed('city-b'));
    expect(hashSeed(null, 7)).toBe(7);
  });

  it('uses a fixed seed in test mode', () => {
    expect(TEST_MODE_SEED).toBe(12345);
    expect(generateCity({ seed: TEST_MODE_SEED }).buildings).toEqual(
      generateCity({ seed: TEST_MODE_SEED }).buildings,
    );
  });

  it('is driven by a deterministic PRNG (mulberry32, no Math.random)', () => {
    const a = createRandom(1234);
    const b = createRandom(1234);
    const sequenceA = [a(), a(), a()];
    const sequenceB = [b(), b(), b()];
    expect(sequenceA).toEqual(sequenceB);
    for (const value of sequenceA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('city layout (Spec §10, §12)', () => {
  const layout = generateCity({ seed: 12345 });

  it('builds a 2000 m city with 20x20 blocks', () => {
    expect(layout.worldSize).toBe(2000);
    expect(layout.blockCountX).toBe(20);
    expect(layout.blockCountZ).toBe(20);
    expect(layout.blocks).toHaveLength(400);
  });

  it('generates between 600 and 1500 buildings', () => {
    for (const seed of [1, 7, 42, 999, 12345]) {
      const generated = generateCity({ seed });
      expect(generated.buildingCount).toBeGreaterThanOrEqual(600);
      expect(generated.buildingCount).toBeLessThanOrEqual(1500);
    }
  });

  it('keeps every building between 10 m and 150 m tall', () => {
    for (const building of layout.buildings) {
      expect(building.size.y).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(building.size.y).toBeLessThanOrEqual(150 + 1e-9);
      // Buildings sit on the ground plane.
      expect(building.position.y).toBeCloseTo(building.size.y / 2, 9);
    }
  });

  it('honours a ?buildings= budget without dropping landmarks', () => {
    const trimmed = generateCity({ seed: 12345, buildingTarget: 600 });
    expect(trimmed.buildingCount).toBe(600);
    expect(trimmed.landmarks.length).toBeGreaterThan(0);
    expect(trimmed.landmarks.every((building) => building.landmark)).toBe(true);
  });

  it('includes landmark variety for navigation', () => {
    const kinds = new Set(layout.blocks.map((block) => block.kind));
    expect(kinds.has('tower')).toBe(true);
    // Parks/plazas may or may not appear at a given landmark budget, but the
    // central tower is guaranteed.
    expect(layout.landmarks.some((building) => building.kind === 'tower')).toBe(true);
  });

  it('never places a building footprint on a road', () => {
    const roads = new RoadSystem(layout);
    let violations = 0;
    for (const building of layout.buildings) {
      const hx = building.size.x / 2;
      const hz = building.size.z / 2;
      const corners: [number, number][] = [
        [building.position.x - hx, building.position.z - hz],
        [building.position.x + hx, building.position.z - hz],
        [building.position.x - hx, building.position.z + hz],
        [building.position.x + hx, building.position.z + hz],
      ];
      for (const [x, z] of corners) {
        if (roads.isOnRoad(x, z)) violations += 1;
      }
    }
    expect(violations).toBe(0);
  });

  it('assigns stable ids in the documented format', () => {
    expect(layout.buildings[0].id).toBe('building-0');
    expect(layout.buildings[1].id).toBe('building-1');
    expect(new Set(layout.buildings.map((building) => building.id)).size).toBe(layout.buildingCount);
  });
});

describe('spatial grid (Spec §14)', () => {
  const layout = generateCity({ seed: 321 });
  const buildings = createBuildingSystem(layout);

  it('matches a brute-force search for arbitrary query points', () => {
    const random = createRandom(777);
    for (let i = 0; i < 40; i += 1) {
      const center = {
        x: (random() * 2 - 1) * 1000,
        y: random() * 150,
        z: (random() * 2 - 1) * 1000,
      };
      const radius = 10 + random() * 120;

      const viaGrid = buildings.queryXZ(center, radius);
      const viaBruteForce = layout.buildings.filter((building) => {
        const dx = Math.max(Math.abs(building.position.x - center.x) - building.size.x / 2, 0);
        const dz = Math.max(Math.abs(building.position.z - center.z) - building.size.z / 2, 0);
        return dx * dx + dz * dz <= radius * radius;
      });

      expect(new Set(viaGrid.map((building) => building.id))).toEqual(
        new Set(viaBruteForce.map((building) => building.id)),
      );
    }
  });

  it('never duplicates a building in a single query', () => {
    const results = buildings.queryXZ({ x: 0, y: 50, z: 0 }, 300);
    expect(new Set(results.map((building) => building.index)).size).toBe(results.length);
  });

  it('uses a 50 m cell size and reports world bounds', () => {
    expect(buildings.cellSize).toBe(50);
    const bounds = buildings.bounds;
    expect(bounds.maxHeight).toBeGreaterThan(100);
    expect(bounds.minX).toBeGreaterThanOrEqual(-1000);
    expect(bounds.maxX).toBeLessThanOrEqual(1000);
  });

  it('returns snapshots sorted by surface distance (Spec §24)', () => {
    const snapshots = buildings.getSnapshots({ x: 0, y: 40, z: 0 }, 200);
    expect(snapshots.length).toBeGreaterThan(0);
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i].distance).toBeGreaterThanOrEqual(snapshots[i - 1].distance);
    }
    const first = snapshots[0];
    expect(Object.keys(first).sort()).toEqual(
      ['centerDistance', 'distance', 'id', 'kind', 'landmark', 'max', 'min', 'position', 'roofType', 'size', 'type']
        .sort(),
    );
    expect(first.position).toHaveProperty('y');
    expect(first.size).toHaveProperty('y');
  });
});

describe('sphere vs AABB resolution (Spec §13)', () => {
  const min = { x: -1, y: 0, z: -1 };
  const max = { x: 1, y: 4, z: 1 };

  it('returns null when there is no overlap', () => {
    expect(sphereAabbResolution({ x: 10, y: 2, z: 0 }, 0.8, min, max)).toBeNull();
  });

  it('pushes out along the closest face', () => {
    const hit = sphereAabbResolution({ x: 1.5, y: 2, z: 0 }, 0.8, min, max);
    expect(hit).not.toBeNull();
    expect(hit!.normal.x).toBeCloseTo(1, 6);
    expect(hit!.depth).toBeCloseTo(0.3, 6);
  });

  it('pushes out of the shallowest axis when the centre is inside', () => {
    const hit = sphereAabbResolution({ x: 0, y: 4.1, z: 0 }, 0.8, min, max);
    expect(hit).not.toBeNull();
    expect(hit!.normal).toEqual({ x: 0, y: 1, z: 0 });
  });
});

describe('spawn system (Spec §10, §28)', () => {
  const layout = gen({ seed: 55 });
  const roads = new RoadSystem(layout);
  const buildings = createBuildingSystem(layout);
  const spawn = new SpawnSystem(roads, buildings);

  it('always finds a clear default spawn', () => {
    const point = spawn.findSpawn({ mode: 'default', altitude: 0.8 });
    expect(spawn.isSpawnValid(point, 0.8)).toBe(true);
    expect(roads.isOnRoad(point.x, point.z)).toBe(true);
  });

  it('finds clear random spawns for many seeds', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const point = spawn.findSpawn({ mode: 'random', altitude: 1.5, seed });
      expect(buildings.queryXZ(point, 1.5)).toHaveLength(0);
    }
  });

  it('spawns above the tallest roof in air mode', () => {
    const point = spawn.findSpawn({ mode: 'air', seed: 3 });
    expect(point.y).toBeGreaterThan(buildings.bounds.maxHeight);
  });

  it('produces a clear attack corridor for the collision test', () => {
    const approach = spawn.findApproach({ distance: 20 });
    expect(buildings.queryXZ(approach.position, 2.5)).toHaveLength(0);
    expect(approach.building.size.y).toBeGreaterThan(40);
    // The yaw must actually point at the building.
    const forwardX = -Math.sin(approach.yaw);
    const forwardZ = -Math.cos(approach.yaw);
    const toBuilding = {
      x: approach.building.position.x - approach.position.x,
      z: approach.building.position.z - approach.position.z,
    };
    const length = Math.hypot(toBuilding.x, toBuilding.z);
    expect(forwardX).toBeCloseTo(toBuilding.x / length, 6);
    expect(forwardZ).toBeCloseTo(toBuilding.z / length, 6);
  });
});

describe('building system bookkeeping', () => {
  it('supports incremental add/clear', () => {
    const system = new BuildingSystem(25);
    system.add({
      id: 'building-0',
      index: 0,
      kind: 'building',
      type: 'A',
      roofType: 'flat',
      position: { x: 0, y: 5, z: 0 },
      size: { x: 10, y: 10, z: 10 },
      color: 0xffffff,
      landmark: false,
    });
    expect(system.count).toBe(1);
    expect(system.byId('building-0')).toBeDefined();
    expect(system.queryXZ({ x: 0, y: 0, z: 0 }, 1)).toHaveLength(1);
    system.clear();
    expect(system.count).toBe(0);
    expect(system.queryXZ({ x: 0, y: 0, z: 0 }, 100)).toHaveLength(0);
  });
});
