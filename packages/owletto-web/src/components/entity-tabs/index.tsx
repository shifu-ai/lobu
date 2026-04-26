import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DynamicSchemaForm } from '@/components/dynamic-schema-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspaceDashboardHome } from '@/components/workspace-dashboard-home';
import {
  type ResolvedEntityDetails,
  type ResolvedNamespace,
  type ResolvePathBootstrap,
  useDeleteEntity,
  useEntityType,
  useUpdateEntity,
} from '@/lib/api';
import { type JsonNode, JsonRenderer } from '@/lib/json-renderer';
import { normalizeMetadataForSchema } from '@/lib/schema-value-normalization';
import { buildEntityUrl } from '@/lib/url';
import { ConnectorsView } from './connections-tab/connector-list-view';
import { EventsTab } from './events-tab';
import type { EntityTabName } from './types';
import { WatchersTab } from './watchers-tab';

function findAnnotatedField(
  schema: Record<string, unknown> | null | undefined,
  annotation: string
): string | undefined {
  const props = (schema as { properties?: Record<string, Record<string, boolean>> } | undefined)
    ?.properties;
  if (!props) return undefined;
  return Object.entries(props).find(([, p]) => p[annotation])?.[0];
}

function useGravatarUrl(email: string | undefined): string | undefined {
  const [hash, setHash] = useState<string>();
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    const trimmed = email.trim().toLowerCase();
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(trimmed)).then((buf) => {
      if (cancelled) return;
      setHash(
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      );
    });
    return () => {
      cancelled = true;
    };
  }, [email]);
  return hash ? `https://www.gravatar.com/avatar/${hash}?d=identicon&s=80` : undefined;
}

function EntityAvatar({
  metadata,
  metadataSchema,
  name,
}: {
  metadata: Record<string, unknown> | null;
  metadataSchema: Record<string, unknown> | null | undefined;
  name: string;
}) {
  const imageKey = findAnnotatedField(metadataSchema, 'x-image');
  const emailKey = findAnnotatedField(metadataSchema, 'x-email');
  const profilePhoto = imageKey ? (metadata?.[imageKey] as string) || undefined : undefined;
  const email = emailKey ? (metadata?.[emailKey] as string) || undefined : undefined;
  const gravatarUrl = useGravatarUrl(!profilePhoto ? email : undefined);
  const src = profilePhoto || gravatarUrl;
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex justify-center">
      {src ? (
        <img
          src={src}
          alt={name}
          referrerPolicy="no-referrer"
          className="h-16 w-16 rounded-full object-cover border border-border"
        />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground border border-border">
          {initials}
        </div>
      )}
    </div>
  );
}

interface EntitySidebarFormProps {
  entity: ResolvedEntityDetails;
  entityTypeSlug: string;
  orgContext: { slug?: string | null };
  onDeleted?: () => void;
}

