import type { MessagePayload } from '@lobu/core';
import type { ActiveCourseBindingWriteResult, ISessionManager } from '../session.js';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';

export interface CourseContextGateOptions extends ToolboxCourseContextClientOptions { sessionManager?: ISessionManager; sessionKey?: string }
export type CourseContextGateResult = { status: 'skipped' } | { status: 'ready'; binding?: ActiveCourseBindingWriteResult };

export async function attachCourseContextForReviewedScope(data: MessagePayload, options?: CourseContextGateOptions): Promise<CourseContextGateResult> {
  if (data.platformMetadata?.courseScope !== 'reviewed') return { status: 'skipped' };
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return { status: 'skipped' };
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
  if (!options?.sessionManager || !options.sessionKey) return { status: 'ready' };
  const binding = await options.sessionManager.bindActiveCourse(options.sessionKey, {
    courseKey: course.courseKey, courseEntityId: course.courseEntityId, source: 'resolver',
    boundAt: new Date().toISOString(), contextPackId: context.contextPackId,
  });
  data.platformMetadata.courseContextBinding = binding;
  return { status: 'ready', binding };
}
