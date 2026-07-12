import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import logger from "../logger";

describe("HTTP logger redaction", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("redacts authentication headers from completed-request logs", async () => {
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});

		const app = new Hono();
		app.use("*", pinoLogger({ pino: logger }));
		app.get("/logged", (c) => {
			c.header("set-cookie", "session=secret-response-cookie");
			c.header("x-lobu-worker-token", "secret-worker-token");
			c.header("x-internal-token", "secret-internal-token");
			c.header("x-api-key", "secret-api-key");
			c.header("x-goog-api-key", "secret-google-api-key");
			return c.text("ok");
		});

		const secretFixtures = [
			"Bearer secret-authorization",
			"session=secret-request-cookie",
			"secret-internal",
			"Basic secret-proxy-authorization",
			"secret-direct-auth",
			"secret-telegram-token",
			"secret-worker-token",
			"secret-internal-token",
			"secret-api-key",
			"secret-google-api-key",
			"secret-response-cookie",
		];

		await app.request("/logged", {
			headers: {
				authorization: secretFixtures[0],
				cookie: secretFixtures[1],
				"x-internal-secret": secretFixtures[2],
				"proxy-authorization": secretFixtures[3],
				"x-lobu-memory-direct-auth": secretFixtures[4],
				"x-telegram-bot-api-secret-token": secretFixtures[5],
				"x-lobu-worker-token": secretFixtures[6],
				"x-internal-token": secretFixtures[7],
				"x-api-key": secretFixtures[8],
				"x-goog-api-key": secretFixtures[9],
			},
		});

		const completedLine = lines.find((line) =>
			line.includes("Request completed"),
		);
		expect(completedLine).toBeDefined();
		expect(completedLine).toContain("[Redacted]");
		expect(completedLine).toContain('"method":"GET"');
		expect(completedLine).toContain('"status":200');
		for (const secret of secretFixtures) {
			expect(completedLine).not.toContain(secret);
		}
	});
});
