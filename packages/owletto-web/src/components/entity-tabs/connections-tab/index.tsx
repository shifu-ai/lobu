import { Link } from '@tanstack/react-router';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { AlertCircle, ChevronRight, Link2, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildConnectorDefinitionMap,
  ConnectorDisplay,
  resolveConnectorDisplay,
} from '@/components/connectors/connector-display';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRowExpansion } from '@/hooks/use-row-expansion';
import type { FeedItem } from '@/lib/api';
import { useAllFeeds, useConnections, useConnectorDefinitions } from '@/lib/api';
import { formatTimeAgo } from '@/lib/format-utils';
import { getStatusVariant } from '@/lib/status-variants';
import { TabEmptyState, TabErrorState, TabLoadingState } from '../tab-states';
import { AddFeedDialog } from './add-feed-dialog';
import { ConnectionSheet } from './connection-sheet';
import { FeedExpandedRow } from './feed-expanded-row';

interface ConnectionsTabProps {
  organizationId: string;
  eventsPath?: string;
  entityId?: number;
  entityName?: string;
  initialConnectionId?: number;
  initialConnectorKey?: string;
  onSheetClose?: () => void;
  onSelectConnection?: (connectionId: number) => void;
  onCloseSelectedConnection?: () => void;
}

export function ConnectionsTab({
  organizationId,
  eventsPath,
  entityId,
  entityName,
  initialConnectionId,
  initialConnectorKey,
  onSheetClose,
  onSelectConnection,
  onCloseSelectedConnection,
}: ConnectionsTabProps) {
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);
  const [editConnectionId, setEditConnectionId] = useState<number | null>(null);
  const [initialOpened, setInitialOpened] = useState(false);

  const { data: feeds = [], isLoading, error } = useAllFeeds(organizationId, { entityId });
  const { data: connections = [] } = useConnections(organizationId, { entityId });
  const { data: connectorDefinitions = [] } = useConnectorDefinitions(organizationId);
  const { toggleRow, isExpanded } = useRowExpansion();

  const connectorDefinitionsByKey = useMemo(
    () => buildConnectorDefinitionMap(connectorDefinitions),
    [connectorDefinitions]
  );

  // Resolve the ConnectionItem for the edit sheet
  const routedEditConnectionId = initialConnectionId ?? null;
  const activeEditId = routedEditConnectionId ?? editConnectionId;
  const editTarget = useMemo(
    () => (activeEditId ? (connections.find((c) => c.id === activeEditId) ?? null) : null),
    [connections, activeEditId]
  );

  useEffect(() => {
    if (initialOpened) return;
    if (initialConnectorKey && !isLoading) {
      setAddConnectionOpen(true);
      setInitialOpened(true);
    }
  }, [initialConnectorKey, initialOpened, isLoading]);

  const handleEditConnection = useCallback(
    (connectionId: number) => {
      if (onSelectConnection) {
        onSelectConnection(connectionId);
        return;
      }
      setEditConnectionId(connectionId);
    },
    [onSelectConnection]
  );

  const columns = useMemo<ColumnDef<FeedItem>[]>(
    () => [
      {
        id: 'expand',
        header: '',
        size: 32,
        cell: ({ row }) => (
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded(row.original.id) ? 'rotate-90' : ''}`}
          />
        ),
      },
      {
        id: 'connector',
        header: 'Connector',
        cell: ({ row }) => {
          const connector = resolveConnectorDisplay(
            row.original.connector_key,
            connectorDefinitionsByKey,
            { name: row.original.connector_name || row.original.connector_key }
          );
          return (
            <ConnectorDisplay
              connector={connector}
              showDescription={false}
              nameClassName="font-medium"
            />
          );
        },
      },
      {
        accessorKey: 'display_name',
        header: 'Feed',
        cell: ({ row }) => (
          <span className="text-sm font-medium">
            {row.original.display_name || row.original.feed_key}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const feed = row.original;
          const authError = feed.auth_profile_status && feed.auth_profile_status !== 'active';
          return (
            <div className="flex items-center gap-2">
              <StatusBadge status={getStatusVariant(feed.status)}>{feed.status}</StatusBadge>
              {authError && (
                <span title={`Auth: ${feed.auth_profile_status}`}>
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                </span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'last_sync_at',
        header: 'Last Sync',
        cell: ({ row }) => {
          const feed = row.original;
          return (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {feed.last_sync_at ? formatTimeAgo(feed.last_sync_at) : '—'}
              {feed.last_sync_status === 'failed' && (
                <AlertCircle className="h-3 w-3 text-destructive" />
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'next_run_at',
        header: 'Next Sync',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.next_run_at ? formatTimeAgo(row.original.next_run_at) : '—'}
          </span>
        ),
      },
      {
        accessorKey: 'event_count',
        header: 'Knowledge',
        cell: ({ row }) => {
          const count = row.original.event_count ?? 0;
          if (count === 0 || !eventsPath) {
            return (
              <span className="text-sm font-mono text-muted-foreground">
                {count.toLocaleString()}
              </span>
            );
          }
          return (
            <Link
              to={eventsPath as '/'}
              search={{ platforms: row.original.connector_key }}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-mono text-primary hover:underline"
            >
              {count.toLocaleString()}
            </Link>
          );
        },
      },
      {
        id: 'actions',
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  handleEditConnection(row.original.connection_id);
                }}
              >
                <Pencil className="h-4 w-4 mr-2" />
                Edit Connection
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [connectorDefinitionsByKey, eventsPath, handleEditConnection, isExpanded]
  );

  const table = useReactTable({
    data: feeds,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (isLoading) return <TabLoadingState label="feeds" />;
  if (error) return <TabErrorState label="feeds" />;

  if (feeds.length === 0) {
    return (
      <>
        <TabEmptyState
          icon={Link2}
          title={`No feeds${entityName ? ` for ${entityName}` : ''}`}
          description="Add a connector to start syncing data"
          actionLabel="Add Connector"
          onAction={() => setAddConnectionOpen(true)}
        />
        <ConnectionSheet
          open={addConnectionOpen}
          onOpenChange={(open) => {
            setAddConnectionOpen(open);
            if (!open) onSheetClose?.();
          }}
          organizationId={organizationId}
          initialConnectorKey={initialConnectorKey}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 mb-4">
        <AddFeedDialog
          organizationId={organizationId}
          connections={connections}
          connectorDefinitions={connectorDefinitions}
          entityId={entityId}
        />
        <Button variant="outline" size="sm" onClick={() => setAddConnectionOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Connector
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <Fragment key={row.id}>
                <TableRow
                  className={`cursor-pointer ${
                    row.original.status === 'error' ? 'bg-red-50 dark:bg-red-950/20' : ''
                  }`}
                  onClick={() => toggleRow(row.original.id)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                {isExpanded(row.original.id) && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={columns.length} className="p-0">
                      <FeedExpandedRow
                        feed={row.original}
                        organizationId={organizationId}
                        onEditConnection={handleEditConnection}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      <ConnectionSheet
        open={addConnectionOpen}
        onOpenChange={(open) => {
          setAddConnectionOpen(open);
          if (!open) onSheetClose?.();
        }}
        organizationId={organizationId}
        connections={connections}
        initialConnectorKey={initialConnectorKey}
      />

      <ConnectionSheet
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) {
            if (routedEditConnectionId) {
              onCloseSelectedConnection?.();
            } else {
              setEditConnectionId(null);
            }
          }
        }}
        organizationId={organizationId}
        editingConnection={editTarget}
      />
    </>
  );
}
