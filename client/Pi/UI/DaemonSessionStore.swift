#if os(macOS)
import Foundation
import Combine

/// A fresh, observed busy-to-settled transition, never a history/snapshot notification.
nonisolated struct SessionSettlement: Sendable {
    let id: String
    let sessionID: String
    let remoteOrigin: String?
    let title: String
}

@MainActor final class DaemonSessionStore: ObservableObject {
    let settlements = PassthroughSubject<SessionSettlement, Never>()
    /// Validated canonical frames for attached-session activity panels.
    let activityFrames = PassthroughSubject<LinkIncomingFrame, Never>()
    @Published var sessions: [LinkSession] = [] {
        didSet { mergeSidebarMetadata() }
    }
    @Published var sidebarSummaries: [String: SessionSidebarSummary] = [:]
    @Published private(set) var sessionActivity = SessionActivityTracker()
    private var activitySubscriptionID: String?
    private var subscribingActivity = false
    private var bufferedActivity: [LinkIncomingFrame.ActivityEvent] = []
    enum OccupiedChoice { case watch, fork, steal }
    @Published var occupiedSelection: LinkSession?
    @Published var selectedID: String?
    @Published var snapshot: LinkSnapshot?
    @Published var records: [NativeRecord] = []
    @Published var live: LinkLive?
    @Published private(set) var workingMessage: String?
    @Published var leafID: String?
    @Published var control = LinkControl(controllerClientId: nil, controlGeneration: 0)
    @Published var interactions: [LinkInteraction] = []
    /// HTTP acknowledgement may precede interactionResolved; shared across window/sheet presenters.
    @Published private(set) var acknowledgedInteractionIDs: Set<String> = []
    @Published var operations: [LinkOperation] = []
    @Published var messages: SessionMessage.Transcript = []
    private var committedProjection: SessionMessage.CommittedProjection?
    private var committedSidebarPreview: String?
    @Published var error: String?
    @Published var connected = false
    @Published var busy = false
    private var agentDir = DaemonDiscovery.userHome.appendingPathComponent(".pi/agent").path
    private var environment: [String: String] = DaemonDiscovery.launchEnvironment(
        executable: UserDefaults.standard.string(forKey: "daemonExecutable").map { URL(fileURLWithPath: $0) }
    )
    @Published var savedRemoteProfiles: [String] = RemoteProfileKeychain.origins()
    @Published var remoteOrigin: String?
    private var controlClientID: String?
    private var client: SessionLinkClient?
    private var frameTask: Task<Void, Never>?
    private var sequence = 0
    private var attachmentWaiters: [UUID: (id: String, seq: Int, waiter: CheckedContinuation<Void, Error>)] = [:]
    private var connectionEpoch = UUID()
    private var observedBusy = false
    private var lastLiveSequence: Int?
    var ownsControl: Bool { connected && controlClientID == control.controllerClientId && snapshot?.sessionId == selectedID }
    var canMutate: Bool { ownsControl && !busy && occupiedSelection == nil }
    var availableModels: [LinkModel] { live?.catalog ?? [] }
    var currentModel: LinkModel? { live?.model }
    var selectedModelKey: LinkModelKey? { currentModel?.key }
    var canSelectModel: Bool { canMutate && !availableModels.isEmpty }

    /// A read against the attached owner; stale answers never cross session changes.
    func commandCompletions(name: String, prefix: String, sessionID: String) async -> [LinkCompletionItem]? {
        guard connected, snapshot?.sessionId == sessionID, selectedID == sessionID, let client,
              live?.commands?.contains(where: { $0.invokedAs == name && $0.argumentCompletions == true }) == true else { return nil }
        let epoch = connectionEpoch
        do {
            let items = try await client.request("commandCompletions", [
                "sessionId": .string(sessionID), "name": .string(name), "prefix": .string(prefix)
            ], as: [LinkCompletionItem]?.self)
            guard connected, epoch == connectionEpoch, snapshot?.sessionId == sessionID else { return nil }
            return items
        } catch { return nil } // Typing must not surface transient completion failures as chat errors.
    }

