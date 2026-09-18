/**
 * InputManager — the single place where human and machine input meet
 * (Spec §3, §32).
 *
 * Priority:
 *
 *   Automation override
 *          ↓
 *       Gamepad
 *          ↓
 *       Keyboard
 *
 * By default keyboard and gamepad are *combined* (added, then clamped), and an
 * active automation channel overrides per-axis. `setControlMode('automation')`
 * disables human input entirely, which is what automated regression tests use.
 */
import type { DroneControlInput } from '../simulation/DroneState';
import { NEUTRAL_INPUT, createControlInput } from '../simulation/DroneState';
import { clamp } from '../simulation/vec3';
import { AutomationInput } from './AutomationInput';
import { GamepadInput, type GamepadCallbacks, type GamepadStatus } from './GamepadInput';
import { KeyboardInput, type KeyboardCallbacks } from './KeyboardInput';

export type ControlMode = 'manual' | 'automation';

export type InputSourceName = 'none' | 'keyboard' | 'gamepad' | 'keyboard+gamepad' | 'automation';

export interface InputManagerOptions {
  keyboard?: KeyboardInput;
  gamepad?: GamepadInput;
  automation?: AutomationInput;
  controlMode?: ControlMode;
}

export interface InputManagerSnapshot {
  input: DroneControlInput;
  source: InputSourceName;
  controlMode: ControlMode;
  keyboardActive: boolean;
  automationActive: boolean;
  gamepad: GamepadStatus;
}

export class InputManager {
  readonly keyboard: KeyboardInput;
  readonly gamepad: GamepadInput;
  readonly automation: AutomationInput;

  private controlMode: ControlMode;
  private lastInput: DroneControlInput = { ...NEUTRAL_INPUT };
  private lastSource: InputSourceName = 'none';

  constructor(options: InputManagerOptions = {}) {
    this.keyboard = options.keyboard ?? new KeyboardInput();
    this.gamepad = options.gamepad ?? new GamepadInput();
    this.automation = options.automation ?? new AutomationInput();
    this.controlMode = options.controlMode ?? 'manual';
  }

  attach(): void {
    this.keyboard.attach();
    this.gamepad.attach();
  }

  detach(): void {
    this.keyboard.detach();
    this.gamepad.detach();
  }

  setControlMode(mode: ControlMode): void {
    this.controlMode = mode;
  }

  getControlMode(): ControlMode {
    return this.controlMode;
  }

  /** Poll the pad; call once per rendered frame. */
  update(): void {
    this.gamepad.poll();
  }

  getInput(): DroneControlInput {
    const result = this.compute();

    // Keep the last non-neutral value so the HUD can show what was applied
    // even on the frame the keys were released.
    this.lastInput = result.input;
    this.lastSource = result.source;
    return result.input;
  }

  /** Last resolved input without re-reading devices. */
  peekInput(): DroneControlInput {
    return { ...this.lastInput };
  }

  getActiveSource(): InputSourceName {
    return this.lastSource;
  }

  getSnapshot(): InputManagerSnapshot {
    const result = this.compute();
    return {
      input: result.input,
      source: result.source,
      controlMode: this.controlMode,
      keyboardActive: this.keyboard.isActive,
      automationActive: this.automation.isActive(),
      gamepad: this.gamepad.getStatus(),
    };
  }

  setKeyboardCallbacks(callbacks: KeyboardCallbacks): void {
    this.keyboard.setCallbacks(callbacks);
  }

  setGamepadCallbacks(callbacks: GamepadCallbacks): void {
    this.gamepad.setCallbacks(callbacks);
  }

  private compute(): { input: DroneControlInput; source: InputSourceName } {
    const automation = this.automation.getInput();

    if (this.controlMode === 'automation') {
      const input = this.automation.isActive() ? automation : { ...NEUTRAL_INPUT };
      return { input, source: 'automation' };
    }

    const keyboardInput = this.keyboard.getInput();
    const gamepadInput = this.gamepad.connected ? this.gamepad.getInput() : { ...NEUTRAL_INPUT };

    const keyboardActive = !isNeutral(keyboardInput);
    const gamepadActive = this.gamepad.connected && !isNeutral(gamepadInput);

    const combined = createControlInput({
      pitch: clamp(keyboardInput.pitch + gamepadInput.pitch, -1, 1),
      roll: clamp(keyboardInput.roll + gamepadInput.roll, -1, 1),
      yaw: clamp(keyboardInput.yaw + gamepadInput.yaw, -1, 1),
      vertical: clamp(keyboardInput.vertical + gamepadInput.vertical, -1, 1),
      brake: keyboardInput.brake === true || gamepadInput.brake === true,
    });

    let source: InputSourceName = 'none';
    if (keyboardActive && gamepadActive) source = 'keyboard+gamepad';
    else if (keyboardActive) source = 'keyboard';
    else if (gamepadActive) source = 'gamepad';

    if (this.automation.isActive()) {
      return {
        input: {
          pitch: automation.pitch !== 0 ? automation.pitch : combined.pitch,
          roll: automation.roll !== 0 ? automation.roll : combined.roll,
          yaw: automation.yaw !== 0 ? automation.yaw : combined.yaw,
          vertical: automation.vertical !== 0 ? automation.vertical : combined.vertical,
          brake: automation.brake === true || combined.brake === true,
        },
        source: 'automation',
      };
    }

    return { input: combined, source };
  }
}

function isNeutral(input: DroneControlInput): boolean {
  return (
    input.pitch === 0 && input.roll === 0 && input.yaw === 0 && input.vertical === 0 && input.brake !== true
  );
}
