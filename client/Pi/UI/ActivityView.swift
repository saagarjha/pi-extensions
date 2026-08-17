import SwiftUI

enum ActivityPanel: String, Identifiable {
    case subagents = "Subagents"
    case tasks = "Background Tasks"

    var id: String { rawValue }
}

/// The subagent list mirrors the session sidebar: title, message count and
/// activity status, then a short preview of the latest user/assistant content.
private struct SubagentSidebarRow: View {
    let child: LinkSubagent
    let selected: Bool

    #if os(macOS)
    @Environment(\.controlActiveState) private var controlActiveState
    private var highlighted: Bool { selected && controlActiveState == .key }
    private var selectedText: Color { Color(nsColor: .alternateSelectedControlTextColor) }
    #else
    private var highlighted: Bool { false }
    private var selectedText: Color { .primary }
    #endif
    private var primaryText: Color { highlighted ? selectedText : .primary }
    private var secondaryText: Color { highlighted ? selectedText.opacity(0.8) : .secondary }
    private var statusColor: Color {
        if highlighted { return selectedText }
        switch child.lifecycleStatus {
        case "running": return .green
        case "idle": return .blue
        default: return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if child.lifecycleStatus == "running" {
                    ProgressView().controlSize(.mini)
                        .tint(highlighted ? selectedText : .accentColor)
                        .accessibilityLabel("Running")
                } else {
                    Color.clear.frame(height: 12).accessibilityHidden(true)
                }
            }
            .frame(width: 14)
            VStack(alignment: .leading, spacing: 4) {
                Text(child.name).font(.headline).foregroundStyle(primaryText).lineLimit(1)
                HStack(alignment: .firstTextBaseline) {
                    if let count = child.messageCount {
                        Text(count == 1 ? "1 message" : "\(count.formatted()) messages")
                            .foregroundStyle(primaryText)
                    }
                    Spacer(minLength: 4)
                    Text(child.lifecycleStatus.capitalized).foregroundStyle(statusColor)
                }
                .font(.subheadline).lineLimit(1)
                if let latest = child.latestMessage, !latest.isEmpty {
                    Text(latest).font(.caption).foregroundStyle(secondaryText).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Activity selection is independent of the root session. Closing this view never stops work.
struct ActivityView: View {
    let panel: ActivityPanel
    @ObservedObject var store: ActivityStore
    let dismiss: () -> Void
    var permissionPresentationAllowed = true
    var onPermissionPresentationChange: (Bool) -> Void = { _ in }
    #if os(macOS)
    var onWindowChange: (NSWindow?) -> Void = { _ in }
    var onSheetEnd: (NSWindow) -> Void = { _ in }
    #endif

    @State private var drafts: [String: String] = [:]
    @State private var subagentSearchText = ""
    @State private var permission: ChildPermission?
    @State private var showsPermission = false
    @State private var answeringPermission = false
    @State private var answeredPermissions: Set<String> = []

    private struct ChildPermission {
        let request: LinkInteraction
        let childID: String
        let revision: Int
        let contextID: UUID
        var key: String { "\(contextID):\(childID):\(revision):\(request.id)" }
    }

    private var selectedTask: LinkBackgroundTask? {
        store.tasks.first { $0.id == store.selectedTaskID }
    }

    private var selectedChild: LinkSubagent? {
        store.subagents.first { $0.id == store.selectedSubagentID }
    }

    private var filteredSubagents: [LinkSubagent] {
        store.subagents.filter { child in
            subagentSearchText.isEmpty || child.name.localizedCaseInsensitiveContains(subagentSearchText)
                || (child.latestMessage?.localizedCaseInsensitiveContains(subagentSearchText) ?? false)
        }.sorted(by: LinkSubagent.tuiOrder)
    }

    private var title: String {
        switch panel {
        case .tasks: selectedTask?.title ?? panel.rawValue
        case .subagents: selectedChild?.name ?? panel.rawValue
        }
    }

    private var subtitle: String {
        panel == .subagents ? selectedChild?.modelLabel ?? "" : ""
    }

    private var permissionRequestIDs: [String] {
        store.childInteractions.filter { $0.kind == "confirm" }.map(\.id)
    }

    private var actionEnabled: Bool {
        panel == .tasks && store.connected && store.canMutate && !store.busy
            && selectedTask?.isRunning == true
    }

    private func performAction() {
        guard actionEnabled else { return }
        let id = store.selectedTaskID
        Task {
            guard store.selectedTaskID == id else { return }
            await store.stopTask()
        }
    }

    var body: some View {
        panelContent
        .frame(minWidth: 640, idealWidth: 900, minHeight: 440, idealHeight: 640)
        .alert(permission?.request.title ?? "Permission request",
               isPresented: $showsPermission, presenting: permission) { pending in
            Button("Allow") { answerPermission(pending, allow: true) }
                .disabled(!canAnswer(pending))
            Button("Deny", role: .cancel) { answerPermission(pending, allow: false) }
                .disabled(!canAnswer(pending))
        } message: { pending in
            Text(pending.request.detail ?? "")
        }
        .onAppear { presentNextPermission() }
        .onDisappear { onPermissionPresentationChange(false) }
        .onChange(of: permissionPresentationAllowed) { presentNextPermission() }
        .onChange(of: showsPermission) { _, presented in
            onPermissionPresentationChange(presented)
            if !presented { Task { await Task.yield(); presentNextPermission() } }
        }
        .onChange(of: permissionRequestIDs) { presentNextPermission() }
        .onChange(of: store.selectedSubagentID) { presentNextPermission() }
        .onChange(of: store.childContextID) {
            answeredPermissions.removeAll()
            presentNextPermission()
        }
        .onChange(of: selectedChild?.controlRevision) { presentNextPermission() }
        .onChange(of: store.canMutate) { presentNextPermission() }
        .onChange(of: store.connected) { presentNextPermission() }
        .onChange(of: store.childReady) { presentNextPermission() }
    }

    @ViewBuilder private var panelContent: some View {
        #if os(macOS)
        ActivityMacPanel(title: title, subtitle: subtitle,
                         actionLabel: panel == .tasks ? "Stop" : nil,
                         actionImage: panel == .tasks ? "stop.fill" : nil,
                         actionEnabled: actionEnabled, action: performAction, close: dismiss,
                         onWindowChange: onWindowChange, onSheetEnd: onSheetEnd) {
            navigationSplitContent
        }
        .ignoresSafeArea(.container, edges: .top)
        #else
        navigationSplitContent
        #endif
    }

    private var navigationSplitContent: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle(panel.rawValue)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 360)
        } detail: {
            detail
                .navigationTitle(title)
                #if os(macOS)
                .navigationSubtitle(subtitle)
                #endif
                .safeAreaInset(edge: .top, spacing: 0) {
                    if panel == .tasks { notices }
                }
                #if !os(macOS)
                .toolbar {
                    ToolbarItemGroup {
                        if panel == .tasks {
                            Button("Stop", systemImage: "stop.fill", action: performAction)
                                .disabled(!actionEnabled)
                                .help("Stop the selected background command")
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Close", action: dismiss).keyboardShortcut(.cancelAction)
                    }
                }
                #endif
        }
    }

    @ViewBuilder private var sidebar: some View {
        if panel == .tasks {
            List(selection: Binding(get: { store.selectedTaskID }, set: { id in
                Task { await store.selectTask(id) }
            })) {
                ForEach(store.tasks, id: \.id) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.command).lineLimit(2)
                        Text(task.status).font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(task.id)
                }
            }
            .overlay { if store.tasks.isEmpty { sidebarEmpty("No background commands") } }
        } else {
            subagentList.searchable(text: $subagentSearchText, placement: .sidebar, prompt: "Search subagents")
        }
    }

