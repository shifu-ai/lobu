import type { MessagePayload } from '@lobu/core';
import type { ActiveCourseBindingWriteResult, ISessionManager } from '../session.js';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';

export interface CourseContextGateOptions extends ToolboxCourseContextClientOptions { sessionManager?: ISessionManager; sessionKey?: string; courseSkillEnabled?: boolean }
export type CourseContextGateResult = { status: 'not_required' } | { status: 'ready'; context: NonNullable<MessagePayload['resolvedCourseContext']>; bindingStatus?: ActiveCourseBindingWriteResult } | { status: 'clarification_required'; candidates: Array<{courseKey:string;displayName:string}> } | { status: 'onboarding_required' } | { status: 'context_unavailable'; displayName?:string; reasonCode:string };
const COURSE_INTENT = /(?:銷講|三個秘密|課綱|課程|老師回饋|課程會議|課程文件|戰報|招生|offer)/iu;
const PERSONAL_REMINDER = /提醒我.{0,30}(?:繳|付|買|拿|帶|吃|喝|電話費|水費|電費)/u;
export function requiresCourseContext(data: MessagePayload, options: {courseSkillEnabled?:boolean;hasActiveCourse?:boolean} = {}): boolean {
  const message = data.messageText?.trim() ?? '';
  if (PERSONAL_REMINDER.test(message) && !COURSE_INTENT.test(message)) return false;
  if (options.courseSkillEnabled || data.platformMetadata?.courseScope === 'reviewed') return true;
  if (COURSE_INTENT.test(message)) return true;
  return Boolean(options.hasActiveCourse && /^(?:繼續|接著|然後|再來|照剛才|就這個)/u.test(message));
}

export async function attachCourseContextForReviewedScope(data: MessagePayload, options?: CourseContextGateOptions): Promise<CourseContextGateResult> {
  const session = options?.sessionManager && options.sessionKey ? await options.sessionManager.getSession(options.sessionKey) : null;
  if (!requiresCourseContext(data, { courseSkillEnabled: options?.courseSkillEnabled, hasActiveCourse: Boolean(session?.shifuCourseContext) })) return { status: 'not_required' };
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return { status: 'context_unavailable', reasonCode: 'not_configured' };
  const client = new ToolboxCourseContextClient({ ...options, baseUrl, secret });
  let resolution; try { resolution = await client.resolve({ ownerUserId: data.userId, agentId: data.agentId, conversationId: data.conversationId, message: data.messageText }); } catch { return { status: 'context_unavailable', reasonCode: 'resolver_unavailable' }; }
  if (resolution.status === 'ambiguous') return { status: 'clarification_required', candidates: resolution.candidates.map(({courseKey,displayName}) => ({courseKey,displayName})) };
  if (resolution.status === 'missing') return { status: 'onboarding_required' };
  const course = resolution.course;
  let bundle; try { bundle = await client.bundle(course.courseKey, { ownerUserId: data.userId, agentId: data.agentId }); } catch { return { status: 'context_unavailable', displayName: course.displayName, reasonCode: 'bundle_unavailable' }; }
  const context = bundle.context;
  data.resolvedCourseContext = {
    course: { courseKey: course.courseKey, courseEntityId: course.courseEntityId, displayName: course.displayName },
    resolution: { confidence: 'high', matchedBy: ['single_course_default'] },
    context: { contextPackId: context.contextPackId, contextVersion: context.version, stale: context.stale, confirmedSummary: context.confirmedSummary },
    retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] },
  };
  if (!options?.sessionManager || !options.sessionKey) return { status: 'ready', context: data.resolvedCourseContext };
  const binding = await options.sessionManager.bindActiveCourse(options.sessionKey, {
    courseKey: course.courseKey, courseEntityId: course.courseEntityId, source: 'resolver',
    boundAt: new Date().toISOString(), contextPackId: context.contextPackId,
  });
  data.platformMetadata.courseContextBinding = binding;
  return { status: 'ready', context: data.resolvedCourseContext, bindingStatus: binding };
}
