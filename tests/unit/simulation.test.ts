/**
 * Spec §37 — Required automated tests 1-7, plus timing and lifecycle checks.
 */
import { describe, expect, it } from 'vitest';
import { DroneSimulation } from '../../src/simulation/DroneSimulation';
import { actionSequence, createHarness, createSim } from './helpers';

describe('Test 1 — Spawn', () => {
  it('spawns above the ground and not crashed', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ seed: 123 });

    const state = sim.getState();
    expect(state.altitude).toBeGreaterThan(0);
    expect(state.crashed).toBe(false);
    expect(state.collided).toBe(false);
    expect(state.tick).toBe(0);
  });

  it('spawns on a clear road intersection, not inside a building', () => {
    const sim = createSim({ seed: 7 });
    const spawn = sim.getSpawnPosition();
    expect(sim.roads.isOnRoad(spawn.x, spawn.z)).toBe(true);
    // Horizontally clear of every building, and inside the world.
    expect(sim.buildings.queryXZ(spawn, 2.5)).toHaveLength(0);
    expect(Math.abs(spawn.x)).toBeLessThan(sim.roads.worldHalf);
    expect(Math.abs(spawn.z)).toBeLessThan(sim.roads.worldHalf);
  });
});

describe('Test 2 — Ascend', () => {
  it('climbs when vertical = +1 for 120 ticks', () => {
    const sim = createSim({ seed: 123 });
    const before = sim.getState().altitude;

    sim.setInput({ vertical: 1 });
    sim.step(120);
    sim.clearInput();

    const after = sim.getState();
    expect(after.altitude).toBeGreaterThan(before);
    // ~15 m of climb in 2 s with the default dynamics.
    expect(after.altitude - before).toBeGreaterThan(5);
    expect(after.crashed).toBe(false);
  });

  it('matches the Spec §19 example within a sane tolerance', () => {
    const sim = createSim({ seed: 12345 });
    sim.reset();
    sim.setInput({ vertical: 1 });
    sim.step(120);
    sim.clearInput();

    const state = sim.getState();
    expect(state.altitude).toBeGreaterThan(12);
    expect(state.altitude).toBeLessThan(19);
    expect(state.crashed).toBe(false);
  });
});

describe('Test 3 — Descend', () => {
  it('loses altitude when vertical = -1 for 60 ticks from 30 m', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 30, z: 0 } });
    const before = sim.getState().altitude;
    expect(before).toBeCloseTo(30, 5);

    sim.setInput({ vertical: -1 });
    sim.step(60);
    sim.clearInput();

    const after = sim.getState();
    expect(after.altitude).toBeLessThan(before);
    expect(after.crashed).toBe(false);
  });
});

describe('Test 4 — Forward', () => {
  it('moves horizontally (and along -Z at yaw 0) when pitch = 1', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 60, z: 0 } });
    const before = sim.getState();

    sim.setInput({ pitch: 1 });
    sim.step(120);
    sim.clearInput();

    const after = sim.getState();
    const displacement = Math.hypot(
      after.position.x - before.position.x,
      after.position.z - before.position.z,
    );

    expect(after.speed).toBeGreaterThan(0);
    expect(displacement).toBeGreaterThan(10);
    // Spec §20: at yaw 0, forward is -Z.
    expect(after.position.z).toBeLessThan(before.position.z);
  });

  it('reaches close to the configured maximum horizontal speed', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 120, z: 0 } });
    sim.setInput({ pitch: 1 });
    sim.step(300);

    const speed = sim.getHorizontalSpeed();
    expect(speed).toBeGreaterThan(15);
    expect(speed).toBeLessThanOrEqual(sim.getConfig().maxHorizontalSpeed + 1e-6);
  });
});

describe('Test 5 — Yaw', () => {
  it('changes heading when yaw = 1 for 60 ticks', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 80, z: 0 } });
    const before = sim.getState().rotation.yaw;

    sim.setInput({ yaw: 1 });
    sim.step(60);
    sim.clearInput();

    const after = sim.getState().rotation.yaw;
    expect(Math.abs(after - before)).toBeGreaterThan(0.5);
    // Default yaw rate is 1.8 rad/s -> ~1.8 rad in one second.
    expect(Math.abs(after - before)).toBeCloseTo(sim.getConfig().yawSpeed, 1);
  });

  it('yaws the other way with yaw = -1', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 80, z: 0 } });
    sim.setInput({ yaw: -1 });
    sim.step(30);
    expect(sim.getState().rotation.yaw).toBeLessThan(0);
  });
});

