import Combine
import Foundation

/// Top-level observable state for the menu bar app. One source of truth for
/// sign-in status, sync state, last result, and worker-host toggle.
@MainActor
final class AppState: ObservableObject {
    @Published var credentials: OAuthCredentials?
    @Published var isLoggingIn: Bool = false
    @Published var loginCode: String?
    @Published var status: String = ""
    @Published var isSyncing: Bool = false
    @Published var lastSyncSummary: String = ""
    @Published var workerHostRunning: Bool = false
    @Published var workerHostStatus: String = "Stopped"
    @Published var baseURL: String = {
        UserDefaults.standard.string(forKey: "lobuBaseURL")
            ?? "https://buraks-macbook-pro-1.brill-kanyu.ts.net:8443"
    }()

    private let credentialStore = KeychainCredentialStore()
    private let workerHost = WorkerHost()

    /// Background poll timer. Drives the connector loop on its own cadence so
    /// the user never has to tap Sync now manually. Cadence matches a typical
    /// connector schedule — once every 10 min — which is fast enough for
    /// Screen Time and slow enough to be a non-issue for battery / DB.
    private var pollTimer: Timer?
    private static let autoPollInterval: TimeInterval = 600  // 10 min

    init() {
        credentials = credentialStore.load()
        startAutoPollIfSignedIn()
    }

    var displayName: String {
        credentials?.displayName ?? "Not signed in"
    }

    /// The org the user picked when approving the OAuth device login. OAuth
    /// metadata carries it on userInfo.organization_slug; we map back to the
    /// human name from the embedded organizations list. Falls back to the slug
    /// when the org isn't enumerated (rare — happens for cross-org tokens).
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

    func setBaseURL(_ value: String) {
        baseURL = value
        UserDefaults.standard.set(value, forKey: "lobuBaseURL")
    }

    // MARK: Sign in / out --------------------------------------------------------

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
        if workerHostRunning { stopWorkerHost() }
        stopAutoPoll()
        credentialStore.clear()
        credentials = nil
        loginCode = nil
        setStatus("Signed out.")
    }

    // MARK: Auto-poll ------------------------------------------------------------

    private func startAutoPollIfSignedIn() {
        guard credentials != nil, pollTimer == nil else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.autoPollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.isSyncing else { return }
                await self.syncNow()
            }
        }
        // Fire one immediately so we don't make the user wait the full interval
        // on first launch.
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

    // MARK: Sync now -------------------------------------------------------------

    func syncNow() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let result = try await ScreenTimeSyncService.runOneCycle(baseURL: baseURL)
            if result.claimedJob {
                lastSyncSummary = "Streamed \(result.itemsStreamed) Screen Time events."
                setStatus(lastSyncSummary)
            } else {
                setStatus("No pending Screen Time runs — scheduler will queue next when due.")
            }
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    // MARK: Worker host toggle ---------------------------------------------------

    func startWorkerHost() {
        guard let credentials else {
            setStatus("Sign in first to host the connector worker.")
            return
        }
        do {
            try workerHost.start(apiURL: credentials.baseURL, accessToken: credentials.accessToken)
            workerHostRunning = true
            workerHostStatus = "Running (PID \(workerHost.pid ?? -1))"
        } catch {
            setStatus("Could not start worker host: \(error.localizedDescription)")
        }
    }

    func stopWorkerHost() {
        workerHost.stop()
        workerHostRunning = false
        workerHostStatus = "Stopped"
    }

    // MARK: -

    private func setStatus(_ message: String) {
        status = message
        NSLog("[LobuMacBridge] \(message)")
    }
}
