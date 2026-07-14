import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type RuntimeEnvironment = "staging" | "production";

export interface RuntimeCapabilitySnapshot {
  schemaVersion: 1;
  environment: RuntimeEnvironment;
  toolboxUserId: string;
  agentId: string;
  capabilities: string[];
  appliedReleaseId: string;
  appliedReleaseSequence: number;
  expiresAt: string;
  snapshotDigest: string;
}

export interface RuntimeCapabilitySnapshotRequest {
  environment: RuntimeEnvironment;
  toolboxUserId: string;
  agentId: string;
}

const RESPONSE_KEYS = [
	"agentId",
	"appliedReleaseId",
	"appliedReleaseSequence",
	"capabilities",
	"environment",
	"expiresAt",
	"schemaVersion",
	"snapshotDigest",
	"toolboxUserId",
] as const;

const snapshotCache = new Map<
	string,
	{ value: RuntimeCapabilitySnapshot; cachedAt: number }
>();

/** Cached resolver; TTL is always capped by the signed snapshot expiry. */
export async function resolveRuntimeCapabilitySnapshot(
  request: RuntimeCapabilitySnapshotRequest,
	options: Parameters<typeof fetchRuntimeCapabilitySnapshot>[1] & {
		cacheTtlMs?: number;
	} = {},
): Promise<RuntimeCapabilitySnapshot> {
  const now = options.now?.() ?? new Date();
  const key = `${request.environment}\0${request.toolboxUserId}\0${request.agentId}`;
  const cached = snapshotCache.get(key);
	const configured =
		options.cacheTtlMs ??
		Number.parseInt(
			process.env.RUNTIME_CAPABILITY_SNAPSHOT_CACHE_TTL_MS ?? "",
			10,
		);
	const ttlMs =
		Number.isFinite(configured) && configured > 0
			? Math.min(configured, 5 * 60_000)
			: 30_000;
	if (
		cached &&
		now.getTime() - cached.cachedAt < ttlMs &&
		now.getTime() < Date.parse(cached.value.expiresAt)
	) {
    return cached.value;
  }
  snapshotCache.delete(key);
  const value = await fetchRuntimeCapabilitySnapshot(request, options);
  snapshotCache.set(key, { value, cachedAt: now.getTime() });
  return value;
}

export function resetRuntimeCapabilitySnapshotCacheForTests(): void {
  snapshotCache.clear();
}

export async function fetchRuntimeCapabilitySnapshot(
  request: RuntimeCapabilitySnapshotRequest,
  options: {
    url?: string;
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: () => Date;
  } = {},
): Promise<RuntimeCapabilitySnapshot> {
	if (
		request.environment !== "staging" &&
		request.environment !== "production"
	) {
		throw new Error(
			"runtime capability snapshot environment must be staging or production",
		);
  }
  for (const value of [request.toolboxUserId, request.agentId]) {
    if (typeof value !== "string" || !value || value.length > 200) {
      throw new Error("runtime capability snapshot identity is invalid");
    }
  }
	const url =
		options.url ?? process.env.TOOLBOX_RUNTIME_CAPABILITIES_URL?.trim();
  const secret = options.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
	if (!url || !secret)
		throw new Error("runtime capability snapshot transport is not configured");
  const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 1_500,
	);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
			headers: {
				"content-type": "application/json",
				"x-internal-secret": secret,
			},
      body: JSON.stringify({
        environment: request.environment,
        toolboxUserId: request.toolboxUserId,
        agentId: request.agentId,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
	if (!response.ok)
		throw new Error(
			`runtime capability snapshot request failed (${response.status})`,
		);
  const value: unknown = await response.json();
	return validateRuntimeCapabilitySnapshot(
		value,
		request,
		options.now?.() ?? new Date(),
	);
}

export function validateRuntimeCapabilitySnapshot(
  value: unknown,
  request: RuntimeCapabilitySnapshotRequest,
  now: Date,
): RuntimeCapabilitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime capability snapshot response must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
	if (
		keys.length !== RESPONSE_KEYS.length ||
		keys.some((key, index) => key !== RESPONSE_KEYS[index])
	) {
		throw new Error(
			"runtime capability snapshot response has an unknown or missing field",
		);
  }
  if (
    record.schemaVersion !== 1 ||
    record.environment !== request.environment ||
    record.toolboxUserId !== request.toolboxUserId ||
    record.agentId !== request.agentId ||
		typeof record.appliedReleaseId !== "string" ||
		!record.appliedReleaseId ||
		!Number.isInteger(record.appliedReleaseSequence) ||
		(record.appliedReleaseSequence as number) <= 0 ||
		typeof record.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.expiresAt) <= now.getTime() ||
		Date.parse(record.expiresAt) > now.getTime() + 60_000 ||
		typeof record.snapshotDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(record.snapshotDigest) ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.length < 1 ||
		record.capabilities.length > 64 ||
		record.capabilities.some(
			(id) => typeof id !== "string" || !id || id.length > 200,
		)
	)
		throw new Error(
			"runtime capability snapshot response is invalid or expired",
		);
  const { snapshotDigest, ...unsigned } = record;
  const expected = `sha256:${createHash("sha256").update(canonicalize(unsigned)).digest("hex")}`;
	if (snapshotDigest !== expected)
		throw new Error("runtime capability snapshot digest mismatch");
  return record as unknown as RuntimeCapabilitySnapshot;
}
