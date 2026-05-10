import SwiftUI

@main
struct LobuIOSBridgeApp: App {
    init() {
        HealthBackgroundSync.register()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
