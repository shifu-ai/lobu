/**
 * JSON Renderer component for displaying extracted_data
 * Renders JSON data as structured cards with formatted section titles
 */

import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { JsonSchema } from '@jsonforms/core';
import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EditablePrimitive,
  type FieldCorrection,
} from '@/lib/editable-field/editable-primitive';
import { SchemaItemForm } from '@/lib/editable-field/schema-item-form';
import {
  resolveItemSchemaForArrayPath,
  resolveSchemaForPath,
} from '@/lib/editable-field/schema-utils';
import { cn } from '@/lib/utils';

export type TrendDirection = 'up' | 'down' | 'stable';

export interface ClassificationContext {
  stats: Record<string, Record<string, number>>;
  trends: Record<string, Record<string, TrendDirection>>;
  colors: Record<string, string>;
}

export interface IdReferenceItem {
  id: number;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  platform?: string | null;
}

interface JsonRendererProps {
  data: unknown;
  depth?: number;
  className?: string;
  classificationContext?: ClassificationContext;
  showSectionSidebar?: boolean;
  parentKey?: string;
  idReferences?: Record<number, IdReferenceItem>;
  /** Callback for field corrections. When provided, leaf values become editable. */
  onCorrection?: (fieldPath: string, newValue: unknown) => void;
  /**
   * Callback for structural array corrections (remove an item, append a new
   * one). When provided, array items expose a remove control and arrays
   * expose an "Add item" form. Past/pending state is read from
   * FieldFeedbackProvider context.
   */
  onStructuralCorrection?: (
    fieldPath: string,
    mutation: 'remove' | 'add',
    value?: unknown
  ) => void;
  /**
   * Watcher's `extraction_schema` (JSON Schema) for the rendered data. When
   * supplied, the add/edit forms use JSONForms over the per-item subschema
   * for typed field inputs; without it, they fall back to a JSON textarea.
   */
  extractionSchema?: JsonSchema;
  /** Latest committed correction per field path (for "edited" indicator). */
  corrections?: Record<string, FieldCorrection>;
  /** Pending (locally staged, not yet submitted) corrections per field path. */
  pendingCorrections?: Record<string, unknown>;
  /** Current JSON path for building correction field paths. */
  fieldPath?: string;
}

/**
 * Format a key into a human-readable title
 * e.g., "problems_analysis" -> "Problems Analysis"
 */
