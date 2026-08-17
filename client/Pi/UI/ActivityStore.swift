import Foundation
import Combine

/// Presentation state for the attached owner's services, not another session executor.
@MainActor final class ActivityStore: ObservableObject {
    typealias Read = (String, String, [LinkJSON], String) async throws -> LinkServiceValue
    typealias Mutate = (String, String, [LinkJSON], String) async throws -> String
    typealias Submit = (String, [LinkJSON], String, String, String) async throws -> LinkOperationAcceptance
    struct Context: Equatable {
        let connection: UUID
        let sessionID: String?
        let connected: Bool
        let canMutate: Bool
        let ownsControl: Bool
        let control: LinkControl
        let local: Bool
        var ownerIncarnation: String? = nil
        var authority: String = ""
        var forgottenProfiles: [String: UUID] = [:]
        var observationID: UUID? = nil
    }

    @Published var tasks: [LinkBackgroundTask] = []
    @Published var subagents: [LinkSubagent] = []
    @Published private(set) var selectedTaskID: String?
    @Published private(set) var selectedSubagentID: String?
    @Published private(set) var task: LinkBackgroundTaskDetail?
    // Storage and routing advance on every frame. Only same-response partials
    // and established tool-output updates defer view invalidation (20 Hz).
    // Lifecycle, interaction, and authority changes remain immediate.
    private var childMessageStorage: SessionMessage.Transcript = []
    private var pacingChildObservation = false
    private var childPublication: Task<Void, Never>?
    private(set) var childMessages: SessionMessage.Transcript {
        get { childMessageStorage }
        set {
            guard newValue != childMessageStorage else { return }
            if pacingChildObservation {
                childMessageStorage = newValue
                if childPublication == nil {
                    childPublication = Task { [weak self] in
                        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                        guard !Task.isCancelled, let self else { return }
                        self.childPublication = nil; self.objectWillChange.send()
                    }
                }
            } else {
                flushChildPublication(); objectWillChange.send(); childMessageStorage = newValue
            }
        }
    }
    private func flushChildPublication() {
        guard let pending = childPublication else { return }
        pending.cancel(); childPublication = nil; objectWillChange.send()
    }
    @Published private(set) var childInteractions: [LinkInteraction] = []
    @Published private(set) var childReady = false
    @Published private(set) var childStreaming = false
    @Published private(set) var childCompacting = false
    @Published private(set) var childWorkingMessage: String?
    @Published private(set) var childContextUsage: LinkContextUsage?
    @Published private(set) var childStatusFooterData: LinkStatusFooterData?
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
    @Published private(set) var childSubagentDisplayNames: [String: String] = [:]
    private var childPermissionValue: PermissionState?

