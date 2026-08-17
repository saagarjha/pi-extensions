#if os(macOS)
import SwiftUI

/// Binds the platform-neutral activity presentation to this window's existing connection.
struct ActivityPanelHost: View {
    let panel: ActivityPanel
    @ObservedObject var owner: DaemonSessionStore
    let dismiss: () -> Void
    @StateObject private var activity: ActivityStore

    init(panel: ActivityPanel, owner: DaemonSessionStore, dismiss: @escaping () -> Void) {
        self.panel = panel; self.owner = owner; self.dismiss = dismiss
        _activity = StateObject(wrappedValue: ActivityStore(
            read: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                return try await owner.readService(service, operation: operation, args: args, serviceGeneration: generation)
            },
            mutate: { [weak owner] service, operation, args, generation in
                guard let owner else { throw LinkFailure("Session closed") }
                return try await owner.mutateService(service, operation: operation, args: args, serviceGeneration: generation)
            }
        ))
    }

    var body: some View {
        ActivityView(panel: panel, store: activity, dismiss: dismiss)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                let requests = owner.interactions.filter { $0.kind != "confirm" }
                let context = owner.activityContext
                if !requests.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(requests) { request in
                                DaemonInteractionView(request: request, enabled: owner.canMutate) { value in
                                    Task {
                                        guard owner.activityContext.connection == context.connection,
                                              owner.activityContext.sessionID == context.sessionID,
                                              owner.control == context.control,
                                              owner.interactions.contains(where: { $0.id == request.id }) else { return }
                                        _ = await owner.answer(request, value: value)
                                    }
                                }
                            }
                        }.padding(16)
                    }
                    .frame(maxHeight: 240)
                    .background(.regularMaterial)
                }
            }
            .modifier(DaemonPermissionAlerts(store: owner, enabled: true))
            .onAppear { synchronize() }
            .onChange(of: owner.activityContext) { synchronize() }
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
