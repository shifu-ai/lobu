import SwiftUI

@main
struct LobuMacBridgeApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(state: state)
        } label: {
            // Use the system "rectangle.on.rectangle" as a placeholder until we
            // ship a proper template image. Renders monochrome in the menu bar.
            Label("Lobu", systemImage: "rectangle.on.rectangle")
        }
        .menuBarExtraStyle(.window)
    }
}
