import { createPostgresState } from "@chat-adapter/state-pg";
import type { StateAdapter } from "chat";
import { createLogger } from "@lobu/core";
import type { Pool } from "pg";
import { getPgPool } from "../../db/pg-pool";

const logger = createLogger("chat-state");

/**
 * Build the Chat SDK `StateAdapter` backed by Postgres (state-pg).
 *
 * Shares the singleton `pg.Pool` so every adapter constructed by the gateway
 * (one per connection plus a shared one in CoreServices) reuses the same
 * connections. State-pg auto-creates `chat_state_*` tables on `connect()`,
 * scoped to the `chat-conn` keyPrefix so they coexist with any other
 * state-pg consumer that picks a different prefix.
 *
 * Tests that don't have a live Postgres can pass an in-memory adapter via
 * the dedicated test fixture instead of calling this function.
 */
export function createGatewayStateAdapter(pool?: Pool): StateAdapter {
  return createPostgresState({
    client: pool ?? getPgPool(),
    keyPrefix: "chat-conn",
    logger,
  }) as StateAdapter;
}