    @discardableResult func selectModel(_ key: LinkModelKey) async -> Bool {
        guard canSelectModel, availableModels.contains(where: { $0.key == key }) else { return false }
        // Acceptance is not completion: only canonical live frames change selection.
        return await mutate("setModel", args: [key.selectionArgument])
    }

    func importRemoteProfile(_ base64: String) async {
        do {
            let profile = try RemoteConnectionProfile.importing(base64)
            try RemoteProfileKeychain.save(profile)
            savedRemoteProfiles = RemoteProfileKeychain.origins()
            await connectRemote(profileID: profile.origin)
        } catch { self.error = error.localizedDescription }
    }
    func connectRemote(profileID: String) async {
        do { try await connectUsing(profile: RemoteProfileKeychain.load(profileID)) }
        catch { self.error = error.localizedDescription }
    }
    func connect(executable: URL? = nil) async {
        do { try await connectUsing(executable: executable) }
        catch { self.error = error.localizedDescription }
    }
    private func connectUsing(executable: URL? = nil, profile: RemoteConnectionProfile? = nil) async throws {
        guard !busy else { return }
        busy = true; defer { busy = false }
        await disconnect()
        error = nil
        do {
            let descriptor: DaemonDescriptor?
            if profile != nil { descriptor = nil }
            else if let executable {
                environment = DaemonDiscovery.launchEnvironment(executable: executable, base: environment)
                descriptor = try await DaemonDiscovery.bootstrap(executable: executable, environment: environment)
            }
            else { descriptor = try await DaemonDiscovery.discover() }
            let connection = SessionLinkClient()
            client = connection
            let epoch = connectionEpoch
            frameTask = Task { [weak self] in
                do {
                    for try await frame in connection.frames {
                        guard let self, epoch == self.connectionEpoch else { return }
                        try self.apply(frame)
                    }
                } catch {
                    guard let self, epoch == self.connectionEpoch else { return }
                    self.connected = false
                    self.failAttachmentWaiters(error)
                    self.error = error.localizedDescription
                    await connection.close(error: error)
                }
            }
            if let profile { try await connection.connect(profile) }
            else if let descriptor { try await connection.connect(descriptor) }
            controlClientID = await connection.clientID
            if remoteOrigin != profile?.origin {
                agentDir = profile == nil ? DaemonDiscovery.userHome.appendingPathComponent(".pi/agent").path : ""
            }
            remoteOrigin = profile?.origin
            connected = true
            try await refresh()
            await subscribeToActivity()
        } catch {
            self.error = error.localizedDescription
            connected = false
            await client?.close(error: error)
        }
    }
    func disconnect() async {
        failAttachmentWaiters(LinkFailure("Disconnected before attachment was presented"))
        connectionEpoch = UUID()
        observedBusy = false; lastLiveSequence = nil
        frameTask?.cancel(); frameTask = nil
        await client?.close(); client = nil
        controlClientID = nil
        connected = false; sessions = []; selectedID = nil; snapshot = nil; occupiedSelection = nil
        records = []; messages = []; committedProjection = nil; committedSidebarPreview = nil; interactions = []; operations = []
        live = nil; workingMessage = nil; leafID = nil; sidebarSummaries.removeAll()
        sessionActivity = SessionActivityTracker(); activitySubscriptionID = nil
        subscribingActivity = false; bufferedActivity.removeAll()
        acknowledgedInteractionIDs.removeAll()
        control = LinkControl(controllerClientId: nil, controlGeneration: 0)
    }
    func refresh() async throws {
        guard let client else { throw LinkFailure("Not connected") }
        var params: [String: LinkJSON] = [:]
        if remoteOrigin == nil { params["profile"] = launchProfile }
        sessions = try await client.request("list", params, as: [LinkSession].self)
    }
    private func subscribeToActivity() async {
        guard connected, let client else { return }
        let epoch = connectionEpoch
        subscribingActivity = true; bufferedActivity.removeAll()
        do {
            var params: [String: LinkJSON] = [:]
            if remoteOrigin == nil { params["profile"] = launchProfile }
            let result = try await client.request("subscribeActivity", params, as: LinkActivitySubscription.self)
            guard epoch == connectionEpoch, connected else { return }
            activitySubscriptionID = result.subscriptionId
            sessionActivity.install(result.activities, viewed: snapshot?.sessionId)
            if let id = snapshot?.sessionId {
                sessionActivity.viewed(id, messageCount: sidebarSummaries[id]?.messageCount)
            }
            let pending = bufferedActivity
            bufferedActivity.removeAll(); subscribingActivity = false
            for frame in pending { try receiveSessionActivity(frame) }
        } catch {
            guard epoch == connectionEpoch else { return }
            subscribingActivity = false; bufferedActivity.removeAll()
            self.error = error.localizedDescription // The chat remains usable without this optional feed.
        }
    }

