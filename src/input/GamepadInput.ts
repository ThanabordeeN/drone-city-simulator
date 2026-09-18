/**
 * Gamepad / joystick input (Spec §8, §9).
 *
 * Two built-in profiles:
 *
 *  - `droneMode2`    : RC "Mode 2" layout.
 *                      Left stick  -> yaw + ascend/descend
 *                      Right stick -> roll + pitch
 *  - `gameController`: twin-stick FPS layout.
 *                      Left stick  -> pitch (fwd/back) + roll (strafe)
 *                      Right stick X -> yaw, LT/RT -> descend/ascend
 *
 * Both are configurable (deadzone, per-axis invert) and a fully custom axis
 * mapping can be supplied for exotic hardware.
 */
import { NEUTRAL_INPUT, createControlInput, type DroneControlInput } from '../simulation/DroneState';
import { clamp } from '../simulation/vec3';

export type GamepadProfile = 'droneMode2' | 'gameController' | 'custom';

export interface GamepadAxisMap {
  axis: number;
  /** Multiply the raw axis by this to get the drone-space sign. */
  sign: 1 | -1;
}

export interface GamepadMapping {
  yaw: GamepadAxisMap;
  vertical: GamepadAxisMap;
  roll: GamepadAxisMap;
  pitch: GamepadAxisMap;
  /** Analog triggers (used by the game-controller profile). */
  ascendButton: number | null;
  descendButton: number | null;
  brakeButton: number;
  resetButton: number;
  cameraButton: number;
  pauseButton: number;
}

export interface GamepadConfig {
  profile: GamepadProfile;
  deadzone: number;
  invertPitch: boolean;
  invertVertical: boolean;
  invertYaw: boolean;
  invertRoll: boolean;
  /** Overrides applied when `profile === 'custom'`. */
  customMapping?: Partial<GamepadMapping>;
}

export interface GamepadStatus {
  connected: boolean;
  id: string | null;
  index: number | null;
  mapping: string | null;
  axes: number;
  buttons: number;
  profile: GamepadProfile;
  deadzone: number;
  /** Live normalized stick values, handy for the HUD. */
  raw: { leftX: number; leftY: number; rightX: number; rightY: number };
}

export interface GamepadCallbacks {
  onReset?: () => void;
  onCameraCycle?: () => void;
  onTogglePause?: () => void;
  onConnectionChange?: (connected: boolean, id: string | null) => void;
}

export const DEFAULT_GAMEPAD_CONFIG: GamepadConfig = {
  profile: 'droneMode2',
  deadzone: 0.08,
  invertPitch: false,
  invertVertical: false,
  invertYaw: false,
  invertRoll: false,
};

const MAPPINGS: Record<Exclude<GamepadProfile, 'custom'>, GamepadMapping> = {
  // Spec §8 default: Left X -> yaw, Left Y -> vertical, Right X -> roll, Right Y -> pitch.
  droneMode2: {
    yaw: { axis: 0, sign: -1 }, // stick right = yaw right (yaw is +left)
    vertical: { axis: 1, sign: -1 }, // stick up = ascend
    roll: { axis: 2, sign: 1 }, // stick right = roll right
    pitch: { axis: 3, sign: -1 }, // stick up = pitch forward
    ascendButton: null,
    descendButton: null,
    brakeButton: 0, // A / Cross
    resetButton: 1, // B / Circle
    cameraButton: 3, // Y / Triangle
    pauseButton: 9, // Start / Options
  },
  // Spec §9 alternative.
  gameController: {
    pitch: { axis: 1, sign: -1 }, // left stick up = forward
    roll: { axis: 0, sign: 1 }, // left stick right = strafe right
    yaw: { axis: 2, sign: -1 }, // right stick X
    vertical: { axis: 3, sign: -1 }, // right stick Y fallback if no triggers
    ascendButton: 7, // RT
    descendButton: 6, // LT
    brakeButton: 0,
    resetButton: 1,
    cameraButton: 3,
    pauseButton: 9,
  },
};

