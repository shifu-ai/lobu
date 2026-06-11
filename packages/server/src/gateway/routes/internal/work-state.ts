#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { IMessageQueue } from "../../infrastructure/queue/types.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("internal-work-state-routes");

interface WorkStateEvent {
  type: "human_input.requested";
  version: 1;
  eventId: string;
  decisionId?: string;
  agentId: string;
  conversationId: string;
  channel: string;
  title: string;
  prompt: string;
  allowCustomResponse: true;
  options: unknown[];
  createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseWorkStateEvent(input: unknown): WorkStateEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Work-state event must be an object");
  }
  const event = input as Partial<WorkStateEvent>;
  if (event.type !== "human_input.requested") {
    throw new Error("Unsupported work-state event type");
  }
  if (event.version !== 1) {
    throw new Error("Unsupported work-state event version");
  }
  for (const field of [
    "eventId",
    "agentId",
    "conversationId",
    "channel",
    "title",
    "prompt",
    "createdAt",
  ] as const) {
    if (!isNonEmptyString(event[field])) {
      throw new Error(`Work-state event requires ${field}`);
    }
  }
  if (event.allowCustomResponse !== true) {
    throw new Error("Work-state event must allow a custom response");
  }
  if (!Array.isArray(event.options) || event.options.length === 0) {
    throw new Error("Work-state event requires options");
  }
  return event as WorkStateEvent;
}

export function createWorkStateRoutes(
  queueProducer: Pick<IMessageQueue, "send">
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  router.post("/internal/work-state/events", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const parsed = parseWorkStateEvent(await c.req.json());

      if (parsed.conversationId !== worker.conversationId) {
        return errorResponse(c, "conversationId does not match worker token", 400);
      }
      if (worker.agentId && parsed.agentId !== worker.agentId) {
        return errorResponse(c, "agentId does not match worker token", 400);
      }

      const channelId = worker.channelId || parsed.channel;
      const platform = worker.platform || parsed.channel || "unknown";
      const payload = {
        messageId: parsed.eventId,
        channelId,
        conversationId: worker.conversationId,
        userId: worker.userId,
        teamId: worker.teamId,
        platform,
        timestamp: Date.now(),
        customEvent: {
          name: "shifu.work_state",
          data: parsed,
        },
      };

      const id = await queueProducer.send("thread_response", payload);
      return c.json({ id, status: "queued" });
    } catch (error) {
      logger.error("Failed to enqueue work-state event:", error);
      const message =
        error instanceof Error ? error.message : "Invalid work-state event";
      return errorResponse(c, message, 400);
    }
  });

  logger.debug("Internal work-state routes registered");
  return router;
}
