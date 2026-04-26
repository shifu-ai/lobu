import { CodeEditor } from '@/components/ui/code-editor';

interface JsonSchemaEditorProps {
  value: string;
  onChange: (value: string) => void;
  readonly?: boolean;
  error?: string | null;
}

export function JsonSchemaEditor({ value, onChange, readonly, error }: JsonSchemaEditorProps) {
  return (
    <div className="space-y-2">
      <CodeEditor
        value={value}
        onChange={onChange}
        readonly={readonly}
        placeholder='{ "type": "object", "properties": {} }'
        minHeight="200px"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
