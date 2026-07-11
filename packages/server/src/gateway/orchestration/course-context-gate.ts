import { createLogger, type MessagePayload } from '@lobu/core';
import type { ActiveCourseBindingWriteResult, ISessionManager } from '../session.js';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';

export interface CourseContextGateOptions extends ToolboxCourseContextClientOptions { sessionManager?: ISessionManager; sessionKey?: string; courseSkillEnabled?: boolean }
export type CourseContextGateResult = { status: 'not_required' } | {status:'already_dispatched'} | { status: 'ready'; context: NonNullable<MessagePayload['resolvedCourseContext']>; bindingStatus?: ActiveCourseBindingWriteResult; replay?:{pendingId:string;messageId:string} } | { status: 'clarification_required'; candidates: Array<{courseKey:string;displayName:string}> } | { status: 'onboarding_required' } | { status: 'context_unavailable'; displayName?:string; reasonCode:string };
const COURSE_INTENT = /(?:銷講|三個秘密|課綱|課程|老師回饋|課程會議|課程文件|戰報|招生|offer)/iu;
const PERSONAL_REMINDER = /提醒我.{0,30}(?:繳|付|買|拿|帶|吃|喝|電話費|水費|電費)/u;
const logger = createLogger('course-context-gate');
export function requiresCourseContext(data: MessagePayload, options: {courseSkillEnabled?:boolean;hasActiveCourse?:boolean} = {}): boolean {
  const message = data.messageText?.trim() ?? '';
  if (PERSONAL_REMINDER.test(message) && !COURSE_INTENT.test(message)) return false;
  if (options.courseSkillEnabled || data.platformMetadata?.courseScope === 'reviewed') return true;
  if (COURSE_INTENT.test(message)) return true;
  return Boolean(options.hasActiveCourse && /^(?:繼續|接著|然後|再來|照剛才|就這個)/u.test(message));
}
export function isExplicitPersonalBypass(data: MessagePayload): boolean { const message=data.messageText?.trim()??''; return PERSONAL_REMINDER.test(message)&&!COURSE_INTENT.test(message); }

