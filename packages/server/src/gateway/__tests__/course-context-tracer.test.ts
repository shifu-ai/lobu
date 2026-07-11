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
    const consumer = new MessageConsumer({} as never, {} as never, {} as never);
    const order: string[] = [];
    let forwarded: MessagePayload | undefined;
    const payload = { userId: 'pm-1', agentId: 'shifu-u-pm-1', conversationId: 'conv-1', messageText: 'x', platformMetadata: { courseScope: 'reviewed' } } as MessagePayload;
    await consumer.dispatchCourseContextBoundary(payload,
      async () => { order.push('arm'); },
      async (actual) => { order.push('send'); forwarded = actual; },
      async (actual) => { order.push('resolve'); actual.resolvedCourseContext = { course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體' }, resolution: { confidence: 'high', matchedBy: ['single_course_default'] }, context: { contextPackId: 'pack-super-ai', contextVersion: 1, stale: false, confirmedSummary: '已確認摘要' }, retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] } }; });
    expect(order).toEqual(['resolve', 'arm', 'send']);
    expect(forwarded?.resolvedCourseContext?.course.courseKey).toBe('super-ai');
  });
});
