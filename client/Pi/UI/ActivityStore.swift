import Foundation
import Combine

nonisolated struct LinkChildView: Decodable, Sendable {
    struct Archive: Decodable, Sendable {
        let header: NativeRecord?
        let entries: [NativeRecord]
        let leafId: String?
        let cwd: String
    }
    let child: LinkSubagent
    let dormant: Bool
    let snapshot: LinkSnapshot?
    let archive: Archive?
}

/// Presentation state for the attached owner's services, not another session executor.
@MainActor final class ActivityStore: ObservableObject {
    typealias Read = (String, String, [LinkJSON], String) async throws -> LinkServiceValue
    typealias Mutate = (String, String, [LinkJSON], String) async throws -> String
    struct Context: Equatable {
        let connection: UUID
        let sessionID: String?
        let connected: Bool
        let canMutate: Bool
        let ownsControl: Bool
        let control: LinkControl
        let local: Bool
    }

    @Published var tasks: [LinkBackgroundTask] = []
    @Published var subagents: [LinkSubagent] = []
    @Published private(set) var selectedTaskID: String?
    @Published private(set) var selectedSubagentID: String?
    @Published private(set) var task: LinkBackgroundTaskDetail?
    @Published private(set) var childMessages: SessionMessage.Transcript = []
    @Published private(set) var childInteractions: [LinkInteraction] = []
    @Published private(set) var childReady = false
    @Published private(set) var childStreaming = false
    @Published private(set) var connected = false
    @Published private(set) var canMutate = false
    @Published private(set) var ownsControl = false
    @Published private(set) var busy = false
    @Published private(set) var permissionsBusy = false
    private var permissionOperationID: String?
    @Published var error: String?
    @Published private(set) var childContextID = UUID()
    @Published private(set) var childLocalDirectory: String?
    @Published private(set) var childPathTargets: [PermissionsSnapshot.RunningTarget] = []
    private var childPermissionValue: PermissionState?

    private let read: Read
    private let mutate: Mutate
    private var context: Context?
    private var services: LinkActivityServices?
    private var backgroundGeneration: String?
    private var childGeneration: String?
    private var taskLoad = UUID()
    private var childLoad = UUID()
    private var loadingChild = false
    private var recoveringChild = false
    private var bufferedChildFrames: [LinkIncomingFrame.ChildFrame] = []
    private var childIdentity: String?
    private var retiredIdentities: Set<String> = []
    private var childSessionID: String?
    private var childSequence = -1
    private var childRecords: [NativeRecord] = []
    private var childLeaf: String?
    private var childPartial: NativeMessage?
    private var operations: Set<String> = []
    private var operationResults: [String: LinkOperation] = [:]

    init(read: @escaping Read, mutate: @escaping Mutate) {
        self.read = read; self.mutate = mutate
    }

    func synchronize(_ incoming: Context, services value: LinkActivityServices?) {
        let reset = context?.connection != incoming.connection || context?.sessionID != incoming.sessionID
        let connectionChanged = context?.connected != incoming.connected
        let authorityChanged = context?.control != incoming.control || connectionChanged
        context = incoming
        // Identical @Published assignments still invalidate observing panels.
        // Context and service/operation processing remain live for every frame.
        if connected != incoming.connected { connected = incoming.connected }
        if ownsControl != incoming.ownsControl { ownsControl = incoming.ownsControl }
        if canMutate != incoming.canMutate { canMutate = incoming.canMutate }
        if reset {
            taskLoad = UUID(); childLoad = UUID(); task = nil; tasks = []; subagents = []
            selectedTaskID = nil; selectedSubagentID = nil
            backgroundGeneration = nil; childGeneration = nil; services = nil
            operations.removeAll(); operationResults.removeAll(); error = nil; clearChild()
            permissionsBusy = false; permissionOperationID = nil
        } else {
            if authorityChanged { childContextID = UUID() }
            if connectionChanged {
                permissionsBusy = false; permissionOperationID = nil
                taskLoad = UUID(); childLoad = UUID(); loadingChild = false; bufferedChildFrames.removeAll()
                if connected {
                    services = nil; childReady = false
                    if let id = selectedTaskID {
                        Task { [weak self] in
                            guard let self, self.selectedTaskID == id else { return }
                            await self.selectTask(id)
                        }
                    }
                }
            }
        }
        guard connected, value != services else { return }
        services = value
        do {
            let state = value
            let bg = state?.background?.serviceGeneration
            if bg != backgroundGeneration {
                backgroundGeneration = bg; taskLoad = UUID(); task = nil; tasks = []
                if bg == nil { selectedTaskID = nil }
                else if let id = selectedTaskID {
                    Task { [weak self] in
                        guard let self, self.selectedTaskID == id else { return }
                        await self.selectTask(id)
                    }
                }
            }
            if let rows = state?.background?.jobs {
                // A delayed live snapshot cannot roll back a newer pushed job observation.
                let previous = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
                tasks = rows.map { row in
                    if let old = previous[row.id], old.revision > row.revision { return old }
                    return row
                }
            }
            let generation = state?.subagents?.serviceGeneration
            if generation != childGeneration {
                childGeneration = generation; childLoad = UUID(); clearChild()
            }
            subagents = state?.subagents?.children ?? []
            if let id = selectedSubagentID {
                if let child = subagents.first(where: { $0.id == id }) {
                    if !childReady, !loadingChild {
                        scheduleChildReload(id)
                    } else if child.dormant, childIdentity != nil {
                        scheduleChildReload(id)
                    } else if let identity = child.nativeIdentity, identity != childIdentity,
                              !retiredIdentities.contains(identity), !loadingChild {
                        scheduleChildReload(id)
                    }
                } else { selectedSubagentID = nil; clearChild() }
            }
        }
    }

