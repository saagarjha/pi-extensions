import SwiftUI
import Combine
#if os(macOS)

/// Window composition and window-lifetime state; feature UI lives in focused child views.
struct ContentView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    var automaticallyConnect = true
    // Never key this state to the current snapshot/session: unsent drafts survive selection changes.
    @State private var draft = ""
    @State private var activity: ActivityPanel?
    @State private var showsPermissionsInspector = false
    @State private var inspectorContentMinimum: CGFloat = 800
    @State private var splitVisibility: NavigationSplitViewVisibility = .all
    @State private var previousSplitVisibility: NavigationSplitViewVisibility = .all
    @State private var collapsedForInspector = false
    @State private var retiringInspector = false
    @State private var windowContentWidth: CGFloat = 0

    private var selectedSession: LinkSession? {
        store.sessions.first { $0.id == store.presentedSelectionID }
    }

    private var modelName: String {
        store.currentModel?.name ?? store.currentModel?.id ?? ""
    }

    private var sessionTitle: String {
        if !store.selectionPending, let live = store.live { return LinkSession.displayTitle(live.sessionName) }
        return selectedSession?.title ?? "Pi"
    }

    private var sessionSubtitle: String {
        if store.selectionPending { return store.selectionLoading ? "Loading…" : "Not loaded" }
        guard let thinking = store.live?.thinking, !thinking.isEmpty else { return modelName }
        return "\(modelName) (\(thinking))"
    }

    private func showPermissions() {
        guard !showsPermissionsInspector else { return }
        if windowContentWidth < 1020, splitVisibility != .detailOnly {
            previousSplitVisibility = splitVisibility
            collapsedForInspector = true
            splitVisibility = .detailOnly
        }
        // Lay out the split at its content minimum *before* SwiftUI chooses the
        // inspector presentation. Changing both in one update slides the sidebar.
        inspectorContentMinimum = 520
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            showsPermissionsInspector = true
        }
    }

    private func hidePermissions() {
        retiringInspector = true
        showsPermissionsInspector = false
    }

    private func restoreAfterInspectorRetires(at leadingEdge: CGFloat) {
        guard retiringInspector, leadingEdge >= windowContentWidth - 1 else { return }
        retiringInspector = false
        // The native inspector remains in the split layout briefly after its
        // divider moves offscreen. Restoring the sidebar immediately makes AppKit
        // enlarge the window to fit both side columns again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard !showsPermissionsInspector else { return }
            inspectorContentMinimum = 800
            if collapsedForInspector {
                collapsedForInspector = false
                splitVisibility = previousSplitVisibility
            }
        }
    }

    private var sessionWindow: some View {
        NavigationSplitView(columnVisibility: $splitVisibility) {
            SessionSidebarView { Task { await store.create() } }
        } detail: {
            SelectedSessionContent(store: store, draft: $draft)
            .navigationTitle(sessionTitle)
            .navigationSubtitle(sessionSubtitle)
            .background {
                WindowTitlePopover(title: sessionTitle) {
                    SessionSettingsView().environmentObject(store)
                        .disabled(store.selectionPending)
                }
                .frame(width: 0, height: 0)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if let error = store.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).font(.callout).textSelection(.enabled)
                        Spacer()
                        if !store.connected, store.localConnectionFailed {
                            Button("Retry Pi") { Task { await store.connect() } }
                                .disabled(store.busy)
                        }
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
                    SessionActivityControls(subagentCount: store.selectionPending ? nil : store.live?.asyncWork?.subagents,
                                            backgroundCount: store.selectionPending ? nil : store.live?.asyncWork?.background,
                                            activity: $activity)
                        .disabled(store.selectionPending)
                    if !showsPermissionsInspector {
                        Button {
                            showPermissions()
                        } label: {
                            Label("Permissions", systemImage: "sidebar.right")
                        }
                        .help("Show permissions inspector")
                        .disabled(store.selectionPending)
                    }
                }
            }
            .sheet(item: $activity) { panel in
                ActivityPanelHost(panel: panel, owner: store) { activity = nil }
                    .disabled(store.selectionPending)
            }
        }
        .inspector(isPresented: $showsPermissionsInspector) {
            PermissionsInspectorHost(owner: store)
                .disabled(store.selectionPending)
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minX } action: { leadingEdge in
                    restoreAfterInspectorRetires(at: leadingEdge)
                }
                .toolbar {
                    if showsPermissionsInspector {
                        ToolbarItem(placement: .primaryAction) {
                            Button {
                                hidePermissions()
                            } label: {
                                Label("Hide Permissions", systemImage: "sidebar.right")
                            }
                            .help("Hide permissions inspector")
                        }
                    }
                }
        }
        .frame(minWidth: inspectorContentMinimum, minHeight: 520)
        .onChange(of: showsPermissionsInspector) { wasPresented, isPresented in
            if wasPresented, !isPresented { retiringInspector = true }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            windowContentWidth = width
            if showsPermissionsInspector, width < 1020,
               splitVisibility != .detailOnly {
                previousSplitVisibility = splitVisibility
                collapsedForInspector = true
                splitVisibility = .detailOnly
            }
            // The native inspector cannot fit below the main window minimum;
            // dismiss it before a live window resize reaches that layout.
            if showsPermissionsInspector, width < 800 {
                hidePermissions()
            }
        }
        .task {
            guard automaticallyConnect, !store.connected, !store.busy else { return }
            await store.connect()
        }
        .modifier(DaemonPermissionAlerts(store: store, enabled: activity == nil && !store.selectionPending))
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

