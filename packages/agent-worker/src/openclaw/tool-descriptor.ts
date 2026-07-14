import { createHash } from "node:crypto";
import type { McpToolDef } from "@lobu/core";
import {
  catalogEntryForTool,
  hasTrustedReadOnlyToolMetadata,
  type ToolPriority,
} from "./tool-catalog";
import type { ToolDestination, ToolOperation } from "./tool-route-query";
import {
  releaseToolRouterCacheEntry,
  retainToolRouterCacheEntry,
  touchToolRouterCacheEntry,
} from "./tool-router-memory-budget";

const MAX_INDEXED_TEXT_BYTES = 16 * 1024;
const DESCRIPTOR_VERSION = 1;
const DESCRIPTOR_CACHE_NAMESPACE = "descriptor-snapshot";
const MAX_DESCRIPTOR_SNAPSHOTS_PER_TOOL = 8;
const descriptorSnapshotCache = new WeakMap<
  McpToolDef,
  Map<string, ToolDescriptor>
>();
const descriptorSourceIds = new WeakMap<McpToolDef, number>();
let nextDescriptorSourceId = 1;
const deeplyImmutableDescriptorSources = new WeakSet<object>();
const descriptorSourceFinalizer = new FinalizationRegistry<string>(
  (retainedKey) =>
    releaseToolRouterCacheEntry(DESCRIPTOR_CACHE_NAMESPACE, retainedKey),
);

export function toolIdentityKey(mcpId: string, name: string): string {
  return JSON.stringify([mcpId, name]);
}

export interface ToolDescriptor {
  key: string;
  identityKey: string;
  mcpId: string;
  name: string;
  indexedKey: string;
  indexedName: string;
  title?: string;
  description: string;
  aliases: string[];
  parameterNames: string[];
  parameterDescriptions: string[];
  domain?: string;
  operations: ToolOperation[];
  destinations: ToolDestination[];
  positiveExamples: string[];
  negativeExamples: string[];
  readOnly: boolean;
  mutatesState: boolean;
  requiresConfirmation: boolean;
  sideEffectClasses: string[];
  primarySideEffect: {
    action: string;
    resource: string;
    destination: string;
  } | null;
  priority: ToolPriority;
  originalIndex: number;
  indexedTextBytes: number;
}

function isDeeplyImmutable(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value !== "object") return true;
  if (deeplyImmutableDescriptorSources.has(value)) return true;
  if (visited.has(value) || !Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return false;
  visited.add(value);
  for (const nested of Object.values(value)) {
    if (!isDeeplyImmutable(nested, visited)) return false;
  }
  deeplyImmutableDescriptorSources.add(value);
  return true;
}

function freezeDescriptorSnapshot(descriptor: ToolDescriptor): ToolDescriptor {
  return Object.freeze({
    ...descriptor,
    aliases: Object.freeze([...descriptor.aliases]),
    parameterNames: Object.freeze([...descriptor.parameterNames]),
    parameterDescriptions: Object.freeze([...descriptor.parameterDescriptions]),
    operations: Object.freeze([...descriptor.operations]),
    destinations: Object.freeze([...descriptor.destinations]),
    positiveExamples: Object.freeze([...descriptor.positiveExamples]),
    negativeExamples: Object.freeze([...descriptor.negativeExamples]),
    sideEffectClasses: Object.freeze([...descriptor.sideEffectClasses]),
    primarySideEffect: descriptor.primarySideEffect
      ? Object.freeze({ ...descriptor.primarySideEffect })
      : null,
  }) as ToolDescriptor;
}

interface DescriptorOverride {
  aliases: string[];
  operations: ToolOperation[];
  destinations: ToolDestination[];
  positiveExamples: string[];
  negativeExamples: string[];
  readOnly: boolean;
  mutatesState: boolean;
  requiresConfirmation: boolean;
}

const DESCRIPTOR_OVERRIDES: Readonly<Record<string, DescriptorOverride>> = {
  [toolIdentityKey("lobu-memory", "manage_schedules")]: {
    aliases: ["提醒我", "稍後叫我", "個人提醒", "延遲提醒", "agent schedule"],
    operations: ["create", "update", "delete", "schedule"],
    destinations: ["personal_reminder"],
    positiveExamples: ["五分鐘後提醒我", "明天提醒我繳費"],
    negativeExamples: ["Google Calendar", "行事曆"],
    readOnly: false,
    mutatesState: true,
    requiresConfirmation: true,
  },
  [toolIdentityKey("google_workspace", "gws_calendar_events_create")]: {
    aliases: ["Google Calendar", "建立行事曆事件", "建立日曆事件"],
    operations: ["create"],
    destinations: ["google_calendar"],
    positiveExamples: ["放進 Google Calendar", "建立行事曆會議"],
    negativeExamples: ["提醒我", "稍後叫我"],
    readOnly: false,
    mutatesState: true,
    requiresConfirmation: true,
  },
};

