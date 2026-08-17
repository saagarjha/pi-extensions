#if os(macOS)
import Foundation
import Combine

/// A fresh, observed busy-to-settled transition, never a history/snapshot notification.
nonisolated struct SessionSettlement: Sendable {
    let id: String
    let sessionID: String
    let remoteOrigin: String?
    let title: String
    let connectionEpoch: UUID
    let observationID: UUID
    let ownerIncarnation: String?
}

@MainActor final class DaemonSessionStore: ObservableObject {
    let settlements = PassthroughSubject<SessionSettlement, Never>()
    let settlementInvalidations = PassthroughSubject<String, Never>()
    private var currentSettlements: [String: SessionSettlement] = [:]

    /// An idle lease belongs to a canonical attachment, never sidebar selection.
    func isCurrentSettlement(_ event: SessionSettlement) -> Bool {
        guard connected, remoteOrigin == event.remoteOrigin, connectionEpoch == event.connectionEpoch,
              currentSettlements[event.sessionID]?.id == event.id,
              let attachment = attachments[event.sessionID], !attachment.failed,
              attachment.observationID == event.observationID,
              attachment.snapshot?.ownerIncarnation == event.ownerIncarnation else { return false }
        if activeAttachment === attachment {
            return snapshot?.sessionId == event.sessionID && live?.isNotificationIdle == true && interactions.isEmpty
        }
        return attachment.live?.isNotificationIdle == true && attachment.interactions.isEmpty
    }

    private func invalidateSettlement(for sessionID: String) {
        if let event = currentSettlements.removeValue(forKey: sessionID) {
            settlementInvalidations.send(event.id)
        }
    }

    private func invalidateSettlement(for frame: LinkIncomingFrame) {
        guard let id = frame.sessionId else { return }
        switch frame.payload {
        case .snapshot, .interaction: invalidateSettlement(for: id)
        case .live(let live) where !live.isNotificationIdle: invalidateSettlement(for: id)
        case .event(let event) where event.type == "agent_start": invalidateSettlement(for: id)
        default: break
        }
    }

    private func publishSettlement(sessionID: String, sequence: Int, title: String) {
        guard let attachment = attachments[sessionID] else { return }
        invalidateSettlement(for: sessionID)
        let event = SessionSettlement(id: "\(connectionEpoch):\(sessionID):\(sequence)",
            sessionID: sessionID, remoteOrigin: remoteOrigin, title: title,
            connectionEpoch: connectionEpoch, observationID: attachment.observationID,
            ownerIncarnation: attachment.snapshot?.ownerIncarnation)
        currentSettlements[sessionID] = event
        settlements.send(event)
    }
    /// Validated canonical frames for attached-session activity panels.
    let activityFrames = PassthroughSubject<LinkIncomingFrame, Never>()
    private var pinnedActivityFrames: [String: PassthroughSubject<LinkIncomingFrame, Never>] = [:]
    func activityFrames(for sessionID: String?) -> AnyPublisher<LinkIncomingFrame, Never> {
        guard let sessionID else { return activityFrames.eraseToAnyPublisher() }
        if let existing = pinnedActivityFrames[sessionID] { return existing.eraseToAnyPublisher() }
        let frames = PassthroughSubject<LinkIncomingFrame, Never>()
        pinnedActivityFrames[sessionID] = frames
        return frames.eraseToAnyPublisher()
    }
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
    @Published var selectedID: String? {
        willSet { if newValue != selectedID { cancelPartialPublication() } }
    }
    // Sidebar intent is presentation-only; selectedID remains the canonical attachment.
    @Published private(set) var requestedSelectionID: String?
    private(set) var selectionRevision: UInt64 = 0
    // Only a settled failure of this intent may show the unloaded retry state.
    private var failedSelectionRevision: UInt64?
    private var selecting = false
    // Native List can call its binding setter inside a SwiftUI view update.
    // Stage intent without ObservableObject publication: the binding immediately
    // reads the clicked row, and action admission immediately sees it as pending.
    private var stagedSelection: (id: String, revision: UInt64, connection: UUID)?
    private var selectionPublicationScheduled = false
    var presentedSelectionID: String? { stagedSelection?.id ?? requestedSelectionID ?? selectedID }
    var selectionPending: Bool { stagedSelection != nil || requestedSelectionID != nil }
    var selectionLoading: Bool { stagedSelection != nil || (requestedSelectionID != nil && failedSelectionRevision != selectionRevision) }
    @Published var snapshot: LinkSnapshot?
    @Published var records: [NativeRecord] = []
    // Canonical values always advance immediately; only partial-only SwiftUI
    // invalidation is coalesced. No projected-publisher consumers depend on these.
    var live: LinkLive? {
        willSet {
            guard newValue != live else { return }
            if let next = newValue, let previous = live,
               next.isActivityServiceOnlyUpdate(from: previous) { return }
            transcriptWillChange()
        }
    }
    @Published private(set) var workingMessage: String?
    @Published private(set) var statusFooterData: LinkStatusFooterData?
    @Published var leafID: String?
    @Published var control = LinkControl(controllerClientId: nil, controlGeneration: 0)
    @Published var interactions: [LinkInteraction] = []
    @Published private(set) var hiddenPendingRequests: [String: [LinkInteraction]] = [:]
    @Published private(set) var hiddenErrors: [String: String] = [:]
    @Published private(set) var attachmentModes: [String: SessionSidebarConnection] = [:]
    /// HTTP acknowledgement may precede interactionResolved; shared across window/sheet presenters.
    @Published private(set) var acknowledgedInteractionIDs: Set<String> = []
    @Published var operations: [LinkOperation] = []
    typealias LocalSubmission = UserSubmission
    @Published private(set) var localSubmissions: [String: [LocalSubmission]] = [:]
    private var submissionPresentations: [String: UserMessagePresentation] = [:]
    private struct QueueCut {
        let seq: Int
        let steering: [String]
        let followUp: [String]
    }
    @Published private var queueCuts: [String: QueueCut] = [:]
    func presentedSubmissions(for id: String?) -> [SessionMessage] {
        guard let id else { return [] }
        return localSubmissions[id, default: []].map(\.message)
    }
    func presentedQueue(for id: String?) -> [SessionMessage] {
        guard let id, let value = selectedID == id ? live : attachments[id]?.live else { return [] }
        // A window can present a retained attachment while another session owns
        // the sidebar. Queue handoffs are scoped to that attachment's live epoch.
        let attachment = attachments[id]
        let liveSequence = selectedID == id ? lastLiveSequence ?? snapshot?.seq ?? 0
            : attachment?.lastLiveSequence ?? attachment?.snapshot?.seq ?? 0
        let cut = queueCuts[id].flatMap { $0.seq > liveSequence ? $0 : nil }
        let live = value
        let queueSequence = cut?.seq ?? liveSequence
        let steering = (cut?.steering ?? live.steering ?? []).enumerated().map { index, text in
            SessionMessage.queued(id: "queue:\(id):steering:\(index)", text: text, mode: .steering, seq: queueSequence)
        }
        let followUp = (cut?.followUp ?? live.followUp ?? []).enumerated().map { index, text in
            SessionMessage.queued(id: "queue:\(id):followUp:\(index)", text: text, mode: .followUp, seq: queueSequence)
        }
        return steering + followUp
    }
    var messages: SessionMessage.Transcript = [] {
        willSet { if newValue != messages { transcriptWillChange() } }
    }
    // Eligible partials refresh only their session content, not window-level UI.
    // Receivers reread canonical state; structural and control changes still publish globally.
    let partialTranscriptPublications = PassthroughSubject<String, Never>()
    private var coalescingPartialPublication = false
    private var partialPublicationTask: Task<Void, Never>?
    private var lastTranscriptPublication: ContinuousClock.Instant?
    private var lastPublishedSequence: Int?
    private var committedProjection: SessionMessage.CommittedProjection?
    private var toolPresentation = SessionMessage.ToolExecutionProjection()
    private var incrementalProjection: SessionMessage.IncrementalProjection?
    private var committedSidebarPreview: String?
    @Published var error: String?
    @Published private(set) var localConnectionFailed = false
    // Optional sidebar feed failures must not appear as session/chat failures.
    @Published private(set) var activityError: String?
    @Published var connected = false
    @Published var busy = false
    private var agentDir = DaemonDiscovery.userHome.appendingPathComponent(".pi/agent").path
    @Published var savedRemoteProfiles: [String] = RemoteProfileKeychain.origins()
    @Published var remoteOrigin: String?
    private var controlClientID: String?
    /// The management connection owns the existing list/activity subscription, never an attachment.
    private var client: SessionLinkClient?
    // Durable content outlives sockets, daemon instances, app exits, and mobile suspension.
    private let recordCache = LinkRecordCache.shared
    private var frameTask: Task<Void, Never>?
    private final class Attachment {
        var sessionID: String
        var observationID = UUID()
        var childObservations: [String: LinkChildObservation] = [:]
        var childServiceGeneration: String?
        var toolPresentation = SessionMessage.ToolExecutionProjection()
        let client: SessionLinkClient
        var clientID: String?
        var control: LinkControl?
        var task: Task<Void, Never>?
        var failed = false
        var previous: Attachment?
        var recordKeys: [String] = []
        var resumeControl: Bool?
        var snapshot: LinkSnapshot?
        var records: [NativeRecord] = []
        var sequence = 0
        var live: LinkLive?
        var leafID: String?
        var workingMessage: String?
        var statusFooterData: LinkStatusFooterData?
        var interactions: [LinkInteraction] = []
        var operations: [LinkOperation] = []
        var acknowledged: Set<String> = []
        var observedBusy = false
        var lastLiveSequence: Int?
        var committed: SessionMessage.CommittedProjection?
        var incremental: SessionMessage.IncrementalProjection?
        var preview: String?
        var messages: SessionMessage.Transcript = []
        var projectionDirty = false
        init(sessionID: String, client: SessionLinkClient) { self.sessionID = sessionID; self.client = client }
    }
    private var attachments: [String: Attachment] = [:]
    private var windowReferences: [String: Int] = [:]
    private var windowAttachmentsInFlight: Set<String> = []
    private var pendingWindowPartialPublication: Set<String> = []
    @Published private(set) var windowErrors: [String: String] = [:]
    /// Stable display-only projection. Service/activity updates can arrive every
    /// stream delta; publish only if a child ID/name actually changed.
    @Published private(set) var subagentDisplayNamesBySession: [String: [String: String]] = [:]
    private var resumeModes: [String: [String: Bool]] = [:]
    private var dormant: [String: [String: Attachment]] = [:]
    private var recordKeys: [String] = []
    private var activeAttachment: Attachment?
    private var pendingSelectionID: String?
    private var forkingSourceID: String?
    private var daemonDescriptor: DaemonDescriptor?
    private var remoteProfile: RemoteConnectionProfile?
    private var attachedClient: SessionLinkClient? { activeAttachment?.client }
    private var sequence = 0
    private var attachmentWaiters: [UUID: (id: String, seq: Int, waiter: CheckedContinuation<Void, Error>)] = [:]
    private(set) var connectionEpoch = UUID()
    private var presentationEpoch = UUID()
    private var observedBusy = false
    private var lastLiveSequence: Int?
    var ownsControl: Bool {
        connected && !selectionPending && activeAttachment != nil && controlClientID != nil
            && controlClientID == control.controllerClientId
            && snapshot?.sessionId != nil && snapshot?.sessionId == selectedID
    }
    var canMutate: Bool { ownsControl && !busy && !selectionPending && occupiedSelection == nil }
    var availableModels: [LinkModel] { live?.selectableModels ?? [] }
    var currentModel: LinkModel? { live?.model }
    var selectedModelKey: LinkModelKey? { currentModel?.key }
    var canSelectModel: Bool { canMutate && !availableModels.isEmpty }

