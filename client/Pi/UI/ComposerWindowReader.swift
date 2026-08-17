#if os(macOS)
import AppKit
import SwiftUI

/// Binds a composer to its own NSWindow without replacing SwiftUI's text field
/// or field editor. Used only to scope image-paste interception.
struct ComposerWindowReader: NSViewRepresentable {
    var onWindow: @MainActor (NSWindow?) -> Void

    func makeNSView(context: Context) -> Reader { Reader(onWindow: onWindow) }
    func updateNSView(_ view: Reader, context: Context) { view.onWindow = onWindow }

    final class Reader: NSView {
        var onWindow: @MainActor (NSWindow?) -> Void
        init(onWindow: @escaping @MainActor (NSWindow?) -> Void) {
            self.onWindow = onWindow
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let current = window
            DispatchQueue.main.async { self.onWindow(current) }
        }
    }
}
#endif
