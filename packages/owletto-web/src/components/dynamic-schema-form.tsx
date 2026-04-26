/**
 * Dynamic Schema Form
 *
 * Renders a form dynamically based on a JSON Schema using native React inputs.
 * Replaces the previous JSON Forms-based implementation which had issues with
 * Radix portals (Sheet/Dialog) causing inputs to become unresponsive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { normalizeMetadataForSchema } from '@/lib/schema-value-normalization';

// ============================================================
// Types
// ============================================================

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  readOnly?: boolean;
  format?: string;
  items?: { type?: string; enum?: string[] };
  'x-image'?: boolean;
  'x-email'?: boolean;
  'x-table-column'?: boolean;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface DynamicSchemaFormProps {
  /** JSON Schema defining the form structure */
  schema: Record<string, unknown> | null | undefined;
  /** Initial form values */
  initialValues?: Record<string, unknown>;
  /** Callback when form values change */
  onValuesChange: (values: Record<string, unknown>) => void;
  /** Whether the form is read-only */
  readonly?: boolean;
}

// ============================================================
// Helpers
// ============================================================

function formatLabel(key: string): string {
  return key
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanFormData(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

// ============================================================
// Component
// ============================================================

export function DynamicSchemaForm({
  schema,
  initialValues = {},
  onValuesChange,
  readonly = false,
}: DynamicSchemaFormProps) {
  const parsed = schema as JsonSchemaObject | null | undefined;
  const properties = parsed?.properties;
  const required = new Set(parsed?.required ?? []);
  const initialValuesKey = JSON.stringify(initialValues);
  const normalizedInitialValues = useMemo<Record<string, unknown>>(() => {
    try {
      return normalizeMetadataForSchema(
        JSON.parse(initialValuesKey) as Record<string, unknown>,
        schema
      );
    } catch {
      return {};
    }
  }, [initialValuesKey, schema]);

  const [values, setValues] = useState<Record<string, unknown>>(normalizedInitialValues);
  const onValuesChangeRef = useRef(onValuesChange);
  onValuesChangeRef.current = onValuesChange;

  useEffect(() => {
    setValues(normalizedInitialValues);
  }, [normalizedInitialValues]);

  useEffect(() => {
    onValuesChangeRef.current(cleanFormData(values));
  }, [values]);

  const handleChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  if (!properties || Object.keys(properties).length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        No additional fields required for this entity type.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, prop]) => {
        const label = prop.description || formatLabel(key);
        const isRequired = required.has(key);
        const isReadOnly = readonly || prop.readOnly === true;
        const value = values[key];

        // Enum / Select
        if (prop.enum && Array.isArray(prop.enum)) {
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>
                {label}
                {isRequired && <span className="text-destructive ml-1">*</span>}
              </Label>
              {prop.description && (
                <p className="text-xs text-muted-foreground">{prop.description}</p>
              )}
              <Select
                value={(value as string) ?? ''}
                onValueChange={(v) => handleChange(key, v || undefined)}
                disabled={isReadOnly}
              >
                <SelectTrigger id={key}>
                  <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {prop.enum.map((option) => (
                    <SelectItem key={option} value={option}>
                      {formatLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }

        // Boolean / Checkbox
        if (prop.type === 'boolean') {
          return (
            <div key={key} className="flex items-center space-x-2 py-1">
              <Checkbox
                id={key}
                checked={(value as boolean) ?? false}
                onCheckedChange={(checked) => handleChange(key, checked)}
                disabled={isReadOnly}
              />
              <Label htmlFor={key} className="font-normal">
                {label}
              </Label>
            </div>
          );
        }

        // Number
        if (prop.type === 'number' || prop.type === 'integer') {
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>
                {label}
                {isRequired && <span className="text-destructive ml-1">*</span>}
              </Label>
              <Input
                id={key}
                type="number"
                value={(value as number) ?? ''}
                onChange={(e) =>
                  handleChange(key, e.target.value === '' ? undefined : Number(e.target.value))
                }
                placeholder={`Enter ${label.toLowerCase()}`}
                disabled={isReadOnly}
              />
            </div>
          );
        }

        // Array of strings (comma-separated)
        if (prop.type === 'array' && prop.items?.type === 'string') {
          const arrValue = (value as string[]) ?? [];
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>
                {label}
                {isRequired && <span className="text-destructive ml-1">*</span>}
              </Label>
              <Input
                id={key}
                value={arrValue.join(', ')}
                onChange={(e) => {
                  const vals = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  handleChange(key, vals.length > 0 ? vals : undefined);
                }}
                placeholder="Enter comma-separated values"
                disabled={isReadOnly}
              />
              <p className="text-xs text-muted-foreground">Separate values with commas</p>
            </div>
          );
        }

        // Default: text input
        const isUrl = prop.format === 'uri' || prop.format === 'url';
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={key}>
              {label}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
            {prop.description && (
              <p className="text-xs text-muted-foreground">{prop.description}</p>
            )}
            <Input
              id={key}
              type={isUrl ? 'url' : 'text'}
              value={(value as string) ?? ''}
              onChange={(e) => handleChange(key, e.target.value || undefined)}
              placeholder={isUrl ? 'https://example.com' : `Enter ${label.toLowerCase()}`}
              disabled={isReadOnly}
            />
          </div>
        );
      })}
    </div>
  );
}
