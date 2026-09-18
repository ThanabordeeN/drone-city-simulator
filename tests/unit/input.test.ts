/**
 * Input layer tests (Spec §7, §8, §9, §22, §32).
 *
 * These run in plain Node by installing minimal fake `window`/`navigator`
 * globals, which keeps the input mapping logic testable without a browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationInput } from '../../src/input/AutomationInput';
import { GamepadInput, DEFAULT_GAMEPAD_CONFIG } from '../../src/input/GamepadInput';
import { InputManager } from '../../src/input/InputManager';
import { KeyboardInput } from '../../src/input/KeyboardInput';

interface FakeWindow {
  listeners: Map<string, ((event: unknown) => void)[]>;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  dispatch(type: string, event: unknown): void;
}

function installFakeWindow(): FakeWindow {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const fake: FakeWindow = {
    listeners,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((entry) => entry !== handler),
      );
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fake, configurable: true, writable: true });
  return fake;
}

function installFakeGamepad(pad: Partial<Gamepad> | null): void {
  // Node 22 defines `navigator` as a getter-only global, so patch with
  // defineProperty rather than assignment.
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => (pad ? [pad as Gamepad] : []) },
    configurable: true,
    writable: true,
  });
}

function makePad(overrides: Partial<Gamepad> = {}): Gamepad {
  return {
    id: 'Fake Controller',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
    ...overrides,
  } as unknown as Gamepad;
}

function keyEvent(code: string): { code: string; repeat: boolean; preventDefault(): void } {
  return { code, repeat: false, preventDefault() {} };
}

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalNavigator = (globalThis as unknown as { navigator?: unknown }).navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
});

describe('KeyboardInput (Spec §7)', () => {
  it('maps every documented key', () => {
    const fake = installFakeWindow();
    const keyboard = new KeyboardInput();
    keyboard.attach();

    fake.dispatch('keydown', keyEvent('KeyW'));
    expect(keyboard.getInput().pitch).toBe(1);

    fake.dispatch('keyup', keyEvent('KeyW'));
    fake.dispatch('keydown', keyEvent('KeyS'));
    expect(keyboard.getInput().pitch).toBe(-1);

    fake.dispatch('keyup', keyEvent('KeyS'));
    fake.dispatch('keydown', keyEvent('KeyA'));
    expect(keyboard.getInput().roll).toBe(-1);

    fake.dispatch('keyup', keyEvent('KeyA'));
    fake.dispatch('keydown', keyEvent('KeyD'));
    expect(keyboard.getInput().roll).toBe(1);

    fake.dispatch('keyup', keyEvent('KeyD'));
    fake.dispatch('keydown', keyEvent('KeyQ'));
    expect(keyboard.getInput().yaw).toBe(1);

    fake.dispatch('keyup', keyEvent('KeyQ'));
    fake.dispatch('keydown', keyEvent('KeyE'));
    expect(keyboard.getInput().yaw).toBe(-1);

    fake.dispatch('keyup', keyEvent('KeyE'));
    fake.dispatch('keydown', keyEvent('ShiftLeft'));
    expect(keyboard.getInput().vertical).toBe(1);

    fake.dispatch('keyup', keyEvent('ShiftLeft'));
    fake.dispatch('keydown', keyEvent('ControlLeft'));
    expect(keyboard.getInput().vertical).toBe(-1);

    fake.dispatch('keyup', keyEvent('ControlLeft'));
    fake.dispatch('keydown', keyEvent('Space'));
    expect(keyboard.getInput().brake).toBe(true);

    keyboard.detach();
  });

  it('supports simultaneous keys (W + D + Shift)', () => {
    const fake = installFakeWindow();
    const keyboard = new KeyboardInput();
    keyboard.attach();

    fake.dispatch('keydown', keyEvent('KeyW'));
    fake.dispatch('keydown', keyEvent('KeyD'));
    fake.dispatch('keydown', keyEvent('ShiftLeft'));

    expect(keyboard.getInput()).toEqual({
      pitch: 1,
      roll: 1,
      yaw: 0,
      vertical: 1,
      brake: false,
    });

    keyboard.detach();
  });

  it('fires the one-shot command keys', () => {
    const fake = installFakeWindow();
    const events: string[] = [];
    const keyboard = new KeyboardInput({
      onReset: () => events.push('reset'),
      onCameraCycle: () => events.push('camera'),
      onTogglePause: () => events.push('pause'),
    });
    keyboard.attach();

    fake.dispatch('keydown', keyEvent('KeyR'));
    fake.dispatch('keydown', keyEvent('KeyC'));
    fake.dispatch('keydown', keyEvent('KeyP'));
    expect(events).toEqual(['reset', 'camera', 'pause']);

    keyboard.detach();
  });

  it('releases all keys when the window loses focus', () => {
    const fake = installFakeWindow();
    const keyboard = new KeyboardInput();
    keyboard.attach();

    fake.dispatch('keydown', keyEvent('KeyW'));
    expect(keyboard.getInput().pitch).toBe(1);
    fake.dispatch('blur', {});
    expect(keyboard.getInput().pitch).toBe(0);

    keyboard.detach();
  });

  it('ignores auto-repeat so one press is one event', () => {
    const fake = installFakeWindow();
    let resets = 0;
    const keyboard = new KeyboardInput({ onReset: () => (resets += 1) });
    keyboard.attach();

    fake.dispatch('keydown', keyEvent('KeyR'));
    fake.dispatch('keydown', { ...keyEvent('KeyR'), repeat: true });
    expect(resets).toBe(1);

    keyboard.detach();
  });
});

describe('GamepadInput (Spec §8, §9)', () => {
  it('uses a 0.08 deadzone by default', () => {
    expect(DEFAULT_GAMEPAD_CONFIG.deadzone).toBe(0.08);
  });

  it('maps the default Drone Mode 2 layout', () => {
    const pad = makePad({ axes: [0.5, -0.5, 0.25, -0.75] });
    installFakeGamepad(pad);
    const gamepad = new GamepadInput();

    const input = gamepad.getInput();
    expect(input.yaw).toBeLessThan(0); // left X right -> yaw right
    expect(input.vertical).toBeGreaterThan(0); // left Y up -> ascend
    expect(input.roll).toBeGreaterThan(0); // right X right -> roll right
    expect(input.pitch).toBeGreaterThan(0); // right Y up -> pitch forward
  });

  it('applies the deadzone and rescales the remainder', () => {
    installFakeGamepad(makePad({ axes: [0.04, 0, 0, 0] }));
    expect(new GamepadInput().getInput().yaw).toBe(0);

    installFakeGamepad(makePad({ axes: [0.5, 0, 0, 0] }));
    // (0.5 - 0.08) / (1 - 0.08) = 0.4565..., negated for yaw-right.
    expect(new GamepadInput().getInput().yaw).toBeCloseTo(-0.45652, 4);
  });

  it('honours invertPitch and invertVertical', () => {
    installFakeGamepad(makePad({ axes: [0, -0.8, 0, -0.8] }));
    const inverted = new GamepadInput({ invertPitch: true, invertVertical: true });
    const input = inverted.getInput();
    expect(input.vertical).toBeLessThan(0);
    expect(input.pitch).toBeLessThan(0);
  });

  it('maps the alternative game-controller profile with analog triggers', () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
    buttons[7] = { pressed: true, touched: true, value: 1 }; // RT ascend
    installFakeGamepad(makePad({ axes: [-0.6, -0.4, 0.3, 0], buttons }));

    const gamepad = new GamepadInput({ profile: 'gameController' });
    const input = gamepad.getInput();
    expect(input.pitch).toBeGreaterThan(0); // left stick up = forward
    expect(input.roll).toBeLessThan(0); // left stick left = strafe left
    expect(input.yaw).toBeLessThan(0); // right stick right = yaw right
    expect(input.vertical).toBe(1); // RT
  });

  it('supports LT for descend', () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
    buttons[6] = { pressed: true, touched: true, value: 1 };
    installFakeGamepad(makePad({ axes: [0, 0, 0, 0], buttons }));

    expect(new GamepadInput({ profile: 'gameController' }).getInput().vertical).toBe(-1);
  });

  it('reports connection status for the HUD', () => {
    installFakeGamepad(makePad());
    const status = new GamepadInput().getStatus();
    expect(status.connected).toBe(true);
    expect(status.id).toBe('Fake Controller');
    expect(status.axes).toBe(4);
    expect(status.buttons).toBe(16);

    installFakeGamepad(null);
    expect(new GamepadInput().getStatus().connected).toBe(false);
  });

  it('reads a custom axis mapping', () => {
    installFakeGamepad(makePad({ axes: [0, 0, 0.9, 0] }));
    const gamepad = new GamepadInput({
      profile: 'custom',
      customMapping: { yaw: { axis: 2, sign: 1 } },
    });
    expect(gamepad.getInput().yaw).toBeGreaterThan(0.8);
  });
});

describe('AutomationInput (Spec §18, §27)', () => {
  it('merges partial actions and reports the active flag', () => {
    const input = new AutomationInput();
    expect(input.isActive()).toBe(false);

    input.set({ pitch: 1 });
    expect(input.isActive()).toBe(true);
    expect(input.getInput().pitch).toBe(1);

    input.set({ vertical: 0.5 });
    expect(input.getInput().pitch).toBe(1);
    expect(input.getInput().vertical).toBe(0.5);

    input.clear();
    expect(input.isActive()).toBe(false);
    expect(input.getInput().pitch).toBe(0);
  });

  it('clamps out-of-range values', () => {
    const input = new AutomationInput();
    input.set({ pitch: 12, roll: -9, yaw: 3, vertical: -4 });
    expect(input.getInput()).toMatchObject({ pitch: 1, roll: -1, yaw: 1, vertical: -1 });
  });
});

describe('InputManager priority (Spec §32)', () => {
  it('combines keyboard and gamepad by default', () => {
    const fake = installFakeWindow();
    installFakeGamepad(makePad({ axes: [0, -0.8, 0, 0] }));

    const keyboard = new KeyboardInput();
    const gamepad = new GamepadInput();
    const manager = new InputManager({ keyboard, gamepad, automation: new AutomationInput() });
    manager.attach();
    manager.update();

    fake.dispatch('keydown', keyEvent('KeyD'));
    const snapshot = manager.getSnapshot();
    expect(snapshot.input.roll).toBe(1);
    expect(snapshot.input.vertical).toBeGreaterThan(0);
    expect(snapshot.source).toBe('keyboard+gamepad');

    manager.detach();
  });

  it('lets automation override human axes', () => {
    const fake = installFakeWindow();
    installFakeGamepad(null);

    const automation = new AutomationInput();
    const keyboard = new KeyboardInput();
    const manager = new InputManager({ keyboard, gamepad: new GamepadInput(), automation });
    manager.attach();
    manager.update();

    fake.dispatch('keydown', keyEvent('KeyW'));
    automation.set({ pitch: -1, yaw: 1 });

    const input = manager.getInput();
    expect(input.pitch).toBe(-1); // automation wins
    expect(input.yaw).toBe(1); // keyboard has no yaw pressed
    expect(manager.getActiveSource()).toBe('automation');

    manager.detach();
  });

  it('disables human input in automation control mode', () => {
    const fake = installFakeWindow();
    installFakeGamepad(null);

    const manager = new InputManager({ automation: new AutomationInput() });
    manager.attach();
    manager.setControlMode('automation');

    fake.dispatch('keydown', keyEvent('KeyW'));
    expect(manager.getInput().pitch).toBe(0);

    manager.automation.set({ pitch: 0.25 });
    expect(manager.getInput().pitch).toBe(0.25);

    manager.setControlMode('manual');
    // Automation still overrides what the human presses...
    expect(manager.getInput().pitch).toBe(0.25);
    // ...until it releases the sticks.
    manager.automation.clear();
    expect(manager.getInput().pitch).toBe(1);

    manager.detach();
  });

  it('reports an idle source when nothing is pressed', () => {
    installFakeWindow();
    installFakeGamepad(null);
    const manager = new InputManager();
    manager.attach();
    manager.update();
    expect(manager.getSnapshot().source).toBe('none');
    manager.detach();
  });
});
