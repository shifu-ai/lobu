import { Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  useCreateWatcher,
  useCreateWatcherVersion,
  useSetReactionScript,
  useUpdateWatcher,
  useWatchersList,
} from '@/hooks/use-watchers';
import { cn } from '@/lib/utils';
import { FromScratchPanel } from './from-scratch-panel';

type CreationMode = 'scratch' | 'clone';

interface EditingWatcher {
  watcher_id: string;
  entity_id?: number;
  name?: string;
  slug?: string;
  description?: string;
  prompt?: string;
  extraction_schema?: Record<string, unknown>;
  json_template?: unknown;
  sources?: Array<{ name: string; query: string }>;
  schedule?: string;
  reaction_script?: string;
  agent_id?: string | null;
  scheduler_client_id?: string | null;
  classifiers?: unknown[];
  keying_config?: Record<string, unknown>;
  condensation_prompt?: string;
  condensation_window_count?: number;
  reactions_guidance?: string;
  model_config?: Record<string, unknown>;
  tags?: string[];
}

interface CreateWatcherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  entityId?: number;
  entityName?: string;
  onSuccess?: (watcherId: string) => void;
  editingWatcher?: EditingWatcher;
}

export function CreateWatcherSheet({
  open,
  onOpenChange,
  organizationId,
  entityId,
  entityName,
  onSuccess,
  editingWatcher,
}: CreateWatcherSheetProps) {
  const createWatcher = useCreateWatcher();
  const createVersion = useCreateWatcherVersion();
  const setReactionScript = useSetReactionScript();
  const updateWatcher = useUpdateWatcher();
  const isEditing = !!editingWatcher;
  const [mode, setMode] = useState<CreationMode>('scratch');
  const [clonePrefill, setClonePrefill] = useState<
    | {
        name?: string;
        slug?: string;
        prompt?: string;
        extraction_schema?: Record<string, unknown>;
        json_template?: unknown;
        classifiers?: unknown[];
        keying_config?: Record<string, unknown>;
        condensation_prompt?: string;
        condensation_window_count?: number;
      }
    | undefined
  >(undefined);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      createWatcher.reset();
      createVersion.reset();
      setMode('scratch');
      setClonePrefill(undefined);
    }
    onOpenChange(newOpen);
  };

  const handleCreate = async (params: {
    slug: string;
    name: string;
    description?: string;
    prompt: string;
    extraction_schema: Record<string, unknown>;
    json_template?: unknown;
    entity_id?: number;
    schedule?: string;
    sources?: Array<{ name: string; query: string }>;
    reaction_script?: string;
    scheduler_client_id?: string;
    classifiers?: unknown[];
    keying_config?: Record<string, unknown>;
    condensation_prompt?: string;
    condensation_window_count?: number;
    reactions_guidance?: string;
    model_config?: Record<string, unknown>;
    tags?: string[];
    change_notes?: string;
    agent_id?: string;
  }) => {
    try {
      if (isEditing) {
        // Single atomic create_version call — also updates watcher-level fields
        await createVersion.mutateAsync({
          watcher_id: editingWatcher.watcher_id,
          name: params.name,
          description: params.description,
          prompt: params.prompt,
          extraction_schema: params.extraction_schema,
          json_template: params.json_template,
          sources: params.sources,
          set_as_current: true,
          schedule: params.schedule || null,
          scheduler_client_id: params.scheduler_client_id || null,
          classifiers: params.classifiers,
          keying_config: params.keying_config,
          condensation_prompt: params.condensation_prompt,
          condensation_window_count: params.condensation_window_count,
          reactions_guidance: params.reactions_guidance,
          change_notes: params.change_notes,
        });
        // Reaction script is compiled server-side, so it's a separate call
        const originalScript = editingWatcher.reaction_script ?? '';
        const newScript = params.reaction_script ?? '';
        if (newScript !== originalScript) {
          await setReactionScript.mutateAsync({
            watcher_id: editingWatcher.watcher_id,
            reaction_script: newScript,
          });
        }
        // Watcher-level fields (not part of version)
        const watcherUpdates: Record<string, unknown> = {};
        if (params.model_config !== undefined) watcherUpdates.model_config = params.model_config;
        if (params.tags !== undefined) watcherUpdates.tags = params.tags;
        if (params.agent_id !== undefined) watcherUpdates.agent_id = params.agent_id || null;
        if (Object.keys(watcherUpdates).length > 0) {
          await updateWatcher.mutateAsync({
            watcher_id: editingWatcher.watcher_id,
            ...watcherUpdates,
          });
        }
        handleOpenChange(false);
        onSuccess?.(editingWatcher.watcher_id);
      } else {
        const result = await createWatcher.mutateAsync(params);
        handleOpenChange(false);
        onSuccess?.(result.watcher_id);
      }
    } catch {
      // error is shown by the panel
    }
  };

  const mutationState = isEditing ? createVersion : createWatcher;
  let description = 'Add a watcher';
  if (isEditing) {
    description = 'Edit watcher configuration (saves as new version)';
  } else if (entityName) {
    description = `Add a watcher for ${entityName}`;
  }

  const editPrefill = editingWatcher
    ? {
        entity_id: editingWatcher.entity_id,
        name: editingWatcher.name,
        slug: editingWatcher.slug,
        description: editingWatcher.description,
        prompt: editingWatcher.prompt,
        extraction_schema: editingWatcher.extraction_schema,
        json_template: editingWatcher.json_template,
        sources: editingWatcher.sources,
        schedule: editingWatcher.schedule,
        reaction_script: editingWatcher.reaction_script,
        scheduler_client_id: editingWatcher.scheduler_client_id ?? undefined,
        classifiers: editingWatcher.classifiers,
        keying_config: editingWatcher.keying_config,
        condensation_prompt: editingWatcher.condensation_prompt,
        condensation_window_count: editingWatcher.condensation_window_count,
        reactions_guidance: editingWatcher.reactions_guidance,
        model_config: editingWatcher.model_config,
        tags: editingWatcher.tags,
        agent_id: editingWatcher.agent_id ?? undefined,
      }
    : undefined;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="overflow-y-auto w-full sm:max-w-[1200px]">
        <SheetHeader>
          <SheetTitle>{isEditing ? 'Edit Watcher' : 'Create Watcher'}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="py-6 space-y-6">
          {!isEditing && (
            <div className="flex gap-2">
              <ModeButton
                active={mode === 'scratch'}
                onClick={() => {
                  setMode('scratch');
                  setClonePrefill(undefined);
                }}
                icon={<Plus className="h-4 w-4" />}
                label="From scratch"
              />
              <ModeButton
                active={mode === 'clone'}
                onClick={() => setMode('clone')}
                icon={<Copy className="h-4 w-4" />}
                label="Clone existing"
              />
            </div>
          )}

          {!isEditing && mode === 'clone' && !clonePrefill ? (
            <CloneWatcherPicker
              organizationId={organizationId}
              onSelect={(prefill) => {
                setClonePrefill(prefill);
                setMode('scratch');
              }}
            />
          ) : (
            <FromScratchPanel
              organizationId={organizationId}
              entityId={entityId}
              prefill={editPrefill ?? clonePrefill}
              onSubmit={handleCreate}
              isSubmitting={mutationState.isPending}
              error={mutationState.error ? (mutationState.error as Error).message : null}
              isEditing={isEditing}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
        active
          ? 'border-primary bg-primary/5 text-primary'
          : 'border-border text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function CloneWatcherPicker({
  organizationId,
  onSelect,
}: {
  organizationId: string;
  onSelect: (prefill: {
    name: string;
    slug: string;
    prompt?: string;
    extraction_schema?: Record<string, unknown>;
    json_template?: unknown;
    classifiers?: unknown[];
    keying_config?: Record<string, unknown>;
    condensation_prompt?: string;
    condensation_window_count?: number;
  }) => void;
}) {
  const { data: watchers, isLoading } = useWatchersList(organizationId);
  const [search, setSearch] = useState('');

  const filtered = (watchers || []).filter((w) =>
    w.name?.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-4">Loading watchers...</p>;
  }

  if (!watchers || watchers.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No existing watchers to clone.</p>;
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search watchers..."
        className="w-full rounded-md border px-3 py-2 text-sm bg-background"
      />
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {filtered.map((watcher) => (
          <button
            key={watcher.watcher_id}
            type="button"
            onClick={() =>
              onSelect({
                name: `${watcher.name} (copy)`,
                slug: `${watcher.slug || watcher.watcher_id}-copy`,
                prompt: watcher.prompt,
                extraction_schema: watcher.extraction_schema,
                json_template: watcher.json_template,
                classifiers: watcher.classifiers,
                keying_config: watcher.keying_config,
                condensation_prompt: watcher.condensation_prompt,
                condensation_window_count: watcher.condensation_window_count,
              })
            }
            className="w-full text-left rounded-md border p-3 hover:border-primary/50 hover:bg-primary/5 transition-colors"
          >
            <p className="text-sm font-medium">{watcher.name}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {watcher.entity_name || 'Space-level'} · v{watcher.version ?? '?'}
            </p>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No watchers match your search.
          </p>
        )}
      </div>
    </div>
  );
}
