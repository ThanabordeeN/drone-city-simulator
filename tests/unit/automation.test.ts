/**
 * Automation API tests (Spec §17 – §29, §32, §35).
 *
 * The API is exercised exactly as Playwright would use it, but with no browser
 * at all: proving the automation surface does not depend on the renderer.
 */
import { describe, expect, it } from 'vitest';
import { AutomationAPI, AUTOMATION_API_VERSION, installAutomationAPI } from '../../src/automation/AutomationAPI';
import { toFullSnapshot } from '../../src/automation/SimulationSnapshot';
import { DroneSimulation } from '../../src/simulation/DroneSimulation';
import { createHarness } from './helpers';

describe('window.__DRONE_SIM__ (Spec §17)', () => {
  it('installs the API on the global object', () => {
    const { api } = createHarness({ seed: 1 });
    const fakeWindow = {} as unknown as Window & typeof globalThis;
    installAutomationAPI(api, fakeWindow);

    expect(fakeWindow.__DRONE_SIM__).toBe(api);
    expect(fakeWindow.__DRONE_SIM_READY__).toBe(true);
  });

  it('resolves ready() once the bootstrap signals readiness', async () => {
    const sim = new DroneSimulation({ seed: 1 });
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const api = new AutomationAPI({ simulation: sim, ready });

    let settled = false;
    const pending = api.ready().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    api.markReady();
    resolveReady();
    await pending;
    expect(settled).toBe(true);
    expect(api.version).toBe(AUTOMATION_API_VERSION);
  });

  it('exposes every method required by Spec §18', () => {
    const { api } = createHarness({ seed: 1 });
    const required: (keyof typeof api)[] = [
      'ready',
      'getState',
      'getInput',
      'setInput',
      'clearInput',
      'reset',
      'pause',
      'resume',
      'step',
      'teleport',
      'setRotation',
      'setCameraMode',
      'getNearbyBuildings',
      'getWorldInfo',
      'getMetrics',
      'getSensors',
      'observe',
      'act',
      'startEpisode',
      'endEpisode',
      'setGoal',
      'getGoal',
      'setControlMode',
    ];
    for (const method of required) {
      expect(typeof api[method], `missing ${String(method)}`).toBe('function');
    }
  });
});

describe('Spec §19 — take off example', () => {
  it('climbs to roughly 15 m and does not crash', () => {
    const { api } = createHarness({ seed: 12345 });
    api.reset();

    api.setInput({ vertical: 1 });
    api.step(120);
    api.clearInput();

    const state = api.getState();
    expect(state.crashed).toBe(false);
    expect(state.altitude).toBeGreaterThan(5);
    expect(state.altitude).toBeLessThan(20);
  });
});

describe('Spec §20 — fly forward test', () => {
  it('gains speed and moves along -Z', () => {
    const { api } = createHarness({ seed: 1 });

    api.reset({ seed: 123 });
    api.pause();
    api.setInput({ pitch: 1 });
    api.step(180);
    api.clearInput();

    const state = api.getState();
    expect(state.speed).toBeGreaterThan(0);
    expect(state.position.z).toBeLessThan(0);
  });

  it('reports pause state and refuses to advance from the frame loop', () => {
    const { sim } = createHarness({ seed: 1 });
    sim.pause();
    expect(sim.isPaused).toBe(true);
    sim.advance(1);
    expect(sim.getState().tick).toBe(0);
    sim.resume();
    expect(sim.isPaused).toBe(false);
  });
});

describe('Spec §21 — automation without keyboard events', () => {
  it('never needs a DOM event to fly', () => {
    const { api, sim } = createHarness({ seed: 2 });

    api.pause();
    api.setInput({ vertical: 1 });
    api.step(120);
    api.clearInput();

    expect(sim.getState().altitude).toBeGreaterThan(5);
    // No browser input plumbing was involved at all: the sticks are released
    // and the automation channel is idle.
    expect(sim.automationInput.isActive()).toBe(false);
    expect(sim.automationInput.getInput()).toEqual({ pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: false });
    expect(sim.getControlMode()).toBe('manual');
  });
});

