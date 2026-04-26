import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  EntityTypeBreadcrumbSelector,
  WorkspaceBreadcrumbSelector,
} from '@/components/breadcrumbs/breadcrumb-selector';
import { EntityTabsContent } from '@/components/entity-tabs';
import type { EntityTabName } from '@/components/entity-tabs/types';
import { CreateWatcherSheet } from '@/components/entity-tabs/watchers-tab/create-watcher-sheet';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityIcon } from '@/components/ui/entity-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDeleteWatcher, usePublicWatcherDetail, useWatcherDetail } from '@/hooks/use-watchers';
import type {
  ChildEntity,
  ResolvedEntityDetails,
  ResolvedNamespace,
  ResolvedPathEntity,
  ResolvePathBootstrap,
  SiblingEntity,
} from '@/lib/api';
import { useEntityType } from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import { buildEntityUrl } from '@/lib/url';
import { cn } from '@/lib/utils';

interface EntityPageProps {
  namespace: ResolvedNamespace;
  path: ResolvedPathEntity[];
  entity: ResolvedEntityDetails;
  childEntities: ChildEntity[];
  siblings: SiblingEntity[];
  activeTab?: EntityTabName;
  watcherId?: string;
  connectorKey?: string;
  bootstrap?: ResolvePathBootstrap | null;
}

function getEntityTypeIconValue(configuredIcon?: string | null): string | undefined {
  return configuredIcon?.trim() ? configuredIcon : undefined;
}

