import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function safePrettyJson(value: unknown, fallback: unknown = {}): string {
  return JSON.stringify(value ?? fallback, null, 2);
}

export function parseJsonField<T>(label: string, value: string, fallback: T): T {
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export function JsonField({
  id,
  label,
  value,
  onChange,
  description,
  rows = 8,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  rows?: number;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="font-mono text-xs"
      />
    </div>
  );
}
