/**
 * AIControlPanel (Spec §3, §4, §30–§33, §41, §45, §46).
 *
 * DOM overlay with two tabs — SIMULATOR / AI CONTROL. The Three.js world keeps
 * rendering no matter which tab is open (the panel is just an overlay; the
 * canvas frame loop is untouched).
 *
 * The API key lives ONLY in a local variable of this class (Spec §5): never
 * written to localStorage / sessionStorage / cookies / URL, and dropped on
 * reload by construction.
 */
import type { AgentController } from './AgentController';
import type { DroneObservation } from './AgentProtocol';

export interface AIControlPanelOptions {
  controller: AgentController;
  /** `window.__DRONE_SIM__` — used read-only for live telemetry display. */
  sim: {
    getGoal(): { x: number; y: number; z: number } | null;
    getControlMode(): 'manual' | 'automation';
  };
}

const DEFAULT_MODEL = 'typesafe/jev-1.13';
const MODEL_SUGGESTIONS = ['typesafe/jev-1.13', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.1-8b-instruct'];

const STYLE_ID = 'agent-panel-styles';

const CSS = `
.agent-bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 6px; z-index: 40; pointer-events: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.agent-bar__tab { padding: 6px 14px; font-size: 11px; letter-spacing: 0.12em;
  color: #9fb6cc; background: rgba(8,16,26,0.72); border: 1px solid rgba(120,180,240,0.25);
  border-radius: 6px; cursor: pointer; user-select: none; }
.agent-bar__tab[data-active="true"] { color: #06121f; background: #7fd4ff; border-color: #7fd4ff; }
.agent-panel { position: fixed; top: 52px; right: 12px; bottom: 12px; width: 352px;
  overflow-y: auto; z-index: 30; pointer-events: auto; display: none;
  background: rgba(8,16,26,0.82); border: 1px solid rgba(120,180,240,0.3);
  border-radius: 8px; padding: 12px; color: #e8f3ff; backdrop-filter: blur(4px);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.5; }
.agent-panel[data-visible="true"] { display: block; }
.agent-panel h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.14em; color: #7fd4ff; text-transform: uppercase; }
.agent-panel label { display: block; margin: 8px 0 3px; color: #9fb6cc; font-size: 11px; letter-spacing: 0.06em; }
.agent-panel input[type="password"], .agent-panel input[type="text"], .agent-panel textarea, .agent-panel select {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 5px;
  border: 1px solid rgba(120,180,240,0.35); background: rgba(4,10,18,0.85); color: #e8f3ff;
  font-family: inherit; font-size: 12px; }
.agent-panel textarea { resize: vertical; min-height: 56px; }
.agent-panel button { cursor: pointer; border-radius: 5px; border: 1px solid rgba(120,180,240,0.35);
  background: rgba(20,34,52,0.9); color: #e8f3ff; padding: 6px 12px; font-family: inherit; font-size: 11px; letter-spacing: 0.08em; }
.agent-panel button[data-variant="primary"] { background: #4fc3ff; color: #06121f; border-color: #4fc3ff; font-weight: 700; }
.agent-panel button[data-variant="danger"] { background: #ff6b6b; color: #1a0505; border-color: #ff6b6b; font-weight: 700; }
.agent-panel button:disabled { opacity: 0.4; cursor: default; }
.agent-panel__row { display: flex; gap: 8px; margin-top: 8px; }
.agent-panel__section { margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(120,180,240,0.2); }
.agent-panel__title { color: #7fd4ff; letter-spacing: 0.12em; font-size: 10px; text-transform: uppercase; margin-bottom: 4px; }
.agent-panel__rowline { display: flex; justify-content: space-between; gap: 10px; }
.agent-panel__key { color: #9fb6cc; }
.agent-panel__val { color: #fff; white-space: nowrap; }
.agent-panel__val--good { color: #6bf0a4; }
.agent-panel__val--warn { color: #ffc857; }
.agent-panel__val--bad { color: #ff6b6b; }
.agent-panel__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #6b7a8c; vertical-align: middle; }
.agent-panel__dot--run { background: #6bf0a4; }
.agent-panel__dot--warn { background: #ffc857; }
.agent-panel__dot--bad { background: #ff6b6b; }
.agent-panel pre { margin: 4px 0 0; padding: 6px; background: rgba(2,6,12,0.9); border-radius: 5px;
  font-size: 10px; max-height: 180px; overflow: auto; white-space: pre-wrap; color: #a8ffd0; }
.agent-panel__error { color: #ff8f8f; margin-top: 6px; white-space: pre-wrap; }
.agent-panel__checkboxline { display: flex; align-items: center; gap: 6px; color: #9fb6cc; margin-top: 4px; }
`;

function dotClass(status: string): string {
  if (status === 'running' || status === 'completed') return 'agent-panel__dot--good';
  if (status === 'starting' || status === 'stopping') return 'agent-panel__dot--warn';
  if (status === 'failed') return 'agent-panel__dot--bad';
  return '';
}

function signed(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
}

export class AIControlPanel {
  private readonly controller: AgentController;
  private readonly sim: AIControlPanelOptions['sim'];
  private apiKey: string | null = null; // runtime memory only (Spec §5)

  private readonly panel: HTMLDivElement;
  private readonly keyInput: HTMLInputElement;
  private readonly modelInput: HTMLInputElement;
  private readonly commandInput: HTMLTextAreaElement;
  private readonly runButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly statusPill: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly debugBox: HTMLElement;
  private readonly debugToggles: HTMLInputElement[] = [];
  private readonly rawPre: HTMLPreElement;
  private rawResponse: string | null = null;

  private readonly nodes = new Map<string, HTMLElement>();
  private detachStore: () => void;
  private timer: number | undefined;

  constructor(options: AIControlPanelOptions) {
    this.controller = options.controller;
    this.sim = options.sim;
    this.rawResponse = null;

    injectStyles();

    // ---- Tab bar -----------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'agent-bar';
    const simTab = tabButton('SIMULATOR');
    const aiTab = tabButton('AI CONTROL');
    bar.append(simTab, aiTab);
    document.body.appendChild(bar);

    simTab.addEventListener('click', () => {
      this.setActiveTab('simulator');
      // Manual takeover (Spec §36): leaving the AI tab hands control back.
      if (this.controller.isRunning) void this.controller.stopAndReturnControl();
    });
    aiTab.addEventListener('click', () => this.setActiveTab('ai'));

    // ---- Panel -------------------------------------------------------------
    this.panel = document.createElement('div');
    this.panel.className = 'agent-panel';
    this.panel.dataset.visible = 'false';
    document.body.appendChild(this.panel);

    this.panel.innerHTML = `
      <h2>AI Control</h2>
      <label>Provider</label>
      <select data-role="provider-select"><option value="openrouter">OpenRouter</option><option value="reflex">Local reflex (no API key)</option></select>
      <label>API Key <span data-role="keystate" style="color:#9fb6cc"></span></label>
      <div style="display:flex;gap:6px">
        <input data-role="key" type="password" placeholder="sk-or-v1-..." autocomplete="off" spellcheck="false" />
        <button data-role="keyshow" title="Show / hide">eye</button>
        <button data-role="keyclear" title="Clear key (memory only)">x</button>
      </div>
      <label>Model</label>
      <input data-role="model" type="text" list="agent-models" value="${DEFAULT_MODEL}" spellcheck="false" />
      <datalist id="agent-models">${MODEL_SUGGESTIONS.map((m) => `<option value="${m}"></option>`).join('')}</datalist>
      <label>Command</label>
      <textarea data-role="command" placeholder="e.g. fly to x=400 y=50 z=-250, avoid buildings"></textarea>
      <div class="agent-panel__row">
        <button data-role="run" data-variant="primary" style="flex:1">RUN</button>
        <button data-role="stop" data-variant="danger" style="flex:1" disabled>STOP</button>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">Status</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Agent</span><span class="agent-panel__val"><span data-role="dot" class="agent-panel__dot"></span><span data-role="status">IDLE</span></span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Step</span><span class="agent-panel__val" data-role="step">0</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Control mode</span><span class="agent-panel__val" data-role="mode">manual</span></div>
        <div data-role="error" class="agent-panel__error"></div>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">Position</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">X</span><span class="agent-panel__val" data-role="px">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Y</span><span class="agent-panel__val" data-role="py">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Z</span><span class="agent-panel__val" data-role="pz">-</span></div>
        <div class="agent-panel__title" style="margin-top:8px">Goal</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">X / Y / Z</span><span class="agent-panel__val" data-role="goal">none</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Goal distance</span><span class="agent-panel__val" data-role="gdist">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Altitude</span><span class="agent-panel__val" data-role="alt">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Speed</span><span class="agent-panel__val" data-role="speed">-</span></div>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">Last action</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Pitch</span><span class="agent-panel__val" data-role="pitch">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Roll</span><span class="agent-panel__val" data-role="roll">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Yaw</span><span class="agent-panel__val" data-role="yaw">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Vertical</span><span class="agent-panel__val" data-role="vertical">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Brake</span><span class="agent-panel__val" data-role="brake">-</span></div>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">Sensors</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Front</span><span class="agent-panel__val" data-role="s-front">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Back</span><span class="agent-panel__val" data-role="s-back">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Left</span><span class="agent-panel__val" data-role="s-left">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Right</span><span class="agent-panel__val" data-role="s-right">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Down</span><span class="agent-panel__val" data-role="s-down">-</span></div>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">AI status</div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Provider</span><span class="agent-panel__val" data-role="provider">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Model</span><span class="agent-panel__val" data-role="amodel">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Session</span><span class="agent-panel__val" data-role="session">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Requests</span><span class="agent-panel__val" data-role="requests">0</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Last latency</span><span class="agent-panel__val" data-role="latency">-</span></div>
        <div class="agent-panel__rowline"><span class="agent-panel__key">Last update</span><span class="agent-panel__val" data-role="lastupdate">-</span></div>
      </div>
      <div class="agent-panel__section">
        <div class="agent-panel__title">Debug</div>
        <label class="agent-panel__checkboxline"><input type="checkbox" data-debug="observation"/> Show raw observation</label>
        <label class="agent-panel__checkboxline"><input type="checkbox" data-debug="response"/> Show raw AI response</label>
        <label class="agent-panel__checkboxline"><input type="checkbox" data-debug="action"/> Show action</label>
        <pre data-role="raw" style="display:none"></pre>
      </div>
    `;

    const query = <T extends HTMLElement>(role: string): T => this.panel.querySelector(`[data-role="${role}"]`) as T;
    this.keyInput = query<HTMLInputElement>('key');
    this.modelInput = query<HTMLInputElement>('model');
    this.commandInput = query<HTMLTextAreaElement>('command');
    this.runButton = query<HTMLButtonElement>('run');
    this.stopButton = query<HTMLButtonElement>('stop');
    this.statusPill = query<HTMLElement>('status');
    this.errorBox = query<HTMLElement>('error');
    this.rawPre = query<HTMLPreElement>('raw');

    // Cache display nodes.
    for (const node of Array.from(this.panel.querySelectorAll<HTMLElement>('[data-role]'))) {
      this.nodes.set(node.dataset.role ?? '', node);
    }

    this.controller.setRawResponseListener((response: unknown) => {
      try {
        this.rawResponse = JSON.stringify(response, null, 2);
      } catch {
        this.rawResponse = String(response);
      }
      this.renderDebug();
    });

    // ---- API key memory handling (Spec §5, §46) -----------------------------
    this.keyInput.addEventListener('input', () => {
      this.apiKey = this.keyInput.value.trim() === '' ? null : this.keyInput.value;
      const state = this.nodes.get('keystate');
      if (state) {
        state.textContent = this.apiKey ? '(in memory only)' : '';
      }
    });
    query<HTMLButtonElement>('keyshow').addEventListener('click', () => {
      this.keyInput.type = this.keyInput.type === 'password' ? 'text' : 'password';
    });
    query<HTMLButtonElement>('keyclear').addEventListener('click', () => {
      this.apiKey = null;
      this.keyInput.value = '';
      const state = this.nodes.get('keystate');
      if (state) state.textContent = '(cleared)';
    });

    // ---- Run / stop (Spec §34, §35) -----------------------------------------
    query<HTMLSelectElement>('provider-select').addEventListener('change', () => {
      const provider = query<HTMLSelectElement>('provider').value;
      this.runButton.disabled = false;
      this.runButton.dataset.needsKey = provider === 'openrouter' ? 'true' : 'false';
    });
    this.runButton.dataset.needsKey = 'true';

    this.runButton.addEventListener('click', () => {
      const provider = query<HTMLSelectElement>('provider-select').value as 'openrouter' | 'reflex';
      if (provider === 'openrouter' && !this.apiKey) {
        this.showError('Add your OpenRouter API key first.');
        return;
      }
      const command = this.commandInput.value;
      if (command.trim() === '') {
        this.showError('Type a command first.');
        return;
      }
      this.showError('');
      void this.controller
        .start({
          command,
          apiKey: this.apiKey,
          model: this.modelInput.value.trim() || DEFAULT_MODEL,
          provider,
        })
        .catch((error: unknown) => this.showError(String(error)));
    });

    this.stopButton.addEventListener('click', () => {
      void this.controller.stop().catch((error: unknown) => this.showError(String(error)));
    });

    // ---- Debug toggles (Spec §45) -------------------------------------------
    for (const checkbox of Array.from(this.panel.querySelectorAll<HTMLInputElement>('input[data-debug]'))) {
      this.debugToggles.push(checkbox);
      checkbox.addEventListener('change', () => this.renderDebug());
    }
    this.debugBox = this.rawPre;

    // ---- Store subscription + telemetry timer --------------------------------
    this.detachStore = this.controller.store.subscribe(() => this.renderAgentState());
    this.renderAgentState();
    this.timer = window.setInterval(() => this.renderTelemetry(), 200);
  }

  dispose(): void {
    this.detachStore();
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.panel.remove();
  }

  private setActiveTab(tab: 'simulator' | 'ai'): void {
    this.panel.dataset.visible = tab === 'ai' ? 'true' : 'false';
    const bar = document.querySelector('.agent-bar');
    if (bar) {
      const tabs = bar.querySelectorAll<HTMLElement>('.agent-bar__tab');
      tabs[0].dataset.active = tab === 'simulator' ? 'true' : 'false';
      tabs[1].dataset.active = tab === 'ai' ? 'true' : 'false';
    }
  }

  private showError(message: string): void {
    this.errorBox.textContent = message;
  }

  private renderAgentState(): void {
    const runtime = this.controller.getRuntime();
    const activity = this.controller.getActivity();

    this.statusPill.textContent = runtime.status.toUpperCase();
    const dot = this.nodes.get('dot');
    if (dot) dot.className = `agent-panel__dot ${dotClass(runtime.status)}`;

    this.set('step', String(runtime.step));
    this.set('gdist', runtime.goalDistance === null ? '-' : `${runtime.goalDistance.toFixed(1)} m`);
    this.set('requests', String(activity.requests));
    this.set('latency', activity.lastLatencyMs === null ? '-' : `${Math.round(activity.lastLatencyMs)} ms`);
    this.set('session', activity.sessionId ?? '-');
    this.set('provider', activity.provider);
    this.set('amodel', activity.model || '-');
    this.errorBox.textContent = runtime.error ?? '';

    const busy = runtime.status === 'running' || runtime.status === 'starting' || runtime.status === 'stopping';
    this.runButton.disabled = busy;
    this.stopButton.disabled = !busy;

    if (runtime.lastAction) {
      const action = runtime.lastAction;
      this.set('pitch', signed(action.pitch));
      this.set('roll', signed(action.roll));
      this.set('yaw', signed(action.yaw));
      this.set('vertical', signed(action.vertical));
      this.set('brake', String(action.brake));
    }

    this.renderDebug(runtime.lastObservation);
  }

  private renderTelemetry(): void {
    const runtime = this.controller.getRuntime();
    const obs = runtime.lastObservation;
    if (obs) {
      this.set('px', obs.position[0].toFixed(1));
      this.set('py', obs.position[1].toFixed(1));
      this.set('pz', obs.position[2].toFixed(1));
      this.set('alt', `${obs.altitude.toFixed(1)} m`);
      this.set('speed', `${obs.speed.toFixed(1)} m/s`);
      this.sensor('front', obs.sensors.front);
      this.sensor('back', obs.sensors.back);
      this.sensor('left', obs.sensors.left);
      this.sensor('right', obs.sensors.right);
      this.sensor('down', obs.sensors.down);
    }
    const goal = this.sim.getGoal();
    this.set('goal', goal ? `${goal.x.toFixed(0)} / ${goal.y.toFixed(0)} / ${goal.z.toFixed(0)}` : 'none');
    this.set('mode', this.sim.getControlMode());
    const activity = this.controller.getActivity();
    this.set(
      'lastupdate',
      activity.lastUpdateAt === null ? '-' : `${Math.max(0, Math.round(performance.now() - activity.lastUpdateAt))} ms ago`,
    );
  }

  private sensor(role: string, value: number | null): void {
    this.set(`s-${role}`, value === null ? 'INF' : `${value.toFixed(1)} m`);
  }

  private set(role: string, text: string): void {
    const node = this.nodes.get(role);
    if (node) node.textContent = text;
  }

  /** Spec §45: raw observation / response / action views. */
  private renderDebug(observation: DroneObservation | null = null): void {
    const showObservation = this.debugToggles[0]?.checked ?? false;
    const showResponse = this.debugToggles[1]?.checked ?? false;
    const showAction = this.debugToggles[2]?.checked ?? false;
    const lines: string[] = [];
    if (showObservation && observation) lines.push(`observation = ${JSON.stringify(observation, null, 2)}`);
    if (showResponse && this.rawResponse) lines.push(`raw response = ${this.rawResponse}`);
    if (showAction && this.controller.getRuntime().lastAction) {
      lines.push(`action = ${JSON.stringify(this.controller.getRuntime().lastAction, null, 2)}`);
    }
    this.debugBox.style.display = lines.length === 0 ? 'none' : 'block';
    this.debugBox.textContent = lines.join('\n\n');
  }
}

function tabButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-bar__tab';
  button.textContent = label;
  button.dataset.active = 'false';
  return button;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
