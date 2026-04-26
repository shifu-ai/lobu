import { useQuery } from '@tanstack/react-query';
import {
  getEntityListInitialData,
  getEntityTypeInitialData,
  getResolvedPathInitialData,
} from '../public-bootstrap';
import type { EntityPathSegment } from '../url';
import { buildOwnerRootPath } from '../url';
import {
  API_URL,
  type ApiOrgContext,
  apiCall,
  fetchWithTimeout,
  normalizeOrgContext,
  resolveOrgSelector,
} from './core';
import { createMutation, createOrgQuery } from './hook-factory';

type OrgContextArg = ApiOrgContext | string | null | undefined;

export interface AuthConfig {
  social: Record<string, boolean>;
  magicLink: boolean;
  phone: boolean;
  emailPassword: boolean;
}

// Uses fetchWithTimeout directly (REST endpoint, not tool-based)
export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config', typeof window !== 'undefined' ? window.location.pathname : null],
    queryFn: async () => {
      const url = new URL(`${API_URL}/api/auth-config`);
      if (typeof window !== 'undefined') {
        url.searchParams.set('callbackUrl', window.location.href);
      }
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      return (await response.json()) as AuthConfig;
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ============================================================
// Public Organizations (no auth required)
// ============================================================

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  description: string | null;
  created_at: string;
  is_member: boolean;
  visibility: 'public' | 'private';
}

// Uses fetchWithTimeout directly (REST endpoint, not tool-based)
export function useOrganizations(options?: { search?: string }) {
  return useQuery({
    queryKey: ['organizations', options?.search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.search) params.append('search', options.search);

      const url = `${API_URL}/api/organizations${params.toString() ? `?${params}` : ''}`;
      const response = await fetchWithTimeout(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const result = await response.json();
      return (result.organizations || []) as Organization[];
    },
    staleTime: 300000,
  });
}

// Entity types
export interface Entity {
  id: number;
  name: string;
  entity_type: string;
  parent_id: number | null;
  slug: string;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  domain?: string;
  organization_id: string;
  metadata?: Record<string, unknown>;
  relationships?: Record<
    string,
    Array<{ id: number; name: string; slug: string; entity_type: string }>
  >;
  created_at: string;
  // Stats from entities_with_stats view
  total_content?: number;
  active_connections?: number;
  watchers_count?: number;
  children_count?: number;
  parent_name?: string;
}

export interface EntityWithChildren extends Entity {
  children?: EntityWithChildren[];
  icon?: string;
  path?: EntityPathSegment[];
}

// Default icon for unknown entity types
const DEFAULT_ENTITY_ICON = '📄';

function getEntityIcon(_entity: Entity): string {
  return DEFAULT_ENTITY_ICON;
}

// Build tree structure from flat list
function buildEntityTree(entities: Entity[]): EntityWithChildren[] {
  const entityMap = new Map<number, EntityWithChildren>();
  const roots: EntityWithChildren[] = [];

  for (const entity of entities) {
    entityMap.set(entity.id, {
      ...entity,
      icon: getEntityIcon(entity),
      children: [],
    });
  }

  for (const entity of entities) {
    const node = entityMap.get(entity.id);
    if (!node) {
      continue;
    }
    if (entity.parent_id) {
      const parent = entityMap.get(entity.parent_id);
      if (parent) {
        parent.children = parent.children || [];
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const assignPaths = (nodes: EntityWithChildren[], parentPath: EntityPathSegment[] = []) => {
    for (const node of nodes) {
      const path = [...parentPath, { entity_type: node.entity_type, slug: node.slug }];
      node.path = path;
      if (node.children && node.children.length > 0) {
        assignPaths(node.children, path);
      }
    }
  };

  assignPaths(roots);
  return roots;
}

export const useEntities = createOrgQuery<[orgContext?: OrgContextArg], EntityWithChildren[]>({
  queryKey: (ctx) => ['entities', ctx.organizationId, ctx.slug],
  tool: 'manage_entity',
  body: () => ({ action: 'list', limit: 500 }),
  orgContext: (orgContext) => orgContext,
  transform: (r) => buildEntityTree(r.entities || []),
  staleTime: 30000,
});

// Entity type definition
export interface EntityType {
  id: number;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  metadata_schema?: Record<string, unknown>;
  organization_id?: string;
  entity_count?: number;
}

interface EntityListMetadata {
  page_size: number;
  has_more: boolean;
  filtered_by_type?: string;
  total_count?: number;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface EntityListResult {
  entities: Entity[];
  metadata: EntityListMetadata;
}

export interface ResolvedNamespace {
  slug: string;
  type: 'user' | 'organization';
  id: string;
  name: string | null;
}

export interface ResolvedPathEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
}

export interface ViewTemplateTab {
  tab_name: string;
  tab_order: number;
  json_template: Record<string, unknown>;
  version: number;
  version_id: number;
  template_data: Record<string, unknown[]> | null;
}

export interface ResolvedEntityDetails extends ResolvedPathEntity {
  parent_id: number | null;
  metadata: Record<string, unknown>;
  json_template: Record<string, unknown> | null;
  json_template_version: number | null;
  template_data: Record<string, unknown[]> | null;
  tabs: ViewTemplateTab[];
  created_at: string;
  total_content: number;
  active_connections: number;
  watchers_count: number;
}

export interface ChildEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  market: string | null;
  content_count: number;
}

export interface SiblingEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  content_count: number;
}

export interface BootstrapEntityTypeSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  entity_count: number;
}