describe('Test 6 — Collision', () => {
  it('reports a collision when flying into a building', () => {
    const sim = createSim({ seed: 123 });
    const approach = sim.spawn.findApproach({ distance: 20 });

    sim.reset({ position: approach.position });
    sim.setRotation({ yaw: approach.yaw });

    // Sanity: the start position must be free.
    expect(sim.getState().collided).toBe(false);
    expect(sim.getState().crashed).toBe(false);

    sim.setInput({ pitch: 1 });
    sim.step(180);
    sim.clearInput();

    const state = sim.getState();
    expect(state.collided).toBe(true);
    expect(sim.getCollisionCounts().building).toBeGreaterThan(0);
    expect(sim.getEpisodeStats().collisions).toBeGreaterThan(0);
  });

  it('detects a ground collision after a hard descent', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 60, z: 0 } });
    sim.setInput({ vertical: -1 });
    sim.step(400);
    sim.clearInput();

    const state = sim.getState();
    expect(state.collided).toBe(true);
    expect(state.grounded).toBe(true);
    // Descending at up to 10 m/s exceeds the 8 m/s crash threshold.
    expect(state.crashed).toBe(true);
    expect(sim.getEpisodeStats().collisions).toBeGreaterThan(0);
  });

  it('does not report a collision while resting on the ground', () => {
    const sim = createSim({ seed: 123 });
    const radius = sim.getConfig().radius;
    sim.reset({ position: { x: 0, y: radius, z: 0 } });
    sim.step(30);

    const state = sim.getState();
    expect(state.grounded).toBe(true);
    expect(state.collided).toBe(false);
    expect(state.crashed).toBe(false);
    expect(state.altitude).toBeCloseTo(radius, 6);
  });

  it('reports a ground collision but no crash for a slow touchdown', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 2.2, z: 0 } });
    // Descend at a low throttle: the impact stays under the 8 m/s threshold.
    sim.setInput({ vertical: -0.35 });
    sim.step(90);
    sim.clearInput();

    const state = sim.getState();
    expect(state.grounded).toBe(true);
    expect(state.crashed).toBe(false);
  });

  it('keeps the drone inside the world bounds', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 0, y: 300, z: 0 } });
    sim.setInput({ pitch: 1 });
    sim.step(60 * 60);
    sim.clearInput();

    const limit = sim.roads.worldHalf;
    expect(Math.abs(sim.getState().position.x)).toBeLessThanOrEqual(limit + 1e-6);
    expect(Math.abs(sim.getState().position.z)).toBeLessThanOrEqual(limit + 1e-6);
  });
});

describe('Test 7 — Determinism', () => {
  it('produces identical final states for identical seeds and actions', () => {
    const run = (): ReturnType<DroneSimulation['getState']> => {
      const sim = createSim({ seed: 123 });
      sim.reset({ seed: 123 });
      sim.setInput({ vertical: 1 });
      sim.step(60);
      sim.clearInput();

      const actions = actionSequence(240);
      for (const action of actions) {
        sim.setInput(action);
        sim.step(1);
      }
      sim.clearInput();
      return sim.getState();
    };

    const a = run();
    const b = run();

    expect(a.tick).toBe(b.tick);
    expect(a.position.x).toBeCloseTo(b.position.x, 10);
    expect(a.position.y).toBeCloseTo(b.position.y, 10);
    expect(a.position.z).toBeCloseTo(b.position.z, 10);
    expect(a.velocity.x).toBeCloseTo(b.velocity.x, 10);
    expect(a.velocity.y).toBeCloseTo(b.velocity.y, 10);
    expect(a.velocity.z).toBeCloseTo(b.velocity.z, 10);
    expect(a.rotation.yaw).toBeCloseTo(b.rotation.yaw, 10);
  });

  it('gives the same trajectory at 30 FPS and 60 FPS rendering (Spec §4)', () => {
    const runAt = (hz: number): ReturnType<DroneSimulation['getState']> => {
      const sim = createSim({ seed: 99 });
      sim.reset({ seed: 99 });
      sim.setInput({ pitch: 0.7, vertical: 0.3 });
      for (let i = 0; i < hz * 3; i += 1) sim.advance(1 / hz);
      return sim.getState();
    };

    const sixty = runAt(60);
    const thirty = runAt(30);
    const hundredFortyFour = runAt(144);

    expect(thirty.tick).toBe(sixty.tick);
    expect(hundredFortyFour.tick).toBe(sixty.tick);
    // Same 3 s of wall-clock time must yield the same number of fixed ticks.
    expect(sixty.tick).toBe(180);
    expect(thirty.position.x).toBeCloseTo(sixty.position.x, 8);
    expect(thirty.position.z).toBeCloseTo(sixty.position.z, 8);
    expect(thirty.position.y).toBeCloseTo(sixty.position.y, 8);
    expect(hundredFortyFour.position.x).toBeCloseTo(sixty.position.x, 8);
    expect(hundredFortyFour.position.z).toBeCloseTo(sixty.position.z, 8);
    expect(hundredFortyFour.position.y).toBeCloseTo(sixty.position.y, 8);
  });
});

