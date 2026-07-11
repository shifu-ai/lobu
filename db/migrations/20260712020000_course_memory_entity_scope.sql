-- migrate:up

-- Deploy order: apply this backfill/index migration before rolling out the
-- array-only course memory retrieval code. New context-pack writes already
-- populate course_entity_ids, so no singular runtime fallback is required.

UPDATE public.events
SET metadata = jsonb_set(metadata, '{course_entity_ids}', jsonb_build_array(metadata->'course_entity_id'), true)
WHERE jsonb_typeof(metadata->'course_entity_ids') IS NULL
  AND jsonb_typeof(metadata->'course_entity_id') = 'string'
  AND metadata->>'course_entity_id' ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$';

CREATE INDEX IF NOT EXISTS events_course_entity_ids_gin_idx
  ON public.events USING gin ((metadata->'course_entity_ids'));

-- migrate:down

DROP INDEX IF EXISTS public.events_course_entity_ids_gin_idx;