    func receive(_ frame: LinkIncomingFrame) {
        guard connected, frame.sessionId == context?.sessionID else { return }
        do {
            switch frame.payload {
            case .backgroundEvent(let event):
                guard event.serviceGeneration == backgroundGeneration else { return }
                let summary = event.job.summary
                if let index = tasks.firstIndex(where: { $0.id == summary.id }) {
                    if tasks[index].revision <= summary.revision { tasks[index] = summary }
                } else { tasks.append(summary) }
                if summary.id == selectedTaskID {
                    let detail = event.job
                    if task == nil || task!.revision <= detail.revision { task = detail }
                }
            case .childFrame(let event):
                guard event.serviceGeneration == childGeneration,
                      event.childId == selectedSubagentID else { return }
                if loadingChild { bufferedChildFrames.append(event) }
                else { try applyChildEvent(event) }
            case .operation(let operation):
                do {
                    // HTTP acceptance can arrive after its SSE completion.
                    operationResults[operation.id] = operation
                    if permissionOperationID == operation.id, operation.status != "running" {
                        permissionsBusy = false; permissionOperationID = nil
                    }
                    if operations.contains(operation.id), let failure = operation.error { error = failure }
                    if operationResults.count > 256 {
                        operationResults = operationResults.filter { operations.contains($0.key) }
                    }
                }
            default: break
            }
        } catch {
            self.error = error.localizedDescription
            if let id = selectedSubagentID, frame.type == "childFrame", !recoveringChild {
                recoveringChild = true; scheduleChildReload(id)
            }
        }
    }

    func selectTask(_ id: String?) async {
        selectedTaskID = id; task = nil; error = nil
        let ticket = UUID(); taskLoad = ticket
        guard let id, connected, let generation = backgroundGeneration else { return }
        do {
            let raw = try await read("background", "status", [.string(id)], generation)
            guard ticket == taskLoad, backgroundGeneration == generation, connected else { return }
            guard case .backgroundTask(let value) = raw else { throw LinkFailure("Invalid background task response") }
            guard value.id == id else { throw LinkFailure("Mismatched background task") }
            if task == nil || task!.revision <= value.revision { task = value }
        } catch { if ticket == taskLoad { self.error = error.localizedDescription } }
    }

    func selectSubagent(_ id: String?) async {
        let changed = selectedSubagentID != id
        selectedSubagentID = id; error = nil
        if changed { clearChild() }
        let ticket = UUID(); childLoad = ticket
        guard let id, connected, let generation = childGeneration else { return }
        loadingChild = true; bufferedChildFrames.removeAll()
        let requestedChild = selectedChild
        let requestedIdentity = requestedChild?.nativeIdentity
        do {
            let raw = try await read("subagents", "view", [.string(id)], generation)
            guard ticket == childLoad, childGeneration == generation, connected else { return }
            guard case .childView(let view) = raw else { throw LinkFailure("Invalid child view response") }
            guard view.child.id == id else { throw LinkFailure("Mismatched subagent") }
            if let current = selectedChild, let requestedChild,
               current.nativeIdentity != requestedChild.nativeIdentity || current.dormant != requestedChild.dormant {
                // An incarnation/dormancy transition observed while HTTP was pending wins
                // over that older read. Reconcile by reading, never by replaying an action.
                if view.child.nativeIdentity != current.nativeIdentity || view.child.dormant != current.dormant {
                    loadingChild = false; bufferedChildFrames.removeAll()
                    scheduleChildReload(id); return
                }
            }
            if let index = subagents.firstIndex(where: { $0.id == id }),
               subagents[index].controlRevision <= view.child.controlRevision {
                subagents[index] = view.child
            }
            if let snapshot = view.snapshot, let identity = view.child.nativeIdentity {
                if let old = requestedIdentity, old != identity { retiredIdentities.insert(old) }
                replaceIdentity(identity)
                try applyChildSnapshot(snapshot)
            } else if view.dormant, let archive = view.archive {
                if let old = childIdentity { retiredIdentities.insert(old) }
                childIdentity = nil; childSessionID = archive.header?.id ?? id
                childRecords = archive.entries; childLeaf = archive.leafId; childPartial = nil
                childStreaming = false; childInteractions = []; childSequence = -1
                childLocalDirectory = context?.local == true ? archive.cwd : nil
                updateChildPathTargets(nil)
                childReady = true; projectChild()
            } else { throw LinkFailure("Subagent session is unavailable") }
            let buffered = bufferedChildFrames; bufferedChildFrames.removeAll(); loadingChild = false
            for event in buffered { try applyChildEvent(event) }
            recoveringChild = false
        } catch {
            if ticket == childLoad {
                loadingChild = false; childReady = false
                bufferedChildFrames.removeAll(); self.error = error.localizedDescription
                if (error as? LinkFailure)?.code == "CHILD_SEQUENCE_GAP", !recoveringChild {
                    recoveringChild = true; scheduleChildReload(id)
                }
            }
        }
    }

