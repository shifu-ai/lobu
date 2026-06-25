process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  type MessagePayload,
  verifyWorkerToken,
} from "@lobu/core";
import { mintRunJobToken } from "../orchestration/message-consumer.js";

describe("mintRunJobToken", () => {
  test("preserves connectionId from platform metadata", () => {
    __resetEncryptionKeyCacheForTests();
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "line",
        channelId: "line-user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        messageText: "hello",
        platformMetadata: {
          connectionId: "line-connection-1",
          teamId: "team-from-metadata",
        },
        runId: 123,
      } as MessagePayload,
      "conv-1",
      "deploy-1"
    );

    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token!);
    expect(decoded?.connectionId).toBe("line-connection-1");
    expect(decoded?.teamId).toBe("team-from-metadata");
    expect(decoded?.runId).toBe(123);
    expect(decoded?.messageId).toBe("msg-1");
    expect(decoded?.processedMessageIds).toEqual(["msg-1"]);
  });

  test("does not mint a token for legacy payloads without runId", () => {
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        platform: "line",
        channelId: "line-user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        messageText: "hello",
        platformMetadata: { connectionId: "line-connection-1" },
      } as MessagePayload,
      "conv-1",
      "deploy-1"
    );

    expect(token).toBeUndefined();
  });
});
