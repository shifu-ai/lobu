import { describe, expect, it, vi } from 'vitest';
import type { MessagePayload } from '@lobu/core';
import { attachCourseContextForReviewedScope } from '../orchestration/course-context-gate.js';
import { MessageConsumer, parseCourseContextRolloutConfig } from '../orchestration/message-consumer.js';

describe('course context tracer', () => {
  it.each([
    [{}, { mode: 'enforce', legacyFallback: false }],
    [{ COURSE_CONTEXT_GATE_MODE: 'shadow', COURSE_CONTEXT_LEGACY_FALLBACK: 'true' }, { mode: 'shadow', legacyFallback: true }],
    [{ COURSE_CONTEXT_GATE_MODE: 'single_course', COURSE_CONTEXT_LEGACY_FALLBACK: 'TRUE' }, { mode: 'single_course', legacyFallback: true }],
    [{ COURSE_CONTEXT_GATE_MODE: 'enforce', COURSE_CONTEXT_LEGACY_FALLBACK: 'false' }, { mode: 'enforce', legacyFallback: false }],
    [{ COURSE_CONTEXT_GATE_MODE: 'typo', COURSE_CONTEXT_LEGACY_FALLBACK: 'yes' }, { mode: 'off', legacyFallback: false }],
  ])('parses narrow rollout config %#', (source, expected) => expect(parseCourseContextRolloutConfig(source)).toEqual(expected));

  it('off mode sends the legacy payload without invoking the course resolver', async () => {
    const resolver = vi.fn(); let forwarded: MessagePayload | undefined;
    const queue = { createQueue: vi.fn(), send: vi.fn(async (name: string, payload: MessagePayload) => { if (name.startsWith('thread_message_')) forwarded = payload; return 'job'; }) };
    const previous = process.env.COURSE_CONTEXT_GATE_MODE; process.env.COURSE_CONTEXT_GATE_MODE = 'off';
    try {
      const consumer = new MessageConsumer({ queues: { expireInSeconds: 1, retryLimit: 1 } } as never, {} as never, queue as never, resolver);
      const payload = { userId:'pm-1',agentId:'shifu-u-pm-1',conversationId:'conv-1',messageText:'course secret',platformMetadata:{courseScope:'reviewed'} } as MessagePayload;
      await (consumer as unknown as {dispatchCourseContextBoundary(p:MessagePayload,d:string):Promise<boolean>}).dispatchCourseContextBoundary(payload,'d');
      expect(resolver).not.toHaveBeenCalled(); expect(forwarded?.resolvedCourseContext).toBeUndefined();
    } finally { if(previous===undefined)delete process.env.COURSE_CONTEXT_GATE_MODE;else process.env.COURSE_CONTEXT_GATE_MODE=previous; }
  });

  it('shadow mode observes resolution on a clone but never changes worker or terminal behavior', async () => {
    const resolver=vi.fn(async(actual:MessagePayload)=>{actual.resolvedCourseContext={course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'},resolution:{confidence:'high',matchedBy:['single_course_default']},context:{contextPackId:'p',contextVersion:1,stale:false,confirmedSummary:'SECRET CONTEXT'},retrieval:{status:'failed',crossCourseGuard:'passed',eventIds:[],evidenceRefs:[],snippets:[]}};return {status:'clarification_required',candidates:[{courseKey:'x',displayName:'X'}]} as const;});
    let forwarded:MessagePayload|undefined; const queue={createQueue:vi.fn(),send:vi.fn(async(name:string,payload:MessagePayload)=>{if(name.startsWith('thread_message_'))forwarded=payload;return'job';})};
    const previous=process.env.COURSE_CONTEXT_GATE_MODE;process.env.COURSE_CONTEXT_GATE_MODE='shadow';
    try{const consumer=new MessageConsumer({queues:{expireInSeconds:1,retryLimit:1}} as never,{} as never,queue as never,resolver);const payload={userId:'u',agentId:'a',conversationId:'c',messageText:'SECRET MESSAGE',platformMetadata:{courseScope:'reviewed'}} as MessagePayload;await (consumer as any).dispatchCourseContextBoundary(payload,'d');expect(resolver).toHaveBeenCalled();expect(forwarded?.resolvedCourseContext).toBeUndefined();expect(queue.send).not.toHaveBeenCalledWith('thread_response',expect.anything(),expect.anything());}finally{if(previous===undefined)delete process.env.COURSE_CONTEXT_GATE_MODE;else process.env.COURSE_CONTEXT_GATE_MODE=previous;}
  });
  it('uses the Toolbox resolver and bundle contract to attach bounded context', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'resolved', confidence: 'high', matchedBy: ['single_course_default'], course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體', aliases: ['超級AI'], status: 'active' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體', aliases: ['超級AI'], status: 'active' }, profile: { pmRole: null, teacher: null, collaborators: [], audience: null, coursePromise: null, resourceLocations: {} }, context: { agentMd: '已確認摘要', contextPackId: 'pack-super-ai', version: 1, confidence: 'high', generatedAt: '2026-07-11T00:00:00Z', lastIndexedAt: null, stale: false }, evidence: { confirmed: [], candidates: [] } }), { status: 200 }));
    const payload = { userId: 'pm-1', agentId: 'shifu-u-pm-1', conversationId: 'conv-1', messageText: '幫我想三個秘密', platformMetadata: { courseScope: 'reviewed' } } as MessagePayload;
    await attachCourseContextForReviewedScope(payload, { baseUrl: 'https://toolbox.test/agent-workbench/course-context', secret: 'secret', fetcher });
    expect(payload.resolvedCourseContext).toEqual({ course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體' }, resolution: { confidence: 'high', matchedBy: ['single_course_default'] }, context: { contextPackId: 'pack-super-ai', contextVersion: 1, stale: false, confirmedSummary: '已確認摘要' }, retrieval: { status: 'failed',crossCourseGuard:'passed', eventIds: [], evidenceRefs: [],snippets:[] } });
  });

  it('emits ordered safe gate events without message, context body, or secret', async () => {
    const events: Array<Record<string, unknown>>=[];
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'resolved',confidence:'high',matchedBy:['single_course_default'],course:{courseKey:'x',courseEntityId:'course:x',displayName:'X',aliases:[],status:'active'}}))).mockResolvedValueOnce(new Response(JSON.stringify({course:{courseKey:'x',courseEntityId:'course:x',displayName:'X',aliases:[],status:'active'},profile:{pmRole:null,teacher:null,collaborators:[],audience:null,coursePromise:null,resourceLocations:{}},context:{agentMd:'SECRET CONTEXT',contextPackId:'p',version:2,confidence:'high',generatedAt:'2026-07-11T00:00:00Z',lastIndexedAt:null,stale:false},evidence:{confirmed:[],candidates:[]}})));
    const payload={userId:'owner-secret',agentId:'agent-key',conversationId:'conversation-secret',messageId:'m1',messageText:'SECRET MESSAGE',platformMetadata:{courseScope:'reviewed'}} as MessagePayload;
    await attachCourseContextForReviewedScope(payload,{baseUrl:'https://toolbox.test',secret:'TOKEN SECRET',fetcher,traceEmitter:async(event)=>{events.push(event);}});
    expect(events.map(event=>event.event)).toEqual(['context.gate.started','context.course.resolved','context.bundle.loaded','context.memory.failed','context.guard.passed']);
    const serialized=JSON.stringify(events);expect(serialized).not.toContain('SECRET MESSAGE');expect(serialized).not.toContain('SECRET CONTEXT');expect(serialized).not.toContain('TOKEN SECRET');expect(serialized).not.toContain('owner-secret');expect(serialized).not.toContain('conversation-secret');
  });

  it('enriches the actual MessageConsumer dispatch payload in resolve-arm-send order', async () => {
    let createCount = 0;
    const queue = { createQueue: async () => { order.push(createCount++ === 0 ? 'arm' : 'create-send'); }, send: async (name: string, actual: MessagePayload) => { if (name.startsWith('thread_message_')) { order.push('send'); forwarded = actual; } return 'job'; } };
    const consumer = new MessageConsumer({ queues: { expireInSeconds: 1, retryLimit: 1 } } as never, {} as never, queue as never, async (actual) => { order.push('resolve'); actual.resolvedCourseContext = { course: { courseKey: 'super-ai', courseEntityId: 'course:pm-1:super-ai', displayName: '超級 AI 個體' }, resolution: { confidence: 'high', matchedBy: ['single_course_default'] }, context: { contextPackId: 'pack-super-ai', contextVersion: 1, stale: false, confirmedSummary: '已確認摘要' }, retrieval: { status: 'failed',crossCourseGuard:'passed', eventIds: [], evidenceRefs: [],snippets:[] } }; });
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
