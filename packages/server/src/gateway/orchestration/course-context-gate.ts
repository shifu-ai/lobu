import type { MessagePayload } from '@lobu/core';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';

export async function attachCourseContextForReviewedScope(data: MessagePayload, options?: ToolboxCourseContextClientOptions): Promise<void> {
  if (data.platformMetadata?.courseScope !== 'reviewed') return;
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return;
  const client = new ToolboxCourseContextClient({ ...options, baseUrl, secret });
  const resolution = await client.resolve({ ownerUserId: data.userId, agentId: data.agentId, conversationId: data.conversationId, message: data.messageText });
  const course = resolution.course;
  const bundle = await client.bundle(course.courseKey, { ownerUserId: data.userId, agentId: data.agentId });
  const context = bundle.context;
  data.resolvedCourseContext = {
    course: { courseKey: course.courseKey, courseEntityId: course.courseEntityId, displayName: course.displayName },
    resolution: { confidence: 'high', matchedBy: ['single_course_default'] },
    context: { contextPackId: context.contextPackId, contextVersion: context.version, stale: context.stale, confirmedSummary: context.confirmedSummary },
    retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] },
  };
}
