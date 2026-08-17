#if os(macOS)
import AppKit
import SwiftUI

/// Anchors a popover to the existing AppKit title field, without replacing the
/// window title or inserting a toolbar item. AppKit exposes no title-content
/// customization hook, so locate the native field by its public text value.
struct WindowTitlePopover<Content: View>: NSViewRepresentable {
    let title: String
    @ViewBuilder var content: () -> Content

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WindowObserver {
        let view = WindowObserver()
        view.windowChanged = { [weak coordinator = context.coordinator] window in
            coordinator?.observe(window)
        }
        return view
    }

    func updateNSView(_ view: WindowObserver, context: Context) {
        context.coordinator.title = title
        context.coordinator.host.rootView = AnyView(content())
        context.coordinator.observe(view.window)
        context.coordinator.attachToTitle()
    }

    static func dismantleNSView(_ view: WindowObserver, coordinator: Coordinator) {
        view.windowChanged = nil
        coordinator.observe(nil)
    }

    final class WindowObserver: NSView {
        var windowChanged: ((NSWindow?) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            windowChanged?(window)
        }
    }

    final class Coordinator: NSObject {
        var title = ""
        let host = NSHostingController(rootView: AnyView(EmptyView()))
        private let popover = NSPopover()
        private weak var window: NSWindow?
        private weak var titleField: NSTextField?
        private var previousTooltip: String?
        private lazy var click = NSClickGestureRecognizer(target: self, action: #selector(showSettings))

        override init() {
            super.init()
            popover.behavior = .transient
            popover.contentViewController = host
        }

        func observe(_ newWindow: NSWindow?) {
            guard window !== newWindow else { return }
            NotificationCenter.default.removeObserver(self)
            detach()
            window = newWindow
            if let newWindow {
                NotificationCenter.default.addObserver(self, selector: #selector(windowUpdated), name: NSWindow.didUpdateNotification, object: newWindow)
                attachToTitle()
            }
        }

        @objc private func windowUpdated() { attachToTitle() }

        func attachToTitle() {
            guard !title.isEmpty, let window, let contentView = window.contentView,
                  let frame = contentView.superview else { return }
            // Exclude the entire content hierarchy: a chat may contain the title
            // text too. Do not depend on private AppKit class names or selectors.
            func findTitle(in view: NSView) -> NSTextField? {
                guard view !== contentView else { return nil }
                if let field = view as? NSTextField, field.stringValue == title, !field.isEditable {
                    return field
                }
                for child in view.subviews {
                    if let match = findTitle(in: child) { return match }
                }
                return nil
            }
            guard let field = findTitle(in: frame) else { return }
            if field !== titleField {
                detach()
                titleField = field
                previousTooltip = field.toolTip
                field.toolTip = "Model and thinking level"
                field.addGestureRecognizer(click)
            }
        }

        private func detach() {
            popover.close()
            titleField?.removeGestureRecognizer(click)
            titleField?.toolTip = previousTooltip
            titleField = nil
        }

        @objc private func showSettings() {
            guard let field = titleField else { return }
            if popover.isShown { popover.close(); return }
            host.view.layoutSubtreeIfNeeded()
            popover.contentSize = host.view.fittingSize
            popover.show(relativeTo: field.bounds, of: field, preferredEdge: .minY)
        }
    }
}
#endif
