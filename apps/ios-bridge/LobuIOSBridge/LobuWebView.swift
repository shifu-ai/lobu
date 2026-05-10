import SwiftUI
import WebKit

/// SwiftUI presentation of the embedded Lobu web app. Before navigating, fetches
/// a better-auth session cookie via /api/me/web-session-from-oauth, drops it
/// into WKWebsiteDataStore.default().httpCookieStore for the Lobu host, then
/// loads the requested path. The user lands signed in — no second OAuth flow
/// inside the web view.
struct LobuWebView: View {
    /// Path on the Lobu app, e.g. "/approvals/abc123" or "/".
    let path: String
    @Environment(\.dismiss) private var dismiss
    @State private var status: LoadStatus = .preparing

    enum LoadStatus: Equatable {
        case preparing
        case loading(URL)
        case ready(URL)
        case error(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch status {
                case .preparing:
                    ProgressView("Signing in to Lobu…").padding()
                case let .loading(url), let .ready(url):
                    WebViewRepresentable(url: url)
                        .ignoresSafeArea(.container, edges: .bottom)
                case let .error(message):
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.orange)
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: path) { await prepare() }
    }

    private func prepare() async {
        do {
            let credentialStore = KeychainCredentialStore()
            guard var credentials = credentialStore.load() else {
                status = .error("Sign in to Lobu first.")
                return
            }
            // Refresh access token if it's near expiry — same pattern HealthSyncService uses.
            let oauth = try OAuthClient(baseURL: credentials.baseURL)
            if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
                credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
                try credentialStore.save(credentials)
            }

            let baseURL = credentials.baseURL.trimmedTrailingSlash()
            guard let endpoint = URL(string: "\(baseURL)/api/me/web-session-from-oauth"),
                  let targetURL = URL(string: "\(baseURL)\(path)") else {
                status = .error("Invalid Lobu URL.")
                return
            }

            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("Bearer \(credentials.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? "<binary>"
                status = .error("Could not mint web session: \(body)")
                return
            }

            struct Body: Decodable {
                let cookie_name: String
                let cookie_value: String
                let expires_at: String?
            }
            let body = try JSONDecoder().decode(Body.self, from: data)

            try await seedCookie(on: targetURL, name: body.cookie_name, value: body.cookie_value)
            status = .loading(targetURL)
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    @MainActor
    private func seedCookie(on url: URL, name: String, value: String) async throws {
        guard let host = url.host else { return }
        // Plant on both the apex and a leading-dot variant so any Lobu subdomain
        // navigation inside the web view stays signed in.
        let domains = [host, ".\(host.replacingOccurrences(of: ".", with: "."))"]
        for domain in domains {
            let properties: [HTTPCookiePropertyKey: Any] = [
                .name: name,
                .value: value,
                .domain: domain,
                .path: "/",
                .secure: true,
                .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax,
            ]
            if let cookie = HTTPCookie(properties: properties) {
                await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
            }
        }
    }
}

/// Thin UIViewRepresentable wrapping WKWebView. Keeps the body trivial so the
/// SwiftUI side (LobuWebView) owns presentation + auth handoff.
struct WebViewRepresentable: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = true
        return view
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}
