#if os(macOS)
import SwiftUI

/// Binds the platform-neutral activity presentation to this window's existing connection.
struct ActivityPanelHost: View {
    let panel: ActivityPanel
    @ObservedObject var owner: DaemonSessionStore
    let sessionID: String?
    let dismiss: () -> Void
    @StateObject private var activity: ActivityStore
    // AppKit may attach only one confirmation sheet to this activity sheet.
    // Root and selected-child requests have separate authorities, but share
    // this one physical window. The currently displayed alert keeps its turn.
    @State private var rootAlertPresented = false
    @State private var childAlertPresented = false
    @State private var rootSheetEndPending = false
    @State private var childSheetEndPending = false
    @State private var activityWindow: NSWindow?

    private func rootPresentationChanged(_ showing: Bool) {
        if showing {
            rootSheetEndPending = false
            rootAlertPresented = true
        } else if rootAlertPresented, activityWindow?.attachedSheet != nil {
            // SwiftUI's isPresented becomes false before AppKit finishes ending
            // its native alert sheet. Opening the child alert now can be lost.
            rootSheetEndPending = true
        } else {
            rootAlertPresented = false
        }
    }

    private func childPresentationChanged(_ showing: Bool) {
        if showing {
            childSheetEndPending = false
            childAlertPresented = true
        } else if childAlertPresented, activityWindow?.attachedSheet != nil {
            // The child alert also owns the native sheet until AppKit ends it.
            childSheetEndPending = true
        } else {
            childAlertPresented = false
        }
    }

    private func sheetEnded(_ window: NSWindow) {
        guard activityWindow === window else { return }
        if rootSheetEndPending {
            rootSheetEndPending = false
            rootAlertPresented = false
        }
        if childSheetEndPending {
            childSheetEndPending = false
            childAlertPresented = false
        }
    }

    private var rootPermissionQueued: Bool {
        if let sessionID {
            guard let state = owner.windowPresentation(for: sessionID), state.canMutate else { return false }
            return state.interactions.contains {
                $0.kind == "confirm" && !owner.windowHasAnswered($0.id, for: sessionID)
            }
        }
        guard owner.canMutate, owner.selectedID == owner.snapshot?.sessionId else { return false }
        return owner.interactions.contains {
            $0.kind == "confirm" && !owner.acknowledgedInteractionIDs.contains($0.id)
        }
    }

    init(panel: ActivityPanel, owner: DaemonSessionStore, sessionID: String? = nil, dismiss: @escaping () -> Void) {
        self.panel = panel; self.owner = owner; self.sessionID = sessionID; self.dismiss = dismiss
        _activity = StateObject(wrappedValue: ActivityStore(
            read: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                if let sessionID {
                    return try await owner.readService(service, operation: operation, args: args,
                                                       serviceGeneration: generation, for: sessionID)
                }
                return try await owner.readService(service, operation: operation, args: args, serviceGeneration: generation)
            },
            mutate: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                if let sessionID {
                    return try await owner.mutateService(service, operation: operation, args: args,
                                                         serviceGeneration: generation, for: sessionID)
                }
                return try await owner.mutateService(service, operation: operation, args: args, serviceGeneration: generation)
            },
            submit: { [weak owner] operation, args, generation, submissionID, incarnation in
                guard let owner else { throw LinkFailure("Session closed") }
                if let sessionID {
                    return try await owner.submitChildMessage(operation, args: args,
                        serviceGeneration: generation, submissionID: submissionID,
                        ownerIncarnation: incarnation, for: sessionID)
                }
                return try await owner.submitChildMessage(operation, args: args,
                    serviceGeneration: generation, submissionID: submissionID, ownerIncarnation: incarnation)
            },
            observation: { [weak owner] id in
                guard let owner else { return nil }
                if let sessionID { return owner.childObservation(id, for: sessionID) }
                return owner.childObservation(id)
            }
        ))
    }

    var body: some View {
        Group {
            if let sessionID {
                activityContent.modifier(PoppedSessionPermissionAlerts(store: owner, sessionID: sessionID,
                                                                        enabled: !childAlertPresented,
                                                                        onPresentationChange: rootPresentationChanged))
            } else {
                activityContent.modifier(DaemonPermissionAlerts(store: owner, enabled: !childAlertPresented,
                                                                 onPresentationChange: rootPresentationChanged))
            }
        }
        .onAppear { synchronize() }
        .onChange(of: owner.activityContext(for: sessionID)) { synchronize() }
        .onReceive(owner.activityFrames(for: sessionID)) { frame in
            synchronize()
            activity.receive(frame)
        }
    }

    private var activityContent: some View {
        ActivityView(panel: panel, store: activity, dismiss: dismiss,
                     permissionPresentationAllowed: !rootAlertPresented && (!rootPermissionQueued || childAlertPresented),
                     onPermissionPresentationChange: childPresentationChanged,
                     onWindowChange: { activityWindow = $0 }, onSheetEnd: sheetEnded)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                let state = sessionID.flatMap { owner.windowPresentation(for: $0) }
                let requests = (sessionID == nil ? owner.interactions : state?.interactions ?? [])
                    .filter { $0.kind != "confirm" }
                let context = owner.activityContext(for: sessionID)
                if !requests.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(requests) { request in
                                DaemonInteractionView(request: request,
                                                      enabled: sessionID == nil ? owner.canMutate : state?.canMutate == true) { value in
                                    Task {
                                        let current = owner.activityContext(for: sessionID)
                                        guard current.connection == context.connection,
                                              current.sessionID == context.sessionID,
                                              current.control == context.control,
                                              (sessionID == nil ? owner.interactions
                                                  : owner.windowPresentation(for: sessionID!)?.interactions ?? [])
                                                .contains(where: { $0.id == request.id }) else { return }
                                        if let sessionID { _ = await owner.answer(request, value: value, for: sessionID) }
                                        else { _ = await owner.answer(request, value: value) }
                                    }
                                }
                            }
                        }.padding(16)
                    }
                    .frame(maxHeight: 240)
                    .background(.regularMaterial)
                }
            }
    }

    private func synchronize() {
        let services = sessionID == nil ? owner.live?.services : owner.windowPresentation(for: sessionID!)?.services
        let receipts = sessionID.map { owner.windowOperations(for: $0) } ?? owner.operations
        activity.synchronize(owner.activityContext(for: sessionID), services: services,
                             receipts: receipts)
    }
}
#endif
