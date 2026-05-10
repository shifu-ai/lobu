import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var health = HealthKitManager()

    @AppStorage("lobuBaseURL") private var lobuBaseURL = "https://app.lobu.ai"
    @AppStorage("selectedOrgSlug") private var selectedOrgSlug = ""
    @AppStorage("backfillDays") private var backfillDays = 7
    @AppStorage("pendingOAuthLogin") private var pendingOAuthLoginData = Data()

    @State private var credentials: OAuthCredentials?
    @State private var isLoggingIn = false
    @State private var isSyncing = false
    @State private var loginCode: String?
    @State private var status = "Sign in to Lobu, authorize Health, then sync."
    @State private var lastUploadCount = 0

    private let credentialStore = KeychainCredentialStore()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init() {
        decoder.dateDecodingStrategy = .iso8601
        encoder.dateEncodingStrategy = .iso8601
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        Image("LobuLogo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 96, height: 96)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                        Text("Lobu iOS Bridge")
                            .font(.title2.bold())
                        Text("Connect iOS data sources to your personal Lobu organization. Apple Health is the first collector.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }

                Section("Lobu account") {
                    TextField("Base URL", text: $lobuBaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)

                    if let credentials {
                        LabeledContent("Signed in", value: credentials.displayName)
                        if let boundOrgSlug = credentials.userInfo?.organization_slug {
                            LabeledContent("Organization", value: orgName(for: boundOrgSlug, in: credentials.userInfo))
                        } else if credentials.userInfo?.organizations.isEmpty == false {
                            Picker("Organization", selection: $selectedOrgSlug) {
                                ForEach(credentials.userInfo?.organizations ?? []) { org in
                                    Text(org.name).tag(org.slug)
                                }
                            }
                        } else {
                            TextField("Org slug", text: $selectedOrgSlug)
                                .textInputAutocapitalization(.never)
                        }
                        Button("Sign out", role: .destructive) {
                            signOut()
                        }
                    } else {
                        Button(isLoggingIn ? "Waiting for approval…" : "Sign in with Lobu") {
                            Task { await signIn() }
                        }
                        .disabled(isLoggingIn)
                    }

                    if let loginCode {
                        LabeledContent("Login code", value: loginCode)
                        Button("I've approved — check now") {
                            Task { await resumePendingLogin() }
                        }
                        .disabled(isLoggingIn)
                    }
                }

                Section("Health permissions") {
                    LabeledContent("HealthKit", value: health.isHealthDataAvailable ? "Available" : "Unavailable")
                    LabeledContent("Status", value: health.authorizationStatus)
                    Button("Authorize Apple Health") {
                        Task { await authorizeHealth() }
                    }
                }

                Section("Apple Health sync") {
                    Stepper("Backfill \(backfillDays) days", value: $backfillDays, in: 1...30)
                    Button(isSyncing ? "Syncing…" : "Sync now") {
                        Task { await sync() }
                    }
                    .disabled(isSyncing || credentials == nil || selectedOrgSlug.isEmpty)
                    LabeledContent("Last upload", value: "\(lastUploadCount) events")
                }

                Section("Status") {
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Lobu iOS Bridge")
            .onAppear {
                credentials = credentialStore.load()
                if selectedOrgSlug.isEmpty {
                    selectedOrgSlug = credentials?.userInfo?.organization_slug ?? credentials?.userInfo?.organizations.first?.slug ?? ""
                }
                if credentials == nil, let pendingLogin = pendingLogin(), pendingLogin.expiresAt > Date() {
                    loginCode = pendingLogin.authorization.user_code
                    status = "Return here after approving code \(pendingLogin.authorization.user_code)."
                    Task { await resumePendingLogin() }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, credentials == nil, loginCode != nil {
                    Task { await resumePendingLogin() }
                }
            }
        }
    }

    private func orgName(for slug: String, in userInfo: OAuthUserInfo?) -> String {
        userInfo?.organizations.first(where: { $0.slug == slug })?.name ?? slug
    }

    private func signIn() async {
        isLoggingIn = true
        loginCode = nil
        defer { isLoggingIn = false }
        do {
            let oauth = try OAuthClient(baseURL: lobuBaseURL)
            status = "Discovering Lobu OAuth…"
            let discovery = try await oauth.discover()
            let client = try await oauth.registerClient(discovery)
            let authorization = try await oauth.startDeviceAuthorization(discovery, client: client)
            let pending = PendingOAuthLogin(
                discovery: discovery,
                client: client,
                authorization: authorization,
                createdAt: Date()
            )
            savePendingLogin(pending)
            loginCode = authorization.user_code
            status = "Approve the login in your browser. Code: \(authorization.user_code)"
            oauth.openVerificationURL(authorization)
            await completeLogin(pending)
        } catch is CancellationError {
            // The app may be suspended while Safari is in front. Keep the saved device code
            // so the user can return and tap "I've approved — check now".
        } catch {
            status = error.localizedDescription
        }
    }

    private func resumePendingLogin() async {
        guard !isLoggingIn, let pending = pendingLogin() else { return }
        guard pending.expiresAt > Date() else {
            clearPendingLogin()
            loginCode = nil
            status = "Login request expired. Try signing in again."
            return
        }
        isLoggingIn = true
        defer { isLoggingIn = false }
        await completeLogin(pending)
    }

    private func completeLogin(_ pending: PendingOAuthLogin) async {
        do {
            let oauth = try OAuthClient(baseURL: lobuBaseURL)
            var interval = max(pending.authorization.interval ?? 5, 1)
            while Date() < pending.expiresAt {
                switch try await oauth.pollDeviceToken(
                    pending.discovery,
                    client: pending.client,
                    deviceCode: pending.authorization.device_code
                ) {
                case let .pending(slowDown):
                    if slowDown { interval += 5 }
                    try await Task.sleep(for: .seconds(interval))
                case let .complete(tokens):
                    let userInfo = try await oauth.fetchUserInfo(
                        pending.discovery.userinfo_endpoint,
                        accessToken: tokens.access_token
                    )
                    let saved = OAuthCredentials(
                        baseURL: lobuBaseURL.trimmedTrailingSlash(),
                        clientID: pending.client.client_id,
                        clientSecret: pending.client.client_secret,
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        expiresAt: tokens.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) },
                        userInfo: userInfo
                    )
                    try credentialStore.save(saved)
                    credentials = saved
                    selectedOrgSlug = userInfo?.organization_slug ?? userInfo?.organizations.first?.slug ?? selectedOrgSlug
                    loginCode = nil
                    clearPendingLogin()
                    status = "Signed in to Lobu."
                    return
                }
            }
            clearPendingLogin()
            loginCode = nil
            status = "Login request expired. Try signing in again."
        } catch is CancellationError {
            // Keep pending login around for when the app returns to foreground.
        } catch {
            status = error.localizedDescription
        }
    }

    private func pendingLogin() -> PendingOAuthLogin? {
        guard !pendingOAuthLoginData.isEmpty else { return nil }
        return try? decoder.decode(PendingOAuthLogin.self, from: pendingOAuthLoginData)
    }

    private func savePendingLogin(_ pending: PendingOAuthLogin) {
        pendingOAuthLoginData = (try? encoder.encode(pending)) ?? Data()
    }

    private func clearPendingLogin() {
        pendingOAuthLoginData = Data()
    }

    private func signOut() {
        credentialStore.clear()
        clearPendingLogin()
        credentials = nil
        loginCode = nil
        selectedOrgSlug = ""
        status = "Signed out."
    }

    private func authorizeHealth() async {
        do {
            try await health.requestAuthorization()
            status = "Apple Health authorized."
        } catch {
            status = error.localizedDescription
        }
    }

    private func sync() async {
        isSyncing = true
        defer { isSyncing = false }
        do {
            guard var currentCredentials = credentials else { throw HealthBridgeError.missingConfiguration }
            let oauth = try OAuthClient(baseURL: currentCredentials.baseURL)
            if let expiresAt = currentCredentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
                currentCredentials = try await oauth.refresh(currentCredentials, discovery: try await oauth.discover())
                try credentialStore.save(currentCredentials)
                credentials = currentCredentials
            }

            let client = LobuClient(
                baseURL: currentCredentials.baseURL,
                orgSlug: selectedOrgSlug,
                accessToken: currentCredentials.accessToken
            )
            let (summaries, workouts) = try await health.summariesForLastDays(backfillDays)
            var uploaded = 0
            for summary in summaries {
                try await client.saveDailySummary(summary)
                uploaded += 1
            }
            for workout in workouts {
                try await client.saveWorkout(workout)
                uploaded += 1
            }
            lastUploadCount = uploaded
            status = "Uploaded \(uploaded) Apple Health events to Lobu."
        } catch {
            status = error.localizedDescription
        }
    }
}

#Preview {
    ContentView()
}