    /// Pass the revision/generation captured by the editor, never silently rebase a stale edit.
    func mutatePermissions(_ mutation: LinkPermissionMutation, expectedRevision: Int, serviceGeneration: String) async -> Bool {
        guard services?.permissions?.serviceGeneration == serviceGeneration,
              services?.permissions?.value.revision == expectedRevision else {
            error = "Permissions changed. Refresh before editing again."
            return false
        }
        guard connected, canMutate, !busy, !permissionsBusy else { return false }
        let scope = context?.connection; let parent = context?.sessionID
        error = nil; permissionsBusy = true
        do {
            let id = try await mutate("permissions", "mutate", [.number(Double(expectedRevision)), mutation.json], serviceGeneration)
            guard scope == context?.connection, parent == context?.sessionID else { return false }
            operations.insert(id)
            if let result = operationResults[id], result.status != "running" {
                permissionsBusy = false
                if let failure = result.error { error = failure; return false }
            } else { permissionOperationID = id }
            return true // Completion stays observable while SSH probing is in flight.
        } catch {
            if scope == context?.connection, parent == context?.sessionID {
                permissionsBusy = false; self.error = error.localizedDescription
            }
            return false
        }
    }

    func stopTask() async {
        guard let id = selectedTaskID, tasks.first(where: { $0.id == id })?.isRunning == true,
              let generation = backgroundGeneration else { return }
        _ = await perform("background", "stop", [.string(id)], generation)
    }

    func dismissSubagent() async {
        guard let child = selectedChild, let generation = childGeneration else { return }
        _ = await perform("subagents", "dismiss", [.string(child.id), .number(Double(child.controlRevision))], generation)
    }

    func submitChild(_ text: String) async -> Bool {
        guard childReady, let child = selectedChild, let generation = childGeneration else { return false }
        if child.dormant {
            return await perform("subagents", "message", [.string(child.id), .string(text), .number(Double(child.controlRevision)), .string("auto")], generation)
        }
        return await childCommand("prompt", args: [.string(text)])
    }

    func abortChild() async { _ = await childCommand("abort", args: []) }

    func answerChild(_ request: LinkInteraction, value: LinkJSON) async -> Bool {
        guard childInteractions.contains(where: { $0.id == request.id }), request.kind != "custom",
              let child = selectedChild, let identity = childIdentity, let generation = childGeneration else { return false }
        return await perform("subagents", "viewAnswer", [
            .string(child.id), .number(Double(child.controlRevision)), .string(identity), .string(request.id), value
        ], generation)
    }

    private var selectedChild: LinkSubagent? { subagents.first { $0.id == selectedSubagentID } }

    private func childCommand(_ command: String, args: [LinkJSON]) async -> Bool {
        guard childReady, let child = selectedChild, let identity = childIdentity,
              let generation = childGeneration else { return false }
        return await perform("subagents", "viewCommand", [
            .string(child.id), .number(Double(child.controlRevision)), .string(identity), .string(command), .array(args)
        ], generation)
    }

    private func perform(_ service: String, _ operation: String, _ args: [LinkJSON], _ generation: String) async -> Bool {
        guard connected, canMutate, !busy else { return false }
        let scope = context?.connection; let parent = context?.sessionID
        busy = true; defer { busy = false }
        do {
            let id = try await mutate(service, operation, args, generation)
            guard scope == context?.connection, parent == context?.sessionID else { return false }
            operations.insert(id)
            if let failure = operationResults[id]?.error { error = failure }
            return true // Admission only; canonical operation frames report completion/failure.
        } catch {
            if scope == context?.connection, parent == context?.sessionID { self.error = error.localizedDescription }
            return false
        }
    }

