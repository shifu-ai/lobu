import SwiftUI

/// The popover shown when the user clicks the menu bar icon. Mirrors the iOS
/// bridge's slim layout — sign-in card, Screen Time row, Sync now, Worker host
/// toggle, Quit.
struct MenuBarContent: View {
    @ObservedObject var state: AppState
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            if state.credentials == nil {
                signInRow
            } else {
                signedInRow
                Divider()
                dataSourceRow
                syncButton
                Divider()
                workerHostRow
            }
            if !state.status.isEmpty {
                Divider()
                Text(state.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            Divider()
            HStack {
                Button("Quit Lobu") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                Spacer()
                Text(state.baseURL.replacingOccurrences(of: "https://", with: ""))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(14)
        .frame(width: 320)
    }

    // -------------------------------------------------------------------------

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.on.rectangle")
                .font(.title3)
            Text("Lobu")
                .font(.headline)
            Spacer()
        }
    }

    private var signInRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(state.isLoggingIn ? "Waiting for approval…" : "Sign in with Lobu") {
                Task { await state.signIn() }
            }
            .disabled(state.isLoggingIn)
            if let code = state.loginCode {
                HStack {
                    Text("Code").foregroundStyle(.secondary)
                    Spacer()
                    Text(code).monospaced()
                }
                .font(.caption)
            }
        }
    }

    private var signedInRow: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(state.displayName).font(.body)
                if let orgName = state.credentials?.userInfo?.organizations.first?.name {
                    Text(orgName).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Sign out", role: .destructive) { state.signOut() }
                .buttonStyle(.plain)
                .font(.caption)
        }
    }

    private var dataSourceRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.fill")
                .foregroundStyle(.purple)
                .frame(width: 22)
            Text("Screen Time").font(.body)
            Spacer()
            Text("Connected").font(.caption).foregroundStyle(.green)
        }
    }

    private var syncButton: some View {
        Button(state.isSyncing ? "Syncing…" : "Sync now") {
            Task { await state.syncNow() }
        }
        .disabled(state.isSyncing || state.credentials == nil)
    }

    private var workerHostRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { state.workerHostRunning },
                set: { newValue in
                    if newValue { state.startWorkerHost() } else { state.stopWorkerHost() }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Host connector worker")
                    Text(state.workerHostStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(state.credentials == nil)
            Text("Runs Lobu's connector worker locally on your Mac (Gmail, Calendar, GitHub, …). Off by default.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
