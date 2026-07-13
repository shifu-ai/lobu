import { expect, mock, test } from "bun:test";
import { enqueueAgentMessage } from "../services/agent-threads.js";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";

test("copies only safe scheduled delivery metadata into worker completion routing", async () => {
  const enqueueMessage = mock(async () => "worker-run-1");
  const sessionManager = {
    getSession: mock(async () => ({
      userId: "owner-1", agentId: "agent-1", organizationId: "org-1",
      conversationId: "conversation-1", channelId: "api_owner-1", dryRun: false,
    })),
    touchSession: mock(async () => undefined),
  };
  const scheduledCourseContext = {
    schemaVersion: 1 as const,
    source: "calendar_scheduled_wake" as const,
    automationId: "auto-1",
    jobId: "job-1",
    runId: 42,
    taskKind: "opp_coach_event_prompt" as const,
    evidenceReadiness: "canonical_only" as const,
    course: {
      ownerUserId: "owner-1", agentId: "agent-1", courseKey: "course-a",
      courseEntityId: "course:owner-1:course-a", displayName: "Course A",
    },
  };

  await enqueueAgentMessage(
    { sessionManager: sessionManager as never, queueProducer: { enqueueMessage } as never },
    { threadId: "conversation-1", messageText: "wake", source: "scheduled-job", scheduledCourseContext },
  );

  expect(enqueueMessage).toHaveBeenCalledTimes(1);
  expect(enqueueMessage.mock.calls[0]?.[0]).toMatchObject({
    platformMetadata: {
      source: "scheduled-job",
      scheduledCourseWake: {
        schemaVersion: 1,
        source: "calendar_scheduled_wake",
        automationId: "auto-1",
        jobId: "job-1",
        runId: 42,
        toolboxUserId: "owner-1",
        lobuAgentId: "agent-1",
      },
    },
  });
  expect(JSON.stringify(enqueueMessage.mock.calls[0]?.[0])).not.toContain("lineUserId");
});

test("transient completion retry reuses stored final output without a second worker dispatch", async () => {
  const workerDispatch = mock(async () => "worker-run-1");
  const sessionManager = {
    getSession: mock(async () => ({
      userId: "owner-1", agentId: "agent-1", organizationId: "org-1",
      conversationId: "conversation-1", channelId: "api_owner-1",
    })),
    touchSession: mock(async () => undefined),
  };
  const scheduledCourseContext = {
    schemaVersion: 1 as const, source: "calendar_scheduled_wake" as const,
    automationId: "auto-1", jobId: "job-1", runId: 42,
    taskKind: "opp_coach_event_prompt" as const, evidenceReadiness: "canonical_only" as const,
    course: { ownerUserId: "owner-1", agentId: "agent-1", courseKey: "course-a",
      courseEntityId: "course:owner-1:course-a", displayName: "Course A" },
  };
  await enqueueAgentMessage(
    { sessionManager: sessionManager as never, queueProducer: { enqueueMessage: workerDispatch } as never },
    { threadId: "conversation-1", messageText: "wake", source: "scheduled-job", scheduledCourseContext },
  );
  const routing = (workerDispatch.mock.calls[0]?.[0] as unknown as {
    platformMetadata: Record<string, unknown>;
  }).platformMetadata;
  const delivered: string[] = [];
  const mechanicalDelivery = mock(async ({ completion }: {
    completion: { kind: "succeeded"; finalOutput: string };
  }) => {
    delivered.push(completion.finalOutput);
    if (delivered.length === 1) throw new Error("course_wake_delivery_retrying");
  });
  const consumer = new UnifiedThreadResponseConsumer(
    {} as never, {} as never, {} as never, mechanicalDelivery as never,
  ) as unknown as {
    handleThreadResponse(job: { id: string; data: unknown }): Promise<void>;
  };
  const terminal = { messageId: "turn-1", channelId: "scheduled", conversationId: "conversation-1",
    userId: "owner-1", teamId: "api", platform: "api", timestamp: 1,
    processedMessageIds: ["turn-1"], finalText: "stored final output", platformMetadata: routing };

  await expect(consumer.handleThreadResponse({ id: "terminal-run", data: terminal }))
    .rejects.toThrow("course_wake_delivery_retrying");
  await consumer.handleThreadResponse({ id: "terminal-run", data: terminal });

  expect(workerDispatch).toHaveBeenCalledTimes(1);
  expect(mechanicalDelivery).toHaveBeenCalledTimes(2);
  expect(delivered).toEqual(["stored final output", "stored final output"]);
});
