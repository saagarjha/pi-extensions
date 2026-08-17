#if os(macOS)
import SwiftUI

/// Keeps the inspector on the same attached-session authority as the activity panels.
struct PermissionsInspectorHost: View {
    @ObservedObject var owner: DaemonSessionStore
    @StateObject private var activity: ActivityStore

    init(owner: DaemonSessionStore) {
        self.owner = owner
        _activity = StateObject(wrappedValue: ActivityStore(
            read: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                return try await owner.readService(service, operation: operation,
                    args: args, serviceGeneration: generation)
            },
            mutate: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                return try await owner.mutateService(service, operation: operation,
                    args: args, serviceGeneration: generation)
            }
        ))
    }

    var body: some View {
        PermissionsInspectorView(
            state: owner.live?.services?.permissions?.value,
            connected: owner.connected,
            canEdit: owner.canMutate && !activity.busy && !activity.permissionsBusy,
            serviceGeneration: owner.live?.services?.permissions?.serviceGeneration,
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
                     owner.connected && owner.remoteOrigin == nil ? owner.snapshot?.cwd : nil)
        .onAppear { synchronize() }
        .onChange(of: owner.activityContext) { synchronize() }
        .onChange(of: owner.live?.services) { synchronize() }
        .onReceive(owner.activityFrames) { frame in
            synchronize()
            activity.receive(frame)
        }
    }

    private func synchronize() {
        activity.synchronize(owner.activityContext, services: owner.live?.services)
    }
}
#endif
