import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorkerToken } from "@lobu/core";
import { verifyWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { createGatewayApp } from "../cli/gateway.js";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const AUTH_TOKEN = "test-org-token";
const AGENT_ID = "shifu-u-media-test";
const CONVERSATION_ID = `${AGENT_ID}_user-test_org-test`;
const TEST_ENCRYPTION_KEY = Buffer.from(
	"12345678901234567890123456789012",
).toString("base64");

let tempDir = "";
let previousEncryptionKey: string | undefined;

interface EnqueuedMessage {
	messageId: string;
	messageText: string;
	platformMetadata: {
		agentId?: string;
		source?: string;
		sessionReset?: boolean;
		files?: Array<{
			name: string;
			mimetype: string;
			size: number;
			downloadUrl: string;
		}>;
		line?: {
			messageId?: string;
			mediaType?: string;
		};
		automationModificationContext?: Record<string, unknown>;
	};
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "lobu-direct-attachments-"));
	process.env.LOBU_ARTIFACTS_DIR = tempDir;
	previousEncryptionKey = process.env.ENCRYPTION_KEY;
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	setAuthProvider((c) => {
		const authHeader = c.req.header("Authorization");
		const token = authHeader?.startsWith("Bearer ")
			? authHeader.substring(7)
			: null;
		if (token !== AUTH_TOKEN) return null;
		return {
			userId: "user-test",
			organizationId: "org-test",
			platform: "api",
			exp: Date.now() + 60_000,
		};
	});
});

afterEach(async () => {
	setAuthProvider(null);
	delete process.env.LOBU_ARTIFACTS_DIR;
	if (previousEncryptionKey === undefined) {
		delete process.env.ENCRYPTION_KEY;
	} else {
		process.env.ENCRYPTION_KEY = previousEncryptionKey;
	}
	await rm(tempDir, { recursive: true, force: true });
});

function makeApp(overrides: Record<string, unknown> = {}) {
	const enqueued: EnqueuedMessage[] = [];
	const sessions = new Map<string, Record<string, unknown>>([
		[
			CONVERSATION_ID,
			{
				agentId: AGENT_ID,
				conversationId: CONVERSATION_ID,
				userId: "user-test",
				channelId: "api_user-test",
				organizationId: "org-test",
				provider: "claude",
			},
		],
	]);

	const app = createAgentApi({
		queueProducer: {
			enqueueMessage: mock(async (payload: EnqueuedMessage) => {
				enqueued.push(payload);
				return `job-${randomUUID()}`;
			}),
		} as never,
		sessionManager: {
			getSession: mock(async (id: string) => sessions.get(id) || null),
			touchSession: mock(async () => undefined),
			setSession: mock(async (session: Record<string, unknown>) => {
				sessions.set(String(session.conversationId), session);
			}),
		} as never,
		sseManager: {} as never,
		publicGatewayUrl: "https://lobu.example",
		agentSettingsStore: {
			getSettings: mock(async () => undefined),
		} as never,
		agentMetadataStore: {
			getMetadata: mock(async () => ({
				owner: { platform: "api", userId: "user-test" },
				organizationId: "org-test",
			})),
		} as never,
		...overrides,
	});

	return { app, enqueued };
}

function makeGatewayApp(overrides: Record<string, unknown> = {}) {
	const enqueued: EnqueuedMessage[] = [];
	const transcriptionService = overrides.transcriptionService;
	const sessions = new Map<string, Record<string, unknown>>([
		[
			CONVERSATION_ID,
			{
				agentId: AGENT_ID,
				conversationId: CONVERSATION_ID,
				userId: "user-test",
				channelId: "api_user-test",
				organizationId: "org-test",
				provider: "claude",
			},
		],
	]);
	const coreServices = {
		getPublicGatewayUrl: () => "https://lobu.example",
		getQueueProducer: () => ({
			enqueueMessage: mock(async (payload: EnqueuedMessage) => {
				enqueued.push(payload);
				return `job-${randomUUID()}`;
			}),
		}),
		getSessionManager: () => ({
			getSession: mock(async (id: string) => sessions.get(id) || null),
			touchSession: mock(async () => undefined),
		}),
		getInteractionService: () => ({}),
		getSseManager: () => ({}),
		getAgentMetadataStore: () => ({
			getMetadata: mock(async () => ({
				owner: { platform: "api", userId: "user-test" },
				organizationId: "org-test",
			})),
		}),
		getTranscriptionService: () => transcriptionService,
		getBedrockOpenAIService: () => undefined,
		getSecretStore: () => undefined,
		getMcpConfigService: () => undefined,
		getImageGenerationService: () => undefined,
		getGrantStore: () => undefined,
		getMcpProxy: () => undefined,
		getExternalAuthClient: () => undefined,
		getAgentSettingsStore: () => undefined,
		getConfigStore: () => undefined,
		getUserAgentsStore: () => undefined,
		getAuthProfilesManager: () => undefined,
		getOAuthStateStore: () => undefined,
		getProviderRegistryService: () => undefined,
		getWorkerGateway: () => undefined,
		getQueue: () => undefined,
		getProviderCatalogService: () => undefined,
		getChannelBindingService: () => undefined,
	};
	const app = createGatewayApp({
		secretProxy: null,
		workerGateway: null,
		mcpProxy: null,
		coreServices,
		authProvider: (c) => {
			const authHeader = c.req.header("Authorization");
			const token = authHeader?.startsWith("Bearer ")
				? authHeader.substring(7)
				: null;
			if (token !== AUTH_TOKEN) return null;
			return {
				userId: "user-test",
				organizationId: "org-test",
				platform: "api",
				exp: Date.now() + 60_000,
			};
		},
	});

	return { app, enqueued };
}

