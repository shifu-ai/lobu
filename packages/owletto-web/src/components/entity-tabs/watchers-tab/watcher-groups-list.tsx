import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { FileText, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SortIcon } from '@/components/table/sort-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePublicWatchersList, useWatchersList } from '@/hooks/use-watchers';
import { useAuthState } from '@/lib/auth-state';
import { groupWatchers, type WatcherGroup } from '@/lib/watcher-groups';
import { TabEmptyState } from '../tab-states';
import { CreateWatcherSheet } from './create-watcher-sheet';

interface WatcherGroupsListProps {
  organizationId: string;
  ownerSlug?: string;
  onSelectGroup: (groupId: string) => void;
  defaultCreateOpen?: boolean;
}

export function WatcherGroupsList({
  organizationId,
  ownerSlug,
  onSelectGroup,
  defaultCreateOpen = false,
}: WatcherGroupsListProps) {
  const { isAuthenticated } = useAuthState();
  const [searchQuery, setSearchQuery] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'assignmentsCount', desc: true }]);
  const [createSheetOpen, setCreateSheetOpen] = useState(defaultCreateOpen);

  const authQuery = useWatchersList(isAuthenticated ? organizationId : undefined, undefined, {
    includeDetails: isAuthenticated,
  });
  const publicQuery = usePublicWatchersList(!isAuthenticated ? ownerSlug : undefined, undefined, {
    includeDetails: false,
  });

  const assignments = (isAuthenticated ? authQuery.data : publicQuery.data) ?? [];
  const loading = isAuthenticated ? authQuery.isLoading : publicQuery.isLoading;
  const loadError = isAuthenticated ? authQuery.error : publicQuery.error;

  const groups = useMemo(() => groupWatchers(assignments), [assignments]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return groups;

    return groups.filter(
      (group) =>
        group.name.toLowerCase().includes(q) ||
        group.description?.toLowerCase().includes(q) ||
        group.assignments.some(
          (assignment) =>
            assignment.entity_name?.toLowerCase().includes(q) ||
            assignment.name.toLowerCase().includes(q)
        )
    );
  }, [groups, searchQuery]);

  const columns = useMemo<ColumnDef<WatcherGroup>[]>(
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
          const group = row.original;
          return (
            <button
              type="button"
              className="w-full text-left"
              onClick={() => onSelectGroup(group.groupId)}
            >
              <div className="font-medium text-primary hover:underline">{group.name}</div>
              {group.description ? (
                <p className="truncate text-xs text-muted-foreground mt-0.5">{group.description}</p>
              ) : null}
            </button>
          );
        },
      },
      {
        id: 'assignmentsCount',
        accessorFn: (group) => group.assignmentsCount,
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Assignments
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => <span className="tabular-nums">{row.original.assignmentsCount}</span>,
        meta: { align: 'right' as const },
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => {
          const group = row.original;
          return (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="default">{group.activeAssignmentsCount} active</Badge>
              {group.archivedAssignmentsCount > 0 ? (
                <Badge variant="secondary">{group.archivedAssignmentsCount} archived</Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'schedule',
        header: 'Schedule',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground font-mono">
            {row.original.schedule ?? '—'}
          </span>
        ),
      },
      {
        id: 'windows',
        accessorFn: (group) => group.totalWindowsCount,
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
        cell: ({ row }) => <span className="tabular-nums">{row.original.totalWindowsCount}</span>,
        meta: { align: 'right' as const },
      },
    ],
    [onSelectGroup]
  );

  const table = useReactTable({
    data: filteredGroups,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: false,
  });

  if (loadError) {
    const errorMessage = loadError instanceof Error ? loadError.message : 'Unknown error';
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-destructive mb-2">Failed to load watchers</div>
        <p className="text-sm text-muted-foreground max-w-md">{errorMessage}</p>
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

  return (
    <>
      {groups.length === 0 ? (
        <TabEmptyState
          icon={FileText}
          title={!isAuthenticated ? 'No public watchers' : 'No watchers'}
          description={
            !isAuthenticated
              ? 'No public watchers are available for this workspace yet.'
              : 'Create a watcher to start analyzing your content'
          }
          actionLabel={isAuthenticated ? 'Create Watcher' : undefined}
          onAction={isAuthenticated ? () => setCreateSheetOpen(true) : undefined}
        />
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
          onOpenChange={setCreateSheetOpen}
          organizationId={organizationId}
          onSuccess={(watcherId) => {
            setCreateSheetOpen(false);
            onSelectGroup(watcherId);
          }}
        />
      ) : null}
    </>
  );
}
