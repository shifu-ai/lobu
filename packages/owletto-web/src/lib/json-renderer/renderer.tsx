import type { ReactNode } from 'react';
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { EditablePrimitive } from '../editable-field/editable-primitive';
import { AreaChart, BarChart, LineChart, PieChart, Sparkline, StackedAreaChart } from './charts';
import type {
  ComponentNode,
  ConditionalNode,
  DataBinding,
  JsonNode,
  LoopNode,
  RenderContext,
  TextNode,
} from './types';

// Map arbitrary object arrays to the {label, value} shape expected by bar/line/area charts.
function normalizeLabelValueData(
  data: unknown,
  labelField?: string,
  valueField?: string
): Array<{ label: string; value: number }> {
  const arr = data as Array<Record<string, unknown>>;
  if (!Array.isArray(arr)) return [];
  if (!labelField && !valueField) return arr as Array<{ label: string; value: number }>;
  return arr.map((d) => ({
    label: String(d[labelField ?? 'label'] ?? ''),
    value: Number(d[valueField ?? 'value'] ?? 0),
  }));
}

// Map arbitrary object arrays to the {name, value} shape expected by pie charts.
function normalizeNameValueData(
  data: unknown,
  nameField?: string,
  valueField?: string
): Array<{ name: string; value: number; itemStyle?: { color?: string } }> {
  const arr = data as Array<Record<string, unknown>>;
  if (!Array.isArray(arr)) return [];
  if (!nameField && !valueField)
    return arr as Array<{ name: string; value: number; itemStyle?: { color?: string } }>;
  return arr.map((d) => ({
    name: String(d[nameField ?? 'name'] ?? ''),
    value: Number(d[valueField ?? 'value'] ?? 0),
  }));
}

// Simple component registry - maps JSON types to React components
const componentRegistry: Record<
  string,
  React.ComponentType<{ children?: React.ReactNode; className?: string; [key: string]: unknown }>
