import type { MessagePayload } from '@lobu/core';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';

export async function attachCourseContextForReviewedScope(data: MessagePayload, options?: ToolboxCourseContextClientOptions): Promise<void> {
  if (data.platformMetadata?.courseScope !== 'reviewed') return;
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return;
  const client = new ToolboxCourseContextClient({ ...options, baseUrl, secret });
  const resolution = await client.resolve({ ownerUserId: data.userId, agentId: data.agentId, conversationId: data.conversationId, message: data.messageText });
  const course = resolution.course as Record<string, unknown>;
  const bundle = await client.bundle(String(course.courseKey), { ownerUserId: data.userId, agentId: data.agentId });
  const context = bundle.context as Record<string, unknown>;
  data.resolvedCourseContext = {
    course: { courseKey: String(course.courseKey), courseEntityId: String(course.courseEntityId), displayName: String(course.displayName) },
    resolution: { confidence: 'high', matchedBy: ['single_course_default'] },
    context: { contextPackId: String(context.contextPackId), contextVersion: Number(context.version), stale: Boolean(context.stale), confirmedSummary: String(context.confirmedSummary) },
    retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] },
  };
}
