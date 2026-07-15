-- migrate:up

CREATE TABLE IF NOT EXISTS toolbox_sales_battle_report_schedule_sync (
  organization_id text NOT NULL,
  toolbox_schedule_id text NOT NULL,
  last_accepted_revision integer NOT NULL,
  desired_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, toolbox_schedule_id)
);

-- migrate:down

DROP TABLE IF EXISTS toolbox_sales_battle_report_schedule_sync;
