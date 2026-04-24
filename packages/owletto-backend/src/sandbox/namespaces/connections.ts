/**
 * ClientSDK `connections` namespace. Thin wrapper over `manageConnections`.
 *
 * `connect` is the entry point for setting up a new authenticated connection —
 * the handler returns a `connect_url` that the caller must surface to the
 * user's browser. Field names follow the handler schema.
 */

import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";

export interface ConnectionsConnectInput {
  connector_key: string;
  display_name?: string;
  auth_profile_slug?: string;
}

export interface ConnectionsCreateInput {
  connector_key: string;
  display_name?: string;
  config?: Record<string, unknown>;
}

export interface ConnectionsNamespace {
  list(input?: { connector_key?: string }): Promise<unknown>;
  listConnectorDefinitions(): Promise<unknown>;
  get(connection_id: number): Promise<unknown>;
  create(input: ConnectionsCreateInput): Promise<unknown>;
  connect(input: ConnectionsConnectInput): Promise<unknown>;
  update(input: {
    connection_id: number;
    display_name?: string;
    auth_profile_slug?: string | null;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  delete(connection_id: number): Promise<unknown>;
  test(connection_id: number): Promise<unknown>;
  installConnector(input: {
    connector_key: string;
    source_url?: string;
  }): Promise<unknown>;
  uninstallConnector(connector_key: string): Promise<unknown>;
  toggleConnectorLogin(input: {
    connector_key: string;
    enabled: boolean;
  }): Promise<unknown>;
  updateConnectorAuth(input: {
    connector_key: string;
    auth_config: Record<string, unknown>;
  }): Promise<unknown>;
}

export function buildConnectionsNamespace(
  ctx: ToolContext,
  env: Env,
): ConnectionsNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageConnections(payload as never, env, ctx) as Promise<T>;

  return {
    list: (input) => call({ action: "list", ...input }),
    listConnectorDefinitions: () =>
      call({ action: "list_connector_definitions" }),
    get: (connection_id) => call({ action: "get", connection_id }),
    create: (input) => call({ action: "create", ...input }),
    connect: (input) => call({ action: "connect", ...input }),
    update: (input) => call({ action: "update", ...input }),
    delete: (connection_id) => call({ action: "delete", connection_id }),
    test: (connection_id) => call({ action: "test", connection_id }),
    installConnector: (input) =>
      call({ action: "install_connector", ...input }),
    uninstallConnector: (connector_key) =>
      call({ action: "uninstall_connector", connector_key }),
    toggleConnectorLogin: (input) =>
      call({ action: "toggle_connector_login", ...input }),
    updateConnectorAuth: (input) =>
      call({ action: "update_connector_auth", ...input }),
  };
}
