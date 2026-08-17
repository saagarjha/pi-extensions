#if os(macOS)
import AppKit
import Combine
import SwiftUI
import UserNotifications

/// Native notifications for live attached sessions only. No polling or extra watchers.
@MainActor final class SessionNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    private weak var store: DaemonSessionStore?
    private let center = UNUserNotificationCenter.current()
    private var subscription: AnyCancellable?
    private var invalidationSubscription: AnyCancellable?
    private var eligibleSettlements: [String: SessionSettlement] = [:]
    private var schedulingTasks: [String: Task<Void, Never>] = [:]
    private var seenSettlements = Set<String>()
    private var checkedPermission = false
    var openWindow: (() -> Void)?

    private struct WindowState {
        weak var window: NSWindow?
        let sessionID: String?
        let remoteOrigin: String?
        let connected: Bool
        let isMainWindow: Bool
    }
    private var windows: [UUID: WindowState] = [:]

    init(store: DaemonSessionStore) {
        self.store = store
        super.init()
        center.delegate = self
        subscription = store.settlements.sink { [weak self] event in self?.received(event) }
        invalidationSubscription = store.settlementInvalidations.sink { [weak self] id in self?.invalidate(id) }
        NotificationCenter.default.addObserver(self, selector: #selector(focusChanged), name: NSWindow.didBecomeKeyNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(focusChanged), name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    func trackWindow(_ id: UUID, window: NSWindow?, sessionID: String?, remoteOrigin: String?, connected: Bool, isMainWindow: Bool) {
        if let window {
            windows[id] = WindowState(window: window, sessionID: sessionID, remoteOrigin: remoteOrigin,
                                      connected: connected, isMainWindow: isMainWindow)
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

    private func invalidate(_ id: String) {
        eligibleSettlements.removeValue(forKey: id)
        schedulingTasks.removeValue(forKey: id)?.cancel()
        removeNotification(id)
    }

    private func removeNotification(_ id: String) {
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    private func received(_ event: SessionSettlement) {
        guard seenSettlements.insert(event.id).inserted,
              store?.isCurrentSettlement(event) == true,
              !isFocused(sessionID: event.sessionID, remoteOrigin: event.remoteOrigin) else { return }
        eligibleSettlements[event.id] = event
        schedulingTasks[event.id] = Task { [weak self] in
            guard let self else { return }
            defer { schedulingTasks.removeValue(forKey: event.id) }
            let settings = await center.notificationSettings()
            guard !Task.isCancelled, store?.isCurrentSettlement(event) == true,
                  settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
                  !isFocused(sessionID: event.sessionID, remoteOrigin: event.remoteOrigin) else {
                eligibleSettlements.removeValue(forKey: event.id)
                return
            }
            let content = UNMutableNotificationContent()
            content.title = event.title
            content.body = "Session is idle"
            content.sound = .default
            // Only routing metadata. Never include tokens, certificates, prompts, or tool output.
            content.userInfo = ["kind": "session-idle", "sessionID": event.sessionID,
                                "connection": event.remoteOrigin == nil ? "local" : "remote"]
            if let origin = event.remoteOrigin { content.userInfo["profileOrigin"] = origin }
            try? await center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
            // Invalidation can race the asynchronous add; remove again after its completion.
            if Task.isCancelled || store?.isCurrentSettlement(event) != true {
                eligibleSettlements.removeValue(forKey: event.id)
                removeNotification(event.id)
            }
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
        let identifier = notification.request.identifier
        return await MainActor.run {
            guard let event = self.eligibleSettlements[identifier],
                  event.sessionID == target.sessionID, event.remoteOrigin == target.remoteOrigin,
                  self.store?.isCurrentSettlement(event) == true,
                  !self.isFocused(sessionID: target.sessionID, remoteOrigin: target.remoteOrigin) else { return [] }
            return [.banner, .sound]
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let target = Self.target(response.notification.request.content.userInfo) else { return }
        await openSession(target.sessionID, remoteOrigin: target.remoteOrigin)
    }

    private func focus(_ window: NSWindow) {
        NSApplication.shared.activate()
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    private var navigationRevision: UInt64 = 0

    private func openSession(_ sessionID: String, remoteOrigin: String?) async {
        navigationRevision &+= 1
        let revision = navigationRevision
        guard let store else { return }
        // A pinned window is an independent presentation of the same attachment.
        // Surfacing it must not redirect the main window or request control again.
        if store.connected, store.remoteOrigin == remoteOrigin,
           store.windowPresentation(for: sessionID) != nil,
           let match = windows.values.first(where: {
               $0.connected && $0.sessionID == sessionID && $0.remoteOrigin == remoteOrigin &&
               $0.window != nil && (!$0.isMainWindow ||
                   (!store.selectionPending && store.selectedID == sessionID && store.snapshot?.sessionId == sessionID))
           }), let window = match.window {
            focus(window)
            return
        }
        // Only main windows follow sidebar selection. Never focus an unrelated popout.
        if let window = windows.values.first(where: { $0.isMainWindow && $0.window != nil })?.window {
            focus(window)
        } else {
            NSApplication.shared.activate()
            openWindow?()
        }
        guard store.occupiedSelection == nil, !store.busy || store.selectionLoading else {
            store.error = "Finish the current session action, then open this notification again."
            return
        }
        if !store.connected || store.remoteOrigin != remoteOrigin {
            guard !store.busy, !store.selectionPending else {
                store.error = "Finish the current session action, then open this notification again."
                return
            }
            if let remoteOrigin {
                // This is a previously imported Keychain profile ID, not a URL carrying credentials.
                await store.connectRemote(profileID: remoteOrigin)
            } else {
                await store.connectExisting() // Private discovery only; never bootstrap a daemon from a notification.
            }
        }
        guard revision == navigationRevision, store.connected, store.remoteOrigin == remoteOrigin else { return }
        // select() serializes/reconciles in-flight sidebar admission. A notification
        // click is a new navigation intent, not a reason to cancel an attachment RPC.
        if store.sessions.contains(where: { $0.id == sessionID }) || store.windowPresentation(for: sessionID) != nil {
            await store.select(sessionID)
            return
        }
        let epoch = store.connectionEpoch
        let selectionRevision = store.selectionRevision
        do { try await store.refresh() }
        catch {
            if revision == navigationRevision, epoch == store.connectionEpoch,
               selectionRevision == store.selectionRevision { store.error = error.localizedDescription }
            return
        }
        guard revision == navigationRevision, epoch == store.connectionEpoch,
              selectionRevision == store.selectionRevision,
              store.connected, store.remoteOrigin == remoteOrigin else { return }
        guard store.sessions.contains(where: { $0.id == sessionID }) else {
            store.error = "The session from this notification is no longer available."
            return
        }
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
    var isMainWindow = true

    func makeNSView(context: Context) -> WindowAnchor { WindowAnchor() }
    func updateNSView(_ view: WindowAnchor, context: Context) {
        let id = view.id
        let openWindow = openWindow
        if isMainWindow { notifications.openWindow = { openWindow(id: "sessions") } }
        view.windowChanged = { [weak notifications] window in
            notifications?.trackWindow(id, window: window, sessionID: sessionID, remoteOrigin: remoteOrigin,
                                       connected: connected, isMainWindow: isMainWindow)
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
