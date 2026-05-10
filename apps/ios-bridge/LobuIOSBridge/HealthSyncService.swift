import Foundation

struct HealthSyncResult: Equatable {
    let dailySummaryCount: Int
    let workoutCount: Int
    let uploadedCount: Int
}

@MainActor
enum HealthSyncService {
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
        guard var credentials = credentialStore.load() else { throw HealthBridgeError.missingConfiguration }
        let orgSlug = resolvedOrgSlug(credentials)
        guard !orgSlug.isEmpty else { throw HealthBridgeError.missingConfiguration }

        let oauth = try OAuthClient(baseURL: credentials.baseURL)
        if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
            credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
            try credentialStore.save(credentials)
        }

        let client = LobuClient(
            baseURL: credentials.baseURL,
            orgSlug: orgSlug,
            accessToken: credentials.accessToken
        )
        let backfillDays = clampedBackfillDays(requestedBackfillDays)
        let (summaries, workouts) = try await healthManager.summariesForLastDays(backfillDays)
        var uploaded = 0
        for summary in summaries {
            try await client.saveDailySummary(summary)
            uploaded += 1
        }
        for workout in workouts {
            try await client.saveWorkout(workout)
            uploaded += 1
        }
        return HealthSyncResult(
            dailySummaryCount: summaries.count,
            workoutCount: workouts.count,
            uploadedCount: uploaded
        )
    }

    static func resolvedOrgSlug(_ credentials: OAuthCredentials) -> String {
        credentials.userInfo?.organization_slug
            ?? UserDefaults.standard.string(forKey: "selectedOrgSlug")
            ?? credentials.userInfo?.organizations.first?.slug
            ?? ""
    }

    static func clampedBackfillDays(_ requestedBackfillDays: Int? = nil) -> Int {
        let value = requestedBackfillDays ?? UserDefaults.standard.integer(forKey: "backfillDays")
        return min(max(value == 0 ? 7 : value, 1), 30)
    }
}
