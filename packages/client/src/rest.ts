import { LobuApiError } from "./errors.js";
import {
  getApiV1AgentsByAgentIdEvents,
  postApiV1Agents,
  postApiV1AgentsByAgentIdMessages,
} from "./generated/sdk.gen.js";
import { createClient, type Client } from "./generated/client/index.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  LobuFetch,
  LobuHeaders,
  LobuInternalRequestOptions,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
  TokenProvider,
} from "./types.js";

export class LobuRestClient {
  private readonly token: TokenProvider;
  private readonly fetchImpl: LobuFetch;
  private readonly headers: LobuHeaders | undefined;
  private readonly client: Client;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly org: string | undefined;

  constructor(options: {
    baseUrl: string;
    token: TokenProvider;
    fetch: LobuFetch;
    headers?: LobuHeaders;
    org?: string;
    apiBaseUrl?: string;
  }) {
    this.token = options.token;
    this.fetchImpl = options.fetch;
    this.headers = options.headers;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiBaseUrl = options.apiBaseUrl
      ? normalizeBaseUrl(options.apiBaseUrl)
      : this.baseUrl.replace(/\/lobu$/, "");
    this.org = options.org;
    this.client = createClient({
      baseUrl: this.baseUrl,
      fetch: options.fetch,
    });
  }

  async createSession(
    input: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const result = await postApiV1Agents({
      client: this.client,
      body: input,
      headers: await this.authHeaders(),
    });
    if (result.error) throw new LobuApiError(result.response, result.error);
    return result.data;
  }

  async sendMessage(
    sessionId: string,
    sessionToken: string,
    content: string,
    options: SendMessageOptions = {}
  ): Promise<SendMessageResponse> {
    const result = await postApiV1AgentsByAgentIdMessages({
      client: this.client,
      path: { agentId: sessionId },
      body: { content, messageId: options.messageId },
      headers: this.authHeadersFor(sessionToken),
    });
    if (result.error) throw new LobuApiError(result.response, result.error);
    return result.data;
  }

  async *streamEvents<TData = unknown>(
    sessionId: string,
    sessionToken: string,
    options: StreamEventsOptions = {}
  ): AsyncIterable<LobuSseEvent<TData>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();

    const queue: Array<LobuSseEvent<TData>> = [];
    let done = false;
    let pumpError: unknown;
    let wake: (() => void) | undefined;

    const wakeReader = () => {
      wake?.();
      wake = undefined;
    };

    const result = await getApiV1AgentsByAgentIdEvents({
      client: this.client,
      path: { agentId: sessionId },
      headers: {
        ...this.authHeadersFor(sessionToken),
        ...headersToRecord(options.headers),
      },
      signal: controller.signal,
      onSseEvent: (event) => {
        queue.push({
          event: event.event ?? "message",
          data: event.data as TData,
          id: event.id,
          retry: event.retry,
        });
        wakeReader();
      },
    });

    const pump = (async () => {
      try {
        for await (const _data of result.stream) {
          // onSseEvent above preserves event names. The generated stream yields
          // only data payloads, so the queue is the public SDK surface.
        }
      } catch (error) {
        pumpError = error;
      } finally {
        done = true;
        wakeReader();
      }
    })();

    try {
      while (!done || queue.length > 0) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (pumpError) throw pumpError;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (pumpError) throw pumpError;
    } finally {
      controller.abort();
      options.signal?.removeEventListener("abort", abort);
      await pump;
    }
  }

  async tool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    options: LobuInternalRequestOptions = {}
  ): Promise<T> {
    if (!this.org) throw new Error("Lobu org is required for connector APIs");
    return this.request<T>(`/api/${encodeURIComponent(this.org)}/${toolName}`, {
      method: "POST",
      body: JSON.stringify(args),
      signal: options.signal,
    });
  }

  async worker<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    options: LobuInternalRequestOptions = {}
  ): Promise<T> {
    return this.request<T>(`/api/workers${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  getFetch(): LobuFetch {
    return this.fetchImpl;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...headersToRecord(this.headers),
        ...headersToRecord(init.headers),
        ...(await this.authHeaders()),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const body = await readBody(response);
    if (!response.ok) throw new LobuApiError(response, body);
    return body as T;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return this.authHeadersFor(await resolveToken(this.token));
  }

  private authHeadersFor(token: string): Record<string, string> {
    return {
      ...headersToRecord(this.headers),
      Authorization: `Bearer ${token}`,
    };
  }
}

async function resolveToken(provider: TokenProvider): Promise<string> {
  return typeof provider === "function" ? provider() : provider;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Lobu baseUrl is required");
  return trimmed;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToRecord(
  headers: LobuHeaders | RequestInit["headers"] | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers as Iterable<readonly [string, string]>);
  }
  return headers as Record<string, string>;
}
