/**
 * Local Directory Connector (V1 runtime) — Mac Bridge only.
 *
 * Syncs text files (txt/md/json/csv/html) from a local folder on the user's
 * Mac via the Lobu Mac helper. The helper advertises the `local_directory`
 * capability on /api/workers/poll, reads the folder, and streams file events
 * back through the standard worker protocol.
 *
 * The sync() / execute() stubs here throw immediately if a server-side worker
 * somehow bypassed the capability gate — same pattern as apple_health.ts.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY_MESSAGE =
  'local.directory runs only on a worker advertising capability "local_directory" (the Lobu Mac helper). ' +
  'This run was claimed by a worker without that capability — check connector_definitions.required_capability and the poll-time capability filter.';

export default class LocalDirectoryConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'local.directory',
    name: 'Local Folder',
    description:
      'Sync text files (txt/md/json/csv/html) from a folder on your Mac via the Lobu Mac helper.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'local_directory',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      files: {
        key: 'files',
        name: 'Files',
        description: 'Text files from the configured local folder.',
        configSchema: {
          type: 'object',
          properties: {},
        },
        eventKinds: {
          file_document: {
            description: 'A text file from the local folder.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'path', 'name'],
              properties: {
                source: { type: 'string', const: 'local_directory' },
                path: { type: 'string' },
                name: { type: 'string' },
                ext: { type: 'string' },
                size_bytes: { type: 'number' },
                modified_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }
}
