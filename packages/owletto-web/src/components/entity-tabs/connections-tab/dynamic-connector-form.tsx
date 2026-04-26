import { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ConnectorType } from '@/lib/api';

// ============================================================
// Schema Parsing Types
// ============================================================

type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'multi-select' | 'array';

interface SelectOption {
  value: string | number;
  label: string;
}

interface FieldConfig {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description?: string;
  placeholder?: string;
  defaultValue?: unknown;
  example?: unknown;
  options?: SelectOption[];
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    minItems?: number;
    maxItems?: number;
  };
}

type DescriptionPart =
  | { id: string; type: 'text'; value: string }
  | { id: string; type: 'link'; href: string; label: string };

function parseAnchoredText(input: string): DescriptionPart[] {
  const parts: DescriptionPart[] = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>(.*?)<\/a>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(input)) !== null) {
    const [fullMatch, href, label] = match;
    const start = match.index;

    if (start > cursor) {
      parts.push({
        id: `text-${cursor}-${start}`,
        type: 'text',
        value: input.slice(cursor, start),
      });
    }

    parts.push({
      id: `link-${start}-${start + fullMatch.length}`,
      type: 'link',
      href: href.trim(),
      label: label.replace(/<[^>]*>/g, '').trim() || href.trim(),
    });

    cursor = start + fullMatch.length;
  }

  if (cursor < input.length) {
    parts.push({
      id: `text-${cursor}-${input.length}`,
      type: 'text',
      value: input.slice(cursor),
    });
  }

  return parts.length > 0 ? parts : [{ id: `text-0-${input.length}`, type: 'text', value: input }];
}

function DescriptionText({ text }: { text: string }) {
  const parts = parseAnchoredText(text);

  return (
    <p className="text-xs text-muted-foreground">
      {parts.map((part) =>
        part.type === 'text' ? (
          <span key={part.id}>{part.value}</span>
        ) : (
          <a
            key={part.id}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            {part.label}
          </a>
        )
      )}
    </p>
  );
}

// ============================================================
// Schema Parsing Functions
// ============================================================