    struct WindowPresentation {
        let sessionID: String
        let title: String
        let transcript: SessionMessage.Transcript
        let snapshot: LinkSnapshot
        let live: LinkLive
        let interactions: [LinkInteraction]
        let workingMessage: String?
        var statusFooterData: LinkStatusFooterData? = nil
        let controls: Bool
        let canMutate: Bool
        let services: LinkActivityServices?
    }

    private func namesKey(for sessionID: String) -> String { "\(remoteOrigin ?? "local"):\(sessionID)" }

    func subagentDisplayNames(for sessionID: String?) -> [String: String] {
        guard let sessionID else { return [:] }
        return subagentDisplayNamesBySession[namesKey(for: sessionID)] ?? [:]
    }

    private func observeSubagentDisplayNames(_ value: LinkLive?, sessionID: String) {
        guard let children = value?.services?.subagents?.children else { return }
        let key = namesKey(for: sessionID)
        let previous = subagentDisplayNamesBySession[key] ?? [:]
        guard previous.count != children.count || children.contains(where: { previous[$0.id] != $0.name }) else { return }
        subagentDisplayNamesBySession[key] = Dictionary(uniqueKeysWithValues: children.map { ($0.id, $0.name) })
    }

    /// Popped-out windows observe the same session attachment as the main window.
    func windowPresentation(for id: String) -> WindowPresentation? {
        if selectedID == id, let snapshot, let live {
            return WindowPresentation(sessionID: id,
                title: LinkSession.displayTitle(live.sessionName),
                transcript: messages, snapshot: snapshot, live: live,
                interactions: interactions, workingMessage: workingMessage, statusFooterData: statusFooterData,
                controls: ownsControl, canMutate: canMutate, services: live.services)
        }
        guard let attachment = attachments[id], let snapshot = attachment.snapshot,
              let live = attachment.live, !attachment.failed else { return nil }
        if attachment.projectionDirty {
            if UserDefaults.standard.bool(forKey: "experimentalNativeTranscript") {
                if attachment.incremental == nil {
                    attachment.incremental = SessionMessage.IncrementalProjection(records: attachment.records, leafID: attachment.leafID)
                }
                attachment.messages = attachment.incremental?.observing(live.partial, sessionID: id,
                    executions: live.toolExecutions ?? [], presentation: attachment.toolPresentation) ?? []
                attachment.committed = nil
            } else {
                if attachment.committed == nil {
                    attachment.committed = SessionMessage.projectCommitted(records: attachment.records, leafID: attachment.leafID)
                }
                attachment.messages = attachment.committed?.observing(live.partial, sessionID: id,
                    executions: live.toolExecutions ?? [], presentation: attachment.toolPresentation) ?? []
            }
            attachment.projectionDirty = false
        }
        let controls = connected && attachment.clientID != nil &&
            attachment.control?.controllerClientId == attachment.clientID
        return WindowPresentation(sessionID: id,
            title: LinkSession.displayTitle(live.sessionName),
            transcript: attachment.messages, snapshot: snapshot, live: live,
            interactions: attachment.interactions, workingMessage: attachment.workingMessage,
            statusFooterData: attachment.statusFooterData,
            controls: controls, canMutate: controls && !busy && occupiedSelection == nil, services: live.services)
    }

    func windowHasAnswered(_ requestID: String, for sessionID: String) -> Bool {
        if selectedID == sessionID, snapshot?.sessionId == sessionID {
            return acknowledgedInteractionIDs.contains(requestID)
        }
        return attachments[sessionID]?.acknowledged.contains(requestID) == true
    }

