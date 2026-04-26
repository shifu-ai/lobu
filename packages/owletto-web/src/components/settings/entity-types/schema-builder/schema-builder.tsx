import { AlertTriangle, Code, Eye, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldRow } from './field-row';
import { JsonSchemaEditor } from './json-schema-editor';

export interface SchemaField {
  id: string;
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  required: boolean;
  enumOptions?: string[];
  description?: string;
  default?: string;
  examples?: string[];
}

interface SchemaBuilderProps {
  value: Record<string, unknown> | undefined;
  onChange: (schema: Record<string, unknown> | undefined) => void;
}

/** Check if a JSON Schema can be represented in the visual builder (flat object with primitives + enums) */
function isSimpleSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  const props = schema.properties;
  if (!props || typeof props !== 'object') return Object.keys(schema).length <= 1;

  for (const val of Object.values(props as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') return false;
    const prop = val as Record<string, unknown>;
    const type = prop.type as string | undefined;
    if (prop.enum) continue; // enum is ok
    if (!type || !['string', 'number', 'integer', 'boolean'].includes(type)) return false;
    // Nested objects / arrays / allOf / oneOf etc. disqualify
    if (prop.properties || prop.items || prop.allOf || prop.oneOf || prop.anyOf) return false;
  }
  return true;
}

function createFieldId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `field-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function schemaToFields(schema: Record<string, unknown>): SchemaField[] {
  const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];

  return Object.entries(props).map(([name, prop]) => {
    const base = {
      id: createFieldId(),
      name,
      required: required.includes(name),
      description: (prop.description as string) || undefined,
      default: prop.default !== undefined ? String(prop.default) : undefined,
      examples: Array.isArray(prop.examples) ? (prop.examples as unknown[]).map(String) : undefined,
    };

    if (prop.enum) {
      return { ...base, type: 'enum' as const, enumOptions: (prop.enum as string[]) || [] };
    }
    return { ...base, type: (prop.type as SchemaField['type']) || 'string' };
  });
}

function coerceValue(val: string, type: SchemaField['type']): unknown {
  if (type === 'number' || type === 'integer') {
    const n = Number(val);
    return Number.isNaN(n) ? val : n;
  }
  if (type === 'boolean') {
    if (val === 'true') return true;
    if (val === 'false') return false;
    return val;
  }
  return val;
}

function fieldsToSchema(fields: SchemaField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    if (!field.name.trim()) continue;

    const prop: Record<string, unknown> = {};

    if (field.type === 'enum') {
      prop.enum = field.enumOptions || [];
    } else {
      prop.type = field.type;
    }

    if (field.description?.trim()) {
      prop.description = field.description.trim();
    }
    if (field.default !== undefined && field.default !== '') {
      prop.default = coerceValue(field.default, field.type);
    }
    if (field.examples && field.examples.length > 0) {
      prop.examples = field.examples.map((e) => coerceValue(e, field.type));
    }

    properties[field.name] = prop;

    if (field.required) {
      required.push(field.name);
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function SchemaBuilder({ value, onChange }: SchemaBuilderProps) {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [fields, setFields] = useState<SchemaField[]>([]);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [complexWarning, setComplexWarning] = useState(false);
  // Track internal edits so the sync effect doesn't overwrite local state
  const internalEdit = useRef(false);

  // Sync from external value prop (only when not caused by our own onChange)
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false;
      return;
    }

    if (!value || Object.keys(value).length === 0) {
      setFields([]);
      setJsonText('');
      setComplexWarning(false);
      return;
    }

    const json = JSON.stringify(value, null, 2);
    setJsonText(json);

    if (isSimpleSchema(value)) {
      setFields(schemaToFields(value));
      setComplexWarning(false);
    } else {
      setComplexWarning(true);
      setMode('json');
    }
  }, [value]);

  const handleFieldsChange = useCallback(
    (newFields: SchemaField[]) => {
      internalEdit.current = true;
      setFields(newFields);
      const schema = fieldsToSchema(newFields);
      const hasFields = newFields.some((f) => f.name.trim());
      setJsonText(hasFields ? JSON.stringify(schema, null, 2) : '');
      onChange(hasFields ? schema : undefined);
    },
    [onChange]
  );

  const handleJsonChange = useCallback(
    (text: string) => {
      internalEdit.current = true;
      setJsonText(text);

      if (!text.trim()) {
        setJsonError(null);
        setFields([]);
        onChange(undefined);
        return;
      }

      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        setJsonError(null);

        if (isSimpleSchema(parsed)) {
          setFields(schemaToFields(parsed));
          setComplexWarning(false);
        } else {
          setComplexWarning(true);
        }

        onChange(parsed);
      } catch (e) {
        setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
      }
    },
    [onChange]
  );

  const addField = () => {
    handleFieldsChange([
      ...fields,
      { id: createFieldId(), name: '', type: 'string', required: false },
    ]);
  };

  const updateField = (index: number, field: SchemaField) => {
    const next = [...fields];
    next[index] = field;
    handleFieldsChange(next);
  };

  const deleteField = (index: number) => {
    handleFieldsChange(fields.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={mode === 'visual' ? 'default' : 'outline'}
          size="sm"
          onClick={() => !complexWarning && setMode('visual')}
          disabled={complexWarning}
          className="h-7 text-xs"
        >
          <Eye className="h-3 w-3 mr-1" />
          Visual
        </Button>
        <Button
          type="button"
          variant={mode === 'json' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('json')}
          className="h-7 text-xs"
        >
          <Code className="h-3 w-3 mr-1" />
          JSON
        </Button>
      </div>

      {complexWarning && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            This schema uses advanced features (nested objects, allOf, etc.) that can only be edited
            in JSON mode.
          </span>
        </div>
      )}

      {mode === 'visual' ? (
        <div className="space-y-3">
          {fields.map((field, i) => (
            <FieldRow
              key={field.id}
              field={field}
              onChange={(f) => updateField(i, f)}
              onDelete={() => deleteField(i)}
            />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addField} className="w-full">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Field
          </Button>
        </div>
      ) : (
        <JsonSchemaEditor value={jsonText} onChange={handleJsonChange} error={jsonError} />
      )}
    </div>
  );
}