> = {
  // Basic HTML elements
  div: ({ children, ...props }) => <div {...props}>{children}</div>,
  span: ({ children, ...props }) => <span {...props}>{children}</span>,
  p: ({ children, ...props }) => <p {...props}>{children}</p>,
  h1: ({ children, ...props }) => <h1 {...props}>{children}</h1>,
  h2: ({ children, ...props }) => <h2 {...props}>{children}</h2>,
  h3: ({ children, ...props }) => <h3 {...props}>{children}</h3>,
  h4: ({ children, ...props }) => <h4 {...props}>{children}</h4>,
  ul: ({ children, ...props }) => <ul {...props}>{children}</ul>,
  ol: ({ children, ...props }) => <ol {...props}>{children}</ol>,
  li: ({ children, ...props }) => <li {...props}>{children}</li>,
  table: ({ children, ...props }) => <table {...props}>{children}</table>,
  thead: ({ children, ...props }) => <thead {...props}>{children}</thead>,
  tbody: ({ children, ...props }) => <tbody {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => <tr {...props}>{children}</tr>,
  th: ({ children, ...props }) => <th {...props}>{children}</th>,
  td: ({ children, ...props }) => <td {...props}>{children}</td>,

  // Card components (shadcn-style)
  card: ({ children, className, ...props }) => (
    <div
      className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className || ''}`}
      {...props}
    >
      {children}
    </div>
  ),
  'card-header': ({ children, className, ...props }) => (
    <div className={`flex flex-col space-y-1.5 p-6 ${className || ''}`} {...props}>
      {children}
    </div>
  ),
  'card-title': ({ children, className, ...props }) => (
    <h3
      className={`text-2xl font-semibold leading-none tracking-tight ${className || ''}`}
      {...props}
    >
      {children}
    </h3>
  ),
  'card-description': ({ children, className, ...props }) => (
    <p className={`text-sm text-muted-foreground ${className || ''}`} {...props}>
      {children}
    </p>
  ),
  'card-content': ({ children, className, ...props }) => (
    <div className={`p-6 pt-0 ${className || ''}`} {...props}>
      {children}
    </div>
  ),

  // Badge component
  badge: ({ children, className, variant = 'default', ...props }) => {
    const variants: Record<string, string> = {
      default: 'bg-primary text-primary-foreground',
      secondary: 'bg-secondary text-secondary-foreground',
      destructive: 'bg-destructive text-destructive-foreground',
      outline: 'border border-input bg-background',
    };
    // Humanize snake_case/kebab-case enum values in children
    const humanize = (v: unknown): ReactNode => {
      if (typeof v === 'string') {
        return v.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
        return v;
      }
      if (React.isValidElement(v)) {
        return v;
      }
      if (Array.isArray(v)) {
        return v.map(humanize);
      }
      return String(v);
    };
    const humanized = humanize(children);
    return (
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant as string] || variants.default} ${className || ''}`}
        {...props}
      >
        {humanized}
      </span>
    );
  },

  // Button component
  button: ({ children, className, variant = 'default', type = 'button', ...props }) => {
    const variants: Record<string, string> = {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
      ghost: 'hover:bg-accent hover:text-accent-foreground',
    };
    return (
      <button
        type={type as 'button' | 'submit' | 'reset'}
        className={`inline-flex items-center justify-center rounded-md text-sm font-medium h-10 px-4 py-2 ${variants[variant as string] || variants.default} ${className || ''}`}
        {...props}
      >
        {children}
      </button>
    );
  },

  // Alert component
  alert: ({ children, className, variant = 'default', ...props }) => {
    const variants: Record<string, string> = {
      default: 'bg-background text-foreground',
      destructive: 'border-destructive/50 text-destructive dark:border-destructive',
    };
    return (
      <div
        role="alert"
        className={`relative w-full rounded-lg border p-4 ${variants[variant as string] || variants.default} ${className || ''}`}
        {...props}
      >
        {children}
      </div>
    );
  },
  'alert-title': ({ children, className, ...props }) => (
    <h5 className={`mb-1 font-medium leading-none tracking-tight ${className || ''}`} {...props}>
      {children}
    </h5>
  ),
  'alert-description': ({ children, className, ...props }) => (
    <div className={`text-sm [&_p]:leading-relaxed ${className || ''}`} {...props}>
      {children}
    </div>
  ),

  // Progress component
  progress: ({ className, value = 0, label, ...props }) => {
    const pct = Math.round(value as number);
    return (
      <div className={`flex items-center gap-2 ${className || ''}`} {...props}>
        <div className="relative h-4 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full w-full flex-1 bg-primary transition-all"
            style={{ transform: `translateX(-${100 - pct}%)` }}
          />
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground shrink-0">
          {label ? String(label) : `${pct}%`}
        </span>
      </div>
    );
  },

  // Separator
  separator: ({ className, ...props }) => (
    <div className={`shrink-0 bg-border h-[1px] w-full ${className || ''}`} {...props} />
  ),

  // Markdown component
  markdown: ({ content, className }) => (
    <div className={`max-w-none text-sm space-y-2 ${className || ''}`}>
      <ReactMarkdown
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
        {String(content ?? '')}
      </ReactMarkdown>
    </div>
  ),

  // High-level layout / widget components used by watcher templates
  layout: ({ children, className, direction = 'vertical' }) => (
    <div
      className={`flex ${direction === 'horizontal' ? 'flex-row' : 'flex-col'} gap-4 ${className || ''}`}
    >
      {children}
    </div>
  ),

  columns: ({ children, className }) => {
    const count = Array.isArray(children)
      ? children.filter((c) => c != null).length
      : children
        ? 1
        : 0;
    return (
      <div
        className={`grid gap-4 ${className || ''}`}
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        {children}
      </div>
    );
  },

  metric: ({ label, value, className }) => (
    <div className={`rounded-lg border bg-card p-4 ${className || ''}`}>
      <p className="text-sm text-muted-foreground">{String(label ?? '')}</p>
      <p className="mt-1 text-2xl font-bold">{String(value ?? '')}</p>
    </div>
  ),

  // Chart components
  'bar-chart': ({ data, height, xLabel, yLabel, labelField, valueField }) => (
    <BarChart
      data={normalizeLabelValueData(data, labelField as string, valueField as string)}
      height={height as number}
      xLabel={xLabel as string}
      yLabel={yLabel as string}
    />
  ),
  'line-chart': ({ data, height, xLabel, yLabel, labelField, valueField }) => (
    <LineChart
      data={normalizeLabelValueData(data, labelField as string, valueField as string)}
      height={height as number}
      xLabel={xLabel as string}
      yLabel={yLabel as string}
    />
  ),
  'area-chart': ({ data, height, xLabel, yLabel, labelField, valueField }) => (
    <AreaChart
      data={normalizeLabelValueData(data, labelField as string, valueField as string)}
      height={height as number}
      xLabel={xLabel as string}
      yLabel={yLabel as string}
    />
  ),
  'pie-chart': ({
    data,
    height,
    showLabel,
    showLegend,
    radius,
    highlightName,
    nameField,
    valueField,
  }) => (
    <PieChart
      data={normalizeNameValueData(data, nameField as string, valueField as string)}
      height={height as number}
      showLabel={showLabel as boolean}
      showLegend={showLegend as boolean}
      radius={radius as string | [string, string]}
      highlightName={highlightName as string | null}
    />
  ),
  sparkline: ({ data, height, width, color, trend }) => (
    <Sparkline
      data={data as number[]}
      height={height as number}
      width={width as number}
      color={color as string}
      trend={trend as 'up' | 'down' | 'stable'}
    />
  ),
  'stacked-area-chart': ({
    data,
    series,
    height,
    xLabel,
    yLabel,
    onSeriesClick,
    onDateRangeSelect,
  }) => (
    <StackedAreaChart
      data={data as Array<Record<string, number | string>>}
      series={series as Array<{ key: string; name: string; color?: string }>}
      height={height as number}
      xLabel={xLabel as string}
      yLabel={yLabel as string}
      onSeriesClick={onSeriesClick as (seriesKey: string) => void}
      onDateRangeSelect={onDateRangeSelect as (start: string, end: string) => void}
    />
  ),
};

