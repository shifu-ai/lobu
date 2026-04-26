import { ArrowRight, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useOrgContext } from '@/hooks/use-org-context';
import {
  type EntityTypeAdmin,
  type RelationshipType,
  type RelationshipTypeRule,
  useAddRelationshipTypeRule,
  useCreateRelationshipType,
  useEntityTypesAdmin,
  useRelationshipTypeRules,
  useRelationshipTypes,
  useRemoveRelationshipTypeRule,
} from '@/lib/api';

interface RelationshipTypesTabProps {
  entityType: EntityTypeAdmin;
}

export function RelationshipTypesTab({ entityType }: RelationshipTypesTabProps) {
  const { orgContext } = useOrgContext();
  const { data: relationshipTypes, isLoading: loadingTypes } = useRelationshipTypes(orgContext);
  const { data: allEntityTypes } = useEntityTypesAdmin(orgContext);

  // Collect all rules across all relationship types
  const relevantTypes = (relationshipTypes || []).filter((rt) => rt.status === 'active');

  return (
    <div className="space-y-4 py-4">
      {loadingTypes ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading relationships...
        </div>
      ) : (
        <>
          <RelationshipRulesList
            entityTypeSlug={entityType.slug}
            relationshipTypes={relevantTypes}
            allEntityTypes={allEntityTypes || []}
          />
          <AddRelationshipPopover
            entityTypeSlug={entityType.slug}
            relationshipTypes={relevantTypes}
            allEntityTypes={allEntityTypes || []}
          />
        </>
      )}
    </div>
  );
}

function RelationshipRulesList({
  entityTypeSlug,
  relationshipTypes,
  allEntityTypes,
}: {
  entityTypeSlug: string;
  relationshipTypes: RelationshipType[];
  allEntityTypes: EntityTypeAdmin[];
}) {
  return (
    <div className="space-y-2">
      {relationshipTypes.map((rt) => (
        <RelationshipTypeRulesSection
          key={rt.id}
          relationshipType={rt}
          entityTypeSlug={entityTypeSlug}
          allEntityTypes={allEntityTypes}
        />
      ))}
    </div>
  );
}