function formatLabel(name: string): string {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function extractLabelFromDescription(description: string | undefined, fieldName: string): string {
  if (!description) return formatLabel(fieldName);
  const label = description.replace(/\s*\(e\.g\.,.*?\)/gi, '').trim();
  const firstSentence = label.split('.')[0].trim();
  return firstSentence || label || formatLabel(fieldName);
}

function formatExampleValue(example: unknown): string | undefined {
  if (example === undefined || example === null) return undefined;
  if (typeof example === 'string' || typeof example === 'number' || typeof example === 'boolean') {
    return String(example);
  }
  if (Array.isArray(example)) {
    const parts = example
      .map((item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
          ? String(item)
          : null
      )
      .filter((item): item is string => item !== null);
    if (parts.length > 0) return parts.join(', ');
  }
  try {
    return JSON.stringify(example);
  } catch {
    return undefined;
  }
}

function parseField(
  name: string,
  schema: Record<string, unknown>,
  isRequired: boolean
): FieldConfig | null {
  // Handle Optional wrapper (TypeBox style)
  const anyOf = schema.anyOf as Array<Record<string, unknown>> | undefined;
  if (anyOf && anyOf.length > 0) {
    const nullOption = anyOf.find((opt) => opt.type === 'null');
    if (nullOption) {
      const nonNullOptions = anyOf.filter((opt) => opt.type !== 'null');
      if (nonNullOptions.length === 1) {
        return parseField(name, nonNullOptions[0], false);
      }
      isRequired = false;
    }
  }

  const config: FieldConfig = {
    name,
    label:
      (schema.title as string | undefined) ||
      extractLabelFromDescription(schema.description as string | undefined, name),
    type: 'text',
    required: isRequired,
    description: schema.description as string | undefined,
    defaultValue: schema.default,
    example: schema.example,
  };
  const examplePlaceholder = formatExampleValue(schema.example);

  // Determine field type
  if (schema.type === 'string') {
    config.type = schema.format === 'password' ? 'password' : 'text';
    config.placeholder = examplePlaceholder || `Enter ${formatLabel(name).toLowerCase()}`;
    config.validation = {
      minLength: schema.minLength as number | undefined,
      maxLength: schema.maxLength as number | undefined,
    };
  } else if (schema.type === 'number' || schema.type === 'integer') {
    config.type = 'number';
    config.placeholder = examplePlaceholder;
    config.validation = {
      min: schema.minimum as number | undefined,
      max: schema.maximum as number | undefined,
    };
  } else if (schema.type === 'boolean') {
    config.type = 'boolean';
  } else if (schema.type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items?.enum && Array.isArray(items.enum)) {
      config.type = 'multi-select';
      config.options = (items.enum as Array<string | number>).map((value) => ({
        value,
        label: formatLabel(String(value)),
      }));
    } else if (items?.anyOf || items?.oneOf) {
      const unionOptions = (items.anyOf || items.oneOf) as Array<Record<string, unknown>>;
      const literalValues = unionOptions
        .filter((opt) => opt.const !== undefined)
        .map((opt) => opt.const as string | number);
      if (literalValues.length > 0) {
        config.type = 'multi-select';
        config.options = literalValues.map((value) => ({
          value,
          label: formatLabel(String(value)),
        }));
      } else {
        config.type = 'array';
        config.placeholder = examplePlaceholder ?? 'Add items...';
      }
    } else {
      config.type = 'array';
      config.placeholder = examplePlaceholder ?? 'Add items...';
    }
    config.validation = {
      minItems: schema.minItems as number | undefined,
      maxItems: schema.maxItems as number | undefined,
    };
  } else if (anyOf) {
    // Union types -> select dropdown
    const literalValues = anyOf
      .filter((opt) => opt.const !== undefined)
      .map((opt) => opt.const as string | number);
    if (literalValues.length > 0) {
      config.type = 'select';
      config.options = literalValues.map((value) => ({
        value,
        label: formatLabel(String(value)),
      }));
      config.placeholder = examplePlaceholder;
    }
  }

  // Check for enum
  if (schema.enum && Array.isArray(schema.enum)) {
    config.type = 'select';
    config.options = (schema.enum as Array<string | number>).map((value) => ({
      value,
      label: formatLabel(String(value)),
    }));
    config.placeholder = examplePlaceholder;
  }

  return config;
}

function parseSchema(schema: Record<string, unknown> | undefined): FieldConfig[] {
  if (!schema || !schema.properties) return [];

  const fields: FieldConfig[] = [];
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[]) || [];

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    const field = parseField(fieldName, fieldSchema, required.includes(fieldName));
    if (field) fields.push(field);
  }

  return fields;
}

// ============================================================
// Component
// ============================================================

interface DynamicConnectorFormProps {
  connectorType?: ConnectorType;
  schema?: Record<string, unknown>;
  initialValues?: Record<string, unknown>;
  onValuesChange?: (values: Record<string, unknown>) => void;
  fieldIdPrefix?: string;
  readOnly?: boolean;
}

const EMPTY_VALUES: Record<string, unknown> = {};