describe("direct API multipart attachments", () => {
	test("mints trusted platform context privilege only for an admin PAT caller", async () => {
		const { app } = makeApp();
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			c.set("authSource", "pat");
			c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
			await next();
		});
		outer.route("/", app);
		const res = await outer.request("/api/v1/agents", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ agentId: AGENT_ID, userId: "gateway-user" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json() as { token: string };
		expect(verifyWorkerToken(body.token)?.trustedPlatformContext).toBe(true);
	});

	test("does not mint trusted platform context privilege for a non-admin PAT", async () => {
		const { app } = makeApp();
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			c.set("authSource", "pat");
			c.set("mcpAuthInfo", { scopes: ["mcp:read"] });
			await next();
		});
		outer.route("/", app);
		const res = await outer.request("/api/v1/agents", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ agentId: AGENT_ID, userId: "ordinary-user" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json() as { token: string };
		expect(verifyWorkerToken(body.token)?.trustedPlatformContext).toBe(false);
	});

	test("strips forged automation modification context from an ordinary session caller", async () => {
		const { app, enqueued } = makeApp();
		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${AUTH_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: "改成每小時",
					platformMetadata: {
						automationModificationContext: {
							decisionId: "forged-decision",
							planId: "forged-plan",
							display: {
								title: "偽造卡片",
								summary: "偽造內容",
								schedule: "每小時",
								reason: "偽造原因",
							},
							expiresAt: "2099-07-14T12:15:00.000Z",
							trustedByServer: true,
						},
					},
				}),
			},
		);

		expect(res.status).toBe(200);
		expect(enqueued[0]?.messageText).toBe("改成每小時");
		expect(enqueued[0]?.platformMetadata.automationModificationContext).toBeUndefined();
	});

	test("stamps automation modification context only for a privileged server-minted session", async () => {
		const { app, enqueued } = makeApp();
		const token = generateWorkerToken(
			"user-test",
			CONVERSATION_ID,
			"api-shifu-u",
			{
				channelId: "api_user-test",
				agentId: AGENT_ID,
				organizationId: "org-test",
				platform: "api",
				tokenKind: "session",
				trustedPlatformContext: true,
			},
		);
		const context = {
			decisionId: "decision-selected",
			planId: "plan-selected",
			display: {
				title: "週一課程摘要",
				summary: "整理課程進度",
				schedule: "每週一上午 8:30",
				reason: "週會前掌握狀況",
			},
			expiresAt: "2099-07-14T12:15:00.000Z",
			trustedByServer: false,
		};
		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: "改成每小時",
					platformMetadata: { automationModificationContext: context },
				}),
			},
		);

		expect(res.status).toBe(200);
		expect(enqueued[0]?.platformMetadata.automationModificationContext).toEqual({
			...context,
			trustedByServer: true,
		});
	});

	test("forwards direct API platformMetadata for session reset messages", async () => {
		const { app, enqueued } = makeApp();

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${AUTH_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: "Reset this LINE conversation context.",
					messageId: "lobu-msg-clear",
					platformMetadata: {
						source: "line-clear-command",
						sessionReset: true,
					},
				}),
			},
		);

		expect(res.status).toBe(200);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toMatchObject({
			messageId: "lobu-msg-clear",
			messageText: "Reset this LINE conversation context.",
		});
		expect(enqueued[0].platformMetadata).toMatchObject({
			agentId: AGENT_ID,
			source: "line-clear-command",
			sessionReset: true,
		});
	});

	test("accepts an attachment-only image and forwards it as platformMetadata.files", async () => {
		const { app, enqueued } = makeApp();
		const imageBytes = Buffer.from("png-bytes");
		const form = new FormData();
		form.set("content", "");
		form.set("messageId", "lobu-msg-image");
		form.set("line.messageId", "line-msg-image");
		form.set("line.mediaType", "image");
		form.append(
			"files",
			new File([imageBytes], "line_msg_image.png", {
				type: "image/png",
			}),
		);

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
				body: form,
			},
		);

		expect(res.status).toBe(200);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toMatchObject({ messageId: "lobu-msg-image" });
		expect(enqueued[0].messageText).toBe("");
		expect(enqueued[0].platformMetadata.line).toEqual({
			messageId: "line-msg-image",
			mediaType: "image",
		});
		expect(enqueued[0].platformMetadata.files).toHaveLength(1);
		expect(enqueued[0].platformMetadata.files[0]).toMatchObject({
			name: "line_msg_image.png",
			mimetype: "image/png",
			size: imageBytes.length,
		});
		expect(enqueued[0].platformMetadata.files[0].downloadUrl).toContain(
			"/api/v1/files/",
		);
		expect(enqueued[0].platformMetadata.files[0].downloadUrl).toContain(
			"token=",
		);
	});

	test("accepts attachment-only audio, transcribes it, and preserves artifact metadata", async () => {
		const audioBytes = Buffer.from("ogg-audio-bytes");
		const transcriptionService = {
			transcribe: mock(
				async (buffer: Buffer, agentId: string, mimeType: string) => {
					expect(buffer.equals(audioBytes)).toBe(true);
					expect(agentId).toBe(AGENT_ID);
					expect(mimeType).toBe("audio/ogg");
					return { text: "please review my schedule", provider: "openai" };
				},
			),
		};
		const { app, enqueued } = makeApp({ transcriptionService });
		const form = new FormData();
		form.append(
			"files",
			new File([audioBytes], "line_voice.ogg", {
				type: "audio/ogg",
			}),
		);

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
				body: form,
			},
		);

		expect(res.status).toBe(200);
		expect(transcriptionService.transcribe).toHaveBeenCalledTimes(1);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].messageText).toBe(
			"[Voice message]: please review my schedule",
		);
		expect(enqueued[0].platformMetadata.files).toHaveLength(1);
		expect(enqueued[0].platformMetadata.files[0]).toMatchObject({
			name: "line_voice.ogg",
			mimetype: "audio/ogg",
			size: audioBytes.length,
		});
	});

	test("uses the gateway core transcription service for direct audio uploads", async () => {
		const audioBytes = Buffer.from("gateway-ogg-audio-bytes");
		const transcriptionService = {
			transcribe: mock(async () => ({
				text: "gateway routed transcript",
				provider: "openai",
			})),
		};
		const { app, enqueued } = makeGatewayApp({ transcriptionService });
		const form = new FormData();
		form.set("content", "User sent a voice note.");
		form.append(
			"files",
			new File([audioBytes], "gateway_voice.ogg", {
				type: "audio/ogg",
			}),
		);

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
				body: form,
			},
		);

		expect(res.status).toBe(200);
		expect(transcriptionService.transcribe).toHaveBeenCalledTimes(1);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].messageText).toBe(
			"User sent a voice note.\n\n[Voice message]: gateway routed transcript",
		);
		expect(enqueued[0].platformMetadata.files).toHaveLength(1);
	});

	test("still rejects JSON requests without content", async () => {
		const { app, enqueued } = makeApp();

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${AUTH_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			success: false,
			error: "content is required",
		});
		expect(enqueued).toHaveLength(0);
	});

	test("still rejects empty multipart requests without files", async () => {
		const { app, enqueued } = makeApp();
		const form = new FormData();
		form.set("content", "");

		const res = await app.request(
			`/api/v1/agents/${CONVERSATION_ID}/messages`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
				body: form,
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			success: false,
			error: "content is required",
		});
		expect(enqueued).toHaveLength(0);
	});

	test("warns and keeps original text plus artifacts when transcription returns an error", async () => {
		const warnSpy = mock(() => {});
		const previousWarn = console.warn;
		console.warn = warnSpy as never;
		try {
			const audioBytes = Buffer.from("ogg-audio-bytes");
			const transcriptionService = {
				transcribe: mock(async () => ({ error: "No provider configured" })),
			};
			const { app, enqueued } = makeApp({ transcriptionService });
			const form = new FormData();
			form.set("content", "Original voice note caption.");
			form.append(
				"files",
				new File([audioBytes], "line_voice.ogg", {
					type: "audio/ogg",
				}),
			);

			const res = await app.request(
				`/api/v1/agents/${CONVERSATION_ID}/messages`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
					body: form,
				},
			);

			expect(res.status).toBe(200);
			expect(transcriptionService.transcribe).toHaveBeenCalledTimes(1);
			expect(enqueued).toHaveLength(1);
			expect(enqueued[0].messageText).toBe("Original voice note caption.");
			expect(enqueued[0].platformMetadata.files).toHaveLength(1);
			expect(enqueued[0].platformMetadata.files[0]).toMatchObject({
				name: "line_voice.ogg",
				mimetype: "audio/ogg",
				size: audioBytes.length,
			});
			expect(warnSpy).toHaveBeenCalled();
			expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
				"Direct API audio transcription returned an error",
			);
		} finally {
			console.warn = previousWarn;
		}
	});
});
