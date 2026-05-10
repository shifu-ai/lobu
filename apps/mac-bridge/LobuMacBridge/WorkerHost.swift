import Foundation

/// Optional: hosts Lobu's connector-worker daemon (the Node-based worker that
/// runs server-side connectors like Gmail, Calendar, GitHub, RSS, etc.) as a
/// child process on the user's Mac. The daemon polls /api/workers/* itself,
/// using the user's OAuth bearer for auth — same protocol the Mac bridge's
/// Screen Time reader uses, just running standard connectors instead of
/// phone-bridged ones.
///
/// Spawning strategy: prefer a bundled `bun` binary at
/// `Bundle.main.resourceURL/bun` (ships ~80MB inside the .app), fall back to
/// whatever `bun` is on the user's PATH if they have it installed already.
/// The daemon process itself comes from the published @lobu/connector-worker
/// npm package which `bunx` will pull on first run.
final class WorkerHost {
    private(set) var pid: Int32?
    private var process: Process?
    private let logFile: URL

    init() {
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/LobuMacBridge", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        self.logFile = logs.appendingPathComponent("connector-worker.log")
    }

    enum HostError: LocalizedError {
        case bunNotFound
        case alreadyRunning
        case spawn(Error)
        var errorDescription: String? {
            switch self {
            case .bunNotFound: return "bun runtime not found (expected bundled at .app/Contents/Resources/bun or on $PATH)."
            case .alreadyRunning: return "Connector worker is already running."
            case let .spawn(err): return "Failed to spawn worker: \(err.localizedDescription)"
            }
        }
    }

    func start(apiURL: String, accessToken: String) throws {
        if process?.isRunning == true { throw HostError.alreadyRunning }

        let bunPath = locateBun()
        guard FileManager.default.isExecutableFile(atPath: bunPath) else {
            throw HostError.bunNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bunPath)
        proc.arguments = ["x", "@lobu/connector-worker", "daemon"]
        var env = ProcessInfo.processInfo.environment
        env["API_URL"] = apiURL
        env["WORKER_API_TOKEN"] = accessToken
        env["WORKER_ID"] = "mac-bridge-host-\(LobuWorkerIdentity.current())"
        proc.environment = env

        FileManager.default.createFile(atPath: logFile.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            proc.standardOutput = handle
            proc.standardError = handle
        }

        do {
            try proc.run()
            process = proc
            pid = proc.processIdentifier
            NSLog("[WorkerHost] started bun connector-worker (pid=\(pid ?? -1)) log=\(logFile.path)")
        } catch {
            throw HostError.spawn(error)
        }
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        process = nil
        pid = nil
        NSLog("[WorkerHost] stopped bun connector-worker")
    }

    /// Look for bun in three places, in order of preference:
    ///   1. Bundled binary inside the .app (production distribution)
    ///   2. ~/.bun/bin/bun (the official bun installer's default location)
    ///   3. /opt/homebrew/bin/bun (Homebrew install)
    /// Returns the first path that exists. Caller still checks executability.
    private func locateBun() -> String {
        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("bun").path
            if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        }
        let userBun = "\(NSHomeDirectory())/.bun/bin/bun"
        if FileManager.default.isExecutableFile(atPath: userBun) { return userBun }
        return "/opt/homebrew/bin/bun"
    }
}