function EntitySidebarForm({
  entity,
  entityTypeSlug,
  orgContext,
  onDeleted,
}: EntitySidebarFormProps) {
  const { data: entityType } = useEntityType(entityTypeSlug, orgContext);
  const updateEntity = useUpdateEntity();
  const deleteEntity = useDeleteEntity();
  const metadataSchema = entityType?.metadata_schema;
  const normalizedEntityMetadata = useMemo(
    () => normalizeMetadataForSchema(entity.metadata ?? {}, metadataSchema),
    [entity.metadata, metadataSchema]
  );

  const [name, setName] = useState(entity.name);
  const [slug, setSlug] = useState(entity.slug);
  const [metadata, setMetadata] = useState<Record<string, unknown>>(normalizedEntityMetadata);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setName(entity.name);
    setSlug(entity.slug);
    setMetadata(normalizedEntityMetadata);
    setError(null);
    setDeleteError(null);
  }, [entity.name, entity.slug, normalizedEntityMetadata]);

  const handleMetadataChange = useCallback((values: Record<string, unknown>) => {
    setMetadata(values);
  }, []);

  const isDirty =
    name !== entity.name ||
    slug !== entity.slug ||
    JSON.stringify(metadata) !== JSON.stringify(normalizedEntityMetadata);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    try {
      await updateEntity.mutateAsync({
        entityId: entity.id,
        name: name.trim() !== entity.name ? name.trim() : undefined,
        slug: slug !== entity.slug ? slug : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update entity');
    }
  };

  const handleDelete = async () => {
    setDeleteError(null);
    try {
      await deleteEntity.mutateAsync({ entityId: entity.id });
      setShowDeleteDialog(false);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete entity');
    }
  };

  return (
    <>
      <Card className="border-border/80 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <EntityAvatar
              metadata={normalizedEntityMetadata}
              metadataSchema={metadataSchema}
              name={entity.name}
            />

            <div className="grid gap-2">
              <Label htmlFor="sidebar-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input id="sidebar-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="sidebar-slug">URL Slug</Label>
              <Input
                id="sidebar-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              />
            </div>

            {metadataSchema && Object.keys(metadataSchema).length > 0 && (
              <>
                <Separator />
                <DynamicSchemaForm
                  schema={metadataSchema}
                  initialValues={normalizedEntityMetadata}
                  onValuesChange={handleMetadataChange}
                />
              </>
            )}

            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                Delete
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!isDirty || updateEntity.isPending || !name.trim()}
              >
                {updateEntity.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {entityType?.name || entityTypeSlug}</DialogTitle>
            <DialogDescription>Are you sure you want to delete "{entity.name}"?</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {(entity.total_content > 0 || entity.watchers_count > 0) && (
              <div className="flex items-start gap-3 p-3 rounded-md bg-amber-500/10 text-amber-600">
                <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">This entity has associated data</p>
                  <p className="mt-1 text-amber-600/80">
                    {[
                      entity.total_content > 0 &&
                        `${entity.total_content} content item${entity.total_content === 1 ? '' : 's'}`,
                      entity.watchers_count > 0 &&
                        `${entity.watchers_count} watcher${entity.watchers_count === 1 ? '' : 's'}`,
                      entity.active_connections > 0 &&
                        `${entity.active_connections} connector${entity.active_connections === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    . Deleting will remove everything.
                  </p>
                </div>
              </div>
            )}

            <p className="text-sm text-muted-foreground">This action cannot be easily undone.</p>

            {deleteError && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {deleteError}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteEntity.isPending}>
              {deleteEntity.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface EntityTabsContentProps {
  namespace: ResolvedNamespace;
  entity: ResolvedEntityDetails;
  activeTab: EntityTabName;
  watcherId?: string;
  connectorKey?: string;
  onSelectConnector: (connectorKey: string) => void;
  onCloseSelectedConnector: () => void;
  onDeleted?: () => void;
  bootstrap?: ResolvePathBootstrap | null;
}

export function EntityTabsContent({
  namespace,
  entity,
  activeTab,
  watcherId,
  connectorKey,
  onSelectConnector,
  onCloseSelectedConnector,
  onDeleted,
  bootstrap,
}: EntityTabsContentProps) {
  // Flatten entity data for template rendering (metadata + entity props + data source results)
  const templateData = {
    ...entity.metadata,
    ...(entity.template_data ?? {}),
    name: entity.name,
    entity_type: entity.entity_type,
    total_content: entity.total_content,
    active_connections: entity.active_connections,
    watchers_count: entity.watchers_count,
  };

  const customTabs = entity.tabs ?? [];
  const hasCustomTabs = customTabs.length > 0;
  const usesDashboardOverview = !hasCustomTabs && !entity.json_template;
  const entityBasePath = buildEntityUrl(namespace.slug, [
    { entity_type: entity.entity_type, slug: entity.slug },
  ]);

  const entitySidebar = (
    <EntitySidebarForm
      entity={entity}
      entityTypeSlug={entity.entity_type}
      orgContext={{ slug: namespace.slug }}
      onDeleted={onDeleted}
    />
  );

  return (
    <>
      {/* Dashboard overview is always mounted (to keep hooks stable) but hidden when not active */}
      {usesDashboardOverview && (
        <div className={activeTab === 'overview' ? 'mt-4' : 'hidden'}>
          <WorkspaceDashboardHome
            owner={namespace.slug}
            sidebarContent={entitySidebar}
            entityBasePath={entityBasePath}
            bootstrap={bootstrap}
          />
        </div>
      )}

      {activeTab === 'overview' && !usesDashboardOverview && (
        <div className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_460px]">
          <div className="space-y-6">
            {hasCustomTabs ? (
              <Tabs defaultValue={entity.json_template ? '__default__' : customTabs[0]?.tab_name}>
                <TabsList>
                  {entity.json_template && <TabsTrigger value="__default__">Overview</TabsTrigger>}
                  {customTabs.map((tab) => (
                    <TabsTrigger key={tab.tab_name} value={tab.tab_name}>
                      {tab.tab_name}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {entity.json_template && (
                  <TabsContent value="__default__">
                    <JsonRenderer
                      template={{ root: entity.json_template as JsonNode }}
                      data={templateData}
                    />
                  </TabsContent>
                )}

                {customTabs.map((tab) => (
                  <TabsContent key={tab.tab_name} value={tab.tab_name}>
                    <JsonRenderer
                      template={{ root: tab.json_template as JsonNode }}
                      data={{ ...templateData, ...(tab.template_data ?? {}) }}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <JsonRenderer
                template={{ root: entity.json_template as JsonNode }}
                data={templateData}
              />
            )}
          </div>
          <div className="space-y-4">{entitySidebar}</div>
        </div>
      )}

      {activeTab === 'connectors' && (
        <div className="mt-4">
          <ConnectorsView
            organizationId={namespace.id}
            ownerSlug={namespace.slug}
            entityId={entity.id}
            selectedConnectorKey={connectorKey}
            onSelectConnector={onSelectConnector}
            onCloseSelectedConnector={onCloseSelectedConnector}
          />
        </div>
      )}

      {activeTab === 'events' && (
        <div className="mt-4">
          <EventsTab
            organizationId={namespace.id}
            ownerSlug={namespace.slug}
            entityId={entity.id}
            entityName={entity.name}
            entityBasePath={entityBasePath}
          />
        </div>
      )}

      {activeTab === 'watchers' && (
        <div className="mt-4">
          <WatchersTab
            organizationId={namespace.id}
            ownerSlug={namespace.slug}
            entityId={entity.id}
            entityName={entity.name}
            watcherId={watcherId}
          />
        </div>
      )}
    </>
  );
}