    private let read: Read
    private let mutate: Mutate
    private let submit: Submit
    private let observation: (String) -> LinkChildObservation?
    private var context: Context?
    private var services: LinkActivityServices?
    private var backgroundGeneration: String?
    private var childGeneration: String?
    private var taskLoad = UUID()
    /// One canonical replica per child, independent of the selected presentation.
    /// Only immutable content is durable; all authority below is re-established by a
    /// fresh parent/service/child cut after connection or generation changes.
    private final class ChildReplica {
        var ticket = UUID(), contextID = UUID()
        var current = false, loading = false, reloadScheduled = false, dormant = false
        var identity: String?, sessionID: String?, generation: String?
        // An idle archive can retain a persisted summary UUID without a runtime.
        var archiveSummaryIdentity: String?
        var observationID: UUID?
        var summaryDormant: Bool?
        var retired = Set<String>()
        var sequence = -1
        var parentSequence = -1
        var records: [NativeRecord] = [], keys: [String] = []
        var toolExecutions: [LinkToolExecution] = []
        var live: LinkLive?
        var workingMessage: String?
        var statusFooterData: LinkStatusFooterData?
        let toolPresentation = SessionMessage.ToolExecutionProjection()
        var leaf: String?, partial: NativeMessage?
        var interactions: [LinkInteraction] = []
        var streaming = false
        var cwd: String?, services: LinkActivityServices?
        var buffered: [(event: LinkIncomingFrame.ChildFrame, parentSequence: Int?)] = []
        var projector: SessionMessage.IncrementalProjection?
        var pendingPrefix: Int?
        func invalidate() {
            current = false; loading = false; reloadScheduled = false; ticket = UUID(); contextID = UUID()
            parentSequence = -1
            buffered.removeAll(); partial = nil; toolExecutions = []; live = nil; interactions = []; streaming = false; services = nil
            workingMessage = nil; statusFooterData = nil
        }
    }
    private struct ParentKey: Hashable { let authority: String; let session: String }
    private struct ChildOutboxKey: Hashable { let parent: ParentKey; let child: String }
    private struct ChildSubmission: Identifiable {
        var submission: UserSubmission
        let operation: String
        let args: [LinkJSON]
        let serviceGeneration: String
        var id: String { submission.id }
        var ownerIncarnation: String { submission.ownerIncarnation }
        var state: SessionMessage.SubmissionState {
            get { submission.state }
            set { submission.state = newValue }
        }
        var message: SessionMessage { submission.message }
    }
    private struct ChildQueueCut { let seq: Int; let steering: [String]; let followUp: [String] }
    /// Panel hosts may be dismissed while a request is in flight. Keep the outbox
    /// alive for the app process, without persisting it or inventing native history.
    private final class Outbox: ObservableObject {
        static let shared = Outbox()
        @Published var submissions: [ChildOutboxKey: [ChildSubmission]] = [:]
        @Published var cuts: [ChildOutboxKey: ChildQueueCut] = [:]
        var presentations: [ChildOutboxKey: UserMessagePresentation] = [:]
    }
    private let outbox = Outbox.shared
    private var outboxSubscription: AnyCancellable?
    private var childSubmissions: [ChildOutboxKey: [ChildSubmission]] {
        get { outbox.submissions }
        set { outbox.submissions = newValue }
    }
    private var childQueueCuts: [ChildOutboxKey: ChildQueueCut] {
        get { outbox.cuts }
        set { outbox.cuts = newValue }
    }
    private var selectedOutboxKey: ChildOutboxKey? {
        guard let context, let child = selectedSubagentID else { return nil }
        return ChildOutboxKey(parent: parentKey(context), child: child)
    }
    var childLocalMessages: [SessionMessage] {
        guard let key = selectedOutboxKey else { return [] }
        return childSubmissions[key, default: []].map(\.message)
    }
    var childQueuedMessages: [SessionMessage] {
        guard let key = selectedOutboxKey, let live = selectedReplica?.live else { return [] }
        let cut = childQueueCuts[key].flatMap { $0.seq > (selectedReplica?.parentSequence ?? -1) ? $0 : nil }
        let queueSequence = cut?.seq ?? selectedReplica?.parentSequence ?? -1
        return (cut?.steering ?? live.steering ?? []).enumerated().map { index, text in
            SessionMessage.queued(id: "child-queue:\(key.child):steering:\(index)", text: text, mode: .steering, seq: queueSequence)
        } + (cut?.followUp ?? live.followUp ?? []).enumerated().map { index, text in
            SessionMessage.queued(id: "child-queue:\(key.child):followUp:\(index)", text: text, mode: .followUp, seq: queueSequence)
        }
    }
    var childSessionID: String? { childReady ? selectedReplica?.sessionID : nil }
    var childCommands: [LinkCommand] { childReady ? selectedReplica?.live?.commands ?? [] : [] }
    var childSendUnavailableReason: String? {
        context?.ownerIncarnation == nil && childReady ? "Reload the daemon to send subagent messages." : nil
    }
    private var children: [String: ChildReplica] = [:]
    private var parents: [ParentKey: [String: ChildReplica]] = [:]
    private var selectedReplica: ChildReplica? { selectedSubagentID.flatMap { children[$0] } }
    private var childIdentity: String? { selectedReplica?.identity }
    private func replica(_ id: String) -> ChildReplica {
        if let value = children[id] { return value }
        let value = ChildReplica(); value.summaryDormant = subagents.first { $0.id == id }?.dormant
        children[id] = value; return value
    }
    private func parentKey(_ context: Context) -> ParentKey {
        ParentKey(authority: context.authority, session: context.sessionID ?? "")
    }
    private var latestParentSequence = -1
    private var operations: Set<String> = []
    private var operationResults: [String: LinkOperation] = [:]

