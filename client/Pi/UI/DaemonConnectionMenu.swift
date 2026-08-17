import SwiftUI
#if os(macOS)

/// Connection controls use the same discovery/login-shell path as window startup.
struct DaemonConnectionMenu: View {
    @EnvironmentObject private var store: DaemonSessionStore

    var body: some View {
        Menu {
            Text(store.connected ? (store.ownsControl ? "Connected · Controlling" : "Connected · Watching") : "Disconnected")
            if !store.connected {
                Button("Reconnect") { Task { await store.connect() } }
            } else {
                Button("Refresh Sessions") { Task { await refresh() } }
                if store.snapshot != nil {
                    Divider()
                    Button(store.ownsControl ? "Release Control" : "Take Control") {
                        Task { if store.ownsControl { await store.releaseControl() } else { await store.takeControl() } }
                    }
                }
            }
        } label: {
            Label("Connection", systemImage: store.connected ? "bolt.horizontal.circle" : "bolt.horizontal.circle.fill")
        }
        .disabled(store.busy)
        .help(store.connected ? (store.ownsControl ? "Connected · Controlling" : "Connected · Watching") : "Disconnected")
    }

    private func refresh() async {
        do { try await store.refresh() } catch { store.error = error.localizedDescription }
    }

}

#Preview("Connection controls") {
    DaemonConnectionMenu()
        .environmentObject(PreviewFixtures.daemonStore())
        .padding()
}
#endif
