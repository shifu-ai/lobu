-- migrate:up

-- Per-org skill rows. Today skills are bundled-only in @lobu/cli and
-- referenced by ID in agents.skills_config jsonb. A dedicated table lets
-- hosted lobu.ai serve different skill sets per org without a binary release,
-- and lets templates ship custom skill content via lobu seed.
--
-- bundled_version tracks which @lobu/cli release a "bundled:*" skill was
-- copied from, so re-installing a newer version overwrites cleanly.
-- uploaded/template-sourced skills set source accordingly and leave
-- bundled_version NULL.

CREATE TABLE public.skills (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  slug text NOT NULL,
  content text NOT NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text,
  bundled_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX skills_org_id_idx ON public.skills (org_id);

-- migrate:down

DROP TABLE IF EXISTS public.skills;