// ============================================
// Smart cell rendering for data-driven tables
// ============================================

const BADGE_FIELDS = new Set(['urgency', 'severity', 'sentiment', 'trend', 'status', 'priority']);

const URGENCY_STYLES: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-green-500/15 text-green-400 border-green-500/30',
};

function renderCellValue(col: string, value: unknown): React.ReactNode {
  if (value == null) return <span className="text-muted-foreground">–</span>;

  const str = String(value);

  // URL fields or values that look like URLs
  if (str.startsWith('http://') || str.startsWith('https://')) {
    return (
      <a
        href={str}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {col === 'url' ? '↗ Link' : str}
      </a>
    );
  }

  // Subreddit → link to reddit
  if (col === 'subreddit' && typeof value === 'string') {
    return (
      <a
        href={`https://reddit.com/r/${value}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        r/{value}
      </a>
    );
  }

  // Badge fields (urgency, severity, etc.)
  if (BADGE_FIELDS.has(col) && typeof value === 'string') {
    const style =
      URGENCY_STYLES[value.toLowerCase()] ?? 'bg-secondary text-secondary-foreground border-border';
    const humanized = value.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return (
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}
      >
        {humanized}
      </span>
    );
  }

  // Numbers
  if (typeof value === 'number') {
    return <span className="font-mono tabular-nums">{value}</span>;
  }

  // Booleans
  if (typeof value === 'boolean') {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${value ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-secondary text-secondary-foreground border-border'}`}
      >
        {value ? 'Yes' : 'No'}
      </span>
    );
  }

  return <span className="whitespace-pre-wrap">{str}</span>;
}