export interface BootstrapScopeSummary {
  total_content: number;
  active_connections: number;
  watchers_count: number;
}

export interface BootstrapContentItem {
  id: number;
  entity_ids: number[];
  platform: string;
  entity_name: string | null;
  title: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  text_content: string;
  payload_data?: Record<string, unknown>;
  payload_template?: Record<string, unknown> | null;
  source_url: string | null;
  author_name: string | null;
  created_at: string;
  occurred_at: string | null;
}

export interface BootstrapFeedItem {
  id: number;
  connection_id: number;
  connector_key: string;
  display_name: string | null;
  status: string;
  entity_ids: number[];
  connector_name: string | null;
  connection_name: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

export interface BootstrapWatcherItem {
  watcher_id: string;
  name: string;
  status: string;
  schedule: string | null;
  entity_id: number | null;
  entity_type: string | null;
  entity_name: string | null;
  entity_slug: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  organization_slug: string;
  windows_count: number;
  created_at: string;
  updated_at: string;
}

export interface BootstrapConnectorDefinition {
  key: string;
  name: string;
  description: string | null;
  icon?: string | null;
  favicon_domain?: string | null;
}

export interface ResolvePathBootstrap {
  entity_types: BootstrapEntityTypeSummary[];
  summary: BootstrapScopeSummary;
  recent_content: BootstrapContentItem[];
  recent_feeds: BootstrapFeedItem[];
  recent_watchers: BootstrapWatcherItem[];
  connector_definitions: BootstrapConnectorDefinition[];
}

export interface ResolvePathResult {
  workspace: ResolvedNamespace;
  segments: Array<{ entity_type: string; slug: string }>;
  path: ResolvedPathEntity[];
  entity: ResolvedEntityDetails | null;
  children: ChildEntity[];
  siblings: SiblingEntity[];
  bootstrap: ResolvePathBootstrap | null;
}

function normalizeResolvedPathInput(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';

  const [pathname, query = ''] = trimmed.split('?', 2);
  const normalizedPath = `/${pathname.replace(/^\/+|\/+$/g, '')}`;
  return query ? `${normalizedPath}?${query}` : normalizedPath;
}

// Uses optional org context with URL-path fallback (not suited to factory)
export function useResolvedPath(
  path: string,
  orgContext?: { organizationId?: string | null; slug?: string | null } | string | null,
  options?: { includeBootstrap?: boolean }
) {
  const ctx = normalizeOrgContext(orgContext);
  const orgSelector = ctx.organizationId || ctx.slug ? resolveOrgSelector(ctx) : undefined;
  const normalizedPath = normalizeResolvedPathInput(path);

  return useQuery({
    queryKey: [
      'resolve-path',
      normalizedPath,
      ctx.organizationId,
      ctx.slug,
      options?.includeBootstrap ?? false,
    ],
    queryFn: async () => {
      const result = await apiCall<ResolvePathResult>(
        'resolve_path',
        { path: normalizedPath, include_bootstrap: options?.includeBootstrap ?? false },
        orgSelector
      );
      return result;
    },
    enabled: !!normalizedPath,
    placeholderData: getResolvedPathInitialData(normalizedPath),
    staleTime: 300000,
  });
}

export function useWorkspaceRoot(
  owner: string | null | undefined,
  orgContext?: { organizationId?: string | null; slug?: string | null } | string | null
) {
  return useResolvedPath(buildOwnerRootPath(owner), orgContext);
}

export function useWorkspaceBootstrap(
  owner: string | null | undefined,
  orgContext?: { organizationId?: string | null; slug?: string | null } | string | null
) {
  return useResolvedPath(buildOwnerRootPath(owner), orgContext, { includeBootstrap: true });
}

// ============================================================
// Org-scoped query hooks
// ============================================================

export const useEntitiesByType = createOrgQuery<
  [
    entityType: string,
    orgContext?: OrgContextArg,
    options?: {
      limit?: number;
      offset?: number;
      parentId?: number | null;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    },
  ],
  EntityListResult
>({
  queryKey: (ctx, entityType, _orgContext, options) => [
    'entities-by-type',
    entityType,
    ctx.organizationId,
    ctx.slug,
    options?.limit,
    options?.offset,
    options?.parentId,
    options?.search,
    options?.sortBy,
    options?.sortOrder,
  ],
  tool: 'manage_entity',
  body: (entityType, _orgContext, options) => ({
    action: 'list',
    entity_type: entityType,
    limit: options?.limit,
    offset: options?.offset,
    parent_id: options?.parentId,
    search: options?.search,
    sort_by: options?.sortBy,
    sort_order: options?.sortOrder,
  }),
  orgContext: (_entityType, orgContext) => orgContext,
  placeholderData: (ctx, entityType, _orgContext, options) =>
    ctx.slug
      ? options?.parentId === undefined
        ? getEntityListInitialData({
            ownerSlug: ctx.slug,
            entityTypeSlug: entityType,
            limit: options?.limit,
            offset: options?.offset,
            search: options?.search,
            sortBy: options?.sortBy,
            sortOrder: options?.sortOrder,
          })
        : undefined
      : undefined,
  enabled: (ctx, entityType) => !!(ctx.organizationId || ctx.slug) && !!entityType,
  staleTime: 30000,
});

function parseEntityType(et: EntityType): EntityType {
  return {
    ...et,
    metadata_schema:
      typeof et.metadata_schema === 'string' ? JSON.parse(et.metadata_schema) : et.metadata_schema,
  };
}

export const useEntityType = createOrgQuery<
  [typeSlug: string, orgContext?: OrgContextArg],
  EntityType | null
>({
  queryKey: (ctx, typeSlug) => ['entity-type', typeSlug, ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: (typeSlug) => ({ schema_type: 'entity_type', action: 'get', slug: typeSlug }),
  orgContext: (_typeSlug, orgContext) => orgContext,
  transform: (r) => (r.entity_type ? parseEntityType(r.entity_type) : null),
  placeholderData: (ctx, typeSlug) =>
    ctx.slug ? getEntityTypeInitialData(ctx.slug, typeSlug) : undefined,
  enabled: (ctx, typeSlug) => !!typeSlug && !!(ctx.organizationId || ctx.slug),
  staleTime: 60000,
});

export const useEntityTypes = createOrgQuery<[orgContext?: OrgContextArg], EntityType[]>({
  queryKey: (ctx) => ['entity-types', ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: () => ({ schema_type: 'entity_type', action: 'list' }),
  orgContext: (orgContext) => orgContext,
  transform: (r) =>
    (r.entity_types || []).map((row: EntityType) => ({
      ...parseEntityType(row),
      entity_count: Number(row.entity_count) || 0,
    })),
  staleTime: 300000,
});

// ============================================================
// Entity Type Admin (CRUD + Audit)
// ============================================================

export interface EntityTypeAdmin extends EntityType {
  created_by?: string | null;
  created_by_username?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface EntityTypeAuditEntry {
  id: number;
  entity_type_id: number;
  action: string;
  actor: string | null;
  before_payload: Record<string, unknown> | null;
  after_payload: Record<string, unknown> | null;
  created_at: string;
}

export const useEntityTypesAdmin = createOrgQuery<[orgContext?: OrgContextArg], EntityTypeAdmin[]>({
  queryKey: (ctx) => ['entity-types-admin', ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: () => ({ schema_type: 'entity_type', action: 'list' }),
  orgContext: (orgContext) => orgContext,
  transform: (r) =>
    (r.entity_types || []).map((row: EntityTypeAdmin) => ({
      ...parseEntityType(row),
      created_by: row.created_by ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      entity_count: Number(row.entity_count) || 0,
    })) as EntityTypeAdmin[],
  staleTime: 300000,
});

export const useEntityTypeAudit = createOrgQuery<
  [slug: string | null, orgContext?: OrgContextArg],
  EntityTypeAuditEntry[]
>({
  queryKey: (ctx, slug) => ['entity-type-audit', slug, ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: (slug) => ({ schema_type: 'entity_type', action: 'audit', slug }),
  orgContext: (_slug, orgContext) => orgContext,
  transform: (r) => r.audit_entries || [],
  enabled: (ctx, slug) => !!slug && !!(ctx.organizationId || ctx.slug),
});

// ============================================================
// Relationship Types
// ============================================================

export interface RelationshipType {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  organization_id?: string | null;
  created_by?: string | null;
  created_by_username?: string | null;
  metadata_schema?: Record<string, unknown> | null;
  is_symmetric: boolean;
  inverse_type_id?: number | null;
  inverse_type_slug?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  relationship_count?: number;
}

export interface RelationshipTypeRule {
  id: number;
  relationship_type_id: number;
  source_entity_type_slug: string;
  target_entity_type_slug: string;
  created_at: string;
}

export const useRelationshipTypes = createOrgQuery<
  [orgContext?: OrgContextArg],
  RelationshipType[]
>({
  queryKey: (ctx) => ['relationship-types', ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: () => ({ schema_type: 'relationship_type', action: 'list' }),
  orgContext: (orgContext) => orgContext,
  transform: (r) => r.relationship_types || [],
  staleTime: 30000,
});

export const useRelationshipTypeRules = createOrgQuery<
  [slug: string | null, orgContext?: OrgContextArg],
  RelationshipTypeRule[]
>({
  queryKey: (ctx, slug) => ['relationship-type-rules', slug, ctx.organizationId, ctx.slug],
  tool: 'manage_entity_schema',
  body: (slug) => ({ schema_type: 'relationship_type', action: 'list_rules', slug }),
  orgContext: (_slug, orgContext) => orgContext,
  transform: (r) => r.rules || [],
  enabled: (ctx, slug) => !!slug && !!(ctx.organizationId || ctx.slug),
});

// ============================================================
// View Template Versioning
// ============================================================

export interface ViewTemplateVersionRow {
  id: number;
  version: number;
  tab_name: string | null;
  tab_order: number;
  json_template: Record<string, unknown>;
  change_notes: string | null;
  created_by: string;
  created_by_username: string | null;
  created_at: string;
}

export interface ViewTemplateTabInfo {
  tab_name: string;
  tab_order: number;
  current_version: number;
  current_version_id: number;
  json_template: Record<string, unknown>;
}

export interface ViewTemplateResult {
  default_tab: {
    current: ViewTemplateVersionRow | null;
    history: ViewTemplateVersionRow[];
  };
  tabs: ViewTemplateTabInfo[];
}

export const useViewTemplateHistory = createOrgQuery<
  [
    resourceType: 'entity_type' | 'entity',
    resourceId: string | number | null,
    orgContext?: OrgContextArg,
  ],
  ViewTemplateResult
>({
  queryKey: (ctx, resourceType, resourceId) => [
    'view-template-history',
    resourceType,
    resourceId,
    ctx.organizationId,
    ctx.slug,
  ],
  tool: 'manage_view_templates',
  body: (resourceType, resourceId) => ({
    action: 'get',
    resource_type: resourceType,
    resource_id: resourceId,
  }),
  orgContext: (_resourceType, _resourceId, orgContext) => orgContext,
  enabled: (ctx, _resourceType, resourceId) => !!resourceId && !!(ctx.organizationId || ctx.slug),
});

// ============================================================
// Mutation hooks
// ============================================================

export const useCreateEntityType = createMutation<{
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  metadata_schema?: Record<string, unknown>;
}>({
  tool: 'manage_entity_schema',
  body: (p) => ({ schema_type: 'entity_type', action: 'create', ...p }),
  invalidateKeys: ['entity-types', 'entity-types-admin'],
  checkError: false,
});

export const useUpdateEntityType = createMutation<{
  slug: string;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  metadata_schema?: Record<string, unknown>;
}>({
  tool: 'manage_entity_schema',
  body: (p) => ({ schema_type: 'entity_type', action: 'update', ...p }),
  invalidateKeys: ['entity-types', 'entity-types-admin', 'entity-type'],
  checkError: false,
});

export const useDeleteEntityType = createMutation<string>({
  tool: 'manage_entity_schema',
  body: (slug) => ({ schema_type: 'entity_type', action: 'delete', slug }),
  invalidateKeys: ['entity-types', 'entity-types-admin'],
  checkError: false,
  successMessage: 'Entity type deleted',
});

export interface CreateEntityParams {
  entityType: string;
  name: string;
  slug?: string;
  parentId?: number;
  metadata?: Record<string, unknown>;
  domain?: string;
  category?: string;
  platformType?: string;
  mainMarket?: string;
  market?: string;
  link?: string;
  enabledClassifiers?: string[];
}

export interface CreateEntityResult {
  action: 'create';
  entity: Entity;
  warnings?: string[];
  next_steps: string[];
}

export const useCreateEntity = createMutation<CreateEntityParams, CreateEntityResult>({
  tool: 'manage_entity',
  body: (p) => ({
    action: 'create',
    entity_type: p.entityType,
    name: p.name,
    slug: p.slug,
    parent_id: p.parentId,
    metadata: p.metadata,
    domain: p.domain,
    category: p.category,
    platform_type: p.platformType,
    main_market: p.mainMarket,
    market: p.market,
    link: p.link,
    enabled_classifiers: p.enabledClassifiers,
  }),
  invalidateKeys: ['entities', 'entities-by-type', 'entity-types'],
  checkError: false,
  successMessage: 'Entity created',
});

export interface UpdateEntityParams {
  entityId: number;
  name?: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export const useUpdateEntity = createMutation<UpdateEntityParams>({
  tool: 'manage_entity',
  body: (p) => ({
    action: 'update',
    entity_id: p.entityId,
    name: p.name,
    slug: p.slug,
    metadata: p.metadata,
  }),
  invalidateKeys: ['entities', 'entities-by-type', 'resolve-path'],
  checkError: false,
});

export const useDeleteEntity = createMutation<{ entityId: number; force?: boolean }>({
  tool: 'manage_entity',
  body: (p) => ({ action: 'delete', entity_id: p.entityId, force: p.force }),
  invalidateKeys: ['entities', 'entities-by-type', 'entity-types'],
  checkError: false,
  successMessage: 'Entity deleted',
});

export const useSetViewTemplate = createMutation<{
  resourceType: 'entity_type' | 'entity';
  resourceId: string | number;
  json_template: Record<string, unknown>;
  tab_name?: string;
  tab_order?: number;
  change_notes?: string;
}>({
  tool: 'manage_view_templates',
  body: (p) => ({
    action: 'set',
    resource_type: p.resourceType,
    resource_id: p.resourceId,
    json_template: p.json_template,
    tab_name: p.tab_name,
    tab_order: p.tab_order,
    change_notes: p.change_notes,
  }),
  invalidateKeys: ['view-template-history', 'resolve-path', 'entities', 'entity-types'],
  checkError: false,
});

export const useRollbackViewTemplate = createMutation<{
  resourceType: 'entity_type' | 'entity';
  resourceId: string | number;
  version: number;
  tab_name?: string;
}>({
  tool: 'manage_view_templates',
  body: (p) => ({
    action: 'rollback',
    resource_type: p.resourceType,
    resource_id: p.resourceId,
    version: p.version,
    tab_name: p.tab_name,
  }),
  invalidateKeys: ['view-template-history', 'resolve-path', 'entities', 'entity-types'],
  checkError: false,
});

export const useCreateRelationshipType = createMutation<
  {
    slug: string;
    name: string;
    description?: string;
    is_symmetric?: boolean;
    inverse_type_slug?: string;
    metadata_schema?: Record<string, unknown>;
    status?: 'active' | 'archived';
  },
  { relationship_type: RelationshipType }
>({
  tool: 'manage_entity_schema',
  body: (p) => ({ schema_type: 'relationship_type', action: 'create', ...p }),
  invalidateKeys: ['relationship-types'],
  checkError: false,
  successMessage: 'Relationship type created',
});

export const useAddRelationshipTypeRule = createMutation<{
  slug: string;
  source_entity_type_slug: string;
  target_entity_type_slug: string;
}>({
  tool: 'manage_entity_schema',
  body: (p) => ({ schema_type: 'relationship_type', action: 'add_rule', ...p }),
  invalidateKeys: ['relationship-type-rules', 'relationship-types'],
  checkError: false,
});

export const useRemoveRelationshipTypeRule = createMutation<number>({
  tool: 'manage_entity_schema',
  body: (ruleId) => ({
    schema_type: 'relationship_type',
    action: 'remove_rule',
    rule_id: ruleId,
  }),
  invalidateKeys: ['relationship-type-rules', 'relationship-types'],
  checkError: false,
  successMessage: 'Rule removed',
});
