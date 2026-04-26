import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useFeatures } from '@/hooks/use-features';
import { useAgents } from '@/lib/api/agents';
import { generateSlug } from '@/lib/url';
import { EntitySelector } from './entity-selector';
import { ScheduleSelector } from './schedule-selector';
import {
  SchemaRendererFields,
  TemplateFieldsEditor,
  validateExtractionSchemaShape,
} from './template-fields-editor';

/** Postgres text[] may arrive as a raw string like "{a,b}" — normalize to JS array */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.startsWith('{') && raw.endsWith('}')) {
    const inner = raw.slice(1, -1);
    return inner ? inner.split(',').map((s) => s.trim()) : [];
  }
  return [];
}

const DEFAULT_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Short summary of the most important finding in this window',
    },
  },
  required: ['summary'],
  additionalProperties: false,
} as const;

interface FromScratchPanelProps {
  organizationId: string;
  entityId?: number;
  onAdvancedOpenChange?: (open: boolean) => void;
  prefill?: {
    name?: string;
    slug?: string;
    description?: string;
    prompt?: string;
    extraction_schema?: Record<string, unknown>;
    json_template?: unknown;
    entity_id?: number;
    schedule?: string;
    scheduler_client_id?: string;
    sources?: Array<{ name: string; query: string }>;
    reaction_script?: string;
    classifiers?: unknown[];
    keying_config?: Record<string, unknown>;
    condensation_prompt?: string;
    condensation_window_count?: number;
    reactions_guidance?: string;
    model_config?: Record<string, unknown>;
    tags?: string[];
    agent_id?: string;
  };
  onSubmit: (params: {
    slug: string;
    name: string;
    description?: string;
    prompt: string;
    extraction_schema: Record<string, unknown>;
    json_template?: unknown;
    entity_id?: number;
    schedule?: string;
    scheduler_client_id?: string;
    sources?: Array<{ name: string; query: string }>;
    reaction_script?: string;
    classifiers?: unknown[];
    keying_config?: Record<string, unknown>;
    condensation_prompt?: string;
    condensation_window_count?: number;
    reactions_guidance?: string;
    model_config?: Record<string, unknown>;
    tags?: string[];
    change_notes?: string;
    agent_id?: string;
  }) => void;
  isSubmitting: boolean;
  error: string | null;
  isEditing?: boolean;
}

