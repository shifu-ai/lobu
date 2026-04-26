import { Loader2, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import type { ConnectionItem, ConnectorDefinitionItem } from '@/lib/api';
import { useCreateFeed } from '@/lib/api';
import { EntityMultiSelector } from '../watchers-tab/entity-multi-selector';
import { DynamicConnectorForm } from './dynamic-connector-form';

interface AddFeedDialogProps {
  organizationId: string;
  connections: ConnectionItem[];
  connectorDefinitions: ConnectorDefinitionItem[];
  entityId?: number;
}

interface FeedDef {
  key: string;
  name: string;
  description?: string;
  configSchema?: Record<string, unknown>;
}

function getFeedDefs(connectorDef: ConnectorDefinitionItem | undefined): FeedDef[] {
  if (!connectorDef?.feeds_schema) return [];
  return Object.entries(connectorDef.feeds_schema).map(([key, v]) => ({
    key,
    name: (v as { name?: string }).name ?? key,
    description: (v as { description?: string }).description,
    configSchema: (v as { configSchema?: Record<string, unknown> }).configSchema,
  }));
}

export function AddFeedDialog({
  organizationId,
  connections,
  connectorDefinitions,
  entityId,
}: AddFeedDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>('');
  const [selectedFeedKey, setSelectedFeedKey] = useState<string>('');
  const [selectedEntityIds, setSelectedEntityIds] = useState<number[]>(entityId ? [entityId] : []);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const createFeed = useCreateFeed();

  const connectorDefsByKey = useMemo(
    () => new Map(connectorDefinitions.map((d) => [d.key, d])),
    [connectorDefinitions]
  );

  const selectedConnection = useMemo(
    () => connections.find((c) => String(c.id) === selectedConnectionId),
    [connections, selectedConnectionId]
  );

  const feedDefs = useMemo(
    () =>
      selectedConnection
        ? getFeedDefs(connectorDefsByKey.get(selectedConnection.connector_key))
        : [],
    [selectedConnection, connectorDefsByKey]
  );
  const selectedFeedDef = useMemo(
    () => feedDefs.find((def) => def.key === selectedFeedKey) ?? null,
    [feedDefs, selectedFeedKey]
  );

  const resetForm = useCallback(() => {
    setSelectedConnectionId('');
    setSelectedFeedKey('');
    setSelectedEntityIds(entityId ? [entityId] : []);
    setConfigValues({});
    setError(null);
  }, [entityId]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        resetForm();
      }
    },
    [resetForm]
  );

  const handleCreate = useCallback(async () => {
    if (!selectedConnection || !selectedFeedKey) return;
    setError(null);
    try {
      await createFeed.mutateAsync({
        connection_id: selectedConnection.id,
        feed_key: selectedFeedKey,
        config: Object.keys(configValues).length > 0 ? configValues : undefined,
        entity_ids: entityId
          ? [entityId]
          : selectedEntityIds.length > 0
            ? selectedEntityIds
            : undefined,
      });
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create feed');
    }
  }, [
    configValues,
    createFeed,
    entityId,
    handleOpenChange,
    selectedConnection,
    selectedEntityIds,
    selectedFeedKey,
  ]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Feed
        </Button>
      </SheetTrigger>
      <SheetContent className="flex h-full w-full flex-col sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Add Feed</SheetTitle>
          <SheetDescription>
            Feeds are optional scheduled sync targets for an existing connection.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto py-6 pr-1">
          <div className="space-y-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: label for custom Select component */}
            <label className="text-sm font-medium">Connection</label>
            <Select
              value={selectedConnectionId}
              onValueChange={(v) => {
                setSelectedConnectionId(v);
                setSelectedFeedKey('');
                setConfigValues({});
                setError(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((conn) => (
                  <SelectItem key={conn.id} value={String(conn.id)}>
                    {conn.display_name || conn.connector_name || conn.connector_key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedConnection && feedDefs.length > 0 && (
            <div className="space-y-2">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: label for custom Select component */}
              <label className="text-sm font-medium">Feed Type</label>
              <Select
                value={selectedFeedKey}
                onValueChange={(value) => {
                  setSelectedFeedKey(value);
                  setConfigValues({});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select feed type" />
                </SelectTrigger>
                <SelectContent>
                  {feedDefs.map((def) => (
                    <SelectItem key={def.key} value={def.key}>
                      <div>
                        <span>{def.name}</span>
                        {def.description && (
                          <span className="text-muted-foreground ml-1 text-xs">
                            — {def.description}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {entityId ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Target Entity</p>
              <p className="text-sm text-muted-foreground">
                This feed will be attached to the current entity.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">Target Entities</p>
              <EntityMultiSelector
                organizationId={organizationId}
                value={selectedEntityIds}
                onChange={setSelectedEntityIds}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Optional. Leave empty to create an unscoped feed.
              </p>
            </div>
          )}

          {selectedFeedDef?.configSchema && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Feed Configuration</p>
              <DynamicConnectorForm
                schema={selectedFeedDef.configSchema}
                onValuesChange={setConfigValues}
              />
            </div>
          )}

          {selectedConnection && feedDefs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              This connector has no configurable feed types.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <SheetFooter className="border-t pt-4">
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selectedFeedKey || createFeed.isPending}
            onClick={() => void handleCreate()}
          >
            {createFeed.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Feed
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