function DataTable({
  rows,
  columns: cols,
  title,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  title?: string;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  // Find extra fields not in columns (for the detail row)
  const allKeys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) allKeys.add(k);
  }
  const colSet = new Set(cols);
  const extraKeys = Array.from(allKeys).filter((k) => !colSet.has(k));
  const hasExtras = extraKeys.length > 0;

  return (
    <div className="space-y-2">
      {title && <h4 className="text-sm font-semibold">{title}</h4>}
      <div className="overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {cols.map((col) => (
                <th key={col} className="px-3 py-2 text-left font-medium capitalize">
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const isExpanded = expandedIndex === idx;
              const rowKey = cols.map((c) => row[c]).join('|') || String(idx);
              return (
                <React.Fragment key={rowKey}>
                  <tr
                    className={`border-b last:border-b-0 ${hasExtras ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''} ${isExpanded ? 'bg-muted/20' : ''}`}
                    onClick={
                      hasExtras ? () => setExpandedIndex(isExpanded ? null : idx) : undefined
                    }
                  >
                    {cols.map((col) => (
                      <td key={col} className="px-3 py-2">
                        {renderCellValue(col, row[col])}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr className="border-b last:border-b-0 bg-muted/10">
                      <td colSpan={cols.length} className="px-4 py-3">
                        <div className="space-y-2 text-sm">
                          {extraKeys.map((k) => {
                            const v = row[k];
                            if (v == null) return null;
                            return (
                              <div key={k}>
                                <span className="text-muted-foreground capitalize">
                                  {k.replace(/_/g, ' ')}:{' '}
                                </span>
                                {renderCellValue(k, v)}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Get value from nested object path (e.g., "user.name" or "items[0].title")
function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// Render a single JSON node
function renderNode(
  node: JsonNode,
  context: RenderContext,
  key?: string | number
): React.ReactNode {
  // Text node
  if (node.type === 'text') {
    return (node as TextNode).content;
  }

  // Data binding
  if (node.type === 'data') {
    const binding = node as DataBinding;
    const value = getValueByPath(context.data, binding.path);
    const resolved = value !== undefined ? value : binding.fallback;

    // Editable mode: leaf data bindings become click-to-edit primitives. The
    // template's binding path is the same path we expect on the server side
    // for `submit_feedback` corrections, so it can be used directly.
    if (context.onCorrection && resolved !== undefined && typeof resolved !== 'object') {
      return (
        <EditablePrimitive
          value={resolved}
          fieldPath={binding.path}
          onCorrection={context.onCorrection}
        />
      );
    }

    const str = resolved !== undefined ? String(resolved) : '';
    if (str.length > 100 && (str.includes('\n') || /[#*-]/.test(str))) {
      const MarkdownComponent = componentRegistry.markdown;
      return MarkdownComponent ? <MarkdownComponent content={str} /> : str;
    }
    return str;
  }

  // Conditional rendering
  if (node.type === 'if') {
    const conditional = node as ConditionalNode;
    const conditionValue = getValueByPath(context.data, conditional.condition);
    if (conditionValue) {
      return renderNode(conditional.then, context, key);
    } else if (conditional.else) {
      return renderNode(conditional.else, context, key);
    }
    return null;
  }

  // Loop/iteration
  if (node.type === 'each') {
    const loop = node as LoopNode;
    const items = getValueByPath(context.data, loop.items) as unknown[];
    if (!Array.isArray(items)) return null;

    return items.map((item, index) => {
      const loopAs = loop.as;
      const itemContext: RenderContext = {
        ...context,
        data: {
          ...context.data,
          [loopAs]: item,
          [`${loopAs}Index`]: index,
        },
      };
      // String shorthand: "- {{t}}" → replace loop variable with item value
      if (typeof loop.render === 'string') {
        const placeholder = `{{${loopAs}}}`;
        const value = typeof item === 'string' ? item : JSON.stringify(item);
        return loop.render.split(placeholder).join(value);
      }
      return renderNode(loop.render, itemContext, index);
    });
  }

  // Component node
  const componentNode = node as ComponentNode;
  const Component = componentRegistry[componentNode.type];

  if (!Component) {
    console.warn(`Unknown component type: ${componentNode.type}`);
    return null;
  }

  // Resolve a single prop value (data bindings, actions, or passthrough)
  const resolveProp = (propValue: unknown): unknown => {
    if (typeof propValue !== 'string') return propValue;
    if (propValue.startsWith('@')) {
      const actionName = propValue.slice(1);
      return context.actions?.[actionName];
    }
    // Pure binding: "{{path}}" → resolved value (preserves non-string types)
    if (
      propValue.startsWith('{{') &&
      propValue.endsWith('}}') &&
      propValue.indexOf('}}') === propValue.length - 2
    ) {
      const path = propValue.slice(2, -2).trim();
      return getValueByPath(context.data, path);
    }
    // Interpolated string: "{{a}}/100" → "42/100"
    if (propValue.includes('{{')) {
      return propValue.replace(/\{\{(.+?)\}\}/g, (_, path) => {
        const val = getValueByPath(context.data, path.trim());
        return val !== undefined ? String(val) : '';
      });
    }
    return propValue;
  };

  // Process props – merge top-level properties with explicit `props` object.
  // Top-level properties (except reserved keys) are picked up first, then the
  // explicit `props` bag overrides them.  This lets templates use a flat DSL
  // (e.g. {"type":"metric","label":"…","value":"…"}) while still supporting
  // the canonical {"type":"div","props":{…}} format.
  const processedProps: Record<string, unknown> = { key };
  const reservedKeys = new Set(['type', 'children', 'props', 'path', 'fallback']);

  for (const [propKey, propValue] of Object.entries(node as Record<string, unknown>)) {
    if (reservedKeys.has(propKey)) continue;
    processedProps[propKey] = resolveProp(propValue);
  }
  if (componentNode.props) {
    for (const [propKey, propValue] of Object.entries(componentNode.props)) {
      processedProps[propKey] = resolveProp(propValue);
    }
  }

  // Data-driven table: when a "table" node carries `data` (resolved to an
  // array) and `columns`, render a full table instead of delegating to the
  // basic HTML <table> wrapper.
  if (
    componentNode.type === 'table' &&
    Array.isArray(processedProps.data) &&
    Array.isArray(processedProps.columns)
  ) {
    const rows = processedProps.data as Record<string, unknown>[];
    const cols = processedProps.columns as string[];
    const title = processedProps.title as string | undefined;
    return <DataTable key={key} rows={rows} columns={cols} title={title} />;
  }

  // Render children
  const children = componentNode.children?.map((child: JsonNode, index: number) =>
    renderNode(child, context, index)
  );

  return <Component {...processedProps}>{children}</Component>;
}

// Main render function
export function renderJsonTemplate(
  template: { root: JsonNode },
  data: Record<string, unknown>,
  actions?: Record<string, (...args: unknown[]) => void>,
  onCorrection?: (fieldPath: string, newValue: unknown) => void
): React.ReactNode {
  const context: RenderContext = { data, actions, onCorrection };
  return renderNode(template.root, context);
}

// React component wrapper
interface JsonRendererProps {
  template: { root: JsonNode };
  data: Record<string, unknown>;
  actions?: Record<string, (...args: unknown[]) => void>;
  /**
   * When provided, leaf `data` bindings become click-to-edit primitives that
   * emit corrections keyed by the binding path. Wrap in
   * `<FieldFeedbackProvider>` to surface past/pending corrections inline.
   */
  onCorrection?: (fieldPath: string, newValue: unknown) => void;
}

export function JsonRenderer({
  template,
  data,
  actions,
  onCorrection,
}: JsonRendererProps): React.ReactElement {
  return <>{renderJsonTemplate(template, data, actions, onCorrection)}</>;
}
