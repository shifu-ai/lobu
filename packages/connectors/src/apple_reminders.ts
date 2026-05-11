/**
 * Apple Reminders Connector (V1 runtime)
 *
 * Phone-bridged: Reminders data is read via EventKit on iOS. The connector
 * definition lives here; the iOS Bridge claims runs advertising the
 * `reminders` capability and streams events back through the worker protocol.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'Apple Reminders runs only on a worker advertising capability "reminders" (the Lobu iOS Bridge).';

export default class AppleRemindersConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.reminders',
    name: 'Apple Reminders',
    description:
      'Sync tasks and reminders from the Lobu iOS Bridge app. The iPhone reads EventKit locally and streams events to Lobu through the worker protocol.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'reminders',
    runtime: { platforms: ['ios'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      reminders: {
        key: 'reminders',
        name: 'Reminders',
        description: 'Tasks and reminders across all lists, including completion state.',
        configSchema: {
          type: 'object',
          properties: {
            include_completed: {
              type: 'boolean',
              default: true,
              description: 'Whether to include completed reminders.',
            },
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              default: 365,
              description: 'How far back to look for completed reminders (no effect on open ones).',
            },
          },
        },
        eventKinds: {
          reminder: {
            description: 'A single reminder / task.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'apple_reminders' },
                origin_id: { type: 'string' },
                list_name: { type: ['string', 'null'] },
                due_date: { type: ['string', 'null'] },
                completed: { type: 'boolean' },
                completed_at: { type: ['string', 'null'] },
                priority: { type: ['integer', 'null'] },
                notes: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(_a: string, _i: unknown, _c: ActionContext): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}
