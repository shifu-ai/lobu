-- migrate:up

-- The schema-mirror feature lets a template agent (e.g. examples/personal-finance)
-- own a canonical set of entity types, relationship types, classifiers and
-- watcher definitions in its template org and mirror them into each user's
-- personal org when they install the agent. The two new columns record the
-- provenance of mirrored rows so they can be re-synced on template updates and
-- treated as read-only by the user-org owner.
--
-- managed_by_template_agent_id: the agents.id (in the template org) that owns
--   this row. NULL for rows authored by the user themselves.
-- source_template_org_id: the organization.id of the template org. Pairs with
--   the agent_id so a user can re-sync against the right source even if the
--   template agent is later renamed.

ALTER TABLE public.entity_types
    ADD COLUMN managed_by_template_agent_id text,
    ADD COLUMN source_template_org_id text;

ALTER TABLE public.entity_relationship_types
    ADD COLUMN managed_by_template_agent_id text,
    ADD COLUMN source_template_org_id text;

ALTER TABLE public.event_classifiers
    ADD COLUMN managed_by_template_agent_id text,
    ADD COLUMN source_template_org_id text;

ALTER TABLE public.watchers
    ADD COLUMN managed_by_template_agent_id text,
    ADD COLUMN source_template_org_id text;

CREATE INDEX idx_entity_types_managed_by_template
    ON public.entity_types (managed_by_template_agent_id)
    WHERE managed_by_template_agent_id IS NOT NULL;

CREATE INDEX idx_entity_relationship_types_managed_by_template
    ON public.entity_relationship_types (managed_by_template_agent_id)
    WHERE managed_by_template_agent_id IS NOT NULL;

CREATE INDEX idx_event_classifiers_managed_by_template
    ON public.event_classifiers (managed_by_template_agent_id)
    WHERE managed_by_template_agent_id IS NOT NULL;

CREATE INDEX idx_watchers_managed_by_template
    ON public.watchers (managed_by_template_agent_id)
    WHERE managed_by_template_agent_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.idx_watchers_managed_by_template;
DROP INDEX IF EXISTS public.idx_event_classifiers_managed_by_template;
DROP INDEX IF EXISTS public.idx_entity_relationship_types_managed_by_template;
DROP INDEX IF EXISTS public.idx_entity_types_managed_by_template;

ALTER TABLE public.watchers
    DROP COLUMN IF EXISTS source_template_org_id,
    DROP COLUMN IF EXISTS managed_by_template_agent_id;

ALTER TABLE public.event_classifiers
    DROP COLUMN IF EXISTS source_template_org_id,
    DROP COLUMN IF EXISTS managed_by_template_agent_id;

ALTER TABLE public.entity_relationship_types
    DROP COLUMN IF EXISTS source_template_org_id,
    DROP COLUMN IF EXISTS managed_by_template_agent_id;

ALTER TABLE public.entity_types
    DROP COLUMN IF EXISTS source_template_org_id,
    DROP COLUMN IF EXISTS managed_by_template_agent_id;
