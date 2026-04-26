import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PlatformIcon } from '@/components/agents/platform-icon';
import { DynamicSchemaForm } from '@/components/dynamic-schema-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  type AgentConnectionItem,
  type PlatformSchema,
  useAgentConnections,
  useAgentPlatforms,
  useCreateAgentConnection,
  useDeleteAgentConnection,
} from '@/lib/api/agents';

// ============================================================
// Constants
// ============================================================

const SECRET_PATTERN = /(?:secret|token|password|key|credential|authorization)/i;

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-green-500/15 text-green-700 dark:text-green-400' },
  stopped: { label: 'Stopped', className: 'bg-muted text-muted-foreground' },
  error: { label: 'Error', className: 'bg-red-500/15 text-red-700 dark:text-red-400' },
};

const PLATFORM_ICONS: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  teams: 'Teams',
  gchat: 'Google Chat',
};

// ============================================================
// Helpers
// ============================================================

function redactValue(key: string, value: unknown): string {
  if (SECRET_PATTERN.test(key) && typeof value === 'string' && value.length > 0) {
    return `${'*'.repeat(Math.min(value.length, 8))}...`;
  }
  return String(value ?? '');
}

function platformDisplayName(platform: string, schemas: Record<string, PlatformSchema>): string {
  return schemas[platform]?.name ?? PLATFORM_ICONS[platform] ?? platform;
}

function platformIconName(platform: string, schemas: Record<string, PlatformSchema>): string {
  return schemas[platform]?.icon ?? platform;
}

// ============================================================
// Connection Config Details
// ============================================================

interface ConnectionDetailProps {
  connection: AgentConnectionItem;
  onDelete: (connId: string) => void;
  isDeleting: boolean;
}

