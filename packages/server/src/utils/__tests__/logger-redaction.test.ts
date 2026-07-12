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

		const sensitiveHeaderNames = [
			"authorization",
			"cookie",
			"set-cookie",
			"x-internal-secret",
			"proxy-authorization",
			"x-lobu-memory-direct-auth",
			"x-telegram-bot-api-secret-token",
			"x-lobu-worker-token",
			"x-internal-token",
			"x-api-key",
			"x-goog-api-key",
		] as const;
		const secretFixtures = sensitiveHeaderNames.map(
			(name) => `secret-fixture-${name}`,
		);

		const app = new Hono();
		app.use("*", pinoLogger({ pino: logger }));
		app.get("/logged", (c) => {
			for (const [index, name] of sensitiveHeaderNames.entries()) {
				c.header(name, secretFixtures[index]);
			}
			return c.text("ok");
		});

		await app.request("/logged", {
			headers: {
				Authorization: secretFixtures[0],
				Cookie: secretFixtures[1],
				"Set-Cookie": secretFixtures[2],
				"X-Internal-Secret": secretFixtures[3],
				"Proxy-Authorization": secretFixtures[4],
				"X-Lobu-Memory-Direct-Auth": secretFixtures[5],
				"X-Telegram-Bot-Api-Secret-Token": secretFixtures[6],
				"X-Lobu-Worker-Token": secretFixtures[7],
				"X-Internal-Token": secretFixtures[8],
				"X-Api-Key": secretFixtures[9],
				"X-Goog-Api-Key": secretFixtures[10],
			},
		});

		const completedLine = lines.find((line) =>
			line.includes("Request completed"),
		);
		expect(completedLine).toBeDefined();
		expect(completedLine).toContain("[Redacted]");
		expect(completedLine).toContain('"method":"GET"');
		expect(completedLine).toContain('"status":200');
		const completedLog = JSON.parse(completedLine as string) as {
			req: { headers: Record<string, string> };
			res: { headers: Record<string, string> };
		};
		for (const name of sensitiveHeaderNames) {
			expect(completedLog.req.headers).toHaveProperty(name, "[Redacted]");
			expect(completedLog.res.headers).toHaveProperty(name, "[Redacted]");
		}
		for (const secret of secretFixtures) {
			expect(completedLine).not.toContain(secret);
		}
	});
});
