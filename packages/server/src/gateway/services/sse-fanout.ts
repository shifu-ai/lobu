/**
 * SseFanout — cross-replica delivery for ephemeral SSE events.
 *
 * `SseManager` is per-pod and in-memory: a broadcast only reaches clients
 * whose SSE connection lives on the broadcasting pod. But the event producers
 * — the thread_response consumer (deltas/status) and the
 * InteractionService→api bridge (ask_user/approvals) — run on whichever
 * replica claimed the work or spawned the worker, independent of the ClientIP
 * affinity that pins a client's SSE to one pod. So under N>1 replicas an event
 * produced on pod A is silently dropped when the client's SSE is on pod S.
 *
 * This bridges that gap with Postgres LISTEN/NOTIFY: every broadcast is
 * published on a single `sse_fanout` channel, and each replica re-delivers the
 * events it did NOT originate to its own local connections. It is the minimal
 * cross-pod transport — it reuses the shared listener socket the runs queue and
 * caches already multiplex onto (see `getDbListener`), needs no new table, and
 * is best-effort by design (durable terminal delivery stays on the
 * thread_response owner-gate in `unified-thread-consumer`).
 *
 * Scaling note: this is a broadcast — every replica sees every event and drops
 * the ones it can't serve. That is fine at the replica counts we run. For very
 * large N the next step is targeted delivery via a durable SSE-session→pod
 * registry; swapping the publisher/subscriber here needs no broadcast
 * call-site changes (`SseManager` only knows the `SseFanoutPublisher` callback).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import { getDb, getDbListener } from "../../db/client.js";
import type { SseEvent, SseManager } from "./sse-manager.js";

const logger = createLogger("sse-fanout");

const CHANNEL = "sse_fanout";
// Postgres caps NOTIFY payloads at 8000 bytes; stay well under to leave room
// for JSON framing. Oversized events fall back to local-only delivery (deltas
// and interaction events are tiny and never approach this).
const MAX_PAYLOAD_BYTES = 7000;

interface FanoutMessage {
	/** Per-process id of the publishing replica — receivers skip their own. */
	origin: string;
	agentId: string;
	event: string;
	data: unknown;
	/** Original event timestamp, preserved for cross-pod backlog ordering. */
	ts: number;
}

export class SseFanout {
	private readonly origin = randomUUID();
	private subscription?: { unlisten: () => Promise<unknown> };

	constructor(private readonly sseManager: SseManager) {}

	async start(): Promise<void> {
		this.sseManager.setPublisher((agentId, entry) =>
			this.publish(agentId, entry),
		);
		try {
			this.subscription = await getDbListener().listen(CHANNEL, (payload) =>
				this.onNotify(payload),
			);
			logger.debug(`LISTEN ${CHANNEL} (origin=${this.origin})`);
		} catch (err) {
			// Fail open: without LISTEN, fan-out is disabled and broadcasts stay
			// local-only — identical to single-replica behavior. (A transaction-mode
			// pooler drops LISTEN; the boot probe already surfaces that condition.)
			logger.warn(
				`SSE fan-out LISTEN failed; cross-pod SSE delivery disabled: ${
					(err as Error).message
				}`,
			);
		}
	}

	async stop(): Promise<void> {
		this.sseManager.setPublisher(undefined);
		if (this.subscription) {
			try {
				await this.subscription.unlisten();
			} catch {
				// ignore — shutting down
			}
			this.subscription = undefined;
		}
	}

	/** Publish a locally-broadcast event to peer replicas (fire-and-forget). */
	private publish(agentId: string, entry: SseEvent): void {
		const message: FanoutMessage = {
			origin: this.origin,
			agentId,
			event: entry.event,
			data: entry.data,
			ts: entry.timestamp,
		};
		let payload: string;
		try {
			payload = JSON.stringify(message);
		} catch {
			return; // non-serializable payload; local delivery already happened
		}
		if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
			logger.debug(
				`SSE fan-out skipped oversized "${entry.event}" for ${agentId}`,
			);
			return;
		}
		// broadcast() is synchronous and best-effort, so this NOTIFY is
		// fire-and-forget; failures only cost one ephemeral event.
		void getDb()`SELECT pg_notify(${CHANNEL}, ${payload})`.catch(
			(err: Error) => {
				logger.debug(`SSE fan-out NOTIFY failed: ${err.message}`);
			},
		);
	}

	/** Re-deliver a peer's event to this pod's local connections. */
	private onNotify(payload: unknown): void {
		if (typeof payload !== "string" || payload.length === 0) return;
		let message: FanoutMessage;
		try {
			message = JSON.parse(payload) as FanoutMessage;
		} catch {
			return;
		}
		// Skip our own NOTIFYs — broadcast() already delivered them locally.
		if (!message || message.origin === this.origin) return;
		this.sseManager.deliverFromPeer(message.agentId, {
			event: message.event,
			data: message.data,
			timestamp: message.ts,
		});
	}
}