function sanitize(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value]
    .map((codepoint) => {
      const codepointValue = codepoint.codePointAt(0) ?? 0;
      return codepointValue <= 0x1f ||
        (codepointValue >= 0x7f && codepointValue <= 0x9f)
        ? " "
        : codepoint;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(sanitize).filter(Boolean))];
}

function searchableText(descriptor: ToolDescriptor): string {
  return [
    descriptor.indexedKey,
    descriptor.indexedName,
    descriptor.title,
    descriptor.aliases.join(" "),
    descriptor.description,
    descriptor.parameterNames.join(" "),
    descriptor.parameterDescriptions.join(" "),
    descriptor.domain,
    descriptor.operations.join(" "),
    descriptor.destinations.join(" "),
    descriptor.positiveExamples.join(" "),
    descriptor.negativeExamples.join(" "),
    descriptor.sideEffectClasses.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function indexedBytes(descriptor: ToolDescriptor): number {
  return Buffer.byteLength(searchableText(descriptor), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  let bytes = 0;
  for (const codepoint of value) {
    const nextBytes = Buffer.byteLength(codepoint, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    result += codepoint;
    bytes += nextBytes;
  }
  return result.trim();
}

function trimArrayToFit(descriptor: ToolDescriptor, values: string[]): void {
  let excess = indexedBytes(descriptor) - MAX_INDEXED_TEXT_BYTES;
  while (values.length > 0 && excess > 0) {
    const removed = values.pop();
    if (removed === undefined) break;
    excess -= Buffer.byteLength(removed, "utf8");
    if (values.length > 0) excess--;
  }
}

function trimStringToFit(
  descriptor: ToolDescriptor,
  field: "indexedKey" | "indexedName" | "title" | "description" | "domain",
): void {
  const value = descriptor[field];
  if (!value || indexedBytes(descriptor) <= MAX_INDEXED_TEXT_BYTES) return;

  const currentBytes = Buffer.byteLength(value, "utf8");
  const excess = indexedBytes(descriptor) - MAX_INDEXED_TEXT_BYTES;
  descriptor[field] = truncateUtf8(value, Math.max(0, currentBytes - excess));
}

function boundSearchableText(descriptor: ToolDescriptor): void {
  trimArrayToFit(descriptor, descriptor.parameterDescriptions);
  trimArrayToFit(descriptor, descriptor.positiveExamples);
  trimArrayToFit(descriptor, descriptor.negativeExamples);
  trimStringToFit(descriptor, "description");

  // These fields are normally tiny trusted metadata. Keep them searchable when
  // possible, but defensively bound malformed schemas without dropping identity.
  trimStringToFit(descriptor, "title");
  trimArrayToFit(descriptor, descriptor.aliases);
  trimArrayToFit(descriptor, descriptor.parameterNames);
  trimStringToFit(descriptor, "domain");
  trimArrayToFit(descriptor, descriptor.operations);
  trimArrayToFit(descriptor, descriptor.destinations);
  trimArrayToFit(descriptor, descriptor.sideEffectClasses);
  trimStringToFit(descriptor, "indexedKey");
  trimStringToFit(descriptor, "indexedName");

  descriptor.indexedTextBytes = indexedBytes(descriptor);
}

function inferOperations(name: string): ToolOperation[] {
  const operations: ToolOperation[] = [];
  const normalized = name.toLowerCase();
  for (const [operation, pattern] of [
    ["read", /(?:^|[_-])(read|get|list)(?:[_-]|$)/],
    ["search", /(?:^|[_-])(search|find|lookup)(?:[_-]|$)/],
    ["create", /(?:^|[_-])(create|add|insert|upload|invite)(?:[_-]|$)/],
    [
      "update",
      /(?:^|[_-])(update|edit|modify|save|submit|set|upsert|write)(?:[_-]|$)/,
    ],
    ["delete", /(?:^|[_-])(delete|remove|archive)(?:[_-]|$)/],
    ["send", /(?:^|[_-])(send|post|publish|execute|run|trigger)(?:[_-]|$)/],
    ["schedule", /(?:^|[_-])(schedule|remind)(?:[_-]|$)/],
  ] as const) {
    if (pattern.test(normalized)) operations.push(operation);
  }
  return operations.length > 0 ? operations : ["unknown"];
}

const MUTATING_ACTIONS = new Set([
  "create",
  "add",
  "insert",
  "save",
  "submit",
  "upload",
  "invite",
  "execute",
  "run",
  "trigger",
  "set",
  "upsert",
  "update",
  "edit",
  "modify",
  "delete",
  "remove",
  "archive",
  "send",
  "post",
  "publish",
  "write",
  "schedule",
  "remind",
]);
const READ_ACTIONS = new Set([
  "get",
  "list",
  "read",
  "status",
  "search",
  "find",
  "lookup",
  "describe",
]);

function identifierTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function standardToolAnnotations(tool: McpToolDef): {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
} {
  const annotations = (
    tool as McpToolDef & {
      annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
    }
  ).annotations;
  return {
    readOnlyHint:
      typeof annotations?.readOnlyHint === "boolean"
        ? annotations.readOnlyHint
        : undefined,
    destructiveHint:
      typeof annotations?.destructiveHint === "boolean"
        ? annotations.destructiveHint
        : undefined,
  };
}

function primarySideEffect(
  name: string,
  mcpId: string,
  destinations: readonly ToolDestination[],
): ToolDescriptor["primarySideEffect"] {
  const tokens = identifierTokens(name);
  const action =
    tokens.find((token) => MUTATING_ACTIONS.has(token)) ?? "potential_write";
  const resourceTokens = tokens.filter(
    (token) =>
      !MUTATING_ACTIONS.has(token) &&
      !READ_ACTIONS.has(token) &&
      !["gws", "tool", "tools", "api"].includes(token),
  );
  return {
    action,
    resource: resourceTokens.join("_") || "unknown_resource",
    destination: destinations[0] ?? (sanitize(mcpId) || "unknown_destination"),
  };
}

function inferSideEffectClasses(
  name: string,
  description: string,
  operations: readonly ToolOperation[],
): string[] {
  const classesFor = (text: string): string[] => {
    const searchable = text.replace(/[_-]+/g, " ");
    const classes: string[] = [];
    const add = (value: string, pattern: RegExp) => {
      if (pattern.test(searchable)) classes.push(value);
    };
    add("email", /\b(email|mail)\b/);
    add("message", /\b(message|chat|slack|sms)\b|訊息|消息/);
    add("publication", /\b(post|publish|social)\b|發布|发布/);
    add("calendar_event", /\b(calendar|event|meeting)\b|行事曆|日曆|日历/);
    add("personal_reminder", /\b(reminder|schedule)\b|提醒|排程/);
    add("document", /\b(document|docs?|file)\b|文件|檔案/);
    add("task", /\b(task|ticket|issue)\b|任務|工單/);
    add("record", /\b(record|row|database)\b|資料列|紀錄/);
    return classes;
  };
  // Stable tool identity is the strongest conservative hint. Description is
  // untrusted ranking text and only fills a missing class; it never downgrades
  // a write or grants callability.
  const classes = classesFor(name.toLowerCase());
  if (classes.length === 0)
    classes.push(...classesFor(description.toLowerCase()));
  if (classes.length === 0) {
    const mutatingOperation = operations.find((operation) =>
      ["create", "update", "delete", "send", "schedule"].includes(operation),
    );
    if (mutatingOperation) classes.push(`${mutatingOperation}_write`);
  }
  return uniqueStrings(classes);
}

function parameterMetadata(tool: McpToolDef): {
  names: string[];
  descriptions: string[];
} {
  const properties = tool.inputSchema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return { names: [], descriptions: [] };
  }

  const names: string[] = [];
  const descriptions: string[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    const sanitizedName = sanitize(name);
    if (sanitizedName) names.push(sanitizedName);
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const description = sanitize(
        (schema as Record<string, unknown>).description,
      );
      if (description) descriptions.push(description);
    }
  }
  return {
    names: uniqueStrings(names),
    descriptions: uniqueStrings(descriptions),
  };
}

function readDescriptorTitle(tool: McpToolDef): string | undefined {
  const looseTool = tool as unknown as {
    title?: unknown;
    _meta?: { title?: unknown; shifuTool?: { title?: unknown } };
    annotations?: { title?: unknown; shifuTool?: { title?: unknown } };
  };
  const title =
    looseTool.title ??
    looseTool._meta?.title ??
    looseTool.annotations?.title ??
    looseTool._meta?.shifuTool?.title ??
    looseTool.annotations?.shifuTool?.title;
  return sanitize(title) || undefined;
}

export function buildToolDescriptor(
  tool: McpToolDef,
  mcpId: string,
  originalIndex: number,
): ToolDescriptor {
  const entry = catalogEntryForTool(tool, originalIndex, mcpId);
  const name = entry.name;
  const key = mcpId ? `${mcpId}/${name}` : name;
  const identityKey = toolIdentityKey(mcpId, name);
  const indexedName = sanitize(name);
  const indexedMcpId = sanitize(mcpId);
  const indexedKey = indexedMcpId
    ? `${indexedMcpId}/${indexedName}`
    : indexedName;
  const override = DESCRIPTOR_OVERRIDES[identityKey];
  const parameters = parameterMetadata(tool);
  const inferredOperations = inferOperations(name);
  const tokens = identifierTokens(name);
  const annotations = standardToolAnnotations(tool);
  const hasMutatingAction = tokens.some((token) => MUTATING_ACTIONS.has(token));
  const hasReadAction = tokens.some((token) => READ_ACTIONS.has(token));
  const hasTrustedReadOnlyMetadata = hasTrustedReadOnlyToolMetadata(tool);
  const inferredMutating =
    hasMutatingAction ||
    annotations.destructiveHint === true ||
    annotations.readOnlyHint === false ||
    (!hasReadAction && !hasTrustedReadOnlyMetadata);
  const mutatesState =
    override?.mutatesState ?? (entry.mutatesState || inferredMutating);
  const descriptor: ToolDescriptor = {
    key,
    identityKey,
    mcpId,
    name,
    indexedKey,
    indexedName,
    title: readDescriptorTitle(tool),
    description: sanitize(tool.description),
    aliases: uniqueStrings([...entry.aliases, ...(override?.aliases ?? [])]),
    parameterNames: parameters.names,
    parameterDescriptions: parameters.descriptions,
    domain: entry.domain === "unknown" ? undefined : entry.domain,
    operations: [...(override?.operations ?? inferredOperations)],
    destinations: [...(override?.destinations ?? [])],
    positiveExamples: [...(override?.positiveExamples ?? [])],
    negativeExamples: [...(override?.negativeExamples ?? [])],
    readOnly: override?.readOnly ?? (mutatesState ? false : entry.readOnly),
    mutatesState,
    requiresConfirmation:
      override?.requiresConfirmation ?? entry.requiresConfirmation,
    priority: entry.priority,
    originalIndex,
    indexedTextBytes: 0,
    sideEffectClasses: inferSideEffectClasses(
      name,
      tool.description || "",
      override?.operations ?? inferredOperations,
    ),
    primarySideEffect: mutatesState
      ? primarySideEffect(name, mcpId, override?.destinations ?? [])
      : null,
  };

  boundSearchableText(descriptor);
  return descriptor;
}

export function getOrBuildToolDescriptor(
  tool: McpToolDef,
  mcpId: string,
  originalIndex: number,
): ToolDescriptor {
  if (!isDeeplyImmutable(tool))
    return buildToolDescriptor(tool, mcpId, originalIndex);
  const localKey = JSON.stringify([mcpId, originalIndex]);
  const sourceId = descriptorSourceIds.get(tool) ?? nextDescriptorSourceId++;
  descriptorSourceIds.set(tool, sourceId);
  const retainedKey = `${sourceId}:${localKey}`;
  const snapshots = descriptorSnapshotCache.get(tool) ?? new Map();
  const cached = snapshots.get(localKey);
  if (cached) {
    snapshots.delete(localKey);
    snapshots.set(localKey, cached);
    touchToolRouterCacheEntry(DESCRIPTOR_CACHE_NAMESPACE, retainedKey);
    return cached;
  }
  const descriptor = freezeDescriptorSnapshot(
    buildToolDescriptor(tool, mcpId, originalIndex),
  );
  const estimatedBytes =
    Buffer.byteLength(JSON.stringify(descriptor), "utf8") * 2 + 512;
  const toolReference = new WeakRef(tool);
  const retained = retainToolRouterCacheEntry({
    namespace: DESCRIPTOR_CACHE_NAMESPACE,
    key: retainedKey,
    estimatedBytes,
    onEvict: () => {
      const source = toolReference.deref();
      if (source) descriptorSnapshotCache.get(source)?.delete(localKey);
    },
  });
  if (!retained.retained) return descriptor;
  descriptorSourceFinalizer.register(tool, retainedKey);
  snapshots.set(localKey, descriptor);
  while (snapshots.size > MAX_DESCRIPTOR_SNAPSHOTS_PER_TOOL) {
    const oldestKey = snapshots.keys().next().value;
    if (oldestKey === undefined) break;
    snapshots.delete(oldestKey);
    releaseToolRouterCacheEntry(
      DESCRIPTOR_CACHE_NAMESPACE,
      `${sourceId}:${oldestKey}`,
    );
  }
  descriptorSnapshotCache.set(tool, snapshots);
  return descriptor;
}

export function inventoryFingerprint(descriptors: ToolDescriptor[]): string {
  const inventory = descriptors.map(
    ({ indexedTextBytes: _indexedTextBytes, ...descriptor }, position) => ({
      position,
      ...descriptor,
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify({ version: DESCRIPTOR_VERSION, inventory }))
    .digest("hex");
}
