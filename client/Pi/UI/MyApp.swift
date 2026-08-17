import SwiftUI

@main struct MyApp: App {
    #if os(macOS)
    @StateObject private var store: DaemonSessionStore
    @StateObject private var notifications: SessionNotifications
    @State private var showsRemoteConnection = false
    #endif

    init() {
        #if os(macOS)
        let store = DaemonSessionStore()
        _store = StateObject(wrappedValue: store)
        _notifications = StateObject(wrappedValue: SessionNotifications(store: store))
        #endif
    }

    var body: some Scene {
        WindowGroup(id: "sessions") {
            #if os(macOS)
            ContentView()
                .environmentObject(store)
                .background {
                    SessionNotificationWindow(notifications: notifications, sessionID: store.snapshot?.sessionId,
                                              remoteOrigin: store.remoteOrigin, connected: store.connected)
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
                    .disabled(store.busy || store.occupiedSelection != nil)
            }
            #endif
        }
    }
}
