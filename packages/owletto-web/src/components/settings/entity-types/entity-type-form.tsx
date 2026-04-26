import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { type EntityTypeAdmin, useCreateEntityType, useUpdateEntityType } from '@/lib/api';
import { RelationshipTypesTab } from './relationship-types-tab';
import { SchemaBuilder } from './schema-builder/schema-builder';

interface EntityTypeFormProps {
  entityType: EntityTypeAdmin | null; // null = create mode
  onCancel: () => void;
  onSaved: () => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function EntityTypeForm({ entityType, onCancel, onSaved }: EntityTypeFormProps) {
  const isEditing = !!entityType;

  const createMutation = useCreateEntityType();
  const updateMutation = useUpdateEntityType();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [metadataSchema, setMetadataSchema] = useState<Record<string, unknown> | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entityType) {
      setName(entityType.name);
      setSlug(entityType.slug);
      setSlugTouched(true);
      setDescription(entityType.description || '');
      setIcon(entityType.icon || '');
      setColor(entityType.color || '');
      setMetadataSchema(entityType.metadata_schema || undefined);
    } else {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setDescription('');
      setIcon('');
      setColor('');
      setMetadataSchema(undefined);
    }
    setError(null);
  }, [entityType]);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!isEditing && !slugTouched) {
      setSlug(slugify(value));
    }
  };

  const handleSubmit = async () => {
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!isEditing && !slug.trim()) {
      setError('Slug is required');
      return;
    }

    try {
      if (isEditing) {
        await updateMutation.mutateAsync({
          slug: entityType!.slug,
          name: name.trim(),
          description: description.trim() || undefined,
          icon: icon.trim() || undefined,
          color: color.trim() || undefined,
          metadata_schema: metadataSchema,
        });
      } else {
        await createMutation.mutateAsync({
          slug: slug.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          icon: icon.trim() || undefined,
          color: color.trim() || undefined,
          metadata_schema: metadataSchema,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="et-name">Name</Label>
        <Input
          id="et-name"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. Product"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="et-slug">Slug</Label>
        <Input
          id="et-slug"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          placeholder="e.g. topic"
          disabled={isEditing}
        />
        {isEditing && (
          <p className="text-xs text-muted-foreground">Slug cannot be changed after creation.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="et-desc">Description</Label>
        <Textarea
          id="et-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description..."
          rows={2}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="et-icon">Icon (emoji)</Label>
          <Input
            id="et-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="e.g. 📦"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="et-color">Color</Label>
          <div className="flex gap-2">
            <Input
              id="et-color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="e.g. #6366f1"
              className="flex-1"
            />
            {color && (
              <div
                className="h-9 w-9 rounded-md border border-border shrink-0"
                style={{ backgroundColor: color }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Metadata Schema</Label>
        <p className="text-xs text-muted-foreground">
          Define the structure of metadata fields for entities of this type.
        </p>
        <SchemaBuilder value={metadataSchema} onChange={setMetadataSchema} />
      </div>

      {isEditing && (
        <div className="space-y-1.5">
          <Label>Relationships</Label>
          <p className="text-xs text-muted-foreground">
            Define how this entity type relates to others.
          </p>
          <RelationshipTypesTab entityType={entityType!} />
        </div>
      )}

      {error && (
        <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? 'Saving...' : isEditing ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  );
}