export function FromScratchPanel({
  organizationId,
  entityId,
  onAdvancedOpenChange,
  prefill,
  onSubmit,
  isSubmitting,
  error,
  isEditing,
}: FromScratchPanelProps) {
  const { lobuEmbedded } = useFeatures();
  const { data: agents = [] } = useAgents();
  const [name, setName] = useState(prefill?.name ?? '');
  const [customSlug, setCustomSlug] = useState(prefill?.slug ?? '');
  const [useCustomSlug, setUseCustomSlug] = useState(Boolean(prefill?.slug));
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [prompt, setPrompt] = useState(prefill?.prompt ?? '');
  const [schemaText, setSchemaText] = useState(
    JSON.stringify(prefill?.extraction_schema ?? DEFAULT_EXTRACTION_SCHEMA, null, 2)
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [rendererText, setRendererText] = useState(
    prefill?.json_template ? JSON.stringify(prefill.json_template, null, 2) : ''
  );
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<number | undefined>(
    prefill?.entity_id ?? entityId
  );
  const [schedule, setSchedule] = useState(prefill?.schedule ?? '');
  const [schedulerClientId, setSchedulerClientId] = useState(prefill?.scheduler_client_id ?? '');
  const [sourcesText, setSourcesText] = useState(
    prefill?.sources && prefill.sources.length > 0 ? JSON.stringify(prefill.sources, null, 2) : ''
  );
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [reactionScript, setReactionScript] = useState(prefill?.reaction_script ?? '');
  const [classifiersText, setClassifiersText] = useState(
    prefill?.classifiers ? JSON.stringify(prefill.classifiers, null, 2) : ''
  );
  const [classifiersError, setClassifiersError] = useState<string | null>(null);
  const [keyingConfigText, setKeyingConfigText] = useState(
    prefill?.keying_config ? JSON.stringify(prefill.keying_config, null, 2) : ''
  );
  const [keyingConfigError, setKeyingConfigError] = useState<string | null>(null);
  const [condensationPrompt, setCondensationPrompt] = useState(prefill?.condensation_prompt ?? '');
  const [condensationWindowCount, setCondensationWindowCount] = useState(
    prefill?.condensation_window_count?.toString() ?? ''
  );
  const [reactionsGuidance, setReactionsGuidance] = useState(prefill?.reactions_guidance ?? '');
  const [modelConfigText, setModelConfigText] = useState(
    prefill?.model_config ? JSON.stringify(prefill.model_config, null, 2) : ''
  );
  const [modelConfigError, setModelConfigError] = useState<string | null>(null);
  const [tagsText, setTagsText] = useState(parseTags(prefill?.tags).join(', '));
  const [changeNotes, setChangeNotes] = useState('');
  const [agentId, setAgentId] = useState(prefill?.agent_id ?? '');
  const hasAdvancedContent = Boolean(
    prefill?.description ||
      prefill?.sources?.length ||
      prefill?.reaction_script ||
      prefill?.extraction_schema ||
      prefill?.json_template ||
      prefill?.classifiers?.length ||
      prefill?.keying_config ||
      prefill?.condensation_prompt ||
      prefill?.reactions_guidance ||
      prefill?.model_config ||
      parseTags(prefill?.tags).length ||
      prefill?.agent_id
  );
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedContent);
  useEffect(() => {
    if (!prefill) return;

    setName(prefill.name ?? '');
    setCustomSlug(prefill.slug ?? '');
    setUseCustomSlug(Boolean(prefill.slug));
    setDescription(prefill.description ?? '');
    setPrompt(prefill.prompt ?? '');
    setSchemaText(JSON.stringify(prefill.extraction_schema ?? DEFAULT_EXTRACTION_SCHEMA, null, 2));
    setRendererText(prefill.json_template ? JSON.stringify(prefill.json_template, null, 2) : '');
    setSelectedEntityId(prefill.entity_id ?? entityId);
    setSchedule(prefill.schedule ?? '');
    setSchedulerClientId(prefill.scheduler_client_id ?? '');
    setSourcesText(
      prefill.sources && prefill.sources.length > 0 ? JSON.stringify(prefill.sources, null, 2) : ''
    );
    setSourcesError(null);
    setReactionScript(prefill.reaction_script ?? '');
    setClassifiersText(prefill.classifiers ? JSON.stringify(prefill.classifiers, null, 2) : '');
    setClassifiersError(null);
    setKeyingConfigText(
      prefill.keying_config ? JSON.stringify(prefill.keying_config, null, 2) : ''
    );
    setKeyingConfigError(null);
    setCondensationPrompt(prefill.condensation_prompt ?? '');
    setCondensationWindowCount(prefill.condensation_window_count?.toString() ?? '');
    setReactionsGuidance(prefill.reactions_guidance ?? '');
    setModelConfigText(prefill.model_config ? JSON.stringify(prefill.model_config, null, 2) : '');
    setModelConfigError(null);
    setTagsText(parseTags(prefill.tags).join(', '));
    setChangeNotes('');
    setAgentId(prefill.agent_id ?? '');
    setSchemaError(null);
    setRendererError(null);
  }, [prefill, entityId]);

  const displaySlug = useCustomSlug ? customSlug : generateSlug(name);

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim() || !selectedEntityId) return;

    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      setSchemaError('Invalid JSON. Please check the syntax.');
      return;
    }

    const schemaShapeError = validateExtractionSchemaShape(schema);
    if (schemaShapeError) {
      setSchemaError(schemaShapeError);
      return;
    }

    setSchemaError(null);

    let jsonTemplate: unknown | undefined;
    if (rendererText.trim()) {
      try {
        jsonTemplate = JSON.parse(rendererText);
      } catch {
        setRendererError('Invalid JSON. Please check the syntax.');
        return;
      }
    }
    setRendererError(null);

    let sources: Array<{ name: string; query: string }> | undefined;
    if (sourcesText.trim()) {
      try {
        const parsed = JSON.parse(sourcesText);
        if (!Array.isArray(parsed)) {
          setSourcesError('Sources must be a JSON array.');
          return;
        }
        sources = parsed;
      } catch {
        setSourcesError('Invalid JSON. Please check the syntax.');
        return;
      }
    }
    setSourcesError(null);

    let classifiers: unknown[] | undefined;
    if (classifiersText.trim()) {
      try {
        const parsed = JSON.parse(classifiersText);
        if (!Array.isArray(parsed)) {
          setClassifiersError('Classifiers must be a JSON array.');
          return;
        }
        classifiers = parsed;
      } catch {
        setClassifiersError('Invalid JSON. Please check the syntax.');
        return;
      }
    }
    setClassifiersError(null);

    let keyingConfig: Record<string, unknown> | undefined;
    if (keyingConfigText.trim()) {
      try {
        const parsed = JSON.parse(keyingConfigText);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          setKeyingConfigError('Keying config must be a JSON object.');
          return;
        }
        keyingConfig = parsed;
      } catch {
        setKeyingConfigError('Invalid JSON. Please check the syntax.');
        return;
      }
    }
    setKeyingConfigError(null);

    let modelConfig: Record<string, unknown> | undefined;
    if (modelConfigText.trim()) {
      try {
        const parsed = JSON.parse(modelConfigText);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          setModelConfigError('Model config must be a JSON object.');
          return;
        }
        modelConfig = parsed;
      } catch {
        setModelConfigError('Invalid JSON. Please check the syntax.');
        return;
      }
    }
    setModelConfigError(null);

    const tags = tagsText.trim()
      ? tagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    onSubmit({
      slug: displaySlug,
      name: name.trim(),
      description: description.trim() || undefined,
      prompt: prompt.trim(),
      extraction_schema: schema,
      json_template: jsonTemplate,
      entity_id: selectedEntityId,
      schedule: schedule || undefined,
      scheduler_client_id: schedulerClientId.trim() || undefined,
      sources,
      reaction_script: reactionScript.trim() || undefined,
      classifiers,
      keying_config: keyingConfig,
      condensation_prompt: condensationPrompt.trim() || undefined,
      condensation_window_count: condensationWindowCount
        ? Number(condensationWindowCount)
        : undefined,
      reactions_guidance: reactionsGuidance.trim() || undefined,
      model_config: modelConfig,
      tags,
      change_notes: changeNotes.trim() || undefined,
      agent_id: agentId.trim() || undefined,
    });
  };

  return (
    <div className="space-y-4">
      <TemplateFieldsEditor prompt={prompt} onPromptChange={setPrompt} />

      <div className="space-y-2">
        <Label htmlFor="scratch-name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="scratch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Sentiment Analysis"
        />
      </div>

      {!entityId && (
        <div className="space-y-2">
          <Label>
            Entity <span className="text-destructive">*</span>
          </Label>
          <EntitySelector
            organizationId={organizationId}
            value={selectedEntityId}
            onChange={setSelectedEntityId}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label>Schedule</Label>
        <ScheduleSelector value={schedule} onChange={setSchedule} className="w-full" />
      </div>

      <Collapsible
        open={advancedOpen}
        onOpenChange={(open) => {
          setAdvancedOpen(open);
          onAdvancedOpenChange?.(open);
        }}
        className="space-y-2"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            <span>Advanced</span>
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-4 rounded-md border bg-muted/20 p-3">
          {!isEditing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="scratch-slug">Slug</Label>
                <button
                  type="button"
                  onClick={() => setUseCustomSlug(!useCustomSlug)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {useCustomSlug ? 'Auto-generate' : 'Customize'}
                </button>
              </div>
              {useCustomSlug ? (
                <Input
                  id="scratch-slug"
                  value={customSlug}
                  onChange={(e) =>
                    setCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="custom-slug"
                />
              ) : (
                <div className="flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
                  {displaySlug || 'slug-preview'}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="scratch-description">Description</Label>
            <Input
              id="scratch-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this watcher template"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-scheduler-client">Scheduler Client</Label>
            <Input
              id="scratch-scheduler-client"
              value={schedulerClientId}
              onChange={(e) => setSchedulerClientId(e.target.value)}
              placeholder="e.g., codex, claude-code, lobu"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Optional non-Lobu MCP client that should auto-run this watcher.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-sources">Sources (JSON)</Label>
            <Textarea
              id="scratch-sources"
              value={sourcesText}
              onChange={(e) => {
                setSourcesText(e.target.value);
                setSourcesError(null);
              }}
              placeholder='[{ "name": "content", "query": "SELECT ..." }]'
              className="font-mono text-xs min-h-[80px]"
            />
            {sourcesError && <p className="text-xs text-destructive">{sourcesError}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-reaction">Reaction Script (TypeScript)</Label>
            <Textarea
              id="scratch-reaction"
              value={reactionScript}
              onChange={(e) => setReactionScript(e.target.value)}
              placeholder="export default async function reaction(ctx) { ... }"
              className="font-mono text-xs min-h-[120px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-classifiers">Classifiers (JSON)</Label>
            <Textarea
              id="scratch-classifiers"
              value={classifiersText}
              onChange={(e) => {
                setClassifiersText(e.target.value);
                setClassifiersError(null);
              }}
              placeholder='[{ "slug": "sentiment", "name": "Sentiment", "source_path": "$.analysis[*]", "value_field": "sentiment" }]'
              className="font-mono text-xs min-h-[80px]"
            />
            {classifiersError && <p className="text-xs text-destructive">{classifiersError}</p>}
            <p className="text-xs text-muted-foreground">
              Classifier definitions that extract and normalize values from watcher output via
              JSONPath.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-keying-config">Keying Config (JSON)</Label>
            <Textarea
              id="scratch-keying-config"
              value={keyingConfigText}
              onChange={(e) => {
                setKeyingConfigText(e.target.value);
                setKeyingConfigError(null);
              }}
              placeholder='{ "entity_path": "$.items[*]", "key_fields": ["name"], "key_output_field": "entity_key" }'
              className="font-mono text-xs min-h-[60px]"
            />
            {keyingConfigError && <p className="text-xs text-destructive">{keyingConfigError}</p>}
            <p className="text-xs text-muted-foreground">
              Stable key generation for merging entities across windows.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-condensation-prompt">Condensation Prompt</Label>
            <Textarea
              id="scratch-condensation-prompt"
              value={condensationPrompt}
              onChange={(e) => setCondensationPrompt(e.target.value)}
              placeholder="Handlebars template for condensing multiple windows into a rollup..."
              className="font-mono text-xs min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-condensation-count">Condensation Window Count</Label>
            <Input
              id="scratch-condensation-count"
              type="number"
              min={2}
              value={condensationWindowCount}
              onChange={(e) => setCondensationWindowCount(e.target.value)}
              placeholder="4"
            />
            <p className="text-xs text-muted-foreground">
              How many leaf windows to condense into one rollup. Default: 4.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-reactions-guidance">Reactions Guidance</Label>
            <Textarea
              id="scratch-reactions-guidance"
              value={reactionsGuidance}
              onChange={(e) => setReactionsGuidance(e.target.value)}
              placeholder="Guidance text for the reaction system (e.g., when to alert, severity thresholds)..."
              className="font-mono text-xs min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-model-config">Model Config (JSON)</Label>
            <Textarea
              id="scratch-model-config"
              value={modelConfigText}
              onChange={(e) => {
                setModelConfigText(e.target.value);
                setModelConfigError(null);
              }}
              placeholder='{ "model": "claude-sonnet-4-20250514", "max_tokens": 4096 }'
              className="font-mono text-xs min-h-[60px]"
            />
            {modelConfigError && <p className="text-xs text-destructive">{modelConfigError}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-agent-id">Agent</Label>
            {lobuEmbedded ? (
              <Select
                value={agentId || '__none__'}
                onValueChange={(value) => setAgentId(value === '__none__' ? '' : value)}
              >
                <SelectTrigger id="scratch-agent-id" className="font-mono text-sm">
                  <SelectValue placeholder="Select a Lobu agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No agent</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.agentId} value={agent.agentId}>
                      {agent.name} ({agent.agentId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="scratch-agent-id"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="e.g., agent-123"
                className="font-mono text-sm"
              />
            )}
            <p className="text-xs text-muted-foreground">
              {lobuEmbedded
                ? 'Assign a Lobu agent to automate this watcher through the embedded gateway.'
                : 'Agent that owns or executes this watcher.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scratch-tags">Tags</Label>
            <Input
              id="scratch-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="tag1, tag2, tag3"
            />
            <p className="text-xs text-muted-foreground">Comma-separated tags for filtering.</p>
          </div>

          {isEditing && (
            <div className="space-y-2">
              <Label htmlFor="scratch-change-notes">Change Notes</Label>
              <Input
                id="scratch-change-notes"
                value={changeNotes}
                onChange={(e) => setChangeNotes(e.target.value)}
                placeholder="What changed in this version?"
              />
            </div>
          )}

          <SchemaRendererFields
            schemaText={schemaText}
            onSchemaTextChange={(v) => {
              setSchemaText(v);
              setSchemaError(null);
            }}
            schemaError={schemaError}
            rendererText={rendererText}
            onRendererTextChange={(v) => {
              setRendererText(v);
              setRendererError(null);
            }}
            rendererError={rendererError}
          />
        </CollapsibleContent>
      </Collapsible>

      {error &&
        !schemaError &&
        !rendererError &&
        !sourcesError &&
        !classifiersError &&
        !keyingConfigError &&
        !modelConfigError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

      <Button
        onClick={handleSubmit}
        disabled={!name.trim() || !prompt.trim() || !selectedEntityId || isSubmitting}
        className="w-full"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating...
          </>
        ) : isEditing ? (
          'Save Watcher'
        ) : (
          'Create Watcher'
        )}
      </Button>
    </div>
  );
}
