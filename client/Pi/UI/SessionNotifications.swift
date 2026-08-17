#if os(macOS)
import AppKit
import Combine
import SwiftUI
import UserNotifications

/// Native notifications for the currently attached session only. No polling or extra watchers.
@MainActor final class SessionNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    private weak var store: DaemonSessionStore?
    private let center = UNUserNotificationCenter.current()
    private var subscription: AnyCancellable?
    private var seenSettlements = Set<String>()
    private var checkedPermission = false
    var openWindow: (() -> Void)?

    private struct WindowState {
        weak var window: NSWindow?
        let sessionID: String?
        let remoteOrigin: String?
        let connected: Bool
    }
    private var windows: [UUID: WindowState] = [:]

    init(store: DaemonSessionStore) {
        self.store = store
        super.init()
        center.delegate = self
        subscription = store.settlements.sink { [weak self] event in self?.received(event) }
        NotificationCenter.default.addObserver(self, selector: #selector(focusChanged), name: NSWindow.didBecomeKeyNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(focusChanged), name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    func trackWindow(_ id: UUID, window: NSWindow?, sessionID: String?, remoteOrigin: String?, connected: Bool) {
        if let window {
            windows[id] = WindowState(window: window, sessionID: sessionID, remoteOrigin: remoteOrigin, connected: connected)
        } else {
            windows.removeValue(forKey: id)
        }
        requestPermissionIfNeeded()
    }

    private func isFocused(sessionID: String, remoteOrigin: String?) -> Bool {
        guard NSApplication.shared.isActive else { return false }
        return windows.values.contains { state in
            guard state.sessionID == sessionID, state.remoteOrigin == remoteOrigin,
                  let window = state.window, window.isVisible, !window.isMiniaturized else { return false }
            var key = NSApplication.shared.keyWindow
            // Native sheets/popovers may own key status while their session window remains the focus.
            for _ in 0..<16 {
                guard let current = key else { return false }
                if current === window { return true }
                key = current.sheetParent ?? current.parent
            }
            return false
        }
    }

    @objc private func focusChanged(_ notification: Notification) { requestPermissionIfNeeded() }

    private func requestPermissionIfNeeded() {
        guard !checkedPermission, windows.values.contains(where: { state in
            guard state.connected, let sessionID = state.sessionID else { return false }
            return isFocused(sessionID: sessionID, remoteOrigin: state.remoteOrigin)
        }) else { return }
        checkedPermission = true
        Task { [weak self] in
            guard let self else { return }
            let settings = await center.notificationSettings()
            guard settings.authorizationStatus == .notDetermined else { return }
            // Ask in the foreground, after an actual session is attached, never on background completion.
            guard windows.values.contains(where: { state in
                guard state.connected, let sessionID = state.sessionID else { return false }
                return self.isFocused(sessionID: sessionID, remoteOrigin: state.remoteOrigin)
            }) else { checkedPermission = false; return }
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
    }

    private func received(_ event: SessionSettlement) {
        guard seenSettlements.insert(event.id).inserted,
              !isFocused(sessionID: event.sessionID, remoteOrigin: event.remoteOrigin) else { return }
        Task { [weak self] in
            guard let self else { return }
            let settings = await center.notificationSettings()
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
                  !isFocused(sessionID: event.sessionID, remoteOrigin: event.remoteOrigin) else { return }
            let content = UNMutableNotificationContent()
            content.title = event.title
            content.body = "Session is idle"
            content.sound = .default
            // Only routing metadata. Never include tokens, certificates, prompts, or tool output.
            content.userInfo = ["kind": "session-idle", "sessionID": event.sessionID,
                                "connection": event.remoteOrigin == nil ? "local" : "remote"]
            if let origin = event.remoteOrigin { content.userInfo["profileOrigin"] = origin }
            try? await center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
        }
    }

    nonisolated private static func target(_ info: [AnyHashable: Any]) -> (sessionID: String, remoteOrigin: String?)? {
        guard info["kind"] as? String == "session-idle", let sessionID = info["sessionID"] as? String, !sessionID.isEmpty else { return nil }
        switch info["connection"] as? String {
        case "local": return (sessionID, nil)
        case "remote":
            guard let origin = info["profileOrigin"] as? String, !origin.isEmpty else { return nil }
            return (sessionID, origin)
        default: return nil
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let target = Self.target(notification.request.content.userInfo) else { return [] }
        return await MainActor.run {
            self.isFocused(sessionID: target.sessionID, remoteOrigin: target.remoteOrigin) ? [] : [.banner, .sound]
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let target = Self.target(response.notification.request.content.userInfo) else { return }
        await openSession(target.sessionID, remoteOrigin: target.remoteOrigin)
    }

    private func openSession(_ sessionID: String, remoteOrigin: String?) async {
        NSApplication.shared.activate()
        let window = windows.values.first(where: { $0.sessionID == sessionID && $0.remoteOrigin == remoteOrigin })?.window
            ?? windows.values.compactMap(\.window).first
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        if let window { window.makeKeyAndOrderFront(nil) }
        else { openWindow?() }
        guard let store else { return }
        if store.connected, store.remoteOrigin == remoteOrigin, store.selectedID == sessionID { return }
        guard !store.busy, store.occupiedSelection == nil else {
            store.error = "Finish the current session action, then open this notification again."
            return
        }
        if !store.connected || store.remoteOrigin != remoteOrigin {
            if let remoteOrigin {
                // This is a previously imported Keychain profile ID, not a URL carrying credentials.
                await store.connectRemote(profileID: remoteOrigin)
            } else {
                await store.connect() // Private discovery only; never bootstrap a daemon from a notification.
            }
        }
        guard store.connected, store.remoteOrigin == remoteOrigin else { return }
        do { try await store.refresh() }
        catch { store.error = error.localizedDescription; return }
        // Atomic conditional admission retains the existing Watch/Fork/Steal choice if occupied.
        await store.select(sessionID)
    }
}

/// Observes the actual native window containing the session, not just application activation.
struct SessionNotificationWindow: NSViewRepresentable {
    @Environment(\.openWindow) private var openWindow
    let notifications: SessionNotifications
    let sessionID: String?
    let remoteOrigin: String?
    let connected: Bool

    func makeNSView(context: Context) -> WindowAnchor { WindowAnchor() }
    func updateNSView(_ view: WindowAnchor, context: Context) {
        let id = view.id
        let openWindow = openWindow
        notifications.openWindow = { openWindow(id: "sessions") }
        view.windowChanged = { [weak notifications] window in
            notifications?.trackWindow(id, window: window, sessionID: sessionID, remoteOrigin: remoteOrigin, connected: connected)
        }
        view.windowChanged?(view.window)
    }
    static func dismantleNSView(_ view: WindowAnchor, coordinator: ()) {
        view.windowChanged?(nil)
        view.windowChanged = nil
    }
    final class WindowAnchor: NSView {
        let id = UUID()
        var windowChanged: ((NSWindow?) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            windowChanged?(window)
        }
    }
}
#endif
