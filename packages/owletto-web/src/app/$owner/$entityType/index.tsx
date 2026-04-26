import { useQueries } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type RowData,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  EntityTypeBreadcrumbSelector,
  WorkspaceBreadcrumbSelector,
} from '@/components/breadcrumbs/breadcrumb-selector';
import { CreateEntitySheet } from '@/components/create-entity-sheet';
import { SortIcon } from '@/components/table/sort-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityIcon } from '@/components/ui/entity-icon';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useOrgContext } from '@/hooks/use-org-context';
import {
  apiCall,
  type Entity,
  type EntityListResult,
  useEntitiesByType,
  useEntityType,
  useResolvedPath,
} from '@/lib/api';
import { normalizeEnumValue } from '@/lib/schema-value-normalization';
import { titleCaseWords } from '@/lib/string-utils';
import { buildEntityUrl } from '@/lib/url';

export const Route = createFileRoute('/$owner/$entityType/')({
  component: EntityListPage,
});

function buildEntityPath(owner: string, entity: Entity) {
  if (entity.parent_id && entity.parent_slug && entity.parent_entity_type) {
    return buildEntityUrl(owner, [
      { entity_type: entity.parent_entity_type, slug: entity.parent_slug },
      { entity_type: entity.entity_type, slug: entity.slug },
    ]);
  }
  return buildEntityUrl(owner, [{ entity_type: entity.entity_type, slug: entity.slug }]);
}

interface MetadataTableProperty {
  description?: string;
  enum?: string[];
  format?: string;
  'x-table-column'?: boolean;
  'x-table-label'?: string;
  'x-image'?: boolean;
  'x-link-entity-type'?: string;
  'x-link-lookup-field'?: string;
}

interface LinkedEntityColumnSpec {
  entityType: string;
  lookupField: string;
}

function parseEntityMetadata(metadata: Entity['metadata']): Record<string, unknown> {
  if (typeof metadata === 'string') {
    return JSON.parse(metadata) as Record<string, unknown>;
  }
  return (metadata as Record<string, unknown> | null | undefined) ?? {};
}

function getLinkedEntityLookupKey(spec: LinkedEntityColumnSpec): string {
  return `${spec.entityType}:${spec.lookupField}`;
}

function isHttpUrl(value: string, format?: string): boolean {
  if (format !== 'uri' && !/^https?:\/\//i.test(value)) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const HUMANIZED_METADATA_FIELDS = new Set(['stage', 'category', 'round_type', 'investor_type']);

function humanizeMetadataToken(value: string): string {
  return titleCaseWords(value.replace(/[_-]+/g, ' '));
}

function looksLikeDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
    value
  );
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, '');
    const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
    return `${host}${path}`;
  } catch {
    return value;
  }
}

function isCurrencyMetadataField(key: string, prop: MetadataTableProperty): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey === 'mrr' ||
    normalizedKey === 'arr' ||
    normalizedKey === 'revenue' ||
    normalizedKey === 'valuation' ||
    normalizedKey === 'funding_raised' ||
    normalizedKey === 'fund_size' ||
    normalizedKey.endsWith('_usd') ||
    prop.description?.toLowerCase().includes('usd') === true
  );
}

function formatMetadataDisplayValue(
  key: string,
  value: unknown,
  prop: MetadataTableProperty
): string {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number') {
    if (isCurrencyMetadataField(key, prop)) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: value >= 1000 ? 'compact' : 'standard',
        maximumFractionDigits: value >= 1_000_000_000 ? 1 : 0,
      }).format(value);
    }

    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  }

  if (typeof value !== 'string') {
    return JSON.stringify(value);
  }

  if (isHttpUrl(value, prop.format)) {
    return formatUrlLabel(value);
  }

  if (prop.format === 'date' || prop.format === 'date-time' || looksLikeDateString(value)) {
    return formatDateLabel(value);
  }

  if (prop.enum?.length || HUMANIZED_METADATA_FIELDS.has(key) || key.endsWith('_slug')) {
    return humanizeMetadataToken(value);
  }

  return value;
}

