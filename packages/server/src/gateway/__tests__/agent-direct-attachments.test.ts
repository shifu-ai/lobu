import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	messageText: string;
	platformMetadata: {
		files?: Array<{
			name: string;
			mimetype: string;
			size: number;
			downloadUrl: string;
		}>;
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
	test("publishes an image file and forwards it as platformMetadata.files", async () => {
		const { app, enqueued } = makeApp();
		const imageBytes = Buffer.from("png-bytes");
		const form = new FormData();
		form.set("content", "User sent an image.");
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
		expect(enqueued[0].messageText).toBe("User sent an image.");
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

	test("transcribes audio uploads and preserves artifact metadata", async () => {
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
		form.set("content", "User sent a voice note.");
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
			"User sent a voice note.\n\n[Voice message]: please review my schedule",
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
