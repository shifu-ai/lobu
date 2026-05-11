import SwiftUI

@main
struct LobuMacBridgeApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(state: state)
        } label: {
            // Lobu lobster mark — vector SVG, rendered as a template so it
            // tints to the menu bar's light/dark appearance. The SVG carries an
            // explicit 17×16 size; the frame here is belt-and-suspenders so a
            // bad intrinsic size can't blow up the menu bar item.
            Image("MenuBarIcon")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 14, height: 14)
                .accessibilityLabel("Lobu Bridge")
        }
        .menuBarExtraStyle(.window)
    }
}
