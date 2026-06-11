#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import {
  type IMessageQueue,
  TERMINAL_DELIVERY_SEND_OPTS,
} from "../../infrastructure/queue/types.js";
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
  options: StructuredDecisionOption[];
  createdAt: string;
}

interface StructuredDecisionOption {
  value: string;
  label: string;
  tradeoff: string;
  recommended?: boolean;
  recommendationReason?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRecoverableDecisionOptions(
  options: unknown
): asserts options is StructuredDecisionOption[] {
  if (!Array.isArray(options)) {
    throw new Error("Recoverable decision options must be an array");
  }
  if (options.length !== 3) {
    throw new Error(
      "Recoverable decision options must include exactly 3 options"
    );
  }

  const recommended = options.filter(
    (option) =>
      option &&
      typeof option === "object" &&
      (option as StructuredDecisionOption).recommended === true
  );
  if (recommended.length !== 1) {
    throw new Error(
      "Recoverable decision options must include exactly one recommended option"
    );
  }

  for (const [index, option] of options.entries()) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(
        `Recoverable decision option ${index + 1} must be an object`
      );
    }
    const typed = option as StructuredDecisionOption;
    if (!isNonEmptyString(typed.value)) {
      throw new Error(`Recoverable decision option ${index + 1} needs a value`);
    }
    if (!isNonEmptyString(typed.label)) {
      throw new Error(`Recoverable decision option ${index + 1} needs a label`);
    }
    if (!isNonEmptyString(typed.tradeoff)) {
      throw new Error(
        `Recoverable decision option ${index + 1} needs a non-empty tradeoff`
      );
    }
    if (
      typed.recommended === true &&
      !isNonEmptyString(typed.recommendationReason)
    ) {
      throw new Error(
        "The recommended recoverable decision option needs a recommendation reason"
      );
    }
  }
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
  assertRecoverableDecisionOptions(event.options);
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
      const sourcePlatform = worker.platform || parsed.channel || "unknown";
      const payload = {
        messageId: parsed.eventId,
        channelId,
        conversationId: worker.conversationId,
        userId: worker.userId,
        teamId: worker.teamId,
        platform: "api",
        platformMetadata: {
          sourcePlatform,
          sourceChannel: parsed.channel,
        },
        timestamp: Date.now(),
        customEvent: {
          name: "shifu.work_state",
          requireSseOwner: true,
          data: parsed,
        },
      };

      const id = await queueProducer.send(
        "thread_response",
        payload,
        TERMINAL_DELIVERY_SEND_OPTS
      );
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
