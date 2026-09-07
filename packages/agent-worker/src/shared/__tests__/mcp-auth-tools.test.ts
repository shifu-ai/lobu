import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	checkMcpLogin,
	startMcpLogin,
	type GatewayParams,
	type ToolContentResult,
} from "../tool-implementations";

const GW: GatewayParams = {
	gatewayUrl: "http://gateway.internal:8080",
	workerToken: "test-token",
} as GatewayParams;

let originalFetch: typeof globalThis.fetch;

function stubGateway(
	startBody: unknown,
	statusBody: unknown = { authenticated: false },
) {
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url.includes("/internal/device-auth/status")) {
			return Response.json(statusBody);
		}
		if (url.includes("/internal/device-auth/start")) {
			return Response.json(startBody);
		}
		if (url.includes("/internal/interactions")) {
			return Response.json({ id: "int-1" });
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function parseResult(result: ToolContentResult) {
	const text = result.content.find((part) => part.type === "text")?.text;
	if (!text) throw new Error("Expected text result");
	return JSON.parse(text);
}

describe("startMcpLogin message copy", () => {
	test("auth_code fallback -> instructs agent to send the URL as plain text", async () => {
		stubGateway({
			flow: "auth_code",
			userCode: "",
			verificationUri: "https://gw.example.com/mcp/oauth/start?token=abc",
			verificationUriComplete:
				"https://gw.example.com/mcp/oauth/start?token=abc",
			expiresIn: 900,
		});
		const parsed = parseResult(await startMcpLogin(GW, { mcpId: "notion" }));
		expect(parsed.status).toBe("login_started");
		expect(parsed.verification_url).toContain("/mcp/oauth/start?token=abc");
		expect(parsed.message).toContain("plain text");
		expect(parsed.message).toContain(
			"https://gw.example.com/mcp/oauth/start?token=abc",
		);
		expect(parsed.message).toContain("notion_login_check");
		expect(parsed.message).not.toContain("Do not repeat the URL");
	});

	test("device flow -> also instructs plain-text send and includes user code", async () => {
		stubGateway({
			userCode: "ABCD-1234",
			verificationUri: "https://idp.example.com/device",
			verificationUriComplete:
				"https://idp.example.com/device?user_code=ABCD-1234",
			expiresIn: 600,
		});
		const parsed = parseResult(
			await startMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);
		expect(parsed.message).toContain("plain text");
		expect(parsed.message).toContain("ABCD-1234");
		expect(parsed.message).not.toContain("has been sent directly to the user");
	});

	test("reauth status from Lobu returns needs_reauth with the direct login link", async () => {
		stubGateway(
			{
				userCode: "SHOULD-NOT-START",
				verificationUri: "https://idp.example.com/device",
				expiresIn: 600,
			},
			{
				authenticated: false,
				status: "needs_reauth",
				reason: "upstream_rejected",
				upstreamError: "invalid_grant",
				login: {
					flow: "auth_code",
					verificationUri:
						"https://gw.example.com/mcp/oauth/start?token=reauth",
					verificationUriComplete:
						"https://gw.example.com/mcp/oauth/start?token=reauth",
					expiresIn: 900,
				},
			},
		);

		const parsed = parseResult(
			await startMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("needs_reauth");
		expect(parsed.authenticated).toBe(false);
		expect(parsed.upstream_error).toBe("invalid_grant");
		expect(parsed.verification_url).toContain("/mcp/oauth/start?token=reauth");
		expect(parsed.message).toContain("plain text");
		expect(parsed.message).toContain(
			"https://gw.example.com/mcp/oauth/start?token=reauth",
		);
	});

	test("reauth status without a login link directs the user to Agent Workbench tool connections", async () => {
		stubGateway(
			{
				userCode: "SHOULD-NOT-START",
				verificationUri: "https://idp.example.com/device",
				expiresIn: 600,
			},
			{
				authenticated: false,
				status: "needs_reauth",
				reason: "missing_login_url",
				upstreamError: "invalid_grant",
			},
		);

		const parsed = parseResult(
			await startMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("needs_reauth");
		expect(parsed.reason).toBe("missing_login_url");
		expect(parsed.upstream_error).toBe("invalid_grant");
		expect(parsed.verification_url).toBeUndefined();
		expect(parsed.message).toContain("Agent Workbench");
		expect(parsed.message).toContain("tool connections");
		expect(parsed.message).toContain("shifu-toolbox");
		expect(parsed.message).toContain("wait for confirmation before retrying");
		expect(parsed.message).not.toContain("https://");
		expect(parsed.message).not.toContain("plain text");
		expect(parsed.message).not.toContain("authorization link");
		expect(parsed.message).not.toContain("degraded");
		expect(parsed.message).not.toContain("retry later");
	});

	test("degraded preflight status with a login payload does not return direct reauth copy", async () => {
		stubGateway(
			{
				userCode: "SHOULD-NOT-START",
				verificationUri: "https://idp.example.com/device",
				expiresIn: 600,
			},
			{
				authenticated: false,
				status: "degraded",
				reason: "upstream_unavailable",
				login: {
					flow: "auth_code",
					verificationUri:
						"https://gw.example.com/mcp/oauth/start?token=degraded",
					verificationUriComplete:
						"https://gw.example.com/mcp/oauth/start?token=degraded",
					expiresIn: 900,
				},
			},
		);

		const parsed = parseResult(
			await startMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("degraded");
		expect(parsed.authenticated).toBe(false);
		expect(parsed.verification_url).toBeUndefined();
		expect(parsed.message).toContain("cannot be confirmed right now");
		expect(parsed.message).toContain("temporarily degraded");
		expect(parsed.message).not.toContain("needs to be refreshed");
		expect(parsed.message).not.toContain("reconnect");
		expect(parsed.message).not.toContain("Agent Workbench");
	});
});

describe("checkMcpLogin auth truth", () => {
	test("reauth status returns the login link instead of polling or already_authenticated", async () => {
		stubGateway(
			{ status: "pending" },
			{
				authenticated: false,
				status: "needs_reauth",
				reason: "no_refresh_token",
				login: {
					flow: "auth_code",
					verificationUri: "https://gw.example.com/mcp/oauth/start?token=check",
					verificationUriComplete:
						"https://gw.example.com/mcp/oauth/start?token=check",
					expiresIn: 900,
				},
			},
		);

		const parsed = parseResult(
			await checkMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("needs_reauth");
		expect(parsed.authenticated).toBe(false);
		expect(parsed.message).toContain(
			"https://gw.example.com/mcp/oauth/start?token=check",
		);
	});

	test("reauth status without a login link directs the user to Agent Workbench tool connections", async () => {
		stubGateway(
			{ status: "pending" },
			{
				authenticated: false,
				status: "needs_reauth",
				reason: "no_refresh_token",
			},
		);

		const parsed = parseResult(
			await checkMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("needs_reauth");
		expect(parsed.reason).toBe("no_refresh_token");
		expect(parsed.verification_url).toBeUndefined();
		expect(parsed.message).toContain("Agent Workbench");
		expect(parsed.message).toContain("tool connections");
		expect(parsed.message).toContain("shifu-toolbox");
		expect(parsed.message).toContain("wait for confirmation before retrying");
		expect(parsed.message).not.toContain("https://");
		expect(parsed.message).not.toContain("plain text");
		expect(parsed.message).not.toContain("authorization link");
		expect(parsed.message).not.toContain("degraded");
		expect(parsed.message).not.toContain("retry later");
	});

	test("transient degraded status with a login payload does not tell the user they definitely need to reconnect", async () => {
		stubGateway(
			{ status: "pending" },
			{
				authenticated: false,
				status: "degraded",
				reason: "upstream_error",
				login: {
					flow: "auth_code",
					verificationUri: "https://gw.example.com/mcp/oauth/start?token=check",
					verificationUriComplete:
						"https://gw.example.com/mcp/oauth/start?token=check",
					expiresIn: 900,
				},
			},
		);

		const parsed = parseResult(
			await checkMcpLogin(GW, { mcpId: "shifu-toolbox" }),
		);

		expect(parsed.status).toBe("degraded");
		expect(parsed.authenticated).toBe(false);
		expect(parsed.verification_url).toBeUndefined();
		expect(parsed.message).toContain("cannot be confirmed right now");
		expect(parsed.message).toContain("temporarily degraded");
		expect(parsed.message).not.toContain("needs to be refreshed");
		expect(parsed.message).not.toContain("reconnect");
		expect(parsed.message).not.toContain("Agent Workbench");
	});
});
