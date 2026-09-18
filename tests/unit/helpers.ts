/**
 * Shared helpers for the headless simulation tests.
 *
 * These tests run in plain Node: no browser, no WebGL, no DOM. That is the
 * whole point of the architecture (Spec §39) — if these pass, the simulation
 * core genuinely does not depend on the renderer.
 */
import { AutomationAPI } from '../../src/automation/AutomationAPI';
import { AutomationInput } from '../../src/input/AutomationInput';
import { DroneSimulation, type SimulationOptions } from '../../src/simulation/DroneSimulation';
import { generateCity } from '../../src/world/CityGenerator';

export function createSim(options: SimulationOptions = {}): DroneSimulation {
  return new DroneSimulation(options);
}

export interface HeadlessHarness {
  sim: DroneSimulation;
  automation: AutomationInput;
  api: AutomationAPI;
}

/** A simulation with a real AutomationAPI attached, still in plain Node. */
export function createHarness(options: SimulationOptions = {}): HeadlessHarness {
  const automation = options.automationInput ?? new AutomationInput();
  const sim = new DroneSimulation({ ...options, automationInput: automation });
  const api = new AutomationAPI({ simulation: sim });
  return { sim, automation, api };
}

export function createLayout(seed: number) {
  return generateCity({ seed });
}

/** Deterministic pseudo-random action sequence for determinism tests. */
export function actionSequence(length: number): { pitch: number; roll: number; yaw: number; vertical: number }[] {
  const actions: { pitch: number; roll: number; yaw: number; vertical: number }[] = [];
  for (let i = 0; i < length; i += 1) {
    actions.push({
      pitch: Math.sin(i * 0.31),
      roll: Math.cos(i * 0.17) * 0.6,
      yaw: Math.sin(i * 0.07),
      vertical: Math.cos(i * 0.53) * 0.4,
    });
  }
  return actions;
}
