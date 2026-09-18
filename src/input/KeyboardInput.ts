/**
 * Keyboard input (Spec §7).
 *
 * Simultaneous keys are the norm (`W + D + Shift`), so this is a held-key set
 * rather than a one-key-at-a-time state machine. R/C/P are edge-triggered
 * commands, not axes.
 */
import { NEUTRAL_INPUT, createControlInput, type DroneControlInput } from '../simulation/DroneState';
import { clamp } from '../simulation/vec3';

export interface KeyboardCallbacks {
  onReset?: () => void;
  onCameraCycle?: () => void;
  onTogglePause?: () => void;
  onToggleHelp?: () => void;
  onToggleDebug?: () => void;
}

const PITCH_FORWARD = new Set(['KeyW', 'ArrowUp']);
const PITCH_BACKWARD = new Set(['KeyS', 'ArrowDown']);
const ROLL_LEFT = new Set(['KeyA', 'ArrowLeft']);
const ROLL_RIGHT = new Set(['KeyD', 'ArrowRight']);
const YAW_LEFT = new Set(['KeyQ']);
const YAW_RIGHT = new Set(['KeyE']);
const ASCEND = new Set(['ShiftLeft', 'ShiftRight']);
const DESCEND = new Set(['ControlLeft', 'ControlRight']);
const BRAKE = new Set(['Space']);

const HANDLED_CODES = new Set([
  ...PITCH_FORWARD,
  ...PITCH_BACKWARD,
  ...ROLL_LEFT,
  ...ROLL_RIGHT,
  ...YAW_LEFT,
  ...YAW_RIGHT,
  ...ASCEND,
  ...DESCEND,
  ...BRAKE,
  'KeyR',
  'KeyC',
  'KeyP',
  'KeyH',
  'KeyB',
]);

export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private attached = false;
  private callbacks: KeyboardCallbacks = {};

  /** Counts key presses for the debug panel. */
  private eventCount = 0;

  constructor(callbacks: KeyboardCallbacks = {}) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: KeyboardCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached || typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.pressed.clear();
    this.attached = false;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get isActive(): boolean {
    return this.pressed.size > 0;
  }

  get keyCount(): number {
    return this.eventCount;
  }

  getPressedKeys(): string[] {
    return [...this.pressed];
  }

  clear(): void {
    this.pressed.clear();
  }

  getInput(): DroneControlInput {
    let pitch = 0;
    let roll = 0;
    let yaw = 0;
    let vertical = 0;

    for (const code of this.pressed) {
      if (PITCH_FORWARD.has(code)) pitch += 1;
      else if (PITCH_BACKWARD.has(code)) pitch -= 1;
      else if (ROLL_RIGHT.has(code)) roll += 1;
      else if (ROLL_LEFT.has(code)) roll -= 1;
      else if (YAW_LEFT.has(code)) yaw += 1;
      else if (YAW_RIGHT.has(code)) yaw -= 1;
      else if (ASCEND.has(code)) vertical += 1;
      else if (DESCEND.has(code)) vertical -= 1;
    }

    let brake = false;
    for (const code of BRAKE) {
      if (this.pressed.has(code)) brake = true;
    }

    return createControlInput({
      pitch: clamp(pitch, -1, 1),
      roll: clamp(roll, -1, 1),
      yaw: clamp(yaw, -1, 1),
      vertical: clamp(vertical, -1, 1),
      brake,
    });
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (HANDLED_CODES.has(event.code)) {
      // Stop the browser scrolling / opening menus while flying.
      event.preventDefault();
    }

    if (event.repeat) return;

    this.pressed.add(event.code);
    this.eventCount += 1;

    switch (event.code) {
      case 'KeyR':
        this.callbacks.onReset?.();
        break;
      case 'KeyC':
        this.callbacks.onCameraCycle?.();
        break;
      case 'KeyP':
        this.callbacks.onTogglePause?.();
        break;
      case 'KeyH':
        this.callbacks.onToggleHelp?.();
        break;
      case 'KeyB':
        this.callbacks.onToggleDebug?.();
        break;
      default:
        break;
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /** Losing focus must not leave a key stuck down. */
  private readonly handleBlur = (): void => {
    this.pressed.clear();
  };
}

export const KEYBOARD_HELP: { keys: string; action: string }[] = [
  { keys: 'W / S', action: 'Pitch forward / backward (move on Z)' },
  { keys: 'A / D', action: 'Roll left / right (move on X)' },
  { keys: 'Shift', action: 'Ascend' },
  { keys: 'Control', action: 'Descend' },
  { keys: 'Q / E', action: 'Yaw left / right' },
  { keys: 'Space', action: 'Brake / hover' },
  { keys: 'R', action: 'Reset drone' },
  { keys: 'C', action: 'Change camera' },
  { keys: 'P', action: 'Pause simulation' },
  { keys: 'B', action: 'Toggle debug panel' },
  { keys: 'H', action: 'Toggle this help' },
];

export { NEUTRAL_INPUT };
