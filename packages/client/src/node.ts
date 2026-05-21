import { Lobu as BaseLobu } from "./client.js";
import type { LobuInternalRequestOptions } from "./types.js";

export class Lobu extends BaseLobu {
  readonly connectors = {
    register: (
      connector: HostedConnector,
      options?: LobuInternalRequestOptions
    ) => registerConnector(this, connector, options),
    serve: (
      connector: HostedConnector,
      options?: { workerId?: string; label?: string; signal?: AbortSignal }
    ) => serveConnector(this, connector, options),
  };
}

export type JsonSchema = Record<string, unknown>;

export interface HostedFeedContext<
  C = Record<string, unknown>,
  K = Record<string, unknown>,
> {
  runId: number;
  feedId?: number;
  connectionId?: number;
  config: C;
  checkpoint?: K;
  entityIds?: number[];
  emit: (items: HostedEvent[], checkpoint?: K) => Promise<void>;
}

export interface HostedActionContext {
  runId: number;
  connectionId?: number;
}

export interface HostedEvent {
  id: string;
  title?: string;
  payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
  payload_text: string;
  payload_data?: Record<string, unknown>;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[];
  author_name?: string;
  occurred_at?: string | Date;
  source_url?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  origin_parent_id?: string;
  origin_type?: string;
  semantic_type?: string;
}

export interface HostedFeed<
  C = Record<string, unknown>,
  K = Record<string, unknown>,
> {
  key: string;
  name: string;
  description?: string;
  configSchema?: JsonSchema;
  eventKinds?: Record<string, Record<string, unknown>>;
  sync: (
    ctx: HostedFeedContext<C, K>
  ) => Promise<{ checkpoint?: K } | undefined>;
}

export interface HostedAction<
  I = Record<string, unknown>,
  O = Record<string, unknown>,
> {
  key: string;
  name: string;
  description?: string;
  requiresApproval?: boolean;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  execute: (ctx: HostedActionContext, input: I) => Promise<O>;
}

export interface HostedConnector {
  key: string;
  name: string;
  version: string;
  description?: string;
  authSchema?: JsonSchema | null;
  optionsSchema?: JsonSchema | null;
  faviconDomain?: string | null;
  feeds?: Record<string, HostedFeed>;
  actions?: Record<string, HostedAction>;
}

export function defineConnector(connector: HostedConnector): HostedConnector {
  return connector;
}

export function feed<C = Record<string, unknown>, K = Record<string, unknown>>(
  value: HostedFeed<C, K>
): HostedFeed<C, K> {
  return value;
}

export function action<
  I = Record<string, unknown>,
  O = Record<string, unknown>,
>(value: HostedAction<I, O>): HostedAction<I, O> {
  return value;
}

export async function registerConnector(
  lobu: BaseLobu,
  connector: HostedConnector,
  options: LobuInternalRequestOptions = {}
): Promise<unknown> {
  return lobu.rest.tool(
    "manage_connections",
    {
      action: "install_connector",
      connector_definition: toDefinition(connector),
    },
    options
  );
}

