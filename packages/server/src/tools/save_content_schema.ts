import { type Static, Type } from '@sinclair/typebox';

export const SaveContentSchema = Type.Object({
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Entity IDs to associate content with. Omit for org-scoped content.',
    })
  ),
  content: Type.Optional(
    Type.String({
      description: 'The text content to save. Required for text/markdown payload types.',
    })
  ),
  title: Type.Optional(Type.String({ description: 'Short title or summary' })),
  author: Type.Optional(Type.String({ description: 'Author name or identifier' })),
  semantic_type: Type.Optional(
    Type.String({
      description:
        'Semantic type (e.g. note, summary, decision, identity, observation). Preferred.',
    })
  ),
  payload_type: Type.Optional(
    Type.Union(
      [
        Type.Literal('text'),
        Type.Literal('markdown'),
        Type.Literal('json_template'),
        Type.Literal('media'),
        Type.Literal('empty'),
      ],
      {
        description:
          "Content format. 'text' (default): plain text. 'markdown': rendered as rich text. 'json_template': rendered via payload_template + payload_data. 'media': media-focused display. 'empty': metadata only.",
      }
    )
  ),
  payload_data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Structured data object. Used as template data for json_template, or structured metadata for media.',
    })
  ),
  payload_template: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'JSON template for rendering. Required when payload_type is json_template. Must have a { root: ... } structure.',
    })
  ),
  attachments: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Any()), {
      description: 'Array of attachment objects (e.g. files, images).',
    })
  ),
  source_url: Type.Optional(
    Type.String({ description: 'URL of the original source for this content.' })
  ),
  occurred_at: Type.Optional(
    Type.String({
      description: 'When the event actually happened (ISO 8601). Defaults to now if omitted.',
    })
  ),
  metadata: Type.Record(Type.String(), Type.Any(), {
    description:
      'Structured metadata — validated against the entity type schema or semantic_type schema',
  }),
  supersedes_event_id: Type.Optional(
    Type.Number({
      description:
        'ID of an existing event this content replaces (e.g. updated preference, corrected fact). The old event is marked as superseded and excluded from future searches.',
    })
  ),
  watcher_source: Type.Optional(
    Type.Object(
      {
        watcher_id: Type.Number({ description: 'Watcher that triggered this save' }),
        window_id: Type.Number({ description: 'Window that triggered this save' }),
      },
      { description: 'Attribution source when save is triggered by a watcher reaction' }
    )
  ),
});

export type SaveContentArgs = Static<typeof SaveContentSchema>;
