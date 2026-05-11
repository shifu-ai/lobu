import Combine
import Foundation

// MARK: - Recent job record --------------------------------------------------

struct RecentJob: Codable {
    let connectorKey: String
    let runId: Int
    let itemsStreamed: Int
    let finishedAt: Date
    var displayLabel: String {
        switch connectorKey {
        case "apple.screen_time": return "Screen Time"
        case "local.directory":   return "Local folder"
        default:                  return connectorKey
        }
    }
    var timeAgoString: String {
        let secs = Int(-finishedAt.timeIntervalSinceNow)
        if secs < 60 { return "\(secs) sec ago" }
        let mins = secs / 60
        if mins < 60 { return "\(mins) min ago" }
        let hrs = mins / 60
        return "\(hrs) h ago"
    }
}

// MARK: - AppState ------------------------------------------------------------

/// Top-level observable state for the menu bar app. One source of truth for
/// sign-in status, sync state, last result, worker-host toggle, and integrations.
@MainActor
final class AppState: ObservableObject {
    @Published var credentials: OAuthCredentials?
    @Published var isLoggingIn: Bool = false
    @Published var loginCode: String?
    @Published var status: String = ""
    @Published var isSyncing: Bool = false
    @Published var lastPollDate: Date?
    @Published var lastPollSuccess: Bool = true
    @Published var recentJobs: [RecentJob] = []

    // Integrations state
    @Published var hasFDA: Bool = false
    @Published var localFolderBookmarks: [Data] = []

    @Published var baseURL: String = {
        UserDefaults.standard.string(forKey: "lobuBaseURL")
            ?? "https://app.lobu.ai"
    }()

    private let credentialStore = KeychainCredentialStore()

    /// Background poll timer.
    private var pollTimer: Timer?
    private static let autoPollInterval: TimeInterval = 600  // 10 min
    private static let recentJobsKey = "lobu.recentJobs"
    private static let folderBookmarksKey = "lobu.localFolderBookmarks"

    init() {
        credentials = credentialStore.load()
        loadPersistedState()
        refreshFDAStatus()
        startAutoPollIfSignedIn()
    }

    var displayName: String {
        credentials?.displayName ?? "Not signed in"
    }

    var activeOrgName: String? {
        guard let info = credentials?.userInfo else { return nil }
        let slug = info.organization_slug
        guard let chosenSlug = slug, !chosenSlug.isEmpty else {
            return info.organizations.first?.name
        }
        if let match = info.organizations.first(where: { $0.slug == chosenSlug }) {
            return match.name
        }
        return chosenSlug
    }

    /// The org slug runs land in (the user's personal org — that's where the
    /// auto-wired connectors live). Used to build "open this run" links.
    private var personalOrgSlug: String? {
        guard let info = credentials?.userInfo else { return nil }
        if let slug = info.organization_slug, !slug.isEmpty { return slug }
        return info.organizations.first?.slug
    }

    /// Web URL for a recent job's connector, with the run id so the page can
    /// focus it. nil when we don't know the org slug yet.
    func recentJobURL(_ job: RecentJob) -> URL? {
        guard let slug = personalOrgSlug, !slug.isEmpty else { return nil }
        var base = baseURL
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/\(slug)/connectors/\(job.connectorKey)?run=\(job.runId)")
    }

    func setBaseURL(_ value: String) {
        baseURL = value
        UserDefaults.standard.set(value, forKey: "lobuBaseURL")
    }

    // MARK: - Status line -------------------------------------------------------

    var connectionStatusLabel: String {
        guard credentials != nil else { return "Sign in to connect" }
        guard let lastPoll = lastPollDate else { return "Connecting…" }
        if !lastPollSuccess { return "Sync failed — see details" }
        let secs = Int(-lastPoll.timeIntervalSinceNow)
        if secs < 60 { return "Connected · last poll \(secs)s ago" }
        let mins = secs / 60
        return "Idle · last poll \(mins)m ago"
    }

    // MARK: - Capabilities -------------------------------------------------------