    init(read: @escaping Read, mutate: @escaping Mutate,
         submit: @escaping Submit = { _, _, _, _, _ in throw LinkFailure("Static preview") },
         observation: @escaping (String) -> LinkChildObservation? = { _ in nil }) {
        self.read = read; self.mutate = mutate; self.submit = submit; self.observation = observation
        outboxSubscription = outbox.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
    private func isCurrent(_ retained: ChildReplica, id: String) -> Bool {
        guard retained.current, retained.generation == childGeneration,
              retained.observationID == context?.observationID else { return false }
        guard let latest = observation(id) else { return true }
        return latest.serviceGeneration == retained.generation && latest.nativeIdentity == retained.identity && latest.sequence <= retained.sequence
    }

    /// A child view or older summary can omit lightweight sidebar metadata while
    /// its canonical branch loads. Only the same native identity may carry forward
    /// a known preview; an explicit empty preview or zero count clears it.
    private func retainingChildSidebarPreview(_ incoming: LinkSubagent, previous: LinkSubagent?) -> LinkSubagent {
        guard let previous, let identity = incoming.nativeIdentity,
              previous.nativeIdentity == identity else { return incoming }
        var merged = incoming
        if merged.messageCount == nil { merged.messageCount = previous.messageCount }
        if merged.latestMessage == nil, incoming.messageCount != 0 {
            merged.latestMessage = previous.latestMessage
        }
        return merged
    }

    func synchronize(_ incoming: Context, services value: LinkActivityServices?,
                     receipts: [LinkOperation] = []) {
        let reset = context?.connection != incoming.connection || context?.sessionID != incoming.sessionID
        let incarnationChanged = context?.ownerIncarnation != incoming.ownerIncarnation
        let connectionChanged = context?.connected != incoming.connected
        let authorityChanged = context?.control != incoming.control || connectionChanged
        for (authority, epoch) in incoming.forgottenProfiles where context?.forgottenProfiles[authority] != epoch {
            for (key, values) in parents where key.authority == authority {
                for child in values.values { child.invalidate() }
                parents.removeValue(forKey: key)
            }
            if context?.authority == authority {
                for child in children.values { child.invalidate() }
                children.removeAll(); clearChild()
            }
        }
        if reset {
            for child in children.values where child.loading { child.invalidate() }
            if let context { parents[parentKey(context)] = children }
            children = parents.removeValue(forKey: parentKey(incoming)) ?? [:]
            for child in children.values where incoming.observationID == nil || child.observationID != incoming.observationID || !incoming.connected {
                child.invalidate()
            }
        }
        context = incoming
        if reset || incarnationChanged { for receipt in receipts { reconcileChildSubmission(receipt) } }
        // A restarted owner cannot recover in-memory delivery IDs. Preserve the
        // text but never replay an uncertain old-incarnation submission.
        if incarnationChanged, incoming.ownerIncarnation != nil {
            for key in Array(childSubmissions.keys) {
                guard key.parent == parentKey(incoming) else { continue }
                for index in childSubmissions[key]!.indices where
                    childSubmissions[key]![index].ownerIncarnation != incoming.ownerIncarnation {
                    childSubmissions[key]![index].state = .failed(
                        "Daemon restarted; delivery cannot be verified. Copy this message for a new submission.",
                        retryable: false)
                }
            }
        }
        // Identical @Published assignments still invalidate observing panels.
        // Context and service/operation processing remain live for every frame.
        if connected != incoming.connected { connected = incoming.connected }
        if ownsControl != incoming.ownsControl { ownsControl = incoming.ownsControl }
        if canMutate != incoming.canMutate { canMutate = incoming.canMutate }
        if reset {
            latestParentSequence = -1
            taskLoad = UUID(); task = nil; tasks = []; subagents = []
            selectedTaskID = nil; selectedSubagentID = nil
            backgroundGeneration = nil; childGeneration = nil; services = nil
            operations.removeAll(); operationResults.removeAll(); error = nil; clearChild()
            permissionsBusy = false; permissionOperationID = nil
        } else {
            if authorityChanged {
                flushChildPublication()
                selectedReplica?.contextID = UUID()
                childContextID = selectedReplica?.contextID ?? UUID()
            }
            if connectionChanged {
                permissionsBusy = false; permissionOperationID = nil
                taskLoad = UUID(); for child in children.values { child.invalidate() }; clearChild()
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
                let nextTasks = rows.map { row in
                    if let old = previous[row.id], old.revision > row.revision { return old }
                    return row
                }
                if tasks != nextTasks { tasks = nextTasks }
            }
            let generation = state?.subagents?.serviceGeneration
            let samePreviewGeneration = !incarnationChanged && generation == childGeneration
            if generation != childGeneration {
                childGeneration = generation
                for child in children.values where child.generation != generation { child.invalidate() }
                clearChild()
            }
            let previousSubagents = Dictionary(uniqueKeysWithValues: subagents.map { ($0.id, $0) })
            let nextSubagents = (state?.subagents?.children ?? []).map {
                samePreviewGeneration ? retainingChildSidebarPreview($0, previous: previousSubagents[$0.id]) : $0
            }
            if subagents != nextSubagents { subagents = nextSubagents }
            for child in subagents {
                guard let retained = children[child.id] else { continue }
                let becameDormant = child.dormant && retained.summaryDormant == false
                retained.summaryDormant = child.dormant
                guard retained.current else { continue }
                // Activation publishes a native snapshot before its manager clears
                // the dormant flag. Preserve that baseline through the transition.
                // Restored idle archives may carry the persisted session UUID in
                // their summary despite having no live runtime. A repeated summary
                // is not a wake; a child snapshot frame promotes the archive.
                let identityChanged: Bool
                if !child.dormant, let identity = child.nativeIdentity {
                    identityChanged = retained.dormant
                        ? identity != retained.archiveSummaryIdentity
                        : retained.identity != identity && !retained.retired.contains(identity)
                } else { identityChanged = false }
                if becameDormant || identityChanged { retained.invalidate() }
            }
            if let id = selectedSubagentID {
                if subagents.contains(where: { $0.id == id }) {
                    let retained = replica(id)
                    if !retained.current || (!retained.dormant && !isCurrent(retained, id: id)) {
                        retained.current = false; scheduleChildReload(id)
                    }
                } else { selectedSubagentID = nil; clearChild() }
            }
        }
    }

    func receive(_ frame: LinkIncomingFrame) {
        guard connected, frame.sessionId == context?.sessionID else { return }
        if let seq = frame.seq { latestParentSequence = max(latestParentSequence, seq) }
        do {
            switch frame.payload {
            case .backgroundEvent(let event):
                guard event.serviceGeneration == backgroundGeneration else { return }
                let summary = event.job.summary
                if let index = tasks.firstIndex(where: { $0.id == summary.id }) {
                    if tasks[index].revision <= summary.revision, tasks[index] != summary {
                        tasks[index] = summary
                    }
                } else { tasks.append(summary) }
                if summary.id == selectedTaskID {
                    let detail = event.job
                    if task == nil || task!.revision <= detail.revision { task = detail }
                }
            case .childFrame(let event):
                guard event.serviceGeneration == childGeneration else { return }
                let retained = replica(event.childId)
                if retained.loading { retained.buffered.append((event, frame.seq)) }
                else {
                    do {
                        let previousIdentity = retained.identity, previousSequence = retained.sequence
                        try applyChildEvent(event, to: retained)
                        acceptChildQueueFrame(event, parentSequence: frame.seq, retained: retained,
                                              previousIdentity: previousIdentity, previousSequence: previousSequence)
                    } catch {
                        retained.invalidate()
                        if event.childId == selectedSubagentID {
                            self.error = error.localizedDescription; scheduleChildReload(event.childId)
                        }
                    }
                }
            case .operation(let operation):
                do {
                    // HTTP acceptance can arrive after its SSE completion.
                    operationResults[operation.id] = operation
                    reconcileChildSubmission(operation)
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
        }
    }

    private func acceptChildQueueFrame(_ event: LinkIncomingFrame.ChildFrame, parentSequence: Int?,
                                       retained: ChildReplica, previousIdentity: String?, previousSequence: Int) {
        guard let parentSequence, retained.current, retained.identity == event.nativeIdentity,
              retained.identity != previousIdentity || retained.sequence > previousSequence else { return }
        switch event.frame.payload {
        case .snapshot, .live: break
        default: return
        }
        retained.parentSequence = max(retained.parentSequence, parentSequence)
        if let context {
            let key = ChildOutboxKey(parent: parentKey(context), child: event.childId)
            if let cut = childQueueCuts[key], parentSequence >= cut.seq {
                childQueueCuts.removeValue(forKey: key)
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

    func selectSubagent(_ id: String?) async { await selectSubagent(id, retryBufferedGap: true) }
    private func selectSubagent(_ id: String?, retryBufferedGap: Bool) async {
        let changed = selectedSubagentID != id
        selectedSubagentID = id; error = nil
        if changed { clearChild() }
        guard let id, connected, let generation = childGeneration else { return }
        let retained = replica(id)
        if changed { retained.contextID = UUID() }
        // A live retained replica has observed every child frame, including while hidden.
        // A dormant archive has no live observer: revalidate its native cut on revisit,
        // retaining all healthy bodies rather than assuming a file cannot be replaced.
        if isCurrent(retained, id: id), !retained.dormant, subagents.first(where: { $0.id == id })?.dormant == false {
            presentChild(retained); return
        }
        if retained.loading { return }
        retained.current = false; retained.loading = true; retained.buffered.removeAll()
        let ticket = UUID(); retained.ticket = ticket
        let scope = context?.connection, requestedChild = selectedChild
        let loadStartedAtParentSequence = latestParentSequence
        let cutAtLoadStart = selectedOutboxKey.flatMap { childQueueCuts[$0]?.seq }
        do {
            let raw = try await read("subagents", "view", [.string(id)], generation)
            guard ticket == retained.ticket, context?.connection == scope, childGeneration == generation, connected else { return }
            guard case .childView(let view) = raw, view.child.id == id else { throw LinkFailure("Mismatched subagent view") }
            if let current = subagents.first(where: { $0.id == id }), let requestedChild,
               current.nativeIdentity != requestedChild.nativeIdentity || current.dormant != requestedChild.dormant {
                if view.child.nativeIdentity != current.nativeIdentity || view.child.dormant != current.dormant {
                    retained.invalidate(); if id == selectedSubagentID { scheduleChildReload(id) }; return
                }
            }
            if let index = subagents.firstIndex(where: { $0.id == id }), subagents[index].controlRevision <= view.child.controlRevision {
                subagents[index] = retainingChildSidebarPreview(view.child, previous: subagents[index])
            }
            if let snapshot = view.snapshot, let identity = view.child.nativeIdentity {
                replaceIdentity(identity, in: retained)
                try applyChildSnapshot(snapshot, to: retained, selected: id == selectedSubagentID)
            } else if view.dormant, let archive = view.archive, let cut = archive.immutable {
                if let old = retained.identity { retained.retired.insert(old) }
                retained.identity = nil; retained.archiveSummaryIdentity = view.child.nativeIdentity
                retained.sessionID = archive.header?.id ?? id
                reconcileChild(retained, records: archive.entries, keys: cut.entryKeys, leaf: archive.leafId, selected: id == selectedSubagentID)
                retained.live = nil; retained.toolExecutions = []
                retained.workingMessage = nil; retained.statusFooterData = nil
                retained.partial = nil; retained.interactions = []; retained.streaming = false; retained.sequence = -1
                retained.cwd = archive.cwd; retained.services = nil; retained.dormant = true
                retained.current = true; retained.generation = generation; retained.observationID = context?.observationID
            } else { throw LinkFailure("Subagent immutable cut is unavailable", code: "CHILD_IMMUTABLE_SYNC_UNSUPPORTED") }
            if let key = selectedOutboxKey, let cut = childQueueCuts[key],
               cut.seq <= loadStartedAtParentSequence || cut.seq == cutAtLoadStart {
                // A fresh HTTP child cut supersedes a queue cut known before
                // that read began, even if this panel missed SSE while closed.
                childQueueCuts.removeValue(forKey: key)
            }
            let buffered = retained.buffered; retained.buffered.removeAll(); retained.loading = false
            for item in buffered {
                let previousIdentity = retained.identity, previousSequence = retained.sequence
                try applyChildEvent(item.event, to: retained)
                acceptChildQueueFrame(item.event, parentSequence: item.parentSequence, retained: retained,
                                      previousIdentity: previousIdentity, previousSequence: previousSequence)
            }
            if id == selectedSubagentID { presentChild(retained) }
        } catch {
            if ticket == retained.ticket {
                retained.invalidate()
                if id == selectedSubagentID {
                    childReady = false; self.error = error.localizedDescription
                    if retryBufferedGap, (error as? LinkFailure)?.code == "CHILD_SEQUENCE_GAP" {
                        await selectSubagent(id, retryBufferedGap: false)
                    }
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

    /// Swipe actions act on the row that exposed them, not whichever child the
    /// detail pane happens to have selected when the asynchronous task starts.
    func dismissSubagent(_ id: String) async {
        guard let child = subagents.first(where: { $0.id == id }), child.lifecycleStatus != "dismissed",
              let generation = childGeneration else { return }
        _ = await perform("subagents", "dismiss", [.string(child.id), .number(Double(child.controlRevision))], generation)
    }

    /// Synchronous outbox admission; the composer clears only after this row exists.
    var childSupportsImages: Bool { selectedChild?.model?.input?.contains("image") != false }
    func enqueueChild(_ text: String, images: [ComposerImage] = [], followUp: Bool = false) -> Bool {
        guard connected, canMutate, !busy, childReady, let key = selectedOutboxKey,
              let child = selectedChild, let generation = childGeneration,
              let ownerIncarnation = context?.ownerIncarnation,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return false }
        guard images.isEmpty || childSupportsImages else {
            error = "The selected subagent model does not accept images."
            return false
        }
        let mode: UserSubmission.Mode = childStreaming
            ? (followUp ? .followUp : .steering) : .prompt
        let submission = UserSubmission(id: UUID().uuidString, text: text, images: images,
                                        mode: mode, ownerIncarnation: ownerIncarnation)
        let operation: String
        let args: [LinkJSON]
        // Status describes lifecycle, not transport availability. An idle
        // restored child can have an archive view and no native runtime identity;
        // the manager's human message operation wakes it with this same revision.
        if child.dormant || (selectedReplica?.dormant == true && childIdentity == nil) {
            operation = "message"
            let delivery = switch mode {
            case .prompt: "auto"
            case .steering: "steer"
            case .followUp: "followUp"
            }
            args = [.string(child.id), .string(text), .number(Double(child.controlRevision)), .string(delivery)]
                + (images.isEmpty ? [] : [.array(images.map(\.wire))])
        } else {
            guard let identity = childIdentity else {
                error = "Subagent view is unavailable. Reopen it and try again."
                return false
            }
            operation = "viewCommand"
            let command = mode.command
            args = [.string(child.id), .number(Double(child.controlRevision)), .string(identity),
                    .string(command), .array(submission.mutationArgs)]
        }
        var value = ChildSubmission(submission: submission, operation: operation,
                                    args: args, serviceGeneration: generation)
        let presentation = outbox.presentations[key] ?? UserMessagePresentation { [weak outbox] ids in
            guard let outbox else { return }
            let retired = Set(outbox.submissions[key, default: []].filter { ids.contains($0.id) && $0.submission.handoff != nil }.map(\.id))
            guard !retired.isEmpty else { return }
            outbox.submissions[key]?.removeAll { retired.contains($0.id) }
            outbox.presentations[key]?.retired(retired)
        }
        outbox.presentations[key] = presentation
        value.submission.presentationWindow = presentation.register(value.submission, in: childMessages)
        childSubmissions[key, default: []].append(value)
        Task { await dispatchChildSubmission(value, key: key) }
        return true
    }

    func retryChildSubmission(_ presentationID: String) {
        guard let key = selectedOutboxKey,
              let value = childSubmissions[key]?.first(where: { "local-submission:" + $0.id == presentationID }),
              case .failed(_, retryable: true) = value.state, connected else { return }
        updateChildSubmission(value.id, key: key) { $0.state = .sending }
        Task { await dispatchChildSubmission(value, key: key) }
    }

    private func updateChildSubmission(_ id: String, key: ChildOutboxKey,
                                       change: (inout UserSubmission) -> Void) {
        guard let index = childSubmissions[key]?.firstIndex(where: { $0.id == id }) else { return }
        change(&childSubmissions[key]![index].submission)
    }
    private func dispatchChildSubmission(_ value: ChildSubmission, key: ChildOutboxKey) async {
        await UserSubmission.dispatch(value.submission, request: {
            try await submit(value.operation, value.args, value.serviceGeneration,
                             value.id, value.ownerIncarnation)
        }, update: { id, change in
            updateChildSubmission(id, key: key, change: change)
        }, reconcile: { operation in
            reconcileChildSubmission(operation)
        })
    }
    private func reconcileChildSubmission(_ operation: LinkOperation) {
        guard let id = operation.submissionId,
              let key = childSubmissions.keys.first(where: { key in
                  childSubmissions[key]?.contains(where: { $0.id == id }) == true
              }) else { return }
        guard let value = childSubmissions[key]?.first(where: { $0.id == id }) else { return }
        switch value.submission.receiptEffect(operation) {
        case .none: break
        case .handoff(let handoff):
            let latest = max(childQueueCuts[key]?.seq ?? -1, children[key.child]?.parentSequence ?? -1)
            if handoff.seq > latest {
                childQueueCuts[key] = ChildQueueCut(seq: handoff.seq,
                    steering: handoff.steering, followUp: handoff.followUp)
            }
            updateChildSubmission(id, key: key) {
                $0.receivedHandoff(handoff, operationID: operation.operationId)
            }
            let window = value.submission.presentationWindow
            if handoff.disposition == .handled {
                window?.presentation.retired([id])
                childSubmissions[key]?.removeAll { $0.id == id }
            } else if window?.presentation.retains(id) != true {
                window?.presentation.retired([id])
                childSubmissions[key]?.removeAll { $0.id == id }
            }
        case .failure(let failure):
            updateChildSubmission(id, key: key) {
                $0.handoff = operation.handoff ?? $0.handoff
                $0.state = .failed(failure, retryable: false)
            }
            if operation.handoff == nil && value.submission.handoff == nil {
                value.submission.presentationWindow?.presentation.retired([id])
            } else if value.submission.presentationWindow?.presentation.retains(id) != true {
                value.submission.presentationWindow?.presentation.retired([id])
                childSubmissions[key]?.removeAll { $0.id == id }
            }
        }
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

    /// Command completion is a scoped child service read, not a parent-session RPC.
    /// The captured revision, native identity, generation and panel context must
    /// all still match when the asynchronous answer reaches the composer.
    func childCommandCompletions(name: String, prefix: String, childID: String,
                                 contextID: UUID) async -> [LinkCompletionItem]? {
        guard connected, canMutate, childReady, selectedSubagentID == childID,
              childContextID == contextID, let scope = context?.connection,
              let child = selectedChild, !child.dormant,
              let identity = child.nativeIdentity, selectedReplica?.identity == identity,
              let generation = childGeneration,
              selectedReplica?.live?.commands?.contains(where: {
                  $0.invokedAs == name && $0.argumentCompletions == true
              }) == true else { return nil }
        let revision = child.controlRevision
        do {
            let answer = try await read("subagents", "commandCompletions", [
                .string(childID), .number(Double(revision)), .string(identity),
                .string(name), .string(prefix)
            ], generation)
            guard connected, canMutate, childReady, context?.connection == scope,
                  selectedSubagentID == childID, childContextID == contextID,
                  childGeneration == generation, let current = selectedChild,
                  current.controlRevision == revision, current.nativeIdentity == identity,
                  !current.dormant, selectedReplica?.identity == identity,
                  case .commandCompletions(let items) = answer else { return nil }
            return items
        } catch { return nil } // Completion failures must not interrupt typing.
    }

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

    /// Clears presentation only. Replica content is retained independently.
    private func clearChild() {
        flushChildPublication()
        childContextID = UUID(); childMessages = []; childInteractions = []
        childReady = false; childStreaming = false; childCompacting = false; childLocalDirectory = nil
        childWorkingMessage = nil; childContextUsage = nil; childStatusFooterData = nil
        if !childSubagentDisplayNames.isEmpty { childSubagentDisplayNames = [:] }
        updateChildPathTargets(nil)
    }
    private func replaceIdentity(_ identity: String, in retained: ChildReplica) {
        guard retained.identity != identity else { return }
        if let old = retained.identity { retained.retired.insert(old) }
        retained.retired.remove(identity)
        retained.identity = identity; retained.contextID = UUID(); retained.sequence = -1
    }
    private func scheduleChildReload(_ id: String) {
        let retained = replica(id)
        guard !retained.loading, !retained.reloadScheduled, selectedSubagentID == id else { return }
        retained.reloadScheduled = true; childReady = false; childContextID = UUID()
        let scope = context?.connection, generation = childGeneration
        Task { [weak self, weak retained] in
            guard let self, let retained else { return }
            retained.reloadScheduled = false
            guard self.selectedSubagentID == id, self.context?.connection == scope, self.childGeneration == generation else { return }
            await self.selectSubagent(id)
        }
    }
    private func reconcileChild(_ retained: ChildReplica, records: [NativeRecord], keys: [String], leaf: String?, selected: Bool) {
        let prefix = retained.keys.count <= keys.count && zip(retained.keys, keys).allSatisfy(==)
        if prefix, let projector = retained.projector {
            // Safe suffix extension reuses committed COW pages and tool/provenance indices.
            if selected {
                projector.reconcileSuffix(records: records, unchangedCount: retained.pendingPrefix ?? retained.keys.count, leafID: leaf)
                retained.pendingPrefix = nil
            } else if retained.keys != keys || retained.leaf != leaf {
                retained.pendingPrefix = retained.pendingPrefix ?? retained.keys.count
            }
        } else { retained.projector = nil; retained.pendingPrefix = nil }
        retained.records = records; retained.keys = keys; retained.leaf = leaf
    }
    private func applyChildSnapshot(_ snapshot: LinkSnapshot, to retained: ChildReplica, selected: Bool) throws {
        guard snapshot.header != nil, let cut = snapshot.immutable else { throw LinkFailure("Missing native child immutable cut") }
        retained.sessionID = snapshot.sessionId; retained.sequence = snapshot.seq
        reconcileChild(retained, records: snapshot.entries, keys: cut.entryKeys, leaf: snapshot.leafId, selected: selected)
        retained.summaryDormant = subagents.first { $0.nativeIdentity == retained.identity }?.dormant
        // Replica-derived composer state must not rely on an incidental service
        // list publication when the authoritative child cut is replaced.
        if selected, retained.live?.steering != snapshot.live.steering || retained.live?.followUp != snapshot.live.followUp
            || retained.live?.commands != snapshot.live.commands { objectWillChange.send() }
        retained.live = snapshot.live
        retained.workingMessage = snapshot.uiState?.first(where: { $0.method == "setWorkingMessage" })?.workingMessage
        retained.statusFooterData = snapshot.uiState?.first(where: { $0.method == "ownedFooter" })?.statusFooter
        if selected { observeChildSubagentNames(snapshot.live) }
        retained.toolExecutions = snapshot.live.toolExecutions ?? []
        retained.partial = snapshot.live.partial; retained.streaming = snapshot.live.streaming
        retained.interactions = snapshot.pendingRequests; retained.cwd = snapshot.cwd; retained.services = snapshot.live.services
        retained.current = true; retained.dormant = false; retained.archiveSummaryIdentity = nil
        retained.generation = childGeneration; retained.observationID = context?.observationID
    }
    private func applyChildEvent(_ event: LinkIncomingFrame.ChildFrame, to retained: ChildReplica) throws {
        guard !retained.retired.contains(event.nativeIdentity) else { return }
        let frame = event.frame, selected = event.childId == selectedSubagentID
        if case .snapshot(let snapshot) = frame.payload {
            if retained.current, event.nativeIdentity == retained.identity, snapshot.seq <= retained.sequence { return }
            replaceIdentity(event.nativeIdentity, in: retained)
            try applyChildSnapshot(snapshot, to: retained, selected: selected)
            if selected { presentChild(retained) }; return
        }
        guard retained.current, event.nativeIdentity == retained.identity, let seq = frame.seq else {
            retained.current = false
            if selected { scheduleChildReload(event.childId) }; return
        }
        guard seq > retained.sequence else { return }
        guard frame.sessionId == retained.sessionID, seq == retained.sequence + 1 else {
            throw LinkFailure("Subagent stream gap; reconciling only missing immutable records", code: "CHILD_SEQUENCE_GAP")
        }
        retained.sequence = seq
        var changed = false, paceObservation = false
        switch frame.payload {
        case .append(let entry):
            guard let key = frame.entryKey else { throw LinkFailure("Unkeyed child append", code: "CHILD_IMMUTABLE_SYNC_UNSUPPORTED") }
            retained.records.append(entry); retained.keys.append(key)
            if retained.pendingPrefix == nil, let projector = retained.projector {
                if selected || projector.canAppendWithoutRebuild(entry, records: retained.records) {
                    _ = projector.appended(entry, records: retained.records)
                } else { retained.projector = nil }
            }
            changed = true
        case .leaf(let leaf):
            // Receipt already advanced above. Owner refreshes repeat the leaf
            // before each partial; no branch change means no forced publication.
            guard leaf != retained.leaf else { break }
            if retained.pendingPrefix == nil, let projector = retained.projector {
                if selected || projector.canMoveLeafWithoutRebuild(leaf, records: retained.records) {
                    projector.moveLeaf(leaf, records: retained.records)
                } else { retained.projector = nil }
            }
            retained.leaf = leaf; changed = true
        case .live(let live):
            // Advance the branch with its observation, never with the prior partial.
            if live.leafId != retained.leaf {
                if retained.pendingPrefix == nil, let projector = retained.projector {
                    if selected || projector.canMoveLeafWithoutRebuild(live.leafId, records: retained.records) {
                        projector.moveLeaf(live.leafId, records: retained.records)
                    } else { retained.projector = nil }
                }
                retained.leaf = live.leafId
            }
            // Queue-only frames do not change the immutable transcript projection.
            // The queue rows are derived from the replica, so publish them explicitly.
            if selected, retained.live?.steering != live.steering || retained.live?.followUp != live.followUp
                || retained.live?.commands != live.commands {
                objectWillChange.send()
            }
            paceObservation = retained.interactions.isEmpty && retained.live.map {
                live.isStreamingPartialUpdate(from: $0)
            } == true
            retained.live = live
            if selected { observeChildSubagentNames(live) }
            retained.toolExecutions = live.toolExecutions ?? []
            retained.partial = live.partial; retained.streaming = live.streaming; retained.services = live.services; changed = true
        case .ui(let action):
            if action.method == "setWorkingMessage", retained.workingMessage != action.workingMessage {
                retained.workingMessage = action.workingMessage; changed = true
            }
            if action.method == "ownedFooter", retained.statusFooterData != action.statusFooter {
                retained.statusFooterData = action.statusFooter; changed = true
            }
        case .interaction(let request):
            retained.interactions.removeAll { $0.id == request.id }; retained.interactions.append(request); changed = true
        case .interactionResolved(let id): retained.interactions.removeAll { $0.id == id }; changed = true
        case .operation(let operation): if selected, let failure = operation.error { error = failure }
        case .control: if selected { flushChildPublication() }
        default: break
        }
        if selected, changed { presentChild(retained, paceObservation: paceObservation) }
    }
    private func presentChild(_ retained: ChildReplica, paceObservation: Bool = false) {
        if !paceObservation { flushChildPublication() }
        pacingChildObservation = paceObservation
        defer { pacingChildObservation = false }
        guard retained.current, let id = retained.sessionID else { childReady = false; return }
        if retained.projector == nil {
            retained.projector = SessionMessage.IncrementalProjection(records: retained.records, leafID: retained.leaf)
        } else if let unchanged = retained.pendingPrefix {
            retained.projector?.reconcileSuffix(records: retained.records, unchangedCount: unchanged, leafID: retained.leaf)
        }
        retained.pendingPrefix = nil
        childMessages = retained.projector!.observing(retained.partial, sessionID: id, executions: retained.toolExecutions, presentation: retained.toolPresentation)
        if childContextID != retained.contextID { childContextID = retained.contextID }
        if !childReady { childReady = true }
        if childStreaming != retained.streaming { childStreaming = retained.streaming }
        let compacting = retained.live?.compacting == true
        if childCompacting != compacting { childCompacting = compacting }
        if childWorkingMessage != retained.workingMessage { childWorkingMessage = retained.workingMessage }
        if childContextUsage != retained.live?.contextUsage { childContextUsage = retained.live?.contextUsage }
        if childStatusFooterData != retained.statusFooterData { childStatusFooterData = retained.statusFooterData }
        if !childInteractions.isEmpty || !retained.interactions.isEmpty { childInteractions = retained.interactions }
        let directory = context?.local == true ? retained.cwd : nil
        if childLocalDirectory != directory { childLocalDirectory = directory }
        updateChildPathTargets(retained.services)
    }

    private func observeChildSubagentNames(_ live: LinkLive) {
        guard let children = live.services?.subagents?.children else { return }
        let previous = childSubagentDisplayNames
        guard previous.count != children.count || children.contains(where: { previous[$0.id] != $0.name }) else { return }
        childSubagentDisplayNames = Dictionary(uniqueKeysWithValues: children.map { ($0.id, $0.name) })
    }

    private func updateChildPathTargets(_ services: LinkActivityServices?) {
        let value = context?.local == true ? services?.permissions?.value : nil
        guard value != childPermissionValue else { return }
        childPermissionValue = value
        childPathTargets = PathTargetMetadata.targets(in: value)
    }

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
}
