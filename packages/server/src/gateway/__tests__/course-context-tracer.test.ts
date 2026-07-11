import { describe, expect, it, vi } from 'vitest';
import type { MessagePayload } from '@lobu/core';
import { attachCourseContextForReviewedScope } from '../orchestration/course-context-gate.js';
import { MessageConsumer } from '../orchestration/message-consumer.js';

describe('course context tracer', () => {
  it('uses the Toolbox resolver and bundle contract to attach bounded context', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'resolved', confidence: 'high', matchedBy: ['single_course_default'], course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體', aliases: ['超級AI'], status: 'active' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體', aliases: ['超級AI'], status: 'active' }, context: { contextPackId: 'pack-super-ai', version: 1, stale: false, confirmedSummary: '已確認摘要' } }), { status: 200 }));
    const payload = { userId: 'pm-1', agentId: 'shifu-u-pm-1', conversationId: 'conv-1', messageText: '幫我想三個秘密', platformMetadata: { courseScope: 'reviewed' } } as MessagePayload;
    await attachCourseContextForReviewedScope(payload, { baseUrl: 'https://toolbox.test/agent-workbench/course-context', secret: 'secret', fetcher });
    expect(payload.resolvedCourseContext).toEqual({ course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體' }, resolution: { confidence: 'high', matchedBy: ['single_course_default'] }, context: { contextPackId: 'pack-super-ai', contextVersion: 1, stale: false, confirmedSummary: '已確認摘要' }, retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] } });
  });

  it('enriches the actual MessageConsumer dispatch payload in resolve-arm-send order', async () => {
    let createCount = 0;
    const queue = { createQueue: async () => { order.push(createCount++ === 0 ? 'arm' : 'create-send'); }, send: async (name: string, actual: MessagePayload) => { if (name.startsWith('thread_message_')) { order.push('send'); forwarded = actual; } return 'job'; } };
    const consumer = new MessageConsumer({ queues: { expireInSeconds: 1, retryLimit: 1 } } as never, {} as never, queue as never, async (actual) => { order.push('resolve'); actual.resolvedCourseContext = { course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體' }, resolution: { confidence: 'high', matchedBy: ['single_course_default'] }, context: { contextPackId: 'pack-super-ai', contextVersion: 1, stale: false, confirmedSummary: '已確認摘要' }, retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] } }; });
    const order: string[] = [];
    let forwarded: MessagePayload | undefined;
    const payload = { userId: 'pm-1', agentId: 'shifu-u-pm-1', conversationId: 'conv-1', messageText: 'x', platformMetadata: { courseScope: 'reviewed' } } as MessagePayload;
    await (consumer as unknown as { dispatchCourseContextBoundary(p: MessagePayload, d: string): Promise<void> }).dispatchCourseContextBoundary(payload, 'test-deployment');
    expect(order).toEqual(['resolve', 'arm', 'create-send', 'send']);
    expect(forwarded?.resolvedCourseContext?.course.courseKey).toBe('super-ai');
  });

  it.each([
    ['malformed json', [new Response('{', { status: 200 })]],
    ['wrong resolve shape', [new Response(JSON.stringify({ status: 'resolved' }), { status: 200 })]],
    ['string false', [new Response(JSON.stringify({ status: 'resolved', confidence: 'high', matchedBy: ['single_course_default'], course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' } })), new Response(JSON.stringify({ course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' }, context: { contextPackId: 'p', version: 1, stale: 'false', confirmedSummary: 'ok' } }))]],
    ['invalid version', [new Response(JSON.stringify({ status: 'resolved', confidence: 'high', matchedBy: ['single_course_default'], course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' } })), new Response(JSON.stringify({ course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' }, context: { contextPackId: 'p', version: 0, stale: false, confirmedSummary: 'ok' } }))]],
    ['oversized summary', [new Response(JSON.stringify({ status: 'resolved', confidence: 'high', matchedBy: ['single_course_default'], course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' } })), new Response(JSON.stringify({ course: { courseKey: 'super-ai', courseEntityId: 'course:1', displayName: 'AI' }, context: { contextPackId: 'p', version: 1, stale: false, confirmedSummary: 'x'.repeat(8001) } }))]],
  ])('terminalizes %s without attaching context', async (_name, responses) => {
    const fetcher = vi.fn(); for (const response of responses) fetcher.mockResolvedValueOnce(response);
    const payload = { userId: 'pm-1', agentId: 'shifu-u-pm-1', conversationId: 'conv-1', messageText: 'x', platformMetadata: { courseScope: 'reviewed' } } as MessagePayload;
    await expect(attachCourseContextForReviewedScope(payload, { baseUrl: 'https://toolbox.test', secret: 'secret', fetcher })).resolves.toMatchObject({ status: 'context_unavailable' });
    expect(payload.resolvedCourseContext).toBeUndefined();
  });
});
