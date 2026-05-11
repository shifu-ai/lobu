import AppKit
import SwiftUI

/// The popover shown when the user clicks the menu bar icon.
/// Layout (top → bottom):
///   1. Status line
///   2. Recent jobs (last 3–5)
///   3. Integrations section (Screen Time + Local folders)
///   4. Account (name, Open Lobu, Sign out)
///   5. Quit
struct MenuBarContent: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
            Divider().padding(.vertical, 8)
            statusRow
            if state.credentials == nil {
                signInSection
            } else {
                if !state.recentJobs.isEmpty {
                    Divider().padding(.vertical, 8)
                    recentJobsSection
                }
                Divider().padding(.vertical, 8)
                integrationsSection
                Divider().padding(.vertical, 8)
                accountSection
            }
            Divider().padding(.vertical, 8)
            footerRow
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: 320)
    }

    // -------------------------------------------------------------------------
    // MARK: Header
    // -------------------------------------------------------------------------

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image("MenuBarIcon")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(.orange)
            Text("Lobu")
                .font(.headline)
            Spacer()
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 1. Status line
    // -------------------------------------------------------------------------

    private var statusRow: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(state.connectionStatusLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if state.isSyncing {
                ProgressView().controlSize(.mini)
            } else if state.credentials != nil {
                Button("Sync now") {
                    Task { await state.syncNow() }
                }
                .buttonStyle(.plain)
                .font(.caption)
                .disabled(state.isSyncing)
            }
        }
    }

    private var statusColor: Color {
        guard state.credentials != nil else { return .gray }
        guard state.lastPollDate != nil else { return .yellow }
        return state.lastPollSuccess ? .green : .red
    }

    // -------------------------------------------------------------------------
    // MARK: Sign-in section (when not signed in)
    // -------------------------------------------------------------------------

    private var signInSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.vertical, 4)
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

    // -------------------------------------------------------------------------
    // MARK: 2. Recent jobs
    // -------------------------------------------------------------------------

    private var recentJobsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel("Recent jobs")
            ForEach(Array(state.recentJobs.prefix(5).enumerated()), id: \.offset) { _, job in
                HStack(spacing: 0) {
                    Text(job.displayLabel)
                        .font(.caption)
                    Text(" · \(job.itemsStreamed) items")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(job.timeAgoString)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.leading, 4)
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 3. Integrations
    // -------------------------------------------------------------------------

    private var integrationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Integrations")
            screenTimeRow
            localFolderRows
        }
    }

    private var screenTimeRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.fill")
                .foregroundStyle(.purple)
                .frame(width: 18)
            Text("Screen Time")
                .font(.caption)
            Spacer()
            if state.hasFDA {
                Label("Granted", systemImage: "checkmark.circle.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.green)
                    .font(.caption)
            } else {
                Button("Open Settings") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundStyle(.orange)
            }
        }
    }

    private var localFolderRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(.blue)
                    .frame(width: 18)
                Text("Local folder")
                    .font(.caption)
                Spacer()
                Button("Add folder…") {
                    openFolderPanel()
                }
                .buttonStyle(.plain)
                .font(.caption)
            }
            ForEach(Array(state.localFolderBookmarks.enumerated()), id: \.offset) { idx, _ in
                if let url = state.resolvedURLForBookmark(at: idx) {
                    HStack(spacing: 4) {
                        Text(url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button {
                            state.removeFolderBookmark(at: idx)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.leading, 26)
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 4. Account
    // -------------------------------------------------------------------------

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Account")
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Signed in as \(state.displayName)")
                        .font(.caption)
                    if let orgName = state.activeOrgName {
                        Text(orgName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            HStack(spacing: 10) {
                Button("Open Lobu \u{2197}") {
                    if let url = URL(string: state.baseURL) {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.plain)
                .font(.caption)
                Spacer()
                Button("Sign out", role: .destructive) { state.signOut() }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: Footer
    // -------------------------------------------------------------------------

    private var footerRow: some View {
        HStack {
            Button("Quit Lobu") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.plain)
            .font(.caption)
            Spacer()
            Text(state.baseURL.replacingOccurrences(of: "https://", with: ""))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    // -------------------------------------------------------------------------
    // MARK: Helpers
    // -------------------------------------------------------------------------

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fontWeight(.semibold)
            .tracking(0.4)
    }

    private func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Add"
        panel.message = "Choose a folder for Lobu to read"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        state.addFolderBookmark(url: url)
    }
}
