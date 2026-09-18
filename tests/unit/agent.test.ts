/**
 * AI Control Module tests (Spec §5, §13, §14, §19, §20, §22-§23, §35, §37-§40).
 *
 * DOM-free, browser-free: the parser, protocol, JEV adapter, OpenRouter
 * transport and the real-time agent loop are all exercised in plain Node,
 * exactly like the rest of the simulation core.
 */
import { describe, expect, it, vi } from 'vitest';
import { validateAction } from '../../src/agent/AgentProtocol';
import { parseCommand } from '../../src/agent/CommandParser';
import { ChatActionAdapter, DefaultJevAdapter } from '../../src/agent/JevAdapter';
import { OpenRouterClient, ProviderError, OPENROUTER_CHAT_URL, OPENROUTER_DECISIONS_URL } from '../../src/agent/OpenRouterClient';
import { AgentController } from '../../src/agent/AgentController';
import { createHarness } from './helpers';

describe('CommandParser (Spec §9, §22)', () => {
  it('parses explicit axis syntax', () => {
    const parsed = parseCommand('บินไปที่ x=400 y=50 z=-250');
    expect(parsed.kind).toBe('destination');
    expect(parsed.goal).toEqual({ x: 400, y: 50, z: -250 });
  });

  it('parses Thai coordinate triplets', () => {
    const parsed = parseCommand('บินไปที่พิกัด 200 40 -500 โดยห้ามชนตึก');
    expect(parsed.kind).toBe('destination');
    expect(parsed.goal).toEqual({ x: 200, y: 40, z: -500 });
  });

  it('parses bare triplets', () => {
    const parsed = parseCommand('fly to 400 50 -250');
    expect(parsed.kind).toBe('destination');
    expect(parsed.goal).toEqual({ x: 400, y: 50, z: -250 });
  });

  it('parses altitude-only commands', () => {
    const parsed = parseCommand('บินขึ้นไปสูง 50 เมตร');
    expect(parsed.kind).toBe('altitude');
    expect(parsed.altitudeTarget).toBe(50);
  });

  it('classifies survival and circle commands as freeform with hints', () => {
    const forward = parseCommand('บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก');
    expect(forward.kind).toBe('freeform');
    expect(forward.hints.forward).toBe(true);

    const circle = parseCommand('บินเป็นวงกลมและรักษาความสูงไว้');
    expect(circle.kind).toBe('freeform');
    expect(circle.hints.circle).toBe(true);
    expect(circle.hints.maintainAltitude).toBe(true);
  });
});

describe('validateAction (Spec §14)', () => {
  it('clamps axes into [-1, +1]', () => {
    const action = validateAction({ pitch: 5, roll: -3, yaw: 1, vertical: 0.5, brake: true });
    expect(action).toEqual({ pitch: 1, roll: -1, yaw: 1, vertical: 0.5, brake: true });
  });

  it('replaces invalid values with neutral ones', () => {
    const action = validateAction({
      pitch: Number.NaN,
      roll: Number.POSITIVE_INFINITY,
      yaw: 'garbage' as unknown as number,
      vertical: undefined,
      brake: 'yes' as unknown as boolean,
    });
    expect(action).toEqual({ pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: false });
  });

  it('rejects non-object input entirely', () => {
    expect(validateAction(null)).toEqual({ pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: false });
    expect(validateAction('crash me')).toEqual({ pitch: 0, roll: 0, yaw: 0, vertical: 0, brake: false });
  });
});

