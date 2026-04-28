-- migrate:up transaction:false

-- Add ON DELETE CASCADE FK on events.organization_id and watchers.organization_id.
--
-- These two columns were declared as `text NOT NULL` with no FK to organization,
-- so dropping an org left orphaned events/watchers behind that had to be DELETE'd
-- separately. Every other org-scoped table has a CASCADE FK; these two were
-- oversights. Add them so future org deletes are atomic with their event/watcher
-- data.
--
-- Lock-window strategy: ADD CONSTRAINT NOT VALID adds the catalog row under
-- a brief ACCESS EXCLUSIVE without scanning the table. VALIDATE then takes
-- only SHARE UPDATE EXCLUSIVE so concurrent reads and writes are unaffected.
-- Running with `transaction:false` lets each ALTER release its lock on
-- completion — keeping ADD + VALIDATE in a single transaction would hold
-- ACCESS EXCLUSIVE through the validate scan and block writers on the
-- 575k-row events table.
--
-- Idempotency: each ADD is gated on `pg_constraint`. If the FK already
-- exists (e.g. it was applied out-of-band before this migration was
-- recorded), the ADD is skipped; VALIDATE on a constraint that's already
-- validated is a no-op.

SET lock_timeout = '5s';

-- 1. events.organization_id → organization(id) ON DELETE CASCADE.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.events'::regclass
           AND conname  = 'events_organization_id_fkey'
    ) THEN
        ALTER TABLE public.events
            ADD CONSTRAINT events_organization_id_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END$$;

ALTER TABLE public.events VALIDATE CONSTRAINT events_organization_id_fkey;

-- 2. watchers.organization_id → organization(id) ON DELETE CASCADE.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.watchers'::regclass
           AND conname  = 'watchers_organization_id_fkey'
    ) THEN
        ALTER TABLE public.watchers
            ADD CONSTRAINT watchers_organization_id_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END$$;

ALTER TABLE public.watchers VALIDATE CONSTRAINT watchers_organization_id_fkey;


-- migrate:down transaction:false

ALTER TABLE public.events    DROP CONSTRAINT IF EXISTS events_organization_id_fkey;
ALTER TABLE public.watchers  DROP CONSTRAINT IF EXISTS watchers_organization_id_fkey;
