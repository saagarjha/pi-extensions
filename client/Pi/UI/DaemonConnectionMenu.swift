import SwiftUI
#if os(macOS)

import AppKit

/// Retains the existing connection controls without changing where the window presents them.
struct DaemonConnectionMenu: View {
    @EnvironmentObject private var store: DaemonSessionStore
    @Binding var executablePath: String

    var body: some View {
        Menu {
            Text(store.connected ? (store.ownsControl ? "Connected · Controlling" : "Connected · Watching") : "Disconnected")
            if !store.connected {
                Button("Reconnect") { Task { await store.connect() } }
                if !executablePath.isEmpty {
                    Button("Start Pi") { Task { await store.connect(executable: URL(fileURLWithPath: executablePath)) } }
                }
                Button("Choose Pi Executable…") { chooseExecutable() }
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

    private func chooseExecutable() {
        let panel = NSOpenPanel()
        panel.title = "Choose the Pi executable (not a session file)"
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            executablePath = url.path
            UserDefaults.standard.set(url.path, forKey: "daemonExecutable")
            Task { await store.connect(executable: url) }
        }
    }
}

#Preview("Connection controls") {
    DaemonConnectionMenu(executablePath: .constant(""))
        .environmentObject(PreviewFixtures.daemonStore())
        .padding()
}
#endif
