import {
  createChildSpan,
  createLogger,
  ErrorCode,
  extractTraceId,
  generateTraceId,
  generateWorkerToken,
  getTraceparent,
  type GuardrailRegistry,
  type MessagePayload,
  OrchestratorError,
  retryWithBackoff,
  runGuardrailInstances,
  SpanStatusCode,
} from "@lobu/core";
import type {Env} from '@lobu/connector-sdk';
import { createHash } from "node:crypto";
import { resolveAgentGuardrails } from "../guardrails/aggregator.js";
import * as Sentry from "@sentry/node";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { computeSessionKey, type ISessionManager } from "../session.js";
import { platformMetadataString } from "../connections/platform-metadata.js";
import { recordGuardrailTrip } from "../guardrails/audit.js";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue/index.js";
import {
  RunsQueue,
  TERMINAL_DELIVERY_SEND_OPTS,
} from "../infrastructure/queue/index.js";
import { armTurnTimeout, failTurnIfPending } from "./turn-liveness.js";
import { attachCourseContextForReviewedScope, isExplicitPersonalBypass, type CourseContextGateResult } from "./course-context-gate.js";
import type {CourseMemorySearch} from './course-memory-retriever.js';
import {resolveCourseSkillContextMetadata,selectActiveCourseSkill} from './course-skill-context-metadata.js';
import { emitJourneyEvent as emitJourneyObsEvent } from "../services/journey-observability.js";
import {
  type BaseDeploymentManager,
  buildCanonicalConversationKey,
  generateDeploymentName,
  type OrchestratorConfig,
} from "./base-deployment-manager.js";

const logger = createLogger("orchestrator");
export type CourseContextGateMode = "off" | "shadow" | "single_course" | "enforce";
export function parseCourseContextRolloutConfig(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): { mode: CourseContextGateMode; legacyFallback: boolean } {
  const rawMode = source.COURSE_CONTEXT_GATE_MODE?.trim().toLowerCase();
  const mode: CourseContextGateMode = rawMode === undefined ? "enforce" : rawMode === "off" || rawMode === "shadow" || rawMode === "single_course" || rawMode === "enforce" ? rawMode : "off";
  return { mode, legacyFallback: source.COURSE_CONTEXT_LEGACY_FALLBACK?.trim().toLowerCase() === "true" };
}
export type LegacyComparison = "match"|"mismatch"|"legacy_missing"|"resolved_missing";
export function compareCourseContextIdentity(resolved:{courseKey:string;courseEntityId:string}|undefined,legacy:{courseKey:string;courseEntityId:string}|undefined):LegacyComparison{if(!resolved)return"resolved_missing";if(!legacy)return"legacy_missing";return resolved.courseKey===legacy.courseKey&&resolved.courseEntityId===legacy.courseEntityId?"match":"mismatch";}
function hasTrustedCourseContext(data:MessagePayload,context:NonNullable<MessagePayload['resolvedCourseContext']>):boolean{const trust=context.trust;return Boolean(trust&&trust.ownerUserId===data.userId&&trust.agentId===data.agentId&&trust.conversationId===data.conversationId&&trust.courseKey===context.course.courseKey&&trust.courseEntityId===context.course.courseEntityId&&trust.contextPackId===context.context.contextPackId&&trust.contextVersion===context.context.contextVersion&&Number.isSafeInteger(trust.contextVersion)&&trust.contextVersion>0&&context.retrieval.crossCourseGuard==='passed');}
type LegacyCourseContext={courseKey:string;courseEntityId:string;contextPackId:string;contextVersion:number;stale:boolean;confirmedSummary:string};
async function readLegacyCourseContext(data:MessagePayload):Promise<LegacyCourseContext|undefined>{const root=process.env.COURSE_CONTEXT_LEGACY_COMPARE_URL?.trim();const secret=process.env.TOOLBOX_INTERNAL_SECRET?.trim();if(!root||!secret)return undefined;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),500);try{const url=new URL(root);url.searchParams.set('ownerUserId',data.userId);url.searchParams.set('agentId',data.agentId);const response=await fetch(url,{headers:{'x-internal-secret':secret},signal:controller.signal});if(response.status===404)return undefined;if(!response.ok)return undefined;const value=await response.json() as Record<string,unknown>;if(typeof value.courseKey!=="string"||value.courseKey.length>200||typeof value.courseEntityId!=="string"||value.courseEntityId.length>300||typeof value.contextPackId!=="string"||value.contextPackId.length>300||!Number.isInteger(value.contextVersion)||typeof value.stale!=="boolean"||typeof value.confirmedSummary!=="string"||value.confirmedSummary.length>8000)return undefined;return value as LegacyCourseContext;}catch{return undefined;}finally{clearTimeout(timer);}}
export function buildCourseMemorySearchEnv(source:NodeJS.ProcessEnv=process.env):Env{return{ENVIRONMENT:source.ENVIRONMENT??'production',EMBEDDINGS_SERVICE_URL:source.EMBEDDINGS_SERVICE_URL,EMBEDDINGS_SERVICE_TOKEN:source.EMBEDDINGS_SERVICE_TOKEN,EMBEDDINGS_MODEL:source.EMBEDDINGS_MODEL,EMBEDDINGS_DIMENSIONS:source.EMBEDDINGS_DIMENSIONS,EMBEDDINGS_TIMEOUT_MS:source.EMBEDDINGS_TIMEOUT_MS};}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function mintRunJobToken(
  data: MessagePayload,
  effectiveConversationId: string,
  deploymentName: string,
  includeTrustedCourseScope = false
): string | undefined {
  if (data.runId === undefined) return undefined;
  return generateWorkerToken(data.userId, effectiveConversationId, deploymentName, {
    channelId: data.channelId,
    teamId: data.teamId || getStringField(data.platformMetadata, "teamId"),
    agentId: data.agentId,
    organizationId: data.organizationId,
    platform: data.platform,
    connectionId:
      getStringField(data.platformMetadata, "connectionId") ??
      (data.platform === "api" ? effectiveConversationId : undefined),
    traceId: extractTraceId(data),
    runId: data.runId,
    messageId: data.messageId,
    processedMessageIds: [data.messageId],
    tokenKind: "run",
    executionMode: data.trustedExecutionScope?.mode === "onboarding"
      ? "onboarding"
      : includeTrustedCourseScope && data.resolvedCourseContext
        ? "course"
        : "personal",
    courseToolScope: includeTrustedCourseScope && data.resolvedCourseContext?.trust ? {
      ownerUserId: data.resolvedCourseContext.trust.ownerUserId,
      agentId: data.resolvedCourseContext.trust.agentId,
      courseEntityId: data.resolvedCourseContext.trust.courseEntityId,
    } : undefined,
  });
}

