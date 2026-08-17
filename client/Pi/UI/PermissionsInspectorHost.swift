#if os(macOS)
import SwiftUI

/// Keeps the inspector on the same attached-session authority as the activity panels.
struct PermissionsInspectorHost: View {
    @ObservedObject var owner: DaemonSessionStore
    let sessionID: String?
    @StateObject private var activity: ActivityStore

    init(owner: DaemonSessionStore, sessionID: String? = nil) {
        self.owner = owner; self.sessionID = sessionID
        _activity = StateObject(wrappedValue: ActivityStore(
            read: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                if let sessionID {
                    return try await owner.readService(service, operation: operation,
                        args: args, serviceGeneration: generation, for: sessionID)
                }
                return try await owner.readService(service, operation: operation,
                    args: args, serviceGeneration: generation)
            },
            mutate: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                if let sessionID {
                    return try await owner.mutateService(service, operation: operation,
                        args: args, serviceGeneration: generation, for: sessionID)
                }
                return try await owner.mutateService(service, operation: operation,
                    args: args, serviceGeneration: generation)
            }
        ))
    }

    var body: some View {
        let state = sessionID.flatMap { owner.windowPresentation(for: $0) }
        let services = sessionID == nil ? owner.live?.services : state?.services
        let canMutate = sessionID == nil ? owner.canMutate : state?.canMutate == true
        PermissionsInspectorView(
            state: services?.permissions?.value,
            connected: owner.connected && (sessionID == nil || state != nil),
            canEdit: canMutate && !activity.busy && !activity.permissionsBusy,
            serviceGeneration: services?.permissions?.serviceGeneration,
            pending: activity.permissionsBusy,
            error: activity.error,
            // Capture the stable operation store, not this whole observed host.
            // Revision and generation remain explicit arguments captured by the editor.
            mutate: { [activity] mutation, revision, generation in
                await activity.mutatePermissions(mutation, expectedRevision: revision,
                                                 serviceGeneration: generation)
            }
        )
        .environment(\.localPathDirectory,
                     owner.connected && owner.remoteOrigin == nil
                         ? (sessionID == nil ? owner.snapshot?.cwd : state?.snapshot.cwd) : nil)
        .onAppear { synchronize() }
        .onChange(of: owner.activityContext(for: sessionID)) { synchronize() }
        .onChange(of: services) { synchronize() }
        .onReceive(owner.activityFrames(for: sessionID)) { frame in
            synchronize()
            activity.receive(frame)
        }
    }

    private func synchronize() {
        let services = sessionID == nil ? owner.live?.services : owner.windowPresentation(for: sessionID!)?.services
        activity.synchronize(owner.activityContext(for: sessionID), services: services)
    }
}
#endif
