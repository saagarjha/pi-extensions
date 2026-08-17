import Foundation

extension SessionMessage {
    /// COW pages share finalized values without copying the full message array on
    /// each commit. Only the page index and one <=64-message page are copied.
    /// The page index still scales with history; this is deliberately not a tree.
    nonisolated struct MessageList: RandomAccessCollection, Sendable {
        private var pages: [[SessionMessage]]
        private(set) var endIndex: Int
        var startIndex: Int { 0 }
        init(_ values: [SessionMessage] = []) {
            pages = stride(from: 0, to: values.count, by: 64).map {
                Array(values[$0..<Swift.min($0 + 64, values.count)])
            }
            endIndex = values.count
        }
        func index(after i: Int) -> Int { i + 1 }
        func index(before i: Int) -> Int { i - 1 }
        subscript(index: Int) -> SessionMessage {
            precondition(index >= 0 && index < endIndex)
            return pages[index / 64][index % 64]
        }
        func appending(_ value: SessionMessage) -> Self {
            var next = self
            if endIndex % 64 == 0 { next.pages.append([value]) }
            else { next.pages[endIndex / 64].append(value) }
            next.endIndex += 1
            return next
        }
        func replacing(at index: Int, with value: SessionMessage) -> Self {
            precondition(index >= 0 && index < endIndex)
            var next = self
            next.pages[index / 64][index % 64] = value
            return next
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
        /// Local display lineage only; not a native entry or submission identity.
        struct ArrivalCheckpoint: Sendable, Equatable {
            let lineage: UUID
            let count: Int
        }
        var arrivalCheckpoint: ArrivalCheckpoint { ArrivalCheckpoint(lineage: epoch, count: messages.count) }
        func arrivals(since checkpoint: ArrivalCheckpoint, limit: Int) -> Range<Int>? {
            guard epoch == checkpoint.lineage, messages.count >= checkpoint.count,
                  messages.count - checkpoint.count <= limit else { return nil }
            return checkpoint.count..<messages.count
        }
        init(_ messages: [SessionMessage]) {
            self.messages = MessageList(messages); epoch = UUID(); revision = 0; recent = []
        }
        private init(messages: MessageList, epoch: UUID, revision: UInt64, recent: [Change]) {
            self.messages = messages; self.epoch = epoch; self.revision = revision; self.recent = recent
        }
        /// A separate receipt lineage sharing the same COW pages. Presentation
        /// patches must never collide with independently advancing canonical revisions.
        func presentationCopy() -> CommittedContent {
            CommittedContent(messages: messages, epoch: UUID(), revision: 0, recent: [])
        }
        func updating(_ messages: MessageList, index: Int) -> CommittedContent {
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
    /// only immutable COW pages and bounded receipts, never these mutable sets/maps.
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
        /// Hidden replicas may keep indexing/extending cheap suffixes, but defer an
        /// authoritative branch/replacement rebuild until somebody actually views it.
        func canAppendWithoutRebuild(_ entry: NativeRecord, records: [NativeRecord]) -> Bool {
            records.count == recordCount + 1 && (entry.type == "session" || !dependencies.contains(entry.id))
        }
        func canMoveLeafWithoutRebuild(_ id: String?, records: [NativeRecord]) -> Bool {
            if id == leaf { return true }
            guard let id, candidate == id, complete, let index = indices[id] else { return false }
            return index == records.count - 1 && records.count == recordCount && records[index].parentId == leaf
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
        /// Reconcile a manifest-proven unchanged native prefix after reconnect. No
        /// prefix re-index/projection; only genuinely missing suffix records are visited.
        func reconcileSuffix(records: [NativeRecord], unchangedCount: Int, leafID: String?) {
            guard recordCount == unchangedCount, unchangedCount <= records.count else {
                leaf = leafID; resetIndex(records); rebuild(records); return
            }
            for index in unchangedCount..<records.count {
                let entry = records[index]
                recordCount += 1; candidate = nil
                guard entry.type != "session" else { continue }
                let unique = indices.updateValue(index, forKey: entry.id) == nil
                if dependencies.contains(entry.id) {
                    leaf = leafID; resetIndex(records); rebuild(records); return
                }
                if unique, complete, entry.parentId == leaf,
                   entry.type == "message" || entry.type == "custom_message" {
                    extend(entry); leaf = entry.id; dependencies.insert(entry.id)
                }
            }
            moveLeaf(leafID, records: records)
        }
        func observing(_ partial: NativeMessage?, sessionID: String, executions: [LinkToolExecution] = [], presentation: ToolExecutionProjection? = nil) -> Transcript {
            let tail = SessionMessage.projectPartial(partial, sessionID: sessionID, responses: responses)
            return presentation?.observing(content, partial: tail, pendingCalls: pendingCalls, executions: executions)
                ?? Transcript(committed: content, partial: tail)
        }
    }
}
