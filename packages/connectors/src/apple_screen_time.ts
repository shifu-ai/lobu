/**
 * Apple Screen Time Connector (V1 runtime) — gated by entitlement.
 *
 * IMPORTANT: this is a scaffold. Apple's Screen Time API (FamilyControls +
 * DeviceActivity + ManagedSettings) is intentionally designed so per-app
 * usage data CANNOT be exfiltrated from the device by a third-party app:
 *
 *   1. The `com.apple.developer.family-controls` entitlement requires
 *      explicit approval from Apple — it is not a self-service toggle.
 *   2. Even with the entitlement, raw app-usage data is only readable inside
 *      a `DeviceActivityReport` SwiftUI extension that renders charts on
 *      device. The extension cannot perform network I/O.
 *   3. The aggregate signals that ARE readable from the host app
 *      (`DeviceActivityCenter` schedules + opaque event thresholds) are
 *      thresholds, not totals — they fire when a budget is crossed, no
 *      per-app totals are exposed.
 *
 * What this connector definition does today:
 *   - Reserves the connector key + UI slot in the catalog.
 *   - Declares `requiredCapability='screentime'` so when (and only when) an
 *     iOS Bridge build with the Family Controls entitlement advertises it,
 *     the scheduler will route runs to that device.
 *
 * What it would take to make this real:
 *   - Request and obtain the Family Controls entitlement from Apple.
 *   - Add a DeviceActivityReport SwiftUI extension target to the iOS app.
 *   - Constrain this connector's eventKinds to the aggregate-only signals
 *     the extension can derive (e.g. daily total screen time per category,
 *     never per-app totals). The user grants `FamilyControls.AuthorizationCenter`
 *     before any of that runs.
 *
 * Until those land, the connector definition exists but no iOS Bridge advertises
 * the `screentime` capability, so runs queued for it will sit pending forever
 * (which is the right behavior — visibly stalled is better than silently lost).
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
  'Apple Screen Time requires the Family Controls entitlement on the iOS Bridge build.';

export default class AppleScreenTimeConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.screen_time',
    name: 'Apple Screen Time',
    description:
      'Daily Screen Time category totals from the Lobu iOS Bridge. Requires the Family Controls entitlement; until that ships, runs for this connector stay pending. Per-app totals are not exposed by iOS to third-party apps.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'screentime',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      daily_category_totals: {
        key: 'daily_category_totals',
        name: 'Daily category totals',
        description:
          'Per-day total Screen Time by category (e.g. Social, Productivity). Aggregate-only — no per-app data is available to third-party apps.',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 90,
              default: 14,
              description: 'How many days the bridge should backfill.',
            },
          },
        },
        eventKinds: {
          screen_time_daily_category: {
            description: 'Total Screen Time spent in a category on a given day.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'date', 'category', 'seconds'],
              properties: {
                source: { type: 'string', const: 'apple_screen_time' },
                origin_id: { type: 'string' },
                date: { type: 'string', format: 'date' },
                category: { type: 'string' },
                seconds: { type: 'number', minimum: 0 },
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
