-- migrate:up

-- Persist agent guardrails to PG. Today they're loaded only from lobu.toml via
-- file-loader.ts:447 → AgentSettings.guardrails (in-memory). Postgres-driven
-- agents (UI-created) silently drop the field because no column existed.
-- Adding a dedicated column keeps the AgentSettings interface stable
-- (top-level `guardrails: string[]`) without overloading tools_config jsonb.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS guardrails text[] NOT NULL DEFAULT '{}';

-- migrate:down

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS guardrails;
