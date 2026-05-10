import Foundation

struct SaveMemoryPayload<Metadata: Encodable>: Encodable {
    let content: String
    let title: String
    let semantic_type: String
    let occurred_at: String
    let metadata: Metadata
}

struct DailyHealthMetadata: Encodable {
    let origin_id: String
    let source: String
    let sensitivity: String
    let date: String
    let start_at: String
    let end_at: String
    let steps: Double
    let distance_m: Double
    let active_energy_kcal: Double
    let exercise_minutes: Double
    let resting_heart_rate_bpm: Double?
}

struct WorkoutMetadata: Encodable {
    let origin_id: String
    let source: String
    let sensitivity: String
    let workout_type: String
    let start_at: String
    let end_at: String
    let duration_s: Double
    let active_energy_kcal: Double?
    let distance_m: Double?
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

    func saveDailySummary(_ summary: DailyHealthSummary) async throws {
        let payload = SaveMemoryPayload(
            content: summary.summaryText,
            title: summary.title,
            semantic_type: "summary",
            occurred_at: isoString(summary.startAt),
            metadata: DailyHealthMetadata(
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
                resting_heart_rate_bpm: summary.restingHeartRateBpm
            )
        )
        try await postSaveMemory(payload)
    }

    func saveWorkout(_ workout: WorkoutSummary) async throws {
        let payload = SaveMemoryPayload(
            content: workout.summaryText,
            title: workout.title,
            semantic_type: "event",
            occurred_at: isoString(workout.startAt),
            metadata: WorkoutMetadata(
                origin_id: workout.originID,
                source: "apple_health",
                sensitivity: "health",
                workout_type: workout.workoutType,
                start_at: isoString(workout.startAt),
                end_at: isoString(workout.endAt),
                duration_s: workout.durationSeconds,
                active_energy_kcal: workout.activeEnergyKilocalories,
                distance_m: workout.distanceMeters
            )
        )
        try await postSaveMemory(payload)
    }

    private func postSaveMemory<Metadata: Encodable>(_ payload: SaveMemoryPayload<Metadata>) async throws {
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/save_memory") else {
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
