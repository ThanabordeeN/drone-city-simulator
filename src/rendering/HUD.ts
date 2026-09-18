/**
 * HUD (Spec §16, §31).
 *
 * Plain DOM overlay — no canvas text, no extra draw calls. Shows the flight
 * readout, live input values (for gamepad debugging), controller status and a
 * collapsible debug panel.
 */
import type { DroneControlInput, DroneState } from '../simulation/DroneState';
import type { CompactSensors, SimulationMetrics, WorldInfo } from '../simulation/DroneSimulation';
import type { InputManagerSnapshot } from '../input/InputManager';
import type { CameraMode } from './CameraController';
import { KEYBOARD_HELP } from '../input/KeyboardInput';

export interface HUDData {
  state: DroneState;
  input: DroneControlInput;
  metrics: SimulationMetrics;
  inputSnapshot: InputManagerSnapshot;
  cameraMode: CameraMode;
  worldInfo: WorldInfo;
  paused: boolean;
  sensors?: CompactSensors;
}

function fmtDistance(value: number | null | undefined): string {
  if (value === null || value === undefined) return '∞';
  return `${value.toFixed(1)} m`;
}

const STYLE_ID = 'drone-sim-hud-styles';

const CSS = `
.dshud { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.45; color: #e8f3ff;
  text-shadow: 0 1px 2px rgba(0,0,0,0.75); }
.dshud__panel { position: absolute; background: rgba(8,16,26,0.62);
  border: 1px solid rgba(120,180,240,0.25); border-radius: 6px;
  padding: 8px 10px; backdrop-filter: blur(3px); min-width: 168px; }
.dshud__panel--readout { top: 12px; left: 12px; }
.dshud__panel--input { top: 12px; left: 200px; }
.dshud__panel--pad { top: 12px; right: 12px; }
.dshud__panel--debug { bottom: 12px; right: 12px; max-height: 55vh; overflow: auto;
  pointer-events: auto; }
.dshud__panel--help { bottom: 12px; left: 12px; }
.dshud__panel--banner { top: 50%; left: 50%; transform: translate(-50%,-50%);
  text-align: center; font-size: 16px; letter-spacing: 0.08em; }
.dshud__title { color: #7fd4ff; letter-spacing: 0.12em; font-size: 10px;
  text-transform: uppercase; margin-bottom: 4px; }
.dshud__row { display: flex; justify-content: space-between; gap: 14px; }
.dshud__key { color: #9fb6cc; }
.dshud__val { color: #ffffff; }
.dshud__val--warn { color: #ffc857; }
.dshud__val--bad { color: #ff6b6b; }
.dshud__val--good { color: #6bf0a4; }
.dshud__sep { height: 1px; background: rgba(120,180,240,0.2); margin: 6px 0; }
.dshud__bar { position: relative; height: 5px; background: rgba(255,255,255,0.12);
  border-radius: 3px; overflow: hidden; }
.dshud__bar > i { position: absolute; top: 0; bottom: 0; left: 50%; width: 0;
  background: #4fc3ff; }
.dshud__toggle { pointer-events: auto; cursor: pointer; color: #7fd4ff;
  user-select: none; letter-spacing: 0.12em; font-size: 10px; text-transform: uppercase; }
.dshud__hidden { display: none; }
.dshud__hint { color: #9fb6cc; font-size: 11px; }
`;

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function signed(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
}

export class HUD {
  private readonly root: HTMLDivElement;
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly debugBody: HTMLDivElement;
  private readonly helpPanel: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private debugVisible = false;
  private helpVisible = false;

