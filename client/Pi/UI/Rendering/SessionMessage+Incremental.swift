import Foundation

extension SessionMessage {
    /// Immutable 32-way paged vector. Append/replacement copies only one bounded
    /// page per tree level; snapshots share nodes, never retain older snapshots.
    nonisolated struct MessageList: RandomAccessCollection, Sendable {
        private final class Node: Sendable {
            let values: [SessionMessage]
            let children: [Node]
            init(values: [SessionMessage] = [], children: [Node] = []) {
                self.values = values; self.children = children
            }
            func setting(_ index: Int, height: Int, value: SessionMessage) -> Node {
                if height == 0 {
                    var next = values
                    if index & 31 == next.count { next.append(value) }
                    else { next[index & 31] = value }
                    return Node(values: next)
                }
                let slot = (index >> (height * 5)) & 31
                var next = children
                if slot == next.count { next.append(Node().setting(index, height: height - 1, value: value)) }
                else { next[slot] = next[slot].setting(index, height: height - 1, value: value) }
                return Node(children: next)
            }
        }
        private let root: Node
        private let height: Int
        let endIndex: Int
        var startIndex: Int { 0 }
        init(_ values: [SessionMessage] = []) {
            var level = stride(from: 0, to: values.count, by: 32).map {
                Node(values: Array(values[$0..<min($0 + 32, values.count)]))
            }
            var height = 0
            while level.count > 1 {
                level = stride(from: 0, to: level.count, by: 32).map {
                    Node(children: Array(level[$0..<min($0 + 32, level.count)]))
                }
                height += 1
            }
            root = level.first ?? Node(); self.height = height; endIndex = values.count
        }
        private init(root: Node, height: Int, count: Int) {
            self.root = root; self.height = height; endIndex = count
        }
        func index(after i: Int) -> Int { i + 1 }
        func index(before i: Int) -> Int { i - 1 }
        subscript(index: Int) -> SessionMessage {
            precondition(index >= 0 && index < endIndex)
            var node = root
            if height > 0 {
                for level in stride(from: height, through: 1, by: -1) {
                    node = node.children[(index >> (level * 5)) & 31]
                }
            }
            return node.values[index & 31]
        }
        func appending(_ value: SessionMessage) -> Self {
            var root = root, height = height
            if endIndex >> ((height + 1) * 5) > 0 {
                root = Node(children: [root]); height += 1
            }
            return Self(root: root.setting(endIndex, height: height, value: value), height: height, count: endIndex + 1)
        }
        func replacing(at index: Int, with value: SessionMessage) -> Self {
            precondition(index >= 0 && index < endIndex)
            return Self(root: root.setting(index, height: height, value: value), height: height, count: endIndex)
        }
    }

    nonisolated final class CommittedContent: Sendable {
        struct Change: Sendable {
            let revision: UInt64
            let previousCount: Int
            let index: Int
        }
        let messages: MessageList
        private let epoch: UUID
        private let revision: UInt64
        private let recent: [Change]
        init(_ messages: [SessionMessage]) {
            self.messages = MessageList(messages); epoch = UUID(); revision = 0; recent = []
        }
        private init(messages: MessageList, epoch: UUID, revision: UInt64, recent: [Change]) {
            self.messages = messages; self.epoch = epoch; self.revision = revision; self.recent = recent
        }
        fileprivate func updating(_ messages: MessageList, index: Int) -> CommittedContent {
            precondition(revision < .max)
            var changes = Array(recent.suffix(31))
            changes.append(Change(revision: revision + 1, previousCount: self.messages.count, index: index))
            return CommittedContent(messages: messages, epoch: epoch, revision: revision + 1, recent: changes)
        }
        /// Bounded numeric receipts, not a chain of old snapshots. A lag beyond the
        /// window or a different authoritative epoch explicitly requests full fallback.
        func changes(since previous: CommittedContent) -> [Int]? {
            if self === previous { return [] }
            guard epoch == previous.epoch, revision > previous.revision,
                  revision - previous.revision <= UInt64(recent.count) else { return nil }
            let changes = recent.suffix(Int(revision - previous.revision))
            guard changes.first?.revision == previous.revision + 1,
                  changes.first?.previousCount == previous.messages.count else { return nil }
            return Array(Set(changes.map(\.index))).sorted()
        }
    }