    private var subagentList: some View {
        List(selection: Binding(get: { store.selectedSubagentID }, set: { id in
            guard let id else { return } // Filtering must not clear the selected child's detail.
            Task { await store.selectSubagent(id) }
        })) {
            ForEach(filteredSubagents, id: \.id) { child in
                SubagentSidebarRow(child: child, selected: store.selectedSubagentID == child.id)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if child.lifecycleStatus != "dismissed" {
                        Button("Dismiss", systemImage: "person.crop.circle.badge.minus", role: .destructive) {
                            Task { await store.dismissSubagent(child.id) }
                        }
                        .disabled(!store.connected || !store.canMutate || store.busy)
                    }
                }
                .tag(child.id)
            }
        }
        .overlay {
            if !subagentSearchText.isEmpty, filteredSubagents.isEmpty {
                ContentUnavailableView.search(text: subagentSearchText)
            } else if store.subagents.isEmpty {
                sidebarEmpty("No subagents")
            }
        }
    }

    private func sidebarEmpty(_ text: String) -> some View {
        VStack(spacing: 8) {
            if store.busy { ProgressView() }
            Text(text).font(.callout).foregroundStyle(.secondary)
        }.padding()
    }

    @ViewBuilder private var notices: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.connected {
                Label("Disconnected — showing last available activity", systemImage: "wifi.slash")
            } else if !store.ownsControl {
                Label("Read-only", systemImage: "lock")
            }
            if let error = store.error {
                Label(error, systemImage: "exclamationmark.circle").textSelection(.enabled)
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(store.error != nil || !store.connected || !store.ownsControl ? 12 : 0)
        .background(.regularMaterial)
    }

    @ViewBuilder private var detail: some View {
        if panel == .tasks {
            if let task = store.task, task.id == store.selectedTaskID {
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 16) {
                        CommandOutputView(target: task.target, command: task.command,
                                          timeoutMs: task.timeoutMs, output: task.output)
                        if let error = task.error {
                            Text(error).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        if let code = task.exitCode {
                            Text("Exit code: \(code)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
                }
                .defaultScrollAnchor(.bottomLeading)
                .defaultScrollAnchor(.topLeading, for: .alignment)
                .id(task.id)
            } else if store.selectedTaskID != nil, store.connected {
                if store.error != nil, !store.busy {
                    ContentUnavailableView("Command unavailable", systemImage: "exclamationmark.circle")
                } else {
                    ProgressView("Loading command…")
                }
            } else {
                ContentUnavailableView("Select a command", systemImage: "terminal",
                                       description: Text("Choose a background command from the sidebar."))
            }
        } else if let id = store.selectedSubagentID, selectedChild != nil {
            if store.childReady {
                let contextID = store.childContextID
                SessionView(
                    hasSession: true, connected: store.connected, messages: store.childMessages,
                    localMessages: store.childLocalMessages, queuedMessages: store.childQueuedMessages,
                    retrySubmission: { store.retryChildSubmission($0) },
                    isStreaming: store.childStreaming, interactions: store.childInteractions,
                    canMutate: store.connected && store.canMutate, ownsControl: store.ownsControl,
                    draft: Binding(get: { drafts[id, default: ""] }, set: { drafts[id] = $0 }),
                    enqueue: { text, images, followUp in
                        guard store.selectedSubagentID == id, store.childContextID == contextID else { return false }
                        return store.enqueueChild(text, images: images, followUp: followUp)
                    },
                    imageInputSupported: store.childSupportsImages,
                    sendUnavailableReason: store.childSendUnavailableReason,
                    abort: {
                        guard store.selectedSubagentID == id, store.childContextID == contextID else { return }
                        await store.abortChild()
                    },
                    answer: { request, value in
                        Task {
                            guard store.selectedSubagentID == id, store.childContextID == contextID else { return }
                            _ = await store.answerChild(request, value: value)
                        }
                    },
                    sessionID: store.childSessionID,
                    workingMessage: store.childWorkingMessage,
                    localCompletionDirectory: store.childLocalDirectory,
                    commands: store.childCommands,
                    commandCompletions: { name, prefix in
                        await store.childCommandCompletions(name: name, prefix: prefix,
                                                            childID: id, contextID: contextID)
                    },
                    contextUsage: store.connected ? store.childContextUsage : nil,
                    statusFooterData: store.connected ? store.childStatusFooterData : nil,
                    compacting: store.connected && store.childCompacting
                )
                .environment(\.localPathDirectory, store.connected ? store.childLocalDirectory : nil)
                .environment(\.subagentDisplayNames, store.childSubagentDisplayNames)
                .environment(\.pathTargets, store.connected ? store.childPathTargets : [])
                .id(id)
            } else if store.connected {
                if store.error != nil, !store.busy {
                    ContentUnavailableView("Subagent unavailable", systemImage: "exclamationmark.circle")
                } else {
                    ContentUnavailableView {
                        Label("Loading subagent…", systemImage: "person.3")
                    } description: {
                        ProgressView()
                    }
                }
            } else {
                ContentUnavailableView("Subagent unavailable", systemImage: "wifi.slash",
                                       description: Text("Reconnect to load this session."))
            }
        } else {
            ContentUnavailableView("Select a subagent", systemImage: "person.3",
                                   description: Text("Choose a subagent from the sidebar."))
        }
    }

    private func canAnswer(_ pending: ChildPermission) -> Bool {
        store.connected && store.canMutate && store.childReady
            && store.childContextID == pending.contextID
            && store.selectedSubagentID == pending.childID
            && selectedChild?.controlRevision == pending.revision
            && store.childInteractions.contains { $0.id == pending.request.id && $0.kind == "confirm" }
    }

    private func presentNextPermission() {
        guard panel == .subagents, permissionPresentationAllowed else {
            showsPermission = false; permission = nil
            return
        }
        guard !answeringPermission else { return }
        let pending = selectedChild.flatMap { child in
            store.childInteractions.filter { $0.kind == "confirm" }.map {
                ChildPermission(request: $0, childID: child.id, revision: child.controlRevision,
                                contextID: store.childContextID)
            }.first { !answeredPermissions.contains($0.key) }
        }
        guard let pending, canAnswer(pending) else {
            showsPermission = false
            permission = nil
            return
        }
        if showsPermission {
            if permission?.key != pending.key {
                showsPermission = false
                permission = nil
            }
            return
        }
        permission = pending
        showsPermission = true
    }

    private func answerPermission(_ pending: ChildPermission, allow: Bool) {
        guard !answeringPermission else { return }
        answeringPermission = true
        Task {
            if canAnswer(pending), await store.answerChild(pending.request, value: .bool(allow)) {
                // Acknowledgement may precede the canonical interaction-resolved update.
                answeredPermissions.insert(pending.key)
            }
            answeringPermission = false
            await Task.yield()
            presentNextPermission()
        }
    }
}

#Preview("Background Tasks") {
    @Previewable @StateObject var store = ActivityStore.preview()
    ActivityView(panel: .tasks, store: store, dismiss: {})
}

#Preview("Subagents") {
    @Previewable @StateObject var store = ActivityStore.preview()
    ActivityView(panel: .subagents, store: store, dismiss: {})
}
