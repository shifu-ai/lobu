-- migrate:up

-- Fix connection-config encryption asymmetry in agent_connections.config.
--
-- encryptConfig() in postgres-stores.ts historically returned raw
-- "iv:tag:ciphertext" output from @lobu/core's `encrypt()`, but
-- decryptConfig() only decrypts strings that start with "enc:v1:". So any
-- secret-named field that hit encryptConfig was stored as prefixless
-- ciphertext and round-tripped as that ciphertext literal on read.
--
-- This migration backfills existing prefixless rows by re-prefixing them so
-- the now-aligned decryptConfig path can decrypt them.
--
-- Identification: AES-GCM in @lobu/core uses a 12-byte IV (24 hex chars)
-- and a 16-byte auth tag (32 hex chars), joined with the ciphertext as
-- `iv:tag:ciphertext`. We match exactly that shape to avoid touching
-- arbitrary `:` separated values.
--
-- Idempotent: jsonb_object_agg only rewrites string values that match the
-- prefixless shape AND lack the prefix. Re-running the migration is a noop.

UPDATE public.agent_connections AS ac
SET config = sub.fixed_config
FROM (
  SELECT
    id,
    jsonb_object_agg(
      key,
      CASE
        WHEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'
             AND value #>> '{}' NOT LIKE 'enc:v1:%'
        THEN to_jsonb('enc:v1:' || (value #>> '{}'))
        ELSE value
      END
    ) AS fixed_config
  FROM public.agent_connections,
       LATERAL jsonb_each(config)
  GROUP BY id
) AS sub
WHERE ac.id = sub.id
  AND ac.config IS DISTINCT FROM sub.fixed_config;

-- migrate:down

-- Strip the "enc:v1:" prefix to restore the prefixless ciphertext shape.
-- Same regex: only touch strings whose remainder is `iv:tag:ciphertext`.

UPDATE public.agent_connections AS ac
SET config = sub.fixed_config
FROM (
  SELECT
    id,
    jsonb_object_agg(
      key,
      CASE
        WHEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' LIKE 'enc:v1:%'
             AND substring(value #>> '{}' FROM 8) ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'
        THEN to_jsonb(substring(value #>> '{}' FROM 8))
        ELSE value
      END
    ) AS fixed_config
  FROM public.agent_connections,
       LATERAL jsonb_each(config)
  GROUP BY id
) AS sub
WHERE ac.id = sub.id
  AND ac.config IS DISTINCT FROM sub.fixed_config;
