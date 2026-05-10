-- migrate:up

-- Add a per-connector capability gate for worker dispatch. Workers advertise
-- their capabilities on poll; the runs scheduler only assigns connector runs
-- to workers whose capabilities include the connector's required_capability.
-- NULL means "no special capability required" (the default for API/browser
-- connectors that the existing fleet can run).
--
-- Initial use case: apple.health, which can only run inside the iOS Bridge
-- app because HealthKit data is unreachable from a server-side worker.

ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS required_capability text;

CREATE INDEX IF NOT EXISTS connector_definitions_required_capability_idx
    ON public.connector_definitions (required_capability)
    WHERE required_capability IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.connector_definitions_required_capability_idx;
ALTER TABLE public.connector_definitions
    DROP COLUMN IF EXISTS required_capability;