function EntityListPage() {
  const { owner, entityType: entityTypeSlug } = Route.useParams();
  const { orgContext, hasOrgContext } = useOrgContext();

  const entityTypeQuery = useEntityType(entityTypeSlug, orgContext);
  const { data: entityType, isLoading: isTypeLoading, error: entityTypeError } = entityTypeQuery;
  const { data: resolvedData } = useResolvedPath(`/${owner}`, orgContext);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const sortBy = sorting[0]?.id ?? 'created_at';
  const sortOrder = sorting[0]?.desc === false ? 'asc' : 'desc';

  const entityListQuery = useEntitiesByType(entityTypeSlug, orgContext, {
    limit: pageSize,
    offset: page * pageSize,
    search: search.trim() || undefined,
    sortBy,
    sortOrder,
  });
  const parentCoverageQuery = useEntitiesByType(entityTypeSlug, orgContext, {
    limit: 1,
    offset: 0,
    parentId: null,
  });
  const { data: entityList, isLoading: isEntitiesLoading, error: entitiesError } = entityListQuery;

  const isTypeReady = !isTypeLoading && entityType?.slug === entityTypeSlug;
  const pageError = entityTypeError || entitiesError;
  const entities = entityList?.entities ?? [];
  const hasMore = entityList?.metadata?.has_more ?? false;
  const totalCount = entityList?.metadata?.total_count ?? 0;
  const shouldShowTable = entities.length > 0 || search.trim().length > 0 || page > 0;

  const pageTitle = entityType?.name?.trim() || titleCaseWords(entityTypeSlug);
  const entityTypeIconValue = entityType?.icon || undefined;
  const workspaceName = resolvedData?.workspace?.name || owner;
  const schema = entityType?.metadata_schema as
    | {
        properties?: Record<string, MetadataTableProperty>;
        'x-table-relationships'?: Array<{ relationship_type: string; label: string }>;
      }
    | undefined;
  const schemaProperties = schema?.properties;

  const imageField = useMemo(() => {
    if (!schemaProperties) return undefined;
    return Object.entries(schemaProperties).find(([, p]) => p['x-image'])?.[0];
  }, [schemaProperties]);

  const linkedColumnSpecs = useMemo<Record<string, LinkedEntityColumnSpec>>(() => {
    if (!schemaProperties) return {};

    return Object.fromEntries(
      Object.entries(schemaProperties).flatMap(([key, prop]) => {
        if (!prop['x-link-entity-type']) return [];
        return [
          [
            key,
            {
              entityType: prop['x-link-entity-type'],
              lookupField: prop['x-link-lookup-field'] || 'slug',
            },
          ],
        ];
      })
    );
  }, [schemaProperties]);

  const linkedEntityTypes = useMemo(
    () => [...new Set(Object.values(linkedColumnSpecs).map((spec) => spec.entityType))],
    [linkedColumnSpecs]
  );

  const linkedEntityQueries = useQueries({
    queries: linkedEntityTypes.map((linkedType) => ({
      queryKey: [
        'entity-link-options',
        linkedType,
        orgContext?.organizationId,
        orgContext?.slug,
        owner,
      ],
      queryFn: () =>
        apiCall<EntityListResult>(
          'manage_entity',
          {
            action: 'list',
            entity_type: linkedType,
            limit: 500,
            offset: 0,
          },
          orgContext ?? owner
        ),
      staleTime: 30000,
      enabled: !!linkedType,
    })),
  });

  const isLinkedLookupsLoading = linkedEntityQueries.some((query) => query.isLoading);
  const isLoading =
    !hasOrgContext ||
    !isTypeReady ||
    isEntitiesLoading ||
    parentCoverageQuery.isLoading ||
    isLinkedLookupsLoading;

  const linkedEntityLookups = useMemo(() => {
    const lookups = new Map<
      string,
      Map<string, { slug: string; entityType: string; name: string }>
    >();

    linkedEntityTypes.forEach((linkedType, index) => {
      const entities = linkedEntityQueries[index]?.data?.entities ?? [];
      const lookupFields = new Set(
        Object.values(linkedColumnSpecs)
          .filter((spec) => spec.entityType === linkedType)
          .map((spec) => spec.lookupField)
      );

      lookupFields.forEach((lookupField) => {
        const values = new Map<string, { slug: string; entityType: string; name: string }>();

        entities.forEach((entity) => {
          const metadata = parseEntityMetadata(entity.metadata);
          const lookupValue = lookupField === 'slug' ? entity.slug : metadata[lookupField];
          if (lookupValue == null || lookupValue === '') return;
          values.set(String(lookupValue), {
            slug: entity.slug,
            entityType: entity.entity_type,
            name: entity.name,
          });
        });

        lookups.set(getLinkedEntityLookupKey({ entityType: linkedType, lookupField }), values);
      });
    });

    return lookups;
  }, [linkedColumnSpecs, linkedEntityQueries, linkedEntityTypes]);

  const schemaColumns = useMemo<ColumnDef<Entity>[]>(() => {
    if (!schemaProperties) return [];

    const entries = Object.entries(schemaProperties).filter(
      ([, p]) => !p['x-image'] && p['x-table-column'] === true
    );

    return entries.map(([key, prop]) => {
      const linkSpec = linkedColumnSpecs[key];
      const linkedLookup = linkSpec
        ? linkedEntityLookups.get(getLinkedEntityLookupKey(linkSpec))
        : undefined;

      return {
        id: `meta_${key}`,
        accessorFn: (row: Entity) => {
          const meta = parseEntityMetadata(row.metadata);
          return normalizeEnumValue(meta[key], prop.enum);
        },
        header: prop['x-table-label'] || prop.description || titleCaseWords(key.replace(/_/g, ' ')),
        cell: ({ getValue }: { getValue: () => unknown }) => {
          const val = getValue();
          const values = (Array.isArray(val) ? val : [val]).filter(
            (item) => item != null && String(item).trim() !== ''
          );

          if (values.length === 0) {
            return <span className="text-muted-foreground">-</span>;
          }

          return (
            <div className="flex flex-wrap gap-1">
              {values.map((item, index) => {
                const rawValue = String(item);
                const formattedValue = formatMetadataDisplayValue(key, item, prop);
                const target = linkedLookup?.get(rawValue);
                const isExternalLink = isHttpUrl(rawValue, prop.format);
                const itemKey = target ? `${target.entityType}:${target.slug}` : rawValue;
                return (
                  <span key={itemKey}>
                    {target ? (
                      <Link
                        to={
                          buildEntityUrl(owner, [
                            { entity_type: target.entityType, slug: target.slug },
                          ]) as '/'
                        }
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {target.name}
                      </Link>
                    ) : isExternalLink ? (
                      <a
                        href={rawValue}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {formattedValue}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{formattedValue}</span>
                    )}
                    {index < values.length - 1 && ','}
                  </span>
                );
              })}
            </div>
          );
        },
      } satisfies ColumnDef<Entity>;
    });
  }, [linkedColumnSpecs, linkedEntityLookups, owner, schemaProperties]);

  const relationshipColumns = useMemo<ColumnDef<Entity>[]>(() => {
    const specs = schema?.['x-table-relationships'];
    if (!specs || specs.length === 0) return [];

    return specs.map((spec) => ({
      id: `rel_${spec.relationship_type}`,
      accessorFn: (row: Entity) => row.relationships?.[spec.relationship_type] ?? [],
      header: spec.label,
      cell: ({ getValue }: { getValue: () => unknown }) => {
        const related = getValue() as
          | Array<{ id: number; name: string; slug: string; entity_type: string }>
          | undefined;
        if (!related || related.length === 0) {
          return <span className="text-muted-foreground">-</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {related.map((r, i) => (
              <span key={r.id}>
                <Link
                  to={buildEntityUrl(owner, [{ entity_type: r.entity_type, slug: r.slug }]) as '/'}
                  className="text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {r.name}
                </Link>
                {i < related.length - 1 && ','}
              </span>
            ))}
          </div>
        );
      },
    }));
  }, [owner, schema]);

  const rootEntityCount = parentCoverageQuery.data?.metadata?.total_count;
  const hasAnyParents =
    totalCount > 0 && typeof rootEntityCount === 'number' ? rootEntityCount < totalCount : false;

  const parentColumn = useMemo<ColumnDef<Entity>[]>(() => {
    const hasParents =
      hasAnyParents ||
      entities.some(
        (entity) => entity.parent_name && entity.parent_slug && entity.parent_entity_type
      );
    if (!hasParents) return [];

    return [
      {
        id: 'parent',
        accessorFn: (row: Entity) => row.parent_name,
        header: 'Parent',
        cell: ({ row }) => {
          if (
            !row.original.parent_name ||
            !row.original.parent_slug ||
            !row.original.parent_entity_type
          ) {
            return <span className="text-muted-foreground">-</span>;
          }

          return (
            <Link
              to={
                buildEntityUrl(owner, [
                  {
                    entity_type: row.original.parent_entity_type,
                    slug: row.original.parent_slug,
                  },
                ]) as '/'
              }
              className="text-primary hover:underline"
            >
              {row.original.parent_name}
            </Link>
          );
        },
      },
    ];
  }, [entities, hasAnyParents, owner]);

  const statColumns = useMemo<ColumnDef<Entity>[]>(() => {
    const columns: ColumnDef<Entity>[] = [];
    const hasKnowledge = entities.some((entity) => (entity.total_content ?? 0) > 0);
    const hasConnectors = entities.some((entity) => (entity.active_connections ?? 0) > 0);
    const hasWatchers = entities.some((entity) => (entity.watchers_count ?? 0) > 0);

    if (hasKnowledge) {
      columns.push({
        accessorKey: 'total_content',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Knowledge
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>() ?? 0}</span>,
        meta: { align: 'right' },
      });
    }

    if (hasConnectors) {
      columns.push({
        accessorKey: 'active_connections',
        header: 'Connectors',
        cell: ({ getValue }) => {
          const count = getValue<number>();
          return count && count > 0 ? (
            <Badge variant="outline" className="text-green-600 dark:text-green-400">
              {count} active
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          );
        },
        meta: { align: 'right' },
      });
    }

    if (hasWatchers) {
      columns.push({
        accessorKey: 'watchers_count',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Watchers
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>() ?? 0}</span>,
        meta: { align: 'right' },
      });
    }

    return columns;
  }, [entities]);

  const columns = useMemo<ColumnDef<Entity>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Name
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => {
          const meta = parseEntityMetadata(row.original.metadata);
          const image = imageField ? (meta?.[imageField] as string | undefined) : undefined;
          return (
            <div className="flex items-center gap-2">
              {image && (
                <img
                  src={image}
                  alt=""
                  className="h-6 w-6 rounded-full object-cover shrink-0"
                  referrerPolicy="no-referrer"
                />
              )}
              <div>
                <Link
                  to={buildEntityPath(owner, row.original) as '/'}
                  className="font-medium hover:underline"
                >
                  {row.original.name}
                </Link>
              </div>
            </div>
          );
        },
      },
      ...parentColumn,
      ...schemaColumns,
      ...relationshipColumns,
      ...statColumns,
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Created
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ getValue }) => (
          <span className="text-muted-foreground">
            {new Date(getValue<string>()).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        ),
      },
    ],
    [owner, parentColumn, schemaColumns, relationshipColumns, statColumns, imageField]
  );

  const table = useReactTable({
    data: entities,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableSortingRemoval: false,
  });

  return (
    <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="space-y-2 px-4 lg:px-6">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <WorkspaceBreadcrumbSelector currentSlug={owner} currentName={workspaceName} />
          <span>/</span>
          <EntityTypeBreadcrumbSelector
            ownerSlug={owner}
            currentEntityTypeSlug={entityTypeSlug}
            currentLabel={pageTitle}
            orgContext={orgContext}
          />
        </nav>

        <div className="flex items-center gap-2">
          <span className="text-2xl leading-none">
            <EntityIcon icon={entityTypeIconValue} className="h-7 w-7" />
          </span>
          <h1 className="text-3xl font-semibold leading-tight">{pageTitle}</h1>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        {shouldShowTable && (
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={`Search ${pageTitle.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => setCreateSheetOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add {pageTitle || 'Entity'}
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            Loading...
          </div>
        ) : pageError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-sm text-destructive">
            {pageError.message || `Failed to load ${pageTitle.toLowerCase()}.`}
          </div>
        ) : shouldShowTable ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className={
                          header.column.columnDef.meta?.align === 'right' ? 'text-right' : ''
                        }
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={
                            cell.column.columnDef.meta?.align === 'right' ? 'text-right' : ''
                          }
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="text-4xl mb-4">
              <EntityIcon icon={entityType?.icon} className="h-10 w-10" />
            </div>
            <h3 className="text-lg font-medium">No {pageTitle.toLowerCase()} yet</h3>
            <p className="text-muted-foreground mt-1 mb-4">
              Get started by creating your first {entityType?.name?.toLowerCase() || 'entity'}.
            </p>
            <Button onClick={() => setCreateSheetOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add {entityType?.name || 'Entity'}
            </Button>
          </div>
        )}
        {!isLoading && (entities.length > 0 || page > 0) && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <div>
              Showing {entities.length} of {totalCount} {pageTitle.toLowerCase()}
            </div>
            <div className="flex items-center gap-2">
              <span>
                Page {page + 1} of {Math.max(1, Math.ceil(totalCount / pageSize))}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                disabled={page === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={!hasMore}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      <CreateEntitySheet
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
        entityTypeSlug={entityTypeSlug}
        orgContext={orgContext}
      />
    </div>
  );
}

declare module '@tanstack/react-table' {
  // biome-ignore lint/correctness/noUnusedVariables: Required for module augmentation
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'center' | 'right';
  }
}
