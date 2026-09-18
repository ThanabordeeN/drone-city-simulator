/**
 * main.ts — application bootstrap (Spec §3, §23, §33).
 *
 * Wires the pure simulation core to the browser: canvas renderer, camera,
 * HUD and input devices. Everything it creates is *downstream* of the
 * simulation; deleting this file would still leave a fully testable simulator.
 *
 * URL parameters (§33):
 *   ?seed=123            deterministic city seed
 *   ?testMode=1          fixed seed, starts paused, animation randomness off
 *   ?buildings=800       building budget (600 – 1500)
 *   ?camera=fpv          initial camera mode: chase | fpv | free
 *   ?debug=1             open the debug panel on load
 *   ?control=automation  start with human input disabled
 */
import { AutomationAPI, installAutomationAPI } from './automation/AutomationAPI';
import { AutomationInput } from './input/AutomationInput';
import { GamepadInput, type GamepadProfile } from './input/GamepadInput';
import { InputManager, type ControlMode } from './input/InputManager';
import { KeyboardInput } from './input/KeyboardInput';
import { CameraController, type CameraMode } from './rendering/CameraController';
import { DroneRenderer } from './rendering/DroneRenderer';
import { HUD } from './rendering/HUD';
import { SceneRenderer } from './rendering/SceneRenderer';
import { DroneSimulation } from './simulation/DroneSimulation';
import { generateCity, hashSeed, TEST_MODE_SEED } from './world/CityGenerator';

export interface BootstrapParams {
  seed: number;
  seedSource: string | null;
  testMode: boolean;
  buildingTarget?: number;
  camera: CameraMode;
  debug: boolean;
  control: ControlMode;
  profile?: GamepadProfile;
}

const CAMERA_MODES: CameraMode[] = ['chase', 'fpv', 'free'];

/** Parse `?seed=…&testMode=1&buildings=…&camera=…` (Spec §33). */
export function parseUrlParams(search: string = window.location.search): BootstrapParams {
  const params = new URLSearchParams(search);
  const testMode = params.get('testMode') === '1' || params.get('testMode') === 'true';

  const rawSeed = params.get('seed');
  const seed = testMode && !rawSeed ? TEST_MODE_SEED : hashSeed(rawSeed, TEST_MODE_SEED);

  const rawBuildings = params.get('buildings');
  let buildingTarget: number | undefined;
  if (rawBuildings !== null && rawBuildings !== '') {
    const parsed = Number(rawBuildings);
    if (Number.isFinite(parsed) && parsed > 0) {
      buildingTarget = Math.max(50, Math.floor(parsed));
    }
  }

  const rawCamera = (params.get('camera') ?? 'chase') as CameraMode;
  const camera = CAMERA_MODES.includes(rawCamera) ? rawCamera : 'chase';

  const rawControl = params.get('control');
  const control: ControlMode = rawControl === 'automation' ? 'automation' : 'manual';

  const rawProfile = params.get('profile');
  const profile: GamepadProfile | undefined =
    rawProfile === 'droneMode2' || rawProfile === 'gameController' || rawProfile === 'custom'
      ? rawProfile
      : undefined;

  return {
    seed,
    seedSource: rawSeed,
    testMode,
    ...(buildingTarget !== undefined ? { buildingTarget } : {}),
    camera,
    debug: params.get('debug') === '1' || params.get('debug') === 'true',
    control,
    ...(profile !== undefined ? { profile } : {}),
  };
}

function showBootError(error: unknown): void {
  const element = document.getElementById('boot-error');
  if (!element) return;
  element.style.display = 'grid';
  element.textContent = `Drone City Simulator failed to start:\n\n${String(error)}`;
  console.error('[drone-sim] boot failure', error);
}

