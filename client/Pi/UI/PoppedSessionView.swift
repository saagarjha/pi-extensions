#if os(macOS)
import SwiftUI

/// An independent window of the app's existing session attachment. The sidebar's
/// selected session can change without redirecting this window to another chat.
struct PoppedSessionView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    let sessionID: String
    let notifications: SessionNotifications
    @State private var draft = ""
    @State private var registered = false
    @State private var activity: ActivityPanel?
    @State private var showsPermissionsInspector = false
    @State private var inspectorContentMinimum: CGFloat = 800
    @State private var retiringInspector = false
    @State private var windowContentWidth: CGFloat = 0

    private func showPermissions() {
        guard !showsPermissionsInspector else { return }
        // Lower the transcript minimum before the native inspector joins the layout.
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
        // The inspector still occupies the split briefly after its divider leaves.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard !showsPermissionsInspector else { return }
            inspectorContentMinimum = 800
        }
    }

    private var pinned: DaemonSessionStore.WindowPresentation? {
        store.windowPresentation(for: sessionID)
    }
    private var modelSubtitle: String {
        guard let live = pinned?.live else { return "" }
        let model = live.model?.name ?? live.model?.id ?? ""
        guard let thinking = live.thinking, !thinking.isEmpty else { return model }
        return "\(model) (\(thinking))"
    }

    var body: some View {
        NavigationStack {
            PinnedSessionContent(store: store, sessionID: sessionID, draft: $draft)
                .navigationTitle(pinned?.title ?? "Session")
                .navigationSubtitle(modelSubtitle)
                .background {
                    WindowTitlePopover(title: pinned?.title ?? "Session") {
                        SessionSettingsView(sessionID: sessionID).environmentObject(store)
                    }
                    .frame(width: 0, height: 0)
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if pinned != nil, let error = store.windowErrors[sessionID] {
                        HStack(alignment: .top) {
                            Image(systemName: "exclamationmark.circle")
                            Text(error).font(.callout).textSelection(.enabled)
                            Spacer()
                            Button { store.dismissWindowError(for: sessionID) } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss error")
                        }
                        .padding(12)
                        .background(.regularMaterial)
                    }
                }
                .toolbar {
                    ToolbarItemGroup {
                        SessionActivityControls(subagentCount: pinned?.live.asyncWork?.subagents,
                                                backgroundCount: pinned?.live.asyncWork?.background,
                                                activity: $activity)
                        if !showsPermissionsInspector {
                            Button { showPermissions() } label: {
                                Label("Permissions", systemImage: "sidebar.right")
                            }
                            .help("Show permissions inspector")
                        }
                    }
                }
                .sheet(item: $activity) { panel in
                    ActivityPanelHost(panel: panel, owner: store, sessionID: sessionID) { activity = nil }
                }
        }
        .inspector(isPresented: $showsPermissionsInspector) {
            PermissionsInspectorHost(owner: store, sessionID: sessionID)
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minX } action: { leadingEdge in
                    restoreAfterInspectorRetires(at: leadingEdge)
                }
                .toolbar {
                    if showsPermissionsInspector {
                        ToolbarItem(placement: .primaryAction) {
                            Button { hidePermissions() } label: {
                                Label("Hide Permissions", systemImage: "sidebar.right")
                            }
                            .help("Hide permissions inspector")
                        }
                    }
                }
        }
        .background {
            SessionNotificationWindow(notifications: notifications, sessionID: pinned?.sessionID,
                                      remoteOrigin: store.remoteOrigin,
                                      connected: store.connected && pinned != nil, isMainWindow: false)
                .frame(width: 0, height: 0)
        }
        .frame(minWidth: inspectorContentMinimum, minHeight: 520)
        .onChange(of: showsPermissionsInspector) { wasPresented, isPresented in
            if wasPresented, !isPresented { retiringInspector = true }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            windowContentWidth = width
            // Match the main window: dismiss before live resizing reaches its minimum.
            if showsPermissionsInspector, width < 800 { hidePermissions() }
        }
        .modifier(PoppedSessionPermissionAlerts(store: store, sessionID: sessionID,
                                                  enabled: activity == nil))
        .onAppear {
            guard !registered else { return }
            registered = true
            store.registerWindow(for: sessionID)
            if store.connected { Task { await store.attachWindow(for: sessionID) } }
        }
        .task(id: store.connected) {
            if store.connected { await store.attachWindow(for: sessionID) }
        }
        .onDisappear {
            guard registered else { return }
            registered = false
            store.unregisterWindow(for: sessionID)
        }
    }

}

/// A pinned window reads its own current presentation, independent of main-window selection.
private struct PinnedSessionContent: View {
    @ObservedObject var store: DaemonSessionStore
    let sessionID: String
    @Binding var draft: String
    @State private var displayRevision: UInt64 = 0

