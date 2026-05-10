import Foundation

/// Result of running one worker-loop iteration. Surfaced to the UI so the user
/// sees whether a job was claimed and how many events were streamed.
struct HealthSyncResult: Equatable {
    let dailySummaryCount: Int
    let workoutCount: Int
    let uploadedCount: Int
    /// True when the poll claimed a job. False means the server had no
    /// pending apple.health runs for this user.
    let claimedJob: Bool
}

@MainActor
enum HealthSyncService {
    /// Run one cycle of the worker protocol: poll → if claimed, execute the
    /// claimed apple.health job against HealthKit → stream events → complete.
    ///
    /// `requestHealthAuthorization` requests HealthKit permissions on first
    /// run (no-op afterwards). `backfillDays` is a UI-visible default the user
    /// can override; the actual backfill window per run comes from the feed's
    /// merged config the server sends in the poll response, falling back to
    /// this value when the connector definition's config isn't set on the feed.
    static func sync(
        health: HealthKitManager? = nil,
        requestHealthAuthorization: Bool,
        backfillDays requestedBackfillDays: Int? = nil
    ) async throws -> HealthSyncResult {
        let healthManager = health ?? HealthKitManager()
        if requestHealthAuthorization {
            try await healthManager.requestAuthorization()
            try? await healthManager.enableBackgroundDelivery()
            UserDefaults.standard.set(true, forKey: "healthAuthorizationRequested")
        }

        let credentialStore = KeychainCredentialStore()
        guard var credentials = credentialStore.load() else {
            throw HealthBridgeError.missingConfiguration
        }

        let oauth = try OAuthClient(baseURL: credentials.baseURL)
        if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
            credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
            try credentialStore.save(credentials)
        }

        let worker = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        let workerId = LobuWorkerIdentity.current()

        let (job, _) = try await worker.poll(
            workerId: workerId,
            capabilities: ["healthkit": true]
        )
        guard let job else {
            return HealthSyncResult(
                dailySummaryCount: 0,
                workoutCount: 0,
                uploadedCount: 0,
                claimedJob: false
            )
        }

        // Currently the iOS bridge only knows how to run apple.health. If the
        // server somehow handed us a different connector we fail the run and
        // surface that clearly — better than silently producing no events.
        guard job.connector_key == "apple.health" else {
            try await worker.complete(
                workerId: workerId,
                runId: job.run_id,
                itemsCollected: 0,
                error: "iOS Bridge cannot execute connector '\(job.connector_key)'"
            )
            throw HealthBridgeError.unsupportedConnector(job.connector_key)
        }

        let userDefaultBackfill = clampedBackfillDays(requestedBackfillDays)
        let backfillDays = job.config?["backfill_days"]?.intValue ?? userDefaultBackfill

        do {
            let (summaries, workouts) = try await healthManager.summariesForLastDays(backfillDays)
            let items: [WorkerStreamItem]
            let dailyCount: Int
            let workoutCount: Int

            switch job.feed_key {
            case "daily_summaries":
                items = summaries.map(makeDailySummaryItem(from:))
                dailyCount = summaries.count
                workoutCount = 0
            case "workouts":
                items = workouts.map(makeWorkoutItem(from:))
                dailyCount = 0
                workoutCount = workouts.count
            default:
                // No feed_key set: behave conservatively and stream both — the
                // server validates per-event semantic_type against the feed's
                // declared eventKinds so unsupported feed_keys still error
                // cleanly server-side.
                items = summaries.map(makeDailySummaryItem(from:)) + workouts.map(makeWorkoutItem(from:))
                dailyCount = summaries.count
                workoutCount = workouts.count
            }

            if !items.isEmpty {
                try await worker.stream(runId: job.run_id, items: items)
            }

            try await worker.complete(
                workerId: workerId,
                runId: job.run_id,
                itemsCollected: items.count,
                error: nil
            )

            return HealthSyncResult(
                dailySummaryCount: dailyCount,
                workoutCount: workoutCount,
                uploadedCount: items.count,
                claimedJob: true
            )
        } catch {
            // Best-effort: tell the server the run failed so it doesn't sit
            // forever as 'running' and block subsequent runs.
            try? await worker.complete(
                workerId: workerId,
                runId: job.run_id,
                itemsCollected: 0,
                error: error.localizedDescription
            )
            throw error
        }
    }

    static func clampedBackfillDays(_ requestedBackfillDays: Int? = nil) -> Int {
        let value = requestedBackfillDays ?? UserDefaults.standard.integer(forKey: "backfillDays")
        return min(max(value == 0 ? 7 : value, 1), 30)
    }
}

// =============================================================================
// HealthKit → WorkerStreamItem mapping. Field names + semantic_type must match
// the connector definition at packages/connectors/src/apple_health.ts.
// =============================================================================

private func makeDailySummaryItem(from summary: DailyHealthSummary) -> WorkerStreamItem {
    WorkerStreamItem(
        id: summary.originID,
        title: summary.title,
        payload_text: summary.summaryText,
        occurred_at: isoString(summary.startAt),
        semantic_type: "health_daily_summary",
        metadata: [
            "source": AnyEncodable("apple_health"),
            "origin_id": AnyEncodable(summary.originID),
            "date": AnyEncodable(summary.date),
            "steps": AnyEncodable(summary.steps),
            "distance_m": AnyEncodable(summary.distanceMeters),
            "active_energy_kcal": AnyEncodable(summary.activeEnergyKilocalories),
            "exercise_minutes": AnyEncodable(summary.exerciseMinutes),
            "resting_heart_rate_bpm": AnyEncodable(summary.restingHeartRateBpm as Any?),
        ]
    )
}

private func makeWorkoutItem(from workout: WorkoutSummary) -> WorkerStreamItem {
    WorkerStreamItem(
        id: workout.originID,
        title: workout.title,
        payload_text: workout.summaryText,
        occurred_at: isoString(workout.startAt),
        semantic_type: "health_workout",
        metadata: [
            "source": AnyEncodable("apple_health"),
            "origin_id": AnyEncodable(workout.originID),
            "workout_type": AnyEncodable(workout.workoutType),
            "duration_s": AnyEncodable(workout.durationSeconds),
            "active_energy_kcal": AnyEncodable(workout.activeEnergyKilocalories as Any?),
            "distance_m": AnyEncodable(workout.distanceMeters as Any?),
        ]
    )
}
