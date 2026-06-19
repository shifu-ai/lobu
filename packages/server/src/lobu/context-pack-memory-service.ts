import { hasRequiredMcpScope } from '../auth/tool-access';
import type { Env } from '../index';
import { saveContent } from '../tools/save_content';
import type { ToolContext, TokenType } from '../tools/registry';
import { generateEmbeddings, getConfiguredEmbeddingModel } from '../utils/embeddings';
import { ToolUserError } from '../utils/errors';
import { AGENT_ID_PATTERN } from './stores/postgres-stores';

const MAX_TITLE_LENGTH = 500;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_METADATA_JSON_LENGTH = 64_000;
const DEFAULT_SEMANTIC_TYPE = 'project_profile';
const TOOLBOX_ONBOARDING_SOURCE = 'toolbox_onboarding';

export type ContextPackMemoryErrorCode =
  | 'lobu_memory_invalid_request'
  | 'lobu_memory_unauthorized'
  | 'lobu_memory_write_forbidden'
  | 'lobu_memory_semantic_type_invalid'
  | 'lobu_memory_write_failed';

export class ContextPackMemoryError extends Error {
  constructor(
    readonly errorCode: ContextPackMemoryErrorCode,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message);
    this.name = 'ContextPackMemoryError';
  }
}

export interface ContextPackMemoryRequest {
  ownerUserId: string;
  agentId: string;
  source: typeof TOOLBOX_ONBOARDING_SOURCE;
  title: string;
  summary: string;
  content: string;
  semanticType: string;
  metadata: Record<string, unknown>;
}

export interface ContextPackMemoryResult {
  refs: string[];
  eventId: number;
  semanticType: string;
  agentId: string;
  viewUrl?: string;
}

type SaveContentImpl = typeof saveContent;
type GenerateEmbeddingsImpl = typeof generateEmbeddings;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function metadataJsonLength(metadata: Record<string, unknown>): number {
  try {
    return JSON.stringify(metadata).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function parseContextPackMemoryRequest(body: unknown): ContextPackMemoryRequest {
  if (!isPlainRecord(body)) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'Request body must be a JSON object'
    );
  }

  const ownerUserId = stringField(body.ownerUserId);
  const agentId = stringField(body.agentId);
  const title = stringField(body.title);
  const summary = stringField(body.summary);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const semanticType = stringField(body.semanticType) || DEFAULT_SEMANTIC_TYPE;
  const metadata = body.metadata === undefined ? {} : body.metadata;
  const source = isPlainRecord(metadata) ? stringField(metadata.source) : '';

  if (!ownerUserId) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'ownerUserId is required'
    );
  }
  if (!agentId || !AGENT_ID_PATTERN.test(agentId)) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'agentId is required and must be a valid Lobu agent id'
    );
  }
  if (source !== TOOLBOX_ONBOARDING_SOURCE) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'source must be toolbox_onboarding'
    );
  }
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      `title is required and must be ${MAX_TITLE_LENGTH} characters or fewer`
    );
  }
  if (!summary || summary.length > MAX_CONTENT_LENGTH) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      `summary is required and must be ${MAX_CONTENT_LENGTH} characters or fewer`
    );
  }
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      `content is required and must be ${MAX_CONTENT_LENGTH} characters or fewer`
    );
  }
  if (!semanticType) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'semanticType is required'
    );
  }
  if (!isPlainRecord(metadata) || metadataJsonLength(metadata) > MAX_METADATA_JSON_LENGTH) {
    throw new ContextPackMemoryError(
      'lobu_memory_invalid_request',
      'metadata must be a bounded JSON object'
    );
  }

  return {
    ownerUserId,
    agentId,
    source,
    title,
    summary,
    content,
    semanticType,
    metadata,
  };
}

function tokenTypeFromAuthSource(authSource: string | null | undefined): TokenType {
  if (authSource === 'session' || authSource === 'pat' || authSource === 'oauth') {
    return authSource;
  }
  return 'anonymous';
}

function mapSaveContentError(error: unknown): never {
  if (error instanceof ToolUserError) {
    if (error.httpStatus === 422) {
      throw new ContextPackMemoryError(
        'lobu_memory_semantic_type_invalid',
        error.message,
        422
      );
    }
    if (error.httpStatus === 403) {
      throw new ContextPackMemoryError('lobu_memory_write_forbidden', error.message, 403);
    }
    throw new ContextPackMemoryError('lobu_memory_invalid_request', error.message, error.httpStatus);
  }

  throw new ContextPackMemoryError(
    'lobu_memory_write_failed',
    'Failed to write context pack memory',
    500
  );
}

export async function writeContextPackMemory(
  input: {
    organizationId: string;
    ownerMemberRole: string;
    authSource: 'session' | 'pat' | 'oauth' | null;
    scopes: string[] | null | undefined;
    requestUrl?: string;
    baseUrl?: string;
    env?: Env;
    body: unknown;
  },
  deps: { saveContentImpl?: SaveContentImpl; generateEmbeddingsImpl?: GenerateEmbeddingsImpl } = {}
): Promise<ContextPackMemoryResult> {
  if (!input.organizationId) {
    throw new ContextPackMemoryError(
      'lobu_memory_unauthorized',
      'Organization context is required',
      401
    );
  }
  if (!hasRequiredMcpScope('write', input.scopes)) {
    throw new ContextPackMemoryError(
      'lobu_memory_write_forbidden',
      'Context pack memory writes require mcp:write or mcp:admin scope',
      403
    );
  }

  const parsed = parseContextPackMemoryRequest(input.body);
  const ctx: ToolContext = {
    organizationId: input.organizationId,
    userId: parsed.ownerUserId,
    memberRole: input.ownerMemberRole,
    agentId: parsed.agentId,
    isAuthenticated: true,
    scopes: input.scopes,
    tokenType: tokenTypeFromAuthSource(input.authSource),
    scopedToOrg: true,
    allowCrossOrg: false,
    requestUrl: input.requestUrl,
    baseUrl: input.baseUrl,
  };

  const saveContentImpl = deps.saveContentImpl ?? saveContent;
  const env = input.env ?? (process.env as unknown as Env);
  const generateEmbeddingsImpl = deps.generateEmbeddingsImpl ?? generateEmbeddings;
  let embedding: number[] | undefined;
  if (env.EMBEDDINGS_SERVICE_URL) {
    const embeddings = await generateEmbeddingsImpl([parsed.content], env);
    embedding = embeddings[0];
  }
  let saved: Awaited<ReturnType<SaveContentImpl>>;
  try {
    saved = await saveContentImpl(
      {
        payload_type: 'markdown',
        semantic_type: parsed.semanticType,
        title: parsed.title,
        content: parsed.content,
        author: 'Toolbox Onboarding',
        metadata: {
          ...parsed.metadata,
          summary: parsed.summary,
          owner_user_id: parsed.ownerUserId,
          agent_id: parsed.agentId,
          memory_source: parsed.source,
        },
        ...(embedding ? {
          embedding,
          embedding_model: getConfiguredEmbeddingModel(),
        } : {}),
      },
      env,
      ctx
    );
  } catch (error) {
    mapSaveContentError(error);
  }

  const eventId = Number(saved?.id);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new ContextPackMemoryError(
      'lobu_memory_write_failed',
      'Memory write did not return a durable event id',
      500
    );
  }

  return {
    refs: [`lobu:event:${eventId}`],
    eventId,
    semanticType: saved.semantic_type ?? parsed.semanticType,
    agentId: parsed.agentId,
    ...(saved.view_url ? { viewUrl: saved.view_url } : {}),
  };
}