export function workerMessageSingletonKey(data: MessagePayload): string {
  const canonical = buildCanonicalConversationKey({ platform:data.platform,channelId:data.channelId,conversationId:data.conversationId });
  return `worker-message:${createHash("sha256").update(`${data.organizationId ?? ""}\0${data.agentId ?? ""}\0${canonical}\0${data.messageId}`).digest("hex")}`;
}

export function terminalCourseContextSingletonKey(
  data: MessagePayload,
  result: Exclude<CourseContextGateResult, {status:"ready"}|{status:"not_required"}|{status:"already_dispatched"}>,
): string {
  const canonical = buildCanonicalConversationKey({ platform:data.platform,channelId:data.channelId,conversationId:data.conversationId });
  const outcome = result.status === "clarification_required"
    ? `${result.status}:${result.candidates.map((candidate) => candidate.courseKey).sort().join(",")}`
    : result.status;
  return `course-terminal:${createHash("sha256").update(`${data.organizationId ?? ""}\0${data.agentId ?? ""}\0${canonical}\0${data.messageId ?? ""}\0${outcome}`).digest("hex")}`;
}

export class MessageConsumer {
  private queue: IMessageQueue;
  private deploymentManager: BaseDeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;
  /**
   * Per-process deployment-creation lock. The embedded-only server
   * has a single MessageConsumer instance per process, so an in-memory Set
   * is sufficient for the "two consecutive messages for the same thread
   * race to create the deployment" guard. The cross-pod guard is the PG
   * advisory lock in BaseDeploymentManager — this Set is pod-local only.
   */
  private deploymentLocks = new Set<string>();
  private agentSettingsStore?: AgentSettingsStore;
  private guardrailRegistry?: GuardrailRegistry;
  private readonly courseContextResolver: (payload: MessagePayload) => Promise<CourseContextGateResult | void>;
  private readonly courseContextRollout: ReturnType<typeof parseCourseContextRolloutConfig>;
  private readonly journeyEmitter: (event:Parameters<typeof emitJourneyObsEvent>[0],signal?:AbortSignal)=>Promise<void>;
  private async emitJourneyFailOpen(event:Parameters<typeof emitJourneyObsEvent>[0]):Promise<void>{const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;try{const operation=this.journeyEmitter(event,controller.signal);const guarded=operation.catch(()=>{});await Promise.race([guarded,new Promise<void>(resolve=>{timeout=setTimeout(()=>{controller.abort();resolve();},20);})]);}catch{}finally{if(timeout)clearTimeout(timeout);}}
  private sessionManager?: ISessionManager;
  private courseMemorySearch?:CourseMemorySearch;
  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager,
    queue?: IMessageQueue,
    courseContextResolver: (payload: MessagePayload) => Promise<CourseContextGateResult | void> = attachCourseContextForReviewedScope,
    journeyEmitter: (event:Parameters<typeof emitJourneyObsEvent>[0],signal?:AbortSignal)=>Promise<void> = emitJourneyObsEvent,
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = queue ?? new RunsQueue();
    this.courseContextResolver = courseContextResolver;
    this.courseContextRollout = parseCourseContextRolloutConfig();
    this.journeyEmitter = journeyEmitter;
  }

  private async dispatchCourseContextBoundary(data: MessagePayload, deploymentName: string): Promise<boolean> {
    // The execution scope is an internal orchestration fact. Never trust a
    // caller/model supplied value, including on rollout bypass paths.
    delete data.trustedExecutionScope;
    // Resolved course context is equally privileged: every accepted value
    // must be freshly minted by this turn's resolver, never carried in from
    // an inbound API/platform payload.
    delete data.resolvedCourseContext;
    if (this.courseContextRollout.mode === "off") {
      data.runJobToken = mintRunJobToken(data, data.conversationId, deploymentName);
      await armTurnTimeout(this.queue, { messageId:data.messageId,channelId:data.channelId,conversationId:data.conversationId,userId:data.userId,platform:data.platform,platformMetadata:data.platformMetadata,deploymentName,organizationId:data.organizationId });
      await this.sendToWorkerQueue(data, deploymentName);
      return true;
    }
    let result: CourseContextGateResult | void;
    const isNonBindingEvaluation = this.courseContextRollout.mode === "shadow" || this.courseContextRollout.mode === "single_course";
    const shadowPayload = isNonBindingEvaluation ? { ...data, platformMetadata: { ...data.platformMetadata }, resolvedCourseContext: undefined } : data;
    try { if (this.courseContextResolver === attachCourseContextForReviewedScope) {
      const personalBypass = isExplicitPersonalBypass(shadowPayload);
      if (!personalBypass && data.platformMetadata?.courseScope === "reviewed" && !this.sessionManager) {
        throw new Error("Course context persistence is not initialized");
      }
      let settings = null; if (!personalBypass) try { settings = data.agentId && this.agentSettingsStore ? await this.agentSettingsStore.getSettings(data.agentId) : null; } catch { logger.warn({ category: "course_skill_settings", agentId: data.agentId }, "Course skill settings unavailable; using deterministic message scope"); }
      const courseSkillContext=resolveCourseSkillContextMetadata(settings?.skillsConfig?.skills??[]);
      const activeCourseSkill=selectActiveCourseSkill({available:courseSkillContext,message:typeof shadowPayload.messageText==='string'?shadowPayload.messageText:''});
      result = await attachCourseContextForReviewedScope(shadowPayload, {
        baseUrl: process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim() ?? "", secret: process.env.TOOLBOX_INTERNAL_SECRET?.trim() ?? "",
        sessionManager:isNonBindingEvaluation ? undefined : this.sessionManager,sessionKey:computeSessionKey(data),oppCoachAvailable:courseSkillContext.oppCoachAvailable,activeSpecializedSkill:activeCourseSkill.activeSpecializedSkill,courseSkillContextFields:courseSkillContext.contextFields,courseSkillRetrievalTerms:courseSkillContext.retrievalTerms,courseSkillRetrievalLimit:courseSkillContext.retrievalLimit,memorySearch:this.courseMemorySearch,env:buildCourseMemorySearchEnv(),
      });
    } else {
      result = await this.courseContextResolver(shadowPayload);
    }} catch(error) { if(this.courseContextRollout.mode!=="shadow")throw error; result={status:"not_required"}; await this.emitJourneyFailOpen({trace_id:extractTraceId(data)??`tr_${createHash("sha256").update(data.messageId??data.conversationId).digest("hex").slice(0,32)}`,journey_id:"course_context_gate",event:"context.course.missing",service:"lobu",module:"course-context-gate",status:"failed",reason_code:"resolver_unavailable"}); }
    if(this.courseContextRollout.mode==="shadow"){
      const resolved=result?.status==="ready"?result.context.course:result?.status==="context_unavailable"?result.resolvedCourse:undefined;const legacy=await readLegacyCourseContext(data);const comparison=compareCourseContextIdentity(resolved,legacy);await this.emitJourneyFailOpen({trace_id:extractTraceId(data)??`tr_${createHash("sha256").update(data.messageId??data.conversationId).digest("hex").slice(0,32)}`,journey_id:"course_context_gate",event:"context.legacy.compared",service:"lobu",module:"course-context-gate",status:"ok",comparison});
    }
    if (this.courseContextRollout.mode === "shadow") result = { status: "not_required" };
    if(this.courseContextRollout.mode==="enforce"&&this.courseContextRollout.legacyFallback&&result?.status==="context_unavailable"&&result.resolvedCourse){const legacy=await readLegacyCourseContext(data);if(compareCourseContextIdentity(result.resolvedCourse,legacy)==="match")await this.emitJourneyFailOpen({trace_id:extractTraceId(data)??`tr_${createHash("sha256").update(data.messageId??data.conversationId).digest("hex").slice(0,32)}`,journey_id:"course_context_gate",event:"context.legacy.compared",service:"lobu",module:"course-context-gate",status:"ok",comparison:"match"});}
    if(result?.status==='ready'&&!hasTrustedCourseContext(data,result.context)){delete data.resolvedCourseContext;result={status:'context_unavailable',reasonCode:'untrusted_context'};}
    if (this.courseContextRollout.mode === "single_course") {
      const isSingleCourseDefault = result?.status === "ready" && result.context.resolution.matchedBy.includes("single_course_default");
      if (isSingleCourseDefault) data.resolvedCourseContext = shadowPayload.resolvedCourseContext;
      // Only the gate's deterministic non-course/personal classification may
      // bypass. A course-scoped timeout, unavailable bundle, mismatch,
      // onboarding gap, or ambiguity remains terminal and can never reach the
      // worker without canonical context.
      else if (result?.status === "ready") result = { status: "context_unavailable", reasonCode: "single_course_not_confirmed" };
    }
    if(data.resolvedCourseContext&&!hasTrustedCourseContext(data,data.resolvedCourseContext)){delete data.resolvedCourseContext;result={status:'context_unavailable',reasonCode:'untrusted_context'};}
    if(result?.status==='ready'&&this.courseContextRollout.mode==='enforce'){
      const context=result.context;
      data.trustedExecutionScope={mode:'course',ownerUserId:data.userId,agentId:data.agentId,conversationId:data.conversationId,courseEntityId:context.course.courseEntityId,contextPackId:context.context.contextPackId,contextVersion:context.context.contextVersion,activeSpecializedSkill:context.activeSpecializedSkill};
    }
    if (result?.status === "onboarding_ready") {
      // Onboarding and resolved-course execution are mutually exclusive,
      // including when an injected/custom resolver accidentally mutates data.
      delete data.resolvedCourseContext;
      if (this.courseContextRollout.mode !== "enforce") {
        result = { status: "context_unavailable", reasonCode: "onboarding_scope_not_enforced" };
      } else if (
        result.scope.ownerUserId !== data.userId ||
        result.scope.agentId !== data.agentId ||
        result.scope.conversationId !== data.conversationId
      ) {
        result = { status: "context_unavailable", reasonCode: "onboarding_scope_mismatch" };
      } else {
        data.trustedExecutionScope = result.scope;
      }
    }
    if (result?.status === "already_dispatched") return false;
    if (result?.status === "clarification_required" || result?.status === "context_unavailable") {
      await this.deliverCourseContextTerminal(data, result);
      return false;
    }
    data.runJobToken = mintRunJobToken(data, data.conversationId, deploymentName, this.courseContextRollout.mode === "enforce" && result?.status === "ready");
    await armTurnTimeout(this.queue, {
      messageId: data.messageId, channelId: data.channelId, conversationId: data.conversationId,
      userId: data.userId, platform: data.platform, platformMetadata: data.platformMetadata,
      deploymentName, organizationId: data.organizationId,
    });
    await this.sendToWorkerQueue(data, deploymentName);
    if (result?.status === "ready" && result.replay && this.sessionManager) {
      let marked = await this.sessionManager.markPendingCourseSelectionDispatched(computeSessionKey(data), result.replay.pendingId, data.userId, data.agentId, result.replay.messageId);
      for(let attempt=1;marked.status==='failed'&&attempt<3;attempt++)marked=await this.sessionManager.markPendingCourseSelectionDispatched(computeSessionKey(data),result.replay.pendingId,data.userId,data.agentId,result.replay.messageId);
      if(marked.status==='failed')logger.warn({category:"pending_dispatch_mark",pendingId:result.replay.pendingId},"Course selection dispatched; dispatch marker deferred");
      const cleared = await this.sessionManager.clearPendingCourseSelection(computeSessionKey(data), result.replay.pendingId, data.userId, data.agentId, result.replay.messageId);
      if (cleared.status !== "cleared" && cleared.status !== "stale") logger.warn({ category:"pending_cleanup", pendingId:result.replay.pendingId }, "Course selection dispatched; pending cleanup deferred");
    }
    return true;
  }

  private async deliverCourseContextTerminal(data: MessagePayload, result: Exclude<CourseContextGateResult, {status:"ready"}|{status:"not_required"}|{status:"already_dispatched"}>): Promise<void> {
    const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, " ").slice(0, 200);
    const finalText = result.status === "clarification_required"
      ? `請選擇這次要處理的課程：\n${result.candidates.map((candidate, index) => `${index + 1}. ${clean(candidate.displayName)}`).join("\n")}`
      : result.status==='context_unavailable'&&result.displayName ? `目前無法取得「${clean(result.displayName)}」的課程資料，請稍後再試。` : "目前無法取得課程資料，請稍後再試。";
    await this.queue.createQueue("thread_response");
    await this.queue.send("thread_response", { messageId:data.messageId,userId:data.userId,agentId:data.agentId,organizationId:data.organizationId,channelId:data.channelId,conversationId:data.conversationId,platform:data.platform,platformMetadata:data.platformMetadata,finalText,processedMessageIds:[data.messageId],timestamp:Date.now(),teamId:data.teamId ?? getStringField(data.platformMetadata,"teamId") ?? "" }, {
      ...TERMINAL_DELIVERY_SEND_OPTS,
      singletonKey: terminalCourseContextSingletonKey(data, result),
      durableSingleton: true,
    });
  }

  /**
   * Inject guardrail infrastructure post-construction. Called by the
   * Orchestrator after CoreServices has built the registry — the consumer
   * is constructed earlier than CoreServices is wired up, so a setter
   * matches the existing `injectCoreServices` pattern on the orchestrator.
   * Calling with no args is a no-op (guardrails simply don't run).
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.guardrailRegistry = registry;
    this.agentSettingsStore = settingsStore;
  }

  setSessionManager(sessionManager: ISessionManager): void {
    this.sessionManager = sessionManager;
  }
  setCourseMemorySearch(search:CourseMemorySearch):void{this.courseMemorySearch=search;}

  async start(): Promise<void> {
    try {
      await this.queue.start();
      this.isRunning = true;

      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      logger.debug("Created/verified messages queue");

      // Subscribe to the single messages queue for all messages
      await this.queue.work(
        "messages",
        async (job: SharedQueueJob<MessagePayload>) => {
          return await Sentry.startSpan(
            {
              name: "orchestrator.process_queue_job",
              op: "orchestrator.queue_processing",
              attributes: {
                "job.id": job?.id || "unknown",
              },
            },
            async () => {
              return this.handleMessage(job);
            }
          );
        }
      );

      logger.debug("Queue consumer started");
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to start queue consumer: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.queue.stop();
  }

  /**
   * Handle all messages - creates deployment for new threads or routes to existing thread queues
   */
  private async handleMessage(
    job: SharedQueueJob<MessagePayload>
  ): Promise<void> {
    const data = job?.data;
    const jobId = job?.id || "unknown";

    // Extract traceparent for distributed tracing (from message ingestion)
    const traceparent = platformMetadataString(
      data?.platformMetadata,
      "traceparent"
    );

    // Extract or generate trace ID for logging (backwards compatible)
    const traceId =
      extractTraceId(data) || generateTraceId(data?.messageId || jobId);

    // Add traceId to Sentry scope for correlation
    Sentry.getCurrentScope().setTag("traceId", traceId);

    // Create child span for queue processing (linked to message_received span)
    const queueSpan = createChildSpan("queue_processing", traceparent, {
      "lobu.trace_id": traceId,
      "lobu.job_id": jobId,
      "lobu.user_id": data?.userId || "unknown",
      "lobu.conversation_id": data?.conversationId || "unknown",
    });

    // Get traceparent to pass to worker (for further context propagation)
    const childTraceparent = getTraceparent(queueSpan) || traceparent;

    logger.info(
      {
        traceparent,
        traceId,
        jobId,
        userId: data?.userId,
        conversationId: data?.conversationId,
      },
      "Processing job with trace context"
    );

    try {
      // The runs-queue claim sets `job.id = String(runId)` when it
      // dispatches into this handler. Stamp the runId onto the payload so
      // it survives the thread_message_{deployment} hop and reaches the
      // worker — the per-run agent_transcript_snapshot POST needs it to
      // attribute snapshots to the right run (codex P1#1 on PR #865).
      // Best-effort parse; non-numeric ids (legacy direct enqueue paths)
      // leave the field undefined and the snapshot path falls back to
      // skipping the write.
      const parsedRunId = Number(jobId);
      if (Number.isFinite(parsedRunId) && parsedRunId > 0) {
        data.runId = parsedRunId;
      }

      // CRITICAL: For consistent worker naming, conversationId must be the root conversation ID
      // (e.g., Slack thread root ts), not individual message timestamps.
      const effectiveConversationId = data.conversationId;
      if (!effectiveConversationId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "conversationId is required for message routing",
          { messageId: data.messageId, userId: data.userId },
          true
        );
      }

      const canonicalConversationKey = buildCanonicalConversationKey({
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });
      const deploymentName = generateDeploymentName({
        userId: data.userId,
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });

      // Mint a per-run worker JWT bound to this exact `runs.id` and pass
      // it to the worker via the message payload. The snapshot route uses
      // it to enforce `tokenData.runId === body.runId`, so a worker
      // bearing a same-(org, agent, conv) deployment-lifetime token
      // cannot POST under a different run's slot. Codex round 2 finding
      // A on PR #865. Without a parsed runId (legacy direct-enqueue
      // path) we skip the mint; the snapshot path then declines to write
      // (worker-side runId is undefined and writeSnapshot bails).
      logger.info(
        `Conversation routing - effectiveConversationId: ${effectiveConversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
      );

      // Input-stage guardrails: short-circuit dispatch when an enabled
      // guardrail trips. We surface the trip reason to the user via the
      // `thread_response` queue (same path `trackFailedDeployment` uses)
      // and skip both the worker queue enqueue and the deployment ensure.
      // The trip is captured here but DELIVERED below (outside the fail-open
      // try-catch) so a delivery failure can't be swallowed into dispatch.
      let inputTrip: { reason: string; guardrail: string } | null = null;
      if (
        this.guardrailRegistry &&
        this.agentSettingsStore &&
        data.agentId &&
        data.messageText
      ) {
        try {
          const settings = await this.agentSettingsStore.getSettings(
            data.agentId
          );
          const resolved = resolveAgentGuardrails(
            settings ?? { guardrails: [] },
            (settings?.skillsConfig?.skills ?? []).filter((s) => s.enabled),
            this.guardrailRegistry
          );
          const list = resolved.byStage.input;
          if (list.length > 0) {
            const outcome = await runGuardrailInstances("input", list, {
              agentId: data.agentId,
              userId: data.userId,
              message: data.messageText,
              platform: data.platform,
              conversationId: effectiveConversationId,
            });
            if (outcome.tripped) {
              // Resolve org id with a metadata fallback so a trip never
              // silently drops the audit — legacy/test enqueues can omit it.
              let resolvedOrgId = data.organizationId;
              if (!resolvedOrgId && this.agentSettingsStore) {
                try {
                  const md = await this.agentSettingsStore.getMetadata(
                    data.agentId
                  );
                  resolvedOrgId = md?.organizationId;
                } catch (lookupErr) {
                  logger.warn(
                    {
                      agentId: data.agentId,
                      err:
                        lookupErr instanceof Error
                          ? lookupErr.message
                          : String(lookupErr),
                    },
                    "Input guardrail trip: orgId metadata lookup failed (audit may be skipped)"
                  );
                }
              }
              void recordGuardrailTrip({
                organizationId: resolvedOrgId,
                agentId: data.agentId,
                userId: data.userId,
                conversationId: effectiveConversationId,
                stage: "input",
                guardrail: outcome.tripped.guardrail,
                reason: outcome.tripped.reason,
                metadata: outcome.tripped.metadata,
              });
              // Capture the trip; the rejection is DELIVERED below, outside this
              // fail-open try-catch. Delivering here would let a delivery
              // failure be caught by the catch and fall through to dispatch the
              // blocked input — the opposite of what a trip must do.
              inputTrip = {
                reason: outcome.tripped.reason ?? "blocked by policy",
                guardrail: outcome.tripped.guardrail,
              };
            }
          }
        } catch (err) {
          // Fail open on store/registry-level errors — the runner already
          // fail-opens on per-guardrail throws.
          logger.warn(
            {
              agentId: data.agentId,
              err: err instanceof Error ? err.message : String(err),
            },
            "Input guardrail check failed — proceeding without guardrails"
          );
        }
      }

      // Deliver a guardrail rejection OUTSIDE the fail-open try-catch above. A
      // delivery failure here MUST propagate so the `messages` run retries (the
      // trip is deterministic) — it must never be swallowed and fall through to
      // dispatching the blocked input. Routed via `error` (renders end-to-end:
      // SSE error event + CLI exit 1; platforms post `Error: …`). No turn marker
      // is armed for a rejected turn, so the message-queue retry is the backstop.
      if (inputTrip) {
        const responseQueue = "thread_response";
        await this.queue.createQueue(responseQueue);
        await this.queue.send(
          responseQueue,
          {
            messageId: data.messageId,
            userId: data.userId,
            channelId: data.channelId,
            conversationId: data.conversationId,
            platform: data.platform,
            platformMetadata: data.platformMetadata,
            error: `Message rejected: ${inputTrip.reason}`,
            processedMessageIds: [data.messageId],
          },
          TERMINAL_DELIVERY_SEND_OPTS
        );
        logger.info(
          {
            agentId: data.agentId,
            guardrail: inputTrip.guardrail,
            conversationId: effectiveConversationId,
          },
          "Input guardrail tripped — message dropped"
        );
        queueSpan?.setStatus({ code: SpanStatusCode.OK });
        queueSpan?.end();
        return;
      }

      // Arm the turn-liveness marker BEFORE the message is deliverable to the
      // worker. The marker is the durable record that this turn owes the client
      // a terminal event; it is discharged on the worker's reply and otherwise
      // failed (fast path on crash, deadline backstop on hang/pod-death) into a
      // terminal `error`. Arming first closes a race where an already-running
      // worker could reply before the marker exists — the discharge would
      // no-op, then a stale marker would be armed and the sweep would emit a
      // spurious error after a successful turn.
      // 1) Resolve the reviewed course scope, durably arm the turn, then send
      // without unrelated awaited work between arming and dispatch.
      const workerDispatched = await Sentry.startSpan(
        {
          name: "orchestrator.send_to_worker_queue",
          op: "orchestrator.message_routing",
          attributes: {
            "user.id": data.userId,
            "conversation.id": effectiveConversationId || "unknown",
            "deployment.name": deploymentName,
          },
        },
        async () => {
          return await this.dispatchCourseContextBoundary(data, deploymentName);
        }
      );

      if (!workerDispatched) { queueSpan?.setStatus({ code: SpanStatusCode.OK }); queueSpan?.end(); return; }

      logger.info(
        { traceId, traceparent: childTraceparent, deploymentName },
        "Enqueued message to thread queue"
      );

      // 2) Ensure worker exists in the background (don't block queue send)
      // Pass traceparent for propagation to worker deployment
      this.ensureWorkerExists(
        deploymentName,
        data,
        effectiveConversationId,
        traceId,
        childTraceparent
      ).catch((bgError) => {
        // Capture error for monitoring and alerting
        Sentry.captureException(bgError, {
          tags: {
            component: "deployment-creation",
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          level: "error",
        });

        logger.error(
          {
            traceId,
            error: bgError instanceof Error ? bgError.message : String(bgError),
            stack: bgError instanceof Error ? bgError.stack : undefined,
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          "Critical: Background worker creation failed. Messages are queued but worker unavailable."
        );

        // Track failed deployments for monitoring and potential retry
        this.trackFailedDeployment(deploymentName, data, bgError).catch(
          (trackError) => {
            logger.error("Failed to track deployment failure:", trackError);
          }
        );
      });

      queueSpan?.setStatus({ code: SpanStatusCode.OK });
      queueSpan?.end();

      logger.info({ traceId, jobId }, "Message job queued successfully");
    } catch (error) {
      queueSpan?.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      queueSpan?.end();
      Sentry.captureException(error);
      logger.error({ traceId, jobId, error }, "Message job failed");

      // Re-throw for queue retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process message job: ${error instanceof Error ? error.message : String(error)}`,
        { jobId, data, error },
        true
      );
    }
  }

  /**
   * Send message to worker queue for the worker to consume
   */
  private async sendToWorkerQueue(
    data: MessagePayload,
    deploymentName: string
  ): Promise<void> {
    try {
      // Create thread-specific queue name: thread_message_[deploymentid]
      const threadQueueName = `thread_message_${deploymentName}`;

      // Create the thread-specific queue if it doesn't exist
      await this.queue.createQueue(threadQueueName);

      // Send message to thread-specific queue
      const jobId = await this.queue.send(threadQueueName, data, {
        expireInSeconds: this.config.queues.expireInSeconds,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: 2, // 2 seconds — fast retry for stale connection recovery
        priority: 10, // Thread messages have high priority
        singletonKey: workerMessageSingletonKey(data),
        durableSingleton: true,
      });

      if (!jobId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          `queue.send() returned null/undefined for queue: ${threadQueueName}`,
          { threadQueueName, deploymentName },
          true
        );
      }

      logger.info(
        `✅ Sent message to thread queue ${threadQueueName} for conversation ${data.conversationId}, jobId: ${jobId}`
      );
    } catch (error) {
      logger.error(`❌ [ERROR] sendToWorkerQueue failed:`, error);
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to send message to thread queue: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, data, error },
        true
      );
    }
  }

  /**
   * Acquire a per-process lock for deployment creation. Prevents two
   * concurrent message handlers from racing to create the same deployment.
   * In embedded mode the gateway is single-process; an in-memory Map is
   * the right primitive here (TTL is not needed because the lock is held
   * for the duration of the awaited create call and released in finally).
   */
  private acquireDeploymentLock(deploymentName: string): boolean {
    if (this.deploymentLocks.has(deploymentName)) return false;
    this.deploymentLocks.add(deploymentName);
    return true;
  }

  private releaseDeploymentLock(deploymentName: string): void {
    this.deploymentLocks.delete(deploymentName);
  }

  /**
   * Ensure worker deployment exists for a thread
   * Uses shared retry utility with linear backoff + jitter
   * Uses an advisory lock to prevent concurrent duplicate deployment creation
   */
  private async ensureWorkerExists(
    deploymentName: string,
    data: MessagePayload,
    conversationId: string,
    traceId: string,
    traceparent?: string
  ): Promise<void> {
    return retryWithBackoff(
      async () => {
        // Ensure traceparent is in platformMetadata for worker deployment
        const dataWithTrace: MessagePayload = {
          ...data,
          platformMetadata: {
            ...data.platformMetadata,
            traceparent: traceparent || data.platformMetadata?.traceparent,
          },
        };

        // Check if this is truly a new thread by looking for existing deployment
        const existingDeployments =
          await this.deploymentManager.listDeployments();
        const isNewThread = !existingDeployments.some(
          (d) => d.deploymentName === deploymentName
        );

        if (isNewThread) {
          const acquired = this.acquireDeploymentLock(deploymentName);
          if (!acquired) {
            logger.info(
              { traceId, deploymentName },
              "Another handler is creating this deployment, waiting"
            );
            await new Promise((r) => setTimeout(r, 3000));
            const rechecked = await this.deploymentManager.listDeployments();
            if (rechecked.some((d) => d.deploymentName === deploymentName)) {
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              logger.info(
                { traceId, deploymentName },
                "Deployment created by other handler, scaled up"
              );
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }
            throw new Error("Deployment lock held but deployment not created");
          }

          try {
            // Re-check after acquiring lock — another handler in this process
            // may have completed creation between our initial check and the
            // lock acquisition.
            const recheckAfterLock =
              await this.deploymentManager.listDeployments();
            if (
              recheckAfterLock.some((d) => d.deploymentName === deploymentName)
            ) {
              logger.info(
                { traceId, deploymentName },
                "Deployment already created by another handler after lock acquired"
              );
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }

            logger.info(
              { traceId, traceparent, conversationId, deploymentName },
              "New thread - creating deployment"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace,
              recheckAfterLock
            );
            logger.info({ traceId, deploymentName }, "Created deployment");
          } finally {
            this.releaseDeploymentLock(deploymentName);
          }
        } else {
          logger.info(
            { traceId, conversationId, deploymentName },
            "Existing thread - ensuring worker exists"
          );
          // Sync network config domains to grant store (picks up settings changes)
          await this.deploymentManager.syncNetworkConfigGrants(dataWithTrace);
          try {
            await this.deploymentManager.scaleDeployment(deploymentName, 1);
            logger.info(
              { traceId, deploymentName },
              "Scaled existing worker to 1"
            );
          } catch {
            logger.info(
              { traceId, conversationId, deploymentName },
              "Worker doesn't exist, creating it"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace
            );
            logger.info({ traceId, deploymentName }, "Created worker");
          }
        }

        // Update deployment activity annotation for simplified tracking
        await this.deploymentManager.updateDeploymentActivity(deploymentName);

        logger.info({ traceId, deploymentName }, "Worker is ready");
      },
      {
        maxRetries: 3,
        baseDelay: 2000,
        strategy: "linear",
        jitter: true,
        onRetry: (attempt, error) => {
          logger.warn(
            { traceId, deploymentName, attempt, maxAttempts: 3 },
            `Retry attempt failed: ${error.message}`
          );
        },
      }
    );
  }

  /**
   * Track failed deployment creation. Sends the error response to the user
   * via the thread_response queue; structured logs cover ops visibility.
   */
  private async trackFailedDeployment(
    deploymentName: string,
    data: MessagePayload,
    error: unknown
  ): Promise<void> {
    try {
      logger.error(
        {
          deploymentName,
          userId: data.userId,
          conversationId: data.conversationId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          queueName: `thread_message_${deploymentName}`,
        },
        "Deployment creation failed"
      );

      const userMessage =
        "Worker startup failed and your request could not be processed. Please retry in a moment.";

      // Emit the startup-failure notice through the first-writer-wins election
      // (atomic delete-marker + enqueue-error in one tx). This is gated on the
      // marker still being pending: if a still-attached worker raced a real
      // terminal reply (which discharged the marker), this no-ops instead of
      // double-signalling the client. Routes via `error` (renders end-to-end:
      // SSE error event + CLI exit 1; platforms post `Error: …`). If the marker
      // was never armed (arm failed) it also no-ops — logged at arm time.
      await failTurnIfPending(deploymentName, data.messageId, userMessage);
    } catch (trackError) {
      // Don't fail the main flow if tracking fails
      logger.error("Failed to track deployment failure:", trackError);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    messages?: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    };
    isRunning: boolean;
    error?: string;
  }> {
    try {
      const stats = await this.queue.getQueueStats("messages");
      return {
        messages: stats,
        isRunning: this.isRunning,
      };
    } catch (error) {
      logger.error("Failed to get queue stats:", error);
      return {
        isRunning: this.isRunning,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
