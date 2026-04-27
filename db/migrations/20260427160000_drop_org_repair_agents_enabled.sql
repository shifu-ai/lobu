-- migrate:up

-- Drop the per-org repair-agent kill switch. The per-connector default
-- agent + per-feed override already provide a complete disable surface
-- (clearing the connector default disables auto-repair for everything
-- under it), so the org-level toggle was a redundant escape hatch with
-- no unique effect.
ALTER TABLE public.organization DROP COLUMN IF EXISTS repair_agents_enabled;

-- migrate:down

ALTER TABLE public.organization
  ADD COLUMN repair_agents_enabled boolean NOT NULL DEFAULT TRUE;