export class GamepadInput {
  config: GamepadConfig;
  private callbacks: GamepadCallbacks = {};
  private attached = false;
  private padIndex: number | null = null;
  private lastButtons: boolean[] = [];
  private connectedId: string | null = null;
  private lastRaw = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };

  constructor(config: Partial<GamepadConfig> = {}, callbacks: GamepadCallbacks = {}) {
    this.config = { ...DEFAULT_GAMEPAD_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  setConfig(overrides: Partial<GamepadConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  setCallbacks(callbacks: GamepadCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  get mapping(): GamepadMapping {
    if (this.config.profile === 'custom') {
      return { ...MAPPINGS.droneMode2, ...this.config.customMapping };
    }
    return MAPPINGS[this.config.profile];
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', this.handleConnected);
    window.addEventListener('gamepaddisconnected', this.handleDisconnected);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached || typeof window === 'undefined') return;
    window.removeEventListener('gamepadconnected', this.handleConnected);
    window.removeEventListener('gamepaddisconnected', this.handleDisconnected);
    this.attached = false;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get connected(): boolean {
    return this.getActivePad() !== null;
  }

  /** The live Gamepad object, or null when nothing is connected. */
  getActivePad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (!pads) return null;

    if (this.padIndex !== null) {
      const pad = pads[this.padIndex];
      if (pad && pad.connected) return pad;
      this.padIndex = null;
    }

    for (const pad of pads) {
      if (pad && pad.connected) {
        this.padIndex = pad.index;
        return pad;
      }
    }
    return null;
  }

  /**
   * Sample the pad once per rendered frame. Detects connection changes and
   * button edges (reset / camera / pause).
   */
  poll(): GamepadStatus {
    const pad = this.getActivePad();

    if (!pad) {
      if (this.connectedId !== null) {
        this.connectedId = null;
        this.lastButtons = [];
        this.callbacks.onConnectionChange?.(false, null);
      }
      return this.status();
    }

    if (this.connectedId !== pad.id) {
      this.connectedId = pad.id;
      this.lastButtons = pad.buttons.map((button) => button.pressed);
      this.callbacks.onConnectionChange?.(true, pad.id);
    } else {
      const mapping = this.mapping;
      this.fireEdge(pad, mapping.resetButton, this.lastButtons, () => this.callbacks.onReset?.());
      this.fireEdge(pad, mapping.cameraButton, this.lastButtons, () => this.callbacks.onCameraCycle?.());
      this.fireEdge(pad, mapping.pauseButton, this.lastButtons, () => this.callbacks.onTogglePause?.());
      this.lastButtons = pad.buttons.map((button) => button.pressed);
    }

    return this.status();
  }

  getStatus(): GamepadStatus {
    return this.status();
  }

  getInput(): DroneControlInput {
    const pad = this.getActivePad();
    if (!pad) return { ...NEUTRAL_INPUT };

    const mapping = this.mapping;
    const cfg = this.config;

    const raw = (index: number): number => {
      const value = pad.axes[index];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    this.lastRaw = {
      leftX: raw(0),
      leftY: raw(1),
      rightX: raw(2),
      rightY: raw(3),
    };

    let yaw = this.deadzone(raw(mapping.yaw.axis) * mapping.yaw.sign, cfg.deadzone);
    if (cfg.invertYaw) yaw = -yaw;

    let pitch = this.deadzone(raw(mapping.pitch.axis) * mapping.pitch.sign, cfg.deadzone);
    if (cfg.invertPitch) pitch = -pitch;

    let roll = this.deadzone(raw(mapping.roll.axis) * mapping.roll.sign, cfg.deadzone);
    if (cfg.invertRoll) roll = -roll;

    let vertical: number;
    if (mapping.ascendButton !== null && mapping.descendButton !== null) {
      const ascend = this.buttonValue(pad, mapping.ascendButton);
      const descend = this.buttonValue(pad, mapping.descendButton);
      vertical = clamp(ascend - descend, -1, 1);
      // Fall back to the vertical stick when no trigger is pulled.
      if (vertical === 0) {
        vertical = this.deadzone(raw(mapping.vertical.axis) * mapping.vertical.sign, cfg.deadzone);
      }
    } else {
      vertical = this.deadzone(raw(mapping.vertical.axis) * mapping.vertical.sign, cfg.deadzone);
    }
    if (cfg.invertVertical) vertical = -vertical;

    const brake = Boolean(pad.buttons[mapping.brakeButton]?.pressed);

    return createControlInput({
      pitch: clamp(pitch, -1, 1),
      roll: clamp(roll, -1, 1),
      yaw: clamp(yaw, -1, 1),
      vertical: clamp(vertical, -1, 1),
      brake,
    });
  }

  status(): GamepadStatus {
    const pad = this.getActivePad();
    return {
      connected: pad !== null,
      id: pad?.id ?? null,
      index: pad?.index ?? null,
      mapping: pad?.mapping ?? null,
      axes: pad?.axes.length ?? 0,
      buttons: pad?.buttons.length ?? 0,
      profile: this.config.profile,
      deadzone: this.config.deadzone,
      raw: { ...this.lastRaw },
    };
  }

  /** Radial deadzone with a smooth ramp so there is no control jump. */
  private deadzone(value: number, deadzone: number): number {
    const magnitude = Math.abs(value);
    if (magnitude <= deadzone) return 0;
    const scaled = (magnitude - deadzone) / (1 - deadzone);
    return clamp(Math.sign(value) * scaled, -1, 1);
  }

  private buttonValue(pad: Gamepad, index: number): number {
    const button = pad.buttons[index];
    if (!button) return 0;
    if (button.pressed) return 1;
    return button.value > this.config.deadzone ? button.value : 0;
  }

  private fireEdge(pad: Gamepad, index: number, previous: boolean[], action: () => void): void {
    const pressed = Boolean(pad.buttons[index]?.pressed);
    const was = Boolean(previous[index]);
    if (pressed && !was) action();
  }

  private readonly handleConnected = (event: Event): void => {
    const gamepadEvent = event as GamepadEvent;
    this.padIndex = gamepadEvent.gamepad.index;
    this.connectedId = gamepadEvent.gamepad.id;
    this.callbacks.onConnectionChange?.(true, gamepadEvent.gamepad.id);
  };

  private readonly handleDisconnected = (event: Event): void => {
    const gamepadEvent = event as GamepadEvent;
    if (this.padIndex === gamepadEvent.gamepad.index) {
      this.padIndex = null;
      this.connectedId = null;
      this.lastButtons = [];
      this.callbacks.onConnectionChange?.(false, null);
    }
  };
}