    /// Mutable bookkeeping stays with the replica owner; published content contains
    /// only immutable vector nodes and bounded receipts, never these mutable sets/maps.
    nonisolated final class IncrementalProjection {
        private(set) var content: CommittedContent
        private var responses: Set<ResponseIdentity> = []
        private var dependencies: Set<String> = []
        private var pendingCalls: [String: [(message: Int, part: Int)]] = [:]
        private var indices: [String: Int] = [:]
        private var recordCount = 0
        private var leaf: String?
        private var complete = false
        private var candidate: String?

        init(records: [NativeRecord], leafID: String?) {
            content = CommittedContent([]); leaf = leafID
            resetIndex(records)
            rebuild(records)
        }
        private func resetIndex(_ records: [NativeRecord]) {
            indices.removeAll(keepingCapacity: true)
            for index in records.indices where records[index].type != "session" { indices[records[index].id] = index }
            recordCount = records.count
        }
        private func rebuild(_ records: [NativeRecord]) {
            let full = SessionMessage.projectCommittedIndexed(records: records, leafID: leaf)
            content = full.content; responses = full.responses; dependencies = full.dependencies ?? []
            pendingCalls = full.pendingCalls.filter { !$0.value.isEmpty }; complete = full.complete
            candidate = nil
        }
        /// Called after the authoritative record was retained. Duplicate active IDs and
        /// newly supplied missing ancestors rebuild immediately, even before a leaf frame.
        func appended(_ entry: NativeRecord, records: [NativeRecord]) -> Bool {
            guard records.count == recordCount + 1 else {
                resetIndex(records); rebuild(records); return true
            }
            recordCount = records.count
            candidate = nil
            guard entry.type != "session" else { return false }
            let unique = indices.updateValue(records.count - 1, forKey: entry.id) == nil
            if dependencies.contains(entry.id) { rebuild(records); return true }
            if unique, complete, entry.parentId == leaf,
               entry.type == "message" || entry.type == "custom_message" { candidate = entry.id }
            return false
        }
        func moveLeaf(_ id: String?, records: [NativeRecord]) {
            guard id != leaf else { return }
            if let id, candidate == id, complete, let index = indices[id],
               index == records.count - 1, records.count == recordCount,
               records[index].parentId == leaf {
                extend(records[index]); leaf = id; dependencies.insert(id); candidate = nil
            } else {
                leaf = id
                if records.count != recordCount { resetIndex(records) }
                rebuild(records)
            }
        }
        private func extend(_ entry: NativeRecord) {
            if let message = entry.message, let id = message.responseId {
                responses.insert(ResponseIdentity(id: id, provider: message.provider, role: message.role))
            }
            var messages = content.messages
            let projected: SessionMessage
            if entry.type == "message" {
                guard let message = entry.message else { return }
                if message.role == "toolResult", let callID = message.toolCallId,
                   let location = pendingCalls[callID]?.popLast(),
                   case .toolCall(let call, _) = messages[location.message].parts[location.part] {
                    if pendingCalls[callID]?.isEmpty == true { pendingCalls.removeValue(forKey: callID) }
                    var changed = messages[location.message]
                    changed.parts[location.part] = .toolCall(call, result: message)
                    messages = messages.replacing(at: location.message, with: changed)
                    content = content.updating(messages, index: location.message)
                    return
                }
                projected = SessionMessage.projectMessage(message, id: entry.id)
            } else {
                projected = SessionMessage(id: entry.id, author: entry.customType ?? "Custom", text: "", isUser: false,
                                           parts: entry.content.map(SessionMessage.render) ?? [.text("[Custom message content unavailable]")])
            }
            for (part, value) in projected.parts.enumerated() {
                if case .toolCall(let call, _) = value { pendingCalls[call.id, default: []].append((messages.count, part)) }
            }
            let index = messages.count
            messages = messages.appending(projected)
            content = content.updating(messages, index: index)
        }
        func observing(_ partial: NativeMessage?, sessionID: String) -> Transcript {
            Transcript(committed: content, partial: SessionMessage.projectPartial(partial, sessionID: sessionID, responses: responses))
        }
    }
}