describe('Spec §24 — world query API', () => {
  it('returns structured building snapshots near the drone', () => {
    const { sim, api } = createHarness({ seed: 12345 });
    // Fly somewhere with neighbours.
    sim.reset({ position: { x: 0, y: 40, z: 0 } });

    const buildings = api.getNearbyBuildings(50);
    expect(Array.isArray(buildings)).toBe(true);
    expect(buildings.length).toBeGreaterThan(0);

    for (const building of buildings) {
      expect(typeof building.id).toBe('string');
      expect(building.position).toHaveProperty('x');
      expect(building.position).toHaveProperty('y');
      expect(building.position).toHaveProperty('z');
      expect(building.size).toHaveProperty('x');
      expect(building.size).toHaveProperty('y');
      expect(building.size).toHaveProperty('z');
      expect(typeof building.distance).toBe('number');
      expect(building.distance).toBeGreaterThanOrEqual(0);
    }

    // Everything returned really is within the requested radius.
    for (const building of buildings) {
      expect(building.distance).toBeLessThanOrEqual(50 + 1e-6);
    }
  });

  it('produces JSON-serializable payloads', () => {
    const { api } = createHarness({ seed: 42 });
    const payload = api.getNearbyBuildings(80);
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
  });
});

describe('Spec §25 — sensor API', () => {
  it('reports downward distance and altitude', () => {
    const { sim, api } = createHarness({ seed: 12345 });
    sim.reset({ position: { x: 0, y: 60, z: 0 } });

    const sensors = api.getSensors();
    expect(sensors.altitude).toBeCloseTo(60, 6);
    expect(sensors.downDistance).toBeCloseTo(60, 6);
    expect(sensors.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(sensors.heading).toBe(0);
  });

  it('sees a building in front and reports null when the path is clear', () => {
    const { sim, api } = createHarness({ seed: 123 });
    const approach = sim.spawn.findApproach({ distance: 30 });

    sim.reset({ position: approach.position });
    sim.setRotation({ yaw: approach.yaw });

    const sensors = api.getSensors();
    expect(sensors.frontDistance).not.toBeNull();
    expect(sensors.frontDistance!).toBeGreaterThan(0);
    expect(sensors.frontDistance!).toBeLessThan(30);

    // Turn 180 degrees: the same wall is now behind us.
    sim.setRotation({ yaw: approach.yaw + Math.PI });
    expect(api.getSensors().backDistance).not.toBeNull();
  });
});

describe('Spec §26 — observation API', () => {
  it('returns the documented shape', () => {
    const { sim, api } = createHarness({ seed: 12345 });
    sim.step(30);

    const observation = api.observe();
    expect(Object.keys(observation).sort()).toEqual(
      [
        'altitude',
        'collision',
        'crashed',
        'goalDirection',
        'goalDistance',
        'goalReached',
        'grounded',
        'heading',
        'position',
        'rotation',
        'sensors',
        'speed',
        'tick',
        'velocity',
      ].sort(),
    );

    expect(observation.position).toHaveLength(3);
    expect(observation.velocity).toHaveLength(3);
    expect(observation.rotation).toHaveLength(3);
    expect(typeof observation.tick).toBe('number');
    expect(typeof observation.collision).toBe('boolean');
    expect(observation.sensors).toHaveProperty('front');
    expect(observation.sensors).toHaveProperty('left');
    expect(observation.sensors).toHaveProperty('right');
    expect(observation.sensors).toHaveProperty('down');
    expect(JSON.parse(JSON.stringify(observation))).toBeTruthy();
  });
});

describe('Spec §27 — action API', () => {
  it('drives the drone through act() + step(1)', () => {
    const { api } = createHarness({ seed: 123 });
    api.reset({ position: { x: 0, y: 80, z: 0 } });

    const before = api.getState();
    api.act({ pitch: 0.7, roll: 0, yaw: -0.2, vertical: 0.1 });
    api.step(1);

    const after = api.getState();
    expect(after.tick).toBe(before.tick + 1);
    expect(after.rotation.yaw).toBeLessThan(before.rotation.yaw);
    expect(after.velocity.z).toBeLessThan(0);
    expect(after.altitude).toBeGreaterThan(before.altitude);
    // The applied input is readable back.
    expect(api.getInput().pitch).toBeCloseTo(0.7, 6);
  });
});

describe('Spec §28 — episode API', () => {
  it('reports the documented episode summary', () => {
    const { api } = createHarness({ seed: 12345 });

    api.startEpisode({ seed: 100, spawn: 'random' });
    expect(api.getWorldInfo().seed).toBe(100);

    // Fly well above the skyline so the episode cannot end in a crash.
    api.teleport({ x: 0, y: 300, z: 0 });
    api.setInput({ pitch: 1, vertical: 0.2 });
    api.step(300);
    api.clearInput();

    const summary = api.endEpisode();
    expect(Object.keys(summary).sort()).toEqual(
      ['collisions', 'crashed', 'distanceTravelled', 'duration', 'ticks'].sort(),
    );
    expect(summary.ticks).toBe(300);
    expect(summary.duration).toBeCloseTo(5, 3);
    expect(summary.distanceTravelled).toBeGreaterThan(0);
    expect(summary.crashed).toBe(false);
  });

  it('resets episode statistics between episodes', () => {
    const { api } = createHarness({ seed: 12345 });
    api.startEpisode({ seed: 12345, spawn: 'default' });
    api.setInput({ pitch: 1 });
    api.step(60);
    expect(api.endEpisode().ticks).toBe(60);

    api.startEpisode({ seed: 12345, spawn: 'default' });
    expect(api.getEpisodeStats().ticks).toBe(0);
  });
});

describe('Spec §29 — goal system', () => {
  it('reports goal distance and direction in the observation', () => {
    const { api } = createHarness({ seed: 123 });
    api.reset({ position: { x: 0, y: 50, z: 0 } });

    api.setGoal({ x: 400, y: 50, z: -250 });
    const observation = api.observe();

    expect(observation.goalDistance).toBeCloseTo(Math.hypot(400, 0, -250), 6);
    expect(observation.goalDirection).not.toBeNull();
    const [dx, dy, dz] = observation.goalDirection!;
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 6);
    expect(observation.goalReached).toBe(false);
    expect(api.getGoal()).toEqual({ x: 400, y: 50, z: -250, radius: 5 });
  });

  it('marks the waypoint reached inside the 5 m radius', () => {
    const { api } = createHarness({ seed: 123 });
    api.reset({ position: { x: 0, y: 50, z: 0 } });
    api.setGoal({ x: 0, y: 50, z: -3 });

    api.step(1);
    expect(api.isGoalReached()).toBe(true);
    expect(api.observe().goalReached).toBe(true);
    expect(api.getGoalDistance()).toBeCloseTo(3, 6);
  });

  it('clears the goal', () => {
    const { api } = createHarness({ seed: 123 });
    api.setGoal({ x: 1, y: 2, z: 3 });
    api.clearGoal();
    expect(api.getGoal()).toBeNull();
    expect(api.observe().goalDistance).toBeNull();
  });
});