    /// Capabilities advertised on the next poll.
    var currentCapabilities: [String: Bool] {
        var caps: [String: Bool] = [:]
        if hasFDA { caps["screentime"] = true }
        if !localFolderBookmarks.isEmpty { caps["local_directory"] = true }
        return caps
    }

    // MARK: - Sign in / out -----------------------------------------------------

    func signIn() async {
        isLoggingIn = true
        loginCode = nil
        defer { isLoggingIn = false }
        do {
            let oauth = try OAuthClient(baseURL: baseURL)
            setStatus("Discovering Lobu OAuth…")
            let discovery = try await oauth.discover()
            let client = try await oauth.registerClient(discovery)
            let authorization = try await oauth.startDeviceAuthorization(discovery, client: client)
            loginCode = authorization.user_code
            setStatus("Approve the login in your browser. Code: \(authorization.user_code)")
            oauth.openVerificationURL(authorization)

            var interval = max(authorization.interval ?? 5, 1)
            while Date() < authorization.expiresAt {
                switch try await oauth.pollDeviceToken(discovery, client: client, deviceCode: authorization.device_code) {
                case let .pending(slowDown):
                    if slowDown { interval += 5 }
                    try await Task.sleep(for: .seconds(interval))
                case let .complete(tokens):
                    let userInfo = try await oauth.fetchUserInfo(discovery.userinfo_endpoint, accessToken: tokens.access_token)
                    let saved = OAuthCredentials(
                        baseURL: baseURL.trimmedTrailingSlash(),
                        clientID: client.client_id,
                        clientSecret: client.client_secret,
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        expiresAt: tokens.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) },
                        userInfo: userInfo
                    )
                    try credentialStore.save(saved)
                    credentials = saved
                    loginCode = nil
                    setStatus("Signed in.")
                    startAutoPollIfSignedIn()
                    return
                }
            }
            setStatus("Login request expired before approval.")
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    func signOut() {
        stopAutoPoll()
        credentialStore.clear()
        credentials = nil
        loginCode = nil
        lastPollDate = nil
        lastPollSuccess = true
        setStatus("Signed out.")
    }

    // MARK: - Auto-poll ---------------------------------------------------------

