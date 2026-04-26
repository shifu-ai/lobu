import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EnumOptionsEditor } from './enum-options-editor';
import type { SchemaField } from './schema-builder';

const FIELD_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'enum', label: 'Enum' },
] as const;

interface FieldRowProps {
  field: SchemaField;
  onChange: (field: SchemaField) => void;
  onDelete: () => void;
}

function ExamplesEditor({
  examples,
  onChange,
}: {
  examples: string[];
  onChange: (examples: string[]) => void;
}) {
  const [newExample, setNewExample] = useState('');

  const add = () => {
    const trimmed = newExample.trim();
    if (trimmed && !examples.includes(trimmed)) {
      onChange([...examples, trimmed]);
      setNewExample('');
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {examples.map((ex, i) => (
          <span
            key={ex}
            className="inline-flex items-center gap-1 bg-muted text-xs px-2 py-0.5 rounded"
          >
            {ex}
            <button
              type="button"
              onClick={() => onChange(examples.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={newExample}
          onChange={(e) => setNewExample(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add example..."
          className="h-7 text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={add}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export function FieldRow({ field, onChange, onDelete }: FieldRowProps) {
  const [expanded, setExpanded] = useState(
    !!(field.description || field.default || (field.examples && field.examples.length > 0))
  );

  return (
    <div className="rounded-md border border-border p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <Input
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          placeholder="Field name"
          className="h-8 flex-1"
        />
        <Select
          value={field.type}
          onValueChange={(val) =>
            onChange({
              ...field,
              type: val as SchemaField['type'],
              enumOptions: val === 'enum' ? field.enumOptions || [] : undefined,
            })
          }
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((ft) => (
              <SelectItem key={ft.value} value={ft.value}>
                {ft.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground whitespace-nowrap">
          <Checkbox
            checked={field.required}
            onCheckedChange={(checked) => onChange({ ...field, required: checked === true })}
          />
          <span>Required</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {field.type === 'enum' && (
        <div className="pl-6">
          <EnumOptionsEditor
            options={field.enumOptions || []}
            onChange={(opts) => onChange({ ...field, enumOptions: opts })}
          />
        </div>
      )}

      {expanded && (
        <div className="pl-6 space-y-2 pt-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[11px] text-muted-foreground font-medium">Description</span>
              <Input
                value={field.description || ''}
                onChange={(e) => onChange({ ...field, description: e.target.value || undefined })}
                placeholder="Field description"
                className="h-7 text-xs mt-0.5"
              />
            </div>
            <div>
              <span className="text-[11px] text-muted-foreground font-medium">Default</span>
              <Input
                value={field.default || ''}
                onChange={(e) => onChange({ ...field, default: e.target.value || undefined })}
                placeholder={field.type === 'boolean' ? 'true / false' : 'Default value'}
                className="h-7 text-xs mt-0.5"
              />
            </div>
          </div>
          <div>
            <span className="text-[11px] text-muted-foreground font-medium">Examples</span>
            <div className="mt-0.5">
              <ExamplesEditor
                examples={field.examples || []}
                onChange={(exs) =>
                  onChange({ ...field, examples: exs.length > 0 ? exs : undefined })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