describe('Spec §32 — control mode', () => {
  it('switches between manual and automation', () => {
    const { api } = createHarness({ seed: 123 });
    expect(api.getControlMode()).toBe('manual');

    api.setControlMode('automation');
    expect(api.getControlMode()).toBe('automation');

    api.setControlMode('manual');
    expect(api.getControlMode()).toBe('manual');
  });
});

describe('Spec §34 / §18 — teleport, rotation, pause, camera', () => {
  it('teleports and resets velocity', () => {
    const { api } = createHarness({ seed: 123 });
    api.setInput({ pitch: 1 });
    api.step(60);

    api.teleport({ x: 100, y: 55, z: -200 });
    const state = api.getState();
    expect(state.position).toEqual({ x: 100, y: 55, z: -200 });
    expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.altitude).toBe(55);
  });

  it('applies partial rotation updates', () => {
    const { api } = createHarness({ seed: 123 });
    api.setRotation({ yaw: Math.PI / 2 });
    const state = api.getState();
    expect(state.rotation.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(state.rotation.pitch).toBe(0);
    expect(state.rotation.roll).toBe(0);

    api.setRotation({ pitch: 0.3 });
    expect(api.getState().rotation.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(api.getState().rotation.pitch).toBeCloseTo(0.3, 6);
  });

  it('accepts a camera mode even when no camera is attached', () => {
    const { api } = createHarness({ seed: 123 });
    expect(() => api.setCameraMode('fpv')).not.toThrow();
    expect(api.getCameraMode()).toBe('chase');
  });

  it('toggles pause', () => {
    const { api } = createHarness({ seed: 123 });
    expect(api.isPaused()).toBe(false);
    expect(api.togglePause()).toBe(true);
    expect(api.isPaused()).toBe(true);
    api.resume();
    expect(api.isPaused()).toBe(false);
  });
});

describe('Spec §35 — metrics', () => {
  it('reports the documented performance metrics', () => {
    const { sim, api } = createHarness({ seed: 12345 });
    sim.setRenderMetrics({ fps: 117, frameTimeMs: 8.5, drawCalls: 34, triangles: 284320 });

    const metrics = api.getMetrics();
    expect(metrics.fps).toBe(117);
    expect(metrics.frameTimeMs).toBe(8.5);
    expect(metrics.drawCalls).toBe(34);
    expect(metrics.triangles).toBe(284320);
    expect(metrics.buildingCount).toBeGreaterThanOrEqual(600);
    expect(metrics.simulationHz).toBe(60);
    expect(JSON.parse(JSON.stringify(metrics))).toBeTruthy();
  });
});

describe('world info', () => {
  it('describes the world', () => {
    const { sim, api } = createHarness({ seed: 777, buildingTarget: 700 });
    const info = api.getWorldInfo();

    expect(info.seed).toBe(777);
    expect(info.worldSize).toBe(2000);
    expect(info.blockCount).toBe(400);
    expect(info.buildingCount).toBe(700);
    expect(info.spatialCellSize).toBe(50);
    expect(info.testMode).toBe(false);
    expect(info.bounds.maxHeight).toBeGreaterThan(0);
    expect(info.spawn.y).toBeGreaterThan(0);
    expect(sim.buildings.count).toBe(700);
  });

  it('flags test mode', () => {
    const { api } = createHarness({ seed: 12345, testMode: true });
    expect(api.getWorldInfo().testMode).toBe(true);
    expect(api.isPaused()).toBe(true);
  });
});

describe('configuration', () => {
  it('reads and writes drone configuration', () => {
    const { api } = createHarness({ seed: 1 });
    expect(api.getConfig().maxHorizontalSpeed).toBe(20);

    api.setConfig({ maxHorizontalSpeed: 30 });
    expect(api.getConfig().maxHorizontalSpeed).toBe(30);
  });
});

describe('full snapshot helper', () => {
  it('bundles every serializable view in one call', () => {
    const { sim } = createHarness({ seed: 1 });
    sim.step(10);
    const snapshot = toFullSnapshot(sim);

    expect(Object.keys(snapshot).sort()).toEqual(
      ['episode', 'goal', 'input', 'metrics', 'observation', 'sensors', 'state', 'world'].sort(),
    );
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});