function formatEntityTypeBreadcrumbLabel(entityType: string): string {
  return entityType
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTabLabel(tab: EntityTabName): string {
  switch (tab) {
    case 'connectors':
      return 'Connectors';
    case 'events':
      return 'Knowledge';
    case 'watchers':
      return 'Watchers';
    case 'overview':
    default:
      return 'Overview';
  }
}

interface ChildEntitySelectorProps {
  namespace: ResolvedNamespace;
  parentPath: ResolvedPathEntity[];
  childEntities: ChildEntity[];
  currentTab?: EntityTabName;
}

function ChildEntitySelector({
  namespace,
  parentPath,
  childEntities,
  currentTab,
}: ChildEntitySelectorProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleSelect = (child: ChildEntity) => {
    const segments = [
      ...parentPath.map((item) => ({
        entity_type: item.entity_type,
        slug: item.slug,
      })),
      { entity_type: child.entity_type, slug: child.slug },
    ];
    let to = buildEntityUrl(namespace.slug, segments);
    if (currentTab && currentTab !== 'overview') {
      to = `${to}/${currentTab}`;
    }
    navigate({ to: to as '/' });
    setOpen(false);
  };

  const groupedByType = useMemo(() => {
    const groups = new Map<string, ChildEntity[]>();
    for (const child of childEntities) {
      const existing = groups.get(child.entity_type) || [];
      existing.push(child);
      groups.set(child.entity_type, existing);
    }
    return groups;
  }, [childEntities]);

  const summaryLabel = useMemo(() => {
    return Array.from(groupedByType.entries())
      .map(([type, items]) => `${items.length} ${type}${items.length === 1 ? '' : 's'}`)
      .join(', ');
  }, [groupedByType]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-sm font-normal text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs text-muted-foreground mr-1">{summaryLabel}</span>
          <ChevronsUpDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {Array.from(groupedByType.entries()).map(([type, items]) => (
              <CommandGroup key={type} heading={`${type}s`}>
                {items.map((child) => (
                  <CommandItem
                    key={child.id}
                    value={child.name}
                    onSelect={() => handleSelect(child)}
                    className="cursor-pointer"
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {child.market && child.market !== 'global' && (
                        <span className="text-xs font-medium text-muted-foreground flex-shrink-0">
                          {child.market.toUpperCase()}
                        </span>
                      )}
                      <span className="truncate flex-1">{child.name}</span>
                      {child.content_count > 0 && (
                        <span className="text-xs text-muted-foreground ml-auto flex-shrink-0 px-1.5 py-0.5 bg-muted rounded">
                          {child.content_count}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface SiblingSelectorProps {
  namespace: ResolvedNamespace;
  parentPath: ResolvedPathEntity[];
  currentEntity: ResolvedPathEntity;
  siblings: SiblingEntity[];
  currentTab?: EntityTabName;
}

function SiblingSelector({
  namespace,
  parentPath,
  currentEntity,
  siblings,
  currentTab,
}: SiblingSelectorProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleSelect = (sibling: SiblingEntity) => {
    if (sibling.id === currentEntity.id) {
      setOpen(false);
      return;
    }
    const segments = [
      ...parentPath.map((item) => ({
        entity_type: item.entity_type,
        slug: item.slug,
      })),
      { entity_type: sibling.entity_type, slug: sibling.slug },
    ];
    let to = buildEntityUrl(namespace.slug, segments);
    if (currentTab && currentTab !== 'overview') {
      to = `${to}/${currentTab}`;
    }
    navigate({ to: to as '/' });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto px-1 py-0 text-sm font-normal text-muted-foreground hover:text-foreground hover:bg-transparent"
        >
          {currentEntity.name}
          <ChevronsUpDown className="ml-1 h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {siblings.map((sibling) => (
                <CommandItem
                  key={sibling.id}
                  value={sibling.name}
                  onSelect={() => handleSelect(sibling)}
                  className="cursor-pointer"
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      sibling.id === currentEntity.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="truncate flex-1">{sibling.name}</span>
                    {sibling.content_count > 0 && (
                      <span className="text-xs text-muted-foreground ml-auto flex-shrink-0 px-1.5 py-0.5 bg-muted rounded">
                        {sibling.content_count}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface BreadcrumbsProps {
  namespace: ResolvedNamespace;
  path: ResolvedPathEntity[];
  childEntities: ChildEntity[];
  siblings: SiblingEntity[];
  currentTab?: EntityTabName;
  orgContext: { slug?: string };
}

function Breadcrumbs({
  namespace,
  path,
  childEntities,
  siblings,
  currentTab,
  orgContext,
}: BreadcrumbsProps) {
  const showSiblingSelector = childEntities.length === 0 && siblings.length > 1;
  const lastIndex = path.length - 1;

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <WorkspaceBreadcrumbSelector
        currentSlug={namespace.slug}
        currentName={namespace.name || namespace.slug}
      />
      {path.map((segment, index) => {
        const segments = path.slice(0, index + 1).map((item) => ({
          entity_type: item.entity_type,
          slug: item.slug,
        }));
        const to = buildEntityUrl(namespace.slug, segments);
        const isLast = index === lastIndex;
        const prevType = index > 0 ? path[index - 1].entity_type : null;
        const showType = segment.entity_type !== prevType;

        return (
          <span key={`${segment.entity_type}-${segment.slug}`} className="flex items-center gap-1">
            {showType && (
              <>
                <span>/</span>
                <EntityTypeBreadcrumbSelector
                  ownerSlug={namespace.slug}
                  currentEntityTypeSlug={segment.entity_type}
                  currentLabel={formatEntityTypeBreadcrumbLabel(segment.entity_type)}
                  orgContext={orgContext}
                />
              </>
            )}
            <span>/</span>
            {isLast && showSiblingSelector && (
              <SiblingSelector
                namespace={namespace}
                parentPath={path.slice(0, index)}
                currentEntity={segment}
                siblings={siblings}
                currentTab={currentTab}
              />
            )}
            {isLast && !showSiblingSelector && (
              <span className="text-foreground">{segment.name}</span>
            )}
            {!isLast && (
              <Link to={to as '/'} className="hover:text-foreground">
                {segment.name}
              </Link>
            )}
          </span>
        );
      })}
      {childEntities.length > 0 && (
        <span className="flex items-center gap-1">
          <span>/</span>
          <ChildEntitySelector
            namespace={namespace}
            parentPath={path}
            childEntities={childEntities}
            currentTab={currentTab}
          />
        </span>
      )}
    </nav>
  );
}

export function EntityPage({
  namespace,
  path,
  entity,
  childEntities,
  siblings,
  activeTab = 'overview',
  watcherId,
  connectorKey,
  bootstrap,
}: EntityPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuthState();
  const { data: entityTypeDefinition } = useEntityType(entity.entity_type, {
    slug: namespace.slug,
  });

  const watcherQueryOptions = {
    templateVersion: (location.search as Record<string, unknown>)?.version as number | undefined,
  };
  const authWatcherQuery = useWatcherDetail(
    isAuthenticated ? watcherId : undefined,
    watcherId ? entity.id : undefined,
    watcherId ? namespace.id : undefined,
    watcherQueryOptions
  );
  const publicWatcherQuery = usePublicWatcherDetail(
    namespace.slug,
    !isAuthenticated ? watcherId : undefined,
    watcherId ? entity.id : undefined,
    watcherQueryOptions
  );
  const watcherData = isAuthenticated ? authWatcherQuery.data : publicWatcherQuery.data;
  const deleteWatcher = useDeleteWatcher();
  const [editWatcherOpen, setEditWatcherOpen] = useState(false);
  const watcher = watcherData?.watcher;
  const entityIconValue = getEntityTypeIconValue(entityTypeDefinition?.icon);
  const entityBasePath = buildEntityUrl(
    namespace.slug,
    path.map((item) => ({
      entity_type: item.entity_type,
      slug: item.slug,
    }))
  );
  const connectorsPath = `${entityBasePath}/connectors`;
  let pageLabel: string | null = null;
  if (watcher) {
    pageLabel = watcher.watcher_name;
  } else if (watcherId) {
    pageLabel = 'Watcher';
  } else if (activeTab !== 'overview') {
    pageLabel = formatTabLabel(activeTab);
  }

  const handleWatcherVersionChange = (v: string) => {
    navigate({
      to: location.pathname as '/',
      search: { ...(location.search as Record<string, unknown>), version: parseInt(v, 10) },
      replace: true,
    });
  };

  const [confirmingWatcherDelete, setConfirmingWatcherDelete] = useState(false);
  const handleWatcherDelete = async () => {
    if (!watcherId) return;
    await deleteWatcher.mutateAsync(watcherId);
    const watchersPath = location.pathname.replace(/\/watchers\/[^/]+$/, '/watchers');
    navigate({ to: watchersPath as '/' });
  };

  return (
    <div className="flex flex-1 flex-col py-4 px-4 lg:px-6">
      <div className="space-y-2">
        <Breadcrumbs
          namespace={namespace}
          path={path}
          childEntities={childEntities}
          siblings={siblings}
          currentTab={activeTab}
          orgContext={{ slug: namespace.slug }}
        />
        <div className="flex items-center gap-2">
          <h1 className="flex items-center gap-2 text-3xl font-semibold leading-tight">
            <span className="text-2xl leading-none">
              <EntityIcon icon={entityIconValue} className="h-7 w-7" />
            </span>
            {watcherId ? (
              <span>{pageLabel}</span>
            ) : (
              <>
                <span>{entity.name}</span>
                {pageLabel && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span>{pageLabel}</span>
                  </>
                )}
              </>
            )}
          </h1>
          {watcher?.version &&
            watcher.available_versions &&
            watcher.available_versions.length > 0 && (
              <Select
                value={String(
                  (location.search as Record<string, unknown>)?.version ?? watcher.version
                )}
                onValueChange={handleWatcherVersionChange}
              >
                <SelectTrigger className="h-6 w-auto text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {watcher.available_versions?.map((v: number | { version: number }) => {
                    const version = typeof v === 'object' && v !== null ? v.version : v;
                    return (
                      <SelectItem key={version} value={String(version)}>
                        v{version}
                        {version === watcher.version && ' (current)'}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          {isAuthenticated && watcher && !confirmingWatcherDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditWatcherOpen(true)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit Watcher
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmingWatcherDelete(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Watcher
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isAuthenticated && watcher && confirmingWatcherDelete && (
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteWatcher.isPending}
                onClick={() => void handleWatcherDelete()}
              >
                {deleteWatcher.isPending ? 'Deleting...' : 'Confirm Delete'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingWatcherDelete(false)}
                disabled={deleteWatcher.isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>

      <EntityTabsContent
        namespace={namespace}
        entity={entity}
        activeTab={activeTab}
        watcherId={watcherId}
        connectorKey={connectorKey}
        onSelectConnector={(nextConnectorKey) => {
          navigate({ to: `${connectorsPath}/${nextConnectorKey}` as '/' });
        }}
        onCloseSelectedConnector={() => {
          navigate({ to: connectorsPath as '/' });
        }}
        bootstrap={bootstrap}
        onDeleted={() => {
          const parentPath = path.slice(0, -1);
          if (parentPath.length > 0) {
            const to = buildEntityUrl(namespace.slug, parentPath);
            navigate({ to: to as '/' });
          } else {
            navigate({
              to: `/${namespace.slug}/${entity.entity_type}` as '/',
            });
          }
        }}
      />

      {isAuthenticated && watcher && (
        <CreateWatcherSheet
          open={editWatcherOpen}
          onOpenChange={setEditWatcherOpen}
          organizationId={namespace.id}
          entityId={entity.id}
          entityName={entity.name}
          editingWatcher={{
            watcher_id: watcher.watcher_id,
            name: watcher.watcher_name,
            slug: watcher.slug,
            description: watcher.description,
            prompt: watcher.prompt,
            extraction_schema: watcher.extraction_schema as Record<string, unknown> | undefined,
            json_template: watcher.json_template,
            sources: watcher.sources,
            schedule: watcher.schedule ?? undefined,
            reaction_script: watcher.reaction_script,
          }}
        />
      )}
    </div>
  );
}
