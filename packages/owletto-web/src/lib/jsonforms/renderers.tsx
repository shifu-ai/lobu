/**
 * JSON Forms Renderers for shadcn/ui
 *
 * Custom renderer set that uses shadcn/ui components instead of Material UI.
 * Provides consistent styling with the rest of the application.
 */

import type { JsonFormsRendererRegistryEntry, JsonSchema, UISchemaElement } from '@jsonforms/core';
import {
  and,
  type ControlProps,
  isBooleanControl,
  isDateControl,
  isEnumControl,
  isIntegerControl,
  isNumberControl,
  isObjectControl,
  isOneOfEnumControl,
  isStringControl,
  type LayoutProps,
  rankWith,
  schemaMatches,
  uiTypeIs,
} from '@jsonforms/core';
import {
  JsonFormsDispatch,
  withJsonFormsControlProps,
  withJsonFormsLayoutProps,
} from '@jsonforms/react';
import { useMemo } from 'react';
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

// ============================================================
// Utility Functions
// ============================================================

function formatLabel(text: string): string {
  return text
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getLabel(schema: JsonSchema, path: string): string {
  if (schema.title) return schema.title;
  const segments = path.split('.');
  const lastSegment = segments[segments.length - 1];
  return formatLabel(lastSegment || 'Field');
}

function getElementKey(element: UISchemaElement, fallback: string): string {
  const record = element as unknown as Record<string, unknown>;
  const candidate = [record.scope, record.label, record.type].find(
    (value) => typeof value === 'string' && value.length > 0
  ) as string | undefined;
  if (candidate) {
    return candidate;
  }
  try {
    return JSON.stringify(element);
  } catch {
    return fallback;
  }
}

// ============================================================
// Control Components
// ============================================================

// Text Input Control
const TextControl = ({ data, handleChange, path, schema, enabled, required }: ControlProps) => {
  const label = getLabel(schema, path);
  const isUrl = schema.format === 'uri' || schema.format === 'url';

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Input
        id={path}
        type={isUrl ? 'url' : 'text'}
        value={data ?? ''}
        onChange={(e) => handleChange(path, e.target.value || undefined)}
        placeholder={isUrl ? 'https://example.com' : `Enter ${label.toLowerCase()}`}
        disabled={!enabled}
      />
    </div>
  );
};

// Number Input Control
const NumberControl = ({ data, handleChange, path, schema, enabled, required }: ControlProps) => {
  const label = getLabel(schema, path);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Input
        id={path}
        type="number"
        value={data ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          handleChange(path, val === '' ? undefined : Number(val));
        }}
        placeholder={`Enter ${label.toLowerCase()}`}
        disabled={!enabled}
        min={schema.minimum}
        max={schema.maximum}
      />
    </div>
  );
};

// Boolean/Checkbox Control
const BooleanControl = ({ data, handleChange, path, schema, enabled, required }: ControlProps) => {
  const label = getLabel(schema, path);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={path}
          checked={data ?? false}
          onCheckedChange={(checked) => handleChange(path, checked)}
          disabled={!enabled}
        />
        <Label htmlFor={path} className="font-normal">
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
      </div>
      {schema.description && (
        <p className="text-xs text-muted-foreground ml-6">{schema.description}</p>
      )}
    </div>
  );
};

// Date Input Control
const DateControl = ({ data, handleChange, path, schema, enabled, required }: ControlProps) => {
  const label = getLabel(schema, path);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Input
        id={path}
        type="date"
        value={data ?? ''}
        onChange={(e) => handleChange(path, e.target.value || undefined)}
        disabled={!enabled}
      />
    </div>
  );
};

