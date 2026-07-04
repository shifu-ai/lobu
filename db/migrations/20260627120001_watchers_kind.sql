-- migrate:up

-- watchers.kind: distinguishes knowledge-extraction (default) from
-- agent-driven digest watchers. Dispatch branches on this to decide whether
-- to run the standard read_knowledge/complete_window extraction loop or an
-- agent-driven digest instead (see packages/server/src/watchers/automation.ts).
ALTER TABLE public.watchers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'knowledge';

COMMENT ON COLUMN public.watchers.kind IS 'knowledge (default, extraction pipeline) | digest (agent-driven digest run).';

-- migrate:down

ALTER TABLE public.watchers DROP COLUMN IF EXISTS kind;
