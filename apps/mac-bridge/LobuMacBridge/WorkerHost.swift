import Foundation

/// Optional: hosts Lobu's connector-worker daemon (the Node-based worker that
/// runs server-side connectors like Gmail, GitHub, RSS, etc.) as a child
/// process on the user's Mac. The daemon polls /api/workers/* itself, using
/// the user's OAuth bearer for auth — same protocol the Mac bridge's Screen
/// Time reader uses, just running standard connectors instead of phone-
/// bridged ones.
///
/// The daemon ships from this monorepo's @lobu/connector-worker package, NOT
/// from npm (the package is intentionally private). Two locations to find it:
///   1. Bundled at Bundle.main.resourceURL/connector-worker/dist/bin.js
///      (production distribution — copied in by the release pipeline)
///   2. Dev fallback: env LOBU_REPO_ROOT/packages/connector-worker/dist/bin.js
///      (set the env var when launching from Xcode for local iteration)
///
/// bun is found in this order: bundled binary → ~/.bun/bin/bun → Homebrew.
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
        case daemonNotFound(String)
        case alreadyRunning
        case spawn(Error)
        var errorDescription: String? {
            switch self {
            case .bunNotFound:
                return "bun runtime not found. Install via `curl -fsSL https://bun.sh/install | bash` or bundle it in the .app."
            case let .daemonNotFound(path):
                return "Connector-worker daemon not found at \(path). For dev, set LOBU_REPO_ROOT to the repo root before launching."
            case .alreadyRunning:
                return "Connector worker is already running."
            case let .spawn(err):
                return "Failed to spawn worker: \(err.localizedDescription)"
            }
        }
    }

    func start(apiURL: String, accessToken: String) throws {
        if process?.isRunning == true { throw HostError.alreadyRunning }

        let bunPath = locateBun()
        guard FileManager.default.isExecutableFile(atPath: bunPath) else {
            throw HostError.bunNotFound
        }
        let daemonPath = try locateDaemon()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bunPath)
        proc.arguments = ["run", daemonPath, "daemon"]
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
            NSLog("[WorkerHost] started \(bunPath) run \(daemonPath) (pid=\(pid ?? -1)) log=\(logFile.path)")
        } catch {
            throw HostError.spawn(error)
        }
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        process = nil
        pid = nil
        NSLog("[WorkerHost] stopped connector-worker")
    }

    private func locateBun() -> String {
        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("bun").path
            if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        }
        let userBun = "\(NSHomeDirectory())/.bun/bin/bun"
        if FileManager.default.isExecutableFile(atPath: userBun) { return userBun }
        return "/opt/homebrew/bin/bun"
    }

    private func locateDaemon() throws -> String {
        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("connector-worker/dist/bin.js").path
            if FileManager.default.fileExists(atPath: bundled) { return bundled }
        }
        if let repoRoot = ProcessInfo.processInfo.environment["LOBU_REPO_ROOT"] {
            let devPath = "\(repoRoot)/packages/connector-worker/dist/bin.js"
            if FileManager.default.fileExists(atPath: devPath) { return devPath }
            throw HostError.daemonNotFound(devPath)
        }
        throw HostError.daemonNotFound("(bundled or $LOBU_REPO_ROOT)")
    }
}