// Enum/Select Control
const EnumControl = ({ data, handleChange, path, schema, enabled, required }: ControlProps) => {
  const label = getLabel(schema, path);
  const options = schema.enum as string[] | undefined;

  if (!options || options.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Select
        value={data ?? ''}
        onValueChange={(value) => handleChange(path, value || undefined)}
        disabled={!enabled}
      >
        <SelectTrigger id={path}>
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {formatLabel(String(option))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

// Multi-Select Control (array of enum)
const MultiSelectControl = ({
  data,
  handleChange,
  path,
  schema,
  enabled,
  required,
}: ControlProps) => {
  const label = getLabel(schema, path);
  const items = schema.items as JsonSchema | undefined;
  const options = items?.enum as string[] | undefined;
  const currentValue = (data as string[]) ?? [];

  if (!options || options.length === 0) {
    return null;
  }

  const toggleOption = (option: string) => {
    if (currentValue.includes(option)) {
      handleChange(
        path,
        currentValue.filter((v) => v !== option)
      );
    } else {
      handleChange(path, [...currentValue, option]);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <div className="flex flex-wrap gap-2 p-2 border rounded-md">
        {options.map((option) => {
          const selected = currentValue.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => toggleOption(option)}
              disabled={!enabled}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                selected
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted border-border'
              } ${!enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {formatLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// Array of Strings Control (comma-separated)
const StringArrayControl = ({
  data,
  handleChange,
  path,
  schema,
  enabled,
  required,
}: ControlProps) => {
  const label = getLabel(schema, path);
  const currentValue = (data as string[]) ?? [];

  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Input
        id={path}
        type="text"
        value={currentValue.join(', ')}
        onChange={(e) => {
          const text = e.target.value;
          const values = text
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v);
          handleChange(path, values.length > 0 ? values : undefined);
        }}
        placeholder="Enter comma-separated values"
        disabled={!enabled}
      />
      <p className="text-xs text-muted-foreground">Separate values with commas</p>
    </div>
  );
};

// ============================================================
// Layout Components
// ============================================================

// Vertical Layout
const VerticalLayoutRenderer = ({
  uischema,
  schema,
  path,
  enabled,
  renderers,
  cells,
}: LayoutProps) => {
  const elements = (uischema as { elements?: UISchemaElement[] }).elements ?? [];

  return (
    <div className="space-y-4">
      {elements.map((element) => (
        <JsonFormsDispatch
          key={getElementKey(element, path)}
          uischema={element}
          schema={schema}
          path={path}
          enabled={enabled}
          renderers={renderers}
          cells={cells}
        />
      ))}
    </div>
  );
};

// Group Layout (for nested objects)
const GroupLayoutRenderer = ({
  uischema,
  schema,
  path,
  enabled,
  renderers,
  cells,
}: LayoutProps) => {
  const elements = (uischema as { elements?: UISchemaElement[]; label?: string }).elements ?? [];
  const label = (uischema as { label?: string }).label;

  return (
    <div className="space-y-3">
      {label && <Label className="text-sm font-medium">{label}</Label>}
      <div className="pl-4 border-l-2 border-muted space-y-3">
        {elements.map((element) => (
          <JsonFormsDispatch
            key={getElementKey(element, path)}
            uischema={element}
            schema={schema}
            path={path}
            enabled={enabled}
            renderers={renderers}
            cells={cells}
          />
        ))}
      </div>
    </div>
  );
};

// Object Control (renders nested object properties)
const ObjectControl = ({ schema, path, enabled, renderers, cells }: ControlProps) => {
  const label = getLabel(schema, path);
  const properties = schema.properties ?? {};

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">{label}</Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <div className="pl-4 border-l-2 border-muted space-y-3">
        {Object.keys(properties).map((propName) => (
          <JsonFormsDispatch
            key={`${path}.${propName}`}
            uischema={{
              type: 'Control',
              scope: `#/properties/${propName}`,
            }}
            schema={properties[propName] as JsonSchema}
            path={`${path}.${propName}`}
            enabled={enabled}
            renderers={renderers}
            cells={cells}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================================
// Wrapped Components with HOCs
// ============================================================

const WrappedTextControl = withJsonFormsControlProps(TextControl);
const WrappedNumberControl = withJsonFormsControlProps(NumberControl);
const WrappedBooleanControl = withJsonFormsControlProps(BooleanControl);
const WrappedDateControl = withJsonFormsControlProps(DateControl);
const WrappedEnumControl = withJsonFormsControlProps(EnumControl);
const WrappedMultiSelectControl = withJsonFormsControlProps(MultiSelectControl);
const WrappedStringArrayControl = withJsonFormsControlProps(StringArrayControl);
const WrappedObjectControl = withJsonFormsControlProps(ObjectControl);
const WrappedVerticalLayout = withJsonFormsLayoutProps(VerticalLayoutRenderer);
const WrappedGroupLayout = withJsonFormsLayoutProps(GroupLayoutRenderer);

// ============================================================
// Testers
// ============================================================

// Check if schema is an array type
const isArrayType = schemaMatches((schema) => schema.type === 'array');

// Check if array has enum items (for multi-select)
const isArrayWithEnumItems = and(
  isArrayType,
  schemaMatches((schema) => {
    const items = schema.items as JsonSchema | undefined;
    return !!(items?.enum && Array.isArray(items.enum));
  })
);

// Check if array has string items without enum (for comma-separated)
const isStringArrayControl = and(
  isArrayType,
  schemaMatches((schema) => {
    const items = schema.items as JsonSchema | undefined;
    return items?.type === 'string' && !items?.enum;
  })
);

// ============================================================
// Renderer Registry
// ============================================================

export const shadcnRenderers: JsonFormsRendererRegistryEntry[] = [
  // Layouts
  { tester: rankWith(1, uiTypeIs('VerticalLayout')), renderer: WrappedVerticalLayout },
  { tester: rankWith(1, uiTypeIs('Group')), renderer: WrappedGroupLayout },

  // Controls - higher rank overrides lower
  { tester: rankWith(2, isStringControl), renderer: WrappedTextControl },
  { tester: rankWith(2, isNumberControl), renderer: WrappedNumberControl },
  { tester: rankWith(2, isIntegerControl), renderer: WrappedNumberControl },
  { tester: rankWith(2, isBooleanControl), renderer: WrappedBooleanControl },
  { tester: rankWith(3, isDateControl), renderer: WrappedDateControl },
  { tester: rankWith(3, isEnumControl), renderer: WrappedEnumControl },
  { tester: rankWith(3, isOneOfEnumControl), renderer: WrappedEnumControl },
  { tester: rankWith(4, isArrayWithEnumItems), renderer: WrappedMultiSelectControl },
  { tester: rankWith(3, isStringArrayControl), renderer: WrappedStringArrayControl },
  { tester: rankWith(2, isObjectControl), renderer: WrappedObjectControl },
];

// ============================================================
// Hook for using renderers
// ============================================================

export function useShadcnRenderers() {
  return useMemo(() => shadcnRenderers, []);
}