function ConnectionDetail({ connection, onDelete, isDeleting }: ConnectionDetailProps) {
  const configEntries = Object.entries(connection.config).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );

  return (
    <div className="space-y-3 px-4 pb-3 pl-[3.25rem]">
      {configEntries.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Configuration
          </p>
          <div className="rounded-md bg-muted px-3 py-2">
            {configEntries.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-4 py-0.5 text-xs">
                <span className="font-medium text-muted-foreground">{key}</span>
                <span className="truncate font-mono text-muted-foreground">
                  {redactValue(key, value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {connection.errorMessage && (
        <p className="text-xs text-red-600 dark:text-red-400">{connection.errorMessage}</p>
      )}

      <Button
        size="sm"
        variant="destructive"
        disabled={isDeleting}
        onClick={() => onDelete(connection.id)}
      >
        <Trash2 className="h-3 w-3" />
        {isDeleting ? 'Deleting...' : 'Delete Connection'}
      </Button>
    </div>
  );
}

// ============================================================
// AgentConnections
// ============================================================

interface AgentConnectionsProps {
  agentId: string;
  showToolbar?: boolean;
  addMode?: boolean;
  onAddModeChange?: (addMode: boolean) => void;
}

export function AgentConnections({
  agentId,
  showToolbar = true,
  addMode,
  onAddModeChange,
}: AgentConnectionsProps) {
  const { data: connections = [], isLoading } = useAgentConnections(agentId);
  const { data: platforms = {} } = useAgentPlatforms();
  const createConnection = useCreateAgentConnection(agentId);
  const deleteConnection = useDeleteAgentConnection(agentId);

  const [openConnId, setOpenConnId] = useState<string | null>(null);
  const [internalAddMode, setInternalAddMode] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});

  const showPlatformPicker = addMode ?? internalAddMode;

  const setAddMode = useCallback(
    (next: boolean) => {
      if (addMode === undefined) {
        setInternalAddMode(next);
      }
      onAddModeChange?.(next);
    },
    [addMode, onAddModeChange]
  );

  useEffect(() => {
    if (showPlatformPicker) return;
    setSelectedPlatform(null);
    setConfigValues({});
  }, [showPlatformPicker]);

  const handleStartAdd = useCallback(() => {
    setAddMode(true);
    setSelectedPlatform(null);
    setConfigValues({});
  }, [setAddMode]);

  const handlePlatformSelect = useCallback((platformKey: string) => {
    setSelectedPlatform(platformKey);
    setConfigValues({});
  }, []);

  const handleCancelAdd = useCallback(() => {
    setAddMode(false);
    setSelectedPlatform(null);
    setConfigValues({});
  }, [setAddMode]);

  const handleSubmit = useCallback(() => {
    if (!selectedPlatform) return;
    createConnection.mutate(
      { platform: selectedPlatform, config: configValues },
      {
        onSuccess: () => {
          setAddMode(false);
          setSelectedPlatform(null);
          setConfigValues({});
        },
      }
    );
  }, [configValues, createConnection, selectedPlatform, setAddMode]);

  const handleDelete = useCallback(
    (connId: string) => {
      deleteConnection.mutate(connId);
    },
    [deleteConnection]
  );

  if (isLoading) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground">Loading connections...</p>
      </div>
    );
  }

  const selectedSchema = selectedPlatform ? platforms[selectedPlatform]?.schema : null;
  const isAddingConnection = showPlatformPicker || selectedPlatform !== null;

  return (
    <div className="space-y-3">
      {showToolbar ? (
        <div className="flex items-center justify-between px-1">
          {isAddingConnection ? (
            <Button size="sm" variant="ghost" onClick={handleCancelAdd}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={handleStartAdd}>
              <Plus className="h-3 w-3" />
              Add Connection
            </Button>
          )}
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {connections.length} configured
          </p>
        </div>
      ) : null}

      {showPlatformPicker && !selectedPlatform ? (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Choose a platform</p>
            <p className="text-sm text-muted-foreground">
              Select the messaging platform you want this agent to connect to.
            </p>
          </div>

          <div className="space-y-2">
            {Object.entries(platforms).map(([key, platform]) => (
              <button
                key={key}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => handlePlatformSelect(key)}
              >
                <PlatformIcon platform={platform.icon} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 text-sm font-medium">{platform.name}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {selectedPlatform ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Configure {platformDisplayName(selectedPlatform, platforms)}
            </p>
            <p className="text-sm text-muted-foreground">
              Fill in the platform credentials and settings below.
            </p>
          </div>

          {selectedSchema ? (
            <DynamicSchemaForm
              schema={selectedSchema}
              initialValues={configValues}
              onValuesChange={setConfigValues}
            />
          ) : (
            <p className="rounded-md border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
              No configuration required for this platform.
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setSelectedPlatform(null)}>
              Choose Different Platform
            </Button>
            <Button onClick={handleSubmit} disabled={createConnection.isPending}>
              {createConnection.isPending ? 'Creating...' : 'Create Connection'}
            </Button>
          </div>
        </div>
      ) : null}

      {connections.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          No connections yet. Add one to connect this agent to a messaging platform.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-lg border">
          {connections.map((conn) => {
            const isOpen = openConnId === conn.id;
            const statusStyle = STATUS_STYLES[conn.status] ?? STATUS_STYLES.stopped;

            return (
              <Collapsible
                key={conn.id}
                open={isOpen}
                onOpenChange={(next) => setOpenConnId(next ? conn.id : null)}
              >
                <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/50">
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  />
                  <PlatformIcon
                    platform={platformIconName(conn.platform, platforms)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="text-sm font-medium">
                    {platformDisplayName(conn.platform, platforms)}
                  </span>
                  <Badge
                    variant="outline"
                    className={`ml-auto px-1.5 py-0 text-[10px] ${statusStyle.className}`}
                  >
                    {statusStyle.label}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ConnectionDetail
                    connection={conn}
                    onDelete={handleDelete}
                    isDeleting={deleteConnection.isPending}
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