describe('DefaultJevAdapter (Spec §20 — Decisions API)', () => {
  const adapter = new DefaultJevAdapter();

  it('builds a Decisions request: state + typed questions', () => {
    const request = adapter.createRequest(
      { command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก', startedAt: 0 },
      makeObservation(),
      [{ id: 'b1', position: { x: 1, y: 2, z: 3 }, distance: 9 }],
    ) as { state: Record<string, unknown>; questions: Record<string, unknown> };

    expect(request.state.task).toBe('บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก');
    expect(request.state.nearbyBuildings).toHaveLength(1);
    // Every continuous axis uses a 5-point ordered rubric (-1 .. +1).
    const questions = request.questions as Record<string, { type: string; criteria: unknown[] }>;
    expect(questions.pitch.type).toBe('score');
    expect(questions.brake.type).toBe('noul');
    expect(questions.pitch.criteria).toHaveLength(5);
    expect(questions.strafe.criteria).toHaveLength(5);
    expect(questions.yaw.criteria).toHaveLength(5);
    expect(questions.vertical.criteria).toHaveLength(5);
  });

  it('maps score answers into stick values (0→-1, middle→0, 4→+1)', () => {
    const response = {
      answers: {
        pitch: { score: 4 },
        strafe: { score: 0 },
        yaw: { score: 2 },
        vertical: { score: 3 },
        brake: { noul: 0.1 },
      },
    };
    expect(adapter.parseResponse(response)).toEqual({
      pitch: 1, roll: -1, yaw: 0, vertical: 0.5, brake: false,
    });
  });

  it('uses the expected position of a full distribution for smoother control', () => {
    const response = {
      answers: {
        // P([0,1,2,3,4]) = [0, 0, 0.5, 0.5, 0] → expected position 2.5 → 0.25
        pitch: { score: 2, probabilities: [0, 0, 0.5, 0.5, 0] },
        strafe: { score: 2 },
        yaw: { score: 2 },
        vertical: { score: 2 },
        brake: { noul: 0.9 },
      },
    };
    const action = adapter.parseResponse(response);
    expect(action.pitch).toBeCloseTo(0.25, 5);
    expect(action.brake).toBe(true);
  });

  it('throws when answers are missing', () => {
    expect(() => adapter.parseResponse({ nothing: true })).toThrow();
  });
});

describe('ChatActionAdapter (generic chat models)', () => {
  const adapter = new ChatActionAdapter();

  it('builds a chat request from task + observation', () => {
    const request = adapter.createRequest(
      { command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก', startedAt: 0 },
      makeObservation(),
      [{ id: 'b1', position: { x: 1, y: 2, z: 3 }, distance: 9 }],
    ) as { messages: { role: string; content: string }[] };

    expect(Array.isArray(request.messages)).toBe(true);
    expect(request.messages[0].role).toBe('system');
    const userPayload = JSON.parse(request.messages[1].content) as Record<string, unknown>;
    expect(userPayload.task).toBe('บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก');
    expect(userPayload.nearbyBuildings).toHaveLength(1);
  });

  it('parses clean / fenced JSON responses and clamps out-of-range values', () => {
    const clean = { choices: [{ message: { content: '{"action":{"pitch":0.5,"roll":0,"yaw":-0.2,"vertical":0.1,"brake":false}}' } }] };
    expect(adapter.parseResponse(clean)).toEqual({ pitch: 0.5, roll: 0, yaw: -0.2, vertical: 0.1, brake: false });

    const fenced = {
      choices: [{ message: { content: 'Sure!\n```json\n{"action":{"pitch":7,"roll":0,"yaw":0,"vertical":0,"brake":false}}\n```' } }],
    };
    expect(adapter.parseResponse(fenced).pitch).toBe(1);
  });

  it('throws on responses without an action', () => {
    expect(() => adapter.parseResponse({ choices: [{ message: { content: 'no json here' } }] })).toThrow();
  });
});

describe('OpenRouterClient (Spec §19, §37, §39) — chat endpoint', () => {
  const chatAdapter = new ChatActionAdapter();

  function stubFetch(
    handler: (url: string, init: RequestInit) => Promise<Response>,
    overrides: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {},
  ): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: 'sk-test',
      model: 'openai/gpt-4o-mini',
      adapter: chatAdapter,
      fetchImpl: handler as unknown as typeof fetch,
      ...overrides,
    });
  }

  it('requires an API key', () => {
    expect(() => new OpenRouterClient({ apiKey: '  ', model: 'm', adapter: chatAdapter })).toThrow(ProviderError);
  });

  it('sends the key + model and returns a validated action', async () => {
    let capturedUrl = '';
    let captured: RequestInit | undefined;
    const client = stubFetch(async (url, init) => {
      capturedUrl = url;
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":{"pitch":2,"roll":0,"yaw":0,"vertical":0,"brake":false}}' } }] }), { status: 200 });
    });
    const action = await client.decide({ task: { command: 'go' }, state: makeObservation(), sessionId: 's1' });
    expect(action.pitch).toBe(1); // clamped
    expect(capturedUrl).toBe(OPENROUTER_CHAT_URL);
    const body = JSON.parse(String(captured?.body)) as { model: string };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect((captured?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('maps HTTP 401 to an invalid-key ProviderError', async () => {
    const client = stubFetch(async () => new Response('unauthorized', { status: 401 }));
    await expect(
      client.decide({ task: { command: 'x' }, state: makeObservation(), sessionId: 's' }),
    ).rejects.toThrow(/invalid API key/);
  });

  it('maps network failures to ProviderError', async () => {
    const client = stubFetch(async () => { throw new TypeError('network down'); });
    await expect(
      client.decide({ task: { command: 'x' }, state: makeObservation(), sessionId: 's' }),
    ).rejects.toThrow(ProviderError);
  });
});

describe('OpenRouterClient — JEV Decisions endpoint (typesafe/jev-1.13)', () => {
  const jevAdapter = new DefaultJevAdapter();

  function decisionsClient(
    handler: (url: string, init: RequestInit) => Promise<Response>,
  ): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: 'sk-test',
      model: 'typesafe/jev-1.13',
      adapter: jevAdapter,
      endpoint: 'decisions',
      fetchImpl: handler as unknown as typeof fetch,
    });
  }

  it('POSTs state + typed questions to the Decisions API and maps the answers', async () => {
    let capturedUrl = '';
    let captured: RequestInit | undefined;
    const client = decisionsClient(async (url, init) => {
      capturedUrl = url;
      captured = init;
      return new Response(JSON.stringify({
        answers: {
          pitch: { score: 4, probabilities: [0, 0, 0, 0, 1] },
          strafe: { score: 2 },
          yaw: { score: 2 },
          vertical: { score: 2 },
          brake: { noul: 0.05 },
        },
      }), { status: 200 });
    });

    const action = await client.decide({ task: { command: 'go' }, state: makeObservation(), sessionId: 's1' });
    expect(capturedUrl).toBe(OPENROUTER_DECISIONS_URL);

    const body = JSON.parse(String(captured?.body)) as { model: string; state: unknown; questions: unknown };
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toBeTruthy();
    expect((body.questions as Record<string, unknown>).pitch).toBeTruthy();

    expect(action.pitch).toBe(1);
    expect(action.brake).toBe(false);
  });

  it('rejects 4xx responses like the chat endpoint', async () => {
    const client = decisionsClient(async () => new Response('unauthorized', { status: 401 }));
    await expect(
      client.decide({ task: { command: 'x' }, state: makeObservation(), sessionId: 's' }),
    ).rejects.toThrow(/invalid API key/);
  });
});

