/**
 * Integration test for SseFanout against a real Postgres LISTEN/NOTIFY.
 *
 * Reproduces the multi-replica gap: SSE events are broadcast on whichever pod
 * claimed the work (thread_response row / worker spawn), but the client's SSE
 * connection is pinned by ClientIP affinity to a possibly-different pod. With a
 * pod-local in-memory SseManager the event is silently dropped.
 *
 * Two SseManager+SseFanout pairs in one process (each with its own `origin`)
 * faithfully model two pods sharing one database: the fan-out NOTIFY is the
 * exact production transport (`pg_notify` over the shared listener socket), so
 * cross-pod delivery here proves the production guarantee.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SseFanout } from "../services/sse-fanout.js";
import { type SseConnection, SseManager } from "../services/sse-manager.js";
import { ensureDbForGatewayTests } from "./helpers/db-setup.js";

function fakeStream(): SseConnection & {
	events: Array<{ event: string; data: string }>;
} {
	const events: Array<{ event: string; data: string }> = [];
	return {
		events,
		writeSSE(payload) {
			events.push(payload);
		},
	} as SseConnection & { events: Array<{ event: string; data: string }> };
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`condition not met within ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

let podA: SseManager;
let podB: SseManager;
let fanoutA: SseFanout;
let fanoutB: SseFanout;

beforeAll(async () => {
	await ensureDbForGatewayTests();
	podA = new SseManager();
	podB = new SseManager();
	fanoutA = new SseFanout(podA);
	fanoutB = new SseFanout(podB);
	await fanoutA.start();
	await fanoutB.start();
});

afterAll(async () => {
	await fanoutA?.stop();
	await fanoutB?.stop();
});

describe("SseFanout cross-replica delivery", () => {
	test("a broadcast on pod A reaches a connection held on pod B", async () => {
		const stream = fakeStream();
		podB.addConnection("agent-cross", stream);

		podA.broadcast("agent-cross", "output", { content: "hello from A" });

		await waitFor(() => stream.events.length > 0);
		expect(stream.events).toHaveLength(1);
		expect(stream.events[0]?.event).toBe("output");
		expect(stream.events[0]?.data).toBe(
			JSON.stringify({ content: "hello from A" }),
		);
	});

	test("the originating pod does not double-deliver its own event", async () => {
		const onA = fakeStream();
		const onB = fakeStream();
		podA.addConnection("agent-dup", onA);
		podB.addConnection("agent-dup", onB);

		podA.broadcast("agent-dup", "output", { n: 1 });

		// B receives via fan-out; A delivered locally exactly once and must NOT
		// also re-deliver its own NOTIFY (origin-skip).
		await waitFor(() => onB.events.length > 0);
		await new Promise((r) => setTimeout(r, 100)); // allow any stray loopback
		expect(onA.events).toHaveLength(1);
		expect(onB.events).toHaveLength(1);
	});

	test("a peer event is dropped when no local connection exists (no backlog seeded)", async () => {
		// No connection for this agent on either pod.
		podA.broadcast("agent-orphan", "output", { n: 1 });

		// Give the NOTIFY time to round-trip, then confirm B did not seed backlog
		// for an agent it never served.
		await new Promise((r) => setTimeout(r, 150));
		expect(podB.getRecentEvents("agent-orphan")).toEqual([]);
	});
});
