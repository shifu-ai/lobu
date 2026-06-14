import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { encrypt, type SecretRef, type WorkerTokenData } from "@lobu/core";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";
import { McpProxy } from "../auth/mcp/proxy.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

class OrgScopedWritableStore implements WritableSecretStore {
	private readonly entries = new Map<string, string>();

	constructor(private readonly organizationId: string) {}

	async get(ref: SecretRef): Promise<string | null> {
		if (tryGetOrgId() !== this.organizationId) return null;
		if (!ref.startsWith("secret://")) return null;
		const name = decodeURIComponent(ref.slice("secret://".length));
		return this.entries.get(name) ?? null;
	}

	async put(name: string, value: string): Promise<SecretRef> {
		this.entries.set(name, value);
		return `secret://${encodeURIComponent(name)}` as SecretRef;
	}

	async delete(nameOrRef: string): Promise<void> {
		const name = nameOrRef.startsWith("secret://")
			? decodeURIComponent(nameOrRef.slice("secret://".length))
			: nameOrRef;
		this.entries.delete(name);
	}

	async list(prefix?: string): Promise<SecretListEntry[]> {
		if (tryGetOrgId() !== this.organizationId) return [];
		return Array.from(this.entries.keys())
			.filter((name) => !prefix || name.startsWith(prefix))
			.map((name) => ({
				ref: `secret://${encodeURIComponent(name)}` as SecretRef,
				backend: "memory",
				name,
				updatedAt: Date.now(),
			}));
	}
}

function createWorkerToken(data: Omit<WorkerTokenData, "timestamp">): string {
	return encrypt(JSON.stringify({ ...data, timestamp: Date.now() }));
}

describe("McpProxy org context", () => {
	const originalFetch = globalThis.fetch;
	const originalEncryptionKey = process.env.ENCRYPTION_KEY;

	beforeAll(() => {
		process.env.ENCRYPTION_KEY =
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterAll(() => {
		if (originalEncryptionKey === undefined) {
			delete process.env.ENCRYPTION_KEY;
		} else {
			process.env.ENCRYPTION_KEY = originalEncryptionKey;
		}
	});

	test("resolves org-scoped MCP credentials from the worker token organization", async () => {
		const orgId = "org-mcp-proxy-test";
		const mcpId = "test-mcp";
		const agentId = "agent1";
		const userId = "user1";
		const store = new OrgScopedWritableStore(orgId);
		await store.put(
			`mcp-auth/${agentId}/${userId}/${mcpId}/credential`,
			JSON.stringify({
				accessToken: "oauth-access-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() + 60 * 60 * 1000,
				clientId: "client-id",
				tokenUrl: "https://auth.example/token",
				tokenEndpointAuthMethod: "none",
			}),
		);
		const token = createWorkerToken({
			userId,
			conversationId: "conv1",
			deploymentName: "deploy1",
			channelId: "ch1",
			agentId,
			organizationId: orgId,
		});
		const proxy = new McpProxy(
			{
				getHttpServer: async () => ({
					id: mcpId,
					upstreamUrl: "https://upstream.example/mcp",
				}),
				getAllHttpServers: async () => new Map(),
			},
			{ secretStore: store },
		);

		let capturedAuthorization: string | null = null;
		globalThis.fetch = async (_url, init) => {
			capturedAuthorization = new Headers(init?.headers).get("Authorization");
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{ type: "text", text: "ok" }],
						isError: false,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		const res = await proxy.getApp().request(`/${mcpId}/tools/my_tool`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ arg1: "value1" }),
		});

		expect(res.status).toBe(200);
		expect(capturedAuthorization).toBe("Bearer oauth-access-token");
	});
});
