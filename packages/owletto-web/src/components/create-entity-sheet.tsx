import { useCallback, useEffect, useState } from 'react';
import { DynamicSchemaForm } from '@/components/dynamic-schema-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { type CreateEntityParams, useCreateEntity, useEntityType } from '@/lib/api';
import { generateSlug } from '@/lib/url';

// ============================================================
// Types
// ============================================================

interface CreateEntitySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityTypeSlug: string;
  orgContext: { organizationId?: string | null; slug?: string | null };
  onSuccess?: (entityId: number) => void;
}

// ============================================================
// Slug Generation
// ============================================================

// ============================================================
// Component
// ============================================================

export function CreateEntitySheet({
  open,
  onOpenChange,
  entityTypeSlug,
  orgContext,
  onSuccess,
}: CreateEntitySheetProps) {
  // Fetch entity type to get schema
  const { data: entityType, isLoading: isTypeLoading } = useEntityType(entityTypeSlug, orgContext);

  // Form state
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState('');
  const [useCustomSlug, setUseCustomSlug] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  // Mutation
  const createEntity = useCreateEntity();

  // Computed slug
  const displaySlug = useCustomSlug ? customSlug : generateSlug(name);

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      setName('');
      setCustomSlug('');
      setUseCustomSlug(false);
      setMetadata({});
      setError(null);
    }
  }, [open]);

  // Handle metadata changes from dynamic form
  const handleMetadataChange = useCallback((values: Record<string, unknown>) => {
    setMetadata(values);
  }, []);

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    const params: CreateEntityParams = {
      entityType: entityTypeSlug,
      name: name.trim(),
      slug: useCustomSlug ? customSlug : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    try {
      const result = await createEntity.mutateAsync(params);
      onOpenChange(false);
      onSuccess?.(result.entity.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create entity');
    }
  };

  const entityTypeName = entityType?.name || entityTypeSlug;
  const metadataSchema = entityType?.metadata_schema;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[520px] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <SheetHeader>
            <SheetTitle>Create {entityTypeName}</SheetTitle>
            <SheetDescription>
              Add a new {entityTypeName.toLowerCase()} to your workspace.
            </SheetDescription>
          </SheetHeader>

          <div className="grid gap-4 py-4">
            {/* Name field */}
            <div className="grid gap-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Enter ${entityTypeName.toLowerCase()} name`}
                autoFocus
              />
            </div>

            {/* Slug field */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="slug">URL Slug</Label>
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
                  id="slug"
                  value={customSlug}
                  onChange={(e) =>
                    setCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="custom-slug"
                />
              ) : (
                <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                  {displaySlug || 'slug-preview'}
                </div>
              )}
            </div>

            {/* Metadata fields from schema */}
            {isTypeLoading ? (
              <div className="text-sm text-muted-foreground py-2">Loading schema...</div>
            ) : metadataSchema && Object.keys(metadataSchema).length > 0 ? (
              <>
                <Separator className="my-2" />
                <div className="grid gap-2">
                  <Label className="text-sm font-medium">Additional Fields</Label>
                  <DynamicSchemaForm
                    schema={metadataSchema}
                    initialValues={{}}
                    onValuesChange={handleMetadataChange}
                  />
                </div>
              </>
            ) : null}

            {/* Error display */}
            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createEntity.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createEntity.isPending || !name.trim()}>
              {createEntity.isPending ? 'Creating...' : `Create ${entityTypeName}`}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
