import Foundation

/// Mac-side analog of HealthSyncService on the iOS bridge. Runs one cycle of
/// the worker protocol: poll → if claimed, run the requested apple.* connector
/// (currently only apple.screen_time) → stream events → complete.
@MainActor
enum ScreenTimeSyncService {
    struct CycleResult {
        let claimedJob: Bool
        let itemsStreamed: Int
        let connectorKey: String?
    }

    static func runOneCycle(baseURL: String) async throws -> CycleResult {
        let credentialStore = KeychainCredentialStore()
        guard var credentials = credentialStore.load() else {
            throw NSError(domain: "LobuMacBridge", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Sign in to Lobu first."])
        }
        let oauth = try OAuthClient(baseURL: credentials.baseURL)
        if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
            credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
            try credentialStore.save(credentials)
        }

        let worker = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        let workerId = LobuWorkerIdentity.current()

        let (job, _) = try await worker.poll(workerId: workerId, capabilities: ["screentime": true])
        guard let job else {
            return CycleResult(claimedJob: false, itemsStreamed: 0, connectorKey: nil)
        }

        do {
            let items: [WorkerStreamItem]
            switch job.connector_key {
            case "apple.screen_time":
                items = try await runScreenTime(job: job)
            default:
                try await worker.complete(workerId: workerId, runId: job.run_id, itemsCollected: 0,
                                          error: "Mac bridge cannot run connector \(job.connector_key)")
                return CycleResult(claimedJob: true, itemsStreamed: 0, connectorKey: job.connector_key)
            }

            if !items.isEmpty {
                try await worker.stream(runId: job.run_id, items: items)
            }
            try await worker.complete(workerId: workerId, runId: job.run_id,
                                      itemsCollected: items.count, error: nil)
            return CycleResult(claimedJob: true, itemsStreamed: items.count, connectorKey: job.connector_key)
        } catch {
            try? await worker.complete(workerId: workerId, runId: job.run_id,
                                       itemsCollected: 0, error: error.localizedDescription)
            throw error
        }
    }

    // -------------------------------------------------------------------------

    private static func runScreenTime(job: WorkerJob) async throws -> [WorkerStreamItem] {
        let backfillDays = job.config?["backfill_days"]?.intValue ?? 14
        let reader = KnowledgeKitReader()
        let usage = try reader.dailyAppUsage(days: backfillDays)
        return usage.map { row in
            let originId = "apple-screen-time:app:\(row.date):\(row.bundleID)"
            let minutes = Int((row.seconds / 60.0).rounded())
            return WorkerStreamItem(
                id: originId,
                title: "\(row.bundleID) — \(minutes) min on \(row.date)",
                payload_text: "Used \(row.bundleID) for \(minutes) min on \(row.date).",
                occurred_at: isoString(parseDate(row.date)),
                semantic_type: "screen_time_daily_app",
                metadata: [
                    "source": AnyEncodable("apple_screen_time"),
                    "origin_id": AnyEncodable(originId),
                    "date": AnyEncodable(row.date),
                    "bundle_id": AnyEncodable(row.bundleID),
                    "seconds": AnyEncodable(row.seconds),
                ]
            )
        }
    }

    private static func parseDate(_ yyyyMMdd: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: yyyyMMdd) ?? Date()
    }
}
