import Foundation

/// A display-only projection of daemon-owned native history.
nonisolated struct SessionMessage: Identifiable, Sendable, Equatable {
    nonisolated enum Part: Sendable, Equatable {
        case text(String)
        case thinking(String)
        case image(ImageContent)
        case toolCall(ToolCall, result: NativeMessage?)

        /// Presentation only: empty provider start events must not reserve space.
        /// Keep the original part and its index in the authoritative projection.
        var hasVisibleContent: Bool {
            switch self {
            case .text(let text), .thinking(let text): text.contains { !$0.isWhitespace }
            case .toolCall, .image: true
            }
        }

        var text: String {
            switch self {
            case .text(let text), .thinking(let text): text
            case .toolCall(let call, _): "Tool: \(call.name) (\(call.id))"
            case .image(let image): "[Image: \(image.mimeType)]"
            }
        }
    }

    let id: String
    let author: String
    let isUser: Bool
    let isAssistant: Bool
    /// Display-state continuity only; never a replacement for canonical entry identity.
    let responseIdentity: ResponseIdentity?
    /// A change invalidates live display state; equality is NOT an observation identity.
    let observationHint: ObservationHint?
    var parts: [Part]
    /// Transient native execution observations keyed by the paired part, never history.
    var toolExecutions: [Int: LinkToolExecution] = [:]
    enum SubmissionState: Sendable, Equatable { case sending, accepted, failed(String, retryable: Bool) }
    var localSubmission: SubmissionState? = nil
    var submissionMode: UserSubmission.Mode? = nil
    var submissionWindow: UserMessagePresentation.Window? = nil
    /// Raw queue projection, not queue-item identity. Empty image-only input is
    /// different from the literal display text "Image queued".
    struct QueuePresentation: Sendable, Equatable {
        let text: String
        let mode: UserSubmission.Mode
        let seq: Int
    }
    var queuePresentation: QueuePresentation? = nil
    var submissionQueueCut: Int? = nil
    var text: String { parts.map(\.text).joined(separator: "\n\n") }
    var isEmptyAssistantPlaceholder: Bool { isAssistant && !parts.contains(where: \.hasVisibleContent) }

    init(id: String, author: String, text: String, isUser: Bool,
         isAssistant: Bool = false, parts: [Part]? = nil, responseIdentity: ResponseIdentity? = nil,
         observationHint: ObservationHint? = nil) {
        self.id = id
        self.author = author
        self.isUser = isUser
        self.isAssistant = isAssistant
        self.responseIdentity = responseIdentity
        self.observationHint = observationHint
        self.parts = parts ?? [.text(text)]
    }

    static func queued(id: String, text: String, mode: UserSubmission.Mode, seq: Int) -> Self {
        var message = Self(id: id, author: mode.author, text: text.isEmpty ? "Image queued" : text, isUser: true)
        message.queuePresentation = QueuePresentation(text: text, mode: mode, seq: seq)
        return message
    }

    /// Adapter retained for paged-history/cache integration; the live store uses the native overload.
    static func project(snapshot: Snapshot, records: [NativeRecord] = []) -> [SessionMessage] {
        let current = snapshot.current
        let allRecords = records + snapshot.observations.map(\.record)
        let liveLeaf: String?
        if let root = current.root { liveLeaf = root.leafId }
        else if current.child != nil { liveLeaf = current.leafId }
        else { liveLeaf = current.leafId ?? allRecords.last(where: { $0.type != "session" })?.id }
        return project(sessionID: snapshot.descriptor.id,
                       records: allRecords,
                       leafID: liveLeaf,
                       partial: current.root != nil ? current.root?.partial?.message : current.partial)
    }

    /// Immutable derived display values for one committed branch. Identity belongs to this
    /// snapshot, never a native entry ID: rebuilds/restores get a new snapshot instance.
    nonisolated final class CommittedProjection: Sendable {
        let content: CommittedContent
        var messages: MessageList { content.messages }
        let responses: Set<ResponseIdentity>
        let pendingCalls: [String: [(message: Int, part: Int)]]
        let complete: Bool
        /// Traversed IDs, including the first missing ancestor. These are display-cache
        /// dependencies, not a second history. Nil keeps the original rebuild policy.
        let dependencies: Set<String>?

        fileprivate init(messages: [SessionMessage], responses: Set<ResponseIdentity>, dependencies: Set<String>?,
                     pendingCalls: [String: [(message: Int, part: Int)]], complete: Bool) {
            content = CommittedContent(messages)
            self.responses = responses; self.dependencies = dependencies
            self.pendingCalls = pendingCalls; self.complete = complete
        }

        func isAffected(byAppending record: NativeRecord) -> Bool {
            record.type != "session" && (dependencies?.contains(record.id) != false)
        }

        func observing(_ partial: NativeMessage?, sessionID: String, executions: [LinkToolExecution] = [], presentation: ToolExecutionProjection? = nil) -> Transcript {
            let tail = SessionMessage.projectPartial(partial, sessionID: sessionID, responses: responses)
            return presentation?.observing(content, partial: tail, pendingCalls: pendingCalls, executions: executions)
                ?? Transcript(committed: content, partial: tail)
        }

        /// Array adapter for existing cache/child-history callers, not the live root path.
        func appending(_ partial: NativeMessage?, sessionID: String) -> [SessionMessage] {
            guard let message = SessionMessage.projectPartial(partial, sessionID: sessionID, responses: responses) else { return Array(messages) }
            return Array(messages) + [message]
        }
    }

    static func projectPartial(_ partial: NativeMessage?, sessionID: String, responses: Set<ResponseIdentity>) -> SessionMessage? {
        guard let partial else { return nil }
        if let responseID = partial.responseId,
           responses.contains(ResponseIdentity(id: responseID, provider: partial.provider, role: partial.role)) {
            return nil
        }
        let message = projectMessage(partial, id: "partial:\(sessionID):\(partial.responseId ?? "current")")
        return SessionMessage(id: message.id, author: message.author, text: "",
                              isUser: message.isUser, isAssistant: message.isAssistant, parts: message.parts,
                              responseIdentity: message.responseIdentity,
                              observationHint: ObservationHint(timestamp: partial.timestamp, provider: partial.provider, role: partial.role))
    }

    /// An immutable COW display prefix plus one independent assistant observation.
    /// The prefix may carry transient tool overlays; canonical records/projections stay
    /// separate and unchanged. Indexed access never flattens it. Equality is identity + tail:
    /// a rebuilt snapshot is a new input even if its IDs/text happen to match the previous one.
    nonisolated struct Transcript: RandomAccessCollection, Sendable, Equatable, ExpressibleByArrayLiteral {
        let committed: CommittedContent
        let partial: SessionMessage?
        var pending: [SessionMessage] = []
        /// Initial prompts share the live/saved side of the working indicator.
        /// Only queued inputs belong after it. Compose keeps these groups contiguous.
        var pendingPromptCount: Int { pending.prefix { $0.submissionMode == .prompt }.count }

        init(committed: CommittedContent, partial: SessionMessage?, pending: [SessionMessage] = []) {
            self.committed = committed
            self.partial = partial
            self.pending = pending
        }
        init(_ messages: [SessionMessage] = []) {
            committed = CommittedContent(messages)
            partial = nil
        }
        init(arrayLiteral elements: SessionMessage...) { self.init(elements) }
        var startIndex: Int { 0 }
        var endIndex: Int { committed.messages.count + (partial == nil ? 0 : 1) + pending.count }
        func index(after i: Int) -> Int { i + 1 }
        func index(before i: Int) -> Int { i - 1 }
        subscript(index: Int) -> SessionMessage {
            precondition(index >= startIndex && index < endIndex)
            if index < committed.messages.count { return committed.messages[index] }
            let tail = index - committed.messages.count
            if tail == 0, let partial { return partial }
            return pending[tail - (partial == nil ? 0 : 1)]
        }
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.committed === rhs.committed && lhs.partial == rhs.partial && lhs.pending == rhs.pending
        }
    }

    struct ObservationHint: Equatable, Sendable {
        let timestamp: Double?
        let provider: String?
        let role: String?
    }

    struct ResponseIdentity: Hashable, Sendable {
        let id: String
        let provider: String?
        let role: String?
    }

    /// Native daemon replica projection. Null leaf means an empty branch, never the last entry.
    static func project(sessionID: String, records: [NativeRecord], leafID: String?, partial: NativeMessage?) -> [SessionMessage] {
        projectCommitted(records: records, leafID: leafID).appending(partial, sessionID: sessionID)
    }

    static func projectCommitted(records: [NativeRecord], leafID: String?) -> CommittedProjection {
        var entries: [String: NativeRecord] = [:]
        for record in records where record.type != "session" { entries[record.id] = record }
        var cursor = leafID
        var visited = Set<String>()
        var branch: [NativeRecord] = []
        while let id = cursor, visited.insert(id).inserted, let entry = entries[id] {
            branch.append(entry)
            cursor = entry.parentId
        }
        // Missing ancestors terminate the known segment; never splice other branches.
        branch.reverse()
        return projectBranch(branch, dependencies: nil, complete: cursor == nil)
    }

    /// Experimental store path: traverse indices into the authoritative records instead
    /// of copying large NativeRecord values into both a dictionary and a branch array.
    static func projectCommittedIndexed(records: [NativeRecord], leafID: String?) -> CommittedProjection {
        var entries: [String: Int] = [:]
        entries.reserveCapacity(records.count)
        for index in records.indices where records[index].type != "session" {
            entries[records[index].id] = index // Preserve the original last-duplicate-ID rule.
        }
        var cursor = leafID
        var visited = Set<String>()
        var branch: [Int] = []
        while let id = cursor, visited.insert(id).inserted, let index = entries[id] {
            branch.append(index)
            cursor = records[index].parentId
        }
        return projectBranch(branch.reversed().lazy.map { records[$0] }, dependencies: visited, complete: cursor == nil)
    }

    private static func projectBranch<Branch: Collection>(_ branch: Branch, dependencies: Set<String>?, complete: Bool) -> CommittedProjection
        where Branch.Element == NativeRecord {
        var result: [SessionMessage] = []
        var pendingCalls: [String: [(message: Int, part: Int)]] = [:]
        for entry in branch {
            let projected: SessionMessage
            switch entry.type {
            case "message":
                guard let message = entry.message else { continue }
                // Pair with the nearest preceding unresolved occurrence, never a later
                // call or another branch. Reused IDs cannot replace an earlier result.
                if message.role == "toolResult", let callID = message.toolCallId,
                   let location = pendingCalls[callID]?.popLast(),
                   case .toolCall(let call, _) = result[location.message].parts[location.part] {
                    result[location.message].parts[location.part] = .toolCall(call, result: message)
                    continue
                }
                projected = projectMessage(message, id: entry.id)
            case "custom_message":
                projected = SessionMessage(
                    id: entry.id, author: entry.customType ?? "Custom", text: "", isUser: false,
                    parts: entry.content.map(render) ?? [.text("[Custom message content unavailable]")]
                )
            default:
                continue
            }
            for (index, part) in projected.parts.enumerated() {
                if case .toolCall(let call, _) = part {
                    pendingCalls[call.id, default: []].append((result.count, index))
                }
            }
            result.append(projected)
        }

        // SDK partials have no entry ID. Only a response ID on this branch with
        // the same provider and role suppresses the live observation.
        let responses = Set(branch.compactMap { entry -> ResponseIdentity? in
            guard let message = entry.message, let id = message.responseId else { return nil }
            return ResponseIdentity(id: id, provider: message.provider, role: message.role)
        })
        return CommittedProjection(messages: result, responses: responses, dependencies: dependencies,
                                   pendingCalls: pendingCalls, complete: complete)
    }

    static func projectMessage(_ message: NativeMessage, id: String) -> SessionMessage {
        let role = message.role ?? "unknown"
        // Only the subagent harness's structured provenance can relabel a user-role
        // message. Text that merely resembles an origin tag is not authoritative.
        let provenance = role == "user" ? message.extensionFields["subagentMessage"] : nil
        let origin = provenance?["id"]?.string != nil ? provenance?["origin"]?.string : nil
        let author: String
        switch role {
        case "user":
            switch origin {
            case "parent": author = "Parent"
            case "extension": author = "Extension"
            default: author = "You"
            }
        case "assistant": author = "Assistant"
        case "toolResult": author = message.toolName.map { "Tool: " + $0 } ?? "Tool"
        case "custom": author = message.customType ?? "Custom"
        default: author = role
        }
        var parts: [Part]
        if let content = message.content {
            parts = render(content)
        } else if role == "bashExecution" {
            parts = [.text([message.command.map { "$ " + $0 }, message.output].compactMap { $0 }.joined(separator: "\n"))]
        } else if let summary = message.summary {
            parts = [.text(summary)]
        } else if let omitted = message.omitted {
            parts = [.text("[Message omitted: \(omitted.reason)]")]
        } else {
            parts = [.text("[\(role) message content unavailable]")]
        }
        // The origin header must remain in daemon/model history, but not in the
        // bubble. Remove only the exact header the harness says it prepended.
        if role == "user", let origin, ["parent", "user", "extension"].contains(origin),
           provenance?["labelled"] == .bool(true),
           let content = message.content, case .blocks(let blocks) = content,
           let first = blocks.first, case .text(let header) = first,
           header.text == "[Subagent message origin=\(origin)]\n", !parts.isEmpty {
            parts.removeFirst()
        }
        if let error = message.errorMessage, !error.isEmpty {
            parts.append(.text(error))
        }
        return SessionMessage(id: id, author: author, text: "", isUser: role == "user",
                              isAssistant: role == "assistant", parts: parts,
                              responseIdentity: message.responseId.map {
                                  ResponseIdentity(id: $0, provider: message.provider, role: message.role)
                              }, observationHint: role == "user"
                                  ? ObservationHint(timestamp: message.timestamp, provider: message.provider, role: message.role)
                                  : nil)
    }

    static func render(_ content: NativeMessageContent) -> [Part] {
        switch content {
        case .text(let text): return [.text(text)]
        case .blocks(let blocks): return blocks.map { block in
            switch block {
            case .text(let value): return .text(value.text)
            case .thinking(let value):
                return .thinking(value.presentationText)
            case .image(let value): return .image(value)
            case .toolCall(let value): return .toolCall(value, result: nil)
            case .unsupported(let type): return .text("[Unsupported content: \(type)]")
            }
        }
        }
    }
}
