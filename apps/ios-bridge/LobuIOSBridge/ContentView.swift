import SwiftUI

struct ContentView: View {
    @StateObject private var health = HealthKitManager()

    @AppStorage("lobuBaseURL") private var lobuBaseURL = "https://app.lobu.ai"
    @AppStorage("selectedOrgSlug") private var selectedOrgSlug = ""
    @AppStorage("backfillDays") private var backfillDays = 7

    @State private var credentials: OAuthCredentials?
    @State private var isLoggingIn = false
    @State private var isSyncing = false
    @State private var loginCode: String?
    @State private var status = "Sign in to Lobu, authorize Health, then sync."
    @State private var lastUploadCount = 0

    private let credentialStore = KeychainCredentialStore()

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
            loginCode = authorization.user_code
            status = "Approve the login in your browser. Code: \(authorization.user_code)"
            oauth.openVerificationURL(authorization)

            let deadline = Date().addingTimeInterval(TimeInterval(authorization.expires_in))
            var interval = max(authorization.interval ?? 5, 1)
            while Date() < deadline {
                try await Task.sleep(for: .seconds(interval))
                switch try await oauth.pollDeviceToken(discovery, client: client, deviceCode: authorization.device_code) {
                case let .pending(slowDown):
                    if slowDown { interval += 5 }
                case let .complete(tokens):
                    let userInfo = try await oauth.fetchUserInfo(discovery.userinfo_endpoint, accessToken: tokens.access_token)
                    let saved = OAuthCredentials(
                        baseURL: lobuBaseURL.trimmedTrailingSlash(),
                        clientID: client.client_id,
                        clientSecret: client.client_secret,
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        expiresAt: tokens.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) },
                        userInfo: userInfo
                    )
                    try credentialStore.save(saved)
                    credentials = saved
                    selectedOrgSlug = userInfo?.organization_slug ?? userInfo?.organizations.first?.slug ?? selectedOrgSlug
                    loginCode = nil
                    status = "Signed in to Lobu."
                    return
                }
            }
            status = "Login request expired. Try signing in again."
        } catch {
            status = error.localizedDescription
        }
    }

    private func signOut() {
        credentialStore.clear()
        credentials = nil
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
