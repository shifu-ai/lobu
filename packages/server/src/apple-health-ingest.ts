import type { Context } from 'hono';
import { hasRequiredMcpScope } from './auth/tool-access';
import { getDb } from './db/client';
import type { Env } from './index';
import { ensureConnectorInstalled } from './utils/ensure-connector-installed';
import { errorMessage } from './utils/errors';
import { validateConnectorEventSemanticType } from './utils/event-kind-validation';
import { insertEvent } from './utils/insert-event';

const CONNECTOR_KEY = 'apple.health';
const CONNECTOR_VERSION = '0.1.0';

type AppleHealthIngestItem = {
  origin_id: string;
  title?: string;
  content?: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
};

type AppleHealthIngestBody = {
  connection_id?: number;
  daily_summaries?: AppleHealthIngestItem[];
  workouts?: AppleHealthIngestItem[];
};

type FeedKey = 'daily_summaries' | 'workouts';

function assertCanIngest(c: Context<{ Bindings: Env }>): Response | null {
  if (!c.var.mcpIsAuthenticated) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  if (!c.var.organizationId) {
    return c.json({ error: 'Organization context required' }, 400);
  }
  if (!c.var.memberRole) {
    return c.json({ error: 'Workspace membership with write access is required' }, 403);
  }
  if (!hasRequiredMcpScope('write', c.var.mcpAuthInfo?.scopes ?? null)) {
    return c.json({ error: 'This Lobu session does not include write access' }, 403);
  }
  return null;
}

function normalizeItems(value: unknown): AppleHealthIngestItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AppleHealthIngestItem => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as AppleHealthIngestItem;
    return typeof candidate.origin_id === 'string' && typeof candidate.occurred_at === 'string';
  });
}