  constructor(private readonly container: HTMLElement = document.body) {
    if (typeof document === 'undefined') {
      throw new Error('HUD requires a DOM environment');
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.root = document.createElement('div');
    this.root.className = 'dshud';

    const readout = this.panel('dshud__panel--readout', `
      <div class="dshud__title">Flight</div>
      ${this.row('ALT', 'alt')}
      ${this.row('SPD', 'spd')}
      ${this.row('FPS', 'fps')}
      ${this.row('POS', 'pos')}
      ${this.row('YAW', 'yaw')}
      ${this.row('MODE', 'mode')}
      ${this.row('TICK', 'tick')}
    `);

    const inputPanel = this.panel('dshud__panel--input', `
      <div class="dshud__title">Input</div>
      ${this.row('Pitch', 'in-pitch')}
      ${this.row('Roll', 'in-roll')}
      ${this.row('Yaw', 'in-yaw')}
      ${this.row('Vertical', 'in-vertical')}
      ${this.row('Brake', 'in-brake')}
    `);

    const padPanel = this.panel('dshud__panel--pad', `
      <div class="dshud__title">Controller</div>
      ${this.row('Connected', 'pad-connected')}
      ${this.row('Device', 'pad-device')}
      ${this.row('Axes', 'pad-axes')}
      ${this.row('Buttons', 'pad-buttons')}
      ${this.row('Profile', 'pad-profile')}
      ${this.row('Source', 'input-source')}
    `);

    // Debug panel is collapsible and interactive.
    const debugPanel = this.panel('dshud__panel--debug', `
      <div class="dshud__toggle" data-role="debug-toggle">Debug panel (B)</div>
      <div class="dshud__dbg dshud__hidden" data-role="debug-body">
        <div class="dshud__sep"></div>
        <div class="dshud__title">Simulation</div>
        ${this.row('Tick', 'dbg-tick')}
        ${this.row('Fixed DT', 'dbg-dt')}
        ${this.row('Paused', 'dbg-paused')}
        ${this.row('Sim rate', 'dbg-rate')}
        <div class="dshud__sep"></div>
        <div class="dshud__title">Render</div>
        ${this.row('FPS', 'dbg-fps')}
        ${this.row('Frame', 'dbg-frame')}
        ${this.row('Draw calls', 'dbg-calls')}
        ${this.row('Triangles', 'dbg-tris')}
        <div class="dshud__sep"></div>
        <div class="dshud__title">Drone</div>
        ${this.row('Altitude', 'dbg-alt')}
        ${this.row('Speed', 'dbg-spd')}
        ${this.row('Grounded', 'dbg-grounded')}
        ${this.row('Collided', 'dbg-collided')}
        ${this.row('Crashed', 'dbg-crashed')}
        <div class="dshud__sep"></div>
        <div class="dshud__title">World</div>
        ${this.row('Seed', 'dbg-seed')}
        ${this.row('Buildings', 'dbg-buildings')}
        ${this.row('Nearby', 'dbg-nearby')}
        ${this.row('Sensor F', 'dbg-sensor-front')}
        ${this.row('Sensor L/R', 'dbg-sensor-sides')}
        ${this.row('Sensor down', 'dbg-sensor-down')}
        <div class="dshud__sep"></div>
        <div class="dshud__title">Input</div>
        ${this.row('Keyboard', 'dbg-keyboard')}
        ${this.row('Gamepad', 'dbg-gamepad')}
        ${this.row('Automation', 'dbg-automation')}
        ${this.row('Control mode', 'dbg-controlmode')}
      </div>
    `);

    this.debugBody = debugPanel.querySelector('[data-role="debug-body"]') as HTMLDivElement;
    const debugToggle = debugPanel.querySelector('[data-role="debug-toggle"]') as HTMLElement;
    debugToggle.addEventListener('click', () => this.toggleDebug());

    this.helpPanel = this.panel('dshud__panel--help', `
      <div class="dshud__toggle" data-role="help-toggle">Controls (H)</div>
      <div class="dshud__hidden" data-role="help-body">
        ${KEYBOARD_HELP.map(
          (entry) =>
            `<div class="dshud__row"><span class="dshud__val">${entry.keys}</span><span class="dshud__key">${entry.action}</span></div>`,
        ).join('')}
      </div>
    `);
    const helpToggle = this.helpPanel.querySelector('[data-role="help-toggle"]') as HTMLElement;
    helpToggle.addEventListener('click', () => this.toggleHelp());

    this.banner = this.panel('dshud__panel--banner', `
      <div class="dshud__title">Paused</div>
      <div class="dshud__hint">Press P to resume · step via <code>__DRONE_SIM__.step()</code></div>
    `);
    this.banner.classList.add('dshud__hidden');

    void readout;
    void inputPanel;
    void padPanel;

    this.root.append(readout, inputPanel, padPanel, debugPanel, this.helpPanel, this.banner);
    this.container.appendChild(this.root);
  }

  private panel(className: string, html: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = `dshud__panel ${className}`;
    element.innerHTML = html;
    return element;
  }

  private row(key: string, id: string): string {
    return `<div class="dshud__row"><span class="dshud__key">${key}</span><span class="dshud__val" data-field="${id}">–</span></div>`;
  }

  private field(id: string): HTMLElement {
    let node = this.nodes.get(id);
    if (!node) {
      node = this.root.querySelector(`[data-field="${id}"]`) as HTMLElement;
      if (node) this.nodes.set(id, node);
    }
    return node;
  }

  private set(id: string, value: string, modifier?: 'warn' | 'bad' | 'good'): void {
    const node = this.field(id);
    if (!node) return;
    if (node.textContent !== value) node.textContent = value;
    const className = modifier ? `dshud__val dshud__val--${modifier}` : 'dshud__val';
    if (node.className !== className) node.className = className;
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debugBody.classList.toggle('dshud__hidden', !this.debugVisible);
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    const body = this.helpPanel.querySelector('[data-role="help-body"]') as HTMLElement;
    body.classList.toggle('dshud__hidden', !this.helpVisible);
    void body;
  }

  showHelp(visible: boolean): void {
    if (visible !== this.helpVisible) this.toggleHelp();
  }

  showDebug(visible: boolean): void {
    if (visible !== this.debugVisible) this.toggleDebug();
  }

  update(data: HUDData): void {
    const { state, input, metrics, inputSnapshot, cameraMode, worldInfo, paused } = data;

    // ---- Flight readout ---------------------------------------------------
    this.set('alt', `${fmt(state.altitude, 1)} m`);
    this.set('spd', `${fmt(state.speed, 1)} m/s`);
    this.set('fps', `${Math.round(metrics.fps)}`);
    this.set('pos', `${Math.round(state.position.x)}, ${Math.round(state.position.y)}, ${Math.round(state.position.z)}`);
    this.set('yaw', `${Math.round(((state.rotation.yaw * 180) / Math.PI + 360) % 360)}°`);
    this.set('mode', cameraMode.toUpperCase());
    this.set('tick', `${state.tick}`);

    // ---- Input values -----------------------------------------------------
    this.set('in-pitch', signed(input.pitch));
    this.set('in-roll', signed(input.roll));
    this.set('in-yaw', signed(input.yaw));
    this.set('in-vertical', signed(input.vertical));
    this.set('in-brake', input.brake ? 'ON' : 'off', input.brake ? 'warn' : undefined);

    // ---- Controller -------------------------------------------------------
    const pad = inputSnapshot.gamepad;
    this.set('pad-connected', pad.connected ? 'Yes' : 'No', pad.connected ? 'good' : undefined);
    this.set('pad-device', pad.id ? pad.id.slice(0, 26) : '–');
    this.set('pad-axes', `${pad.axes}`);
    this.set('pad-buttons', `${pad.buttons}`);
    this.set('pad-profile', pad.profile);
    this.set('input-source', inputSnapshot.source.toUpperCase());

    // ---- Debug panel ------------------------------------------------------
    this.set('dbg-tick', `${metrics.tick}`);
    this.set('dbg-dt', `${fmt(metrics.fixedDtMs, 2)} ms`);
    this.set('dbg-paused', `${paused}`, paused ? 'warn' : undefined);
    this.set('dbg-rate', `${metrics.simulationHz} Hz`);
    this.set('dbg-fps', `${Math.round(metrics.fps)}`);
    this.set('dbg-frame', `${fmt(metrics.frameTimeMs, 1)} ms`);
    this.set('dbg-calls', `${metrics.drawCalls}`);
    this.set('dbg-tris', `${metrics.triangles.toLocaleString()}`);
    this.set('dbg-alt', `${fmt(state.altitude, 1)} m`);
    this.set('dbg-spd', `${fmt(state.speed, 1)} m/s`);
    this.set('dbg-grounded', `${state.grounded}`);
    this.set('dbg-collided', `${state.collided}`, state.collided ? 'warn' : undefined);
    this.set('dbg-crashed', `${state.crashed}`, state.crashed ? 'bad' : undefined);
    this.set('dbg-seed', `${worldInfo.seed}`);
    this.set('dbg-buildings', `${worldInfo.buildingCount}`);
    this.set('dbg-nearby', `${metrics.activeBuildings}`);
    const sensors = data.sensors;
    this.set('dbg-sensor-front', fmtDistance(sensors?.front));
    this.set('dbg-sensor-sides', `${fmtDistance(sensors?.left)} / ${fmtDistance(sensors?.right)}`);
    this.set('dbg-sensor-down', fmtDistance(sensors?.down));
    this.set('dbg-keyboard', inputSnapshot.keyboardActive ? 'Active' : 'Idle');
    this.set('dbg-gamepad', pad.connected ? 'Connected' : 'Disconnected');
    this.set('dbg-automation', inputSnapshot.automationActive ? 'Active' : 'Idle');
    this.set('dbg-controlmode', inputSnapshot.controlMode);

    this.banner.classList.toggle('dshud__hidden', !paused);
  }

  dispose(): void {
    this.root.remove();
    this.nodes.clear();
  }

  get rootElement(): HTMLElement {
    return this.root;
  }
}
