#if os(macOS)
import SwiftUI

/// Presents the attached session's native confirmations in the currently visible window or sheet.
/// Acknowledgements belong to the store so moving between presenters cannot repeat an answer.
struct DaemonPermissionAlerts: ViewModifier {
    @ObservedObject var store: DaemonSessionStore
    var enabled: Bool

    @State private var pending: Pending?
    @State private var presented = false
    @State private var answering = false
    @State private var active = false

    private struct Pending {
        let request: LinkInteraction
        let connection: UUID
        let sessionID: String
        let control: LinkControl
    }

    func body(content: Content) -> some View {
        content
            .alert(pending?.request.title ?? "Permission request",
                   isPresented: $presented, presenting: pending) { permission in
                Button("Allow") { answer(permission, allow: true) }
                    .disabled(!isCurrent(permission) || !store.canMutate)
                Button("Deny", role: .cancel) { answer(permission, allow: false) }
                    .disabled(!isCurrent(permission) || !store.canMutate)
            } message: { permission in
                Text(permission.request.detail ?? "")
            }
            .onAppear { active = true; presentNext() }
            .onDisappear { active = false; presented = false; pending = nil }
            .onChange(of: enabled) { presentNext() }
            .onChange(of: store.activityContext) { presentNext() }
            .onChange(of: store.selectedID) { presentNext() }
            .onChange(of: store.interactions.filter { $0.kind == "confirm" }.map(\.id)) { presentNext() }
            .onChange(of: store.acknowledgedInteractionIDs) { presentNext() }
            .onChange(of: presented) { _, showing in
                if !showing { Task { await Task.yield(); presentNext() } }
            }
    }

    private func isCurrent(_ permission: Pending) -> Bool {
        enabled && active && store.connected && store.ownsControl
            && store.activityContext.connection == permission.connection
            && store.selectedID == permission.sessionID
            && store.snapshot?.sessionId == permission.sessionID
            && store.control == permission.control
            && !store.acknowledgedInteractionIDs.contains(permission.request.id)
            && store.interactions.contains { $0.id == permission.request.id && $0.kind == "confirm" }
    }

    private func presentNext() {
        guard enabled, active else {
            presented = false; pending = nil
            return
        }
        // Busy alone disables buttons, but must not dismiss a valid native dialog.
        if presented, let pending {
            if !isCurrent(pending) { presented = false; self.pending = nil }
            return
        }
        guard !answering, store.canMutate, let sessionID = store.selectedID,
              let request = store.interactions.first(where: {
                  $0.kind == "confirm" && !store.acknowledgedInteractionIDs.contains($0.id)
              }) else { return }
        pending = Pending(request: request, connection: store.activityContext.connection,
                          sessionID: sessionID, control: store.control)
        presented = true
    }

    private func answer(_ permission: Pending, allow: Bool) {
        guard !answering else { return }
        answering = true
        Task {
            // Native alerts can outlive selection, connection, control, or presenter changes.
            if isCurrent(permission), store.canMutate {
                _ = await store.answer(permission.request, value: .bool(allow))
            }
            answering = false
            await Task.yield()
            // A failed answer remains pending for another explicit human choice, never replayed.
            presentNext()
        }
    }
}
#endif
