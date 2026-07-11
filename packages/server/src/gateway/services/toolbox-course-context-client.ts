type Fetcher = typeof fetch;
const MAX_ID = 200; const MAX_AGENT_MD = 50000;
export class ToolboxCourseContextResponseError extends Error { readonly code = 'invalid_toolbox_course_context_response'; }
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolboxCourseContextResponseError(); return v as Record<string, unknown>; }
function str(v: unknown, max = MAX_ID): string { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ToolboxCourseContextResponseError(); return v; }
function course(v: unknown) { const x = obj(v); return { courseKey: str(x.courseKey), courseEntityId: str(x.courseEntityId), displayName: str(x.displayName) }; }
function canonicalCourse(v: unknown) { const x = obj(v); if (!Array.isArray(x.aliases) || x.aliases.length > 50 || x.status !== 'active') throw new ToolboxCourseContextResponseError(); return { courseKey:str(x.courseKey),courseEntityId:str(x.courseEntityId),displayName:str(x.displayName,500),aliases:x.aliases.map((a)=>str(a)),status:'active' as const }; }
const CANDIDATE_REASONS = new Set(['message_name', 'message_alias']);
type ResolutionMatch = 'explicit_course_key' | 'message_name' | 'message_alias' | 'conversation_binding' | 'single_course_default';
const RESOLUTION_MATCHES = new Set(['explicit_course_key', 'message_name', 'message_alias', 'conversation_binding', 'single_course_default']);
type AmbiguousReason = 'alias_overlap' | 'name_overlap' | 'message_course_overlap' | 'multiple_active_courses' | 'explicit_course_key_not_found';
const AMBIGUOUS_REASONS = new Set(['alias_overlap', 'name_overlap', 'message_course_overlap', 'multiple_active_courses', 'explicit_course_key_not_found']);
function candidate(v: unknown) {
  const x = obj(v); const aliases = x.aliases; const reasons = x.reasons;
  if (!Array.isArray(aliases) || aliases.length > 20 || !Array.isArray(reasons) || reasons.length > 2) throw new ToolboxCourseContextResponseError();
  if (x.status !== 'active') throw new ToolboxCourseContextResponseError();
  return { ...course(x), aliases: aliases.map((a) => str(a)), status: x.status, reasons: reasons.map((r) => { const value = str(r); if (!CANDIDATE_REASONS.has(value)) throw new ToolboxCourseContextResponseError(); return value; }) };
}
export type ValidResolution = { status: 'resolved'; confidence: 'high'; matchedBy: [ResolutionMatch]; course: ReturnType<typeof course> };
export type ValidCourseResolution = ValidResolution | { status: 'ambiguous'; reason: AmbiguousReason; candidates: Array<ReturnType<typeof candidate>> } | { status: 'missing'; reason: 'no_courses' | 'archived_only' };
export type ValidBundle = { course: ReturnType<typeof canonicalCourse>; context: { agentMd: string; contextPackId: string; version: number; confidence: 'high'|'medium'|'low'; generatedAt: string; lastIndexedAt: string|null; stale: boolean } };
function nullable(v: unknown, max = MAX_ID): string|null { return v === null ? null : str(v, max); }
function profile(v: unknown) { const x=obj(v); if (!Array.isArray(x.collaborators) || x.collaborators.length>100) throw new ToolboxCourseContextResponseError(); const collaborators=x.collaborators.map((v)=>{const c=obj(v);return {name:str(c.name),role:nullable(c.role)};}); const locations=obj(x.resourceLocations); if(Object.keys(locations).length>100)throw new ToolboxCourseContextResponseError(); for(const value of Object.values(locations)) nullable(value, 2000); return {pmRole:nullable(x.pmRole),teacher:nullable(x.teacher),collaborators,audience:nullable(x.audience,2000),coursePromise:nullable(x.coursePromise,2000)}; }
function evidenceRef(v: unknown) { const x=obj(v); return {id:str(x.id),sourceType:str(x.sourceType),sourceId:str(x.sourceId),sourceUrl:nullable(x.sourceUrl,2000),sourceTitle:nullable(x.sourceTitle,2000),excerptPreview:nullable(x.excerptPreview,500),evidenceKind:str(x.evidenceKind),confidence:str(x.confidence),observedAt:str(x.observedAt)}; }
function parseResolution(v: unknown): ValidCourseResolution {
  const x = obj(v);
  if (x.status === 'ambiguous') { if (typeof x.reason !== 'string' || !AMBIGUOUS_REASONS.has(x.reason) || !Array.isArray(x.candidates) || x.candidates.length < 1 || x.candidates.length > 20) throw new ToolboxCourseContextResponseError(); const candidates = x.candidates.map(candidate); return { status: 'ambiguous', reason: x.reason as AmbiguousReason, candidates }; }
  if (x.status === 'missing') { if (x.reason !== 'no_courses' && x.reason !== 'archived_only') throw new ToolboxCourseContextResponseError(); return { status: 'missing', reason: x.reason }; }
  if (x.status !== 'resolved' || x.confidence !== 'high' || !Array.isArray(x.matchedBy) || x.matchedBy.length !== 1 || typeof x.matchedBy[0] !== 'string' || !RESOLUTION_MATCHES.has(x.matchedBy[0])) throw new ToolboxCourseContextResponseError(); return { status: 'resolved', confidence: 'high', matchedBy: [x.matchedBy[0] as ResolutionMatch], course: course(x.course) };
}
function parseBundle(v: unknown): ValidBundle { const x=obj(v); profile(x.profile); const c=obj(x.context); const evidence=obj(x.evidence); const version=c.version; if(!Number.isInteger(version)||(version as number)<=0||typeof c.stale!=='boolean'||(c.confidence!=='high'&&c.confidence!=='medium'&&c.confidence!=='low')||!Array.isArray(evidence.confirmed)||!Array.isArray(evidence.candidates)||evidence.confirmed.length>100||evidence.candidates.length>100)throw new ToolboxCourseContextResponseError(); evidence.confirmed.map(evidenceRef); evidence.candidates.map(evidenceRef); return {course:canonicalCourse(x.course),context:{agentMd:str(c.agentMd,MAX_AGENT_MD),contextPackId:str(c.contextPackId),version:version as number,confidence:c.confidence,generatedAt:str(c.generatedAt),lastIndexedAt:nullable(c.lastIndexedAt),stale:c.stale}}; }

export type ToolboxCourseContextClientOptions = { baseUrl: string; secret: string; timeoutMs?: number; fetcher?: Fetcher };

export class ToolboxCourseContextClient {
  constructor(private readonly options: ToolboxCourseContextClientOptions) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 1500);
    try {
      const response = await (this.options.fetcher ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, { ...init, signal: controller.signal, headers: { ...init?.headers, 'x-internal-secret': this.options.secret } });
      if (!response.ok) throw new Error(`Toolbox course context request failed (${response.status})`);
      try { return JSON.parse(await response.text()); } catch { throw new ToolboxCourseContextResponseError(); }
    } finally { clearTimeout(timeout); }
  }

  async resolve(input: { ownerUserId: string; agentId: string; conversationId: string; message: string; boundCourseKey?: string; explicitCourseKey?: string }) {
    return parseResolution(await this.request('/internal/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  }
  async bundle(courseKey: string, input: { ownerUserId: string; agentId: string }) {
    const query = new URLSearchParams(input);
    return parseBundle(await this.request(`/internal/courses/${encodeURIComponent(courseKey)}?${query}`));
  }
}
