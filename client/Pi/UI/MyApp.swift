import SwiftUI
#if os(macOS)
import Combine
#endif

@main struct MyApp: App {
    #if os(macOS)
    @StateObject private var scenePresentation: AppScenePresentation
    @StateObject private var notifications: SessionNotifications
    @State private var showsRemoteConnection = false
    #endif

    init() {
        #if os(macOS)
        let store = DaemonSessionStore()
        _scenePresentation = StateObject(wrappedValue: AppScenePresentation(owner: store))
        _notifications = StateObject(wrappedValue: SessionNotifications(store: store))
        #endif
    }

    #if os(macOS)
    private var store: DaemonSessionStore { scenePresentation.owner }
    #endif

    var body: some Scene {
        WindowGroup(id: "sessions") {
            #if os(macOS)
            ContentView()
                .environmentObject(store)
                .background {
                    SessionNotificationWindow(notifications: notifications, sessionID: scenePresentation.value.sessionID,
                                              remoteOrigin: scenePresentation.value.remoteOrigin,
                                              connected: scenePresentation.value.connected)
                        .frame(width: 0, height: 0)
                }
                .sheet(isPresented: $showsRemoteConnection) {
                    RemoteConnectionSheet().environmentObject(store)
                }
            #else
            ContentView()
            #endif
        }
        .commands {
            SidebarCommands()
            #if os(macOS)
            CommandGroup(after: .newItem) {
                Button("Connect to Remote…") { showsRemoteConnection = true }
                    .disabled(scenePresentation.value.remoteConnectionDisabled)
            }
            #endif
        }
        #if os(macOS)
        WindowGroup("Session", id: "session-detail", for: String.self) { $sessionID in
            if let sessionID {
                PoppedSessionView(sessionID: sessionID, notifications: notifications)
                    .environmentObject(store)
            }
        }
        #endif
    }
}

#if os(macOS)
/// Only App/Scene metadata drives the application graph. Child views keep the
/// original authoritative owner and its original publishers/environment.
@MainActor private final class AppScenePresentation: ObservableObject {
    struct Value: Equatable {
        let sessionID: String?
        let remoteOrigin: String?
        let connected: Bool
        let remoteConnectionDisabled: Bool
    }

    let owner: DaemonSessionStore
    @Published private(set) var value: Value
    private var subscription: AnyCancellable?

    init(owner: DaemonSessionStore) {
        self.owner = owner
        value = Value(sessionID: owner.snapshot?.sessionId,
                      remoteOrigin: owner.remoteOrigin,
                      connected: owner.connected,
                      remoteConnectionDisabled: owner.busy || owner.occupiedSelection != nil)
        let disabled = Publishers.CombineLatest(
            owner.$busy,
            owner.$occupiedSelection.map { $0 != nil }.removeDuplicates()
        ).map { $0.0 || $0.1 }.removeDuplicates()
        subscription = Publishers.CombineLatest4(
            owner.$snapshot.map { $0?.sessionId }.removeDuplicates(),
            owner.$remoteOrigin.removeDuplicates(),
            owner.$connected.removeDuplicates(),
            disabled
        )
        .map { Value(sessionID: $0.0, remoteOrigin: $0.1, connected: $0.2,
                     remoteConnectionDisabled: $0.3) }
        .removeDuplicates()
        .sink { [weak self] next in
            guard let self, self.value != next else { return }
            self.value = next
        }
    }
}
#endif
