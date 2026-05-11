/**
 * Apple Health Connector (V1 runtime)
 *
 * Phone-bridged: HealthKit data is only reachable from an authorized iOS app.
 * The connector DEFINITION (feeds, event kinds, options) is the source of truth
 * for what data ends up in Lobu and how it's shaped. The EXECUTION lives in the
 * Lobu iOS Bridge app, which polls /api/workers/* as a worker advertising the
 * `healthkit` capability and streams events back through the standard worker
 * protocol — same `runs` lifecycle as every other connector.
 *
 * The TS sync() / execute() here are safety stubs: if a server-side worker
 * somehow bypassed the capability gate (`required_capability='healthkit'`),
 * the run would throw immediately instead of silently producing no events.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY_MESSAGE =
  'Apple Health runs only on a worker advertising capability "healthkit" (the Lobu iOS Bridge). ' +
  'This run was claimed by a worker without that capability — check connector_definitions.required_capability and the poll-time capability filter.';

export default class AppleHealthConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.health',
    name: 'Apple Health',
    description:
      'Sync Apple Health daily activity summaries and workouts from the Lobu iOS Bridge app. ' +
      'The iPhone reads HealthKit locally and streams events to Lobu through the worker protocol.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'healthkit',
    runtime: {
      platforms: ['ios'],
      scopes: ['steps', 'distance', 'active-calories', 'workouts', 'heart-rate'],
    },
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      daily_summaries: {
        key: 'daily_summaries',
        name: 'Daily summaries',
        description:
          'Daily Apple Health activity summaries: steps, distance, active energy, ' +
          'exercise minutes, and resting heart rate.',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              default: 30,
              description: 'How many days the iOS bridge should backfill for this feed.',
            },
          },
        },
        eventKinds: {
          health_daily_summary: {
            description: 'A daily summary of Apple Health activity data.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'date'],
              properties: {
                source: { type: 'string', const: 'apple_health' },
                origin_id: { type: 'string' },
                date: { type: 'string', format: 'date' },
                steps: { type: 'number' },
                distance_m: { type: 'number' },
                active_energy_kcal: { type: 'number' },
                exercise_minutes: { type: 'number' },
                resting_heart_rate_bpm: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
      workouts: {
        key: 'workouts',
        name: 'Workouts',
        description: 'Workout sessions recorded in Apple Health.',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              default: 30,
              description: 'How many days the iOS bridge should backfill for this feed.',
            },
          },
        },
        eventKinds: {
          health_workout: {
            description: 'A workout recorded in Apple Health.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'workout_type'],
              properties: {
                source: { type: 'string', const: 'apple_health' },
                origin_id: { type: 'string' },
                workout_type: { type: 'string' },
                duration_s: { type: 'number' },
                active_energy_kcal: { type: ['number', 'null'] },
                distance_m: { type: ['number', 'null'] },
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

  async execute(_action: string, _input: unknown, _ctx: ActionContext): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }
}
