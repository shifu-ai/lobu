-- migrate:up

-- Add a per-connector capability gate for worker dispatch. Workers advertise
-- their capabilities on poll; the runs scheduler only assigns connector runs
-- to workers whose capabilities include the connector's required_capability.
-- NULL means "no special capability required" (the default for API/browser
-- connectors that the existing fleet can run).
--
-- `runtime` carries platform metadata for device-bound connectors (e.g.
-- `{"platforms": ["macos"]}` for apple.screen_time / local.directory, which
-- only run inside the Lobu Mac Bridge — that data is unreachable from a
-- server-side worker). NULL = cloud connector.
--
-- Initial use case: apple.screen_time and local.directory, served by the Lobu
-- Mac Bridge polling /api/workers/* as a user-scoped device worker.

ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS required_capability text,
    ADD COLUMN IF NOT EXISTS runtime jsonb;

CREATE INDEX IF NOT EXISTS connector_definitions_required_capability_idx
    ON public.connector_definitions (required_capability)
    WHERE required_capability IS NOT NULL;

-- Backfill the gate for the bundled device connectors in case an earlier build
-- installed them before this column existed (otherwise a server-side worker
-- could claim them and hit their bridge-only throwing stubs). Reinstalls via
-- upsertConnectorDefinitionRecords set this from the connector's
-- `requiredCapability`; this just covers rows that predate that.
UPDATE public.connector_definitions SET required_capability = 'screentime'
    WHERE key = 'apple.screen_time' AND required_capability IS NULL;
UPDATE public.connector_definitions SET required_capability = 'local_directory'
    WHERE key = 'local.directory' AND required_capability IS NULL;

CREATE TABLE IF NOT EXISTS public.device_workers (
    user_id text NOT NULL,
    worker_id text NOT NULL,
    platform text,
    app_version text,
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    label text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, worker_id)
);

CREATE INDEX IF NOT EXISTS device_workers_user_id_idx
    ON public.device_workers (user_id);

-- migrate:down

DROP INDEX IF EXISTS public.device_workers_user_id_idx;
DROP TABLE IF EXISTS public.device_workers;
DROP INDEX IF EXISTS public.connector_definitions_required_capability_idx;
ALTER TABLE public.connector_definitions
    DROP COLUMN IF EXISTS runtime,
    DROP COLUMN IF EXISTS required_capability;
