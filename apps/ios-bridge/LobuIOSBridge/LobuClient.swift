import Foundation

struct AppleHealthIngestPayload: Encodable {
    let daily_summaries: [AppleHealthIngestItem]
    let workouts: [AppleHealthIngestItem]
}

struct AppleHealthIngestItem: Encodable {
    let origin_id: String
    let title: String
    let content: String
    let occurred_at: String
    let metadata: AppleHealthMetadata
}

struct AppleHealthMetadata: Encodable {
    let origin_id: String
    let source: String
    let sensitivity: String
    let date: String?
    let start_at: String
    let end_at: String
    let steps: Double?
    let distance_m: Double?
    let active_energy_kcal: Double?
    let exercise_minutes: Double?
    let resting_heart_rate_bpm: Double?
    let workout_type: String?
    let duration_s: Double?
}

final class LobuClient {
    private let baseURL: String
    private let orgSlug: String
    private let accessToken: String
    private let session: URLSession
    private let encoder: JSONEncoder

    init(baseURL: String, orgSlug: String, accessToken: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.orgSlug = orgSlug
        self.accessToken = accessToken
        self.session = session
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
    }

    func uploadAppleHealth(dailySummaries: [DailyHealthSummary], workouts: [WorkoutSummary]) async throws {
        let payload = AppleHealthIngestPayload(
            daily_summaries: dailySummaries.map { summary in
                AppleHealthIngestItem(
                    origin_id: summary.originID,
                    title: summary.title,
                    content: summary.summaryText,
                    occurred_at: isoString(summary.startAt),
                    metadata: AppleHealthMetadata(
                        origin_id: summary.originID,
                        source: "apple_health",
                        sensitivity: "health",
                        date: summary.date,
                        start_at: isoString(summary.startAt),
                        end_at: isoString(summary.endAt),
                        steps: summary.steps,
                        distance_m: summary.distanceMeters,
                        active_energy_kcal: summary.activeEnergyKilocalories,
                        exercise_minutes: summary.exerciseMinutes,
                        resting_heart_rate_bpm: summary.restingHeartRateBpm,
                        workout_type: nil,
                        duration_s: nil
                    )
                )
            },
            workouts: workouts.map { workout in
                AppleHealthIngestItem(
                    origin_id: workout.originID,
                    title: workout.title,
                    content: workout.summaryText,
                    occurred_at: isoString(workout.startAt),
                    metadata: AppleHealthMetadata(
                        origin_id: workout.originID,
                        source: "apple_health",
                        sensitivity: "health",
                        date: nil,
                        start_at: isoString(workout.startAt),
                        end_at: isoString(workout.endAt),
                        steps: nil,
                        distance_m: workout.distanceMeters,
                        active_energy_kcal: workout.activeEnergyKilocalories,
                        exercise_minutes: nil,
                        resting_heart_rate_bpm: nil,
                        workout_type: workout.workoutType,
                        duration_s: workout.durationSeconds
                    )
                )
            }
        )
        try await postAppleHealthIngest(payload)
    }

    private func postAppleHealthIngest(_ payload: AppleHealthIngestPayload) async throws {
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/apple-health/ingest") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? httpResponse.description
            throw LobuClientError.uploadFailed(statusCode: httpResponse.statusCode, body: body)
        }
    }
}

enum LobuClientError: LocalizedError {
    case uploadFailed(statusCode: Int, body: String)

    var errorDescription: String? {
        switch self {
        case let .uploadFailed(statusCode, body):
            return "Lobu upload failed (\(statusCode)): \(body)"
        }
    }
}

func isoString(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

extension String {
    func trimmedTrailingSlash() -> String {
        var value = self
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}
