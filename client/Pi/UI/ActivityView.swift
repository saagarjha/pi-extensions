import SwiftUI

enum ActivityPanel: String, Identifiable {
    case subagents = "Subagents"
    case tasks = "Background Tasks"

    var id: String { rawValue }
}

/// Activity selection is independent of the root session. Closing this view never stops work.
struct ActivityView: View {
    let panel: ActivityPanel
    @ObservedObject var store: ActivityStore
    let dismiss: () -> Void

    @State private var drafts: [String: String] = [:]
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
        store.connected && store.canMutate && !store.busy
            && (panel == .tasks ? selectedTask?.isRunning == true
                : selectedChild != nil && selectedChild?.dormant != true)
    }

    private func performAction() {
        guard actionEnabled else { return }
        if panel == .tasks {
            let id = store.selectedTaskID
            Task {
                guard store.selectedTaskID == id else { return }
                await store.stopTask()
            }
        } else {
            let id = store.selectedSubagentID
            Task {
                guard store.selectedSubagentID == id else { return }
                await store.dismissSubagent()
            }
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
        .onChange(of: showsPermission) { _, presented in
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
                         actionLabel: panel == .tasks ? "Stop" : "Dismiss",
                         actionImage: panel == .tasks ? "stop.fill" : "person.crop.circle.badge.minus",
                         actionEnabled: actionEnabled, action: performAction, close: dismiss) {
            sidebar
        } detail: {
            detail.safeAreaInset(edge: .top, spacing: 0) {
                if panel == .tasks { notices }
            }
            .frame(maxHeight: .infinity)
        }
        .ignoresSafeArea(.container, edges: .top)
        #else
        NavigationSplitView {
            sidebar
                .navigationTitle(panel.rawValue)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 360)
        } detail: {
            detail
                .navigationTitle(title)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if panel == .tasks { notices }
                }
                .toolbar {
                    ToolbarItemGroup {
                        if panel == .tasks {
                            Button("Stop", systemImage: "stop.fill", action: performAction)
                                .disabled(!actionEnabled)
                                .help("Stop the selected background command")
                        } else {
                            Button("Dismiss", systemImage: "person.crop.circle.badge.minus", action: performAction)
                                .disabled(!actionEnabled)
                                .help("Dismiss the selected subagent")
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Close", action: dismiss).keyboardShortcut(.cancelAction)
                    }
                }
        }
        #endif
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
            List(selection: Binding(get: { store.selectedSubagentID }, set: { id in
                Task { await store.selectSubagent(id) }
            })) {
                ForEach(store.subagents, id: \.id) { child in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(child.name).lineLimit(1)
                        Text(child.dormant ? "\(child.status) · Dormant" : child.status)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(child.id)
                }
            }
            .overlay { if store.subagents.isEmpty { sidebarEmpty("No subagents") } }
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
                    isStreaming: store.childStreaming, interactions: store.childInteractions,
                    canMutate: store.connected && store.canMutate, ownsControl: store.ownsControl,
                    draft: Binding(get: { drafts[id, default: ""] }, set: { drafts[id] = $0 }),
                    submit: { text in
                        guard store.selectedSubagentID == id, store.childContextID == contextID else { return false }
                        return await store.submitChild(text)
                    },
                    abort: {
                        guard store.selectedSubagentID == id, store.childContextID == contextID else { return }
                        await store.abortChild()
                    },
                    answer: { request, value in
                        Task {
                            guard store.selectedSubagentID == id, store.childContextID == contextID else { return }
                            _ = await store.answerChild(request, value: value)
                        }
                    }
                )
                .environment(\.localPathDirectory, store.connected ? store.childLocalDirectory : nil)
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
        guard panel == .subagents, !answeringPermission else { return }
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

#if DEBUG
#Preview("Background Tasks") {
    @Previewable @StateObject var store = ActivityStore.preview()
    ActivityView(panel: .tasks, store: store, dismiss: {})
}

#Preview("Subagents") {
    @Previewable @StateObject var store = ActivityStore.preview()
    ActivityView(panel: .subagents, store: store, dismiss: {})
}
#endif
