import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase

    // Data source managers — one per supported connector.
    @StateObject private var health = HealthKitManager()
    @StateObject private var calendar = CalendarManager()
    @StateObject private var reminders = RemindersManager()
    @StateObject private var contacts = ContactsManager()

    @AppStorage("lobuBaseURL") private var lobuBaseURL = "https://app.lobu.ai"
    @AppStorage("selectedOrgSlug") private var selectedOrgSlug = ""
    @AppStorage("backfillDays") private var backfillDays = 7
    @AppStorage("pendingOAuthLogin") private var pendingOAuthLoginData = Data()
    @AppStorage("healthAuthorizationRequested") private var healthAuthorizationRequested = false

    @State private var credentials: OAuthCredentials?
    @State private var isLoggingIn = false
    @State private var isSyncing = false
    @State private var loginCode: String?
    @State private var status = ""
    @State private var showSettings = false

    private let credentialStore = KeychainCredentialStore()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    private var clampedBackfillDays: Int {
        min(max(backfillDays, 1), 30)
    }

    init() {
        decoder.dateDecodingStrategy = .iso8601
        encoder.dateEncodingStrategy = .iso8601
    }

    var body: some View {
        NavigationStack {
            Form {
                heroSection
                accountSection
                if credentials != nil {
                    dataSourcesSection
                    syncSection
                }
                settingsDisclosure
                if !status.isEmpty {
                    Section { Text(status).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Lobu iOS Bridge")
            .onAppear(perform: handleAppear)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    refreshAllPermissions()
                    if credentials == nil, loginCode != nil {
                        Task { await resumePendingLogin() }
                    }
                }
            }
            .onOpenURL(perform: handleDeepLink)
        }
    }

    // -------------------------------------------------------------------------
    // Sections
    // -------------------------------------------------------------------------

    @ViewBuilder
    private var heroSection: some View {
        Section {
            VStack(spacing: 8) {
                Image("LobuLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                Text("Lobu iOS Bridge")
                    .font(.title3.bold())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let credentials {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(credentials.displayName).font(.body)
                        if let orgName = currentOrgName(in: credentials.userInfo) {
                            Text(orgName).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Sign out", role: .destructive, action: signOut)
                        .buttonStyle(.borderless)
                        .font(.footnote)
                }
            } else {
                Button(isLoggingIn ? "Waiting for approval…" : "Sign in with Lobu") {
                    Task { await signIn() }
                }
                .disabled(isLoggingIn)
                if let loginCode {
                    HStack {
                        Text("Code").foregroundStyle(.secondary)
                        Spacer()
                        Text(loginCode).monospaced()
                    }
                    Button("I've approved — check now") {
                        Task { await resumePendingLogin() }
                    }
                    .disabled(isLoggingIn)
                }
            }
        }
    }

    @ViewBuilder
    private var dataSourcesSection: some View {
        Section("Data sources") {
            ForEach(DataSourceCatalog.all) { descriptor in
                Button {
                    Task { await authorize(descriptor) }
                } label: {
                    HStack {
                        Text(descriptor.label)
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(permissionLabel(for: descriptor))
                            .foregroundStyle(permissionLabelColor(for: descriptor))
                            .font(.footnote)
                        Image(systemName: "chevron.right")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var syncSection: some View {
        Section {
            Button(isSyncing ? "Syncing…" : "Sync now") {
                Task { await sync() }
            }
            .disabled(isSyncing || credentials == nil || managersBag.advertisedCapabilities.isEmpty)
        }
    }

    @ViewBuilder
    private var settingsDisclosure: some View {
        Section {
            DisclosureGroup("Settings", isExpanded: $showSettings) {
                TextField("Base URL", text: $lobuBaseURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .disabled(credentials != nil)
                Stepper(
                    "Backfill \(clampedBackfillDays) days",
                    value: Binding(get: { clampedBackfillDays }, set: { backfillDays = min(max($0, 1), 30) }),
                    in: 1...30
                )
            }
        }
    }

    // -------------------------------------------------------------------------
    // Permission helpers
    // -------------------------------------------------------------------------

    private var managersBag: DataSourceManagers {
        DataSourceManagers(health: health, calendar: calendar, reminders: reminders, contacts: contacts)
    }

    private func permission(for descriptor: DataSourceDescriptor) -> DataSourcePermission {
        switch descriptor.capability {
        case "healthkit":
            if healthAuthorizationRequested { return .authorized }
            return health.isHealthDataAvailable ? .notDetermined : .unsupported
        case "calendar": return calendar.permission
        case "reminders": return reminders.permission
        case "contacts": return contacts.permission
        default: return .unsupported
        }
    }

    private func permissionLabel(for descriptor: DataSourceDescriptor) -> String {
        permission(for: descriptor).label
    }

    private func permissionLabelColor(for descriptor: DataSourceDescriptor) -> Color {
        switch permission(for: descriptor) {
        case .authorized: return .green
        case .denied: return .orange
        case .notDetermined, .unsupported: return .secondary
        }
    }

    private func authorize(_ descriptor: DataSourceDescriptor) async {
        do {
            switch descriptor.capability {
            case "healthkit":
                try await health.requestAuthorization()
                try? await health.enableBackgroundDelivery()
                healthAuthorizationRequested = true
                HealthBackgroundSync.schedule()
            case "calendar":
                try await calendar.requestAuthorization()
            case "reminders":
                try await reminders.requestAuthorization()
            case "contacts":
                try await contacts.requestAuthorization()
            default:
                break
            }
            setStatus("\(descriptor.label) is ready.")
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    private func refreshAllPermissions() {
        calendar.refreshPermission()
        reminders.refreshPermission()
        contacts.refreshPermission()
    }

    private func currentOrgName(in userInfo: OAuthUserInfo?) -> String? {
        let slug = userInfo?.organization_slug ?? selectedOrgSlug
        guard !slug.isEmpty else { return nil }
        return userInfo?.organizations.first(where: { $0.slug == slug })?.name ?? slug
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    private func handleAppear() {
        if backfillDays < 1 || backfillDays > 30 {
            backfillDays = clampedBackfillDays
        }
        if healthAuthorizationRequested {
            health.restorePreviouslyRequestedAuthorizationState()
            HealthBackgroundSync.schedule()
        }
        refreshAllPermissions()
        credentials = credentialStore.load()
        if selectedOrgSlug.isEmpty {
            selectedOrgSlug = credentials?.userInfo?.organization_slug
                ?? credentials?.userInfo?.organizations.first?.slug
                ?? ""
        }
        if credentials == nil, let pending = pendingLogin(), pending.expiresAt > Date() {
            loginCode = pending.authorization.user_code
            setStatus("Return here after approving code \(pending.authorization.user_code).")
            Task { await resumePendingLogin() }
        }
    }

    private func setStatus(_ message: String) {
        status = message
        print("[LobuIOSBridge] \(message)")
    }

    private func handleDeepLink(_ url: URL) {
        if url.host == "sync" {
            Task { await sync() }
            return
        }
        if url.host == "oauth", url.path == "/device-approved" {
            Task { await resumePendingLogin() }
        }
    }

    // -------------------------------------------------------------------------
    // OAuth — unchanged from prior implementation
    // -------------------------------------------------------------------------

    private func signIn() async {
        isLoggingIn = true
        loginCode = nil
        defer { isLoggingIn = false }
        do {
            let oauth = try OAuthClient(baseURL: lobuBaseURL)
            setStatus("Discovering Lobu OAuth…")
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
            setStatus("Approve the login in your browser. Code: \(authorization.user_code)")
            oauth.openVerificationURL(authorization)
            await completeLogin(pending)
        } catch is CancellationError {
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    private func resumePendingLogin() async {
        guard !isLoggingIn, let pending = pendingLogin() else { return }
        guard pending.expiresAt > Date() else {
            clearPendingLogin()
            loginCode = nil
            setStatus("Login request expired. Try signing in again.")
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
                    setStatus("Signed in.")
                    return
                }
            }
            setStatus("Login request expired before approval.")
            clearPendingLogin()
        } catch {
            setStatus(error.localizedDescription)
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
        setStatus("Signed out.")
    }

    // -------------------------------------------------------------------------
    // Sync
    // -------------------------------------------------------------------------

    private func sync() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let result = try await HealthSyncService.sync(
                managers: managersBag,
                backfillDays: clampedBackfillDays
            )
            HealthBackgroundSync.schedule()
            if result.claimedJob {
                let label = connectorLabel(result.claimedConnectorKey)
                setStatus("Streamed \(result.uploadedCount) \(label) event\(result.uploadedCount == 1 ? "" : "s").")
            } else {
                setStatus("No pending sync work — scheduler will queue the next run when due.")
            }
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    private func connectorLabel(_ key: String?) -> String {
        guard let key else { return "" }
        return DataSourceCatalog.all.first(where: { $0.connectorKey == key })?.label ?? key
    }
}

#Preview {
    ContentView()
}
