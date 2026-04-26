import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function validateExtractionSchemaShape(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'Extraction schema must be a JSON object.';
  }

  const parsed = schema as Record<string, unknown>;
  if (parsed.type !== 'object') {
    return 'Extraction schema must have "type": "object".';
  }

  if (
    !Object.hasOwn(parsed, 'properties') ||
    !parsed.properties ||
    typeof parsed.properties !== 'object' ||
    Array.isArray(parsed.properties)
  ) {
    return 'Extraction schema must include a "properties" object.';
  }

  return null;
}

interface TemplateFieldsEditorProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  schemaText: string;
  onSchemaTextChange: (value: string) => void;
  schemaError: string | null;
  rendererText: string;
  onRendererTextChange: (value: string) => void;
  rendererError: string | null;
}

export function TemplateFieldsEditor({
  prompt,
  onPromptChange,
}: Pick<TemplateFieldsEditorProps, 'prompt' | 'onPromptChange'>) {
  return (
    <div className="space-y-2">
      <Label htmlFor="tfe-prompt">
        Prompt <span className="text-destructive">*</span>
      </Label>
      <Textarea
        id="tfe-prompt"
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="Describe what this watcher should analyze..."
        rows={4}
      />
      <p className="text-xs text-muted-foreground">
        {'Variables: {{entities}}, {{content}}, {{sources.<name>}}, {{data.<name>}}'}
      </p>
    </div>
  );
}

export function SchemaRendererFields({
  schemaText,
  onSchemaTextChange,
  schemaError,
  rendererText,
  onRendererTextChange,
  rendererError,
}: Omit<TemplateFieldsEditorProps, 'prompt' | 'onPromptChange'>) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="tfe-schema">Extraction Schema (JSON)</Label>
        <Textarea
          id="tfe-schema"
          value={schemaText}
          onChange={(e) => onSchemaTextChange(e.target.value)}
          placeholder='{ "type": "object", "properties": { ... } }'
          rows={8}
          className="font-mono text-xs"
        />
        {schemaError && <p className="text-xs text-destructive">{schemaError}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="tfe-renderer">Output Renderer (JSON)</Label>
        <Textarea
          id="tfe-renderer"
          value={rendererText}
          onChange={(e) => onRendererTextChange(e.target.value)}
          placeholder="Optional — leave empty for auto rendering"
          rows={4}
          className="font-mono text-xs"
        />
        {rendererError && <p className="text-xs text-destructive">{rendererError}</p>}
      </div>
    </>
  );
}
