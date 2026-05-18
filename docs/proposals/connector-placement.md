# Connector-worker placement: device vs cloud, scale-from-zero pool

Status: draft proposal — no code changes yet
Tracking issue: [#615](https://github.com/lobu-ai/lobu/issues/615)
Related: [#597](https://github.com/lobu-ai/lobu/issues/597), [PR #620](https://github.com/lobu-ai/lobu/pull/620)

## 1. Current state

### 1.1 Single queue, two claim lanes

The `runs` table is the only queue for both execution targets. The dispatcher lives in `packages/server/src/worker-api.ts` at `pollWorkerJob` (l. 140–536). Every `/api/workers/poll` request takes one of two auth modes:

* `workerAuthMode === 'trusted'` — the in-cluster `connector-worker` pod uses `WORKER_API_TOKEN` (anonymous in local dev). Claims **only `connections.device_worker_id IS NULL`** rows (l. 391–398). This is the cloud lane.
* `workerAuthMode === 'user'` — a Lobu-for-Mac / Lobu-for-iOS bridge using a PAT minted via `/api/me/devices/mint-child-token`. Claims (a) unpinned capability-matched device connectors in the device's org scope (l. 399–411), or (b) **any** run on a connection pinned to *this* device id (l. 417–426), or (c) watcher runs whose `approved_input.device_worker_id` equals this device (l. 436–442). PAT is bound to a single `worker_id` and `platform`; both are immutable after first registration.

The `WITH next_run … FOR UPDATE OF r SKIP LOCKED` claim atomically flips `runs.status = 'running'` and writes `claimed_by = worker_id`. There is no in-flight lease — `last_heartbeat_at` lives on the **legacy `workers` table** (`baseline.sql` l. 2014, 3781) which the new dispatcher does not write. A run that crashes mid-execution stays `running` until the worker process completes it or it gets orphaned forever. No reaper today.

### 1.2 Device-worker path (already shipped)

PR #620 added `connections.device_worker_id` (uuid FK to `device_workers.id`) plus `device_workers.organization_id`. `manage_connections.create` requires `device_worker_id` for any connector whose `connector_definitions.required_capability` is set; for all other connectors the binding is an optional override ("run Reddit on my Mac"). A unique partial index `(organization_id, connector_key, device_worker_id) WHERE deleted_at IS NULL` prevents double-binding.

`reconcileDeviceCapabilities` (called every poll) keeps the device's auto-wired connectors in lockstep with what the fleet currently advertises.

### 1.3 Cloud connector-worker pool

Helm chart at `charts/lobu/templates/worker-deployment.yaml` — a single `Deployment` with `worker.replicaCount` (default `1`). Each pod runs `WorkerDaemon` from `packages/connector-worker/src/daemon/worker.ts`: poll → execute one run → sleep `POLL_INTERVAL_MS` (default 10s). `maxConcurrentJobs = 1` by default; multiple replicas == horizontal concurrency. No HPA, no KEDA, no autoscaling object in the chart.

### 1.4 Prod state

Verified 2026-05-18: `kubectl get deployment summaries-app-lobu-worker -n summaries-prod` reports `1/1 1 1`. The issue body's "scaled to 0" claim is stale — the pool is currently serving cloud runs at `replicaCount=1`. There is no other cloud execution path (no in-app dispatcher fallback). If the Deployment scales to 0, every unpinned run sits forever.

### 1.5 Why the issue exists

* Placement is implicit: today it's derived from `connections.device_worker_id IS NULL`. There is no first-class column on `connectors`, `feeds`, or `runs` declaring intended placement, so the planner can't reject a misconfigured run before it claims one.
* The user-visible model is "every connection runs somewhere," but there is no per-org concept of "the cloud is *my* default device" — so the device-vs-cloud split leaks into the create-connection flow as a "Run on" dropdown (PR #620 follow-up) instead of being a routing decision made by the server.
* The cloud pool has no scale-from-zero story. A future "set `replicaCount=0` until the queue has work" mode needs a defined trigger, a lease so in-flight runs survive scale-down, and a hard interlock that a *device-required* run can never be tagged as cloud.

## 2. Placement tagging

### 2.1 Tag the connector definition, not the run

`connector_definitions` is where the operator's intent lives — and it's small, versioned, and already org-scoped. Adding a placement column there makes the planner cheap.

```sql
ALTER TABLE connector_definitions
  ADD COLUMN placement text NOT NULL DEFAULT 'auto'
    CHECK (placement IN ('cloud_only','device_only','auto'));
```

| Value         | Meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `cloud_only`  | Runs only on the cloud pool. Disallows `connections.device_worker_id` being set.                           |
| `device_only` | Runs only on a device. `connections.device_worker_id` is mandatory. (Today this is `required_capability IS NOT NULL`.) |
| `auto`        | Default for connectors with no capability — runs in the cloud unless the user explicitly pins to a device. |

Backfill is mechanical (§5).

### 2.2 Materialise the resolved target on the run

`runs` already pivots through `connections`/`connector_definitions` on every claim. Adding a denormalised `run_target` solves three problems at once: (1) planner can reject impossible configurations before insert, (2) claim filter becomes a single equality check, (3) operators get a queryable view of "what's stuck in cloud lane right now."

```sql
ALTER TABLE runs
  ADD COLUMN run_target text NOT NULL DEFAULT 'cloud'
    CHECK (run_target IN ('cloud','device')),
  ADD COLUMN target_device_worker_id uuid REFERENCES device_workers(id);

CREATE INDEX idx_runs_pending_cloud
  ON runs (created_at)
  WHERE status='pending' AND run_target='cloud';
```

* Writer: `enqueueRun()` / `materializeDueFeeds()` / `manage_watchers` set both columns at insert time from `connection.device_worker_id`+`connector_definition.placement`. If they disagree (e.g. `device_only` connector with no pinned device), the insert fails. **No backfill — old rows keep current claim path; only new inserts carry the column.**
* Reader: the claim WHERE turns into `(run_target = 'cloud' AND <trusted-worker>) OR (run_target = 'device' AND target_device_worker_id = <this device>)`, which subsumes the current device-pinned vs unpinned branches and the partial-index makes the cloud lane an index-only scan.

### 2.3 Feeds don't need their own tag

A feed inherits placement from its connection (1:N: one connection → many feeds, but a feed never has a different target from its parent). Storing placement on feeds duplicates state we'd then have to keep in sync with `connections.device_worker_id`. Skip.

## 3. "Org default device" semantics

The user-facing question is "when I add a connector that *could* run anywhere, where does it go?" Today the answer is "cloud if you don't tick the device picker." That's correct but the model isn't named anywhere.

Proposal: the **cloud pool is the org's default device, modelled as a synthetic `device_workers` row** seeded per-org at creation time:

* `device_workers.id = '00000000-0000-0000-0000-000000000000'` (sentinel) is allowed.
* Or simpler — add `organization.default_placement text NOT NULL DEFAULT 'cloud'` and stop pretending it's a device. Connectors with `placement='auto'` resolve to whatever the org default says. An "always run on my Mac" org default is on the table but not part of this proposal.

Picking option B (column on `organization`) avoids inventing a synthetic device row that doesn't poll, isn't a real `device_workers` member, and would confuse `/api/me/devices` enumerators. The web UI's "Run on" picker becomes:

* `device_only` connector → required device picker, no "cloud" option.
* `cloud_only` connector → no picker, runs in the cloud pool.
* `auto` connector → picker defaults to "Cloud (org default)", user can override to any owned/granted device.

## 4. Scale-from-zero pool

**Out of scope for v1 of this design.** The issue explicitly says autoscaling is deferred until there's load to justify it. The current chart's `replicaCount=1` is correct for the foreseeable future. This section is the sketch for when we do need it, so the placement-tagging work in §2 lands compatible with it.

### 4.1 Trigger

KEDA's PostgreSQL scaler is the simplest pick — zero app code, just a `ScaledObject`. Trigger query:

```sql
SELECT count(*)
FROM runs
WHERE status = 'pending'
  AND run_target = 'cloud'
  AND (expires_at IS NULL OR expires_at > now())
  AND created_at < now() - interval '15 seconds';
```

* Activation threshold: `>= 1` → scale to `minReplicas=1`. (Don't oscillate on a single run; once you're up, stay up at least one cooldown window.)
* Cooldown: 60 s after the queue drains before scaling back to 0.
* Max replicas: start at 3; revisit when we have throughput data.

The `idx_runs_pending_cloud` partial index above keeps this query at <1 ms even at scale.

### 4.2 Cold-start budget

The worker image is ~600 MB (Node + connector source bundle). On the current node pool a cold container is ~10-15 s to first poll. The 15-second `created_at` delay in the trigger query absorbs that — short bursty work (one-off action, a single sync) shouldn't wake the pool at all because the existing pod will pick it up within `POLL_INTERVAL_MS`. The trigger fires when work has actually queued up.

### 4.3 In-flight lease so scale-down is safe

Today scale-down is unsafe: KEDA could yank a pod mid-run and the row sits in `running` forever. Two pieces required:

1. **Heartbeat column on `runs`.** Reuse the connector-worker's existing `/api/workers/heartbeat` (already implemented, currently a no-op for the run row) to bump `runs.last_heartbeat_at = now()`. Every 30 s.
2. **Reaper.** A periodic job (in-process inside the app pod, behind `pg_try_advisory_xact_lock` like `materializeDueFeeds`) that flips `running` runs whose `last_heartbeat_at < now() - 2 minutes` back to `pending`, with a retry-counter increment and a hard cap (`runs.retry_count` already exists per `20260429140100_runs_priority_expires_at_retry_delay.sql`). When the reaper requeues, log a `run-reaped` event so operators can see the rate.

Graceful drain: the daemon already handles SIGTERM (`worker.ts` l. 168–194) and waits up to 30 s for active jobs. KEDA's default `terminationGracePeriodSeconds` is 30 s, which matches. Document that KEDA scale-down must not race a long-running connector — if any connector regularly exceeds 30 s, raise the grace period; if it routinely exceeds the heartbeat reaper window, raise that too.

## 5. Migration plan

Single migration, runs in this order:

1. `ALTER TABLE connector_definitions ADD COLUMN placement` (default `'auto'`).
2. Backfill: `UPDATE connector_definitions SET placement = 'device_only' WHERE required_capability IS NOT NULL`. Everything else stays `auto`. We do **not** auto-promote anything to `cloud_only` — that label is for connectors the operator explicitly forbids from running on a user's machine, which is a follow-up policy decision.
3. `ALTER TABLE runs ADD COLUMN run_target` (default `'cloud'`), `target_device_worker_id`. **No backfill of existing rows** — old pending runs (there should be near zero in practice; runs finish in seconds) keep going through the current dispatch path until they clear naturally. The `pollWorkerJob` claim WHERE handles both shapes via `COALESCE(r.run_target, CASE WHEN con.device_worker_id IS NULL THEN 'cloud' ELSE 'device' END)` for one release, then we drop the COALESCE.
4. `ALTER TABLE organization ADD COLUMN default_placement` (default `'cloud'`). Backfill is the default — every existing org becomes cloud-default, matching today's behaviour.
5. Validation pass at deploy time: any `connections.device_worker_id IS NULL` whose connector now resolves to `device_only` is a misconfiguration. Should be zero rows in practice (the `manage_connections` validator already enforces this) but the migration script logs the count for ops awareness and refuses to drop the legacy COALESCE branch in the follow-up release unless the count is 0.

No data is destroyed at any step. The migration is reversible up to step 3 (column add) — drop columns in reverse, the COALESCE branch keeps reading.

## 6. Risks

### 6.1 Cloud pool at 0, run mis-tagged as cloud

A device-only run incorrectly tagged `run_target='cloud'` would sit in the queue forever once KEDA scales to 0 with no work to wake on. Mitigations, in order of how much we trust them:

* **Insertion-time check (primary).** `enqueueRun()` rejects with a clear error if `connector_definitions.placement` disagrees with the computed `run_target`. Tested under the same TX as the insert — no race.
* **CHECK constraint (defence in depth).** `CHECK ((run_target='cloud' AND target_device_worker_id IS NULL) OR (run_target='device' AND target_device_worker_id IS NOT NULL))`. The DB refuses contradictory rows.
* **Sweeper.** Same advisory-locked job that reaps stale `running` runs scans `pending` rows whose declared target is unreachable for >5 minutes (no online device worker advertising the capability for `device`; no cloud pod and a `pending`-cloud queue depth that's been monotonic across two sweeps for `cloud`). Marks them `failed` with a `placement_unreachable` reason and notifies the connection owner. **This is the fail-safe; it is not a substitute for the insertion check.**

### 6.2 Wrong device claims a device run

Already mitigated by PR #620's `authorizeRunForWorker` (rechecks org/owner scope, not just `claimed_by`) and the capability gate inside the claim query. The new `target_device_worker_id` adds an equality check to that, tightening it further.

### 6.3 Operator deletes the cloud-only Deployment

Same failure mode as 6.1 from the queue's perspective. The sweeper covers it. Operationally, the chart's `worker.enabled` flag is the documented kill-switch; turning it off without first migrating cloud-only connectors to device-only (or pausing those connections) is an operator error.

### 6.4 KEDA wakes the pool but the pod can't pull the image

Same as today's "Deployment is broken." Falls under standard k8s observability — Prometheus alert on `kube_deployment_status_replicas_unavailable{deployment=~".*-worker"}`. Out of scope for the placement design.

### 6.5 Migration backfill leaves an ambiguous connector

A connector whose `required_capability` is NULL but which actually needs a device (none exist today, but a future one could). Backfill marks it `auto`, which means it'd run in the cloud and fail. Caught by the insert-time check the first time someone creates a connection from it; a one-time `ALTER` by the operator promotes it to `device_only`. Documented in the migration notes.

## 7. Out of scope

* Placement-aware UI in `packages/owletto` (the "Run on" picker landed in PR #620's follow-up — we just need to surface "Cloud (org default)" as a labelled option).
* Multi-region cloud pools (different `run_target` namespaces per region). One pool is enough today.
* Per-connector cost accounting. The same plumbing can power "this org used X cloud-worker-minutes this month" but that's its own design.
* Migrating away from the legacy `workers` table — it's still referenced by some heartbeat indexes but the runtime path no longer uses it.

## 8. Open questions

1. **Org default placement: column on `organization` or synthetic device row?** Proposal picks the column. Confirm before implementation; a synthetic device row would simplify some UI listing code at the cost of muddying `/api/me/devices`.
2. **Does `cloud_only` need to exist as a placement value, or is `device_only` + `auto` enough for v1?** Today no connector is forbidden from running on a device. If we ship `cloud_only` we should ship at least one connector that uses it (audit-log? cost-metered analytics?) — otherwise it's dead code.
3. **Reaper threshold.** Proposed 2 minutes for stale `running`, 5 minutes for `pending` with no reachable target. These are guesses; we should pick based on the longest-running connector's p99 (sync runs can legitimately last minutes for first-time imports).
4. **KEDA vs always-on `replicaCount=1`.** This proposal assumes the autoscaling work is real follow-on; if we're never doing it, the lease/reaper work in §4.3 still has value (crash recovery) but its priority drops. Confirm with ops whether scale-from-zero is on the roadmap before we build for it.
5. **`approved_input.device_worker_id` for watchers.** Currently the watcher claim lane reads pin from `approved_input` JSON, not a column. Should it migrate to `runs.target_device_worker_id` for consistency, or stay as-is? Leaning *migrate* since it converges the dispatch path on one column, but it's a separate refactor.
6. **Backwards compatibility window for the COALESCE bridge in §5 step 3.** One release? Two? Depends on prod rollout cadence; tracking issue should set the explicit version.
