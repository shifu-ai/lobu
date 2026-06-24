import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