    private func receiveSessionActivity(_ frame: LinkIncomingFrame.ActivityEvent) throws {
        if subscribingActivity { bufferedActivity.append(frame); return }
        guard connected, let subscriptionID = activitySubscriptionID,
              frame.subscriptionId == subscriptionID else { return }
        let activity = frame.activity
        var next = sessionActivity
        next.apply(activity, baseline: frame.baseline == true, viewed: snapshot?.sessionId)
        if next != sessionActivity {
            sessionActivity = next
            // Preserve the last known count after a worker goes away. A later list
            // refresh replaces it; the attached transcript keeps its own exact count.
            if activity.removed == true, activity.sessionId != snapshot?.sessionId,
               let session = sessions.first(where: { $0.sessionId == activity.sessionId }) {
                var summary = sidebarSummary(for: session)
                summary.messageCount = activity.messageCount
                sidebarSummaries[activity.sessionId] = summary
            }
        }
    }

    func sidebarConnection(for session: LinkSession) -> SessionSidebarConnection {
        guard connected, snapshot?.sessionId == session.sessionId else { return .disconnected }
        return ownsControl ? .connected : .viewing
    }

    func sidebarWorking(for session: LinkSession) -> Bool {
        guard connected else { return false }
        if snapshot?.sessionId == session.sessionId, live?.isNotificationBusy == true { return true }
        guard let activity = sessionActivity.activities[session.sessionId], activity.removed != true else { return false }
        return activity.working == true
    }

    func sidebarMessageCount(for session: LinkSession) -> Int? {
        if snapshot?.sessionId == session.sessionId, let count = sidebarSummaries[session.sessionId]?.messageCount { return count }
        if let activity = sessionActivity.activities[session.sessionId], activity.removed != true { return activity.messageCount }
        return sidebarSummaries[session.sessionId]?.messageCount ?? session.messageCount.flatMap { $0 >= 0 ? $0 : nil }
    }

    private func mergeSidebarMetadata() {
        for session in sessions where session.sessionId != snapshot?.sessionId {
            guard let cached = sidebarSummaries[session.sessionId] else { continue }
            let summary = SessionSidebarSummary(
                name: session.name, preview: cached.preview,
                modified: [cached.modified, session.modifiedDate].compactMap { $0 }.max(),
                messageCount: session.messageCount.flatMap { $0 >= 0 ? $0 : nil } ?? cached.messageCount
            )
            if summary != cached { sidebarSummaries[session.sessionId] = summary }
        }
    }

    func sidebarSummary(for session: LinkSession) -> SessionSidebarSummary {
        sidebarSummaries[session.sessionId] ?? SessionSidebarSummary(
            name: session.name, preview: SessionSidebarSummary.excerpt(session.firstMessage), modified: session.modifiedDate,
            messageCount: session.messageCount.flatMap { $0 >= 0 ? $0 : nil }
        )
    }

