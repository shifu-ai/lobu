import { ArrowDown, ArrowUp, Minus, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentSettings, AgentSkillConfig, AgentSkillsCatalogItem } from '@/lib/api';

export type SkillEditorRow = {
  repo: string;
  skillId: string;
  name: string;
  description?: string;
  instructions?: string;
  content?: string;
  enabled: boolean;
  system?: boolean;
  mcpServers?: Array<{ id: string; name?: string; url?: string; type?: string }>;
  nixPackages?: string[];
  permissions?: string[];
  /** Original skill config — preserved to avoid dropping untracked fields on save. */
  _original?: AgentSkillConfig;
};

export function buildSkillRows(
  settings: Pick<AgentSettings, 'skillsConfig'> | null | undefined,
  catalog: AgentSkillsCatalogItem[]
): SkillEditorRow[] {
  const skills = settings?.skillsConfig?.skills ?? [];
  const catalogByRepo = new Map(catalog.map((item) => [item.repo, item]));

  return skills.map((skill) => {
    const catalogEntry = catalogByRepo.get(skill.repo);
    return {
      repo: skill.repo,
      skillId: skill.repo.replace(/^system\//, '') || skill.name,
      name: skill.name || catalogEntry?.name || skill.repo,
      description: skill.description ?? catalogEntry?.description,
      instructions: skill.instructions ?? catalogEntry?.instructions,
      content: skill.content,
      enabled: skill.enabled,
      system: skill.system,
      mcpServers: skill.mcpServers ?? catalogEntry?.mcpServers,
      nixPackages: skill.nixPackages ?? catalogEntry?.nixPackages,
      permissions: skill.permissions ?? catalogEntry?.permissions,
      _original: skill,
    };
  });
}

export function skillRowsToSkillsConfig(rows: SkillEditorRow[]): { skills: AgentSkillConfig[] } {
  return {
    skills: rows.map((row) => {
      const content = row.content || row.instructions || row.name;
      return {
        ...row._original,
        repo: row.repo,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        content,
        enabled: row.enabled,
        system: row.system,
        mcpServers: row.mcpServers,
        nixPackages: row.nixPackages,
        permissions: row.permissions,
      };
    }),
  };
}

interface SkillEditorSectionProps {
  skillRows: SkillEditorRow[];
  setSkillRows: React.Dispatch<React.SetStateAction<SkillEditorRow[]>>;
  catalog: AgentSkillsCatalogItem[];
  isLoading: boolean;
  isPending: boolean;
}

export function SkillEditorSection({
  skillRows,
  setSkillRows,
  catalog,
  isLoading,
  isPending,
}: SkillEditorSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [customMcpServers, setCustomMcpServers] = useState<Record<string, { url?: string }>>({});
  const [customPermissions, setCustomPermissions] = useState<string[]>([]);
  const [customNixPackages, setCustomNixPackages] = useState<string[]>([]);

  const templateSkills = catalog.filter(
    (item) => !item.hidden && !skillRows.some((row) => row.repo === item.repo)
  );

  const resetForm = useCallback(() => {
    setCustomName('');
    setCustomInstructions('');
    setCustomMcpServers({});
    setCustomPermissions([]);
    setCustomNixPackages([]);
  }, []);

  const applyTemplate = useCallback((item: AgentSkillsCatalogItem) => {
    setCustomName(item.name);
    setCustomInstructions(item.instructions ?? '');
    const mcpMap: Record<string, { url?: string }> = {};
    for (const srv of item.mcpServers ?? []) {
      mcpMap[srv.id] = srv.url ? { url: srv.url } : {};
    }
    setCustomMcpServers(mcpMap);
    setCustomPermissions(item.permissions ?? []);
    setCustomNixPackages(item.nixPackages ?? []);
  }, []);

  const toggleEnabled = useCallback(
    (repo: string) => {
      setSkillRows((current) =>
        current.map((row) => (row.repo === repo ? { ...row, enabled: !row.enabled } : row))
      );
    },
    [setSkillRows]
  );

  const moveSkill = useCallback(
    (repo: string, direction: -1 | 1) => {
      setSkillRows((current) => {
        const index = current.findIndex((row) => row.repo === repo);
        if (index < 0) return current;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= current.length) return current;
        const next = [...current];
        const [row] = next.splice(index, 1);
        next.splice(nextIndex, 0, row);
        return next;
      });
    },
    [setSkillRows]
  );

  const removeSkill = useCallback(
    (repo: string) => {
      setSkillRows((current) => current.filter((row) => row.repo !== repo));
    },
    [setSkillRows]
  );

  const addSkill = useCallback(() => {
    const name = customName.trim();
    if (!name) return;
    const repo = `custom/${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const mcpEntries = Object.entries(customMcpServers);
    const mcpServers =
      mcpEntries.length > 0
        ? mcpEntries.map(([id, config]) => ({ id, url: config.url }))
        : undefined;
    setSkillRows((current) => {
      if (current.some((row) => row.repo === repo)) return current;
      return [
        ...current,
        {
          repo,
          skillId: name,
          name,
          instructions: customInstructions.trim() || undefined,
          content: customInstructions.trim() || name,
          enabled: true,
          mcpServers,
          nixPackages: customNixPackages.length > 0 ? customNixPackages : undefined,
          permissions: customPermissions.length > 0 ? customPermissions : undefined,
        },
      ];
    });
    resetForm();
    setShowForm(false);
  }, [
    customName,
    customInstructions,
    customMcpServers,
    customNixPackages,
    customPermissions,
    resetForm,
    setSkillRows,
  ]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading skills...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
        <p className="text-muted-foreground">
          {skillRows.length === 0
            ? 'No skills configured yet.'
            : `${skillRows.length} skill${skillRows.length === 1 ? '' : 's'} configured.`}
        </p>
        {showForm ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              resetForm();
              setShowForm(false);
            }}
            disabled={isPending}
          >
            <X className="h-4 w-4" />
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowForm(true)}
            disabled={isPending}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        )}
      </div>

      {showForm ? (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          {templateSkills.length > 0 ? (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium">Start from a template</p>
                <p className="text-sm text-muted-foreground">
                  Pick a system skill to pre-fill the form, or start from scratch.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {templateSkills.map((item) => (
                  <button
                    key={item.repo}
                    type="button"
                    className="flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
                    onClick={() => applyTemplate(item)}
                    disabled={isPending}
                  >
                    <span className="font-medium">{item.name}</span>
                    <SkillBadges item={item} />
                  </button>
                ))}
              </div>
              <div className="border-t" />
            </>
          ) : null}
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="custom-skill-name">Name</Label>
              <Input
                id="custom-skill-name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="my-skill"
                disabled={isPending}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="custom-skill-instructions">Instructions</Label>
              <Textarea
                id="custom-skill-instructions"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Instructions for the agent when this skill is active..."
                rows={3}
                disabled={isPending}
              />
            </div>
            <McpServersEditor
              value={customMcpServers}
              onChange={setCustomMcpServers}
              disabled={isPending}
            />
            <div className="grid gap-2">
              <Label>Network Permissions</Label>
              <StringListEditor
                items={customPermissions}
                onChange={setCustomPermissions}
                placeholder="api.example.com"
                disabled={isPending}
              />
            </div>
            <div className="grid gap-2">
              <Label>Packages</Label>
              <StringListEditor
                items={customNixPackages}
                onChange={setCustomNixPackages}
                placeholder="nodejs, python3..."
                disabled={isPending}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addSkill}
              disabled={!customName.trim() || isPending}
              className="w-fit"
            >
              Add Skill
            </Button>
          </div>
        </div>
      ) : null}

      {skillRows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Add skills to give this agent MCP tools, network access, and system packages.
        </div>
      ) : null}

      {skillRows.map((row, index) => (
        <div key={row.repo} className="space-y-3 rounded-lg border bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <Checkbox
                checked={row.enabled}
                onCheckedChange={() => toggleEnabled(row.repo)}
                disabled={isPending}
                className="mt-1"
              />
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{row.name}</p>
                  {row.system ? <Badge variant="outline">System</Badge> : null}
                  {!row.enabled ? (
                    <Badge variant="secondary" className="opacity-60">
                      Disabled
                    </Badge>
                  ) : null}
                </div>
                {row.description ? (
                  <p className="text-xs text-muted-foreground">{row.description}</p>
                ) : null}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <SkillBadges item={row} />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => moveSkill(row.repo, -1)}
                disabled={index === 0 || isPending}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => moveSkill(row.repo, 1)}
                disabled={index === skillRows.length - 1 || isPending}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              {!row.system ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeSkill(row.repo)}
                  disabled={isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillBadges({
  item,
}: {
  item: {
    mcpServers?: Array<unknown>;
    nixPackages?: string[];
    permissions?: string[];
  };
}) {
  const mcpCount = item.mcpServers?.length ?? 0;
  const nixCount = item.nixPackages?.length ?? 0;
  const permCount = item.permissions?.length ?? 0;

  return (
    <>
      {mcpCount > 0 ? (
        <Badge variant="secondary" className="text-[10px]">
          {mcpCount} MCP {mcpCount === 1 ? 'server' : 'servers'}
        </Badge>
      ) : null}
      {nixCount > 0 ? (
        <Badge variant="secondary" className="text-[10px]">
          {nixCount} {nixCount === 1 ? 'package' : 'packages'}
        </Badge>
      ) : null}
      {permCount > 0 ? (
        <Badge variant="secondary" className="text-[10px]">
          {permCount} {permCount === 1 ? 'permission' : 'permissions'}
        </Badge>
      ) : null}
    </>
  );
}

// ── Agent-level config editors ───────────────────────────────────────────────

function StringListEditor({
  items,
  onChange,
  placeholder,
  disabled,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');

  const add = useCallback(() => {
    const value = draft.trim();
    if (!value || items.includes(value)) return;
    onChange([...items, value]);
    setDraft('');
  }, [draft, items, onChange]);

  const remove = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={add}
          disabled={!draft.trim() || disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, index) => (
            <Badge key={item} variant="secondary" className="gap-1 pr-1">
              {item}
              <button
                type="button"
                onClick={() => remove(index)}
                disabled={disabled}
                className="ml-0.5 rounded-sm hover:bg-muted"
              >
                <Minus className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function McpServersEditor({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, { url?: string }>;
  onChange: (value: Record<string, { url?: string }>) => void;
  disabled?: boolean;
}) {
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const entries = Object.entries(value);

  const add = useCallback(() => {
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name) return;
    onChange({ ...value, [name]: url ? { url } : {} });
    setDraftName('');
    setDraftUrl('');
  }, [draftName, draftUrl, value, onChange]);

  const remove = useCallback(
    (name: string) => {
      const next = { ...value };
      delete next[name];
      onChange(next);
    },
    [value, onChange]
  );

  return (
    <div className="grid gap-2">
      <Label>MCP Servers</Label>
      <p className="text-xs text-muted-foreground">
        Agent-level MCP servers available to all skills.
      </p>
      {entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map(([name, config]) => (
            <div
              key={name}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm"
            >
              <span className="font-medium">{name}</span>
              {config.url ? (
                <span className="truncate text-xs text-muted-foreground">{config.url}</span>
              ) : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-auto h-6 w-6"
                onClick={() => remove(name)}
                disabled={disabled}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="Server name"
          disabled={disabled}
          className="flex-1"
        />
        <Input
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          placeholder="URL (optional)"
          disabled={disabled}
          className="flex-[2]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={add}
          disabled={!draftName.trim() || disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