function formatSectionTitle(key: string): string {
  const normalizedKey = key.replace(/_ids$/i, '_references');

  return normalizedKey
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function sectionIdFromKey(key: string, index: number): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return `section-${slug || 'item'}-${index + 1}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function slugLabel(label: string): string {
  return label.replace(/_/g, ' ');
}

/** Humanize a snake_case or kebab-case enum value: "very_positive" → "Very Positive" */
function humanizeValue(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Detect whether a string is likely markdown / multi-line prose worth rendering as rich text */
function isMarkdownLike(str: string): boolean {
  return str.length > 100 && (str.includes('\n') || /[#*-]/.test(str));
}

/** Detect whether a string array contains sentence-length items (not short tags) */
function isLongStringArray(data: unknown[]): boolean {
  if (data.length === 0) return false;
  if (!data.every((item) => typeof item === 'string')) return false;
  const avgLength = (data as string[]).reduce((sum, s) => sum + s.length, 0) / data.length;
  return avgLength > 30;
}

function isIdentifierLike(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9]+$/.test(value.trim());
}

function isIdentifierListKey(key?: string): boolean {
  if (!key) return false;
  const normalized = key.toLowerCase();
  return normalized === 'ids' || normalized.endsWith('_ids');
}

function formatIdentifierListLabel(key: string): string {
  const normalized = key.toLowerCase();
  const withoutSuffix = normalized.endsWith('_ids') ? normalized.slice(0, -4) : normalized;

  const base = withoutSuffix.replace(/_/g, ' ').trim();
  if (!base) return 'linked items';

  return base.endsWith('s') ? base : `${base}s`;
}

function buildConicGradient(
  segments: Array<{ label: string; value: number; color: string }>
): string | null {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;

  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = (cursor / total) * 100;
    cursor += segment.value;
    const end = (cursor / total) * 100;
    return `${segment.color} ${start}% ${end}%`;
  });

  return `conic-gradient(${stops.join(', ')})`;
}

/**
 * Check if an object looks like a "problem" or "item" with specific fields
 */
function isItemLike(obj: Record<string, unknown>): boolean {
  const itemFields = ['name', 'title', 'description', 'category', 'severity', 'summary'];
  return itemFields.some((field) => field in obj);
}

/**
 * Render a primitive value (string, number, boolean)
 */
function renderPrimitive(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">-</span>;
  }

  if (typeof value === 'boolean') {
    return <Badge variant={value ? 'default' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>;
  }

  if (typeof value === 'number') {
    return <span className="font-mono">{value.toLocaleString()}</span>;
  }

  // String value
  const str = String(value);

  // Check if it's a URL
  if (str.startsWith('http://') || str.startsWith('https://')) {
    return (
      <a
        href={str}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
      >
        {str}
      </a>
    );
  }

  // Multi-line / long text → render as markdown
  if (isMarkdownLike(str)) {
    return (
      <div className="max-w-none text-sm space-y-2">
        <Markdown
          components={{
            h1: ({ children }) => <h2 className="text-lg font-semibold mt-4 mb-1">{children}</h2>,
            h2: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1">{children}</h3>,
            h3: ({ children }) => <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>,
            p: ({ children }) => (
              <p className="text-sm text-foreground leading-relaxed">{children}</p>
            ),
            ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5">{children}</ul>,
            ol: ({ children }) => (
              <ol className="list-decimal list-inside space-y-0.5">{children}</ol>
            ),
            li: ({ children }) => <li className="text-sm text-muted-foreground">{children}</li>,
            strong: ({ children }) => (
              <strong className="font-semibold text-foreground">{children}</strong>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {children}
              </a>
            ),
          }}
        >
          {str}
        </Markdown>
      </div>
    );
  }

  return <span className="whitespace-pre-wrap">{str}</span>;
}

const TREND_DISPLAY: Record<TrendDirection, { arrow: string; className: string }> = {
  up: { arrow: '\u2191', className: 'text-red-500' },
  down: { arrow: '\u2193', className: 'text-green-600' },
  stable: { arrow: '\u2192', className: 'text-muted-foreground' },
};

function DistributionMiniChart({
  classifierSlug,
  values,
  colors,
}: {
  classifierSlug: string;
  values: Record<string, number>;
  colors: Record<string, string>;
}) {
  const total = Object.values(values).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;

  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([label, value]) => ({
    label,
    value,
    color: colors[label] ?? '#94a3b8',
  }));

  const remainder = sorted.slice(5).reduce((sum, [, count]) => sum + count, 0);
  const segments =
    remainder > 0 ? [...top, { label: 'other', value: remainder, color: '#cbd5e1' }] : top;

  const gradient = buildConicGradient(segments);
  if (!gradient) return null;

  return (
    <div className="rounded-md border bg-background/70 p-2">
      <p className="mb-2 line-clamp-1 text-xs font-medium text-muted-foreground capitalize">
        {slugLabel(classifierSlug)}
      </p>
      <div className="flex items-center gap-2">
        <div
          role="img"
          className="relative h-12 w-12 shrink-0 rounded-full"
          style={{ background: gradient }}
          aria-label={`${classifierSlug} distribution`}
        >
          <div className="absolute inset-2 rounded-full bg-background" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {segments.slice(0, 3).map((segment) => {
            const pct = (segment.value / total) * 100;
            return (
              <div key={segment.label} className="flex items-center gap-1.5 text-[11px]">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: segment.color }}
                  aria-hidden
                />
                <span className="truncate text-muted-foreground">{slugLabel(segment.label)}</span>
                <span className="ml-auto font-mono text-foreground">{formatPercent(pct)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Find classification match for an item's categorization fields.
 * Returns the first matching classifier value's stats, trend, and color.
 */
function findClassificationMatch(
  item: Record<string, unknown>,
  ctx: ClassificationContext
): {
  value: string;
  count: number;
  total: number;
  trend: TrendDirection | null;
  color: string;
} | null {
  const matchFields = ['category', 'type', 'classification'];

  for (const field of matchFields) {
    const fieldValue = item[field];
    if (typeof fieldValue !== 'string') continue;

    for (const [classifierSlug, values] of Object.entries(ctx.stats)) {
      if (fieldValue in values) {
        const count = values[fieldValue];
        const total = Object.values(values).reduce((sum, c) => sum + c, 0);
        const trend = ctx.trends[classifierSlug]?.[fieldValue] ?? null;
        const color = ctx.colors[fieldValue] ?? '#94a3b8';
        return { value: fieldValue, count, total, trend, color };
      }
    }
  }

  return null;
}

/**
 * Render an item card (for objects that look like items/problems)
 */
function ItemCard({
  item,
  depth,
  classificationContext,
  idReferences,
  onCorrection,
  onStructuralCorrection,
  extractionSchema,
  fieldPath,
}: {
  item: Record<string, unknown>;
  depth: number;
  classificationContext?: ClassificationContext;
  idReferences?: Record<number, IdReferenceItem>;
  onCorrection?: (fieldPath: string, newValue: unknown) => void;
  onStructuralCorrection?: (
    fieldPath: string,
    mutation: 'remove' | 'add',
    value?: unknown
  ) => void;
  extractionSchema?: JsonSchema;
  fieldPath?: string;
}) {
  const [editing, setEditing] = useState(false);
  const itemSchema = useMemo(
    () => (fieldPath ? resolveSchemaForPath(extractionSchema, fieldPath) : undefined),
    [extractionSchema, fieldPath]
  );
  // Extract common fields
  const name = item.name || item.title || item.problem_name;
  const description = item.description || item.summary;
  const category = item.category;
  const severity = item.severity;
  const count = item.count || item.mention_count;

  const classMatch = classificationContext
    ? findClassificationMatch(item, classificationContext)
    : null;

  // Get remaining fields
  const displayedFields = new Set([
    'name',
    'title',
    'problem_name',
    'description',
    'summary',
    'category',
    'severity',
    'count',
    'mention_count',
  ]);
  const otherFields = Object.entries(item).filter(([key]) => !displayedFields.has(key));

  const canRemove = !!onStructuralCorrection && !!fieldPath;
  const canEditWhole = !!onCorrection && !!fieldPath;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-2">
        {/* Header with name and badges */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            {!!name && <h4 className="font-semibold text-sm">{String(name)}</h4>}
            {!!description && (
              <p className="text-sm text-muted-foreground mt-1">{String(description)}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {canEditWhole && !editing && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                title="Edit this item with the watcher's schema form"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canRemove && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                title="Mark this item for removal"
                onClick={() => onStructuralCorrection?.(fieldPath as string, 'remove')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {!!category && (
              <Badge variant="outline" className="text-xs">
                {humanizeValue(String(category))}
              </Badge>
            )}
            {classMatch && (
              <Badge
                variant="outline"
                className="text-xs gap-1 font-mono"
                style={{ borderColor: classMatch.color, color: classMatch.color }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: classMatch.color }}
                />
                {classMatch.count}
                <span className="font-sans text-muted-foreground">
                  ({Math.round((classMatch.count / classMatch.total) * 100)}%)
                </span>
                {classMatch.trend && (
                  <span className={TREND_DISPLAY[classMatch.trend].className}>
                    {TREND_DISPLAY[classMatch.trend].arrow}
                  </span>
                )}
              </Badge>
            )}
            {!!severity && (
              <Badge
                variant={
                  String(severity).toLowerCase() === 'critical'
                    ? 'destructive'
                    : String(severity).toLowerCase() === 'high'
                      ? 'destructive'
                      : 'secondary'
                }
                className="text-xs"
              >
                {humanizeValue(String(severity))}
              </Badge>
            )}
            {count !== undefined && (
              <Badge variant="secondary" className="text-xs font-mono">
                {Number(count).toLocaleString()}
              </Badge>
            )}
          </div>
        </div>

        {/* Other fields */}
        {otherFields.length > 0 && (
          <div className="pt-2 border-t space-y-1.5">
            {otherFields.map(([key, value]) => {
              const childPath = fieldPath ? `${fieldPath}.${key}` : key;
              return (
                <div key={key} className="text-sm">
                  <span className="text-muted-foreground">{formatSectionTitle(key)}: </span>
                  {BADGE_FIELDS.has(key) && typeof value === 'string' ? (
                    <Badge variant="outline" className="text-xs">
                      {humanizeValue(value)}
                    </Badge>
                  ) : Array.isArray(value) ? (
                    <JsonRenderer
                      data={value}
                      depth={depth + 1}
                      classificationContext={classificationContext}
                      parentKey={key}
                      idReferences={idReferences}
                      onCorrection={onCorrection}
                      onStructuralCorrection={onStructuralCorrection}
                      extractionSchema={extractionSchema}
                      fieldPath={childPath}
                    />
                  ) : typeof value === 'object' && value !== null ? (
                    <JsonRenderer
                      data={value}
                      depth={depth + 1}
                      classificationContext={classificationContext}
                      parentKey={key}
                      idReferences={idReferences}
                      onCorrection={onCorrection}
                      onStructuralCorrection={onStructuralCorrection}
                      extractionSchema={extractionSchema}
                      fieldPath={childPath}
                    />
                  ) : onCorrection ? (
                    <EditablePrimitive
                      value={value}
                      fieldPath={childPath}
                      onCorrection={onCorrection}
                    />
                  ) : (
                    renderPrimitive(value)
                  )}
                </div>
              );
            })}
          </div>
        )}
        {editing && canEditWhole ? (
          <SchemaItemForm
            schema={itemSchema}
            initialData={item}
            submitLabel="Stage edit"
            description={
              <>
                Edit fields below. Submitting stages a single <span className="font-mono">set</span>{' '}
                correction at <span className="font-mono">{fieldPath}</span> with the new item.
              </>
            }
            onSubmit={(value) => {
              onCorrection?.(fieldPath as string, value);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

const BADGE_FIELDS = new Set(['severity', 'urgency', 'sentiment', 'trend', 'status', 'context']);

/**
 * Detect arrays of same-shape objects with only primitive values
 */
function isPrimitiveOrIdArray(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return true;
  if (Array.isArray(v) && v.every((item) => isIdentifierLike(item))) return true;
  return false;
}

function isUniformPrimitiveArray(data: unknown[]): data is Record<string, unknown>[] {
  if (data.length < 2) return false;

  const first = data[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return false;

  const keys = Object.keys(first as Record<string, unknown>)
    .sort()
    .join(',');

  return data.every((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const rec = item as Record<string, unknown>;
    if (Object.keys(rec).sort().join(',') !== keys) return false;
    return Object.values(rec).every(isPrimitiveOrIdArray);
  });
}

/**
 * Render a uniform array of same-shape primitive objects as a table
 */
function UniformArrayTable({
  data,
  classificationContext,
  onCorrection,
  onStructuralCorrection,
  extractionSchema,
  fieldPath,
}: {
  data: Record<string, unknown>[];
  classificationContext?: ClassificationContext;
  onCorrection?: (fieldPath: string, newValue: unknown) => void;
  onStructuralCorrection?: (
    fieldPath: string,
    mutation: 'remove' | 'add',
    value?: unknown
  ) => void;
  extractionSchema?: JsonSchema;
  fieldPath?: string;
}) {
  const columnKeys = Object.keys(data[0]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const itemSchema = useMemo(
    () => (fieldPath ? resolveItemSchemaForArrayPath(extractionSchema, fieldPath) : undefined),
    [extractionSchema, fieldPath]
  );
  const editable = !!onCorrection && !!fieldPath;
  const removable = !!onStructuralCorrection && !!fieldPath;

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => [
      ...columnKeys.map<ColumnDef<Record<string, unknown>>>((key) => ({
        accessorKey: key,
        header: formatSectionTitle(key),
        cell: ({ getValue, row }) => {
          const value = getValue();
          const cellPath = fieldPath ? `${fieldPath}[${row.index}].${key}` : undefined;
          if (BADGE_FIELDS.has(key) && typeof value === 'string') {
            return (
              <Badge variant="outline" className="text-xs">
                {humanizeValue(value)}
              </Badge>
            );
          }
          if (
            classificationContext &&
            typeof value === 'string' &&
            ['category', 'type', 'classification'].includes(key)
          ) {
            const match = findClassificationMatch(row.original, classificationContext);
            if (match) {
              return (
                <Badge
                  variant="outline"
                  className="text-xs gap-1 font-mono"
                  style={{ borderColor: match.color, color: match.color }}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: match.color }}
                  />
                  {value}
                  <span className="font-sans text-muted-foreground">
                    ({match.count}/{match.total})
                  </span>
                  {match.trend && (
                    <span className={TREND_DISPLAY[match.trend].className}>
                      {TREND_DISPLAY[match.trend].arrow}
                    </span>
                  )}
                </Badge>
              );
            }
          }
          // Inline-editable cell when the watcher is editable and the value
          // is a primitive — uses the same EditablePrimitive as the
          // auto-renderer so corrections, "edited" badges, and pending
          // overlays all light up in the table view.
          if (
            onCorrection &&
            cellPath &&
            (value === null ||
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean')
          ) {
            return (
              <EditablePrimitive value={value} fieldPath={cellPath} onCorrection={onCorrection} />
            );
          }
          return renderPrimitive(value);
        },
      })),
      ...(editable || removable
        ? [
            {
              id: '__row_actions',
              header: () => null,
              cell: ({ row }) => {
                const rowPath = fieldPath ? `${fieldPath}[${row.index}]` : undefined;
                return (
                  <div className="flex items-center justify-end gap-0.5">
                    {editable && rowPath ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        title="Edit this row with the schema form"
                        onClick={() => setEditingIndex(row.index)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {removable && rowPath ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        title="Mark this row for removal"
                        onClick={() => onStructuralCorrection?.(rowPath, 'remove')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                );
              },
            } as ColumnDef<Record<string, unknown>>,
          ]
        : []),
    ],
    [columnKeys, classificationContext, onCorrection, onStructuralCorrection, fieldPath, editable, removable]
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-2">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {editingIndex !== null && fieldPath && onCorrection ? (
        <SchemaItemForm
          schema={itemSchema}
          initialData={data[editingIndex]}
          submitLabel="Stage edit"
          description={
            <>
              Edit row {editingIndex + 1}. Submitting stages a single{' '}
              <span className="font-mono">set</span> correction at{' '}
              <span className="font-mono">
                {fieldPath}[{editingIndex}]
              </span>
              .
            </>
          }
          onSubmit={(value) => {
            onCorrection(`${fieldPath}[${editingIndex}]`, value);
            setEditingIndex(null);
          }}
          onCancel={() => setEditingIndex(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Main JSON Renderer component
 */
export function JsonRenderer({
  data,
  depth = 0,
  className,
  classificationContext,
  showSectionSidebar = false,
  parentKey,
  idReferences,
  onCorrection,
  onStructuralCorrection,
  extractionSchema,
  fieldPath,
}: JsonRendererProps) {
  if (data === null || data === undefined) {
    return <span className="text-muted-foreground italic">No data</span>;
  }

  const getStableKey = (item: unknown, fallback: string) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const candidate = record.id ?? record.slug ?? record.name ?? record.title;
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        return String(candidate);
      }
      try {
        return JSON.stringify(item);
      } catch {
        return fallback;
      }
    }
    return String(item);
  };

  // Handle arrays
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-muted-foreground italic">Empty list</span>;
    }

    // Check if it's an array of primitive values
    if (data.every((item) => typeof item !== 'object' || item === null)) {
      const numericIds =
        parentKey && isIdentifierListKey(parentKey) && data.every((item) => isIdentifierLike(item))
          ? data
              .map((item) => (typeof item === 'number' ? item : Number.parseInt(String(item), 10)))
              .filter((id) => Number.isFinite(id))
          : [];

      if (numericIds.length > 0) {
        const resolved = numericIds
          .map((id) => (idReferences ? idReferences[id] : undefined))
          .filter((ref): ref is IdReferenceItem => !!ref);
        const unresolvedCount = numericIds.length - resolved.length;

        if (resolved.length > 0) {
          return (
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">
                {numericIds.length.toLocaleString()} {formatIdentifierListLabel(parentKey ?? 'ids')}
              </div>
              <div className="space-y-1.5">
                {resolved.map((ref) => (
                  <div key={ref.id} className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
                    {ref.url ? (
                      <a
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary hover:underline"
                      >
                        {ref.title || 'Open source item'}
                      </a>
                    ) : (
                      <span className="font-medium">{ref.title || 'Source item'}</span>
                    )}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[ref.platform, ref.author].filter(Boolean).join(' \u00b7 ')}
                    </div>
                  </div>
                ))}
              </div>
              {unresolvedCount > 0 && (
                <div className="text-xs text-muted-foreground">
                  {unresolvedCount.toLocaleString()} reference
                  {unresolvedCount === 1 ? '' : 's'} could not be resolved.
                </div>
              )}
            </div>
          );
        }
      }

      if (
        parentKey &&
        isIdentifierListKey(parentKey) &&
        data.length > 0 &&
        data.every((item) => isIdentifierLike(item))
      ) {
        return (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="font-medium">{data.length.toLocaleString()}</span>{' '}
            <span className="text-muted-foreground">{formatIdentifierListLabel(parentKey)}</span>
          </div>
        );
      }

      // Long string arrays → bullet list
      if (isLongStringArray(data)) {
        return (
          <ul className="list-disc list-inside space-y-1 text-sm">
            {data.map((item, i) => (
              <li key={getStableKey(item, `value-${depth}-${i}`)}>{String(item)}</li>
            ))}
          </ul>
        );
      }

      return (
        <div className="flex flex-wrap gap-1.5">
          {data.map((item, i) => (
            <Badge
              key={getStableKey(item, `value-${depth}-${i}`)}
              variant="secondary"
              className="text-xs"
            >
              {String(item)}
            </Badge>
          ))}
        </div>
      );
    }

    // Uniform array of same-shape primitive objects → render as table
    if (isUniformPrimitiveArray(data)) {
      return (
        <div className="space-y-2">
          <UniformArrayTable
            data={data}
            classificationContext={classificationContext}
            onCorrection={onCorrection}
            onStructuralCorrection={onStructuralCorrection}
            extractionSchema={extractionSchema}
            fieldPath={fieldPath}
          />
          {onStructuralCorrection && fieldPath ? (
            <AddItemForm
              arrayPath={fieldPath}
              templateItem={data[0]}
              itemSchema={resolveItemSchemaForArrayPath(extractionSchema, fieldPath)}
              onAdd={(value) => onStructuralCorrection(`${fieldPath}[]`, 'add', value)}
            />
          ) : null}
        </div>
      );
    }

    // Array of objects
    return (
      <div className={cn('space-y-3', className)}>
        {data.map((item, i) => {
          const key = getStableKey(item, `item-${depth}-${i}`);
          const childPath = fieldPath ? `${fieldPath}[${i}]` : `[${i}]`;
          if (
            typeof item === 'object' &&
            item !== null &&
            isItemLike(item as Record<string, unknown>)
          ) {
            return (
              <ItemCard
                key={key}
                item={item as Record<string, unknown>}
                depth={depth}
                classificationContext={classificationContext}
                idReferences={idReferences}
                onCorrection={onCorrection}
                onStructuralCorrection={onStructuralCorrection}
                extractionSchema={extractionSchema}
                fieldPath={childPath}
              />
            );
          }
          return (
            <Card key={key} className="p-3">
              <JsonRenderer
                data={item}
                depth={depth + 1}
                classificationContext={classificationContext}
                parentKey={parentKey}
                idReferences={idReferences}
                onCorrection={onCorrection}
                onStructuralCorrection={onStructuralCorrection}
                extractionSchema={extractionSchema}
                fieldPath={childPath}
              />
            </Card>
          );
        })}
        {onStructuralCorrection && fieldPath ? (
          <AddItemForm
            arrayPath={fieldPath}
            templateItem={data[0]}
            itemSchema={resolveItemSchemaForArrayPath(extractionSchema, fieldPath)}
            onAdd={(value) => onStructuralCorrection(`${fieldPath}[]`, 'add', value)}
          />
        ) : null}
      </div>
    );
  }

  // Handle objects
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);

    if (entries.length === 0) {
      return <span className="text-muted-foreground italic">Empty</span>;
    }

    // Top-level object fallback: add a sticky section navigator for long structured outputs.
    if (depth === 0 && showSectionSidebar && entries.length > 1) {
      const sections = entries.map(([key], index) => ({
        key,
        id: sectionIdFromKey(key, index),
      }));
      const distributionEntries = classificationContext
        ? Object.entries(classificationContext.stats).filter(([, values]) => {
            const total = Object.values(values).reduce((sum, count) => sum + count, 0);
            return total > 0;
          })
        : [];

      return (
        <div className={cn('grid gap-4 lg:grid-cols-[220px_1fr]', className)}>
          <aside className="hidden lg:block">
            <div className="sticky top-20 space-y-3">
              {distributionEntries.length > 0 && (
                <div className="rounded-lg border bg-card/50 p-2">
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Distribution
                  </p>
                  <div className="space-y-2">
                    {distributionEntries.slice(0, 3).map(([classifierSlug, values]) => (
                      <DistributionMiniChart
                        key={classifierSlug}
                        classifierSlug={classifierSlug}
                        values={values}
                        colors={classificationContext?.colors ?? {}}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-lg border bg-card/50 p-2">
                <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Sections
                </p>
                <nav className="space-y-1">
                  {sections.map((section) => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {formatSectionTitle(section.key)}
                    </a>
                  ))}
                </nav>
              </div>
            </div>
          </aside>

          <div className="space-y-6">
            {entries.map(([key, value], index) => {
              const sectionId = sectionIdFromKey(key, index);
              const childPath = fieldPath ? `${fieldPath}.${key}` : key;
              const hideHeading =
                key.toLowerCase() === 'summary' &&
                (typeof value === 'string' ||
                  typeof value === 'number' ||
                  typeof value === 'boolean');
              return (
                <section key={key} id={sectionId} className="scroll-mt-24">
                  {!hideHeading && (
                    <h3 className="mb-3 text-base font-semibold text-foreground">
                      {formatSectionTitle(key)}
                    </h3>
                  )}
                  <JsonRenderer
                    data={value}
                    depth={depth + 1}
                    classificationContext={classificationContext}
                    parentKey={key}
                    idReferences={idReferences}
                    onCorrection={onCorrection}
                    onStructuralCorrection={onStructuralCorrection}
                    extractionSchema={extractionSchema}
                    fieldPath={childPath}
                  />
                </section>
              );
            })}
          </div>
        </div>
      );
    }

    // If it's a shallow object with item-like structure, render as ItemCard
    if (depth > 0 && isItemLike(data as Record<string, unknown>)) {
      return (
        <ItemCard
          item={data as Record<string, unknown>}
          depth={depth}
          classificationContext={classificationContext}
          idReferences={idReferences}
          onCorrection={onCorrection}
          onStructuralCorrection={onStructuralCorrection}
          extractionSchema={extractionSchema}
          fieldPath={fieldPath}
        />
      );
    }

    // Shallow objects (all primitive values) render as a compact grid
    const allPrimitive =
      depth > 0 &&
      entries.length > 1 &&
      entries.every(
        ([, v]) =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
      );

    if (allPrimitive) {
      return (
        <div
          className={cn(
            'grid gap-3',
            entries.length <= 3
              ? 'grid-cols-2 sm:grid-cols-3'
              : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
            className
          )}
        >
          {entries.map(([key, value]) => {
            const childPath = fieldPath ? `${fieldPath}.${key}` : key;
            return (
              <div key={key} className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs text-muted-foreground">{formatSectionTitle(key)}</div>
                <div className="mt-0.5 font-medium text-sm">
                  {onCorrection ? (
                    <EditablePrimitive
                      value={value}
                      fieldPath={childPath}
                      onCorrection={onCorrection}
                    />
                  ) : (
                    renderPrimitive(value)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className={cn('space-y-4', className)}>
        {entries.map(([key, value]) => {
          const childPath = fieldPath ? `${fieldPath}.${key}` : key;
          const hideHeading =
            key.toLowerCase() === 'summary' &&
            (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');

          return (
            <div key={key}>
              {!hideHeading && (
                <h4 className="mb-2 text-sm font-semibold text-foreground">
                  {formatSectionTitle(key)}
                </h4>
              )}
              <div className="pl-0">
                <JsonRenderer
                  data={value}
                  depth={depth + 1}
                  classificationContext={classificationContext}
                  parentKey={key}
                  idReferences={idReferences}
                  onCorrection={onCorrection}
                  onStructuralCorrection={onStructuralCorrection}
                  extractionSchema={extractionSchema}
                  fieldPath={childPath}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Handle primitives
  if (onCorrection && fieldPath) {
    return <EditablePrimitive value={data} fieldPath={fieldPath} onCorrection={onCorrection} />;
  }
  return renderPrimitive(data);
}

/**
 * "Add item" form rendered below an array of objects. When the watcher's
 * extraction schema knows the item shape, it renders a JSONForms-driven
 * typed form. Otherwise it falls back to a JSON textarea (with the first
 * existing item used as a shape hint) so the operator can still propose
 * an item.
 */
function AddItemForm({
  arrayPath,
  templateItem,
  itemSchema,
  onAdd,
}: {
  arrayPath: string;
  templateItem: unknown;
  itemSchema?: JsonSchema;
  onAdd: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);

  const skeleton = useMemo(() => {
    if (templateItem && typeof templateItem === 'object' && !Array.isArray(templateItem)) {
      const blanked: Record<string, unknown> = {};
      for (const k of Object.keys(templateItem as Record<string, unknown>)) {
        blanked[k] = '';
      }
      return blanked;
    }
    return {};
  }, [templateItem]);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-xs gap-1"
        onClick={() => setOpen(true)}
      >
        + Suggest a new item for {arrayPath}
      </Button>
    );
  }

  return (
    <SchemaItemForm
      schema={itemSchema}
      initialData={skeleton}
      submitLabel="Stage add"
      description={
        <>
          Suggest a new entry for <span className="font-mono">{arrayPath}</span>.{' '}
          {itemSchema
            ? "Fields come from this watcher's extraction schema."
            : 'Keys come from existing items — fill values, then submit.'}
        </>
      }
      onSubmit={(value) => {
        onAdd(value);
        setOpen(false);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}
