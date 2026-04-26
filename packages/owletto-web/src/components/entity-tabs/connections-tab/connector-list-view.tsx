import { Link } from '@tanstack/react-router';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { Link2, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConnectorMark, resolveConnectorDisplay } from '@/components/connectors/connector-display';
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
import type { ConnectorDefinitionItem } from '@/lib/api';
import {
  useAllFeeds,
  useConnections,
  useConnectorDefinitions,
  usePublicConnectorDefinitions,
} from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import { TabEmptyState, TabErrorState, TabLoadingState } from '../tab-states';
import { getAuthSchemaLabel } from './auth-helpers';
import { ConnectionSheet } from './connection-sheet';
import { ConnectorDetailView } from './connector-detail-view';

interface ConnectorListViewProps {
  organizationId: string;
  ownerSlug?: string;
  onSelectConnector: (connectorKey: string) => void;
  initialConnectorKey?: string;
  onSheetClose?: () => void;
  entityId?: number;
  createdBy?: string;
}

export function ConnectorListView({
  organizationId,
  ownerSlug,
  onSelectConnector,
  initialConnectorKey,
  onSheetClose,
  entityId,
  createdBy,
}: ConnectorListViewProps) {
  const { isAuthenticated } = useAuthState();
  const { data: publicConnectorDefs = [], isLoading: publicBootstrapLoading } =
    usePublicConnectorDefinitions(!isAuthenticated ? ownerSlug : null, { entityId });
  const {
    data: connectorDefs = [],
    isLoading,
    error,
  } = useConnectorDefinitions(isAuthenticated ? organizationId : null);
  const { data: connections = [] } = useConnections(
    isAuthenticated ? organizationId : null,
    createdBy ? { createdBy, limit: 1000 } : { limit: 1000 }
  );
  const { data: entityFeeds = [] } = useAllFeeds(
    isAuthenticated && entityId ? organizationId : null,
    { entityId }
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [addConnectorOpen, setAddConnectorOpen] = useState(false);

  const effectiveConnectorDefs = isAuthenticated ? connectorDefs : publicConnectorDefs;

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conn of connections) {
      counts.set(conn.connector_key, (counts.get(conn.connector_key) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  // When scoped to an entity, only show connectors that have feeds for it.
  // For anonymous viewers, the public connectors endpoint already filtered
  // by entity_id (feeds aren't fetched client-side without auth), so skip here.
  const entityConnectorKeys = useMemo(() => {
    if (!entityId || !isAuthenticated) return null;
    return new Set(entityFeeds.map((f) => f.connector_key));
  }, [entityId, entityFeeds, isAuthenticated]);

  // When filtered by user, only show connectors they have connections for
  const userConnectorKeys = useMemo(() => {
    if (!createdBy) return null;
    return new Set(connections.map((c) => c.connector_key));
  }, [createdBy, connections]);

  const visibleDefs = useMemo(() => {
    let defs = effectiveConnectorDefs.filter((c) => {
      if (entityConnectorKeys && !entityConnectorKeys.has(c.key)) return false;
      if (userConnectorKeys && !userConnectorKeys.has(c.key)) return false;
      return true;
    });

    if (isAuthenticated && defs.length === 0 && userConnectorKeys && userConnectorKeys.size > 0) {
      const seen = new Set<string>();
      defs = connections
        .filter((c) => {
          if (seen.has(c.connector_key)) return false;
          seen.add(c.connector_key);
          return true;
        })
        .map((c) => ({
          key: c.connector_key,
          name: c.connector_name || c.connector_key,
          description: null,
          auth_schema: null,
          status: 'active' as const,
        })) as ConnectorDefinitionItem[];
    }

    return defs;
  }, [
    effectiveConnectorDefs,
    entityConnectorKeys,
    userConnectorKeys,
    connections,
    isAuthenticated,
  ]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return visibleDefs.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.key.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q)
    );
  }, [visibleDefs, searchQuery]);

  const [sorting, setSorting] = useState<SortingState>([{ id: 'connections', desc: true }]);

  const columns = useMemo<ColumnDef<ConnectorDefinitionItem>[]>(
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
        cell: ({ row, table }) => {
          const connector = row.original;
          const display = resolveConnectorDisplay(
            connector.key,
            new Map([[connector.key, connector]]),
            { name: connector.name }
          );
          const onSelect = (table.options.meta as { onSelectConnector?: (key: string) => void })
            ?.onSelectConnector;
          return (
            <button
              type="button"
              className="flex items-center gap-3 w-full text-left cursor-pointer"
              onClick={() => onSelect?.(connector.key)}
            >
              <ConnectorMark
                icon={display.icon}
                name={display.name}
                faviconDomain={display.faviconDomain}
                className="h-7 w-7 rounded-md text-[10px]"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium hover:underline">{connector.name}</div>
                {connector.description && (
                  <p className="truncate text-xs text-muted-foreground">{connector.description}</p>
                )}
              </div>
            </button>
          );
        },
      },
      {
        id: 'auth',
        header: 'Auth',
        enableSorting: false,
        cell: ({ row }) => {
          const label = getAuthSchemaLabel(
            row.original.auth_schema as Record<string, unknown> | null
          );
          return label ? (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {label}
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          );
        },
      },
      {
        id: 'connections',
        accessorFn: (row) => connectionCounts.get(row.key) ?? 0,
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Connections
            <SortIcon direction={column.getIsSorted()} />
          </button>
        ),
        cell: ({ getValue }) => {
          const count = getValue<number>();
          return count > 0 ? (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              {count}
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          );
        },
        meta: { align: 'right' as const },
      },
    ],
    [connectionCounts]
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: false,
    meta: { onSelectConnector },
  });

  if ((isAuthenticated && isLoading) || (!isAuthenticated && publicBootstrapLoading)) {
    return <TabLoadingState label="connectors" />;
  }
  if (error && !createdBy) return <TabErrorState label="connectors" />;

  if (visibleDefs.length === 0) {
    return (
      <>
        <TabEmptyState
          icon={Link2}
          title={createdBy ? 'No connections' : 'No connectors installed'}
          description={
            createdBy
              ? 'This user has no active connections'
              : isAuthenticated
                ? 'Install a connector to start syncing data'
                : 'Sign in to install a connector for this workspace.'
          }
          actionLabel={isAuthenticated && !createdBy ? 'Add Connector' : undefined}
          onAction={
            isAuthenticated && !createdBy ? () => setAddConnectorOpen(true) : undefined
          }
        >
          {!isAuthenticated && !createdBy ? (
            <Button asChild variant="outline" className="mt-4">
              <Link
                to="/auth/login"
                search={{
                  callbackUrl: undefined,
                  mode: undefined,
                  error: undefined,
                  errorDescription: undefined,
                  loginHint: undefined,
                  invitationOrg: undefined,
                  intent: undefined,
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Sign in to add a connector
              </Link>
            </Button>
          ) : null}
        </TabEmptyState>
        {isAuthenticated ? (
          <ConnectionSheet
            open={addConnectorOpen}
            onOpenChange={(open) => {
              setAddConnectorOpen(open);
              if (!open) onSheetClose?.();
            }}
            organizationId={organizationId}
            connections={connections}
            initialConnectorKey={initialConnectorKey}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search connectors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {!createdBy &&
          (isAuthenticated ? (
            <Button variant="outline" size="sm" onClick={() => setAddConnectorOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Connector
            </Button>
          ) : (
            <Button asChild variant="outline" size="sm">
              <Link
                to="/auth/login"
                search={{
                  callbackUrl: undefined,
                  mode: undefined,
                  error: undefined,
                  errorDescription: undefined,
                  loginHint: undefined,
                  invitationOrg: undefined,
                  intent: undefined,
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Sign in to add a connector
              </Link>
            </Button>
          ))}
      </div>

      {!isAuthenticated && (
        <p className="mb-4 text-sm text-muted-foreground">
          Public view shows connector definitions only. Sign in to add connections or manage feeds.
        </p>
      )}

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
                  No connectors match "{searchQuery}"
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAuthenticated ? (
        <ConnectionSheet
          open={addConnectorOpen}
          onOpenChange={(open) => {
            setAddConnectorOpen(open);
            if (!open) onSheetClose?.();
          }}
          organizationId={organizationId}
          connections={connections}
          initialConnectorKey={initialConnectorKey}
        />
      ) : null}
    </>
  );
}

/**
 * URL-driven list/detail controller for connector views.
 * Used by both org-level and entity-level connectors tabs.
 */
export function ConnectorsView({
  organizationId,
  ownerSlug,
  entityId,
  createdBy,
  selectedConnectorKey,
  onSelectConnector,
  onCloseSelectedConnector,
}: {
  organizationId: string;
  ownerSlug?: string;
  entityId?: number;
  createdBy?: string;
  selectedConnectorKey?: string;
  onSelectConnector: (connectorKey: string) => void;
  onCloseSelectedConnector: () => void;
}) {
  if (selectedConnectorKey) {
    return (
      <ConnectorDetailView
        organizationId={organizationId}
        ownerSlug={ownerSlug}
        connectorKey={selectedConnectorKey}
        entityId={entityId}
        createdBy={createdBy}
        onBack={onCloseSelectedConnector}
      />
    );
  }

  return (
    <ConnectorListView
      organizationId={organizationId}
      ownerSlug={ownerSlug}
      entityId={entityId}
      createdBy={createdBy}
      onSelectConnector={onSelectConnector}
    />
  );
}