    private func startAutoPollIfSignedIn() {
        guard credentials != nil, pollTimer == nil else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.autoPollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.isSyncing else { return }
                await self.syncNow()
            }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(2))
            if !self.isSyncing { await self.syncNow() }
        }
    }

    private func stopAutoPoll() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Sync now ----------------------------------------------------------

    func syncNow() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        refreshFDAStatus()
        do {
            let result = try await SyncDispatcher.runOneCycle(
                baseURL: baseURL,
                capabilities: currentCapabilities
            )
            lastPollDate = Date()
            lastPollSuccess = true
            if result.claimedJob, let key = result.connectorKey, let runId = result.runId {
                let job = RecentJob(
                    connectorKey: key,
                    runId: runId,
                    itemsStreamed: result.itemsStreamed,
                    finishedAt: Date()
                )
                appendRecentJob(job)
                setStatus("Synced \(result.itemsStreamed) items from \(job.displayLabel).")
            } else {
                setStatus("Connected. Waiting for sync jobs.")
            }
        } catch {
            lastPollDate = Date()
            lastPollSuccess = false
            setStatus(error.localizedDescription)
        }
    }

    // MARK: - Recent jobs -------------------------------------------------------

    private func appendRecentJob(_ job: RecentJob) {
        recentJobs.insert(job, at: 0)
        if recentJobs.count > 10 { recentJobs = Array(recentJobs.prefix(10)) }
        persistRecentJobs()
    }

    private func persistRecentJobs() {
        if let data = try? JSONEncoder().encode(recentJobs) {
            UserDefaults.standard.set(data, forKey: Self.recentJobsKey)
        }
    }

    // MARK: - Local folder bookmarks -------------------------------------------

    func addFolderBookmark(url: URL) {
        guard (try? url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)) != nil else { return }
        do {
            let bookmark = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
            localFolderBookmarks.append(bookmark)
            persistBookmarks()
            setStatus("Folder added. Lobu will sync supported text files from it.")
        } catch {
            setStatus("Could not bookmark folder: \(error.localizedDescription)")
        }
    }

    func removeFolderBookmark(at index: Int) {
        guard localFolderBookmarks.indices.contains(index) else { return }
        localFolderBookmarks.remove(at: index)
        persistBookmarks()
        setStatus("Folder removed.")
    }

    private func persistBookmarks() {
        UserDefaults.standard.set(localFolderBookmarks, forKey: Self.folderBookmarksKey)
    }

    /// Resolve a bookmark to a display URL (best-effort; not security-scoped access).
    func resolvedURLForBookmark(at index: Int) -> URL? {
        guard localFolderBookmarks.indices.contains(index) else { return nil }
        var isStale = false
        return try? URL(resolvingBookmarkData: localFolderBookmarks[index],
                        options: .withSecurityScope, relativeTo: nil,
                        bookmarkDataIsStale: &isStale)
    }

    // MARK: - Full Disk Access -------------------------------------------------

    func refreshFDAStatus() {
        let path = "\(NSHomeDirectory())/Library/Application Support/Knowledge/knowledgeC.db"
        // Actually *open* the file rather than stat it. A real open() is what
        // makes macOS register this app in System Settings → Privacy & Security
        // → Full Disk Access (so the user just flips a toggle, no "+" digging).
        // `fileExists` / `isReadableFile` don't count as "access" and never
        // surface the app in that list.
        if let handle = FileHandle(forReadingAtPath: path) {
            try? handle.close()
            hasFDA = true
        } else {
            hasFDA = false
        }
    }

    // MARK: - Persistence helpers ----------------------------------------------

    private func loadPersistedState() {
        if let data = UserDefaults.standard.data(forKey: Self.recentJobsKey),
           let jobs = try? JSONDecoder().decode([RecentJob].self, from: data) {
            recentJobs = jobs
        }
        if let bookmarks = UserDefaults.standard.array(forKey: Self.folderBookmarksKey) as? [Data] {
            localFolderBookmarks = bookmarks
        }
    }

    // MARK: -

    private func setStatus(_ message: String) {
        status = message
        NSLog("[LobuMacBridge] \(message)")
    }
}

// MARK: - SyncDispatcher -------------------------------------------------------

/// Dispatches a single poll cycle, routing the claimed job to the appropriate
/// sync service based on connector_key.
@MainActor
enum SyncDispatcher {
    struct CycleResult {
        let claimedJob: Bool
        let itemsStreamed: Int
        let connectorKey: String?
        let runId: Int?
    }

    static func runOneCycle(baseURL: String, capabilities: [String: Bool]) async throws -> CycleResult {
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

        let (job, _) = try await worker.poll(workerId: workerId, capabilities: capabilities)
        guard let job else {
            return CycleResult(claimedJob: false, itemsStreamed: 0, connectorKey: nil, runId: nil)
        }

        do {
            let items: [WorkerStreamItem]
            switch job.connector_key {
            case "apple.screen_time":
                items = try await ScreenTimeSyncService.runScreenTime(job: job)
            case "local.directory":
                items = try LocalDirectorySyncService.runLocalDirectory(job: job)
            default:
                try await worker.complete(workerId: workerId, runId: job.run_id, itemsCollected: 0,
                                          error: "Mac bridge cannot run connector \(job.connector_key)")
                return CycleResult(claimedJob: true, itemsStreamed: 0, connectorKey: job.connector_key, runId: job.run_id)
            }

            if !items.isEmpty {
                try await worker.stream(runId: job.run_id, items: items)
            }
            try await worker.complete(workerId: workerId, runId: job.run_id,
                                      itemsCollected: items.count, error: nil)
            return CycleResult(claimedJob: true, itemsStreamed: items.count, connectorKey: job.connector_key, runId: job.run_id)
        } catch {
            try? await worker.complete(workerId: workerId, runId: job.run_id,
                                       itemsCollected: 0, error: error.localizedDescription)
            throw error
        }
    }
}
