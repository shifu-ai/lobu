-- migrate:up

-- Normalize watcher feedback to one row per corrected field.
--
-- The original `watcher_window_feedback` stored every correction batch as a
-- single JSONB blob (`corrections`) with one shared `notes` column. That
-- shape blocks per-field notes, makes "latest correction per field" a JSONB
-- aggregation, and lets duplicate submissions for the same field accumulate
-- forever (the prompt summary then injects every historical version).
--
-- New table is per-field with explicit mutation kind so structural edits
-- (remove an array item, append a new one) live alongside value corrections
-- without overloading the value column. Existing rows are migrated by
-- expanding the JSONB map into one row per key.

CREATE TABLE IF NOT EXISTS public.watcher_window_field_feedback (
    id bigserial PRIMARY KEY,
    window_id integer NOT NULL REFERENCES public.watcher_windows(id) ON DELETE CASCADE,
    watcher_id integer NOT NULL REFERENCES public.watchers(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    field_path text NOT NULL,
    mutation text NOT NULL DEFAULT 'set'
        CHECK (mutation IN ('set', 'remove', 'add')),
    corrected_value jsonb,
    note text,
    created_by text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wwff_watcher_field_recent
    ON public.watcher_window_field_feedback (watcher_id, field_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wwff_window
    ON public.watcher_window_field_feedback (window_id);

INSERT INTO public.watcher_window_field_feedback (
    window_id, watcher_id, organization_id,
    field_path, mutation, corrected_value, note,
    created_by, created_at
)
SELECT
    f.window_id,
    f.watcher_id,
    f.organization_id,
    kv.key AS field_path,
    'set' AS mutation,
    kv.value AS corrected_value,
    f.notes AS note,
    f.created_by,
    f.created_at
FROM public.watcher_window_feedback f,
     LATERAL jsonb_each(f.corrections) AS kv;

DROP TABLE IF EXISTS public.watcher_window_feedback;

-- migrate:down

CREATE TABLE IF NOT EXISTS public.watcher_window_feedback (
    id bigserial PRIMARY KEY,
    window_id integer NOT NULL REFERENCES public.watcher_windows(id) ON DELETE CASCADE,
    watcher_id integer NOT NULL REFERENCES public.watchers(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    corrections jsonb NOT NULL,
    notes text,
    created_by text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wwf_window ON public.watcher_window_feedback(window_id);
CREATE INDEX IF NOT EXISTS idx_wwf_watcher ON public.watcher_window_feedback(watcher_id);

-- Best-effort rollback: structural mutations ('add' / 'remove') don't fit
-- the old shape and are dropped (WHERE mutation = 'set'). When multiple
-- contributors edited the same window, MAX(note) and MAX(created_by) pick
-- one arbitrarily — this is an emergency recovery path, not a clean inverse.
INSERT INTO public.watcher_window_feedback (
    window_id, watcher_id, organization_id,
    corrections, notes, created_by, created_at
)
SELECT
    window_id,
    watcher_id,
    organization_id,
    jsonb_object_agg(field_path, COALESCE(corrected_value, 'null'::jsonb)) AS corrections,
    MAX(note) AS notes,
    MAX(created_by) AS created_by,
    MAX(created_at) AS created_at
FROM public.watcher_window_field_feedback
WHERE mutation = 'set'
GROUP BY window_id, watcher_id, organization_id;

DROP TABLE IF EXISTS public.watcher_window_field_feedback;
