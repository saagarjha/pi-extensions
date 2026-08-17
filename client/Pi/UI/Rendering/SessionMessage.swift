import Foundation

/// A display-only projection of daemon-owned native history.
nonisolated struct SessionMessage: Identifiable, Sendable, Equatable {
    nonisolated enum Part: Sendable, Equatable {
        case text(String)
        case thinking(String)
        case toolCall(ToolCall, result: NativeMessage?)

        var text: String {
            switch self {
            case .text(let text), .thinking(let text): text
            case .toolCall(let call, _): "Tool: \(call.name) (\(call.id))"
            }
        }
    }

    let id: String
    let author: String
    let isUser: Bool
    let isAssistant: Bool
    var parts: [Part]
    var text: String { parts.map(\.text).joined(separator: "\n\n") }

    init(id: String, author: String, text: String, isUser: Bool,
         isAssistant: Bool = false, parts: [Part]? = nil) {
        self.id = id
        self.author = author
        self.isUser = isUser
        self.isAssistant = isAssistant
        self.parts = parts ?? [.text(text)]
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
        let messages: [SessionMessage]
        fileprivate let responses: Set<ResponseIdentity>
        /// Traversed IDs, including the first missing ancestor. These are display-cache
        /// dependencies, not a second history. Nil keeps the original rebuild policy.
        fileprivate let dependencies: Set<String>?

        fileprivate init(messages: [SessionMessage], responses: Set<ResponseIdentity>, dependencies: Set<String>?) {
            self.messages = messages
            self.responses = responses
            self.dependencies = dependencies
        }

        func isAffected(byAppending record: NativeRecord) -> Bool {
            record.type != "session" && (dependencies?.contains(record.id) != false)
        }

        private func projectPartial(_ partial: NativeMessage?, sessionID: String) -> SessionMessage? {
            guard let partial else { return nil }
            if let responseID = partial.responseId,
               responses.contains(ResponseIdentity(id: responseID, provider: partial.provider, role: partial.role)) {
                return nil
            }
            let message = SessionMessage.projectMessage(partial, id: "partial:\(sessionID):\(partial.responseId ?? "current")")
            return SessionMessage(
                id: message.id, author: message.author + " (live observation)", text: "",
                isUser: message.isUser, isAssistant: message.isAssistant, parts: message.parts
            )
        }

        func observing(_ partial: NativeMessage?, sessionID: String) -> Transcript {
            Transcript(committed: self, partial: projectPartial(partial, sessionID: sessionID))
        }

        /// Array adapter for existing cache/child-history callers, not the live root path.
        func appending(_ partial: NativeMessage?, sessionID: String) -> [SessionMessage] {
            guard let message = projectPartial(partial, sessionID: sessionID) else { return messages }
            return messages + [message]
        }
    }

    /// A shared immutable committed prefix plus one independent live observation. Indexed
    /// access/iteration never flatten the prefix. Equality is snapshot identity + tail value:
    /// a rebuilt snapshot is a new input even if its IDs/text happen to match the previous one.
    nonisolated struct Transcript: RandomAccessCollection, Sendable, Equatable, ExpressibleByArrayLiteral {
        let committed: CommittedProjection
        let partial: SessionMessage?

        fileprivate init(committed: CommittedProjection, partial: SessionMessage?) {
            self.committed = committed
            self.partial = partial
        }
        init(_ messages: [SessionMessage] = []) {
            committed = CommittedProjection(messages: messages, responses: [], dependencies: nil)
            partial = nil
        }
        init(arrayLiteral elements: SessionMessage...) { self.init(elements) }
        var startIndex: Int { 0 }
        var endIndex: Int { committed.messages.count + (partial == nil ? 0 : 1) }
        func index(after i: Int) -> Int { i + 1 }
        func index(before i: Int) -> Int { i - 1 }
        subscript(index: Int) -> SessionMessage {
            precondition(index >= startIndex && index < endIndex)
            return index < committed.messages.count ? committed.messages[index] : partial!
        }
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.committed === rhs.committed && lhs.partial == rhs.partial
        }
    }

    fileprivate struct ResponseIdentity: Hashable, Sendable {
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
        return projectBranch(branch, dependencies: nil)
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
        return projectBranch(branch.reversed().lazy.map { records[$0] }, dependencies: visited)
    }

    private static func projectBranch<Branch: Collection>(_ branch: Branch, dependencies: Set<String>?) -> CommittedProjection
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
        return CommittedProjection(messages: result, responses: responses, dependencies: dependencies)
    }

    private static func projectMessage(_ message: NativeMessage, id: String) -> SessionMessage {
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
                              isAssistant: role == "assistant", parts: parts)
    }

    private static func render(_ content: NativeMessageContent) -> [Part] {
        switch content {
        case .text(let text): return [.text(text)]
        case .blocks(let blocks): return blocks.map { block in
            switch block {
            case .text(let value): return .text(value.text)
            case .thinking(let value):
                return .thinking(value.redacted == true ? "[Redacted thinking]" : value.thinking)
            case .image(let value): return .text("[Image: \(value.mimeType)]")
            case .toolCall(let value): return .toolCall(value, result: nil)
            case .unsupported(let type): return .text("[Unsupported content: \(type)]")
            }
        }
        }
    }
}
