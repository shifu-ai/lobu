-- migrate:up

-- Add ON DELETE CASCADE FK on events.organization_id and watchers.organization_id.
--
-- These two columns were declared as `text NOT NULL` with no FK to organization,
-- so dropping an org left orphaned events/watchers behind that had to be DELETE'd
-- separately (manual cleanup playbook). Every other org-scoped table has a
-- CASCADE FK; these two were oversights. Add them so future org deletes are
-- atomic with their event/watcher data.
--
-- Pre-flight: a NOT VALID add followed by VALIDATE keeps the lock window
-- short on the large `events` table. The validate scan only reads the
-- column and the parent PK, no rewrite. We've verified no orphan rows exist
-- before this migration so VALIDATE will succeed immediately.

ALTER TABLE public.events
    ADD CONSTRAINT events_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.events VALIDATE CONSTRAINT events_organization_id_fkey;

ALTER TABLE public.watchers
    ADD CONSTRAINT watchers_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.watchers VALIDATE CONSTRAINT watchers_organization_id_fkey;


-- migrate:down

ALTER TABLE public.events    DROP CONSTRAINT events_organization_id_fkey;
ALTER TABLE public.watchers  DROP CONSTRAINT watchers_organization_id_fkey;