    private func updateSidebarSummary(frameType: String) {
        guard let snapshot else { return }
        let previous = sidebarSummaries[snapshot.sessionId]
        let listed = sessions.first { $0.sessionId == snapshot.sessionId }
        let activity: Date?
        switch frameType {
        case "snapshot":
            activity = records.lazy.compactMap(SessionSidebarSummary.activityDate).max()
                ?? listed?.modifiedDate ?? LinkSession.date(from: snapshot.header?.timestamp)
        case "append": activity = records.last.flatMap(SessionSidebarSummary.activityDate)
        default: activity = nil
        }
        let partialDate: Date?
        if let timestamp = live?.partial?.timestamp, timestamp.isFinite, timestamp > 0 {
            partialDate = Date(timeIntervalSince1970: timestamp / 1000)
        } else { partialDate = nil }
        let modified = [previous?.modified, listed?.modifiedDate, activity, partialDate].compactMap { $0 }.max()
        let count: Int
        if frameType != "snapshot", let previousCount = previous?.messageCount {
            count = previousCount + (frameType == "append" && records.last?.type == "message" ? 1 : 0)
        } else {
            count = records.lazy.filter { $0.type == "message" }.count
        }
        // Tool-only/empty live observations must not rescan finalized history for text.
        let preview = messages.partial.flatMap {
            SessionSidebarSummary.latestMessage(in: CollectionOfOne($0))
        } ?? committedSidebarPreview
        let summary = SessionSidebarSummary(
            name: live?.sessionName, preview: preview, modified: modified,
            messageCount: count
        )
        if previous != summary { sidebarSummaries[snapshot.sessionId] = summary }
        var observed = sessionActivity
        observed.viewed(snapshot.sessionId, messageCount: count)
        if observed != sessionActivity { sessionActivity = observed }
    }

