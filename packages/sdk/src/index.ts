// Lobu authoring SDK — define agents, connectors, watchers, and connections in
// TypeScript. `lobu apply` imports a project entrypoint (default export of
// `defineConfig`) and maps it to the server's desired state.

// Connector authoring is re-exported from @lobu/connector-sdk so a project can
// import its whole authoring surface from a single package.
export { defineConnector } from "@lobu/connector-sdk";
export type {
  ConnectorActionSpec,
  ConnectorClass,
  ConnectorFeedSpec,
  ConnectorSpec,
} from "@lobu/connector-sdk";
// TypeBox schema authoring (extraction schemas, feed/action config schemas).
export { Type } from "@lobu/connector-sdk";
export type { Static } from "@lobu/connector-sdk";

export * from "./define.js";
export * from "./secret.js";
