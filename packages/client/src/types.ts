export type TokenProvider = string | (() => string | Promise<string>);

export type LobuFetch = typeof fetch;
export type LobuHeaders =
  | Headers
  | Record<string, string>
  | ReadonlyArray<readonly [string, string]>;

export interface LobuClientOptions {
  baseUrl: string;
  apiBaseUrl?: string;
  token: TokenProvider;
  fetch?: LobuFetch;
  headers?: LobuHeaders;
  org?: string;
}

export interface CreateSessionRequest {
  agentId?: string;
  userId?: string;
  thread?: string;
  provider?: string;
  model?: string;
  forceNew?: boolean;
  dryRun?: boolean;
  networkConfig?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
  };
  mcpServers?: Record<
    string,
    {
      url?: string;
      type?: "sse" | "streamable-http" | "stdio";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      description?: string;
    }
  >;
  nix?: {
    flakeUrl?: string;
    packages?: string[];
  };
}

export interface CreateSessionResponse {
  success: boolean;
  agentId: string;
  token: string;
  expiresAt: number;
  sseUrl: string;
  messagesUrl: string;
}

export interface SendMessageOptions {
  messageId?: string;
}

export interface SendMessageResponse {
  success: boolean;
  messageId: string;
  agentId?: string;
  jobId?: string;
  eventsUrl?: string;
  queued: boolean;
  traceparent?: string;
}

export interface LobuSseEvent<TData = unknown> {
  event: string;
  data: TData;
  id?: string;
  retry?: number;
}

export interface StreamEventsOptions {
  signal?: AbortSignal;
  headers?: LobuHeaders;
}

export interface LobuInternalRequestOptions {
  signal?: AbortSignal;
}
