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

    init() {
        credentials = credentialStore.load()
    }

    var displayName: String {
        credentials?.displayName ?? "Not signed in"
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
        credentialStore.clear()
        credentials = nil
        loginCode = nil
        setStatus("Signed out.")
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
