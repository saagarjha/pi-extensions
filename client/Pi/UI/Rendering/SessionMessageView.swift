import SwiftUI

/// Presentation of one session message, independent of transcript layout and scrolling.
struct SessionMessageView: View {
    let message: SessionMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if message.isUser {
                GroupBox(message.author) {
                    MarkdownMessageView(source: message.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(.blue.opacity(0.15))
                                .padding(-8)
                        }
                }
            } else if !message.isAssistant {
                GroupBox(message.author) {
                    Text(message.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text):
                            MarkdownMessageView(source: text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        case .thinking(let text):
                            MarkdownMessageView(source: text)
                                .italic()
                                .frame(maxWidth: .infinity, alignment: .leading)
                        case .toolCall(let call, let result):
                            ToolCallView(call: call, result: result)
                        }
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
