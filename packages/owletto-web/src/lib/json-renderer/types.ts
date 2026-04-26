import { z } from 'zod';

// Define the node types first
export type TextNode = {
  type: 'text';
  content: string;
};

export type DataBinding = {
  type: 'data';
  path: string;
  fallback?: unknown;
};

export type ComponentType =
  | 'card'
  | 'card-header'
  | 'card-title'
  | 'card-description'
  | 'card-content'
  | 'badge'
  | 'button'
  | 'alert'
  | 'alert-title'
  | 'alert-description'
  | 'progress'
  | 'separator'
  | 'markdown'
  | 'div'
  | 'span'
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'ul'
  | 'ol'
  | 'li'
  | 'table'
  | 'thead'
  | 'tbody'
  | 'tr'
  | 'th'
  | 'td';

export type ComponentNode = {
  type: ComponentType;
  props?: Record<string, unknown>;
  children?: JsonNode[];
};

export type ConditionalNode = {
  type: 'if';
  condition: string;
  then: JsonNode;
  else?: JsonNode;
};

export type LoopNode = {
  type: 'each';
  items: string;
  as: string;
  render: JsonNode | string; // String shorthand: "- {{var}}" interpolated per item
};

export type JsonNode = TextNode | ComponentNode | DataBinding | ConditionalNode | LoopNode;

export type JsonTemplate = {
  version: 1;
  root: JsonNode;
};

// Zod schemas for runtime validation
export const textNodeSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
});

export const dataBindingSchema = z.object({
  type: z.literal('data'),
  path: z.string(),
  fallback: z.unknown().optional(),
});

export const componentTypeSchema = z.enum([
  'card',
  'card-header',
  'card-title',
  'card-description',
  'card-content',
  'badge',
  'button',
  'alert',
  'alert-title',
  'alert-description',
  'progress',
  'separator',
  'markdown',
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

// Use z.lazy for recursive schemas
export const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z.union([
    textNodeSchema,
    dataBindingSchema,
    z.object({
      type: componentTypeSchema,
      props: z.record(z.unknown()).optional(),
      children: z.array(jsonNodeSchema).optional(),
    }),
    z.object({
      type: z.literal('if'),
      condition: z.string(),
      // biome-ignore lint/suspicious/noThenProperty: schema uses "then" to model conditional templates.
      then: jsonNodeSchema,
      else: jsonNodeSchema.optional(),
    }),
    z.object({
      type: z.literal('each'),
      items: z.string(),
      as: z.string(),
      render: z.union([jsonNodeSchema, z.string()]),
    }),
  ])
);

export const jsonTemplateSchema = z.object({
  version: z.literal(1),
  root: jsonNodeSchema,
});

// Renderer context
export interface RenderContext {
  data: Record<string, unknown>;
  actions?: Record<string, (...args: unknown[]) => void>;
  /**
   * If set, leaf data bindings render as editable primitives that emit
   * corrections keyed by the binding's path.
   */
  onCorrection?: (fieldPath: string, newValue: unknown) => void;
}