describe('AgentController + AgentLoop with the real simulation (Spec §16-§18, §23, §34-§35, §37-§38)', () => {
  function createAgentHarness(
    options: {
      intervalMs?: number;
      actionTimeoutMs?: number;
      fetchImpl?: typeof fetch;
      autoRecover?: boolean;
    } = {},
  ) {
    const { sim, api } = createHarness({ seed: 1 });
    api.markReady(); // the browser does this on the first rendered frame
    const controller = new AgentController({
      sim: api,
      loopConfig: {
        intervalMs: options.intervalMs ?? 25,
        actionTimeoutMs: options.actionTimeoutMs ?? 400,
        maxDurationMs: 30_000,
      },
      // Never hit the real network from a unit test.
      fetchImpl: options.fetchImpl ?? (async () => { throw new TypeError('no network in unit tests'); }),
      ...(options.autoRecover !== undefined ? { autoRecover: options.autoRecover } : {}),
    });
    // Drive the fixed-timestep core exactly like the browser frame loop would.
    const driver = setInterval(() => sim.step(3), 5);
    return { sim, api, controller, stopDriving: (): void => clearInterval(driver) };
  }

  it('navigates to a destination goal, stops the agent on goalReached (Spec §22, §23, §51)', async () => {
    const harness = createAgentHarness();
    const spawn = harness.sim.getSpawnPosition();
    const safeY = harness.sim.buildings.bounds.maxHeight + 50;
    harness.sim.teleport({ x: spawn.x, y: safeY, z: spawn.z });

    const goalX = spawn.x + 25;
    const goalZ = spawn.z - 30;
    const finished = harness.controller.start({
      command: `fly to x=${goalX} y=${Math.round(safeY)} z=${goalZ}`,
      model: 'local-reflex',
      provider: 'reflex',
    });

    await finished;
    harness.stopDriving();

    const runtime = harness.controller.getRuntime();
    expect(runtime.status).toBe('completed');
    expect(runtime.goalDistance ?? 999).toBeLessThan(6);
    expect(harness.sim.goalIsReached).toBe(true);
    expect(harness.sim.getControlMode()).toBe('automation');
  }, 20_000);

  it('STOP switches to idle and clears the drone input immediately (Spec §35)', async () => {
    const harness = createAgentHarness();
    const spawn = harness.sim.getSpawnPosition();
    const safeY = harness.sim.buildings.bounds.maxHeight + 50;
    harness.sim.teleport({ x: spawn.x, y: safeY, z: spawn.z });

    const finished = harness.controller.start({
      command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก',
      model: 'local-reflex',
      provider: 'reflex',
    });

    await vi.waitFor(() => expect(harness.controller.currentStatus).toBe('running'), { timeout: 5_000 });
    await harness.controller.stop();
    await finished;
    harness.stopDriving();

    expect(harness.controller.currentStatus).toBe('idle');
    const input = harness.sim.getInput();
    expect(input.pitch).toBe(0);
    expect(input.vertical).toBe(0);
  }, 20_000);

  it('provider failure clears input and fails the session (Spec §37)', async () => {
    const harness = createAgentHarness();
    harness.sim.teleport({ x: 0, y: harness.sim.buildings.bounds.maxHeight + 50, z: 0 });

    const finished = harness.controller.start({
      command: 'บินเป็นวงกลมและรักษาความสูงไว้',
      model: 'boom',
      provider: 'openrouter',
      apiKey: 'sk-bad',
    });

    await finished;
    harness.stopDriving();

    expect(harness.controller.currentStatus).toBe('failed');
    expect(harness.controller.getRuntime().error).toBeTruthy();
    expect(harness.sim.getInput().pitch).toBe(0);
  }, 20_000);

  it('action watchdog clears held input while the provider hangs (Spec §38)', async () => {
    const harness = createAgentHarness({ actionTimeoutMs: 200 });
    harness.sim.teleport({ x: 0, y: harness.sim.buildings.bounds.maxHeight + 50, z: 0 });

    const finished = harness.controller.start({
      command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชนและห้ามตก',
      model: 'hang',
      provider: 'openrouter',
      apiKey: 'sk-hang',
    });

    await vi.waitFor(() => {
      const input = harness.sim.getInput();
      expect(input.pitch).toBe(0);
      expect(input.roll).toBe(0);
    }, { timeout: 3_000 });

    await harness.controller.stop();
    await finished;
    harness.stopDriving();
  }, 20_000);

  it('stopAndReturnControl works from idle and leaves the session idle', async () => {
    const harness = createAgentHarness();
    await harness.controller.stopAndReturnControl();
    expect(harness.controller.currentStatus).toBe('idle');
    harness.stopDriving();
  });

describe('Crash auto-recovery (Spec §37 variant: survival)', () => {
  it('resets to spawn on crash and keeps the session running when enabled', async () => {
    const harness = createAgentHarness({ autoRecover: true });
    const finished = harness.controller.start({
      command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชน',
      model: 'local-reflex',
      provider: 'reflex',
    });
    await vi.waitFor(() => expect(harness.controller.currentStatus).toBe('running'), { timeout: 5_000 });

    // Simulate a crash exactly like a building impact would.
    harness.sim.state.crashed = true;

    await vi.waitFor(() => {
      const runtime = harness.controller.getRuntime();
      expect(runtime.recoveries).toBeGreaterThanOrEqual(1);
      expect(runtime.status).toBe('running'); // recovered, not failed
    }, { timeout: 5_000 });

    // The reset dropped the drone back at the spawn point, alive again.
    expect(harness.sim.state.crashed).toBe(false);
    const spawn = harness.sim.getSpawnPosition();
    const position = harness.sim.getState().position;
    expect(Math.hypot(position.x - spawn.x, position.z - spawn.z)).toBeLessThan(2);

    await harness.controller.stop();
    await finished;
    harness.stopDriving();
  }, 20_000);

  it('fails the session on crash when auto-recovery is disabled', async () => {
    const harness = createAgentHarness({ autoRecover: false });
    const finished = harness.controller.start({
      command: 'บินไปข้างหน้าเรื่อย ๆ ห้ามชน',
      model: 'local-reflex',
      provider: 'reflex',
    });
    await vi.waitFor(() => expect(harness.controller.currentStatus).toBe('running'), { timeout: 5_000 });

    harness.sim.state.crashed = true;

    await finished;
    harness.stopDriving();
    expect(harness.controller.currentStatus).toBe('failed');
    expect(harness.controller.getRuntime().error).toMatch(/crashed/);
  }, 20_000);

  it('re-sets the destination goal after a recovery', async () => {
    const harness = createAgentHarness({ autoRecover: true });
    const finished = harness.controller.start({
      command: 'fly to x=60 y=40 z=-60',
      model: 'local-reflex',
      provider: 'reflex',
    });
    await vi.waitFor(() => expect(harness.controller.currentStatus).toBe('running'), { timeout: 5_000 });

    harness.sim.state.crashed = true;
    await vi.waitFor(() => {
      expect(harness.controller.getRuntime().recoveries).toBeGreaterThanOrEqual(1);
    }, { timeout: 5_000 });

    // reset() cleared the goal; the controller must restore it.
    expect(harness.sim.getGoal()).toEqual({ x: 60, y: 40, z: -60, radius: 5 });

    await harness.controller.stop();
    await finished;
    harness.stopDriving();
  }, 20_000);
});
});

function makeObservation() {
  return {
    tick: 1,
    position: [0, 0, 0] as [number, number, number],
    velocity: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    altitude: 0,
    speed: 0,
    heading: 0,
    sensors: { front: null, back: null, left: null, right: null, down: null },
    collision: false,
    crashed: false,
    grounded: false,
    goalDistance: null,
    goalDirection: null,
    goalReached: false,
  };
}
