import SwiftUI

struct ContentView: View {
    @StateObject private var health = HealthKitManager()

    @AppStorage("lobuBaseURL") private var lobuBaseURL = "https://app.lobu.ai"
    @AppStorage("lobuOrgSlug") private var lobuOrgSlug = ""
    @AppStorage("backfillDays") private var backfillDays = 7

    @State private var lobuToken = ""
    @State private var isSyncing = false
    @State private var status = "Configure Lobu, authorize Health, then sync."
    @State private var lastUploadCount = 0

    var body: some View {
        NavigationStack {
            Form {
                Section("Lobu") {
                    TextField("Base URL", text: $lobuBaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Org slug", text: $lobuOrgSlug)
                        .textInputAutocapitalization(.never)
                    SecureField("API token", text: $lobuToken)
                        .textInputAutocapitalization(.never)
                }

                Section("Health permissions") {
                    LabeledContent("HealthKit", value: health.isHealthDataAvailable ? "Available" : "Unavailable")
                    LabeledContent("Status", value: health.authorizationStatus)
                    Button("Authorize Apple Health") {
                        Task { await authorizeHealth() }
                    }
                }

                Section("Sync") {
                    Stepper("Backfill \(backfillDays) days", value: $backfillDays, in: 1...30)
                    Button(isSyncing ? "Syncing…" : "Sync now") {
                        Task { await sync() }
                    }
                    .disabled(isSyncing)
                    LabeledContent("Last upload", value: "\(lastUploadCount) events")
                }

                Section("Status") {
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Lobu Health Bridge")
            .onAppear {
                lobuToken = KeychainTokenStore().load()
            }
            .onChange(of: lobuToken) { _, newValue in
                KeychainTokenStore().save(newValue)
            }
        }
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
            let config = LobuConfig(baseURL: lobuBaseURL, orgSlug: lobuOrgSlug, token: lobuToken)
            let client = LobuClient(config: config)
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
