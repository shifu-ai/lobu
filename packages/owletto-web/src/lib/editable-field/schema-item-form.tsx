/**
 * Renders a JSONForms-driven form for one item in a watcher's extracted_data
 * array, using the per-item subschema from the watcher's extraction_schema.
 *
 * Used by both the "Add new item" and "Edit existing item" flows in the
 * auto-renderer. Falls back to a raw JSON textarea when no schema is
 * available (older watchers without extraction_schema).
 */

import type { JsonSchema } from '@jsonforms/core';
import { JsonForms } from '@jsonforms/react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useShadcnRenderers } from '@/lib/jsonforms/renderers';

/** No vanilla cells; the shadcn renderers handle every leaf type the schema is likely to have. */
const EMPTY_CELLS: never[] = [];

interface SchemaItemFormProps {
  /** Per-item JSON Schema, or undefined to render the JSON-textarea fallback. */
  schema?: JsonSchema;
  /** Pre-fill values; pass an existing item for "edit", `{}` for "add". */
  initialData?: unknown;
  /** Submit label, e.g. "Stage edit" or "Stage add". */
  submitLabel: string;
  /** A short description shown above the form. */
  description?: React.ReactNode;
  onSubmit: (value: unknown) => void;
  onCancel: () => void;
}

export function SchemaItemForm({
  schema,
  initialData,
  submitLabel,
  description,
  onSubmit,
  onCancel,
}: SchemaItemFormProps) {
  const [data, setData] = useState<unknown>(initialData ?? {});
  const [errors, setErrors] = useState<unknown[]>([]);
  const renderers = useShadcnRenderers();

  // No schema → JSON textarea fallback so the operator can still propose an
  // item; the backend stores it as opaque JSON either way.
  if (!schema) {
    return <JsonFallbackForm initialData={initialData} submitLabel={submitLabel} description={description} onSubmit={onSubmit} onCancel={onCancel} />;
  }

  const submittable = errors.length === 0;

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      <div className="rounded-md border bg-background p-3">
        <JsonForms
          schema={schema}
          data={data}
          renderers={renderers}
          cells={EMPTY_CELLS}
          onChange={({ data: next, errors: nextErrors }) => {
            setData(next);
            setErrors(nextErrors ?? []);
          }}
        />
      </div>
      {!submittable && errors.length > 0 ? (
        <p className="text-xs text-destructive">
          {(errors[0] as { message?: string })?.message ?? 'Form has validation errors.'}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" className="text-xs" disabled={!submittable} onClick={() => onSubmit(data)}>
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function JsonFallbackForm({
  initialData,
  submitLabel,
  description,
  onSubmit,
  onCancel,
}: Omit<SchemaItemFormProps, 'schema'>) {
  const skeleton = useMemo(() => {
    if (initialData && typeof initialData === 'object' && !Array.isArray(initialData)) {
      return JSON.stringify(initialData, null, 2);
    }
    return '{\n  \n}';
  }, [initialData]);
  const [text, setText] = useState(skeleton);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        rows={Math.min(12, text.split('\n').length + 1)}
        className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="text-xs"
          onClick={() => {
            try {
              onSubmit(JSON.parse(text));
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Invalid JSON');
            }
          }}
        >
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
