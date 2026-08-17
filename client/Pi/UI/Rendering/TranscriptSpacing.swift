import Foundation

/// Provider message/part boundaries must not add visual breaks to continuous thinking.
nonisolated enum TranscriptSpacing {
    static let thinking: CGFloat = 12 // Same gap as paragraphs within a Markdown body.
    static let part: CGFloat = 8
    static let row: CGFloat = 28

    static func betweenParts(_ previous: SessionMessage.Part, _ next: SessionMessage.Part) -> CGFloat {
        if case .thinking = previous, case .thinking = next { return thinking }
        return part
    }

    static func continuesThinking(_ previous: SessionMessage?, _ next: SessionMessage?) -> Bool {
        guard let previous, let next, previous.isAssistant, next.isAssistant,
              let last = previous.parts.last(where: \.hasVisibleContent),
              let first = next.parts.first(where: \.hasVisibleContent),
              case .thinking = last, case .thinking = first else { return false }
        return true
    }

    struct Insets: Equatable {
        let top: CGFloat
        let bottom: CGFloat
    }
    static func insets(previous: SessionMessage?, current: SessionMessage?, next: SessionMessage?) -> Insets {
        Insets(top: (continuesThinking(previous, current) ? thinking : row) / 2,
               bottom: (continuesThinking(current, next) ? thinking : row) / 2)
    }

    /// Preserve message identity and lazy indexed access; do not flatten history for spacing.
    struct Rows: RandomAccessCollection {
        let messages: SessionMessage.Transcript
        private var hiddenPartial: Int? {
            messages.partial?.isEmptyAssistantPlaceholder == true ? messages.committed.messages.count : nil
        }
        var startIndex: Int { messages.startIndex }
        var endIndex: Int { messages.endIndex - (hiddenPartial == nil ? 0 : 1) }
        private func message(at index: Int) -> SessionMessage {
            messages[index + (hiddenPartial.map { index >= $0 } == true ? 1 : 0)]
        }
        struct Element: Identifiable {
            let message: SessionMessage
            let spacingBefore: CGFloat
            var id: String { message.id }
        }
        subscript(index: Int) -> Element {
            let message = message(at: index)
            let gap = index == startIndex ? 0 : Self.gap(self.message(at: index - 1), message)
            return Element(message: message, spacingBefore: gap)
        }
        private static func gap(_ previous: SessionMessage, _ next: SessionMessage) -> CGFloat {
            TranscriptSpacing.continuesThinking(previous, next) ? TranscriptSpacing.thinking : TranscriptSpacing.row
        }
    }
}