export async function serveConnector(
  lobu: BaseLobu,
  connector: HostedConnector,
  options: { workerId?: string; label?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const workerId = options.workerId ?? crypto.randomUUID();
  while (!options.signal?.aborted) {
    try {
      const poll = await lobu.rest.worker<WorkerPollResponse>(
        "/poll",
        {
          worker_id: workerId,
          platform: "node",
          label: options.label ?? connector.name,
          connector_keys: [connector.key],
        },
        { signal: options.signal }
      );

      if (!poll.run_id) {
        await sleep((poll.next_poll_seconds ?? 10) * 1000, options.signal);
        continue;
      }

      if (poll.connector_key !== connector.key) {
        await failRun(
          lobu,
          workerId,
          poll,
          `Worker for ${connector.key} cannot run ${poll.connector_key}`
        );
        continue;
      }

      if (poll.run_type === "sync") {
        await runFeed(lobu, workerId, connector, poll);
      } else if (poll.run_type === "action") {
        await runAction(lobu, workerId, connector, poll);
      } else {
        await failRun(
          lobu,
          workerId,
          poll,
          `Unsupported run_type ${poll.run_type}`
        );
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      console.error("[lobu] hosted connector worker error", error);
      await sleep(3000, options.signal);
    }
  }
}

function toDefinition(connector: HostedConnector): Record<string, unknown> {
  return {
    key: connector.key,
    name: connector.name,
    description: connector.description,
    version: connector.version,
    authSchema: connector.authSchema ?? null,
    optionsSchema: connector.optionsSchema ?? null,
    faviconDomain: connector.faviconDomain ?? null,
    feeds: Object.fromEntries(
      Object.entries(connector.feeds ?? {}).map(([key, value]) => [
        key,
        {
          key: value.key,
          name: value.name,
          description: value.description,
          configSchema: value.configSchema,
          eventKinds: value.eventKinds,
        },
      ])
    ),
    actions: Object.fromEntries(
      Object.entries(connector.actions ?? {}).map(([key, value]) => [
        key,
        {
          key: value.key,
          name: value.name,
          description: value.description,
          requiresApproval: value.requiresApproval ?? false,
          inputSchema: value.inputSchema,
          outputSchema: value.outputSchema,
        },
      ])
    ),
  };
}

type WorkerPollResponse = {
  next_poll_seconds?: number;
  run_id?: number;
  run_type?: string;
  connector_key?: string;
  feed_key?: string;
  feed_id?: number;
  connection_id?: number;
  config?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  entity_ids?: number[];
  action_key?: string;
  action_input?: Record<string, unknown>;
};

async function runFeed(
  lobu: BaseLobu,
  workerId: string,
  connector: HostedConnector,
  poll: WorkerPollResponse
): Promise<void> {
  const current = poll.feed_key ? connector.feeds?.[poll.feed_key] : undefined;
  if (!current || !poll.run_id) {
    await complete(lobu, workerId, poll, {
      status: "failed",
      error_message: `Unknown feed ${poll.feed_key}`,
    });
    return;
  }

  let itemsCollected = 0;
  const emit = async (
    items: HostedEvent[],
    checkpoint?: Record<string, unknown>
  ) => {
    itemsCollected += items.length;
    await lobu.rest.worker("/stream", {
      type: "batch",
      run_id: poll.run_id!,
      worker_id: workerId,
      items: items.map(normalizeEvent),
      checkpoint,
    });
  };

  let result: { checkpoint?: Record<string, unknown> } | undefined;
  try {
    result = await current.sync({
      runId: poll.run_id,
      feedId: poll.feed_id,
      connectionId: poll.connection_id,
      config: (poll.config ?? {}) as Record<string, unknown>,
      checkpoint: poll.checkpoint,
      entityIds: poll.entity_ids,
      emit,
    });
  } catch (error) {
    await complete(lobu, workerId, poll, {
      status: "failed",
      items_collected: itemsCollected,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await complete(lobu, workerId, poll, {
    status: "success",
    items_collected: itemsCollected,
    checkpoint: result?.checkpoint,
  });
}

async function runAction(
  lobu: BaseLobu,
  workerId: string,
  connector: HostedConnector,
  poll: WorkerPollResponse
): Promise<void> {
  const current = poll.action_key
    ? connector.actions?.[poll.action_key]
    : undefined;
  if (!current || !poll.run_id) {
    await completeAction(lobu, workerId, poll, {
      status: "failed",
      error_message: `Unknown action ${poll.action_key}`,
    });
    return;
  }

  let output: unknown;
  try {
    output = await current.execute(
      { runId: poll.run_id, connectionId: poll.connection_id },
      (poll.action_input ?? {}) as Record<string, unknown>
    );
  } catch (error) {
    await completeAction(lobu, workerId, poll, {
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await completeAction(lobu, workerId, poll, {
    status: "success",
    action_output: toRecord(output),
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function normalizeEvent(event: HostedEvent): Record<string, unknown> {
  return {
    ...event,
    occurred_at:
      event.occurred_at instanceof Date
        ? event.occurred_at.toISOString()
        : (event.occurred_at ?? new Date().toISOString()),
  };
}

function failRun(
  lobu: BaseLobu,
  workerId: string,
  poll: WorkerPollResponse,
  message: string
): Promise<unknown> {
  const body = { status: "failed", error_message: message };
  return poll.run_type === "action"
    ? completeAction(lobu, workerId, poll, body)
    : complete(lobu, workerId, poll, body);
}

function complete(
  lobu: BaseLobu,
  workerId: string,
  poll: WorkerPollResponse,
  body: Record<string, unknown>
): Promise<unknown> {
  return lobu.rest.worker("/complete", {
    run_id: poll.run_id!,
    worker_id: workerId,
    ...body,
  });
}

function completeAction(
  lobu: BaseLobu,
  workerId: string,
  poll: WorkerPollResponse,
  body: Record<string, unknown>
): Promise<unknown> {
  return lobu.rest.worker("/complete-action", {
    run_id: poll.run_id!,
    worker_id: workerId,
    ...body,
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
