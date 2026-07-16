-- migrate:up

CREATE TABLE public.queue_consumer_leases (
    queue_name text NOT NULL,
    consumer_id text NOT NULL,
    lease_instance_id text NOT NULL,
    deployment_revision text NOT NULL,
    declared_image_digest text,
    started_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    identity_conflict boolean NOT NULL DEFAULT false,
    PRIMARY KEY (queue_name, consumer_id, lease_instance_id),
    CONSTRAINT queue_consumer_leases_queue_name_check
        CHECK (length(queue_name) BETWEEN 1 AND 120),
    CONSTRAINT queue_consumer_leases_consumer_id_check
        CHECK (length(consumer_id) BETWEEN 1 AND 200),
    CONSTRAINT queue_consumer_leases_revision_check
        CHECK (length(deployment_revision) BETWEEN 1 AND 200),
    CONSTRAINT queue_consumer_leases_image_digest_check
        CHECK (declared_image_digest IS NULL OR declared_image_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT queue_consumer_leases_time_check
        CHECK (started_at <= last_seen_at AND last_seen_at < lease_expires_at)
);

CREATE INDEX queue_consumer_leases_expiry_idx
    ON public.queue_consumer_leases (queue_name, lease_expires_at DESC);

-- migrate:down

DROP TABLE public.queue_consumer_leases;