export async function attachCourseContextForReviewedScope(data: MessagePayload, options?: CourseContextGateOptions): Promise<CourseContextGateResult> {
  if (isExplicitPersonalBypass(data)) return { status: 'not_required' };
  let session = null; try { session = options?.sessionManager && options.sessionKey ? await options.sessionManager.getSessionStrict(options.sessionKey) : null; } catch { logger.warn({ category: 'session_read' }, 'Course context session unavailable'); return { status: 'context_unavailable', reasonCode: 'session_unavailable' }; }
  const pendingExpired = Boolean(session?.pendingCourseSelection?.status === 'pending' && Date.now() - session.pendingCourseSelection.createdAt > 10 * 60_000);
  if (pendingExpired && options?.sessionManager && options.sessionKey && (await options.sessionManager.clearPendingCourseSelection(options.sessionKey, session!.pendingCourseSelection!.pendingId)).status !== 'cleared') return { status: 'context_unavailable', reasonCode: 'pending_clear_failed' };
  let pending = !pendingExpired ? session?.pendingCourseSelection : undefined;
  if(pending?.status==='dispatched'){if(pending.claimedMessageId===data.messageId)return{status:'already_dispatched'};if(!options?.sessionManager||!options.sessionKey||(await options.sessionManager.clearPendingCourseSelection(options.sessionKey,pending.pendingId,pending.claimedMessageId)).status!=='cleared')return{status:'context_unavailable',reasonCode:'dispatched_cleanup_failed'};pending=undefined;}
  const CLAIMED_RECOVERY_GRACE_MS=5*60_000;
  if(pending?.status==='claimed'&&pending.claimedMessageId!==data.messageId&&pending.claimedAt&&Date.now()-pending.claimedAt>CLAIMED_RECOVERY_GRACE_MS){if(!options?.sessionManager||!options.sessionKey||(await options.sessionManager.clearPendingCourseSelection(options.sessionKey,pending.pendingId,pending.claimedMessageId)).status!=='cleared')return{status:'context_unavailable',reasonCode:'claimed_recovery_failed'};pending=undefined;}
  const text = typeof data.messageText === 'string' ? data.messageText.trim() : '';
  let choice = pending?.status === 'claimed' && pending.claimedMessageId === data.messageId ? pending.candidates.find((candidate)=>candidate.courseKey===pending.claimedCourseKey) : pending ? pending.candidates.find((candidate, index) => text === String(index + 1) || text === candidate.courseKey || text === candidate.displayName) : undefined;
  if (!choice && !pending && !requiresCourseContext(data, { courseSkillEnabled: options?.courseSkillEnabled, hasActiveCourse: Boolean(session?.shifuCourseContext) })) return { status: 'not_required' };
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return { status: 'context_unavailable', reasonCode: 'not_configured' };
  const client = new ToolboxCourseContextClient({ ...options, baseUrl, secret });
  if (pending && !choice) return { status: 'clarification_required', candidates: pending.candidates };
  let replay:{pendingId:string;messageId:string}|undefined;
  if(choice&&pending?.status==='pending'&&options?.sessionManager&&options.sessionKey){const claimed=await options.sessionManager.claimPendingCourseSelection(options.sessionKey,pending.pendingId,choice.courseKey,data.messageId);if(claimed.status!=='claimed')return{status:'context_unavailable',reasonCode:'pending_claim_failed'};replay={pendingId:pending.pendingId,messageId:data.messageId};}
  else if(choice&&pending?.status==='claimed')replay={pendingId:pending.pendingId,messageId:data.messageId};
  if (choice) data.messageText = pending!.originalMessage;
  let resolution; try { resolution = await client.resolve({ ownerUserId: data.userId, agentId: data.agentId, conversationId: data.conversationId, message: typeof data.messageText==='string'?data.messageText:'', boundCourseKey: session?.shifuCourseContext?.courseKey, explicitCourseKey: choice?.courseKey }); } catch { logger.warn({ category: 'resolver' }, 'Course context resolver unavailable'); return { status: 'context_unavailable', reasonCode: 'resolver_unavailable' }; }
  if (resolution.status === 'ambiguous') { const candidates = resolution.candidates.map(({courseKey,displayName}) => ({courseKey,displayName})); if (options?.sessionManager && options.sessionKey && (await options.sessionManager.createPendingCourseSelection(options.sessionKey, { candidates, originalMessage: (typeof data.messageText==='string'?data.messageText:'').slice(0, 8000), createdAt: Date.now() })).status!=='persisted') return { status: 'context_unavailable', reasonCode: 'pending_write_failed' }; return { status: 'clarification_required', candidates }; }
  if (resolution.status === 'missing') return { status: 'onboarding_required' };
  const course = resolution.course;
  let bundle; try { bundle = await client.bundle(course.courseKey, { ownerUserId: data.userId, agentId: data.agentId }); } catch { logger.warn({ category: 'bundle' }, 'Course context bundle unavailable'); return { status: 'context_unavailable', displayName: course.displayName, reasonCode: 'bundle_unavailable' }; }
  if (bundle.course.courseKey !== course.courseKey || bundle.course.courseEntityId !== course.courseEntityId) return { status: 'context_unavailable', displayName: course.displayName, reasonCode: 'bundle_identity_mismatch' };
  const context = bundle.context;
  data.resolvedCourseContext = {
    course: { courseKey: course.courseKey, courseEntityId: course.courseEntityId, displayName: course.displayName },
    resolution: { confidence: 'high', matchedBy: resolution.matchedBy },
    context: { contextPackId: context.contextPackId, contextVersion: context.version, stale: context.stale, confirmedSummary: context.agentMd.slice(0, 8000) },
    retrieval: { status: 'skipped', eventIds: [], evidenceRefs: [] },
  };
  if (!options?.sessionManager || !options.sessionKey) return { status: 'ready', context: data.resolvedCourseContext };
  const binding = await options.sessionManager.bindActiveCourse(options.sessionKey, {
    courseKey: course.courseKey, courseEntityId: course.courseEntityId, source: 'resolver',
    boundAt: new Date().toISOString(), contextPackId: context.contextPackId,
  });
  data.platformMetadata.courseContextBinding = binding;
  return { status: 'ready', context: data.resolvedCourseContext, bindingStatus: binding, replay };
}
