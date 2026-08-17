#if os(macOS)
import AppKit
import SwiftUI

/// A sheet owns its own window toolbar; SwiftUI's navigation toolbar in a sheet
/// can otherwise become a bottom bar. Host the entire SwiftUI navigation split
/// together so its native sidebar search keeps its navigation context.
struct ActivityMacPanel<Content: View>: NSViewControllerRepresentable {
    let title: String
    let subtitle: String
    let actionLabel: String?
    let actionImage: String?
    let actionEnabled: Bool
    let action: () -> Void
    let close: () -> Void
    var onWindowChange: (NSWindow?) -> Void = { _ in }
    var onSheetEnd: (NSWindow) -> Void = { _ in }
    @ViewBuilder let content: Content

    func makeNSViewController(context: Context) -> Controller {
        Controller(content: content)
    }

    func updateNSViewController(_ controller: Controller, context: Context) {
        controller.contentHost.rootView = content
        controller.configuration = self
        controller.updateToolbar()
    }

    static func dismantleNSViewController(_ controller: Controller, coordinator: ()) {
        controller.restoreWindow()
    }

    final class Controller: NSViewController, NSToolbarDelegate {
        let contentHost: NSHostingController<Content>
        var configuration: ActivityMacPanel?
        private weak var installedWindow: NSWindow?
        private var ownedToolbar: NSToolbar?
        private var originalToolbar: NSToolbar?
        private var originalStyle: NSWindow.StyleMask = []
        private var originalToolbarStyle: NSWindow.ToolbarStyle = .automatic
        private var originalTitle = ""
        private var originalSubtitle = ""
        private var originalTitleVisibility: NSWindow.TitleVisibility = .visible
        private var mutationItem: NSToolbarItem?

        init(content: Content) {
            contentHost = NSHostingController(rootView: content)
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidLoad() {
            super.viewDidLoad()
            addChild(contentHost)
            contentHost.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(contentHost.view)
            NSLayoutConstraint.activate([
                contentHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                contentHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                contentHost.view.topAnchor.constraint(equalTo: view.topAnchor),
                contentHost.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
        }

        override func viewDidAppear() {
            super.viewDidAppear()
            installToolbar()
        }

        private func installToolbar() {
            guard let window = view.window, window.sheetParent != nil, installedWindow !== window else { return }
            restoreWindow()
            installedWindow = window
            NotificationCenter.default.addObserver(self, selector: #selector(didEndSheet(_:)),
                                                   name: NSWindow.didEndSheetNotification, object: window)
            configuration?.onWindowChange(window)
            originalToolbar = window.toolbar
            originalStyle = window.styleMask
            originalToolbarStyle = window.toolbarStyle
            originalTitle = window.title
            originalSubtitle = window.subtitle
            originalTitleVisibility = window.titleVisibility
            window.styleMask.insert(.fullSizeContentView)
            // SwiftUI presents this as a non-resizable sheet by default, even
            // though its split columns and detail view support live resizing.
            window.styleMask.insert(.resizable)
            let toolbar = NSToolbar(identifier: "Pi.Activity")
            ownedToolbar = toolbar
            toolbar.delegate = self
            toolbar.displayMode = .iconOnly
            toolbar.allowsUserCustomization = false
            window.toolbar = toolbar
            window.toolbarStyle = .unified
            window.titleVisibility = .visible
            updateToolbar()
        }

        func updateToolbar() {
            guard let configuration else { return }
            if let window = installedWindow, window.toolbar === ownedToolbar {
                window.title = configuration.title
                window.subtitle = configuration.subtitle
            }
            if let window = installedWindow, window.toolbar === ownedToolbar, let toolbar = ownedToolbar {
                let showsAction = configuration.actionLabel != nil && configuration.actionImage != nil
                if showsAction, mutationItem == nil {
                    toolbar.insertItem(withItemIdentifier: .init("activityMutation"), at: toolbar.items.count)
                } else if !showsAction,
                          let index = toolbar.items.firstIndex(where: { $0.itemIdentifier.rawValue == "activityMutation" }) {
                    toolbar.removeItem(at: index)
                    mutationItem = nil
                }
            }
            if let label = configuration.actionLabel, let image = configuration.actionImage {
                mutationItem?.label = label
                mutationItem?.toolTip = label
                mutationItem?.image = NSImage(systemSymbolName: image, accessibilityDescription: label)
                mutationItem?.isEnabled = configuration.actionEnabled
            }
        }

        @objc private func didEndSheet(_ notification: Notification) {
            guard let window = notification.object as? NSWindow, window === installedWindow else { return }
            configuration?.onSheetEnd(window)
        }

        func restoreWindow() {
            if let window = installedWindow {
                NotificationCenter.default.removeObserver(self, name: NSWindow.didEndSheetNotification, object: window)
                configuration?.onWindowChange(nil)
            }
            if let window = installedWindow, window.toolbar === ownedToolbar {
                window.toolbar = originalToolbar
                window.styleMask = originalStyle
                window.toolbarStyle = originalToolbarStyle
                window.title = originalTitle
                window.subtitle = originalSubtitle
                window.titleVisibility = originalTitleVisibility
            }
            ownedToolbar?.delegate = nil
            ownedToolbar = nil
            originalToolbar = nil
            installedWindow = nil
            mutationItem = nil
        }

        func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
            var items: [NSToolbarItem.Identifier] = [.init("activityClose"), .sidebarTrackingSeparator, .flexibleSpace]
            if configuration?.actionLabel != nil, configuration?.actionImage != nil {
                items.append(.init("activityMutation"))
            }
            return items
        }

        func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
            [.init("activityClose"), .sidebarTrackingSeparator, .flexibleSpace, .init("activityMutation")]
        }

        func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                     willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
            if id == .sidebarTrackingSeparator { return nil } // AppKit creates the standard tracking item.
            let item = NSToolbarItem(itemIdentifier: id)
            item.target = self
            item.autovalidates = false
            if id.rawValue == "activityMutation" {
                mutationItem = item
                item.action = #selector(mutate)
                updateToolbar()
            } else {
                item.label = "Close"
                item.toolTip = "Close activity panel"
                item.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
                item.action = #selector(closePanel)
            }
            return item
        }

        @objc private func mutate() {
            guard let configuration, configuration.actionEnabled else { return }
            configuration.action()
        }

        @objc private func closePanel() { configuration?.close() }
        override func cancelOperation(_ sender: Any?) { configuration?.close() }
    }
}
#endif