    private func clearChild() {
        childLoad = UUID(); recoveringChild = false
        childContextID = UUID(); childIdentity = nil; retiredIdentities.removeAll()
        childSessionID = nil; childSequence = -1; childRecords = []; childLeaf = nil; childPartial = nil
        childMessages = []; childInteractions = []; childReady = false; childStreaming = false
        childLocalDirectory = nil; loadingChild = false; bufferedChildFrames.removeAll()
        updateChildPathTargets(nil)
    }

    private func replaceIdentity(_ identity: String) {
        guard childIdentity != identity else { return }
        if let old = childIdentity { retiredIdentities.insert(old) }
        childIdentity = identity; childContextID = UUID(); childSequence = -1
    }

    private func scheduleChildReload(_ id: String) {
        guard !loadingChild else { return }
        loadingChild = true; childReady = false; childContextID = UUID()
        Task { [weak self] in
            guard let self, self.selectedSubagentID == id else { return }
            await self.selectSubagent(id)
        }
    }

    private func applyChildSnapshot(_ snapshot: LinkSnapshot) throws {
        guard snapshot.header != nil else { throw LinkFailure("Missing native child session header") }
        if !childReady { error = nil }
        childSessionID = snapshot.sessionId; childSequence = snapshot.seq
        childRecords = snapshot.entries; childLeaf = snapshot.leafId; childPartial = snapshot.live.partial
        childStreaming = snapshot.live.streaming; childInteractions = snapshot.pendingRequests
        childLocalDirectory = context?.local == true ? snapshot.cwd : nil
        updateChildPathTargets(snapshot.live.services)
        childReady = true; projectChild()
    }

    private func applyChildEvent(_ event: LinkIncomingFrame.ChildFrame) throws {
        let identity = event.nativeIdentity
        guard !retiredIdentities.contains(identity) else { return }
        let frame = event.frame
        if case .snapshot(let snapshot) = frame.payload {
            if identity == childIdentity, snapshot.seq <= childSequence { return }
            replaceIdentity(identity); try applyChildSnapshot(snapshot); return
        }
        guard identity == childIdentity, let seq = frame.seq else {
            if let id = selectedSubagentID { scheduleChildReload(id) }; return
        }
        guard seq > childSequence else { return }
        guard frame.sessionId == childSessionID, seq == childSequence + 1 else {
            throw LinkFailure("Subagent stream gap; refreshing without replaying commands", code: "CHILD_SEQUENCE_GAP")
        }
        childSequence = seq
        var changed = false
        switch frame.payload {
        case .append(let entry):
            childRecords.append(entry); changed = true
        case .leaf(let leaf): childLeaf = leaf; changed = true
        case .live(let live):
            childPartial = live.partial; childStreaming = live.streaming; changed = true
            updateChildPathTargets(live.services)
        case .interaction(let request):
            childInteractions.removeAll { $0.id == request.id }; childInteractions.append(request)
        case .interactionResolved(let requestID): childInteractions.removeAll { $0.id == requestID }
        case .operation(let operation):
            if let failure = operation.error { error = failure }
        default: break
        }
        if changed { projectChild() }
    }

    private func updateChildPathTargets(_ services: LinkActivityServices?) {
        let value = context?.local == true ? services?.permissions?.value : nil
        guard value != childPermissionValue else { return }
        childPermissionValue = value
        childPathTargets = PathTargetMetadata.targets(in: value)
    }

    private func projectChild() {
        guard let id = childSessionID else { return }
        childMessages = .init(SessionMessage.project(sessionID: id, records: childRecords, leafID: childLeaf, partial: childPartial))
    }

    #if DEBUG
    /// Static Canvas state; neither closure connects to a service or executes an action.
    static func preview() -> ActivityStore {
        let store = ActivityStore(
            read: { _, _, _, _ in throw LinkFailure("Static preview") },
            mutate: { _, _, _, _ in throw LinkFailure("Static preview") }
        )
        store.connected = true; store.canMutate = true; store.ownsControl = true
        store.tasks = PreviewFixtures.backgroundTasks
        store.selectedTaskID = PreviewFixtures.backgroundTaskOutput.id
        store.task = PreviewFixtures.backgroundTaskOutput
        store.subagents = PreviewFixtures.activitySubagents
        store.selectedSubagentID = PreviewFixtures.activitySubagents.first?.id
        store.childMessages = .init(PreviewFixtures.streamingMessages)
        store.childReady = true; store.childStreaming = true
        return store
    }
    #endif
}
