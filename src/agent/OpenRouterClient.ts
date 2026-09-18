/**
 * OpenRouterClient (Spec §19, §37, §39).
 *
 * Transport only: API key handling, HTTP request/response, timeout, abort and
 * error mapping. The decision schema lives in `JevAdapter`.
 *
 * The API key lives ONLY inside this instance (runtime memory, Spec §5). It is
 * never logged, stored, or serialized.
 */
import type { AIProvider, AgentDecisionRequest, DroneAction, JevAdapter } from './AgentProtocol';

/** OpenAI-compatible chat endpoint (generic chat models). */
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Decisions endpoint — JEV answers typed questions about a state. */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  adapter: JevAdapter;
  /** Per-request timeout in ms (default 25 s). */
  timeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Debug hook: raw provider response, before schema parsing (Spec §45). */
  onRawResponse?: (response: unknown) => void;
  /** Which OpenRouter endpoint this transport talks to. */
  endpoint?: 'chat' | 'decisions';
  /** Optional site URL for OpenRouter leaderboards (Quick Start header). */
  siteUrl?: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionResult {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: string };
}

export class OpenRouterClient implements AIProvider {
  private readonly apiKey: string;
  readonly model: string;
  private readonly adapter: JevAdapter;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onRawResponse: ((response: unknown) => void) | undefined;
  private readonly endpoint: 'chat' | 'decisions';
  private readonly siteUrl: string | undefined;
  private inFlight: AbortController | null = null;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new ProviderError('OpenRouter API key is required');
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model;
    this.adapter = options.adapter;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onRawResponse = options.onRawResponse;
    this.endpoint = options.endpoint ?? 'chat';
    this.siteUrl = options.siteUrl;
  }

  /** Abort the request currently in flight, if any (Spec §39). */
  abort(): void {
    this.inFlight?.abort();
  }

  async decide(
    request: AgentDecisionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DroneAction> {
    const isDecisions = this.endpoint === 'decisions';
    const partial = this.adapter.createRequest(
      { command: request.task.command, startedAt: 0 },
      request.state,
      request.nearbyBuildings,
    ) as { messages?: ChatMessage[]; temperature?: number; max_tokens?: number; state?: unknown; questions?: unknown };

    const body: Record<string, unknown> = { model: this.model };
    if (isDecisions) {
      // Decisions API: the adapter supplies `state` + typed `questions`.
      body.state = partial.state;
      body.questions = partial.questions;
    } else {
      if (partial.messages) body.messages = partial.messages;
      if (partial.temperature !== undefined) body.temperature = partial.temperature;
      if (partial.max_tokens !== undefined) body.max_tokens = partial.max_tokens;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    const onOuterAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(isDecisions ? OPENROUTER_DECISIONS_URL : OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Drone City Simulator',
          ...(this.siteUrl ? { 'HTTP-Referer': this.siteUrl } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        void bodyText;
        const hint =
          response.status === 401
            ? 'invalid API key'
            : response.status === 429
              ? 'rate limited'
              : 'HTTP error';
        throw new ProviderError(`OpenRouter ${hint} (${response.status})`, response.status);
      }

      const json = (await response.json()) as ChatCompletionResult;
      if (json.error) throw new ProviderError(json.error.message ?? 'OpenRouter error');
      this.onRawResponse?.(json);
      // A stale request (agent stopped / new session) must never move the drone.
      if (options.signal?.aborted) throw new ProviderError('request aborted');
      return this.adapter.parseResponse(json);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProviderError('request aborted or timed out');
      }
      throw new ProviderError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
}