/// Reread current owner state only in the transcript subtree for eligible partials.
private struct SelectedSessionContent: View {
    @ObservedObject var store: DaemonSessionStore
    @Binding var draft: String
    @State private var displayRevision: UInt64 = 0

    var body: some View {
        let _ = displayRevision
        let presentedSessionID = store.snapshot?.sessionId
        // Keep the transcript owner alive across selection intent; actual session
        // changes still reset its collection, document, and Find observation scopes.
        ZStack {
        SessionView(
            hasSession: store.snapshot != nil, connected: store.connected, isPresented: !store.selectionPending,
            messages: store.messages, localMessages: store.presentedSubmissions(for: store.selectedID),
            queuedMessages: store.presentedQueue(for: store.selectedID),
            retrySubmission: { store.retrySubmission($0) }, isStreaming: store.live?.streaming == true,
            interactions: store.interactions, canMutate: store.canMutate, ownsControl: store.ownsControl,
            draft: $draft,
            enqueue: { text, images, followUp in
                guard let target = presentedSessionID,
                      target == store.selectedID, store.snapshot?.sessionId == target else { return false }
                return store.submitMessage(text, images: images, followUp: followUp, for: target)
            },
            imageInputSupported: store.live?.model?.input?.contains("image") != false,
            sendUnavailableReason: store.snapshot != nil && store.snapshot?.ownerIncarnation == nil
                ? "Reload the daemon to send messages." : nil,
            abort: { _ = await store.mutate("abort") },
            answer: { request, value in Task { await store.answer(request, value: value) } },
            sessionID: store.snapshot?.sessionId,
            workingMessage: store.workingMessage,
            localCompletionDirectory: store.connected && store.remoteOrigin == nil ? store.snapshot?.cwd : nil,
            commands: store.live?.commands ?? [],
            commandCompletions: { name, prefix in
                guard let sessionID = store.snapshot?.sessionId else { return nil }
                return await store.commandCompletions(name: name, prefix: prefix, sessionID: sessionID)
            },
            nativeMarkdownEvents: store.activityFrames.eraseToAnyPublisher(),
            contextUsage: store.connected && !store.selectionPending && store.selectedID != nil
                && store.snapshot?.sessionId == store.selectedID ? store.live?.contextUsage : nil,
            statusFooterData: store.connected && !store.selectionPending && store.selectedID != nil
                && store.snapshot?.sessionId == store.selectedID ? store.statusFooterData : nil,
            compacting: store.connected && !store.selectionPending && store.selectedID != nil
                && store.snapshot?.sessionId == store.selectedID && store.live?.compacting == true
        )
        .environment(\.localPathDirectory, store.connected && store.remoteOrigin == nil ? store.snapshot?.cwd : nil)
        .environment(\.subagentDisplayNames, store.subagentDisplayNames(for: presentedSessionID))
        .modifier(PathTargetsModifier(services: store.connected && store.remoteOrigin == nil ? store.live?.services : nil))
        .onReceive(store.partialTranscriptPublications) { id in
            guard id == presentedSessionID else { return }
            displayRevision &+= 1
        }
        .opacity(store.selectionPending ? 0 : 1)
        .allowsHitTesting(!store.selectionPending)
        .disabled(store.selectionPending)
        .accessibilityHidden(store.selectionPending)
        if store.selectionPending {
            VStack(spacing: 12) {
                if store.selectionLoading {
                    ProgressView()
                    Text("Loading session…")
                } else {
                    ContentUnavailableView("Session not loaded", systemImage: "exclamationmark.circle",
                                           description: Text("Select the session again to retry."))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("session-selection-loading")
        }
        }
    }
}
#else
struct ContentView: View {
    var body: some View { ContentUnavailableView("macOS daemon client required", systemImage: "desktopcomputer") }
}
#endif
