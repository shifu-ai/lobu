import { Hono } from "hono";
import { compareWorkerToken } from "../auth/worker-token.js";
import type { WritableSecretStore } from "../gateway/secrets/index.js";
import {
	createLobuConfigStatusService,
	LobuConfigStatusError,
	type LobuConfigStatusService,
	type LobuConfigStatusStore,
	type LobuOAuthStatusProvider,
} from "./config-status-service.js";
import { isValidAgentId } from "./stores/postgres-stores.js";

export interface LobuConfigStatusRouteDeps {
	token?: string;
	store?: LobuConfigStatusStore;
	oauthStatusProvider?: LobuOAuthStatusProvider;
	secretStore?: WritableSecretStore;
	getSecretStore?: () => WritableSecretStore | undefined;
	getCurrentStatus?: LobuConfigStatusService["getCurrentStatus"];
}

const SHIFU_USER_AGENT_ID_PATTERN = /^shifu-u-[a-z0-9-]+$/;

function bearerToken(header: string | undefined): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
	return match?.[1] ?? null;
}

function requestToken(headers: Headers): string | null {
	return bearerToken(headers.get("authorization") ?? undefined) ?? headers.get("x-internal-token");
}

function tokenMatches(provided: string | null, expected: string | undefined): boolean {
	return compareWorkerToken(provided ?? undefined, expected);
}

function isValidShifuAgentId(agentId: string): boolean {
	return isValidAgentId(agentId) && SHIFU_USER_AGENT_ID_PATTERN.test(agentId);
}

export function createLobuConfigStatusRoutes(deps: LobuConfigStatusRouteDeps = {}) {
	const app = new Hono();
	const service = deps.getCurrentStatus
		? { getCurrentStatus: deps.getCurrentStatus }
		: createLobuConfigStatusService({
				store: deps.store,
				oauthStatusProvider: deps.oauthStatusProvider,
				secretStore: deps.secretStore,
				getSecretStore: deps.getSecretStore,
			});

	app.get("/current", async (c) => {
		if (!tokenMatches(requestToken(c.req.raw.headers), deps.token)) {
			return c.json({ error: "unauthorized" }, 401);
		}

		const agentId = c.req.query("agentId")?.trim() ?? "";
		const userId = c.req.query("userId")?.trim() ?? "";
		if (!isValidShifuAgentId(agentId) || !userId) {
			return c.json({ error: "agentId and userId are required" }, 400);
		}

		try {
			return c.json(await service.getCurrentStatus({ agentId, userId }));
		} catch (error) {
			if (error instanceof LobuConfigStatusError) {
				return c.json({ error: error.code }, 404);
			}
			throw error;
		}
	});

	return app;
}
