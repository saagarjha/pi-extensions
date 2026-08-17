import Foundation

extension SessionMessage {
    /// Replica-owned presentation cache. The authoritative committed content and
    /// native records are never changed. Output observations patch COW display
    /// pages with bounded receipts, including the final transition back to a
    /// canonical result in an earlier row after later Markdown has arrived.
    nonisolated final class ToolExecutionProjection {
        private(set) var base: CommittedContent?
        private var display: CommittedContent?
        private var overlaid = Set<Int>()

        func observing(_ next: CommittedContent, partial: SessionMessage?,
                       pendingCalls: [String: [(message: Int, part: Int)]],
                       executions: [LinkToolExecution]) -> Transcript {
            var replacements: [Int: SessionMessage] = [:]
            var consumed = Set<String>()
            for execution in executions where execution.isConsistent {
                guard let location = pendingCalls[execution.start.toolCallId]?.last,
                      location.message < next.messages.count else { continue }
                var message = replacements[location.message] ?? next.messages[location.message]
                guard location.part < message.parts.count,
                      case .toolCall(let call, nil) = message.parts[location.part],
                      call.name == execution.start.toolName else { continue }
                message.toolExecutions[location.part] = execution
                replacements[location.message] = message
                consumed.insert(call.id)
            }
            var tail = partial
            if var message = tail {
                for execution in executions where execution.isConsistent && !consumed.contains(execution.start.toolCallId) {
                    if let part = message.parts.indices.last(where: { index in
                        if case .toolCall(let call, nil) = message.parts[index] {
                            return call.id == execution.start.toolCallId && call.name == execution.start.toolName
                        }
                        return false
                    }) { message.toolExecutions[part] = execution }
                }
                tail = message
            }
            let changes = base.flatMap { next.changes(since: $0) }
            if changes == nil || display == nil {
                // Canonical and presentation revisions are independent. Sharing an
                // epoch would let reconnect falsely accept receipts from the other fork.
                display = next.presentationCopy(); overlaid.removeAll()
            }
            var shown = display!
            let indices = Set(changes ?? []).union(overlaid).union(replacements.keys).sorted()
            for index in indices where index < next.messages.count {
                let value = replacements[index] ?? next.messages[index]
                if index == shown.messages.count {
                    shown = shown.updating(shown.messages.appending(value), index: index)
                } else if index < shown.messages.count, shown.messages[index] != value {
                    shown = shown.updating(shown.messages.replacing(at: index, with: value), index: index)
                }
            }
            base = next; display = shown; overlaid = Set(replacements.keys)
            return Transcript(committed: shown, partial: tail)
        }
    }
}
