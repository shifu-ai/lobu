-- migrate:up
CREATE TABLE agent_configuration_controls (
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  management_mode text NOT NULL DEFAULT 'native',
  configuration_revision bigint NOT NULL DEFAULT 0,
  last_mutation_kind text,
  last_command_id text,
  last_command_digest text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_configuration_controls_pkey PRIMARY KEY (organization_id, agent_id),
  CONSTRAINT agent_configuration_controls_agent_fkey FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_configuration_controls_mode_check CHECK (management_mode IN ('native', 'toolbox_managed')),
  CONSTRAINT agent_configuration_controls_revision_check CHECK (configuration_revision >= 0),
  CONSTRAINT agent_configuration_controls_last_command_closed CHECK (
    (last_mutation_kind IS NULL AND last_command_id IS NULL AND last_command_digest IS NULL)
    OR
    (last_mutation_kind IS NOT NULL AND last_command_id IS NOT NULL AND last_command_digest IS NOT NULL
      AND last_mutation_kind IN ('bootstrap', 'native_patch', 'managed_release', 'managed_enrollment')
      AND btrim(last_command_id) <> ''
      AND last_command_digest ~ '^sha256:[0-9a-f]{64}$')
  )
);

CREATE TABLE agent_configuration_commands (
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  command_id text NOT NULL,
  command_digest text NOT NULL,
  mutation_kind text NOT NULL,
  resulting_revision bigint NOT NULL,
  resulting_mode text NOT NULL,
  resulting_settings_digest text NOT NULL,
  result_status text NOT NULL,
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_configuration_commands_pkey PRIMARY KEY (organization_id, agent_id, command_id),
  CONSTRAINT agent_configuration_commands_agent_fkey FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_configuration_commands_digest_check CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT agent_configuration_commands_id_check CHECK (btrim(command_id) <> ''),
  CONSTRAINT agent_configuration_commands_kind_check CHECK (mutation_kind IN ('bootstrap', 'native_patch', 'managed_release', 'managed_enrollment')),
  CONSTRAINT agent_configuration_commands_revision_check CHECK (resulting_revision >= 0),
  CONSTRAINT agent_configuration_commands_mode_check CHECK (resulting_mode IN ('native', 'toolbox_managed')),
  CONSTRAINT agent_configuration_commands_settings_digest_check CHECK (resulting_settings_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT agent_configuration_commands_status_check CHECK (result_status IN ('applied', 'no_change'))
);

CREATE INDEX agent_configuration_commands_agent_applied_idx ON agent_configuration_commands (organization_id, agent_id, applied_at DESC);

-- migrate:down
DROP TABLE agent_configuration_commands;
DROP TABLE agent_configuration_controls;