function RelationshipTypeRulesSection({
  relationshipType,
  entityTypeSlug,
  allEntityTypes,
}: {
  relationshipType: RelationshipType;
  entityTypeSlug: string;
  allEntityTypes: EntityTypeAdmin[];
}) {
  const { orgContext } = useOrgContext();
  const { data: rules } = useRelationshipTypeRules(relationshipType.slug, orgContext);
  const removeMutation = useRemoveRelationshipTypeRule();

  const relevantRules = (rules || []).filter(
    (r) =>
      r.source_entity_type_slug === entityTypeSlug || r.target_entity_type_slug === entityTypeSlug
  );

  if (relevantRules.length === 0) return null;

  const entityTypeNameMap = new Map(allEntityTypes.map((et) => [et.slug, et.name]));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{relationshipType.name}</span>
        <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {relationshipType.slug}
        </code>
        {relationshipType.is_symmetric && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            symmetric
          </Badge>
        )}
      </div>
      {relevantRules.map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          entityTypeSlug={entityTypeSlug}
          entityTypeNameMap={entityTypeNameMap}
          onRemove={() => removeMutation.mutate(rule.id)}
          isRemoving={removeMutation.isPending}
        />
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  entityTypeSlug,
  entityTypeNameMap,
  onRemove,
  isRemoving,
}: {
  rule: RelationshipTypeRule;
  entityTypeSlug: string;
  entityTypeNameMap: Map<string, string>;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isSource = rule.source_entity_type_slug === entityTypeSlug;
  const otherSlug = isSource ? rule.target_entity_type_slug : rule.source_entity_type_slug;
  const otherName = entityTypeNameMap.get(otherSlug) || otherSlug;

  return (
    <div className="flex items-center gap-2 py-1.5 px-3 rounded-md border border-border bg-muted/30 text-sm">
      <span className="text-muted-foreground">{isSource ? 'this' : otherName}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">{isSource ? otherName : 'this'}</span>
      {confirming ? (
        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant="destructive"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onRemove}
            disabled={isRemoving}
          >
            {isRemoving ? 'Removing...' : 'Remove'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setConfirming(false)}
            disabled={isRemoving}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirming(true)}
            disabled={isRemoving}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function AddRelationshipPopover({
  entityTypeSlug,
  relationshipTypes,
  allEntityTypes,
}: {
  entityTypeSlug: string;
  relationshipTypes: RelationshipType[];
  allEntityTypes: EntityTypeAdmin[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');

  // Existing relationship type selection
  const [selectedRelTypeSlug, setSelectedRelTypeSlug] = useState('');
  const [targetEntityTypeSlug, setTargetEntityTypeSlug] = useState('');
  const [direction, setDirection] = useState<'source' | 'target'>('source');

  // New relationship type creation
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newSymmetric, setNewSymmetric] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const createRelTypeMutation = useCreateRelationshipType();
  const addRuleMutation = useAddRelationshipTypeRule();

  const reset = () => {
    setMode('existing');
    setSelectedRelTypeSlug('');
    setTargetEntityTypeSlug('');
    setDirection('source');
    setNewName('');
    setNewSlug('');
    setNewSymmetric(false);
    setError(null);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const slugify = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

  const handleSave = async () => {
    setError(null);

    try {
      let relTypeSlug = selectedRelTypeSlug;

      if (mode === 'new') {
        if (!newName.trim()) {
          setError('Name is required');
          return;
        }
        const slug = newSlug.trim() || slugify(newName);
        if (!slug) {
          setError('Slug is required');
          return;
        }
        const result = await createRelTypeMutation.mutateAsync({
          slug,
          name: newName.trim(),
          is_symmetric: newSymmetric,
        });
        relTypeSlug = result.relationship_type.slug;
      }

      if (!relTypeSlug) {
        setError('Select a relationship type');
        return;
      }
      if (!targetEntityTypeSlug) {
        setError('Select a target entity type');
        return;
      }

      const sourceSlug = direction === 'source' ? entityTypeSlug : targetEntityTypeSlug;
      const targetSlug = direction === 'source' ? targetEntityTypeSlug : entityTypeSlug;

      await addRuleMutation.mutateAsync({
        slug: relTypeSlug,
        source_entity_type_slug: sourceSlug,
        target_entity_type_slug: targetSlug,
      });

      handleOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    }
  };

  const isPending = createRelTypeMutation.isPending || addRuleMutation.isPending;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Relationship Rule
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Relationship Type</Label>
            <div className="flex gap-1.5">
              <Button
                variant={mode === 'existing' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={() => setMode('existing')}
              >
                Existing
              </Button>
              <Button
                variant={mode === 'new' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={() => setMode('new')}
              >
                Create New
              </Button>
            </div>
          </div>

          {mode === 'existing' ? (
            <Select value={selectedRelTypeSlug} onValueChange={setSelectedRelTypeSlug}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select relationship type..." />
              </SelectTrigger>
              <SelectContent>
                {relationshipTypes.map((rt) => (
                  <SelectItem key={rt.slug} value={rt.slug}>
                    {rt.name}
                  </SelectItem>
                ))}
                {relationshipTypes.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No relationship types yet. Create one.
                  </div>
                )}
              </SelectContent>
            </Select>
          ) : (
            <div className="space-y-2">
              <Input
                placeholder="Name (e.g. Integrates With)"
                className="h-8 text-sm"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (!newSlug) setNewSlug('');
                }}
              />
              <Input
                placeholder={newName ? slugify(newName) || 'slug' : 'Slug (auto-generated)'}
                className="h-8 text-sm"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={newSymmetric}
                  onChange={(e) => setNewSymmetric(e.target.checked)}
                  className="rounded"
                />
                Symmetric (A↔B = B↔A)
              </label>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Direction</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as 'source' | 'target')}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="source">This type → other</SelectItem>
                <SelectItem value="target">Other → this type</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              {direction === 'source' ? 'Target' : 'Source'} Entity Type
            </Label>
            <Select value={targetEntityTypeSlug} onValueChange={setTargetEntityTypeSlug}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select entity type..." />
              </SelectTrigger>
              <SelectContent>
                {allEntityTypes.map((et) => (
                  <SelectItem key={et.slug} value={et.slug}>
                    {et.icon ? `${et.icon} ` : ''}
                    {et.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button size="sm" className="w-full" onClick={handleSave} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Saving...
              </>
            ) : (
              'Add Rule'
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
