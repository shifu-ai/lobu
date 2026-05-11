import SwiftUI

@main
struct LobuMacBridgeApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(state: state)
        } label: {
            // Lobu lobster mark — vector SVG, rendered as a template so it
            // tints to the menu bar's light/dark appearance.
            Label("Lobu", image: "MenuBarIcon")
        }
        .menuBarExtraStyle(.window)
    }
}
