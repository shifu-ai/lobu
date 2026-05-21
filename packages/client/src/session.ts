import type { LobuRestClient } from "./rest.js";
import type {
  CreateSessionResponse,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
} from "./types.js";

export class AgentSession {
  readonly agentId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly sseUrl: string;
  readonly messagesUrl: string;

  constructor(
    private readonly rest: LobuRestClient,
    response: CreateSessionResponse
  ) {
    this.agentId = response.agentId;
    this.token = response.token;
    this.expiresAt = response.expiresAt;
    this.sseUrl = response.sseUrl;
    this.messagesUrl = response.messagesUrl;
  }

  send(
    content: string,
    options?: SendMessageOptions
  ): Promise<SendMessageResponse> {
    return this.rest.sendMessage(this.agentId, this.token, content, options);
  }

  events<TData = unknown>(
    options: StreamEventsOptions = {}
  ): AsyncIterable<LobuSseEvent<TData>> {
    return this.rest.streamEvents<TData>(this.agentId, this.token, options);
  }
}