    func dismissWindowError(for id: String) { windowErrors.removeValue(forKey: id) }
    func registerWindow(for id: String) { windowReferences[id, default: 0] += 1 }
    private func publishWindow(_ id: String, partial: Bool = false) {
        guard windowReferences[id, default: 0] > 0 else { return }
        if !partial { objectWillChange.send(); return }
        guard pendingWindowPartialPublication.insert(id).inserted else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(50))
            guard let self else { return }
            self.pendingWindowPartialPublication.remove(id)
            if self.windowReferences[id, default: 0] > 0 {
                self.partialTranscriptPublications.send(id)
            }
        }
    }
    func unregisterWindow(for id: String) {
        let count = windowReferences[id, default: 0]
        if count <= 1 {
            windowReferences.removeValue(forKey: id)
            pinnedActivityFrames.removeValue(forKey: id)
        } else { windowReferences[id] = count - 1 }
    }
    func attachWindow(for id: String) async {
        guard connected, windowReferences[id, default: 0] > 0,
              windowAttachmentsInFlight.insert(id).inserted else { return }
        defer { windowAttachmentsInFlight.remove(id) }
        if selectedID == id, snapshot?.sessionId == id { return }
        do {
            while busy {
                try await Task.sleep(for: .milliseconds(50))
                guard connected, windowReferences[id, default: 0] > 0 else { return }
            }
            let existing = attachments[id] != nil
            let attachment = try await attachment(for: id)
            guard connected, windowReferences[id, default: 0] > 0 else { return }
            if attachment.snapshot != nil, !attachment.failed { return }
            let descriptor = sessions.first { $0.id == id }
            let ack: LinkAttachmentAck
            do {
                ack = try await attachment.client.request("attach",
                    attachmentParams(id, descriptor: descriptor, control: attachment.resumeControl ?? !existing,
                                     ifUnoccupied: !existing && attachment.resumeControl == nil,
                                     controlIfFree: attachment.resumeControl == true),
                    as: LinkAttachmentAck.self)
            } catch let failure as LinkFailure where failure.isContextOccupied {
                ack = try await attachment.client.request("attach",
                    attachmentParams(id, descriptor: descriptor, control: false),
                    as: LinkAttachmentAck.self)
            }
            // The RPC acknowledgment can precede delivery of its snapshot frame.
            // Do not let a concurrent sidebar selection attach this socket again.
            guard ack.sessionId == id else { throw LinkFailure("Unexpected attached session") }
            let deadline = ContinuousClock.now.advanced(by: .seconds(30))
            while attachment.snapshot?.sessionId != id || attachment.sequence < ack.seq {
                try await Task.sleep(for: .milliseconds(25))
                guard connected, attachments[id] === attachment,
                      windowReferences[id, default: 0] > 0 else { return }
                if ContinuousClock.now >= deadline { throw LinkFailure("Session snapshot timed out") }
            }
            windowErrors.removeValue(forKey: id)
            publishWindow(id)
        } catch is CancellationError { }
        catch { windowErrors[id] = error.localizedDescription }
    }

    /// A detached view's command completions must use its retained socket, not
    /// whichever session the main window happens to have selected.
    func commandCompletions(name: String, prefix: String, for sessionID: String) async -> [LinkCompletionItem]? {
        if selectedID == sessionID {
            return await commandCompletions(name: name, prefix: prefix, sessionID: sessionID)
        }
        guard connected, let attachment = attachments[sessionID], attachment.snapshot != nil,
              attachment.live?.commands?.contains(where: {
                  $0.invokedAs == name && $0.argumentCompletions == true
              }) == true else { return nil }
        let epoch = connectionEpoch
        do {
            let items = try await attachment.client.request("commandCompletions", [
                "sessionId": .string(sessionID), "name": .string(name), "prefix": .string(prefix)
            ], as: [LinkCompletionItem]?.self)
            guard connected, epoch == connectionEpoch, attachments[sessionID] === attachment,
                  attachment.snapshot?.sessionId == sessionID else { return nil }
            return items
        } catch { return nil }
    }

    /// A read against the attached owner; stale answers never cross session changes.
    func commandCompletions(name: String, prefix: String, sessionID: String) async -> [LinkCompletionItem]? {
        guard connected, snapshot?.sessionId == sessionID, selectedID == sessionID, let client = attachedClient,
              live?.commands?.contains(where: { $0.invokedAs == name && $0.argumentCompletions == true }) == true else { return nil }
        let epoch = connectionEpoch, presentation = presentationEpoch
        do {
            let items = try await client.request("commandCompletions", [
                "sessionId": .string(sessionID), "name": .string(name), "prefix": .string(prefix)
            ], as: [LinkCompletionItem]?.self)
            guard connected, epoch == connectionEpoch, presentation == presentationEpoch,
                  attachedClient === client, snapshot?.sessionId == sessionID else { return nil }
            return items
        } catch { return nil } // Typing must not surface transient completion failures as chat errors.
    }

    /// Admission only: the native session_info_changed and operation frames own the result.
    func requestSessionName(_ name: String, for sessionID: String) async -> String? {
        guard let state = windowPresentation(for: sessionID), state.canMutate,
              let attachment = attachments[sessionID], let generation = attachment.control?.controlGeneration else { return nil }
        let client = selectedID == sessionID ? attachedClient : attachment.client
        guard let client else { return nil }
        let epoch = connectionEpoch
        busy = true; defer { busy = false }
        do {
            let accepted = try await client.request("mutate", [
                "command": .string("setSessionName"), "args": .array([.string(name)]),
                "controlGeneration": .number(Double(generation))
            ], as: LinkOperationAcceptance.self)
            guard connected, epoch == connectionEpoch, attachments[sessionID] === attachment else { return nil }
            return accepted.operationId
        } catch {
            if epoch == connectionEpoch {
                if selectedID == sessionID { self.error = error.localizedDescription }
                else { windowErrors[sessionID] = error.localizedDescription }
            }
            return nil
        }
    }

    @discardableResult func selectModel(_ key: LinkModelKey, for sessionID: String) async -> Bool {
        guard let state = windowPresentation(for: sessionID), state.canMutate,
              state.live.selectableModels.contains(where: { $0.key == key }) else { return false }
        return await mutate("setModel", args: [key.selectionArgument], for: sessionID)
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
    private var forgottenProfileEpochs: [String: UUID] = [:]
    func forgetRemoteProfile(profileID: String) async {
        forgottenProfileEpochs[profileID] = UUID()
        if remoteOrigin == profileID { await disconnect() }
        dormant.removeValue(forKey: profileID); resumeModes.removeValue(forKey: profileID)
        defer { savedRemoteProfiles = RemoteProfileKeychain.origins() }
        do { try await RemoteProfileKeychain.remove(profileID) }
        catch { self.error = error.localizedDescription }
    }
    func connectRemote(profileID: String) async {
        localConnectionFailed = false
        do { try await connectUsing(profile: RemoteProfileKeychain.load(profileID)) }
        catch { self.error = error.localizedDescription }
    }
    func connect() async {
        localConnectionFailed = false
        do { try await connectUsing(startIfMissing: true) }
        catch { self.error = error.localizedDescription }
        localConnectionFailed = !connected && error != nil
    }
    /// Notification activation may join an existing broker, never launch Pi.
    func connectExisting() async {
        localConnectionFailed = false
        do { try await connectUsing() }
        catch { self.error = error.localizedDescription }
    }
    private func connectUsing(profile: RemoteConnectionProfile? = nil, startIfMissing: Bool = false) async throws {
        guard !busy else { return }
        busy = true; defer { busy = false }
        await disconnect()
        error = nil
        do {
            let descriptor: DaemonDescriptor?
            if profile != nil { descriptor = nil }
            else {
                do { descriptor = try await DaemonDiscovery.discover() }
                catch is DaemonDiscovery.MissingDaemon {
                    guard startIfMissing else { throw DaemonDiscovery.MissingDaemon() }
                    descriptor = try await DaemonDiscovery.bootstrap()
                }
            }
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
                    await self.disconnect()
                    self.error = error.localizedDescription
                }
            }
            if let profile { try await connection.connect(profile) }
            else if let descriptor { try await connection.connect(descriptor) }
            daemonDescriptor = descriptor
            remoteProfile = profile
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
        cancelPartialPublication()
        failAttachmentWaiters(LinkFailure("Disconnected before attachment was presented"))
        for id in Array(currentSettlements.keys) { invalidateSettlement(for: id) }
        connectionEpoch = UUID()
        presentationEpoch = UUID()
        observedBusy = false; lastLiveSequence = nil
        frameTask?.cancel(); frameTask = nil
        await client?.close(); client = nil
        retainPresentation()
        let retiredAttachments = Array(attachments.values)
        for attachment in retiredAttachments {
            dormant[remoteOrigin ?? "local", default: [:]][attachment.sessionID] = attachment
            resumeModes[remoteOrigin ?? "local", default: [:]][attachment.sessionID] = attachment.resumeControl
                ?? (attachment.clientID != nil && attachment.control?.controllerClientId == attachment.clientID)
        }
        attachments.removeAll()
        for attachment in retiredAttachments {
            attachment.task?.cancel()
            await attachment.client.close()
        }
        activeAttachment = nil; pendingSelectionID = nil; forkingSourceID = nil
        stagedSelection = nil; requestedSelectionID = nil; selectionRevision &+= 1
        daemonDescriptor = nil; remoteProfile = nil
        hiddenPendingRequests.removeAll(); hiddenErrors.removeAll(); attachmentModes.removeAll()
        controlClientID = nil
        connected = false; sessions = []; selectedID = nil; snapshot = nil; occupiedSelection = nil
        records = []; messages = []; committedProjection = nil; incrementalProjection = nil; committedSidebarPreview = nil; interactions = []; operations = []
        toolPresentation = SessionMessage.ToolExecutionProjection()
        live = nil; workingMessage = nil; statusFooterData = nil; leafID = nil; sidebarSummaries.removeAll()
        sessionActivity = SessionActivityTracker(); activitySubscriptionID = nil
        activityError = nil
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
            activityError = nil
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
            activityError = error.localizedDescription
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

    func sidebarConnection(for session: LinkSession) -> SessionSidebarConnection? {
        guard connected else { return nil }
        return attachmentModes[session.sessionId]
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
        .object(["agentDir": .string(agentDir), "args": .array([])])
    }
    private func attachment(for id: String) async throws -> Attachment {
        if let existing = attachments[id], !existing.failed { return existing }
        guard connected else { throw LinkFailure("Not connected") }
        let connection = SessionLinkClient(recordCache: recordCache)
        let attachment = Attachment(sessionID: id, client: connection)
        attachment.previous = attachments[id] ?? dormant[remoteOrigin ?? "local"]?.removeValue(forKey: id)
        attachment.resumeControl = attachment.previous?.resumeControl ?? resumeModes[remoteOrigin ?? "local"]?[id]
        let epoch = connectionEpoch
        invalidateSettlement(for: id)
        attachments[id] = attachment
        attachment.task = Task { [weak self, weak attachment] in
            do {
                for try await frame in connection.frames {
                    guard let self, let attachment, self.connectionEpoch == epoch,
                          self.attachments[attachment.sessionID] === attachment else { return }
                    try self.receiveAttachmentFrame(frame, from: attachment)
                }
                if let self, let attachment, self.connectionEpoch == epoch,
                   self.attachments[attachment.sessionID] === attachment {
                    self.invalidateSettlement(for: attachment.sessionID)
                }
            } catch {
                guard let self, let attachment, self.connectionEpoch == epoch,
                      self.attachments[attachment.sessionID] === attachment else { return }
                // Keep the last canonical replica until a fresh immutable cut arrives.
                // A retired stream cannot publish into its replacement (identity guard above).
                if self.activeAttachment === attachment { self.retainPresentation() }
                attachment.resumeControl = attachment.clientID != nil && attachment.control?.controllerClientId == attachment.clientID
                attachment.failed = true
                self.invalidateSettlement(for: attachment.sessionID)
                if self.pendingSelectionID == attachment.sessionID { self.failAttachmentWaiters(error) }
                self.hiddenPendingRequests.removeValue(forKey: attachment.sessionID)
                self.hiddenErrors[attachment.sessionID] = error.localizedDescription
                if self.windowReferences[attachment.sessionID, default: 0] > 0 {
                    self.windowErrors[attachment.sessionID] = error.localizedDescription
                }
                self.attachmentModes.removeValue(forKey: attachment.sessionID)
                if self.activeAttachment === attachment {
                    self.activeAttachment = nil; self.controlClientID = nil
                    self.snapshot = nil; self.selectedID = nil; self.live = nil
                    self.messages = []; self.records = []; self.interactions = []
                    self.committedProjection = nil; self.incrementalProjection = nil
                    self.toolPresentation = SessionMessage.ToolExecutionProjection()
                    self.error = error.localizedDescription
                }
            }
        }
        do {
            if let remoteProfile { try await connection.connect(remoteProfile) }
            else if let daemonDescriptor { try await connection.connect(daemonDescriptor) }
            else { throw LinkFailure("Daemon endpoint unavailable") }
            guard connectionEpoch == epoch, connected else { throw LinkFailure("Connection changed while attaching") }
            attachment.clientID = await connection.clientID
            return attachment
        } catch {
            if attachments[id] === attachment { attachments.removeValue(forKey: id) }
            attachment.task?.cancel()
            await connection.close(error: error)
            throw error
        }
    }

    private func updateAttachmentMode(_ attachment: Attachment) {
        attachmentModes[attachment.sessionID] =
            attachment.clientID != nil && attachment.control?.controllerClientId == attachment.clientID
                ? .controlling : .viewing
    }

    /// Move presentation ownership without copying native payloads or rebuilding the branch.
    private func retainPresentation() {
        guard let a = activeAttachment, snapshot?.sessionId == a.sessionID else { return }
        a.snapshot = snapshot; a.records = records; a.recordKeys = recordKeys; a.sequence = sequence
        a.live = live; a.leafID = leafID; a.control = control
        a.workingMessage = workingMessage; a.statusFooterData = statusFooterData
        a.interactions = interactions; a.operations = operations
        a.acknowledged = acknowledgedInteractionIDs
        a.observedBusy = observedBusy; a.lastLiveSequence = lastLiveSequence
        a.committed = committedProjection; a.incremental = incrementalProjection; a.toolPresentation = toolPresentation
        a.preview = committedSidebarPreview; a.messages = messages
        a.projectionDirty = false
    }

    private func present(_ a: Attachment) {
        cancelPartialPublication()
        retainPresentation()
        guard let retained = a.snapshot else { return }
        activeAttachment = a; controlClientID = a.clientID
        presentationEpoch = UUID()
        snapshot = retained; selectedID = a.sessionID; sequence = a.sequence
        records = a.records; recordKeys = a.recordKeys; live = a.live; leafID = a.leafID
        observeSubagentDisplayNames(a.live, sessionID: a.sessionID)
        control = a.control ?? retained.control; workingMessage = a.workingMessage
        statusFooterData = a.statusFooterData
        interactions = a.interactions; operations = a.operations
        acknowledgedInteractionIDs = a.acknowledged
        observedBusy = a.observedBusy; lastLiveSequence = a.lastLiveSequence
        incrementalProjection = a.incremental; committedProjection = a.committed; toolPresentation = a.toolPresentation
        committedSidebarPreview = a.preview
        if a.projectionDirty {
            if UserDefaults.standard.bool(forKey: "experimentalNativeTranscript") {
                if incrementalProjection == nil {
                    incrementalProjection = SessionMessage.IncrementalProjection(records: records, leafID: leafID)
                }
                messages = incrementalProjection?.observing(live?.partial, sessionID: a.sessionID, executions: live?.toolExecutions ?? [], presentation: toolPresentation) ?? []
            } else {
                if committedProjection == nil { committedProjection = SessionMessage.projectCommitted(records: records, leafID: leafID) }
                messages = committedProjection?.observing(live?.partial, sessionID: a.sessionID, executions: live?.toolExecutions ?? [], presentation: toolPresentation) ?? []
            }
            // Only branch replacement needs a prefix scan; ordinary append preview is updated below.
            committedSidebarPreview = a.preview ?? SessionSidebarSummary.latestMessage(in: messages.committed.messages)
        } else { messages = a.messages }
        hiddenPendingRequests.removeValue(forKey: a.sessionID)
        error = hiddenErrors.removeValue(forKey: a.sessionID)
        sessionActivity.viewed(a.sessionID)
        updateSidebarSummary(frameType: "selection")
        finishAttachmentWaiters()
    }

    private func receiveAttachmentFrame(_ frame: LinkIncomingFrame, from attachment: Attachment) throws {
        invalidateSettlement(for: frame)
        if case .snapshot(let incoming) = frame.payload {
            invalidateSettlement(for: attachment.sessionID)
            attachment.observationID = UUID(); attachment.childObservations.removeAll()
            attachment.childServiceGeneration = incoming.live.services?.subagents?.serviceGeneration
            retainPresentation()
            let prior = attachment.previous ?? attachment
            let incomingKeys = incoming.immutable?.entryKeys ?? []
            let reuse = incoming.immutable != nil && prior.records.count == prior.recordKeys.count
                && incomingKeys.count >= prior.recordKeys.count
                && incomingKeys.prefix(prior.recordKeys.count).elementsEqual(prior.recordKeys)
            let retainedProjection = reuse ? prior.incremental : nil
            attachment.toolPresentation = reuse ? prior.toolPresentation : SessionMessage.ToolExecutionProjection()
            retainedProjection?.reconcileSuffix(records: incoming.entries, unchangedCount: prior.records.count, leafID: incoming.leafId)
            attachment.previous = nil
            attachment.recordKeys = incomingKeys
            attachment.control = incoming.control
            attachment.resumeControl = nil // Subsequent reconnect intent follows the actual new lease.
            attachment.snapshot = incoming; attachment.records = incoming.entries
            attachment.sequence = incoming.seq; attachment.live = incoming.live; attachment.leafID = incoming.leafId
            observeSubagentDisplayNames(incoming.live, sessionID: incoming.sessionId)
            attachment.interactions = incoming.pendingRequests; attachment.operations = incoming.operations
            attachment.workingMessage = incoming.uiState?.first(where: { $0.method == "setWorkingMessage" })?.workingMessage
            attachment.statusFooterData = incoming.uiState?.first(where: { $0.method == "ownedFooter" })?.statusFooter
            attachment.incremental = retainedProjection; attachment.committed = nil; attachment.preview = nil
            attachment.projectionDirty = true
            attachment.observedBusy = incoming.live.isNotificationBusy || !incoming.pendingRequests.isEmpty
            attachment.lastLiveSequence = nil; attachment.acknowledged.removeAll()
            queueCuts.removeValue(forKey: incoming.sessionId)
            for operation in incoming.operations { reconcileSubmission(operation, sessionID: incoming.sessionId) }
            if let incarnation = incoming.ownerIncarnation {
                for index in localSubmissions[incoming.sessionId, default: []].indices where
                    localSubmissions[incoming.sessionId]![index].ownerIncarnation != incarnation {
                    localSubmissions[incoming.sessionId]![index].state = .failed(
                        "Daemon restarted; delivery cannot be verified. Copy this message for a new submission.",
                        retryable: false)
                }
            }
            if forkingSourceID == attachment.sessionID && incoming.sessionId != attachment.sessionID {
                attachments.removeValue(forKey: attachment.sessionID)
                hiddenPendingRequests.removeValue(forKey: attachment.sessionID)
                attachmentModes.removeValue(forKey: attachment.sessionID)
                attachment.sessionID = incoming.sessionId
                attachments[incoming.sessionId] = attachment
                pendingSelectionID = incoming.sessionId
                forkingSourceID = nil
            }
            updateAttachmentMode(attachment)
            if pendingSelectionID == incoming.sessionId || activeAttachment === attachment {
                if let oldID = snapshot?.sessionId, oldID != incoming.sessionId,
                   !interactions.isEmpty { hiddenPendingRequests[oldID] = interactions }
                activeAttachment = attachment
                controlClientID = attachment.clientID
                hiddenPendingRequests.removeValue(forKey: incoming.sessionId)
                let hiddenError = hiddenErrors.removeValue(forKey: incoming.sessionId)
                try apply(frame)
                if let hiddenError { error = hiddenError }
            } else {
                hiddenPendingRequests[incoming.sessionId] = incoming.pendingRequests
                publishWindow(incoming.sessionId)
            }
            return
        }
        guard frame.sessionId == attachment.sessionID else { return }
        if case .operation(let operation) = frame.payload {
            reconcileSubmission(operation, sessionID: attachment.sessionID)
        }
        if case .live = frame.payload, let cut = queueCuts[attachment.sessionID], let seq = frame.seq, seq >= cut.seq {
            queueCuts.removeValue(forKey: attachment.sessionID)
        }
        if case .live(let live) = frame.payload, live.services?.subagents?.serviceGeneration != attachment.childServiceGeneration {
            attachment.childServiceGeneration = live.services?.subagents?.serviceGeneration
            attachment.childObservations = attachment.childObservations.filter { $0.value.serviceGeneration == attachment.childServiceGeneration }
        }
        if case .childFrame(let event) = frame.payload, let sequence = event.frame.seq {
            attachment.childObservations[event.childId] = LinkChildObservation(serviceGeneration: event.serviceGeneration,
                nativeIdentity: event.nativeIdentity, sequence: sequence)
        }
        let priorControl = attachment.control
        if case .control(let incomingControl) = frame.payload {
            attachment.control = incomingControl
            updateAttachmentMode(attachment)
        }
        if activeAttachment === attachment, snapshot?.sessionId == attachment.sessionID {
            try apply(frame)
            return
        }
        guard attachment.snapshot != nil, frame.seq == attachment.sequence + 1 else {
            throw LinkFailure("Session updates were interrupted. Reconnect to refresh the conversation.")
        }
        attachment.sequence += 1
        // The same boundary as the selected-root display clock: child notifications,
        // events and duplicate leaves do not redraw this window; only eligible
        // assistant/tool-body partials are paced. Canonical state always advances.
        let priorLive = attachment.live
        var windowChanged = false
        var windowPartial = false
        switch frame.payload {
        case .append(let entry):
            attachment.records.append(entry)
            if let key = frame.entryKey { attachment.recordKeys.append(key) }
            if let projection = attachment.incremental {
                if projection.canAppendWithoutRebuild(entry, records: attachment.records) {
                    _ = projection.appended(entry, records: attachment.records)
                } else { attachment.incremental = nil; attachment.preview = nil }
            }
            attachment.committed = nil; attachment.projectionDirty = true
            windowChanged = true
        case .leaf(let leaf):
            if leaf != attachment.leafID {
                if let projection = attachment.incremental, projection.canMoveLeafWithoutRebuild(leaf, records: attachment.records) {
                    let previous = projection.content
                    projection.moveLeaf(leaf, records: attachment.records)
                    let next = projection.content
                    if next.changes(since: previous) != nil {
                        if next.messages.count > previous.messages.count {
                            attachment.preview = SessionSidebarSummary.latestMessage(in: next.messages[previous.messages.count...]) ?? attachment.preview
                        }
                    } else { attachment.preview = SessionSidebarSummary.latestMessage(in: next.messages) }
                } else { attachment.incremental = nil; attachment.preview = nil }
                attachment.leafID = leaf; attachment.committed = nil
                attachment.projectionDirty = true
                windowChanged = true
            }
        case .live(let live):
            // Branch and observation belong to the same authoritative live cut.
            if live.leafId != attachment.leafID {
                if let projection = attachment.incremental, projection.canMoveLeafWithoutRebuild(live.leafId, records: attachment.records) {
                    let previous = projection.content
                    projection.moveLeaf(live.leafId, records: attachment.records)
                    let next = projection.content
                    if next.changes(since: previous) != nil {
                        if next.messages.count > previous.messages.count {
                            attachment.preview = SessionSidebarSummary.latestMessage(in: next.messages[previous.messages.count...]) ?? attachment.preview
                        }
                    } else { attachment.preview = SessionSidebarSummary.latestMessage(in: next.messages) }
                } else { attachment.incremental = nil; attachment.preview = nil }
                attachment.leafID = live.leafId; attachment.committed = nil
                attachment.projectionDirty = true
            }
            let activityOnly = priorLive.map { live.isActivityServiceOnlyUpdate(from: $0) } == true
            windowChanged = priorLive != live && !activityOnly
            windowPartial = UserDefaults.standard.bool(forKey: "experimentalNativeTranscript")
                && attachment.interactions.isEmpty
                && priorLive.map { live.isStreamingPartialUpdate(from: $0) } == true
            attachment.live = live; attachment.lastLiveSequence = attachment.sequence
            observeSubagentDisplayNames(live, sessionID: attachment.sessionID)
            attachment.projectionDirty = true
            if live.isNotificationBusy { attachment.observedBusy = true }
        case .ui(let action):
            if action.method == "setWorkingMessage", attachment.workingMessage != action.workingMessage {
                attachment.workingMessage = action.workingMessage
                windowChanged = true
            }
            if action.method == "ownedFooter", attachment.statusFooterData != action.statusFooter {
                attachment.statusFooterData = action.statusFooter
                windowChanged = true
            }
        case .control(let control):
            windowChanged = priorControl != control
            attachment.control = control
        case .interaction(let request):
            windowChanged = true
            attachment.observedBusy = true
            attachment.interactions.removeAll { $0.id == request.id }
            attachment.interactions.append(request)
        case .interactionResolved(let id):
            windowChanged = true
            attachment.interactions.removeAll { $0.id == id }
            attachment.acknowledged.remove(id)
        case .operation(let operation):
            windowChanged = true
            attachment.operations.removeAll { $0.id == operation.id }
            attachment.operations.append(operation)
            if let failure = operation.error { hiddenErrors[attachment.sessionID] = failure }
        case .event(let event):
            if event.type == "agent_start" { attachment.observedBusy = true }
            if event.type == "agent_settled", attachment.observedBusy,
               attachment.lastLiveSequence == attachment.sequence - 1,
               attachment.live?.isNotificationIdle == true, attachment.interactions.isEmpty {
                attachment.observedBusy = false
                publishSettlement(sessionID: attachment.sessionID, sequence: attachment.sequence,
                    title: attachment.live?.sessionName ?? "Pi")
            }
        default: break
        }
        if frame.type == "interaction" || frame.type == "interactionResolved" {
            hiddenPendingRequests[attachment.sessionID] = attachment.interactions
        }
        pinnedActivityFrames[attachment.sessionID]?.send(frame)
        if windowChanged { publishWindow(attachment.sessionID, partial: windowPartial) }
    }

    /// Safe inside the native List binding's view-update callback. Do not publish here.
    func requestSelection(_ id: String) {
        guard connected, occupiedSelection == nil, !busy || selecting else { return }
        selectionRevision &+= 1
        stagedSelection = (id, selectionRevision, connectionEpoch)
        guard !selectionPublicationScheduled else { return }
        selectionPublicationScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.selectionPublicationScheduled = false
            guard let intent = self.stagedSelection else { return }
            self.stagedSelection = nil
            guard self.connected, intent.connection == self.connectionEpoch,
                  intent.revision == self.selectionRevision else { return }
            self.requestedSelectionID = intent.id
            self.error = nil
            Task { await self.drainSelection() }
        }
    }

    func select(_ id: String) async {
        guard connected, occupiedSelection == nil, !busy || selecting else { return }
        selectionRevision &+= 1
        stagedSelection = nil
        requestedSelectionID = id
        error = nil
        await drainSelection()
    }

    // Keep native attach admission serialized. New clicks replace only presentation
    // intent; an in-flight request is reconciled, never cancelled/replayed or stolen.
    private func drainSelection() async {
        guard !selecting, !busy, connected else { return }
        selecting = true
        busy = true
        defer { selecting = false; busy = false; pendingSelectionID = nil }
        let epoch = connectionEpoch
        while let id = requestedSelectionID, connected, epoch == connectionEpoch {
            // A newer native click is waiting for post-update publication. Let
            // that scheduled publication restart the drain, not the older target.
            guard stagedSelection == nil else { return }
            let revision = selectionRevision
            let loaded = await loadSelection(id, revision: revision)
            guard connected, epoch == connectionEpoch else { return }
            guard revision == selectionRevision else {
                occupiedSelection = nil
                error = nil
                continue
            }
            // A prior canonical operation error is a banner, not an attach failure.
            if loaded, snapshot?.sessionId == id, occupiedSelection == nil {
                requestedSelectionID = nil
            } else {
                failedSelectionRevision = revision
            }
            return
        }
    }

    private func loadSelection(_ id: String, revision: UInt64) async -> Bool {
        let epoch = connectionEpoch
        // A popout may have begun attaching before the first click selected its
        // sidebar row. Share the same attachment instead of racing a second RPC.
        while windowAttachmentsInFlight.contains(id) {
            try? await Task.sleep(for: .milliseconds(25))
            guard connected, epoch == connectionEpoch else { return false }
        }
        let descriptor = sessions.first { $0.id == id }
        let retained = attachments[id] != nil
        var candidate: Attachment?
        do {
            let attachment = try await attachment(for: id)
            candidate = attachment
            pendingSelectionID = id
            // A retained attachment already has every ordered canonical update.
            // Selection is local: never ask the owner for known history again.
            if attachment.snapshot != nil, !attachment.failed {
                present(attachment)
                return true
            }
            let ack = try await attachment.client.request("attach",
                attachmentParams(id, descriptor: descriptor, control: attachment.resumeControl ?? !retained,
                    ifUnoccupied: !retained && attachment.resumeControl == nil, controlIfFree: attachment.resumeControl == true),
                as: LinkAttachmentAck.self)
            try await waitForAttachment(ack)
            return true
        } catch let failure as LinkFailure where failure.isContextOccupied {
            if connected, epoch == connectionEpoch, revision == selectionRevision {
                if let descriptor { occupiedSelection = descriptor }
                else { self.error = "Another client is attached. Refresh the session list to choose Watch, Fork, or Steal." }
            }
            if !retained, let candidate, activeAttachment !== candidate { await retire(candidate) }
        } catch {
            if connected, epoch == connectionEpoch, revision == selectionRevision {
                self.error = error.localizedDescription
            }
            if !retained, let candidate, activeAttachment !== candidate { await retire(candidate) }
        }
        return false
    }

    private func retire(_ attachment: Attachment) async {
        if attachments[attachment.sessionID] === attachment {
            invalidateSettlement(for: attachment.sessionID)
            attachments.removeValue(forKey: attachment.sessionID)
            attachmentModes.removeValue(forKey: attachment.sessionID)
            hiddenPendingRequests.removeValue(forKey: attachment.sessionID)
            hiddenErrors.removeValue(forKey: attachment.sessionID)
        }
        attachment.task?.cancel()
        await attachment.client.close()
    }
    func cancelOccupiedSelection() {
        selectionRevision &+= 1
        stagedSelection = nil
        occupiedSelection = nil
        requestedSelectionID = nil
    }
    func resolveOccupied(_ choice: OccupiedChoice) async {
        guard let selection = occupiedSelection else { return }
        await resolveOccupied(choice, selection: selection)
    }
    // Capture selection synchronously in the button action: SwiftUI may dismiss
    // the confirmation dialog before the action's Task starts running.
    func resolveOccupied(_ choice: OccupiedChoice, selection source: LinkSession) async {
        guard !busy, connected else { return }
        selectionRevision &+= 1
        stagedSelection = nil
        let revision = selectionRevision
        let epoch = connectionEpoch
        var watchingSource = false
        var selectionPresented = false
        busy = true
        defer {
            pendingSelectionID = nil; forkingSourceID = nil
            // A failed Fork can still leave a valid Watch of its source (or a
            // successful fork with a watcher-retention error). Keep that fallback.
            if selectionPresented || error == nil || watchingSource { requestedSelectionID = nil }
            else if connected, epoch == connectionEpoch, revision == selectionRevision {
                failedSelectionRevision = revision
            }
            busy = false
        }
        requestedSelectionID = source.id
        occupiedSelection = nil
        error = nil
        var candidate: Attachment?
        do {
            let attachment = try await attachment(for: source.id)
            candidate = attachment
            pendingSelectionID = source.sessionId
            // Fork initially watches the source, then the broker moves this one
            // socket to its newly controlled session.
            let ack = try await attachment.client.request("attach",
                attachmentParams(source.id, descriptor: source, control: choice == .steal),
                as: LinkAttachmentAck.self)
            try await waitForAttachment(ack)
            watchingSource = choice == .fork
            selectionPresented = choice != .fork
            if choice == .fork {
                forkingSourceID = source.sessionId
                let forkAck = try await attachment.client.request("fork", as: LinkAttachmentAck.self)
                try await waitForAttachment(forkAck)
                try await refresh()
                // Fork moves the source socket to its new controlled session.
                // Keep the source's Watch attachment on a separate retained socket.
                do {
                    let watcher = try await self.attachment(for: source.id)
                    _ = try await watcher.client.request("attach",
                        attachmentParams(source.id, descriptor: source, control: false),
                        as: LinkAttachmentAck.self)
                } catch {
                    self.error = "Fork succeeded, but could not retain Watch of the source: " + error.localizedDescription
                }
            }
        } catch {
            if watchingSource && connected && selectedID == source.sessionId {
                self.error = "Fork failed; watching the selected source session. " + error.localizedDescription
            } else {
                self.error = error.localizedDescription
                if !watchingSource, let candidate, activeAttachment !== candidate { await retire(candidate) }
            }
        }
    }
    private func attachmentParams(_ id: String, descriptor: LinkSession?, control: Bool, ifUnoccupied: Bool = false, controlIfFree: Bool = false) -> [String: LinkJSON] {
        let profile: LinkJSON = .object([
            "agentDir": .string(descriptor?.agentDir ?? agentDir),
            "args": .array([])
        ])
        var params: [String: LinkJSON] = ["sessionId": .string(id), "control": .bool(control), "profile": profile]
        if remoteOrigin != nil { params.removeValue(forKey: "profile") }
        if ifUnoccupied { params["ifUnoccupied"] = .bool(true) }
        if controlIfFree { params["controlIfFree"] = .bool(true) }
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
        guard !busy, !selectionPending, occupiedSelection == nil, connected, snapshot?.sessionId == selectedID, let client = attachedClient else { return false }
        busy = true; defer { busy = false }
        do { _ = try await client.request(method, params, as: LinkAcknowledgment.self); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    /// Presentation-only outbox. Never inserts a fabricated native record into the immutable ledger.
    func submitMessage(_ text: String, images: [ComposerImage] = [], followUp: Bool = false) -> Bool {
        guard let selectedID else { return false }
        return submitMessage(text, images: images, followUp: followUp, for: selectedID)
    }
    func submitMessage(_ text: String, images: [ComposerImage] = [], followUp: Bool = false, for sessionID: String) -> Bool {
        guard let state = windowPresentation(for: sessionID), state.controls,
              !busy, occupiedSelection == nil, let attachment = attachments[sessionID],
              let ownerIncarnation = state.snapshot.ownerIncarnation,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return false }
        guard images.isEmpty || state.live.model?.input?.contains("image") != false else {
            let message = "The selected model does not accept images. Choose an image-capable model."
            if selectedID == sessionID { error = message }
            else { windowErrors[sessionID] = message }
            return false
        }
        let mode: LocalSubmission.Mode = state.live.streaming ? (followUp ? .followUp : .steering) : .prompt
        let command = mode.command
        let generation = selectedID == sessionID ? control.controlGeneration : attachment.control?.controlGeneration ?? -1
        let client = attachment.client
        var submission = LocalSubmission(id: UUID().uuidString, text: text, images: images, mode: mode,
                                         ownerIncarnation: ownerIncarnation)
        let presentation = submissionPresentations[sessionID] ?? UserMessagePresentation { [weak self] ids in
            guard let self else { return }
            let retired = Set(localSubmissions[sessionID, default: []].filter { ids.contains($0.id) && $0.handoff != nil }.map(\.id))
            guard !retired.isEmpty else { return }
            localSubmissions[sessionID]?.removeAll { retired.contains($0.id) }
            submissionPresentations[sessionID]?.retired(retired)
        }
        submissionPresentations[sessionID] = presentation
        submission.presentationWindow = presentation.register(submission, in: state.transcript)
        localSubmissions[sessionID, default: []].append(submission)
        Task { await dispatchSubmission(submission, sessionID: sessionID, client: client, command: command,
                                        controlGeneration: generation) }
        return true // The composer can clear immediately; delivery is tracked in the outbox.
    }
    func retrySubmission(_ presentationID: String) {
        guard let selectedID else { return }
        retrySubmission(presentationID, for: selectedID)
    }
    func retrySubmission(_ presentationID: String, for sessionID: String) {
        guard presentationID.hasPrefix("local-submission:"), let state = windowPresentation(for: sessionID),
              state.controls, let attachment = attachments[sessionID],
              let value = localSubmissions[sessionID]?.first(where: { "local-submission:" + $0.id == presentationID }),
              case .failed(_, retryable: true) = value.state else { return }
        let command = value.mode.command
        updateSubmission(value.id, sessionID: sessionID) { $0.state = .sending }
        Task { await dispatchSubmission(value, sessionID: sessionID, client: attachment.client, command: command,
                                        controlGeneration: selectedID == sessionID ? control.controlGeneration : attachment.control?.controlGeneration ?? -1) }
    }
    private func updateSubmission(_ id: String, sessionID: String, change: (inout LocalSubmission) -> Void) {
        guard let index = localSubmissions[sessionID]?.firstIndex(where: { $0.id == id }) else { return }
        change(&localSubmissions[sessionID]![index])
    }
    private func dispatchSubmission(_ value: LocalSubmission, sessionID: String, client: SessionLinkClient,
                                    command: String, controlGeneration: Int) async {
        await UserSubmission.dispatch(value, request: {
            // Native prompt dispatches extension commands before queueing ordinary input.
            // Direct steer/followUp bypass that dispatch and reject commands while streaming.
            try await client.request("mutate", [
                "command": .string("prompt"),
                "args": .array(value.promptMutationArgs(streamingBehavior: command == "followUp" ? "followUp" : "steer")),
                "controlGeneration": .number(Double(controlGeneration)),
                "submissionId": .string(value.id),
                "expectedOwnerIncarnation": .string(value.ownerIncarnation)
            ], as: LinkOperationAcceptance.self, timeout: .seconds(86400))
        }, update: { id, change in
            updateSubmission(id, sessionID: sessionID, change: change)
        }, reconcile: { operation in
            reconcileSubmission(operation, sessionID: sessionID)
        })
    }

    private func reconcileSubmission(_ operation: LinkOperation, sessionID: String) {
        guard let id = operation.submissionId,
              let value = localSubmissions[sessionID]?.first(where: { $0.id == id }) else { return }
        switch value.receiptEffect(operation) {
        case .none: break
        case .handoff(let handoff):
            let liveSequence = selectedID == sessionID ? lastLiveSequence ?? snapshot?.seq ?? 0
                : attachments[sessionID]?.lastLiveSequence ?? attachments[sessionID]?.snapshot?.seq ?? 0
            let latestQueueSequence = max(liveSequence, queueCuts[sessionID]?.seq ?? 0)
            if handoff.seq > latestQueueSequence {
                queueCuts[sessionID] = QueueCut(seq: handoff.seq,
                    steering: handoff.steering, followUp: handoff.followUp)
            }
            updateSubmission(id, sessionID: sessionID) {
                $0.receivedHandoff(handoff, operationID: operation.operationId)
            }
            // Admission precedes presentation. Keep the bubble until a scoped
            // visual replacement, known handling, or the existing window ends.
            let window = value.presentationWindow
            if handoff.disposition == .handled {
                window?.presentation.retired([id])
                localSubmissions[sessionID]?.removeAll { $0.id == id }
            } else if window?.presentation.retains(id) != true {
                window?.presentation.retired([id])
                localSubmissions[sessionID]?.removeAll { $0.id == id }
            }
        case .failure(let failure):
            updateSubmission(id, sessionID: sessionID) {
                $0.handoff = operation.handoff ?? $0.handoff
                $0.state = .failed(failure, retryable: false)
            }
            if operation.handoff == nil && value.handoff == nil {
                value.presentationWindow?.presentation.retired([id])
            } else if value.presentationWindow?.presentation.retains(id) != true {
                value.presentationWindow?.presentation.retired([id])
                localSubmissions[sessionID]?.removeAll { $0.id == id }
            }
        }
    }

    @discardableResult func mutate(_ command: String, args: [LinkJSON] = [], for sessionID: String) async -> Bool {
        if selectedID == sessionID { return await mutate(command, args: args) }
        guard connected, !busy, occupiedSelection == nil,
              let attachment = attachments[sessionID], let state = windowPresentation(for: sessionID),
              state.controls, let generation = attachment.control?.controlGeneration else { return false }
        busy = true; defer { busy = false }
        let epoch = connectionEpoch
        do {
            _ = try await attachment.client.request("mutate", [
                "command": .string(command), "args": .array(args),
                "controlGeneration": .number(Double(generation))
            ], as: LinkOperationAcceptance.self)
            return connected && epoch == connectionEpoch && attachments[sessionID] === attachment
        } catch {
            if epoch == connectionEpoch { windowErrors[sessionID] = error.localizedDescription }
            return false
        }
    }
    @discardableResult func mutate(_ command: String, args: [LinkJSON] = []) async -> Bool {
        guard canMutate, let client = attachedClient else { return false }
        let generation = control.controlGeneration
        busy = true; defer { busy = false }
        do {
            _ = try await client.request("mutate", ["command": .string(command), "args": .array(args), "controlGeneration": .number(Double(generation))], as: LinkOperationAcceptance.self)
            // Admission is not completion. Canonical operation frames update status independently.
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    /// Child messages use the parent's idempotency ledger. This call is admission,
    /// never an instruction to replay the native child if its receipt was lost.
    func submitChildMessage(_ operation: String, args: [LinkJSON], serviceGeneration: String,
                            submissionID: String, ownerIncarnation: String) async throws -> LinkOperationAcceptance {
        guard let client = attachedClient, snapshot?.sessionId == selectedID else {
            throw LinkFailure("No attached parent session")
        }
        return try await client.request("serviceMutate", [
            "service": .string("subagents"), "operation": .string(operation), "args": .array(args),
            "serviceGeneration": .string(serviceGeneration),
            "controlGeneration": .number(Double(control.controlGeneration)),
            "submissionId": .string(submissionID), "expectedOwnerIncarnation": .string(ownerIncarnation)
        ], as: LinkOperationAcceptance.self, timeout: .seconds(86400))
    }

    func submitChildMessage(_ operation: String, args: [LinkJSON], serviceGeneration: String,
                            submissionID: String, ownerIncarnation: String, for sessionID: String) async throws -> LinkOperationAcceptance {
        if selectedID == sessionID {
            return try await submitChildMessage(operation, args: args, serviceGeneration: serviceGeneration,
                                                submissionID: submissionID, ownerIncarnation: ownerIncarnation)
        }
        guard connected, let attachment = attachments[sessionID], !attachment.failed,
              attachment.snapshot?.sessionId == sessionID,
              let generation = attachment.control?.controlGeneration else {
            throw LinkFailure("No attached parent session")
        }
        return try await attachment.client.request("serviceMutate", [
            "service": .string("subagents"), "operation": .string(operation), "args": .array(args),
            "serviceGeneration": .string(serviceGeneration), "controlGeneration": .number(Double(generation)),
            "submissionId": .string(submissionID), "expectedOwnerIncarnation": .string(ownerIncarnation)
        ], as: LinkOperationAcceptance.self, timeout: .seconds(86400))
    }

    func childObservation(_ id: String) -> LinkChildObservation? { activeAttachment?.childObservations[id] }
    func childObservation(_ id: String, for sessionID: String) -> LinkChildObservation? {
        attachments[sessionID]?.childObservations[id]
    }
    func windowOperations(for sessionID: String) -> [LinkOperation] {
        selectedID == sessionID ? operations : attachments[sessionID]?.operations ?? []
    }
    func activityContext(for sessionID: String?) -> ActivityStore.Context {
        guard let sessionID else { return activityContext }
        let attachment = attachments[sessionID], state = windowPresentation(for: sessionID)
        return .init(connection: attachment?.observationID ?? presentationEpoch,
                     sessionID: state?.snapshot.sessionId, connected: connected && state != nil,
                     canMutate: state?.canMutate ?? false, ownsControl: state?.controls ?? false,
                     control: attachment?.control ?? state?.snapshot.control ?? LinkControl(controllerClientId: nil, controlGeneration: 0),
                     local: remoteOrigin == nil, ownerIncarnation: state?.snapshot.ownerIncarnation,
                     authority: remoteOrigin ?? "local", forgottenProfiles: forgottenProfileEpochs,
                     observationID: attachment?.observationID)
    }
    var activityContext: ActivityStore.Context {
        .init(connection: presentationEpoch, sessionID: snapshot?.sessionId, connected: connected,
              canMutate: canMutate, ownsControl: ownsControl, control: control, local: remoteOrigin == nil,
              ownerIncarnation: snapshot?.ownerIncarnation, authority: remoteOrigin ?? "local",
              forgottenProfiles: forgottenProfileEpochs, observationID: activeAttachment?.observationID)
    }

    func readService(_ service: String, operation: String, args: [LinkJSON] = [], serviceGeneration: String? = nil) async throws -> LinkServiceValue {
        guard connected, let parentID = snapshot?.sessionId, parentID == selectedID, let client = attachedClient else {
            throw LinkFailure("No attached session")
        }
        let epoch = connectionEpoch, presentation = presentationEpoch
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
        case ("subagents", "commandCompletions"):
            value = .commandCompletions(try await client.request("serviceRead", params, as: [LinkCompletionItem]?.self))
        case ("permissions", "snapshot"):
            value = .permissions(try await client.request("serviceRead", params, as: PermissionState.self))
        case ("subagents", "list"):
            value = .children(try await client.request("serviceRead", params, as: [ChildSummary].self))
        case ("background", "list"):
            value = .backgroundTasks(try await client.request("serviceRead", params, as: [LinkBackgroundTask].self))
        default:
            value = .fallback(try await client.request("serviceRead", params, as: LinkJSON.self))
        }
        guard epoch == connectionEpoch, presentation == presentationEpoch,
              attachedClient === client, connected, snapshot?.sessionId == parentID else {
            throw LinkFailure("Session changed while reading activity")
        }
        return value
    }

    func readService(_ service: String, operation: String, args: [LinkJSON] = [],
                     serviceGeneration: String? = nil, for sessionID: String) async throws -> LinkServiceValue {
        if selectedID == sessionID {
            return try await readService(service, operation: operation, args: args, serviceGeneration: serviceGeneration)
        }
        guard connected, let attachment = attachments[sessionID], !attachment.failed,
              attachment.snapshot?.sessionId == sessionID else {
            throw LinkFailure("No attached session")
        }
        let epoch = connectionEpoch, observation = attachment.observationID
        var params: [String: LinkJSON] = ["service": .string(service), "operation": .string(operation), "args": .array(args)]
        if let serviceGeneration { params["serviceGeneration"] = .string(serviceGeneration) }
        let client = attachment.client
        let value: LinkServiceValue
        switch (service, operation) {
        case ("background", "status"):
            value = .backgroundTask(try await client.request("serviceRead", params, as: LinkBackgroundTaskDetail.self))
        case ("subagents", "view"):
            value = .childView(try await client.request("serviceRead", params, as: LinkChildView.self))
        case ("subagents", "inspect"):
            value = .childInspection(try await client.request("serviceRead", params, as: LinkChildInspection.self))
        case ("subagents", "commandCompletions"):
            value = .commandCompletions(try await client.request("serviceRead", params, as: [LinkCompletionItem]?.self))
        case ("permissions", "snapshot"):
            value = .permissions(try await client.request("serviceRead", params, as: PermissionState.self))
        case ("subagents", "list"):
            value = .children(try await client.request("serviceRead", params, as: [ChildSummary].self))
        case ("background", "list"):
            value = .backgroundTasks(try await client.request("serviceRead", params, as: [LinkBackgroundTask].self))
        default:
            value = .fallback(try await client.request("serviceRead", params, as: LinkJSON.self))
        }
        guard connected, epoch == connectionEpoch, attachments[sessionID] === attachment,
              attachment.observationID == observation, !attachment.failed else {
            throw LinkFailure("Session changed while reading activity")
        }
        return value
    }

    func mutateService(_ service: String, operation: String, args: [LinkJSON],
                       serviceGeneration: String, for sessionID: String) async throws -> String {
        if selectedID == sessionID {
            return try await mutateService(service, operation: operation, args: args, serviceGeneration: serviceGeneration)
        }
        guard connected, !busy, occupiedSelection == nil,
              let attachment = attachments[sessionID], !attachment.failed,
              let state = windowPresentation(for: sessionID), state.canMutate,
              let generation = attachment.control?.controlGeneration else {
            throw LinkFailure("This session is read-only or busy")
        }
        busy = true; defer { busy = false }
        let epoch = connectionEpoch, observation = attachment.observationID
        let accepted = try await attachment.client.request("serviceMutate", [
            "service": .string(service), "operation": .string(operation), "args": .array(args),
            "serviceGeneration": .string(serviceGeneration), "controlGeneration": .number(Double(generation))
        ], as: LinkOperationAcceptance.self)
        guard epoch == connectionEpoch, attachments[sessionID] === attachment,
              attachment.observationID == observation, !attachment.failed else {
            throw LinkFailure("Session changed; operation outcome may be uncertain. Not replayed.")
        }
        return accepted.operationId
    }

    func mutateService(_ service: String, operation: String, args: [LinkJSON], serviceGeneration: String) async throws -> String {
        guard canMutate, let client = attachedClient else { throw LinkFailure("This session is read-only or busy") }
        let epoch = connectionEpoch, presentation = presentationEpoch
        let parentID = selectedID
        let generation = control.controlGeneration
        busy = true; defer { busy = false }
        let accepted = try await client.request("serviceMutate", [
            "service": .string(service), "operation": .string(operation), "args": .array(args),
            "serviceGeneration": .string(serviceGeneration), "controlGeneration": .number(Double(generation))
        ], as: LinkOperationAcceptance.self)
        guard epoch == connectionEpoch, presentation == presentationEpoch,
              attachedClient === client, selectedID == parentID else {
            throw LinkFailure("Session changed; operation outcome may be uncertain. Not replayed.")
        }
        return accepted.operationId
    }

    @discardableResult func answer(_ request: LinkInteraction, value: LinkJSON, for sessionID: String) async -> Bool {
        if selectedID == sessionID { return await answer(request, value: value) }
        guard request.kind != "custom", !busy, let attachment = attachments[sessionID],
              let state = windowPresentation(for: sessionID), state.canMutate,
              let generation = attachment.control?.controlGeneration,
              !attachment.acknowledged.contains(request.id),
              attachment.interactions.contains(where: { $0.id == request.id && $0.kind == request.kind }) else { return false }
        busy = true; defer { busy = false }
        let epoch = connectionEpoch
        do {
            _ = try await attachment.client.request("answer", [
                "requestId": .string(request.id), "value": value,
                "controlGeneration": .number(Double(generation))
            ], as: LinkAcknowledgment.self)
            guard epoch == connectionEpoch, attachments[sessionID] === attachment else { return false }
            if attachment.interactions.contains(where: { $0.id == request.id }) {
                attachment.acknowledged.insert(request.id)
                objectWillChange.send()
            }
            return true
        } catch {
            if epoch == connectionEpoch { windowErrors[sessionID] = error.localizedDescription }
            return false
        }
    }
    @discardableResult func answer(_ request: LinkInteraction, value: LinkJSON) async -> Bool {
        guard canMutate, request.kind != "custom",
              !acknowledgedInteractionIDs.contains(request.id),
              interactions.contains(where: { $0.id == request.id && $0.kind == request.kind }) else { return false }
        let epoch = connectionEpoch, presentation = presentationEpoch
        let sessionID = selectedID
        let accepted = await perform("answer", ["requestId": .string(request.id), "value": value, "controlGeneration": .number(Double(control.controlGeneration))])
        guard epoch == connectionEpoch, presentation == presentationEpoch,
              selectedID == sessionID, snapshot?.sessionId == sessionID else { return false }
        if accepted, interactions.contains(where: { $0.id == request.id }) {
            acknowledgedInteractionIDs.insert(request.id)
        }
        return accepted
    }
    private func cancelPartialPublication() {
        partialPublicationTask?.cancel(); partialPublicationTask = nil
        lastTranscriptPublication = nil; lastPublishedSequence = nil
    }
    private func publishTranscriptImmediately(displayOnly: Bool = false) {
        cancelPartialPublication()
        lastTranscriptPublication = .now; lastPublishedSequence = sequence
        if displayOnly, let id = snapshot?.sessionId {
            partialTranscriptPublications.send(id)
        } else { objectWillChange.send() }
    }
    private func transcriptWillChange() {
        guard coalescingPartialPublication else { publishTranscriptImmediately(); return }
        // live and its projection change in one synchronous canonical apply.
        if lastPublishedSequence == sequence { return }
        if let lastTranscriptPublication,
           ContinuousClock.now < lastTranscriptPublication + .milliseconds(50) {
            if partialPublicationTask == nil {
                let deadline = lastTranscriptPublication + .milliseconds(50)
                let connection = connectionEpoch, presentation = presentationEpoch
                partialPublicationTask = Task { [weak self] in
                    do { try await Task.sleep(until: deadline, clock: .continuous) }
                    catch { return }
                    guard !Task.isCancelled, let self,
                          self.connectionEpoch == connection, self.presentationEpoch == presentation else { return }
                    // No captured model: publish the latest already-applied canonical
                    // state. Ordinary immediate changes still notify before mutation.
                    self.publishTranscriptImmediately(displayOnly: true)
                }
            }
        } else { publishTranscriptImmediately(displayOnly: true) }
    }
    private func flushPartialPublication() {
        if partialPublicationTask != nil { publishTranscriptImmediately() }
    }

    func apply(_ frame: LinkIncomingFrame) throws {
        defer { coalescingPartialPublication = false }
        invalidateSettlement(for: frame)
        let type = frame.type
        let experimental = UserDefaults.standard.bool(forKey: "experimentalNativeTranscript")
        if case .sessionActivity(let activity) = frame.payload { try receiveSessionActivity(activity); return }
        var projectionChanged = false
        var committedChanged = false
        var partialChanged = false
        if case .snapshot(let incoming) = frame.payload {
            guard incoming.header != nil else { throw LinkFailure("Native session header missing") }
            cancelPartialPublication()
            presentationEpoch = UUID()
            acknowledgedInteractionIDs.removeAll()
            snapshot = incoming; selectedID = incoming.sessionId; sequence = incoming.seq
            sessionActivity.viewed(incoming.sessionId)
            records = incoming.entries; recordKeys = incoming.immutable?.entryKeys ?? []
            incrementalProjection = activeAttachment?.incremental
            toolPresentation = activeAttachment?.toolPresentation ?? SessionMessage.ToolExecutionProjection()
            committedProjection = nil
            live = incoming.live
            observeSubagentDisplayNames(incoming.live, sessionID: incoming.sessionId)
            workingMessage = incoming.uiState?.first(where: { $0.method == "setWorkingMessage" })?.workingMessage
            statusFooterData = incoming.uiState?.first(where: { $0.method == "ownedFooter" })?.statusFooter
            leafID = incoming.leafId; control = incoming.control
            interactions = incoming.pendingRequests; operations = incoming.operations
            observedBusy = incoming.live.isNotificationBusy || !incoming.pendingRequests.isEmpty
            lastLiveSequence = nil
            projectionChanged = true
            committedChanged = true
        } else {
            guard frame.sessionId == snapshot?.sessionId else { return }
            guard frame.seq == sequence + 1 else { throw LinkFailure("Session updates were interrupted. Reconnect to refresh the conversation.") }
            sequence += 1
            // Native events/child receipts remain ordered and unthrottled below.
            // A structural or interactive frame cannot sit behind the display clock.
            switch frame.payload {
            // Child notifications accompany native child frames on every delta;
            // they are not parent transcript or authority boundaries.
            case .live, .event, .childFrame, .childEvent, .backgroundEvent: break
            // The owner repeats the current leaf before every streaming delta.
            // It is not a branch change and must not defeat the display deadline.
            case .leaf(let incomingLeaf) where incomingLeaf == leafID: break
            case .ui(let action) where
                (action.method != "setWorkingMessage" || action.workingMessage == workingMessage) &&
                (action.method != "ownedFooter" || action.statusFooter == statusFooterData): break
            default: flushPartialPublication()
            }
            switch frame.payload {
            case .append(let entry):
                records.append(entry)
                if let key = frame.entryKey { recordKeys.append(key) }
                projectionChanged = true
                // The projector indexes the record already retained above. Active-ID
                // replacements/missing ancestors rebuild; unrelated records still survive.
                committedChanged = experimental
                    ? incrementalProjection?.appended(entry, records: records) ?? true
                    : true
            case .leaf(let incomingLeaf):
                committedChanged = incomingLeaf != leafID
                if committedChanged { leafID = incomingLeaf }
                projectionChanged = true
            case .live(let incomingLive):
                committedChanged = incomingLive.leafId != leafID
                if committedChanged { leafID = incomingLive.leafId }
                coalescingPartialPublication = experimental && interactions.isEmpty
                    && live.map { incomingLive.isStreamingPartialUpdate(from: $0) } == true
                let activityOnly = live.map { incomingLive.isActivityServiceOnlyUpdate(from: $0) } == true
                if !coalescingPartialPublication && !activityOnly { flushPartialPublication() }
                partialChanged = incomingLive.partial != live?.partial || incomingLive.toolExecutions != live?.toolExecutions
                if live != incomingLive { live = incomingLive }
                if let sessionID = snapshot?.sessionId { observeSubagentDisplayNames(incomingLive, sessionID: sessionID) }
                lastLiveSequence = sequence
                if live?.isNotificationBusy == true { observedBusy = true }
                projectionChanged = true
            case .ui(let action):
                if action.method == "setWorkingMessage", workingMessage != action.workingMessage {
                    workingMessage = action.workingMessage
                }
                if action.method == "ownedFooter", statusFooterData != action.statusFooter {
                    statusFooterData = action.statusFooter
                }
            case .event(let event):
                if event.type == "agent_settled" { flushPartialPublication() }
                if event.type == "agent_start" { observedBusy = true }
                if event.type == "agent_settled", connected, observedBusy,
                   lastLiveSequence == sequence - 1, live?.isNotificationIdle == true,
                   interactions.isEmpty, let sessionID = snapshot?.sessionId {
                    observedBusy = false
                    publishSettlement(sessionID: sessionID, sequence: sequence,
                        title: live?.sessionName ?? sessions.first(where: { $0.id == sessionID })?.name ?? "Pi")
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
            if experimental {
                if incrementalProjection == nil {
                    incrementalProjection = SessionMessage.IncrementalProjection(records: records, leafID: leafID)
                    committedChanged = true
                } else if committedChanged {
                    incrementalProjection?.moveLeaf(leafID, records: records)
                }
                if let projection = incrementalProjection {
                    if committedChanged {
                        let previous = toolPresentation.base ?? messages.committed, next = projection.content
                        if type != "snapshot", next.changes(since: previous) != nil {
                            // Incremental replacements only fill existing tool-result
                            // slots; they cannot alter the text-only sidebar preview.
                            if next.messages.count > previous.messages.count {
                                committedSidebarPreview = SessionSidebarSummary.latestMessage(in: next.messages[previous.messages.count...])
                                    ?? committedSidebarPreview
                            }
                        } else {
                            committedSidebarPreview = SessionSidebarSummary.latestMessage(in: next.messages)
                        }
                        partialChanged = true
                    }
                    if partialChanged { messages = projection.observing(live?.partial, sessionID: snapshot.sessionId, executions: live?.toolExecutions ?? [], presentation: toolPresentation) }
                }
                committedProjection = nil
            } else {
                incrementalProjection = nil
                // Flag-off keeps the original complete projection policy.
                if committedChanged || committedProjection == nil {
                    committedProjection = SessionMessage.projectCommitted(records: records, leafID: leafID)
                    committedSidebarPreview = committedProjection.flatMap { SessionSidebarSummary.latestMessage(in: $0.messages) }
                    partialChanged = true
                }
                if partialChanged, let committedProjection {
                    messages = committedProjection.observing(live?.partial, sessionID: snapshot.sessionId, executions: live?.toolExecutions ?? [], presentation: toolPresentation)
                }
            }
            // Metadata can change even when the branch and partial are unchanged.
            updateSidebarSummary(frameType: type)
        }
        finishAttachmentWaiters()
        activityFrames.send(frame)
        if let id = frame.sessionId { pinnedActivityFrames[id]?.send(frame) }
    }
}
#endif