async function ensureAppleHealthConnection(params: {
  organizationId: string;
  userId: string | null;
  requestedConnectionId?: number;
}): Promise<number> {
  const sql = getDb();
  const { organizationId, userId, requestedConnectionId } = params;

  const installed = await ensureConnectorInstalled({ organizationId, connectorKey: CONNECTOR_KEY });
  if (!installed) {
    throw new Error('Apple Health connector is not available on this Lobu server.');
  }

  if (requestedConnectionId) {
    const rows = await sql`
      SELECT id
      FROM connections
      WHERE id = ${requestedConnectionId}
        AND organization_id = ${organizationId}
        AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows[0]?.id) return Number(rows[0].id);
  }

  const existing = await sql`
    SELECT id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND connector_key = ${CONNECTOR_KEY}
      AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (existing[0]?.id) {
    const id = Number(existing[0].id);
    await sql`
      UPDATE connections
      SET status = 'active', error_message = NULL, updated_at = NOW()
      WHERE id = ${id}
    `;
    return id;
  }

  const inserted = await sql`
    INSERT INTO connections (
      organization_id, connector_key, display_name, status, config, created_by, visibility
    ) VALUES (
      ${organizationId}, ${CONNECTOR_KEY}, 'Apple Health', 'active', ${sql.json({ bridge: 'ios' })}, ${userId}, 'private'
    )
    RETURNING id
  `;
  return Number(inserted[0].id);
}

async function ensureFeed(params: {
  organizationId: string;
  connectionId: number;
  feedKey: FeedKey;
  displayName: string;
  backfillDays?: number;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT id
    FROM feeds
    WHERE organization_id = ${params.organizationId}
      AND connection_id = ${params.connectionId}
      AND feed_key = ${params.feedKey}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows[0]?.id) return Number(rows[0].id);

  const inserted = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status, config, schedule
    ) VALUES (
      ${params.organizationId},
      ${params.connectionId},
      ${params.feedKey},
      ${params.displayName},
      'active',
      ${sql.json({ backfill_days: params.backfillDays ?? 30, bridge: 'ios' })},
      'ios_background'
    )
    RETURNING id
  `;
  return Number(inserted[0].id);
}

async function createCompletedRun(params: {
  organizationId: string;
  connectionId: number;
  feedId: number;
  itemCount: number;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id, connector_key, connector_version,
      status, items_collected, completed_at
    ) VALUES (
      ${params.organizationId}, 'sync', ${params.feedId}, ${params.connectionId},
      ${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, 'completed', ${params.itemCount}, NOW()
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function ingestFeed(params: {
  organizationId: string;
  connectionId: number;
  feedKey: FeedKey;
  feedId: number;
  runId: number;
  items: AppleHealthIngestItem[];
  originType: 'health_daily_summary' | 'health_workout';
  semanticType: 'summary' | 'event';
  userId: string | null;
  clientId: string | null;
}): Promise<number> {
  let inserted = 0;
  for (const item of params.items) {
    const metadata = {
      ...(item.metadata ?? {}),
      source: 'apple_health',
      origin_id: item.origin_id,
    };
    const validation = await validateConnectorEventSemanticType(
      params.originType,
      metadata,
      CONNECTOR_KEY,
      params.feedKey,
      params.organizationId
    );
    if (!validation.valid) {
      throw new Error(validation.errors.join('\n'));
    }

    await insertEvent(
      {
        entityIds: [],
        organizationId: params.organizationId,
        originId: item.origin_id,
        title: item.title,
        content: item.content ?? item.title ?? '',
        occurredAt: item.occurred_at,
        metadata,
        semanticType: params.semanticType,
        originType: params.originType,
        connectorKey: CONNECTOR_KEY,
        connectionId: params.connectionId,
        feedKey: params.feedKey,
        feedId: params.feedId,
        runId: params.runId,
        createdBy: params.userId,
        clientId: params.clientId,
      },
      { onConflictUpdate: true }
    );
    inserted++;
  }
  return inserted;
}

export async function appleHealthIngest(c: Context<{ Bindings: Env }>) {
  const authError = assertCanIngest(c);
  if (authError) return authError;

  try {
    const organizationId = c.var.organizationId!;
    const userId = c.var.mcpAuthInfo?.userId ?? c.var.session?.userId ?? null;
    const clientId = c.var.mcpAuthInfo?.clientId ?? null;
    const body = (await c.req.json()) as AppleHealthIngestBody;
    const dailySummaries = normalizeItems(body.daily_summaries);
    const workouts = normalizeItems(body.workouts);

    const connectionId = await ensureAppleHealthConnection({
      organizationId,
      userId,
      requestedConnectionId: body.connection_id,
    });
    const dailyFeedId = await ensureFeed({
      organizationId,
      connectionId,
      feedKey: 'daily_summaries',
      displayName: 'Daily summaries',
    });
    const workoutFeedId = await ensureFeed({
      organizationId,
      connectionId,
      feedKey: 'workouts',
      displayName: 'Workouts',
    });

    const dailyRunId = await createCompletedRun({
      organizationId,
      connectionId,
      feedId: dailyFeedId,
      itemCount: dailySummaries.length,
    });
    const workoutRunId = await createCompletedRun({
      organizationId,
      connectionId,
      feedId: workoutFeedId,
      itemCount: workouts.length,
    });

    const dailyInserted = await ingestFeed({
      organizationId,
      connectionId,
      feedKey: 'daily_summaries',
      feedId: dailyFeedId,
      runId: dailyRunId,
      items: dailySummaries,
      originType: 'health_daily_summary',
      semanticType: 'summary',
      userId,
      clientId,
    });
    const workoutInserted = await ingestFeed({
      organizationId,
      connectionId,
      feedKey: 'workouts',
      feedId: workoutFeedId,
      runId: workoutRunId,
      items: workouts,
      originType: 'health_workout',
      semanticType: 'event',
      userId,
      clientId,
    });

    const sql = getDb();
    const lastPushAt = new Date().toISOString();
    await sql`
      UPDATE connections
      SET status = 'active', error_message = NULL, updated_at = NOW()
      WHERE id = ${connectionId}
    `;
    await sql`
      UPDATE feeds
      SET last_sync_at = NOW(), last_sync_status = 'success', last_error = NULL,
          consecutive_failures = 0, items_collected = items_collected + ${dailyInserted},
          checkpoint = ${sql.json({ last_push_at: lastPushAt })},
          updated_at = NOW()
      WHERE id = ${dailyFeedId}
    `;
    await sql`
      UPDATE feeds
      SET last_sync_at = NOW(), last_sync_status = 'success', last_error = NULL,
          consecutive_failures = 0, items_collected = items_collected + ${workoutInserted},
          checkpoint = ${sql.json({ last_push_at: lastPushAt })},
          updated_at = NOW()
      WHERE id = ${workoutFeedId}
    `;

    return c.json({
      connection_id: connectionId,
      feeds: {
        daily_summaries: { feed_id: dailyFeedId, run_id: dailyRunId, items: dailyInserted },
        workouts: { feed_id: workoutFeedId, run_id: workoutRunId, items: workoutInserted },
      },
      uploaded: dailyInserted + workoutInserted,
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
}
