import { Link } from '@tanstack/react-router';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import {
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { SortIcon } from '@/components/table/sort-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useFeatures } from '@/hooks/use-features';
import {
  useDeleteWatcher,
  usePublicWatchersList,
  useTriggerWatcher,
  useWatchersList,
} from '@/hooks/use-watchers';
import type { Watcher } from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import { EntityLinkCell } from '../entity-link-cell';
import { TabEmptyState } from '../tab-states';
import { buildEntityTabUrl } from '../types';
import { CreateWatcherSheet } from './create-watcher-sheet';
import { WatcherGroupsList } from './watcher-groups-list';

interface WatchersListProps {
  organizationId: string;
  ownerSlug?: string; // Required for org-wide mode drill-down links
  entityId?: number; // Optional - undefined means org-wide mode
  entityName?: string;
  isOrgWide?: boolean;
  onSelectWatcher: (watcherId: string) => void;
  defaultCreateOpen?: boolean;
}

function buildWatcherDetailsPath(watcher: Watcher, ownerSlug?: string): string | undefined {
  // Skip entities with missing type/slug or internal types (e.g. $member)
  if (!watcher.entity_type || !watcher.entity_slug || watcher.entity_type.startsWith('$')) {
    return undefined;
  }

  const resolvedNamespaceSlug = watcher.organization_slug || ownerSlug;
  if (!resolvedNamespaceSlug) {
    return undefined;
  }

  const watchersBasePath = buildEntityTabUrl(
    resolvedNamespaceSlug,
    {
      entityId: watcher.entity_id,
      entityName: watcher.entity_name,
      entityType: watcher.entity_type,
      entitySlug: watcher.entity_slug,
      parentEntityType: watcher.parent_entity_type,
      parentEntitySlug: watcher.parent_slug,
    },
    'watchers'
  );

  return `${watchersBasePath}/${watcher.watcher_id}`;
}

export function WatchersList(props: WatchersListProps) {
  if (props.isOrgWide) {
    return (
      <WatcherGroupsList
        organizationId={props.organizationId}
        ownerSlug={props.ownerSlug}
        onSelectGroup={props.onSelectWatcher}
        defaultCreateOpen={props.defaultCreateOpen}
      />
    );
  }

  return <EntityWatchersList {...props} />;
}

function EntityWatchersList({
  organizationId,
  ownerSlug,
  entityId,
  entityName,
  onSelectWatcher,
  defaultCreateOpen = false,
}: WatchersListProps) {
  const { isAuthenticated } = useAuthState();
  const { lobuEmbedded } = useFeatures();
  const [createSheetOpen, setCreateSheetOpen] = useState(defaultCreateOpen);
  const [editingWatcher, setEditingWatcher] = useState<Watcher | null>(null);
  const {
    data: watchers,
    isLoading,
    error,
  } = useWatchersList(isAuthenticated ? organizationId : undefined, entityId, {
    includeDetails: isAuthenticated,
  });
  const {
    data: publicWatchers = [],
    isLoading: publicWatchersLoading,
    error: publicWatchersError,
  } = usePublicWatchersList(!isAuthenticated ? ownerSlug : undefined, entityId, {
    includeDetails: false,
  });
  const deleteWatcher = useDeleteWatcher();
  const triggerWatcher = useTriggerWatcher();

  const [searchQuery, setSearchQuery] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const handleCloseSheet = useCallback(() => {
    setCreateSheetOpen(false);
    setEditingWatcher(null);
  }, []);

  const columns = useMemo<ColumnDef<Watcher>[]>(
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
          const watcher = row.original;
          const displayName = watcher.name;
          const viewDetailsPath = buildWatcherDetailsPath(watcher, ownerSlug);

          if (viewDetailsPath) {
            return (
              <Link
                to={viewDetailsPath as '/'}
                className="text-left font-medium hover:underline text-primary"
              >
                {displayName}
              </Link>
            );
          }

          return (
            <button
              type="button"
              onClick={() => onSelectWatcher(watcher.watcher_id)}
              className="text-left font-medium hover:underline text-primary"
            >
              {displayName}
            </button>
          );
        },
      },
      {
        accessorKey: 'entity_name',
        header: 'Entity',
        cell: ({ row }: { row: { original: Watcher } }) => {
          const w = row.original;
          // Internal entity types (e.g. $member) don't have navigable pages
          if (!w.entity_type || w.entity_type.startsWith('$')) {
            return <span className="text-sm text-muted-foreground">{w.entity_name || '—'}</span>;
          }
          return (
            <EntityLinkCell
              ownerSlug={w.organization_slug || ownerSlug || ''}
              entity={{
                entityId: w.entity_id,
                entityName: w.entity_name,
                entityType: w.entity_type,
                entitySlug: w.entity_slug,
                parentEntityType: w.parent_entity_type,
                parentEntitySlug: w.parent_slug,
              }}
              tab="watchers"
            />
          );
        },
      } as ColumnDef<Watcher>,
      {
        accessorKey: 'version',
        header: 'Version',
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            v{row.original.version ?? '?'}
          </Badge>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Status
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => (
          <Badge variant={row.original.status === 'active' ? 'default' : 'secondary'}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: 'schedule',
        header: 'Schedule',
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <span className="block text-sm text-muted-foreground font-mono">
              {row.original.schedule ?? '—'}
            </span>
            {isAuthenticated && row.original.agent_id ? (
              <span className="block text-xs text-muted-foreground">
                Agent: <span className="font-mono">{row.original.agent_id}</span>
              </span>
            ) : null}
            {isAuthenticated && row.original.scheduler_client_id ? (
              <span className="block text-xs text-muted-foreground">
                External: <span className="font-mono">{row.original.scheduler_client_id}</span>
              </span>
            ) : null}
            {isAuthenticated && row.original.watcher_run_status ? (
              <span className="block text-xs text-muted-foreground">
                Run: <span className="font-mono">{row.original.watcher_run_status}</span>
              </span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'windows_count',
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Windows
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{row.original.windows_count ?? 0}</span>
        ),
        meta: { align: 'right' as const },
      },
      ...(isAuthenticated
        ? [
            {
              id: 'actions',
              cell: ({ row }: { row: { original: Watcher } }) => {
                const watcher = row.original;
                const viewDetailsPath = buildWatcherDetailsPath(watcher, ownerSlug);

                if (confirmingDeleteId === watcher.watcher_id) {
                  return (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={deleteWatcher.isPending}
                        onClick={() => {
                          deleteWatcher.mutate(watcher.watcher_id, {
                            onSettled: () => setConfirmingDeleteId(null),
                          });
                        }}
                      >
                        {deleteWatcher.isPending ? 'Deleting...' : 'Confirm'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setConfirmingDeleteId(null)}
                        disabled={deleteWatcher.isPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  );
                }

                return (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {viewDetailsPath ? (
                        <DropdownMenuItem asChild>
                          <Link to={viewDetailsPath as '/'}>
                            <FileText className="h-4 w-4 mr-2" />
                            View Details
                          </Link>
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => onSelectWatcher(watcher.watcher_id)}>
                          <FileText className="h-4 w-4 mr-2" />
                          View Details
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => {
                          setEditingWatcher(watcher);
                          setCreateSheetOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      {lobuEmbedded && watcher.agent_id ? (
                        <DropdownMenuItem
                          disabled={triggerWatcher.isPending}
                          onClick={() => triggerWatcher.mutate(watcher.watcher_id)}
                        >
                          {triggerWatcher.isPending ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4 mr-2" />
                          )}
                          Run now
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        onClick={() => setConfirmingDeleteId(watcher.watcher_id)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              },
            } as ColumnDef<Watcher>,
          ]
        : []),
    ],
    [
      confirmingDeleteId,
      deleteWatcher,
      isAuthenticated,
      lobuEmbedded,
      onSelectWatcher,
      ownerSlug,
      triggerWatcher,
    ]
  );

  const rawData = isAuthenticated ? watchers || [] : publicWatchers;
  const loading = isAuthenticated ? isLoading : publicWatchersLoading;
  const loadError = isAuthenticated ? error : publicWatchersError;

  const filteredData = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return rawData;
    return rawData.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.entity_name?.toLowerCase().includes(q) ||
        w.description?.toLowerCase().includes(q)
    );
  }, [rawData, searchQuery]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: false,
  });

  const seeAllWatchersLink = useMemo(() => {
    if (!ownerSlug) return null;
    // Entity-level -> org-level watchers
    if (entityId) return `/${ownerSlug}/watchers`;
    // Org-level -> already top level, no link
    return null;
  }, [ownerSlug, entityId]);

  if (loadError) {
    const errorMessage = loadError instanceof Error ? loadError.message : 'Unknown error';
    const isServiceUnavailable = errorMessage.includes('503');

    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-destructive mb-2">
          {isServiceUnavailable ? 'Service temporarily unavailable' : 'Failed to load watchers'}
        </div>
        <p className="text-sm text-muted-foreground max-w-md">
          {isServiceUnavailable
            ? 'The watchers service is currently unavailable. Please try again in a few moments.'
            : errorMessage}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {['skeleton-1', 'skeleton-2', 'skeleton-3'].map((key) => (
          <div key={key} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  const isEmpty = filteredData.length === 0;

  const editingData =
    editingWatcher && isAuthenticated
      ? {
          watcher_id: editingWatcher.watcher_id,
          entity_id: editingWatcher.entity_id,
          name: editingWatcher.name,
          slug: editingWatcher.slug,
          description: editingWatcher.description,
          prompt: editingWatcher.prompt,
          extraction_schema: editingWatcher.extraction_schema,
          json_template: editingWatcher.json_template,
          sources: editingWatcher.sources,
          schedule: editingWatcher.schedule ?? undefined,
          reaction_script: editingWatcher.reaction_script,
          scheduler_client_id: editingWatcher.scheduler_client_id,
          classifiers: editingWatcher.classifiers,
          keying_config: editingWatcher.keying_config,
          condensation_prompt: editingWatcher.condensation_prompt,
          condensation_window_count: editingWatcher.condensation_window_count,
          reactions_guidance: editingWatcher.reactions_guidance,
          model_config: editingWatcher.model_config,
          tags: editingWatcher.tags,
          agent_id: editingWatcher.agent_id,
        }
      : undefined;

  return (
    <>
      {isEmpty ? (
        <TabEmptyState
          icon={FileText}
          title={`${!isAuthenticated ? 'No public watchers' : 'No watchers'}${entityName ? ` for ${entityName}` : ''}`}
          description={
            !isAuthenticated
              ? 'No public watchers are available for this workspace yet.'
              : 'Create a watcher to start analyzing your content'
          }
          actionLabel={isAuthenticated ? 'Create Watcher' : undefined}
          onAction={isAuthenticated ? () => setCreateSheetOpen(true) : undefined}
        >
          {seeAllWatchersLink && (
            <Link
              to={seeAllWatchersLink as '/'}
              className="mt-3 text-sm font-medium text-primary hover:text-primary/80"
            >
              See all watchers under {ownerSlug}
            </Link>
          )}
        </TabEmptyState>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search watchers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            {isAuthenticated ? (
              <Button variant="outline" size="sm" onClick={() => setCreateSheetOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create Watcher
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Public view is read-only. Sign in to create, edit, or delete watchers.
              </p>
            )}
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className={
                          (header.column.columnDef.meta as { align?: string })?.align === 'right'
                            ? 'text-right'
                            : ''
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
                            (cell.column.columnDef.meta as { align?: string })?.align === 'right'
                              ? 'text-right'
                              : ''
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
                      No watchers match "{searchQuery}"
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {isAuthenticated ? (
        <CreateWatcherSheet
          open={createSheetOpen}
          onOpenChange={(open) => {
            if (!open) handleCloseSheet();
            else setCreateSheetOpen(true);
          }}
          organizationId={organizationId}
          entityId={entityId}
          entityName={entityName}
          onSuccess={(watcherId) => {
            handleCloseSheet();
            onSelectWatcher(watcherId);
          }}
          editingWatcher={editingData}
        />
      ) : null}
    </>
  );
}
