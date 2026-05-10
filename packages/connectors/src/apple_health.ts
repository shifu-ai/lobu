import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

/**
 * Apple Health is a phone-bridged connector.
 *
 * HealthKit data is only accessible to an authorized iOS app, so Lobu cannot
 * pull it from the server/worker like a normal cloud API. The bundled connector
 * definition makes Apple Health visible and manageable in Lobu; the iOS Bridge
 * performs the actual HealthKit reads and pushes connector-scoped events to the
 * gateway ingest endpoint.
 */
export default class AppleHealthConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.health',
    name: 'Apple Health',
    description:
      'Sync Apple Health summaries and workouts from the Lobu iOS Bridge app. The iPhone reads HealthKit and pushes selected data to Lobu.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      daily_summaries: {
        key: 'daily_summaries',
        name: 'Daily summaries',
        description: 'Daily Apple Health activity summaries such as steps, distance, energy, exercise minutes, and resting heart rate.',
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
                date: { type: 'string' },
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
    optionsSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Apple Health is configured through the Lobu iOS Bridge app.',
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    return {
      events: [],
      checkpoint: {
        bridge_required: true,
        message: 'Apple Health sync runs on the Lobu iOS Bridge app.',
      },
    };
  }

  async execute(_action: string, _input: unknown, _ctx: ActionContext): Promise<ActionResult> {
    throw new Error('Apple Health does not expose connector actions yet.');
  }
}