    private var launchProfile: LinkJSON {
        .object(["agentDir": .string(agentDir), "args": .array([]), "env": .object(remoteOrigin == nil ? environment.mapValues(LinkJSON.string) : [:])])
    }
    func select(_ id: String) async {
        guard !busy, occupiedSelection == nil, connected, let client else { return }
        busy = true; defer { busy = false }
        error = nil
        let descriptor = sessions.first { $0.id == id }
        do {
            // Admission is atomic. Keep the current presentation until a new snapshot arrives.
            let ack = try await client.request("attach", attachmentParams(id, descriptor: descriptor, control: true, ifUnoccupied: true), as: LinkAttachmentAck.self)
            try await waitForAttachment(ack)
        } catch let failure as LinkFailure where failure.isContextOccupied {
            if let descriptor { occupiedSelection = descriptor }
            else { self.error = "Another client is attached. Refresh the session list to choose Watch, Fork, or Steal." }
        } catch { self.error = error.localizedDescription }
    }
    func cancelOccupiedSelection() { occupiedSelection = nil }
    func resolveOccupied(_ choice: OccupiedChoice) async {
        guard let selection = occupiedSelection else { return }
        await resolveOccupied(choice, selection: selection)
    }
    // Capture selection synchronously in the button action: SwiftUI may dismiss
    // the confirmation dialog before the action's Task starts running.
    func resolveOccupied(_ choice: OccupiedChoice, selection source: LinkSession) async {
        guard !busy, connected, let client else { return }
        busy = true; defer { busy = false }
        occupiedSelection = nil
        error = nil
        var watchingSource = false
        do {
            // Fork first watches the source; it never takes the source controller's lease.
            let ack = try await client.request("attach", attachmentParams(source.id, descriptor: source, control: choice == .steal), as: LinkAttachmentAck.self)
            try await waitForAttachment(ack)
            watchingSource = choice == .fork
            if choice == .fork {
                let forkAck = try await client.request("fork", as: LinkAttachmentAck.self)
                try await waitForAttachment(forkAck)
                try await refresh()
            }
        } catch {
            if watchingSource && connected && selectedID == source.id {
                self.error = "Fork failed; watching the selected source session. " + error.localizedDescription
            } else { self.error = error.localizedDescription }
        }
    }
    private func attachmentParams(_ id: String, descriptor: LinkSession?, control: Bool, ifUnoccupied: Bool = false) -> [String: LinkJSON] {
        let profile: LinkJSON = .object([
            "agentDir": .string(descriptor?.agentDir ?? agentDir),
            "args": .array([]), "env": .object(remoteOrigin == nil ? environment.mapValues(LinkJSON.string) : [:])
        ])
        var params: [String: LinkJSON] = ["sessionId": .string(id), "control": .bool(control), "profile": profile]
        if remoteOrigin != nil { params.removeValue(forKey: "profile") }
        if ifUnoccupied { params["ifUnoccupied"] = .bool(true) }
        if let identity = descriptor?.fileIdentity { params["fileIdentity"] = .string(identity) }
        return params
    }
    /// Wire delivery precedes the RPC reply, but the MainActor frame task may lag.
    /// Wait for canonical presentation; never apply the snapshot from a second source.
    func waitForAttachment(_ ack: LinkAttachmentAck) async throws {
        try Task.checkCancellation()
        guard connected else { throw LinkFailure("Disconnected before attachment was presented") }
        let id = ack.sessionId, seq = ack.seq
        if snapshot?.sessionId == id && sequence >= seq { return }
        let key = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
                attachmentWaiters[key] = (id, seq, waiter)
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(30))
                    self?.attachmentWaiters.removeValue(forKey: key)?.waiter.resume(throwing: LinkFailure("Attachment snapshot timed out. Reconnect to reconcile; the request was not replayed."))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.attachmentWaiters.removeValue(forKey: key)?.waiter.resume(throwing: CancellationError())
            }
        }
    }
    private func finishAttachmentWaiters() {
        for (key, pending) in attachmentWaiters where snapshot?.sessionId == pending.id && sequence >= pending.seq {
            attachmentWaiters.removeValue(forKey: key)?.waiter.resume()
        }
    }
    private func failAttachmentWaiters(_ error: Error) {
        let waiting = attachmentWaiters.values
        attachmentWaiters.removeAll()
        for pending in waiting { pending.waiter.resume(throwing: error) }
    }
    func create() async {
        guard !busy, occupiedSelection == nil, connected, let client else { return }
        busy = true
        do {
            let result = try await client.request("create", as: LinkCreatedSession.self)
            guard let id = result.sessionId ?? result.id else { throw LinkFailure("Daemon create did not return a session ID") }
            try await refresh()
            busy = false
            await select(id)
            // Creation/selection never silently takes another controller's authority.
        } catch { self.error = error.localizedDescription }
        busy = false
    }
    func takeControl() async { await perform("takeControl") }
    func releaseControl() async { await perform("releaseControl", ["controlGeneration": .number(Double(control.controlGeneration))]) }
    @discardableResult private func perform(_ method: String, _ params: [String: LinkJSON] = [:]) async -> Bool {
        guard !busy, occupiedSelection == nil, connected, snapshot?.sessionId == selectedID, let client else { return false }
        busy = true; defer { busy = false }
        do { _ = try await client.request(method, params, as: LinkAcknowledgment.self); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    @discardableResult func mutate(_ command: String, args: [LinkJSON] = []) async -> Bool {
        guard canMutate, let client else { return false }
        let generation = control.controlGeneration
        busy = true; defer { busy = false }
        do {
            _ = try await client.request("mutate", ["command": .string(command), "args": .array(args), "controlGeneration": .number(Double(generation))], as: LinkOperationAcceptance.self)
            // Admission is not completion. Canonical operation frames update status independently.
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    var activityContext: ActivityStore.Context {
        .init(connection: connectionEpoch, sessionID: snapshot?.sessionId, connected: connected,
              canMutate: canMutate, ownsControl: ownsControl, control: control, local: remoteOrigin == nil)
    }

    func readService(_ service: String, operation: String, args: [LinkJSON] = [], serviceGeneration: String? = nil) async throws -> LinkServiceValue {
        guard connected, let parentID = snapshot?.sessionId, parentID == selectedID, let client else {
            throw LinkFailure("No attached session")
        }
        let epoch = connectionEpoch
        var params: [String: LinkJSON] = ["service": .string(service), "operation": .string(operation), "args": .array(args)]
        if let serviceGeneration { params["serviceGeneration"] = .string(serviceGeneration) }
        let value: LinkServiceValue
        switch (service, operation) {
        case ("background", "status"):
            value = .backgroundTask(try await client.request("serviceRead", params, as: LinkBackgroundTaskDetail.self))
        case ("subagents", "view"):
            value = .childView(try await client.request("serviceRead", params, as: LinkChildView.self))
        case ("subagents", "inspect"):
            value = .childInspection(try await client.request("serviceRead", params, as: LinkChildInspection.self))
        case ("permissions", "snapshot"):
            value = .permissions(try await client.request("serviceRead", params, as: PermissionState.self))
        case ("subagents", "list"):
            value = .children(try await client.request("serviceRead", params, as: [ChildSummary].self))
        case ("background", "list"):
            value = .backgroundTasks(try await client.request("serviceRead", params, as: [LinkBackgroundTask].self))
        default:
            value = .fallback(try await client.request("serviceRead", params, as: LinkJSON.self))
        }
        guard epoch == connectionEpoch, connected, snapshot?.sessionId == parentID else {
            throw LinkFailure("Session changed while reading activity")
        }
        return value
    }

    func mutateService(_ service: String, operation: String, args: [LinkJSON], serviceGeneration: String) async throws -> String {
        guard canMutate, let client else { throw LinkFailure("This session is read-only or busy") }
        let epoch = connectionEpoch
        let parentID = selectedID
        let generation = control.controlGeneration
        busy = true; defer { busy = false }
        let accepted = try await client.request("serviceMutate", [
            "service": .string(service), "operation": .string(operation), "args": .array(args),
            "serviceGeneration": .string(serviceGeneration), "controlGeneration": .number(Double(generation))
        ], as: LinkOperationAcceptance.self)
        guard epoch == connectionEpoch, selectedID == parentID else {
            throw LinkFailure("Session changed; operation outcome may be uncertain. Not replayed.")
        }
        return accepted.operationId
    }

    @discardableResult func answer(_ request: LinkInteraction, value: LinkJSON) async -> Bool {
        guard canMutate, request.kind != "custom",
              !acknowledgedInteractionIDs.contains(request.id),
              interactions.contains(where: { $0.id == request.id && $0.kind == request.kind }) else { return false }
        let epoch = connectionEpoch
        let sessionID = selectedID
        let accepted = await perform("answer", ["requestId": .string(request.id), "value": value, "controlGeneration": .number(Double(control.controlGeneration))])
        guard epoch == connectionEpoch, selectedID == sessionID, snapshot?.sessionId == sessionID else { return false }
        if accepted, interactions.contains(where: { $0.id == request.id }) {
            acknowledgedInteractionIDs.insert(request.id)
        }
        return accepted
    }
    func apply(_ frame: LinkIncomingFrame) throws {
        let type = frame.type
        if case .sessionActivity(let activity) = frame.payload { try receiveSessionActivity(activity); return }
        var projectionChanged = false
        var committedChanged = false
        var partialChanged = false
        if case .snapshot(let incoming) = frame.payload {
            guard incoming.header != nil else { throw LinkFailure("Native session header missing") }
            if snapshot?.sessionId != incoming.sessionId { acknowledgedInteractionIDs.removeAll() }
            snapshot = incoming; selectedID = incoming.sessionId; sequence = incoming.seq
            sessionActivity.viewed(incoming.sessionId)
            records = incoming.entries
            live = incoming.live
            workingMessage = incoming.uiState?.first(where: { $0.method == "setWorkingMessage" })?.workingMessage
            leafID = incoming.leafId; control = incoming.control
            interactions = incoming.pendingRequests; operations = incoming.operations
            observedBusy = incoming.live.isNotificationBusy || !incoming.pendingRequests.isEmpty
            lastLiveSequence = nil
            projectionChanged = true
            committedChanged = true
        } else {
            guard frame.sessionId == snapshot?.sessionId else { return }
            guard frame.seq == sequence + 1 else { throw LinkFailure("Sequence gap. Reconnect for a fresh authoritative snapshot; commands will not replay.") }
            sequence += 1
            switch frame.payload {
            case .append(let entry):
                records.append(entry)
                projectionChanged = true
                // An append outside the current ancestry cannot change its projection.
                // Missing ancestors and duplicate IDs on that ancestry still rebuild;
                // every native record/event is retained and applied as before.
                committedChanged = !UserDefaults.standard.bool(forKey: "experimentalNativeTranscript")
                    || committedProjection?.isAffected(byAppending: entry) != false
            case .leaf(let incomingLeaf):
                committedChanged = incomingLeaf != leafID
                if committedChanged { leafID = incomingLeaf }
                projectionChanged = true
            case .live(let incomingLive):
                partialChanged = incomingLive.partial != live?.partial
                if live != incomingLive { live = incomingLive }
                lastLiveSequence = sequence
                if live?.isNotificationBusy == true { observedBusy = true }
                projectionChanged = true
            case .ui(let action):
                if action.method == "setWorkingMessage" { workingMessage = action.workingMessage }
            case .event(let event):
                if event.type == "agent_start" { observedBusy = true }
                if event.type == "agent_settled", connected, observedBusy,
                   lastLiveSequence == sequence - 1, live?.isNotificationIdle == true,
                   interactions.isEmpty, let sessionID = snapshot?.sessionId {
                    observedBusy = false
                    settlements.send(SessionSettlement(
                        id: "\(connectionEpoch.uuidString):\(sessionID):\(sequence)",
                        sessionID: sessionID, remoteOrigin: remoteOrigin,
                        title: live?.sessionName ?? sessions.first(where: { $0.id == sessionID })?.name ?? "Pi"
                    ))
                }
            case .control(let incomingControl):
                control = incomingControl
            case .interaction(let request):
                observedBusy = true
                interactions.removeAll { $0.id == request.id }; interactions.append(request)
            case .interactionResolved(let requestID): interactions.removeAll { $0.id == requestID }
            case .operation(let op):
                operations.removeAll { $0.id == op.id }; operations.append(op)
                if let failure = op.error { error = failure }
            default: break // Event/UI/child frames still advance sequence; no invented state.
            }
        }
        if type == "snapshot" || type == "interaction" || type == "interactionResolved" {
            acknowledgedInteractionIDs.formIntersection(Set(interactions.map(\.id)))
        }
        if projectionChanged, let snapshot {
            // Native history/branch changes rebuild committed display values. Streaming
            // observations reuse those values instead of regenerating the whole transcript.
            if committedChanged || committedProjection == nil {
                if UserDefaults.standard.bool(forKey: "experimentalNativeTranscript") {
                    committedProjection = SessionMessage.projectCommittedIndexed(records: records, leafID: leafID)
                } else {
                    committedProjection = SessionMessage.projectCommitted(records: records, leafID: leafID)
                }
                committedSidebarPreview = committedProjection.flatMap { SessionSidebarSummary.latestMessage(in: $0.messages) }
                partialChanged = true
            }
            if partialChanged, let committedProjection {
                messages = committedProjection.observing(live?.partial, sessionID: snapshot.sessionId)
            }
            // Metadata can change even when the branch and partial are unchanged.
            updateSidebarSummary(frameType: type)
        }
        finishAttachmentWaiters()
        activityFrames.send(frame)
    }
}
#endif
