/**
 * ClientSDK `connections` namespace. Thin wrapper over `manageConnections`.
 */

import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";

export interface ConnectionsNamespace {
  list(input?: { connector_key?: string }): Promise<unknown>;
  listConnectorDefinitions(): Promise<unknown>;
  get(connection_id: number): Promise<unknown>;
  create(input: {
    connector_key: string;
    name?: string;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  connect(input: {
    connector_key: string;
    auth_profile_id?: number;
  }): Promise<unknown>;
  update(input: {
    connection_id: number;
    [key: string]: unknown;
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
  env: Env
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
