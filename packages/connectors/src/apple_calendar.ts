/**
 * Apple Calendar Connector (V1 runtime)
 *
 * Phone-bridged: EventKit data is only reachable from an authorized iOS app.
 * Source-of-truth schema for events + event kinds lives here; the Lobu iOS
 * Bridge runs the actual reads when it claims a job advertising the `calendar`
 * capability.
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
  'Apple Calendar runs only on a worker advertising capability "calendar" (the Lobu iOS Bridge).';

export default class AppleCalendarConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.calendar',
    name: 'Apple Calendar',
    description:
      'Sync Calendar events from the Lobu iOS Bridge app. The iPhone reads EventKit locally and streams events to Lobu through the worker protocol.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'calendar',
    runtime: { type: 'device', platforms: ['ios'], plugin: 'Calendar' },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      events: {
        key: 'events',
        name: 'Events',
        description: 'Calendar events including title, time window, location, and calendar name.',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              default: 30,
              description: 'How many days of past events the iOS bridge should backfill.',
            },
            lookahead_days: {
              type: 'integer',
              minimum: 0,
              maximum: 365,
              default: 30,
              description: 'How many days of upcoming events to include.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A single calendar event.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'start_at'],
              properties: {
                source: { type: 'string', const: 'apple_calendar' },
                origin_id: { type: 'string' },
                calendar_name: { type: ['string', 'null'] },
                start_at: { type: 'string' },
                end_at: { type: ['string', 'null'] },
                location: { type: ['string', 'null'] },
                all_day: { type: 'boolean' },
                participants: { type: ['array', 'null'], items: { type: 'string' } },
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
