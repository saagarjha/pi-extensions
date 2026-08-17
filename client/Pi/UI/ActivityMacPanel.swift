#if os(macOS)
import AppKit
import SwiftUI

/// A sheet owns its own window toolbar; SwiftUI's navigation toolbar in a sheet
/// can otherwise become a bottom bar. The tracking separator anchors the native
/// title and actions to the detail column while the sidebar extends to the top.
struct ActivityMacPanel<Sidebar: View, Detail: View>: NSViewControllerRepresentable {
    let title: String
    let subtitle: String
    let actionLabel: String
    let actionImage: String
    let actionEnabled: Bool
    let action: () -> Void
    let close: () -> Void
    @ViewBuilder let sidebar: Sidebar
    @ViewBuilder let detail: Detail

    func makeNSViewController(context: Context) -> Controller {
        Controller(sidebar: sidebar, detail: detail)
    }

    func updateNSViewController(_ controller: Controller, context: Context) {
        controller.sidebarHost.rootView = sidebar
        controller.detailHost.rootView = detail
        controller.configuration = self
        controller.updateToolbar()
    }

    static func dismantleNSViewController(_ controller: Controller, coordinator: ()) {
        controller.restoreWindow()
    }

    final class Controller: NSSplitViewController, NSToolbarDelegate {
        let sidebarHost: NSHostingController<Sidebar>
        let detailHost: NSHostingController<Detail>
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

        init(sidebar: Sidebar, detail: Detail) {
            sidebarHost = NSHostingController(rootView: sidebar)
            detailHost = NSHostingController(rootView: detail)
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidLoad() {
            super.viewDidLoad()
            splitView.isVertical = true
            splitView.dividerStyle = .thin
            let sidebar = NSSplitViewItem(sidebarWithViewController: sidebarHost)
            sidebar.minimumThickness = 180
            sidebar.maximumThickness = 360
            sidebar.canCollapse = false
            addSplitViewItem(sidebar)
            addSplitViewItem(NSSplitViewItem(viewController: detailHost))
            splitView.setPosition(240, ofDividerAt: 0)
        }

        override func viewDidAppear() {
            super.viewDidAppear()
            installToolbar()
        }

        private func installToolbar() {
            guard let window = view.window, installedWindow !== window else { return }
            restoreWindow()
            installedWindow = window
            originalToolbar = window.toolbar
            originalStyle = window.styleMask
            originalToolbarStyle = window.toolbarStyle
            originalTitle = window.title
            originalSubtitle = window.subtitle
            originalTitleVisibility = window.titleVisibility
            window.styleMask.insert(.fullSizeContentView)
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
            mutationItem?.label = configuration.actionLabel
            mutationItem?.toolTip = configuration.actionLabel
            mutationItem?.image = NSImage(systemSymbolName: configuration.actionImage,
                                         accessibilityDescription: configuration.actionLabel)
            mutationItem?.isEnabled = configuration.actionEnabled
        }

        func restoreWindow() {
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
            [.init("activityClose"), .init("activitySidebar"), .flexibleSpace, .init("activityMutation")]
        }

        func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
            toolbarDefaultItemIdentifiers(toolbar)
        }

        func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                     willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
            if id.rawValue == "activitySidebar" {
                return NSTrackingSeparatorToolbarItem(identifier: id, splitView: splitView, dividerIndex: 0)
            }
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