    var body: some View {
        let _ = displayRevision
        Group {
            if let state = store.windowPresentation(for: sessionID) {
                SessionView(hasSession: true, connected: store.connected,
                    messages: state.transcript,
                    localMessages: store.presentedSubmissions(for: sessionID),
                    queuedMessages: store.presentedQueue(for: sessionID),
                    retrySubmission: { store.retrySubmission($0, for: sessionID) },
                    isStreaming: state.live.streaming, interactions: state.interactions,
                    canMutate: state.canMutate, ownsControl: state.controls,
                    draft: $draft,
                    enqueue: { text, images, followUp in
                        store.submitMessage(text, images: images, followUp: followUp, for: sessionID)
                    },
                    imageInputSupported: state.live.model?.input?.contains("image") != false,
                    sendUnavailableReason: state.snapshot.ownerIncarnation == nil
                        ? "Reload the daemon to send messages." : nil,
                    abort: { _ = await store.mutate("abort", for: sessionID) },
                    answer: { request, value in
                        Task { _ = await store.answer(request, value: value, for: sessionID) }
                    },
                    sessionID: state.sessionID,
                    workingMessage: state.workingMessage,
                    localCompletionDirectory: store.remoteOrigin == nil ? state.snapshot.cwd : nil,
                    commands: state.live.commands ?? [],
                    commandCompletions: { name, prefix in
                        await store.commandCompletions(name: name, prefix: prefix, for: sessionID)
                    },
                    nativeMarkdownEvents: store.activityFrames(for: sessionID),
                    contextUsage: store.connected && state.snapshot.sessionId == sessionID ? state.live.contextUsage : nil,
                    statusFooterData: store.connected && state.snapshot.sessionId == sessionID ? state.statusFooterData : nil,
                    compacting: store.connected && state.snapshot.sessionId == sessionID && state.live.compacting == true)
                    .environment(\.localPathDirectory, store.remoteOrigin == nil ? state.snapshot.cwd : nil)
                    .environment(\.subagentDisplayNames, store.subagentDisplayNames(for: sessionID))
                    .modifier(PathTargetsModifier(services: store.remoteOrigin == nil ? state.services : nil))
            } else if let error = store.windowErrors[sessionID] {
                ContentUnavailableView("Session unavailable", systemImage: "exclamationmark.bubble",
                                       description: Text(error))
                    .overlay(alignment: .bottom) {
                        Button("Try Again") { Task { await store.attachWindow(for: sessionID) } }
                            .padding(.bottom, 70)
                    }
            } else {
                ProgressView("Opening session…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onReceive(store.partialTranscriptPublications) { id in
            guard id == sessionID else { return }
            displayRevision &+= 1
        }
    }
}

/// Permission confirmations belong to the pinned session, even when the main
/// window is currently displaying a different conversation.
struct PoppedSessionPermissionAlerts: ViewModifier {
    @ObservedObject var store: DaemonSessionStore
    let sessionID: String
    let enabled: Bool
    var onPresentationChange: (Bool) -> Void = { _ in }
    @State private var pending: LinkInteraction?
    @State private var presented = false
    @State private var answering = false
    @State private var active = false

    func body(content: Content) -> some View {
        content
            .alert(pending?.title ?? "Permission request",
                   isPresented: $presented, presenting: pending) { permission in
                Button("Allow") { answer(permission, allow: true) }
                    .disabled(!isCurrent(permission) || store.windowPresentation(for: sessionID)?.canMutate != true)
                Button("Deny", role: .cancel) { answer(permission, allow: false) }
                    .disabled(!isCurrent(permission) || store.windowPresentation(for: sessionID)?.canMutate != true)
            } message: { permission in
                Text(permission.detail ?? "")
            }
            .onAppear { active = true; presentNext() }
            .onDisappear { active = false; presented = false; pending = nil; onPresentationChange(false) }
            .onChange(of: store.windowPresentation(for: sessionID)?.interactions.filter { $0.kind == "confirm" }.map(\.id)) {
                presentNext()
            }
            .onChange(of: enabled) { presentNext() }
            .onChange(of: store.selectedID) { presentNext() }
            .onChange(of: store.acknowledgedInteractionIDs) { presentNext() }
            .onChange(of: presented) { _, showing in
                onPresentationChange(showing)
                if !showing { Task { await Task.yield(); presentNext() } }
            }
    }

    private func isCurrent(_ request: LinkInteraction) -> Bool {
        guard enabled, active, let state = store.windowPresentation(for: sessionID), state.controls,
              !store.windowHasAnswered(request.id, for: sessionID) else { return false }
        return state.interactions.contains { $0.id == request.id && $0.kind == "confirm" }
    }

    private func presentNext() {
        guard active, enabled else { presented = false; pending = nil; return }
        if presented, let pending {
            if !isCurrent(pending) { presented = false; self.pending = nil }
            return
        }
        guard !answering, let state = store.windowPresentation(for: sessionID), state.canMutate,
              let request = state.interactions.first(where: {
                  $0.kind == "confirm" && !store.windowHasAnswered($0.id, for: sessionID)
              }) else { return }
        pending = request
        presented = true
    }

    private func answer(_ request: LinkInteraction, allow: Bool) {
        guard !answering else { return }
        answering = true
        Task {
            if isCurrent(request), store.windowPresentation(for: sessionID)?.canMutate == true {
                _ = await store.answer(request, value: .bool(allow), for: sessionID)
            }
            answering = false
            await Task.yield()
            presentNext()
        }
    }
}
#endif