export function DynamicConnectorForm({
  connectorType,
  schema,
  initialValues = EMPTY_VALUES,
  onValuesChange,
  fieldIdPrefix = '',
  readOnly = false,
}: DynamicConnectorFormProps) {
  // Parse schema to get fields
  const fields = useMemo(
    () => parseSchema(schema ?? connectorType?.options_schema),
    [schema, connectorType]
  );

  // Form state
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});

  // Initialize form values
  useEffect(() => {
    const newValues: Record<string, unknown> = {};
    fields.forEach((field) => {
      if (field.name in initialValues) {
        newValues[field.name] = initialValues[field.name];
      } else if (readOnly && field.example !== undefined) {
        // In read-only mode, show example values
        newValues[field.name] =
          field.type === 'array' && Array.isArray(field.example) ? field.example : field.example;
      } else if (field.defaultValue !== undefined) {
        newValues[field.name] = field.defaultValue;
      } else if (field.type === 'multi-select' || field.type === 'array') {
        newValues[field.name] = [];
      } else if (field.type === 'boolean') {
        newValues[field.name] = false;
      } else {
        newValues[field.name] = '';
      }
    });
    setFormValues(newValues);
  }, [initialValues, fields, readOnly]);

  // Notify parent of changes
  const notifyChanges = useCallback(
    (values: Record<string, unknown>) => {
      const cleanOptions: Record<string, unknown> = {};
      fields.forEach((field) => {
        const value = values[field.name];
        if (value !== '' && value !== undefined && value !== null) {
          if (field.type === 'multi-select' || field.type === 'array') {
            if (Array.isArray(value) && value.length > 0) {
              cleanOptions[field.name] = value;
            }
          } else {
            cleanOptions[field.name] = value;
          }
        }
      });
      onValuesChange?.(cleanOptions);
    },
    [fields, onValuesChange]
  );

  const updateValue = (name: string, value: unknown) => {
    const newValues = { ...formValues, [name]: value };
    setFormValues(newValues);
    notifyChanges(newValues);
  };

  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">No configuration required.</p>;
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const fieldId = `${fieldIdPrefix}${field.name}`;
        return (
          <div key={field.name} className="space-y-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {field.label}
              {field.required && !readOnly && <span className="text-red-500 ml-1">*</span>}
            </label>
            {field.description && <DescriptionText text={field.description} />}

            {(field.type === 'text' || field.type === 'password' || field.type === 'number') && (
              <Input
                id={fieldId}
                type={field.type}
                value={(formValues[field.name] as string | number) ?? ''}
                onChange={(e) => updateValue(field.name, e.target.value)}
                placeholder={field.placeholder}
                readOnly={readOnly}
                disabled={readOnly}
              />
            )}

            {field.type === 'boolean' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={fieldId}
                  checked={(formValues[field.name] as boolean) ?? false}
                  onCheckedChange={(checked) => updateValue(field.name, checked)}
                  disabled={readOnly}
                />
                <label htmlFor={fieldId} className="text-sm">
                  Enable
                </label>
              </div>
            )}

            {field.type === 'select' && field.options && (
              <Select
                value={String(formValues[field.name] ?? '')}
                onValueChange={(value) => updateValue(field.name, value)}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={field.placeholder || `Select ${field.label.toLowerCase()}...`}
                  />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {field.type === 'multi-select' && field.options && (
              <div className="flex flex-wrap gap-2 p-2 border rounded-md">
                {field.options.map((option) => {
                  const selected = Array.isArray(formValues[field.name])
                    ? (formValues[field.name] as Array<string | number>).includes(option.value)
                    : false;
                  return (
                    <button
                      key={String(option.value)}
                      type="button"
                      disabled={readOnly}
                      onClick={() => {
                        const current = (formValues[field.name] as Array<string | number>) || [];
                        if (selected) {
                          updateValue(
                            field.name,
                            current.filter((v) => v !== option.value)
                          );
                        } else {
                          updateValue(field.name, [...current, option.value]);
                        }
                      }}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        selected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-muted border-border'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}

            {field.type === 'array' && (
              <>
                <Input
                  id={fieldId}
                  type="text"
                  value={
                    Array.isArray(formValues[field.name])
                      ? (formValues[field.name] as string[]).join(', ')
                      : ''
                  }
                  onChange={(e) => {
                    const text = e.target.value;
                    const values = text
                      .split(',')
                      .map((v) => v.trim())
                      .filter((v) => v);
                    updateValue(field.name, values);
                  }}
                  placeholder={field.placeholder || 'Enter comma-separated values'}
                  readOnly={readOnly}
                  disabled={readOnly}
                />
                <p className="text-xs text-muted-foreground">Enter values separated by commas</p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
