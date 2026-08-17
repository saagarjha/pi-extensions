import SwiftUI
#if os(macOS)

/// Window composition and window-lifetime state; feature UI lives in focused child views.
struct ContentView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    var automaticallyConnect = true
    // Never key this state to the current snapshot/session: unsent drafts survive selection changes.
    @State private var draft = ""
    @State private var activity: ActivityPanel?
    @State private var showsPermissionsInspector = false
    @State private var executablePath = UserDefaults.standard.string(forKey: "daemonExecutable") ?? ""

    private var selectedSession: LinkSession? {
        store.sessions.first { $0.id == store.selectedID }
    }

    private var modelName: String {
        store.currentModel?.name ?? store.currentModel?.id ?? ""
    }

    private var sessionTitle: String {
        if let live = store.live { return LinkSession.displayTitle(live.sessionName) }
        return selectedSession?.title ?? "Pi"
    }

    private var sessionSubtitle: String {
        guard let thinking = store.live?.thinking, !thinking.isEmpty else { return modelName }
        return "\(modelName) (\(thinking))"
    }

    private var sessionWindow: some View {
        NavigationSplitView {
            SessionSidebarView { Task { await store.create() } }
        } detail: {
            SessionView(
                hasSession: store.snapshot != nil, connected: store.connected,
                messages: store.messages, isStreaming: store.live?.streaming == true,
                interactions: store.interactions, canMutate: store.canMutate, ownsControl: store.ownsControl,
                draft: $draft,
                submit: { await store.mutate("prompt", args: [.string($0)]) },
                abort: { _ = await store.mutate("abort") },
                answer: { request, value in Task { await store.answer(request, value: value) } },
                sessionID: store.snapshot?.sessionId,
                workingMessage: store.workingMessage,
                localCompletionDirectory: store.connected && store.remoteOrigin == nil ? store.snapshot?.cwd : nil,
                commands: store.live?.commands ?? [],
                commandCompletions: { name, prefix in
                    guard let sessionID = store.snapshot?.sessionId else { return nil }
                    return await store.commandCompletions(name: name, prefix: prefix, sessionID: sessionID)
                }
            )
            .environment(\.localPathDirectory, store.connected && store.remoteOrigin == nil ? store.snapshot?.cwd : nil)
            .modifier(PathTargetsModifier(services: store.connected && store.remoteOrigin == nil ? store.live?.services : nil))
            .navigationTitle(sessionTitle)
            .navigationSubtitle(sessionSubtitle)
            .background {
                WindowTitlePopover(title: sessionTitle) {
                    SessionSettingsView().environmentObject(store)
                }
                .frame(width: 0, height: 0)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if let error = store.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).font(.callout).textSelection(.enabled)
                        Spacer()
                        Button { store.error = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss error")
                    }
                    .padding(12)
                    .background(.regularMaterial)
                }
            }
            .toolbar {
                ToolbarItemGroup {
                    SessionActivityControls(subagentCount: store.live?.asyncWork?.subagents,
                                            backgroundCount: store.live?.asyncWork?.background,
                                            activity: $activity)
                    if !showsPermissionsInspector {
                        Button {
                            showsPermissionsInspector = true
                        } label: {
                            Label("Permissions", systemImage: "sidebar.right")
                        }
                        .help("Show permissions inspector")
                    }
                }
            }
            .sheet(item: $activity) { panel in
                ActivityPanelHost(panel: panel, owner: store) { activity = nil }
            }
        }
        .inspector(isPresented: $showsPermissionsInspector) {
            PermissionsInspectorHost(owner: store)
                .toolbar {
                    if showsPermissionsInspector {
                        ToolbarItem(placement: .primaryAction) {
                            Button {
                                showsPermissionsInspector = false
                            } label: {
                                Label("Hide Permissions", systemImage: "sidebar.right")
                            }
                            .help("Hide permissions inspector")
                        }
                    }
                }
        }
        .frame(minWidth: showsPermissionsInspector ? 1020 : 760, minHeight: 520)
        .task {
            guard automaticallyConnect, !store.connected, !store.busy else { return }
            await store.connect()
            if !store.connected, !executablePath.isEmpty {
                await store.connect(executable: URL(fileURLWithPath: executablePath))
            }
        }
        .modifier(DaemonPermissionAlerts(store: store, enabled: activity == nil))
    }

    var body: some View {
        sessionWindow
        .confirmationDialog(
            "Another client is attached to this session",
            isPresented: Binding(
                get: { store.occupiedSelection != nil },
                set: { if !$0 { store.cancelOccupiedSelection() } }
            ),
            titleVisibility: .visible,
            presenting: store.occupiedSelection
        ) { session in
            Button("Watch") {
                let selection = session
                Task { await store.resolveOccupied(.watch, selection: selection) }
            }
            .disabled(!store.connected || store.busy)
            Button("Fork") {
                let selection = session
                Task { await store.resolveOccupied(.fork, selection: selection) }
            }
            .disabled(!store.connected || store.busy)
            Button("Steal", role: .destructive) {
                let selection = session
                Task { await store.resolveOccupied(.steal, selection: selection) }
            }
            .disabled(!store.connected || store.busy)
            Button("Cancel", role: .cancel) { store.cancelOccupiedSelection() }
        } message: { session in
            Text("Watch \"\(session.title)\" without controlling it, fork a separate session, or take control here.")
        }
    }

}

#Preview("Watching a session") {
    ContentView(automaticallyConnect: false)
        .environmentObject(PreviewFixtures.daemonStore())
}

#else
struct ContentView: View {
    var body: some View { ContentUnavailableView("macOS daemon client required", systemImage: "desktopcomputer") }
}
#endif
