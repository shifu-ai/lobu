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
            // The asset is a square 18pt SVG with built-in padding (the
            // claw mark sits at ~70% of the canvas) so it reads like a normal
            // menu-bar glyph. No .resizable()/.frame() — MenuBarExtra ignores
            // the label's frame, so the size has to live in the asset itself.
            Image("MenuBarIcon")
                .renderingMode(.template)
                .accessibilityLabel("Lobu Bridge")
        }
        .menuBarExtraStyle(.window)
    }
}
