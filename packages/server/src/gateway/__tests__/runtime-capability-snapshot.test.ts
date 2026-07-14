import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "bun:test";
import { canonicalize } from "json-canonicalize";
import {
	fetchRuntimeCapabilitySnapshot,
	resetRuntimeCapabilitySnapshotCacheForTests,
	resolveRuntimeCapabilitySnapshot,
} from "../services/runtime-capability-snapshot.js";

function envelope(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    schemaVersion: 1,
    environment: "production",
    toolboxUserId: "user-1",
    agentId: "agent-1",
    capabilities: ["personal_reminder_delivery.v1"],
    appliedReleaseId: "release-3",
    appliedReleaseSequence: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  return {
    ...unsigned,
    snapshotDigest: `sha256:${createHash("sha256").update(canonicalize(unsigned)).digest("hex")}`,
  };
}

describe("runtime capability snapshot transport", () => {
  test("caches by exact identity only until the lesser configured TTL or expiry", async () => {
    resetRuntimeCapabilitySnapshotCacheForTests();
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(envelope())),
		);
		const request = {
			environment: "production" as const,
			toolboxUserId: "user-1",
			agentId: "agent-1",
		};
		const options = {
			url: "https://toolbox.test",
			secret: "secret",
			fetchImpl,
			cacheTtlMs: 30_000,
		};
    await resolveRuntimeCapabilitySnapshot(request, options);
    await resolveRuntimeCapabilitySnapshot(request, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
		await resolveRuntimeCapabilitySnapshot(
			{ ...request, agentId: "agent-2" },
			{
      ...options,
				fetchImpl: vi.fn(
					async () =>
						new Response(JSON.stringify(envelope({ agentId: "agent-2" }))),
				),
			},
		);
  });
  test("posts the exact three-field server-only request and accepts a closed digest-bound envelope", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(envelope())),
		);
		const result = await fetchRuntimeCapabilitySnapshot(
			{
      environment: "production",
      toolboxUserId: "user-1",
      agentId: "agent-1",
			},
			{
      url: "https://toolbox.test/internal/runtime-capabilities",
      secret: "server-secret",
      fetchImpl,
			},
		);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://toolbox.test/internal/runtime-capabilities");
		expect(init?.headers).toEqual({
			"content-type": "application/json",
			"x-internal-secret": "server-secret",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			environment: "production",
			toolboxUserId: "user-1",
			agentId: "agent-1",
		});
    expect(result.appliedReleaseId).toBe("release-3");
  });

  test.each([
    ["extra response field", { extra: true }],
    ["wrong environment", { environment: "staging" }],
    ["wrong user", { toolboxUserId: "other" }],
    ["wrong agent", { agentId: "other" }],
    ["expired", { expiresAt: new Date(Date.now() - 1_000).toISOString() }],
  ])("fails closed for %s", async (_name, overrides) => {
    const value = envelope(overrides);
    if ("extra" in overrides) {
      // digest includes the extra key, proving closed-schema validation is independent.
    }
		await expect(
			fetchRuntimeCapabilitySnapshot(
				{
					environment: "production",
					toolboxUserId: "user-1",
					agentId: "agent-1",
				},
				{
      url: "https://toolbox.test/internal/runtime-capabilities",
      secret: "server-secret",
      fetchImpl: async () => new Response(JSON.stringify(value)),
				},
			),
		).rejects.toThrow();
  });

  test("rejects a bad digest and local as a transport environment", async () => {
		await expect(
			fetchRuntimeCapabilitySnapshot(
				{
					environment: "production",
					toolboxUserId: "user-1",
					agentId: "agent-1",
				},
				{
      url: "https://toolbox.test/internal/runtime-capabilities",
      secret: "server-secret",
					fetchImpl: async () =>
						new Response(
							JSON.stringify({
								...envelope(),
								snapshotDigest: `sha256:${"0".repeat(64)}`,
							}),
						),
				},
			),
		).rejects.toThrow(/digest/i);
		await expect(
			fetchRuntimeCapabilitySnapshot(
				{
					environment: "local" as never,
					toolboxUserId: "user-1",
					agentId: "agent-1",
				},
				{
					url: "https://toolbox.test/internal/runtime-capabilities",
					secret: "server-secret",
				},
			),
		).rejects.toThrow(/environment/i);
	});

	test("accepts the exact 60s expiry boundary and rejects farther future snapshots", async () => {
		const now = new Date("2026-07-15T00:00:00.000Z");
		const request = {
			environment: "production" as const,
			toolboxUserId: "user-1",
			agentId: "agent-1",
		};
		await expect(
			fetchRuntimeCapabilitySnapshot(request, {
				url: "https://toolbox.test",
				secret: "secret",
				now: () => now,
				fetchImpl: async () =>
					new Response(
						JSON.stringify(
							envelope({
								expiresAt: new Date(now.getTime() + 60_000).toISOString(),
							}),
						),
					),
			}),
		).resolves.toMatchObject({ expiresAt: "2026-07-15T00:01:00.000Z" });
		await expect(
			fetchRuntimeCapabilitySnapshot(request, {
				url: "https://toolbox.test",
				secret: "secret",
				now: () => now,
				fetchImpl: async () =>
					new Response(
						JSON.stringify(
							envelope({
								expiresAt: new Date(now.getTime() + 60_001).toISOString(),
							}),
						),
					),
			}),
		).rejects.toThrow(/invalid or expired/);
	});

	test("never serves a cached snapshot across its expiry", async () => {
		resetRuntimeCapabilitySnapshotCacheForTests();
		let nowMs = Date.parse("2026-07-15T00:00:00.000Z");
		let calls = 0;
		const request = {
			environment: "production" as const,
			toolboxUserId: "user-1",
			agentId: "agent-1",
		};
		const options = {
			url: "https://toolbox.test",
			secret: "secret",
			cacheTtlMs: 60_000,
			now: () => new Date(nowMs),
			fetchImpl: async () => {
				calls += 1;
				return new Response(
					JSON.stringify(
						envelope({
							expiresAt: new Date(
								nowMs + (calls === 1 ? 20_000 : 60_000),
							).toISOString(),
							appliedReleaseId: calls === 1 ? "release-3" : "release-4",
							appliedReleaseSequence: calls === 1 ? 3 : 4,
						}),
					),
				);
			},
		};
		await resolveRuntimeCapabilitySnapshot(request, options);
		nowMs += 19_999;
		expect(
			(await resolveRuntimeCapabilitySnapshot(request, options))
				.appliedReleaseId,
		).toBe("release-3");
		nowMs += 1;
		expect(
			(await resolveRuntimeCapabilitySnapshot(request, options))
				.appliedReleaseId,
		).toBe("release-4");
		expect(calls).toBe(2);
  });
});