async function bootstrap(): Promise<void> {
  const params = parseUrlParams();

  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#viewport canvas not found');

  // ---- World (deterministic from the seed) ------------------------------
  const layout = generateCity({
    seed: params.seed,
    ...(params.buildingTarget !== undefined ? { buildingTarget: params.buildingTarget } : {}),
  });

  // ---- Rendering --------------------------------------------------------
  const sceneRenderer = new SceneRenderer(canvas, layout, params.testMode);
  const cameraController = new CameraController(sceneRenderer.camera, canvas);
  const droneRenderer = new DroneRenderer({ testMode: params.testMode });
  sceneRenderer.scene.add(droneRenderer.group);
  cameraController.attach();
  cameraController.setMode(params.camera);

  // ---- Input ------------------------------------------------------------
  const automationInput = new AutomationInput();
  const keyboard = new KeyboardInput();
  const gamepad = new GamepadInput(params.profile ? { profile: params.profile } : {});
  const inputManager = new InputManager({
    keyboard,
    gamepad,
    automation: automationInput,
    controlMode: params.control,
  });
  inputManager.attach();

  // ---- Simulation (source of truth) -------------------------------------
  const simulation = new DroneSimulation({
    layout,
    testMode: params.testMode,
    inputSource: inputManager,
    automationInput,
    startPaused: params.testMode,
  });
  simulation.setControlMode(params.control);
  cameraController.snap(simulation.state);

  // ---- HUD --------------------------------------------------------------
  const hud = new HUD(document.body);
  hud.showDebug(params.debug);

  // ---- Keyboard / gamepad commands --------------------------------------
  const handleReset = (): void => {
    simulation.reset();
    simulation.clearInput();
    cameraController.snap(simulation.state);
  };
  const handleCameraCycle = (): void => {
    cameraController.cycle();
  };
  const handlePause = (): void => {
    simulation.togglePause();
  };

  keyboard.setCallbacks({
    onReset: handleReset,
    onCameraCycle: handleCameraCycle,
    onTogglePause: handlePause,
    onToggleHelp: () => hud.toggleHelp(),
    onToggleDebug: () => hud.toggleDebug(),
  });
  gamepad.setCallbacks({
    onReset: handleReset,
    onCameraCycle: handleCameraCycle,
    onTogglePause: handlePause,
  });

  // Rebuild the GPU-side city whenever the simulation swaps worlds.
  simulation.onWorldChanged((newLayout, roads) => {
    sceneRenderer.buildCity(newLayout, roads);
  });

  // ---- Automation API (Spec §17) ----------------------------------------
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const api = new AutomationAPI({
    simulation,
    camera: cameraController,
    sceneRenderer,
    inputManager,
    ready,
  });
  installAutomationAPI(api);

  // ---- Frame loop -------------------------------------------------------
  let lastFrameAt = performance.now();
  let firstFrame = true;

  const frame = (now: number): void => {
    const deltaSeconds = Math.min((now - lastFrameAt) / 1000, 0.25);
    lastFrameAt = now;

    inputManager.update();
    const steps = simulation.advance(deltaSeconds);
    void steps;

    cameraController.update(simulation.state, deltaSeconds);
    droneRenderer.update(simulation.state, simulation.getInput(), deltaSeconds);
    droneRenderer.setFpvHidden(cameraController.mode === 'fpv');

    sceneRenderer.render();
    simulation.setRenderMetrics(sceneRenderer.getMetrics());

    hud.update({
      state: simulation.state,
      input: simulation.getInput(),
      metrics: simulation.getMetrics(),
      inputSnapshot: inputManager.getSnapshot(),
      cameraMode: cameraController.mode,
      worldInfo: simulation.getWorldInfo(),
      paused: simulation.isPaused,
      sensors: simulation.observe().sensors,
    });

    if (firstFrame) {
      firstFrame = false;
      api.markReady();
      resolveReady();
    }

    requestAnimationFrame(frame);
  };

  window.addEventListener('resize', () => sceneRenderer.resize());
  sceneRenderer.resize();
  requestAnimationFrame(frame);
}

if (typeof window !== 'undefined') {
  bootstrap().catch(showBootError);
}

export { bootstrap };
