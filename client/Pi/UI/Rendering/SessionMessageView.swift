import SwiftUI

private struct RetrySubmissionKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}
extension EnvironmentValues {
    var retrySubmission: (String) -> Void {
        get { self[RetrySubmissionKey.self] }
        set { self[RetrySubmissionKey.self] = newValue }
    }
}

/// Presentation of one session message, independent of transcript layout and scrolling.
struct SessionMessageView: View {
    let message: SessionMessage
    @Environment(\.retrySubmission) private var retrySubmission
    @Environment(\.transcriptFindScope) private var findScope
    #if os(macOS)
    @Environment(\.nativeMarkdownMessage) private var nativeMarkdown
    #endif

    @ViewBuilder private func markdown(_ source: String, part: Int, kind: String) -> some View {
        #if os(macOS)
        if let nativeMarkdown {
            NativeMarkdownBody(document: MarkdownDocument(source), message: nativeMarkdown, part: part, kind: kind)
                .lineSpacing(4)
        } else {
            MarkdownMessageView(source: source)
                .environment(\.transcriptFindScope, scope(for: part))
        }
        #else
        MarkdownMessageView(source: source)
            .environment(\.transcriptFindScope, scope(for: part))
        #endif
    }

    private func scope(for part: Int) -> TranscriptFindScope? {
        guard let findScope else { return nil }
        // The image-free user renderer merges its text parts into one Markdown body.
        if message.isUser && !message.parts.contains(where: { if case .image = $0 { true } else { false } }) {
            return findScope
        }
        let offset = message.parts.prefix(part).compactMap(TranscriptFindText.part)
            .reduce(0) { $0 + $1.utf16.count + 2 }
        guard let text = TranscriptFindText.part(message.parts[part]),
              let range = TranscriptFindText.local(findScope.range, offset: offset, length: text.utf16.count) else { return nil }
        return .init(row: message.id, part: part, range: range, navigation: findScope.navigation)
    }

    @ViewBuilder private var userContents: some View {
        if message.parts.contains(where: { if case .image = $0 { return true }; return false }) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(message.parts.enumerated()), id: \.offset) { index, part in
                    if case .image(let image) = part {
                        MessageImageView(base64: image.data, mimeType: image.mimeType)
                    } else if part.hasVisibleContent {
                        markdown(part.text, part: index, kind: "user")
                    }
                }
            }
        } else {
            markdown(message.text, part: 0, kind: "user")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if message.isUser {
                GroupBox {
                    userContents
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(.blue.opacity(0.15))
                                .padding(-8)
                        }
                } label: {
                    HStack(spacing: 8) {
                        Text(message.author)
                        if let state = message.localSubmission {
                            switch state {
                            case .sending:
                                ProgressView().controlSize(.small).accessibilityLabel("Sending message")
                            case .accepted: EmptyView()
                            case .failed(let error, let retryable):
                                if retryable {
                                    Button("Retry") { retrySubmission(message.id) }
                                        .buttonStyle(.borderless)
                                        .help(error)
                                } else {
                                    Label("Failed", systemImage: "exclamationmark.circle")
                                        .foregroundStyle(.red).help(error)
                                }
                            }
                        }
                    }
                }
            } else if !message.isAssistant {
                GroupBox(message.author) {
                    Text(TranscriptFindText.highlight(AttributedString(message.text), range: findScope?.range))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
            } else {
                // Keep original indices for document/tool identity, but ignore
                // announced empty parts when deciding the visible boundary gap.
                let visible = message.parts.enumerated().filter { $0.element.hasVisibleContent }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.offset) { position, entry in
                        Group {
                            switch entry.element {
                            case .text(let text):
                                markdown(text, part: entry.offset, kind: "text")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            case .thinking(let text):
                                markdown(text, part: entry.offset, kind: "thinking")
                                    .italic()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            case .image(let image):
                                MessageImageView(base64: image.data, mimeType: image.mimeType)
                            case .toolCall(let call, let result):
                                ToolCallView(call: call, result: result, execution: message.toolExecutions[entry.offset])
                            }
                        }
                        .padding(.top, position == 0 ? 0 : TranscriptSpacing.betweenParts(visible[position - 1].element, entry.element))
                    }
                }
            }
        }
    }
}

#Preview("User") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "message-0" }!)
}

#Preview("Model text") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "message-3" }!)
}

#Preview("Thinking") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "thinking" }!)
}

#Preview("Text and thinking") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "mixed" }!)
}

#Preview("Redacted thinking") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "redacted" }!)
}

#Preview("Image fallback") {
    SessionMessageView(message: .init(
        id: "image", author: "Assistant", text: "", isUser: false, isAssistant: true,
        parts: [PreviewFixtures.messages.first { $0.id == "media" }!.parts[0]]
    ))
}

#Preview("Unsupported content") {
    SessionMessageView(message: .init(
        id: "unsupported", author: "Assistant", text: "", isUser: false, isAssistant: true,
        parts: [PreviewFixtures.messages.first { $0.id == "media" }!.parts[1]]
    ))
}

#Preview("Tool call") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "write" }!
    SessionMessageView(message: .init(
        id: "tool-call", author: "Assistant", text: "", isUser: false, isAssistant: true,
        parts: [.toolCall(tool.call, result: tool.result)]
    ))
}

#Preview("Notice") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "custom-entry" }!)
}

#Preview("Unavailable custom content") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "custom-unavailable" }!)
}

#Preview("Custom message") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-0" }!)
}

#Preview("Native bash execution") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-1" }!)
}

#Preview("Summary") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-2" }!)
}

#Preview("Omitted message") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-3" }!)
}

#Preview("Missing content") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-4" }!)
}

#Preview("Model error") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-5" }!)
}

#Preview("Unmatched tool result") {
    SessionMessageView(message: PreviewFixtures.messages.first { $0.id == "fallback-6" }!)
}

#Preview("Live message") {
    SessionMessageView(message: PreviewFixtures.streamingMessages.last!)
}
