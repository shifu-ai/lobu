import Foundation

// =============================================================================
// Worker protocol client
//
// Talks to /api/workers/{poll,heartbeat,stream,complete} on a Lobu server.
// Auth: the user's existing OAuth access token (Bearer). The server's
// /api/workers/* middleware accepts user OAuth and treats this app as a
// user-scoped worker — runs are filtered to orgs the user belongs to and the
// app advertises the `healthkit` capability so it only ever claims
// apple.health jobs.
// =============================================================================

/// Stable per-install worker identifier. Stored in UserDefaults so the same
/// device claims runs under one identity across launches.
enum LobuWorkerIdentity {
    private static let key = "lobu.workerId"

    static func current() -> String {
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let generated = "ios-bridge-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(generated, forKey: key)
        return generated
    }
}

/// A claimed worker job. Mirrors the relevant subset of the poll response.
struct WorkerJob: Decodable {
    let run_id: Int
    let run_type: String?
    let connector_key: String
    let feed_key: String?
    let feed_id: Int?
    let connection_id: Int?
    let config: [String: AnyJSONValue]?
    let checkpoint: [String: AnyJSONValue]?
}

/// Lazy decode container for arbitrary JSON values from server responses.
/// We only inspect a few config keys (e.g. `backfill_days`), so a thin
/// representation is enough — no need for a full JSON value type.
enum AnyJSONValue: Decodable {
    case integer(Int)
    case double(Double)
    case string(String)
    case bool(Bool)
    case null
    case other

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Int.self) {
            self = .integer(v)
        } else if let v = try? c.decode(Double.self) {
            self = .double(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else {
            self = .other
        }
    }

    var intValue: Int? {
        switch self {
        case let .integer(v): return v
        case let .double(v): return Int(v)
        case let .string(s): return Int(s)
        default: return nil
        }
    }
}

/// A single event the worker is streaming back. Field names mirror
/// /api/workers/stream's `items[]` schema.
struct WorkerStreamItem: Encodable {
    let id: String
    let title: String?
    let payload_text: String
    let occurred_at: String
    let semantic_type: String
    let metadata: [String: AnyEncodable]
}

/// Erased Encodable for the metadata bag (mixed Double/Int/String/null values
/// per event kind). Avoids leaking @Codable plumbing into the connector code.
struct AnyEncodable: Encodable {
    private let encodeImpl: (Encoder) throws -> Void

    init<T: Encodable>(_ value: T) {
        self.encodeImpl = value.encode(to:)
    }

    init(_ value: Any?) {
        switch value {
        case nil, is NSNull:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encodeNil()
            }
        case let v as String:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encode(v)
            }
        case let v as Bool:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encode(v)
            }
        case let v as Int:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encode(v)
            }
        case let v as Double:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encode(v)
            }
        default:
            self.encodeImpl = { encoder in
                var c = encoder.singleValueContainer()
                try c.encode(String(describing: value ?? ""))
            }
        }
    }

    func encode(to encoder: Encoder) throws { try encodeImpl(encoder) }
}

/// Result of completing a worker run cycle (for UI surfacing).
struct WorkerCycleResult {
    let claimed: Bool
    let runId: Int?
    let connectorKey: String?
    let feedKey: String?
    let itemsStreamed: Int
    let status: String
    let nextPollSeconds: Int?
}

enum WorkerClientError: LocalizedError {
    case http(String, Int, String)
    case decode(String)

    var errorDescription: String? {
        switch self {
        case let .http(path, code, body):
            return "Worker \(path) failed (\(code)): \(body)"
        case let .decode(message):
            return "Worker response decode failed: \(message)"
        }
    }
}

/// HTTP client wrapping the four worker endpoints used by phone-bridge workers.
final class WorkerClient {
    private let baseURL: String
    private let accessToken: String
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: String, accessToken: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.session = session
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
        self.decoder = JSONDecoder()
    }

    /// POST /api/workers/poll. Returns either a claimed job or a hint of how
    /// long to wait before polling again.
    func poll(workerId: String, capabilities: [String: Bool]) async throws
        -> (job: WorkerJob?, nextPollSeconds: Int?)
    {
        struct Body: Encodable {
            let worker_id: String
            let capabilities: [String: Bool]
        }
        let data = try await post(
            "/api/workers/poll",
            body: Body(worker_id: workerId, capabilities: capabilities)
        )
        struct Empty: Decodable {
            let next_poll_seconds: Int?
        }
        if let job = try? decoder.decode(WorkerJob.self, from: data) {
            return (job, nil)
        }
        if let empty = try? decoder.decode(Empty.self, from: data) {
            return (nil, empty.next_poll_seconds)
        }
        let body = String(data: data, encoding: .utf8) ?? "<binary>"
        throw WorkerClientError.decode("/poll body=\(body)")
    }

    /// POST /api/workers/heartbeat. Tells the server the worker is still
    /// processing — keeps the run from being reaped.
    func heartbeat(workerId: String, runId: Int, itemsSoFar: Int) async throws {
        struct Body: Encodable {
            let run_id: Int
            let worker_id: String
            let progress: Progress
            struct Progress: Encodable {
                let items_collected_so_far: Int
            }
        }
        _ = try await post(
            "/api/workers/heartbeat",
            body: Body(
                run_id: runId,
                worker_id: workerId,
                progress: .init(items_collected_so_far: itemsSoFar)
            )
        )
    }

    /// POST /api/workers/stream. Pushes a batch of events for a run; server
    /// validates each event's semantic_type against the connector definition.
    func stream(runId: Int, items: [WorkerStreamItem]) async throws {
        struct Body: Encodable {
            let type: String
            let run_id: Int
            let items: [WorkerStreamItem]
        }
        _ = try await post(
            "/api/workers/stream",
            body: Body(type: "batch", run_id: runId, items: items)
        )
    }

    /// POST /api/workers/complete. Marks the run done (success or failed).
    func complete(workerId: String, runId: Int, itemsCollected: Int, error: String?) async throws {
        struct Body: Encodable {
            let run_id: Int
            let worker_id: String
            let status: String
            let items_collected: Int
            let error_message: String?
        }
        _ = try await post(
            "/api/workers/complete",
            body: Body(
                run_id: runId,
                worker_id: workerId,
                status: error == nil ? "success" : "failed",
                items_collected: itemsCollected,
                error_message: error
            )
        )
    }

    // -------------------------------------------------------------------------

    private func post<T: Encodable>(_ path: String, body: T) async throws -> Data {
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())\(path)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let bodyString = String(data: data, encoding: .utf8) ?? "<binary>"
            throw WorkerClientError.http(path, httpResponse.statusCode, bodyString)
        }
        return data
    }
}

// =============================================================================
// Shared helpers
// =============================================================================

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
