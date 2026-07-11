import { createLogger, extractTraceId, type MessagePayload } from '@lobu/core';
import { createHash } from 'node:crypto';
import type {Env} from '@lobu/connector-sdk';
import type { ActiveCourseBindingWriteResult, ISessionManager } from '../session.js';
import { ToolboxCourseContextClient, type ToolboxCourseContextClientOptions } from '../services/toolbox-course-context-client.js';
import { retrieveCourseMemory, type CourseMemorySearch } from './course-memory-retriever.js';
import { emitJourneyEvent, type JourneyEventPayload } from '../services/journey-observability.js';

export interface CourseContextGateOptions extends ToolboxCourseContextClientOptions { sessionManager?: ISessionManager; sessionKey?: string; courseSkillEnabled?: boolean; courseSkillContextFields?:string[]; courseSkillRetrievalTerms?:string[]; courseSkillRetrievalLimit?:number; memorySearch?:CourseMemorySearch; env?:Env; traceEmitter?:(event:JourneyEventPayload)=>Promise<void> }
export type CourseContextGateResult = { status: 'not_required' } | {status:'already_dispatched'} | { status: 'ready'; context: NonNullable<MessagePayload['resolvedCourseContext']>; bindingStatus?: ActiveCourseBindingWriteResult; replay?:{pendingId:string;messageId:string} } | { status: 'clarification_required'; candidates: Array<{courseKey:string;displayName:string}> } | { status: 'onboarding_required' } | { status: 'context_unavailable'; displayName?:string; reasonCode:string; resolvedCourse?:{courseKey:string;courseEntityId:string;displayName:string} };
const COURSE_INTENT = /(?:銷講|三個秘密|課綱|課程|老師回饋|課程會議|課程文件|戰報|招生|offer)/iu;
const PERSONAL_REMINDER = /提醒我.{0,30}(?:繳|付|買|拿|帶|吃|喝|電話費|水費|電費)/u;
const logger = createLogger('course-context-gate');
const STRUCTURED_CONTEXT_FIELDS=new Set(['audience','dream_result','course_promise','key_learning','delivery_mechanism','evidence','offer']);
function hashIdentity(value:string):string{return createHash('sha256').update(value).digest('hex');}
async function traceCourse(data:MessagePayload,options:CourseContextGateOptions|undefined,event:string,status:string,fields:Record<string,unknown>={}):Promise<void>{
  const emitter=options?.traceEmitter??emitJourneyEvent;
  try{void emitter({trace_id:extractTraceId(data)??`tr_${hashIdentity(data.messageId??data.conversationId).slice(0,32)}`,journey_id:typeof data.platformMetadata?.journeyId==='string'?data.platformMetadata.journeyId:'course_context_gate',event,service:'lobu',module:'course-context-gate',status,owner_hash:hashIdentity(data.userId),conversation_hash:hashIdentity(data.conversationId),agent_key:data.agentId,...fields}).catch(()=>{});}catch{}
}
function projectRequiredCourseContext(bundle:Awaited<ReturnType<ToolboxCourseContextClient['bundle']>>,fields:string[]):string{
  const lines=['Required course context (canonical structured fields only):'];
  for(const field of fields.filter((value)=>STRUCTURED_CONTEXT_FIELDS.has(value))){
    if(field==='audience')lines.push(`audience: ${bundle.profile.audience??'[missing]'}`);
    else if(field==='course_promise')lines.push(`course_promise: ${bundle.profile.coursePromise??'[missing]'}`);
    else if(field==='evidence'){
      lines.push('evidence:');
      if(bundle.evidence.confirmed.length===0)lines.push('- [missing]');
      else for(const item of bundle.evidence.confirmed.slice(0,8)){const title=(item.sourceTitle??item.sourceId).slice(0,200);const preview=item.excerptPreview?.slice(0,500);lines.push(`- ${item.id.slice(0,200)} | ${title}${preview?` | ${preview}`:''}`);}
    }else lines.push(`${field}: [missing]`);
  }
  return lines.join('\n').slice(0,8000);
}
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
  const gateStarted=Date.now(); await traceCourse(data,options,'context.gate.started','started',{gate_mode:process.env.COURSE_CONTEXT_GATE_MODE??'enforce'});
  let session = null; try { session = options?.sessionManager && options.sessionKey ? await options.sessionManager.getSessionStrict(options.sessionKey) : null; } catch { logger.warn({ category: 'session_read' }, 'Course context session unavailable'); return { status: 'context_unavailable', reasonCode: 'session_unavailable' }; }
  const storedPending = session?.pendingCourseSelection;
  // Old rolling-deployment records have no owner/agent scope. They must not be
  // selected, replayed, or deleted by a different runtime identity.
  if (storedPending && (storedPending.ownerUserId !== data.userId || storedPending.agentId !== data.agentId)) {
    return { status: 'context_unavailable', reasonCode: 'pending_scope_mismatch' };
  }
  const pendingForExpiry = session?.pendingCourseSelection;
  const pendingExpired = Boolean(pendingForExpiry?.status === 'pending' && Date.now() - pendingForExpiry.createdAt > 10 * 60_000);
  if (pendingExpired && pendingForExpiry && options?.sessionManager && options.sessionKey && (await options.sessionManager.clearPendingCourseSelection(options.sessionKey, pendingForExpiry.pendingId, data.userId, data.agentId)).status !== 'cleared') return { status: 'context_unavailable', reasonCode: 'pending_clear_failed' };
  let pending = !pendingExpired ? session?.pendingCourseSelection : undefined;
  if(pending?.status==='dispatched'){if(pending.claimedMessageId===data.messageId)return{status:'already_dispatched'};if(!options?.sessionManager||!options.sessionKey||(await options.sessionManager.clearPendingCourseSelection(options.sessionKey,pending.pendingId,data.userId,data.agentId,pending.claimedMessageId)).status!=='cleared')return{status:'context_unavailable',reasonCode:'dispatched_cleanup_failed'};pending=undefined;}
  const CLAIMED_RECOVERY_GRACE_MS=5*60_000;
  if(pending?.status==='claimed'&&pending.claimedMessageId!==data.messageId&&pending.claimedAt&&Date.now()-pending.claimedAt>CLAIMED_RECOVERY_GRACE_MS){if(!options?.sessionManager||!options.sessionKey||(await options.sessionManager.clearPendingCourseSelection(options.sessionKey,pending.pendingId,data.userId,data.agentId,pending.claimedMessageId)).status!=='cleared')return{status:'context_unavailable',reasonCode:'claimed_recovery_failed'};pending=undefined;}
  const text = typeof data.messageText === 'string' ? data.messageText.trim() : '';
  const choice = pending?.status === 'claimed' && pending.claimedMessageId === data.messageId ? pending.candidates.find((candidate)=>candidate.courseKey===pending.claimedCourseKey) : pending ? pending.candidates.find((candidate, index) => text === String(index + 1) || text === candidate.courseKey || text === candidate.displayName) : undefined;
  if (!choice && !pending && !requiresCourseContext(data, { courseSkillEnabled: options?.courseSkillEnabled, hasActiveCourse: Boolean(session?.shifuCourseContext) })) return { status: 'not_required' };
  const baseUrl = options?.baseUrl ?? process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim();
  const secret = options?.secret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) return { status: 'context_unavailable', reasonCode: 'not_configured' };
  const client = new ToolboxCourseContextClient({ ...options, baseUrl, secret });
  if (pending && !choice) return { status: 'clarification_required', candidates: pending.candidates };
  let replay:{pendingId:string;messageId:string}|undefined;
  if(choice&&pending?.status==='pending'&&options?.sessionManager&&options.sessionKey){const claimed=await options.sessionManager.claimPendingCourseSelection(options.sessionKey,pending.pendingId,data.userId,data.agentId,choice.courseKey,data.messageId);if(claimed.status!=='claimed')return{status:'context_unavailable',reasonCode:'pending_claim_failed'};replay={pendingId:pending.pendingId,messageId:data.messageId};}
  else if(choice&&pending?.status==='claimed')replay={pendingId:pending.pendingId,messageId:data.messageId};
  if (choice && pending) data.messageText = pending.originalMessage;
  let resolution:Awaited<ReturnType<ToolboxCourseContextClient['resolve']>>; try { resolution = await client.resolve({ ownerUserId: data.userId, agentId: data.agentId, conversationId: data.conversationId, message: typeof data.messageText==='string'?data.messageText:'', boundCourseKey: session?.shifuCourseContext?.courseKey, explicitCourseKey: choice?.courseKey }); await traceCourse(data,options,`context.course.${resolution.status}`,'ok',{duration_ms:Date.now()-gateStarted,...(resolution.status==='resolved'?{course_key:resolution.course.courseKey,course_entity_id:resolution.course.courseEntityId}:{}),reason_code:'reason'in resolution?resolution.reason:undefined}); } catch { logger.warn({ category: 'resolver' }, 'Course context resolver unavailable'); await traceCourse(data,options,'context.course.missing','failed',{reason_code:'resolver_unavailable'}); return { status: 'context_unavailable', reasonCode: 'resolver_unavailable' }; }
  if (resolution.status === 'ambiguous') { const candidates = resolution.candidates.map(({courseKey,displayName}) => ({courseKey,displayName})); if (options?.sessionManager && options.sessionKey && (await options.sessionManager.createPendingCourseSelection(options.sessionKey, { ownerUserId:data.userId,agentId:data.agentId,candidates, originalMessage: (typeof data.messageText==='string'?data.messageText:'').slice(0, 8000), createdAt: Date.now() })).status!=='persisted') return { status: 'context_unavailable', reasonCode: 'pending_write_failed' }; return { status: 'clarification_required', candidates }; }
  if (resolution.status === 'missing') return { status: 'onboarding_required' };
  const course = resolution.course;
  let bundle:Awaited<ReturnType<ToolboxCourseContextClient['bundle']>>; try { bundle = await client.bundle(course.courseKey, { ownerUserId: data.userId, agentId: data.agentId }); await traceCourse(data,options,'context.bundle.loaded','ok',{course_key:course.courseKey,course_entity_id:course.courseEntityId,context_version:bundle.context.version}); } catch { logger.warn({ category: 'bundle' }, 'Course context bundle unavailable'); await traceCourse(data,options,'context.bundle.failed','failed',{course_key:course.courseKey,reason_code:'bundle_unavailable'}); return { status: 'context_unavailable', displayName: course.displayName, reasonCode: 'bundle_unavailable',resolvedCourse:{courseKey:course.courseKey,courseEntityId:course.courseEntityId,displayName:course.displayName} }; }
  if (bundle.course.courseKey !== course.courseKey || bundle.course.courseEntityId !== course.courseEntityId) return { status: 'context_unavailable', displayName: course.displayName, reasonCode: 'bundle_identity_mismatch' };
  const context = bundle.context;
  const skillTerms=options?.courseSkillEnabled?(options.courseSkillRetrievalTerms??[]):[];
  const retrieval=data.organizationId&&options?.memorySearch?await retrieveCourseMemory({organizationId:data.organizationId,ownerUserId:data.userId,agentId:data.agentId,courseEntityId:course.courseEntityId,task:data.messageText,skillTerms,limit:options?.courseSkillRetrievalLimit,env:options.env},{search:options.memorySearch}):{status:'failed' as const,crossCourseGuard:'passed' as const,eventIds:[],evidenceRefs:[],snippets:[]};
  const retrievalEvent = retrieval.status === 'loaded' ? 'retrieved' : retrieval.status;
  await traceCourse(data,options,`context.memory.${retrievalEvent}` ,retrieval.status==='failed'?'degraded':'ok',{course_entity_id:course.courseEntityId,result_count:retrieval.eventIds.length});
  await traceCourse(data,options,`context.guard.${retrieval.crossCourseGuard}` ,retrieval.crossCourseGuard==='passed'?'ok':'failed',{course_entity_id:course.courseEntityId});
  const resolvedCourseContext:NonNullable<MessagePayload['resolvedCourseContext']> = {
    course: { courseKey: course.courseKey, courseEntityId: course.courseEntityId, displayName: course.displayName },
    resolution: { confidence: 'high', matchedBy: resolution.matchedBy },
    context: { contextPackId: context.contextPackId, contextVersion: context.version, stale: context.stale, confirmedSummary: options?.courseSkillEnabled&&options.courseSkillContextFields?.length?projectRequiredCourseContext(bundle,options.courseSkillContextFields):context.agentMd.slice(0, 8000) },
    retrieval,
  };
  data.resolvedCourseContext=resolvedCourseContext;
  if (!options?.sessionManager || !options.sessionKey) return { status: 'ready', context: resolvedCourseContext };
  const binding = await options.sessionManager.bindActiveCourse(options.sessionKey, {
    courseKey: course.courseKey, courseEntityId: course.courseEntityId, source: 'resolver',
    boundAt: new Date().toISOString(), contextPackId: context.contextPackId,
  });
  const bindingSucceeded = binding.status === 'persisted';
  await traceCourse(data,options,`context.binding.${bindingSucceeded?'updated':'failed'}`,bindingSucceeded?'ok':'failed',{course_key:course.courseKey,course_entity_id:course.courseEntityId,reason_code:binding.status});
  data.platformMetadata.courseContextBinding = binding;
  return { status: 'ready', context: resolvedCourseContext, bindingStatus: binding, replay };
}