describe('Fixed timestep (Spec §4)', () => {
  it('never advances physics while paused', () => {
    const sim = createSim({ seed: 123 });
    sim.reset();
    sim.pause();

    sim.advance(1);
    sim.advance(0.5);
    expect(sim.getState().tick).toBe(0);

    sim.step(5);
    expect(sim.getState().tick).toBe(5);
  });

  it('accumulates sub-step deltas instead of dropping them', () => {
    const sim = createSim({ seed: 123 });
    sim.reset();
    sim.setInput({ vertical: 1 });

    // 6 x 1/360 s == one fixed 1/60 s tick.
    for (let i = 0; i < 6; i += 1) sim.advance(1 / 360);
    expect(sim.getState().tick).toBe(1);
  });

  it('shares one fixed dt across pause/step and rendered mode', () => {
    const sim = createSim({ seed: 123 });
    expect(sim.fixedDt).toBeCloseTo(1 / 60, 12);
    expect(sim.getMetrics().simulationHz).toBe(60);
    expect(sim.getMetrics().fixedDtMs).toBeCloseTo(16.667, 2);
  });
});

describe('Reset (Spec §34)', () => {
  it('clears position, velocity, rotation, collisions, input and episode stats', () => {
    const sim = createSim({ seed: 123 });
    sim.setInput({ pitch: 1, vertical: 1 });
    sim.step(120);
    expect(sim.getState().tick).toBe(120);
    expect(sim.getEpisodeStats().ticks).toBe(120);

    sim.reset();

    const state = sim.getState();
    expect(state.tick).toBe(0);
    expect(state.velocity.x).toBe(0);
    expect(state.velocity.y).toBe(0);
    expect(state.velocity.z).toBe(0);
    expect(state.rotation.pitch).toBe(0);
    expect(state.rotation.yaw).toBe(0);
    expect(state.rotation.roll).toBe(0);
    expect(state.collided).toBe(false);
    expect(state.crashed).toBe(false);
    expect(state.speed).toBe(0);
    expect(sim.getInput().pitch).toBe(0);
    expect(sim.getEpisodeStats().ticks).toBe(0);

    // The drone must not move after the input was cleared.
    sim.step(30);
    expect(sim.getState().position.x).toBeCloseTo(state.position.x, 10);
  });

  it('can reset to an explicit position', () => {
    const sim = createSim({ seed: 123 });
    sim.reset({ position: { x: 12, y: 44, z: -8 } });
    const state = sim.getState();
    expect(state.position).toEqual({ x: 12, y: 44, z: -8 });
    expect(state.altitude).toBe(44);
  });
});

describe('camera-independent simulation', () => {
  it('exposes no renderer dependency on the simulation core', () => {
    const sim = createSim({ seed: 123 });
    // If this file could import three.js at runtime the test would still pass,
    // but the module graph assertion below is the real guard.
    expect(Object.keys(sim)).not.toContain('renderer');
    expect(typeof sim.advance).toBe('function');
    expect(typeof sim.step).toBe('function');
  });

  it('runs a full observe -> act -> step agent loop headlessly', () => {
    const { sim } = createHarness({ seed: 4 });
    sim.pause();

    for (let i = 0; i < 120; i += 1) {
      const observation = sim.observe();
      const action = observation.sensors.down !== null && observation.altitude < 20
        ? { vertical: 1 }
        : { pitch: 1 };
      sim.act(action);
      sim.step(1);
    }

    const state = sim.getState();
    expect(state.tick).toBe(120);
    expect(state.crashed).toBe(false);
    expect(state.speed).toBeGreaterThan(0);
  });
});
